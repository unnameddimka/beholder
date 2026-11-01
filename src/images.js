// Dialogue-only image generation subagent. Adapted from Society src/world-illustration.js: the OpenRouter Images API
// (POST /api/v1/images), per-model endpoint capability lookup (GET /api/v1/images/models/{model}/endpoints) to send
// only advertised options, strict response parsing (canonical base64 or data URI, raster signature/MIME agreement,
// size limits). Beholder additions: a selectable model, download of temporary https URLs, and persistence as files
// under data/images with relative metadata in SQLite. Jobs are asynchronous and never block chat.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import dns from "node:dns/promises";
import { coded, nowIso, sleep } from "./utils.js";
import { sanitize } from "./sanitize.js";

export const IMAGE_ENDPOINT = "https://openrouter.ai/api/v1/images";
export const IMAGE_MODELS_ENDPOINT = "https://openrouter.ai/api/v1/images/models";
export const IMAGE_MAX_BYTES = 16 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 180_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const CAPABILITY_TTL_MS = 6 * 60 * 60 * 1000;
const ATTEMPTS = 3;
const MIME_EXT = Object.freeze({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" });
// Optional request fields, sent only when every candidate endpoint advertises an accepting descriptor.
const PREFERRED_OPTIONS = Object.freeze({ n: 1, aspect_ratio: "1:1", quality: "medium", output_format: "webp", stream: false });
export const IMAGE_FILE_PATTERN = /^[0-9a-f]{32}\.(png|jpg|webp)$/;

function isPlainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

export function detectRasterMime(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function decodeCanonicalBase64(value) {
  const maxChars = Math.ceil(IMAGE_MAX_BYTES / 3) * 4;
  if (typeof value !== "string" || !value || value.length > maxChars || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

function descriptorAccepts(descriptor, value) {
  if (!isPlainObject(descriptor)) return false;
  if (descriptor.type === "enum") return Array.isArray(descriptor.values) && descriptor.values.includes(value);
  if (descriptor.type === "range") return typeof value === "number" && (descriptor.min === undefined || value >= descriptor.min) && (descriptor.max === undefined || value <= descriptor.max);
  if (descriptor.type === "boolean") return typeof value === "boolean";
  return false;
}

export function selectImageOptions(records) {
  const candidates = (records || []).filter((record) => isPlainObject(record?.supported_parameters));
  if (!candidates.length) return {};
  return Object.fromEntries(Object.entries(PREFERRED_OPTIONS).filter(([name, value]) => candidates.every((record) => descriptorAccepts(record.supported_parameters[name], value))));
}

// Society imageCandidate, extended: an https URL is accepted as a temporary location to download.
function imageCandidate(entry) {
  if (!isPlainObject(entry)) return null;
  const declared = [entry.media_type, entry.mime_type, entry.mimeType].filter((value) => typeof value === "string");
  const encoded = [entry.b64_json, entry.b64, entry.base64].find((value) => typeof value === "string");
  if (encoded !== undefined) return { base64: encoded.replace(/\s+/g, ""), declared };
  const url = typeof entry.url === "string" ? entry.url : typeof entry.image_url === "string" ? entry.image_url : typeof entry.image_url?.url === "string" ? entry.image_url.url : null;
  if (!url) return null;
  const data = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=\s]+)$/.exec(url);
  if (data) return { base64: data[2].replace(/\s+/g, ""), declared: [data[1], ...declared] };
  if (/^https:\/\//i.test(url)) return { url, declared };
  return null;
}

export function parseImageResponse(body) {
  if (!isPlainObject(body)) throw coded("IMAGE_RESPONSE_INVALID", "Image response is not a JSON object.");
  if (body.error) throw coded("IMAGE_PROVIDER_ERROR", `Image provider returned an error: ${String(body.error?.message || "").slice(0, 300)}`);
  const list = Array.isArray(body.data) ? body.data : Array.isArray(body.images) ? body.images : null;
  if (!list || !list.length) throw coded("IMAGE_NO_IMAGE", "Image response contained no image.");
  const candidate = imageCandidate(list[0]);
  if (!candidate) throw coded("IMAGE_RESPONSE_INVALID", "Image response did not contain base64 bytes or an https URL.");
  return candidate;
}

function verifiedRaster(bytes, declared) {
  if (!bytes || !bytes.length) throw coded("IMAGE_BYTES_INVALID", "Image bytes are empty or not canonical base64.");
  if (bytes.length > IMAGE_MAX_BYTES) throw coded("IMAGE_TOO_LARGE", "Image exceeds the size limit.");
  const mime = detectRasterMime(bytes);
  if (!mime) throw coded("IMAGE_UNSUPPORTED_FORMAT", "Image is not PNG, JPEG, or WebP.");
  for (const value of declared) {
    const normalized = value.trim().toLowerCase().replace(/^image\/jpg$/, "image/jpeg");
    if (normalized.startsWith("image/") && normalized !== mime) throw coded("IMAGE_MIME_MISMATCH", "Declared image type does not match its bytes.");
  }
  return { bytes, mime };
}

async function timedFetch(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetchImpl(url, { ...init, signal: controller.signal }); }
  catch (cause) { throw coded(controller.signal.aborted ? "IMAGE_TIMEOUT" : "IMAGE_NETWORK_ERROR", controller.signal.aborted ? "Image request timed out." : String(cause?.message || cause)); }
  finally { clearTimeout(timer); }
}

// Destinations a provider-returned URL may never point at: loopback, private, link-local, CGNAT, unspecified,
// multicast/reserved, and their IPv6 counterparts (including IPv4-mapped addresses).
const BLOCKED_ADDRESSES = (() => {
  const list = new net.BlockList();
  for (const [prefix, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
    ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]]) list.addSubnet(prefix, bits, "ipv4");
  for (const [prefix, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]]) list.addSubnet(prefix, bits, "ipv6");
  return list;
})();

export function isBlockedAddress(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return BLOCKED_ADDRESSES.check(mapped[1], "ipv4");
  const family = net.isIPv4(address) ? "ipv4" : net.isIPv6(address) ? "ipv6" : null;
  return family === null || BLOCKED_ADDRESSES.check(address, family);
}

// Only public https hosts on the default port. The hostname is resolved first and refused if any address is internal.
// (A DNS answer that changes between this check and the fetch is not defended against; acceptable for a LAN PoC.)
export async function checkDownloadUrl(url, lookupImpl = dns.lookup) {
  let parsed;
  try { parsed = new URL(url); } catch { throw coded("IMAGE_URL_REFUSED", "Image URL is not a valid URL."); }
  if (parsed.protocol !== "https:" || (parsed.port && parsed.port !== "443") || parsed.username || parsed.password) throw coded("IMAGE_URL_REFUSED", "Image URL must be a plain https URL.");
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw coded("IMAGE_URL_REFUSED", "Image URL points at a local host.");
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw coded("IMAGE_URL_REFUSED", "Image URL points at an internal address.");
    return;
  }
  let addresses;
  try { addresses = await lookupImpl(host, { all: true, verbatim: true }); } catch { throw coded("IMAGE_DOWNLOAD_FAILED", "Image URL host could not be resolved."); }
  if (!addresses.length || addresses.some((entry) => isBlockedAddress(entry.address))) throw coded("IMAGE_URL_REFUSED", "Image URL resolves to an internal address.");
}

// Temporary provider URLs are downloaded immediately: destination policy first, no redirects, and the body is read
// as a stream that is aborted as soon as it exceeds the byte ceiling (Content-Length is not trusted). The timeout
// covers the whole download, including the body.
async function downloadImage(fetchImpl, url, lookupImpl) {
  await checkDownloadUrl(url, lookupImpl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    let response;
    try { response = await fetchImpl(url, { redirect: "error", headers: { Accept: "image/png,image/jpeg,image/webp" }, signal: controller.signal }); }
    catch (cause) { throw coded(controller.signal.aborted ? "IMAGE_TIMEOUT" : "IMAGE_NETWORK_ERROR", controller.signal.aborted ? "Image download timed out." : String(cause?.message || cause)); }
    if (!response.ok) throw coded("IMAGE_DOWNLOAD_FAILED", `Image download HTTP ${response.status}.`);
    const length = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(length) && length > IMAGE_MAX_BYTES) throw coded("IMAGE_TOO_LARGE", "Image exceeds the size limit.");
    if (!response.body) throw coded("IMAGE_DOWNLOAD_FAILED", "Image download returned no body.");
    const chunks = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > IMAGE_MAX_BYTES) {
          controller.abort();
          throw coded("IMAGE_TOO_LARGE", "Image exceeds the size limit.");
        }
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      if (error.code) throw error;
      throw coded(controller.signal.aborted ? "IMAGE_TIMEOUT" : "IMAGE_NETWORK_ERROR", controller.signal.aborted ? "Image download timed out." : String(error?.message || error));
    } finally {
      reader.releaseLock?.();
    }
    const type = response.headers?.get?.("content-type");
    return { bytes: Buffer.concat(chunks), declared: type ? [type.split(";")[0]] : [] };
  } finally {
    clearTimeout(timer);
  }
}

export class ImageService {
  constructor({ store, settings, key, diagnostics, fetchImpl = fetch, imagesDir, backoffMs = 2000, lookupImpl = dns.lookup }) {
    this.store = store;
    this.settings = settings;
    this.key = key;
    this.diagnostics = diagnostics;
    this.fetchImpl = fetchImpl;
    this.imagesDir = imagesDir;
    this.backoffMs = backoffMs;
    this.lookupImpl = lookupImpl;
    this.inFlight = new Map();
    this.capabilities = new Map();
    this.generations = [];
  }

  request({ message, prompt }) {
    const image = this.store.addImage({ messageId: message.id, characterId: message.characterId, request: prompt, model: this.settings.get().models.image });
    this.start(image);
    return image;
  }

  start(image) {
    if (this.inFlight.has(image.id)) return this.inFlight.get(image.id);
    const job = this.run(image)
      .catch((error) => {
        this.store.failImage(image.id, { code: error.code || "IMAGE_FAILED", message: error.message });
        this.note({ imageId: image.id, status: "failed", code: error.code || "IMAGE_FAILED", message: error.message });
        this.diagnostics.error("image_generation", error, { imageId: image.id, messageId: image.messageId });
      })
      .finally(() => this.inFlight.delete(image.id));
    this.inFlight.set(image.id, job);
    return job;
  }

  // Pending rows from before a restart resume once a key is available.
  resumePending() {
    if (!this.key.configured()) return;
    for (const image of this.store.pendingImages()) this.start(image);
  }

  note(entry) {
    this.generations.push({ at: nowIso(), ...sanitize(entry, [this.key.get()].filter(Boolean)) });
    if (this.generations.length > 100) this.generations.splice(0, this.generations.length - 100);
  }

  async options(model) {
    const cached = this.capabilities.get(model);
    if (cached && Date.now() - cached.at < CAPABILITY_TTL_MS) return cached.options;
    let options = {};
    try {
      const response = await timedFetch(this.fetchImpl, `${IMAGE_MODELS_ENDPOINT}/${model.split("/").map(encodeURIComponent).join("/")}/endpoints`,
        { headers: { Authorization: `Bearer ${this.key.get()}`, Accept: "application/json" } }, 20_000);
      if (response.ok) {
        const body = await response.json();
        const envelope = isPlainObject(body?.data) && Array.isArray(body.data.endpoints) ? body.data : body;
        options = selectImageOptions(Array.isArray(envelope?.endpoints) ? envelope.endpoints : []);
      }
    } catch { /* unknown capabilities: send only model and prompt */ }
    this.capabilities.set(model, { at: Date.now(), options });
    return options;
  }

  async run(image) {
    const apiKey = this.key.get();
    if (!apiKey) throw coded("API_KEY_MISSING", "Enter the OpenRouter API key first.");
    const startedMs = Date.now();
    const options = await this.options(image.model);
    const requestBody = { model: image.model, prompt: image.request, ...options };
    const exchangeId = this.diagnostics.beginExchange({ purpose: "image_generation", modelRole: "image", model: image.model, imageId: image.id, characterId: image.characterId, request: requestBody });
    let lastError = null;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        const response = await timedFetch(this.fetchImpl, IMAGE_ENDPOINT, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "Beholder" }, body: JSON.stringify(requestBody) }, IMAGE_TIMEOUT_MS);
        const raw = await response.text();
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch {}
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          throw coded(response.status === 401 ? "AUTHENTICATION_FAILED" : retryable ? "IMAGE_PROVIDER_RETRYABLE" : "IMAGE_PROVIDER_ERROR", `Image provider HTTP ${response.status}: ${String(body?.error?.message || "").slice(0, 300)}`, { retryable });
        }
        const candidate = parseImageResponse(body);
        const fetched = candidate.url ? await downloadImage(this.fetchImpl, candidate.url, this.lookupImpl) : { bytes: decodeCanonicalBase64(candidate.base64), declared: candidate.declared };
        const { bytes, mime } = verifiedRaster(fetched.bytes, [...candidate.declared, ...(fetched.declared || [])]);
        const file = `${crypto.randomBytes(16).toString("hex")}.${MIME_EXT[mime]}`;
        await fs.mkdir(this.imagesDir, { recursive: true });
        const tmp = path.join(this.imagesDir, `${file}.tmp`);
        await fs.writeFile(tmp, bytes);
        await fs.rename(tmp, path.join(this.imagesDir, file));
        this.store.completeImage(image.id, { file, mime, bytes: bytes.length });
        this.diagnostics.finishExchange(exchangeId, { status: "succeeded", finishedAt: nowIso(), elapsedMs: Date.now() - startedMs, attempt, response: { file, mime, bytes: bytes.length, source: candidate.url ? "url" : "inline" } });
        this.note({ imageId: image.id, status: "succeeded", file, mime, bytes: bytes.length, attempt });
        return { file };
      } catch (error) {
        lastError = error;
        const retryable = error.retryable || ["IMAGE_TIMEOUT", "IMAGE_NETWORK_ERROR"].includes(error.code);
        if (!retryable || attempt === ATTEMPTS) break;
        await sleep(this.backoffMs * 3 ** (attempt - 1));
      }
    }
    this.diagnostics.finishExchange(exchangeId, { status: "failed", finishedAt: nowIso(), elapsedMs: Date.now() - startedMs, error: { code: lastError.code, message: lastError.message } });
    throw lastError;
  }

  // Image model list for the selector: the Images API catalogue when available, otherwise chat models whose output
  // modalities include images. The selector always also accepts a typed model id.
  async modelList() {
    try {
      const response = await timedFetch(this.fetchImpl, IMAGE_MODELS_ENDPOINT, { headers: { Accept: "application/json", ...(this.key.get() ? { Authorization: `Bearer ${this.key.get()}` } : {}) } }, 20_000);
      if (response.ok) {
        const body = await response.json();
        const list = Array.isArray(body?.data) ? body.data : [];
        const ids = list.map((entry) => ({ id: entry?.id, name: entry?.name || entry?.id })).filter((entry) => typeof entry.id === "string");
        if (ids.length) return { source: "images_api", models: ids };
      }
    } catch { /* fall through */ }
    return { source: "none", models: [] };
  }

  status() {
    return { inFlight: [...this.inFlight.keys()], recent: this.generations.slice(-20) };
  }
}
