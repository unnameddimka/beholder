// Specification 0005: character-owned AI configuration, three descriptions in every AI role, Force controls with
// Maintenance status, and Ctrl+Enter in the composer.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeApp, closeApp, waitFor, reply, seedMessages, tempDir, identityConsolidation, jsonResponse, configure, configOf, schema4Database, TEST_KEY, ROOT } from "./helpers.js";
import { Store, MIGRATIONS, poolOf } from "../src/db.js";
import { defaultConfig } from "../src/settings.js";
import { createServer } from "../src/server.js";
import { buildEmergencyDump } from "../src/dump.js";
import { imagePrompt } from "../src/prompts/image.js";
import { stmSystemPrompt, ltmSystemPrompt, ltmSelectionSystemPrompt, retrievalSystemPrompt } from "../src/prompts/memory.js";
import { prefetchSystemPrompt, consolidationSystemPrompt, maintenanceSystemPrompt, generationSystemPrompt, generationReviewSystemPrompt, gestaltizationSystemPrompt, experimentPlanningSystemPrompt } from "../src/prompts/contemplation.js";
import { visionSystemPrompt } from "../src/prompts/vision.js";

const base = { name: "Mira", description: "Keeper of the lighthouse." };
const quietPrefetch = () => ({ generation: false, maintenance: false });
const unchanged = () => ({ action: "unchanged", text: null, completedExperimentIds: [] });
const payloadOf = (call) => JSON.parse(call.body.messages[1].content);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const described = { description: "CHAR-DESC", sceneDescription: "SCENE-DESC", userDescription: "USER-DESC" };
const contextOf = (name) => ({ characterName: name, characterDescription: "CHAR-DESC", sceneDescription: "SCENE-DESC", userDescription: "USER-DESC" });

function gated() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return { gate, release };
}

async function listen(app) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

// Seeds a pool without triggering automatic Contemplation.
function seedPool(app, character, texts, experiments = []) {
  const pool = poolOf(character);
  const enabled = configOf(app, character.id).contemplationEnabled;
  configure(app, character.id, { contemplationEnabled: false });
  for (const text of texts) app.contemplation.addInterpretation(pool, text, character.id);
  for (const text of experiments) app.contemplation.addExperiment(pool, text);
  app.store.setPlanningNeeded(pool, false);
  configure(app, character.id, { contemplationEnabled: enabled });
  return pool;
}

const rows = (file, sql) => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };

// ---- A1-A3: character record, validation, defaults ----------------------------------------------------------------

test("A1/A2/A3: a character owns three descriptions and its whole AI configuration; a new one starts from built-in defaults", async () => {
  const { app } = await makeApp({});
  try {
    const a = app.createCharacter({ name: "A", description: "Line 1\nЛиния 2 ✨", sceneDescription: "A rainy pier.\nNight.", userDescription: "I am a nurse.",
      config: { models: { dialogue: "vendor/a-dialogue" }, temperature: { dialogue: { enabled: true, value: 1.2 } }, maxTokens: { vision: 1024 }, imageEnabled: true } });
    assert.equal(a.description, "Line 1\nЛиния 2 ✨");
    assert.equal(a.sceneDescription, "A rainy pier.\nNight.");
    assert.equal(a.userDescription, "I am a nurse.");
    assert.equal(a.config.models.dialogue, "vendor/a-dialogue");
    assert.deepEqual(a.config.temperature.dialogue, { enabled: true, value: 1.2 });
    assert.equal(a.config.maxTokens.vision, 1024);
    assert.equal(a.config.imageEnabled, true);
    const b = app.createCharacter({ name: "B" });
    assert.deepEqual(b.config, defaultConfig(), "built-in defaults, not A's settings");
    assert.equal(b.description, "");
    assert.equal(b.sceneDescription, "");
    assert.equal(b.userDescription, "");
    // Editing A changes neither B nor A's own cognition.
    app.contemplation.addInterpretation(poolOf(a), "Kept idea", a.id);
    seedMessages(app, a.id, 2);
    configure(app, a.id, { models: { contemplation: "vendor/a-contemplation" } });
    app.updateCharacter(a.id, { sceneDescription: "" });
    assert.equal(configOf(app, a.id).models.dialogue, "vendor/a-dialogue", "a patch keeps the other roles");
    assert.equal(app.store.getCharacter(a.id).userDescription, "I am a nurse.", "a field left out keeps its value");
    assert.deepEqual(app.store.getCharacter(b.id).config, defaultConfig());
    assert.deepEqual(app.store.interpretations(poolOf(a)).map((entry) => entry.text), ["Kept idea"]);
    assert.equal(app.store.messageCount(a.id), 2);
  } finally { closeApp(app); }
});

test("A3: invalid descriptions or configuration are rejected with a clear error and nothing is saved", async () => {
  const { app } = await makeApp({});
  try {
    const a = app.createCharacter({ name: "A", ...described });
    const before = app.store.getCharacter(a.id);
    const attempts = [
      [{ sceneDescription: "x".repeat(20_001) }, /Scene Description must be at most 20000/],
      [{ userDescription: 5 }, /User Description must be text/],
      [{ description: "changed", config: { models: { dialogue: "not a model id" } } }, /models\.dialogue/],
      [{ sceneDescription: "changed", config: { temperature: { vision: { enabled: true, value: 3 } } } }, /temperature\.vision/],
      [{ userDescription: "changed", config: { maxTokens: { contemplation: 100 } } }, /maxTokens\.contemplation/],
      [{ config: { imageEnabled: "yes" } }, /imageEnabled/],
      [{ config: { image: { temperature: 1 } } }, /Unknown setting image/]
    ];
    for (const [input, message] of attempts) {
      assert.throws(() => app.updateCharacter(a.id, input), message);
      assert.deepEqual(app.store.getCharacter(a.id), before, "no partial save");
    }
    assert.equal(app.createCharacter({ name: "Max", description: "y".repeat(20_000), sceneDescription: "s".repeat(20_000), userDescription: "u".repeat(20_000) }).userDescription.length, 20_000);
    const { server, url } = await listen(app);
    try {
      const response = await fetch(`${url}/api/characters/${a.id}`, { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "A", description: "changed", config: { models: { vision: "bad" } } }) });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.error.code, "CONFIG_INVALID");
      assert.ok(body.error.validationErrors.length);
      assert.deepEqual(app.store.getCharacter(a.id), before);
    } finally { server.close(); }
  } finally { closeApp(app); }
});

test("A3/A4: no global settings or user description remain in the API, status or Emergency Dump; the key stays out", async () => {
  const { app } = await makeApp({});
  try {
    const a = app.createCharacter({ name: "A", ...described, config: { models: { dialogue: "vendor/a-dialogue" } } });
    const { server, url } = await listen(app);
    try {
      const status = await (await fetch(`${url}/api/status`)).json();
      assert.equal("settings" in status, false);
      assert.equal("userDescription" in status, false);
      assert.deepEqual(status.defaultConfig, defaultConfig());
      assert.equal((await fetch(`${url}/api/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 404);
      assert.equal((await fetch(`${url}/api/user-description`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 404);
      const listed = (await (await fetch(`${url}/api/characters`)).json())[0];
      assert.equal(listed.userDescription, "USER-DESC");
      assert.equal(listed.sceneDescription, "SCENE-DESC");
      assert.equal(listed.config.models.dialogue, "vendor/a-dialogue");
    } finally { server.close(); }
    const { zip, manifest } = buildEmergencyDump(app);
    assert.equal("settings.json" in manifest.sections, false);
    assert.equal("user-description.json" in manifest.sections, false);
    assert.equal(manifest.sections["characters.json"].ok, true);
    assert.ok(zip.includes(Buffer.from("vendor/a-dialogue")) && zip.includes(Buffer.from("SCENE-DESC")));
    assert.equal(zip.includes(Buffer.from(TEST_KEY)), false);
    assert.equal(JSON.stringify(app.store.getCharacter(a.id)).includes(TEST_KEY), false);
    assert.equal(app.store.getMeta("settings", null), null);
    assert.equal(app.store.getMeta("userDescription", null), null);
  } finally { closeApp(app); }
});

// ---- A4: migration ----------------------------------------------------------------------------------------------

function legacyInstall(dataDir, { settings, userDescription, characters = [["Alice", "Old description."]] }) {
  const at = "2026-11-01T10:00:00.000Z";
  schema4Database(dataDir, (db) => {
    for (const [name, description] of characters) db.prepare("INSERT INTO characters (name, description, created_at, updated_at) VALUES (?, ?, ?, ?)").run(name, description, at, at);
    db.prepare("INSERT INTO messages (character_id, role, kind, text, created_at) VALUES (1, 'user', 'user', 'Hello', ?), (1, 'character', 'reply', 'Hi', ?)").run(at, at);
    db.prepare("INSERT INTO interpretation_pools (pool, interpretation_revision, experiment_revision, gestalt, gestalt_revision) VALUES ('character:1', 7, 3, 'A gestalt.', 7)").run();
    db.prepare("INSERT INTO interpretations (pool, text, origin, created_at, updated_at) VALUES ('character:1', 'An idea.', '{}', ?, ?)").run(at, at);
    db.prepare("INSERT INTO memory_records (pool, tier, topic, summary, importance, sources, created_at, updated_at) VALUES ('character:1', 'ltm', 'T', 'S', 0.5, '[]', ?, ?)").run(at, at);
    if (settings !== undefined) db.prepare("INSERT INTO meta (key, value) VALUES ('settings', ?)").run(typeof settings === "string" ? settings : JSON.stringify(settings));
    if (userDescription !== undefined) db.prepare("INSERT INTO meta (key, value) VALUES ('userDescription', ?)").run(JSON.stringify(userDescription));
    db.prepare("INSERT INTO meta (key, value) VALUES ('lastLtmDate', '\"2026-11-01\"')").run();
  });
  return path.join(dataDir, "beholder.sqlite");
}

const LEGACY = {
  models: { dialogue: "vendor/old-dialogue", contemplation: "vendor/old-contemplation", vision: "vendor/old-vision", image: "vendor/old-image" },
  temperature: { dialogue: { enabled: true, value: 0.35 }, contemplation: { enabled: false, value: 1.5 }, vision: { enabled: true, value: 0 } },
  maxTokens: { dialogue: 3000, contemplation: 50_000, vision: 777 },
  imageEnabled: true,
  contemplationEnabled: false
};

test("A4: the single existing character receives the exact legacy settings and user description; Scene starts empty; data is intact", () => {
  const dataDir = tempDir();
  const file = legacyInstall(dataDir, { settings: LEGACY, userDescription: "I am the user.\nTwo lines." });
  const keep = (sql) => rows(file, sql);
  const before = { messages: keep("SELECT * FROM messages"), interpretations: keep("SELECT * FROM interpretations"), memory: keep("SELECT * FROM memory_records"),
    pool: keep("SELECT pool, interpretation_revision, experiment_revision, gestalt, gestalt_revision FROM interpretation_pools") };
  const store = new Store(file);
  const alice = store.getCharacter(1);
  assert.deepEqual(alice.config, LEGACY);
  assert.equal(alice.description, "Old description.");
  assert.equal(alice.userDescription, "I am the user.\nTwo lines.");
  assert.equal(alice.sceneDescription, "");
  assert.equal(store.schemaVersion(), MIGRATIONS.length);
  assert.deepEqual(keep("SELECT key FROM meta ORDER BY key").map((row) => row.key), ["lastLtmDate"], "the legacy keys are retired");
  // A later edit is never overwritten by reopening the database.
  store.updateCharacter(1, { ...alice, sceneDescription: "Edited.", config: { ...alice.config, imageEnabled: false } });
  store.close();
  const again = new Store(file);
  assert.equal(again.getCharacter(1).sceneDescription, "Edited.");
  assert.equal(again.getCharacter(1).config.imageEnabled, false);
  again.close();
  assert.deepEqual(keep("SELECT * FROM messages"), before.messages);
  assert.deepEqual(keep("SELECT * FROM interpretations"), before.interpretations);
  assert.deepEqual(keep("SELECT * FROM memory_records"), before.memory);
  assert.deepEqual(keep("SELECT pool, interpretation_revision, experiment_revision, gestalt, gestalt_revision FROM interpretation_pools"), before.pool);
});

test("A4: several existing characters each get one copy, independent afterwards; missing legacy values give defaults and empty text", () => {
  const file = legacyInstall(tempDir(), { settings: { contemplationEnabled: false }, userDescription: "Shared once.", characters: [["Ann", "a"], ["Ben", "b"]] });
  const store = new Store(file);
  try {
    const [ann, ben] = store.listCharacters();
    assert.deepEqual(ann.config, { ...defaultConfig(), contemplationEnabled: false }, "the old partial object merged onto the defaults, as it was effective");
    assert.deepEqual(ben.config, ann.config);
    assert.equal(ann.userDescription, "Shared once.");
    assert.equal(ben.userDescription, "Shared once.");
    store.updateCharacter(ann.id, { ...ann, userDescription: "Only Ann.", config: { ...ann.config, imageEnabled: true } });
    assert.equal(store.getCharacter(ben.id).userDescription, "Shared once.");
    assert.equal(store.getCharacter(ben.id).config.imageEnabled, false);
  } finally { store.close(); }
  const fresh = new Store(legacyInstall(tempDir(), {}));
  try {
    assert.deepEqual(fresh.getCharacter(1).config, defaultConfig());
    assert.equal(fresh.getCharacter(1).userDescription, "");
  } finally { fresh.close(); }
});

test("A4: unreadable or invalid legacy values stop the migration and leave the database untouched", () => {
  const cases = [
    { settings: { models: { dialogue: "not a model" } } },
    { settings: { maxTokens: { dialogue: 1 } } },
    { settings: "{not json" },
    { settings: LEGACY, userDescription: 42 },
    { settings: LEGACY, userDescription: "x".repeat(20_001) }
  ];
  for (const legacy of cases) {
    const file = legacyInstall(tempDir(), legacy);
    const before = rows(file, "SELECT * FROM meta ORDER BY key");
    assert.throws(() => new Store(file), (error) => error.code === "MIGRATION_BLOCKED" && /Specification 0005 migration stopped/.test(error.message), JSON.stringify(legacy).slice(0, 80));
    assert.equal(rows(file, "PRAGMA user_version")[0].user_version, 4);
    assert.deepEqual(rows(file, "SELECT * FROM meta ORDER BY key"), before);
    assert.deepEqual(rows(file, "SELECT name FROM pragma_table_info('characters')").map((row) => row.name), ["id", "name", "description", "created_at", "updated_at"]);
  }
});

// ---- A5: routing and in-flight stability --------------------------------------------------------------------------

test("A5/13: overlapping jobs of two characters each use their own Dialogue, retrieval, Contemplation and Vision configuration", async () => {
  const gates = { A: gated(), B: gated() };
  const nameOf = (body) => /You are (\w+),/.exec(body.messages[0].content)?.[1];
  const { app, mock } = await makeApp({
    dialogue_reply: async (body) => { await gates[nameOf(body)].gate; return reply(`hi from ${nameOf(body)}`); },
    dialogue_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    contemplation_prefetch: quietPrefetch,
    vision_observation: () => "The image shows a small square of color."
  });
  try {
    const config = (name) => ({ models: { dialogue: `vendor/${name}-dialogue`, contemplation: `vendor/${name}-contemplation`, vision: `vendor/${name}-vision` },
      temperature: { dialogue: { enabled: true, value: name === "a" ? 0.25 : 1.75 } }, maxTokens: { dialogue: name === "a" ? 1111 : 2222 } });
    const a = app.createCharacter({ name: "A", ...described, config: config("a") });
    const b = app.createCharacter({ name: "B", ...described, config: config("b") });
    for (const character of [a, b]) app.store.insertMemory({ pool: poolOf(character), tier: "ltm", topic: "t", summary: "s", retrievalBrief: "", importance: 0.5, sources: [] });
    app.dialogue.send(a.id, "hello");
    await app.dialogue.sendImage(b.id, "look", { image: PNG });
    await waitFor(() => mock.byPurpose("dialogue_reply").length === 2, { message: "both replies in flight" });
    gates.B.release();
    gates.A.release();
    await waitFor(() => app.store.lastMessage(a.id)?.role === "character" && app.store.lastMessage(b.id)?.role === "character");
    await app.contemplation.idle(poolOf(a));
    await app.contemplation.idle(poolOf(b));
    for (const call of mock.byPurpose("dialogue_reply")) {
      const who = nameOf(call.body).toLowerCase();
      assert.equal(call.body.model, `vendor/${who}-dialogue`);
      assert.equal(call.body.temperature, who === "a" ? 0.25 : 1.75);
      assert.equal(call.body.max_tokens, who === "a" ? 1111 : 2222);
    }
    const retrievals = mock.byPurpose("dialogue_memory_retrieval");
    assert.deepEqual(retrievals.map((call) => [payloadOf(call).characterContext.characterName, call.body.model]).sort(), [["A", "vendor/a-dialogue"], ["B", "vendor/b-dialogue"]]);
    assert.deepEqual(mock.byPurpose("contemplation_prefetch").map((call) => [payloadOf(call).characterContext.characterName, call.body.model]).sort(), [["A", "vendor/a-contemplation"], ["B", "vendor/b-contemplation"]]);
    assert.deepEqual(mock.byPurpose("vision_observation").map((call) => call.body.model), ["vendor/b-vision"]);
  } finally { closeApp(app); }
});

test("A5/12: an edit during a job never changes that job, including its repair; the next job uses the new values", async () => {
  const { gate, release } = gated();
  const { app, mock } = await makeApp({
    dialogue_reply: async (body, ctx) => {
      if (ctx.count === 1) { await gate; return "{\"message\": 1}"; } // attempted JSON: goes to repair
      return reply("fixed");
    },
    contemplation_prefetch: quietPrefetch
  });
  try {
    const a = app.createCharacter({ name: "A", ...described, config: { models: { dialogue: "vendor/before" }, contemplationEnabled: false } });
    app.dialogue.send(a.id, "hello");
    await waitFor(() => mock.byPurpose("dialogue_reply").length === 1);
    app.updateCharacter(a.id, { sceneDescription: "NEW-SCENE", config: { models: { dialogue: "vendor/after" }, maxTokens: { dialogue: 999 } } });
    release();
    await waitFor(() => app.store.lastMessage(a.id)?.role === "character");
    const [first, repair] = mock.byPurpose("dialogue_reply");
    assert.equal(first.body.model, "vendor/before");
    assert.equal(repair.body.model, "vendor/before", "the repair stays on the job's snapshot");
    assert.equal(repair.body.max_tokens, defaultConfig().maxTokens.dialogue);
    assert.match(first.body.messages[0].content, /SCENE-DESC/);
    app.dialogue.send(a.id, "again");
    await waitFor(() => mock.byPurpose("dialogue_reply").length === 3 && app.store.lastMessage(a.id)?.role === "character");
    const next = mock.byPurpose("dialogue_reply")[2];
    assert.equal(next.body.model, "vendor/after");
    assert.equal(next.body.max_tokens, 999);
    assert.match(next.body.messages[0].content, /NEW-SCENE/);
  } finally { closeApp(app); }
});

test("A5/12: every stage of one Maintenance run keeps the configuration and descriptions it started with", async () => {
  const { gate, release } = gated();
  const { app, mock } = await makeApp({
    contemplation_consolidation: async (body) => { await gate; return identityConsolidation(body); },
    contemplation_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    // A revision makes the run continue into gestaltization and experiment planning.
    contemplation_maintenance: (body) => ({ action: "replace", text: `${payloadOf({ body }).interpretation.text} Revised.`, completedExperimentIds: [] }),
    contemplation_gestaltization: () => ({ gestalt: "Whole." }),
    contemplation_experiment_planning: () => ({ experiments: [] })
  });
  try {
    const a = app.createCharacter({ name: "A", ...described, config: { models: { contemplation: "vendor/before" }, contemplationEnabled: false } });
    const pool = seedPool(app, a, ["One.", "Two."]);
    app.store.insertMemory({ pool, tier: "ltm", topic: "t", summary: "s", retrievalBrief: "", importance: 0.5, sources: [] });
    seedMessages(app, a.id, 2);
    app.contemplation.force(pool, "maintenance", a.id);
    await waitFor(() => mock.byPurpose("contemplation_consolidation").length === 1);
    app.updateCharacter(a.id, { userDescription: "NEW-USER", config: { models: { contemplation: "vendor/after" } } });
    release();
    await app.contemplation.idle(pool);
    const run = mock.calls.filter((call) => call.purpose.startsWith("contemplation_"));
    assert.deepEqual([...new Set(run.map((call) => call.purpose))], ["contemplation_consolidation", "contemplation_memory_retrieval", "contemplation_maintenance", "contemplation_gestaltization", "contemplation_experiment_planning"]);
    for (const call of run) {
      assert.equal(call.body.model, "vendor/before", call.purpose);
      assert.equal(payloadOf(call).characterContext.userDescription, "USER-DESC", call.purpose);
    }
  } finally { closeApp(app); }
});

test("A5/14: a queued image keeps its model and descriptions through an edit and a restart; a later image uses the new values", async () => {
  const { gate, release } = gated();
  const seen = [];
  const images = async (url, init) => {
    if (url.endsWith("/endpoints")) return jsonResponse(200, { data: { endpoints: [] } });
    seen.push(JSON.parse(init.body));
    if (seen.length === 1) await gate;
    return jsonResponse(200, { data: [{ b64_json: PNG.toString("base64"), media_type: "image/png" }] });
  };
  const dataDir = tempDir();
  const { app } = await makeApp({ dialogue_reply: () => reply("*sketches*", { imageRequest: "a lighthouse" }), contemplation_prefetch: quietPrefetch }, { images, dataDir });
  try {
    const a = app.createCharacter({ name: "A", ...described, config: { models: { image: "vendor/image-before" }, imageEnabled: true } });
    app.dialogue.send(a.id, "draw");
    await waitFor(() => seen.length === 1);
    app.updateCharacter(a.id, { description: "NEW-CHAR", config: { models: { image: "vendor/image-after" } } });
    release();
    await waitFor(() => app.store.allImages()[0].status === "ready");
    assert.equal(seen[0].model, "vendor/image-before");
    assert.match(seen[0].prompt, /CHAR-DESC/);
    assert.doesNotMatch(seen[0].prompt, /NEW-CHAR/);
    // A row still pending at shutdown resumes with what it was queued with.
    app.store.addImage({ messageId: app.store.addMessage({ characterId: a.id, role: "character", kind: "reply", text: "later" }).id, characterId: a.id,
      request: "a gull", model: "vendor/queued-model", context: { characterName: "A", characterDescription: "QUEUED-CHAR", sceneDescription: "", userDescription: "" } });
  } finally { closeApp(app); }
  const restarted = await makeApp({ dialogue_reply: () => reply("*sketches again*", { imageRequest: "a boat" }), contemplation_prefetch: quietPrefetch }, { images, dataDir });
  try {
    await waitFor(() => seen.length === 2);
    assert.equal(seen[1].model, "vendor/queued-model");
    assert.match(seen[1].prompt, /^IMAGE REQUEST \(what to depict\):\na gull\n/);
    assert.match(seen[1].prompt, /QUEUED-CHAR/);
    restarted.app.dialogue.send(1, "one more");
    await waitFor(() => seen.length === 3 && restarted.app.store.allImages().every((image) => image.status === "ready") && !restarted.app.dialogue.chat(1).pending);
    assert.equal(seen[2].model, "vendor/image-after");
    assert.match(seen[2].prompt, /NEW-CHAR/);
    await restarted.app.contemplation.idle(poolOf({ id: 1 }));
  } finally { closeApp(restarted.app); }
});

test("A5/15: image generation off still perceives attachments; one character's Contemplation flag never affects another", async () => {
  const { app, mock } = await makeApp({
    dialogue_reply: () => reply("ok"),
    contemplation_prefetch: quietPrefetch,
    vision_observation: () => "The image shows a square."
  });
  try {
    const a = app.createCharacter({ name: "A", config: { imageEnabled: false, contemplationEnabled: false } });
    const b = app.createCharacter({ name: "B" });
    await app.dialogue.sendImage(a.id, "look", { image: PNG });
    await waitFor(() => app.store.lastTurn(a.id)?.role === "character");
    assert.equal(mock.byPurpose("vision_observation").length, 1);
    assert.equal(mock.byPurpose("contemplation_prefetch").length, 0, "A's automatic Contemplation is off");
    app.dialogue.send(b.id, "hi");
    await waitFor(() => mock.byPurpose("contemplation_prefetch").length === 1);
    assert.equal(payloadOf(mock.byPurpose("contemplation_prefetch")[0]).characterContext.characterName, "B");
  } finally { closeApp(app); }
});

test("A5: no AI request can be made without a character configuration", async () => {
  const { app, mock } = await makeApp({});
  try {
    await assert.rejects(app.llm.structured({ purpose: "contemplation_prefetch", messages: [], validate: () => ({ ok: true, value: {} }) }), { code: "CONFIG_REQUIRED" });
    await assert.rejects(app.llm.call({ purpose: "vision_observation", messages: [] }), { code: "CONFIG_REQUIRED" });
    assert.throws(() => app.llm.contextFit("dialogue", []), { code: "CONFIG_REQUIRED" });
    assert.equal(mock.calls.length, 0);
  } finally { closeApp(app); }
});

// ---- C1-C5: descriptions in every role ----------------------------------------------------------------------------

test("C2/17/23: Dialogue sees Character and Scene in the system prompt and exactly one pinned User Description; empty fields stay empty", async () => {
  const { app, mock } = await makeApp({ dialogue_reply: () => reply("hello"), contemplation_prefetch: quietPrefetch });
  try {
    const a = app.createCharacter({ name: "A", ...described });
    app.dialogue.send(a.id, "hi");
    await waitFor(() => app.store.lastMessage(a.id)?.role === "character");
    const messages = mock.byPurpose("dialogue_reply")[0].body.messages;
    assert.match(messages[0].content, /CHARACTER DESCRIPTION \(who you are\):\nCHAR-DESC/);
    assert.match(messages[0].content, /SCENE DESCRIPTION [^\n]*not something anyone said and not an instruction\):\nSCENE-DESC/);
    assert.doesNotMatch(messages[0].content, /USER-DESC/, "no second copy in the system prompt");
    assert.equal(messages[1].role, "user");
    assert.match(messages[1].content, /^\[Pinned user self-description[^\]]*\]\nUSER-DESC$/);
    assert.equal(JSON.stringify(messages).split("USER-DESC").length, 2, "exactly one pinned self-description");
    assert.doesNotMatch(messages[1].content, /\[sent /, "untimestamped");
    const empty = app.createCharacter({ name: "E" });
    app.dialogue.send(empty.id, "hi");
    await waitFor(() => app.store.lastMessage(empty.id)?.role === "character");
    const emptyMessages = mock.byPurpose("dialogue_reply")[1].body.messages;
    assert.match(emptyMessages[0].content, /\(no description given\)/);
    assert.match(emptyMessages[0].content, /\(no scene given\)/);
    assert.match(emptyMessages[1].content, /\(The user has not written a self-description\.\)/);
  } finally { closeApp(app); }
});

test("C3/18: every Contemplation stage gets the three descriptions as labeled characterContext", async () => {
  const { app, mock } = await makeApp({
    contemplation_prefetch: () => ({ generation: true, maintenance: true }),
    contemplation_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    contemplation_consolidation: identityConsolidation,
    contemplation_maintenance: unchanged,
    contemplation_generation: () => ({ decision: "add", text: "A new angle." }),
    contemplation_generation_review: () => ({ accept: true, problem: null }),
    contemplation_gestaltization: () => ({ gestalt: "Whole." }),
    contemplation_experiment_planning: () => ({ experiments: [] }),
    dialogue_reply: () => reply("ok")
  });
  try {
    const a = app.createCharacter({ name: "A", ...described });
    const pool = seedPool(app, a, ["One."]);
    app.store.insertMemory({ pool, tier: "ltm", topic: "t", summary: "s", retrievalBrief: "", importance: 0.5, sources: [] });
    app.store.setPlanningNeeded(pool, true);
    app.dialogue.send(a.id, "hello");
    await waitFor(() => app.store.lastMessage(a.id)?.role === "character");
    await waitFor(() => mock.byPurpose("contemplation_experiment_planning").length === 1);
    await app.contemplation.idle(pool);
    const stages = ["contemplation_prefetch", "contemplation_consolidation", "contemplation_memory_retrieval", "contemplation_maintenance", "contemplation_generation",
      "contemplation_generation_review", "contemplation_gestaltization", "contemplation_experiment_planning"];
    for (const purpose of stages) {
      const calls = mock.byPurpose(purpose);
      assert.ok(calls.length, purpose);
      for (const call of calls) assert.deepEqual(payloadOf(call).characterContext, contextOf("A"), purpose);
    }
    for (const prompt of [prefetchSystemPrompt(), consolidationSystemPrompt(), maintenanceSystemPrompt(), generationSystemPrompt(), generationReviewSystemPrompt(), gestaltizationSystemPrompt(), experimentPlanningSystemPrompt()]) {
      assert.match(prompt, /characterContext holds three texts written by the user/);
      assert.match(prompt, /never complete an experiment/);
    }
  } finally { closeApp(app); }
});

test("C3/19: STM, LTM and retrieval use the owner's Dialogue configuration and get the descriptions as framing, never as a source", async () => {
  const { app, mock } = await makeApp({
    memory_stm_consolidation: () => ({ shortTermMemoriesToUpsert: [], shortTermMemoriesToAdd: [], stmRepartitions: [] }),
    memory_ltm_consolidation: (body) => {
      const ids = payloadOf({ body }).consumableShortTermMemories.map((entry) => entry.id);
      return { longTermMemoriesToUpsert: [], longTermMemoriesToAdd: [], retirementGroups: [{ stmIds: ids, disposition: "safe_to_forget", representedByLtmRefs: [], reason: "routine" }] };
    }
  });
  try {
    const a = app.createCharacter({ name: "A", ...described, config: { models: { dialogue: "vendor/a-dialogue", contemplation: "vendor/a-contemplation" }, contemplationEnabled: false } });
    seedMessages(app, a.id, 100);
    await app.memory.maybeConsolidate(a.id);
    const stm = mock.byPurpose("memory_stm_consolidation")[0];
    assert.equal(stm.body.model, "vendor/a-dialogue");
    assert.deepEqual(payloadOf(stm).characterContext, contextOf("A"));
    app.store.insertMemory({ pool: poolOf(a), tier: "stm", scopeCharacterId: a.id, topic: "t", summary: "s", retrievalBrief: "", importance: 0.5, sources: [] });
    await app.memory.consolidatePoolLtm(poolOf(a));
    const ltm = mock.byPurpose("memory_ltm_consolidation")[0];
    assert.equal(ltm.body.model, "vendor/a-dialogue");
    assert.deepEqual(payloadOf(ltm).characterContext, contextOf("A"));
    for (const prompt of [stmSystemPrompt("A"), ltmSystemPrompt(), ltmSelectionSystemPrompt(), retrievalSystemPrompt("x")]) assert.match(prompt, /characterContext holds three texts/);
    assert.match(stmSystemPrompt("A"), /characterContext is never a memory source/);
  } finally { closeApp(app); }
});

test("C4/20: Vision gets the three descriptions besides image, verbatim and gestalt, and no memory, interpretations or experiments", async () => {
  const { app, mock } = await makeApp({ vision_observation: () => "The image shows a square.", dialogue_reply: () => reply("ok"), contemplation_prefetch: quietPrefetch,
    dialogue_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }) });
  try {
    const a = app.createCharacter({ name: "A", ...described, config: { contemplationEnabled: true } });
    const pool = seedPool(app, a, ["INTERPRETATION-TEXT"], ["EXPERIMENT-TEXT"]);
    app.store.setGestalt(pool, "GESTALT-TEXT", 0);
    app.store.insertMemory({ pool, tier: "ltm", topic: "LTM-TOPIC", summary: "LTM-SUMMARY", retrievalBrief: "", importance: 0.5, sources: [] });
    await app.dialogue.sendImage(a.id, "look", { image: PNG });
    await waitFor(() => app.store.lastTurn(a.id)?.role === "character");
    const call = mock.byPurpose("vision_observation")[0];
    const context = JSON.parse(call.body.messages[1].content[0].text);
    assert.deepEqual(Object.keys(context).sort(), ["characterContext", "conversation", "gestalt", "imageAttachedTo"]);
    assert.deepEqual(context.characterContext, contextOf("A"));
    assert.equal(context.gestalt.text, "GESTALT-TEXT");
    assert.doesNotMatch(JSON.stringify(call.body), /INTERPRETATION-TEXT|EXPERIMENT-TEXT|LTM-TOPIC|LTM-SUMMARY/);
    assert.match(visionSystemPrompt("A"), /a scene or self-description never makes something visible, never identifies a person/);
  } finally { closeApp(app); }
});

test("C5/21: the image prompt carries the descriptions as background only, omits empty fields, and never shortens anything", () => {
  const full = imagePrompt("a lighthouse at dusk", { characterName: "A", characterDescription: "CHAR-DESC", sceneDescription: "SCENE-DESC", userDescription: "USER-DESC" });
  assert.match(full, /^IMAGE REQUEST \(what to depict\):\na lighthouse at dusk\n\nBACKGROUND CONTEXT /);
  assert.match(full, /do not add these people, places or objects unless the request asks for them/);
  assert.match(full, /The character showing this image \(A\): CHAR-DESC\nThe scene of the conversation: SCENE-DESC\nThe viewer, as they describe themselves: USER-DESC$/);
  const partial = imagePrompt("x", { characterName: "A", characterDescription: "", sceneDescription: "SCENE", userDescription: "  " });
  assert.doesNotMatch(partial, /character showing|viewer/);
  assert.match(partial, /The scene of the conversation: SCENE$/);
  assert.equal(imagePrompt("x", { characterName: "A", characterDescription: "", sceneDescription: "", userDescription: "" }), "x", "no context block without context");
  assert.equal(imagePrompt("legacy", null), "legacy", "an image queued before Specification 0005 is sent as queued");
  const long = "s".repeat(20_000);
  assert.ok(imagePrompt("x", { characterName: "A", characterDescription: long, sceneDescription: long, userDescription: long }).length > 60_000);
});

test("C5 (owner decision Q1): a refused long prompt fails visibly with guidance and is never shortened", async () => {
  const seen = [];
  const images = async (url, init) => {
    if (url.endsWith("/endpoints")) return jsonResponse(200, { data: { endpoints: [] } });
    seen.push(JSON.parse(init.body));
    return jsonResponse(400, { error: { message: "prompt is too long" } });
  };
  const { app } = await makeApp({ dialogue_reply: () => reply("look", { imageRequest: "a lighthouse" }), contemplation_prefetch: quietPrefetch }, { images });
  try {
    const a = app.createCharacter({ name: "A", sceneDescription: "s".repeat(20_000), config: { imageEnabled: true } });
    app.dialogue.send(a.id, "draw");
    await waitFor(() => app.store.allImages()[0]?.status === "failed");
    assert.equal(seen.length, 1, "not retried with a shorter prompt");
    assert.ok(seen[0].prompt.includes("s".repeat(20_000)));
    assert.match(app.store.allImages()[0].errorMessage, /prompt is too long.*shorten the descriptions or choose another image model/);
  } finally { closeApp(app); }
});

test("C1/22: editing descriptions creates no chat turn, calls no model, and triggers no Maintenance", async () => {
  const { app, mock } = await makeApp({ contemplation_prefetch: quietPrefetch });
  try {
    const a = app.createCharacter({ name: "A", ...described });
    const pool = seedPool(app, a, ["One."]);
    seedMessages(app, a.id, 3);
    const calls = mock.calls.length;
    const { server, url } = await listen(app);
    try {
      const response = await fetch(`${url}/api/characters/${a.id}`, { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "A", description: "New.", sceneDescription: "A storm.", userDescription: "Someone else." }) });
      assert.equal(response.status, 200);
    } finally { server.close(); }
    await app.contemplation.idle(pool);
    assert.equal(app.store.messageCount(a.id), 3);
    assert.equal(mock.calls.length, calls);
    assert.equal(app.store.ensureInterpretationPool(pool).lastMaintenance, null);
    assert.deepEqual(app.store.interpretations(pool).map((entry) => entry.text), ["One."]);
  } finally { closeApp(app); }
});

// ---- F1-F3: Force and Maintenance status ----------------------------------------------------------------------------

test("F2/24/26: Force queues the existing stages once per kind and keeps each character's queue separate", async () => {
  const { gate, release } = gated();
  const { app } = await makeApp({
    contemplation_consolidation: async (body) => { await gate; return identityConsolidation(body); },
    contemplation_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    contemplation_maintenance: unchanged,
    contemplation_generation: () => ({ decision: "decline", text: null }),
    contemplation_gestaltization: () => ({ gestalt: "Whole." }),
    contemplation_experiment_planning: () => ({ experiments: [] })
  });
  try {
    const a = app.createCharacter({ name: "A" });
    const b = app.createCharacter({ name: "B" });
    const pool = seedPool(app, a, ["One."]);
    seedMessages(app, a.id, 2);
    // Review 0005 P2-B: each accepted request has an id; a duplicate click names the request it joined.
    assert.deepEqual(app.contemplation.force(pool, "maintenance", a.id), { queued: true, requestId: 1 });
    assert.deepEqual(app.contemplation.force(pool, "maintenance", a.id), { queued: false, reason: "running", requestId: 1 });
    assert.deepEqual(app.contemplation.force(pool, "generation", a.id), { queued: true, requestId: 2 });
    assert.deepEqual(app.contemplation.force(pool, "generation", a.id), { queued: false, reason: "already_queued", requestId: 2 });
    assert.throws(() => app.contemplation.force(pool, "maintenance", b.id), /A character is required/);
    const status = app.contemplation.status(pool);
    assert.equal(status.maintenance, "running");
    assert.equal(status.forcedRunning, "maintenance");
    assert.deepEqual(status.queued.forced, ["generation"]);
    assert.equal(status.lastMaintenance.status, "running", "accepted is never shown as succeeded");
    const other = app.contemplation.status(poolOf(b));
    assert.deepEqual([other.maintenance, other.forcedRunning, other.queued.forced, other.lastMaintenance], ["idle", null, [], null]);
    release();
    await app.contemplation.idle(pool);
    assert.equal(app.contemplation.status(pool).lastMaintenance.status, "unchanged");
    const { server, url } = await listen(app);
    try {
      const view = await (await fetch(`${url}/api/characters/${a.id}/contemplation/force`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "experimentation" }) })).json();
      assert.deepEqual(view.force, { queued: true, requestId: 3 });
      assert.equal(view.status.lastMaintenance.source, "forced");
    } finally { server.close(); }
  } finally { closeApp(app); }
});

test("F2/27 (owner decision Q2): Force runs with automatic Contemplation off, with gestalt and planning, and Dialogue still gets neither", async () => {
  const { app, mock } = await makeApp({
    contemplation_consolidation: identityConsolidation,
    contemplation_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    contemplation_maintenance: (body) => ({ action: "replace", text: `${payloadOf({ body }).interpretation.text} Revised.`, completedExperimentIds: [] }),
    contemplation_gestaltization: () => ({ gestalt: "FORCED-GESTALT" }),
    contemplation_experiment_planning: () => ({ experiments: [{ id: null, text: "FORCED-EXPERIMENT" }] }),
    dialogue_reply: () => reply("ok")
  });
  try {
    const a = app.createCharacter({ name: "A", config: { contemplationEnabled: false } });
    const pool = seedPool(app, a, ["One."]);
    seedMessages(app, a.id, 2);
    app.contemplation.force(pool, "maintenance", a.id);
    await app.contemplation.idle(pool);
    assert.deepEqual(app.store.interpretations(pool).map((entry) => entry.text), ["One. Revised."]);
    assert.equal(app.store.ensureInterpretationPool(pool).gestalt, "FORCED-GESTALT", "the forced run gestaltizes although automatic Contemplation is off");
    assert.deepEqual(app.store.experiments(pool).map((entry) => entry.text), ["FORCED-EXPERIMENT"]);
    const last = app.store.ensureInterpretationPool(pool).lastMaintenance;
    assert.deepEqual([last.status, last.source, last.interpretationsChanged], ["applied", "forced", 1]);
    app.dialogue.send(a.id, "hi");
    await waitFor(() => app.store.lastMessage(a.id)?.role === "character");
    assert.doesNotMatch(mock.byPurpose("dialogue_reply")[0].body.messages[0].content, /FORCED-GESTALT|FORCED-EXPERIMENT/);
    assert.equal(mock.byPurpose("contemplation_prefetch").length, 0);
  } finally { closeApp(app); }
});

test("F3/28: the last Maintenance attempt persists with time, outcome, source and reason, or is Never; a restart marks a run interrupted", async () => {
  const dataDir = tempDir();
  const { app } = await makeApp({
    contemplation_prefetch: () => ({ generation: false, maintenance: true }),
    contemplation_consolidation: identityConsolidation,
    contemplation_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    contemplation_maintenance: unchanged,
    contemplation_gestaltization: () => ({ gestalt: "Whole." }),
    contemplation_experiment_planning: () => ({ experiments: [] }),
    dialogue_reply: () => reply("ok")
  }, { dataDir });
  try {
    const a = app.createCharacter({ name: "A" });
    const pool = poolOf(a);
    assert.equal(app.contemplation.status(pool).lastMaintenance, null, "Never");
    app.contemplation.force(pool, "maintenance", a.id);
    await app.contemplation.idle(pool);
    let last = app.store.ensureInterpretationPool(pool).lastMaintenance;
    assert.deepEqual([last.status, last.source], ["skipped", "forced"]);
    assert.match(last.reason, /no interpretations/);
    seedPool(app, a, ["x".repeat(1200)]);
    configure(app, a.id, { maxTokens: { contemplation: 256 } });
    app.contemplation.force(pool, "maintenance", a.id);
    await app.contemplation.idle(pool);
    last = app.store.ensureInterpretationPool(pool).lastMaintenance;
    assert.deepEqual([last.status, last.code], ["skipped", "CONSOLIDATION_OUTPUT_EXCEEDED"]);
    assert.match(last.reason, /max tokens setting/);
    configure(app, a.id, { maxTokens: { contemplation: 16384 } });
    app.dialogue.send(a.id, "hello");
    await waitFor(() => app.store.ensureInterpretationPool(pool).lastMaintenance?.source === "automatic" && app.store.ensureInterpretationPool(pool).lastMaintenance.status !== "running");
    last = app.store.ensureInterpretationPool(pool).lastMaintenance;
    assert.equal(last.status, "unchanged");
    assert.ok(Date.parse(last.startedAt) <= Date.parse(last.finishedAt));
    await app.contemplation.idle(pool);
    app.store.setLastMaintenance(pool, { status: "running", source: "forced", startedAt: "2026-11-02T10:00:00.000Z", finishedAt: null });
  } finally { closeApp(app); }
  const { app: restarted } = await makeApp({}, { dataDir, key: false });
  try {
    const last = restarted.store.ensureInterpretationPool("character:1").lastMaintenance;
    assert.deepEqual([last.status, last.source, last.startedAt], ["interrupted", "forced", "2026-11-02T10:00:00.000Z"]);
    assert.match(last.reason, /nothing from it was applied/);
  } finally { closeApp(restarted); }
});

test("F1/F4/29: the page offers exactly the three Force runs through the force route, shows Maintenance status, and edits no text", () => {
  const source = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const start = source.indexOf("async function renderContemplation(");
  const page = source.slice(start, source.indexOf("// ---- main loop", start));
  for (const label of ["Force Maintenance", "Force Generation", "Force Experimentation"]) assert.ok(page.includes(`"${label}"`), label);
  assert.match(page, /\["maintenance", "Force Maintenance"\], \["generation", "Force Generation"\], \["experimentation", "Force Experimentation"\]/);
  assert.match(page, /"Last Maintenance", maintenanceText\(s\.lastMaintenance\)/);
  assert.match(page, /"Maintenance now", s\.maintenance/);
  assert.doesNotMatch(page, /textarea|\/interpretations|\/experiments|method: "(PUT|DELETE)"/);
  assert.match(source, /if \(!last\) return "Never";/);
  assert.doesNotMatch(source, /next Maintenance|scheduled for/i, "no predicted schedule");
});

// ---- A3 UI and section 4: editor and Ctrl+Enter ----------------------------------------------------------------------

test("A3/U: the editor groups Descriptions and AI Models; the global Settings page and About you are gone", () => {
  const source = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  for (const label of ["Character Description", "Scene Description", "User Description", "AI Models", "\"Dialogue\"", "\"Contemplation\"", "\"Vision\"", "Image Generation", "Refresh model list"]) assert.ok(source.includes(label), label);
  assert.match(source, /config: \{[^}]*\}|config \};/);
  assert.match(source, /state\.status\.defaultConfig/);
  assert.doesNotMatch(source, /About you|\/api\/settings|\/api\/user-description|renderSettings|#\/settings/);
  assert.doesNotMatch(html, /settings/i);
});

test("4/30/31: Ctrl+Enter alone runs the Send handler; IME composition, repeats, Meta and other modifiers are ignored", () => {
  const source = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const start = source.indexOf(`input.addEventListener("keydown"`);
  const handler = source.slice(start, source.indexOf("});", start));
  assert.ok(start > 0);
  assert.match(handler, /event\.key !== "Enter" \|\| !event\.ctrlKey \|\| event\.metaKey \|\| event\.altKey \|\| event\.shiftKey\) return;/);
  assert.match(handler, /event\.isComposing \|\| event\.keyCode === 229\) return;/);
  assert.match(handler, /event\.preventDefault\(\);\s*if \(event\.repeat\) return;\s*submit\(\);/);
  // submit is the Send button's handler and already refuses empty, pending or in-flight sends.
  assert.match(source, /sendButton\.addEventListener\("click", submit\)/);
  assert.match(source, /if \(\(!text && !attachment\) \|\| chatState\.pending \|\| sending\) return;\s*sending = true;/);
});

// ---- review 0005 regressions ----------------------------------------------------------------------------------------

test("review 0005 P2-A: a reply with an image keeps the profile it started with through Vision, retrieval, the reply and its image", async () => {
  const { gate, release } = gated();
  const seenImages = [];
  const images = async (url, init) => {
    if (url.endsWith("/endpoints")) return jsonResponse(200, { data: { endpoints: [] } });
    seenImages.push(JSON.parse(init.body));
    return jsonResponse(200, { data: [{ b64_json: PNG.toString("base64"), media_type: "image/png" }] });
  };
  const nameOf = (body) => /You are (\w+),/.exec(body.messages[0].content)?.[1];
  const { app, mock } = await makeApp({
    vision_observation: async (body, ctx) => { if (ctx.count === 1) await gate; return "The image shows a small square of color."; },
    dialogue_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    dialogue_reply: (body) => reply(`hi from ${nameOf(body)}`, { imageRequest: nameOf(body) === "A" ? "a lighthouse" : null }),
    contemplation_prefetch: quietPrefetch
  }, { images });
  try {
    const a = app.createCharacter({ name: "A", ...described, config: { models: { dialogue: "vendor/a-before", vision: "vendor/a-vision-before", image: "vendor/a-image-before" }, imageEnabled: true } });
    const b = app.createCharacter({ name: "B", ...described, config: { models: { dialogue: "vendor/b-dialogue" } } });
    for (const character of [a, b]) app.store.insertMemory({ pool: poolOf(character), tier: "ltm", topic: "t", summary: "s", retrievalBrief: "", importance: 0.5, sources: [] });
    const idleA = () => !app.dialogue.chat(a.id).pending && app.store.lastMessage(a.id)?.role === "character" && app.store.allImages().every((image) => image.status === "ready");
    await app.dialogue.sendImage(a.id, "look", { image: PNG });
    await waitFor(() => mock.byPurpose("vision_observation").length === 1, { message: "Vision in flight" });
    app.updateCharacter(a.id, { sceneDescription: "NEW-SCENE", userDescription: "NEW-USER",
      config: { models: { dialogue: "vendor/a-after", vision: "vendor/a-vision-after", image: "vendor/a-image-after" } } });
    app.dialogue.send(b.id, "meanwhile");
    await waitFor(() => app.store.lastMessage(b.id)?.role === "character" && !app.dialogue.chat(b.id).pending);
    release();
    await waitFor(() => idleA() && app.store.allImages().length === 1);

    const visionContext = (call) => JSON.parse(call.body.messages[1].content[0].text).characterContext;
    const forA = (purpose) => mock.byPurpose(purpose).filter((call) => (purpose === "dialogue_reply" ? nameOf(call.body) : payloadOf(call).characterContext.characterName) === "A");
    const [vision] = mock.byPurpose("vision_observation");
    assert.deepEqual([vision.body.model, visionContext(vision).sceneDescription, visionContext(vision).userDescription], ["vendor/a-vision-before", "SCENE-DESC", "USER-DESC"]);
    const [retrieval] = forA("dialogue_memory_retrieval");
    assert.deepEqual([retrieval.body.model, payloadOf(retrieval).characterContext.sceneDescription, payloadOf(retrieval).characterContext.userDescription], ["vendor/a-before", "SCENE-DESC", "USER-DESC"]);
    const [dialogue] = forA("dialogue_reply");
    assert.equal(dialogue.body.model, "vendor/a-before");
    assert.match(JSON.stringify(dialogue.body.messages), /SCENE-DESC[\s\S]*USER-DESC|USER-DESC[\s\S]*SCENE-DESC/);
    assert.doesNotMatch(JSON.stringify(dialogue.body.messages), /NEW-SCENE|NEW-USER/);
    assert.equal(seenImages[0].model, "vendor/a-image-before", "the image queued by that reply uses the same snapshot");
    assert.doesNotMatch(seenImages[0].prompt, /NEW-SCENE|NEW-USER/);
    assert.deepEqual(mock.byPurpose("dialogue_reply").filter((call) => nameOf(call.body) === "B").map((call) => call.body.model), ["vendor/b-dialogue"], "the concurrent character keeps its own values");

    // A newly started job takes the edited values everywhere.
    await app.dialogue.sendImage(a.id, "again", { image: PNG });
    await waitFor(() => forA("dialogue_reply").length === 2 && idleA() && app.store.allImages().length === 2);
    const vision2 = mock.byPurpose("vision_observation")[1];
    assert.deepEqual([vision2.body.model, visionContext(vision2).sceneDescription, visionContext(vision2).userDescription], ["vendor/a-vision-after", "NEW-SCENE", "NEW-USER"]);
    assert.equal(forA("dialogue_memory_retrieval")[1].body.model, "vendor/a-after");
    assert.equal(forA("dialogue_reply")[1].body.model, "vendor/a-after");
    assert.match(JSON.stringify(forA("dialogue_reply")[1].body.messages), /NEW-SCENE/);
    assert.equal(seenImages[1].model, "vendor/a-image-after");
    await app.contemplation.idle(poolOf(a));
    await app.contemplation.idle(poolOf(b));
  } finally { closeApp(app); }
});

test("review 0005 P2-B: Force Generation and Experimentation each report queued, running, then completed or failed, per character", async () => {
  const gates = { maintenance: gated(), generation: gated(), experimentation: gated() };
  let fail = false;
  const failing = () => jsonResponse(400, { error: { message: "provider refused" } });
  const { app } = await makeApp({
    contemplation_consolidation: async (body) => { await gates.maintenance.gate; return identityConsolidation(body); },
    contemplation_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    contemplation_maintenance: unchanged,
    contemplation_generation: async () => { await gates.generation.gate; return fail ? failing() : { decision: "decline", text: null }; },
    contemplation_gestaltization: () => ({ gestalt: "Whole." }),
    contemplation_experiment_planning: async () => { await gates.experimentation.gate; return fail ? failing() : { experiments: [{ id: null, text: "Ask about the sea." }] }; }
  });
  try {
    const a = app.createCharacter({ name: "A" });
    const b = app.createCharacter({ name: "B" });
    const pool = seedPool(app, a, ["One."]);
    seedMessages(app, a.id, 2);
    const force = (kind) => app.contemplation.force(pool, kind, a.id);
    const forceStatus = () => app.contemplation.status(pool).force;
    const states = () => Object.fromEntries(Object.entries(forceStatus()).map(([kind, entry]) => [kind, entry.state]));
    const untouched = Object.fromEntries(["maintenance", "generation", "experimentation"].map((kind) => [kind, { state: "idle", requestId: null, last: null }]));

    assert.deepEqual(force("maintenance"), { queued: true, requestId: 1 });
    assert.deepEqual(force("generation"), { queued: true, requestId: 2 });
    assert.deepEqual(force("experimentation"), { queued: true, requestId: 3 });
    assert.deepEqual(states(), { maintenance: "running", generation: "queued", experimentation: "queued" });
    assert.deepEqual(forceStatus().generation, { state: "queued", requestId: 2, last: null }, "accepted is never shown as completed");
    assert.deepEqual(app.contemplation.status(poolOf(b)).force, untouched);

    gates.maintenance.release();
    await waitFor(() => states().generation === "running");
    assert.deepEqual([forceStatus().maintenance.last.status, forceStatus().maintenance.last.result], ["completed", "unchanged"]);
    assert.equal(app.contemplation.status(pool).lastMaintenance.status, "unchanged", "the persisted Maintenance record is unchanged");
    assert.deepEqual(force("generation"), { queued: false, reason: "running", requestId: 2 });

    gates.generation.release();
    await waitFor(() => states().experimentation === "running");
    const generation = forceStatus().generation;
    assert.deepEqual([generation.state, generation.last.requestId, generation.last.status, generation.last.result, generation.last.characterId], ["idle", 2, "completed", "declined", a.id]);
    assert.ok(generation.last.queuedAt && generation.last.startedAt && generation.last.finishedAt);

    gates.experimentation.release();
    await app.contemplation.idle(pool);
    const experimentation = forceStatus().experimentation.last;
    assert.deepEqual([experimentation.requestId, experimentation.status, experimentation.result], [3, "completed", "committed"]);
    assert.deepEqual(app.store.experiments(pool).map((entry) => entry.text), ["Ask about the sea."]);

    // Failing runs: the new request shows the previous outcome only as previous, then its own failure with a reason.
    fail = true;
    gates.generation = gated();
    gates.experimentation = gated();
    assert.deepEqual(force("generation"), { queued: true, requestId: 4 });
    assert.deepEqual(force("experimentation"), { queued: true, requestId: 5 });
    const running = forceStatus().generation;
    assert.deepEqual([running.state, running.requestId, running.last.requestId, running.last.status], ["running", 4, 2, "completed"]);
    gates.generation.release();
    gates.experimentation.release();
    await app.contemplation.idle(pool);
    for (const [kind, id] of [["generation", 4], ["experimentation", 5]]) {
      const entry = forceStatus()[kind];
      assert.deepEqual([entry.state, entry.last.requestId, entry.last.status], ["idle", id, "failed"], kind);
      assert.ok(entry.last.code && entry.last.reason, `${kind} failure has a code and a reason`);
      assert.equal(entry.last.result, undefined);
    }
    assert.deepEqual(app.store.experiments(pool).map((entry) => entry.text), ["Ask about the sea."], "a failed review changes nothing");
    assert.deepEqual(app.contemplation.status(poolOf(b)).force, untouched, "B never sees A's runs");
    assert.doesNotMatch(JSON.stringify(app.contemplation.status(pool)), new RegExp(TEST_KEY));
  } finally { closeApp(app); }
});

test("review 0005 P2-B: a follow-up failure after a completed forced Maintenance is reported beside it; the page shows each kind's outcome", async () => {
  const { app } = await makeApp({
    contemplation_consolidation: identityConsolidation,
    contemplation_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    contemplation_maintenance: (body) => ({ action: "replace", text: `${payloadOf({ body }).interpretation.text} Revised.`, completedExperimentIds: [] }),
    contemplation_gestaltization: () => ({ gestalt: "Whole." }),
    contemplation_experiment_planning: () => jsonResponse(400, { error: { message: "planner refused" } })
  });
  try {
    const a = app.createCharacter({ name: "A" });
    const pool = seedPool(app, a, ["One."]);
    seedMessages(app, a.id, 2);
    app.contemplation.force(pool, "maintenance", a.id);
    await app.contemplation.idle(pool);
    const last = app.contemplation.status(pool).force.maintenance.last;
    assert.deepEqual([last.status, last.result, last.followUpError?.stage], ["completed", "applied", "experiment_planning"]);
    assert.equal(app.contemplation.status(pool).lastMaintenance.status, "applied");
  } finally { closeApp(app); }
  const page = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  assert.match(page, /forceText\(s\.force\?\.\[kind\]\)/);
  assert.match(page, /s\.force\?\.\[kind\]\?\.state/);
});
