# Beholder — Spec 0004 Code Review

**Reviewed commit:** `1efe1f0bd608e00ea7eb24f9fab8d8db0bc6fa74`  
**Source:** GitHub Actions snapshot, run `41421119910`, artifact `repo-1efe1f0bd608e00ea7eb24f9fab8d8db0bc6fa74`  
**Disposition:** CHANGES REQUESTED — one P2 concurrency/state-consistency finding; no new architecture decisions.

## Executive summary (owner / Claude)

1. **Architectural decisions:** Approved design is implemented: interpretation-set consolidation happens first within existing Maintenance; final verified interpretations and applicable experiment completions commit transactionally. Shared memory/interpretation scopes are replaced by character-owned cognition, with a versioned, single-owner migration. Composer changes are limited to the existing web UI. No unapproved architectural change identified.
2. **User-visible behavior:** Consolidated hypotheses should be less repetitive, the two Shared controls are gone, and composer buttons are compact with Enter as a newline. Existing character's cognitive state is migrated; newly created characters begin empty. On-device software-keyboard acceptance remains the owner's manual test.
3. **Objections and risks:** **P2:** Maintenance's stale commit guard checks interpretation revision/IDs/text but not the experiment revision or full experiment snapshot used by each verification call. An experiment added/edited/deleted through the still-existing internal/API mutation pathways while verification is in flight permits committing interpretation changes derived from stale activeExperiments. This falls short of Spec 0004 C4's source-state snapshot and staleness guarantee. The passing automated suite was run on Node 22.16.0, not the project-declared Node >=24. GitHub Actions success confirms snapshot upload, not CI execution of the test suite.
4. **Owner decisions required:** None. Fix within the approved transactional and revision architecture; the manual real-device test is already assigned to the owner.

## What was verified

- Downloaded and inspected the exact Actions snapshot for `1efe1f0` and compared source with the pre-0004 snapshot `8d95f6c`.
- Local `npm test`: **122/122 passing**, including existing Spec 0000–0003 regressions and new Spec 0004 cases. Syntax verification also passed. Runtime: **Node 22.16.0**, while `package.json` requires `>=24`.
- `src/contemplation.js`: one full-set consolidation before individual verification; strict source-ID accounting; all-or-nothing writes under `store.tx`; correct revision bump only on actual interpretation changes; gestaltization follows committed revisions.
- `src/db.js`: versioned migration moving the single owner's memory records, interpretations, experiments, gestalt and revisions/watermark; preserving record identities and text; atomic abort on ambiguous shared ownership. Tests include a representative schema-3 database, recovery and idempotency.
- `src/app.js`, `src/memory.js`, `src/dialogue.js`, `src/vision.js`, `src/server.js`: ownership routes now use `poolOf(character)`; newly created characters have isolated cognitive pools.
- `public/app.js`, `public/styles.css`: compact image/send controls with accessible names, flexing textarea, multiline input and no Enter-to-submit handler.

## P2 — Maintenance can commit stale interpretations after experiment changes

**Source:** `src/contemplation.js:348–415`, in particular:

- `:359–369` captures `experiments = this.experimentViews(pool)` and passes that set as `activeExperiments` to each individual verification LLM call.
- `:385–388` checks only `interpretationRevision`, interpretation count, IDs and text before applying results. It does **not** check `experimentRevision`, experiment IDs or the complete experiment texts that the LLM reviewed.
- `:401–407` protects **only completed-experiment deletion** against changed experiment text. It does not prevent `replace`/`delete` actions on interpretations from being committed after the experiment context used by verification changed.
- `src/contemplation.js:632–647` still supports experiment mutations that increment `experimentRevision`; mutation endpoints remain available in `src/server.js` even though the Contemplation UI is read-only.

**Reproduction outline:** Start a Maintenance run with a nonempty set and an active experiment. Hold one individual-verification response. During that call, edit, delete or add an active experiment using the existing API. Return a valid `replace` response for an interpretation, then release the held call. The commit sees unchanged interpretations and applies the response, even though the verifier's experiment context is no longer current. This contradicts the approved specification's *'Snapshot the interpretation revision/IDs/text and any experiment state relied upon. ... If the relevant source state changed during LLM calls, discard/retry later rather than overwrite or delete newer data with a stale result.'*

**Required fix:** Once the active experiment snapshot for individual verification has been captured, capture its corresponding revision/fingerprint and validate the **same source state** inside the final transaction. If experiments changed, discard the entire proposed Maintenance result as stale; do not partially apply interpretation changes. Preserve the existing bounded retry/defer policy and serial pipeline. This needs no new persistence structure, scheduler or owner decision.

**Regression:** A held individual-verification LLM call, followed by an experiment edit/add/delete during the wait. Assert that neither consolidated interpretations nor completions are persisted, and that the run is recorded as stale. A subsequent run using fresh experiments should apply normally.

## Remaining release verification

- UI automated/static checks do **not** replace Spec 0004 scenario 27: owner must test a real phone with software keyboard visible, including portrait layout and multi-line input.
- Run full test suite with supported **Node.js >=24** before deployment.
- The GitHub Actions workflow in this snapshot **only uploads a repository snapshot**; its successful status is not evidence of tests executing in CI.

## Review outcome

**No P1 findings; one P2 finding.** Implementation appears close to ready. Request a narrow fix and one regression, then re-review the next GitHub Actions snapshot. Do not alter architecture, create additional features, push this review, or implement changes without the owner's instruction.
