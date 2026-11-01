# Beholder — Specification 0003 Re-review

**Reviewed commit:** `82cb6119b7f8f9b02459b3f1a59442c6e46aada2`

**Source:** GitHub Actions snapshot from successful run `41335538468`, artifact `repo-82cb6119b7f8f9b02459b3f1a59442c6e46aada2`.

**Result:** CHANGES REQUESTED — one narrow residual provenance ambiguity; previous P2 fixed.

## Executive summary for owner / Claude

1. **Architectural decisions:** No unauthorized architecture changes. Source timestamps are now fetched through the existing persisted observation→user-message link. Vision validation now rejects clearly instruction-shaped output. However, Dialogue serialization does not include the persisted source-message ID, so timestamp-and-text is not an unambiguous identifier.
2. **User-visible behavior:** The common split-STM case is fixed: the character no longer assumes an image observation belongs to the previous visible user message. Two indistinguishable image-only or duplicate-text uploads within the same second can still be confused in the dialogue context.
3. **Objections and risks:** The original P1 requirement requested source ID plus text *or an equivalently unambiguous reference*. The current reference comprises a timestamp truncated to one second and optional user text; it is not guaranteed unique. P2 instruction-shaped output rejection is satisfactory as a conservative best-effort check. Live visual semantic quality remains untested; local runtime was Node 22, although the project requires >=24.
4. **Owner decisions required:** None. Fix inside the existing schema/prompt boundary; no new state or subsystem is needed.

## Verification

- Downloaded the exact GitHub Actions source snapshot, not a Git checkout.
- Inspected the exact changes since `ab71206`: `src/db.js`, `src/memory.js`, `src/prompts/dialogue.js`, `src/vision.js`, `README.md`, and `tests/spec-0003.test.js`.
- Ran `npm test` on the snapshot: **108/108 passed**, including both new review regression tests. The syntax check also succeeded.
- GitHub Actions run `41335538468` succeeded.

## Review of previous findings

**Previous P1 — mostly fixed, narrow residual ambiguity.**

`src/db.js` now exposes the source message's `createdAt`, and `src/memory.js` transmits it in Contemplation and STM views. `src/prompts/dialogue.js:128–140` labels a visual observation with the source message's sending time, text, and whether that message is still active. The new regression demonstrates that it is no longer misattributed by adjacency after an STM split.

However, `observationSource()` never outputs `message.sourceMessageId` or `message.source.id`. For ordinary Dialogue, `timestampMarker()` in `src/clock.js` rounds the time label to **whole seconds**; source text is allowed to be **empty** for image-only messages. Thus two distinct images with empty messages (or identical message text) sent within one second can produce **exactly the same source label**. The database knows which message each observation refers to; the Dialogue prompt no longer does. This fails the previous review's requirement of an original source ID or *equivalently unambiguous reference* and Spec 0003's source-provenance guarantee.

**Required:** Include the existing stable source-message identifier in the observation's Dialogue context; preserve source text and time for readability. If the source user message is still in verbatim, make that same identifier available on the matching user entry, so the model can correlate them. Preserve normal speaker roles and do not change memory tiers. Add a deterministic regression with two otherwise indistinguishable image-only/duplicate-text messages and observations at the same visible timestamp.

**Previous P2 — fixed.**

`src/vision.js` now rejects several unambiguously instruction- and chat-role-shaped outputs. It deliberately excludes quoted strings so a valid observation can describe visible signage, and the new tests cover examples of both. This is an acceptable constrained validator, not a general proof of semantic accuracy.

## Disposition

One additional small change requested to finish the P1 fix. **No new owner approval required.** Once the source ID is forwarded and the collision regression is green, another narrow re-review should suffice. Do not change the architecture or push reviewer files on behalf of ChatGPT without the owner's explicit command.
