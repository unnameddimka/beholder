import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, closeApp, waitFor, reply, seedMessages, sleep } from "./helpers.js";
import { interpretationPoolOf, SHARED_POOL } from "../src/db.js";
import { validatePrefetch, validatePlanning } from "../src/contemplation.js";

const base = { name: "Mira", description: "Keeper.", useSharedMemory: false, useSharedInterpretations: false };

test("prefetch receives exactly the whole interpretation pool and the last 100 verbatim messages, no memory", async () => {
  const { app, mock } = await makeApp({
    contemplation_prefetch: () => ({ generation: false, maintenance: false }),
    dialogue_reply: () => reply("ok"),
    dialogue_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    memory_stm_consolidation: () => ({ shortTermMemoriesToUpsert: [], shortTermMemoriesToAdd: [], stmRepartitions: [] })
  });
  try {
    const mira = app.createCharacter(base);
    const pool = interpretationPoolOf(mira);
    app.settings.update({ contemplationEnabled: false });
    app.contemplation.addInterpretation(pool, "Interpretation A");
    app.contemplation.addInterpretation(pool, "Interpretation B");
    app.store.insertMemory({ pool: `character:${mira.id}`, tier: "ltm", topic: "MEMORY-TOPIC", summary: "MEMORY-SUMMARY", retrievalBrief: "x", importance: 0.5, sources: [] });
    seedMessages(app, mira.id, 120);
    app.settings.update({ contemplationEnabled: true });
    app.dialogue.send(mira.id, "newest user message");
    await waitFor(() => mock.byPurpose("contemplation_prefetch").length === 1);
    await app.contemplation.idle(pool);
    const payload = JSON.parse(mock.byPurpose("contemplation_prefetch")[0].body.messages[1].content);
    assert.deepEqual(payload.interpretations.map((entry) => entry.text), ["Interpretation A", "Interpretation B"]);
    assert.equal(payload.conversation.messages.length, 100);
    assert.equal(payload.conversation.messages.at(-1).text, "newest user message");
    assert.doesNotMatch(JSON.stringify(mock.byPurpose("contemplation_prefetch")[0].body), /MEMORY-TOPIC|MEMORY-SUMMARY/);
    assert.equal(app.store.watermark(pool, mira.id), app.store.lastUserMessageId(mira.id));
  } finally { closeApp(app); }
});

test("prefetch flags are validated independently", () => {
  assert.equal(validatePrefetch({ generation: true, maintenance: false }).ok, true);
  assert.equal(validatePrefetch({ generation: "yes", maintenance: false }).ok, false);
  assert.equal(validatePrefetch({ generation: true }).ok, false);
  assert.equal(validatePrefetch({ generation: true, maintenance: true, why: "x" }).ok, false);
});

test("both flags: parallel maintenance per interpretation, generation sees the post-maintenance pool, one experiment review at the end", async () => {
  let inFlight = 0;
  let peak = 0;
  const order = [];
  const { app, mock } = await makeApp({
    contemplation_prefetch: () => { order.push("prefetch"); return { generation: true, maintenance: true }; },
    contemplation_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    contemplation_maintenance: async (body) => {
      order.push("maintenance");
      inFlight += 1; peak = Math.max(peak, inFlight);
      await sleep(30);
      inFlight -= 1;
      const payload = JSON.parse(body.messages[1].content);
      if (payload.interpretation.text === "Old A") return { action: "replace", text: "Revised A", completedExperimentIds: [] };
      if (payload.interpretation.text === "Old B") return { action: "delete", text: null, completedExperimentIds: [payload.activeExperiments[0].id] };
      return { action: "unchanged", text: null, completedExperimentIds: [] };
    },
    contemplation_generation: (body) => {
      order.push("generation");
      const payload = JSON.parse(body.messages[1].content);
      assert.deepEqual(payload.interpretations.map((entry) => entry.text).sort(), ["Old C", "Revised A"]);
      return { decision: "add", text: "A brand new angle" };
    },
    contemplation_generation_review: () => ({ accept: true, problem: null }),
    contemplation_experiment_planning: (body) => {
      order.push("planning");
      const payload = JSON.parse(body.messages[1].content);
      assert.deepEqual(Object.keys(payload).sort(), ["activeExperiments", "interpretations", "requiredResponseShape"]);
      assert.deepEqual(payload.interpretations.map((entry) => entry.text).sort(), ["A brand new angle", "Old C", "Revised A"]);
      assert.deepEqual(payload.activeExperiments.map((entry) => entry.text), ["Keep me"]);
      return { experiments: [{ id: payload.activeExperiments[0].id, text: "Keep me (edited)" }, { id: null, text: "Contrast A with the new angle" }] };
    },
    dialogue_reply: () => reply("ok")
  });
  try {
    const mira = app.createCharacter(base);
    const pool = interpretationPoolOf(mira);
    app.settings.update({ contemplationEnabled: false });
    for (const text of ["Old A", "Old B", "Old C"]) app.contemplation.addInterpretation(pool, text);
    app.contemplation.addExperiment(pool, "Finished probe");
    app.contemplation.addExperiment(pool, "Keep me");
    app.store.setPlanningNeeded(pool, false);
    app.settings.update({ contemplationEnabled: true });
    app.dialogue.send(mira.id, "evidence");
    await waitFor(() => order.includes("planning"));
    await app.contemplation.idle(pool);
    assert.equal(peak, 3, "every interpretation is maintained by its own concurrent request");
    assert.deepEqual(order, ["prefetch", "maintenance", "maintenance", "maintenance", "generation", "planning"]);
    assert.deepEqual(app.store.interpretations(pool).map((entry) => entry.text).sort(), ["A brand new angle", "Old C", "Revised A"]);
    assert.deepEqual(app.store.experiments(pool).map((entry) => entry.text), ["Keep me (edited)", "Contrast A with the new angle"]);
    assert.equal(app.store.ensureInterpretationPool(pool).planningNeeded, false);
    assert.equal(mock.byPurpose("contemplation_experiment_planning").length, 1);
  } finally { closeApp(app); }
});

test("a failed maintenance request applies nothing from the batch", async () => {
  const { app } = await makeApp({
    contemplation_prefetch: () => ({ generation: false, maintenance: true }),
    contemplation_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    contemplation_maintenance: (body) => JSON.parse(body.messages[1].content).interpretation.text === "One" ? { action: "replace", text: "Changed", completedExperimentIds: [] } : "not json at all",
    dialogue_reply: () => reply("ok")
  });
  try {
    const mira = app.createCharacter(base);
    const pool = interpretationPoolOf(mira);
    app.settings.update({ contemplationEnabled: false });
    app.contemplation.addInterpretation(pool, "One");
    app.contemplation.addInterpretation(pool, "Two");
    app.settings.update({ contemplationEnabled: true });
    app.dialogue.send(mira.id, "evidence");
    await waitFor(() => app.contemplation.status(pool).lastCycle?.status === "failed");
    assert.deepEqual(app.store.interpretations(pool).map((entry) => entry.text), ["One", "Two"]);
    assert.equal(app.store.watermark(pool, mira.id), 0, "watermark stays so the evidence is re-evaluated later");
  } finally { closeApp(app); }
});

test("messages during a slow cycle are coalesced into one later cycle covering all new evidence", async () => {
  let release;
  let gate = new Promise((resolve) => { release = resolve; });
  const { app, mock } = await makeApp({
    contemplation_prefetch: async () => { await gate; return { generation: false, maintenance: false }; },
    dialogue_reply: () => reply("ok")
  });
  try {
    const mira = app.createCharacter(base);
    const pool = interpretationPoolOf(mira);
    app.dialogue.send(mira.id, "one");
    await waitFor(() => mock.byPurpose("contemplation_prefetch").length === 1);
    for (const text of ["two", "three", "four"]) {
      await waitFor(() => !app.dialogue.chatState(mira.id).pending);
      app.dialogue.send(mira.id, text);
    }
    await waitFor(() => !app.dialogue.chatState(mira.id).pending);
    const firstGate = release;
    gate = Promise.resolve();
    firstGate();
    await waitFor(() => mock.byPurpose("contemplation_prefetch").length === 2);
    await app.contemplation.idle(pool);
    await sleep(20);
    assert.equal(mock.byPurpose("contemplation_prefetch").length, 2, "three extra messages produce one coalesced cycle");
    const second = JSON.parse(mock.byPurpose("contemplation_prefetch")[1].body.messages[1].content);
    assert.equal(second.conversation.messages.filter((m) => m.speaker === "user").at(-1).text, "four");
    assert.equal(app.store.watermark(pool, mira.id), app.store.lastUserMessageId(mira.id));
  } finally { closeApp(app); }
});

test("a stale experiment-planning result never overwrites a newer experiment revision", async () => {
  let releasePlanning;
  const planningGate = new Promise((resolve) => { releasePlanning = resolve; });
  let calls = 0;
  const { app } = await makeApp({
    contemplation_experiment_planning: async (body) => {
      calls += 1;
      if (calls === 1) { await planningGate; return { experiments: [{ id: null, text: "STALE PLAN" }] }; }
      const payload = JSON.parse(body.messages[1].content);
      return { experiments: payload.activeExperiments.map((entry) => ({ id: entry.id, text: entry.text })) };
    }
  });
  try {
    const mira = app.createCharacter(base);
    const pool = interpretationPoolOf(mira);
    app.contemplation.addInterpretation(pool, "Something");
    await waitFor(() => calls === 1);
    app.contemplation.addExperiment(pool, "Manual experiment added meanwhile");
    releasePlanning();
    await app.contemplation.idle(pool);
    const texts = app.store.experiments(pool).map((entry) => entry.text);
    assert.deepEqual(texts, ["Manual experiment added meanwhile"]);
    assert.equal(calls, 2);
  } finally { closeApp(app); }
});

test("manual experiment edits do not trigger contemplation; interpretation edits trigger exactly one review", async () => {
  const { app, mock } = await makeApp({ contemplation_experiment_planning: (body) => ({ experiments: JSON.parse(body.messages[1].content).activeExperiments }) });
  try {
    const mira = app.createCharacter(base);
    const pool = interpretationPoolOf(mira);
    const id = app.contemplation.addExperiment(pool, "e1");
    app.contemplation.editExperiment(pool, id, "e1 edited");
    await app.contemplation.idle(pool);
    assert.equal(mock.calls.filter((call) => call.purpose.startsWith("contemplation")).length, 0);
    const interpretation = app.contemplation.addInterpretation(pool, "i1");
    app.contemplation.editInterpretation(pool, interpretation, "i1 edited");
    await waitFor(() => mock.byPurpose("contemplation_experiment_planning").length >= 1);
    await app.contemplation.idle(pool);
    assert.equal(mock.byPurpose("contemplation_experiment_planning").length, 1, "two quick edits coalesce into one review");
    assert.deepEqual(app.store.experiments(pool).map((entry) => entry.text), ["e1 edited"]);
  } finally { closeApp(app); }
});

test("generation may decline, and a reviewer rejection leads to one retry then decline", async () => {
  const { app, mock } = await makeApp({
    contemplation_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    contemplation_generation: () => ({ decision: "add", text: "Same as before" }),
    contemplation_generation_review: () => ({ accept: false, problem: "duplicates an existing interpretation" })
  });
  try {
    const mira = app.createCharacter(base);
    const pool = interpretationPoolOf(mira);
    seedMessages(app, mira.id, 4);
    await app.contemplation.force(pool, "generation", mira.id);
    await app.contemplation.idle(pool);
    assert.equal(app.store.interpretations(pool).length, 0);
    assert.equal(mock.byPurpose("contemplation_generation").length, 2);
    const retry = JSON.parse(mock.byPurpose("contemplation_generation")[1].body.messages[1].content);
    assert.equal(retry.previousCandidateRejected.problem, "duplicates an existing interpretation");
  } finally { closeApp(app); }
});

test("shared interpretation pool collects evidence from several chats with attribution", async () => {
  const { app } = await makeApp({
    contemplation_prefetch: () => ({ generation: true, maintenance: false }),
    contemplation_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    contemplation_generation: (body) => ({ decision: "add", text: `From ${JSON.parse(body.messages[1].content).conversation.character}` }),
    contemplation_generation_review: () => ({ accept: true, problem: null }),
    contemplation_experiment_planning: () => ({ experiments: [] }),
    dialogue_reply: () => reply("ok")
  });
  try {
    const a = app.createCharacter({ ...base, name: "Ash", useSharedInterpretations: true });
    const b = app.createCharacter({ ...base, name: "Birch", useSharedInterpretations: true });
    app.dialogue.send(a.id, "hi Ash");
    await waitFor(() => app.store.interpretations(SHARED_POOL).length === 1);
    await app.contemplation.idle(SHARED_POOL);
    app.dialogue.send(b.id, "hi Birch");
    await waitFor(() => app.store.interpretations(SHARED_POOL).length === 2);
    const origins = app.store.interpretations(SHARED_POOL).map((entry) => entry.origin.characterName);
    assert.deepEqual(origins, ["Ash", "Birch"]);
  } finally { closeApp(app); }
});

test("planning validator keeps ids stable and rejects unknown ids", () => {
  const ids = new Set(["exp_1"]);
  assert.equal(validatePlanning({ experiments: [{ id: "exp_1", text: "a" }, { id: null, text: "b" }] }, ids).ok, true);
  assert.equal(validatePlanning({ experiments: [{ id: "exp_9", text: "a" }] }, ids).ok, false);
  assert.equal(validatePlanning({ experiments: [{ id: "exp_1", text: "a" }, { id: "exp_1", text: "b" }] }, ids).ok, false);
});

