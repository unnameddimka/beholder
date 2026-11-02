// Dialogue: synchronous-feeling chat replies plus server-guarded follow-up timers (Specification 0000 section 6).
// A reply starts immediately on send and never waits for Contemplation. A message with an attached image is first
// perceived by Vision (Specification 0003); the reply then sees the observation, or knows the image was not seen. It sees a snapshot of the pool's gestalt and
// active experiment intentions (never interpretation texts) and Society-style retrieved memory.
import { coded } from "./utils.js";
import { poolOf } from "./db.js";
import { messageView } from "./memory.js";
import { dialogueSystemPrompt, historyMessages, pinnedSelfDescriptionMessage, validateDialogueEnvelope, MESSAGE_MAX_CHARS } from "./prompts/dialogue.js";
import { VERBATIM_WINDOW } from "./memory.js";
import { clockContext, stripTimestampEcho, validTimeZone } from "./clock.js";
import { validateUploadBytes } from "./uploads.js";

export const OPENER_DELAY_SECONDS = 60;
export const PRESENCE_TTL_MS = 20_000;
const RETRIEVAL_SITUATION_MESSAGES = 12;

// Pure context assembly, exported for tests: system contract + pinned self-description + verbatim history. The
// clock adds the current time and a timestamp marker per history message; the pinned self-description has none.
export function buildDialogueMessages({ character, userDescription, history, imagesByMessage, gestalt = null, experiments, memories, imageEnabled, mode, clock = null }) {
  const userImages = history.some((message) => message.upload || message.role === "observation");
  return [
    { role: "system", content: dialogueSystemPrompt({ character, gestalt, experiments, memories, imageEnabled, mode, clock, userImages }) },
    pinnedSelfDescriptionMessage(userDescription),
    ...historyMessages(history, imagesByMessage, clock)
  ];
}

export class Dialogue {
  constructor({ store, llm, memory, contemplation, images, vision = null, uploads = null, settings, diagnostics, now = () => new Date(), timeScaleMs = 1000, openerDelaySeconds = OPENER_DELAY_SECONDS, presenceTtlMs = PRESENCE_TTL_MS }) {
    this.now = now;
    this.store = store;
    this.llm = llm;
    this.memory = memory;
    this.contemplation = contemplation;
    this.images = images;
    this.vision = vision;
    this.uploads = uploads;
    this.settings = settings;
    this.diagnostics = diagnostics;
    this.timeScaleMs = timeScaleMs;
    this.openerDelaySeconds = openerDelaySeconds;
    this.presenceTtlMs = presenceTtlMs;
    this.chats = new Map();
    this.clients = new Map();
    this.nextToken = 1;
    this.sweepHandle = setInterval(() => this.sweepPresence(), Math.min(5000, presenceTtlMs)).unref?.() ?? null;
  }

  stop() {
    if (this.sweepHandle) clearInterval(this.sweepHandle);
    for (const chat of this.chats.values()) if (chat.timer) clearTimeout(chat.timer.handle);
  }

  chat(characterId) {
    if (!this.chats.has(characterId)) this.chats.set(characterId, { pending: null, uploading: false, lastError: null, timer: null, background: new Set() });
    return this.chats.get(characterId);
  }

  // ---- sending and replies --------------------------------------------------------------------------------------

  // timeZone is the sending browser's IANA zone; an absent or invalid one falls back as in timeZoneFor.
  send(characterId, text, { timeZone = null } = {}) {
    const character = this.store.getCharacter(characterId);
    if (!character) throw coded("CHARACTER_NOT_FOUND", "Character not found.");
    if (typeof text !== "string" || !text.trim()) throw coded("MESSAGE_INVALID", "Message must not be empty.");
    if (text.length > MESSAGE_MAX_CHARS) throw coded("MESSAGE_INVALID", `Message must be at most ${MESSAGE_MAX_CHARS} characters.`);
    const chat = this.chat(characterId);
    if (chat.pending || chat.uploading) throw coded("REPLY_PENDING", "Wait for the current reply before sending another message.", { status: 409 });
    this.cancelTimer(characterId, "message_sent");
    const message = this.store.addMessage({ characterId, role: "user", kind: "user", text: text.replace(/\r\n/g, "\n").trimEnd() });
    chat.lastError = null;
    this.memory.maybeConsolidate(characterId);
    this.contemplation.onUserMessage(characterId);
    this.startReply(characterId, message.id, timeZone);
    return message;
  }

  // A user message with one attached image (Specification 0003 U2). The bytes are validated and stored before the
  // message and its upload row are committed together; a rejected upload leaves no message and no file. The text may
  // be empty. Contemplation is triggered once the image has been perceived (see perceive).
  async sendImage(characterId, text, { timeZone = null, image }) {
    const character = this.store.getCharacter(characterId);
    if (!character) throw coded("CHARACTER_NOT_FOUND", "Character not found.");
    const body = typeof text === "string" ? text.replace(/\r\n/g, "\n").trimEnd() : "";
    if (body.length > MESSAGE_MAX_CHARS) throw coded("MESSAGE_INVALID", `Message must be at most ${MESSAGE_MAX_CHARS} characters.`);
    const mime = validateUploadBytes(image);
    const chat = this.chat(characterId);
    if (chat.pending || chat.uploading) throw coded("REPLY_PENDING", "Wait for the current reply before sending another message.", { status: 409 });
    chat.uploading = true;
    let file = null;
    try {
      file = await this.uploads.save(image, mime);
      const message = this.store.tx(() => {
        const entry = this.store.addMessage({ characterId, role: "user", kind: "user", text: body.trim() ? body : "" });
        this.store.insertUpload({ messageId: entry.id, characterId, file, mime, bytes: image.length });
        return this.store.getMessage(entry.id);
      });
      this.cancelTimer(characterId, "message_sent");
      chat.lastError = null;
      this.diagnostics.event({ type: "upload-accepted", characterId, messageId: message.id, mime, bytes: image.length });
      this.startReply(characterId, message.id, timeZone);
      return message;
    } catch (error) {
      if (file) await this.uploads.remove(file);
      throw error;
    } finally {
      chat.uploading = false;
    }
  }

  // Perception step of a reply: a still-pending attachment is viewed first; then the completed turn triggers
  // Contemplation once and may start verbatim consolidation. A known observation or failure is reused as is.
  async perceive(characterId, userMessageId, progress) {
    const upload = this.store.uploadForMessage(userMessageId);
    if (!upload || upload.status !== "pending") return;
    progress.stage = "vision";
    await this.vision.observe(upload.id);
    this.contemplation.onUserMessage(characterId);
    this.memory.maybeConsolidate(characterId);
  }

  // Restart recovery once the key is known: a pending image whose message is still the chat's latest turn is
  // perceived and answered once; one that a later turn has overtaken is marked failed instead of answered late.
  recoverPendingVision() {
    for (const upload of this.store.pendingUploads()) {
      const chat = this.chat(upload.characterId);
      if (chat.pending) continue;
      if (this.store.lastTurn(upload.characterId)?.id === upload.messageId) this.startReply(upload.characterId, upload.messageId, this.timeZoneFor(upload.characterId));
      else this.vision.fail(upload.id, coded("VISION_INTERRUPTED", "Image perception was interrupted and a later message superseded it."));
    }
  }

  // Retry after a final failure: regenerates for the existing last user turn; never duplicates it or its image.
  retry(characterId, { timeZone = null } = {}) {
    const chat = this.chat(characterId);
    if (chat.pending || chat.uploading) throw coded("REPLY_PENDING", "A reply is already being generated.", { status: 409 });
    const last = this.store.lastTurn(characterId);
    if (!last || last.role !== "user") throw coded("NOTHING_TO_RETRY", "There is no unanswered user message to retry.", { status: 409 });
    chat.lastError = null;
    this.startReply(characterId, last.id, timeZone);
    return { retrying: true, userMessageId: last.id };
  }

  startReply(characterId, userMessageId, timeZone = null) {
    const chat = this.chat(characterId);
    const pending = { kind: "reply", userMessageId, startedAt: new Date().toISOString(), stage: "retrieval", timeZone: validTimeZone(timeZone) };
    chat.pending = pending;
    pending.promise = this.perceive(characterId, userMessageId, pending)
      .then(() => this.generate(characterId, "reply", pending))
      .then((envelope) => {
        const message = this.commitCharacterMessage(characterId, "reply", envelope);
        // A follow-up is scheduled only for a chat that is still actively open and idle at commit time.
        if (envelope.followUpDelaySeconds !== null && this.isActive(characterId) && !this.isTyping(characterId)) {
          this.scheduleTimer(characterId, "followup", envelope.followUpDelaySeconds, message.id);
        }
        return message;
      })
      .catch((error) => {
        chat.lastError = { code: error.code || "DIALOGUE_FAILED", message: error.message, at: new Date().toISOString(), userMessageId };
        this.diagnostics.error("dialogue_reply", error, { characterId, userMessageId });
        return null;
      })
      .finally(() => { if (chat.pending === pending) chat.pending = null; });
    return pending.promise;
  }

  async generate(characterId, mode, progress = {}) {
    const character = this.store.getCharacter(characterId);
    const settings = this.settings.get();
    const history = this.store.activeMessages(characterId, VERBATIM_WINDOW);
    // Snapshot of the gestalt and experiment intentions at request start; later updates apply to the next request only.
    // Both come from the character's own interpretation pool and only while Contemplation is enabled.
    const pool = poolOf(character);
    const gestalt = settings.contemplationEnabled ? this.store.ensureInterpretationPool(pool).gestalt : null;
    const experiments = settings.contemplationEnabled ? this.store.experiments(pool) : [];
    progress.stage = "retrieval";
    const memories = await this.memory.retrieve({ pool, purpose: "dialogue_memory_retrieval", currentCharacterId: characterId,
      situation: { character: character.name, mode, recentMessages: history.slice(-RETRIEVAL_SITUATION_MESSAGES).map((message) => messageView(message, character.name)) } });
    progress.stage = "dialogue";
    const imagesByMessage = new Map(this.store.imagesForCharacter(characterId).map((image) => [image.messageId, image]));
    // "Now" is taken when the actual Dialogue request is assembled, after memory retrieval.
    // A direct Send/Retry uses only its own browser's zone (UTC when that is missing or invalid); autonomous
    // messages use the most recently active session in the chat.
    // Elapsed time is measured between actual chat turns; an image observation is not a message.
    const turns = history.filter((message) => message.role !== "observation");
    const clock = clockContext({ now: this.now(), timeZone: mode === "reply" ? progress.timeZone : this.timeZoneFor(characterId),
      lastMessageAt: turns.at(-1)?.createdAt ?? null, previousMessageAt: turns.at(-2)?.createdAt ?? null });
    const messages = buildDialogueMessages({ character, userDescription: this.settings.userDescription(), history, imagesByMessage, gestalt, experiments,
      memories: { shortTermMemories: memories.shortTermMemories, longTermMemories: memories.longTermMemories }, imageEnabled: settings.imageEnabled, mode, clock });
    const purpose = mode === "reply" ? "dialogue_reply" : mode === "followup" ? "dialogue_followup" : "dialogue_opener";
    const context = { characterId, characterName: character.name, gestaltPresent: Boolean(gestalt), experimentCount: experiments.length, timeZone: clock.timeZone, timeZoneKnown: clock.timeZoneKnown };
    const { value } = await this.llm.structured({ purpose, messages, validate: validateDialogueEnvelope, context });
    // A model that copies the history's timestamp markers gets them removed; the marker is metadata, not speech.
    const echo = stripTimestampEcho(value.message);
    if (echo.stripped) {
      this.diagnostics.event({ type: "dialogue-timestamp-echo-stripped", purpose, characterId });
      if (!echo.text.trim()) throw coded("AI_OUTPUT_INVALID", `${purpose} output contained only a timestamp marker.`);
    }
    return { ...value, message: echo.text.trim(), imageRequest: settings.imageEnabled ? value.imageRequest : null };
  }

  // Browser time zone for autonomous messages (and a reply sent without one): the most recently active session in
  // that chat that reported a valid zone. Null means the clock context falls back to explicitly labeled UTC.
  timeZoneFor(characterId) {
    const cutoff = Date.now() - this.presenceTtlMs;
    let best = null;
    for (const client of this.clients.values()) {
      if (client.characterId !== characterId || client.lastSeen < cutoff || !client.timeZone) continue;
      if (!best || client.lastSeen >= best.lastSeen) best = client;
    }
    return best?.timeZone ?? null;
  }

  commitCharacterMessage(characterId, kind, envelope) {
    const message = this.store.addMessage({ characterId, role: "character", kind, text: envelope.message });
    if (envelope.imageRequest && this.settings.get().imageEnabled) this.images.request({ message, prompt: envelope.imageRequest });
    this.memory.maybeConsolidate(characterId);
    return message;
  }

  // ---- presence -------------------------------------------------------------------------------------------------

  // Heartbeat from a browser tab: which chat is open and whether the draft is non-empty. Typing, switching away,
  // closing, or a lapsed heartbeat cancels that chat's timer; a canceled timer is never reinstated.
  presence(clientId, { characterId = null, draftNonEmpty = false, typingStarted = false, timeZone = null } = {}) {
    if (typeof clientId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) throw coded("CLIENT_INVALID", "Invalid client id.");
    const id = characterId === null || characterId === undefined ? null : Number(characterId);
    if (id !== null && !this.store.getCharacter(id)) throw coded("CHARACTER_NOT_FOUND", "Character not found.");
    const previous = this.clients.get(clientId);
    if (previous?.characterId && previous.characterId !== id) this.cancelTimer(previous.characterId, "navigation");
    this.clients.set(clientId, { characterId: id, lastSeen: Date.now(), draftNonEmpty: Boolean(draftNonEmpty), timeZone: validTimeZone(timeZone) });
    if (id !== null && (typingStarted || draftNonEmpty)) this.cancelTimer(id, "typing");
    if (id !== null && previous?.characterId !== id) this.opened(id);
    return { ok: true };
  }

  leave(clientId) {
    const previous = this.clients.get(clientId);
    this.clients.delete(clientId);
    if (previous?.characterId) this.cancelTimer(previous.characterId, "page_closed");
  }

  sweepPresence() {
    const cutoff = Date.now() - this.presenceTtlMs;
    for (const [clientId, client] of this.clients) {
      if (client.lastSeen >= cutoff) continue;
      this.clients.delete(clientId);
      if (client.characterId) this.cancelTimer(client.characterId, "disconnect");
    }
  }

  isActive(characterId) {
    const cutoff = Date.now() - this.presenceTtlMs;
    for (const client of this.clients.values()) if (client.characterId === characterId && client.lastSeen >= cutoff) return true;
    return false;
  }

  isTyping(characterId) {
    for (const client of this.clients.values()) if (client.characterId === characterId && client.draftNonEmpty) return true;
    return false;
  }

  // Zero follow-up: opening an entirely empty chat starts one 60-second idle timer.
  opened(characterId) {
    const chat = this.chat(characterId);
    if (chat.timer || chat.pending || this.store.messageCount(characterId) > 0 || this.isTyping(characterId)) return;
    this.scheduleTimer(characterId, "opener", this.openerDelaySeconds, 0);
  }

  // ---- timers ---------------------------------------------------------------------------------------------------

  scheduleTimer(characterId, kind, delaySeconds, afterMessageId) {
    const chat = this.chat(characterId);
    if (chat.timer) clearTimeout(chat.timer.handle);
    const token = this.nextToken++;
    const delayMs = Math.max(0, delaySeconds * this.timeScaleMs);
    const timer = { token, kind, afterMessageId, dueAt: new Date(Date.now() + delayMs).toISOString(), handle: null };
    timer.handle = setTimeout(() => this.fireTimer(characterId, token), delayMs);
    chat.timer = timer;
    this.diagnostics.event({ type: "followup-scheduled", characterId, kind, delaySeconds, afterMessageId });
  }

  cancelTimer(characterId, reason) {
    const chat = this.chats.get(characterId);
    if (!chat?.timer) return;
    clearTimeout(chat.timer.handle);
    this.diagnostics.event({ type: "followup-cancelled", characterId, kind: chat.timer.kind, reason });
    chat.timer = null;
  }

  // Guards: the token must be current, the chat still open and idle, no reply pending, and nothing new in the chat.
  // The same conditions are rechecked at commit, so a simultaneous Send discards the autonomous message.
  stillEligible(characterId, timer) {
    const chat = this.chat(characterId);
    if (chat.pending || chat.uploading || !this.isActive(characterId) || this.isTyping(characterId)) return false;
    const last = this.store.lastTurn(characterId);
    return timer.kind === "opener" ? last === null : last?.id === timer.afterMessageId;
  }

  async fireTimer(characterId, token) {
    const chat = this.chat(characterId);
    const timer = chat.timer;
    if (!timer || timer.token !== token) return null;
    chat.timer = null;
    if (!this.stillEligible(characterId, timer)) { this.diagnostics.event({ type: "followup-skipped", characterId, kind: timer.kind, stage: "fire" }); return null; }
    const mode = timer.kind === "opener" ? "opener" : "followup";
    const job = this.generate(characterId, mode, {})
      .then((envelope) => {
        // Re-check at commit: a send or navigation during generation discards the autonomous message.
        if (!this.stillEligible(characterId, timer) || chat.timer) {
          this.diagnostics.event({ type: "followup-skipped", characterId, kind: timer.kind, stage: "commit" });
          return null;
        }
        // An autonomous message never schedules another timer, whatever followUpDelaySeconds it returned.
        return this.commitCharacterMessage(characterId, mode === "opener" ? "opener" : "followup", envelope);
      })
      .catch((error) => { this.diagnostics.error(`dialogue_${mode}`, error, { characterId }); return null; })
      .finally(() => chat.background.delete(job));
    chat.background.add(job);
    return job;
  }

  // ---- status ---------------------------------------------------------------------------------------------------

  chatState(characterId) {
    const chat = this.chat(characterId);
    const last = this.store.lastTurn(characterId);
    return {
      pending: chat.pending ? { kind: chat.pending.kind, stage: chat.pending.stage, startedAt: chat.pending.startedAt } : null,
      autonomousGenerating: chat.background.size > 0,
      error: chat.lastError,
      retryAvailable: !chat.pending && last?.role === "user",
      timer: chat.timer ? { kind: chat.timer.kind, dueAt: chat.timer.dueAt } : null
    };
  }

  status() {
    return {
      chats: [...this.chats.entries()].map(([characterId, chat]) => ({ characterId, ...this.chatState(characterId), backgroundJobs: chat.background.size })),
      clients: [...this.clients.entries()].map(([clientId, client]) => ({ clientId: clientId.slice(0, 6), characterId: client.characterId, lastSeen: new Date(client.lastSeen).toISOString(), draftNonEmpty: client.draftNonEmpty }))
    };
  }
}
