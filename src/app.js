// Application composition: one Store, one in-memory key, and the services built on them. Kept separate from the
// HTTP layer so tests can drive the whole application with a mocked fetch.
import path from "node:path";
import fs from "node:fs";
import { Store, poolOf } from "./db.js";
import { RuntimeKey, MODEL_ROLES, DESCRIPTION_MAX, DESCRIPTION_FIELDS, defaultConfig, mergeConfig } from "./settings.js";
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
const DESCRIPTION_LABELS = Object.freeze({ description: "Character Description", sceneDescription: "Scene Description", userDescription: "User Description" });
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
    this.diagnostics = new Diagnostics({ secrets: () => [this.key.get()] });
    this.locks = new KeyedMutex();
    this.llm = new LlmClient({ key: this.key, diagnostics: this.diagnostics, fetchImpl, backoffMs, timeouts: llmTimeouts });
    this.memory = new MemoryEngine({ store: this.store, llm: this.llm, diagnostics: this.diagnostics, mutex: this.locks, now,
      ...(stmRetryBackoffMs !== undefined ? { stmRetryBackoffMs } : {}), ...(ltmRetryBackoffMs !== undefined ? { ltmRetryBackoffMs } : {}) });
    this.contemplation = new Contemplation({ store: this.store, llm: this.llm, memory: this.memory, diagnostics: this.diagnostics, maxParallel });
    this.uploads = new UploadFiles(this.uploadsDir);
    this.uploads.reconcile(this.store, this.diagnostics);
    this.vision = new Vision({ store: this.store, llm: this.llm, diagnostics: this.diagnostics, uploads: this.uploads });
    this.images = new ImageService({ store: this.store, key: this.key, diagnostics: this.diagnostics, fetchImpl, imagesDir: this.imagesDir, backoffMs: backoffMs * 2, ...(dnsLookup ? { lookupImpl: dnsLookup } : {}) });
    this.dialogue = new Dialogue({ store: this.store, llm: this.llm, memory: this.memory, contemplation: this.contemplation, images: this.images, vision: this.vision, uploads: this.uploads,
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

  // The complete record to store (Specification 0005 A1-A3): the name, the three descriptions and the AI
  // configuration. A field left out keeps its current value (built-in defaults and empty text for a new character);
  // config may be a partial patch over the current configuration. Everything is validated before anything is
  // written, so an invalid submission changes nothing. Legacy scope fields (Specification 0004) are ignored.
  validateCharacter(input, existing = null) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw coded("CHARACTER_INVALID", "The character must be an object.", { status: 400 });
    const name = typeof input.name === "string" ? input.name.trim() : input.name === undefined && existing ? existing.name : "";
    if (!name || name.length > NAME_MAX) throw coded("CHARACTER_INVALID", `Name must be 1 to ${NAME_MAX} characters.`, { status: 400 });
    const record = { name };
    for (const field of DESCRIPTION_FIELDS) {
      const value = input[field] === undefined ? existing?.[field] ?? "" : input[field];
      if (typeof value !== "string") throw coded("CHARACTER_INVALID", `${DESCRIPTION_LABELS[field]} must be text.`, { status: 400 });
      if (value.length > DESCRIPTION_MAX) throw coded("CHARACTER_INVALID", `${DESCRIPTION_LABELS[field]} must be at most ${DESCRIPTION_MAX} characters.`, { status: 400 });
      record[field] = value;
    }
    const base = existing?.config ?? defaultConfig();
    record.config = input.config === undefined ? base : mergeConfig(base, input.config);
    return record;
  }

  createCharacter(input) {
    return this.store.tx(() => {
      const created = this.store.createCharacter(this.validateCharacter(input));
      this.ensurePools(created);
      return created;
    });
  }

  // Changes only this character's record; its transcript, memory, cognition, images and watermarks stay as they are.
  updateCharacter(id, input) {
    const existing = this.store.getCharacter(id);
    if (!existing) throw coded("CHARACTER_NOT_FOUND", "Character not found.", { status: 404 });
    const character = this.store.updateCharacter(id, this.validateCharacter(input, existing));
    this.ensurePools(character);
    return character;
  }

  ensurePools(character) {
    this.store.ensureMemoryPool(poolOf(character));
    this.store.ensureInterpretationPool(poolOf(character));
  }

  characterSummary(character) {
    const last = this.store.lastTurn(character.id);
    return { ...character, pool: poolOf(character), messageCount: this.store.messageCount(character.id),
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

