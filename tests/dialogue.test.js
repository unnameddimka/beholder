import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, closeApp, waitFor, reply, completion, jsonResponse, sleep } from "./helpers.js";
import { interpretationPoolOf } from "../src/db.js";

const character = (overrides = {}) => ({ name: "Mira", description: "A sardonic lighthouse keeper.", useSharedMemory: false, useSharedInterpretations: false, ...overrides });

test("dialogue context: character prompt, pinned self-description first, experiments yes, interpretations never", async () => {
  const { app, mock } = await makeApp({
    dialogue_reply: () => reply("*nods* Hello."),
    contemplation_prefetch: () => ({ generation: false, maintenance: false })
  });
  try {
    app.settings.setUserDescription("I am a night-shift nurse who likes puzzles.");
    const mira = app.createCharacter(character());
    const pool = interpretationPoolOf(mira);
    app.contemplation.addInterpretation(pool, "SECRET-INTERPRETATION: the user is testing the character.");
    app.contemplation.addExperiment(pool, "Explore whether the user enjoys an absurd story.");
    await app.contemplation.idle(pool).catch(() => {});
    app.dialogue.send(mira.id, "Hi *waves*");
    await waitFor(() => app.store.lastMessage(mira.id)?.role === "character", { message: "reply" });
    const call = mock.byPurpose("dialogue_reply")[0];
    const serialized = JSON.stringify(call.body.messages);
    assert.match(call.body.messages[0].content, /sardonic lighthouse keeper/);
    assert.equal(call.body.messages[1].role, "user");
    assert.match(call.body.messages[1].content, /night-shift nurse/);
    assert.match(call.body.messages[1].content, /Pinned user self-description/);
    assert.match(serialized, /absurd story/);
    assert.doesNotMatch(serialized, /SECRET-INTERPRETATION/);
    assert.equal(call.body.messages.at(-1).content, "Hi *waves*");
    // The self-description is not a transcript message, so it is never consolidated as evidence.
    assert.ok(app.store.transcript(mira.id).every((message) => !message.text.includes("night-shift nurse")));
    assert.equal(app.store.lastMessage(mira.id).text, "*nods* Hello.");
  } finally { closeApp(app); }
});

test("contemplation disabled omits experiments from dialogue and schedules no prefetch", async () => {
  const { app, mock } = await makeApp({ dialogue_reply: () => reply("Okay.") });
  try {
    const mira = app.createCharacter(character());
    app.contemplation.addExperiment(interpretationPoolOf(mira), "Show unexpected tenderness.");
    app.settings.update({ contemplationEnabled: false });
    app.dialogue.send(mira.id, "hello");
    await waitFor(() => app.store.lastMessage(mira.id)?.role === "character");
    assert.doesNotMatch(JSON.stringify(mock.byPurpose("dialogue_reply")[0].body.messages), /tenderness/);
    assert.equal(mock.byPurpose("contemplation_prefetch").length, 0);
  } finally { closeApp(app); }
});

test("plain dialogue text is normalized without a repair request or repeated speech", async () => {
  const original = '*tilts her head, amused*\\n\\nNo dreams, just a mission to make me smile.';
  const { app, mock } = await makeApp({
    dialogue_reply: () => original,
    contemplation_prefetch: () => ({ generation: false, maintenance: false })
  });
  try {
    const mira = app.createCharacter(character());
    app.store.addMessage({ characterId: mira.id, role: "character", kind: "reply", text: '"Darling"? Well, good morning.' });
    app.dialogue.send(mira.id, "I don't dream usually.");
    await waitFor(() => app.store.lastMessage(mira.id)?.role === "character" && app.store.lastMessage(mira.id).text === original);
    assert.equal(mock.byPurpose("dialogue_reply").length, 1, "no LLM repair for valid roleplay text");
    assert.equal(app.store.lastMessage(mira.id).text, original);
    assert.doesNotMatch(app.store.lastMessage(mira.id).text, /Darling/);
    assert.equal(app.diagnostics.exchanges.filter((entry) => entry.purpose === "dialogue_reply").length, 1);
  } finally { closeApp(app); }
});

test("broken dialogue JSON is repaired without passing old dialogue turns", async () => {
  const { app, mock } = await makeApp({
    dialogue_reply: (body, { count }) => count === 1 ? '{"message":"Half the answer"' : reply("Repaired reply."),
    contemplation_prefetch: () => ({ generation: false, maintenance: false })
  });
  try {
    const mira = app.createCharacter(character());
    app.store.addMessage({ characterId: mira.id, role: "character", kind: "reply", text: 'Previous darling speech must not be repeated.' });
    app.dialogue.send(mira.id, "hello");
    await waitFor(() => app.store.lastMessage(mira.id)?.role === "character" && app.store.lastMessage(mira.id)?.text === "Repaired reply.");
    assert.equal(mock.byPurpose("dialogue_reply").length, 2);
    const repair = mock.byPurpose("dialogue_reply")[1].body.messages;
    assert.equal(repair.length, 2, "repair receives only the invalid output and the repair contract");
    assert.deepEqual(repair.map((m) => m.role), ["system", "user"]);
    assert.match(repair[0].content, /Repair only the invalid dialogue response/);
    assert.match(repair[1].content, /Half the answer/);
    assert.doesNotMatch(JSON.stringify(repair), /Previous darling speech/);
    assert.equal(app.store.lastMessage(mira.id).text, "Repaired reply.");
  } finally { closeApp(app); }
});

test("OpenRouter request asks supported providers for strict dialogue JSON schema", async () => {
  const { app, mock } = await makeApp({
    dialogue_reply: () => reply("hello"),
    contemplation_prefetch: () => ({ generation: false, maintenance: false })
  });
  try {
    await app.llm.modelCatalog();
    const mira = app.createCharacter(character());
    app.dialogue.send(mira.id, "hi");
    await waitFor(() => app.store.lastMessage(mira.id)?.role === "character");
    const body = mock.byPurpose("dialogue_reply")[0].body;
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.deepEqual(body.response_format.json_schema.schema.required,
      ["message", "followUpDelaySeconds", "imageRequest"]);
    assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
    assert.equal(body.provider.require_parameters, true);
    assert.equal("response_format" in mock.byPurpose("contemplation_prefetch")[0]?.body || {}, false,
      "non-dialogue structured work is not changed by this fix");
  } finally { closeApp(app); }
});

test("unsupported selected dialogue model keeps prompt validation without forced provider format", async () => {
  const { app, mock } = await makeApp({
    dialogue_reply: () => reply("hello"),
    contemplation_prefetch: () => ({ generation: false, maintenance: false })
  });
  try {
    await app.llm.modelCatalog();
    app.settings.update({ models: { ...app.settings.get().models, dialogue: "test/unsupported" } });
    const mira = app.createCharacter(character());
    app.dialogue.send(mira.id, "hi");
    await waitFor(() => app.store.lastMessage(mira.id)?.role === "character");
    const body = mock.byPurpose("dialogue_reply")[0].body;
    assert.equal("response_format" in body, false);
    assert.equal("require_parameters" in body.provider, false);
  } finally { closeApp(app); }
});

test("send is rejected while a reply is pending; final failure keeps the user message and Retry does not duplicate it", async () => {
  let fail = true;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { app, mock } = await makeApp({
    dialogue_reply: async () => { await gate; return fail ? jsonResponse(500, { error: { message: "boom" } }) : completion(reply("Finally.")); },
    contemplation_prefetch: () => ({ generation: false, maintenance: false })
  });
  try {
    const mira = app.createCharacter(character());
    app.dialogue.send(mira.id, "first");
    assert.throws(() => app.dialogue.send(mira.id, "second"), (error) => error.code === "REPLY_PENDING");
    release();
    await waitFor(() => app.dialogue.chatState(mira.id).error, { message: "final failure" });
    // Bounded transport retries: exactly three attempts for one logical request.
    assert.equal(mock.byPurpose("dialogue_reply").length, 3);
    assert.equal(app.store.transcript(mira.id).length, 1);
    assert.equal(app.dialogue.chatState(mira.id).retryAvailable, true);
    fail = false;
    app.dialogue.retry(mira.id);
    await waitFor(() => app.store.lastMessage(mira.id)?.role === "character");
    const transcript = app.store.transcript(mira.id);
    assert.deepEqual(transcript.map((message) => message.role), ["user", "character"]);
    assert.equal(transcript.filter((message) => message.text === "first").length, 1);
  } finally { closeApp(app); }
});

test("reply started in one chat finishes in the background after switching chats, without a follow-up", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { app } = await makeApp({
    dialogue_reply: async () => { await gate; return reply("Late answer.", { followUpDelaySeconds: 1 }); },
    contemplation_prefetch: () => ({ generation: false, maintenance: false })
  });
  try {
    const mira = app.createCharacter(character());
    const other = app.createCharacter(character({ name: "Oren" }));
    app.dialogue.presence("client-aaaaaaaa", { characterId: mira.id });
    app.dialogue.send(mira.id, "hello?");
    app.dialogue.presence("client-aaaaaaaa", { characterId: other.id });
    release();
    await waitFor(() => app.store.lastMessage(mira.id)?.role === "character");
    assert.equal(app.store.lastMessage(mira.id).text, "Late answer.");
    assert.equal(app.dialogue.chatState(mira.id).timer, null);
    await sleep(20);
    assert.equal(app.store.transcript(mira.id).length, 2);
  } finally { closeApp(app); }
});

test("image request is ignored entirely while image generation is disabled", async () => {
  const { app } = await makeApp({
    dialogue_reply: () => reply("Look!", { imageRequest: "a lighthouse at dawn" }),
    contemplation_prefetch: () => ({ generation: false, maintenance: false })
  });
  try {
    const mira = app.createCharacter(character());
    app.dialogue.send(mira.id, "show me");
    await waitFor(() => app.store.lastMessage(mira.id)?.role === "character");
    assert.equal(app.store.allImages().length, 0);
    assert.match(mockSystemPrompt(app), /image generation is not available/);
  } finally { closeApp(app); }
});

function mockSystemPrompt(app) {
  const exchange = app.diagnostics.exchanges.find((entry) => entry.purpose === "dialogue_reply");
  return exchange.request.messages[0].content;
}
