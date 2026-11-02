import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeApp, closeApp, waitFor, reply, jsonResponse } from "./helpers.js";
import { parseImageResponse, detectRasterMime, selectImageOptions } from "../src/images.js";

// A minimal valid PNG signature followed by padding (signature checks only; no decoder is used).
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const base = { name: "Mira", description: "Keeper." };

function imageApi({ gate = null, viaUrl = false } = {}) {
  const seen = [];
  return {
    seen,
    handler: async (url, init) => {
      if (url.endsWith("/endpoints")) return jsonResponse(200, { data: { endpoints: [{ supported_parameters: { aspect_ratio: { type: "enum", values: ["1:1", "4:3"] }, quality: { type: "enum", values: ["low", "high"] } } }] } });
      if (url === "https://openrouter.ai/api/v1/images/models") return jsonResponse(404, {});
      seen.push(JSON.parse(init.body));
      if (gate) await gate;
      return jsonResponse(200, { data: [viaUrl ? { url: "https://cdn.example.test/tmp/abc.png" } : { b64_json: PNG.toString("base64"), media_type: "image/png" }] });
    }
  };
}

test("model-requested image is generated asynchronously after the text is committed and persisted as a file", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const api = imageApi({ gate });
  const { app, dataDir } = await makeApp({ dialogue_reply: () => reply("*holds up a sketch*", { imageRequest: "a pencil sketch of a lighthouse" }), contemplation_prefetch: () => ({ generation: false, maintenance: false }) }, { images: api.handler });
  try {
    const mira = app.createCharacter({ ...base, config: { imageEnabled: true } });
    app.dialogue.send(mira.id, "draw?");
    await waitFor(() => app.store.lastMessage(mira.id).role === "character");
    const message = app.store.lastMessage(mira.id);
    assert.equal(message.text, "*holds up a sketch*", "text is shown before the image exists");
    assert.equal(app.store.allImages()[0].status, "pending");
    release();
    await waitFor(() => app.store.allImages()[0].status === "ready", { message: "image ready" });
    const image = app.store.allImages()[0];
    assert.equal(image.messageId, message.id);
    assert.equal(image.mime, "image/png");
    assert.ok(!path.isAbsolute(image.file) && !image.file.includes("/"));
    assert.deepEqual(fs.readFileSync(path.join(dataDir, "images", image.file)), PNG);
    // Specification 0005 C5: the Dialogue model's request first, then the character's descriptions as labeled background.
    assert.ok(api.seen[0].prompt.startsWith("IMAGE REQUEST (what to depict):\na pencil sketch of a lighthouse\n\nBACKGROUND CONTEXT "));
    assert.ok(api.seen[0].prompt.endsWith("The character showing this image (Mira): Keeper."));
    assert.equal(image.request, "a pencil sketch of a lighthouse", "the stored request stays what the Dialogue model wrote");
    // Only advertised options are sent.
    assert.equal(api.seen[0].aspect_ratio, "1:1");
    assert.equal(api.seen[0].output_format, undefined);
  } finally { closeApp(app); }
});

test("a temporary https URL is downloaded and persisted; failures keep the text message", async () => {
  const api = imageApi({ viaUrl: true });
  let downloadOk = true;
  const extra = async (url) => {
    if (url === "https://cdn.example.test/tmp/abc.png") return downloadOk ? new Response(PNG, { status: 200, headers: { "Content-Type": "image/png" } }) : new Response("gone", { status: 404 });
    throw new Error(`Unexpected ${url}`);
  };
  const { app } = await makeApp({ dialogue_reply: () => reply("look", { imageRequest: "x" }), contemplation_prefetch: () => ({ generation: false, maintenance: false }) }, { images: api.handler, extra });
  try {
    const mira = app.createCharacter({ ...base, config: { imageEnabled: true } });
    app.dialogue.send(mira.id, "a");
    await waitFor(() => app.store.allImages()[0]?.status === "ready");
    downloadOk = false;
    app.dialogue.send(mira.id, "b");
    await waitFor(() => app.store.allImages()[1]?.status === "failed");
    assert.equal(app.store.lastMessage(mira.id).text, "look");
    assert.equal(app.store.allImages()[1].errorCode, "IMAGE_DOWNLOAD_FAILED");
  } finally { closeApp(app); }
});

test("image response parsing enforces raster signatures and rejects non-https URLs", () => {
  assert.equal(detectRasterMime(PNG), "image/png");
  assert.throws(() => parseImageResponse({ data: [{ url: "http://insecure.example/x.png" }] }));
  assert.throws(() => parseImageResponse({ data: [] }));
  assert.ok(parseImageResponse({ data: [{ url: `data:image/png;base64,${PNG.toString("base64")}` }] }).base64);
  assert.deepEqual(selectImageOptions([]), {});
});
