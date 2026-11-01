// Application composition: one Store, one in-memory key, and the services built on them. Kept separate from the
// HTTP layer so tests can drive the whole application with a mocked fetch.
import path from "node:path";
import fs from "node:fs";
import { Store, interpretationPoolOf, memoryPoolOf } from "./db.js";
import { SettingsStore, RuntimeKey, MODEL_ROLES } from "./settings.js";
import { Diagnostics } from "./diagnostics.js";
import { LlmClient } from "./llm.js";
import { MemoryEngine } from "./memory.js";
import { Contemplation } from "./contemplation.js";
import { ImageService } from "./images.js";
import { Dialogue } from "./dialogue.js";
import { Vision } from "./vision.js";
import { UploadFiles } from "./uploads.js";
import { verifyApiKey } from "./openrouter.js";
import { KeyedMutex, coded, msUntilNextLocalMidnight } from "./utils.js";

const NAME_MAX = 100;
const DESCRIPTION_MAX = 20_000;
const DAILY_CHECK_INTERVAL_MS = 60_000;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

export class BeholderApp {
  constructor({ dataDir, fetchImpl = fetch, now = () => new Date(), timeScaleMs = 1000, backoffMs = 1000, llmTimeouts = undefined, openerDelaySeconds = undefined,
    presenceTtlMs = undefined, maxParallel = 16, dnsLookup = undefined, stmRetryBackoffMs = undefined, ltmRetryBackoffMs = undefined, rootDir = process.cwd() }) {
    this.dataDir = dataDir;
    this.imagesDir = path.join(dataDir, "images");
    // User-uploaded originals (Specification 0003 F1), a sibling of the generated images on the same data volume.
    this.uploadsDir = path.join(dataDir, "uploaded-images");
    this.fetchImpl = fetchImpl;
    this.projectMeta = readJson(path.join(rootDir, "package.json"), {});
    this.projectMeta = { name: this.projectMeta.name || "beholder", version: this.projectMeta.version || null };
    const sha = readJson(path.join(rootDir, "build-info.json"), {}).sourceCommitSha;
    this.buildInfo = { sourceCommitSha: typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha) ? sha : "" };
    this.store = new Store(path.join(dataDir, "beholder.sqlite"));
    this.key = new RuntimeKey();
    this.settings = new SettingsStore(this.store);
    this.diagnostics = new Diagnostics({ secrets: () => [this.key.get()] });
    this.locks = new KeyedMutex();
    this.llm = new LlmClient({ settings: this.settings, key: this.key, diagnostics: this.diagnostics, fetchImpl, backoffMs, timeouts: llmTimeouts });
    this.memory = new MemoryEngine({ store: this.store, llm: this.llm, diagnostics: this.diagnostics, mutex: this.locks, now,
      ...(stmRetryBackoffMs !== undefined ? { stmRetryBackoffMs } : {}), ...(ltmRetryBackoffMs !== undefined ? { ltmRetryBackoffMs } : {}) });
    this.contemplation = new Contemplation({ store: this.store, llm: this.llm, memory: this.memory, settings: this.settings, diagnostics: this.diagnostics, maxParallel });
    this.uploads = new UploadFiles(this.uploadsDir);
    this.uploads.reconcile(this.store, this.diagnostics);
    this.vision = new Vision({ store: this.store, llm: this.llm, settings: this.settings, diagnostics: this.diagnostics, uploads: this.uploads });
    this.images = new ImageService({ store: this.store, settings: this.settings, key: this.key, diagnostics: this.diagnostics, fetchImpl, imagesDir: this.imagesDir, backoffMs: backoffMs * 2, ...(dnsLookup ? { lookupImpl: dnsLookup } : {}) });
    this.dialogue = new Dialogue({ store: this.store, llm: this.llm, memory: this.memory, contemplation: this.contemplation, images: this.images, vision: this.vision, uploads: this.uploads, settings: this.settings,
      diagnostics: this.diagnostics, now, timeScaleMs, ...(openerDelaySeconds !== undefined ? { openerDelaySeconds } : {}), ...(presenceTtlMs !== undefined ? { presenceTtlMs } : {}) });
    this.timers = [];
  }

  // Background schedules. Model-backed work needs the key, which exists only after entry in this process, so the
  // catch-up for missed STM -> LTM boundaries, contemplation recovery, and pending image perception start as soon as
  // the key is set.
  start() {
    const daily = () => { if (this.key.configured()) this.memory.runDailyIfDue().catch((error) => this.diagnostics.error("memory_ltm_schedule", error)); };
    const interval = setInterval(daily, DAILY_CHECK_INTERVAL_MS);
    interval.unref?.();
    this.timers.push(interval);
    const armMidnight = () => {
      const handle = setTimeout(() => { daily(); armMidnight(); }, msUntilNextLocalMidnight());
      handle.unref?.();
      this.timers[1] = handle;
    };
    armMidnight();
    // Records today as the first boundary on a fresh database so nothing is "missed" before first use.
    if (!this.store.getMeta("lastLtmDate", null)) this.memory.runDailyIfDue().catch(() => {});
  }

  stop() {
    for (const timer of this.timers) { clearInterval(timer); clearTimeout(timer); }
    this.dialogue.stop();
  }

  async setApiKey(apiKey) {
    const candidate = new RuntimeKey();
    candidate.set(apiKey);
    const check = await verifyApiKey({ apiKey: candidate.get(), fetchImpl: this.fetchImpl });
    if (!check.valid) throw coded("API_KEY_REJECTED", "OpenRouter rejected this API key.", { status: 400 });
    this.key.set(candidate.get());
    this.diagnostics.event({ type: "api-key-set", verified: check.verified });
    this.afterKey();
    return { configured: true, verified: check.verified };
  }

  afterKey() {
    this.llm.modelCatalog().catch(() => {});
    this.memory.runDailyIfDue().catch((error) => this.diagnostics.error("memory_ltm_schedule", error));
    for (const character of this.store.listCharacters()) this.memory.maybeConsolidate(character.id);
    this.contemplation.recover();
    this.dialogue.recoverPendingVision();
    this.images.resumePending();
  }

  // ---- characters --------------------------------------------------------------------------------------------

  validateCharacter(input) {
    const name = typeof input?.name === "string" ? input.name.trim() : "";
    const description = typeof input?.description === "string" ? input.description : "";
    if (!name || name.length > NAME_MAX) throw coded("CHARACTER_INVALID", `Name must be 1 to ${NAME_MAX} characters.`, { status: 400 });
    if (description.length > DESCRIPTION_MAX) throw coded("CHARACTER_INVALID", `Description must be at most ${DESCRIPTION_MAX} characters.`, { status: 400 });
    if (typeof input.useSharedMemory !== "boolean" || typeof input.useSharedInterpretations !== "boolean") throw coded("CHARACTER_INVALID", "Scope flags must be booleans.", { status: 400 });
    return { name, description, useSharedMemory: input.useSharedMemory, useSharedInterpretations: input.useSharedInterpretations };
  }

  createCharacter(input) {
    const character = this.store.createCharacter(this.validateCharacter(input));
    this.ensurePools(character);
    return character;
  }

  updateCharacter(id, input) {
    if (!this.store.getCharacter(id)) throw coded("CHARACTER_NOT_FOUND", "Character not found.", { status: 404 });
    const character = this.store.updateCharacter(id, this.validateCharacter(input));
    this.ensurePools(character);
    return character;
  }

  ensurePools(character) {
    this.store.ensureMemoryPool(memoryPoolOf(character));
    this.store.ensureInterpretationPool(interpretationPoolOf(character));
  }

  characterSummary(character) {
    const last = this.store.lastTurn(character.id);
    return { ...character, memoryPool: memoryPoolOf(character), interpretationPool: interpretationPoolOf(character), messageCount: this.store.messageCount(character.id),
      lastMessageAt: last?.createdAt || null, chat: this.dialogue.chatState(character.id) };
  }

  // ---- activity ----------------------------------------------------------------------------------------------

  activity() {
    const roles = this.diagnostics.roleActivity(MODEL_ROLES);
    const contemplation = this.contemplation.status();
    const dialogueChats = this.dialogue.status().chats.filter((chat) => chat.pending || chat.backgroundJobs);
    const memory = this.memory.status();
    const memoryRunning = memory.stmJobs.some((job) => job.status === "running") || memory.ltm.running;
    const errors = this.diagnostics.errors.slice(-5);
    return {
      working: Object.values(roles).some((role) => role.working) || contemplation.some((pool) => pool.running) || memoryRunning || this.images.inFlight.size > 0 || this.vision.inFlight.size > 0,
      apiKeyConfigured: this.key.configured(),
      roles,
      dialogue: dialogueChats,
      contemplation,
      memory,
      images: { inFlight: this.images.inFlight.size },
      vision: { inFlight: this.vision.inFlight.size },
      recentErrors: errors.map((entry) => ({ at: entry.at, stage: entry.stage, code: entry.code, message: String(entry.message).slice(0, 300) }))
    };
  }
}

