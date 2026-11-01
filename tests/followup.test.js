import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, closeApp, waitFor, reply, sleep } from "./helpers.js";

// timeScaleMs = 1 in tests: one "second" of delay is one millisecond. openerDelaySeconds is overridden per test.
const base = { name: "Mira", description: "Keeper.", useSharedMemory: false, useSharedInterpretations: false };
const CLIENT = "client-test-0001";

async function setup(handlers, appOptions = {}) {
  return makeApp({ contemplation_prefetch: () => ({ generation: false, maintenance: false }), ...handlers }, { appOptions: { openerDelaySeconds: 30, ...appOptions } });
}

test("an empty open chat produces at most one opener after the idle delay", async () => {
  const { app, mock } = await setup({ dialogue_opener: () => reply("*looks up* Oh, a visitor.", { followUpDelaySeconds: 5 }) });
  try {
    const mira = app.createCharacter(base);
    app.dialogue.presence(CLIENT, { characterId: mira.id });
    await waitFor(() => app.store.messageCount(mira.id) === 1, { message: "opener" });
    await sleep(60);
    app.dialogue.presence(CLIENT, { characterId: mira.id });
    await sleep(60);
    assert.equal(mock.byPurpose("dialogue_opener").length, 1);
    assert.equal(app.store.transcript(mira.id)[0].kind, "opener");
    assert.equal(app.dialogue.chatState(mira.id).timer, null, "an opener never schedules a further follow-up");
  } finally { closeApp(app); }
});

test("typing before the opener fires cancels it", async () => {
  const { app, mock } = await setup({ dialogue_opener: () => reply("Hello") }, { openerDelaySeconds: 80 });
  try {
    const mira = app.createCharacter(base);
    app.dialogue.presence(CLIENT, { characterId: mira.id });
    app.dialogue.presence(CLIENT, { characterId: mira.id, typingStarted: true, draftNonEmpty: true });
    await sleep(150);
    assert.equal(mock.byPurpose("dialogue_opener").length, 0);
  } finally { closeApp(app); }
});

test("a reply's integer delay schedules exactly one follow-up; follow-ups cannot chain; null schedules nothing", async () => {
  let delay = 20;
  const { app, mock } = await setup({
    dialogue_reply: () => reply("First answer.", { followUpDelaySeconds: delay }),
    dialogue_followup: () => reply("Still there?", { followUpDelaySeconds: 1 })
  });
  try {
    const mira = app.createCharacter(base);
    app.dialogue.presence(CLIENT, { characterId: mira.id });
    app.store.addMessage({ characterId: mira.id, role: "character", kind: "reply", text: "earlier" });
    app.dialogue.send(mira.id, "hello");
    await waitFor(() => app.store.transcript(mira.id).at(-1).kind === "followup", { message: "follow-up" });
    await sleep(80);
    assert.equal(mock.byPurpose("dialogue_followup").length, 1);
    assert.equal(app.store.transcript(mira.id).filter((m) => m.kind === "followup").length, 1);
    delay = null;
    app.dialogue.send(mira.id, "ok");
    await waitFor(() => app.store.lastMessage(mira.id).kind === "reply");
    await sleep(60);
    assert.equal(mock.byPurpose("dialogue_followup").length, 1);
  } finally { closeApp(app); }
});

test("typing, navigation, disconnect, or a new message cancels the follow-up and it is never reinstated", async () => {
  const { app, mock } = await setup({ dialogue_reply: () => reply("Answer.", { followUpDelaySeconds: 60 }), dialogue_followup: () => reply("follow") });
  try {
    const mira = app.createCharacter(base);
    const other = app.createCharacter({ ...base, name: "Oren" });
    app.store.addMessage({ characterId: mira.id, role: "character", kind: "reply", text: "earlier" });
    const cases = [
      () => app.dialogue.presence(CLIENT, { characterId: mira.id, typingStarted: true }),
      () => app.dialogue.presence(CLIENT, { characterId: other.id }),
      () => app.dialogue.leave(CLIENT)
    ];
    for (const cancel of cases) {
      app.dialogue.presence(CLIENT, { characterId: mira.id });
      app.dialogue.send(mira.id, "hi");
      await waitFor(() => app.dialogue.chatState(mira.id).timer, { message: "timer scheduled" });
      cancel();
      assert.equal(app.dialogue.chatState(mira.id).timer, null);
      app.dialogue.presence(CLIENT, { characterId: mira.id });
      await sleep(100);
      assert.equal(app.dialogue.chatState(mira.id).timer, null, "reopening does not reinstate a canceled timer");
    }
    assert.equal(mock.byPurpose("dialogue_followup").length, 0);
  } finally { closeApp(app); }
});

test("a send during follow-up generation discards the autonomous message (no extra message, no clobbering)", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { app } = await setup({
    dialogue_reply: (body, { count }) => reply(count === 1 ? "Answer one." : "Answer two.", { followUpDelaySeconds: count === 1 ? 5 : null }),
    dialogue_followup: async () => { await gate; return reply("late follow-up"); }
  });
  try {
    const mira = app.createCharacter(base);
    app.store.addMessage({ characterId: mira.id, role: "character", kind: "reply", text: "earlier" });
    app.dialogue.presence(CLIENT, { characterId: mira.id });
    app.dialogue.send(mira.id, "first");
    await waitFor(() => app.dialogue.chatState(mira.id).autonomousGenerating, { message: "follow-up generating" });
    app.dialogue.send(mira.id, "second");
    release();
    await waitFor(() => app.store.lastMessage(mira.id).text === "Answer two.");
    await sleep(30);
    assert.deepEqual(app.store.transcript(mira.id).map((m) => m.text), ["earlier", "first", "Answer one.", "second", "Answer two."]);
  } finally { closeApp(app); }
});

test("a lapsed heartbeat counts as disconnect", async () => {
  const { app, mock } = await setup({ dialogue_reply: () => reply("A", { followUpDelaySeconds: 200 }), dialogue_followup: () => reply("f") }, { presenceTtlMs: 40 });
  try {
    const mira = app.createCharacter(base);
    app.store.addMessage({ characterId: mira.id, role: "character", kind: "reply", text: "earlier" });
    app.dialogue.presence(CLIENT, { characterId: mira.id });
    app.dialogue.send(mira.id, "hi");
    await waitFor(() => app.dialogue.chatState(mira.id).timer);
    await sleep(300);
    assert.equal(mock.byPurpose("dialogue_followup").length, 0);
  } finally { closeApp(app); }
});
