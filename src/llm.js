// Named-purpose LLM calls on top of the OpenRouter transport. Each purpose maps to one model role (Dialogue or
// Contemplation); memory purposes use the Dialogue model as Specification 0000 section 4.1 requires. Structured
// outputs are parsed and validated; malformed output gets bounded LLM repair (pattern from Society
// src/memory-generation.js generateValidatedDraft) and is never committed.
import { callOpenRouter, fetchModelCatalog } from "./openrouter.js";
import { coded, parseModelJson } from "./utils.js";
import { REPAIR_INSTRUCTION, TRUNCATION_RECOVERY_INSTRUCTION, DIALOGUE_REPAIR_INSTRUCTION } from "./prompts/repair.js";
import { DIALOGUE_RESPONSE_FORMAT } from "./prompts/dialogue.js";

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
const DIALOGUE_ENVELOPE_PURPOSES = new Set(["dialogue_reply", "dialogue_followup", "dialogue_opener"]);
export const DIALOGUE_FORMAT_MODES = Object.freeze(["json_schema", "json_object", "prompt"]);
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
    this.formatDowngrades = new Map(); // model id -> lowest DIALOGUE_FORMAT_MODES index allowed
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

  async call({ purpose, messages, context = {}, signal = null, responseFormat = null }) {
    const role = PURPOSE_ROLES[purpose];
    if (!role) throw coded("PURPOSE_UNKNOWN", `No model role is registered for ${purpose}.`);
    const { model, maxTokens, temperature } = this.requestParameters(role);
    return callOpenRouter({
      apiKey: this.key.get(), model, messages, maxTokens, temperature, timeoutMs: this.timeouts[role], fetchImpl: this.fetchImpl, diagnostics: this.diagnostics,
      meta: { purpose, modelRole: role, ...context }, signal, backoffMs: this.backoffMs, responseFormat
    });
  }

  // Provider-enforced dialogue format, best first: strict JSON schema, JSON-object mode, then prompt-only. Only
  // modes the catalogue advertises for the model are ever requested; prompt-only is always available. The catalogue
  // is a hint for the model as a whole, so a request that OpenRouter rejects because no endpoint supports the format
  // steps down to the next advertised mode with the same model; the step is kept until restart.
  dialogueFormatModes(model) {
    const parameters = this.catalog?.byId.get(model)?.supportedParameters || [];
    return DIALOGUE_FORMAT_MODES.filter((mode) => mode === "prompt" || parameters.includes(mode === "json_schema" ? "structured_outputs" : "response_format"));
  }

  async dialogueFormatMode() {
    try { await this.modelCatalog(); } catch {} // An unavailable catalogue means prompt-only enforcement.
    const model = this.requestParameters("dialogue").model;
    const floor = this.formatDowngrades.get(model) ?? 0;
    return this.dialogueFormatModes(model).find((mode) => DIALOGUE_FORMAT_MODES.indexOf(mode) >= floor);
  }

  // Structured call: technical truncation retry once, then JSON parse + validate with up to REPAIR_ATTEMPTS repairs.
  // validate(raw) returns { ok: true, value } or { ok: false, errors: [...] }.
  async structured({ purpose, messages, validate, context = {}, signal = null }) {
    const dialogue = DIALOGUE_ENVELOPE_PURPOSES.has(purpose);
    let formatMode = dialogue ? await this.dialogueFormatMode() : null;
    const trace = { exchangeIds: [], repairs: 0, truncationRetry: false, normalizedPlainText: false, formatMode };
    const call = async (callMessages) => {
      for (;;) {
        try {
          const result = await this.call({ purpose, messages: callMessages, context: dialogue ? { ...context, responseFormatMode: formatMode } : context, signal,
            responseFormat: dialogue ? dialogueResponseFormat(formatMode) : null });
          trace.exchangeIds.push(result.exchangeId);
          return result;
        } catch (error) {
          if (error?.exchangeId) trace.exchangeIds.push(error.exchangeId);
          if (!dialogue || formatMode === "prompt" || !isFormatRejection(error)) throw error;
          const model = this.requestParameters("dialogue").model;
          const current = DIALOGUE_FORMAT_MODES.indexOf(formatMode);
          const next = this.dialogueFormatModes(model).find((mode) => DIALOGUE_FORMAT_MODES.indexOf(mode) > current);
          this.formatDowngrades.set(model, Math.max(DIALOGUE_FORMAT_MODES.indexOf(next), this.formatDowngrades.get(model) ?? 0));
          this.diagnostics?.event({ type: "dialogue-format-downgrade", purpose, model, from: formatMode, to: next, httpStatus: error.httpStatus ?? null, ...context });
          formatMode = next;
          trace.formatMode = formatMode;
        }
      }
    };
    // A truncated output is never a plain-text candidate: it goes through truncation recovery first.
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
    // A dialogue model sometimes answers with ordinary roleplay prose instead of the envelope. A complete answer
    // generated from the full context (not a repair output) is accepted as written, without another model call
    // that might repeat an earlier turn. Attempted JSON still goes to repair.
    if (!validation.ok && dialogue && !looksLikeAttemptedJson(response.content)) {
      const plain = validate({ message: String(response.content).trim(), followUpDelaySeconds: null, imageRequest: null });
      if (plain.ok) {
        validation = plain;
        trace.normalizedPlainText = true;
        this.diagnostics?.event({ type: "dialogue-plain-text-normalized", purpose, characters: plain.value.message.length, formatMode, ...context });
      }
    }
    while (!validation.ok) {
      if (trace.repairs >= REPAIR_ATTEMPTS) {
        throw coded("AI_OUTPUT_INVALID", `${purpose} output stayed invalid after ${REPAIR_ATTEMPTS} repairs: ${validation.errors.slice(0, 8).join("; ")}`, { validationErrors: validation.errors, trace });
      }
      trace.repairs += 1;
      this.diagnostics?.event({ type: "llm-repair", purpose, attempt: trace.repairs, errors: validation.errors.slice(0, 20), ...context });
      const errors = JSON.stringify(validation.errors.slice(0, 30));
      // Dialogue repair is isolated: only the invalid output, the contract and the errors, never the chat context.
      const repairMessages = dialogue ? [
        { role: "system", content: DIALOGUE_REPAIR_INSTRUCTION },
        { role: "user", content: `Invalid response to repair (not a new dialogue turn):\n${String(response.content)}\nValidation errors: ${errors}` }
      ] : [...messages, { role: "assistant", content: String(response.content) },
        { role: "system", content: `${REPAIR_INSTRUCTION}\nValidation errors: ${errors}` }];
      response = await call(repairMessages);
      validation = check(response.content);
    }
    return { value: validation.value, model: response.model, trace };
  }
}

// An actual attempt at the envelope: a JSON object, a JSON array ("[" followed by "{", "[", a quote or "]"), a code
// fence opening a JSON value, or an object literal with an envelope field. Prose such as "[laughs softly] ..." or a
// sentence that merely quotes a field name is not an attempt.
export function looksLikeAttemptedJson(content) {
  const text = String(content || "").trim();
  return !text || /^\{/.test(text) || /^\[\s*[{\["\]]/.test(text) || /^\x60{3}[A-Za-z]*\s*[{\[]/.test(text)
    || /\{\s*"(message|followUpDelaySeconds|imageRequest)"\s*:/.test(text);
}

function dialogueResponseFormat(mode) {
  return mode === "json_schema" ? DIALOGUE_RESPONSE_FORMAT : mode === "json_object" ? { type: "json_object" } : null;
}

// OpenRouter refuses a request whose required parameters no endpoint of the model supports (HTTP 404 "No endpoints
// found that can handle the requested parameters"); a provider may also reject the format itself with a 4xx.
export function isFormatRejection(error) {
  if (error?.code !== "PROVIDER_REQUEST_FAILED" || ![400, 404, 422].includes(error.httpStatus)) return false;
  return /response.?format|structured.?output|json.?(schema|object|mode)|require_parameters|requested parameters/i.test(String(error.message || ""));
}
