import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, closeApp } from "./helpers.js";
import { SHARED_POOL, privatePool, memoryPoolOf, interpretationPoolOf } from "../src/db.js";

test("all four scope combinations select independent memory and interpretation pools", async () => {
  const { app } = await makeApp({});
  try {
    const combos = [[false, false], [true, false], [false, true], [true, true]];
    for (const [useSharedMemory, useSharedInterpretations] of combos) {
      const character = app.createCharacter({ name: `C${useSharedMemory}${useSharedInterpretations}`, description: "", useSharedMemory, useSharedInterpretations });
      assert.equal(memoryPoolOf(character), useSharedMemory ? SHARED_POOL : privatePool(character.id));
      assert.equal(interpretationPoolOf(character), useSharedInterpretations ? SHARED_POOL : privatePool(character.id));
    }
  } finally { closeApp(app); }
});

test("switching a flag switches the active pool without merging, cloning, or deleting either pool", async () => {
  const { app } = await makeApp({ contemplation_experiment_planning: () => ({ experiments: [] }) });
  try {
    app.settings.update({ contemplationEnabled: false });
    const a = app.createCharacter({ name: "A", description: "", useSharedMemory: false, useSharedInterpretations: false });
    const b = app.createCharacter({ name: "B", description: "", useSharedMemory: true, useSharedInterpretations: true });
    app.contemplation.addInterpretation(interpretationPoolOf(a), "private to A");
    app.contemplation.addInterpretation(interpretationPoolOf(b), "shared one");
    app.store.insertMemory({ pool: memoryPoolOf(a), tier: "ltm", topic: "A private", summary: "s", retrievalBrief: "", importance: 0.5, sources: [] });
    app.store.insertMemory({ pool: memoryPoolOf(b), tier: "ltm", topic: "shared", summary: "s", retrievalBrief: "", importance: 0.5, sources: [] });

    const switched = app.updateCharacter(a.id, { name: "A", description: "", useSharedMemory: true, useSharedInterpretations: true });
    assert.deepEqual(app.store.interpretations(interpretationPoolOf(switched)).map((entry) => entry.text), ["shared one"]);
    assert.deepEqual(app.store.memoryRecords(memoryPoolOf(switched)).map((entry) => entry.topic), ["shared"]);
    assert.deepEqual(app.store.interpretations(privatePool(a.id)).map((entry) => entry.text), ["private to A"], "private pool is kept intact");

    const back = app.updateCharacter(a.id, { name: "A", description: "", useSharedMemory: false, useSharedInterpretations: true });
    assert.deepEqual(app.store.memoryRecords(memoryPoolOf(back)).map((entry) => entry.topic), ["A private"]);
    assert.deepEqual(app.store.interpretations(interpretationPoolOf(back)).map((entry) => entry.text), ["shared one"]);
    // Shared pool updates are visible to every character that uses it; private pools stay separate.
    app.contemplation.addInterpretation(SHARED_POOL, "added via B");
    assert.equal(app.store.interpretations(interpretationPoolOf(back)).length, 2);
    assert.equal(app.store.interpretations(privatePool(b.id)).length, 0);
  } finally { closeApp(app); }
});

test("character validation rejects bad input", async () => {
  const { app } = await makeApp({});
  try {
    assert.throws(() => app.createCharacter({ name: "", description: "", useSharedMemory: false, useSharedInterpretations: false }));
    assert.throws(() => app.createCharacter({ name: "X", description: "", useSharedMemory: "yes", useSharedInterpretations: false }));
  } finally { closeApp(app); }
});
