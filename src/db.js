// SQLite persistence (one unencrypted file in the data directory). Every multi-row mutation runs inside one
// transaction so a failed job never leaves partial state. The OpenRouter key is never written here.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { nowIso } from "./utils.js";
import { defaultConfig, mergeConfig, DESCRIPTION_MAX } from "./settings.js";

// Specification 0004 P1: every character owns exactly one memory pool and one interpretation pool, both keyed by
// this technical identity. There is no shared pool and no user-selectable scope.
export function characterPool(characterId) { return `character:${characterId}`; }
export function poolOf(character) { return characterPool(character.id); }
// The one owner of a pool key, or null for a key that is not a character pool.
export function poolOwnerId(pool) {
  const match = /^character:(\d+)$/.exec(String(pool));
  return match ? Number(match[1]) : null;
}

// The key of the retired shared pools (Specifications 0000-0003); it appears only in the 0004 migration.
const LEGACY_SHARED_POOL = "shared";

function migrationBlocked(message) {
  return Object.assign(new Error(`Specification 0004 migration stopped; the database was not changed. ${message} Restore a backup or resolve the legacy shared pool manually (see README).`), { code: "MIGRATION_BLOCKED" });
}

// Specification 0004 P2: moves the legacy shared cognitive state to the single character that used it, keeping
// every row (ids, text, timestamps, provenance) and its pool state (revisions, planning flag, gestalt, LTM date,
// watermarks). Only the pool key changes. Each cognitive kind moves as a whole: the interpretation kind carries its
// interpretations, experiments, gestalt, revisions and Contemplation watermarks together. Anything ambiguous throws
// inside the migration transaction, so nothing is applied.
function migrateToCharacterOwnedPools(db) {
  const shared = LEGACY_SHARED_POOL;
  const characters = db.prepare("SELECT id, use_shared_memory, use_shared_interpretations FROM characters ORDER BY id").all();
  const count = (sql, ...args) => db.prepare(sql).get(...args).n;
  const kinds = [
    {
      label: "memory",
      flag: "use_shared_memory",
      meaningful: (pool) => count("SELECT COUNT(*) AS n FROM memory_records WHERE pool = ?", pool) > 0,
      // Contributions from another chat: record scope, record provenance, or messages consolidated into the pool.
      foreignContributors: (ownerId) => {
        const ids = new Set();
        for (const row of db.prepare("SELECT scope_character_id, sources FROM memory_records WHERE pool = ?").all(shared)) {
          if (row.scope_character_id !== null && row.scope_character_id !== ownerId) ids.add(row.scope_character_id);
          for (const source of JSON.parse(row.sources || "[]")) if (source?.characterId != null && source.characterId !== ownerId) ids.add(source.characterId);
        }
        for (const row of db.prepare("SELECT DISTINCT character_id FROM messages WHERE consolidated_pool = ? AND character_id != ?").all(shared, ownerId)) ids.add(row.character_id);
        return ids;
      },
      drop: (pool) => {
        db.prepare("DELETE FROM memory_pools WHERE pool = ?").run(pool);
      },
      move: (ownerId, target) => {
        db.prepare("UPDATE memory_records SET pool = ? WHERE pool = ?").run(target, shared);
        db.prepare("UPDATE memory_pools SET pool = ? WHERE pool = ?").run(target, shared);
        db.prepare("UPDATE messages SET consolidated_pool = ? WHERE consolidated_pool = ? AND character_id = ?").run(target, shared, ownerId);
      }
    },
    {
      label: "interpretation",
      flag: "use_shared_interpretations",
      meaningful: (pool) => count("SELECT COUNT(*) AS n FROM interpretations WHERE pool = ?", pool) > 0
        || count("SELECT COUNT(*) AS n FROM experiments WHERE pool = ?", pool) > 0
        || count("SELECT COUNT(*) AS n FROM interpretation_pools WHERE pool = ? AND gestalt IS NOT NULL", pool) > 0,
      // Contributions from another chat: interpretation origins and Contemplation watermarks of other chats.
      foreignContributors: (ownerId) => {
        const ids = new Set();
        for (const row of db.prepare("SELECT origin FROM interpretations WHERE pool = ?").all(shared)) {
          const characterId = JSON.parse(row.origin || "{}")?.characterId;
          if (characterId != null && characterId !== ownerId) ids.add(characterId);
        }
        for (const row of db.prepare("SELECT character_id FROM contemplation_watermarks WHERE pool = ? AND character_id != ?").all(shared, ownerId)) ids.add(row.character_id);
        return ids;
      },
      drop: (pool) => {
        db.prepare("DELETE FROM interpretation_pools WHERE pool = ?").run(pool);
        db.prepare("DELETE FROM contemplation_watermarks WHERE pool = ?").run(pool);
      },
      move: (ownerId, target) => {
        db.prepare("UPDATE interpretations SET pool = ? WHERE pool = ?").run(target, shared);
        db.prepare("UPDATE experiments SET pool = ? WHERE pool = ?").run(target, shared);
        db.prepare("UPDATE interpretation_pools SET pool = ? WHERE pool = ?").run(target, shared);
        db.prepare("UPDATE contemplation_watermarks SET pool = ? WHERE pool = ? AND character_id = ?").run(target, shared, ownerId);
        db.prepare("DELETE FROM contemplation_watermarks WHERE pool = ?").run(shared);
      }
    }
  ];
  for (const kind of kinds) {
    const users = characters.filter((character) => character[kind.flag] === 1);
    const sharedMeaningful = kind.meaningful(shared);
    if (sharedMeaningful && users.length !== 1) {
      throw migrationBlocked(`The legacy shared ${kind.label} pool holds data, but ${users.length} characters use it (${users.map((c) => c.id).join(", ") || "none"}); its owner cannot be inferred.`);
    }
    const owner = users.length === 1 ? users[0] : null;
    if (sharedMeaningful) {
      const foreign = kind.foreignContributors(owner.id);
      if (foreign.size) throw migrationBlocked(`The legacy shared ${kind.label} pool contains contributions from other characters (${[...foreign].join(", ")}); it cannot be assigned to character ${owner.id} alone.`);
      if (kind.meaningful(characterPool(owner.id))) {
        throw migrationBlocked(`Character ${owner.id} has both a nonempty shared and a nonempty personal ${kind.label} pool; they cannot be merged without choosing between their states.`);
      }
    }
    // The owner's personal pool state is replaced only when it holds nothing meaningful; its counters then belong
    // to an empty pool that the character no longer used.
    if (owner && !kind.meaningful(characterPool(owner.id))) {
      kind.drop(characterPool(owner.id));
      kind.move(owner.id, characterPool(owner.id));
    }
    kind.drop(shared);
  }
  for (const table of ["memory_records", "interpretations", "experiments"]) {
    if (count(`SELECT COUNT(*) AS n FROM ${table} WHERE pool = ?`, shared)) throw migrationBlocked(`Rows of ${table} would remain in the legacy shared pool.`);
  }
  db.exec("ALTER TABLE characters DROP COLUMN use_shared_memory; ALTER TABLE characters DROP COLUMN use_shared_interpretations;");
}

// Specification 0005 A4: the previously effective global role configuration and the global user self-description
// become every existing character's own copies, once; Scene Description starts empty. The legacy values are read
// exactly as the old SettingsStore read them (the saved object merged onto the built-in defaults) and must
// validate; an unreadable or invalid legacy value stops the migration instead of silently resetting it. The legacy
// meta keys are then removed so they can no longer influence anything.
function migrateToCharacterOwnedConfiguration(db) {
  const blocked = (message) => Object.assign(new Error(`Specification 0005 migration stopped; the database was not changed. ${message} Restore a backup or repair the legacy value (see README).`), { code: "MIGRATION_BLOCKED" });
  const meta = (key) => {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    if (!row) return { present: false };
    try { return { present: true, value: JSON.parse(row.value) }; }
    catch { throw blocked(`The legacy ${key} value is not readable JSON.`); }
  };
  const settings = meta("settings");
  let config = defaultConfig();
  if (settings.present) {
    try { config = mergeConfig(config, settings.value); }
    catch (error) { throw blocked(`The legacy global settings are invalid: ${error.message}`); }
  }
  const user = meta("userDescription");
  const userDescription = user.present ? user.value : "";
  if (typeof userDescription !== "string" || userDescription.length > DESCRIPTION_MAX) throw blocked(`The legacy user description must be text of at most ${DESCRIPTION_MAX} characters.`);
  db.exec(`
    ALTER TABLE characters ADD COLUMN scene_description TEXT NOT NULL DEFAULT '';
    ALTER TABLE characters ADD COLUMN user_description TEXT NOT NULL DEFAULT '';
    ALTER TABLE characters ADD COLUMN ai_config TEXT NOT NULL DEFAULT '';
    ALTER TABLE images ADD COLUMN context TEXT;
    ALTER TABLE interpretation_pools ADD COLUMN last_maintenance TEXT;
  `);
  db.prepare("UPDATE characters SET user_description = ?, ai_config = ?").run(userDescription, JSON.stringify(config));
  db.prepare("DELETE FROM meta WHERE key IN ('settings', 'userDescription')").run();
}

export const MIGRATIONS = [
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
  `,
  // Specification 0002: one evolving gestalt per interpretation pool and the interpretation revision it reflects.
  `
  ALTER TABLE interpretation_pools ADD COLUMN gestalt TEXT;
  ALTER TABLE interpretation_pools ADD COLUMN gestalt_revision INTEGER;
  ALTER TABLE interpretation_pools ADD COLUMN gestalt_updated_at TEXT;
  `,
  // Specification 0003: a typed image_observation verbatim entry (role 'observation') linked to its source user
  // message, and uploaded user images with their perception state. The CHECK constraints require a table rebuild
  // (SQLite procedure: foreign keys off, rebuild, foreign_key_check before commit; see Store.migrate).
  `
  CREATE TABLE messages_v3 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER NOT NULL REFERENCES characters(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'character', 'observation')),
    kind TEXT NOT NULL CHECK (kind IN ('user', 'reply', 'followup', 'opener', 'image_observation')),
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    consolidated_pool TEXT,
    consolidated_at TEXT,
    source_message_id INTEGER REFERENCES messages_v3(id),
    CHECK ((role = 'observation') = (source_message_id IS NOT NULL))
  );
  INSERT INTO messages_v3 (id, character_id, role, kind, text, created_at, active, consolidated_pool, consolidated_at)
    SELECT id, character_id, role, kind, text, created_at, active, consolidated_pool, consolidated_at FROM messages ORDER BY id;
  DROP TABLE messages;
  ALTER TABLE messages_v3 RENAME TO messages;
  CREATE INDEX messages_by_character ON messages (character_id, id);
  CREATE INDEX messages_active ON messages (character_id, active, id);
  CREATE TABLE uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id),
    character_id INTEGER NOT NULL,
    file TEXT NOT NULL UNIQUE,
    mime TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'observed', 'failed')),
    observation_message_id INTEGER UNIQUE REFERENCES messages(id),
    model TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX uploads_pending ON uploads (status, id);
  `,
  // Specification 0004: character-owned cognition; the shared pools and both scope flags are retired.
  migrateToCharacterOwnedPools,
  // Specification 0005: character-owned AI configuration and three descriptions; Maintenance status; image context.
  migrateToCharacterOwnedConfiguration
];

// Message rows carry their upload (a user message) or their source message (an observation) for every consumer.
const MESSAGE_SELECT = `SELECT m.*, u.id AS upload_id, u.file AS upload_file, u.mime AS upload_mime, u.status AS upload_status,
  u.observation_message_id AS upload_observation_id, obs.text AS upload_observation_text, src.text AS source_text,
  src.created_at AS source_created_at
  FROM messages m LEFT JOIN uploads u ON u.message_id = m.id LEFT JOIN messages obs ON obs.id = u.observation_message_id
  LEFT JOIN messages src ON src.id = m.source_message_id`;

function characterRow(row) {
  return row ? { id: row.id, name: row.name, description: row.description, sceneDescription: row.scene_description, userDescription: row.user_description,
    config: JSON.parse(row.ai_config), createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

function messageRow(row) {
  return {
    id: row.id, characterId: row.character_id, role: row.role, kind: row.kind, text: row.text, createdAt: row.created_at, active: row.active === 1,
    sourceMessageId: row.source_message_id ?? null, source: row.source_message_id ? { id: row.source_message_id, text: row.source_text ?? null, createdAt: row.source_created_at ?? null } : null,
    upload: row.upload_id ? { id: row.upload_id, file: row.upload_file, mime: row.upload_mime, status: row.upload_status, observationMessageId: row.upload_observation_id ?? null,
      observation: row.upload_observation_text ?? null } : null
  };
}

function uploadRow(row) {
  return row ? {
    id: row.id, messageId: row.message_id, characterId: row.character_id, file: row.file, mime: row.mime, bytes: row.bytes, status: row.status,
    observationMessageId: row.observation_message_id, model: row.model, errorCode: row.error_code, errorMessage: row.error_message, createdAt: row.created_at, updatedAt: row.updated_at
  } : null;
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
    context: row.context ? JSON.parse(row.context) : null,
    file: row.file, mime: row.mime, bytes: row.bytes, errorCode: row.error_code, errorMessage: row.error_message, createdAt: row.created_at, updatedAt: row.updated_at
  } : null;
}

export class Store {
  constructor(file) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    try { this.migrate(); }
    catch (error) { this.db.close(); throw error; }
  }

  // Foreign keys are off while migrating (a table rebuild drops and renames a referenced table) and every
  // migration must leave no violation before it commits.
  migrate() {
    const version = this.db.prepare("PRAGMA user_version").get().user_version;
    if (version >= MIGRATIONS.length) return;
    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      for (let index = version; index < MIGRATIONS.length; index += 1) {
        this.tx(() => {
          const migration = MIGRATIONS[index];
          if (typeof migration === "function") migration(this.db);
          else this.db.exec(migration);
          const violations = this.db.prepare("PRAGMA foreign_key_check").all();
          if (violations.length) throw new Error(`Migration ${index + 1} left ${violations.length} foreign key violation(s).`);
          this.db.exec(`PRAGMA user_version = ${index + 1}`);
        });
      }
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
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

  createCharacter({ name, description, sceneDescription, userDescription, config }) {
    const at = nowIso();
    const result = this.db.prepare("INSERT INTO characters (name, description, scene_description, user_description, ai_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(name, description, sceneDescription, userDescription, JSON.stringify(config), at, at);
    return this.getCharacter(Number(result.lastInsertRowid));
  }

  updateCharacter(id, { name, description, sceneDescription, userDescription, config }) {
    this.db.prepare("UPDATE characters SET name = ?, description = ?, scene_description = ?, user_description = ?, ai_config = ?, updated_at = ? WHERE id = ?")
      .run(name, description, sceneDescription, userDescription, JSON.stringify(config), nowIso(), id);
    return this.getCharacter(id);
  }

  // ---- messages --------------------------------------------------------------------------------------------
  // sourceMessageId is set only for an image_observation entry (role 'observation').
  addMessage({ characterId, role, kind, text, sourceMessageId = null }) {
    const result = this.db.prepare("INSERT INTO messages (character_id, role, kind, text, created_at, source_message_id) VALUES (?, ?, ?, ?, ?, ?)").run(characterId, role, kind, text, nowIso(), sourceMessageId);
    return this.getMessage(Number(result.lastInsertRowid));
  }

  getMessage(id) {
    const row = this.db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id);
    return row ? messageRow(row) : null;
  }

  transcript(characterId, { afterId = 0, limit = 10_000 } = {}) {
    return this.db.prepare(`${MESSAGE_SELECT} WHERE m.character_id = ? AND m.id > ? ORDER BY m.id LIMIT ?`).all(characterId, afterId, limit).map(messageRow);
  }

  // The bounded active verbatim window, oldest first. Observations are counted entries like any other.
  activeMessages(characterId, limit = 100) {
    return this.db.prepare(`SELECT * FROM (${MESSAGE_SELECT} WHERE m.character_id = ? AND m.active = 1 ORDER BY m.id DESC LIMIT ?) ORDER BY id`).all(characterId, limit).map(messageRow);
  }

  activeCount(characterId) { return this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE character_id = ? AND active = 1").get(characterId).n; }

  oldestActiveMessages(characterId, count) {
    return this.db.prepare(`${MESSAGE_SELECT} WHERE m.character_id = ? AND m.active = 1 ORDER BY m.id LIMIT ?`).all(characterId, count).map(messageRow);
  }

  // The last raw verbatim row, which may be an image observation.
  lastMessage(characterId) {
    const row = this.db.prepare(`${MESSAGE_SELECT} WHERE m.character_id = ? ORDER BY m.id DESC LIMIT 1`).get(characterId);
    return row ? messageRow(row) : null;
  }

  // The last actual chat turn (user or character message), skipping image observations.
  lastTurn(characterId) {
    const row = this.db.prepare(`${MESSAGE_SELECT} WHERE m.character_id = ? AND m.role != 'observation' ORDER BY m.id DESC LIMIT 1`).get(characterId);
    return row ? messageRow(row) : null;
  }

  lastUserMessageId(characterId) {
    return this.db.prepare("SELECT MAX(id) AS id FROM messages WHERE character_id = ? AND role = 'user'").get(characterId).id || 0;
  }

  messageCount(characterId) { return this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE character_id = ?").get(characterId).n; }

  allMessages() { return this.db.prepare(`${MESSAGE_SELECT} ORDER BY m.id`).all().map(messageRow); }

  // ---- uploaded user images --------------------------------------------------------------------------------
  insertUpload({ messageId, characterId, file, mime, bytes }) {
    const at = nowIso();
    const result = this.db.prepare("INSERT INTO uploads (message_id, character_id, file, mime, bytes, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)")
      .run(messageId, characterId, file, mime, bytes, at, at);
    return this.getUpload(Number(result.lastInsertRowid));
  }

  getUpload(id) { return uploadRow(this.db.prepare("SELECT * FROM uploads WHERE id = ?").get(id)); }

  uploadForMessage(messageId) { return uploadRow(this.db.prepare("SELECT * FROM uploads WHERE message_id = ?").get(messageId)); }

  uploadByFile(file) { return uploadRow(this.db.prepare("SELECT * FROM uploads WHERE file = ?").get(file)); }

  pendingUploads() { return this.db.prepare("SELECT * FROM uploads WHERE status = 'pending' ORDER BY id").all().map(uploadRow); }

  pendingUploadCount(characterId) { return this.db.prepare("SELECT COUNT(*) AS n FROM uploads WHERE character_id = ? AND status = 'pending'").get(characterId).n; }

  allUploads() { return this.db.prepare("SELECT * FROM uploads ORDER BY id").all().map(uploadRow); }

  // Both transitions apply only to a still-pending upload, so a perception result is recorded at most once.
  completeUpload(id, { observationMessageId, model }) {
    return Number(this.db.prepare("UPDATE uploads SET status = 'observed', observation_message_id = ?, model = ?, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(observationMessageId, model, nowIso(), id).changes);
  }

  failUpload(id, { code, message, model = null }) {
    return Number(this.db.prepare("UPDATE uploads SET status = 'failed', model = ?, error_code = ?, error_message = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(model, code, String(message || "").slice(0, 500), nowIso(), id).changes);
  }

  // ---- images ----------------------------------------------------------------------------------------------
  // context: the character's descriptions frozen at enqueue time (Specification 0005 A5/C5); null for legacy rows.
  addImage({ messageId, characterId, request, model, context = null }) {
    const at = nowIso();
    const result = this.db.prepare("INSERT INTO images (message_id, character_id, status, request, model, context, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)")
      .run(messageId, characterId, request, model, context === null ? null : JSON.stringify(context), at, at);
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
    this.db.prepare("UPDATE images SET status = 'failed', error_code = ?, error_message = ?, updated_at = ? WHERE id = ? AND status = 'pending'").run(code, String(message || "").slice(0, 800), nowIso(), id);
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
    return this.interpretationPool(pool);
  }

  // Read-only pool state (no SQL write, review 0006 P2); null when the pool row does not exist.
  interpretationPool(pool) {
    const row = this.db.prepare("SELECT * FROM interpretation_pools WHERE pool = ?").get(pool);
    if (!row) return null;
    return { pool: row.pool, interpretationRevision: row.interpretation_revision, experimentRevision: row.experiment_revision, planningNeeded: row.planning_needed === 1,
      gestalt: row.gestalt, gestaltRevision: row.gestalt_revision, gestaltUpdatedAt: row.gestalt_updated_at,
      lastMaintenance: row.last_maintenance ? JSON.parse(row.last_maintenance) : null };
  }

  // Specification 0005 F3: the latest Maintenance attempt of a pool (running while in flight), kept across restarts.
  setLastMaintenance(pool, value) {
    this.ensureInterpretationPool(pool);
    this.db.prepare("UPDATE interpretation_pools SET last_maintenance = ? WHERE pool = ?").run(JSON.stringify(value), pool);
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

  // Replaces the pool's single gestalt; no history of earlier gestalts is kept.
  setGestalt(pool, text, revision) {
    this.ensureInterpretationPool(pool);
    this.db.prepare("UPDATE interpretation_pools SET gestalt = ?, gestalt_revision = ?, gestalt_updated_at = ? WHERE pool = ?").run(text, revision, nowIso(), pool);
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
