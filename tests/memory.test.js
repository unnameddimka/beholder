import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, closeApp, waitFor, seedMessages, tempDir, mockOpenRouter } from "./helpers.js";
import { characterPool } from "../src/db.js";
import { validateStmDraft, validateLtmDraft } from "../src/memory.js";
import { localDateString } from "../src/utils.js";

const base = { name: "Mira", description: "Keeper." };

function stmFromPayload(body) {
  const payload = JSON.parse(body.messages[1].content);
  return { payload, draft: { shortTermMemoriesToUpsert: [], shortTermMemoriesToAdd: [{ topic: "Early chat", summary: "The user said hello many times.", retrievalBrief: "greetings", importance: 0.4, sourceMessageIds: payload.consumedMessageIds.slice(0, 3), contextStmIds: [] }], stmRepartitions: [] } };
}

test("Verbatim -> STM: nothing below 100; at 100 the 20 oldest are consolidated and only then leave the active window", async () => {
  let seen = null;
  const { app, mock } = await makeApp({ memory_stm_consolidation: (body) => { const { payload, draft } = stmFromPayload(body); seen = payload; return draft; } });
  try {
    const mira = app.createCharacter(base);
    const ids = seedMessages(app, mira.id, 99);
    assert.equal(app.memory.maybeConsolidate(mira.id), null);
    ids.push(...seedMessages(app, mira.id, 1, { startRole: "character" }));
    await app.memory.maybeConsolidate(mira.id);
    assert.deepEqual(seen.consumedMessageIds, ids.slice(0, 20).map((id) => `msg_${id}`));
    assert.equal(seen.retainedMessageIds.length, 80);
    assert.equal(app.store.activeCount(mira.id), 80);
    assert.deepEqual(app.store.activeMessages(mira.id).map((m) => m.id), ids.slice(20));
    assert.equal(app.store.transcript(mira.id).length, 100, "visible transcript is never shortened");
    const [record] = app.store.memoryRecords(characterPool(mira.id), "stm");
    assert.equal(record.topic, "Early chat");
    assert.equal(record.sources[0].characterName, "Mira");
    assert.deepEqual(record.sources[0].messageIds, ids.slice(0, 3));
    // Memory consolidation uses the Dialogue model.
    assert.equal(mock.byPurpose("memory_stm_consolidation")[0].body.model, app.settings.get().models.dialogue);
  } finally { closeApp(app); }
});

test("Verbatim -> STM failure preserves every source message in the active window", async () => {
  const { app } = await makeApp({ memory_stm_consolidation: () => "still not json" });
  try {
    const mira = app.createCharacter(base);
    seedMessages(app, mira.id, 100);
    await app.memory.maybeConsolidate(mira.id);
    assert.equal(app.store.activeCount(mira.id), 100);
    assert.equal(app.store.memoryRecords(characterPool(mira.id)).length, 0);
    assert.equal(app.memory.status().stmJobs[0].status, "failed");
  } finally { closeApp(app); }
});

test("STM validator rejects citing retained messages and unknown ids, accepts an empty selective result", () => {
  const frozen = { consumedIds: new Set(["msg_1"]), retainedIds: new Set(["msg_2"]), suppliedStm: new Map() };
  const empty = { shortTermMemoriesToUpsert: [], shortTermMemoriesToAdd: [], stmRepartitions: [] };
  assert.equal(validateStmDraft(empty, frozen).ok, true);
  const add = (ids) => ({ ...empty, shortTermMemoriesToAdd: [{ topic: "t", summary: "s", retrievalBrief: "", importance: 0.5, sourceMessageIds: ids, contextStmIds: [] }] });
  assert.equal(validateStmDraft(add(["msg_1"]), frozen).ok, true);
  assert.equal(validateStmDraft(add(["msg_2"]), frozen).ok, false);
  assert.equal(validateStmDraft(add(["msg_9"]), frozen).ok, false);
});

test("LTM validator requires every consumable STM in exactly one retirement group", () => {
  const record = { id: 1, topic: "t", summary: "s", retrievalBrief: "", importance: 0.5 };
  const frozen = { consumable: new Map([["stm_1", record], ["stm_2", record]]), contextStm: new Map(), selectedLtm: new Map() };
  const add = { ref: "new_ltm_1", topic: "t", summary: "s", retrievalBrief: "", importance: 0.5, sourceStmIds: ["stm_1"], sourceLtmIds: [] };
  const missing = { longTermMemoriesToUpsert: [], longTermMemoriesToAdd: [add], retirementGroups: [{ stmIds: ["stm_1"], disposition: "represented", representedByLtmRefs: ["new_ltm_1"] }] };
  assert.equal(validateLtmDraft(missing, frozen).ok, false);
  const complete = { ...missing, retirementGroups: [...missing.retirementGroups, { stmIds: ["stm_2"], disposition: "safe_to_forget", representedByLtmRefs: [], reason: "routine" }] };
  assert.equal(validateLtmDraft(complete, frozen).ok, true);
});

test("STM -> LTM runs once per server-local date per pool, catches up after a missed midnight, and never double-consolidates", async () => {
  let now = new Date(2026, 9, 30, 15, 0, 0);
  const dataDir = tempDir();
  const handlers = {
    memory_ltm_selection: () => ({ relevantLtmIds: [], contextStmIds: [] }),
    memory_ltm_consolidation: (body) => {
      const payload = JSON.parse(body.messages[1].content);
      const ids = payload.consumableShortTermMemories.map((view) => view.id);
      return { longTermMemoriesToUpsert: [], longTermMemoriesToAdd: [{ ref: "new_ltm_1", topic: "Day summary", summary: "Durable.", retrievalBrief: "day", importance: 0.6, sourceStmIds: ids, sourceLtmIds: [] }],
        retirementGroups: [{ stmIds: ids, disposition: "represented", representedByLtmRefs: ["new_ltm_1"] }] };
    }
  };
  const first = await makeApp(handlers, { dataDir, appOptions: { now: () => now } });
  let { app } = first;
  try {
    const mira = app.createCharacter(base);
    const other = app.createCharacter({ ...base, name: "Oren" });
    assert.equal(app.store.getMeta("lastLtmDate"), localDateString(now));
    app.store.insertMemory({ pool: characterPool(mira.id), tier: "stm", topic: "A", summary: "a", retrievalBrief: "", importance: 0.5, sources: [{ characterId: mira.id, characterName: "Mira", messageIds: [1] }], scopeCharacterId: mira.id });
    app.store.insertMemory({ pool: characterPool(other.id), tier: "stm", topic: "B", summary: "b", retrievalBrief: "", importance: 0.5, sources: [{ characterId: other.id, characterName: "Oren", messageIds: [2] }], scopeCharacterId: other.id });
    assert.equal((await app.memory.runDailyIfDue()).status, "not_due");
    closeApp(app);
    // The server was down over midnight; on restart (and key entry) the missed boundary is consolidated once.
    now = new Date(2026, 9, 31, 9, 30, 0);
    const mock = mockOpenRouter(handlers);
    ({ app } = await makeApp({}, { dataDir, mock, key: false, appOptions: { now: () => now } }));
    assert.equal(app.key.configured(), false, "the key does not survive a restart");
    await app.setApiKey("sk-or-v1-anotherkey1234567890ABCDEF");
    await waitFor(() => app.store.getMeta("lastLtmDate") === "2026-10-31", { message: "catch-up" });
    for (const [character, name] of [[mira, "Mira"], [other, "Oren"]]) {
      const ltm = app.store.memoryRecords(characterPool(character.id), "ltm");
      assert.equal(ltm.length, 1, "each character's own pool is consolidated once");
      assert.deepEqual(ltm[0].sources.map((source) => source.characterName), [name], "no record crosses into another character's pool");
      assert.equal(app.store.memoryRecords(characterPool(character.id), "stm").length, 0);
    }
    assert.equal(mock.byPurpose("memory_ltm_consolidation")[0].body.model, app.settings.get().models.dialogue);
    const callsAfter = mock.byPurpose("memory_ltm_consolidation").length;
    assert.equal((await app.memory.runDailyIfDue({ force: true })).status, "not_due");
    closeApp(app);
    ({ app } = await makeApp({}, { dataDir, mock, appOptions: { now: () => now } }));
    await app.memory.runDailyIfDue({ force: true });
    assert.equal(mock.byPurpose("memory_ltm_consolidation").length, callsAfter, "a repeated restart does not consolidate again");
  } finally { closeApp(app); }
});

test("a failed LTM job keeps its STM and does not mark the date", async () => {
  let now = new Date(2026, 9, 30, 12, 0, 0);
  const { app } = await makeApp({ memory_ltm_consolidation: () => ({ longTermMemoriesToUpsert: [], longTermMemoriesToAdd: [], retirementGroups: [] }) }, { appOptions: { now: () => now } });
  try {
    const mira = app.createCharacter(base);
    app.store.insertMemory({ pool: characterPool(mira.id), tier: "stm", topic: "Keep", summary: "k", retrievalBrief: "", importance: 0.9, sources: [], scopeCharacterId: mira.id });
    now = new Date(2026, 9, 31, 0, 0, 1);
    const result = await app.memory.runDailyIfDue({ force: true });
    assert.equal(result.status, "failed");
    assert.equal(app.store.memoryRecords(characterPool(mira.id), "stm").length, 1);
    assert.equal(app.store.getMeta("lastLtmDate"), "2026-10-30");
  } finally { closeApp(app); }
});

test("dialogue retrieval uses the semantic selector over the memory pool and falls back to importance on failure", async () => {
  const { app, mock } = await makeApp({
    dialogue_memory_retrieval: (body, { count }) => count === 1 ? { stmIds: [], ltmIds: [JSON.parse(body.messages[1].content).catalog.longTermMemories[1].id] } : "garbage",
    dialogue_reply: () => ({ message: "ok", followUpDelaySeconds: null, imageRequest: null }),
    contemplation_prefetch: () => ({ generation: false, maintenance: false })
  });
  try {
    const mira = app.createCharacter(base);
    const pool = characterPool(mira.id);
    app.store.insertMemory({ pool, tier: "ltm", topic: "Low", summary: "LOW-MEMORY", retrievalBrief: "", importance: 0.1, sources: [] });
    app.store.insertMemory({ pool, tier: "ltm", topic: "High", summary: "SELECTED-MEMORY", retrievalBrief: "", importance: 0.9, sources: [] });
    app.dialogue.send(mira.id, "remember?");
    await waitFor(() => app.store.lastMessage(mira.id).role === "character");
    const system = mock.byPurpose("dialogue_reply")[0].body.messages[0].content;
    assert.match(system, /SELECTED-MEMORY/);
    assert.doesNotMatch(system, /LOW-MEMORY/);
    app.dialogue.send(mira.id, "again");
    await waitFor(() => mock.byPurpose("dialogue_reply").length === 2 && app.store.lastMessage(mira.id).role === "character");
    assert.match(mock.byPurpose("dialogue_reply")[1].body.messages[0].content, /LOW-MEMORY/, "fallback includes the deterministic ranking");
  } finally { closeApp(app); }
});
