import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, closeApp } from "./helpers.js";
import { characterPool, poolOf } from "../src/db.js";

// Specification 0004 P1/P3: each character owns one memory pool and one interpretation pool; the legacy scope flags
// are neither required nor able to select any other pool.
test("every character owns its own pool; legacy scope fields are ignored on create and update", async () => {
  const { app } = await makeApp({});
  try {
    const combos = [[false, false], [true, false], [false, true], [true, true]];
    for (const [useSharedMemory, useSharedInterpretations] of combos) {
      const character = app.createCharacter({ name: `C${useSharedMemory}${useSharedInterpretations}`, description: "", useSharedMemory, useSharedInterpretations });
      assert.equal(poolOf(character), characterPool(character.id));
      assert.deepEqual(Object.keys(character).sort(), ["createdAt", "description", "id", "name", "updatedAt"]);
      const updated = app.updateCharacter(character.id, { name: "Renamed", description: "d", useSharedMemory: true, useSharedInterpretations: true });
      assert.equal(poolOf(updated), characterPool(character.id));
    }
    assert.deepEqual(app.store.memoryPools().map((row) => row.pool).sort(), app.store.listCharacters().map((c) => characterPool(c.id)).sort());
    assert.deepEqual(app.store.interpretationPools().map((row) => row.pool).sort(), app.store.listCharacters().map((c) => characterPool(c.id)).sort());
  } finally { closeApp(app); }
});

test("pools of different characters stay separate", async () => {
  const { app } = await makeApp({ contemplation_experiment_planning: () => ({ experiments: [] }) });
  try {
    app.settings.update({ contemplationEnabled: false });
    const a = app.createCharacter({ name: "A", description: "" });
    const b = app.createCharacter({ name: "B", description: "" });
    app.contemplation.addInterpretation(poolOf(a), "about A's chat");
    app.store.insertMemory({ pool: poolOf(a), tier: "ltm", topic: "A memory", summary: "s", retrievalBrief: "", importance: 0.5, sources: [] });
    assert.deepEqual(app.store.interpretations(poolOf(b)), []);
    assert.deepEqual(app.store.memoryRecords(poolOf(b)), []);
    assert.deepEqual(app.store.interpretations(poolOf(a)).map((entry) => entry.text), ["about A's chat"]);
  } finally { closeApp(app); }
});

test("character validation rejects bad input", async () => {
  const { app } = await makeApp({});
  try {
    assert.throws(() => app.createCharacter({ name: "", description: "" }));
    assert.throws(() => app.createCharacter({ name: "X".repeat(101), description: "" }));
    assert.throws(() => app.createCharacter({ name: "X", description: "Y".repeat(20_001) }));
  } finally { closeApp(app); }
});
