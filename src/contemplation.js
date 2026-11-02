// Contemplation: an independent background process per interpretation pool (Specification 0000 section 5); each
// character owns exactly one pool (Specification 0004).
// One serial pipeline per pool: prefetch -> maintenance (one consolidation of the whole pool, then a parallel check
// per consolidated interpretation, all-or-nothing commit) ->
// generation (with an LLM review of the candidate) -> gestaltization (Specification 0002) -> at most one
// experiment-planning pass against the final pool.
// User messages arriving during a cycle are coalesced through a persisted per-(pool, chat) watermark. Writes are
// atomic SQLite transactions guarded by revisions/snapshots, so stale results never overwrite newer state.
// Every job runs on the owner's configuration and descriptions frozen at its start (Specification 0005 A5).
import { coded, exactKeys, mapLimited, nowIso } from "./utils.js";
import { poolOf, poolOwnerId } from "./db.js";
import { messageView } from "./memory.js";
import { profileOf } from "./settings.js";
import { characterContext } from "./prompts/context.js";
import {
  INTERPRETATION_MAX_CHARS, EXPERIMENT_MAX_CHARS, GESTALT_MAX_CHARS,
  prefetchSystemPrompt, consolidationSystemPrompt, maintenanceSystemPrompt, generationSystemPrompt, generationReviewSystemPrompt, gestaltizationSystemPrompt, experimentPlanningSystemPrompt
} from "./prompts/contemplation.js";

export const CONTEMPLATION_HISTORY = 100;
const PLANNING_STALE_RETRIES = 3;
const GESTALT_STALE_RETRIES = 3;
const GENERATION_REREVIEWS = 2;
const RETRIEVAL_SITUATION_MESSAGES = 12;
// Manual edits often come in quick succession; a short debounce lets them coalesce into one experiment review.
const MANUAL_PLANNING_DEBOUNCE_MS = 200;

const wireInterpretation = (id) => `int_${id}`;
const wireExperiment = (id) => `exp_${id}`;
const parseWire = (value, prefix) => {
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

// A gestalt is due when it does not reflect the current interpretation revision and there is something to
// synthesize: interpretations, or an earlier gestalt to reconsider. An empty pool without a gestalt stays empty.
export function gestaltDue(state, interpretationCount) {
  return state.gestaltRevision !== state.interpretationRevision && (interpretationCount > 0 || state.gestalt !== null);
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

// ---- runtime ----------------------------------------------------------------------------------------------------

// Specification 0005 F3: a capacity refusal is shown as a skipped Maintenance, any other error as failed.
const MAINTENANCE_SKIP_CODES = new Set(["CONSOLIDATION_CONTEXT_EXCEEDED", "CONSOLIDATION_OUTPUT_EXCEEDED"]);
const FORCE_KINDS = ["maintenance", "generation", "experimentation"];

function newPoolRuntime(pool) {
  return { pool, running: false, stage: "idle", stageCharacterId: null, parallel: { total: 0, inFlight: 0 }, pendingCharacters: new Set(), forced: [], currentForced: null,
    forceSeq: 0, lastForced: {}, planningRequested: false, gestaltFailedRevision: null, lastError: null, lastCycle: null, cycles: 0, promise: null };
}

export class Contemplation {
  constructor({ store, llm, memory, diagnostics, maxParallel = 16, planningDebounceMs = MANUAL_PLANNING_DEBOUNCE_MS }) {
    this.store = store;
    this.llm = llm;
    this.memory = memory;
    this.diagnostics = diagnostics;
    this.maxParallel = maxParallel;
    this.planningDebounceMs = planningDebounceMs;
    this.planningTimers = new Map();
    this.pools = new Map();
    // A Maintenance attempt still marked running belongs to a previous process: it was interrupted, never applied.
    for (const state of this.store.interpretationPools()) {
      if (state.lastMaintenance?.status === "running") {
        this.store.setLastMaintenance(state.pool, { ...state.lastMaintenance, status: "interrupted", finishedAt: null,
          reason: "The server stopped while this Maintenance was running; nothing from it was applied." });
      }
    }
  }

  runtime(pool) {
    if (!this.pools.has(pool)) this.pools.set(pool, newPoolRuntime(pool));
    return this.pools.get(pool);
  }

  // Automatic Contemplation is a per-character flag (Specification 0005 A2); it never gates an explicit Force.
  enabledFor(characterId) { return Boolean(this.store.getCharacter(characterId)?.config.contemplationEnabled); }

  ownerProfile(pool) { return profileOf(this.store.getCharacter(poolOwnerId(pool))); }

  // ---- triggers -----------------------------------------------------------------------------------------------

  onUserMessage(characterId) {
    const character = this.store.getCharacter(characterId);
    if (!character?.config.contemplationEnabled) return null;
    const pool = poolOf(character);
    this.runtime(pool).pendingCharacters.add(characterId);
    return this.kick(pool);
  }

  // Queues one explicit model-driven run of an existing stage. A kind that is already queued or running for this pool
  // is not queued twice (Specification 0005 F2); the result says which happened, never that the run succeeded. Each
  // request has a pool-local id, so its terminal outcome (status().force) is never confused with an earlier run's.
  force(pool, kind, characterId) {
    if (!FORCE_KINDS.includes(kind)) throw coded("FORCE_KIND_INVALID", "Unknown contemplation action.");
    const ownerId = poolOwnerId(pool);
    if (!this.store.getCharacter(ownerId) || (characterId != null && characterId !== ownerId)) throw coded("CHARACTER_NOT_FOUND", "A character is required for this action.");
    this.store.ensureInterpretationPool(pool);
    const rt = this.runtime(pool);
    if (rt.currentForced?.kind === kind) return { queued: false, reason: "running", requestId: rt.currentForced.requestId };
    const waiting = rt.forced.find((op) => op.kind === kind);
    if (waiting) return { queued: false, reason: "already_queued", requestId: waiting.requestId };
    rt.forceSeq += 1;
    const op = { kind, characterId: ownerId, requestId: rt.forceSeq, queuedAt: nowIso() };
    rt.forced.push(op);
    this.kick(pool);
    return { queued: true, requestId: op.requestId };
  }

  requestPlanning(pool) {
    this.runtime(pool).planningRequested = true;
    return this.kick(pool);
  }

  // Restart recovery: re-evaluate unprocessed user messages, persisted pending experiment planning, and gestalts that
  // do not reflect the current interpretation revision (including pools upgraded from before Specification 0002).
  // characterId limits recovery to one character (automatic Contemplation was just enabled for it).
  recover(characterId = null) {
    for (const character of this.store.listCharacters()) {
      if (!character.config.contemplationEnabled || (characterId !== null && character.id !== characterId)) continue;
      const pool = poolOf(character);
      // A chat whose image is still being perceived is triggered by Dialogue once the turn is complete.
      if (this.store.pendingUploadCount(character.id)) continue;
      if (this.store.lastUserMessageId(character.id) > this.store.watermark(pool, character.id)) this.runtime(pool).pendingCharacters.add(character.id);
    }
    for (const state of this.store.interpretationPools()) {
      const owner = poolOwnerId(state.pool);
      if (!this.enabledFor(owner) || (characterId !== null && owner !== characterId)) continue;
      if (state.planningNeeded) this.runtime(state.pool).planningRequested = true;
      if (gestaltDue(state, this.store.interpretations(state.pool).length)) this.runtime(state.pool).gestaltFailedRevision = null;
    }
    for (const pool of this.pools.keys()) this.kick(pool);
  }

  kick(pool) {
    const rt = this.runtime(pool);
    if (rt.running) return rt.promise;
    rt.running = true;
    rt.promise = this.loop(rt)
      .catch((error) => { rt.lastError = this.diagnostics.error("contemplation", error, { pool }); })
      .finally(() => {
        rt.running = false;
        rt.stage = "idle";
        rt.stageCharacterId = null;
        if (rt.forced.length) this.kick(pool);
      });
    return rt.promise;
  }

  // Waits until a pool's pipeline is idle (tests and diagnostics).
  async idle(pool) {
    while (this.runtime(pool).running || this.planningTimers.has(pool)) {
      if (this.runtime(pool).running) await this.runtime(pool).promise;
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async loop(rt) {
    const pool = rt.pool;
    for (;;) {
      if (rt.forced.length) {
        const op = rt.forced.shift();
        rt.currentForced = { ...op, startedAt: nowIso() };
        // The terminal outcome of this request (review 0005 P2-B): "completed" once its own stage finished, with that
        // stage's result, or "failed" with the sanitized reason. A failure of a follow-up stage after a completed
        // Maintenance or Generation is reported beside the outcome, not as the outcome.
        const outcome = { requestId: op.requestId, kind: op.kind, characterId: op.characterId, queuedAt: op.queuedAt, startedAt: rt.currentForced.startedAt };
        let stage = op.kind;
        try {
          // An explicit run has the normal consequences of successful model work, gestaltization and experiment
          // planning, even while automatic Contemplation is off (owner decision on Specification 0005 F2).
          const profile = this.ownerProfile(pool);
          if (op.kind === "maintenance") outcome.result = (await this.runMaintenance(rt, profile, "forced")).status;
          else if (op.kind === "generation") outcome.result = (await this.runGeneration(rt, profile))?.status ?? null;
          if (op.kind !== "experimentation") { outcome.status = "completed"; stage = "follow-up"; }
          await this.gestaltizeIfDue(rt, profile, { forced: true });
          const planned = await this.planIfNeeded(rt, profile, { force: op.kind === "experimentation" });
          if (op.kind === "experimentation") { outcome.status = "completed"; outcome.result = planned.status; }
        } catch (error) {
          rt.lastError = this.diagnostics.error(`contemplation_${op.kind}`, error, { pool, characterId: op.characterId });
          const failure = this.diagnostics.clean({ stage: rt.stage, code: rt.lastError.code ?? null, reason: String(rt.lastError.message || "The run failed.").slice(0, 500) });
          if (stage === "follow-up") outcome.followUpError = failure;
          else Object.assign(outcome, { status: "failed" }, failure);
        } finally {
          rt.currentForced = null;
          rt.lastForced[op.kind] = { ...outcome, finishedAt: nowIso() };
        }
        continue;
      }
      const characterId = this.nextPendingCharacter(rt);
      if (characterId !== null) {
        await this.runCycle(rt, characterId);
        continue;
      }
      // A gestalt that already failed for this revision waits for the next opportunity (message, edit, restart,
      // re-enable) instead of retrying in a loop.
      const state = this.store.ensureInterpretationPool(pool);
      const enabled = this.enabledFor(poolOwnerId(pool));
      if (enabled && rt.gestaltFailedRevision !== state.interpretationRevision && gestaltDue(state, this.store.interpretations(pool).length)) {
        await this.gestaltizeIfDue(rt, this.ownerProfile(pool));
        continue;
      }
      if ((rt.planningRequested || state.planningNeeded) && enabled) {
        rt.planningRequested = false;
        try { await this.planIfNeeded(rt, this.ownerProfile(pool), {}); }
        catch (error) {
          // Leave planning_needed persisted; the next pool change, message, restart, or Force retries it.
          rt.lastError = this.diagnostics.error("contemplation_experiment_planning", error, { pool });
          return;
        }
        continue;
      }
      rt.planningRequested = false;
      return;
    }
  }

  nextPendingCharacter(rt) {
    for (const characterId of rt.pendingCharacters) {
      rt.pendingCharacters.delete(characterId);
      const character = this.store.getCharacter(characterId);
      if (!character || poolOf(character) !== rt.pool || !character.config.contemplationEnabled) continue;
      if (this.store.lastUserMessageId(characterId) > this.store.watermark(rt.pool, characterId)) return characterId;
    }
    return null;
  }

  // ---- context ------------------------------------------------------------------------------------------------

  conversation(profile) {
    return { character: profile.name, messages: this.store.activeMessages(profile.characterId, CONTEMPLATION_HISTORY).map((message) => messageView(message, profile.name)) };
  }

  interpretationViews(pool) { return this.store.interpretations(pool).map((entry) => ({ id: wireInterpretation(entry.id), text: entry.text })); }

  experimentViews(pool) { return this.store.experiments(pool).map((entry) => ({ id: wireExperiment(entry.id), text: entry.text })); }

  async retrieveMemory(profile, conversation) {
    const result = await this.memory.retrieve({ pool: poolOf({ id: profile.characterId }), purpose: "contemplation_memory_retrieval", profile,
      situation: { conversation: { character: conversation.character, recentMessages: conversation.messages.slice(-RETRIEVAL_SITUATION_MESSAGES) } } });
    return { shortTermMemories: result.shortTermMemories, longTermMemories: result.longTermMemories };
  }

  setStage(rt, stage, characterId = null) {
    rt.stage = stage;
    rt.stageCharacterId = characterId;
    this.diagnostics.event({ type: "contemplation-stage", pool: rt.pool, stage, characterId });
  }

  // ---- stages -------------------------------------------------------------------------------------------------

  // One full cycle for the newest evidence of one chat. The watermark advances only after the cycle succeeds; a
  // failure leaves it so the next message (or a restart) re-evaluates all evidence since the last successful cycle.
  async runCycle(rt, characterId) {
    const pool = rt.pool;
    const profile = profileOf(this.store.getCharacter(characterId));
    const targetMessageId = this.store.lastUserMessageId(characterId);
    const cycle = { characterId, targetMessageId, startedAt: new Date().toISOString(), flags: null, status: "running" };
    rt.lastCycle = cycle;
    try {
      this.setStage(rt, "prefetch", characterId);
      // Prefetch sees exactly the whole interpretation pool, the latest verbatim messages and the active experiment
      // intentions; no consolidated memory.
      const payload = { characterContext: characterContext(profile), interpretations: this.interpretationViews(pool), activeExperiments: this.experimentViews(pool),
        conversation: this.conversation(profile), requiredResponseShape: { generation: false, maintenance: false } };
      const { value: flags } = await this.llm.structured({ purpose: "contemplation_prefetch", config: profile.config, messages: [{ role: "system", content: prefetchSystemPrompt() }, { role: "user", content: JSON.stringify(payload) }],
        validate: validatePrefetch, context: { characterId, pool } });
      cycle.flags = flags;
      if (flags.maintenance && this.store.interpretations(pool).length) await this.runMaintenance(rt, profile, "automatic");
      if (flags.generation) await this.runGeneration(rt, profile);
      this.store.setWatermark(pool, characterId, targetMessageId);
      await this.gestaltizeIfDue(rt, profile);
      await this.planIfNeeded(rt, profile, {});
      cycle.status = "succeeded";
      rt.cycles += 1;
    } catch (error) {
      cycle.status = "failed";
      cycle.error = { code: error.code || "CONTEMPLATION_FAILED", message: error.message };
      rt.lastError = this.diagnostics.error("contemplation_cycle", error, { pool, characterId });
    } finally {
      cycle.finishedAt = new Date().toISOString();
      this.diagnostics.event({ type: "contemplation-cycle", pool, ...cycle });
    }
  }

  // Specification 0004 C1/C4: one consolidation of the whole pool, then the existing per-interpretation check of
  // every consolidated candidate, then one all-or-nothing commit. Consolidated text is never persisted unverified,
  // and a failure at any stage leaves the stored interpretations and experiments exactly as they were.
  // source is "automatic" (selected by prefetch) or "forced"; the attempt and its outcome persist for the
  // Contemplation page (Specification 0005 F3).
  async runMaintenance(rt, profile, source) {
    const pool = rt.pool;
    const characterId = profile.characterId;
    const startedAt = nowIso();
    const record = (status, extra = {}) => this.store.setLastMaintenance(pool, { status, source, startedAt, finishedAt: status === "running" ? null : nowIso(), ...extra });
    const before = this.store.ensureInterpretationPool(pool);
    const snapshot = this.store.interpretations(pool);
    if (!snapshot.length) {
      record("skipped", { reason: "There were no interpretations to maintain." });
      return { status: "empty" };
    }
    record("running");
    const report = { type: "contemplation-maintenance", pool, characterId, source, considered: snapshot.length };
    let stage = "consolidation";
    try {
      this.setStage(rt, "maintenance_consolidation", characterId);
      const candidates = await this.consolidate(profile, pool, snapshot);
      report.candidates = candidates.length;
      report.merged = snapshot.length - candidates.length;
      stage = "verification";
      this.setStage(rt, "maintenance_retrieval", characterId);
      const conversation = this.conversation(profile);
      const memory = await this.retrieveMemory(profile, conversation);
      // The experiment state every verifier sees; the commit is guarded by it as well (review 0004 P2).
      const experimentRevision = this.store.ensureInterpretationPool(pool).experimentRevision;
      const experiments = this.experimentViews(pool);
      const experimentIds = new Set(experiments.map((entry) => entry.id));
      this.setStage(rt, "maintenance", characterId);
      rt.parallel = { total: candidates.length, inFlight: 0 };
      const results = await mapLimited(candidates, this.maxParallel, async (candidate) => {
        rt.parallel.inFlight += 1;
        try {
          const payload = { characterContext: characterContext(profile), interpretation: { id: wireInterpretation(candidate.id), text: candidate.text }, conversation, memory, activeExperiments: experiments,
            requiredResponseShape: { action: "unchanged", text: null, completedExperimentIds: [] } };
          const { value } = await this.llm.structured({ purpose: "contemplation_maintenance", config: profile.config, messages: [{ role: "system", content: maintenanceSystemPrompt() }, { role: "user", content: JSON.stringify(payload) }],
            validate: (raw) => validateMaintenance(raw, experimentIds), context: { characterId, pool, interpretationId: candidate.id } });
          return { candidate, ...value };
        } finally {
          rt.parallel.inFlight -= 1;
        }
      }).finally(() => { rt.parallel = { total: 0, inFlight: 0 }; });
      report.verified = results.length;
      report.actions = results.map((r) => ({ id: r.candidate.id, sourceIds: r.candidate.sourceIds, action: r.action, completed: r.completedExperimentIds }));
      stage = "commit";
      // Every request succeeded: commit the whole verified set only if the pool is still exactly the snapshot the
      // consolidation read (same revision, ids and texts) and the experiments are still exactly what the verifiers
      // examined (same revision, ids and texts). Otherwise the newer state wins, nothing is applied (neither
      // interpretations nor completions), and a later run retries.
      const examinedExperiments = new Map(experiments.map((entry) => [entry.id, entry.text]));
      const original = new Map(snapshot.map((entry) => [entry.id, entry.text]));
      const outcome = this.store.tx(() => {
        const state = this.store.ensureInterpretationPool(pool);
        const current = this.store.interpretations(pool);
        const currentExperiments = this.experimentViews(pool);
        if (state.interpretationRevision !== before.interpretationRevision || current.length !== snapshot.length
          || current.some((entry) => original.get(entry.id) !== entry.text)
          || state.experimentRevision !== experimentRevision || currentExperiments.length !== experiments.length
          || currentExperiments.some((entry) => examinedExperiments.get(entry.id) !== entry.text)) {
          return { applied: false, stale: true, interpretationsChanged: 0, experimentsRemoved: 0 };
        }
        let interpretationsChanged = 0;
        const completed = new Set();
        for (const { candidate, action, text, completedExperimentIds } of results) {
          for (const id of candidate.sourceIds) if (id !== candidate.id) interpretationsChanged += this.store.deleteInterpretation(pool, id);
          for (const id of completedExperimentIds) completed.add(id);
          if (action === "delete") interpretationsChanged += this.store.deleteInterpretation(pool, candidate.id);
          else {
            const finalText = action === "replace" ? text : candidate.text;
            if (finalText !== original.get(candidate.id)) interpretationsChanged += this.store.updateInterpretation(pool, candidate.id, finalText);
          }
        }
        let experimentsRemoved = 0;
        for (const id of completed) experimentsRemoved += this.store.deleteExperiment(pool, parseWire(id, "exp"));
        if (interpretationsChanged) this.store.bumpInterpretationRevision(pool);
        if (experimentsRemoved) this.store.bumpExperimentRevision(pool);
        return { applied: true, stale: false, interpretationsChanged, experimentsRemoved };
      });
      this.diagnostics.event({ ...report, status: outcome.applied ? "applied" : "stale", ...outcome });
      const counts = { considered: snapshot.length, candidates: candidates.length, interpretationsChanged: outcome.interpretationsChanged, experimentsRemoved: outcome.experimentsRemoved };
      const status = !outcome.applied ? "stale" : outcome.interpretationsChanged || outcome.experimentsRemoved ? "applied" : "unchanged";
      if (!outcome.applied) record("stale", { ...counts, reason: "The interpretations or experiments changed while Maintenance was running, so nothing was applied; a later run will retry." });
      else record(status, counts);
      return { status, ...outcome };
    } catch (error) {
      this.diagnostics.event({ ...report, status: "failed", stage, code: error.code || null });
      record(MAINTENANCE_SKIP_CODES.has(error.code) ? "skipped" : "failed", { stage, code: error.code || null, reason: String(error.message || "Maintenance failed.").slice(0, 500) });
      throw error;
    }
  }

  // The consolidation request (Specification 0004 C2/C3) sees the complete pool at once. A pool that cannot fit the
  // Contemplation model's context, or whose unmerged rewrite cannot fit its output budget, is refused, never truncated.
  async consolidate(profile, pool, snapshot) {
    const characterId = profile.characterId;
    const interpretations = snapshot.map((entry) => ({ id: wireInterpretation(entry.id), text: entry.text }));
    const messages = [{ role: "system", content: consolidationSystemPrompt() },
      { role: "user", content: JSON.stringify({ characterContext: characterContext(profile), interpretations, requiredResponseShape: { interpretations: [{ id: "int_1", sourceIds: ["int_1"], text: "..." }] } }) }];
    try { await this.llm.modelCatalog(); } catch {}
    const fit = this.llm.contextFit("contemplation", messages, profile.config);
    if (fit && !fit.fits) {
      throw coded("CONSOLIDATION_CONTEXT_EXCEEDED", `The ${snapshot.length} interpretations do not fit the Contemplation model's context (estimated ${fit.estimatedTokens} of ${fit.contextLength} tokens including the system prompt and output budget); maintenance was skipped and nothing changed.`);
    }
    const output = this.llm.outputFit("contemplation", JSON.stringify(interpretations).length, profile.config);
    if (!output.fits) {
      throw coded("CONSOLIDATION_OUTPUT_EXCEEDED", `Consolidating the ${snapshot.length} interpretations may need about ${output.estimatedTokens} output tokens, above the Contemplation max tokens setting (${output.maxTokens}); maintenance was skipped and nothing changed.`);
    }
    const { value } = await this.llm.structured({ purpose: "contemplation_consolidation", config: profile.config, messages, validate: (raw) => validateConsolidation(raw, interpretations.map((entry) => entry.id)),
      context: { characterId, pool, interpretationCount: snapshot.length } });
    return value.map((entry) => ({ id: parseWire(entry.id, "int"), sourceIds: entry.sourceIds.map((id) => parseWire(id, "int")), text: entry.text }));
  }

  async runGeneration(rt, profile) {
    const pool = rt.pool;
    const characterId = profile.characterId;
    // The pool revision is captured with the snapshot before any model call, so a manual edit during retrieval,
    // generation, or review is detected at commit.
    let revision = this.store.ensureInterpretationPool(pool).interpretationRevision;
    let interpretations = this.interpretationViews(pool);
    this.setStage(rt, "generation_retrieval", characterId);
    const conversation = this.conversation(profile);
    const memory = await this.retrieveMemory(profile, conversation);
    this.setStage(rt, "generation", characterId);
    const base = { characterContext: characterContext(profile), interpretations, conversation, memory };
    const review = async (text) => {
      this.setStage(rt, "generation_review", characterId);
      const { value } = await this.llm.structured({ purpose: "contemplation_generation_review", config: profile.config,
        messages: [{ role: "system", content: generationReviewSystemPrompt() }, { role: "user", content: JSON.stringify({ characterContext: characterContext(profile), existingInterpretations: interpretations, candidate: text, conversation, memory, requiredResponseShape: { accept: true, problem: null } }) }],
        validate: validateGenerationReview, context: { characterId, pool } });
      return value;
    };
    let feedback = null;
    let candidate = null;
    for (let attempt = 1; attempt <= 2 && !candidate; attempt += 1) {
      const payload = { ...base, ...(feedback ? { previousCandidateRejected: feedback } : {}), requiredResponseShape: { decision: "add", text: "..." } };
      const { value } = await this.llm.structured({ purpose: "contemplation_generation", config: profile.config, messages: [{ role: "system", content: generationSystemPrompt() }, { role: "user", content: JSON.stringify(payload) }],
        validate: validateGeneration, context: { characterId, pool } });
      if (value.decision === "decline") break;
      const verdict = await review(value.text);
      if (verdict.accept) candidate = value.text;
      else feedback = { text: value.text, problem: verdict.problem || "not distinct or not compatible with the facts" };
    }
    if (!candidate) {
      this.diagnostics.event({ type: "contemplation-generation", pool, characterId, status: "declined", rejected: feedback });
      return { status: "declined" };
    }
    // Commit only against the revision the approval was made for. If the pool changed meanwhile, the candidate is
    // re-reviewed against the current pool (bounded); a rejection or repeated churn discards it.
    for (let rereview = 0; ; rereview += 1) {
      const id = this.store.tx(() => {
        if (this.store.ensureInterpretationPool(pool).interpretationRevision !== revision) return null;
        const inserted = this.store.insertInterpretation(pool, candidate, { source: "generation", characterId, characterName: profile.name });
        this.store.bumpInterpretationRevision(pool);
        return inserted;
      });
      if (id !== null) {
        this.diagnostics.event({ type: "contemplation-generation", pool, characterId, status: "added", interpretationId: id, rereviews: rereview });
        return { status: "added", id };
      }
      if (rereview >= GENERATION_REREVIEWS) {
        this.diagnostics.event({ type: "contemplation-generation", pool, characterId, status: "stale_discarded", rereviews: rereview });
        return { status: "stale_discarded" };
      }
      revision = this.store.ensureInterpretationPool(pool).interpretationRevision;
      interpretations = this.interpretationViews(pool);
      const verdict = await review(candidate);
      if (!verdict.accept) {
        this.diagnostics.event({ type: "contemplation-generation", pool, characterId, status: "rejected_after_pool_change", problem: verdict.problem });
        return { status: "rejected_after_pool_change" };
      }
    }
  }

  // Gestaltization (Specification 0002 G2/G3): reinterprets the previous gestalt in the light of every current
  // interpretation. It never changes interpretations or experiments. A failure keeps the last valid gestalt, is
  // recorded, and never fails the surrounding cycle; the revision is remembered so the idle loop does not retry it.
  // forced: part of an explicit Force run, which gestaltizes even while automatic Contemplation is off.
  async gestaltizeIfDue(rt, profile, { forced = false } = {}) {
    const pool = rt.pool;
    if (!forced && !profile.config.contemplationEnabled) return { status: "disabled" };
    const state = this.store.ensureInterpretationPool(pool);
    if (!gestaltDue(state, this.store.interpretations(pool).length)) return { status: "not_needed" };
    try {
      const result = await this.runGestaltization(rt, profile);
      rt.gestaltFailedRevision = null;
      return result;
    } catch (error) {
      rt.gestaltFailedRevision = this.store.ensureInterpretationPool(pool).interpretationRevision;
      rt.lastError = this.diagnostics.error("contemplation_gestaltization", error, { pool });
      return { status: "failed" };
    }
  }

  async runGestaltization(rt, profile) {
    const pool = rt.pool;
    for (let attempt = 1; attempt <= GESTALT_STALE_RETRIES; attempt += 1) {
      this.setStage(rt, "gestaltization");
      const state = this.store.ensureInterpretationPool(pool);
      const interpretations = this.interpretationViews(pool);
      if (!gestaltDue(state, interpretations.length)) return { status: "not_needed" };
      const payload = { characterContext: characterContext(profile), interpretationRevision: state.interpretationRevision, interpretations,
        previousGestalt: state.gestalt === null ? null : { text: state.gestalt, interpretationRevision: state.gestaltRevision, updatedAt: state.gestaltUpdatedAt },
        requiredResponseShape: { gestalt: "..." } };
      const messages = [{ role: "system", content: gestaltizationSystemPrompt() }, { role: "user", content: JSON.stringify(payload) }];
      // The whole interpretation set is always sent; a set that cannot fit is refused rather than truncated.
      try { await this.llm.modelCatalog(); } catch {}
      const fit = this.llm.contextFit("contemplation", messages, profile.config);
      if (fit && !fit.fits) {
        throw coded("GESTALT_CONTEXT_EXCEEDED", `The ${interpretations.length} interpretations do not fit the Contemplation model's context (estimated ${fit.estimatedTokens} of ${fit.contextLength} tokens including the output budget); the gestalt was not updated.`);
      }
      const { value } = await this.llm.structured({ purpose: "contemplation_gestaltization", config: profile.config, messages, validate: validateGestalt,
        context: { pool, interpretationRevision: state.interpretationRevision, interpretationCount: interpretations.length } });
      const committed = this.store.tx(() => {
        if (this.store.ensureInterpretationPool(pool).interpretationRevision !== state.interpretationRevision) return false;
        this.store.setGestalt(pool, value, state.interpretationRevision);
        return true;
      });
      this.diagnostics.event({ type: "contemplation-gestaltization", pool, attempt, status: committed ? "committed" : "stale", interpretationRevision: state.interpretationRevision,
        interpretationCount: interpretations.length, characters: value.length });
      if (committed) return { status: "committed", revision: state.interpretationRevision };
    }
    throw coded("GESTALTIZATION_STALE", "The gestalt stayed stale after repeated interpretation changes; it will be synthesized at the next opportunity.");
  }

  // Experiment planning sees only the interpretation pool and the active experiments. It runs once against the
  // final committed pool after maintenance/generation; a result computed from an outdated revision is discarded.
  async planIfNeeded(rt, profile, { force = false }) {
    const pool = rt.pool;
    if (!force && !this.store.ensureInterpretationPool(pool).planningNeeded) return { status: "not_needed" };
    for (let attempt = 1; attempt <= PLANNING_STALE_RETRIES; attempt += 1) {
      this.setStage(rt, "experiment_planning");
      const state = this.store.ensureInterpretationPool(pool);
      const interpretations = this.interpretationViews(pool);
      const experiments = this.experimentViews(pool);
      const experimentIds = new Set(experiments.map((entry) => entry.id));
      const { value } = await this.llm.structured({ purpose: "contemplation_experiment_planning", config: profile.config,
        messages: [{ role: "system", content: experimentPlanningSystemPrompt() }, { role: "user", content: JSON.stringify({ characterContext: characterContext(profile), interpretations, activeExperiments: experiments, requiredResponseShape: { experiments: [{ id: null, text: "..." }] } }) }],
        validate: (raw) => validatePlanning(raw, experimentIds), context: { pool } });
      const committed = this.store.tx(() => {
        const now = this.store.ensureInterpretationPool(pool);
        if (now.interpretationRevision !== state.interpretationRevision || now.experimentRevision !== state.experimentRevision) return false;
        const keep = new Set(value.filter((entry) => entry.id).map((entry) => parseWire(entry.id, "exp")));
        for (const existing of this.store.experiments(pool)) if (!keep.has(existing.id)) this.store.deleteExperiment(pool, existing.id);
        for (const entry of value) {
          if (entry.id) this.store.updateExperiment(pool, parseWire(entry.id, "exp"), entry.text);
          else this.store.insertExperiment(pool, entry.text);
        }
        this.store.bumpExperimentRevision(pool);
        this.store.setPlanningNeeded(pool, false);
        return true;
      });
      this.diagnostics.event({ type: "contemplation-experiment-planning", pool, attempt, status: committed ? "committed" : "stale", count: value.length });
      if (committed) return { status: "committed", count: value.length };
      if (!force && !this.store.ensureInterpretationPool(pool).planningNeeded) return { status: "superseded" };
    }
    throw coded("EXPERIMENT_PLANNING_STALE", "Experiment planning stayed stale after repeated pool changes; it will run again on the next change.");
  }

  // ---- manual edits (atomic, revision-bumping; interpretation edits trigger one experiment review) -------------

  addInterpretation(pool, text, characterId = null) {
    const clean = checkText(text, INTERPRETATION_MAX_CHARS, "Interpretation");
    const character = characterId ? this.store.getCharacter(characterId) : null;
    const id = this.store.tx(() => {
      const inserted = this.store.insertInterpretation(pool, clean, { source: "manual", characterId: character?.id ?? null, characterName: character?.name ?? null });
      this.store.bumpInterpretationRevision(pool);
      return inserted;
    });
    this.afterManualInterpretationChange(pool);
    return id;
  }

  editInterpretation(pool, id, text) {
    const clean = checkText(text, INTERPRETATION_MAX_CHARS, "Interpretation");
    const changed = this.store.tx(() => {
      const count = this.store.updateInterpretation(pool, id, clean);
      if (count) this.store.bumpInterpretationRevision(pool);
      return count;
    });
    if (!changed) throw coded("NOT_FOUND", "Interpretation not found in this pool.");
    this.afterManualInterpretationChange(pool);
  }

  deleteInterpretation(pool, id) {
    const changed = this.store.tx(() => {
      const count = this.store.deleteInterpretation(pool, id);
      if (count) this.store.bumpInterpretationRevision(pool);
      return count;
    });
    if (!changed) throw coded("NOT_FOUND", "Interpretation not found in this pool.");
    this.afterManualInterpretationChange(pool);
  }

  afterManualInterpretationChange(pool) {
    if (!this.enabledFor(poolOwnerId(pool))) return;
    this.runtime(pool).gestaltFailedRevision = null;
    this.runtime(pool).planningRequested = true;
    clearTimeout(this.planningTimers.get(pool));
    const handle = setTimeout(() => { this.planningTimers.delete(pool); this.kick(pool); }, this.planningDebounceMs);
    handle.unref?.();
    this.planningTimers.set(pool, handle);
  }

  // Manual experiment edits never trigger a contemplation cycle.
  addExperiment(pool, text) {
    const clean = checkText(text, EXPERIMENT_MAX_CHARS, "Experiment");
    return this.store.tx(() => { const id = this.store.insertExperiment(pool, clean); this.store.bumpExperimentRevision(pool); return id; });
  }

  editExperiment(pool, id, text) {
    const clean = checkText(text, EXPERIMENT_MAX_CHARS, "Experiment");
    const changed = this.store.tx(() => { const count = this.store.updateExperiment(pool, id, clean); if (count) this.store.bumpExperimentRevision(pool); return count; });
    if (!changed) throw coded("NOT_FOUND", "Experiment not found in this pool.");
  }

  deleteExperiment(pool, id) {
    const changed = this.store.tx(() => { const count = this.store.deleteExperiment(pool, id); if (count) this.store.bumpExperimentRevision(pool); return count; });
    if (!changed) throw coded("NOT_FOUND", "Experiment not found in this pool.");
  }

  // ---- status -------------------------------------------------------------------------------------------------

  // The persisted gestalt with its freshness: none (not formed), pending (older than the interpretation revision),
  // or current.
  gestaltView(pool) {
    const state = this.store.ensureInterpretationPool(pool);
    const status = gestaltDue(state, this.store.interpretations(pool).length) ? "pending" : state.gestalt === null ? "none" : "current";
    return { text: state.gestalt, status, revision: state.gestaltRevision, interpretationRevision: state.interpretationRevision, updatedAt: state.gestaltUpdatedAt };
  }

  status(pool = null) {
    const view = (rt) => ({
      pool: rt.pool, running: rt.running, stage: rt.stage, stageCharacterId: rt.stageCharacterId, parallel: { ...rt.parallel },
      // Specification 0005 F3: Maintenance's current state, distinct from the last persisted attempt.
      maintenance: rt.currentForced?.kind === "maintenance" || rt.stage.startsWith("maintenance") ? "running" : rt.forced.some((op) => op.kind === "maintenance") ? "queued" : "idle",
      lastMaintenance: this.store.ensureInterpretationPool(rt.pool).lastMaintenance,
      forcedRunning: rt.currentForced?.kind ?? null,
      // Per Force kind (review 0005 P2-B): queued/running/idle now, the request id of that run, and the terminal
      // outcome of the last finished forced run of this kind in this process (or null).
      force: Object.fromEntries(FORCE_KINDS.map((kind) => {
        const waiting = rt.forced.find((op) => op.kind === kind);
        const state = rt.currentForced?.kind === kind ? "running" : waiting ? "queued" : "idle";
        return [kind, { state, requestId: rt.currentForced?.kind === kind ? rt.currentForced.requestId : waiting?.requestId ?? null, last: rt.lastForced[kind] ?? null }];
      })),
      queued: { pendingCharacterIds: [...rt.pendingCharacters], forced: rt.forced.map((op) => op.kind), planningRequested: rt.planningRequested || this.store.ensureInterpretationPool(rt.pool).planningNeeded,
        gestaltDue: this.gestaltView(rt.pool).status === "pending" },
      lastError: rt.lastError ? { at: rt.lastError.at, stage: rt.lastError.stage, code: rt.lastError.code, message: rt.lastError.message } : null,
      lastCycle: rt.lastCycle, cycles: rt.cycles
    });
    if (pool) return view(this.runtime(pool));
    return [...this.pools.values()].map(view);
  }
}

function checkText(text, max, label) {
  if (typeof text !== "string" || !text.trim()) throw coded("TEXT_INVALID", `${label} text must not be empty.`);
  if (text.trim().length > max) throw coded("TEXT_INVALID", `${label} text must be at most ${max} characters.`);
  return text.trim();
}

