// Contemplation stage execution (Specification 0006 R2.2): each stage reads its own inputs at the moment it always
// has, builds its LLM messages from the purpose's contract (src/contracts/contemplation.js), calls the model with the
// job's frozen configuration, validates, and returns an uncommitted candidate together with the source-state metadata
// the application must guard on. Nothing here writes to the store, not even pool creation; src/contemplation-apply.js
// commits and src/contemplation.js ensures the pool exists first.
// progress.stage(name) reports the running stage; progress.parallel(counter) exposes the verification counter.
import { coded, mapLimited } from "./utils.js";
import { poolOf } from "./db.js";
import { messageView } from "./memory.js";
import { characterContext } from "./prompts/context.js";
import { CONTEMPLATION_CONTRACTS, wireInterpretation, wireExperiment, parseWire } from "./contracts/contemplation.js";

export const CONTEMPLATION_HISTORY = 100;
const RETRIEVAL_SITUATION_MESSAGES = 12;

// A gestalt is due when it does not reflect the current interpretation revision and there is something to
// synthesize: interpretations, or an earlier gestalt to reconsider. An empty pool without a gestalt stays empty.
export function gestaltDue(state, interpretationCount) {
  return state.gestaltRevision !== state.interpretationRevision && (interpretationCount > 0 || state.gestalt !== null);
}

// The system prompt and the payload (with the contract's required response shape last) of one request.
function requestMessages(purpose, payload) {
  const contract = CONTEMPLATION_CONTRACTS[purpose];
  return [{ role: "system", content: contract.systemPrompt() }, { role: "user", content: JSON.stringify({ ...payload, requiredResponseShape: contract.responseShape }) }];
}

export class ContemplationStages {
  constructor({ store, llm, memory, maxParallel }) {
    this.store = store;
    this.llm = llm;
    this.memory = memory;
    this.maxParallel = maxParallel;
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

  // Read-only pool state; stages never create a pool (review 0006 P2). The orchestration ensures the pool exists before
  // a stage runs, and pool rows are never deleted at runtime.
  poolState(pool) {
    const state = this.store.interpretationPool(pool);
    if (!state) throw coded("INTERPRETATION_POOL_MISSING", "The interpretation pool does not exist.");
    return state;
  }

  request(purpose, profile, messages, validate, context) {
    return this.llm.structured({ purpose, config: profile.config, messages, validate, context });
  }

  // ---- prefetch -----------------------------------------------------------------------------------------------

  // Prefetch sees exactly the whole interpretation pool, the latest verbatim messages and the active experiment
  // intentions; no consolidated memory.
  async prefetch(profile, pool) {
    const messages = requestMessages("contemplation_prefetch", { characterContext: characterContext(profile), interpretations: this.interpretationViews(pool),
      activeExperiments: this.experimentViews(pool), conversation: this.conversation(profile) });
    const { value } = await this.request("contemplation_prefetch", profile, messages, CONTEMPLATION_CONTRACTS.contemplation_prefetch.validate, { characterId: profile.characterId, pool });
    return value;
  }

  // ---- maintenance --------------------------------------------------------------------------------------------

  // The consolidation request (Specification 0004 C2/C3) sees the complete pool at once. A pool that cannot fit the
  // Contemplation model's context, or whose unmerged rewrite cannot fit its output budget, is refused, never truncated.
  async consolidate(profile, pool, snapshot) {
    const characterId = profile.characterId;
    const interpretations = snapshot.map((entry) => ({ id: wireInterpretation(entry.id), text: entry.text }));
    const messages = requestMessages("contemplation_consolidation", { characterContext: characterContext(profile), interpretations });
    try { await this.llm.modelCatalog(); } catch {}
    const fit = this.llm.contextFit("contemplation", messages, profile.config);
    if (fit && !fit.fits) {
      throw coded("CONSOLIDATION_CONTEXT_EXCEEDED", `The ${snapshot.length} interpretations do not fit the Contemplation model's context (estimated ${fit.estimatedTokens} of ${fit.contextLength} tokens including the system prompt and output budget); maintenance was skipped and nothing changed.`);
    }
    const output = this.llm.outputFit("contemplation", JSON.stringify(interpretations).length, profile.config);
    if (!output.fits) {
      throw coded("CONSOLIDATION_OUTPUT_EXCEEDED", `Consolidating the ${snapshot.length} interpretations may need about ${output.estimatedTokens} output tokens, above the Contemplation max tokens setting (${output.maxTokens}); maintenance was skipped and nothing changed.`);
    }
    const suppliedIds = interpretations.map((entry) => entry.id);
    const { value } = await this.request("contemplation_consolidation", profile, messages, (raw) => CONTEMPLATION_CONTRACTS.contemplation_consolidation.validate(raw, suppliedIds),
      { characterId, pool, interpretationCount: snapshot.length });
    return value.map((entry) => ({ id: parseWire(entry.id, "int"), sourceIds: entry.sourceIds.map((id) => parseWire(id, "int")), text: entry.text }));
  }

  // The existing per-interpretation check of every consolidated candidate, in parallel within maxParallel. Returns
  // every verdict with the experiment snapshot all verifiers saw, which also guards the commit (review 0004 P2).
  async verify(profile, pool, candidates, progress) {
    const characterId = profile.characterId;
    progress.stage("maintenance_retrieval");
    const conversation = this.conversation(profile);
    const memory = await this.retrieveMemory(profile, conversation);
    const experimentRevision = this.poolState(pool).experimentRevision;
    const experiments = this.experimentViews(pool);
    const experimentIds = new Set(experiments.map((entry) => entry.id));
    progress.stage("maintenance");
    const counter = { total: candidates.length, inFlight: 0 };
    progress.parallel(counter);
    const results = await mapLimited(candidates, this.maxParallel, async (candidate) => {
      counter.inFlight += 1;
      try {
        const messages = requestMessages("contemplation_maintenance", { characterContext: characterContext(profile), interpretation: { id: wireInterpretation(candidate.id), text: candidate.text },
          conversation, memory, activeExperiments: experiments });
        const { value } = await this.request("contemplation_maintenance", profile, messages, (raw) => CONTEMPLATION_CONTRACTS.contemplation_maintenance.validate(raw, experimentIds),
          { characterId, pool, interpretationId: candidate.id });
        return { candidate, ...value };
      } finally {
        counter.inFlight -= 1;
      }
    }).finally(() => { progress.parallel({ total: 0, inFlight: 0 }); });
    return { results, experiments, experimentRevision };
  }

  // ---- generation ---------------------------------------------------------------------------------------------

  // The pool revision is captured with the snapshot before any model call, so a manual edit during retrieval,
  // generation, or review is detected at commit.
  async generationContext(profile, pool, progress) {
    const revision = this.poolState(pool).interpretationRevision;
    const interpretations = this.interpretationViews(pool);
    progress.stage("generation_retrieval");
    const conversation = this.conversation(profile);
    const memory = await this.retrieveMemory(profile, conversation);
    return { revision, interpretations, conversation, memory };
  }

  // Re-reads the pool a stale candidate must now be reviewed against.
  refreshGenerationContext(pool, context) {
    context.revision = this.poolState(pool).interpretationRevision;
    context.interpretations = this.interpretationViews(pool);
  }

  async review(profile, pool, context, text, progress) {
    progress.stage("generation_review");
    const messages = requestMessages("contemplation_generation_review", { characterContext: characterContext(profile), existingInterpretations: context.interpretations, candidate: text,
      conversation: context.conversation, memory: context.memory });
    const { value } = await this.request("contemplation_generation_review", profile, messages, CONTEMPLATION_CONTRACTS.contemplation_generation_review.validate, { characterId: profile.characterId, pool });
    return value;
  }

  // At most two candidates; the second sees why the first was rejected. Returns the accepted text or null.
  async generate(profile, pool, context, progress) {
    progress.stage("generation");
    const base = { characterContext: characterContext(profile), interpretations: context.interpretations, conversation: context.conversation, memory: context.memory };
    let feedback = null;
    let candidate = null;
    for (let attempt = 1; attempt <= 2 && !candidate; attempt += 1) {
      const messages = requestMessages("contemplation_generation", { ...base, ...(feedback ? { previousCandidateRejected: feedback } : {}) });
      const { value } = await this.request("contemplation_generation", profile, messages, CONTEMPLATION_CONTRACTS.contemplation_generation.validate, { characterId: profile.characterId, pool });
      if (value.decision === "decline") break;
      const verdict = await this.review(profile, pool, context, value.text, progress);
      if (verdict.accept) candidate = value.text;
      else feedback = { text: value.text, problem: verdict.problem || "not distinct or not compatible with the facts" };
    }
    return { candidate, feedback };
  }

  // ---- gestaltization -----------------------------------------------------------------------------------------

  // One gestalt over every current interpretation and the previous gestalt, or null when none is due.
  async gestalt(profile, pool, progress) {
    progress.stage("gestaltization");
    const state = this.poolState(pool);
    const interpretations = this.interpretationViews(pool);
    if (!gestaltDue(state, interpretations.length)) return null;
    const messages = requestMessages("contemplation_gestaltization", { characterContext: characterContext(profile), interpretationRevision: state.interpretationRevision, interpretations,
      previousGestalt: state.gestalt === null ? null : { text: state.gestalt, interpretationRevision: state.gestaltRevision, updatedAt: state.gestaltUpdatedAt } });
    // The whole interpretation set is always sent; a set that cannot fit is refused rather than truncated.
    try { await this.llm.modelCatalog(); } catch {}
    const fit = this.llm.contextFit("contemplation", messages, profile.config);
    if (fit && !fit.fits) {
      throw coded("GESTALT_CONTEXT_EXCEEDED", `The ${interpretations.length} interpretations do not fit the Contemplation model's context (estimated ${fit.estimatedTokens} of ${fit.contextLength} tokens including the output budget); the gestalt was not updated.`);
    }
    const { value } = await this.request("contemplation_gestaltization", profile, messages, CONTEMPLATION_CONTRACTS.contemplation_gestaltization.validate,
      { pool, interpretationRevision: state.interpretationRevision, interpretationCount: interpretations.length });
    return { text: value, interpretationRevision: state.interpretationRevision, interpretationCount: interpretations.length };
  }

  // ---- experiment planning ------------------------------------------------------------------------------------

  // Experiment planning sees only the interpretation pool, the active experiments and characterContext. The
  // replacement array is returned with both revisions it was computed from.
  async plan(profile, pool, progress) {
    progress.stage("experiment_planning");
    const state = this.poolState(pool);
    const interpretations = this.interpretationViews(pool);
    const experiments = this.experimentViews(pool);
    const experimentIds = new Set(experiments.map((entry) => entry.id));
    const messages = requestMessages("contemplation_experiment_planning", { characterContext: characterContext(profile), interpretations, activeExperiments: experiments });
    const { value } = await this.request("contemplation_experiment_planning", profile, messages, (raw) => CONTEMPLATION_CONTRACTS.contemplation_experiment_planning.validate(raw, experimentIds), { pool });
    return { experiments: value, interpretationRevision: state.interpretationRevision, experimentRevision: state.experimentRevision };
  }
}
