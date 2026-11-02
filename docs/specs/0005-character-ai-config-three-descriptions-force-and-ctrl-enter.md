# Beholder — Specification 0005: Character-Owned AI Configuration, Three Descriptions, and Manual Controls

**Status:** FORMAL SPECIFICATION — documentation only. Implementation requires a separate explicit owner instruction.
**Baseline:** Specs 0000–0004; GitHub Actions source snapshot for `99f862d62c1228641e10b730be7519a195a78de4` (run `41430607537`).
**Scope:** Character data and editor; role configuration and AI request assembly; contextual descriptions for AI roles; the existing Contemplation Force UI; chat-composer Ctrl+Enter.
**Source of requirements:** Owner-approved discussion after Spec 0004; no independent redesign of the cognition pipeline.

## 0. Executive summary for owner / implementer

1. **Architectural decisions:** Move the **entire existing AI-role configuration** from global settings into each character: four selected models, text-role temperature override and max-output-token settings, and the current Contemplation/image-generation enable flags. Each character also owns three separately editable AI-facing descriptions: **Character**, **Scene**, and **User**. Every AI role gets those descriptions in its task-appropriate context. Restore the three existing **Force** operations on the Contemplation UI; no new mechanism is required.
2. **User-visible behavior:** Switching characters switches their model configuration, scene, self-description and user description as well as cognition. The character editor exposes the model catalogue and role parameters. **Ctrl+Enter sends** in the chat textarea; plain Enter/Shift+Enter remain newlines. The Contemplation page again offers **Force Maintenance**, **Force Generation**, and **Force Experimentation**, while stored interpretation/experiment text remains non-editable in the UI. Show the last Maintenance time/outcome and whether an operation is queued or running.
3. **Objections and risks:** The current single global SettingsStore is consumed by Dialogue, memory jobs, Contemplation, Vision and the independent image service; a superficial UI move is not enough. A job, including its repairs, must keep the **same character-scoped configuration snapshot** across all of its calls. Migrate existing settings and global user description without loss, duplication, character leakage or altered conversation history. Preserve the Vision observation/evidence boundary and the Spec 0004 Maintenance atomicity guarantees.
4. **Owner decisions required:** **None.** All listed requirements are approved; implementation details within those constraints may be chosen locally.

**Priority:** No code, database, UI or other runtime change is authorized by the specification commit itself.

## 1. Character as the owner of AI configuration and context

### A1. Exactly three AI-facing descriptions

Each character has three distinct persisted text fields:

- **Character Description:** who the character is — identity, personality, voice, disposition and manner of interaction. This is the current `characters.description` concept, retained without losing its existing text.
- **Scene Description:** where and in what circumstances the interaction is taking place — setting, situation, atmosphere, shared scene assumptions. It is explicitly provided by the user, **not** generated or silently revised by memory/Contemplation.
- **User Description:** how the user describes themselves **for this particular character**. This replaces the global pinned self-description value. It is user-provided framing, neither a conversation turn nor a verified psychological fact.

All three fields are **AI-facing** and independently editable in the character form. The character has **one owner identity** for them, matching Spec 0004 personal cognition. A new character has blank Scene and User descriptions by default; Character Description may be blank as currently supported. Character display name remains a separate normal UI/name field and is not counted as a fourth AI-facing description.

Preserve the existing **20,000-character maximum per description**, Unicode/line breaks, exact user-authored content and safe text-only rendering. Empty is allowed. Do not combine or duplicate fields under one persisted long-form blob merely to avoid a migration, and do not expose them as editable memory, gestalt or interpretations.

### A2. The complete role configuration belongs to the character

Each character independently owns the current settings contract:

| Configuration | Role(s) | Character behavior |
| --- | --- | --- |
| Selected OpenRouter model ID | `dialogue`, `contemplation`, `vision`, `image` | One model for each of four roles; select from model list with existing valid custom-ID support |
| Temperature override `{ enabled, value }` | `dialogue`, `contemplation`, `vision` | Preserve the existing 0–2 bounds, provider-default behavior when disabled, and compatibility checking |
| Maximum output tokens | `dialogue`, `contemplation`, `vision` | Preserve existing 256–200000 validation and catalog endpoint maximum clamping |
| Enable image generation | Character-level `imageEnabled` | Existing gate on outgoing image requests; user image attachments continue to work independently |
| Enable automatic Contemplation | Character-level `contemplationEnabled` | Existing automatic background trigger, gestalt/experiments injection and recovery behavior scoped to this character |

The current Image API has no temperature/output-budget controls; **do not invent unsupported settings** for it. Keep any provider capability-based image options and network/security policy as they are.

**Global scope remains limited to infrastructure**, including the transient OpenRouter API key, model catalogue/cache, provider connectivity, network/retry/time-out policies, application defaults and diagnostics. There is **no global selected Dialogue/Contemplation/Vision/Image model**, no global per-role temperature or output budget and no shared user description used as an implicit fallback after migration.

Models are selectable **from a usable list**: preserve the curated role lists, downloadable OpenRouter catalogue, per-role compatibility hints, refresh capability and ability to supply a valid custom model ID. A searchable selection input or existing accessible datalist is acceptable provided users can actually discover and select models rather than needing to memorize IDs. The configured ID stays visible even if temporarily absent from a catalogue response.

### A3. New characters and edits

- On new-character creation, initialize role configuration from **built-in defaults**, not from another character's current private settings. Persist the complete config alongside the three descriptions. Keep the editor usable when model catalogue retrieval is temporarily unavailable.
- Editing a character can change any of its three descriptions and any role setting, without resetting/verbatim history, STM/LTM, interpretations, gestalt, experiments, images, follow-ups or watermarks.
- Character create/update APIs return their **own** descriptions/configuration. Validate server-side with existing model-ID/temperature/token/description limits; reject invalid values with actionable errors, without partial saves.
- A change to one character may not alter another character's settings, descriptions or queued jobs.
- Character editor clearly groups **Descriptions** (Character / Scene / User) and **AI Models** (Dialogue / Contemplation / Vision / Image Generation) with existing optional enable controls. Keep save/cancel behavior coherent on desktop and narrow mobile screens.
- The old global "About you" editor is removed from the Characters page. Model selection and role tuning are removed from the global Settings page; leave or remove that page/navigation according to whether it still has useful global controls, but **never leave two editable sources of truth**.

### A4. Data migration

This patch upgrades databases that currently hold global `meta.settings` and `meta.userDescription`, plus `characters.description`.

- **Every already existing character** receives a copy of the **previously effective global role configuration**; this exactly preserves the role settings those characters used prior to this patch. If only one character exists (the known installation), it receives the original settings without transformation.
- **Every already existing character** receives the previous global user self-description as its personal User Description. This is intentional for pre-existing characters because the old value previously applied to all of them; immediately after migration, their copies become independent.
- Each existing `characters.description` becomes its **Character Description**, unchanged. **Scene Description starts empty** (there is no existing scene field to recover).
- Migrate both feature enable flags (`imageEnabled`, `contemplationEnabled`) to the existing characters. The runtime must no longer use the old global flags for routing/behavior.
- Migration must be **transactional, versioned, idempotent, restart-safe**. If effective old settings cannot be recovered or validated without information loss, fail safely with a clear diagnostic rather than silently resetting a populated character's AI config. Never overwrite already migrated per-character values after an upgrade is retried.
- Existing transcripts, images, in-flight/pending records, memory tiers, interpretations, gestalt, experiments, memory/Contemplation scheduling markers and record IDs must remain intact. No LLM calls, re-summarization or rewriting text as part of migration.
- Retire the old global user-description and per-role configuration **as active settings** after successful migration; stale global values must not continue influencing prompts, model routing or newly created characters. Update the Emergency Dump and status APIs to reflect the new per-character source of truth. Continue to keep the OpenRouter key completely out of persistence, browser responses, logs and dumps.

### A5. Model routing and in-flight stability

**The character is an explicit parameter or an unambiguous owner context for every AI operation.** Do not select a model from the currently viewed UI character, a global mutable "selected character", or the last chat that made a request. This includes autonomous work.

Map the existing purposes to character configurations as follows:

- **Dialogue configuration:** replies, openers, follow-ups, Dialogue memory retrieval, STM consolidation, LTM selection/consolidation and their repair/retry requests.
- **Contemplation configuration:** prefetch, contextual memory retrieval, interpretation consolidation/Maintenance, Generation, Generation Review, Gestaltization, Experiment Planning and their repair/retry requests.
- **Vision configuration:** observation of a user-uploaded image, capability/context preflights and the actual request.
- **Image Generation configuration:** model and request for the generated image belonging to the originating character, including resume-after-restart.

Freeze the **entire relevant character role configuration and three descriptions** at the start of a logical AI job. All stages/calls of one Maintenance run and the repair/format-downgrade/truncation-retry calls of an individual task must use that stable snapshot. Changing settings mid-flight affects **newly starting jobs only**; never switch models, budgets, feature flags or description context in the middle of an existing job. If a compound job can cross a configuration edit, it may finish on its frozen state; it must still enforce the existing state/version staleness protections before writes.

Context-length/output-fit checks and model capability checks must use **the same snapshot as the model request** they assess. A global model catalogue cache and per-model format-downgrade cache are still fine, but no global role selection.

For generated images, persist sufficient request/model/context information **when enqueuing** for resumed or retried work to use the original character's intended generation configuration; changing another character's settings, or editing the same character after enqueueing, must not retroactively alter a pending image request.

## 2. Use all three descriptions in all AI roles

### C1. Common semantics

Every AI role receives **Character Description**, **Scene Description** and **User Description** as **distinct, explicitly labeled context**, in a form suited to that role. Do not silently omit a nonempty field in a role's prompt just because it historically did not receive it. Conversely, do not add stored private interpretations or memory tiers merely because the new user description exists.

Distinguish the status of each field:

- Character Description defines the role's identity/persona for creative/interactive tasks.
- Scene Description provides **owner-authored setting and circumstances**, not necessarily direct evidence of the outside world.
- User Description is **the user's account of themselves** for this character, not fact checked and not a chat turn. It must not be misquoted as something said in the conversation.

Fields must not be confused with **character-created cognition**: STM, LTM, raw interpretations, gestalt and experiments are separate from these owner-authored texts. Editing descriptions **does not itself create a new chat turn**, reset memory or insert an interpretation.

Maintain clear prompt boundaries and labels. Avoid accidentally treating arbitrary text in a description as trusted system/runtime instructions that could override format, source attribution, safety or tool contracts. User-authored content may inform roleplay as intended, but never authorizes bypassing implementation invariants.

### C2. Dialogue

- Continue using Character Description in the character identity portion of the Dialogue prompt.
- Include Scene Description as the **current user-established scene**, not as a new fake chat event.
- Continue the **pinned user self-description** mechanism from Specs 0000/0004, but draw it from **this character's User Description**, not global settings. Keep its attribution as a user-provided self-description and its **untimestamped, non-chat-message** nature. Do not duplicate it both as a pinned user message and a redundant second copy in the system prompt.
- Preserve the existing gestalt/experiment visibility boundary: Dialogue sees **gestalt and current experiments**, not raw interpretations; memory retrieval and time/observation markers remain as before.
- Scene/user changes take effect on a newly started Dialogue job without rewriting past turns. Follow-up/opener prompts use the same owned context.

### C3. Contemplation and memory work

- Every Contemplation stage (including prefetch, Maintenance consolidation and per-item verification, Generation and review, Gestaltization and Experiment Planning) has all three descriptions available as context appropriate to its stage.
- Descriptions may orient interpretation of the interaction but **are not evidence that a historical utterance occurred**. Do not convert them into fabricated dialogue quotations, message IDs, experiment outcomes or memory provenance.
- Existing STM/LTM model calls use the Dialogue model configuration; they must also have access to the same descriptions as **framing, not source material**. Preserve strict source-message and source-memory ID validation: no memory record may cite a description as if it were a consumed conversation message.
- Preserve **one complete-set consolidation before individual Maintenance verification**, atomic commits, experiments snapshot/revision safeguards, genuine competing hypotheses and all Spec 0004 invariants. Adding contextual descriptions must not change the semantic deduplication or truth-assessment split.
- Maintain the existing independent scheduling for automatic Contemplation and daily memory; a scene edit does not fabricate activity or force a new maintenance cycle.

### C4. Vision

- Vision receives all three descriptions as contextual framing **in addition to** its existing full active verbatim window, currently permitted gestalt, and the actual attached image.
- **Do not weaken Spec 0003's observation contract:** describe only what is visibly in the image; description fields and gestalt may guide attention or interpretation of context, **but cannot justify inventing visible facts**, identities, relationships or unreadable content.
- Do **not** add STM/LTM, raw interpretations, private experiments or other historical material to Vision's context.
- Keep the typed `image_observation` entry, provenance, MIME/size validation, injection defenses, context-window preflights, model capability checks and Dialogue's distinction between observed image facts and user claims.

### C5. Image Generation

- Image Generation is a fourth AI role and also gets all three descriptions. Incorporate them as clearly marked contextual information when constructing the **character-owned image generation request**.
- The Dialogue model's `imageRequest` remains an explicit, self-contained request for an image; the generator still must not depend on unprovided private cognition or unrelated chat history. Do not give the image generator raw interpretations, memory tiers or private experiments.
- Preserve the existing asynchronous placeholder, pending/result persistence, restart recovery, image download validation and provider security restrictions.
- Do not force every image to depict the character, the user or the scene; the three fields are **context**, not mandatory elements of a visual composition. Where the explicit `imageRequest` asks for something different, do not mechanically inject inappropriate people/props.

## 3. Restore model-driven Force controls in Contemplation

### F1. Intended meaning of read-only

Specs 0002 and 0004 removed **UI edit/add/delete controls** for interpretation and experiment prose. The owner clarifies that this prohibition applies to **writing/altering cognitive text manually**, **not** to requesting the model to run an existing cognitive procedure.

**Explicitly supersede only the UI ban on Force controls** in earlier specs. The rest of the Contemplation page stays read-only with respect to results.

### F2. UI controls and existing operation

Restore three distinct buttons in the **selected character's** Contemplation view:

- **Force Maintenance** — run existing Interpretation Maintenance, including Spec 0004's initial full-set consolidation and verification.
- **Force Generation** — run existing creation of new interpretations through the model.
- **Force Experimentation** — run existing experiment-planning pass.

Use the existing per-character `POST /api/characters/:id/contemplation/force` endpoint and existing `maintenance`, `generation` and `experimentation` kinds and serialized pool queue. Do not create a second scheduling engine, reinterpret Force as a direct database mutation, or bypass the normal gestaltization/planning consequences of successful model work.

The buttons merely **enqueue an explicit request**, they do not claim completion. Surface whether a request is queued, running, completed or failed; avoid accidental double-queueing from rapid repeated clicks. Pending/running work for character A must never be shown as if it belongs to character B.

When automatic Contemplation is disabled for a character, the **explicit Force operation remains available** as a manual invocation; disabling automatic triggers is not authorization to disable the user's manual commands. Preserve the existing semantics of the stored gestalt/experiments not being injected into Dialogue while automatic Contemplation is disabled, unless the owner later explicitly changes that policy.

### F3. Last Maintenance visibility

The user should no longer have to guess when Maintenance actually ran.

Show on the character's Contemplation page:

- **Last Maintenance attempt time** and **outcome** (success/no-op/skipped/stale/error as appropriate), including whether it was **automatic** or **forced**.
- **Current state** for a forced or automatic Maintenance (queued, running, idle), distinct from the last completed/failed attempt.
- An understandable error/status reason when a run was skipped, failed, or its result rejected as stale. Never show "succeeded" just because the Force endpoint accepted the queue request.
- If Maintenance never ran, display "Never". Persist enough status to avoid silently losing the last completed result at restart; an interrupted run must not be mislabeled successful.

The model still decides whether automatic Maintenance is needed during Prefetch. **Do not invent a predicted next Maintenance time**, an independent timer, or a new automatic cadence.

### F4. Non-goals

- **No** form inputs, inline editing, manual add, delete, drag/drop, approval or text overwrite controls for interpretations, experiments or gestalt.
- Existing server mutation endpoints are outside this UI change; do not add new ones or surface them through the restored controls.
- No new manual override of image observations, STM/LTM or global AI rules.

## 4. Chat composer: Ctrl+Enter sends

Update the existing multiline composer **only**:

- **Enter:** newline.
- **Shift+Enter:** newline.
- **Ctrl+Enter:** invoke the **same send action** as the Send button.
- **Send button:** works as before.
- No submission by plain Enter and no implicit form submission. Do not add a Meta/Command+Enter shortcut without separate owner approval.

The shortcut is intended for **desktop keyboard use**. Keep mobile Enter/newline and touch Send unchanged.

Only handle this shortcut when the composer textarea has focus. Ignore composition/dead-key/IME events; never submit a partially composed character. Respect existing no-empty-submit, image-only submits, pending/sending/busy gate, Retry, attachment lifecycle, multiline draft retention on failure and text clearing on success. Prevent the Ctrl+Enter newline only when actually handling the send shortcut, and do not cause duplicate sends through repeated key events.

No change to the message transport, structured Dialogue response envelope, or image-upload code.

## 5. Integration and safety constraints

- Personal ownership of STM/LTM, interpretations, gestalt, experiments and watermarks from Spec 0004 remains unchanged. The current change extends personal ownership to settings and descriptions.
- Model settings must be read by **explicit character ownership** at every entry point: HTTP chat, autonomous opener/follow-up, daily memory, Contemplation background/recovery/Force, Vision and image generation. Tests must prove cross-character isolation including **simultaneous jobs**.
- Keep the OpenRouter key in process memory only. Never place it in character records or the Emergency Dump. Keep existing security headers, model capability gates, request limits and sanitization.
- All changes to character configuration/descriptions must be validated and persisted consistently, without partially changing unrelated character cognition on an invalid submission.
- Respect format repair, truncation retry, catalogue downgrade, character-bound image generation and context limits. Fail safely if three long descriptions make a request exceed the context window: **do not silently truncate the history or discard one of the approved fields**.
- Keep existing time-awareness, image observations, active verbatim window (100/20/~80), daily STM→LTM, prompt/gestalt boundaries and follow-up timing. No new cross-character shared state or interpretation filters.
- Do not introduce new AI-role types, provider integrations, cron jobs, memory tiers, or speculative knowledge transfer between characters.

## 6. Acceptance criteria

### Character descriptions, settings and migration

1. A character editor has clearly separate, saved **Character Description**, **Scene Description** and **User Description**, each allowing empty text, Unicode and line breaks, with 20,000-character bounds.
2. Every character has an independent four-model selection, valid per-text-role temperature override and output-token budget, plus `imageEnabled` and `contemplationEnabled`; no global role settings remain active.
3. The model UI offers usable curated/catalogue choices plus a valid custom-ID option, retains unknown configured IDs during catalogue failure, and shows the correct role descriptions.
4. When migrating a real/representative Spec 0004 DB with one character, the old character description, global user description, each model, temperature override, token budget and enable flag are preserved exactly in that character; Scene starts empty.
5. If there are multiple preexisting characters, each inherits the previously global settings and user description **once**, then may edit them independently. A **new** post-upgrade character starts from built-in model defaults and has empty Scene/User descriptions.
6. Migration is atomic, idempotent and restart-safe, with no duplicate or lost messages, image metadata, STM/LTM, interpretations, gestalt or experiments. Missing/corrupted legacy role configuration does not silently replace personalized nonempty values.
7. The home page no longer edits a shared user description. Character edit, status, diagnostics and Emergency Dump expose the correct character-owned values; the OpenRouter key remains excluded.
8. Updating character A's Scene, User Description or role model has **no effect** on B, even when both have chats or background jobs.

### Model selection and request isolation

9. Dialogue replies/openers/follow-ups use the selected character's Dialogue model/temperature/output budget, not a global value. Memory retrieval, STM and LTM jobs use the **same owner's Dialogue role configuration**.
10. All Contemplation stages, including full-set consolidation, verify, Generation, Gestaltization and Experimentation, use that character's Contemplation config; one character's disabled auto-Contemplation does not disable another's.
11. Vision uses the owning character's Vision model, parameters and correct context fit/capability check; image generation uses that character's Image model and enabled flag.
12. With character A's job in flight, edit A's model/settings/descriptions. That job, including repairs and subsequent steps within the same logical run, remains on the original snapshot; a later job uses the updated values.
13. With A and B running overlapping tasks, each outbound provider request uses the correct character model and context; no leakage through a global/current-UI character setting.
14. An image queued before a character edit (or server restart) retains its queued model and appropriate generation context; a later image uses the new settings.
15. Disabling image generation does not prevent the user attaching an image; disabling automatic Contemplation leaves stored cognitive data intact and does not affect the other character.
16. A model-catalogue or context-fit failure does not silently drop user/scene/persona fields, truncate forbidden context or corrupt stored state.

### AI-facing descriptions in prompts

17. Dialogue sees the correct separate Character and Scene fields, and **exactly one pinned untimestamped user self-description** from that character's User field, not from global meta.
18. Every Contemplation stage sees all three fields appropriately labeled; they are not counted as chat evidence, source-message IDs or automatic completed experiments.
19. STM/LTM and retrieval calls, which use the Dialogue role model, receive the three fields as context while preserving strict provenance and refusing to fabricate memories from them.
20. Vision sees all three fields **plus** its preexisting image, active verbatim and gestalt, but **no** STM/LTM, raw interpretations or experiments. Observation remains strictly visual; a misleading Scene/User description cannot make it claim unseen facts.
21. Image Generation sees the three fields as contextual framing without necessarily depicting them, and no forbidden cognitive data; generated-image retry/recovery preserves that contextual snapshot.
22. Changing a Scene or User description changes subsequent AI contexts but does **not** create a chat turn, rewrite archived messages, reset cognition or spontaneously trigger Maintenance.
23. Empty fields are handled gracefully across every role with no invented default scene/user identity; response format and safety invariants remain intact.

### Force UI and Maintenance status

24. The selected character's Contemplation page exposes **Force Maintenance**, **Force Generation** and **Force Experimentation**; each invokes the existing endpoint/kind and queues the normal model-driven pipeline.
25. Maintenance Force performs full-set consolidation and verification under Spec 0004, and its success/failure cannot be mistaken for merely accepted queueing; Generation and Experimentation retain their existing semantics.
26. The UI reports queued/running/completed/failed accurately, prevents accidental double queueing, and keeps character A's operation separate from character B's.
27. A disabled **automatic** Contemplation flag does not block an explicit Force operation, and no manual edit/add/delete controls for interpretations/experiments/gestalt appear.
28. The Contemplation view shows the **last Maintenance attempt time, outcome and automatic/forced source**, or "Never", and a useful failed/skipped/stale reason. This remains intelligible after restart and is not presented as a future schedule.
29. Existing server edits and manual-cognition code are not expanded; the page remains read-only in the specific sense of not allowing text mutation.

### Keyboard / regressions

30. Plain Enter and Shift+Enter create newlines without sending; Ctrl+Enter triggers precisely one send through the same handler as the Send button, including when an image is attached.
31. Ctrl+Enter is ignored during IME composition and while pending/busy/empty (unless image-only send is valid); repeated keydown does not double-send; failed sends retain multiline drafts and attachments.
32. Mobile Enter and the Send touch button work unchanged and the growing textarea stays usable at narrow widths; desktop Ctrl+Enter works without needing the mouse.
33. All prior Spec 0000–0004 regression suites pass with the intentional changes reflected. Add migration, per-character concurrent-model routing, prompt-context, forced-operation/status and Ctrl+Enter tests.
34. Verify with supported **Node.js >=24**, report tests separately from the GitHub Actions source snapshot workflow, and inspect a representative upgraded database rather than only a fresh empty one.

## 7. Review and implementation boundary

- **This commit is a specification only.** Do not implement without the owner's separate explicit command.
- Use the GitHub Actions snapshot for implementation review, and put messages for Claude in `docs/review/` only when the owner requests them.
- If an implementation needs a new architectural or behavioral decision beyond this specification, obtain owner approval first. Do not silently replace the approved design with an easier alternative.
- Begin implementation/review correspondence with the four-point executive summary: architecture, behavior, objections/risks, owner decisions.

**End of Specification 0005.**
