import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";
import { makeApp, closeApp, waitFor, reply } from "./helpers.js";

async function withServer(app, fn) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test("HTTP API: key gate, characters, chat round trip, and status never expose the key", async () => {
  const { app } = await makeApp({ dialogue_reply: () => reply("*bows* Welcome."), contemplation_prefetch: () => ({ generation: false, maintenance: false }) }, { key: false });
  try {
    await withServer(app, async (base) => {
      const json = async (path, init = {}) => {
        const response = await fetch(base + path, { ...init, headers: { "Content-Type": "application/json" } });
        return { status: response.status, body: await response.json() };
      };
      assert.equal((await json("/api/status")).body.apiKeyConfigured, false);
      const created = await json("/api/characters", { method: "POST", body: JSON.stringify({ name: "Mira", description: "Keeper", useSharedMemory: true, useSharedInterpretations: true }) });
      assert.equal(created.status, 200);
      assert.equal((await json(`/api/characters/${created.body.id}/messages`, { method: "POST", body: JSON.stringify({ text: "hi" }) })).status, 409, "sending needs the key");
      const key = await json("/api/key", { method: "POST", body: JSON.stringify({ apiKey: "sk-or-v1-httptestkey00000000000000" }) });
      assert.equal(key.body.configured, true);
      const status = await json("/api/status");
      assert.equal(JSON.stringify(status.body).includes("httptestkey"), false);
      const sent = await json(`/api/characters/${created.body.id}/messages`, { method: "POST", body: JSON.stringify({ text: "<script>alert(1)</script> *waves*" }) });
      assert.equal(sent.status, 200);
      await waitFor(async () => (await json(`/api/characters/${created.body.id}/chat`)).body.messages.length === 2);
      const chat = (await json(`/api/characters/${created.body.id}/chat`)).body;
      assert.equal(chat.messages[0].text, "<script>alert(1)</script> *waves*", "text is stored verbatim; the client renders it as text");
      assert.equal(chat.character.pool, `character:${created.body.id}`, "legacy scope fields cannot select a shared pool");
      assert.equal("useSharedMemory" in chat.character || "useSharedInterpretations" in chat.character || "memoryPool" in chat.character, false);
      const activity = await json("/api/activity");
      assert.equal(activity.status, 200);
      assert.ok("dialogue" in activity.body.roles && "contemplation" in activity.body.roles && "image" in activity.body.roles);
      const dump = await fetch(`${base}/api/dump`);
      assert.equal(dump.headers.get("content-type"), "application/zip");
      assert.equal(Buffer.from(await dump.arrayBuffer()).includes(Buffer.from("httptestkey")), false);
    });
  } finally { closeApp(app); }
});

test("HTTP safety: static allowlist, no arbitrary file paths, payload limit, CSP header", async () => {
  const { app } = await makeApp({});
  try {
    await withServer(app, async (base) => {
      const index = await fetch(`${base}/`);
      assert.equal(index.status, 200);
      assert.match(index.headers.get("content-security-policy"), /default-src 'self'/);
      for (const path of ["/../package.json", "/images/..%2F..%2Fpackage.json", "/images/0123.png", "/src/server.js", "/data/beholder.sqlite"]) {
        assert.equal((await fetch(base + path)).status, 404, path);
      }
      const big = await fetch(`${base}/api/user-description`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "x".repeat(300_000) }) });
      assert.equal(big.status, 413);
    });
  } finally { closeApp(app); }
});
