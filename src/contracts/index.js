// The LLM-operation contracts of every current purpose (Specification 0006 R1), in one discoverable place: model role
// (always resolved from the configuration snapshot the job froze with profileOf), readable system prompt
// (src/prompts/), required response shape, validator, the snapshot-scoped checks beyond shape, and the transport
// policy LlmClient applies. Transport, format downgrade, repair and truncation recovery stay in src/llm.js; this table
// only states which of them apply. It is not a framework: subsystems keep building their own requests.
//
// transport.call: "structured" (LlmClient.structured: JSON parse + validate + bounded repair) or "plain"
//   (LlmClient.call, the caller validates the text once; no repair, no truncation retry).
// transport.responseFormat: "dialogue_envelope" (catalogue-advertised json_schema -> json_object -> prompt-only with
//   downgrade on rejection) or "none" (no response_format is ever sent).
// transport.repair: "dialogue_isolated" (only the invalid output, the contract and the errors), "contextual" (the
//   original messages plus the invalid output and the errors), or "none".
import { CONTEMPLATION_CONTRACTS } from "./contemplation.js";
import { MEMORY_LIMITS, stmSystemPrompt, ltmSelectionSystemPrompt, ltmSystemPrompt, retrievalSystemPrompt, DIALOGUE_RETRIEVAL_PURPOSE, CONTEMPLATION_RETRIEVAL_PURPOSE } from "../prompts/memory.js";
import { dialogueSystemPrompt, validateDialogueEnvelope, DIALOGUE_RESPONSE_FORMAT, MESSAGE_MAX_CHARS, FOLLOW_UP_MAX_SECONDS, IMAGE_REQUEST_MAX_CHARS } from "../prompts/dialogue.js";
import { visionSystemPrompt, VISION_OBSERVATION_MAX_CHARS } from "../prompts/vision.js";
import { validateStmDraft, validateLtmSelection, validateLtmDraft, validateRetrieval } from "../memory.js";
import { validateObservation } from "../vision.js";

const STRUCTURED = Object.freeze({ call: "structured", responseFormat: "none", repair: "contextual", truncationRetry: true, plainTextFallback: false });
const DIALOGUE_ENVELOPE = Object.freeze({ call: "structured", responseFormat: "dialogue_envelope", repair: "dialogue_isolated", truncationRetry: true, plainTextFallback: true });
const PLAIN = Object.freeze({ call: "plain", responseFormat: "none", repair: "none", truncationRetry: false, plainTextFallback: false });

const dialogueEnvelope = (mode) => ({
  role: "dialogue",
  systemPrompt: dialogueSystemPrompt,
  responseShape: DIALOGUE_RESPONSE_FORMAT,
  validate: validateDialogueEnvelope,
  input: `the ${mode} context: system prompt with gestalt and experiment intentions (only while Contemplation is enabled), memories, the pinned User Description, and the active verbatim window.`,
  checks: [`message at most ${MESSAGE_MAX_CHARS} characters`, `followUpDelaySeconds at most ${FOLLOW_UP_MAX_SECONDS}`, `imageRequest at most ${IMAGE_REQUEST_MAX_CHARS} characters`],
  failure: "the turn fails visibly; a complete plain-text reply that is not attempted JSON is accepted as the message",
  transport: DIALOGUE_ENVELOPE
});

const retrieval = (role, purposeText) => ({
  role,
  systemPrompt: () => retrievalSystemPrompt(purposeText),
  responseShape: { stmIds: [], ltmIds: [] },
  validate: validateRetrieval, // (raw, catalogue ids of the request)
  input: "characterContext, the situation, the limits, and the owner pool's whole STM/LTM catalogue.",
  checks: ["unknown and repeated ids dropped", `at most ${MEMORY_LIMITS.CONTEXT_STM_LIMIT} STM and ${MEMORY_LIMITS.CONTEXT_LTM_LIMIT} LTM`],
  failure: "deterministic importance selection (fallback_importance), except a missing key or an abort",
  transport: STRUCTURED
});

const OTHER_CONTRACTS = {
  dialogue_reply: dialogueEnvelope("reply"),
  dialogue_followup: dialogueEnvelope("follow-up"),
  dialogue_opener: dialogueEnvelope("opener"),
  dialogue_memory_retrieval: retrieval("dialogue", DIALOGUE_RETRIEVAL_PURPOSE),
  contemplation_memory_retrieval: retrieval("contemplation", CONTEMPLATION_RETRIEVAL_PURPOSE),
  memory_stm_consolidation: {
    role: "dialogue",
    systemPrompt: stmSystemPrompt,
    responseShape: { shortTermMemoriesToUpsert: [], shortTermMemoriesToAdd: [], stmRepartitions: [] },
    validate: validateStmDraft, // (raw, frozen consumed/retained message ids and supplied STM)
    input: "characterContext, the 20 consumed and the retained verbatim messages, and the supplied STM.",
    checks: ["sources only among consumed messages", "upserts only of supplied STM", `at most ${MEMORY_LIMITS.STM_WRITES_MAX} resulting records`,
      `request at most ${MEMORY_LIMITS.REQUEST_CEILING_CHARS} characters (MEMORY_CAPACITY_EXCEEDED)`],
    failure: "the job fails; no message leaves the active window",
    transport: STRUCTURED
  },
  memory_ltm_selection: {
    role: "dialogue",
    systemPrompt: ltmSelectionSystemPrompt,
    responseShape: { relevantLtmIds: [], contextStmIds: [] },
    validate: validateLtmSelection, // (raw, frozen catalogue ids)
    input: "characterContext, the job's sources, the LTM catalogue and the other STM catalogue.",
    checks: ["ids only from the supplied catalogues"],
    failure: "every catalogue record is supplied (fallback_all)",
    transport: STRUCTURED
  },
  memory_ltm_consolidation: {
    role: "dialogue",
    systemPrompt: ltmSystemPrompt,
    responseShape: { longTermMemoriesToUpsert: [], longTermMemoriesToAdd: [], retirementGroups: [] },
    validate: validateLtmDraft, // (raw, consumable, context and selected records)
    input: "characterContext, the consumable STM, read-only context STM, and the selected LTM.",
    checks: ["every consumable STM in exactly one retirement group", "sources only among supplied records",
      `request at most ${MEMORY_LIMITS.REQUEST_CEILING_CHARS} characters (MEMORY_CAPACITY_EXCEEDED)`],
    failure: "the job fails; its STM stays and the date is not marked",
    transport: STRUCTURED
  },
  vision_observation: {
    role: "vision",
    systemPrompt: visionSystemPrompt,
    responseShape: "one prose observation (plain text, not JSON)",
    validate: validateObservation,
    input: "the attached image, the whole active verbatim window, the gestalt (only while Contemplation is enabled), and characterContext.",
    checks: [`at most ${VISION_OBSERVATION_MAX_CHARS} characters`, "not instruction-shaped or structured output",
      "refused before the call for an incompatible model (VISION_MODEL_INCOMPATIBLE) or an oversized context (VISION_CONTEXT_EXCEEDED)"],
    failure: "no observation is stored; Dialogue is told the image could not be viewed",
    transport: PLAIN
  }
};

const withDefaults = (contract) => ({ failure: "the stage fails and nothing it produced is committed", transport: STRUCTURED, ...contract });

export const CONTRACTS = Object.freeze(Object.fromEntries(Object.entries({ ...OTHER_CONTRACTS, ...CONTEMPLATION_CONTRACTS })
  .map(([purpose, contract]) => [purpose, Object.freeze(withDefaults({ purpose, ...contract }))])));

export const PURPOSE_ROLES = Object.freeze(Object.fromEntries(Object.entries(CONTRACTS).map(([purpose, contract]) => [purpose, contract.role])));

export function contractOf(purpose) { return CONTRACTS[purpose] ?? null; }
