# Beholder — Specification 0006: Pregnant Interpretations and Cognitive-Pipeline Refactoring

**Status:** FORMAL DRAFT — for owner approval. **This document does not authorize implementation, commits, or deployment.**  
**Source baseline:** `main` at `3cfb6a5a4c614ba414db912e366dc499939abb81`; GitHub Actions source snapshot for that commit; Specs 0000–0005.  
**Inputs:** `beholder-mini-spec-pregnant-interpretations(1).md` and `beholder-mini-spec-refactoring(1).md` (2026-11-03).  
**Scope:** (S) interpretation semantics in existing Contemplation stages; (R1) explicit contracts for existing structured LLM purposes; (R2) separation of Contemplation orchestration, stages, and atomic application.  
**Implementation boundary:** Fix the actual baseline commit before implementation and reconcile later **owner-approved** changes without reverting them. No code or repository changes are implied by writing this specification.

## 0. Four-part executive summary

1. **Architectural decisions.** Maintain the current single Node.js process, SQLite schema, character-owned cognitive state, LLM transport, scheduling, and stage lifecycle. Reorganize existing LLM-purpose contracts into explicit modules, keeping readable prompts in `src/prompts/`. Divide Contemplation responsibilities into orchestration, stage execution, and transactional application, optionally retaining `Contemplation` as an application-facing facade. **No new entities, stages, processes, message queues, plugin system, or data model.**
2. **Behavior changes.** An interpretation becomes a **pregnant, self-consistent, complete image of who the user could be**. Generation may imaginatively complete unknown biography, relationships, motivations, and circumstances; Consolidation merges substantively equivalent person-images; individual Maintenance checks compatibility with observed dialogue rather than proof of invented details; Gestalt holds unresolved alternatives without converting them into facts. Saved interpretations are images, **not** chronicles, evidence summaries, or experiment notebooks. These changes are the **only** authorized change of model behavior.
3. **Objections and risks.** Imaginative detail may be incorrectly treated as fact; Maintenance or Generation Review may erroneously demand proof; Consolidation or Gestalt may flatten incompatible alternatives. Refactoring may change async order, snapshot timing, per-character isolation, request contracts, concurrency, or transaction safety. All are explicit acceptance risks.
4. **Owner decisions required.** **None** for this specification. Any necessary departure outside the boundaries written here must be returned to the owner before implementation.

## 1. Intent and normative terminology

**Interpretation:** a single **possible-person image**: a coherent, sufficiently complete and psychologically understandable account of *who the user could be*. It expresses an inner logic—motivation, disposition, relationships, formative history, circumstances, or conflict—as parts of one recognizable person, rather than a list of loosely connected traits or claims to verify.

**Pregnant:** its components mutually illuminate each other, allowing the reader to imagine a person with a coherent life. It does **not** require a complete biography, every aspect of life, numerical confidence, or a definitive psychological profile. **Completeness belongs to each interpretation; incompleteness belongs to the collective Gestalt**, because competing possible people remain unresolved.

**Observation:** what the character can actually infer from accessible conversation and its existing, provenance-preserving memory context. What a user *said* is an observation of what they said, not automatic proof that the statement is externally true. Typed image observations retain the visual-evidence boundary of Spec 0003. User-authored Character/Scene/User descriptions are context, **not** new observed dialogue or independently verified biographical facts (Spec 0005).

**Compatibility:** the interpretation is not in direct conflict with observations under the existing evidence semantics. Absence of evidence is **not** incompatibility. Distinct interpretations may be mutually incompatible while each separately remains compatible with observations.

**Normative separation:** requirements prefixed **S** are authorized semantic changes; requirements prefixed **R** only refactor implementation. When a request/prompt/result differs because of S, document that exact difference; **do not** describe it as refactoring equivalence. Nothing in R alone authorizes behavioral or prompt changes.

## 2. S — Semantic contract of interpretations

### S1. Core invariant: possible person, not forensic report

Every new or maintained interpretation must:

- Form a psychologically intelligible, internally coherent image of a *possible person*, including meaningful relationships between its imagined traits, causes, motives, circumstances, or conflicts.
- Remain compatible with known observations. Observations are constraints; they are not the narrative subject of the stored text.
- **Permit and encourage unverified invented details** where they make the possible person vivid and coherent: biography, motives, habits, relationships, life history, formative experiences, inner contradictions, social situation, etc.
- Treat **unverified** as distinct from **disproved**. Do **not** reject or delete a detail only because it has never been mentioned or supported by evidence.
- Allow mutually contradictory **different interpretations** in the same pool. Do not “correct” their differences by making every interpretation equally bland.
- Avoid obligatory hedges in each sentence (“maybe”, “perhaps”, “probably”). The mechanism already marks the whole text as a *possible* interpretation. Such details **must not** be exported as verified facts.

**Length:** maintain the existing hard **4,000-character limit per interpretation** and all existing validations. Do not introduce a new target length, taxonomy, completeness score, confidence field, required biography checklist, or minimum number of invented facts. A concise or unusual image is valid when coherent and distinctive.

### S2. Stored text: image, not chronicle

An interpretation's **persisted prose** contains the person-image and explanatory relations **within** it. It must not contain:

- Retellings, timelines, replayed dialogue or detailed summaries of observed episodes;
- Quotes, lists of evidence, proof, source references, or arguments *for believing* the image;
- Lists or statuses of experiments, experiment IDs, completed tests, future test plans;
- Maintenance notes, update history, confidence bookkeeping, or audit trails.

For example, when an episode suggested a motive, keep a vivid description of the **motive and its role in the person-image**, not the episode as supporting proof. Do not replace vividness with sterile abstractions. If available evidence is needed for checking, keep it in the existing dialogue/memory/experiment inputs, **not** in the saved interpretation text.

No retroactive LLM rewrite or automatic bulk migration of stored interpretations is part of this patch. Existing texts are subject to the revised semantics when their **existing** Generation, Consolidation, or Maintenance work next runs.

### S3. Generation: alternative coherent life

Use the existing Generation stage, request contract, candidate validation and optional decision to decline. Generate **one coherent, genuinely different possible person**, not another commentary on the latest interaction.

- Imaginatively fill unknowns with **internally fitting** concrete details that do not conflict with known observations.
- The text should make the person's inner logic understandable as a whole, rather than merely label a trait.
- Prefer differences in underlying motives, causal structure, relationships, experiences or life circumstances over synonyms, an extra trait, a minor temperament change, or a different retelling of the same episode.
- Keep the stored text free of argumentation, quotes, chronology and experiment proposals.
- Existing **Generation Review** is part of this same behavioral boundary: it must verify **distinctness and compatibility**, **not evidential support or literal truth of imaginative completion**. Reject incompatibility with observations; do not reject mere invention. Preserve its existing accept/reject shape and process position.
- Keep the existing Prefetch generation flag, scheduler, decision logic and number of candidate requests. This patch does not require more frequent Generation or guarantee the model will choose to generate.

### S4. Consolidation: equivalence of people, not of wording or events

Keep the existing first stage of Maintenance: **one request over the complete current interpretation set**, followed by individual checks and atomic persistence (Spec 0004).

- Merge images of **substantially the same person and explanatory logic** even when examples, phrasing or observed episodes differ. Retain the coherent, distinctive details in the surviving image.
- Preserve materially different possible people: motivations, causal accounts, ways of life, relationships or imagined histories, even if they share some traits or explain the same observed events.
- Shared incidents, similar local predictions or overlapping facts are **not** by themselves reasons for merging.
- Do not average incompatible people into one compromise; do not filter unusual or speculative images for plausibility or absence of support.
- Strip chronicles, evidence bookkeeping and maintenance notes while preserving what is distinctive about each imagined life.
- **Consolidation is not truth-checking and is not Generation.** It cannot add unrelated new hypotheses. Its job is to recognize equivalence and preserve diversity.
- Retain the existing all-input coverage rule, stable representative/source-ID mapping, no arbitrary count cap, output size bounds, validation, retry/skip behavior and atomicity. Never silently truncate an oversized batch.

### S5. Individual Maintenance: could this still be that user?

After Consolidation, the existing individual verification stage asks: **“Could this imagined person still be the user we have observed?”**

- **Unconfirmed but compatible:** retain the possible-person image, including imagined detail. Lack of corroboration does not warrant deletion, caveat accumulation, or forced narrowing.
- **Direct contradiction:** amend the image so its inner logic still holds **without** appending the contradictory event, a footnote, disclaimer, audit trail or experiment outcome.
- **Irreparable contradiction:** delete the interpretation when its defining image cannot be kept coherent and compatible, consistent with the existing Maintenance deletion action.
- Preserve distinctness of the image, even when nearby alternatives would be easier to reuse. Do not converge merely to reduce uncertainty.
- Preserve the existing `unchanged` / `replace` / `delete` response structure, completed-experiment-ID validation, snapshot/revision guards and one-transaction application. Experiment-completion detection remains a separate output concern; **do not** write completion bookkeeping into the saved interpretation.
- The evidence against which compatibility is checked remains the **existing** conversation, memory, typed observations and active-experiment inputs under their existing access rules. Do not introduce new evidence sources or fact-checking services.

### S6. Gestalt, Dialogue and experimentation boundary

- Each **individual** interpretation is complete as a possible person. The **collective** Gestalt is necessarily tentative and incomplete: the relations and incompatibilities among interpretations remain unresolved.
- Gestaltization represents meaningful alternatives and tensions without selecting a winner, averaging them into an unambiguous profile, or promoting invented biography to established fact.
- Dialogue continues to receive **Gestalt and relevant experiment intentions**, not raw interpretations. A speculative detail mentioned in Gestalt remains explicitly tentative; Dialogue may use it for sensitivity or imaginative interaction, but **must not assert it as an established fact about the real user**.
- Existing Experiment Planning may use the differences between images to explore uncertainty. **No changes** to planning logic, prompts, scheduling, experiment entities, initiative system or interfaces are authorized solely by this patch.
- Maintain character-owned data boundaries, separate Character/Scene/User descriptions, image-observation constraints, and all current prompt/context restrictions.

### S7. Prompt change boundary

The following existing prompts/semantic instructions may be **edited only as needed** to implement S1–S6:

- Shared Contemplation role/evidence wording as it pertains to interpretations;
- Generation and its existing Generation Review;
- Consolidation and individual Maintenance;
- Gestaltization and its treatment of alternatives;
- The **narrow** downstream Dialogue/Gestalt distinction necessary to prevent promoting invented details to facts.

Existing Prefetch and Experiment Planning purpose/trigger/output semantics remain unchanged; any edits to them must be minimal consistency corrections required by S1–S6, not a new decision policy. Other prompts and transport-level repair instructions remain unchanged. These are **content-driven edits**, not permission for a general prompt rewrite during refactoring.

## 3. R1 — Explicit LLM-operation contracts

### R1.1. Contract binding for existing purposes

For **each current structured LLM purpose**, make the following relationship explicitly discoverable in code:

1. Its current **model role** (`dialogue`, `contemplation` or `vision`) and character-configuration source;
2. Its readable **system prompt** (continue to store prompt texts in `src/prompts/`);
3. Its **response shape/format contract**;
4. Its **syntax/structural validator** and any semantic, snapshot-dependent validation;
5. Its current **input limits, allowed IDs, reference membership, length constraints and other safeguards**;
6. Its current use of response formatting, JSON repair, truncation retry, timeout and error policy **as actually applicable**, not as one universal schema.

The precise grouping, exported functions and module filenames are a **local implementation decision**. The goal is to remove genuinely duplicated or disconnected contract declarations while preserving clear ownership; **do not build a universal contract framework, plugin interface or new dependency-injection system**.

### R1.2. Preserve boundaries and effective requests

- Distinguish **response syntax/shape** from **meaning-specific validation**. All per-call ID membership, complete-set coverage, ownership and staleness checks must still use the appropriate **current input snapshot**. JSON schema alone is not a replacement for these checks.
- Keep network transport, response-format downgrade, bounded repairs and truncation recovery in the existing LLM layer. Moving a contract must not widen usage of `response_format` or structured output to background purposes merely for uniformity.
- Preserve the purpose string, character-selected model, temperature, output budget, context-fit checks, provider request parameters, allowed format modes, request counts and retry semantics for unchanged cases.
- Do not restructure the internal algorithms of **Memory**, **Dialogue** or **Vision** beyond adapting them to the extracted contracts.
- Do not alter the public model configuration, per-character ownership or output envelope of any purpose.

**Allowed exception:** Some **Contemplation prompt text** and its expected semantic result will intentionally differ as required by **S1–S7**. The surrounding transport and structured response contracts still must be equivalent.

## 4. R2 — Separate Contemplation responsibilities

Separate the current Contemplation responsibilities into the following coherent boundaries, without creating a new runtime subsystem:

### R2.1. Orchestration

Own existing user-message triggers, Prefetch scheduling, forced requests, deduplication of queued work, work-loop ordering, serialized execution per interpretation pool, bounded parallel work where it already exists, restart recovery, planning timers, running/queued/idle state and maintenance/Force status reporting.

This layer decides **which existing stage runs when**; it does not edit result prose or prematurely commit a candidate.

### R2.2. Stage execution

Own preparation of the stage's current inputs, the appropriate source snapshots, construction of LLM messages, individual model calls, repair/validation, and production of **uncommitted candidate results** for current Maintenance (Consolidation + verification), Generation (+ review), Gestaltization and Experiment Planning. Existing auxiliary Prefetch and memory retrieval remain at their present decision points.

Stage execution must preserve all existing limits, prompt messages except S-authorized semantic edits, model roles, concurrency and error semantics. It must not persist a consolidated candidate before verification or introduce a new intermediate durable state.

### R2.3. Atomic application

Own final stale-result checks, snapshot/revision and experiment guards, transactional writes and deletions, conditional revision bumps, watermarks, gestalt/source revision updates, planning-needed flags and other existing state mutations. Apply **only** previously validated results with their relevant source-state metadata.

**Concurrency invariant:** A revision/state validation that protects a write occurs **inside the transaction that performs that write**, never only in an earlier LLM stage or unprotected orchestration callback. Failure, stale input or invalid output must leave the relevant previously persisted state intact according to the present behavior.

### R2.4. Compatibility

The existing `Contemplation` class may remain the application-facing facade; public methods and endpoint behavior remain compatible. Do **not** add processes, independent services, queues, event buses, database tables, external workers or different persistent state machines.

The stage/apply boundary may pass candidate values and source-state metadata as ordinary internal data. Its representation is a local technical decision, provided it does not change effective snapshot timing or persistence semantics.

## 5. Required behavioral equivalence outside S

For identical initial DB state, deterministic time and external events, and the **same model responses** (or corresponding outputs when S-authorized prompt changes are being assessed separately), the R1/R2 refactor must preserve:

- LLM **purpose**, chosen character/model/configuration, request parameters, response mode, repair attempts, timeout/backoff and valid fallback policy;
- **Prompt bytes and message ordering** outside explicit S edits; same AI-facing context fields and source boundaries;
- The **moment** each existing profile, history, memory, interpretation and experiment snapshot is taken. **Do not** create one frozen snapshot across the entire Contemplation cycle if different stages currently read live state at different points;
- Stage ordering, dependency graph, per-pool serial execution, existing bounded parallel item verification, and Dialogue's independence from waiting for Contemplation;
- Error classification, rejection of invalid outputs, handling of stale results, correct continuation/abort policy for later operations;
- Spec 0004's Maintenance atomicity (full-set Consolidation → all candidate verifications → one commit, otherwise no partial interpretation/experiment writes);
- Existing generation acceptance/refusal lifecycle, gestalt revision eligibility, experimentation-planning triggers, watermark/revision increments and automatic/Force/restart recovery behavior;
- Character isolation, per-job frozen configuration, Vision evidence limits, and raw-interpretation exclusion from Dialogue;
- Existing external HTTP endpoints, UI, SQLite schema, diagnostics content, emergency-dump layout and stored record identity. Source paths/stack trace lines may change as code moves.

For **intentional** differences, the reviewer must cite **S1–S7** and explain why the difference implements pregnant interpretations. Any unexplained difference is a regression, not a permitted optimization.

## 6. Explicit non-goals and prohibitions

Neither S nor R authorizes:

- New agents/stages/schedules, new memory tiers or experiment machinery, character-ownership redesign, data migrations, new API endpoints, or UI behavior changes;
- Cost/latency optimization, context shrinking, caching, model swaps, shorter or fewer LLM calls, a task-wide time budget, different polling, or new performance metrics;
- Cutting down the full set of interpretations, increasing the 4,000-character hard limit, changing output schemas, or introducing count/length targets for interpretations;
- “Optimizing” Maintenance by stopping remaining checks after an error, partially persisting, changing the Consolidation → verify → commit order, or replacing per-item verification with one global judgment;
- New forced Maintenance cadence, different Prefetch policy, scheduled experiments, changes to automatic initiative, or claims that this patch **guarantees** more initiative from GLM;
- Enabling structured outputs for background requests purely as part of contract refactoring;
- Manual user editing of interpretations/experiments/gestalt, or changes to Force controls, keyboard shortcuts, mobile composer or image generation workflow;
- Bulk sanitization of existing saved prose, retroactive mass conversion of interpretations, or treating invented details as actual memory.

The owner's interest in how **GLM** responds to the new semantic framing is an **evaluation motivation**, not permission to change model choice, temperature, budgets, task schedule or provider logic.

## 7. Acceptance criteria and tests

### S — Semantic acceptance

1. **Whole-person image:** Generated text depicts a psychologically recognizable possible person whose motivations and circumstances form a connected explanation, not a list of traits or recap of the latest messages.
2. **Imaginative completion:** A concrete invented biographical, relational or motivational detail is permissible and can appear in a candidate when it does not contradict observations. Tests/prompts do not demand direct evidence for it.
3. **Generation Review:** A coherent, distinctive but wholly unverified imagined history is **accepted as compatible** by the review contract, provided there is no direct contradiction; an evidenced contradiction is rejected.
4. **Unverified survives Maintenance:** With no contradictory evidence, individual Maintenance keeps such speculative content (unchanged or a coherent rewrite for another legitimate reason) and does not replace it with “not enough evidence.”
5. **Contradiction repaired:** When the user's observed statements/actions refute a defining detail, Maintenance coherently revises the person-image without appending the contradictory event, citation or maintenance log; when repair destroys the image's defining logic, `delete` is available.
6. **Equivalent images consolidate:** Two different wordings/episodes of one underlying possible person become one, with representative/source IDs correctly accounted for and distinctive compatible detail retained.
7. **Distinct images survive:** Two materially different motives/life histories explaining the same event remain distinct, including when the two images contradict each other. Do not collapse them because they predict a similar action.
8. **No chronicle in persistence:** New/updated interpretation texts contain no detailed transcript chronology, evidence quotes/lists, experiment IDs, next-step plans, or maintenance/audit bookkeeping.
9. **No forced brevity/count:** A coherent image approaching the 4,000-character limit may remain valid; no hard new length or count target, and no 4,000+ character result is accepted.
10. **Unresolved Gestalt:** Gestalt carries meaningful competing possible-person images without treating their imaginative facts as established biography, discarding inconvenient alternatives or averaging everything into one definitive portrait.
11. **Dialogue boundary:** A speculative Gestalt detail does not become a factual user assertion in Dialogue. Dialogue continues to receive Gestalt/intention, never raw interpretations.
12. **Prefetch/experiments unchanged:** The new semantics do not introduce new automatic triggers or change experiment lifecycle, generation cadence, memory policy or Force UI.
13. **Legacy stored data:** Existing interpretations stay untouched on startup/migration and are revised only via existing authorized Contemplation operations.

**How to evaluate S:** Verify exact prompt/validator requirements in deterministic tests and review representative **mocked** Generation/Consolidation/Maintenance/Gestalt cases, including counterexamples. A real-model GLM trial can then be conducted by the owner; it is **qualitative**, not a claim of guaranteed improvement or a mandatory paid acceptance test.

### R1/R2 — Refactoring acceptance

14. For every pre-existing structured LLM purpose, the implementation exposes an explicit, readable association of role, prompt, response shape, validator and constraints, with prompts still in `src/prompts/`.
15. Snapshot-scoped ID, text, pool/character membership, coverage and stale-state validations remain enforced beyond JSON shape validation.
16. `response_format`, repair, format-downgrade and truncation retry apply to **exactly** the same purposes and conditions as before; background calls are not silently upgraded to a new output mode.
17. For unchanged purposes, request traces under fixed fixtures match the baseline in purpose, model, config, input payload, message order, outputs and repair behavior. For changed Contemplation prompt text, record a **specific S requirement** justifying each behavioral difference.
18. At equal controlled time/external events, the orchestration fires the same stages in the same dependencies; independent calls may finish in different order only within the previously permitted concurrency.
19. A pool remains serialized, while the existing parallel per-interpretation verification can still proceed within its configured bound; Dialogue never blocks on background Contemplation.
20. Profile, conversation, memory, interpretations and experiments are snapshotted at the same **stage-specific moments** as before, and each logical job continues to use its own frozen character model configuration.
21. Maintenance failure during Consolidation or any later verifier yields **no partial persistence**. A valid complete run updates interpretations/experiments in one atomic application with appropriate revisions; an unchanged result does not spuriously bump revisions.
22. Concurrent addition/edit/deletion of experiments or interpretation revision changes while an LLM call is held cause the applicable stale-result guard to reject the whole result, preserving newer state.
23. Status/Force outcomes, watermarks, gestalts, planning-needed flags and recovery behavior match the baseline at equivalent checkpoints, including after restart and interrupted jobs.
24. Character A/B remain isolated across parallel requests, profiles, cognitive data, saved results and model selection; the current UI character is not used as an implicit owner.
25. The server's HTTP contracts, client UI, SQLite schema, diagnostics/dump fields, security properties and existing memory/vision/image-generation behavior remain unchanged.
26. All existing automated tests pass (with imports updated only when extraction requires it) plus targeted tests for contract mapping, snapshot protection, atomicity and semantic boundaries. **Do not weaken assertions to make the refactor pass.**
27. Documentation (README/AGENTS as appropriate) describes the new code boundaries without claiming new user-facing functionality beyond S.
28. Review lists **separately** structural changes from R1/R2 and behavior changes from S, with traceability to the numbered clauses above. Real paid LLM calls are not required for these regression tests.

## 8. Delivery and review protocol

- Implement this specification **only** after the owner's separate authorization. No automatic implementation, Git commit or review-message write follows from this draft.
- The implementer identifies the actual source commit and corresponding GitHub Actions snapshot before starting. Compare against that baseline, not a stale checkout.
- Prefer a reviewable implementation in which the semantic prompt changes can be distinguished from mechanical module moves; the precise commit breakdown is a local decision, not permission for independent architectural redesign.
- Record test environment and whether Node.js meets the project's supported version. A successful GitHub Actions source-snapshot workflow **does not** alone prove the tests ran in CI.
- For code review, examine the new GitHub Actions source snapshot. Communicate model-to-model through the owner; write `docs/review/` only if the owner requests it.
- Each implementation/review communication begins with the four-point summary: **architecture, behavior, risks/objections, decisions required from owner**.
- If the content and refactoring requirements conflict, **do not** silently resolve the conflict by weakening either. Report the precise conflict to the owner.

**Core rule:** *Each interpretation completes a possible person. The set preserves multiple, potentially incompatible people. Maintenance removes incompatibility with observations—not uncertainty. Refactoring must preserve everything else.*
