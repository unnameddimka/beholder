// Specification 0003: contextual Vision, typed image_observation verbatim entries, uploads, and the memory boundary.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeApp, closeApp, waitFor, reply, tempDir, seedMessages, jsonResponse, TEST_KEY } from "./helpers.js";
import { createServer } from "../src/server.js";
import { interpretationPoolOf, MIGRATIONS } from "../src/db.js";
import { defaultSettings } from "../src/settings.js";
import { messageView } from "../src/memory.js";
import { stmSystemPrompt } from "../src/prompts/memory.js";
import { visionSystemPrompt } from "../src/prompts/vision.js";
import { validateObservation } from "../src/vision.js";
import { parseMultipart, UPLOAD_MAX_BYTES } from "../src/uploads.js";
import { historyMessages } from "../src/prompts/dialogue.js";

const base = { name: "Mira", description: "Keeper.", useSharedMemory: false, useSharedInterpretations: false };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const OBSERVATION = "The image shows a person with short dark hair and round glasses, smiling, in front of a bookshelf.";
const quietPrefetch = () => ({ generation: false, maintenance: false });

async function listen(app) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function postImage(url, characterId, { text = "", bytes = PNG, type = "image/png", extra = null } = {}) {
  const form = new FormData();
  form.append("text", text);
  form.append("timeZone", "Europe/Kyiv");
  if (bytes) form.append("image", new Blob([bytes], { type }), "../../etc/selfie.png");
  if (extra) form.append(extra, "x");
  return fetch(`${url}/api/characters/${characterId}/messages`, { method: "POST", body: form });
}

const uploadFiles = (dataDir) => { try { return fs.readdirSync(path.join(dataDir, "uploaded-images")); } catch { return []; } };
const visionText = (call) => JSON.parse(call.body.messages[1].content[0].text);

// Writes an image turn directly: user message, upload, and (optionally) its observation.
async function imageTurn(app, characterId, { text = "Вот моё селфи", observed = true } = {}) {
  const file = await app.uploads.save(PNG, "image/png");
  const user = app.store.addMessage({ characterId, role: "user", kind: "user", text });
  const upload = app.store.insertUpload({ messageId: user.id, characterId, file, mime: "image/png", bytes: PNG.length });
  if (!observed) return { user, upload };
  const observation = app.store.addMessage({ characterId, role: "observation", kind: "image_observation", text: OBSERVATION, sourceMessageId: user.id });
  app.store.completeUpload(upload.id, { observationMessageId: observation.id, model: "m" });
  return { user, upload, observation };
}

test("settings migrate: an older saved settings object keeps every role and gains the Gemini 3 Flash Vision default", async () => {
  const dataDir = tempDir();
  const first = await makeApp({}, { dataDir, key: false });
  const old = defaultSettings();
  delete old.models.vision; delete old.temperature.vision; delete old.maxTokens.vision;
  Object.assign(old, { imageEnabled: true, contemplationEnabled: false });
  old.models.dialogue = "vendor/dialogue-x";
  old.models.contemplation = "vendor/contemplation-y";
  old.maxTokens.dialogue = 2048;
  first.app.store.setMeta("settings", old);
  closeApp(first.app);
  const { app } = await makeApp({}, { dataDir, key: false });
  try {
    const settings = app.settings.get();
    assert.equal(settings.models.vision, "google/gemini-3-flash-preview");
    assert.equal(settings.models.dialogue, "vendor/dialogue-x");
    assert.equal(settings.models.contemplation, "vendor/contemplation-y");
    assert.equal(settings.maxTokens.dialogue, 2048);
    assert.equal(settings.maxTokens.vision, 4096);
    assert.equal(settings.imageEnabled, true);
    assert.equal(settings.contemplationEnabled, false);
    const { server, url } = await listen(app);
    try {
      const status = await (await fetch(`${url}/api/status`)).json();
      assert.deepEqual(status.curatedVisionModels.map((model) => model.id), ["google/gemini-3-flash-preview", "qwen/qwen3-vl-235b-a22b-instruct", "google/gemini-3.1-flash-lite"]);
      assert.equal(status.uploadMaxBytes, UPLOAD_MAX_BYTES);
    } finally { server.close(); }
    app.settings.update({ models: { ...settings.models, vision: "qwen/qwen3-vl-235b-a22b-instruct" } });
    assert.equal(app.settings.get().models.vision, "qwen/qwen3-vl-235b-a22b-instruct");
    assert.equal(app.settings.get().models.dialogue, "vendor/dialogue-x");
  } finally { closeApp(app); }
});

test("migration: a schema-2 database keeps messages and generated images and gains typed verbatim and uploads", () => {
  const dir = tempDir();
  const db = new DatabaseSync(path.join(dir, "beholder.sqlite"));
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(MIGRATIONS[0]);
  db.exec(MIGRATIONS[1]);
  db.exec("PRAGMA user_version = 2");
  db.exec("INSERT INTO characters (name, created_at, updated_at) VALUES ('Mira', 'x', 'x')");
  db.exec("INSERT INTO messages (character_id, role, kind, text, created_at, active) VALUES (1, 'user', 'user', 'old', 'x', 0), (1, 'character', 'reply', 'art', 'x', 1)");
  db.exec("INSERT INTO images (message_id, character_id, status, request, model, created_at, updated_at) VALUES (2, 1, 'ready', 'r', 'm', 'x', 'x')");
  db.close();
  return import("../src/db.js").then(({ Store }) => {
    const store = new Store(path.join(dir, "beholder.sqlite"));
    try {
      assert.equal(store.schemaVersion(), MIGRATIONS.length);
      assert.deepEqual(store.allMessages().map((m) => [m.id, m.role, m.text, m.active]), [[1, "user", "old", false], [2, "character", "art", true]]);
      assert.equal(store.allImages()[0].messageId, 2);
      assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.throws(() => store.addMessage({ characterId: 1, role: "observation", kind: "image_observation", text: "no source" }));
    } finally { store.close(); }
  });
});

test("selfie: upload, one observation before the reply, exact Vision inputs, typed verbatim, and one Contemplation trigger", async () => {
  const order = [];
  const { app, mock, dataDir } = await makeApp({
    vision_observation: () => { order.push("vision"); return OBSERVATION; },
    dialogue_reply: () => { order.push("reply"); return reply("Nice glasses."); },
    dialogue_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    contemplation_prefetch: () => { order.push("prefetch"); return quietPrefetch(); }
  });
  const { server, url } = await listen(app);
  try {
    app.settings.setUserDescription("SELF-DESCRIPTION-TEXT");
    const mira = app.createCharacter(base);
    const pool = interpretationPoolOf(mira);
    app.settings.update({ contemplationEnabled: false });
    app.contemplation.addInterpretation(pool, "INTERPRETATION-TEXT");
    app.contemplation.addExperiment(pool, "EXPERIMENT-TEXT");
    app.store.setPlanningNeeded(pool, false);
    app.store.setGestalt(pool, "GESTALT-TEXT", app.store.ensureInterpretationPool(pool).interpretationRevision);
    app.settings.update({ contemplationEnabled: true });
    app.store.insertMemory({ pool: `character:${mira.id}`, tier: "stm", topic: "STM-TOPIC", summary: "STM-SUMMARY", retrievalBrief: "x", importance: 0.5, sources: [], scopeCharacterId: mira.id });
    app.store.insertMemory({ pool: `character:${mira.id}`, tier: "ltm", topic: "LTM-TOPIC", summary: "LTM-SUMMARY", retrievalBrief: "x", importance: 0.5, sources: [] });
    seedMessages(app, mira.id, 4);
    assert.equal(app.settings.get().imageEnabled, false, "image generation is off");

    const response = await postImage(url, mira.id, { text: "Вот моё селфи" });
    assert.equal(response.status, 200);
    await waitFor(() => app.store.lastTurn(mira.id).role === "character", { message: "reply" });
    await app.contemplation.idle(pool);

    // The original bytes under data/uploaded-images, apart from generated images.
    const [file] = uploadFiles(dataDir);
    assert.match(file, /^[0-9a-f]{32}\.png$/);
    assert.deepEqual(fs.readFileSync(path.join(dataDir, "uploaded-images", file)), PNG);
    assert.equal(fs.existsSync(path.join(dataDir, "images", file)), false);

    // Vision request: the image part, the whole active verbatim and the gestalt; nothing else.
    assert.equal(mock.byPurpose("vision_observation").length, 1);
    const visionCall = mock.byPurpose("vision_observation")[0];
    assert.equal(visionCall.body.model, "google/gemini-3-flash-preview");
    assert.deepEqual(visionCall.body.provider.ignore, ["alibaba", "Phala", "SiliconFlow", "GMICloud", "baidu"]);
    const parts = visionCall.body.messages[1].content;
    assert.equal(parts[1].type, "image_url");
    assert.equal(parts[1].image_url.url, `data:image/png;base64,${PNG.toString("base64")}`);
    const context = visionText(visionCall);
    assert.equal(context.conversation.messages.length, 5);
    assert.equal(context.conversation.messages.at(-1).text, "Вот моё селфи");
    assert.match(context.conversation.messages.at(-1).attachedImage, /not been viewed yet/);
    assert.equal(context.gestalt.text, "GESTALT-TEXT");
    assert.doesNotMatch(JSON.stringify(visionCall.body), /INTERPRETATION-TEXT|EXPERIMENT-TEXT|STM-TOPIC|STM-SUMMARY|LTM-TOPIC|LTM-SUMMARY|SELF-DESCRIPTION-TEXT/);

    // Perception precedes the reply and the single Contemplation trigger.
    assert.deepEqual(order.filter((step) => step !== "prefetch").slice(0, 2), ["vision", "reply"]);
    assert.ok(order.indexOf("prefetch") > order.indexOf("vision"));
    assert.equal(mock.byPurpose("contemplation_prefetch").length, 1);
    assert.equal(mock.byPurpose("dialogue_reply").length, 1);

    // One typed observation, linked to its user message.
    const rows = app.store.allMessages();
    const user = rows.find((row) => row.text === "Вот моё селфи");
    const observations = rows.filter((row) => row.role === "observation");
    assert.equal(observations.length, 1);
    assert.equal(observations[0].kind, "image_observation");
    assert.equal(observations[0].sourceMessageId, user.id);
    assert.equal(observations[0].text, OBSERVATION);
    assert.equal(app.store.uploadForMessage(user.id).status, "observed");

    // Dialogue sees the observation as its visual input, never the image.
    const dialogueBody = mock.byPurpose("dialogue_reply")[0].body;
    assert.doesNotMatch(JSON.stringify(dialogueBody), /image_url|base64/);
    assert.match(dialogueBody.messages[0].content, /IMAGES FROM THE USER/);
    const history = dialogueBody.messages.slice(2);
    assert.match(history.at(-2).content, /Вот моё селфи\n\[The user attached an image to this message\. Your observation of it follows\.\]/);
    assert.equal(history.at(-1).role, "user");
    assert.match(history.at(-1).content, /^\[viewed \d{4}-.*\]\n\[IMAGE OBSERVATION\]/);
    assert.ok(history.at(-1).content.endsWith(OBSERVATION));

    // Contemplation sees the typed entry.
    const prefetch = JSON.parse(mock.byPurpose("contemplation_prefetch")[0].body.messages[1].content);
    const typed = prefetch.conversation.messages.find((entry) => entry.type === "image_observation");
    assert.deepEqual(typed.imageAttachedTo, { id: `msg_${user.id}`, userText: "Вот моё селфи" });
    assert.equal(app.store.watermark(pool, mira.id), user.id);

    // The browser transcript shows the attachment, not the observation as an utterance.
    const chat = await (await fetch(`${url}/api/characters/${mira.id}/chat`)).json();
    assert.equal(chat.messages.some((message) => message.role === "observation"), false);
    const shown = chat.messages.find((message) => message.id === user.id);
    assert.deepEqual(shown.upload, { status: "observed", url: `/uploads/${file}`, observation: OBSERVATION });
    assert.equal(shown.image, null);
    assert.doesNotMatch(JSON.stringify(chat), /base64/);

    // Served only by its recorded name, with its verified type.
    const served = await fetch(`${url}/uploads/${file}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.equal(served.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);
    for (const bad of [`/uploads/${"0".repeat(32)}.png`, "/uploads/..%2Fbeholder.sqlite", "/uploads/../beholder.sqlite", `/images/${file}`]) {
      assert.equal((await fetch(`${url}${bad}`)).status, 404, bad);
    }

    // Dump and diagnostics keep metadata and text, never the image data.
    const dump = await (await fetch(`${url}/api/dump`)).arrayBuffer();
    const dumpText = Buffer.from(dump).toString("latin1");
    assert.doesNotMatch(dumpText, new RegExp(PNG.toString("base64").slice(0, 40).replace(/[+/]/g, "\\$&")));
    assert.match(dumpText, /uploads\.json/);
    assert.match(dumpText, new RegExp(file));
    assert.match(JSON.stringify(app.diagnostics.exchanges), /REDACTED_DATA_URL/);
  } finally { server.close(); closeApp(app); }
});

test("sends: image only and text only work; a message with nothing is refused; invalid or oversized uploads leave nothing behind", async () => {
  const { app, mock, dataDir } = await makeApp({ vision_observation: () => OBSERVATION, dialogue_reply: () => reply("ok"), contemplation_prefetch: quietPrefetch });
  const { server, url } = await listen(app);
  try {
    const mira = app.createCharacter(base);
    assert.equal((await postImage(url, mira.id)).status, 200);
    await waitFor(() => app.store.lastTurn(mira.id).role === "character");
    assert.equal(app.store.allMessages().find((m) => m.role === "user").text, "");

    const text = await fetch(`${url}/api/characters/${mira.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "plain" }) });
    assert.equal(text.status, 200);
    await waitFor(() => app.store.lastTurn(mira.id).role === "character" && mock.byPurpose("dialogue_reply").length === 2);
    assert.equal(mock.byPurpose("vision_observation").length, 1, "text-only sends need no Vision");

    const before = app.store.allMessages().length;
    const files = uploadFiles(dataDir).length;
    const empty = await fetch(`${url}/api/characters/${mira.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "  " }) });
    assert.equal(empty.status, 400);
    assert.equal((await postImage(url, mira.id, { bytes: null, text: "no image" })).status, 400);
    assert.equal((await postImage(url, mira.id, { bytes: Buffer.from("GIF89a-not-allowed-here"), type: "image/png" })).status, 415);
    assert.equal((await postImage(url, mira.id, { bytes: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), type: "image/svg+xml" })).status, 415);
    assert.equal((await postImage(url, mira.id, { extra: "path" })).status, 400);
    const oversized = Buffer.concat([PNG, Buffer.alloc(UPLOAD_MAX_BYTES)]);
    assert.equal((await postImage(url, mira.id, { bytes: oversized })).status, 413);
    assert.equal(app.store.allMessages().length, before, "no message from a rejected upload");
    assert.equal(uploadFiles(dataDir).length, files, "no file from a rejected upload");
    assert.equal(uploadFiles(dataDir).some((name) => name.endsWith(".part")), false);
  } finally { server.close(); closeApp(app); }
});

test("multipart parser: repeated, unknown and truncated parts are rejected", () => {
  const boundary = "XyZ";
  const part = (name, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const type = `multipart/form-data; boundary=${boundary}`;
  assert.deepEqual(parseMultipart(Buffer.from(`${part("text", "hi")}${part("timeZone", "UTC")}--${boundary}--\r\n`), type), { text: "hi", timeZone: "UTC" });
  assert.throws(() => parseMultipart(Buffer.from(`${part("image", "a")}${part("image", "b")}--${boundary}--`), type), /Only one image/);
  assert.throws(() => parseMultipart(Buffer.from(`${part("file", "a")}--${boundary}--`), type), /Unexpected/);
  assert.throws(() => parseMultipart(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\nno end`), type), /Truncated/);
  assert.throws(() => parseMultipart(Buffer.from("x"), "application/json"), /multipart/);
});

test("Vision failure: the message and file stay, zero observations, and Dialogue knows the image could not be viewed", async () => {
  const { app, mock } = await makeApp({
    vision_observation: () => jsonResponse(400, { error: { message: "image rejected" } }),
    dialogue_reply: () => reply("I couldn't see it, could you send it again?"),
    contemplation_prefetch: quietPrefetch
  });
  try {
    const mira = app.createCharacter(base);
    const message = await app.dialogue.sendImage(mira.id, "look", { image: PNG });
    await waitFor(() => app.store.lastTurn(mira.id).role === "character");
    const upload = app.store.uploadForMessage(message.id);
    assert.equal(upload.status, "failed");
    assert.equal(upload.errorCode, "PROVIDER_REQUEST_FAILED");
    assert.ok(app.uploads.exists(upload.file));
    assert.equal(app.store.allMessages().filter((m) => m.role === "observation").length, 0);
    const body = mock.byPurpose("dialogue_reply")[0].body;
    assert.match(body.messages.at(-1).content, /look\n\[The user attached an image to this message\. The attached image could not be viewed: you do not know what it shows\.\]/);
    assert.match(body.messages[0].content, /Never pretend you saw it/);
    assert.equal(mock.byPurpose("contemplation_prefetch").length, 1);
    assert.ok(app.diagnostics.errors.some((entry) => entry.stage === "vision_observation"));
    assert.equal(app.dialogue.chatState(mira.id).error, null, "a Vision failure is not a Dialogue failure");
  } finally { closeApp(app); }
});

test("an incompatible Vision model or an oversized context fails without a call and without substituting a model", async () => {
  const { app, mock } = await makeApp({ vision_observation: () => OBSERVATION, dialogue_reply: () => reply("ok"), contemplation_prefetch: quietPrefetch });
  try {
    await app.llm.modelCatalog();
    const model = app.settings.get().models.vision;
    app.llm.catalog.byId.set(model, { id: model, inputModalities: ["text"], outputModalities: ["text"], contextLength: 100_000, supportedParameters: null, maxCompletionTokens: null });
    const mira = app.createCharacter(base);
    const first = await app.dialogue.sendImage(mira.id, "", { image: PNG });
    await waitFor(() => app.store.lastTurn(mira.id).role === "character");
    assert.equal(app.store.uploadForMessage(first.id).errorCode, "VISION_MODEL_INCOMPATIBLE");

    app.llm.catalog.byId.set(model, { id: model, inputModalities: ["text", "image"], outputModalities: ["text"], contextLength: 5000, supportedParameters: null, maxCompletionTokens: null });
    const second = await app.dialogue.sendImage(mira.id, "again", { image: PNG });
    await waitFor(() => app.store.uploadForMessage(second.id).status !== "pending" && app.store.lastTurn(mira.id).role === "character");
    assert.equal(app.store.uploadForMessage(second.id).errorCode, "VISION_CONTEXT_EXCEEDED");
    assert.equal(mock.byPurpose("vision_observation").length, 0);
    assert.equal(app.settings.get().models.vision, model);
  } finally { closeApp(app); }
});

test("disabled Contemplation: Vision runs with image and verbatim only; the shared pool's gestalt is used when selected", async () => {
  const { app, mock } = await makeApp({ vision_observation: () => OBSERVATION, dialogue_reply: () => reply("ok") });
  try {
    const shared = app.createCharacter({ ...base, useSharedInterpretations: true });
    app.store.setGestalt("shared", "SHARED-GESTALT", 0);
    app.store.setGestalt(`character:${shared.id}`, "PRIVATE-GESTALT", 0);
    app.settings.update({ contemplationEnabled: false });
    await app.dialogue.sendImage(shared.id, "", { image: PNG });
    await waitFor(() => app.store.lastTurn(shared.id).role === "character");
    assert.equal(visionText(mock.byPurpose("vision_observation")[0]).gestalt, null);
    app.settings.update({ contemplationEnabled: true });
    app.contemplation.onUserMessage = () => null;
    await app.dialogue.sendImage(shared.id, "", { image: PNG });
    await waitFor(() => mock.byPurpose("dialogue_reply").length === 2);
    assert.equal(visionText(mock.byPurpose("vision_observation")[1]).gestalt.text, "SHARED-GESTALT");
  } finally { closeApp(app); }
});

test("Retry after an image turn reuses the observation, never repeats Vision, and is available while an observation is the last row", async () => {
  let failing = true;
  const { app, mock } = await makeApp({
    vision_observation: () => OBSERVATION,
    dialogue_reply: () => failing ? jsonResponse(400, { error: { message: "bad request" } }) : reply("Seen it."),
    contemplation_prefetch: quietPrefetch
  });
  try {
    const mira = app.createCharacter(base);
    const message = await app.dialogue.sendImage(mira.id, "selfie", { image: PNG });
    await waitFor(() => app.dialogue.chatState(mira.id).error);
    assert.equal(app.store.lastMessage(mira.id).role, "observation");
    assert.equal(app.dialogue.chatState(mira.id).retryAvailable, true);
    failing = false;
    assert.deepEqual(app.dialogue.retry(mira.id), { retrying: true, userMessageId: message.id });
    await waitFor(() => app.store.lastTurn(mira.id).role === "character");
    assert.equal(mock.byPurpose("vision_observation").length, 1);
    assert.equal(app.store.allMessages().filter((m) => m.role === "user").length, 1);
    assert.equal(app.store.allUploads().length, 1);
    assert.ok(mock.byPurpose("dialogue_reply").at(-1).body.messages.at(-1).content.endsWith(OBSERVATION));
    assert.equal(mock.byPurpose("contemplation_prefetch").length, 1, "Retry triggers no second Contemplation run");
  } finally { closeApp(app); }
});

test("restart: a pending perception is completed once with one reply; a superseded one is marked failed; files are reconciled", async () => {
  const dataDir = tempDir();
  let first = await makeApp({}, { dataDir, key: false });
  const mira = first.app.createCharacter(base);
  const nova = first.app.createCharacter({ ...base, name: "Nova" });
  const pendingTurn = await imageTurn(first.app, mira.id, { observed: false });
  const superseded = await imageTurn(first.app, nova.id, { observed: false });
  first.app.store.addMessage({ characterId: nova.id, role: "user", kind: "user", text: "later message" });
  const lost = await imageTurn(first.app, nova.id, { observed: false });
  fs.unlinkSync(first.app.uploads.filePath(lost.upload.file));
  fs.writeFileSync(path.join(dataDir, "uploaded-images", `${"a".repeat(32)}.png.part`), "partial");
  fs.writeFileSync(path.join(dataDir, "uploaded-images", `${"b".repeat(32)}.png`), "orphan");
  closeApp(first.app);

  const handlers = { vision_observation: () => OBSERVATION, dialogue_reply: () => reply("Hello again."), contemplation_prefetch: quietPrefetch };
  const { app, mock } = await makeApp(handlers, { dataDir, key: false });
  try {
    assert.equal(app.store.uploadForMessage(lost.user.id).errorCode, "UPLOAD_FILE_MISSING");
    assert.deepEqual(fs.readdirSync(path.join(dataDir, "uploaded-images")).sort(), [pendingTurn.upload.file, superseded.upload.file].sort());
    await app.setApiKey(TEST_KEY);
    await waitFor(() => app.store.lastTurn(mira.id).role === "character");
    assert.equal(mock.byPurpose("vision_observation").length, 1);
    assert.equal(mock.byPurpose("dialogue_reply").length, 1);
    assert.equal(app.store.uploadForMessage(pendingTurn.user.id).status, "observed");
    assert.equal(app.store.uploadForMessage(superseded.user.id).errorCode, "VISION_INTERRUPTED");
  } finally { closeApp(app); }
  const again = await makeApp(handlers, { dataDir });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(again.mock.byPurpose("vision_observation").length, 0, "no duplicate perception after another restart");
    assert.equal(again.app.store.allMessages().filter((m) => m.role === "observation").length, 1);
  } finally { closeApp(again.app); }
});

test("STM boundary: a pending image blocks consolidation; a split pair keeps provenance in the typed view; memory stays prose", async () => {
  let payload = null;
  const { app } = await makeApp({
    memory_stm_consolidation: (body) => {
      payload = JSON.parse(body.messages[1].content);
      const consumedUser = payload.messages.find((entry) => entry.attachedImage);
      return { shortTermMemoriesToUpsert: [], stmRepartitions: [], shortTermMemoriesToAdd: [{ topic: "Selfie", summary: "The user showed Mira a photo they called their selfie; the person pictured had short dark hair and round glasses.",
        retrievalBrief: "selfie photo", importance: 0.6, sourceMessageIds: [consumedUser.id], contextStmIds: [] }] };
    }
  });
  try {
    const nova = app.createCharacter({ ...base, name: "Nova" });
    seedMessages(app, nova.id, 99);
    await imageTurn(app, nova.id, { observed: false });
    assert.equal(app.store.activeCount(nova.id), 100);
    assert.equal(app.memory.maybeConsolidate(nova.id), null, "pending perception keeps the window");

    // The image message is the last consumed entry and its observation the first retained one.
    const mira = app.createCharacter(base);
    seedMessages(app, mira.id, 19);
    const turn = await imageTurn(app, mira.id);
    const observation = turn.observation;
    seedMessages(app, mira.id, 79);
    assert.equal(app.store.activeCount(mira.id), 100);
    const result = await app.memory.maybeConsolidate(mira.id);
    assert.equal(result.status, "applied");
    assert.deepEqual(payload.consumedMessageIds.at(-1), `msg_${turn.user.id}`);
    assert.ok(payload.retainedMessageIds.includes(`msg_${observation.id}`));
    const typed = payload.messages.find((entry) => entry.type === "image_observation");
    assert.deepEqual(typed.imageAttachedTo, { id: `msg_${turn.user.id}`, userText: "Вот моё селфи" });
    assert.equal(typed.speaker, undefined);
    const record = app.store.memoryRecords(`character:${mira.id}`, "stm")[0];
    assert.match(record.summary, /showed Mira a photo they called their selfie/);
    assert.deepEqual(Object.keys(record).sort(), ["createdAt", "id", "importance", "pool", "retrievalBrief", "scopeCharacterId", "sourceFrom", "sourceTo", "sources", "summary", "tier", "topic", "updatedAt"]);
    assert.equal(app.store.getMessage(observation.id).active, true);
    assert.equal(app.store.activeCount(mira.id), 80);
  } finally { closeApp(app); }
});

test("prompts: Vision forbids invention and interpretation; STM records showing, not telling; observations reject structured output", () => {
  const vision = visionSystemPrompt("Mira");
  for (const phrase of [/only to decide what to notice/, /must never change what you claim is in the image/, /Never invent details/, /Do not interpret/,
    /never state that the person is the user/, /uncertain instead of guessing/]) assert.match(vision, phrase);
  const stm = stmSystemPrompt("Mira");
  assert.match(stm, /The user showed Mira a photo they called their selfie/);
  assert.match(stm, /Never record the image content as something the user said/);
  assert.match(stm, /does not establish what the user looks like/);
  assert.equal(validateObservation("  ").ok, false);
  assert.equal(validateObservation("{\"observation\": \"x\"}").ok, false);
  assert.equal(validateObservation("x".repeat(7000)).ok, false);
  assert.deepEqual(validateObservation("```\nThe image shows a cat.\n```"), { ok: true, text: "The image shows a cat." });
});

test("an observation as the latest row: time is measured between turns, markers say viewed, follow-ups and openers are unaffected", async () => {
  const { app, mock } = await makeApp({ dialogue_followup: () => reply("Still looking at that photo."), dialogue_opener: () => reply("Hi.") });
  try {
    const mira = app.createCharacter(base);
    app.store.addMessage({ characterId: mira.id, role: "character", kind: "reply", text: "Show me." });
    const turn = await imageTurn(app, mira.id);
    const history = app.store.activeMessages(mira.id);
    const view = messageView(history.at(-1), "Mira");
    assert.equal(view.type, "image_observation");
    const formatted = historyMessages(history, new Map(), { timeZone: "UTC" });
    assert.match(formatted.at(-1).content, /^\[viewed /);
    assert.match(formatted.at(-2).content, /^\[sent /);
    assert.deepEqual(formatted.map((entry) => entry.role), ["assistant", "user", "user"]);
    assert.equal(app.dialogue.chatState(mira.id).retryAvailable, true);
    assert.equal(app.store.lastTurn(mira.id).id, turn.user.id);
    await app.dialogue.generate(mira.id, "followup");
    const system = mock.byPurpose("dialogue_followup")[0].body.messages[0].content;
    assert.match(system, /The latest chat message was sent/);
    // A chat whose only rows include an observation is not empty: no opener.
    app.dialogue.opened(mira.id);
    assert.equal(app.dialogue.chatState(mira.id).timer, null);
  } finally { closeApp(app); }
});
