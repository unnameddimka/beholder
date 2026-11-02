// Regression tests for docs/review/0000-beholder-review-9adf254.md findings P1-1, P1-2, P2-1 and P2-3.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, closeApp, waitFor, reply, seedMessages, jsonResponse, identityConsolidation } from "./helpers.js";
import { poolOf } from "../src/db.js";
import { validatePlanning } from "../src/contemplation.js";
import { checkDownloadUrl, isBlockedAddress } from "../src/images.js";

const base = { name: "Mira", description: "Keeper." };

function gated() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return { gate, release };
}

// Starts a forced stage and resolves once the pipeline is inside it (its model call is waiting on the gate).
async function forceAndWait(app, pool, kind, characterId, stage) {
  app.contemplation.force(pool, kind, characterId);
  await waitFor(() => app.contemplation.status(pool).stage === stage, { message: stage });
}

test("P1-1: a stale maintenance completion never deletes an experiment edited during maintenance", async () => {
  const { gate, release } = gated();
  const { app } = await makeApp({
    contemplation_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    contemplation_consolidation: identityConsolidation,
    contemplation_maintenance: async (body) => {
      await gate;
      const payload = JSON.parse(body.messages[1].content);
      return { action: "unchanged", text: null, completedExperimentIds: payload.activeExperiments.map((entry) => entry.id) };
    }
  });
  try {
    const mira = app.createCharacter(base);
    const pool = poolOf(mira);
    app.settings.update({ contemplationEnabled: false });
    app.contemplation.addInterpretation(pool, "Theory");
    const edited = app.contemplation.addExperiment(pool, "Original experiment");
    app.contemplation.addExperiment(pool, "Untouched experiment");
    seedMessages(app, mira.id, 2);
    await forceAndWait(app, pool, "maintenance", mira.id, "maintenance");
    app.contemplation.editExperiment(pool, edited, "MANUAL EDIT during maintenance");
    release();
    await app.contemplation.idle(pool);
    assert.deepEqual(app.store.experiments(pool).map((entry) => entry.text), ["MANUAL EDIT during maintenance"],
      "the unedited completed experiment is retired; the manually edited one survives");
  } finally { closeApp(app); }
});

test("P1-1: completions from a superseded interpretation result are not applied", async () => {
  const { gate, release } = gated();
  const { app } = await makeApp({
    contemplation_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    contemplation_consolidation: identityConsolidation,
    contemplation_maintenance: async (body) => {
      await gate;
      const payload = JSON.parse(body.messages[1].content);
      return { action: "replace", text: "Model rewrite", completedExperimentIds: payload.activeExperiments.map((entry) => entry.id) };
    }
  });
  try {
    const mira = app.createCharacter(base);
    const pool = poolOf(mira);
    app.settings.update({ contemplationEnabled: false });
    const interpretation = app.contemplation.addInterpretation(pool, "Theory");
    app.contemplation.addExperiment(pool, "Probe");
    seedMessages(app, mira.id, 2);
    await forceAndWait(app, pool, "maintenance", mira.id, "maintenance");
    app.contemplation.editInterpretation(pool, interpretation, "Manual theory");
    release();
    await app.contemplation.idle(pool);
    assert.deepEqual(app.store.interpretations(pool).map((entry) => entry.text), ["Manual theory"]);
    assert.deepEqual(app.store.experiments(pool).map((entry) => entry.text), ["Probe"]);
  } finally { closeApp(app); }
});

test("P1-2: generation re-reviews against the current pool after a concurrent edit, so a duplicate is not committed", async () => {
  const { gate, release } = gated();
  const reviews = [];
  const { app } = await makeApp({
    contemplation_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    contemplation_generation: async () => { await gate; return { decision: "add", text: "NEW THEORY" }; },
    contemplation_generation_review: (body) => {
      const payload = JSON.parse(body.messages[1].content);
      const existing = payload.existingInterpretations.map((entry) => entry.text);
      reviews.push(existing);
      return existing.includes(payload.candidate) ? { accept: false, problem: "duplicate" } : { accept: true, problem: null };
    }
  });
  try {
    const mira = app.createCharacter(base);
    const pool = poolOf(mira);
    app.settings.update({ contemplationEnabled: false });
    app.contemplation.addInterpretation(pool, "Old theory");
    seedMessages(app, mira.id, 2);
    await forceAndWait(app, pool, "generation", mira.id, "generation");
    app.contemplation.addInterpretation(pool, "NEW THEORY");
    release();
    await app.contemplation.idle(pool);
    assert.deepEqual(app.store.interpretations(pool).map((entry) => entry.text), ["Old theory", "NEW THEORY"]);
    assert.deepEqual(reviews, [["Old theory"], ["Old theory", "NEW THEORY"]]);
  } finally { closeApp(app); }
});

test("P1-2: a candidate still commits after a pool change when the re-review accepts it", async () => {
  const { gate, release } = gated();
  const { app, mock } = await makeApp({
    contemplation_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    contemplation_generation: async () => { await gate; return { decision: "add", text: "Distinct idea" }; },
    contemplation_generation_review: () => ({ accept: true, problem: null })
  });
  try {
    const mira = app.createCharacter(base);
    const pool = poolOf(mira);
    app.settings.update({ contemplationEnabled: false });
    seedMessages(app, mira.id, 2);
    await forceAndWait(app, pool, "generation", mira.id, "generation");
    app.contemplation.addInterpretation(pool, "Manual idea");
    release();
    await app.contemplation.idle(pool);
    assert.deepEqual(app.store.interpretations(pool).map((entry) => entry.text), ["Manual idea", "Distinct idea"]);
    assert.equal(mock.byPurpose("contemplation_generation_review").length, 2);
  } finally { closeApp(app); }
});

test("P2-3: experiment planning has no count limit", () => {
  const experiments = Array.from({ length: 120 }, (_, index) => ({ id: null, text: `intention ${index}` }));
  assert.equal(validatePlanning({ experiments }, new Set()).ok, true);
});

// P2-1: bounded streaming download and destination policy.
function urlImageApi() {
  return async (url) => {
    if (url.endsWith("/endpoints")) return jsonResponse(200, { data: { endpoints: [] } });
    return jsonResponse(200, { data: [{ url: "https://cdn.example.test/tmp/big.png" }] });
  };
}

test("P2-1: a download without Content-Length is aborted as soon as it exceeds the byte limit", async () => {
  let pulled = 0;
  const extra = async () => new Response(new ReadableStream({
    pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(1024 * 1024)); }
  }), { status: 200, headers: { "Content-Type": "image/png" } });
  const { app } = await makeApp({ dialogue_reply: () => reply("look", { imageRequest: "x" }), contemplation_prefetch: () => ({ generation: false, maintenance: false }) },
    { images: urlImageApi(), extra });
  try {
    app.settings.update({ imageEnabled: true });
    const mira = app.createCharacter(base);
    app.dialogue.send(mira.id, "a");
    await waitFor(() => app.store.allImages()[0]?.status === "failed", { timeout: 10_000, message: "image failure" });
    assert.equal(app.store.allImages()[0].errorCode, "IMAGE_TOO_LARGE");
    assert.ok(pulled <= 20, `reading stopped near the 16 MiB limit (pulled ${pulled} chunks of 1 MiB)`);
    assert.equal(app.store.lastMessage(mira.id).text, "look", "the text message is kept");
  } finally { closeApp(app); }
});

test("P2-1: provider URLs pointing at local or internal destinations are refused", async () => {
  const lookup = async (host) => [{ address: host === "evil.example" ? "10.0.0.5" : "93.184.216.34", family: 4 }];
  const refused = ["http://cdn.example.test/x.png", "https://127.0.0.1/x.png", "https://localhost/x.png", "https://[::1]/x.png", "https://192.168.1.10/x.png",
    "https://169.254.169.254/latest", "https://evil.example/x.png", "https://cdn.example.test:8443/x.png", "https://[::ffff:10.0.0.1]/x", "https://user:pw@cdn.example.test/x.png"];
  for (const url of refused) await assert.rejects(checkDownloadUrl(url, lookup), (error) => error.code === "IMAGE_URL_REFUSED", url);
  await checkDownloadUrl("https://cdn.example.test/tmp/a.png", lookup);
  assert.equal(isBlockedAddress("8.8.8.8"), false);
  assert.equal(isBlockedAddress("fd12::1"), true);
});
