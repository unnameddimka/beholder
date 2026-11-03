// Contemplation: an independent background process per interpretation pool (Specification 0000 section 5); each
// character owns exactly one pool (Specification 0004).
// One serial pipeline per pool: prefetch -> maintenance (one consolidation of the whole pool, then a parallel check
// per consolidated interpretation, all-or-nothing commit) ->
// generation (with an LLM review of the candidate) -> gestaltization (Specification 0002) -> at most one
// experiment-planning pass against the final pool.
// User messages arriving during a cycle are coalesced through a persisted per-(pool, chat) watermark. Writes are
// atomic SQLite transactions guarded by revisions/snapshots, so stale results never overwrite newer state.
// Every job runs on the owner's configuration and descriptions frozen at its start (Specification 0005 A5).
//
// Specification 0006 R2 splits the responsibilities: this module is the application-facing facade and the
// orchestration (triggers, Force, queues, the per-pool work loop, restart recovery, planning timers, status); stage
// execution lives in src/contemplation-stages.js and every state write in src/contemplation-apply.js. The LLM
// contracts of the stages are in src/contracts/contemplation.js.
import { coded, nowIso } from "./utils.js";
import { poolOf, poolOwnerId } from "./db.js";
import { profileOf } from "./settings.js";
import { ContemplationStages, gestaltDue } from "./contemplation-stages.js";
import { ContemplationApply } from "./contemplation-apply.js";

export { CONTEMPLATION_HISTORY, gestaltDue } from "./contemplation-stages.js";
export { validatePrefetch, validateMaintenance, validateConsolidation, validateGeneration, validateGenerationReview, validateGestalt, validatePlanning } from "./contracts/contemplation.js";

const PLANNING_STALE_RETRIES = 3;
const GESTALT_STALE_RETRIES = 3;
const GENERATION_REREVIEWS = 2;
// Manual edits often come in quick succession; a short debounce lets them coalesce into one experiment review.
const MANUAL_PLANNING_DEBOUNCE_MS = 200;

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
    this.stages = new ContemplationStages({ store, llm, memory, maxParallel });
    this.apply = new ContemplationApply({ store });
    this.apply.markInterruptedMaintenance();
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

  setStage(rt, stage, characterId = null) {
    rt.stage = stage;
    rt.stageCharacterId = characterId;
    this.diagnostics.event({ type: "contemplation-stage", pool: rt.pool, stage, characterId });
  }

  // The stage-progress hooks of one pool runtime; characterId is reported with each stage it runs for.
  progress(rt, characterId = null) {
    return { stage: (name) => this.setStage(rt, name, characterId), parallel: (counter) => { rt.parallel = counter; } };
  }

  // ---- orchestration of the stages ----------------------------------------------------------------------------

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
      const flags = await this.stages.prefetch(profile, pool);
      cycle.flags = flags;
      if (flags.maintenance && this.store.interpretations(pool).length) await this.runMaintenance(rt, profile, "automatic");
      if (flags.generation) await this.runGeneration(rt, profile);
      this.apply.advanceWatermark(pool, characterId, targetMessageId);
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
    const record = (status, extra = {}) => this.apply.recordMaintenance(pool, { status, source, startedAt, finishedAt: status === "running" ? null : nowIso(), ...extra });
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
      const candidates = await this.stages.consolidate(profile, pool, snapshot);
      report.candidates = candidates.length;
      report.merged = snapshot.length - candidates.length;
      stage = "verification";
      const { results, experiments, experimentRevision } = await this.stages.verify(profile, pool, candidates, this.progress(rt, characterId));
      report.verified = results.length;
      report.actions = results.map((r) => ({ id: r.candidate.id, sourceIds: r.candidate.sourceIds, action: r.action, completed: r.completedExperimentIds }));
      stage = "commit";
      const outcome = this.apply.applyMaintenance(pool, { before, snapshot, experimentRevision, experiments, results }, (target) => this.stages.experimentViews(target));
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

  async runGeneration(rt, profile) {
    const pool = rt.pool;
    const characterId = profile.characterId;
    const progress = this.progress(rt, characterId);
    const context = await this.stages.generationContext(profile, pool, progress);
    const { candidate, feedback } = await this.stages.generate(profile, pool, context, progress);
    if (!candidate) {
      this.diagnostics.event({ type: "contemplation-generation", pool, characterId, status: "declined", rejected: feedback });
      return { status: "declined" };
    }
    // Commit only against the revision the approval was made for. If the pool changed meanwhile, the candidate is
    // re-reviewed against the current pool (bounded); a rejection or repeated churn discards it.
    for (let rereview = 0; ; rereview += 1) {
      const id = this.apply.insertGenerated(pool, candidate, context.revision, profile);
      if (id !== null) {
        this.diagnostics.event({ type: "contemplation-generation", pool, characterId, status: "added", interpretationId: id, rereviews: rereview });
        return { status: "added", id };
      }
      if (rereview >= GENERATION_REREVIEWS) {
        this.diagnostics.event({ type: "contemplation-generation", pool, characterId, status: "stale_discarded", rereviews: rereview });
        return { status: "stale_discarded" };
      }
      this.stages.refreshGenerationContext(pool, context);
      const verdict = await this.stages.review(profile, pool, context, candidate, progress);
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
      const result = await this.stages.gestalt(profile, pool, this.progress(rt));
      if (!result) return { status: "not_needed" };
      const committed = this.apply.commitGestalt(pool, result.text, result.interpretationRevision);
      this.diagnostics.event({ type: "contemplation-gestaltization", pool, attempt, status: committed ? "committed" : "stale", interpretationRevision: result.interpretationRevision,
        interpretationCount: result.interpretationCount, characters: result.text.length });
      if (committed) return { status: "committed", revision: result.interpretationRevision };
    }
    throw coded("GESTALTIZATION_STALE", "The gestalt stayed stale after repeated interpretation changes; it will be synthesized at the next opportunity.");
  }

  // Experiment planning runs once against the final committed pool after maintenance/generation; a result computed
  // from an outdated revision is discarded.
  async planIfNeeded(rt, profile, { force = false }) {
    const pool = rt.pool;
    if (!force && !this.store.ensureInterpretationPool(pool).planningNeeded) return { status: "not_needed" };
    for (let attempt = 1; attempt <= PLANNING_STALE_RETRIES; attempt += 1) {
      const plan = await this.stages.plan(profile, pool, this.progress(rt));
      const committed = this.apply.applyPlanning(pool, plan);
      this.diagnostics.event({ type: "contemplation-experiment-planning", pool, attempt, status: committed ? "committed" : "stale", count: plan.experiments.length });
      if (committed) return { status: "committed", count: plan.experiments.length };
      if (!force && !this.store.ensureInterpretationPool(pool).planningNeeded) return { status: "superseded" };
    }
    throw coded("EXPERIMENT_PLANNING_STALE", "Experiment planning stayed stale after repeated pool changes; it will run again on the next change.");
  }

  // ---- manual edits (atomic, revision-bumping; interpretation edits trigger one experiment review) -------------

  addInterpretation(pool, text, characterId = null) {
    const character = characterId ? this.store.getCharacter(characterId) : null;
    const id = this.apply.addInterpretation(pool, text, character);
    this.afterManualInterpretationChange(pool);
    return id;
  }

  editInterpretation(pool, id, text) {
    this.apply.editInterpretation(pool, id, text);
    this.afterManualInterpretationChange(pool);
  }

  deleteInterpretation(pool, id) {
    this.apply.deleteInterpretation(pool, id);
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
  addExperiment(pool, text) { return this.apply.addExperiment(pool, text); }

  editExperiment(pool, id, text) { this.apply.editExperiment(pool, id, text); }

  deleteExperiment(pool, id) { this.apply.deleteExperiment(pool, id); }

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
