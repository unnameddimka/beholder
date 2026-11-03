// Contracts of the structured Contemplation purposes (Specification 0006 R1): for each purpose its model role, readable
// system prompt (src/prompts/contemplation.js), required response shape, shape validator, and the snapshot-scoped
// checks and limits that JSON shape alone cannot express. Validators that need the current input snapshot take it as
// an argument; the stage that read the snapshot binds it. Transport policy (no response_format, contextual repair,
// one truncation retry) is the default of LlmClient.structured for every non-Dialogue purpose.
import { exactKeys } from "../utils.js";
import {
  INTERPRETATION_MAX_CHARS, EXPERIMENT_MAX_CHARS, GESTALT_MAX_CHARS,
  prefetchSystemPrompt, consolidationSystemPrompt, maintenanceSystemPrompt, generationSystemPrompt, generationReviewSystemPrompt, gestaltizationSystemPrompt, experimentPlanningSystemPrompt
} from "../prompts/contemplation.js";

// Stable wire ids of interpretations and experiments in model payloads.
export const wireInterpretation = (id) => `int_${id}`;
export const wireExperiment = (id) => `exp_${id}`;
export const parseWire = (value, prefix) => {
  const match = typeof value === "string" ? new RegExp(`^${prefix}_(\\d+)$`).exec(value) : null;
  return match ? Number(match[1]) : null;
};

// ---- validators -------------------------------------------------------------------------------------------------

export function validatePrefetch(raw) {
  if (!exactKeys(raw, ["generation", "maintenance"]) || typeof raw.generation !== "boolean" || typeof raw.maintenance !== "boolean") {
    return { ok: false, errors: ["response must be exactly {\"generation\": boolean, \"maintenance\": boolean}."] };
  }
  return { ok: true, value: { generation: raw.generation, maintenance: raw.maintenance } };
}

export function validateMaintenance(raw, experimentIds) {
  const errors = [];
  if (!exactKeys(raw, ["action", "text", "completedExperimentIds"])) return { ok: false, errors: ["response must contain exactly action, text and completedExperimentIds."] };
  if (!["unchanged", "replace", "delete"].includes(raw.action)) errors.push("action must be unchanged, replace, or delete.");
  if (raw.action === "replace") {
    if (typeof raw.text !== "string" || !raw.text.trim()) errors.push("text must be the revised interpretation for replace.");
    else if (raw.text.trim().length > INTERPRETATION_MAX_CHARS) errors.push(`text must be at most ${INTERPRETATION_MAX_CHARS} characters.`);
  } else if (raw.text !== null) errors.push("text must be null unless action is replace.");
  if (!Array.isArray(raw.completedExperimentIds)) errors.push("completedExperimentIds must be an array.");
  else for (const id of raw.completedExperimentIds) if (!experimentIds.has(id)) errors.push(`completedExperimentIds contains unknown id ${id}.`);
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { action: raw.action, text: raw.action === "replace" ? raw.text.trim() : null, completedExperimentIds: [...new Set(raw.completedExperimentIds)] } };
}

// Specification 0004 C3: every supplied id is accounted for exactly once, by a representative that is itself one of
// the supplied ids and lists its own id among its sources. Anything partial, invented, or overlapping is invalid.
export function validateConsolidation(raw, suppliedIds) {
  if (!exactKeys(raw, ["interpretations"]) || !Array.isArray(raw.interpretations)) return { ok: false, errors: ["response must be exactly {\"interpretations\": [...]}."] };
  if (!raw.interpretations.length) return { ok: false, errors: ["interpretations must not be empty; every supplied interpretation must be accounted for."] };
  const errors = [];
  const supplied = new Set(suppliedIds);
  const representatives = new Set();
  const accountedBy = new Map();
  const value = [];
  raw.interpretations.forEach((entry, index) => {
    const path = `interpretations[${index}]`;
    if (!exactKeys(entry, ["id", "sourceIds", "text"])) { errors.push(`${path} must contain exactly id, sourceIds and text.`); return; }
    if (!supplied.has(entry.id)) errors.push(`${path}.id must be a supplied interpretation id.`);
    else if (representatives.has(entry.id)) errors.push(`${path}.id repeats ${entry.id}.`);
    representatives.add(entry.id);
    if (!Array.isArray(entry.sourceIds) || !entry.sourceIds.length) errors.push(`${path}.sourceIds must be a non-empty array of supplied ids.`);
    else {
      for (const id of entry.sourceIds) {
        if (!supplied.has(id)) errors.push(`${path}.sourceIds contains unknown id ${JSON.stringify(id)}.`);
        else if (accountedBy.has(id)) errors.push(`${path}.sourceIds: ${id} is already accounted for by interpretations[${accountedBy.get(id)}].`);
        else accountedBy.set(id, index);
      }
      if (!entry.sourceIds.includes(entry.id)) errors.push(`${path}.sourceIds must include its own id ${entry.id}.`);
    }
    if (typeof entry.text !== "string" || !entry.text.trim()) errors.push(`${path}.text must be non-empty text.`);
    else if (entry.text.trim().length > INTERPRETATION_MAX_CHARS) errors.push(`${path}.text must be at most ${INTERPRETATION_MAX_CHARS} characters.`);
    else value.push({ id: entry.id, sourceIds: [...entry.sourceIds], text: entry.text.trim() });
  });
  for (const id of suppliedIds) if (!accountedBy.has(id)) errors.push(`supplied interpretation ${id} is not accounted for.`);
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

export function validateGeneration(raw) {
  const errors = [];
  if (!exactKeys(raw, ["decision", "text"])) return { ok: false, errors: ["response must contain exactly decision and text."] };
  if (!["add", "decline"].includes(raw.decision)) errors.push("decision must be add or decline.");
  if (raw.decision === "add") {
    if (typeof raw.text !== "string" || !raw.text.trim()) errors.push("text must be the new interpretation for add.");
    else if (raw.text.trim().length > INTERPRETATION_MAX_CHARS) errors.push(`text must be at most ${INTERPRETATION_MAX_CHARS} characters.`);
  } else if (raw.text !== null) errors.push("text must be null for decline.");
  return errors.length ? { ok: false, errors } : { ok: true, value: { decision: raw.decision, text: raw.decision === "add" ? raw.text.trim() : null } };
}

export function validateGenerationReview(raw) {
  if (!exactKeys(raw, ["accept", "problem"]) || typeof raw.accept !== "boolean" || !(raw.problem === null || typeof raw.problem === "string")) {
    return { ok: false, errors: ["response must be exactly {\"accept\": boolean, \"problem\": string or null}."] };
  }
  return { ok: true, value: { accept: raw.accept, problem: raw.problem ? raw.problem.slice(0, 500) : null } };
}

export function validateGestalt(raw) {
  if (!exactKeys(raw, ["gestalt"]) || typeof raw.gestalt !== "string" || !raw.gestalt.trim()) return { ok: false, errors: ["response must be exactly {\"gestalt\": non-empty text}."] };
  if (raw.gestalt.trim().length > GESTALT_MAX_CHARS) return { ok: false, errors: [`gestalt must be at most ${GESTALT_MAX_CHARS} characters.`] };
  return { ok: true, value: raw.gestalt.trim() };
}

export function validatePlanning(raw, experimentIds) {
  const errors = [];
  if (!exactKeys(raw, ["experiments"]) || !Array.isArray(raw.experiments)) return { ok: false, errors: ["response must be exactly {\"experiments\": [...]}."] };
  const seen = new Set();
  const value = [];
  raw.experiments.forEach((entry, index) => {
    const path = `experiments[${index}]`;
    if (!exactKeys(entry, ["id", "text"])) { errors.push(`${path} must contain exactly id and text.`); return; }
    if (entry.id !== null) {
      if (!experimentIds.has(entry.id)) errors.push(`${path}.id must be null or a supplied experiment id.`);
      else if (seen.has(entry.id)) errors.push(`${path}.id repeats ${entry.id}.`);
      seen.add(entry.id);
    }
    if (typeof entry.text !== "string" || !entry.text.trim()) errors.push(`${path}.text must be non-empty text.`);
    else if (entry.text.trim().length > EXPERIMENT_MAX_CHARS) errors.push(`${path}.text must be at most ${EXPERIMENT_MAX_CHARS} characters.`);
    else value.push({ id: entry.id, text: entry.text.trim() });
  });
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

// ---- contracts --------------------------------------------------------------------------------------------------

// responseShape is the requiredResponseShape example sent in each request payload (part of the prompt bytes).
export const CONTEMPLATION_CONTRACTS = Object.freeze({
  contemplation_prefetch: {
    role: "contemplation",
    systemPrompt: prefetchSystemPrompt,
    responseShape: { generation: false, maintenance: false },
    validate: validatePrefetch,
    input: "characterContext, the whole interpretation pool, the active experiments, and up to the last 100 verbatim messages; no consolidated memory.",
    checks: []
  },
  contemplation_consolidation: {
    role: "contemplation",
    systemPrompt: consolidationSystemPrompt,
    responseShape: { interpretations: [{ id: "int_1", sourceIds: ["int_1"], text: "..." }] },
    validate: validateConsolidation, // (raw, suppliedIds of the snapshot read)
    input: "characterContext and every interpretation of the snapshot; never truncated.",
    checks: ["every supplied id accounted for exactly once", "representatives are supplied ids listing themselves", `text at most ${INTERPRETATION_MAX_CHARS} characters`,
      "refused before the call when the snapshot does not fit the context (CONSOLIDATION_CONTEXT_EXCEEDED) or the output budget (CONSOLIDATION_OUTPUT_EXCEEDED)"]
  },
  contemplation_maintenance: {
    role: "contemplation",
    systemPrompt: maintenanceSystemPrompt,
    responseShape: { action: "unchanged", text: null, completedExperimentIds: [] },
    validate: validateMaintenance, // (raw, experiment ids every verifier saw)
    input: "characterContext, one consolidated candidate, the conversation, retrieved memory, and the active experiments.",
    checks: ["completedExperimentIds are supplied experiment ids", `replace text at most ${INTERPRETATION_MAX_CHARS} characters`,
      "applied only if the interpretation and experiment snapshots are unchanged at commit"]
  },
  contemplation_generation: {
    role: "contemplation",
    systemPrompt: generationSystemPrompt,
    responseShape: { decision: "add", text: "..." },
    validate: validateGeneration,
    input: "characterContext, every interpretation, the conversation, retrieved memory, and the rejected previous candidate if any.",
    checks: [`text at most ${INTERPRETATION_MAX_CHARS} characters`, "committed only after an accepting review against the interpretation revision it read"]
  },
  contemplation_generation_review: {
    role: "contemplation",
    systemPrompt: generationReviewSystemPrompt,
    responseShape: { accept: true, problem: null },
    validate: validateGenerationReview,
    input: "characterContext, the existing interpretations, the candidate, the conversation, and retrieved memory.",
    checks: ["problem truncated to 500 characters"]
  },
  contemplation_gestaltization: {
    role: "contemplation",
    systemPrompt: gestaltizationSystemPrompt,
    responseShape: { gestalt: "..." },
    validate: validateGestalt,
    input: "characterContext, every current interpretation with the revision read, and the previous gestalt; never experiments or memory.",
    checks: [`gestalt at most ${GESTALT_MAX_CHARS} characters`, "refused before the call when the set does not fit the context (GESTALT_CONTEXT_EXCEEDED)",
      "committed only against the interpretation revision it read"]
  },
  contemplation_experiment_planning: {
    role: "contemplation",
    systemPrompt: experimentPlanningSystemPrompt,
    responseShape: { experiments: [{ id: null, text: "..." }] },
    validate: validatePlanning, // (raw, experiment ids of the snapshot read)
    input: "characterContext, the interpretation pool, and the active experiments.",
    checks: ["ids are null or supplied experiment ids, without repeats", `text at most ${EXPERIMENT_MAX_CHARS} characters`,
      "replaces the whole array only against the interpretation and experiment revisions it read"]
  }
});
