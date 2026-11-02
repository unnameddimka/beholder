import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeApp, closeApp, waitFor, reply, TEST_KEY, tempDir, mockOpenRouter } from "./helpers.js";
import { buildEmergencyDump } from "../src/dump.js";
import { poolOf } from "../src/db.js";

function filesContain(dir, needle) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (filesContain(full, needle)) return true; }
    else if (fs.readFileSync(full).includes(Buffer.from(needle))) return true;
  }
  return false;
}

test("the API key lives only in process memory: not in SQLite, data files, dumps, or diagnostics; restart forgets it", async () => {
  const dataDir = tempDir();
  const { app } = await makeApp({ dialogue_reply: () => reply("Hello there."), contemplation_prefetch: () => ({ generation: false, maintenance: false }) }, { dataDir });
  const mira = app.createCharacter({ name: "Mira", description: "Keeper" });
  app.dialogue.send(mira.id, "hello");
  await waitFor(() => app.store.lastMessage(mira.id).role === "character");
  const { zip } = buildEmergencyDump(app);
  assert.equal(zip.includes(Buffer.from(TEST_KEY)), false);
  assert.equal(JSON.stringify(app.diagnostics.exchanges).includes(TEST_KEY), false);
  app.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  closeApp(app);
  assert.equal(filesContain(dataDir, TEST_KEY), false);
  const { app: restarted } = await makeApp({}, { dataDir, key: false, mock: mockOpenRouter({}) });
  try {
    assert.equal(restarted.key.configured(), false);
    assert.equal(restarted.store.transcript(mira.id).length, 2, "chats survive the restart");
  } finally { closeApp(restarted); }
});

test("Emergency Dump works while work is in flight and contains useful sanitized sections", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { app } = await makeApp({ dialogue_reply: async () => { await gate; return reply("done"); }, contemplation_prefetch: async () => { await gate; return { generation: false, maintenance: false }; } });
  try {
    const mira = app.createCharacter({ name: "Mira", description: "Keeper" });
    app.contemplation.addExperiment(poolOf(mira), "probe");
    app.dialogue.send(mira.id, "hello");
    await waitFor(() => app.diagnostics.pendingExchanges().some((entry) => entry.purpose === "dialogue_reply"));
    const { zip, manifest } = buildEmergencyDump(app);
    assert.ok(zip.length > 1000);
    for (const name of ["messages.json", "experiments.json", "memory-records.json", "llm-exchanges.json", "in-flight-exchanges.json", "activity.json", "errors.json", "runtime.json"]) {
      assert.equal(manifest.sections[name]?.ok, true, name);
    }
    assert.ok(zip.includes(Buffer.from("dialogue_reply")), "in-flight work metadata is included");
    assert.equal(app.dialogue.chatState(mira.id).pending?.kind, "reply", "the dump did not cancel or change the pending reply");
    release();
    await waitFor(() => app.store.lastMessage(mira.id).role === "character");
  } finally { closeApp(app); }
});
