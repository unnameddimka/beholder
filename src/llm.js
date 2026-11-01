// Named-purpose LLM calls on top of the OpenRouter transport. Each purpose maps to one model role (Dialogue or
// Contemplation); memory purposes use the Dialogue model as Specification 0000 section 4.1 requires. Structured
// outputs are parsed and validated; malformed output gets bounded LLM repair (pattern from Society
// src/memory-generation.js generateValidatedDraft) and is never committed.
import { callOpenRouter, fetchModelCatalog } from "./openrouter.js";
import { coded, parseModelJson } from "./utils.js";
import { REPAIR_INSTRUCTION, TRUNCATION_RECOVERY_INSTRUCTION } from "./prompts/repair.js";

export const PURPOSE_ROLES = Object.freeze({
  dialogue_reply: "dialogue",
  dialogue_followup: "dialogue",
  dialogue_opener: "dialogue",
  dialogue_memory_retrieval: "dialogue",
  memory_stm_consolidation: "dialogue",
  memory_ltm_selection: "dialogue",
  memory_ltm_consolidation: "dialogue",
  contemplation_prefetch: "contemplation",
  contemplation_memory_retrieval: "contemplation",
  contemplation_maintenance: "contemplation",
  contemplation_generation: "contemplation",
  contemplation_generation_review: "contemplation",
  contemplation_experiment_planning: "contemplation"
});

export const REPAIR_ATTEMPTS = 2;
const TIMEOUTS = { dialogue: 150_000, contemplation: 240_000 };
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

export class LlmClient {
  constructor({ settings, key, diagnostics, fetchImpl = fetch, backoffMs = 1000, timeouts = TIMEOUTS }) {
    this.settings = settings;
    this.key = key;
    this.diagnostics = diagnostics;
    this.fetchImpl = fetchImpl;
    this.backoffMs = backoffMs;
    this.timeouts = timeouts;
    this.catalog = null;
  }

  async modelCatalog({ refresh = false } = {}) {
    if (!refresh && this.catalog && Date.now() - this.catalog.at < CATALOG_TTL_MS) return this.catalog;
    const models = await fetchModelCatalog({ fetchImpl: this.fetchImpl });
    this.catalog = { at: Date.now(), models, byId: new Map(models.map((model) => [model.id, model])) };
    return this.catalog;
  }

  // Effective request parameters for a role, honoring catalogue constraints when the catalogue is known.
  requestParameters(role) {
    const settings = this.settings.get();
    const model = settings.models[role];
    const entry = this.catalog?.byId.get(model) || null;
    let maxTokens = settings.maxTokens[role];
    if (entry?.maxCompletionTokens && maxTokens > entry.maxCompletionTokens) maxTokens = entry.maxCompletionTokens;
    const temperatureSetting = settings.temperature[role];
    const temperatureSupported = !entry?.supportedParameters || entry.supportedParameters.includes("temperature");
    const temperature = temperatureSetting.enabled && temperatureSupported ? temperatureSetting.value : null;
    return { model, maxTokens, temperature };
  }

  async call({ purpose, messages, context = {}, signal = null }) {
    const role = PURPOSE_ROLES[purpose];
    if (!role) throw coded("PURPOSE_UNKNOWN", `No model role is registered for ${purpose}.`);
    const { model, maxTokens, temperature } = this.requestParameters(role);
    return callOpenRouter({
      apiKey: this.key.get(), model, messages, maxTokens, temperature, timeoutMs: this.timeouts[role], fetchImpl: this.fetchImpl, diagnostics: this.diagnostics,
      meta: { purpose, modelRole: role, ...context }, signal, backoffMs: this.backoffMs
    });
  }

  // Structured call: technical truncation retry once, then JSON parse + validate with up to REPAIR_ATTEMPTS repairs.
  // validate(raw) returns { ok: true, value } or { ok: false, errors: [...] }.
  async structured({ purpose, messages, validate, context = {}, signal = null }) {
    const trace = { exchangeIds: [], repairs: 0, truncationRetry: false };
    const call = async (callMessages) => {
      const result = await this.call({ purpose, messages: callMessages, context, signal });
      trace.exchangeIds.push(result.exchangeId);
      return result;
    };
    let response;
    try { response = await call(messages); }
    catch (error) {
      if (error?.code !== "AI_OUTPUT_TRUNCATED") throw error;
      trace.truncationRetry = true;
      response = await call([...messages, { role: "system", content: TRUNCATION_RECOVERY_INSTRUCTION }]);
    }
    const check = (content) => {
      try { return validate(parseModelJson(content)); }
      catch (error) { return { ok: false, errors: [`response is not valid JSON: ${error.message}`] }; }
    };
    let validation = check(response.content);
    while (!validation.ok) {
      if (trace.repairs >= REPAIR_ATTEMPTS) {
        throw coded("AI_OUTPUT_INVALID", `${purpose} output stayed invalid after ${REPAIR_ATTEMPTS} repairs: ${validation.errors.slice(0, 8).join("; ")}`, { validationErrors: validation.errors, trace });
      }
      trace.repairs += 1;
      this.diagnostics?.event({ type: "llm-repair", purpose, attempt: trace.repairs, errors: validation.errors.slice(0, 20), ...context });
      response = await call([...messages, { role: "assistant", content: String(response.content) },
        { role: "system", content: `${REPAIR_INSTRUCTION}\nValidation errors: ${JSON.stringify(validation.errors.slice(0, 30))}` }]);
      validation = check(response.content);
    }
    return { value: validation.value, model: response.model, trace };
  }
}
