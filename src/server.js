// HTTP server for the trusted LAN (no auth, no HTTPS by design; never expose it to the internet). Plain node:http
// like Society src/server.js; static files are an explicit allowlist and images (generated and uploaded) are served
// only by a known, recorded name.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BeholderApp } from "./app.js";
import { CURATED_TEXT_MODELS, CURATED_VISION_MODELS, DEFAULT_IMAGE_MODEL, defaultConfig } from "./settings.js";
import { poolOf } from "./db.js";
import { buildEmergencyDump } from "./dump.js";
import { IMAGE_FILE_PATTERN } from "./images.js";
import { readBoundedBody, parseMultipart, UPLOAD_BODY_LIMIT, UPLOAD_MAX_BYTES } from "./uploads.js";
import { coded } from "./utils.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const BODY_LIMIT = 256 * 1024;
const STATIC_FILES = Object.freeze({
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/text-render.js": ["text-render.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"]
});
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
};
const STATUS_BY_CODE = { CHARACTER_NOT_FOUND: 404, NOT_FOUND: 404, REPLY_PENDING: 409, NOTHING_TO_RETRY: 409, API_KEY_MISSING: 409, PAYLOAD_TOO_LARGE: 413,
  UPLOAD_TOO_LARGE: 413, UPLOAD_UNSUPPORTED: 415, UPLOAD_INVALID: 400 };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw coded("PAYLOAD_TOO_LARGE", "Request body is too large.");
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw coded("BAD_JSON", "Request body must be JSON.", { status: 400 }); }
}

function idParam(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw coded("NOT_FOUND", "Not found.");
  return id;
}

// Chat transcript for the browser. Image observations are not chat utterances: they are omitted as entries and shown
// only as the perception state of the user's attachment. Image bytes are never part of this JSON.
function messagesWithImages(app, characterId, afterId) {
  const images = new Map(app.store.imagesForCharacter(characterId).map((image) => [image.messageId, image]));
  return app.store.transcript(characterId, { afterId }).filter((message) => message.role !== "observation").map((message) => {
    const image = images.get(message.id);
    const upload = message.upload;
    const available = upload ? app.uploads.exists(upload.file) : false;
    return { id: message.id, role: message.role, text: message.text, createdAt: message.createdAt,
      image: image ? { status: image.status, url: image.status === "ready" ? `/images/${image.file}` : null, error: image.status === "failed" ? image.errorMessage : null } : null,
      upload: upload ? { status: upload.status, url: available ? `/uploads/${upload.file}` : null, observation: upload.status === "observed" ? upload.observation : null } : null };
  });
}

function contemplationView(app, character, extra = {}) {
  const pool = poolOf(character);
  return {
    ...extra,
    pool,
    poolState: app.store.ensureInterpretationPool(pool),
    contemplationEnabled: character.config.contemplationEnabled,
    gestalt: app.contemplation.gestaltView(pool),
    interpretations: app.store.interpretations(pool),
    experiments: app.store.experiments(pool),
    status: app.contemplation.status(pool)
  };
}

export function createServer(app) {
  const routes = [
    // Global status is infrastructure only; model selection and descriptions belong to each character (Specification 0005).
    ["GET", /^\/api\/status$/, () => ({ apiKeyConfigured: app.key.configured(), defaultConfig: defaultConfig(),
      curatedModels: CURATED_TEXT_MODELS, curatedVisionModels: CURATED_VISION_MODELS, defaultImageModel: DEFAULT_IMAGE_MODEL, uploadMaxBytes: UPLOAD_MAX_BYTES, build: { ...app.projectMeta, sourceCommitSha: app.buildInfo.sourceCommitSha } })],
    ["POST", /^\/api\/key$/, async (req) => app.setApiKey((await readJsonBody(req)).apiKey)],
    ["GET", /^\/api\/models$/, async (req, url) => {
      let catalog = null;
      let catalogError = null;
      try { catalog = await app.llm.modelCatalog({ refresh: url.searchParams.get("refresh") === "1" }); } catch (error) { catalogError = error.message; }
      const textModels = (catalog?.models || []).filter((model) => !model.outputModalities || model.outputModalities.includes("text"));
      const imageList = await app.images.modelList();
      const chatImageModels = (catalog?.models || []).filter((model) => model.outputModalities?.includes("image")).map((model) => ({ id: model.id, name: model.name }));
      return { curated: CURATED_TEXT_MODELS, text: textModels, image: imageList.models.length ? imageList.models : chatImageModels, imageSource: imageList.source, catalogError };
    }],
    ["GET", /^\/api\/characters$/, () => app.store.listCharacters().map((character) => app.characterSummary(character))],
    ["POST", /^\/api\/characters$/, async (req) => app.characterSummary(app.createCharacter(await readJsonBody(req)))],
    // Turning a character's automatic Contemplation on catches up on its unprocessed messages, as the global switch did.
    ["PUT", /^\/api\/characters\/(\d+)$/, async (req, url, m) => {
      const before = mustCharacter(app, m[1]);
      const after = app.updateCharacter(before.id, await readJsonBody(req));
      if (!before.config.contemplationEnabled && after.config.contemplationEnabled && app.key.configured()) app.contemplation.recover(after.id);
      return app.characterSummary(after);
    }],
    ["GET", /^\/api\/characters\/(\d+)\/chat$/, (req, url, m) => {
      const character = mustCharacter(app, m[1]);
      const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
      return { character: app.characterSummary(character), messages: messagesWithImages(app, character.id, after), chat: app.dialogue.chatState(character.id) };
    }],
    ["POST", /^\/api\/characters\/(\d+)\/messages$/, async (req, url, m) => {
      const character = mustCharacter(app, m[1]);
      if (!app.key.configured()) throw coded("API_KEY_MISSING", "Enter the OpenRouter API key first.");
      // A message with an attached image arrives as bounded multipart/form-data (fields text, timeZone, image).
      if (/^multipart\/form-data/i.test(String(req.headers["content-type"] || ""))) {
        const fields = parseMultipart(await readBoundedBody(req, UPLOAD_BODY_LIMIT), req.headers["content-type"]);
        if (!fields.image) throw coded("UPLOAD_INVALID", "No image was attached.");
        return { message: await app.dialogue.sendImage(character.id, fields.text ?? "", { timeZone: fields.timeZone ?? null, image: fields.image }) };
      }
      const body = await readJsonBody(req);
      return { message: app.dialogue.send(character.id, body.text, { timeZone: body.timeZone ?? null }) };
    }],
    ["POST", /^\/api\/characters\/(\d+)\/retry$/, async (req, url, m) => {
      if (!app.key.configured()) throw coded("API_KEY_MISSING", "Enter the OpenRouter API key first.");
      const body = await readJsonBody(req);
      return app.dialogue.retry(mustCharacter(app, m[1]).id, { timeZone: body.timeZone ?? null });
    }],
    ["POST", /^\/api\/presence$/, async (req) => {
      const body = await readJsonBody(req);
      return app.dialogue.presence(body.clientId, { characterId: body.characterId ?? null, draftNonEmpty: body.draftNonEmpty === true, typingStarted: body.typingStarted === true, timeZone: body.timeZone ?? null });
    }],
    ["POST", /^\/api\/presence\/leave$/, async (req) => { app.dialogue.leave((await readJsonBody(req)).clientId); return { ok: true }; }],
    ["GET", /^\/api\/characters\/(\d+)\/contemplation$/, (req, url, m) => contemplationView(app, mustCharacter(app, m[1]))],
    ["POST", /^\/api\/characters\/(\d+)\/contemplation\/force$/, async (req, url, m) => {
      const character = mustCharacter(app, m[1]);
      if (!app.key.configured()) throw coded("API_KEY_MISSING", "Enter the OpenRouter API key first.");
      // The result reports queueing only (queued, or why not); the run's outcome appears in the status later.
      const force = app.contemplation.force(poolOf(character), (await readJsonBody(req)).kind, character.id);
      return contemplationView(app, character, { force });
    }],
    ["POST", /^\/api\/characters\/(\d+)\/interpretations$/, async (req, url, m) => {
      const character = mustCharacter(app, m[1]);
      app.contemplation.addInterpretation(poolOf(character), (await readJsonBody(req)).text, character.id);
      return contemplationView(app, character);
    }],
    ["PUT", /^\/api\/characters\/(\d+)\/interpretations\/(\d+)$/, async (req, url, m) => {
      const character = mustCharacter(app, m[1]);
      app.contemplation.editInterpretation(poolOf(character), idParam(m[2]), (await readJsonBody(req)).text);
      return contemplationView(app, character);
    }],
    ["DELETE", /^\/api\/characters\/(\d+)\/interpretations\/(\d+)$/, (req, url, m) => {
      const character = mustCharacter(app, m[1]);
      app.contemplation.deleteInterpretation(poolOf(character), idParam(m[2]));
      return contemplationView(app, character);
    }],
    ["POST", /^\/api\/characters\/(\d+)\/experiments$/, async (req, url, m) => {
      const character = mustCharacter(app, m[1]);
      app.contemplation.addExperiment(poolOf(character), (await readJsonBody(req)).text);
      return contemplationView(app, character);
    }],
    ["PUT", /^\/api\/characters\/(\d+)\/experiments\/(\d+)$/, async (req, url, m) => {
      const character = mustCharacter(app, m[1]);
      app.contemplation.editExperiment(poolOf(character), idParam(m[2]), (await readJsonBody(req)).text);
      return contemplationView(app, character);
    }],
    ["DELETE", /^\/api\/characters\/(\d+)\/experiments\/(\d+)$/, (req, url, m) => {
      const character = mustCharacter(app, m[1]);
      app.contemplation.deleteExperiment(poolOf(character), idParam(m[2]));
      return contemplationView(app, character);
    }],
    ["GET", /^\/api\/activity$/, () => app.activity()],
    ["POST", /^\/api\/frontend-error$/, async (req) => {
      const body = await readJsonBody(req);
      app.diagnostics.frontendError({ message: String(body.message || "").slice(0, 2000), stack: String(body.stack || "").slice(0, 4000), page: String(body.page || "").slice(0, 200) });
      return { ok: true };
    }]
  ];

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/api/dump") {
        const { zip } = buildEmergencyDump(app);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        return send(res, 200, zip, { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="beholder-dump-${stamp}.zip"`, "Cache-Control": "no-store" });
      }
      if (req.method === "GET" && url.pathname.startsWith("/images/")) {
        const file = url.pathname.slice("/images/".length);
        if (!IMAGE_FILE_PATTERN.test(file)) throw coded("NOT_FOUND", "Not found.");
        const image = app.store.imageByFile(file);
        if (!image) throw coded("NOT_FOUND", "Not found.");
        const bytes = await fs.readFile(path.join(app.imagesDir, file));
        return send(res, 200, bytes, { "Content-Type": image.mime, "Cache-Control": "private, max-age=31536000, immutable" });
      }
      if (req.method === "GET" && url.pathname.startsWith("/uploads/")) {
        const file = url.pathname.slice("/uploads/".length);
        if (!IMAGE_FILE_PATTERN.test(file)) throw coded("NOT_FOUND", "Not found.");
        const upload = app.store.uploadByFile(file);
        if (!upload) throw coded("NOT_FOUND", "Not found.");
        const bytes = await fs.readFile(app.uploads.filePath(file));
        return send(res, 200, bytes, { "Content-Type": upload.mime, "Cache-Control": "private, max-age=31536000, immutable" });
      }
      if (req.method === "GET" && STATIC_FILES[url.pathname]) {
        const [file, type] = STATIC_FILES[url.pathname];
        return send(res, 200, await fs.readFile(path.join(PUBLIC_DIR, file)), { "Content-Type": type, "Cache-Control": "no-cache" });
      }
      for (const [method, pattern, handler] of routes) {
        const match = pattern.exec(url.pathname);
        if (match && method === req.method) return sendJson(res, 200, await handler(req, url, match));
      }
      throw coded("NOT_FOUND", "Not found.");
    } catch (error) {
      const status = error.status || STATUS_BY_CODE[error.code] || (error.code === "ENOENT" ? 404 : 400);
      if (status >= 500 || !error.code) app.diagnostics.error("http", error, { path: url.pathname });
      sendJson(res, status >= 400 ? status : 400, { error: { code: error.code || "ERROR", message: error.message, validationErrors: error.validationErrors || null } });
    }
  });
}

function mustCharacter(app, rawId) {
  const character = app.store.getCharacter(idParam(rawId));
  if (!character) throw coded("CHARACTER_NOT_FOUND", "Character not found.");
  return character;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = path.resolve(process.env.BEHOLDER_DATA_DIR || path.join(ROOT, "data"));
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "0.0.0.0";
  const app = new BeholderApp({ dataDir, rootDir: ROOT });
  app.start();
  const server = createServer(app);
  server.listen(port, host, () => console.log(`Beholder listening on http://${host}:${port} (data: ${dataDir}). Trusted LAN only: no authentication.`));
  const shutdown = () => { app.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
