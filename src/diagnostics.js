// In-memory diagnostics (never persisted): bounded LLM exchange records, job events, and errors, used by the activity
// API and the Emergency Dump. Adapted from Society src/diagnostics.js (beginLlmExchange / finalizeLlmExchange /
// runtimeActivityView). Every entry is sanitized before it is stored.
import { sanitize } from "./sanitize.js";
import { clone, nowIso } from "./utils.js";

const EXCHANGE_LIMIT = 300;
const EVENT_LIMIT = 400;
const ERROR_LIMIT = 200;

export class Diagnostics {
  constructor({ secrets = () => [] } = {}) {
    this.secrets = secrets;
    this.startedAt = nowIso();
    this.nextExchange = 1;
    this.exchanges = [];
    this.events = [];
    this.errors = [];
    this.frontendErrors = [];
  }

  clean(value) { return sanitize(clone(value), this.secrets().filter(Boolean)); }

  beginExchange(entry) {
    const exchangeId = `llm_${this.nextExchange++}`;
    this.exchanges.push({ exchangeId, status: "pending", startedAt: nowIso(), finishedAt: null, elapsedMs: null, response: null, error: null, ...this.clean(entry) });
    this.trimExchanges();
    return exchangeId;
  }

  finishExchange(exchangeId, patch) {
    const exchange = this.exchanges.find((entry) => entry.exchangeId === exchangeId);
    if (exchange) Object.assign(exchange, this.clean(patch));
  }

  // Pending exchanges are never trimmed, so the activity view always sees in-flight work.
  trimExchanges() {
    while (this.exchanges.length > EXCHANGE_LIMIT) {
      const index = this.exchanges.findIndex((entry) => entry.status !== "pending");
      if (index < 0) break;
      this.exchanges.splice(index, 1);
    }
  }

  event(entry) {
    this.events.push({ at: nowIso(), ...this.clean(entry) });
    if (this.events.length > EVENT_LIMIT) this.events.splice(0, this.events.length - EVENT_LIMIT);
  }

  error(stage, error, extra = {}) {
    const entry = { at: nowIso(), stage, code: error?.code || "ERROR", message: String(error?.message || error), stack: typeof error?.stack === "string" ? error.stack.split("\n").slice(0, 12).join("\n") : null,
      validationErrors: error?.validationErrors?.slice?.(0, 20) || null, ...extra };
    this.errors.push(this.clean(entry));
    if (this.errors.length > ERROR_LIMIT) this.errors.splice(0, this.errors.length - ERROR_LIMIT);
    return entry;
  }

  frontendError(entry) {
    this.frontendErrors.push({ at: nowIso(), ...this.clean(entry) });
    if (this.frontendErrors.length > 100) this.frontendErrors.splice(0, this.frontendErrors.length - 100);
  }

  // Per-model-role activity (Society runtimeActivityView): pending count, active models, and the most recent error.
  roleActivity(roles) {
    const view = Object.fromEntries(roles.map((role) => [role, { working: false, pendingCount: 0, activeModels: [], purposes: [], lastError: null }]));
    for (const entry of this.exchanges) {
      const role = view[entry.modelRole];
      if (!role) continue;
      if (entry.status === "pending") {
        role.working = true;
        role.pendingCount += 1;
        if (entry.model && !role.activeModels.includes(entry.model)) role.activeModels.push(entry.model);
        if (entry.purpose && !role.purposes.includes(entry.purpose)) role.purposes.push(entry.purpose);
      } else if (entry.status !== "succeeded" && entry.error) {
        role.lastError = { at: entry.finishedAt, purpose: entry.purpose, code: entry.error.code, message: String(entry.error.message || "").slice(0, 300) };
      } else if (entry.status === "succeeded" && role.lastError && entry.finishedAt > role.lastError.at) {
        role.lastError = null;
      }
    }
    return view;
  }

  pendingExchanges() {
    return this.exchanges.filter((entry) => entry.status === "pending").map((entry) => ({ ...entry, elapsedAtDumpMs: Math.max(0, Date.now() - Date.parse(entry.startedAt)) }));
  }
}
