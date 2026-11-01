// HTTP server for the trusted LAN (no auth, no HTTPS by design; never expose it to the internet). Plain node:http
// like Society src/server.js; static files are an explicit allowlist and images are served only by known name.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BeholderApp } from "./app.js";
import { CURATED_TEXT_MODELS, DEFAULT_IMAGE_MODEL } from "./settings.js";
import { interpretationPoolOf } from "./db.js";
import { buildEmergencyDump } from "./dump.js";
import { IMAGE_FILE_PATTERN } from "./images.js";
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
  "Content-Security-Policy": "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
};
const STATUS_BY_CODE = { CHARACTER_NOT_FOUND: 404, NOT_FOUND: 404, REPLY_PENDING: 409, NOTHING_TO_RETRY: 409, API_KEY_MISSING: 409, PAYLOAD_TOO_LARGE: 413 };

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

function messagesWithImages(app, characterId, afterId) {
  const images = new Map(app.store.imagesForCharacter(characterId).map((image) => [image.messageId, image]));
  return app.store.transcript(characterId, { afterId }).map((message) => {
    const image = images.get(message.id);
    return { id: message.id, role: message.role, text: message.text, createdAt: message.createdAt,
      image: image ? { status: image.status, url: image.status === "ready" ? `/images/${image.file}` : null, error: image.status === "failed" ? image.errorMessage : null } : null };
  });
}

function contemplationView(app, character) {
  const pool = interpretationPoolOf(character);
  return {
    pool,
    poolState: app.store.ensureInterpretationPool(pool),
    contemplationEnabled: app.settings.get().contemplationEnabled,
    interpretations: app.store.interpretations(pool),
    experiments: app.store.experiments(pool),
    status: app.contemplation.status(pool)
  };
}

export function createServer(app) {
  const routes = [
    ["GET", /^\/api\/status$/, () => ({ apiKeyConfigured: app.key.configured(), settings: app.settings.get(), userDescription: app.settings.userDescription(),
      curatedModels: CURATED_TEXT_MODELS, defaultImageModel: DEFAULT_IMAGE_MODEL, build: { ...app.projectMeta, sourceCommitSha: app.buildInfo.sourceCommitSha } })],
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
    ["PUT", /^\/api\/settings$/, async (req) => {
      const before = app.settings.get();
      const after = app.settings.update(await readJsonBody(req));
      if (!before.contemplationEnabled && after.contemplationEnabled && app.key.configured()) app.contemplation.recover();
      return after;
    }],
    ["PUT", /^\/api\/user-description$/, async (req) => ({ text: app.settings.setUserDescription((await readJsonBody(req)).text) })],
    ["GET", /^\/api\/characters$/, () => app.store.listCharacters().map((character) => app.characterSummary(character))],
    ["POST", /^\/api\/characters$/, async (req) => app.characterSummary(app.createCharacter(await readJsonBody(req)))],
    ["PUT", /^\/api\/characters\/(\d+)$/, async (req, url, m) => app.characterSummary(app.updateCharacter(idParam(m[1]), await readJsonBody(req)))],
    ["GET", /^\/api\/characters\/(\d+)\/chat$/, (req, url, m) => {
      const character = mustCharacter(app, m[1]);
      const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
      return { character: app.characterSummary(character), messages: messagesWithImages(app, character.id, after), chat: app.dialogue.chatState(character.id) };
    }],
    ["POST", /^\/api\/characters\/(\d+)\/messages$/, async (req, url, m) => {
      const character = mustCharacter(app, m[1]);
      if (!app.key.configured()) throw coded("API_KEY_MISSING", "Enter the OpenRouter API key first.");
      return { message: app.dialogue.send(character.id, (await readJsonBody(req)).text) };
    }],
    ["POST", /^\/api\/characters\/(\d+)\/retry$/, (req, url, m) => {
      if (!app.key.configured()) throw coded("API_KEY_MISSING", "Enter the OpenRouter API key first.");
      return app.dialogue.retry(mustCharacter(app, m[1]).id);
    }],
    ["POST", /^\/api\/presence$/, async (req) => {
      const body = await readJsonBody(req);
      return app.dialogue.presence(body.clientId, { characterId: body.characterId ?? null, draftNonEmpty: body.draftNonEmpty === true, typingStarted: body.typingStarted === true });
    }],
    ["POST", /^\/api\/presence\/leave$/, async (req) => { app.dialogue.leave((await readJsonBody(req)).clientId); return { ok: true }; }],
    ["GET", /^\/api\/characters\/(\d+)\/contemplation$/, (req, url, m) => contemplationView(app, mustCharacter(app, m[1]))],
    ["POST", /^\/api\/characters\/(\d+)\/contemplation\/force$/, async (req, url, m) => {
      const character = mustCharacter(app, m[1]);
      if (!app.key.configured()) throw coded("API_KEY_MISSING", "Enter the OpenRouter API key first.");
      app.contemplation.force(interpretationPoolOf(character), (await readJsonBody(req)).kind, character.id);
      return contemplationView(app, character);
    }],
    ["POST", /^\/api\/characters\/(\d+)\/interpretations$/, async (req, url, m) => {
      const character = mustCharacter(app, m[1]);
      app.contemplation.addInterpretation(interpretationPoolOf(character), (await readJsonBody(req)).text, character.id);
      return contemplationView(app, character);
    }],
    ["PUT", /^\/api\/characters\/(\d+)\/interpretations\/(\d+)$/, async (req, url, m) => {
      const character = mustCharacter(app, m[1]);
      app.contemplation.editInterpretation(interpretationPoolOf(character), idParam(m[2]), (await readJsonBody(req)).text);
      return contemplationView(app, character);
    }],
    ["DELETE", /^\/api\/characters\/(\d+)\/interpretations\/(\d+)$/, (req, url, m) => {
      const character = mustCharacter(app, m[1]);
      app.contemplation.deleteInterpretation(interpretationPoolOf(character), idParam(m[2]));
      return contemplationView(app, character);
    }],
    ["POST", /^\/api\/characters\/(\d+)\/experiments$/, async (req, url, m) => {
      const character = mustCharacter(app, m[1]);
      app.contemplation.addExperiment(interpretationPoolOf(character), (await readJsonBody(req)).text);
      return contemplationView(app, character);
    }],
    ["PUT", /^\/api\/characters\/(\d+)\/experiments\/(\d+)$/, async (req, url, m) => {
      const character = mustCharacter(app, m[1]);
      app.contemplation.editExperiment(interpretationPoolOf(character), idParam(m[2]), (await readJsonBody(req)).text);
      return contemplationView(app, character);
    }],
    ["DELETE", /^\/api\/characters\/(\d+)\/experiments\/(\d+)$/, (req, url, m) => {
      const character = mustCharacter(app, m[1]);
      app.contemplation.deleteExperiment(interpretationPoolOf(character), idParam(m[2]));
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
