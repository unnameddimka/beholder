// Vision (Specification 0003): perceives one user-uploaded image with the Vision model, given the chat's whole active
// verbatim window, the current gestalt and the character's three descriptions (Specification 0005 C4), and records the result as a typed image_observation verbatim entry. It
// never throws to its caller: a failure is recorded on the upload, and Dialogue then knows the image was not seen.
import fs from "node:fs/promises";
import { coded } from "./utils.js";
import { poolOf } from "./db.js";
import { messageView, VERBATIM_WINDOW } from "./memory.js";
import { detectRasterMime } from "./images.js";
import { visionSystemPrompt, VISION_OBSERVATION_MAX_CHARS } from "./prompts/vision.js";
import { characterContext } from "./prompts/context.js";
import { profileOf } from "./settings.js";

const wireMessage = (id) => `msg_${id}`;

// Unambiguous instruction or chat-role shapes (review 0003 P2), checked outside quoted text so that writing visible in
// the image, quoted in the description, stays acceptable.
const INSTRUCTION_PATTERNS = Object.freeze([
  /\b(ignore|disregard|forget|override)\s+(?:(?:all|any|the|your|my|these|those)\s+)*(?:previous|prior|above|earlier|system|original)\s+(?:instructions?|prompts?|messages?|rules)\b/i,
  /(игнорируй|игнорируйте|забудь|забудьте|проигнорируй)\s+(?:все\s+)?(?:предыдущие|прошлые|прежние|системные)\s+(?:инструкции|указания|правила)/i,
  /^\s*(?:system|assistant|developer|user)\s*:/im,
  /^\s*(?:you are now|from now on|you must|you should|new instructions?)\b/i,
  /^\s*(?:instructions?|task|answer|response|reply)\s*:/i
]);
const QUOTED = /"[^"\n]*"|“[^”\n]*”|«[^»\n]*»|„[^“”\n]*[“”]|'[^'\n]{2,}'/g;

// One non-empty prose observation; structured or instruction-like output is unusable rather than repaired, because
// a repair would need the image again and the result is evidence, not a format.
export function validateObservation(content) {
  const text = String(content ?? "").trim().replace(/^\x60{3}[A-Za-z]*\s*([\s\S]*?)\s*\x60{3}$/, "$1").trim();
  if (!text) return { ok: false, error: "empty observation" };
  if (text.length > VISION_OBSERVATION_MAX_CHARS) return { ok: false, error: `observation longer than ${VISION_OBSERVATION_MAX_CHARS} characters` };
  if (/^[{[]/.test(text)) return { ok: false, error: "observation is structured data, not prose" };
  const unquoted = text.replace(QUOTED, "\"\"");
  if (INSTRUCTION_PATTERNS.some((pattern) => pattern.test(unquoted))) return { ok: false, error: "observation is shaped like instructions, not a description" };
  return { ok: true, text };
}

export class Vision {
  constructor({ store, llm, diagnostics, uploads }) {
    this.store = store;
    this.llm = llm;
    this.diagnostics = diagnostics;
    this.uploads = uploads;
    this.inFlight = new Map();
  }

  // At most one perception per upload at a time; a repeated call joins the running one. profile is the frozen
  // snapshot of the reply job this perception belongs to (review 0005 P2-A).
  observe(uploadId, profile = null) {
    if (!this.inFlight.has(uploadId)) {
      const job = this.run(uploadId, profile).finally(() => this.inFlight.delete(uploadId));
      this.inFlight.set(uploadId, job);
    }
    return this.inFlight.get(uploadId);
  }

  // The exact Vision request (exported shape for tests): system contract, then one user message holding the JSON
  // context and the image. The textual context is the character's descriptions, the verbatim window and the gestalt.
  buildMessages({ character, history, gestalt, messageId, dataUrl }) {
    const context = {
      characterContext: characterContext(character),
      conversation: { character: character.name, messages: history.map((message) => messageView(message, character.name)) },
      imageAttachedTo: wireMessage(messageId),
      gestalt: gestalt ? { note: "the character's tentative, incomplete impression of the user; it never overrides what the image shows", text: gestalt } : null
    };
    return [
      { role: "system", content: visionSystemPrompt(character.name) },
      { role: "user", content: [{ type: "text", text: JSON.stringify(context) }, { type: "image_url", image_url: { url: dataUrl } }] }
    ];
  }

  async run(uploadId, profile = null) {
    const upload = this.store.getUpload(uploadId);
    if (!upload || upload.status !== "pending") return { status: upload?.status ?? "missing" };
    const startedMs = Date.now();
    const context = { characterId: upload.characterId, messageId: upload.messageId, uploadId };
    // The owning character's Vision configuration and descriptions: the reply job's snapshot when it has one for
    // this character, otherwise one frozen now for this perception.
    const owner = profile?.characterId === upload.characterId ? null : this.store.getCharacter(upload.characterId);
    const character = profile?.characterId === upload.characterId ? profile : owner ? profileOf(owner) : null;
    const model = character?.config.models.vision ?? null;
    try {
      if (!character) throw coded("CHARACTER_NOT_FOUND", "Character not found.");
      let bytes;
      try { bytes = await fs.readFile(this.uploads.filePath(upload.file)); }
      catch { throw coded("UPLOAD_FILE_MISSING", "The uploaded image file is missing."); }
      if (detectRasterMime(bytes) !== upload.mime) throw coded("UPLOAD_FILE_INVALID", "The stored image no longer matches its recorded format.");
      try { await this.llm.modelCatalog(); } catch {}
      const capability = this.llm.visionCapability(model);
      if (!capability.ok) throw coded("VISION_MODEL_INCOMPATIBLE", `The Vision model ${model} does not accept image input with text output according to the OpenRouter catalogue; choose an image-capable model in this character's settings.`);
      const gestalt = character.config.contemplationEnabled ? this.store.ensureInterpretationPool(poolOf({ id: character.characterId })).gestalt : null;
      const history = this.store.activeMessages(upload.characterId, VERBATIM_WINDOW);
      const messages = this.buildMessages({ character, history, gestalt, messageId: upload.messageId, dataUrl: `data:${upload.mime};base64,${bytes.toString("base64")}` });
      const fit = this.llm.contextFit("vision", messages, character.config);
      if (fit && !fit.fits) throw coded("VISION_CONTEXT_EXCEEDED", `The image, the character context and the verbatim history do not fit the Vision model's context (estimated ${fit.estimatedTokens} of ${fit.contextLength} tokens); nothing was dropped to make it fit.`);
      const result = await this.llm.call({ purpose: "vision_observation", config: character.config, messages, context: { ...context, gestaltPresent: Boolean(gestalt), verbatimEntries: history.length } });
      const observation = validateObservation(result.content);
      if (!observation.ok) throw coded("VISION_OUTPUT_INVALID", `The Vision model returned an unusable observation: ${observation.error}.`);
      const committed = this.store.tx(() => {
        if (this.store.getUpload(uploadId)?.status !== "pending") return null;
        const entry = this.store.addMessage({ characterId: upload.characterId, role: "observation", kind: "image_observation", text: observation.text, sourceMessageId: upload.messageId });
        this.store.completeUpload(uploadId, { observationMessageId: entry.id, model: result.model || model });
        return entry;
      });
      this.diagnostics.event({ type: "vision-observation", ...context, status: committed ? "observed" : "superseded", model: result.model || model, provider: result.provider || null,
        elapsedMs: Date.now() - startedMs, characters: observation.text.length });
      return committed ? { status: "observed", observationMessageId: committed.id } : { status: this.store.getUpload(uploadId)?.status ?? "missing" };
    } catch (error) {
      this.fail(uploadId, error, { model, elapsedMs: Date.now() - startedMs });
      return { status: "failed", code: error.code || "VISION_FAILED" };
    }
  }

  fail(uploadId, error, extra = {}) {
    const upload = this.store.getUpload(uploadId);
    this.store.failUpload(uploadId, { code: error.code || "VISION_FAILED", message: error.message, model: extra.model ?? null });
    this.diagnostics.error("vision_observation", error, { characterId: upload?.characterId ?? null, messageId: upload?.messageId ?? null, uploadId, ...extra });
    this.diagnostics.event({ type: "vision-observation", uploadId, characterId: upload?.characterId ?? null, status: "failed", code: error.code || "VISION_FAILED", ...extra });
  }

  status() { return { inFlight: [...this.inFlight.keys()] }; }
}
