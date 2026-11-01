// Dialogue-only image generation subagent. Adapted from Society src/world-illustration.js: the OpenRouter Images API
// (POST /api/v1/images), per-model endpoint capability lookup (GET /api/v1/images/models/{model}/endpoints) to send
// only advertised options, strict response parsing (canonical base64 or data URI, raster signature/MIME agreement,
// size limits). Beholder additions: a selectable model, download of temporary https URLs, and persistence as files
// under data/images with relative metadata in SQLite. Jobs are asynchronous and never block chat.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
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

// Temporary provider URLs are downloaded immediately, https only, with a byte ceiling; no redirects are followed.
async function downloadImage(fetchImpl, url) {
  const response = await timedFetch(fetchImpl, url, { redirect: "error", headers: { Accept: "image/png,image/jpeg,image/webp" } }, DOWNLOAD_TIMEOUT_MS);
  if (!response.ok) throw coded("IMAGE_DOWNLOAD_FAILED", `Image download HTTP ${response.status}.`);
  const length = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > IMAGE_MAX_BYTES) throw coded("IMAGE_TOO_LARGE", "Image exceeds the size limit.");
  const bytes = Buffer.from(await response.arrayBuffer());
  const type = response.headers?.get?.("content-type");
  return { bytes, declared: type ? [type.split(";")[0]] : [] };
}

export class ImageService {
  constructor({ store, settings, key, diagnostics, fetchImpl = fetch, imagesDir, backoffMs = 2000 }) {
    this.store = store;
    this.settings = settings;
    this.key = key;
    this.diagnostics = diagnostics;
    this.fetchImpl = fetchImpl;
    this.imagesDir = imagesDir;
    this.backoffMs = backoffMs;
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
        const fetched = candidate.url ? await downloadImage(this.fetchImpl, candidate.url) : { bytes: decodeCanonicalBase64(candidate.base64), declared: candidate.declared };
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
