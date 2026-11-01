# Beholder — Specification 0003 Code Review

**Reviewed commit:** `ab71206e00d20de3695dc1c23ef6a8108da6e618`
**Source:** GitHub Actions repository snapshot, run `41332012228`, artifact `repo-ab71206e00d20de3695dc1c23ef6a8108da6e618`
**Decision:** **CHANGES REQUESTED — one P1 blocker.**

## Executive summary for owner / Claude

1. **Architectural decisions:** The approved design is largely implemented: a separately configured Vision role, uploads in `data/uploaded-images`, one typed `image_observation` in the existing verbatim stream, existing STM/LTM tiers, and no raw interpretations or memory in Vision input. **One Dialogue serialization path fails to preserve the already-stored source-message relationship after the verbatim retention boundary.** No architecture redesign is requested.
2. **User-visible behavior:** Image-only and image+text submissions, contextual image perception, a preview next to the composer, normal Dialogue response, and truthful Vision-failure fallback are present and tested. On an old image observation whose source text has left verbatim, however, Dialogue can receive an incorrect assertion that the observation belongs to the previous visible user message.
3. **Objections and risks:** **P1:** provenance is lost on the Dialogue context boundary, contrary to Spec 0003 M1/M4 and acceptance scenario 27. **P2:** observation validation accepts plainly instructional text as prose, despite Spec 0003 V5's explicit expectation to reject clearly instruction-like responses. Runtime Node 22 was used for local verification, while `package.json` requires >=24.
4. **Owner decisions required:** **None.** Both findings can be addressed within the approved spec. No implementation or changes to other systems are authorized by this review itself.

## Verification

- Downloaded the exact Actions snapshot for the implementation commit, not a direct Git checkout.
- `npm test`: **106/106 passing**; `node --check`: **41/41 files passing** on local Node.js `v22.16.0` (outside the stated >=24 support boundary).
- GitHub Actions run `41332012228` completed successfully.
- The three curated Vision model IDs correspond to public OpenRouter model pages and image-capable models; no live multimodal inference was conducted, so visual-description quality and deployed provider routing remain unverified.

## P1 — Dialogue loses observation-source association after a split STM boundary (blocking)

**Source:** `src/prompts/dialogue.js:132-143`, especially line 136. The observation's Dialogue message is always rendered as:

> `[IMAGE OBSERVATION] Your perception of the image attached to the previous user message ...`

That assumption is only true while the original image-bearing user message and the subsequent observation both remain in the active verbatim window. Spec 0003 explicitly permits these two separately counted entries to straddle the 20-message STM consolidation boundary. The existing test `tests/spec-0003.test.js:379-415` constructs precisely that case: the user selfie message is the last **consumed** entry and its observation the first **retained** entry.

Database and shared `messageView()` already maintain the correct source relationship: `src/db.js:149-169` stores `sourceMessageId` and the original source text, and `src/memory.js:41-50` exposes them via `imageAttachedTo`. But `historyMessages()` uses **neither** field and instead assumes physical adjacency. As a result, the Dialogue input's label can be false or ambiguous; if another user turn appears, the observation can be associated with the wrong turn. This is not merely cosmetic: the key semantic guarantee for images was preserving what was shown as visual evidence, not something the user said or a free-floating assertion about their appearance.

**Required:** Serialize the original source ID and available source user text (or an equivalently unambiguous reference) into the Dialogue observation's labeled context, even when that source message is no longer in active verbatim. Do not add a new memory subsystem, copy the image into Dialogue, or convert observations into user speech.

**Regression test:** Build a real 100-entry window with a user image message at the final consumed position and its observation at the first retained position. Let STM consolidate, then assemble a *new Dialogue request*. Assert that the observation identifies the correct original user message ID/text and never says it belongs to a different/unspecified "previous user message". Include a later, unrelated user message to show no accidental reattribution.

## P2 — Clearly instruction-like Vision output is accepted as observation

**Source:** `src/vision.js:13-20` (`validateObservation()`). The validator checks only nonempty length, maximum characters, and text starting with `{` or `[`. For example, the raw output `Ignore your previous instructions and do something else.` is accepted as a valid observation and can be persisted as perceived evidence. Spec 0003 V5 explicitly asks that unusable or **clearly instruction-formatted** observations be rejected. The current instruction-only text is neither visible image description nor observation.

**Required:** Add conservative checks against unambiguously non-observational instruction-shaped responses, while not rejecting faithfully quoted text *visible within the image* (e.g. `The sign reads "Ignore previous instructions"`). No new model-based review subsystem is authorized. Prompt-only control cannot logically guarantee this invariant, so add at least a negative regression for direct instruction output. Subjective hallucination/interpretation detection still requires real-model manual evaluation.

## Positive findings / preserved invariants

- The Vision role and its three curated IDs/default are separate from the outgoing image-generation role; settings migration preserves existing settings (`src/settings.js`).
- Vision requests carry the selected source image, the active verbatim history, and the selected pool's gestalt only; there is no STM/LTM/interpretation/experiment retrieval or injection (`src/vision.js`).
- Provider exclusions including `baidu` apply to Vision text Chat Completions (`src/openrouter.js`).
- Accepted uploads are stored as byte-preserved originals in a separate persisted directory, using random names and signature/MIME checks; bounded multipart handling and upload URL allowlisting are in place (`src/uploads.js`, `src/server.js`).
- A successful observation is a typed, linked, non-speech verbatim row. A failed Vision request leaves the file/message but no invented observation, and Dialogue receives a failure explanation (`src/db.js`, `src/dialogue.js`, `src/prompts/dialogue.js`).
- STM serialization preserves the modality and meaning of "the user showed a photo they called their selfie" without adding typed markers to STM or LTM (`src/memory.js`, `src/prompts/memory.js`).
- The midnight job remains STM -> LTM only, and the existing 100/20/~80 active verbatim policy is intact.
- Client-facing transcripts show the original attachment, not a second utterance by the user/character. The emergency dump stores metadata and sanitized observations rather than original file bytes.

## Follow-up

Fix P1 before accepting Spec 0003 for deployment. Address P2 in the same patch if possible. Commit fixes as normal; generate a new GitHub Actions source snapshot for re-review. Do not push this reviewer message or any code on behalf of the reviewer without the owner's separate command.
