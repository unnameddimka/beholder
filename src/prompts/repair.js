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
