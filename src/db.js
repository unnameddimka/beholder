// SQLite persistence (one unencrypted file in the data directory). Every multi-row mutation runs inside one
// transaction so a failed job never leaves partial state. The OpenRouter key is never written here.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { nowIso } from "./utils.js";

export const SHARED_POOL = "shared";
export function privatePool(characterId) { return `character:${characterId}`; }
export function memoryPoolOf(character) { return character.useSharedMemory ? SHARED_POOL : privatePool(character.id); }
export function interpretationPoolOf(character) { return character.useSharedInterpretations ? SHARED_POOL : privatePool(character.id); }

const MIGRATIONS = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    use_shared_memory INTEGER NOT NULL DEFAULT 0,
    use_shared_interpretations INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER NOT NULL REFERENCES characters(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'character')),
    kind TEXT NOT NULL CHECK (kind IN ('user', 'reply', 'followup', 'opener')),
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    consolidated_pool TEXT,
    consolidated_at TEXT
  );
  CREATE INDEX messages_by_character ON messages (character_id, id);
  CREATE INDEX messages_active ON messages (character_id, active, id);
  CREATE TABLE images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id),
    character_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
    request TEXT NOT NULL,
    model TEXT NOT NULL,
    file TEXT,
    mime TEXT,
    bytes INTEGER,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE memory_pools (pool TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, last_ltm_date TEXT);
  CREATE TABLE memory_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pool TEXT NOT NULL,
    tier TEXT NOT NULL CHECK (tier IN ('stm', 'ltm')),
    topic TEXT NOT NULL,
    summary TEXT NOT NULL,
    retrieval_brief TEXT NOT NULL DEFAULT '',
    importance REAL NOT NULL,
    sources TEXT NOT NULL,
    scope_character_id INTEGER,
    source_from TEXT,
    source_to TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX memory_by_pool ON memory_records (pool, tier, id);
  CREATE TABLE interpretation_pools (
    pool TEXT PRIMARY KEY,
    interpretation_revision INTEGER NOT NULL DEFAULT 0,
    experiment_revision INTEGER NOT NULL DEFAULT 0,
    planning_needed INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE interpretations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pool TEXT NOT NULL,
    text TEXT NOT NULL,
    origin TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX interpretations_by_pool ON interpretations (pool, id);
  CREATE TABLE experiments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pool TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX experiments_by_pool ON experiments (pool, id);
  CREATE TABLE contemplation_watermarks (
    pool TEXT NOT NULL,
    character_id INTEGER NOT NULL,
    last_user_message_id INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (pool, character_id)
  );
  `
];

function characterRow(row) {
  return row ? {
    id: row.id, name: row.name, description: row.description,
    useSharedMemory: row.use_shared_memory === 1, useSharedInterpretations: row.use_shared_interpretations === 1,
    createdAt: row.created_at, updatedAt: row.updated_at
  } : null;
}

function messageRow(row) {
  return { id: row.id, characterId: row.character_id, role: row.role, kind: row.kind, text: row.text, createdAt: row.created_at, active: row.active === 1 };
}

function memoryRow(row) {
  return {
    id: row.id, pool: row.pool, tier: row.tier, topic: row.topic, summary: row.summary, retrievalBrief: row.retrieval_brief,
    importance: row.importance, sources: JSON.parse(row.sources), scopeCharacterId: row.scope_character_id,
    sourceFrom: row.source_from, sourceTo: row.source_to, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function imageRow(row) {
  return row ? {
    id: row.id, messageId: row.message_id, characterId: row.character_id, status: row.status, request: row.request, model: row.model,
    file: row.file, mime: row.mime, bytes: row.bytes, errorCode: row.error_code, errorMessage: row.error_message, createdAt: row.created_at, updatedAt: row.updated_at
  } : null;
}

export class Store {
  constructor(file) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  migrate() {
    const version = this.db.prepare("PRAGMA user_version").get().user_version;
    for (let index = version; index < MIGRATIONS.length; index += 1) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[index]);
        this.db.exec(`PRAGMA user_version = ${index + 1}`);
      });
    }
  }

  schemaVersion() { return this.db.prepare("PRAGMA user_version").get().user_version; }

  close() { this.db.close(); }

  // Synchronous transaction; node:sqlite is synchronous, so no other JS runs inside it.
  tx(fn) {
    if (this.inTx) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.inTx = true;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    } finally {
      this.inTx = false;
    }
  }

  // ---- meta / settings -------------------------------------------------------------------------------------
  getMeta(key, fallback = null) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  setMeta(key, value) {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }

  // ---- characters ------------------------------------------------------------------------------------------
  listCharacters() { return this.db.prepare("SELECT * FROM characters ORDER BY id").all().map(characterRow); }

  getCharacter(id) { return characterRow(this.db.prepare("SELECT * FROM characters WHERE id = ?").get(id)); }

  createCharacter({ name, description, useSharedMemory, useSharedInterpretations }) {
    const at = nowIso();
    const result = this.db.prepare("INSERT INTO characters (name, description, use_shared_memory, use_shared_interpretations, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(name, description, useSharedMemory ? 1 : 0, useSharedInterpretations ? 1 : 0, at, at);
    return this.getCharacter(Number(result.lastInsertRowid));
  }

  // Changing a scope flag only switches which pool is active; no pool is merged, cloned, or deleted.
  updateCharacter(id, { name, description, useSharedMemory, useSharedInterpretations }) {
    this.db.prepare("UPDATE characters SET name = ?, description = ?, use_shared_memory = ?, use_shared_interpretations = ?, updated_at = ? WHERE id = ?")
      .run(name, description, useSharedMemory ? 1 : 0, useSharedInterpretations ? 1 : 0, nowIso(), id);
    return this.getCharacter(id);
  }

  // ---- messages --------------------------------------------------------------------------------------------
  addMessage({ characterId, role, kind, text }) {
    const result = this.db.prepare("INSERT INTO messages (character_id, role, kind, text, created_at) VALUES (?, ?, ?, ?, ?)").run(characterId, role, kind, text, nowIso());
    return this.getMessage(Number(result.lastInsertRowid));
  }

  getMessage(id) {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    return row ? messageRow(row) : null;
  }

  transcript(characterId, { afterId = 0, limit = 10_000 } = {}) {
    return this.db.prepare("SELECT * FROM messages WHERE character_id = ? AND id > ? ORDER BY id LIMIT ?").all(characterId, afterId, limit).map(messageRow);
  }

  // The bounded active verbatim window, oldest first.
  activeMessages(characterId, limit = 100) {
    return this.db.prepare("SELECT * FROM (SELECT * FROM messages WHERE character_id = ? AND active = 1 ORDER BY id DESC LIMIT ?) ORDER BY id").all(characterId, limit).map(messageRow);
  }

  activeCount(characterId) { return this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE character_id = ? AND active = 1").get(characterId).n; }

  oldestActiveMessages(characterId, count) {
    return this.db.prepare("SELECT * FROM messages WHERE character_id = ? AND active = 1 ORDER BY id LIMIT ?").all(characterId, count).map(messageRow);
  }

  lastMessage(characterId) {
    const row = this.db.prepare("SELECT * FROM messages WHERE character_id = ? ORDER BY id DESC LIMIT 1").get(characterId);
    return row ? messageRow(row) : null;
  }

  lastUserMessageId(characterId) {
    return this.db.prepare("SELECT MAX(id) AS id FROM messages WHERE character_id = ? AND role = 'user'").get(characterId).id || 0;
  }

  messageCount(characterId) { return this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE character_id = ?").get(characterId).n; }

  allMessages() { return this.db.prepare("SELECT * FROM messages ORDER BY id").all().map(messageRow); }

  // ---- images ----------------------------------------------------------------------------------------------
  addImage({ messageId, characterId, request, model }) {
    const at = nowIso();
    const result = this.db.prepare("INSERT INTO images (message_id, character_id, status, request, model, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?, ?, ?)").run(messageId, characterId, request, model, at, at);
    return this.getImage(Number(result.lastInsertRowid));
  }

  getImage(id) { return imageRow(this.db.prepare("SELECT * FROM images WHERE id = ?").get(id)); }

  imageByFile(file) { return imageRow(this.db.prepare("SELECT * FROM images WHERE file = ? AND status = 'ready'").get(file)); }

  imagesForCharacter(characterId) { return this.db.prepare("SELECT * FROM images WHERE character_id = ? ORDER BY id").all(characterId).map(imageRow); }

  allImages() { return this.db.prepare("SELECT * FROM images ORDER BY id").all().map(imageRow); }

  pendingImages() { return this.db.prepare("SELECT * FROM images WHERE status = 'pending' ORDER BY id").all().map(imageRow); }

  completeImage(id, { file, mime, bytes }) {
    this.db.prepare("UPDATE images SET status = 'ready', file = ?, mime = ?, bytes = ?, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ? AND status = 'pending'").run(file, mime, bytes, nowIso(), id);
  }

  failImage(id, { code, message }) {
    this.db.prepare("UPDATE images SET status = 'failed', error_code = ?, error_message = ?, updated_at = ? WHERE id = ? AND status = 'pending'").run(code, String(message || "").slice(0, 500), nowIso(), id);
  }

  // ---- memory ----------------------------------------------------------------------------------------------
  ensureMemoryPool(pool) {
    this.db.prepare("INSERT INTO memory_pools (pool) VALUES (?) ON CONFLICT(pool) DO NOTHING").run(pool);
    return this.db.prepare("SELECT * FROM memory_pools WHERE pool = ?").get(pool);
  }

  memoryPools() { return this.db.prepare("SELECT * FROM memory_pools ORDER BY pool").all(); }

  memoryRecords(pool, tier = null) {
    return (tier
      ? this.db.prepare("SELECT * FROM memory_records WHERE pool = ? AND tier = ? ORDER BY id").all(pool, tier)
      : this.db.prepare("SELECT * FROM memory_records WHERE pool = ? ORDER BY tier DESC, id").all(pool)).map(memoryRow);
  }

  allMemoryRecords() { return this.db.prepare("SELECT * FROM memory_records ORDER BY pool, tier, id").all().map(memoryRow); }

  poolsWithStm() { return this.db.prepare("SELECT DISTINCT pool FROM memory_records WHERE tier = 'stm' ORDER BY pool").all().map((row) => row.pool); }

  insertMemory(record) {
    const at = nowIso();
    const result = this.db.prepare(`INSERT INTO memory_records (pool, tier, topic, summary, retrieval_brief, importance, sources, scope_character_id, source_from, source_to, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(record.pool, record.tier, record.topic, record.summary, record.retrievalBrief, record.importance,
      JSON.stringify(record.sources || []), record.scopeCharacterId ?? null, record.sourceFrom ?? null, record.sourceTo ?? null, at, at);
    return Number(result.lastInsertRowid);
  }

  updateMemory(id, record) {
    this.db.prepare("UPDATE memory_records SET topic = ?, summary = ?, retrieval_brief = ?, importance = ?, sources = ?, source_from = ?, source_to = ?, updated_at = ? WHERE id = ?")
      .run(record.topic, record.summary, record.retrievalBrief, record.importance, JSON.stringify(record.sources || []), record.sourceFrom ?? null, record.sourceTo ?? null, nowIso(), id);
  }

  deleteMemory(id) { this.db.prepare("DELETE FROM memory_records WHERE id = ?").run(id); }

  bumpMemoryRevision(pool) {
    this.ensureMemoryPool(pool);
    this.db.prepare("UPDATE memory_pools SET revision = revision + 1 WHERE pool = ?").run(pool);
  }

  setPoolLtmDate(pool, date) {
    this.ensureMemoryPool(pool);
    this.db.prepare("UPDATE memory_pools SET last_ltm_date = ? WHERE pool = ?").run(date, pool);
  }

  // Removes the consumed messages from the active verbatim window only; the transcript row stays.
  deactivateMessages(ids, pool) {
    const statement = this.db.prepare("UPDATE messages SET active = 0, consolidated_pool = ?, consolidated_at = ? WHERE id = ? AND active = 1");
    const at = nowIso();
    let changed = 0;
    for (const id of ids) changed += Number(statement.run(pool, at, id).changes);
    return changed;
  }

  // ---- interpretations / experiments -----------------------------------------------------------------------
  ensureInterpretationPool(pool) {
    this.db.prepare("INSERT INTO interpretation_pools (pool) VALUES (?) ON CONFLICT(pool) DO NOTHING").run(pool);
    const row = this.db.prepare("SELECT * FROM interpretation_pools WHERE pool = ?").get(pool);
    return { pool: row.pool, interpretationRevision: row.interpretation_revision, experimentRevision: row.experiment_revision, planningNeeded: row.planning_needed === 1 };
  }

  interpretationPools() { return this.db.prepare("SELECT pool FROM interpretation_pools ORDER BY pool").all().map((row) => this.ensureInterpretationPool(row.pool)); }

  interpretations(pool) {
    return this.db.prepare("SELECT * FROM interpretations WHERE pool = ? ORDER BY id").all(pool)
      .map((row) => ({ id: row.id, pool: row.pool, text: row.text, origin: JSON.parse(row.origin), createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  experiments(pool) {
    return this.db.prepare("SELECT * FROM experiments WHERE pool = ? ORDER BY id").all(pool)
      .map((row) => ({ id: row.id, pool: row.pool, text: row.text, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  allInterpretations() { return this.db.prepare("SELECT * FROM interpretations ORDER BY pool, id").all(); }

  allExperiments() { return this.db.prepare("SELECT * FROM experiments ORDER BY pool, id").all(); }

  insertInterpretation(pool, text, origin) {
    const at = nowIso();
    return Number(this.db.prepare("INSERT INTO interpretations (pool, text, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(pool, text, JSON.stringify(origin || {}), at, at).lastInsertRowid);
  }

  updateInterpretation(pool, id, text) {
    return Number(this.db.prepare("UPDATE interpretations SET text = ?, updated_at = ? WHERE id = ? AND pool = ?").run(text, nowIso(), id, pool).changes);
  }

  deleteInterpretation(pool, id) { return Number(this.db.prepare("DELETE FROM interpretations WHERE id = ? AND pool = ?").run(id, pool).changes); }

  insertExperiment(pool, text) {
    const at = nowIso();
    return Number(this.db.prepare("INSERT INTO experiments (pool, text, created_at, updated_at) VALUES (?, ?, ?, ?)").run(pool, text, at, at).lastInsertRowid);
  }

  updateExperiment(pool, id, text) {
    return Number(this.db.prepare("UPDATE experiments SET text = ?, updated_at = ? WHERE id = ? AND pool = ?").run(text, nowIso(), id, pool).changes);
  }

  deleteExperiment(pool, id) { return Number(this.db.prepare("DELETE FROM experiments WHERE id = ? AND pool = ?").run(id, pool).changes); }

  bumpInterpretationRevision(pool) {
    this.ensureInterpretationPool(pool);
    this.db.prepare("UPDATE interpretation_pools SET interpretation_revision = interpretation_revision + 1, planning_needed = 1 WHERE pool = ?").run(pool);
  }

  bumpExperimentRevision(pool) {
    this.ensureInterpretationPool(pool);
    this.db.prepare("UPDATE interpretation_pools SET experiment_revision = experiment_revision + 1 WHERE pool = ?").run(pool);
  }

  setPlanningNeeded(pool, needed) {
    this.ensureInterpretationPool(pool);
    this.db.prepare("UPDATE interpretation_pools SET planning_needed = ? WHERE pool = ?").run(needed ? 1 : 0, pool);
  }

  watermark(pool, characterId) {
    return this.db.prepare("SELECT last_user_message_id AS id FROM contemplation_watermarks WHERE pool = ? AND character_id = ?").get(pool, characterId)?.id || 0;
  }

  setWatermark(pool, characterId, messageId) {
    this.db.prepare(`INSERT INTO contemplation_watermarks (pool, character_id, last_user_message_id, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(pool, character_id) DO UPDATE SET last_user_message_id = MAX(last_user_message_id, excluded.last_user_message_id), updated_at = excluded.updated_at`).run(pool, characterId, messageId, nowIso());
  }

  allWatermarks() { return this.db.prepare("SELECT * FROM contemplation_watermarks ORDER BY pool, character_id").all(); }
}
