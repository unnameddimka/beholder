import { test } from "node:test";
import assert from "node:assert/strict";
import { callOpenRouter } from "../src/openrouter.js";
import { Diagnostics } from "../src/diagnostics.js";
import { completion, jsonResponse, makeApp, closeApp, waitFor, reply } from "./helpers.js";

const KEY = "sk-or-v1-transporttestkey000000000000";

function sequence(responses) {
  let index = 0;
  const bodies = [];
  // Entries are factories so every attempt gets a fresh Response body.
  return { bodies, fetchImpl: async (url, init) => { bodies.push(JSON.parse(init.body)); const next = responses[Math.min(index++, responses.length - 1)](); if (next instanceof Error) throw next; return next; } };
}

test("transient 429 and 5xx are retried with backoff and then succeed", async () => {
  const mock = sequence([() => jsonResponse(429, { error: { message: "slow down" } }, { "Retry-After": "0" }), () => jsonResponse(503, { error: { message: "busy" } }), () => completion("hello")]);
  const result = await callOpenRouter({ apiKey: KEY, model: "a/b", messages: [{ role: "user", content: "x" }], maxTokens: 100, fetchImpl: mock.fetchImpl, backoffMs: 1 });
  assert.equal(result.content, "hello");
  assert.equal(mock.bodies.length, 3);
});

test("retries are bounded and 401 is never retried", async () => {
  const always = sequence([() => jsonResponse(500, { error: { message: "down" } })]);
  await assert.rejects(callOpenRouter({ apiKey: KEY, model: "a/b", messages: [], maxTokens: 10, fetchImpl: always.fetchImpl, backoffMs: 1 }), (error) => error.code === "PROVIDER_5XX");
  assert.equal(always.bodies.length, 3);
  const auth = sequence([() => jsonResponse(401, { error: { message: "bad key" } })]);
  await assert.rejects(callOpenRouter({ apiKey: KEY, model: "a/b", messages: [], maxTokens: 10, fetchImpl: auth.fetchImpl, backoffMs: 1 }), (error) => error.code === "AUTHENTICATION_FAILED");
  assert.equal(auth.bodies.length, 1);
});

test("network errors retry; the request never switches to another model", async () => {
  const mock = sequence([() => new TypeError("fetch failed"), () => completion("ok")]);
  await callOpenRouter({ apiKey: KEY, model: "chosen/model", messages: [], maxTokens: 10, fetchImpl: mock.fetchImpl, backoffMs: 1 });
  assert.deepEqual(mock.bodies.map((body) => body.model), ["chosen/model", "chosen/model"]);
});

test("temperature is sent only when enabled; max_tokens follows the per-role budget and catalogue limit", async () => {
  const { app, mock } = await makeApp({ dialogue_reply: () => reply("ok"), contemplation_prefetch: () => ({ generation: false, maintenance: false }) });
  try {
    await app.llm.modelCatalog();
    const mira = app.createCharacter({ name: "M", description: "" });
    app.dialogue.send(mira.id, "a");
    await waitFor(() => app.store.lastMessage(mira.id).role === "character");
    assert.equal("temperature" in mock.byPurpose("dialogue_reply")[0].body, false);
    assert.equal(mock.byPurpose("dialogue_reply")[0].body.max_tokens, 8192);
    app.settings.update({ models: { ...app.settings.get().models, dialogue: "test/dialogue" }, temperature: { ...app.settings.get().temperature, dialogue: { enabled: true, value: 1.1 } } });
    app.dialogue.send(mira.id, "b");
    await waitFor(() => mock.byPurpose("dialogue_reply").length === 2 && app.store.lastMessage(mira.id).role === "character");
    assert.equal(mock.byPurpose("dialogue_reply")[1].body.temperature, 1.1);
    assert.equal(mock.byPurpose("dialogue_reply")[1].body.max_tokens, 4096, "clamped to the catalogue's max completion tokens");
  } finally { closeApp(app); }
});

test("a truncated structured output gets one compact retry instead of being committed", async () => {
  const { app, mock } = await makeApp({
    dialogue_reply: (body, { count }) => count === 1 ? completion("{\"message\": \"half", { finishReason: "length" }) : completion(reply("complete")),
    contemplation_prefetch: () => ({ generation: false, maintenance: false })
  });
  try {
    const mira = app.createCharacter({ name: "M", description: "" });
    app.dialogue.send(mira.id, "a");
    await waitFor(() => app.store.lastMessage(mira.id).role === "character");
    assert.equal(app.store.lastMessage(mira.id).text, "complete");
    assert.match(mock.byPurpose("dialogue_reply")[1].body.messages.at(-1).content, /exhausted the output budget/);
  } finally { closeApp(app); }
});

test("diagnostics redact the key from requests", async () => {
  const diagnostics = new Diagnostics({ secrets: () => [KEY] });
  const mock = sequence([() => completion("echo")]);
  await callOpenRouter({ apiKey: KEY, model: "a/b", messages: [{ role: "user", content: `my key is ${KEY}` }], maxTokens: 10, fetchImpl: mock.fetchImpl, diagnostics, backoffMs: 1 });
  assert.doesNotMatch(JSON.stringify(diagnostics.exchanges), new RegExp(KEY));
});
