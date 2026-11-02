// Specification 0004: interpretation consolidation inside Maintenance, character-owned cognition and its migration,
// and the mobile composer contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeApp, closeApp, waitFor, seedMessages, tempDir, identityConsolidation, ROOT } from "./helpers.js";
import { Store, MIGRATIONS, poolOf, characterPool } from "../src/db.js";
import { validateConsolidation } from "../src/contemplation.js";
import { consolidationSystemPrompt, INTERPRETATION_MAX_CHARS } from "../src/prompts/contemplation.js";

const base = { name: "Mira", description: "Keeper." };
const payloadOf = (call) => JSON.parse(call.body.messages[1].content);
const unchanged = () => ({ action: "unchanged", text: null, completedExperimentIds: [] });

async function maintain(app, pool, characterId) {
  app.contemplation.force(pool, "maintenance", characterId);
  await app.contemplation.idle(pool);
}

// A pool seeded without triggering planning or gestaltization.
function seedPool(app, character, texts, experiments = []) {
  const pool = poolOf(character);
  app.settings.update({ contemplationEnabled: false });
  const ids = texts.map((text) => app.contemplation.addInterpretation(pool, text, character.id));
  const experimentIds = experiments.map((text) => app.contemplation.addExperiment(pool, text));
  app.store.setPlanningNeeded(pool, false);
  seedMessages(app, character.id, 2);
  return { pool, ids, experimentIds };
}

// ---- C1-C4: consolidation inside Maintenance --------------------------------------------------------------------

test("C1: one consolidation request with the whole pool precedes every verification call; an empty pool makes no call", async () => {
  const { app, mock } = await makeApp({ contemplation_consolidation: identityConsolidation, contemplation_maintenance: unchanged });
  try {
    const mira = app.createCharacter(base);
    const texts = Array.from({ length: 40 }, (_, index) => `Distinct hypothesis number ${index + 1}.`);
    const { pool, ids } = seedPool(app, mira, texts);
    const revision = app.store.ensureInterpretationPool(pool).interpretationRevision;
    await maintain(app, pool, mira.id);
    const consolidations = mock.byPurpose("contemplation_consolidation");
    assert.equal(consolidations.length, 1, "exactly one consolidation, not one per interpretation");
    assert.deepEqual(payloadOf(consolidations[0]).interpretations, ids.map((id, index) => ({ id: `int_${id}`, text: texts[index] })), "complete set, no cap");
    const order = mock.calls.map((call) => call.purpose).filter((purpose) => purpose.startsWith("contemplation_"));
    assert.equal(order[0], "contemplation_consolidation");
    assert.equal(order.filter((purpose) => purpose === "contemplation_maintenance").length, 40, "a large distinct set is not reduced");
    assert.equal(app.store.interpretations(pool).length, 40);
    assert.equal(app.store.ensureInterpretationPool(pool).interpretationRevision, revision, "an unchanged set does not bump the revision");

    const empty = app.createCharacter({ ...base, name: "Empty" });
    await maintain(app, poolOf(empty), empty.id);
    assert.equal(mock.byPurpose("contemplation_consolidation").length, 1, "an empty pool stays a no-op");
  } finally { closeApp(app); }
});

test("C1/C4: a prefetch-selected maintenance consolidates, verifies the consolidated text, and commits once with completions", async () => {
  let merged = null;
  const { app, mock } = await makeApp({
    contemplation_prefetch: () => ({ generation: false, maintenance: true }),
    contemplation_consolidation: (body) => {
      const [a, b, c] = payloadOf({ body }).interpretations;
      merged = { a, b, c };
      return { interpretations: [{ id: a.id, sourceIds: [a.id, b.id], text: "MERGED: the user tests trust through jokes." }, { id: c.id, sourceIds: [c.id], text: c.text }] };
    },
    contemplation_maintenance: (body) => {
      const payload = payloadOf({ body });
      return payload.interpretation.text.startsWith("MERGED")
        ? { action: "replace", text: "VERIFIED MERGE: the user tests trust through jokes.", completedExperimentIds: payload.activeExperiments.map((entry) => entry.id) }
        : unchanged();
    },
    contemplation_gestaltization: () => ({ gestalt: "One person, several readings." }),
    contemplation_experiment_planning: () => ({ experiments: [] }),
    dialogue_reply: () => ({ message: "ok", followUpDelaySeconds: null, imageRequest: null }),
    dialogue_memory_retrieval: () => ({ stmIds: [], ltmIds: [] })
  });
  try {
    const mira = app.createCharacter(base);
    const { pool, ids } = seedPool(app, mira, ["The user jokes to test trust.", "Humor is the user's way of checking whether the character is safe.", "The user is homesick."], ["Tell an absurd story."]);
    const before = app.store.ensureInterpretationPool(pool);
    app.settings.update({ contemplationEnabled: true });
    app.dialogue.send(mira.id, "haha");
    await waitFor(() => mock.byPurpose("contemplation_experiment_planning").length === 1, { message: "planning after the change" });
    await app.contemplation.idle(pool);
    const verified = mock.byPurpose("contemplation_maintenance").map((call) => payloadOf(call).interpretation);
    assert.deepEqual(verified.map((entry) => entry.id).sort(), [merged.a.id, merged.c.id].sort());
    assert.ok(verified.some((entry) => entry.text === "MERGED: the user tests trust through jokes."), "the verifier sees the consolidated candidate");
    assert.ok(!verified.some((entry) => entry.text === "The user jokes to test trust."), "never only the pre-consolidation text");
    assert.deepEqual(app.store.interpretations(pool).map((entry) => [entry.id, entry.text]),
      [[ids[0], "VERIFIED MERGE: the user tests trust through jokes."], [ids[2], "The user is homesick."]], "survivor ids kept, merged-away id removed");
    assert.deepEqual(app.store.experiments(pool), [], "the verified completion is committed with the set");
    const after = app.store.ensureInterpretationPool(pool);
    assert.equal(after.interpretationRevision, before.interpretationRevision + 1, "one revision bump for the whole commit");
    assert.equal(mock.byPurpose("contemplation_gestaltization").length, 1, "the changed set triggers gestaltization");
    const event = app.diagnostics.events.find((entry) => entry.type === "contemplation-maintenance");
    assert.equal(event.considered, 3);
    assert.equal(event.merged, 1);
    assert.equal(event.verified, 2);
    assert.equal(event.applied, true);
  } finally { closeApp(app); }
});

test("C4: a failed consolidation or a failed verification commits nothing", async () => {
  let failVerification = false;
  const { app, mock } = await makeApp({
    contemplation_consolidation: (body, ctx) => ctx.count <= 3 ? "not json" : (() => {
      const [a, b] = payloadOf({ body }).interpretations;
      return { interpretations: [{ id: a.id, sourceIds: [a.id, b.id], text: "Merged." }] };
    })(),
    contemplation_maintenance: () => failVerification ? { action: "explode" } : unchanged()
  });
  try {
    const mira = app.createCharacter(base);
    const { pool } = seedPool(app, mira, ["One.", "Two."], ["Probe."]);
    const snapshot = () => JSON.stringify([app.store.interpretations(pool), app.store.experiments(pool), app.store.ensureInterpretationPool(pool)]);
    const before = snapshot();
    await maintain(app, pool, mira.id);
    assert.equal(mock.byPurpose("contemplation_consolidation").length, 3, "initial attempt plus bounded repairs");
    assert.equal(mock.byPurpose("contemplation_maintenance").length, 0, "no verification after an invalid consolidation");
    assert.equal(snapshot(), before);
    assert.equal(app.diagnostics.events.findLast((entry) => entry.type === "contemplation-maintenance").stage, "consolidation");

    failVerification = true;
    await maintain(app, pool, mira.id);
    assert.ok(mock.byPurpose("contemplation_maintenance").length >= 1);
    assert.equal(snapshot(), before, "the consolidated merge is never persisted without verification");
    assert.equal(app.diagnostics.events.findLast((entry) => entry.type === "contemplation-maintenance").stage, "verification");
  } finally { closeApp(app); }
});

test("C4: a pool change during the model calls discards the stale result; a later run is still eligible", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { app, mock } = await makeApp({
    contemplation_consolidation: (body) => {
      const [a, b] = payloadOf({ body }).interpretations;
      return { interpretations: [{ id: a.id, sourceIds: [a.id, b.id], text: "Merged." }] };
    },
    contemplation_maintenance: async () => { await gate; return unchanged(); },
    contemplation_experiment_planning: () => ({ experiments: [] })
  });
  try {
    const mira = app.createCharacter(base);
    const { pool, ids } = seedPool(app, mira, ["One.", "Two."]);
    app.contemplation.force(pool, "maintenance", mira.id);
    await waitFor(() => app.contemplation.status(pool).stage === "maintenance", { message: "verification" });
    app.contemplation.editInterpretation(pool, ids[1], "Two, edited meanwhile.");
    release();
    await app.contemplation.idle(pool);
    assert.deepEqual(app.store.interpretations(pool).map((entry) => entry.text), ["One.", "Two, edited meanwhile."], "nothing stale is merged or deleted");
    assert.equal(app.diagnostics.events.findLast((entry) => entry.type === "contemplation-maintenance").status, "stale");
    await maintain(app, pool, mira.id);
    assert.deepEqual(app.store.interpretations(pool).map((entry) => entry.text), ["Merged."], "the next run applies");
    assert.equal(mock.byPurpose("contemplation_consolidation").length, 2);
  } finally { closeApp(app); }
});

test("C3: the consolidation result must account for every id exactly once by supplied representatives", () => {
  const ids = ["int_1", "int_2", "int_3"];
  const entry = (id, sourceIds, text = "t") => ({ id, sourceIds, text });
  assert.equal(validateConsolidation({ interpretations: [entry("int_1", ["int_1", "int_2"]), entry("int_3", ["int_3"])] }, ids).ok, true);
  const invalid = {
    empty: { interpretations: [] },
    missing: { interpretations: [entry("int_1", ["int_1"]), entry("int_2", ["int_2"])] },
    unknownRepresentative: { interpretations: [entry("int_9", ["int_9", "int_1", "int_2", "int_3"])] },
    unknownSource: { interpretations: [entry("int_1", ["int_1", "int_2", "int_3", "int_7"])] },
    duplicateRepresentative: { interpretations: [entry("int_1", ["int_1", "int_2"]), entry("int_1", ["int_3"])] },
    overlap: { interpretations: [entry("int_1", ["int_1", "int_2"]), entry("int_2", ["int_2", "int_3"])] },
    ownIdMissing: { interpretations: [entry("int_1", ["int_2", "int_3"]), entry("int_3", ["int_1"])] },
    overLimit: { interpretations: [entry("int_1", ["int_1", "int_2", "int_3"], "x".repeat(INTERPRETATION_MAX_CHARS + 1))] },
    emptyText: { interpretations: [entry("int_1", ["int_1", "int_2", "int_3"], " ")] },
    extraKey: { interpretations: [{ ...entry("int_1", ["int_1", "int_2", "int_3"]), score: 1 }] },
    wrongShape: { merged: [] }
  };
  for (const [name, raw] of Object.entries(invalid)) assert.equal(validateConsolidation(raw, ids).ok, false, name);
});

test("C2/C3: the consolidation prompt separates deduplication from verification and sets no count target", () => {
  const prompt = consolidationSystemPrompt();
  assert.match(prompt, /deduplication, NOT verification/);
  assert.match(prompt, /Never drop, weaken, or merge an interpretation because it is unusual, implausible, speculative, unproven, or in conflict/);
  assert.match(prompt, /Keep genuinely different explanations separate, including different explanations of the same events and openly conflicting/);
  assert.match(prompt, /narrower version/);
  assert.match(prompt, /strip excessive retelling/);
  assert.match(prompt, /Do not invent new hypotheses/);
  assert.match(prompt, /no target, minimum, or maximum number/);
  assert.match(prompt, /Account for every supplied id exactly once/);
});

test("C3: a pool beyond the model's context or output budget is refused before any request, never truncated", async () => {
  const { app, mock } = await makeApp({ contemplation_consolidation: identityConsolidation, contemplation_maintenance: unchanged });
  try {
    const mira = app.createCharacter(base);
    const { pool } = seedPool(app, mira, ["A".repeat(3000), "B".repeat(3000), "C".repeat(3000)]);
    const before = JSON.stringify(app.store.interpretations(pool));
    const model = app.settings.get().models.contemplation;
    app.llm.catalog = { at: Date.now(), models: [], byId: new Map([[model, { id: model, contextLength: 16_500 }]]) };
    await maintain(app, pool, mira.id);
    assert.equal(app.contemplation.status(pool).lastError.code, "CONSOLIDATION_CONTEXT_EXCEEDED");
    assert.match(app.contemplation.status(pool).lastError.message, /system prompt and output budget/);

    app.llm.catalog = { at: Date.now(), models: [], byId: new Map() };
    app.settings.update({ maxTokens: { ...app.settings.get().maxTokens, contemplation: 1000 } });
    await maintain(app, pool, mira.id);
    assert.equal(app.contemplation.status(pool).lastError.code, "CONSOLIDATION_OUTPUT_EXCEEDED");
    assert.equal(mock.byPurpose("contemplation_consolidation").length, 0);
    assert.equal(JSON.stringify(app.store.interpretations(pool)), before);
  } finally { closeApp(app); }
});

// ---- P1-P4: character-owned cognition ---------------------------------------------------------------------------

test("P1: a new character starts with empty cognition; Dialogue, Vision and Contemplation contexts never see another character's", async () => {
  const { app, mock } = await makeApp({
    contemplation_prefetch: () => ({ generation: true, maintenance: false }),
    contemplation_generation: () => ({ decision: "decline", text: null }),
    dialogue_reply: () => ({ message: "ok", followUpDelaySeconds: null, imageRequest: null }),
    dialogue_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    contemplation_memory_retrieval: () => ({ stmIds: [], ltmIds: [] })
  });
  try {
    const first = app.createCharacter(base);
    app.settings.update({ contemplationEnabled: false });
    app.contemplation.addInterpretation(poolOf(first), "FIRST-INTERPRETATION");
    app.contemplation.addExperiment(poolOf(first), "FIRST-EXPERIMENT");
    app.store.setGestalt(poolOf(first), "FIRST-GESTALT", 1);
    app.store.insertMemory({ pool: poolOf(first), tier: "ltm", topic: "FIRST-MEMORY", summary: "s", retrievalBrief: "", importance: 0.5, sources: [] });
    app.settings.update({ contemplationEnabled: true });
    const second = app.createCharacter({ ...base, name: "Second", useSharedMemory: true, useSharedInterpretations: true });
    assert.deepEqual([app.store.interpretations(poolOf(second)), app.store.experiments(poolOf(second)), app.store.memoryRecords(poolOf(second))], [[], [], []]);
    assert.equal(app.store.ensureInterpretationPool(poolOf(second)).gestalt, null);
    app.dialogue.send(second.id, "hello");
    await waitFor(() => mock.byPurpose("contemplation_generation").length === 1, { message: "second chat contemplation" });
    await app.contemplation.idle(poolOf(second));
    await waitFor(() => !app.dialogue.chat(second.id).pending);
    for (const call of mock.calls) assert.doesNotMatch(JSON.stringify(call.body), /FIRST-/, call.purpose);
  } finally { closeApp(app); }
});

// A schema-3 database as Specifications 0000-0003 left it: the given characters, then optional legacy rows.
function legacyDatabase(characters, seed) {
  const dataDir = tempDir();
  const file = path.join(dataDir, "beholder.sqlite");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = OFF");
  for (const migration of MIGRATIONS.slice(0, 3)) db.exec(migration);
  db.exec("PRAGMA user_version = 3");
  const at = "2026-11-01T10:00:00.000Z";
  for (const [name, sharedMemory, sharedInterpretations] of characters) {
    db.prepare("INSERT INTO characters (name, description, use_shared_memory, use_shared_interpretations, created_at, updated_at) VALUES (?, 'd', ?, ?, ?, ?)").run(name, sharedMemory, sharedInterpretations, at, at);
  }
  seed?.(db, at);
  db.close();
  return { dataDir, file };
}

// The installed single-character shape: Alice uses both legacy shared pools, which hold all of her state.
function seedAliceShared(db, at) {
  for (let index = 1; index <= 6; index += 1) db.prepare("INSERT INTO messages (character_id, role, kind, text, created_at, active, consolidated_pool, consolidated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)")
    .run(index % 2 ? "user" : "character", index % 2 ? "user" : "reply", `line ${index}\nsecond line`, at, index > 2 ? 1 : 0, index > 2 ? null : "shared", index > 2 ? null : at);
  db.prepare("INSERT INTO uploads (message_id, character_id, file, mime, bytes, status, created_at, updated_at) VALUES (5, 1, 'abc.png', 'image/png', 10, 'failed', ?, ?)").run(at, at);
  db.prepare("INSERT INTO meta (key, value) VALUES ('settings', '{\"contemplationEnabled\":true}'), ('userDescription', '\"I am the user.\"'), ('lastLtmDate', '\"2026-11-01\"')").run();
  db.prepare("INSERT INTO memory_pools (pool, revision, last_ltm_date) VALUES ('shared', 15, '2026-11-01')").run();
  const source = JSON.stringify([{ characterId: 1, characterName: "Alice", messageIds: [1, 2] }]);
  db.prepare("INSERT INTO memory_records (pool, tier, topic, summary, retrieval_brief, importance, sources, scope_character_id, source_from, source_to, created_at, updated_at) VALUES ('shared', 'stm', 'Greeting', 'Alice and the user met.', 'meeting', 0.6, ?, 1, ?, ?, ?, ?)").run(source, at, at, at, at);
  db.prepare("INSERT INTO memory_records (pool, tier, topic, summary, retrieval_brief, importance, sources, scope_character_id, source_from, source_to, created_at, updated_at) VALUES ('shared', 'stm', 'Kyiv', 'The user writes from Kyiv.', 'place', 0.7, ?, 1, ?, ?, ?, ?)").run(source, at, at, at, at);
  db.prepare("INSERT INTO memory_records (pool, tier, topic, summary, retrieval_brief, importance, sources, scope_character_id, source_from, source_to, created_at, updated_at) VALUES ('shared', 'ltm', 'Name', 'The user is called Dimka.', 'name', 0.9, ?, NULL, ?, ?, ?, ?)").run(source, at, at, at, at);
  db.prepare("INSERT INTO interpretation_pools (pool, interpretation_revision, experiment_revision, planning_needed, gestalt, gestalt_revision, gestalt_updated_at) VALUES ('shared', 61, 98, 1, 'The interpretations circle the user.', 60, ?)").run(at);
  const origin = JSON.stringify({ source: "generation", characterId: 1, characterName: "Alice" });
  for (const text of ["Hypothesis one.", "Hypothesis two.", "Hypothesis three."]) db.prepare("INSERT INTO interpretations (pool, text, origin, created_at, updated_at) VALUES ('shared', ?, ?, ?, ?)").run(text, origin, at, at);
  for (const text of ["Show tenderness.", "Ask about Kyiv."]) db.prepare("INSERT INTO experiments (pool, text, created_at, updated_at) VALUES ('shared', ?, ?, ?)").run(text, at, at);
  db.prepare("INSERT INTO contemplation_watermarks (pool, character_id, last_user_message_id, updated_at) VALUES ('shared', 1, 5, ?)").run(at);
}

const rows = (file, sql) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(sql).all().map((row) => ({ ...row })); } finally { db.close(); }
};

test("P2: the single shared-pool character keeps every record, id, text, revision, gestalt and watermark; reopening changes nothing", () => {
  const { file } = legacyDatabase([["Alice", 1, 1]], seedAliceShared);
  const before = {
    memory: rows(file, "SELECT * FROM memory_records ORDER BY id"), interpretations: rows(file, "SELECT * FROM interpretations ORDER BY id"),
    experiments: rows(file, "SELECT * FROM experiments ORDER BY id"), messages: rows(file, "SELECT * FROM messages ORDER BY id"),
    uploads: rows(file, "SELECT * FROM uploads"), meta: rows(file, "SELECT * FROM meta ORDER BY key")
  };
  const store = new Store(file);
  store.close();
  const own = characterPool(1);
  const moved = (list) => list.map((row) => ({ ...row, pool: own }));
  assert.deepEqual(rows(file, "SELECT * FROM memory_records ORDER BY id"), moved(before.memory), "STM/LTM: ids, text, provenance and timestamps kept");
  assert.deepEqual(rows(file, "SELECT * FROM interpretations ORDER BY id"), moved(before.interpretations));
  assert.deepEqual(rows(file, "SELECT * FROM experiments ORDER BY id"), moved(before.experiments));
  assert.deepEqual(rows(file, "SELECT * FROM memory_pools"), [{ pool: own, revision: 15, last_ltm_date: "2026-11-01" }]);
  assert.deepEqual(rows(file, "SELECT * FROM interpretation_pools"), [{ pool: own, interpretation_revision: 61, experiment_revision: 98, planning_needed: 1,
    gestalt: "The interpretations circle the user.", gestalt_revision: 60, gestalt_updated_at: "2026-11-01T10:00:00.000Z" }]);
  assert.deepEqual(rows(file, "SELECT pool, character_id, last_user_message_id FROM contemplation_watermarks"), [{ pool: own, character_id: 1, last_user_message_id: 5 }]);
  assert.deepEqual(rows(file, "SELECT * FROM messages ORDER BY id"), before.messages.map((row) => ({ ...row, consolidated_pool: row.consolidated_pool ? own : null })),
    "the transcript is untouched apart from the consolidation pool label");
  assert.deepEqual(rows(file, "SELECT * FROM uploads"), before.uploads);
  assert.deepEqual(rows(file, "SELECT * FROM meta ORDER BY key"), before.meta, "settings, self-description and the daily LTM marker are kept");
  assert.deepEqual(rows(file, "SELECT name FROM pragma_table_info('characters') ORDER BY cid").map((row) => row.name), ["id", "name", "description", "created_at", "updated_at"]);
  assert.equal(rows(file, "PRAGMA user_version")[0].user_version, MIGRATIONS.length);

  const snapshot = () => JSON.stringify(["memory_records", "memory_pools", "interpretations", "experiments", "interpretation_pools", "contemplation_watermarks", "messages"].map((table) => rows(file, `SELECT * FROM ${table}`)));
  const migrated = snapshot();
  new Store(file).close();
  assert.equal(snapshot(), migrated, "a restart neither moves nor duplicates anything");
});

test("P2: the migrated character continues its work, and a second character starts empty", async () => {
  const { dataDir } = legacyDatabase([["Alice", 1, 1]], seedAliceShared);
  const { app, mock } = await makeApp({
    contemplation_experiment_planning: () => ({ experiments: [{ id: null, text: "Planned after migration." }] }),
    contemplation_prefetch: () => ({ generation: false, maintenance: false }),
    contemplation_gestaltization: () => ({ gestalt: "Renewed." })
  }, { dataDir });
  try {
    const alice = app.store.getCharacter(1);
    const pool = poolOf(alice);
    await waitFor(() => mock.byPurpose("contemplation_experiment_planning").length === 1, { message: "persisted planning recovered" });
    await app.contemplation.idle(pool);
    assert.equal(payloadOf(mock.byPurpose("contemplation_experiment_planning")[0]).interpretations.length, 3);
    assert.equal(mock.byPurpose("contemplation_prefetch").length, 0, "the watermark kept its position: message 5 was already evaluated");
    const second = app.createCharacter({ ...base, name: "Bob" });
    assert.deepEqual([app.store.interpretations(poolOf(second)), app.store.experiments(poolOf(second)), app.store.memoryRecords(poolOf(second))], [[], [], []]);
    assert.equal(app.store.ensureInterpretationPool(poolOf(second)).gestalt, null);
  } finally { closeApp(app); }
});

test("P2: personal-pool installations migrate unchanged without any extra character", () => {
  const { file } = legacyDatabase([["Ann", 0, 0], ["Ben", 0, 1]], (db, at) => {
    db.prepare("INSERT INTO interpretation_pools (pool, interpretation_revision, gestalt) VALUES ('character:1', 3, 'Ann gestalt')").run();
    db.prepare("INSERT INTO interpretations (pool, text, origin, created_at, updated_at) VALUES ('character:1', 'Ann idea', '{}', ?, ?)").run(at, at);
    db.prepare("INSERT INTO memory_records (pool, tier, topic, summary, importance, sources, created_at, updated_at) VALUES ('character:2', 'ltm', 'Ben memory', 's', 0.5, '[]', ?, ?)").run(at, at);
    db.prepare("INSERT INTO interpretation_pools (pool, interpretation_revision) VALUES ('shared', 4)").run();
  });
  const personal = () => [rows(file, "SELECT * FROM interpretations"), rows(file, "SELECT * FROM memory_records"), rows(file, "SELECT * FROM interpretation_pools WHERE pool = 'character:1'")];
  const before = personal();
  new Store(file).close();
  assert.deepEqual(personal(), before);
  assert.deepEqual(rows(file, "SELECT pool FROM interpretation_pools ORDER BY pool").map((row) => row.pool), ["character:1", "character:2"], "the empty shared pool row went to its only user, Ben");
  assert.equal(rows(file, "SELECT COUNT(*) AS n FROM characters")[0].n, 2);
});

test("P2: ambiguous legacy states stop the migration atomically and leave the database untouched", () => {
  const cases = {
    "two characters share nonempty memory": [[["A", 1, 0], ["B", 1, 0]], (db, at) => db.prepare("INSERT INTO memory_records (pool, tier, topic, summary, importance, sources, created_at, updated_at) VALUES ('shared', 'ltm', 'T', 'S', 0.5, '[]', ?, ?)").run(at, at)],
    "nobody uses nonempty shared interpretations": [[["A", 0, 0]], (db, at) => db.prepare("INSERT INTO interpretations (pool, text, origin, created_at, updated_at) VALUES ('shared', 'orphan', '{}', ?, ?)").run(at, at)],
    "another character contributed": [[["A", 0, 1], ["B", 0, 0]], (db, at) => db.prepare("INSERT INTO interpretations (pool, text, origin, created_at, updated_at) VALUES ('shared', 'from B', '{\"characterId\":2}', ?, ?)").run(at, at)],
    "another chat was consolidated into shared memory": [[["A", 1, 0], ["B", 0, 0]], (db, at) => {
      db.prepare("INSERT INTO memory_records (pool, tier, topic, summary, importance, sources, created_at, updated_at) VALUES ('shared', 'ltm', 'T', 'S', 0.5, '[]', ?, ?)").run(at, at);
      db.prepare("INSERT INTO messages (character_id, role, kind, text, created_at, active, consolidated_pool) VALUES (2, 'user', 'user', 'x', ?, 0, 'shared')").run(at);
    }],
    "shared and personal gestalts both exist": [[["A", 0, 1]], (db) => {
      db.prepare("INSERT INTO interpretation_pools (pool, gestalt) VALUES ('shared', 'shared gestalt'), ('character:1', 'personal gestalt')").run();
    }]
  };
  for (const [name, [characters, seed]] of Object.entries(cases)) {
    const { file } = legacyDatabase(characters, seed);
    const tables = ["characters", "messages", "memory_records", "memory_pools", "interpretations", "experiments", "interpretation_pools", "contemplation_watermarks"];
    const before = JSON.stringify(tables.map((table) => rows(file, `SELECT * FROM ${table}`)));
    assert.throws(() => new Store(file), (error) => error.code === "MIGRATION_BLOCKED" && /database was not changed/.test(error.message), name);
    assert.equal(rows(file, "PRAGMA user_version")[0].user_version, 3, name);
    assert.equal(JSON.stringify(tables.map((table) => rows(file, `SELECT * FROM ${table}`))), before, name);
  }
});

// ---- P3 and U1-U3: browser UI -----------------------------------------------------------------------------------

test("P3/U1/U2: no scope controls remain; the composer has icon buttons and no Enter-to-send handler", () => {
  const app = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");
  assert.doesNotMatch(app, /useShared|shared memory|shared interpretations|private memory|private interpretations|Shared pool/i);
  assert.doesNotMatch(app, /keydown|keypress|"Enter"|'Enter'/, "no keyboard shortcut submits a message");
  assert.match(app, /"aria-label": "Attach image"/);
  assert.match(app, /"aria-label": "Send message"/);
  assert.match(app, /sendButton\.addEventListener\("click", submit\)/);
  assert.doesNotMatch(app, /h\("form"[^\n]*composer/, "the composer is not a form, so Enter cannot submit it implicitly");
  assert.match(css, /\.composer textarea \{[^}]*flex: 1 1 auto;[^}]*min-width: 0;[^}]*max-height:[^}]*overflow-y: auto;/);
  assert.match(css, /\.composer-button \{[^}]*width: 44px; height: 44px;/);
  assert.match(css, /\.composer-button:focus-visible/);
  assert.match(css, /\.composer-button:disabled/);
});
