// OpenRouter chat-completions transport and model catalogue. Adapted from Society src/openrouter.js
// (performProviderAttempt: sanitized request/response diagnostics, timeout via AbortController, truncation and
// empty-completion detection). Beholder adds bounded transport retries with backoff for timeouts, network errors,
// 429 and 5xx. It never switches to a model the owner did not select.
import { coded, nowIso, sleep } from "./utils.js";
import { sanitize } from "./sanitize.js";

export const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models";
export const OPENROUTER_KEY_ENDPOINT = "https://openrouter.ai/api/v1/key";
export const TRUNCATION_FINISH_REASONS = Object.freeze(["length", "max_tokens", "max_output_tokens"]);
// Society PROVIDER_BLACKLIST.
const PROVIDER_IGNORE = ["alibaba", "Phala", "SiliconFlow", "GMICloud"];
export const TRANSPORT_ATTEMPTS = 3;
const RETRYABLE_CODES = new Set(["NETWORK_ERROR", "AI_REQUEST_TIMEOUT", "RATE_LIMITED", "PROVIDER_5XX", "MALFORMED_PROVIDER_RESPONSE", "AI_PROVIDER_COMPLETION_ERROR"]);

export function isRetryableTransportError(error) { return RETRYABLE_CODES.has(error?.code); }

function retryDelayMs(error, attempt, baseMs) {
  const retryAfter = Number(error?.retryAfterSeconds);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(30_000, retryAfter * 1000);
  return Math.round(baseMs * 3 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
}

async function performAttempt({ apiKey, body, timeoutMs, fetchImpl, diagnostics, meta, attempt, signal }) {
  const startedMs = Date.now();
  const exchangeId = diagnostics?.beginExchange({ ...meta, attempt, model: body.model, timeoutMs, maxTokens: body.max_tokens, request: sanitize(body, [apiKey]) });
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort(); else signal?.addEventListener?.("abort", onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let response;
  let rawBody = "";
  const fail = (error, patch = {}) => {
    error.exchangeId = exchangeId;
    diagnostics?.finishExchange(exchangeId, { status: error.code === "AI_REQUEST_TIMEOUT" ? "timed_out" : error.code === "AI_REQUEST_ABORTED" ? "aborted" : "failed", finishedAt: nowIso(),
      elapsedMs: Date.now() - startedMs, ...patch, error: { code: error.code, message: error.message, httpStatus: error.httpStatus ?? null } });
    return error;
  };
  try {
    response = await fetchImpl(OPENROUTER_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "Beholder", "X-Beholder-Purpose": meta.purpose },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    rawBody = await response.text();
  } catch (cause) {
    const aborted = !timedOut && (cause?.name === "AbortError" || controller.signal.aborted);
    throw fail(coded(timedOut ? "AI_REQUEST_TIMEOUT" : aborted ? "AI_REQUEST_ABORTED" : "NETWORK_ERROR",
      timedOut ? `OpenRouter request timed out after ${timeoutMs} ms.` : aborted ? "OpenRouter request was aborted." : `OpenRouter network error: ${cause?.message || cause}`));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
  let parsed = null;
  try { parsed = rawBody ? JSON.parse(rawBody) : null; } catch {}
  const providerDiagnostic = sanitize({ status: response.status, headers: Object.fromEntries(response.headers?.entries?.() || []), rawBody: rawBody.slice(0, 200_000) }, [apiKey]);
  const usage = parsed?.usage || null;
  const usageView = usage ? { promptTokens: usage.prompt_tokens ?? null, completionTokens: usage.completion_tokens ?? null, reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null, cost: usage.cost ?? null } : null;
  if (!response.ok) {
    const message = parsed?.error?.message || rawBody.slice(0, 500) || response.statusText;
    const code = response.status === 401 ? "AUTHENTICATION_FAILED" : response.status === 429 ? "RATE_LIMITED" : response.status >= 500 ? "PROVIDER_5XX" : "PROVIDER_REQUEST_FAILED";
    const error = coded(code, `OpenRouter ${response.status}: ${message}`, { httpStatus: response.status, retryAfterSeconds: Number(response.headers?.get?.("retry-after")) || null });
    throw fail(error, { providerDiagnostic });
  }
  const choice = parsed?.choices?.[0];
  const finishReason = String(choice?.finish_reason || choice?.native_finish_reason || "").toLowerCase() || null;
  const content = typeof choice?.message?.content === "string" ? choice.message.content : null;
  if (!choice || TRUNCATION_FINISH_REASONS.includes(finishReason) || finishReason === "error" || !content || !content.trim()) {
    const truncated = TRUNCATION_FINISH_REASONS.includes(finishReason);
    const error = coded(truncated ? "AI_OUTPUT_TRUNCATED" : finishReason === "error" ? "AI_PROVIDER_COMPLETION_ERROR" : "MALFORMED_PROVIDER_RESPONSE",
      truncated ? "OpenRouter completion was truncated by the output-token budget (reasoning may have consumed it)." : finishReason === "error" ? "OpenRouter provider returned an error completion." : "OpenRouter returned no assistant content.",
      { finishReason, partialContent: content });
    throw fail(error, { providerDiagnostic, usage: usageView, finishReason, response: { content } });
  }
  diagnostics?.finishExchange(exchangeId, { status: "succeeded", finishedAt: nowIso(), elapsedMs: Date.now() - startedMs, modelSelected: parsed.model || body.model, provider: parsed.provider || null,
    usage: usageView, finishReason, response: { content } });
  return { content, model: parsed.model || body.model, provider: parsed.provider || null, usage: usageView, finishReason, exchangeId };
}

// One logical chat completion with bounded transport retries. temperature === null leaves the provider default.
export async function callOpenRouter({ apiKey, model, messages, maxTokens, temperature = null, timeoutMs = 180_000, fetchImpl = fetch, diagnostics = null, meta = {}, signal = null, backoffMs = 1000, attempts = TRANSPORT_ATTEMPTS }) {
  if (!apiKey) throw coded("API_KEY_MISSING", "Enter the OpenRouter API key first.");
  const body = {
    model,
    stream: false,
    max_tokens: maxTokens,
    ...(typeof temperature === "number" ? { temperature } : {}),
    provider: { allow_fallbacks: true, ignore: PROVIDER_IGNORE },
    messages
  };
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await performAttempt({ apiKey, body, timeoutMs, fetchImpl, diagnostics, meta: { ...meta, retryReason: lastError?.code || null }, attempt, signal });
    } catch (error) {
      lastError = error;
      if (!isRetryableTransportError(error) || attempt === attempts || signal?.aborted) throw error;
      await sleep(retryDelayMs(error, attempt, backoffMs));
    }
  }
  throw lastError;
}

// Public model catalogue (no key required). Used to populate selectors and to respect per-model constraints:
// whether `temperature` is a supported parameter and the provider's maximum completion tokens.
export async function fetchModelCatalog({ fetchImpl = fetch, timeoutMs = 20_000, query = "" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${OPENROUTER_MODELS_ENDPOINT}${query}`, { headers: { Accept: "application/json" }, signal: controller.signal });
    if (!response.ok) throw coded("MODEL_CATALOG_UNAVAILABLE", `Model catalogue HTTP ${response.status}.`);
    const body = await response.json();
    const list = Array.isArray(body?.data) ? body.data : [];
    return list.filter((entry) => typeof entry?.id === "string").map((entry) => ({
      id: entry.id,
      name: typeof entry.name === "string" ? entry.name : entry.id,
      contextLength: Number.isFinite(entry.context_length) ? entry.context_length : null,
      maxCompletionTokens: Number.isFinite(entry.top_provider?.max_completion_tokens) ? entry.top_provider.max_completion_tokens : null,
      supportedParameters: Array.isArray(entry.supported_parameters) ? entry.supported_parameters.filter((value) => typeof value === "string") : null,
      inputModalities: Array.isArray(entry.architecture?.input_modalities) ? entry.architecture.input_modalities : null,
      outputModalities: Array.isArray(entry.architecture?.output_modalities) ? entry.architecture.output_modalities : null,
      pricing: entry.pricing && typeof entry.pricing === "object" ? { prompt: entry.pricing.prompt ?? null, completion: entry.pricing.completion ?? null, image: entry.pricing.image ?? null } : null
    }));
  } catch (error) {
    if (error.code) throw error;
    throw coded("MODEL_CATALOG_UNAVAILABLE", `Model catalogue unavailable: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// Verifies a key without spending tokens. Network failure is reported as unverified rather than invalid.
export async function verifyApiKey({ apiKey, fetchImpl = fetch, timeoutMs = 15_000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(OPENROUTER_KEY_ENDPOINT, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }, signal: controller.signal });
    if (response.status === 401 || response.status === 403) return { verified: false, valid: false };
    return { verified: response.ok, valid: true };
  } catch {
    return { verified: false, valid: true };
  } finally {
    clearTimeout(timer);
  }
}
