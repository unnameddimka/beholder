// Specification 0001: dialogue response reliability (R1-R4) and temporal context (T1-T3), with a mocked OpenRouter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, closeApp, waitFor, reply, completion, jsonResponse, sleep } from "./helpers.js";
import { poolOf } from "../src/db.js";
import { stripTimestampEcho, validTimeZone } from "../src/clock.js";

const base = { name: "Mira", description: "A sardonic lighthouse keeper." };
const CLIENT = "client-spec-0001";
const quietPrefetch = () => ({ generation: false, maintenance: false });

// A controllable server clock; the process time zone is irrelevant because localization uses the browser zone.
function clock(iso) {
  const state = { now: new Date(iso) };
  return { state, now: () => new Date(state.now) };
}

function setCreatedAt(app, messageId, iso) {
  app.store.db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(iso, messageId);
}

// Waits for the catalogue fetch that setting the key starts, then installs the test catalogue.
async function catalogue(app, entries) {
  await app.llm.modelCatalog();
  app.llm.catalog = { at: Date.now(), models: entries, byId: new Map(entries.map((entry) => [entry.id, entry])) };
}

function useDialogueModel(app, model) {
  app.settings.update({ models: { ...app.settings.get().models, dialogue: model } });
}

const lastCharacterText = (app, id) => app.store.lastMessage(id)?.role === "character" ? app.store.lastMessage(id).text : null;

// ---- response formatting ----------------------------------------------------------------------------------------

test("plain RP text: exactly one request, content and line breaks preserved, optional fields null, diagnostic emitted", async () => {
  const original = "*tilts her head, amused*\n\nNo dreams, then.\n*turns back to the lamp*";
  const { app, mock } = await makeApp({ dialogue_reply: () => original, contemplation_prefetch: quietPrefetch });
  try {
    const mira = app.createCharacter(base);
    app.store.addMessage({ characterId: mira.id, role: "character", kind: "reply", text: "\"Darling\"? Well, good morning." });
    app.dialogue.presence(CLIENT, { characterId: mira.id });
    app.dialogue.send(mira.id, "I don't dream usually.");
    await waitFor(() => lastCharacterText(app, mira.id) === original);
    assert.equal(mock.byPurpose("dialogue_reply").length, 1);
    assert.doesNotMatch(app.store.lastMessage(mira.id).text, /Darling/);
    assert.equal(app.dialogue.chatState(mira.id).timer, null, "a normalized reply schedules no follow-up");
    assert.equal(app.store.imagesForCharacter(mira.id).length, 0);
    const event = app.diagnostics.events.find((entry) => entry.type === "dialogue-plain-text-normalized");
    assert.ok(event, "normalization diagnostic");
    assert.equal(event.purpose, "dialogue_reply");
  } finally { closeApp(app); }
});

test("malformed JSON repair sees only the invalid output, contract and errors: no history, self-description, memory or experiments", async () => {
  const { app, mock } = await makeApp({
    dialogue_reply: (body, { count }) => count === 1 ? '{"message": "Half the answer", "followUpDelaySeconds": ' : reply("Repaired."),
    dialogue_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    contemplation_prefetch: quietPrefetch
  });
  try {
    app.settings.setUserDescription("PINNED-NURSE-DESCRIPTION");
    app.settings.update({ contemplationEnabled: false });
    const mira = app.createCharacter(base);
    app.contemplation.addExperiment(poolOf(mira), "EXPERIMENT-ABSURD-STORY");
    app.store.insertMemory({ pool: `character:${mira.id}`, tier: "ltm", topic: "MEMORY-TOPIC", summary: "MEMORY-SUMMARY", retrievalBrief: "x", importance: 0.5, sources: [] });
    app.settings.update({ contemplationEnabled: true });
    app.store.addMessage({ characterId: mira.id, role: "character", kind: "reply", text: "HISTORY-DARLING-SPEECH" });
    app.dialogue.send(mira.id, "hello");
    await waitFor(() => lastCharacterText(app, mira.id) === "Repaired.");
    assert.match(JSON.stringify(mock.byPurpose("dialogue_reply")[0].body.messages), /EXPERIMENT-ABSURD-STORY/, "the original request had the full context");
    const repair = mock.byPurpose("dialogue_reply")[1].body.messages;
    assert.deepEqual(repair.map((message) => message.role), ["system", "user"]);
    assert.match(repair[0].content, /message \(a non-empty string\), followUpDelaySeconds \(integer or null\), imageRequest \(string or null\)/);
    assert.match(repair[1].content, /Half the answer/);
    assert.match(repair[1].content, /Validation errors/);
    assert.doesNotMatch(JSON.stringify(repair), /HISTORY-DARLING-SPEECH|PINNED-NURSE-DESCRIPTION|MEMORY-SUMMARY|EXPERIMENT-ABSURD-STORY|\[sent /);
  } finally { closeApp(app); }
});

test("truncated prose follows truncation recovery and is never accepted as plain text", async () => {
  const { app, mock } = await makeApp({
    dialogue_reply: (body, { count }) => count === 1 ? completion("*starts a long story and then", { finishReason: "length" }) : completion(reply("The whole story.")),
    contemplation_prefetch: quietPrefetch
  });
  try {
    const mira = app.createCharacter(base);
    app.dialogue.send(mira.id, "tell me");
    await waitFor(() => lastCharacterText(app, mira.id) === "The whole story.");
    assert.equal(mock.byPurpose("dialogue_reply").length, 2);
    assert.match(mock.byPurpose("dialogue_reply")[1].body.messages.at(-1).content, /exhausted the output budget/);
    assert.equal(app.diagnostics.events.some((entry) => entry.type === "dialogue-plain-text-normalized"), false);
  } finally { closeApp(app); }
});

test("a complete plain-text answer after truncation recovery is accepted without repair", async () => {
  const { app, mock } = await makeApp({
    dialogue_reply: (body, { count }) => count === 1 ? completion("{\"message\": \"cut", { finishReason: "length" }) : completion("*shrugs* Short version: no."),
    contemplation_prefetch: quietPrefetch
  });
  try {
    const mira = app.createCharacter(base);
    app.dialogue.send(mira.id, "tell me");
    await waitFor(() => lastCharacterText(app, mira.id) === "*shrugs* Short version: no.");
    assert.equal(mock.byPurpose("dialogue_reply").length, 2);
  } finally { closeApp(app); }
});

test("exhausted repair: a prose repair result is not accepted, no character message, Retry answers once", async () => {
  let broken = true;
  const { app, mock } = await makeApp({
    dialogue_reply: (body, { count }) => !broken ? reply("Finally whole.") : count === 1 ? '{"message": "oops' : "Sure, here is the reply: *waves*",
    contemplation_prefetch: quietPrefetch
  });
  try {
    const mira = app.createCharacter(base);
    app.dialogue.send(mira.id, "first");
    await waitFor(() => app.dialogue.chatState(mira.id).error, { message: "final failure" });
    assert.equal(mock.byPurpose("dialogue_reply").length, 3, "original plus two bounded repairs");
    assert.equal(app.dialogue.chatState(mira.id).error.code, "AI_OUTPUT_INVALID");
    assert.deepEqual(app.store.transcript(mira.id).map((message) => message.role), ["user"]);
    broken = false;
    app.dialogue.retry(mira.id);
    await waitFor(() => lastCharacterText(app, mira.id) === "Finally whole.");
    assert.deepEqual(app.store.transcript(mira.id).map((message) => [message.role, message.text]), [["user", "first"], ["character", "Finally whole."]]);
  } finally { closeApp(app); }
});

test("valid envelope keeps image requests and follow-up scheduling", async () => {
  const { app } = await makeApp({
    dialogue_reply: () => reply("*holds up a sketch*", { followUpDelaySeconds: 50_000, imageRequest: "a pencil sketch of a lighthouse" }),
    contemplation_prefetch: quietPrefetch
  });
  try {
    app.settings.update({ imageEnabled: true });
    app.images.request = (input) => { app.images.requested = input; };
    const mira = app.createCharacter(base);
    app.dialogue.presence(CLIENT, { characterId: mira.id });
    app.dialogue.send(mira.id, "show me");
    await waitFor(() => lastCharacterText(app, mira.id) === "*holds up a sketch*");
    assert.equal(app.images.requested.prompt, "a pencil sketch of a lighthouse");
    assert.equal(app.dialogue.chatState(mira.id).timer?.kind, "followup");
  } finally { closeApp(app); }
});

test("capability routing: schema, JSON-object and prompt-only modes follow the catalogue and keep the selected model", async () => {
  const { app, mock } = await makeApp({ dialogue_reply: () => reply("hello"), contemplation_prefetch: quietPrefetch });
  try {
    await catalogue(app, [
      { id: "test/schema", supportedParameters: ["structured_outputs", "response_format"] },
      { id: "test/object", supportedParameters: ["response_format"] },
      { id: "test/plain", supportedParameters: ["temperature"] }
    ]);
    const mira = app.createCharacter(base);
    const expected = { "test/schema": "json_schema", "test/object": "json_object", "test/plain": undefined, "test/uncatalogued": undefined };
    for (const [model, format] of Object.entries(expected)) {
      useDialogueModel(app, model);
      const before = mock.byPurpose("dialogue_reply").length;
      app.dialogue.send(mira.id, `hi ${model}`);
      await waitFor(() => mock.byPurpose("dialogue_reply").length === before + 1 && app.store.lastMessage(mira.id)?.role === "character");
      const body = mock.byPurpose("dialogue_reply").at(-1).body;
      assert.equal(body.model, model);
      assert.equal(body.response_format?.type, format, model);
      assert.equal(body.provider.require_parameters, format ? true : undefined, model);
      const exchange = app.diagnostics.exchanges.filter((entry) => entry.purpose === "dialogue_reply").at(-1);
      assert.equal(exchange.responseFormatMode, format || "prompt", "the chosen mode is in diagnostics");
    }
  } finally { closeApp(app); }
});

test("a rejected format steps down within the same model, is remembered, and never leaks the key", async () => {
  const rejection = () => jsonResponse(404, { error: { message: "No endpoints found that can handle the requested parameters." } });
  const { app, mock } = await makeApp({
    dialogue_reply: (body) => body.response_format ? rejection() : completion(reply("Prompt-only reply.")),
    contemplation_prefetch: quietPrefetch
  });
  try {
    await catalogue(app, [{ id: "test/schema", supportedParameters: ["structured_outputs", "response_format"] }]);
    useDialogueModel(app, "test/schema");
    const mira = app.createCharacter(base);
    app.dialogue.send(mira.id, "hi");
    await waitFor(() => lastCharacterText(app, mira.id) === "Prompt-only reply.");
    const bodies = mock.byPurpose("dialogue_reply").map((call) => call.body);
    assert.deepEqual(bodies.map((body) => body.response_format?.type ?? "prompt"), ["json_schema", "json_object", "prompt"]);
    assert.ok(bodies.every((body) => body.model === "test/schema"), "the selected model is never switched");
    const downgrades = app.diagnostics.events.filter((entry) => entry.type === "dialogue-format-downgrade");
    assert.deepEqual(downgrades.map((entry) => [entry.from, entry.to]), [["json_schema", "json_object"], ["json_object", "prompt"]]);
    app.dialogue.send(mira.id, "again");
    await waitFor(() => mock.byPurpose("dialogue_reply").length === 4 && app.store.lastMessage(mira.id)?.role === "character");
    assert.equal("response_format" in mock.byPurpose("dialogue_reply")[3].body, false, "the downgrade is remembered");
    assert.doesNotMatch(JSON.stringify(app.diagnostics.exchanges), /testkeyABCDEF/);
  } finally { closeApp(app); }
});

test("other 4xx errors are not treated as format rejections", async () => {
  const { app, mock } = await makeApp({
    dialogue_reply: () => jsonResponse(400, { error: { message: "Context length exceeded." } }),
    contemplation_prefetch: quietPrefetch
  });
  try {
    await catalogue(app, [{ id: "test/schema", supportedParameters: ["structured_outputs"] }]);
    useDialogueModel(app, "test/schema");
    const mira = app.createCharacter(base);
    app.dialogue.send(mira.id, "hi");
    await waitFor(() => app.dialogue.chatState(mira.id).error);
    assert.equal(mock.byPurpose("dialogue_reply").length, 1);
    assert.equal(app.diagnostics.events.some((entry) => entry.type === "dialogue-format-downgrade"), false);
  } finally { closeApp(app); }
});

test("isolation: plain text from a non-dialogue purpose still goes through strict validation and repair", async () => {
  const { app, mock } = await makeApp({
    dialogue_reply: () => reply("ok"),
    contemplation_prefetch: (body, { count }) => count === 1 ? "I think maintenance is needed." : { generation: false, maintenance: false }
  });
  try {
    const mira = app.createCharacter(base);
    app.dialogue.send(mira.id, "hi");
    await waitFor(() => mock.byPurpose("contemplation_prefetch").length === 2);
    await app.contemplation.idle(poolOf(mira));
    assert.equal(app.contemplation.status(poolOf(mira)).lastCycle.status, "succeeded");
    assert.equal("response_format" in mock.byPurpose("contemplation_prefetch")[0].body, false);
    assert.equal(app.diagnostics.events.some((entry) => entry.type === "dialogue-plain-text-normalized"), false);
  } finally { closeApp(app); }
});

// ---- temporal context -------------------------------------------------------------------------------------------

test("message metadata: distinct original timestamps in order; roles and texts unchanged", async () => {
  const time = clock("2026-11-01T07:12:40Z");
  const { app, mock } = await makeApp({ dialogue_reply: () => reply("Morning."), contemplation_prefetch: quietPrefetch }, { appOptions: { now: time.now } });
  try {
    const mira = app.createCharacter(base);
    const first = app.store.addMessage({ characterId: mira.id, role: "user", kind: "user", text: "Good night!" });
    const second = app.store.addMessage({ characterId: mira.id, role: "character", kind: "reply", text: "*waves* Sleep well." });
    setCreatedAt(app, first.id, "2026-10-30T21:04:00.000Z");
    setCreatedAt(app, second.id, "2026-10-30T21:05:00.000Z");
    app.dialogue.send(mira.id, "Morning.", { timeZone: "Europe/Kyiv" });
    await waitFor(() => app.store.lastMessage(mira.id)?.role === "character");
    const messages = mock.byPurpose("dialogue_reply")[0].body.messages.slice(2);
    assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "user"]);
    assert.equal(messages[0].content, "[sent 2026-10-30T21:04:00Z | Fri 30 Oct 2026, 23:04 Europe/Kyiv (GMT+2)]\nGood night!");
    assert.equal(messages[1].content, "[sent 2026-10-30T21:05:00Z | Fri 30 Oct 2026, 23:05 Europe/Kyiv (GMT+2)]\n*waves* Sleep well.");
    assert.match(messages[2].content, /^\[sent \d{4}-[^\]]+\]\nMorning\.$/);
    assert.deepEqual(app.store.transcript(mira.id).slice(0, 2).map((message) => message.text), ["Good night!", "*waves* Sleep well."], "stored text is unchanged");
  } finally { closeApp(app); }
});

test("user versus server zone: Europe/Kyiv local time is labeled, not mistaken for UTC; elapsed time uses instants", async () => {
  const time = clock("2026-11-01T07:12:40Z");
  const { app, mock } = await makeApp({ dialogue_reply: () => reply("ok"), contemplation_prefetch: quietPrefetch }, { appOptions: { now: time.now } });
  try {
    const mira = app.createCharacter(base);
    const earlier = app.store.addMessage({ characterId: mira.id, role: "character", kind: "reply", text: "See you." });
    // Stored messages carry real creation instants, so the earlier one is placed 34 hours before the real now; the
    // gap to the user's new (latest) message is computed from instants.
    setCreatedAt(app, earlier.id, new Date(Date.now() - (34 * 60 + 1) * 60_000).toISOString());
    app.dialogue.send(mira.id, "back", { timeZone: "Europe/Kyiv" });
    await waitFor(() => app.store.lastMessage(mira.id)?.role === "character");
    const system = mock.byPurpose("dialogue_reply")[0].body.messages[0].content;
    assert.match(system, /it is now 2026-11-01T07:12:40Z \(Sun 1 Nov 2026, 09:12 Europe\/Kyiv \(GMT\+2\)\)/);
    assert.match(system, /The user's local time zone is Europe\/Kyiv\./);
    assert.match(system, /The latest chat message was sent [^,]+ ago, 1 day 10 hours after the message before it\./);
    assert.match(system, /reliable metadata/);
  } finally { closeApp(app); }
});

test("DST: instants around the Kyiv transition keep distinct absolute times and their own offsets", async () => {
  const time = clock("2026-10-25T02:00:00Z");
  const { app, mock } = await makeApp({ dialogue_reply: () => reply("ok"), contemplation_prefetch: quietPrefetch }, { appOptions: { now: time.now } });
  try {
    const mira = app.createCharacter(base);
    const before = app.store.addMessage({ characterId: mira.id, role: "user", kind: "user", text: "before" });
    const after = app.store.addMessage({ characterId: mira.id, role: "character", kind: "reply", text: "after" });
    setCreatedAt(app, before.id, "2026-10-25T00:30:00.000Z");
    setCreatedAt(app, after.id, "2026-10-25T01:30:00.000Z");
    app.dialogue.send(mira.id, "now", { timeZone: "Europe/Kyiv" });
    await waitFor(() => app.store.lastMessage(mira.id)?.role === "character");
    const [first, second] = mock.byPurpose("dialogue_reply")[0].body.messages.slice(2);
    assert.match(first.content, /^\[sent 2026-10-25T00:30:00Z \| Sun 25 Oct 2026, 03:30 Europe\/Kyiv \(GMT\+3\)\]/);
    assert.match(second.content, /^\[sent 2026-10-25T01:30:00Z \| Sun 25 Oct 2026, 03:30 Europe\/Kyiv \(GMT\+2\)\]/);
  } finally { closeApp(app); }
});

test("unavailable or invalid zone falls back to explicitly labeled UTC and generation succeeds", async () => {
  const time = clock("2026-11-01T07:12:40Z");
  const { app, mock } = await makeApp({ dialogue_reply: () => reply("ok"), contemplation_prefetch: quietPrefetch }, { appOptions: { now: time.now } });
  try {
    const mira = app.createCharacter(base);
    for (const timeZone of ["Mars/Olympus_Mons", null, "<script>"]) {
      const before = mock.byPurpose("dialogue_reply").length;
      app.dialogue.send(mira.id, `zone ${timeZone}`, { timeZone });
      await waitFor(() => mock.byPurpose("dialogue_reply").length === before + 1 && app.store.lastMessage(mira.id)?.role === "character");
      const messages = mock.byPurpose("dialogue_reply").at(-1).body.messages;
      assert.match(messages[0].content, /it is now 2026-11-01T07:12:40Z \(Sun 1 Nov 2026, 07:12 UTC\)/);
      assert.match(messages[0].content, /time zone is unknown, so all times are given in UTC; do not guess/);
      assert.match(messages.at(-1).content, /^\[sent [^\]]+ UTC\]\n/);
    }
    assert.equal(validTimeZone("Europe/Kyiv"), "Europe/Kyiv", "the browser spelling is kept");
    assert.equal(validTimeZone("Etc/UTC"), "UTC");
  } finally { closeApp(app); }
});

test("clock in all modes: reply, retry, follow-up and opener each use their own generation-time clock and session zone", async () => {
  const time = clock("2026-11-01T07:00:00Z");
  let failReply = true;
  const { app, mock } = await makeApp({
    dialogue_reply: () => failReply ? jsonResponse(500, { error: { message: "boom" } }) : completion(reply("Answer.", { followUpDelaySeconds: 30 })),
    dialogue_followup: () => reply("Still there?"),
    dialogue_opener: () => reply("*looks up* Oh, a visitor."),
    contemplation_prefetch: quietPrefetch
  }, { appOptions: { now: time.now, openerDelaySeconds: 20 } });
  const nowIn = (purpose, index = 0) => mock.byPurpose(purpose)[index].body.messages[0].content.match(/it is now (\S+) \(([^)]+\)?)\)/).slice(1);
  try {
    const mira = app.createCharacter(base);
    const nova = app.createCharacter({ ...base, name: "Nova" });
    // Opener: an empty chat opened from a browser in New York (US daylight saving ended at 06:00Z that day).
    app.dialogue.presence("client-opener-01", { characterId: nova.id, timeZone: "America/New_York" });
    await waitFor(() => app.store.messageCount(nova.id) === 1, { message: "opener" });
    assert.deepEqual(nowIn("dialogue_opener"), ["2026-11-01T07:00:00Z", "Sun 1 Nov 2026, 02:00 America/New_York (GMT-5)"]);
    // Reply fails, then Retry uses the clock and zone at retry time.
    app.dialogue.presence(CLIENT, { characterId: mira.id, timeZone: "Europe/Kyiv" });
    app.dialogue.send(mira.id, "hello", { timeZone: "Europe/Kyiv" });
    await waitFor(() => app.dialogue.chatState(mira.id).error);
    assert.deepEqual(nowIn("dialogue_reply", 0), ["2026-11-01T07:00:00Z", "Sun 1 Nov 2026, 09:00 Europe/Kyiv (GMT+2)"]);
    time.state.now = new Date("2026-11-01T08:30:00Z");
    failReply = false;
    app.dialogue.retry(mira.id, { timeZone: "Asia/Tokyo" });
    await waitFor(() => lastCharacterText(app, mira.id) === "Answer.");
    assert.deepEqual(nowIn("dialogue_reply", 3), ["2026-11-01T08:30:00Z", "Sun 1 Nov 2026, 17:30 Asia/Tokyo (GMT+9)"]);
    // Follow-up: fires later and reads the clock at its own generation time, in the active session's zone.
    time.state.now = new Date("2026-11-01T09:45:00Z");
    await waitFor(() => lastCharacterText(app, mira.id) === "Still there?", { message: "follow-up" });
    assert.deepEqual(nowIn("dialogue_followup"), ["2026-11-01T09:45:00Z", "Sun 1 Nov 2026, 11:45 Europe/Kyiv (GMT+2)"]);
  } finally { closeApp(app); }
});

test("autonomous messages use the most recently active session's zone", async () => {
  const time = clock("2026-11-01T07:00:00Z");
  const { app, mock } = await makeApp({ dialogue_opener: () => reply("Hello."), contemplation_prefetch: quietPrefetch },
    { appOptions: { now: time.now, openerDelaySeconds: 40 } });
  try {
    const mira = app.createCharacter(base);
    app.dialogue.presence("client-older-001", { characterId: mira.id, timeZone: "Asia/Tokyo" });
    await sleep(5);
    app.dialogue.presence("client-newer-001", { characterId: mira.id, timeZone: "Europe/Kyiv" });
    await waitFor(() => app.store.messageCount(mira.id) === 1, { message: "opener" });
    assert.match(mock.byPurpose("dialogue_opener")[0].body.messages[0].content, /Europe\/Kyiv/);
  } finally { closeApp(app); }
});

test("invariants: only Dialogue gets timestamps; no interpretation leaks; an echoed marker is stripped before commit", async () => {
  const time = clock("2026-11-01T07:12:40Z");
  const { app, mock } = await makeApp({
    dialogue_reply: () => reply("[sent 2026-11-01T07:12:40Z | Sun 1 Nov 2026, 09:12 Europe/Kyiv (GMT+2)] *smiles* Hi."),
    contemplation_prefetch: quietPrefetch
  }, { appOptions: { now: time.now } });
  try {
    const mira = app.createCharacter(base);
    app.contemplation.addInterpretation(poolOf(mira), "SECRET-INTERPRETATION");
    await app.contemplation.idle(poolOf(mira)).catch(() => {});
    app.dialogue.send(mira.id, "hi", { timeZone: "Europe/Kyiv" });
    await waitFor(() => lastCharacterText(app, mira.id) === "*smiles* Hi.");
    await app.contemplation.idle(poolOf(mira));
    assert.doesNotMatch(JSON.stringify(mock.byPurpose("dialogue_reply")[0].body), /SECRET-INTERPRETATION/);
    for (const call of mock.calls.filter((entry) => !entry.purpose.startsWith("dialogue_") || entry.purpose === "dialogue_memory_retrieval")) {
      assert.doesNotMatch(JSON.stringify(call.body), /\[sent \d{4}|it is now/, `${call.purpose} gets no temporal annotation`);
    }
    assert.ok(app.diagnostics.events.some((entry) => entry.type === "dialogue-timestamp-echo-stripped"));
    assert.deepEqual(stripTimestampEcho("*waves* [sent 2026-11-01T07:12:40Z | x] inside stays"), { text: "*waves* [sent 2026-11-01T07:12:40Z | x] inside stays", stripped: false });
  } finally { closeApp(app); }
});

// ---- review 0001 regressions ------------------------------------------------------------------------------------

test("review 0001 P1: bracketed or backtick-led RP prose is accepted verbatim with one request and no repair", async () => {
  const texts = ["[laughs softly] You're impossible.", "\x60whispers\x60 Not here.\n[glances at the door]", "He wrote \"message\": come back. *folds the note*"];
  const { app, mock } = await makeApp({ dialogue_reply: (body, { count }) => texts[count - 1], contemplation_prefetch: quietPrefetch });
  try {
    const mira = app.createCharacter(base);
    app.dialogue.presence(CLIENT, { characterId: mira.id });
    for (const [index, text] of texts.entries()) {
      app.dialogue.send(mira.id, `line ${index}`);
      await waitFor(() => lastCharacterText(app, mira.id) === text, { message: text });
      assert.equal(mock.byPurpose("dialogue_reply").length, index + 1, "exactly one Dialogue request per reply");
      assert.equal(app.dialogue.chatState(mira.id).timer, null);
    }
    assert.equal(app.diagnostics.events.filter((entry) => entry.type === "dialogue-plain-text-normalized").length, texts.length);
    assert.equal(app.diagnostics.events.some((entry) => entry.type === "llm-repair"), false);
  } finally { closeApp(app); }
});

test("review 0001 P1: malformed JSON arrays and code-fenced envelopes still go to repair", async () => {
  const broken = ['[{"message": "half"', "\x60\x60\x60json\n{\"message\": \"half\"", 'Here: {"message": "half", "imageRequest": ',
    // Re-review 0001: unbraced envelope fragments, bare and inside a json fence.
    '"message": "Hello there", "followUpDelaySeconds": null, "imageRequest": null',
    "\x60\x60\x60json\n\"message\": \"Hello there\", \"imageRequest\": null\n\x60\x60\x60"];
  let index = 0;
  const { app, mock } = await makeApp({ dialogue_reply: (body) => body.messages[0].content.startsWith("Repair only") ? reply(`Fixed ${index}.`) : broken[index], contemplation_prefetch: quietPrefetch });
  try {
    const mira = app.createCharacter(base);
    for (index = 0; index < broken.length; index += 1) {
      const before = mock.byPurpose("dialogue_reply").length;
      app.dialogue.send(mira.id, `try ${index}`);
      await waitFor(() => lastCharacterText(app, mira.id) === `Fixed ${index}.`, { message: broken[index] });
      assert.equal(mock.byPurpose("dialogue_reply").length, before + 2, "original plus one isolated repair");
      const repair = mock.byPurpose("dialogue_reply").at(-1).body.messages;
      assert.deepEqual(repair.map((message) => message.role), ["system", "user"]);
      assert.ok(repair[1].content.includes(broken[index]), "the repair sees the invalid output");
      assert.doesNotMatch(JSON.stringify(repair), /try \d/, "the repair sees no chat history");
    }
    assert.ok(app.store.transcript(mira.id).every((message) => !message.text.includes("followUpDelaySeconds")), "no raw envelope reaches the chat");
    assert.equal(app.diagnostics.events.some((entry) => entry.type === "dialogue-plain-text-normalized"), false);
  } finally { closeApp(app); }
});

test("review 0001 P2: a schema-only model steps down straight to prompt-only and never receives JSON-object mode", async () => {
  const { app, mock } = await makeApp({
    dialogue_reply: (body) => body.response_format ? jsonResponse(404, { error: { message: "No endpoints found that can handle the requested parameters." } }) : completion(reply("Plain mode.")),
    contemplation_prefetch: quietPrefetch
  });
  try {
    await catalogue(app, [{ id: "test/schema-only", supportedParameters: ["structured_outputs"] }]);
    useDialogueModel(app, "test/schema-only");
    const mira = app.createCharacter(base);
    app.dialogue.send(mira.id, "hi");
    await waitFor(() => lastCharacterText(app, mira.id) === "Plain mode.");
    app.dialogue.send(mira.id, "again");
    await waitFor(() => mock.byPurpose("dialogue_reply").length === 3 && app.store.lastMessage(mira.id)?.role === "character");
    const modes = mock.byPurpose("dialogue_reply").map((call) => call.body.response_format?.type ?? "prompt");
    assert.deepEqual(modes, ["json_schema", "prompt", "prompt"]);
    assert.ok(mock.byPurpose("dialogue_reply").every((call) => call.body.model === "test/schema-only"));
    const downgrades = app.diagnostics.events.filter((entry) => entry.type === "dialogue-format-downgrade");
    assert.deepEqual(downgrades.map((entry) => [entry.from, entry.to]), [["json_schema", "prompt"]]);
  } finally { closeApp(app); }
});

test("review 0001 minor: a direct Send with an invalid zone uses UTC, not another session's zone", async () => {
  const time = clock("2026-11-01T07:12:40Z");
  const { app, mock } = await makeApp({ dialogue_reply: () => reply("ok"), contemplation_prefetch: quietPrefetch }, { appOptions: { now: time.now } });
  try {
    const mira = app.createCharacter(base);
    app.dialogue.presence("client-other-0001", { characterId: mira.id, timeZone: "Asia/Tokyo" });
    for (const timeZone of ["Not/AZone", null]) {
      const before = mock.byPurpose("dialogue_reply").length;
      app.dialogue.send(mira.id, `zone ${timeZone}`, { timeZone });
      await waitFor(() => mock.byPurpose("dialogue_reply").length === before + 1 && app.store.lastMessage(mira.id)?.role === "character");
      const system = mock.byPurpose("dialogue_reply").at(-1).body.messages[0].content;
      assert.match(system, /07:12 UTC\)/);
      assert.doesNotMatch(system, /Asia\/Tokyo/);
    }
  } finally { closeApp(app); }
});
