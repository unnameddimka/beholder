// Repair prompts shared by every structured purpose. Wording adapted from Society src/memory-generation.js
// (SCHEMA_REPAIR_INSTRUCTION, MEMORY_TRUNCATION_RECOVERY_INSTRUCTION).

export const REPAIR_INSTRUCTION = [
  "Your previous response is listed above as the assistant message and violates the required JSON contract.",
  "Return the corrected complete response in exactly the required contract.",
  "Preserve its supported content; correct only the contract: fields, value types, exact supplied IDs, and limits.",
  "Use only the same supplied evidence and IDs. Do not invent evidence, events, people, IDs, or conclusions.",
  "Return one JSON object only, with no Markdown fences and no commentary."
].join(" ");

export const TRUNCATION_RECOVERY_INSTRUCTION = [
  "The previous attempt exhausted the output budget before finishing.",
  "Do not perform a long analysis. Return the required JSON contract directly and compactly, preserving every required field."
].join(" ");

export const DIALOGUE_REPAIR_INSTRUCTION = [
  "Repair only the invalid dialogue response supplied by the user in this request.",
  "This is a format-repair task, not an invitation to continue or re-create the dialogue.",
  "Do not add any preceding chat turns, repeated greetings, new speech, or commentary.",
  "Preserve the original dialogue text. Return exactly one JSON object with fields:",
  "message (a non-empty string), followUpDelaySeconds (integer or null), imageRequest (string or null).",
  "Use null for missing optional fields. Do not output Markdown fences."
].join(" ");
