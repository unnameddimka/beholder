// Specification 0006: explicit LLM-operation contracts (R1), separated Contemplation responsibilities (R2), and
// pregnant interpretations (S).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, makeApp, closeApp, configure } from "./helpers.js";
import { CONTRACTS, PURPOSE_ROLES as CONTRACT_ROLES, contractOf } from "../src/contracts/index.js";
import { PURPOSE_ROLES } from "../src/llm.js";
import { validateMaintenance, validateConsolidation, validatePlanning } from "../src/contracts/contemplation.js";
import { validateRetrieval } from "../src/memory.js";
import { ContemplationApply } from "../src/contemplation-apply.js";
import { poolOf } from "../src/db.js";
import * as contemplationPrompts from "../src/prompts/contemplation.js";
import * as memoryPrompts from "../src/prompts/memory.js";
import * as dialoguePrompts from "../src/prompts/dialogue.js";
import * as visionPrompts from "../src/prompts/vision.js";

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

test("R2/14: stage execution never writes; orchestration writes only through the application layer", () => {
  const writes = /\.store\.(insert|update|delete|set|bump|add|complete|fail|tx)[A-Za-z]*\(/;
  assert.doesNotMatch(source("src/contemplation-stages.js"), writes);
  assert.doesNotMatch(source("src/contemplation.js"), writes);
  assert.match(source("src/contemplation-apply.js"), /this\.store\.tx\(/);
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
