// Test helpers: a temporary data directory, a mocked OpenRouter keyed by the X-Beholder-Purpose header, and polling.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BeholderApp } from "../src/app.js";
import { OPENROUTER_ENDPOINT } from "../src/openrouter.js";
import { IMAGE_ENDPOINT } from "../src/images.js";

export const TEST_KEY = "sk-or-v1-testkeyABCDEFGHIJKLMNOP0123456789";
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "beholder-test-"));
}

export function jsonResponse(status, value, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });
}

export function completion(content, { finishReason = "stop", model = "test/model" } = {}) {
  return jsonResponse(200, { model, choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: finishReason }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
}

// handlers: { [purpose]: (body, ctx) => content | Response | Promise<...> }. Unhandled purposes fail the test loudly.
export function mockOpenRouter(handlers = {}, { images = null, extra = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target === "https://openrouter.ai/api/v1/key") return jsonResponse(200, { data: { label: "test" } });
    if (target.startsWith("https://openrouter.ai/api/v1/models")) return jsonResponse(200, { data: [{ id: "test/dialogue", name: "Dialogue", supported_parameters: ["temperature", "max_tokens"], top_provider: { max_completion_tokens: 4096 }, architecture: { output_modalities: ["text"] } }] });
    if (target === OPENROUTER_ENDPOINT) {
      const purpose = init.headers["X-Beholder-Purpose"];
      const body = JSON.parse(init.body);
      const call = { purpose, body, at: Date.now() };
      calls.push(call);
      const handler = handlers[purpose];
      if (!handler) throw new Error(`No mock handler for purpose ${purpose}`);
      const result = await handler(body, { count: calls.filter((entry) => entry.purpose === purpose).length, call });
      return result instanceof Response ? result : completion(result);
    }
    if (target.startsWith("https://openrouter.ai/api/v1/images") && images) return images(target, init);
    if (extra) return extra(target, init);
    throw new Error(`Unexpected fetch ${target}`);
  };
  return { fetchImpl, calls, byPurpose: (purpose) => calls.filter((entry) => entry.purpose === purpose) };
}

// Image download hosts resolve to a public documentation address unless a test overrides dnsLookup.
export const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

export async function makeApp(handlers = {}, options = {}) {
  const dataDir = options.dataDir || tempDir();
  const mock = options.mock || mockOpenRouter(handlers, options);
  const app = new BeholderApp({ dataDir, fetchImpl: mock.fetchImpl, timeScaleMs: 1, backoffMs: 1, presenceTtlMs: 60_000, rootDir: ROOT, dnsLookup: publicDns, ...options.appOptions });
  if (options.key !== false) await app.setApiKey(TEST_KEY);
  return { app, mock, dataDir };
}

export async function waitFor(predicate, { timeout = 4000, interval = 5, message = "condition" } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function reply(message, { followUpDelaySeconds = null, imageRequest = null } = {}) {
  return { message, followUpDelaySeconds, imageRequest };
}

// Seeds chat history directly (bypassing dialogue) for memory and contemplation tests.
export function seedMessages(app, characterId, count, { startRole = "user" } = {}) {
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    const role = (index % 2 === 0) === (startRole === "user") ? "user" : "character";
    ids.push(app.store.addMessage({ characterId, role, kind: role === "user" ? "user" : "reply", text: `${role} message ${index + 1}` }).id);
  }
  return ids;
}

export function emptyRetrieval() { return { stmIds: [], ltmIds: [] }; }

export function closeApp(app) {
  app.stop();
  app.store.close();
}
