// Character-owned AI configuration (Specification 0005 A2): each character stores its own copy of this contract.
// Global state is infrastructure only; the OpenRouter key lives only in RuntimeKey below.
import { coded, isObject } from "./utils.js";

// Curated defaults follow Society src/models.js (SUPPORTED_WORLD_MODELS); any OpenRouter model id may be selected.
export const CURATED_TEXT_MODELS = Object.freeze([
  { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { id: "google/gemma-4-31b-it", label: "Gemma 4 31B IT" },
  { id: "google/gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite" },
  { id: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash" },
  { id: "qwen/qwen3-235b-a22b-2507", label: "Qwen3 235B A22B Instruct 2507" }
]);
// Specification 0003 V2: curated multimodal models for perceiving user-uploaded images (any compatible id is accepted).
export const CURATED_VISION_MODELS = Object.freeze([
  { id: "google/gemini-3-flash-preview", label: "Google Gemini 3 Flash Preview" },
  { id: "qwen/qwen3-vl-235b-a22b-instruct", label: "Qwen3-VL-235B-A22B Instruct" },
  { id: "google/gemini-3.1-flash-lite", label: "Google Gemini 3.1 Flash Lite" }
]);
// Society src/world-illustration.js ILLUSTRATION_MODEL.
export const DEFAULT_IMAGE_MODEL = "openai/gpt-image-2";

// Roles with text output (their own temperature and output budget) and every model role.
export const TEXT_ROLES = Object.freeze(["dialogue", "contemplation", "vision"]);
export const MODEL_ROLES = Object.freeze(["dialogue", "contemplation", "vision", "image"]);
export const MAX_OUTPUT_TOKENS_LIMIT = 200_000;

// Built-in defaults for a new character (never copied from another character).
export function defaultConfig() {
  return {
    models: { dialogue: CURATED_TEXT_MODELS[0].id, contemplation: CURATED_TEXT_MODELS[0].id, vision: CURATED_VISION_MODELS[0].id, image: DEFAULT_IMAGE_MODEL },
    temperature: { dialogue: { enabled: false, value: 0.8 }, contemplation: { enabled: false, value: 0.8 }, vision: { enabled: false, value: 0.8 } },
    maxTokens: { dialogue: 8192, contemplation: 16384, vision: 4096 },
    imageEnabled: false,
    contemplationEnabled: true
  };
}

const MODEL_ID = /^[A-Za-z0-9._\-]+\/[A-Za-z0-9._\-:]+$/;

// Strict validation of a full configuration; unknown keys are rejected so the stored shape stays exact.
export function validateConfig(value) {
  const errors = [];
  if (!isObject(value)) throw coded("CONFIG_INVALID", "The AI configuration must be an object.", { status: 400 });
  const allowed = ["models", "temperature", "maxTokens", "imageEnabled", "contemplationEnabled"];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`Unknown setting ${key}.`);
  for (const role of MODEL_ROLES) {
    const model = value.models?.[role];
    if (typeof model !== "string" || !MODEL_ID.test(model.trim()) || model.length > 200) errors.push(`models.${role} must be an OpenRouter model id such as vendor/model.`);
  }
  for (const role of TEXT_ROLES) {
    const temperature = value.temperature?.[role];
    if (!isObject(temperature) || typeof temperature.enabled !== "boolean" || typeof temperature.value !== "number" || !Number.isFinite(temperature.value) || temperature.value < 0 || temperature.value > 2) {
      errors.push(`temperature.${role} must be { enabled: boolean, value: number from 0 to 2 }.`);
    }
    const max = value.maxTokens?.[role];
    if (!Number.isInteger(max) || max < 256 || max > MAX_OUTPUT_TOKENS_LIMIT) errors.push(`maxTokens.${role} must be an integer from 256 to ${MAX_OUTPUT_TOKENS_LIMIT}.`);
  }
  if (typeof value.imageEnabled !== "boolean") errors.push("imageEnabled must be boolean.");
  if (typeof value.contemplationEnabled !== "boolean") errors.push("contemplationEnabled must be boolean.");
  if (errors.length) throw coded("CONFIG_INVALID", errors.join(" "), { validationErrors: errors, status: 400 });
  return {
    models: Object.fromEntries(MODEL_ROLES.map((role) => [role, value.models[role].trim()])),
    temperature: Object.fromEntries(TEXT_ROLES.map((role) => [role, { enabled: value.temperature[role].enabled, value: value.temperature[role].value }])),
    maxTokens: Object.fromEntries(TEXT_ROLES.map((role) => [role, value.maxTokens[role]])),
    imageEnabled: value.imageEnabled,
    contemplationEnabled: value.contemplationEnabled
  };
}

// A patch over a complete configuration: the nested per-role maps merge role by role, then the whole result is
// validated strictly. The legacy global settings were merged onto the defaults the same way (Specification 0005 A4).
export function mergeConfig(base, patch) {
  if (!isObject(patch)) throw coded("CONFIG_INVALID", "The AI configuration must be an object.", { status: 400 });
  const merged = { ...base, ...patch };
  for (const key of ["models", "temperature", "maxTokens"]) if (isObject(base[key]) && isObject(patch[key])) merged[key] = { ...base[key], ...patch[key] };
  return validateConfig(merged);
}

export const DESCRIPTION_MAX = 20_000;
export const DESCRIPTION_FIELDS = Object.freeze(["description", "sceneDescription", "userDescription"]);

function deepFreeze(value) {
  if (value && typeof value === "object") { for (const entry of Object.values(value)) deepFreeze(entry); Object.freeze(value); }
  return value;
}

// The frozen snapshot one AI job uses for all of its calls (Specification 0005 A5): the character's identity, its
// three descriptions and its complete role configuration as they were when the job started.
export function profileOf(character) {
  if (!character) throw coded("CHARACTER_NOT_FOUND", "Character not found.");
  return deepFreeze(structuredClone({ characterId: character.id, name: character.name, description: character.description,
    sceneDescription: character.sceneDescription, userDescription: character.userDescription, config: character.config }));
}

// The OpenRouter key exists only in this process's memory. It is never persisted, logged, or sent to the browser.
export class RuntimeKey {
  #key = null;
  set(value) {
    if (typeof value !== "string" || !value.trim() || value.length > 500 || /\s/.test(value.trim())) throw coded("API_KEY_INVALID", "Enter an OpenRouter API key.");
    this.#key = value.trim();
  }
  get() { return this.#key; }
  configured() { return Boolean(this.#key); }
  clear() { this.#key = null; }
}
