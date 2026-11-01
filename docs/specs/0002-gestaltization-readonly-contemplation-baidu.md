# Beholder — Specification 0002: Gestaltization, Read-Only Contemplation, and Baidu Exclusion

**Status:** APPROVED CONCEPT / FORMAL SPECIFICATION — implementation requires a separate explicit owner command.
**Project:** Beholder
**Baseline:** Specifications 0000 and 0001; source snapshot at commit 138405cfeb33d764658dd92a5e7a87a61126f682.
**Scope:** Contemplation synthesis and Dialogue context, Contemplation page, OpenRouter text-provider exclusions.

## 0. Executive summary for owner / Claude

1. **Architectural decisions:** Add **Gestaltization** as a persistent, pool-scoped synthesis stage within the existing Contemplation pipeline. It transforms all current interpretations together with the **previous gestalt** into a renewed **gestalt**, then exposes that gestalt (but not raw interpretations) to Dialogue. The existing interpretation-pool scope controls whether this state is shared or private. The Contemplation page becomes read-only. Add provider slug **baidu** to the existing OpenRouter text-provider ignore list.
2. **User-visible behavior:** The character can develop a more continuous, multifaceted impression of the user rather than receiving experiment intentions alone. The page shows the gestalt, interpretations, experiments, and process state without editing or Force controls. Text Chat Completions cannot route through Baidu Qianfan.
3. **Objections and risks:** A gestalt that collapses the user into a fixed profile, diagnosis, single hypothesis, or mutually exclusive interpretation ranking violates the concept. A previous gestalt must provide continuity, not self-confirming "evidence". Async synthesis must not overwrite results from newer interpretation revisions. Provider exclusion must not change the chosen model or image routing.
4. **Owner decisions required:** **None**. The owner has explicitly chosen **reinterpretation of the previous gestalt**, not regeneration from scratch. The remaining implementation details are local decisions within this specification.

This document specifies **three agreed changes** in one patch. It supersedes Spec 0000 only where expressly stated; otherwise Specs 0000 and 0001 remain authoritative.

## 1. Concept: the user is the whole, interpretations are perspectives

The gestalt is the Contemplation subsystem's **current, evolving perception of the user as one whole, ultimately unknown and inexhaustible being**. Individual interpretations are different possible views of that whole.

Think of several interpretations of a single artwork: beauty, danger, scale, movement, vulnerability, humor, and countless other readings may coexist. None of those readings is the artwork itself. Likewise, the user **is not any one interpretation, nor the sum of a checklist of them**.

The principal instruction for gestaltization is:

> Preserve the **key points of every current interpretation** as hypotheses or perspectives, while making the **unity and fundamental unknowability of the person** the central organizing idea. The interpretations may all illuminate the same user simultaneously, including in apparently conflicting ways; none defines or exhausts the user.

Required semantic qualities:

- An integrated, readable, free-form reflective **text**, not a flat inventory, trait table, diagnosis, classifier, score or verdict.
- **All key points** of the current interpretation set remain represented as **possible readings**, not established facts. Do not silently select only the most convenient interpretations.
- Contradictory or tension-filled readings may coexist. Do not force an artificial resolution, choose a winner, or average them into a dull compromise.
- The subject's unity is **ontological/perceptual**, not a demand for one explanatory theory: **one person, many incomplete views**.
- Allow genuine surprise, uncertainty, ambiguity and reinterpretation. Avoid finalizing the user into an established psychological portrait.
- The gestalt can express relationships among the interpretations and find new connections, but it must not assert invented biographical facts or present speculation as observed truth.
- A past gestalt is a **historical perspective**, not new independent evidence that its own conclusions were true. Revise or discard former emphases freely when the current interpretation set warrants it.
- The gestalt is neither a plan to influence the user nor a list of experiment tasks. Experiment intentions remain separate.

**Example only, not text to hardcode:** "He may seek closeness while also studying the experience of closeness. These need not be rival explanations: curiosity could sometimes itself be a form of attachment. Yet even this synthesis is just a way of looking at one person who remains richer than any description."

Do not mandate the example's topic, style, length, or interpretation.

## 2. New persistent state: gestalt

### G1. Ownership and persistence

- Store **one current gestalt per interpretation pool** in SQLite, using the existing **shared/private interpretation-pool identity**. Do not create a separate independent scope toggle or a gestalt-per-character duplicate for a shared pool.
- The gestalt is **persistent across requests, browser closure, and server restarts**; it is not recomputed from scratch whenever Dialogue runs.
- Persist at least: **gestalt text**, **the interpretation revision on which it was synthesized**, and **update timestamp**. Keep the current valid gestalt when synthesis is pending or fails; expose whether it is current/pending/stale through existing status/diagnostic conventions.
- An old database migrates without losing characters, chats, interpretations, experiments, memories, images, or settings.
- A pool with **no interpretations and no previous gestalt** begins with **no gestalt** (null / "Not formed yet"); do not fabricate specific knowledge of the user.
- If an existing pool subsequently has **all interpretations removed**, a pending gestaltization still reconsiders the previous gestalt. The result must retract unsupported specific readings and may retain the open-ended acknowledgment that the user is unknown. Do not display obsolete claims as current certainty.
- A pool with existing interpretations but no gestalt (including existing databases upgraded to 0002) should be eligible for **initial synthesis** automatically when Contemplation is enabled and can run. No user-operated Force button is required.

### G2. Gestaltization model call

- Use the **already configured Contemplation text model** via the existing OpenRouter/LLM client and its validation, repair, retry, redaction, and diagnostics infrastructure; do not introduce a new model selector or external service.
- Input: **every current interpretation** of that pool, **the previous gestalt** (or null), the relevant pool/revision metadata, and the output contract. The interpretations are the present hypotheses; the old gestalt is continuity context.
- This specific synthesis pass does **not** need raw chat messages, STM/LTM, experiment intentions, or another memory retrieval step. Do not add them by default or make synthesis a second interpretation generator.
- Output: **one nonempty free-form gestalt text** in a locally validated structured response. A failed parse, invalid response, empty output, or model error may not replace the previous valid state.
- The synthesis prompt must contain the semantic requirements in section 1 explicitly; merely instructing the model to "summarize interpretations" is insufficient.
- Keep the entire input interpretation set semantically represented. Do not impose an arbitrary count limit or silently truncate existing interpretations to fit an output cap; if the model context cannot accommodate the set, handle the limitation explicitly without committing an incomplete gestalt. The implementation may choose a bounded, loss-aware approach consistent with existing infrastructure.
- This is **one evolving state**: do not persist a growing list of previous gestalts or an additional history/ontology subsystem.

### G3. Triggers, sequencing, and race safety

- Schedule gestaltization **when the committed interpretation revision changes** through generation, maintenance, or any existing internal mutation path, **not** merely because the user sent a chat message or an experiment changed.
- Coalesce multiple interpretation changes within the same pool cycle: synthesize **once against the final committed interpretation set** after maintenance and generation. Ordinary experiment completion or replanning alone does not trigger gestaltization.
- Extend the existing per-pool serialized Contemplation pipeline. Conceptual order when work is due: **prefetch → maintenance → generation → gestaltization → experiment planning**. Keep the established relative order and behavior of existing steps. Dialogue remains independent and never waits for synthesis.
- The gestaltization request snapshots **interpretation revision + all interpretation texts + prior gestalt**. Commit only if the interpretation revision is still the revision examined; a stale LLM result is discarded, not published. A later/current run must be eligible to synthesize the newer revision.
- Preserve the existing revision/watermark/coalescing guarantees and transactional writes. The persisted interpretation revision and the revision attached to the last valid gestalt must allow **recovery of unsynthesized work after restart**, subject to the API key and Enable Contemplation setting.
- A synthesis failure retains the last valid gestalt and records a distinct error/stage in existing diagnostics. **It must not block** an otherwise valid interpretation batch, experiment planning, or normal Dialogue; pending synthesis remains recoverable on a later opportunity.
- Do not repeatedly spend tokens on gestaltization when the interpretation revision is unchanged and a current gestalt already exists. A failed job may retry according to the project's bounded retry/recovery policy, not an unbounded tight loop.
- Existing contemplation maintenance remains free to replace/delete interpretations; gestaltization **never changes interpretations or experiments**.

### G4. When Contemplation is disabled

- Disabling Contemplation stops **new automatic gestaltization** together with the existing automatic contemplation pipeline.
- Persisted gestalt state and read-only display remain available.
- **Do not inject gestalt or experiments into Dialogue while Contemplation is disabled**, matching the existing experiment-intention toggle semantics. Do not delete the stored state.
- When re-enabled, eligible unsynthesized revisions may be processed without manual editing or Force UI.

## 3. Dialogue boundary: gestalt enters the character's context

### D1. Inputs and scope

- Pass the **latest valid persisted gestalt** from the character's currently selected interpretation pool to the Dialogue model for **normal replies, Retry, autonomous follow-ups, and openers**, subject to Enable Contemplation.
- Give the Dialogue model the gestalt as a distinct, clearly labeled part of its **system context**, alongside the existing persona contract, pinned user self-description, retrieved factual memory and active experiment intentions.
- Do **not** pass the underlying raw interpretation texts. This changes Spec 0000's "experiments only" boundary to **"gestalt + active experiment intentions, but not raw interpretations."**
- Changing a character's shared/private interpretation flag immediately changes the source pool for **both** gestalt and experiments. Do not mix a shared gestalt with private experiments or vice versa.
- A pool without a gestalt produces no invented fallback portrait. Existing dialogue works without it.
- A newly completed gestalt becomes visible on the **next assembled Dialogue request**; do not interrupt or retroactively modify an in-flight dialogue response.

### D2. Explicit system-prompt semantics

Explain to the Dialogue model, in direct language, that:

1. The gestalt is **your evolving, tentative impression** of a whole human being, not an objective fact sheet, direct quotation from the user, diagnosis, instruction, or exhaustive description.
2. Its component claims are **possible perspectives**. Several may coexist or conflict without requiring you to choose which is "correct".
3. The actual user remains **one whole, fundamentally unknown and more than any representation**, including this gestalt. Do not reduce them to a type or a set of traits.
4. You may draw on the gestalt to experience the user's complexity, recognize connections, find new angles, or **naturally discuss your own impressions and uncertainties with the user**. You are not required to cite, recite, enumerate, or announce the gestalt.
5. Distinguish tentative perception from factual memory and observed statements. A shared pool may reflect observations made in **other characters' conversations**; do not falsely remember those as interactions you personally had.
6. The gestalt is **not** an experiment script, mandatory intervention, or behavioral optimization goal. Experiment intentions remain a separate optional context component.

Keep the existing Dialogue roleplay rules, timestamp context, JSON response contract, image handling, follow-up behavior and memory retrieval unchanged.

## 4. Contemplation page becomes reference-only

### U1. Content

For the selected character's active interpretation pool, show:

- **Gestalt** as a clearly labeled, readable text section, including an empty/"not formed" state and optionally last-updated / pending status.
- **Interpretations** in their current form, read-only.
- **Active experiments** in their current form, read-only.
- Existing process/status diagnostics: current stage (including gestaltization), activity, queued work, last errors, and pool scope as available.

Preserve existing polling/update behavior and safe text rendering. Do not present an old gestalt as newly generated if a newer revision is pending.

### U2. Remove all page actions

- Remove **Add, Edit, Save, Delete** controls, textareas, and other manual mutation affordances for interpretations or experiments.
- Remove **Force Generation, Force Maintenance, Force Experimentation** and any other manual process-start controls from this page.
- The Contemplation page is **informational only**: visiting, polling and reading it must not intentionally mutate the contemplation state.
- Replace obsolete explanatory copy claiming "only experiments go to Dialogue" or that users can force/edit entries.
- This requirement is about the **Contemplation page**. It does not remove unrelated chat, character, or settings controls.
- Do not perform an unrelated API redesign merely to remove front-end controls. Existing backend manual-mutation endpoints may remain for internal compatibility unless their removal is separately approved; **the page must not invoke or expose them**.

## 5. OpenRouter: exclude Baidu Qianfan from text routing

This section incorporates the owner's separate *Mini-Spec — Exclude Baidu Qianfan from OpenRouter Routing* and changes only the text-provider routing policy.

### B1. Provider exclusion

- Add the **exact OpenRouter provider slug "baidu"** to the existing provider exclusion list. **Preserve all existing exclusions** (currently alibaba, Phala, SiliconFlow, GMICloud).
- Include the exclusion in **every text Chat Completions request**, regardless of role/purpose: Dialogue, Contemplation (including gestaltization), memory, retrieval, retries, JSON repair, and truncation recovery.
- Keep the user-selected model **unchanged** and preserve OpenRouter's automatic fallback among **other eligible providers**.
- Preserve current allow_fallbacks and require_parameters behavior, response_format negotiation, transport retry budget and local JSON parsing/validation/normalization/repair. Do not quietly remove the exclusion when a request fails.
- Exclusion applies to **text Chat Completions**, not the separate Images API; **do not change image generation** or image routing.
- Do not choose, prioritize or hardcode a replacement provider. No provider configuration UI.

### B2. Diagnostics

- Retain the existing diagnostics of the **actual provider** reported by OpenRouter when supplied, including on retries, without exposing the API key.
- No new diagnostics subsystem, route-testing service or UI is required.
- A live **post-deployment dump** should confirm Baidu is no longer selected for text requests; this is a deployment verification step, **not** something deterministic offline tests can prove.

## 6. Compatibility / implementation boundaries

Likely implementation areas (guidance, not permission to refactor broadly):

- **src/contemplation.js** and **src/prompts/contemplation.js** — synthesis prompt, role/purpose, trigger/coalescing, stage/error handling.
- **src/db.js** — narrow SQLite migration, per-pool gestalt persistence and source revision.
- **src/llm.js** — register gestaltization purpose under the existing Contemplation model role.
- **src/dialogue.js** and **src/prompts/dialogue.js** — pass gestalt to Dialogue and explain its epistemic semantics.
- **src/server.js** and **public/app.js** — return/read gestalt and remove Contemplation-page write controls.
- **src/openrouter.js** — add baidu to the existing text-provider ignore list.
- **tests/**, **README.md**, **AGENTS.md** — regressions and documentation matching the implemented behavior.

No new model, feature toggle, separate gestalt scope, background agent, interpretation ontology, ranking/confidence scores, personality diagnosis, user-profile settings, or history of old gestalts. Do not change image generation, existing experiment logic, memory consolidation/retrieval, character creation, temporal context, dialogue response recovery, or dialogue initiative beyond passing gestalt.

If a concrete implementation detail seems to require an **architectural change outside this specification**, ask the owner before doing it; two models agreeing is not authorization.

## 7. Acceptance scenarios

### Gestalt content and semantics

1. **Initial synthesis:** A migrated pool with interpretations but no gestalt automatically gains a valid, persisted gestalt when Contemplation can run; there is no dependence on a Force button.
2. **Complete coverage:** In a fixture with several meaningfully different interpretations, the gestalt represents **each one's key points** tentatively; it does not omit some in favor of a single "winning" profile.
3. **Coexisting tensions:** In a fixture containing compatible-but-apparently-contradictory hypotheses, the synthesis preserves multiple readings and explicitly makes the user's whole unknowable identity central; it does not diagnose, label, or collapse the user.
4. **Continuity:** On a changed interpretation revision, the gestalt model receives **the previous gestalt** together with **all current interpretations**; the valid updated gestalt replaces the prior text.
5. **Revision:** When a hypothesis is revised or deleted, the resulting gestalt can **retract or radically rethink** the corresponding earlier idea; the old gestalt is not treated as evidence.
6. **No interpretations:** A new empty pool has no invented portrait. If a previously populated pool becomes empty, reconsider its existing gestalt without preserving unsupported specifics as settled truths.

### Persistence and pipeline

7. **Scope:** Shared-pool characters receive the same current gestalt; private-pool characters keep independent gestalts. Switching the character's interpretation scope switches both gestalt and experiments without copying data.
8. **Single synthesis:** Multiple interpretation changes inside one cycle cause at most one synthesis of the final pool revision; an experiment-only revision causes none.
9. **No unnecessary work:** No gestaltization call is made on a user message when prefetch/maintenance/generation do not change interpretations and a current gestalt already exists.
10. **Race safety:** If the interpretation revision changes while a gestalt model call is running, its stale output cannot overwrite a newer synthesis or be marked current; the newer revision remains eligible.
11. **Failure recovery:** Malformed/failed synthesis preserves the last valid gestalt, reports the error, allows ordinary dialogue and experiment planning to proceed, and retries later within bounded scheduling.
12. **Restart:** After restart/migration, persisted gestalt remains available; pending/outdated revisions are recognized and can be updated once Contemplation is available.
13. **Disabled:** With Contemplation disabled, no automatic synthesis is scheduled and no gestalt/experiment intentions are injected into Dialogue; persisted state remains visible.

### Dialogue and read-only UI

14. **Dialogue context:** Normal reply, Retry, follow-up and opener receive the current gestalt with its system-prompt semantics, but **never raw interpretation texts**.
15. **No gestalt yet:** Dialogue proceeds normally, with no fabricated portrait, when its selected pool has no gestalt.
16. **No rewriting:** Gestalt is input context only; it does not modify past chat messages, timestamps, factual memory, images, response envelopes or experiment intentions.
17. **Page:** The Contemplation page displays gestalt, interpretations, experiments and process status. The empty/pending/error states render without crashing.
18. **Read-only:** The page has no Add/Edit/Delete/Save/Force controls or mutation requests; polling is read-only. Existing chat/character/settings controls remain.
19. **Documentation:** No obsolete text claims that raw interpretations or gestalt are absent from Dialogue or that manual Force/edit controls remain on the page.

### Baidu exclusion and regressions

20. **All text requests:** Mock all text purposes including new gestaltization, memory, retry and JSON repair: every outgoing Chat Completions request includes "baidu" in provider.ignore and preserves every previous ignored provider.
21. **Fallback and model:** allow_fallbacks, require_parameters and JSON-format negotiation remain intact; a failed attempt never silently clears the exclusion or changes the selected model.
22. **Images:** Existing separate Images API request and provider behavior are unchanged.
23. **Diagnostics:** Actual provider metadata is recorded when available and redacted as before; a post-deployment dump is inspected for Baidu routing.
24. **Full regression:** Existing Specs 0000/0001 test suites pass along with new tests for synthesis semantics, race/restart behavior, Dialogue boundaries, page read-only behavior, and provider exclusions.

Tests must verify **prompts/inputs, state transitions, and invariants** deterministically with mocked LLMs. A live model's subjective quality is a separate manual evaluation; tests must not pretend to mathematically certify open-ended artistic/psychological adequacy.

## 8. Completion and review

- Implement only after the owner's **separate explicit authorization**; committing this specification does not authorize coding.
- Include database migration tests and validate old installations retain data.
- Run the complete test suite using the supported Node.js runtime and report any environment limitations.
- Update README and AGENTS.md to reflect actual verified behavior.
- Provide a source commit and a **GitHub Actions repository snapshot** for code review; keep reviewer communication under **docs/review/**.
- During review, summarize architectural changes, user-visible changes, risks and owner decisions **before** technical details.

**End of Specification 0002.**
