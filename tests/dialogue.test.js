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

test("malformed envelope is repaired by the LLM and never committed raw", async () => {
  const { app, mock } = await makeApp({
    dialogue_reply: (body, { count }) => count === 1 ? "Sure! here is my answer without json" : reply("Repaired reply."),
    contemplation_prefetch: () => ({ generation: false, maintenance: false })
  });
  try {
    const mira = app.createCharacter(character());
    app.dialogue.send(mira.id, "hello");
    await waitFor(() => app.store.lastMessage(mira.id)?.role === "character");
    assert.equal(app.store.lastMessage(mira.id).text, "Repaired reply.");
    const repair = mock.byPurpose("dialogue_reply")[1].body.messages;
    assert.equal(repair.at(-2).role, "assistant");
    assert.match(repair.at(-1).content, /violates the required JSON contract/);
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
