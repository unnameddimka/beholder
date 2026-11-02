// Memory prompts: Verbatim -> STM, daily STM -> LTM (read-only selector + writer), and the semantic retrieval
// selector. Organization and wording adapted from Society src/memory-generation.js (MEMORY_EPISTEMIC_RULES),
// src/memory-stm.js (stmSystemPrompt, STM_DRAFT_TEMPLATE), src/memory-ltm.js (selectionSystemPrompt, ltmSystemPrompt,
// LTM_DRAFT_TEMPLATE), and src/mind-runtime.js (selectMindContext). Society's fictional-calendar temporal anchors are
// replaced by real message timestamps; the engine keeps each record's source period itself.
import { CHARACTER_CONTEXT_RULES } from "./context.js";

export const MEMORY_LIMITS = Object.freeze({
  TOPIC_MAX: 240,
  SUMMARY_MAX: 4000,
  RETRIEVAL_BRIEF_MAX: 600,
  STM_WRITES_MAX: 8,
  DAILY_SOURCE_BATCH_CHARS: 24_000,
  REQUEST_CEILING_CHARS: 128_000,
  CONTEXT_STM_LIMIT: 12,
  CONTEXT_LTM_LIMIT: 8
});
export const FORGET_REASONS = Object.freeze(["routine", "redundant", "transient"]);

export const MEMORY_EPISTEMIC_RULES = [
  "Memory records are factual working recollection of a chat between the user and a roleplay character. Write them in neutral third person and always say who said or did what (the user, or the named character).",
  "What the user says is the user's statement, not proof that it is true; what the character says proves only that the character said it. Text between *asterisks* is roleplay action or narration: record it as something done in the roleplay, not as a real-world event.",
  "Promised, intended, attempted, and completed actions are different: never record a promise, suggestion, or plan as done unless the evidence separately shows it happened.",
  "Preserve meaningful names, quantities, preferences, boundaries, conditions, deadlines, explicit corrections and retractions, and unresolved contradictions.",
  "Interpret relative time words (today, tomorrow, next week) against the timestamp of the message that contains them and write the resolved date or the explicit relation to it. Unknown dates stay unknown.",
  "Do not invent connective events, motives, diagnoses, or interpretations of the user's personality; memory records what happened and what was said, not hypotheses about the user.",
  "retrievalBrief is a concise thematic search index, not a second summary.",
  CHARACTER_CONTEXT_RULES,
  "characterContext is never a memory source: do not record it, and record only what the supplied messages or memories show."
].join(" ");

export const MEMORY_TEXT_RULES = `topic: non-empty, at most ${MEMORY_LIMITS.TOPIC_MAX} characters. summary: non-empty, at most ${MEMORY_LIMITS.SUMMARY_MAX} characters. retrievalBrief: at most ${MEMORY_LIMITS.RETRIEVAL_BRIEF_MAX} characters. importance: a number from 0 to 1.`;

export const STM_DRAFT_TEMPLATE = Object.freeze({
  shortTermMemoriesToUpsert: [{ id: "<existing writable STM id>", topic: "<topic>", summary: "<summary>", retrievalBrief: "<index>", importance: 0.5, sourceMessageIds: ["<consumed message id>"], contextStmIds: [] }],
  shortTermMemoriesToAdd: [{ topic: "<topic>", summary: "<summary>", retrievalBrief: "<index>", importance: 0.5, sourceMessageIds: ["<consumed message id>"], contextStmIds: [] }],
  stmRepartitions: [{ sourceStmIds: ["<existing writable STM id>"], replacementRecords: [{ id: "<one of this repartition's sourceStmIds, or null>", topic: "<topic>", summary: "<summary>", retrievalBrief: "<index>", importance: 0.5, sourceMessageIds: [], contextStmIds: ["<source STM id>"] }] }]
});

export function stmSystemPrompt(characterName) {
  return [
    `You consolidate the oldest exact chat messages of the conversation between the user and the character ${characterName} into thematic short-term memories (STM).`,
    MEMORY_EPISTEMIC_RULES,
    "Selective retention: every message in consumedMessageIds leaves the verbatim context once this step is validated and applied, whether or not a record cites it. Write memories for what is genuinely worth remembering; greetings, filler, and incidental gestures need no record. A consumed message that no record cites is intentionally forgotten; that is permitted. If nothing is worth remembering, return all three arrays empty.",
    "The messages in retainedMessageIds stay verbatim after this step; use them only as interpretive context (references, chronology, corrections) and never cite them.",
    `An entry with type image_observation is not speech: it is ${characterName}'s perception of an image the user attached to the message named in imageAttachedTo (whose text is given as userText), and it describes only what the image visibly depicted. A user message with attachedImage carries the image. Record such an event as the user showing ${characterName} an image, together with what the user said about it and what the image depicted, for example: "The user showed ${characterName} a photo they called their selfie; the person pictured had ...". Never record the image content as something the user said or told, and never turn what the user claimed about the image into a verified fact: a photo the user calls their selfie shows a person, it does not establish what the user looks like. An image that could not be viewed has unknown content; never guess it. Write ordinary prose; no special record type or marker.`,
    "STM preserves detail within the memories it keeps. Update a relevant existing writable STM when the new messages materially extend or correct its topic; create separate records for distinct topics; repartition an overly broad existing record into meaningful topic records only when that improves separation (never arbitrary part 1/part 2 splits, and never delete distinct useful details).",
    `WRITE CONTRACT: return exactly ${JSON.stringify(STM_DRAFT_TEMPLATE)} with all three arrays present (each may be empty). Each written record has exactly the fields shown. ${MEMORY_TEXT_RULES} sourceMessageIds lists exact consumed message IDs that the record uses; contextStmIds lists exact supplied STM IDs whose content contributes. An upsert id must be an existing supplied STM and must cite at least one consumed message; omit unchanged records. A repartition lists supplied sourceStmIds (never also an upsert target, never in two repartitions); every source must appear in some replacement's contextStmIds; a replacement id is null for a new record or one of its own sources, and at most one replacement keeps an existing id. At most ${MEMORY_LIMITS.STM_WRITES_MAX} written records in total; prefer one to four coherent writes. Never output new IDs.`,
    "Return one JSON object only."
  ].join(" ");
}

export const LTM_DRAFT_TEMPLATE = Object.freeze({
  longTermMemoriesToUpsert: [{ id: "<selected LTM id>", topic: "<topic>", summary: "<summary>", retrievalBrief: "<index>", importance: 0.5, sourceStmIds: ["<supplied STM id>"], sourceLtmIds: [] }],
  longTermMemoriesToAdd: [{ ref: "new_ltm_1", topic: "<topic>", summary: "<summary>", retrievalBrief: "<index>", importance: 0.5, sourceStmIds: ["<supplied STM id>"], sourceLtmIds: [] }],
  retirementGroups: [
    { stmIds: ["<consumable STM id>"], disposition: "represented", representedByLtmRefs: ["new_ltm_1"] },
    { stmIds: ["<consumable STM id>"], disposition: "safe_to_forget", representedByLtmRefs: [], reason: "routine|redundant|transient" }
  ]
});

export function ltmSelectionSystemPrompt() {
  return [
    "You are a read-only memory selector for one memory pool's daily consolidation.",
    CHARACTER_CONTEXT_RULES,
    "Select with high recall: relevantLtmIds are existing long-term memories that the job's source memories continue, correct, duplicate, overlap, or are already represented by; contextStmIds are other short-term memories of this consolidation whose complete content is needed to interpret references or corrections in the job's sources. Selected context is read-only.",
    "Choose only IDs from the supplied catalogs. Do not write prose, scores, explanations, or new IDs, and change nothing. Empty arrays are valid.",
    "Return exactly {\"relevantLtmIds\":[],\"contextStmIds\":[]}."
  ].join(" ");
}

export function ltmSystemPrompt() {
  return [
    "You convert one memory pool's short-term memories (STM) into durable long-term memories (LTM) at a daily boundary.",
    MEMORY_EPISTEMIC_RULES,
    "Each memory names the conversation it comes from (the character the user talked with). Keep that attribution; never merge two different conversations into one as if they were the same interaction.",
    "LTM preserves durable meaning and may omit minor detail. Group by meaning: several coherent LTM records are preferable to one daily diary. Update a selected LTM only for a material change; an unchanged selected LTM can already represent a source and needs no cosmetic update. Unselected LTM never change.",
    "Every consumable STM must appear in exactly one retirement group: either represented (by new refs and/or selected LTM ids) or safe_to_forget with reason routine, redundant, or transient. Never use safe_to_forget for unique important promises, agreements, boundaries, personal facts the user shared, relationship developments, unresolved conflicts or goals, or significant discoveries. readOnlyContextShortTermMemories may be cited as sources but never retired.",
    `WRITE CONTRACT: return exactly ${JSON.stringify(LTM_DRAFT_TEMPLATE)} with all three arrays present. ${MEMORY_TEXT_RULES} sourceStmIds and sourceLtmIds are exact supplied IDs (unique; at least one source per write; an upsert must cite more than only itself). ref is a unique response-local label such as new_ltm_1, never a supplied ID. When a represented group cites a record written in this response, that record's sourceStmIds must include every STM in the group. Never output new canonical IDs.`,
    "Return one JSON object only."
  ].join(" ");
}

export function retrievalSystemPrompt(purposeText) {
  return [
    `You are a semantic memory-retrieval selector. ${purposeText}`,
    CHARACTER_CONTEXT_RULES,
    "Select only existing record IDs from the catalog that may materially help with the current situation. Do not roleplay, write prose, infer new facts, fill capacity, or invent IDs.",
    `Maximums: STM ${MEMORY_LIMITS.CONTEXT_STM_LIMIT}, LTM ${MEMORY_LIMITS.CONTEXT_LTM_LIMIT}. Return one JSON object only with exactly stmIds and ltmIds.`
  ].join(" ");
}

export const DIALOGUE_RETRIEVAL_PURPOSE = "The character is about to reply in its chat with the user; pick the memories that could matter for this reply.";
export const CONTEMPLATION_RETRIEVAL_PURPOSE = "A researcher is revising free-form interpretations of the user against evidence; pick the memories that could confirm, contradict, or enrich interpretations of the user given the recent conversation.";
