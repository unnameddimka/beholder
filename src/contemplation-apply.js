// Contemplation atomic application (Specification 0006 R2.3): the only Contemplation code that writes cognitive
// state. Every revision/snapshot guard that protects a write runs inside the same SQLite transaction (Store.tx) that
// performs it, so a stale or concurrent result leaves the newer state intact and nothing is partially applied.
import { coded } from "./utils.js";
import { INTERPRETATION_MAX_CHARS, EXPERIMENT_MAX_CHARS } from "./prompts/contemplation.js";
import { parseWire } from "./contracts/contemplation.js";

export class ContemplationApply {
  constructor({ store }) {
    this.store = store;
  }

  // ---- maintenance --------------------------------------------------------------------------------------------

  // A Maintenance attempt still marked running belongs to a previous process: it was interrupted, never applied.
  markInterruptedMaintenance() {
    for (const state of this.store.interpretationPools()) {
      if (state.lastMaintenance?.status === "running") {
        this.store.setLastMaintenance(state.pool, { ...state.lastMaintenance, status: "interrupted", finishedAt: null,
          reason: "The server stopped while this Maintenance was running; nothing from it was applied." });
      }
    }
  }

  recordMaintenance(pool, entry) { this.store.setLastMaintenance(pool, entry); }

  // Commits the whole verified set only if the pool is still exactly the snapshot the consolidation read (same
  // revision, ids and texts) and the experiments are still exactly what the verifiers examined (same revision, ids
  // and texts). Otherwise the newer state wins, nothing is applied (neither interpretations nor completions), and a
  // later run retries. Revisions are bumped only when something actually changed.
  applyMaintenance(pool, { before, snapshot, experimentRevision, experiments, results }, experimentViews) {
    const examinedExperiments = new Map(experiments.map((entry) => [entry.id, entry.text]));
    const original = new Map(snapshot.map((entry) => [entry.id, entry.text]));
    return this.store.tx(() => {
      const state = this.store.ensureInterpretationPool(pool);
      const current = this.store.interpretations(pool);
      const currentExperiments = experimentViews(pool);
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
  }

  // ---- generation, gestalt, planning, watermark ---------------------------------------------------------------

  // Inserts an approved candidate only against the revision the approval was made for; null when the pool changed.
  insertGenerated(pool, text, revision, profile) {
    return this.store.tx(() => {
      if (this.store.ensureInterpretationPool(pool).interpretationRevision !== revision) return null;
      const inserted = this.store.insertInterpretation(pool, text, { source: "generation", characterId: profile.characterId, characterName: profile.name });
      this.store.bumpInterpretationRevision(pool);
      return inserted;
    });
  }

  // Commits a gestalt only against the interpretation revision it was synthesized from.
  commitGestalt(pool, text, interpretationRevision) {
    return this.store.tx(() => {
      if (this.store.ensureInterpretationPool(pool).interpretationRevision !== interpretationRevision) return false;
      this.store.setGestalt(pool, text, interpretationRevision);
      return true;
    });
  }

  // Replaces the whole experiment array atomically, guarded by both revisions the plan was computed from.
  applyPlanning(pool, { experiments, interpretationRevision, experimentRevision }) {
    return this.store.tx(() => {
      const now = this.store.ensureInterpretationPool(pool);
      if (now.interpretationRevision !== interpretationRevision || now.experimentRevision !== experimentRevision) return false;
      const keep = new Set(experiments.filter((entry) => entry.id).map((entry) => parseWire(entry.id, "exp")));
      for (const existing of this.store.experiments(pool)) if (!keep.has(existing.id)) this.store.deleteExperiment(pool, existing.id);
      for (const entry of experiments) {
        if (entry.id) this.store.updateExperiment(pool, parseWire(entry.id, "exp"), entry.text);
        else this.store.insertExperiment(pool, entry.text);
      }
      this.store.bumpExperimentRevision(pool);
      this.store.setPlanningNeeded(pool, false);
      return true;
    });
  }

  // The per-(pool, chat) watermark advances only after a successful cycle's maintenance and generation.
  advanceWatermark(pool, characterId, messageId) { this.store.setWatermark(pool, characterId, messageId); }

  // ---- manual edits (atomic, revision-bumping) ----------------------------------------------------------------

  addInterpretation(pool, text, character) {
    const clean = checkText(text, INTERPRETATION_MAX_CHARS, "Interpretation");
    return this.store.tx(() => {
      const inserted = this.store.insertInterpretation(pool, clean, { source: "manual", characterId: character?.id ?? null, characterName: character?.name ?? null });
      this.store.bumpInterpretationRevision(pool);
      return inserted;
    });
  }

  editInterpretation(pool, id, text) {
    const clean = checkText(text, INTERPRETATION_MAX_CHARS, "Interpretation");
    const changed = this.store.tx(() => {
      const count = this.store.updateInterpretation(pool, id, clean);
      if (count) this.store.bumpInterpretationRevision(pool);
      return count;
    });
    if (!changed) throw coded("NOT_FOUND", "Interpretation not found in this pool.");
  }

  deleteInterpretation(pool, id) {
    const changed = this.store.tx(() => {
      const count = this.store.deleteInterpretation(pool, id);
      if (count) this.store.bumpInterpretationRevision(pool);
      return count;
    });
    if (!changed) throw coded("NOT_FOUND", "Interpretation not found in this pool.");
  }

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
}

function checkText(text, max, label) {
  if (typeof text !== "string" || !text.trim()) throw coded("TEXT_INVALID", `${label} text must not be empty.`);
  if (text.trim().length > max) throw coded("TEXT_INVALID", `${label} text must be at most ${max} characters.`);
  return text.trim();
}
