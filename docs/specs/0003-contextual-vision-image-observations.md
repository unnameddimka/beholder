# Beholder — Specification 0003: Contextual Vision and Image Observations

**Status:** FORMAL SPECIFICATION. This commit authorizes documentation only; implementation requires a separate explicit owner command.
**Project:** Beholder
**Baseline:** Specifications 0000–0002, main commit 292d9c3da87c5d6822f64888eacbd6a63e21d2b4 (GitHub Actions source snapshot).
**Scope:** Incoming user images, the Vision model role, contextual visual perception, typed verbatim observations, memory integration, chat UI, file persistence, and failure behavior.

## 0. Executive summary (owner / Claude)

1. **Architectural decisions:** Add an independent OpenRouter **Vision** model role. It receives the uploaded image, the selected character's **entire currently active verbatim window**, and the **current gestalt** from that character's interpretation pool. It never receives STM/LTM, raw interpretations, or experiment intentions. Its result is a **typed image_observation entry in the same verbatim stream**, linked to the user's image message; no separate visual memory subsystem. User-uploaded originals live in their own sibling directory alongside existing generated images. Existing verbatim → STM → LTM lifecycle is reused unchanged in its fundamental timing and size rules.
2. **User-visible behavior:** An Attach Image button appears **to the left of the chat text input**, with preview and removal before Send. The user can send image + text or image alone. A contextual visual description is created before Dialogue replies. Dialogue reacts to what it has been shown, not to a fabricated image caption. If Vision fails, Dialogue knows the image could not be viewed and can say so without pretending to see anything.
3. **Objections and risks:** Context-dependent attention must not become hallucinated visual facts. Observation provenance must be understood by STM consolidation but **must not become a permanent typed marker on STM/LTM**. A new non-speech verbatim kind must not break Retry, turn ordering, active-window counts, time markers, follow-ups, or contemplation triggers. Uploaded files, data URLs and secrets must not leak to diagnostics, dumps, or unsafe HTTP paths. A definitive public-upload size limit is a **pre-publication requirement**.
4. **Owner decisions required:** **None**. No additional architectural choices are delegated to the implementer. The owner selected three Vision models, Gemini 3 Flash as default, prose observation strictly limited to what is visible, gestalt + verbatim context only, and verbatim-only provenance markers.

This specification is additive. Where it modifies Spec 0000, it explicitly names the change. Specs 0001 and 0002, including Baidu exclusion and the semantics of gestalt, remain in force.

## 1. Purpose and fundamental semantics

Vision is an **organ of perception** for the character, not a second Dialogue agent, an independent psychologist, a generic captioning bot, or a planner. It observes an image in the context of the ongoing relationship but must produce **only a description of the image's visible content**.

The distinction is central:

- **Context influences attention and descriptive emphasis**: which details are noticed, described precisely, or considered relevant to the current exchange.
- **Context must NOT influence claimed visual evidence**: what objects, people, colors, expressions, inscriptions, or spatial relations are said to be present.
- **No confabulation**: no invented image details, invisible attributes, or invented facts about the subject.
- **No interpretation**: no psychological profiling, symbolism, intent-attribution, predictions, emotional/relationship analyses, or conclusions about the user. Those belong to Dialogue and Contemplation, not Vision.
- Observations remain **prose**: one readable, coherent description, with specificity and uncertainty where the image warrants them, not a mandatory taxonomy, field-by-field extraction, or JSON list of traits.
- If context suggests paying attention to a particular detail, the model must describe it **only if actually visible**. If it is ambiguous or obscured, state the uncertainty rather than inventing an answer.
- A message calling an image "my selfie" conveys what **the user claims about the image**. Vision may describe the depicted person in detail but must not independently certify that this is the user, verify identity, or infer personality from appearance.

### Canonical test case

User message: **"Вот моё селфи"** + a real selfie.

A successful observation may say, using actual visible facts from the test photograph: "The image shows a person with [visibly identifiable haircut, glasses, facial hair, expression, clothing, posture, background, lighting, etc.]." Description length and focus depend on what is visible and the verbatim/gestalt context.

The following are **NOT** valid observation content:
- "The user is trying to become closer to me."
- "He looks like an intellectual, just as I expected."
- "The user is definitely the person depicted."
- "The user has told me he looks like this."
- "I am moved to finally see his face."

Dialogue may independently consider possible meanings of the event and respond naturally. The Vision observation itself is confined to grounded visible description.

## 2. Vision model role and settings

### V1. Independent role

Add a fourth model role, **vision**, distinct from:
- dialogue (including memory),
- contemplation,
- image (the existing image-generation role).

Vision invokes OpenRouter **text-returning multimodal Chat Completions**, not the separate Images API used for generation. Keep Dialogue on its existing selected text model.

### V2. Curated model control

On the Settings page add a separately labeled **Vision model** control for incoming image perception, analogous to existing model controls, with exactly these **curated choices**:

1. **Google Gemini 3 Flash Preview** — default model ID: **google/gemini-3-flash-preview**.
2. **Qwen3-VL-235B-A22B Instruct** — model ID: **qwen/qwen3-vl-235b-a22b-instruct**.
3. **Google Gemini 3.1 Flash Lite** — model ID: **google/gemini-3.1-flash-lite**.

Official model pages at the time of drafting:
- https://openrouter.ai/google/gemini-3-flash-preview
- https://openrouter.ai/qwen/qwen3-vl-235b-a22b-instruct
- https://openrouter.ai/google/gemini-3.1-flash-lite

The three are curated, not a restriction forbidding future compatible model IDs if the existing settings pattern allows custom IDs. The selected model must support **image input and text output**; validate known catalog capability and surface an actionable failure for incompatible models instead of silently switching models.

### V3. Settings migration and model execution

- Preserve all existing settings during upgrade; add only the vision role with its default. Existing dialogue, contemplation, image models and toggles must not reset.
- Vision uses the existing OpenRouter API key, provider selection policy including Spec 0002's **Baidu exclusion for all text Chat Completions**, timeouts/retries and diagnostic conventions.
- Any max output tokens / temperature parameters for Vision must follow its own supported settings or safe role-local defaults. Do not make a Vision setting overwrite the Dialogue or Contemplation settings.
- Existing **Enable image generation** toggle is unrelated. Turning image generation off must **not** disable the ability to upload and perceive user images.
- Do not add a new general-purpose model router or another external image-recognition service.

## 3. Exact input boundary for Vision

### V4. Inputs

Each Vision request receives:

1. **The exact uploaded image** being perceived, as an image content part through OpenRouter's supported multimodal request format.
2. **The complete active verbatim window** for this character (currently 80–100 entries, bounded by VERBATIM_WINDOW = 100; see section 6), including the current user's image-bearing message and relevant previous image_observation entries.
3. **The latest persisted gestalt** of the character's currently selected interpretation pool, if one exists and Contemplation is enabled.

The instruction prompt additionally establishes the task/observation contract in section 1.

**Do not pass** raw interpretations, STM, LTM, memory retrieval results, active experiments, a separate psychological profile, or another conversation summary. The current verbatim provides actual dialogue context; gestalt provides an evolving, incomplete impression. These are the **only two textual context sources**. The uploaded image itself is the third, non-text input.

Preserve message order, speaker identity, timestamps/provenance and the distinction between speech and internal image observations in the verbatim serialization. Gestalt is explicitly labeled an uncertain perspective and cannot override visual evidence.

If there is no gestalt, Vision still runs with the image and verbatim. If Contemplation is disabled, do not resurrect a disabled gestalt merely for Vision. The model must not rely on data it was not supplied.

### V5. Context size and output

- Do not silently drop verbatim entries, silently remove the gestalt, or truncate the uploaded image to make a request appear to fit. On an unsupported/oversized context, report a Vision processing failure and use section 8's fallback.
- Output is a **single nonempty prose observation** with reasonable bounded length. Validate length/non-emptiness and reject outputs that are unusable, clearly formatted as instructions or full of unsupported interpretive material. Normal open-ended descriptive accuracy cannot be guaranteed by mechanical checks; prompts and manual evaluation remain necessary.
- No mandatory separate "literal facts vs thoughts" field, no inference list, no image-based diagnostic personality assessment. A structured transport wrapper is acceptable only if it preserves one prose observation and is not exposed as memory schema.
- Keep selected-model metadata and errors in diagnostics without recording raw uploaded image bytes or user secrets.

## 4. Sending an image in chat

### U1. UI placement and mechanics

- Add an **Attach Image** button immediately **to the left of** the chat message textarea.
- Clicking opens the native local file picker (image files only). Show a thumbnail/preview of the selected image beside the composer; allow removing it **before** Send.
- Support **text plus one attached image**, or **one image with an empty text field**. Existing text-only Send remains unchanged.
- The composer and keyboard behavior should remain familiar. Prevent inadvertent double submits; clear draft/attachment after a successful send, retain them and show an error on rejected uploads.
- In the conversation, display the uploaded original as an attachment to the user's message with the user's optional text. An internal image_observation is **not another chat utterance**; it must never be rendered as something the user or character said.
- Generated outgoing images remain visually and functionally distinct from incoming uploaded images.

For this patch, **one image per user message**. Multi-image messages, camera capture, drag-and-drop, paste-from-clipboard, video and audio are out of scope.

### U2. Submit lifecycle

The logical event sequence is:

1. User attaches a local image and optionally types text, then clicks Send.
2. Server validates/stores the original uploaded image and persists the **user message associated with that image**. A server-side rejected upload must not leave a fake, successfully sent image message.
3. Before Dialogue replies, a Vision request is performed with the image, current verbatim including the new user message, and selected gestalt.
4. On Vision success: persist **one typed image_observation verbatim entry**, linked to the user message/image, containing only the prose description.
5. Dialogue receives that observation in its normal verbatim context and generates the usual reply. Contemplation sees the same verbatim event(s) through the existing user-message processing pathway.
6. On Vision failure: **do not insert an image_observation**. Proceed with the still-persisted user message and a specific non-speech service context: "An image was attached, but I could not view it." Dialogue may acknowledge the failure or ask the user to send it again; it must not invent the image contents.

Treat an uploaded image and its observation as **one user-originated turn**, not a second user utterance or a second automatic response trigger. Call Contemplation with the completed turn once, after Vision succeeds or fails, rather than triggering it before a still-pending observation can be recorded.

### U3. Atomicity, races and recovery

- A message may be persisted while perception is pending, but it must not cause a premature reply that lacks its eventually successful observation.
- Link uploaded image, user message, observation, and processing state through stable persisted identifiers. There must be at most one successful observation for a given uploaded image / message, even after retries or restarts.
- Use bounded Vision requests and retry behavior. A transient vision failure cannot hang the chat indefinitely, prevent Dialogue from responding, or silently lose the uploaded original.
- On restart, recover a persisted **pending** image perception if possible; distinguish pending from explicitly **failed** perception and avoid generating duplicate observations/replies. A failed perception may proceed through the dialogue-failure-context path without requiring a new UI retry feature.
- A Dialogue Retry after an image-bearing user turn must not duplicate its original user message, image, or observation; it reuses the available observation or known Vision failure. If no observation was successfully created, Retry must not imply that the character has seen the image.
- Reconcile partially committed file/DB work safely after crashes; never serve a DB row referencing a non-existent file as a valid image.
- Only one reply per logical user turn; preserve existing busy-state, cancellation and follow-up scheduling guarantees.

## 5. Persistent uploaded files

### F1. Location and originals

Existing generated images are stored under **data/images**. Store **user-uploaded original images under data/uploaded-images**, a **separate sibling directory under the same persistent data volume**.

- Preserve **original image bytes**, not a recompressed or rewritten replacement; preserve verified MIME/format metadata.
- Persist a durable association between the uploaded file, user message and eventual observation. Use safe random server-generated filenames, not user-controlled paths.
- Only serve verified files through a constrained route, with safe Content-Type, no sniffing, no directory traversal and no arbitrary file access.
- Display uploaded images in chat even after verbatim consolidation, subject to the existing historical transcript and file persistence rules.
- Files are **not deleted** by verbatim → STM or STM → LTM consolidation.
- Include the new uploads directory in the same **persistent volume/backup plan** as generated images. The existing compose volume covers the data directory; don't move files to ephemeral container storage.

### F2. File validation and safe transport

- Restrict to supported raster inputs (at least JPEG, PNG and WebP where supported), validated by **real file bytes**, not filename/declared MIME alone. Reject unsupported formats with a clear error. Do not process remote user-supplied image URLs as upload destinations.
- Use bounded multipart/binary upload handling or an equivalently bounded transport. The existing **256 KiB JSON request limit** cannot simply be replaced by an unlimited base64 body.
- Validate request/body size and actual file size, avoid unbounded buffering, sanitize file names, handle aborted uploads and partial files, and do not allow oversized/invalid files to reach OpenRouter.
- Image bytes/base64/data URLs are sensitive, often large; **do not include them in diagnostics, ordinary logs, emergency ZIP dumps or exposed chat JSON**. Dumps may include safe metadata (file reference, MIME, byte count, processing status, observation text).
- The server is currently trusted-LAN-only with no authentication. This patch must **not** be presented as making it safe to expose publicly; keep current access assumptions.

### F3. Pre-publication upload-size release gate

The owner explicitly requested a **publication-stage size limit**. Therefore:

- **Before any public release**, set and enforce an explicit product upload-size maximum both in the browser (immediate feedback) and **authoritatively on the server** (cannot be bypassed). Test oversize rejection, correct HTTP status and no leaked temporary files.
- The numeric public product maximum is **not selected by this specification**; decide it against OpenRouter/model limits and deployment budget at publication.
- This does **not** authorize an unlimited upload in the initial private implementation: it still needs conservative **technical safety bounds** on request and memory/byte processing from the start. These provisional technical bounds are not the final public product limit.

## 6. Typed verbatim and the ordinary memory lifecycle

### M1. Image observation as a verbatim entity

Extend the existing transcript/verbatim domain with a **typed, non-dialogue entry** (conceptually **image_observation**) and a stable link to its source user image message. This is **not** a user utterance and **not** a character utterance.

It has its own chronological position, immutable prose content, source image association and creation time. Its type marker is **structural in verbatim** (not a prose prefix masquerading as a user message).

Expose this type faithfully in all consumers of verbatim:
- Dialogue context, including opener/follow-up/Retry where applicable;
- Contemplation prefetch and later interpretation maintenance/generation that use the recent verbatim;
- STM consolidation input and its retained-context tail;
- read-only transcript and diagnostic state as appropriate.

Do not treat observation as a fresh user prompt, change the user/assistant role of neighboring messages, or schedule independent Dialogue/Contemplation jobs because an observation was inserted.

### M2. The marker stops at the verbatim boundary

**Critical owner correction:** The **type marker does NOT survive as a required typed field in STM or LTM**. Its role is to explain the source of a piece of observed evidence **to the model performing verbatim → STM consolidation**.

The downstream memory is **ordinary prose**, with accurate semantic provenance expressed in its words. No image-memory tier, no typed STM/LTM visual record, no propagated image_observation marker in later memory schemas.

For the selfie test, consolidation should preserve something like:

> "The user showed me a photo that they called their selfie. The person pictured had [the details actually described by Vision]."

It must **not** rewrite that as:
- "The user told me they look like [details]." (false source modality)
- "The user looks like [details]." (unqualified identity claim, loss of source)
- "I saw that the user definitely has [details]." (unjustified certainty)

The user **presented** the image as their selfie. The observation **described what was visibly depicted**. STM represents that event and its evidential limits in prose. STM → LTM then operates on the existing natural-language memory without requiring the marker. The model may selectively retain/forget details according to the **existing ordinary memory rules**; not every visual feature is guaranteed to survive permanently.

For other images, analogously preserve "the user showed me an image of..." rather than attributing the image contents to the user's text claims.

### M3. Keep the established 80–100 verbatim behavior

Maintain the existing:
- **VERBATIM_WINDOW = 100 active entries**;
- **STM_BATCH = 20**, consolidating the oldest batch on reaching the window threshold and retaining the newer ~80 entries;
- **midnight consolidation = STM → LTM only** (server-local daily boundary);
- full historical transcript persists unchanged when old verbatim entries become inactive.

Image observations are **ordinary counted verbatim entries for windowing**, not unlimited extra context and not permanently exempt from consolidation. The user asked that approximately **80–100 most recent verbatim entries always remain verbatim**, including across midnight. Do not introduce a midnight verbatim → STM flush or reset.

An image-bearing turn containing user text and image_observation occupies **two typed entries** in that stream (one when observation succeeds); no observation entry is added on failure. Ensure consolidation is safe when a window boundary is near such a pair: the observation's association and source semantics must remain correct, whether one or both entries are in the consumed prefix or retained context.

Pending Vision work must not cause its user message to be consolidated out of the active context before the corresponding observation is committed, or else make the resulting memory provenance inconsistent. Implement a narrow sequencing safeguard within the existing lifecycle.

### M4. Preserve chat semantics despite the new entry type

- **Retry** identifies the latest unanswered logical **user turn**, not simply the last raw row; an observation after a user message must not make Retry unavailable.
- **Openers and follow-ups** must not consider observation to be character speech or a new user input. Timer cancellation and reply anchoring continue to use actual chat turns.
- Clock and timestamp context must distinguish an observation's occurrence from when the message was written; do not label it as something the user "said".
- Pinned self-description and fetched memory records remain separate from verbatim for Dialogue. Vision sees neither.
- Contemplation's user-message watermarks continue to advance from actual **user messages**. Observation can enrich what prefetch sees, but does not itself become another user-triggered run.

## 7. Dialogue behavior and failure semantics

### D1. Successful observation

Dialogue receives a clearly labeled image_observation with its provenance and the immediately preceding user turn. It may naturally discuss visible details or speculate **as Dialogue**, using its normal persona/gestalt/experiment/memory context, without falsely presenting those speculations as Vision facts.

Do not pass the raw image to the text-only Dialogue model; **the observation is its visual input**. Keep Spec 0001's response envelope, timestamps, plain-text recovery, follow-up and imageRequest behavior unchanged.

### D2. Failed observation

A failed Vision attempt still leaves the user's text, uploaded file and attachment visible. Dialogue receives **explicit service-level failure context** tied to that image: "The attached image could not be viewed." No fake observation record or empty observation placeholder is inserted into verbatim.

Dialogue may truthfully acknowledge the inability to view it and suggest resending. It must not claim to have examined the picture, invent its contents or convert the error into a memory of the supposed contents. On normal later requests, a persisted failed-image status can be conveyed appropriately without rewriting it into a user statement or an observation of visible content.

Do not conflate "Vision failed" with "Dialogue failed." Both error pathways retain their existing independently actionable diagnostics.

## 8. Diagnostics, documentation and boundaries

### O1. Diagnostics and dump

- Track Vision request purpose, configured model, selected provider when exposed, processing duration, processing state and safely redacted failures.
- Emergency Dump should contain **typed observation metadata/text, references to uploaded files and processing status**, but no original image bytes or base64. Uploaded originals remain in the local data directory, outside the dump.
- Do not leak API keys, raw images or temporary access URLs through the request/response tracing layer.
- Update README and AGENTS.md for the new Vision role, file layout, typed verbatim semantics, upload behavior, release gate, and real lifecycle details.

### O2. Scope exclusions

Do **not** introduce:
- a separate Vision STM/LTM store or long-lived extra image-description database unrelated to verbatim;
- transmission of raw interpretations, STM, LTM, active experiment intentions or the pinned user description to Vision;
- automatic model replacement, a second agent orchestrator, multi-image inputs, identity matching across photos, facial recognition, emotion/character prediction from facial traits, video/audio perception, or active tool calls by Dialogue back into Vision;
- changes to existing outgoing image generation or its storage;
- a public hosting/authentication deployment;
- manual editing/Force controls on the read-only Contemplation page.

The implementation may choose narrow technical upload parsing, schema migration, job/status representation and recovery mechanisms **within these requirements**. Any larger architectural departure requires explicit owner approval before code is written.

## 9. Acceptance scenarios

### Model and settings

1. Existing saved settings migrate without loss; Vision defaults to **google/gemini-3-flash-preview**, while prior role settings stay unchanged.
2. The Vision control presents the **three specified options**, saves/reloads the selection, and uses the selected image-capable model; Dialogue model is not replaced.
3. Image generation can be disabled while incoming image perception still works.
4. Vision's outgoing Chat Completions request contains an image content part plus the full active verbatim snapshot and the current appropriate gestalt, and contains **no STM, LTM, raw interpretations, experiments or pinned self-description**.
5. With no gestalt or disabled Contemplation, image processing still succeeds using image + verbatim only; shared/private interpretation-pool selection works correctly.
6. Vision text request keeps **baidu** and all previously ignored OpenRouter providers excluded, without modifying the selected model.
7. Unsupported/non-vision model or oversized context yields a well-recorded failure and a truthful Dialogue fallback, not silent model substitution or context truncation.

### Basic selfie and perception semantics

8. Sending a valid actual selfie with the text **"Вот моё селфи"** stores the original and creates one visual observation before Dialogue responds.
9. With a mocked image containing unambiguous visual features, the observation records those specifics as prose; the task prompt explicitly forbids invented details, inferred user identity, personality or intentions.
10. Changing the verbatim/gestalt context may change **salience, ordering and descriptive emphasis** on the same image, but it must not change the visually grounded facts in a mock fixture.
11. The Vision observation itself contains **no contextual relationship analysis** or "the user is doing this to..." speculation. Dialogue may interpret its significance in its own reply.
12. An ambiguous feature in a test image is described tentatively or omitted; the model is not instructed to guess.
13. A user who says "my selfie" is recorded as **claiming that relationship to the image**, not as having an independently verified face identity.

### Chat UI and lifecycle

14. Attach Image button is visibly left of the composer; selecting a supported file shows a preview; removing it restores ordinary text-only composition.
15. **Image only**, **image + text**, and **text only** are valid sends; an empty send with no attachment remains invalid. Keyboard submission and normal draft preservation work.
16. The sent message displays the uploaded image with appropriate text, never as generated character art. The internal observation does **not** appear as a message spoken by the user or character.
17. One image + one user message produces one logical user turn, **one observation on success and one Dialogue reply**; no premature reply before perception and no duplicate Contemplation triggers.
18. Rejecting an invalid or oversized upload does not leave a misleading sent message or accessible partial file.
19. Failure/timeout in Vision preserves the user message and original, inserts **zero** observation entries, and lets Dialogue respond with explicit knowledge that it could not view the image; no hallucinated image claims.
20. Restart while a Vision job is pending recovers/reconciles processing without duplicate observations or duplicate replies. Dialogue Retry never duplicates the original user turn or attachment.
21. Uploaded originals survive restart and consolidation and are served only by a validated, scoped image-serving path.

### Verbatim and consolidation

22. A successful observation is a **typed non-speech verbatim entry** with a source link and timestamp. It is never treated as a user utterance, character utterance, fresh message trigger, or reason to disable Retry.
23. Dialogue and Contemplation receive it with type semantics; STM consolidation sees the same marker and consumes it as **visual evidence from an image shown by the user**.
24. Mock verbatim → STM output says, in ordinary prose, **"the user showed me a selfie depicting..."**, **not** "the user told me..." and **not** "the user looks..." as an unconditional fact.
25. STM and LTM records remain **ordinary prose**, with no required structural image-observation marker; normal STM → LTM selection, retirement, provenance and memory retrieval work unchanged.
26. A verbatim window crossing midnight remains intact. **STM → LTM** occurs when due, with no midnight verbatim flush. The 100 / 20 / ~80 window semantics remain intact when observations enter and age out.
27. Tests cover an image observation adjacent to an STM batch boundary and verify correct linked-event provenance, no lost pending image and no duplicate consolidation.
28. Follow-up scheduling, opener eligibility, reply time markers and Retry are correct when the latest raw verbatim entry is an observation rather than a human/character message.

### Safety, diagnostics and compatibility

29. Upload validation checks file signature and supported MIME, rejects unsafe paths, unsupported types, body/byte overruns and canceled uploads; neither valid nor invalid files can be used for arbitrary file reads.
30. Raw uploaded image bytes/base64 never appear in ordinary application logs, LLM diagnostics or the Emergency Dump; the dump retains safe image and observation metadata instead.
31. The new **data/uploaded-images** directory persists under the existing data volume, independently of **data/images**; generated-image flow is unaffected.
32. Before public release, automated tests prove a **product upload-size maximum** enforced client-side and server-side with clear rejection behavior. Its numerical value is deliberately pending a later owner/release decision.
33. Existing Specs 0000–0002 suites and the new Vision tests pass on the supported Node.js runtime; documentation matches actual verified behavior.

Tests should verify state transitions, prompt/context isolation, storage, timing and provenance deterministically using mocked LLMs and known fixtures. A real multimodal image test is an additional manual semantic check, not something that unit tests can conclusively prove.

## 10. Implementation and review procedure

1. **Do not implement from this document alone.** The owner will separately authorize the implementation stage.
2. Code review is against the **GitHub Actions source snapshot** for the implementing commit, not an arbitrary local checkout.
3. Put Claude/ChatGPT reviewer messages under **docs/review/** only when explicitly requested.
4. In reviewer messages, summarize architectural decisions, player/user-visible behavior, objections/risks, and owner decisions before technical findings.
5. Do not extend the architecture, run a public deployment or alter unrelated project features without a new explicit owner decision.

**End of Specification 0003.**
