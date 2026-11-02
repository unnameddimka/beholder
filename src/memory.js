// Society-derived memory lifecycle for Beholder chats.
// - Verbatim -> STM: at 100 active messages the 20 oldest are consolidated (Society src/memory-stm.js live_wave:
//   consumed prefix + retained context tail, selective retention, strict cited-evidence validation, staged apply).
//   Source messages leave the active verbatim window only on successful commit; the transcript is never touched.
// - STM -> LTM: once per server-local calendar day per memory pool (Society src/memory-ltm.js: read-only selector,
//   writer with exhaustive retirement coverage, deterministic size partition).
// - Retrieval: Society's semantic selector over a catalog of retrievalBriefs (src/mind-runtime.js selectMindContext).
// Society's subjective temporal anchors, protected records, and reconsolidation are intentionally not ported; each
// record keeps real source timestamps and conversation attribution instead.
import { clone, coded, exactKeys, isObject, localDateString, stableFingerprint } from "./utils.js";
import { poolOf, poolOwnerId } from "./db.js";
import { profileOf } from "./settings.js";
import { characterContext } from "./prompts/context.js";
import {
  MEMORY_LIMITS, FORGET_REASONS, MEMORY_EPISTEMIC_RULES, stmSystemPrompt, ltmSelectionSystemPrompt, ltmSystemPrompt, retrievalSystemPrompt,
  DIALOGUE_RETRIEVAL_PURPOSE, CONTEMPLATION_RETRIEVAL_PURPOSE
} from "./prompts/memory.js";

export const VERBATIM_WINDOW = 100;
export const STM_BATCH = 20;
const STM_RETRY_BACKOFF_MS = 5 * 60 * 1000;
const LTM_RETRY_BACKOFF_MS = 15 * 60 * 1000;
const SUMMARY_EXCERPT_CHARS = 240;
const PROVENANCE_MESSAGE_IDS_MAX = 400;

const wire = {
  msg: (id) => `msg_${id}`,
  stm: (id) => `stm_${id}`,
  ltm: (id) => `ltm_${id}`,
  parse: (value, prefix) => {
    const match = typeof value === "string" ? new RegExp(`^${prefix}_(\\d+)$`).exec(value) : null;
    return match ? Number(match[1]) : null;
  }
};

// Attachment state of a user message, as every verbatim consumer sees it (Specification 0003 M1).
const ATTACHED_IMAGE_NOTES = Object.freeze({
  observed: "the user attached an image to this message; the image_observation entry for it describes what it shows",
  failed: "the user attached an image to this message, but it could not be viewed; what it shows is unknown",
  pending: "the user attached an image to this message that has not been viewed yet; what it shows is unknown"
});

// The shared verbatim serialization. An image observation is a typed non-speech entry that names the message it
// belongs to (with that message's text), so its provenance survives even when the two entries are split apart.
export function messageView(message, characterName) {
  if (message.role === "observation") {
    return { id: wire.msg(message.id), type: "image_observation", at: message.createdAt,
      imageAttachedTo: { id: wire.msg(message.sourceMessageId), at: message.source?.createdAt ?? null, userText: message.source?.text ?? null }, text: message.text };
  }
  const view = { id: wire.msg(message.id), speaker: message.role === "user" ? "user" : characterName, at: message.createdAt, text: message.text };
  if (message.upload) view.attachedImage = ATTACHED_IMAGE_NOTES[message.upload.status];
  return view;
}

function originText(sources, currentCharacterId) {
  return (sources || []).map((source) => source.characterId === currentCharacterId
    ? `conversation between the user and ${source.characterName} (this character)`
    : `conversation between the user and ${source.characterName}`).join("; ") || "unknown conversation";
}

export function memoryView(record, currentCharacterId = null) {
  return {
    id: record.tier === "stm" ? wire.stm(record.id) : wire.ltm(record.id),
    topic: record.topic, summary: record.summary, retrievalBrief: record.retrievalBrief, importance: record.importance,
    origin: originText(record.sources, currentCharacterId),
    period: record.sourceFrom ? `${record.sourceFrom.slice(0, 10)} to ${(record.sourceTo || record.sourceFrom).slice(0, 10)}` : null
  };
}

function catalogEntry(record, currentCharacterId = null) {
  const view = memoryView(record, currentCharacterId);
  const brief = view.retrievalBrief.trim() ? { retrievalBrief: view.retrievalBrief } : { summaryExcerpt: view.summary.slice(0, SUMMARY_EXCERPT_CHARS) };
  return { id: view.id, topic: view.topic, ...brief, importance: view.importance, origin: view.origin, period: view.period };
}

function serializedLength(messages) {
  return messages.reduce((sum, message) => sum + String(message.content).length, 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Shared validation helpers (Society src/memory-generation.js memoryTextErrors / idListErrors / isNoOp).
// ---------------------------------------------------------------------------------------------------------------

function memoryTextErrors(record, path, errors) {
  if (typeof record.topic !== "string" || !record.topic.trim() || record.topic.trim().length > MEMORY_LIMITS.TOPIC_MAX) errors.push(`${path}.topic must be non-empty text of at most ${MEMORY_LIMITS.TOPIC_MAX} characters.`);
  if (typeof record.summary !== "string" || !record.summary.trim() || record.summary.trim().length > MEMORY_LIMITS.SUMMARY_MAX) errors.push(`${path}.summary must be non-empty text of at most ${MEMORY_LIMITS.SUMMARY_MAX} characters.`);
  if (typeof record.retrievalBrief !== "string" || record.retrievalBrief.trim().length > MEMORY_LIMITS.RETRIEVAL_BRIEF_MAX) errors.push(`${path}.retrievalBrief must be text of at most ${MEMORY_LIMITS.RETRIEVAL_BRIEF_MAX} characters.`);
  if (typeof record.importance !== "number" || !Number.isFinite(record.importance) || record.importance < 0 || record.importance > 1) errors.push(`${path}.importance must be a number from 0 to 1.`);
}

function idListErrors(value, path, allowed, errors, { forbidden = null, forbiddenMessage = null } = {}) {
  if (!Array.isArray(value)) { errors.push(`${path} must be an array.`); return []; }
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== "string") { errors.push(`${path} contains a non-string id.`); continue; }
    if (seen.has(id)) errors.push(`${path} repeats ${id}.`);
    else if (forbidden?.has(id)) errors.push(`${path}: ${forbiddenMessage} (${id}).`);
    else if (!allowed.has(id)) errors.push(`${path} references unknown or unsupplied id ${id}.`);
    seen.add(id);
  }
  return value.filter((id) => typeof id === "string");
}

function trimmedText(record) {
  return { topic: record.topic.trim(), summary: record.summary.trim(), retrievalBrief: record.retrievalBrief.trim(), importance: record.importance };
}

function normalized(value) { return String(value ?? "").replace(/\s+/g, " ").trim(); }

function isNoOp(existing, record) {
  return normalized(existing.topic) === normalized(record.topic) && normalized(existing.summary) === normalized(record.summary) &&
    normalized(existing.retrievalBrief) === normalized(record.retrievalBrief) && existing.importance === record.importance;
}

const textFields = (record) => (typeof record.topic === "string" && typeof record.summary === "string" && typeof record.retrievalBrief === "string" ? trimmedText(record) : {});

// ---------------------------------------------------------------------------------------------------------------
// Verbatim -> STM validator (Society validateStmDraft without anchors/protected records).
// frozen: { consumedIds:Set, retainedIds:Set, suppliedStm: Map(wireId -> record) }
// ---------------------------------------------------------------------------------------------------------------

const STM_TOP_KEYS = ["shortTermMemoriesToUpsert", "shortTermMemoriesToAdd", "stmRepartitions"];
const STM_WRITE_KEYS = ["topic", "summary", "retrievalBrief", "importance", "sourceMessageIds", "contextStmIds"];

export function validateStmDraft(raw, frozen) {
  const errors = [];
  if (!exactKeys(raw, STM_TOP_KEYS) || !STM_TOP_KEYS.every((key) => Array.isArray(raw[key]))) return { ok: false, errors: [`response must contain exactly the arrays ${STM_TOP_KEYS.join(", ")}.`] };
  const suppliedIds = new Set(frozen.suppliedStm.keys());
  let writes = 0;
  const sources = (record, path) => ({
    msgs: idListErrors(record.sourceMessageIds, `${path}.sourceMessageIds`, frozen.consumedIds, errors, { forbidden: frozen.retainedIds, forbiddenMessage: "retained messages are context only and may not be cited" }),
    ctx: idListErrors(record.contextStmIds, `${path}.contextStmIds`, suppliedIds, errors)
  });
  const upsertTargets = new Set();
  const value = { shortTermMemoriesToUpsert: [], shortTermMemoriesToAdd: [], stmRepartitions: [] };
  raw.shortTermMemoriesToUpsert.forEach((record, index) => {
    const path = `shortTermMemoriesToUpsert[${index}]`;
    writes += 1;
    if (!exactKeys(record, ["id", ...STM_WRITE_KEYS])) { errors.push(`${path} must contain exactly id, ${STM_WRITE_KEYS.join(", ")}.`); return; }
    memoryTextErrors(record, path, errors);
    const { msgs } = sources(record, path);
    if (typeof record.id !== "string" || !suppliedIds.has(record.id)) errors.push(`${path}.id must be an existing supplied STM id.`);
    else if (upsertTargets.has(record.id)) errors.push(`${path}.id repeats an upsert target.`);
    else if (!errors.some((entry) => entry.startsWith(`${path}.`)) && isNoOp(frozen.suppliedStm.get(record.id), trimmedText(record))) errors.push(`${path} is a no-op upsert; omit unchanged records.`);
    if (!msgs.length) errors.push(`${path} must cite at least one consumed message to extend or correct its topic.`);
    if (typeof record.id === "string") upsertTargets.add(record.id);
    value.shortTermMemoriesToUpsert.push({ id: record.id, ...textFields(record), sourceMessageIds: clone(record.sourceMessageIds), contextStmIds: clone(record.contextStmIds) });
  });
  raw.shortTermMemoriesToAdd.forEach((record, index) => {
    const path = `shortTermMemoriesToAdd[${index}]`;
    writes += 1;
    if (!exactKeys(record, STM_WRITE_KEYS)) { errors.push(`${path} must contain exactly ${STM_WRITE_KEYS.join(", ")}.`); return; }
    memoryTextErrors(record, path, errors);
    const { msgs, ctx } = sources(record, path);
    if (!msgs.length && !ctx.length) errors.push(`${path} has no source.`);
    value.shortTermMemoriesToAdd.push({ ...textFields(record), sourceMessageIds: clone(record.sourceMessageIds), contextStmIds: clone(record.contextStmIds) });
  });
  const repartitionSources = new Set();
  raw.stmRepartitions.forEach((repartition, index) => {
    const path = `stmRepartitions[${index}]`;
    if (!exactKeys(repartition, ["sourceStmIds", "replacementRecords"])) { errors.push(`${path} must contain exactly sourceStmIds and replacementRecords.`); return; }
    const sourceIds = idListErrors(repartition.sourceStmIds, `${path}.sourceStmIds`, suppliedIds, errors);
    if (!sourceIds.length) errors.push(`${path}.sourceStmIds must be non-empty.`);
    for (const id of sourceIds) {
      if (repartitionSources.has(id)) errors.push(`${path}.sourceStmIds overlaps another repartition (${id}).`);
      if (upsertTargets.has(id)) errors.push(`${path}.sourceStmIds contains an upsert target (${id}).`);
      repartitionSources.add(id);
    }
    if (!Array.isArray(repartition.replacementRecords) || !repartition.replacementRecords.length) { errors.push(`${path}.replacementRecords must be a non-empty array.`); return; }
    const referenced = new Set();
    let retainedIdCount = 0;
    const replacements = [];
    repartition.replacementRecords.forEach((record, replacementIndex) => {
      const rpath = `${path}.replacementRecords[${replacementIndex}]`;
      writes += 1;
      if (!exactKeys(record, ["id", ...STM_WRITE_KEYS])) { errors.push(`${rpath} must contain exactly id, ${STM_WRITE_KEYS.join(", ")}.`); return; }
      memoryTextErrors(record, rpath, errors);
      const { msgs, ctx } = sources(record, rpath);
      for (const id of ctx) referenced.add(id);
      if (record.id !== null) {
        if (!sourceIds.includes(record.id)) errors.push(`${rpath}.id must be null or one of this repartition's sourceStmIds.`);
        retainedIdCount += 1;
      }
      if (!msgs.length && !ctx.length) errors.push(`${rpath} has no source.`);
      replacements.push({ id: record.id, ...textFields(record), sourceMessageIds: clone(record.sourceMessageIds), contextStmIds: clone(record.contextStmIds) });
    });
    if (retainedIdCount > 1) errors.push(`${path} retains more than one existing id.`);
    for (const id of sourceIds) if (!referenced.has(id)) errors.push(`${path} source ${id} is not referenced by any replacement's contextStmIds.`);
    value.stmRepartitions.push({ sourceStmIds: clone(repartition.sourceStmIds), replacementRecords: replacements });
  });
  if (writes > MEMORY_LIMITS.STM_WRITES_MAX) errors.push(`at most ${MEMORY_LIMITS.STM_WRITES_MAX} resulting STM records are allowed; got ${writes}.`);
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

// ---------------------------------------------------------------------------------------------------------------
// STM -> LTM validators (Society validateSelection / validateLtmDraft without anchors/protected records).
// ---------------------------------------------------------------------------------------------------------------

export function validateLtmSelection(raw, frozen) {
  const errors = [];
  if (!exactKeys(raw, ["relevantLtmIds", "contextStmIds"])) return { ok: false, errors: ["selection must contain exactly relevantLtmIds and contextStmIds."] };
  idListErrors(raw.relevantLtmIds, "relevantLtmIds", frozen.ltmIds, errors);
  idListErrors(raw.contextStmIds, "contextStmIds", frozen.stmIds, errors);
  return errors.length ? { ok: false, errors } : { ok: true, value: { relevantLtmIds: clone(raw.relevantLtmIds), contextStmIds: clone(raw.contextStmIds) } };
}

const LTM_TOP_KEYS = ["longTermMemoriesToUpsert", "longTermMemoriesToAdd", "retirementGroups"];
const LTM_WRITE_KEYS = ["topic", "summary", "retrievalBrief", "importance", "sourceStmIds", "sourceLtmIds"];

// frozen: { consumable: Map(wireId -> record), contextStm: Map, selectedLtm: Map }
export function validateLtmDraft(raw, frozen) {
  const errors = [];
  if (!exactKeys(raw, LTM_TOP_KEYS) || !LTM_TOP_KEYS.every((key) => Array.isArray(raw[key]))) return { ok: false, errors: [`response must contain exactly the arrays ${LTM_TOP_KEYS.join(", ")}.`] };
  const stmAllowed = new Set([...frozen.consumable.keys(), ...frozen.contextStm.keys()]);
  const ltmAllowed = new Set(frozen.selectedLtm.keys());
  const suppliedIds = new Set([...stmAllowed, ...ltmAllowed]);
  const written = new Map();
  const value = { longTermMemoriesToUpsert: [], longTermMemoriesToAdd: [], retirementGroups: [] };
  raw.longTermMemoriesToUpsert.forEach((record, index) => {
    const path = `longTermMemoriesToUpsert[${index}]`;
    if (!exactKeys(record, ["id", ...LTM_WRITE_KEYS])) { errors.push(`${path} must contain exactly id, ${LTM_WRITE_KEYS.join(", ")}.`); return; }
    memoryTextErrors(record, path, errors);
    const stm = idListErrors(record.sourceStmIds, `${path}.sourceStmIds`, stmAllowed, errors);
    const ltm = idListErrors(record.sourceLtmIds, `${path}.sourceLtmIds`, ltmAllowed, errors);
    if (typeof record.id !== "string" || !ltmAllowed.has(record.id)) errors.push(`${path}.id must be a selected existing LTM id.`);
    else if (written.has(record.id)) errors.push(`${path}.id repeats an upsert target.`);
    else if (!errors.some((entry) => entry.startsWith(`${path}.`)) && isNoOp(frozen.selectedLtm.get(record.id), trimmedText(record))) errors.push(`${path} is a no-op upsert; an unchanged selected LTM can represent sources without an update.`);
    if (!stm.length && !ltm.some((id) => id !== record.id)) errors.push(`${path} must cite a source other than its own target.`);
    if (typeof record.id === "string") written.set(record.id, new Set(stm));
    value.longTermMemoriesToUpsert.push({ id: record.id, ...textFields(record), sourceStmIds: clone(record.sourceStmIds), sourceLtmIds: clone(record.sourceLtmIds) });
  });
  raw.longTermMemoriesToAdd.forEach((record, index) => {
    const path = `longTermMemoriesToAdd[${index}]`;
    if (!exactKeys(record, ["ref", ...LTM_WRITE_KEYS])) { errors.push(`${path} must contain exactly ref, ${LTM_WRITE_KEYS.join(", ")}.`); return; }
    memoryTextErrors(record, path, errors);
    const stm = idListErrors(record.sourceStmIds, `${path}.sourceStmIds`, stmAllowed, errors);
    const ltm = idListErrors(record.sourceLtmIds, `${path}.sourceLtmIds`, ltmAllowed, errors);
    if (typeof record.ref !== "string" || !record.ref.trim() || record.ref.length > 80) errors.push(`${path}.ref must be a short non-empty response-local label.`);
    else if (suppliedIds.has(record.ref)) errors.push(`${path}.ref must differ from every supplied canonical id.`);
    else if (written.has(record.ref)) errors.push(`${path}.ref is not unique.`);
    if (!stm.length && !ltm.length) errors.push(`${path} has no source.`);
    if (typeof record.ref === "string") written.set(record.ref, new Set(stm));
    value.longTermMemoriesToAdd.push({ ref: record.ref, ...textFields(record), sourceStmIds: clone(record.sourceStmIds), sourceLtmIds: clone(record.sourceLtmIds) });
  });
  const retired = new Map();
  raw.retirementGroups.forEach((group, index) => {
    const path = `retirementGroups[${index}]`;
    const represented = group?.disposition === "represented";
    const keys = represented ? ["stmIds", "disposition", "representedByLtmRefs"] : ["stmIds", "disposition", "representedByLtmRefs", "reason"];
    if (!isObject(group) || !["represented", "safe_to_forget"].includes(group.disposition) || !exactKeys(group, keys)) { errors.push(`${path} must be a represented group {stmIds, disposition, representedByLtmRefs} or a safe_to_forget group {stmIds, disposition, representedByLtmRefs: [], reason}.`); return; }
    const ids = idListErrors(group.stmIds, `${path}.stmIds`, new Set(frozen.consumable.keys()), errors, { forbidden: new Set(frozen.contextStm.keys()), forbiddenMessage: "read-only context STM cannot be retired in this job" });
    if (!ids.length) errors.push(`${path}.stmIds must be non-empty.`);
    for (const id of ids) {
      if (retired.has(id)) errors.push(`${path} retires ${id}, which already belongs to another retirement group.`);
      retired.set(id, index);
    }
    if (!Array.isArray(group.representedByLtmRefs)) { errors.push(`${path}.representedByLtmRefs must be an array.`); return; }
    if (represented) {
      if (!group.representedByLtmRefs.length) errors.push(`${path} is represented but cites no LTM.`);
      const seen = new Set();
      for (const ref of group.representedByLtmRefs) {
        if (typeof ref !== "string" || seen.has(ref)) { errors.push(`${path}.representedByLtmRefs contains an invalid or repeated reference.`); continue; }
        seen.add(ref);
        if (!written.has(ref) && !ltmAllowed.has(ref)) { errors.push(`${path}.representedByLtmRefs references unknown ${ref}.`); continue; }
        const provenance = written.get(ref);
        if (provenance) for (const id of ids) if (!provenance.has(id)) errors.push(`${path}: written record ${ref} must include ${id} in its sourceStmIds to represent it.`);
      }
    } else {
      if (group.representedByLtmRefs.length) errors.push(`${path} is safe_to_forget and must have an empty representedByLtmRefs.`);
      if (!FORGET_REASONS.includes(group.reason)) errors.push(`${path}.reason must be one of ${FORGET_REASONS.join(", ")}.`);
    }
    value.retirementGroups.push(clone(group));
  });
  for (const id of frozen.consumable.keys()) if (!retired.has(id)) errors.push(`consumable STM ${id} is not accounted for by any retirement group.`);
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

// Deterministic chronological partition by serialized size; never splits a record (Society partitionDailySources).
export function partitionBySize(views, budget = MEMORY_LIMITS.DAILY_SOURCE_BATCH_CHARS) {
  const jobs = [];
  let current = [];
  let size = 0;
  for (const view of views) {
    const length = JSON.stringify(view).length;
    if (current.length && size + length > budget) { jobs.push(current); current = []; size = 0; }
    current.push(view);
    size += length;
  }
  if (current.length) jobs.push(current);
  return jobs;
}

// Provenance union: conversation attribution, bounded message ids, and the real source period.
function mergeProvenance(parts) {
  const byCharacter = new Map();
  let from = null;
  let to = null;
  for (const part of parts) {
    for (const source of part.sources || []) {
      const entry = byCharacter.get(source.characterId) || { characterId: source.characterId, characterName: source.characterName, messageIds: [] };
      entry.characterName = source.characterName || entry.characterName;
      for (const id of source.messageIds || []) if (!entry.messageIds.includes(id)) entry.messageIds.push(id);
      entry.messageIds = entry.messageIds.slice(-PROVENANCE_MESSAGE_IDS_MAX);
      byCharacter.set(source.characterId, entry);
    }
    if (part.from && (!from || part.from < from)) from = part.from;
    if ((part.to || part.from) && (!to || (part.to || part.from) > to)) to = part.to || part.from;
  }
  return { sources: [...byCharacter.values()], sourceFrom: from, sourceTo: to };
}

function deterministicSelection(stm, ltm) {
  const rank = (a, b) => (b.importance - a.importance) || (b.id - a.id);
  return { stm: [...stm].sort(rank).slice(0, MEMORY_LIMITS.CONTEXT_STM_LIMIT), ltm: [...ltm].sort(rank).slice(0, MEMORY_LIMITS.CONTEXT_LTM_LIMIT) };
}

export class MemoryEngine {
  constructor({ store, llm, diagnostics, mutex, now = () => new Date(), stmRetryBackoffMs = STM_RETRY_BACKOFF_MS, ltmRetryBackoffMs = LTM_RETRY_BACKOFF_MS }) {
    this.store = store;
    this.llm = llm;
    this.diagnostics = diagnostics;
    this.mutex = mutex;
    this.now = now;
    this.stmRetryBackoffMs = stmRetryBackoffMs;
    this.ltmRetryBackoffMs = ltmRetryBackoffMs;
    this.stmJobs = new Map();
    this.ltmState = { running: false, lastAttemptAt: null, lastError: null, lastSuccessDate: store.getMeta("lastLtmDate", null), pools: {} };
    this.retrievals = 0;
  }

  // ---- Verbatim -> STM ----------------------------------------------------------------------------------------

  // Called after every committed message. Starts at most one background job per chat; never blocks dialogue.
  maybeConsolidate(characterId) {
    const job = this.stmJobs.get(characterId);
    if (job?.status === "running") return job.promise;
    if (job?.status === "failed" && Date.now() - job.failedAtMs < this.stmRetryBackoffMs) return null;
    if (this.store.activeCount(characterId) < VERBATIM_WINDOW) return null;
    // An image still being perceived keeps the chat's verbatim window as is, so its message never leaves the window
    // before its observation exists (Specification 0003 M3); consolidation runs again once perception settles.
    if (this.store.pendingUploadCount(characterId)) return null;
    const character = this.store.getCharacter(characterId);
    if (!character) return null;
    const pool = poolOf(character);
    const entry = { status: "running", pool, startedAt: new Date().toISOString(), promise: null };
    this.stmJobs.set(characterId, entry);
    entry.promise = this.mutex.run(`memory:${pool}`, () => this.consolidateStm(characterId, pool))
      .then((result) => {
        this.stmJobs.set(characterId, { status: "idle", pool, lastResult: result });
        // A backlog above the window (for example after earlier failures) drains one batch at a time.
        if (result.status === "applied") this.maybeConsolidate(characterId);
        return result;
      })
      .catch((error) => {
        this.diagnostics.error("memory_stm", error, { characterId, pool });
        this.stmJobs.set(characterId, { status: "failed", pool, failedAtMs: Date.now(), error: { code: error.code || "MEMORY_STM_FAILED", message: error.message } });
        return { status: "failed", error };
      });
    return entry.promise;
  }

  // One logical job: the owner's Dialogue configuration and descriptions are frozen here for every call of it.
  async consolidateStm(characterId, pool) {
    const character = profileOf(this.store.getCharacter(characterId));
    const window = this.store.oldestActiveMessages(characterId, VERBATIM_WINDOW);
    if (window.length < VERBATIM_WINDOW) return { status: "skipped" };
    const consumed = window.slice(0, STM_BATCH);
    const retained = window.slice(STM_BATCH);
    const supplied = this.store.memoryRecords(pool, "stm").filter((record) => record.scopeCharacterId === characterId);
    const suppliedMap = new Map(supplied.map((record) => [wire.stm(record.id), record]));
    const frozen = { consumedIds: new Set(consumed.map((m) => wire.msg(m.id))), retainedIds: new Set(retained.map((m) => wire.msg(m.id))), suppliedStm: suppliedMap };
    const payload = {
      characterContext: characterContext(character),
      conversation: { character: character.name },
      consumedMessageIds: consumed.map((m) => wire.msg(m.id)),
      retainedMessageIds: retained.map((m) => wire.msg(m.id)),
      messages: window.map((m) => messageView(m, character.name)),
      existingShortTermMemories: supplied.map((record) => memoryView(record, characterId)),
      limits: { maxResultingRecords: MEMORY_LIMITS.STM_WRITES_MAX, topicMax: MEMORY_LIMITS.TOPIC_MAX, summaryMax: MEMORY_LIMITS.SUMMARY_MAX, retrievalBriefMax: MEMORY_LIMITS.RETRIEVAL_BRIEF_MAX },
      requiredResponseShape: { shortTermMemoriesToUpsert: [], shortTermMemoriesToAdd: [], stmRepartitions: [] }
    };
    const messages = [{ role: "system", content: stmSystemPrompt(character.name) }, { role: "user", content: JSON.stringify(payload) }];
    if (serializedLength(messages) > MEMORY_LIMITS.REQUEST_CEILING_CHARS) throw coded("MEMORY_CAPACITY_EXCEEDED", "Verbatim->STM request exceeds the request ceiling; nothing was consumed.");
    const fingerprint = stableFingerprint({ consumed: consumed.map((m) => m.id), supplied });
    const { value: draft } = await this.llm.structured({ purpose: "memory_stm_consolidation", config: character.config, messages, validate: (raw) => validateStmDraft(raw, frozen), context: { characterId, pool } });
    const messageById = new Map(consumed.map((m) => [wire.msg(m.id), m]));
    const provenanceFor = (record, prior = []) => mergeProvenance([
      ...prior.map((p) => ({ sources: p.sources, from: p.sourceFrom, to: p.sourceTo })),
      ...record.contextStmIds.map((id) => suppliedMap.get(id)).map((p) => ({ sources: p.sources, from: p.sourceFrom, to: p.sourceTo })),
      ...record.sourceMessageIds.map((id) => messageById.get(id)).map((m) => ({ sources: [{ characterId, characterName: character.name, messageIds: [m.id] }], from: m.createdAt, to: m.createdAt }))
    ]);
    const outputIds = [];
    const applied = this.store.tx(() => {
      // Stale guard: the consumed prefix must still be active and the supplied STM unchanged.
      const current = this.store.oldestActiveMessages(characterId, STM_BATCH).map((m) => m.id);
      const currentSupplied = this.store.memoryRecords(pool, "stm").filter((record) => record.scopeCharacterId === characterId);
      if (stableFingerprint({ consumed: current, supplied: currentSupplied }) !== fingerprint) return false;
      for (const record of draft.shortTermMemoriesToUpsert) {
        const prior = suppliedMap.get(record.id);
        this.store.updateMemory(prior.id, { ...trimmedText(record), ...provenanceFor(record, [prior]) });
        outputIds.push(prior.id);
      }
      for (const repartition of draft.stmRepartitions) {
        const retainedTarget = repartition.replacementRecords.find((record) => record.id !== null)?.id || null;
        for (const sourceId of repartition.sourceStmIds) if (sourceId !== retainedTarget) this.store.deleteMemory(suppliedMap.get(sourceId).id);
        for (const record of repartition.replacementRecords) {
          const fields = { ...trimmedText(record), ...provenanceFor(record, record.id ? [suppliedMap.get(record.id)] : []) };
          if (record.id) { this.store.updateMemory(suppliedMap.get(record.id).id, fields); outputIds.push(suppliedMap.get(record.id).id); }
          else outputIds.push(this.store.insertMemory({ pool, tier: "stm", scopeCharacterId: characterId, ...fields }));
        }
      }
      for (const record of draft.shortTermMemoriesToAdd) {
        outputIds.push(this.store.insertMemory({ pool, tier: "stm", scopeCharacterId: characterId, ...trimmedText(record), ...provenanceFor(record) }));
      }
      this.store.deactivateMessages(consumed.map((m) => m.id), pool);
      this.store.bumpMemoryRevision(pool);
      return true;
    });
    const result = { status: applied ? "applied" : "stale", characterId, pool, consumedMessageIds: consumed.map((m) => m.id), outputIds,
      represented: new Set([...draft.shortTermMemoriesToUpsert, ...draft.shortTermMemoriesToAdd, ...draft.stmRepartitions.flatMap((r) => r.replacementRecords)].flatMap((r) => r.sourceMessageIds)).size };
    this.diagnostics.event({ type: "memory-stm", ...result });
    return result;
  }

  // ---- STM -> LTM -------------------------------------------------------------------------------------------------

  // Startup and periodic check. Runs at most once per server-local date; a pool that already succeeded for the date
  // is never consolidated again for it, so repeated restarts do not double-consolidate.
  async runDailyIfDue({ force = false } = {}) {
    const today = localDateString(this.now());
    const last = this.store.getMeta("lastLtmDate", null);
    if (!last) { this.store.setMeta("lastLtmDate", today); this.ltmState.lastSuccessDate = today; return { status: "initialized", date: today }; }
    if (last >= today) return { status: "not_due", date: today };
    if (this.ltmState.running) return { status: "running" };
    if (!force && this.ltmState.lastError && this.ltmState.lastAttemptAt && Date.now() - this.ltmState.lastAttemptAt < this.ltmRetryBackoffMs) return { status: "backoff" };
    this.ltmState.running = true;
    this.ltmState.lastAttemptAt = Date.now();
    const pools = [...new Set([...this.store.poolsWithStm(), ...this.store.memoryPools().map((row) => row.pool)])];
    const failures = [];
    try {
      for (const pool of pools) {
        const row = this.store.ensureMemoryPool(pool);
        if (row.last_ltm_date && row.last_ltm_date >= today) continue;
        try {
          const result = await this.mutex.run(`memory:${pool}`, () => this.consolidatePoolLtm(pool));
          this.store.setPoolLtmDate(pool, today);
          this.ltmState.pools[pool] = { status: "succeeded", date: today, ...result };
        } catch (error) {
          failures.push({ pool, code: error.code || "MEMORY_LTM_FAILED", message: error.message });
          this.ltmState.pools[pool] = { status: "failed", date: today, error: { code: error.code || "MEMORY_LTM_FAILED", message: error.message } };
          this.diagnostics.error("memory_ltm", error, { pool });
        }
      }
      if (failures.length) {
        this.ltmState.lastError = failures;
        return { status: "failed", date: today, failures };
      }
      this.store.setMeta("lastLtmDate", today);
      this.ltmState.lastError = null;
      this.ltmState.lastSuccessDate = today;
      this.diagnostics.event({ type: "memory-ltm-day", date: today, pools });
      return { status: "succeeded", date: today, pools };
    } finally {
      this.ltmState.running = false;
    }
  }

  // Sequential jobs; each job commits atomically (its LTM writes and the retirement of exactly its STM), so a later
  // failure leaves the remaining STM intact for the retry and never loses or duplicates committed work.
  // Every STM present when the boundary job starts belongs to the ending day(s); STM that a retry after a failure
  // finds from the new day is consolidated with them, which only moves it to LTM earlier.
  async consolidatePoolLtm(pool) {
    const stm = this.store.memoryRecords(pool, "stm");
    if (!stm.length) return { jobs: 0 };
    // The pool's owner, frozen for the whole day's consolidation of this pool (Specification 0005 A5).
    const owner = this.store.getCharacter(poolOwnerId(pool));
    if (!owner) throw coded("CHARACTER_NOT_FOUND", `Memory pool ${pool} has no owning character.`);
    const profile = profileOf(owner);
    const dayViews = stm.map((record) => memoryView(record));
    const jobs = partitionBySize(dayViews);
    let committed = 0;
    for (const [jobIndex, job] of jobs.entries()) {
      await this.runLtmJob(pool, profile, job, dayViews, jobIndex, jobs.length);
      committed += 1;
    }
    return { jobs: committed, stmCount: stm.length };
  }

  async runLtmJob(pool, profile, job, dayViews, jobIndex, jobCount) {
    const jobIds = new Set(job.map((view) => view.id));
    const stmRecords = new Map(this.store.memoryRecords(pool, "stm").map((record) => [wire.stm(record.id), record]));
    const ltmRecords = this.store.memoryRecords(pool, "ltm");
    const ltmById = new Map(ltmRecords.map((record) => [wire.ltm(record.id), record]));
    const otherViews = dayViews.filter((view) => !jobIds.has(view.id) && stmRecords.has(view.id));
    let selection = { mode: "skipped", relevantLtmIds: [], contextStmIds: [] };
    if (ltmRecords.length || jobCount > 1) {
      const frozenSelection = { ltmIds: new Set(ltmById.keys()), stmIds: new Set(otherViews.map((view) => view.id)) };
      const messages = [
        { role: "system", content: ltmSelectionSystemPrompt() },
        { role: "user", content: JSON.stringify({ characterContext: characterContext(profile), jobSources: job, existingLongTermMemoryCatalog: ltmRecords.map((record) => catalogEntry(record)),
          otherShortTermMemoryCatalog: otherViews.map((view) => catalogEntry(stmRecords.get(view.id))), requiredResponseShape: { relevantLtmIds: [], contextStmIds: [] } }) }
      ];
      try {
        const { value } = await this.llm.structured({ purpose: "memory_ltm_selection", config: profile.config, messages, validate: (raw) => validateLtmSelection(raw, frozenSelection), context: { pool } });
        selection = { mode: "semantic", ...value };
      } catch (error) {
        // Society fallback: a failed selector supplies every catalog record (high recall), never an arbitrary subset.
        selection = { mode: "fallback_all", relevantLtmIds: [...ltmById.keys()], contextStmIds: otherViews.map((view) => view.id), error: { code: error.code, message: error.message } };
      }
    }
    const consumable = new Map([...jobIds].map((id) => [id, stmRecords.get(id)]));
    const contextStm = new Map(selection.contextStmIds.map((id) => [id, stmRecords.get(id)]));
    const selectedLtm = new Map(selection.relevantLtmIds.map((id) => [id, ltmById.get(id)]));
    const payload = {
      characterContext: characterContext(profile),
      job: { index: jobIndex + 1, count: jobCount },
      consumableShortTermMemories: [...consumable.values()].map((record) => memoryView(record)),
      readOnlyContextShortTermMemories: [...contextStm.values()].map((record) => memoryView(record)),
      selectedLongTermMemories: [...selectedLtm.values()].map((record) => memoryView(record)),
      limits: { topicMax: MEMORY_LIMITS.TOPIC_MAX, summaryMax: MEMORY_LIMITS.SUMMARY_MAX, retrievalBriefMax: MEMORY_LIMITS.RETRIEVAL_BRIEF_MAX, forgetReasons: FORGET_REASONS },
      requiredResponseShape: { longTermMemoriesToUpsert: [], longTermMemoriesToAdd: [], retirementGroups: [] }
    };
    const messages = [{ role: "system", content: ltmSystemPrompt() }, { role: "user", content: JSON.stringify(payload) }];
    if (serializedLength(messages) > MEMORY_LIMITS.REQUEST_CEILING_CHARS) throw coded("MEMORY_CAPACITY_EXCEEDED", "Daily memory request exceeds the request ceiling; no source was dropped.");
    const fingerprint = stableFingerprint([...consumable.values()]);
    const { value: draft } = await this.llm.structured({ purpose: "memory_ltm_consolidation", config: profile.config, messages, validate: (raw) => validateLtmDraft(raw, { consumable, contextStm, selectedLtm }), context: { pool } });
    const sourceRecords = (record) => [...record.sourceStmIds.map((id) => consumable.get(id) || contextStm.get(id)), ...record.sourceLtmIds.map((id) => selectedLtm.get(id))];
    const provenance = (records) => mergeProvenance(records.map((r) => ({ sources: r.sources, from: r.sourceFrom, to: r.sourceTo })));
    this.store.tx(() => {
      const current = this.store.memoryRecords(pool, "stm").filter((record) => jobIds.has(wire.stm(record.id)));
      if (stableFingerprint(current) !== fingerprint) throw coded("MEMORY_STALE", "Short-term memory changed while daily consolidation was preparing; nothing was applied.");
      for (const record of draft.longTermMemoriesToUpsert) {
        const prior = selectedLtm.get(record.id);
        this.store.updateMemory(prior.id, { ...trimmedText(record), ...provenance([prior, ...sourceRecords(record)]) });
      }
      for (const record of draft.longTermMemoriesToAdd) this.store.insertMemory({ pool, tier: "ltm", scopeCharacterId: null, ...trimmedText(record), ...provenance(sourceRecords(record)) });
      for (const record of consumable.values()) this.store.deleteMemory(record.id);
      this.store.bumpMemoryRevision(pool);
    });
    this.diagnostics.event({ type: "memory-ltm-job", pool, job: jobIndex + 1, jobCount, selection: { mode: selection.mode, error: selection.error || null },
      upserts: draft.longTermMemoriesToUpsert.length, adds: draft.longTermMemoriesToAdd.length,
      forgotten: draft.retirementGroups.filter((group) => group.disposition === "safe_to_forget").reduce((sum, group) => sum + group.stmIds.length, 0) });
  }

  // ---- Retrieval --------------------------------------------------------------------------------------------------

  // Society-style semantic retrieval: always the selector over a nonempty catalog (no request for an empty one). A
  // failed selector falls back to deterministic importance ranking so a reply is never blocked; the fallback is
  // recorded in diagnostics. profile is the calling job's snapshot: its configuration for the purpose's role and the
  // character's descriptions.
  async retrieve({ pool, purpose, profile, situation }) {
    const currentCharacterId = profile.characterId;
    const stm = this.store.memoryRecords(pool, "stm");
    const ltm = this.store.memoryRecords(pool, "ltm");
    if (!stm.length && !ltm.length) return { shortTermMemories: [], longTermMemories: [], selection: "empty_catalog" };
    const stmById = new Map(stm.map((record) => [wire.stm(record.id), record]));
    const ltmById = new Map(ltm.map((record) => [wire.ltm(record.id), record]));
    const messages = [
      { role: "system", content: retrievalSystemPrompt(purpose === "dialogue_memory_retrieval" ? DIALOGUE_RETRIEVAL_PURPOSE : CONTEMPLATION_RETRIEVAL_PURPOSE) },
      { role: "user", content: JSON.stringify({ characterContext: characterContext(profile), situation, limits: { stm: MEMORY_LIMITS.CONTEXT_STM_LIMIT, ltm: MEMORY_LIMITS.CONTEXT_LTM_LIMIT },
        catalog: { shortTermMemories: stm.map((record) => catalogEntry(record, currentCharacterId)), longTermMemories: ltm.map((record) => catalogEntry(record, currentCharacterId)) },
        requiredResponseShape: { stmIds: [], ltmIds: [] } }) }
    ];
    // Society sanitizeRetrievalSelection: unknown ids are dropped, duplicates ignored, and limits enforced.
    const validate = (raw) => {
      if (!exactKeys(raw, ["stmIds", "ltmIds"]) || !Array.isArray(raw.stmIds) || !Array.isArray(raw.ltmIds)) return { ok: false, errors: ["response must contain exactly the arrays stmIds and ltmIds."] };
      const pick = (ids, map, limit) => [...new Set(ids.filter((id) => typeof id === "string" && map.has(id)))].slice(0, limit);
      return { ok: true, value: { stmIds: pick(raw.stmIds, stmById, MEMORY_LIMITS.CONTEXT_STM_LIMIT), ltmIds: pick(raw.ltmIds, ltmById, MEMORY_LIMITS.CONTEXT_LTM_LIMIT) } };
    };
    this.retrievals += 1;
    let chosen;
    let mode = "semantic";
    try {
      const { value } = await this.llm.structured({ purpose, config: profile.config, messages, validate, context: { characterId: currentCharacterId, pool } });
      chosen = { stm: value.stmIds.map((id) => stmById.get(id)), ltm: value.ltmIds.map((id) => ltmById.get(id)) };
    } catch (error) {
      if (error.code === "API_KEY_MISSING" || error.code === "AI_REQUEST_ABORTED") throw error;
      mode = "fallback_importance";
      chosen = deterministicSelection(stm, ltm);
      this.diagnostics.error(purpose, error, { pool, fallback: mode });
    }
    return {
      shortTermMemories: chosen.stm.map((record) => memoryView(record, currentCharacterId)),
      longTermMemories: chosen.ltm.map((record) => memoryView(record, currentCharacterId)),
      selection: mode
    };
  }

  status() {
    return {
      stmJobs: [...this.stmJobs.entries()].map(([characterId, job]) => ({ characterId, status: job.status, pool: job.pool, error: job.error || null })),
      ltm: { running: this.ltmState.running, lastSuccessDate: this.store.getMeta("lastLtmDate", null), lastError: this.ltmState.lastError, pools: clone(this.ltmState.pools) }
    };
  }
}

export { MEMORY_EPISTEMIC_RULES };
