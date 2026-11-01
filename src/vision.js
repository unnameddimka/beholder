// Vision (Specification 0003): perceives one user-uploaded image with the Vision model, given the chat's whole active
// verbatim window and the current gestalt, and records the result as a typed image_observation verbatim entry. It
// never throws to its caller: a failure is recorded on the upload, and Dialogue then knows the image was not seen.
import fs from "node:fs/promises";
import { coded } from "./utils.js";
import { interpretationPoolOf } from "./db.js";
import { messageView, VERBATIM_WINDOW } from "./memory.js";
import { detectRasterMime } from "./images.js";
import { visionSystemPrompt, VISION_OBSERVATION_MAX_CHARS } from "./prompts/vision.js";

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
  constructor({ store, llm, settings, diagnostics, uploads }) {
    this.store = store;
    this.llm = llm;
    this.settings = settings;
    this.diagnostics = diagnostics;
    this.uploads = uploads;
    this.inFlight = new Map();
  }

  // At most one perception per upload at a time; a repeated call joins the running one.
  observe(uploadId) {
    if (!this.inFlight.has(uploadId)) {
      const job = this.run(uploadId).finally(() => this.inFlight.delete(uploadId));
      this.inFlight.set(uploadId, job);
    }
    return this.inFlight.get(uploadId);
  }

  // The exact Vision request (exported shape for tests): system contract, then one user message holding the JSON
  // context and the image. Only the verbatim window and the gestalt are textual context.
  buildMessages({ character, history, gestalt, messageId, dataUrl }) {
    const context = {
      conversation: { character: character.name, messages: history.map((message) => messageView(message, character.name)) },
      imageAttachedTo: wireMessage(messageId),
      gestalt: gestalt ? { note: "the character's tentative, incomplete impression of the user; it never overrides what the image shows", text: gestalt } : null
    };
    return [
      { role: "system", content: visionSystemPrompt(character.name) },
      { role: "user", content: [{ type: "text", text: JSON.stringify(context) }, { type: "image_url", image_url: { url: dataUrl } }] }
    ];
  }

  async run(uploadId) {
    const upload = this.store.getUpload(uploadId);
    if (!upload || upload.status !== "pending") return { status: upload?.status ?? "missing" };
    const startedMs = Date.now();
    const model = this.settings.get().models.vision;
    const context = { characterId: upload.characterId, messageId: upload.messageId, uploadId };
    try {
      const character = this.store.getCharacter(upload.characterId);
      if (!character) throw coded("CHARACTER_NOT_FOUND", "Character not found.");
      let bytes;
      try { bytes = await fs.readFile(this.uploads.filePath(upload.file)); }
      catch { throw coded("UPLOAD_FILE_MISSING", "The uploaded image file is missing."); }
      if (detectRasterMime(bytes) !== upload.mime) throw coded("UPLOAD_FILE_INVALID", "The stored image no longer matches its recorded format.");
      try { await this.llm.modelCatalog(); } catch {}
      const capability = this.llm.visionCapability(model);
      if (!capability.ok) throw coded("VISION_MODEL_INCOMPATIBLE", `The Vision model ${model} does not accept image input with text output according to the OpenRouter catalogue; choose an image-capable model in Settings.`);
      const settings = this.settings.get();
      const gestalt = settings.contemplationEnabled ? this.store.ensureInterpretationPool(interpretationPoolOf(character)).gestalt : null;
      const history = this.store.activeMessages(upload.characterId, VERBATIM_WINDOW);
      const messages = this.buildMessages({ character, history, gestalt, messageId: upload.messageId, dataUrl: `data:${upload.mime};base64,${bytes.toString("base64")}` });
      const fit = this.llm.contextFit("vision", messages);
      if (fit && !fit.fits) throw coded("VISION_CONTEXT_EXCEEDED", `The image and the verbatim history do not fit the Vision model's context (estimated ${fit.estimatedTokens} of ${fit.contextLength} tokens); nothing was dropped to make it fit.`);
      const result = await this.llm.call({ purpose: "vision_observation", messages, context: { ...context, gestaltPresent: Boolean(gestalt), verbatimEntries: history.length } });
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
