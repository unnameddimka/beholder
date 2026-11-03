// Specification 0006: explicit LLM-operation contracts (R1), separated Contemplation responsibilities (R2), and
// pregnant interpretations (S).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT, makeApp, closeApp, configure, tempDir, waitFor } from "./helpers.js";
import { CONTRACTS, PURPOSE_ROLES as CONTRACT_ROLES, contractOf } from "../src/contracts/index.js";
import { PURPOSE_ROLES } from "../src/llm.js";
import { validateMaintenance, validateConsolidation, validatePlanning, validateGeneration } from "../src/contracts/contemplation.js";
import { validateRetrieval } from "../src/memory.js";
import { ContemplationApply } from "../src/contemplation-apply.js";
import { poolOf } from "../src/db.js";
import { profileOf } from "../src/settings.js";
import * as contemplationPrompts from "../src/prompts/contemplation.js";
import * as memoryPrompts from "../src/prompts/memory.js";
import * as dialoguePrompts from "../src/prompts/dialogue.js";
import * as visionPrompts from "../src/prompts/vision.js";
import * as repairPrompts from "../src/prompts/repair.js";

const source = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const golden = JSON.parse(source("tests/fixtures/golden-traces.json"));
const goldenCalls = Object.values(golden).flatMap((scenario) => scenario.trace);
const base = { name: "Mira", description: "Keeper." };

// ---- R1 ---------------------------------------------------------------------------------------------------------

test("R1/14: every purpose named in src has exactly one contract with role, prompt from src/prompts, shape, validator and transport", () => {
  const files = fs.readdirSync(path.join(ROOT, "src")).filter((name) => name.endsWith(".js")).map((name) => source(`src/${name}`)).join("\n");
  const named = new Set([...files.matchAll(/purpose: "([a-z_]+)"/g)].map((match) => match[1]));
  // Image generation uses the separate Images API, not a Chat Completions purpose with a model role.
  named.delete("image_generation");
  // Contemplation stages pass their purpose positionally; the contracts module names each one.
  for (const match of source("src/contracts/contemplation.js").matchAll(/^ {2}(contemplation_[a-z_]+): \{/gm)) named.add(match[1]);
  for (const purpose of ["dialogue_reply", "dialogue_followup", "dialogue_opener"]) named.add(purpose); // chosen by mode in src/dialogue.js
  assert.deepEqual([...named].sort(), Object.keys(CONTRACTS).sort());
  const promptExports = new Set([...Object.values(contemplationPrompts), ...Object.values(memoryPrompts), ...Object.values(dialoguePrompts), ...Object.values(visionPrompts)]);
  for (const [purpose, contract] of Object.entries(CONTRACTS)) {
    assert.equal(contract.purpose, purpose);
    assert.ok(["dialogue", "contemplation", "vision"].includes(contract.role), purpose);
    assert.equal(typeof contract.systemPrompt, "function", purpose);
    if (!purpose.endsWith("_memory_retrieval")) assert.ok(promptExports.has(contract.systemPrompt), `${purpose} prompt lives in src/prompts`);
    assert.equal(typeof contract.validate, "function", purpose);
    assert.ok(contract.responseShape, purpose);
    assert.ok(Array.isArray(contract.checks) && typeof contract.input === "string" && typeof contract.failure === "string", purpose);
    assert.ok(["structured", "plain"].includes(contract.transport.call), purpose);
  }
  // Memory retrieval binds the shared retrieval prompt to its purpose text.
  assert.equal(contractOf("dialogue_memory_retrieval").systemPrompt(), memoryPrompts.retrievalSystemPrompt(memoryPrompts.DIALOGUE_RETRIEVAL_PURPOSE));
  assert.equal(contractOf("contemplation_memory_retrieval").systemPrompt(), memoryPrompts.retrievalSystemPrompt(memoryPrompts.CONTEMPLATION_RETRIEVAL_PURPOSE));
});

test("R1/14: model roles are unchanged and come from the contracts; LlmClient uses the same table", () => {
  assert.equal(PURPOSE_ROLES, CONTRACT_ROLES);
  assert.deepEqual({ ...PURPOSE_ROLES }, {
    dialogue_reply: "dialogue", dialogue_followup: "dialogue", dialogue_opener: "dialogue", dialogue_memory_retrieval: "dialogue",
    memory_stm_consolidation: "dialogue", memory_ltm_selection: "dialogue", memory_ltm_consolidation: "dialogue",
    contemplation_prefetch: "contemplation", contemplation_memory_retrieval: "contemplation", contemplation_consolidation: "contemplation",
    contemplation_maintenance: "contemplation", contemplation_generation: "contemplation", contemplation_generation_review: "contemplation",
    contemplation_gestaltization: "contemplation", contemplation_experiment_planning: "contemplation", vision_observation: "vision"
  });
});

test("R1/16: response_format, isolated repair and plain-text fallback apply exactly to the three Dialogue envelopes; Vision is plain", () => {
  const envelopes = Object.values(CONTRACTS).filter((contract) => contract.transport.responseFormat === "dialogue_envelope").map((contract) => contract.purpose).sort();
  assert.deepEqual(envelopes, ["dialogue_followup", "dialogue_opener", "dialogue_reply"]);
  for (const contract of Object.values(CONTRACTS)) {
    const envelope = envelopes.includes(contract.purpose);
    assert.equal(contract.transport.repair, envelope ? "dialogue_isolated" : contract.purpose === "vision_observation" ? "none" : "contextual", contract.purpose);
    assert.equal(contract.transport.plainTextFallback, envelope, contract.purpose);
  }
  assert.equal(contractOf("vision_observation").transport.call, "plain");
  // In the recorded requests, no background or memory purpose ever carries response_format (the recorded Dialogue
  // model is uncatalogued, so its envelope is prompt-only there; the format modes are covered by spec-0001 tests).
  for (const call of goldenCalls) if (!envelopes.includes(call.purpose)) assert.equal("response_format" in call.body, false, call.purpose);
});

test("R1/14: each structured request's requiredResponseShape is exactly its contract's response shape", () => {
  let checked = 0;
  for (const call of goldenCalls) {
    const contract = contractOf(call.purpose);
    if (contract.transport.responseFormat !== "none" || contract.transport.call !== "structured") continue;
    const user = call.body.messages.find((message) => message.role === "user");
    assert.deepEqual(JSON.parse(user.content).requiredResponseShape, contract.responseShape, call.purpose);
    assert.equal(call.body.messages[0].content, contract.systemPrompt("Mira"), call.purpose);
    checked += 1;
  }
  assert.ok(checked >= 10);
});

test("R1/15: snapshot-scoped ids, coverage and membership are enforced beyond JSON shape", () => {
  const ok = { action: "unchanged", text: null, completedExperimentIds: ["exp_9"] };
  assert.equal(validateMaintenance(ok, new Set(["exp_1"])).ok, false, "an experiment the verifier never saw");
  assert.equal(validateMaintenance(ok, new Set(["exp_9"])).ok, true);
  const partial = { interpretations: [{ id: "int_1", sourceIds: ["int_1"], text: "x" }] };
  assert.equal(validateConsolidation(partial, ["int_1", "int_2"]).ok, false, "every supplied id must be covered");
  assert.equal(validateConsolidation(partial, ["int_1"]).ok, true);
  assert.equal(validatePlanning({ experiments: [{ id: "exp_3", text: "x" }] }, new Set(["exp_1"])).ok, false);
  assert.deepEqual(validateRetrieval({ stmIds: ["stm_1", "stm_7", "stm_1"], ltmIds: ["ltm_2"] }, { stmIds: new Set(["stm_1"]), ltmIds: new Set() }).value, { stmIds: ["stm_1"], ltmIds: [] });
});

// ---- R2 ---------------------------------------------------------------------------------------------------------

test("R2/14: orchestration and stages call no write method by name; the application layer owns the transactions", () => {
  const writes = /\.store\.(insert|update|delete|set|bump|add|complete|fail|tx)[A-Za-z]*\(/;
  assert.doesNotMatch(source("src/contemplation-stages.js"), writes);
  assert.doesNotMatch(source("src/contemplation-stages.js"), /ensureInterpretationPool/);
  assert.doesNotMatch(source("src/contemplation.js"), writes);
  assert.match(source("src/contemplation-apply.js"), /this\.store\.tx\(/);
});

// Records every SQL statement that is not a plain SELECT, at the SQLite boundary, so writes made through helper
// methods are observed too (review 0006 P2).
function recordWrites(store) {
  const writes = [];
  const prepare = store.db.prepare.bind(store.db);
  const exec = store.db.exec.bind(store.db);
  const isWrite = (sql) => !/^\s*SELECT\b/i.test(sql);
  store.db.prepare = (sql) => {
    const statement = prepare(sql);
    if (!isWrite(sql)) return statement;
    return new Proxy(statement, { get: (target, key) => {
      const value = Reflect.get(target, key);
      return typeof value === "function" ? (...args) => { writes.push(sql); return value.apply(target, args); } : value;
    } });
  };
  store.db.exec = (sql) => { if (isWrite(sql)) writes.push(sql); return exec(sql); };
  return { writes, restore: () => { store.db.prepare = prepare; store.db.exec = exec; } };
}

test("review 0006 P2: stage execution issues no SQL write, through helpers included, on an existing or an absent pool", async () => {
  const { app } = await makeApp({
    contemplation_prefetch: () => ({ generation: true, maintenance: true }),
    contemplation_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    contemplation_consolidation: (body) => ({ interpretations: JSON.parse(body.messages[1].content).interpretations.map((entry) => ({ id: entry.id, sourceIds: [entry.id], text: entry.text })) }),
    contemplation_maintenance: () => ({ action: "unchanged", text: null, completedExperimentIds: [] }),
    contemplation_generation: () => ({ decision: "add", text: "A ferry pilot." }),
    contemplation_generation_review: () => ({ accept: true, problem: null }),
    contemplation_gestaltization: () => ({ gestalt: "One person." }),
    contemplation_experiment_planning: () => ({ experiments: [] })
  });
  try {
    const mira = app.createCharacter(base);
    const pool = poolOf(mira);
    configure(app, mira.id, { contemplationEnabled: false });
    app.contemplation.addInterpretation(pool, "A beekeeper.");
    app.contemplation.addExperiment(pool, "Mention honey.");
    const profile = profileOf(app.store.getCharacter(mira.id));
    const stages = app.contemplation.stages;
    const progress = { stage: () => {}, parallel: () => {} };
    const recorder = recordWrites(app.store);
    try {
      // An existing pool: every stage computes its candidate without a write.
      await stages.prefetch(profile, pool);
      const candidates = await stages.consolidate(profile, pool, app.store.interpretations(pool));
      await stages.verify(profile, pool, candidates, progress);
      const context = await stages.generationContext(profile, pool, progress);
      await stages.generate(profile, pool, context, progress);
      stages.refreshGenerationContext(pool, context);
      assert.ok(await stages.gestalt(profile, pool, progress));
      await stages.plan(profile, pool, progress);
      assert.deepEqual(recorder.writes, []);
      // An absent pool: the stage refuses and does not create it.
      const absent = "character:4242";
      for (const run of [() => stages.generationContext(profile, absent, progress), () => stages.gestalt(profile, absent, progress), () => stages.plan(profile, absent, progress),
        () => stages.verify(profile, absent, [], progress)]) {
        await assert.rejects(run, { code: "INTERPRETATION_POOL_MISSING" });
      }
      assert.deepEqual(recorder.writes, []);
      assert.equal(app.store.interpretationPool(absent), null);
    } finally { recorder.restore(); }
  } finally { closeApp(app); }
});

test("review 0006 P2: an absent pool is still created by its owner path; automatic and forced runs keep working", async () => {
  const { app, mock } = await makeApp({
    dialogue_reply: () => ({ message: "ok", followUpDelaySeconds: null, imageRequest: null }),
    contemplation_prefetch: () => ({ generation: true, maintenance: false }),
    contemplation_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    contemplation_generation: () => ({ decision: "add", text: "A ferry pilot." }),
    contemplation_generation_review: () => ({ accept: true, problem: null }),
    contemplation_gestaltization: () => ({ gestalt: "One person." }),
    contemplation_experiment_planning: () => ({ experiments: [{ id: null, text: "Ask about boats." }] })
  });
  try {
    for (const route of ["automatic", "forced"]) {
      const mira = app.createCharacter({ ...base, name: `Mira ${route}` });
      const pool = poolOf(mira);
      // Simulate a pool row that was never initialized.
      app.store.db.prepare("DELETE FROM interpretation_pools WHERE pool = ?").run(pool);
      assert.equal(app.store.interpretationPool(pool), null);
      if (route === "automatic") {
        app.dialogue.send(mira.id, "I sailed today.");
        await waitFor(() => app.contemplation.status(pool).lastCycle?.status === "succeeded", { message: "cycle" });
      } else {
        configure(app, mira.id, { contemplationEnabled: false });
        app.store.db.prepare("DELETE FROM interpretation_pools WHERE pool = ?").run(pool);
        app.contemplation.force(pool, "experimentation", mira.id);
      }
      await app.contemplation.idle(pool);
      assert.ok(app.store.interpretationPool(pool), `${route}: the pool exists again`);
      if (route === "automatic") assert.deepEqual(app.store.interpretations(pool).map((entry) => entry.text), ["A ferry pilot."]);
      else assert.equal(app.contemplation.status(pool).force.experimentation.last.status, "completed");
      assert.deepEqual(app.store.experiments(pool).map((entry) => entry.text), ["Ask about boats."]);
    }
    assert.ok(mock.byPurpose("contemplation_generation").length >= 1);
  } finally { closeApp(app); }
});

test("R2/22: every application guard runs inside its transaction and rejects a result computed from older state", async () => {
  const { app } = await makeApp({});
  try {
    const mira = app.createCharacter(base);
    const pool = poolOf(mira);
    configure(app, mira.id, { contemplationEnabled: false });
    const apply = new ContemplationApply({ store: app.store });
    const id = app.contemplation.addInterpretation(pool, "A beekeeper.");
    const revision = app.store.ensureInterpretationPool(pool).interpretationRevision;
    const profile = { characterId: mira.id, name: "Mira" };
    // Guards are evaluated inside Store.tx: a write committed between reading and applying is detected.
    const inTx = [];
    const tx = app.store.tx.bind(app.store);
    app.store.tx = (fn) => tx(() => { inTx.push(true); return fn(); });
    app.contemplation.editInterpretation(pool, id, "A beekeeper who sells candles.");
    assert.equal(apply.insertGenerated(pool, "A sailor.", revision, profile), null);
    assert.equal(apply.commitGestalt(pool, "Old gestalt.", revision), false);
    const state = app.store.ensureInterpretationPool(pool);
    assert.equal(apply.applyPlanning(pool, { experiments: [{ id: null, text: "x" }], interpretationRevision: revision, experimentRevision: state.experimentRevision }), false);
    assert.equal(app.store.interpretations(pool).length, 1);
    assert.equal(app.store.ensureInterpretationPool(pool).gestalt, null);
    assert.deepEqual(app.store.experiments(pool), []);
    assert.ok(inTx.length >= 4);
    // The current revision is accepted.
    assert.notEqual(apply.insertGenerated(pool, "A sailor.", state.interpretationRevision, profile), null);
  } finally { closeApp(app); }
});

// ---- S ----------------------------------------------------------------------------------------------------------

const hash = (text) => crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
const P = contemplationPrompts;
const IMAGED = [P.consolidationSystemPrompt, P.maintenanceSystemPrompt, P.generationSystemPrompt, P.generationReviewSystemPrompt, P.gestaltizationSystemPrompt];

test("S1/S2/acc 1, 2, 8: every S-scoped prompt defines an interpretation as a pregnant possible-person image, not a chronicle", () => {
  for (const prompt of IMAGED.map((fn) => fn())) {
    assert.match(prompt, /one pregnant image of a possible person/);
    assert.match(prompt, /motives, dispositions, relationships, formative history, circumstances and inner conflicts illuminate one another/);
    assert.match(prompt, /not a list of traits, not a recap of the conversation, and not a claim to verify/);
    assert.match(prompt, /Completeness belongs to each interpretation; incompleteness belongs to the pool/);
    assert.match(prompt, /may invent unverified concrete details \(biography, relationships/);
    assert.match(prompt, /Unverified is not disproved/);
    assert.match(prompt, /Absence of evidence is not a conflict/);
    assert.match(prompt, /do not hedge each sentence with maybe, perhaps or probably/);
    assert.match(prompt, /none of its invented details is ever a verified fact/);
    assert.match(prompt, /never contains retellings, timelines, replayed dialogue .*quotes, lists of evidence, sources .*experiment ids, experiment statuses, completed tests or plans for future tests; maintenance notes, update history, confidence bookkeeping or audit trails/);
    assert.match(prompt, /describe the motive and its role in the person, not the episode as proof/);
    // S1 length rule: no new target length, checklist, score or minimum.
    assert.match(prompt, /no target length and no checklist/);
    assert.doesNotMatch(prompt, /confidence (score|field)|minimum number of|at least \d+ (details|facts)/i);
  }
});

test("S3/acc 1-3: Generation asks for a different possible person; its review accepts invention and rejects only direct contradiction", () => {
  const generation = P.generationSystemPrompt();
  assert.match(generation, /a coherent, genuinely different possible person who the user could be/);
  assert.match(generation, /not another commentary on the latest interaction/);
  assert.match(generation, /fill unknowns imaginatively with concrete, internally fitting details/);
  assert.match(generation, /Prefer differences in underlying motives, causal structure, relationships, experiences or life circumstances over synonyms, one extra trait, a small change of temperament, or a different retelling/);
  assert.match(generation, /without argumentation, quotes, chronology or experiment proposals/);
  assert.match(generation, /decline/);
  const review = P.generationReviewSystemPrompt();
  assert.match(review, /Judge two things only/);
  assert.match(review, /materially different possible person/);
  assert.match(review, /Invented, unverified detail is not a problem: do not ask for evidential support/);
  assert.match(review, /Reject only a direct contradiction with what was observed/);
  assert.doesNotMatch(review, /established facts in the evidence contradict/);
});

test("S4/acc 6, 7: Consolidation merges the same person and explanatory logic, keeps different people, and is neither truth-checking nor generation", () => {
  const prompt = P.consolidationSystemPrompt();
  assert.match(prompt, /depict substantially the same person with the same explanatory logic, even when their examples, wording or the observed episodes they mention differ/);
  assert.match(prompt, /Keep the coherent, distinctive, compatible details of every merged source in the surviving image/);
  assert.match(prompt, /Shared incidents, similar predictions of behavior or overlapping facts are not by themselves reasons to merge/);
  assert.match(prompt, /Never average incompatible people into one compromise/);
  assert.match(prompt, /NOT verification and NOT generation/);
  assert.match(prompt, /Account for every supplied id exactly once/);
});

test("S5/acc 4, 5: Maintenance asks whether the imagined person could still be the user, keeps compatible invention, repairs without logs", () => {
  const prompt = P.maintenanceSystemPrompt();
  assert.match(prompt, /could this imagined person still be the user who was observed\?/);
  assert.match(prompt, /compatibility, not of proof/);
  assert.match(prompt, /right answer for unconfirmed but compatible imagined detail; never delete it, add caveats to it, or narrow it for lack of support/);
  assert.match(prompt, /Amend the image so that its inner logic still holds; do not append the contradicting event, a footnote, a disclaimer, an experiment outcome or an update note/);
  assert.match(prompt, /a direct contradiction destroys its defining logic/);
  assert.match(prompt, /Lack of proof is never a reason to delete/);
  assert.match(prompt, /that list is the only record of completion/);
  assert.match(prompt, /never write the experiment, its id, its outcome, or the fact that something was tested into the text/);
  // Specification 0000 section 5.2's "fold what was learned" is narrowed by S2/S5: the image changes, no record is kept.
  assert.doesNotMatch(prompt, /fold what was learned/);
  // The response structure is unchanged: unchanged / replace / delete with completedExperimentIds.
  assert.match(prompt, /"action": "unchanged"\|"replace"\|"delete", "text": <revised prose for replace, otherwise null>, "completedExperimentIds"/);
});

test("S6/acc 10, 11: the gestalt holds unresolved people and never promotes invented biography; Dialogue never asserts it as fact", () => {
  const gestalt = P.gestaltizationSystemPrompt();
  assert.match(gestalt, /Each interpretation is complete as one possible person; how they relate to one another, and their incompatibilities, remain unresolved/);
  assert.match(gestalt, /carry such details as possibilities belonging to their readings, but never promote them to established biography or present them as observed truth/);
  assert.match(gestalt, /Do not force a resolution, choose a winner, rank the interpretations, or average them/);
  const replies = Object.values(golden).flatMap((scenario) => scenario.trace).filter((call) => call.purpose === "dialogue_reply" && /YOUR IMPRESSION OF THE USER/.test(call.body.messages[0].content));
  assert.ok(replies.length >= 2);
  for (const call of replies) {
    assert.match(call.body.messages[0].content, /imagined possibilities, not things you know: you may let them inform your sensitivity or play, but never state them to the user as established facts about them/);
  }
  // Dialogue still receives the gestalt, never raw interpretations.
  const imageReply = golden.imageTurn.trace.find((call) => call.purpose === "dialogue_reply");
  assert.match(JSON.stringify(imageReply.body), /A collector, perhaps\./);
  for (const scenario of ["automaticCycle", "imageTurn"]) {
    for (const call of golden[scenario].trace.filter((entry) => entry.purpose === "dialogue_reply")) {
      assert.doesNotMatch(JSON.stringify(call.body), /A collector of lost things\.|lighthouse keeper/);
    }
  }
});

test("S7/acc 12: Prefetch, Experiment Planning, memory, Vision and repair prompts are byte-identical to the baseline", () => {
  assert.deepEqual({
    prefetch: hash(P.prefetchSystemPrompt()), planning: hash(P.experimentPlanningSystemPrompt()),
    dialogueRetrieval: hash(memoryPrompts.retrievalSystemPrompt(memoryPrompts.DIALOGUE_RETRIEVAL_PURPOSE)),
    contemplationRetrieval: hash(memoryPrompts.retrievalSystemPrompt(memoryPrompts.CONTEMPLATION_RETRIEVAL_PURPOSE)),
    stm: hash(memoryPrompts.stmSystemPrompt("Mira")), ltmSelection: hash(memoryPrompts.ltmSelectionSystemPrompt()), ltm: hash(memoryPrompts.ltmSystemPrompt()),
    vision: hash(visionPrompts.visionSystemPrompt("Mira")), repair: hash(repairPrompts.REPAIR_INSTRUCTION), truncation: hash(repairPrompts.TRUNCATION_RECOVERY_INSTRUCTION),
    dialogueRepair: hash(repairPrompts.DIALOGUE_REPAIR_INSTRUCTION)
  }, {
    prefetch: "d9878ad66d834358", planning: "65dc6139598c8f91", dialogueRetrieval: "6d146b6fc7a601db", contemplationRetrieval: "47dbf6b960113b94", stm: "c0eaf659457b0bdb",
    ltmSelection: "0769c338f04e1a82", ltm: "3fe2cf40fce7210a", vision: "dfa5e7f26306eb5c", repair: "47b094b4374158b9", truncation: "50e5db30bcce6aea", dialogueRepair: "c0f010856de5e805"
  });
});

test("S1/acc 9: the 4,000-character hard limit is unchanged for generation, maintenance and consolidation", () => {
  const at = "x".repeat(P.INTERPRETATION_MAX_CHARS);
  const over = `${at}x`;
  assert.equal(P.INTERPRETATION_MAX_CHARS, 4000);
  assert.equal(validateGeneration({ decision: "add", text: at }).ok, true);
  assert.equal(validateGeneration({ decision: "add", text: over }).ok, false);
  assert.equal(validateMaintenance({ action: "replace", text: at, completedExperimentIds: [] }, new Set()).ok, true);
  assert.equal(validateMaintenance({ action: "replace", text: over, completedExperimentIds: [] }, new Set()).ok, false);
  assert.equal(validateConsolidation({ interpretations: [{ id: "int_1", sourceIds: ["int_1"], text: over }] }, ["int_1"]).ok, false);
});

test("S3-S5/acc 3-7 (mocked): invented images survive review and Maintenance; equivalent images merge, distinct ones survive", async () => {
  const invented = "A former ferry pilot who left the sea after a storm took her brother; she collects tickets because each one proves someone arrived.";
  const { app, mock } = await makeApp({
    contemplation_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    contemplation_generation: () => ({ decision: "add", text: invented }),
    contemplation_generation_review: () => ({ accept: true, problem: null }),
    contemplation_consolidation: (body) => {
      const [a, b, c] = JSON.parse(body.messages[1].content).interpretations;
      return { interpretations: [{ id: a.id, sourceIds: [a.id, b.id], text: a.text }, { id: c.id, sourceIds: [c.id], text: c.text }] };
    },
    contemplation_maintenance: () => ({ action: "unchanged", text: null, completedExperimentIds: [] }),
    contemplation_gestaltization: () => ({ gestalt: "Several possible people." }),
    contemplation_experiment_planning: () => ({ experiments: [] })
  });
  try {
    const mira = app.createCharacter(base);
    const pool = poolOf(mira);
    configure(app, mira.id, { contemplationEnabled: false });
    app.contemplation.addInterpretation(pool, "A night nurse who talks to strangers to stay awake.");
    app.contemplation.addInterpretation(pool, "Someone on night shifts who chats to keep from sleeping.");
    app.contemplation.force(pool, "generation", mira.id);
    await app.contemplation.idle(pool);
    assert.equal(app.store.interpretations(pool).at(-1).text, invented, "an unverified imagined history is stored as written");
    assert.equal(JSON.parse(mock.byPurpose("contemplation_generation_review")[0].body.messages[1].content).candidate, invented);
    app.contemplation.force(pool, "maintenance", mira.id);
    await app.contemplation.idle(pool);
    assert.deepEqual(app.store.interpretations(pool).map((entry) => entry.text), ["A night nurse who talks to strangers to stay awake.", invented],
      "the merged duplicate is gone; the distinct invented person is kept unchanged");
    assert.equal(app.store.ensureInterpretationPool(pool).lastMaintenance.status, "applied");
  } finally { closeApp(app); }
});

test("S2/acc 13: stored interpretations are untouched on startup; no automatic rewrite or migration runs", async () => {
  const dataDir = tempDir();
  const legacy = "Timeline: on Monday the user said X; on Tuesday Y. Evidence: quote 1, quote 2. Experiment exp_3 completed.";
  let { app, mock } = await makeApp({}, { dataDir });
  const mira = app.createCharacter(base);
  const pool = poolOf(mira);
  configure(app, mira.id, { contemplationEnabled: false });
  app.contemplation.addInterpretation(pool, legacy);
  const revision = app.store.ensureInterpretationPool(pool).interpretationRevision;
  closeApp(app);
  ({ app, mock } = await makeApp({}, { dataDir }));
  try {
    assert.deepEqual(app.store.interpretations(pool).map((entry) => entry.text), [legacy]);
    assert.equal(app.store.ensureInterpretationPool(pool).interpretationRevision, revision);
    assert.equal(mock.calls.length, 0);
  } finally { closeApp(app); }
});
