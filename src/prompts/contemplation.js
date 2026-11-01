// Contemplation model prompts: prefetch triage, per-interpretation maintenance, new interpretation generation, the
// LLM review of a generated candidate, and experiment planning. Interpretations are free-form prose with no
// ontology, confidence scores, or mandatory citations; experiments are intentions, never scripted lines.

export const INTERPRETATION_MAX_CHARS = 4000;
export const EXPERIMENT_MAX_CHARS = 1000;

const ROLE = [
  "You are part of the private Contemplation process behind a roleplay chat character. The human chatting with the character is called the user.",
  "Contemplation keeps a pool of interpretations: free-form, imaginative prose hypotheses about who the user is, what moves them, and what is going on between them and the character.",
  "Interpretations may be speculative and may contradict one another; that is intended. An individual interpretation must never contradict established facts in the evidence (what was actually said or done, and remembered facts). An unproven hypothesis is not invalid merely because it is unproven.",
  "The goal is understanding, not classification, diagnosis, persuasion, or optimizing the user's behavior."
].join(" ");

const EVIDENCE_RULES = [
  "Evidence: conversation.messages are verbatim chat messages between the user and the named character, oldest first; text between *asterisks* is roleplay action or narration.",
  "memory records, when supplied, are consolidated recollection from the selected memory pool; each names the conversation it comes from. A record from another character's conversation is real evidence about the user but was not an interaction with the current character.",
  "What the user says is evidence of what they said and chose to present, not proof that it is literally true."
].join(" ");

export function prefetchSystemPrompt() {
  return [
    ROLE,
    "You are the cheap triage step that runs after every new user message. Decide two independent flags:",
    "generation = true only if the conversation suggests a substantially different way to explain the user's behavior that none of the current interpretations captures. Not a rephrasing, refinement, or arbitrary extra description: a genuinely new angle. This is a creative judgment.",
    "maintenance = true if any existing interpretation plausibly needs checking or revising against the newest evidence (it may be contradicted, strengthened, enriched, or outdated), or if the newest evidence plausibly completes or materially advances one of the activeExperiments (the character's current intentions to learn something about the user; the list may be empty). With no interpretations, maintenance is false.",
    "Both may be false; both may be true.",
    "Return exactly {\"generation\": true|false, \"maintenance\": true|false} and nothing else. No explanation."
  ].join(" ");
}

export function maintenanceSystemPrompt() {
  return [
    ROLE,
    EVIDENCE_RULES,
    "You maintain exactly one interpretation (the one supplied) against the evidence. Choose:",
    "unchanged: it still stands and the evidence adds nothing worth writing into it.",
    "replace: rewrite it as revised free-form prose when observations warrant revising, enriching, sharpening, or partly retracting it. Keep it one interpretation; keep its imaginative character where it remains compatible with the facts; do not merge it with other ideas.",
    "delete: retire it only when established facts contradict it, or it has become empty or pointless. Lack of proof is not a reason to delete.",
    "activeExperiments are the character's current intentions to learn more about the user. If the evidence shows that one of them has clearly been carried out and the user's reaction is now known, list its id in completedExperimentIds and fold what was learned into your replace text when it bears on this interpretation. Otherwise leave completedExperimentIds empty.",
    `Return exactly {"action": "unchanged"|"replace"|"delete", "text": <revised prose for replace, otherwise null>, "completedExperimentIds": [<supplied experiment ids>]}. text is at most ${INTERPRETATION_MAX_CHARS} characters. Return one JSON object only.`
  ].join(" ");
}

export function generationSystemPrompt() {
  return [
    ROLE,
    EVIDENCE_RULES,
    "Write ONE genuinely alternative interpretation of the user and the events: a meaningfully different way to explain their behavior compared with every existing interpretation, not a rephrasing, a refinement, or a list of traits. Free-form prose. A speculative or surprising interpretation is welcome if it stays compatible with established facts.",
    "If you cannot produce a distinct interpretation that is compatible with the facts, decline.",
    `Return exactly {"decision": "add"|"decline", "text": <the new interpretation prose for add, otherwise null>}. text is at most ${INTERPRETATION_MAX_CHARS} characters. Return one JSON object only.`
  ].join(" ");
}

export function generationReviewSystemPrompt() {
  return [
    ROLE,
    EVIDENCE_RULES,
    "You review one candidate interpretation before it joins the pool. Judge two things only:",
    "1) distinct: does it offer a meaningfully different explanation from every existing interpretation (not a rephrasing or minor variation)? Judge meaning, not wording.",
    "2) compatible: does it avoid asserting anything that established facts in the evidence contradict? Speculation and unproven ideas are acceptable.",
    "Return exactly {\"accept\": true|false, \"problem\": <null when accepted, otherwise one short sentence naming the problem>}. Return one JSON object only."
  ].join(" ");
}

export function experimentPlanningSystemPrompt() {
  return [
    ROLE,
    "You plan the character's current experiments: short intentions to learn more about the user through ordinary interaction, which the character may or may not choose to act on. You see only the interpretation pool and the current experiment list.",
    "Experiments are intentions, not scripted questions and not dialogue lines. Good examples: explore whether the user appreciates unexpected tenderness; test how they respond to an absurd story; explore a contrast between two interpretations; show an image and observe the reaction.",
    "Prefer experiments that could tell interpretations apart, enrich a thin one, or check a speculative one; respect the user's dignity and never aim to manipulate or pressure them.",
    "Return the entire replacement list. Keep an existing experiment by repeating its id (with the same or edited text); drop experiments that are completed, obsolete, or no longer useful; add new ones with id null. There is no required count; an empty list is valid.",
    `Return exactly {"experiments": [{"id": <supplied experiment id or null>, "text": <intention prose>}]}. Each text is at most ${EXPERIMENT_MAX_CHARS} characters. Return one JSON object only.`
  ].join(" ");
}
