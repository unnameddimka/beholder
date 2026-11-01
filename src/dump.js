// Emergency Dump: a best-effort ZIP of sanitized state and diagnostics. Adapted from Society src/dump.js (section
// producers that each fail independently, explicit-secret redaction of every entry, a manifest). It only reads: it
// never mutates state or cancels running work, so it stays usable while the server is busy.
import { buildStoredZip } from "./zip.js";
import { sanitize } from "./sanitize.js";
import { nowIso } from "./utils.js";

function json(value) { return JSON.stringify(value, null, 2) + "\n"; }

export function buildEmergencyDump(app) {
  const secrets = [app.key.get()].filter(Boolean);
  const files = {};
  const sections = {};
  const section = (filename, producer) => {
    try {
      files[filename] = json(sanitize(producer(), secrets));
      sections[filename] = { ok: true };
    } catch (error) {
      sections[filename] = { ok: false, error: String(error?.message || error) };
    }
  };
  const store = app.store;
  section("runtime.json", () => ({
    project: app.projectMeta, sourceCommitSha: app.buildInfo.sourceCommitSha, node: process.version, platform: process.platform, arch: process.arch,
    uptimeSeconds: Math.round(process.uptime()), processStartedAt: app.diagnostics.startedAt, schemaVersion: store.schemaVersion(),
    apiKeyConfigured: app.key.configured(), serverLocalDate: new Date().toString(), lastLtmDate: store.getMeta("lastLtmDate", null)
  }));
  section("settings.json", () => app.settings.get());
  section("user-description.json", () => ({ text: app.settings.userDescription() }));
  section("characters.json", () => store.listCharacters());
  section("messages.json", () => store.allMessages());
  section("images.json", () => store.allImages());
  // Uploaded images: metadata and perception state only; the original bytes stay in data/uploaded-images.
  section("uploads.json", () => store.allUploads());
  section("memory-pools.json", () => store.memoryPools());
  section("memory-records.json", () => store.allMemoryRecords());
  section("interpretation-pools.json", () => store.interpretationPools());
  section("interpretations.json", () => store.allInterpretations());
  section("experiments.json", () => store.allExperiments());
  section("contemplation-watermarks.json", () => store.allWatermarks());
  section("activity.json", () => app.activity());
  section("contemplation-runtime.json", () => app.contemplation.status());
  section("dialogue-runtime.json", () => app.dialogue.status());
  section("memory-runtime.json", () => app.memory.status());
  section("image-runtime.json", () => app.images.status());
  section("vision-runtime.json", () => app.vision.status());
  section("llm-exchanges.json", () => app.diagnostics.exchanges);
  section("in-flight-exchanges.json", () => app.diagnostics.pendingExchanges());
  section("errors.json", () => app.diagnostics.errors);
  section("events.json", () => app.diagnostics.events);
  section("frontend-errors.json", () => app.diagnostics.frontendErrors);
  const manifest = { schema: "beholder.emergency-dump", version: 1, exportedAt: nowIso(), sourceCommitSha: app.buildInfo.sourceCommitSha, sections };
  files["manifest.json"] = json(sanitize(manifest, secrets));
  return { zip: buildStoredZip(files), manifest };
}
