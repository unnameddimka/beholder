// Specification 0002: gestaltization, the gestalt in Dialogue, the read-only Contemplation page, Baidu exclusion.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeApp, closeApp, waitFor, reply, tempDir, completion, ROOT, TEST_KEY, identityConsolidation, configure, configOf } from "./helpers.js";
import { poolOf, poolOwnerId, MIGRATIONS } from "../src/db.js";
import { PROVIDER_IGNORE } from "../src/openrouter.js";
import { PURPOSE_ROLES } from "../src/llm.js";
import { gestaltizationSystemPrompt } from "../src/prompts/contemplation.js";

const base = { name: "Mira", description: "Keeper." };
const quietPrefetch = () => ({ generation: false, maintenance: false });
const payloadOf = (call) => JSON.parse(call.body.messages[1].content);

// Seeds interpretations with Contemplation off, so no pipeline runs, then clears the pending experiment review.
function seedPool(app, pool, texts) {
  const owner = poolOwnerId(pool);
  configure(app, owner, { contemplationEnabled: false });
  for (const text of texts) app.contemplation.addInterpretation(pool, text);
  app.store.setPlanningNeeded(pool, false);
  configure(app, owner, { contemplationEnabled: true });
}

test("migration: a schema-1 database keeps its data, gains an empty gestalt, and synthesizes it once the key is entered", async () => {
  const dataDir = tempDir();
  const db = new DatabaseSync(path.join(dataDir, "beholder.sqlite"));
  db.exec(MIGRATIONS[0]);
  db.exec("PRAGMA user_version = 1");
  const at = "2026-10-01T10:00:00.000Z";
  db.prepare("INSERT INTO characters (name, description, use_shared_memory, use_shared_interpretations, created_at, updated_at) VALUES ('Mira', 'Keeper.', 0, 0, ?, ?)").run(at, at);
  db.prepare("INSERT INTO messages (character_id, role, kind, text, created_at) VALUES (1, 'user', 'user', 'hello', ?)").run(at);
  db.prepare("INSERT INTO interpretation_pools (pool, interpretation_revision, experiment_revision, planning_needed) VALUES ('character:1', 4, 2, 0)").run();
  db.prepare("INSERT INTO interpretations (pool, text, origin, created_at, updated_at) VALUES ('character:1', 'Old interpretation.', '{}', ?, ?)").run(at, at);
  db.prepare("INSERT INTO experiments (pool, text, created_at, updated_at) VALUES ('character:1', 'Old experiment.', ?, ?)").run(at, at);
  db.prepare("INSERT INTO memory_records (pool, tier, topic, summary, importance, sources, created_at, updated_at) VALUES ('character:1', 'ltm', 'T', 'S', 0.5, '[]', ?, ?)").run(at, at);
  db.prepare("INSERT INTO contemplation_watermarks (pool, character_id, last_user_message_id, updated_at) VALUES ('character:1', 1, 1, ?)").run(at);
  db.close();

  const { app, mock } = await makeApp({ contemplation_gestaltization: () => ({ gestalt: "One person, seen from one old angle." }) }, { dataDir, key: false });
  try {
    assert.equal(app.store.schemaVersion(), MIGRATIONS.length);
    assert.equal(app.store.listCharacters().length, 1);
    assert.equal(app.store.messageCount(1), 1);
    assert.equal(app.store.experiments("character:1").length, 1);
    assert.equal(app.store.memoryRecords("character:1").length, 1);
    const before = app.store.ensureInterpretationPool("character:1");
    assert.equal(before.gestalt, null);
    assert.equal(before.interpretationRevision, 4);
    assert.equal(app.contemplation.gestaltView("character:1").status, "pending");
    assert.equal(mock.byPurpose("contemplation_gestaltization").length, 0, "nothing runs without the key");
    await app.setApiKey(TEST_KEY);
    await waitFor(() => app.store.ensureInterpretationPool("character:1").gestalt, { message: "initial synthesis" });
    await app.contemplation.idle("character:1");
    const after = app.store.ensureInterpretationPool("character:1");
    assert.equal(after.gestalt, "One person, seen from one old angle.");
    assert.equal(after.gestaltRevision, 4);
    assert.equal(mock.byPurpose("contemplation_gestaltization").length, 1);
    assert.deepEqual(payloadOf(mock.byPurpose("contemplation_gestaltization")[0]).interpretations.map((entry) => entry.text), ["Old interpretation."]);
  } finally { closeApp(app); }
});

test("prompt carries the section 1 semantics; input is every interpretation plus the previous gestalt, nothing else", async () => {
  const prompt = gestaltizationSystemPrompt();
  for (const phrase of [/one whole, ultimately unknown and inexhaustible person/, /key points of every current interpretation/, /coexist/, /choose a winner/,
    /historical perspective, not evidence/, /diagnosis/, /not a plan to influence the user/, /Do not invent biographical facts/, /If interpretations is empty/]) {
    assert.match(prompt, phrase);
  }
  const { app, mock } = await makeApp({ contemplation_prefetch: quietPrefetch, contemplation_gestaltization: (body, { count }) => ({ gestalt: `Gestalt ${count}` }),
    contemplation_experiment_planning: () => ({ experiments: [] }) });
  try {
    const mira = app.createCharacter(base);
    const pool = poolOf(mira);
    seedPool(app, pool, ["Seeks closeness.", "Studies the experience of closeness.", "Hides behind humor."]);
    app.store.insertMemory({ pool, tier: "ltm", topic: "MEMORY-TOPIC", summary: "MEMORY-SUMMARY", retrievalBrief: "x", importance: 0.5, sources: [] });
    app.contemplation.addExperiment(pool, "EXPERIMENT-TEXT");
    app.store.addMessage({ characterId: mira.id, role: "user", kind: "user", text: "CHAT-TEXT" });
    app.contemplation.recover();
    await waitFor(() => mock.byPurpose("contemplation_gestaltization").length === 1);
    await app.contemplation.idle(pool);
    const first = payloadOf(mock.byPurpose("contemplation_gestaltization").at(-1));
    assert.deepEqual(first.interpretations.map((entry) => entry.text), ["Seeks closeness.", "Studies the experience of closeness.", "Hides behind humor."]);
    assert.equal(first.previousGestalt, null);
    const serialized = JSON.stringify(mock.byPurpose("contemplation_gestaltization").map((call) => call.body));
    assert.doesNotMatch(serialized, /MEMORY-TOPIC|MEMORY-SUMMARY|EXPERIMENT-TEXT|CHAT-TEXT/);
    const firstGestalt = app.store.ensureInterpretationPool(pool).gestalt;

    // Revision: an interpretation is revised and one deleted; the model sees the previous gestalt and all current ones.
    const [a, , c] = app.store.interpretations(pool);
    app.contemplation.editInterpretation(pool, a.id, "Seeks closeness, perhaps only on their own terms.");
    app.contemplation.deleteInterpretation(pool, c.id);
    await waitFor(() => mock.byPurpose("contemplation_gestaltization").length === 2);
    await app.contemplation.idle(pool);
    const second = payloadOf(mock.byPurpose("contemplation_gestaltization").at(-1));
    assert.equal(second.previousGestalt.text, firstGestalt);
    assert.deepEqual(second.interpretations.map((entry) => entry.text), ["Seeks closeness, perhaps only on their own terms.", "Studies the experience of closeness."]);
    const state = app.store.ensureInterpretationPool(pool);
    assert.equal(state.gestalt, "Gestalt 2");
    assert.equal(state.gestaltRevision, state.interpretationRevision);
    assert.equal(app.contemplation.gestaltView(pool).status, "current");
  } finally { closeApp(app); }
});

test("an empty pool has no gestalt; a pool that becomes empty reconsiders its previous gestalt", async () => {
  const { app, mock } = await makeApp({
    contemplation_prefetch: quietPrefetch,
    contemplation_gestaltization: (body) => ({ gestalt: payloadOf({ body }).interpretations.length ? "Several readings." : "Still unknown." }),
    contemplation_experiment_planning: () => ({ experiments: [] }),
    dialogue_reply: () => reply("ok")
  });
  try {
    const mira = app.createCharacter(base);
    const pool = poolOf(mira);
    app.dialogue.send(mira.id, "hello");
    await waitFor(() => app.contemplation.status(pool).lastCycle?.status === "succeeded");
    await app.contemplation.idle(pool);
    assert.equal(mock.byPurpose("contemplation_gestaltization").length, 0);
    assert.equal(app.contemplation.gestaltView(pool).status, "none");

    app.contemplation.addInterpretation(pool, "A reading.");
    await waitFor(() => app.store.ensureInterpretationPool(pool).gestalt === "Several readings.");
    app.contemplation.deleteInterpretation(pool, app.store.interpretations(pool)[0].id);
    await waitFor(() => app.store.ensureInterpretationPool(pool).gestalt === "Still unknown.");
    await app.contemplation.idle(pool);
    const last = payloadOf(mock.byPurpose("contemplation_gestaltization").at(-1));
    assert.deepEqual(last.interpretations, []);
    assert.equal(last.previousGestalt.text, "Several readings.");
  } finally { closeApp(app); }
});

test("one cycle with maintenance and generation synthesizes once, after generation and before planning", async () => {
  let busy = true;
  const { app, mock } = await makeApp({
    contemplation_prefetch: () => ({ generation: busy, maintenance: busy }),
    contemplation_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    contemplation_consolidation: identityConsolidation,
    contemplation_maintenance: (body) => ({ action: "replace", text: `${payloadOf({ body }).interpretation.text} Revised.`, completedExperimentIds: [] }),
    contemplation_generation: () => ({ decision: "add", text: "A new angle." }),
    contemplation_generation_review: () => ({ accept: true, problem: null }),
    contemplation_gestaltization: () => ({ gestalt: "Whole." }),
    contemplation_experiment_planning: () => ({ experiments: [{ id: null, text: "Try something." }] }),
    dialogue_reply: () => reply("ok")
  });
  try {
    const mira = app.createCharacter(base);
    const pool = poolOf(mira);
    seedPool(app, pool, ["One.", "Two."]);
    app.store.setGestalt(pool, "Earlier.", app.store.ensureInterpretationPool(pool).interpretationRevision);
    app.dialogue.send(mira.id, "news");
    await waitFor(() => app.contemplation.status(pool).lastCycle?.status === "succeeded");
    await app.contemplation.idle(pool);
    assert.equal(mock.byPurpose("contemplation_gestaltization").length, 1);
    const payload = payloadOf(mock.byPurpose("contemplation_gestaltization")[0]);
    assert.deepEqual(payload.interpretations.map((entry) => entry.text), ["One. Revised.", "Two. Revised.", "A new angle."]);
    const order = mock.calls.map((call) => call.purpose).filter((purpose) => purpose.startsWith("contemplation_") && !purpose.endsWith("retrieval"));
    assert.deepEqual(order.slice(-3), ["contemplation_generation_review", "contemplation_gestaltization", "contemplation_experiment_planning"]);
    const state = app.store.ensureInterpretationPool(pool);
    assert.equal(state.gestaltRevision, state.interpretationRevision);

    // Experiment-only change and a message that changes no interpretation: no further synthesis.
    app.contemplation.addExperiment(pool, "Manual experiment.");
    mock.calls.length = 0;
    busy = false;
    app.dialogue.send(mira.id, "small talk");
    await waitFor(() => mock.byPurpose("contemplation_prefetch").length === 1);
    await waitFor(() => app.contemplation.status(pool).lastCycle?.status === "succeeded" && app.contemplation.status(pool).cycles === 2);
    await app.contemplation.idle(pool);
    assert.equal(mock.byPurpose("contemplation_gestaltization").length, 0);
  } finally { closeApp(app); }
});

test("race: a gestalt computed for an outdated revision is discarded and the newer revision is synthesized", async () => {
  let pool;
  let edited = false;
  const { app, mock } = await makeApp({
    contemplation_gestaltization: async (body, { count }) => {
      if (!edited) {
        edited = true;
        app.contemplation.editInterpretation(pool, app.store.interpretations(pool)[0].id, "Edited while synthesizing.");
      }
      return { gestalt: `Synthesis ${count} of ${payloadOf({ body }).interpretations[0].text}` };
    },
    contemplation_experiment_planning: () => ({ experiments: [] })
  });
  try {
    const mira = app.createCharacter(base);
    pool = poolOf(mira);
    seedPool(app, pool, ["Original."]);
    app.contemplation.recover();
    await waitFor(() => app.contemplation.gestaltView(pool).status === "current", { message: "current gestalt" });
    await app.contemplation.idle(pool);
    const state = app.store.ensureInterpretationPool(pool);
    assert.equal(state.gestalt, "Synthesis 2 of Edited while synthesizing.");
    assert.equal(state.gestaltRevision, state.interpretationRevision);
    assert.ok(app.diagnostics.events.some((event) => event.type === "contemplation-gestaltization" && event.status === "stale"));
    assert.equal(mock.byPurpose("contemplation_gestaltization").length, 2);
  } finally { closeApp(app); }
});

test("failure keeps the last valid gestalt, does not block planning or dialogue, and retries only at a later opportunity", async () => {
  let failing = true;
  const { app, mock } = await makeApp({
    contemplation_gestaltization: () => failing ? "not json at all {" : { gestalt: "Recovered." },
    contemplation_experiment_planning: () => ({ experiments: [{ id: null, text: "Planned." }] }),
    contemplation_prefetch: quietPrefetch,
    dialogue_reply: () => reply("still talking")
  });
  try {
    const mira = app.createCharacter(base);
    const pool = poolOf(mira);
    seedPool(app, pool, ["One."]);
    app.store.setGestalt(pool, "Valid old gestalt.", app.store.ensureInterpretationPool(pool).interpretationRevision);
    app.contemplation.addInterpretation(pool, "Two.");
    await waitFor(() => app.contemplation.status(pool).lastError?.stage === "contemplation_gestaltization", { message: "gestalt error" });
    await app.contemplation.idle(pool);
    const calls = mock.byPurpose("contemplation_gestaltization").length;
    assert.equal(calls, 3, "one call plus two bounded repairs");
    assert.equal(app.store.ensureInterpretationPool(pool).gestalt, "Valid old gestalt.");
    assert.equal(app.contemplation.gestaltView(pool).status, "pending");
    assert.deepEqual(app.store.experiments(pool).map((entry) => entry.text), ["Planned."]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(mock.byPurpose("contemplation_gestaltization").length, calls, "no retry loop while idle");

    failing = false;
    const message = app.dialogue.send(mira.id, "hello");
    await waitFor(() => app.store.lastMessage(mira.id).id > message.id, { message: "dialogue is not blocked" });
    await waitFor(() => app.store.ensureInterpretationPool(pool).gestalt === "Recovered.", { message: "retry on the next message" });
  } finally { closeApp(app); }
});

test("context limit: an interpretation set that cannot fit is refused without a call and without a partial gestalt", async () => {
  const { app, mock } = await makeApp({ contemplation_gestaltization: () => ({ gestalt: "never" }), contemplation_experiment_planning: () => ({ experiments: [] }) });
  try {
    const mira = app.createCharacter(base);
    const pool = poolOf(mira);
    await app.llm.modelCatalog();
    const model = configOf(app, mira.id).models.contemplation;
    app.llm.catalog.byId.set(model, { id: model, contextLength: 17_000, supportedParameters: null, maxCompletionTokens: null });
    seedPool(app, pool, Array.from({ length: 4 }, (_, index) => `${index} ${"x".repeat(3900)}`));
    app.contemplation.recover();
    await waitFor(() => app.contemplation.status(pool).lastError?.code === "GESTALT_CONTEXT_EXCEEDED", { message: "context error" });
    assert.equal(mock.byPurpose("contemplation_gestaltization").length, 0);
    assert.equal(app.store.ensureInterpretationPool(pool).gestalt, null);
  } finally { closeApp(app); }
});

test("restart: the persisted gestalt survives and an outdated one is updated once Contemplation can run", async () => {
  const dataDir = tempDir();
  let first = await makeApp({ contemplation_gestaltization: () => ({ gestalt: "Before restart." }), contemplation_experiment_planning: () => ({ experiments: [] }) }, { dataDir });
  const mira = first.app.createCharacter(base);
  const pool = poolOf(mira);
  seedPool(first.app, pool, ["One."]);
  first.app.contemplation.recover();
  await waitFor(() => first.app.store.ensureInterpretationPool(pool).gestalt === "Before restart.");
  await first.app.contemplation.idle(pool);
  configure(first.app, mira.id, { contemplationEnabled: false });
  first.app.contemplation.addInterpretation(pool, "Two.");
  closeApp(first.app);

  const { app, mock } = await makeApp({ contemplation_gestaltization: () => ({ gestalt: "After restart." }), contemplation_experiment_planning: () => ({ experiments: [] }) }, { dataDir, key: false });
  try {
    assert.equal(app.store.ensureInterpretationPool(pool).gestalt, "Before restart.");
    assert.equal(app.contemplation.gestaltView(pool).status, "pending");
    await app.setApiKey(TEST_KEY);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(mock.byPurpose("contemplation_gestaltization").length, 0, "disabled: no automatic synthesis");
    configure(app, mira.id, { contemplationEnabled: true });
    app.contemplation.recover();
    await waitFor(() => app.store.ensureInterpretationPool(pool).gestalt === "After restart.");
  } finally { closeApp(app); }
});

test("dialogue: every mode gets the gestalt with its semantics and never interpretation texts; disabled sends neither gestalt nor experiments", async () => {
  const { app, mock } = await makeApp({
    dialogue_reply: () => reply("reply"),
    dialogue_followup: () => reply("follow-up"),
    dialogue_opener: () => reply("opener"),
    contemplation_prefetch: quietPrefetch
  });
  try {
    const mira = app.createCharacter(base);
    const pool = poolOf(mira);
    seedPool(app, pool, ["INTERPRETATION-SECRET"]);
    app.contemplation.addExperiment(pool, "EXPERIMENT-INTENTION");
    app.store.setGestalt(pool, "GESTALT-TEXT one person, many views.", app.store.ensureInterpretationPool(pool).interpretationRevision);
    const message = app.dialogue.send(mira.id, "hi");
    await waitFor(() => app.store.lastMessage(mira.id).id > message.id);
    await app.dialogue.generate(mira.id, "followup");
    await app.dialogue.generate(mira.id, "opener");
    app.store.addMessage({ characterId: mira.id, role: "user", kind: "user", text: "again" });
    app.dialogue.retry(mira.id);
    await waitFor(() => !app.dialogue.chat(mira.id).pending && mock.byPurpose("dialogue_reply").length === 2);
    const bodies = ["dialogue_reply", "dialogue_followup", "dialogue_opener"].flatMap((purpose) => mock.byPurpose(purpose));
    assert.equal(bodies.length, 4);
    for (const call of bodies) {
      const system = call.body.messages[0].content;
      assert.match(system, /YOUR IMPRESSION OF THE USER \(gestalt\)/);
      assert.match(system, /GESTALT-TEXT one person, many views\./);
      assert.match(system, /possible perspectives/);
      assert.match(system, /fundamentally unknown/);
      assert.match(system, /not an experiment script/);
      assert.match(system, /EXPERIMENT-INTENTION/);
      assert.doesNotMatch(JSON.stringify(call.body), /INTERPRETATION-SECRET/);
    }

    configure(app, mira.id, { contemplationEnabled: false });
    await app.dialogue.generate(mira.id, "followup");
    const disabled = mock.byPurpose("dialogue_followup").at(-1).body.messages[0].content;
    assert.doesNotMatch(disabled, /GESTALT-TEXT|EXPERIMENT-INTENTION|gestalt\)/);
    assert.equal(app.store.ensureInterpretationPool(pool).gestalt, "GESTALT-TEXT one person, many views.", "stored state is kept");

    // No gestalt yet: no impression section and no invented portrait.
    configure(app, mira.id, { contemplationEnabled: true });
    const nova = app.createCharacter({ ...base, name: "Nova" });
    await app.dialogue.generate(nova.id, "opener");
    assert.doesNotMatch(mock.byPurpose("dialogue_opener").at(-1).body.messages[0].content, /IMPRESSION OF THE USER/);
  } finally { closeApp(app); }
});

test("ownership: each character's Dialogue gets only its own gestalt and experiments (Specification 0004)", async () => {
  const { app, mock } = await makeApp({ dialogue_opener: () => reply("hello") });
  try {
    const a = app.createCharacter({ ...base, name: "A", useSharedInterpretations: true, config: { contemplationEnabled: false } });
    const b = app.createCharacter({ ...base, name: "B", useSharedInterpretations: true });
    app.store.setGestalt(poolOf(a), "A-GESTALT", 0);
    app.contemplation.addExperiment(poolOf(a), "A-EXPERIMENT");
    configure(app, a.id, { contemplationEnabled: true });
    const systemFor = async (character) => {
      await app.dialogue.generate(character.id, "opener");
      return mock.byPurpose("dialogue_opener").at(-1).body.messages[0].content;
    };
    let system = await systemFor(a);
    assert.match(system, /A-GESTALT/);
    assert.match(system, /A-EXPERIMENT/);
    system = await systemFor(b);
    assert.doesNotMatch(system, /A-GESTALT|A-EXPERIMENT|IMPRESSION OF THE USER/, "a new character starts with empty cognition");
  } finally { closeApp(app); }
});

test("disabled: interpretation changes schedule no synthesis; the page view still shows the stored gestalt", async () => {
  const { app, mock } = await makeApp({});
  try {
    const mira = app.createCharacter(base);
    const pool = poolOf(mira);
    configure(app, mira.id, { contemplationEnabled: false });
    app.store.setGestalt(pool, "Stored.", 0);
    app.contemplation.addInterpretation(pool, "New.");
    app.contemplation.recover();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(mock.byPurpose("contemplation_gestaltization").length, 0);
    const response = await fetch(`${await listen(app)}/api/characters/${mira.id}/contemplation`);
    const view = await response.json();
    assert.equal(view.gestalt.text, "Stored.");
    assert.equal(view.gestalt.status, "pending");
    assert.equal(view.contemplationEnabled, false);
    assert.deepEqual(view.interpretations.map((entry) => entry.text), ["New."]);
  } finally { app.server?.close(); closeApp(app); }
});

async function listen(app) {
  const { createServer } = await import("../src/server.js");
  app.server = createServer(app);
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${app.server.address().port}`;
}

// Specification 0005 F1/F2 supersedes the Force ban: the page may now ask for the three model-driven runs, and only
// through the force route; it still writes no interpretation, experiment or gestalt text.
test("page: the Contemplation view is read-only and its copy matches the new Dialogue boundary", () => {
  const source = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const start = source.indexOf("async function renderContemplation(");
  const page = source.slice(start, source.indexOf("// ---- main loop", start));
  assert.ok(start > 0 && page.length > 100);
  assert.deepEqual([...page.matchAll(/api\(`([^`]*)`, \{ method: "(\w+)"/g)].map((match) => [match[1], match[2]]), [["/api/characters/${characterId}/contemplation/force", "POST"]]);
  assert.doesNotMatch(page, /method:\s*"(PUT|DELETE)"|\/interpretations|\/experiments/);
  assert.doesNotMatch(page, /textarea|"Add"|"Edit"|"Save"|"Delete"/);
  assert.match(page, /Gestalt/);
  assert.match(page, /Not formed yet/);
  assert.match(page, /never the interpretations themselves/);
  assert.doesNotMatch(source, /Only the active experiments reach the dialogue model|Force actions remain/);
  for (const doc of ["README.md", "AGENTS.md"]) {
    const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
    assert.doesNotMatch(text, /Force actions remain/, doc);
  }
});

test("Baidu: every text request, including gestaltization, repair and truncation recovery, ignores baidu and the earlier providers; images are unchanged", async () => {
  assert.deepEqual([...PROVIDER_IGNORE], ["alibaba", "Phala", "SiliconFlow", "GMICloud", "baidu"]);
  let gestaltCalls = 0;
  const { app, mock } = await makeApp({
    contemplation_prefetch: () => ({ generation: true, maintenance: false }),
    contemplation_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    contemplation_generation: () => ({ decision: "add", text: "Angle." }),
    contemplation_generation_review: () => ({ accept: true, problem: null }),
    contemplation_gestaltization: () => {
      gestaltCalls += 1;
      if (gestaltCalls === 1) return completion("{\"gestalt\": \"cut", { finishReason: "length" });
      if (gestaltCalls === 2) return "{ broken";
      return { gestalt: "Whole." };
    },
    contemplation_experiment_planning: () => ({ experiments: [] }),
    dialogue_reply: (body, { count }) => count === 1 ? "{\"message\": " : reply("ok")
  });
  try {
    const mira = app.createCharacter(base);
    const pool = poolOf(mira);
    app.dialogue.send(mira.id, "hello");
    await waitFor(() => app.store.ensureInterpretationPool(pool).gestalt === "Whole.", { message: "gestalt" });
    await app.contemplation.idle(pool);
    await waitFor(() => !app.dialogue.chat(mira.id).pending);
    assert.ok(mock.byPurpose("dialogue_reply").length >= 2, "dialogue repair happened");
    assert.equal(gestaltCalls, 3, "truncation retry and repair happened");
    for (const call of mock.calls) {
      assert.deepEqual(call.body.provider.ignore, ["alibaba", "Phala", "SiliconFlow", "GMICloud", "baidu"], call.purpose);
      assert.equal(call.body.provider.allow_fallbacks, true);
      assert.equal(call.body.model, app.llm.requestParameters(PURPOSE_ROLES[call.purpose], configOf(app, mira.id)).model, "the selected model is kept");
    }
    const imagesSource = fs.readFileSync(path.join(ROOT, "src", "images.js"), "utf8");
    assert.doesNotMatch(imagesSource, /PROVIDER_IGNORE|baidu/);
  } finally { closeApp(app); }
});
