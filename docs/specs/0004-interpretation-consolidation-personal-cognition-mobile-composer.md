# Beholder — Specification 0004: Interpretation Consolidation, Character-Owned Cognition, and Mobile Composer

**Status:** FORMAL SPECIFICATION — DOCUMENTATION ONLY. Implementation requires a separate explicit owner instruction.
**Project:** Beholder
**Baseline:** Specifications 0000–0003; GitHub Actions source snapshot for \`8d95f6c8ec0a9cf6bd22e82befba2b6e2e29e938\` (run \`41337055942\`).
**Source requirements:** Owner-approved discussion and \`beholder-mini-spec-interpretation-consolidation.md\` (Interpretation Maintenance only).
**Scope:** Interpretation Maintenance, existing shared/private cognitive-pool ownership and migration, character editor/status UI, and chat composer responsiveness/Enter behavior.

## 0. Executive summary for owner / Claude

1. **Architectural decisions:** (a) Begin **each existing Interpretation Maintenance cycle** with **one LLM consolidation request of the complete current interpretation set**, then run the existing individual verification on that consolidated set, and **atomically persist** only the final result. (b) Remove **both** shared/private pool modes. Each character owns its own STM/LTM, interpretations, gestalt and experiments. Migrate the existing single character's shared cognitive state into that character's personal pools without rewriting its prose. (c) No architectural changes to Dialogue/vision/memory lifecycle for the mobile composer work.
2. **User-visible behavior:** Interpretations become shorter and less repetitive while genuinely different or conflicting explanations survive. The two Shared checkboxes, shared/private badges and explanatory copy disappear. Each new character has independent, initially empty cognitive state. On phones, Attach Image and Send become compact icon buttons flanking a wide, growing multiline input. **Enter always inserts a newline; only pressing Send sends the message**, on mobile and desktop.
3. **Objections and risks:** Consolidation is **semantic deduplication, never plausibility filtering**. No partial persisted state when consolidation/verification fails. The only current character must not lose or duplicate its existing shared STM/LTM, interpretations, gestalt, experiments, watermarks or revision state. Do not accidentally transfer cognitive state to a future second character. The mobile text field must remain usable with the software keyboard open and must not be squeezed by fixed-width buttons.
4. **Owner decisions required:** **None**. Exact SQL migration implementation, validated LLM response format, layout measurements and regression fixtures are local technical details within this specification.

**Authority:** This spec incorporates the provided mini-spec without relaxing any invariant. It amends only the named parts of Specs 0000–0003. Do not implement unrelated improvements merely because they seem adjacent.

## 1. Interpretation consolidation: problem and boundaries

Individual Interpretation Maintenance currently evaluates interpretations separately. Over time, several entries can each accumulate the same incidents and overlapping explanations, producing long, partially redundant narratives. They should instead remain a set of **different, competing explanatory hypotheses** of the user, not a fragmented chat history.

The approved change concerns **Interpretation Maintenance only**. It does **not** introduce a scheduled cleanup agent, independent consolidation trigger, new memory tier, additional generation pass or change to the existing Generation, Experimentation or Gestaltization algorithms.

### C1. Required sequence

Every existing Maintenance invocation, whether selected by Prefetch or invoked through an existing internal path, follows this logical sequence:

1. **Consolidation** — exactly **one** structured LLM request receives **all current interpretations in that character's interpretation pool** and returns a consolidated set.
2. **Individual verification** — the existing per-interpretation Maintenance checks **each surviving consolidated interpretation** against the actual conversation and its existing memory/active-experiment context, applying its existing \`unchanged\`, \`replace\`, \`delete\` and completed-experiment behavior.
3. **Persistence** — only when consolidation **and all required verification requests** succeed, save the final verified set in a **single atomic transaction**. This includes deleting redundant interpretations eliminated by consolidation, applying verified changes and verified experiment completions.

Consolidation is **the first stage inside Maintenance**, not a separately scheduled process. Keep Prefetch's Maintenance decision, independent Generation decision, overall cycle order, character-triggered watermarks, serial queue and existing parallel individual-verification behavior unless technically necessary to honor atomicity.

With an empty interpretation pool, the pre-existing Maintenance no-op remains a no-op; do not spend a pointless model call or fabricate an interpretation. With a nonempty pool, run **one** consolidation call per Maintenance attempt, not one per interpretation.

### C2. Consolidation semantics

The model must see the **entire current set simultaneously**, with each interpretation's text and stable identifier:

- **Merge semantic duplicates**, including differently worded explanations, entries distinguished merely by recent anecdotes or incidental details, and repeated dialogue chronology.
- Where one interpretation is a narrower version of another, retain meaningful nuance in **one** interpretation instead of copying the common explanation into several.
- **Keep genuinely different explanations separate**, including explanations of the **same events** and openly conflicting or mutually incompatible hypotheses.
- Strip excessive retellings of the dialogue and evidence to the minimum needed for each explanatory hypothesis. Detailed event history belongs in ordinary memory.
- **Retain unusual, implausible, speculative and mutually competing hypotheses** when semantically distinct. **Consolidation is forbidden to judge truth, evidence quality, or plausibility**; that belongs to the subsequent individual verification.
- Do **not** generate unrelated new hypotheses; Generation remains responsible for novel alternatives.
- Do **not** impose a target number, minimum "neat" number or maximum number of interpretations. The result is determined by actual semantic diversity, not a token- or UI-driven quota.

**Invariant:** Each surviving interpretation expresses a **distinct explanatory hypothesis**, not merely a summary of a different fragment of the conversation.

Keep interpretations as **free-form prose** within the existing per-entry text limit. No interpretation scores, typology, classification, ontology, mandatory citations or mechanical similarity threshold.

### C3. Response validation, identities and exactness

The full implementation may select an appropriate structured response contract, but it must preserve these semantic guarantees:

- Every current interpretation is **accounted for** in the consolidation proposal: retained as its own explanation or explicitly assigned to one merged representative. No silent omission. Represent the relationship with existing stable IDs (e.g. representative ID plus source IDs); do not infer merges merely from result ordering.
- A representative's ID must belong to the original set. No newly invented interpretation IDs and no duplicate representative ID. Preserve existing IDs for unmerged/surviving hypotheses wherever possible, and retain one stable surviving ID for merged groups.
- Every original ID participates in **at most one** output group, and all original IDs are accounted for. A semantic merge may change the representative text; it must not reassign an unrelated ID to an unrelated hypothesis.
- Validate response structure, membership, unique IDs, text constraints and declared mapping **before** individual verification. A structurally invalid, partial, empty-for-nonempty-input or over-limit result is **failure**, not permission to drop records.
- The LLM input must include the **complete** interpretation set, without silent truncation or an arbitrary count cap. If it exceeds model capacity, stop safely, record the limitation and preserve the old data instead of running partial consolidation.
- The system prompt must explicitly distinguish **deduplication from factual/evidential verification**, and forbid dropping speculative or conflicting alternatives for plausibility reasons.

The validator can guarantee IDs and completeness; the quality of semantic deduplication and the preservation of genuine diversity require real-model inspection as well as deterministic prompt/fixture tests.

### C4. All-or-nothing verification and commit

- The consolidated proposals are **temporary** until every required existing per-interpretation Maintenance request completes and validates successfully.
- Individual verification receives its corresponding **consolidated text**, plus the **same actual dialogue, retrieved memory and active experiments** as existing Maintenance. It must **not** verify only the pre-consolidation original text.
- The verified outcome may refine, retain or delete a consolidated interpretation according to the **existing Maintenance rules**, including rejection when facts contradict a hypothesis. **Do not** impose an independent truth filter in Consolidation.
- If consolidation, an individual verification call, repair/validation or required commit precondition fails: preserve the previously stored interpretations and experiments as a whole. **No intermediate consolidated set is ever persisted**. Log a stage-specific error through existing diagnostics; ordinary Dialogue must not be blocked.
- Snapshot the interpretation revision/IDs/text and any experiment state relied upon. Before committing the final set, enforce existing concurrency/staleness guarantees. If the relevant source state changed during LLM calls, discard/retry later rather than overwrite or delete newer data with a stale result.
- Apply surviving ID/text changes, deletions (including merged-away IDs), and valid experiment completions atomically. Keep existing interpretation-revision bump **once when the committed interpretation set actually changes**; trigger existing gestaltization and experiment planning via normal revision/planning rules.
- **Experiments have no structural interpretation-ID foreign key.** There is therefore **no experiment-to-interpretation reference migration** to invent. Existing experiment IDs/text and their ordinary completion-check behavior remain unchanged.
- Keep diagnostic attribution of how many original interpretations were considered, how many merged, how many verified and whether the transaction applied, without copying secrets.

An unchanged interpretation set must not spuriously increment its revision or rerun gestaltization purely because a Maintenance attempt occurred.

## 2. Character-owned cognition: remove both shared modes

### P1. New ownership invariant

Each character has exactly **one personal memory pool and one personal interpretation pool**, or equivalently a single owner identity for all character-specific cognitive data. The implementation may retain the existing internal \`character:<id>\` pool key as a technical representation; this is **never** a user-selectable scope.

A character personally owns:

- **STM and LTM**, including consolidation/retrieval state;
- **interpretations** and their revision;
- the **current evolving gestalt** and its source revision;
- **experiments**, their revision and planning-needed state;
- **Contemplation watermarks / work state** and relevant per-pool scheduling metadata.

**No shared memory or shared interpretations mode.** Remove both \`Use shared memory\` and \`Use shared interpretations\` checkboxes. Do not silently keep a hidden or implicit shared pool after migration.

A newly created character starts with **empty personal cognitive state** regardless of what other characters know. Do not copy records, previous gestalts, intentions, watermarks or voice-specific experiences into it. The owner will evaluate a second character and cross-character knowledge transfer only in a **future** patch.

The global **user self-description pinned in Dialogue** remains as defined previously; it is not a shared cognitive memory pool and is **not** being removed by this change. Conversation transcripts, image uploads, generated images and their associations likewise remain intact and character-bound as before.

### P2. Existing installed data: single-character migration

The existing installation contains **one character**. Its records may be in the legacy **shared** pools because both flags are enabled. Migrate this character's accumulated cognitive data into its own personal pools **without changing the actual content of memories, interpretations, gestalt or experiments**.

The database migration must be:

- **Atomic, durable and repeatable**: no partial moves, no duplications after restart, no transient state with references to missing pool rows. A successful migration is versioned; a failed one leaves the previous valid DB intact.
- **Data-preserving:** move all applicable STM/LTM records with their IDs, timestamps, sources, topic/summary/retrieval metadata and provenance; move interpretations with IDs/text/origin/timestamps; move experiments with IDs/text/timestamps.
- **State-preserving:** move/reconcile the relevant interpretation/experiment revision counters, planning-needed flag, gestalt text + gestalt revision/update time, memory revision + last-LTM date and Contemplation watermarks so ongoing work is neither lost nor incorrectly considered already completed.
- **Identity-preserving:** ensure stable interpretation, experiment and memory record IDs and their provenance remain meaningful. The migration **must not rewrite text**, strip character names, relabel perspective, re-summarize or re-run LLMs.
- **Scope-consistent:** after migration all runtime lookups, LLM contexts, background jobs, pool metadata, diagnostics/status and the Emergency Dump use the personal owner pool, never the retired shared key.
- **Non-destructive in ambiguous cases:** if both shared and personal legacy pools already hold different meaningful state, preflight the merge and preserve all records/metadata or fail the migration **transactionally** with a clear diagnostic that requires manual resolution. Never silently prefer one gestalt and discard the other, overwrite a revision, copy shared content to multiple characters, or delete dormant records.
- **Explicitly safe outside the known one-character case:** if a legacy database has **multiple characters with nonempty shared data**, do not infer an owner or broadcast shared records to everybody. Abort that ambiguous migration safely with an actionable error; owner approval of an explicit multi-character policy is required if this case is encountered. Empty newly created pools need no merge.
- **Existing standalone personal-state installations** should migrate without loss and without introducing an artificial extra character.

After successful transfer, retire the legacy \`shared\` rows/flags **only after all dependent data has been relocated**. Prefer a narrow migration and direct character-owned lookup functions over a broad schema/ORM rewrite. No data-cleansing or memory-to-memory text conversion is authorized.

### P3. Remove flags everywhere

- Character create/edit form: **only existing name and description fields**, no shared/private checkboxes or their instructional paragraphs.
- Character create/update API and validation: shared flags **no longer required**, and cannot be used to select a shared pool. Stored legacy flag columns, if retained temporarily for compatibility, are inert and never drive behavior.
- Character listing, header, chat/Contemplation status: remove "shared memory", "private memory", "shared interpretations", "private interpretations" scope badges/copy and any "Shared pool" selector meaning. A concise character-owned label is optional if helpful; avoid unnecessary status clutter.
- Contemplation remains a **read-only diagnostics page** under Spec 0002. It continues to display interpretations, gestalt, experiments and stage status for the **current character only**.
- Ensure **all relevant subsystems**, including Dialogue memory retrieval, prefetch, Maintenance, Generation, Gestaltization, Experiment Planning, Vision's gestalt, STM consolidation, daily LTM consolidation, watermarks and startup recovery, use the personal character owner. No residual shared lookup path is acceptable.
- Update README and AGENTS.md, removing documentation that characters can select shared cognition.

### P4. Preserve existing behavior

The removal of shared scopes is not authorization to change what or how memory is consolidated:

- Keep verbatim → STM at **100 active entries / 20 oldest consumed / ~80 retained**, with vision observations still counted as specified in 0003.
- Keep **midnight STM → LTM only**, with existing per-character frequency/restart rules.
- Keep ordinary memory retrieval and provenance semantics, including visual-observation provenance remaining natural-language STM/LTM.
- Keep Contemplation's independent processing, current gestalt semantics, experiments and Dialogue's prompt boundary unchanged apart from ownership routing.

## 3. Mobile-friendly chat composer and Enter behavior

### U1. Layout

The current portrait phone chat gives most of the composer width to the long "Attach Image" button and a full "Send" button, leaving a very narrow textarea.

Implement a responsive layout in the **existing composer**, not an unrelated UI redesign:

- **Immediately left of the message input**, a **small square icon-only Attach Image button** (paperclip/image icon) with accessible name, title/tooltip and adequate touch target.
- **Right of the input**, a **compact Send icon button** with accessible name and a touch-friendly target.
- **Between them**, the text area must flex to occupy **all remaining width**; it must be able to shrink correctly inside a flex container without becoming a two-word-wide column. Avoid mobile horizontal overflow.
- The textarea is **multiline**, starts at a comfortable compact height, **grows vertically** with entered lines until a reasonable maximum, then scrolls **internally**. The growing field must not push the message history entirely out of view.
- Composer remains visible/usable with Android/iOS software keyboard open and in a narrow portrait viewport; message history scrolls independently. Respect safe-area insets and avoid keyboard overlay/viewport jumping where feasible within a browser WebView.
- Attached-image preview and Remove still work and must not consume the text field's available width. Buttons must continue to disable correctly during pending/sending states.

Use existing styling/theme variables and text-only safe rendering. The desktop layout should remain usable; it may use the same compact controls for consistency.

### U2. Keyboard contract: Enter is a newline

- **Pressing Enter inside the message textarea inserts a newline; it NEVER sends the message.** This applies on desktop and mobile, irrespective of Shift/Ctrl/Meta.
- **Sending is by activating the Send button only** (touch/click/accessible button activation). Do not introduce an alternative keyboard shortcut without separate owner approval.
- Do not intercept IME composition to submit. Do not allow implicit form submission on Enter.
- Existing empty-message protection, image-only sends, text+image sends, busy state, draft persistence, attachment clearing on success, retention on failure, follow-up cancellation from typing, Retry and timestamp behavior remain unchanged.
- Newly inserted line breaks must survive draft persistence, transmission, transcript rendering and any existing input sanitization.

### U3. Accessibility and validation

Icon buttons require stable accessible names ("Attach image", "Send message"), visible focus indicators, touch targets of roughly **44 CSS px**, and disabled-state affordances. Support common phone portrait widths around **320–400 CSS px** as well as desktop. Do not make mobile usability conditional on a particular keyboard vendor or browser.

## 4. Cross-cutting constraints

- **Do not change** vision models, upload limits/storage, image observation schema, OpenRouter provider exclusion, Dialogue's JSON envelope/recovery, image generation, global pinned self-description, user images, text rendering, security policy, or public deployment controls.
- No new settings toggles for ownership or interpretation consolidation. Consolidation is automatically part of **existing Maintenance** when that step is invoked.
- No new independent timers or queues for consolidation; use the existing serialized Contemplation engine and its LLM role.
- No manual editing/Force controls added back to the Contemplation page.
- Model request failures must be bounded and diagnosable, with no data loss.
- Keep the existing tests and invariants of Specs 0000–0003, updating expectations only where this specification deliberately changes the behavior.

## 5. Acceptance scenarios

### Interpretation consolidation

1. A normal Prefetch-triggered Maintenance with a nonempty set sends **exactly one** consolidation LLM request containing **all** current interpretations before any individual verification call.
2. A Maintenance triggered through any existing internal path follows the same order. With zero interpretations it remains a no-op.
3. For a fixture with paraphrased duplicates and repeated recent dialogue anecdotes, the consolidated set has fewer, more concise interpretations preserving the underlying meaning.
4. For a fixture containing two **substantively different explanations of the same incident**, both survive consolidation. Plausibility, oddness and disagreement are **not** grounds to merge or drop one.
5. A narrower restatement may merge with a broader hypothesis only if its meaningful distinctive content survives in the representative text. No unrelated new hypothesis is introduced.
6. A fixture with a large number of genuinely different hypotheses is **not** reduced to an arbitrary cap or target count.
7. The consolidator's proposed survivor/source-ID mapping is complete and nonoverlapping. Unknown IDs, duplicates, missing originals, empty output for nonempty input and over-limit texts are rejected **before** verification.
8. Every individual verifier sees the **consolidated candidate**, not its old original text, plus the existing actual conversation/memory/experiment context.
9. When all stages succeed, merged-away interpretation IDs are removed and survivor IDs are preserved. The final set is committed in **one transaction** together with ordinary verified experiment completions.
10. If consolidation fails or an individual verifier fails/returns an invalid response, **no interpretation or experiment change** is committed; no intermediate consolidated state is visible.
11. If relevant source state changes during any LLM request, the stale result cannot overwrite it; a later valid run remains eligible.
12. No interpretation change means **no interpretation revision bump**, no gratuitous gestaltization and no gratuitous experiment replan.
13. A successful changed set triggers the existing downstream gestaltization/planning, without a separate consolidation schedule or modified Generation rules.
14. Real-model manual evaluation confirms deduplication without loss of distinct conflicting hypotheses; automated tests assert prompt instructions, input completeness, validation and state transitions.

### Personal cognitive ownership and migration

15. On upgrade of a database with **one character using both legacy shared modes**, the character retains every pre-existing STM/LTM, interpretation, experiment and current gestalt, with record content and IDs intact.
16. The migrated personal pools preserve revision counters, gestalt revision, planning-needed state, watermark positions and daily LTM scheduling markers. Pending appropriate work remains recoverable after restart.
17. Reopening the migrated DB or restarting the server does **not** duplicate/move the data a second time, reset progress or recreate an active shared pool.
18. A legacy database already using personal pools survives migration unchanged. When two nonempty legacy sources cannot be reconciled safely, migration fails atomically rather than silently dropping an interpretation, gestalt or memory.
19. A legacy database with multiple characters sharing nonempty cognitive state cannot accidentally assign the whole shared pool to the wrong character or copy it to all characters.
20. Creating a **second** character after migration produces a character with **empty personal STM/LTM, interpretations, gestalt and experiments**. Its retrieval, Contemplation, Vision and Dialogue contexts do not contain the first character's cognitive state.
21. All new character CRUD calls work **without** \`useSharedMemory\` or \`useSharedInterpretations\`. Legacy values cannot re-enable sharing; no two Shared checkboxes or shared/private badges remain anywhere in the UI.
22. Contemplation and diagnostics accurately show only character-owned state, while the Contemplation page stays **strictly read-only**.
23. Existing memory consolidation (100/20/~80; midnight STM → LTM), image observations, experiment planning, gestalt maintenance, Retry, and normal Dialogue function with the new owner scope.
24. No global pinned user self-description, transcript, upload, generated image, OpenRouter configuration or API-key lifecycle is unexpectedly lost or modified by the migration.

### Mobile composer

25. At **320, 360 and 400 CSS px** portrait viewport widths, the Attach and Send controls are compact icons on either side of an input that occupies the available width, without horizontal overflow or a few-characters-wide textarea.
26. A message with several lines makes the textarea grow up to its bounded height, then scroll internally; the message list remains scrollable.
27. On Android/iOS mobile with a visible software keyboard, the composer remains visible and usable; no substantial overlap or sideways scrolling. A screenshot/manual browser verification is required in addition to unit tests.
28. Plain **Enter**, **Shift+Enter**, **Ctrl+Enter** and IME-assisted Enter **never submit**; Enter produces a newline when appropriate. Only Send activation submits.
29. Image-only, image+text and text-only submissions continue working. Empty send without attachment remains disallowed; drafts preserve line breaks and the pending/failed attachment lifecycle remains correct.
30. Controls have accessible names, keyboard focus styles, touch targets and disabled states; desktop usability remains intact.

### Regression and delivery

31. All existing Spec 0000–0003 test suites pass with the approved changes reflected; new tests cover consolidation atomicity, semantic invariants, migration and responsive composer.
32. Verify the migration against an **actual copy or representative fixture of the existing single-character shared-pool database**, including nonempty gestalt, STM/LTM and active experiments, not just a brand-new in-memory database.
33. Update README and AGENTS.md to explain the new Maintenance sequence and personal cognitive ownership; verify with the project's supported **Node.js >=24** toolchain and report any environment limitations.

## 6. Completion / review workflow

- **This specification commit does not authorize implementation.** The owner will instruct Claude separately.
- Implementation is reviewed from the **GitHub Actions snapshot associated with its source commit**, not an unrelated checkout.
- Reviewer messages go to \`docs/review/\` only on the owner's command.
- Begin each implementation/review communication with the four executive-summary items above.
- If safely migrating existing state would require a change outside this specification, ask the owner first rather than silently changing ownership semantics.

**End of Specification 0004.**
