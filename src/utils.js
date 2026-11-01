// Small shared helpers. Adapted from Society src/utils.js (clone, nowIso, stableFingerprint) and
// src/tick-contract.js (parseModelJson).
import crypto from "node:crypto";

export function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function nowIso() {
  return new Date().toISOString();
}

export function stableFingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function coded(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

export function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function exactKeys(value, keys) {
  return isObject(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

// Model output may arrive fenced or with stray prose around one JSON object.
export function parseModelJson(content) {
  let text = String(content || "").trim();
  if (text.startsWith("```")) text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new Error("Model response does not contain valid JSON.");
}

// Server-local calendar date (YYYY-MM-DD) of a Date. STM -> LTM consolidation runs on this boundary.
export function localDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function msUntilNextLocalMidnight(date = new Date()) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 5);
  return Math.max(1000, next.getTime() - date.getTime());
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Runs async tasks with a concurrency ceiling; preserves result order; rejects with the first failure after all
// launched tasks have settled, so no work is left running unobserved.
export async function mapLimited(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  let firstError = null;
  const run = async () => {
    while (next < items.length) {
      const index = next++;
      try { results[index] = await worker(items[index], index); }
      catch (error) { if (!firstError) firstError = error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, run));
  if (firstError) throw firstError;
  return results;
}

// A per-key serial executor: tasks with the same key run one after another, different keys run independently.
export class KeyedMutex {
  constructor() { this.tails = new Map(); }

  run(key, task) {
    const previous = this.tails.get(key) || Promise.resolve();
    const result = previous.catch(() => {}).then(task);
    const tail = result.catch(() => {});
    this.tails.set(key, tail);
    tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return result;
  }

  busy(key) { return this.tails.has(key); }
}
