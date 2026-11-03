# Beholder — Spec 0006 Code Review (snapshot 312b995)

**Reviewed commit:** `312b9959edcbfdca53c043fbac58a78849079ff8` (includes structural commit `abbdad70e50d9197188d371452062b9b0b793ace`)  
**Basis:** GitHub Actions source snapshot for `312b995`, run `41699486675`, artifact `repo-312b9959edcbfdca53c043fbac58a78849079ff8`.  
**Disposition:** CHANGES REQUESTED — one P2 architectural-boundary issue, no P1.

## Executive summary (owner / Claude)

1. **Architectural decisions:** R1 separates structured LLM contracts under `src/contracts/` and retains prompts in `src/prompts/`. R2 separates Contemplation orchestration, model-backed stages and result application. The split largely meets Spec 0006, but stage execution still invokes a read-or-create database method and can write outside the designated application layer. No new architecture is proposed; complete the existing R2 separation.
2. **Behavior changes:** The approved Pregnant Interpretations semantics are implemented: Generation aims for coherent possible-person images; Generation Review / Maintenance accept compatible imaginative details without demanding proof; Consolidation preserves genuinely distinct people; Gestalt retains alternatives; Dialogue must not promote invented biography to established facts. The refactoring itself is intended to be behavior-preserving. No new user-facing changes requested.
3. **Objections and risks:** **P2** — `src/contemplation-stages.js` calls `store.ensureInterpretationPool(pool)`. This helper issues `INSERT INTO interpretation_pools (pool) VALUES (?) ON CONFLICT(pool) DO NOTHING` before returning the row, so the supposedly stage-only code has a conditional persistence side effect. With an existing pool it normally does nothing, hence no observed functional failure; with a missing pool it inserts a durable row. This is a narrower, structural issue, not evidence that consolidated interpretations are being prematurely committed. Verify the fix by observing SQL writes, not merely scanning for methods named `insert` or `update`.
4. **Owner decisions required:** **None.** The requested correction falls within the approved R2 requirements; do not broaden it into a new storage design or semantic change.

## Review scope and evidence

- Compared source snapshot for `312b995` to the Spec 0005 baseline `3cfb6a5` and evaluated both the R1/R2 and S parts of Spec 0006.
- Local test run during review: **174/174 passing**, on the available **Node.js 22.16.0**. The project declares **Node.js >=24**; repeat the full suite on the supported runtime before deployment. The successful GitHub Actions run denotes a published source snapshot, **not an independent CI test execution**.
- No P1/P2 issue was identified in Maintenance atomicity, experiment-revision checks, parallel verification, character isolation, external API/schema changes, or the S-authorized prompt semantics, apart from the issue below.
- Golden-trace tests provide useful coverage of preserved model request structure, stage ordering and deterministic end state. Model-mocked semantic tests do **not** establish that GLM will behave creatively in practice; evaluate that separately with real-model conversations.

## P2 — Stage execution conditionally writes to SQLite via ensureInterpretationPool

**Affected code:**

- `src/contemplation-stages.js:96` — `verify()`: reads `experimentRevision` via `store.ensureInterpretationPool(pool)`.
- `src/contemplation-stages.js:122` — `generationContext()`: reads `interpretationRevision` through the same helper.
- `src/contemplation-stages.js:132` — `refreshGenerationContext()`: same helper.
- `src/contemplation-stages.js:166` — `gestalt()`: obtains current state through the same helper.
- `src/contemplation-stages.js:188` — `plan()`: same helper.
- `src/db.js:572–577` — `ensureInterpretationPool(pool)` performs `INSERT ... ON CONFLICT DO NOTHING` then `SELECT`.

**Spec requirement:** `docs/specs/0006-pregnant-interpretations-llm-contracts-contemplation-refactoring.md`, **R2.2/R2.3**. Stage execution prepares inputs, calls models, validates output, and yields **uncommitted candidate results**. Result application owns persistence, including atomic writes and guard checks. R2.4 forbids changing persistence semantics or introducing a new DB model.

**Why this matters:** On an absent interpretation-pool row, invoking stage computation can materialize that row before its model requests have succeeded or its outputs have passed verification. On normal existing pools the insertion is a no-op, so this is an architectural separation leak, not evidence of corrupt interpretations or a P1 data-loss incident.

**Requested correction:**

1. Provide/use a **read-only** means of obtaining interpretation-pool state for stage computations. It must not issue any SQL mutation, including `INSERT ... DO NOTHING`.
2. Keep creation/initialization of an absent pool in the already appropriate lifecycle/orchestration/application path; preserve existing normal-start/restart/Force behavior and the stage input snapshot moments. Do **not** silently introduce a new durable intermediate state or move any revision validation outside its protected transaction.
3. Preserve all previously accepted R1/R2 equivalence invariants and all S-stage prompt changes. No new queue, scheduler, transaction convention, schema or capability is authorized.

**Regression tests:**

- Instrument SQLite writes (or use an equivalent observable boundary) during isolated stage execution, including a pool that has not yet been initialized. Assert stage methods perform **no writes** through helper calls, not only no direct writes.
- Assert pool creation remains correct under its intended owner, and automatic/Force startup and recovery continue to work.
- Re-run golden-trace and transactional/stale-result regressions; ensure no model request, ordering, watermark or revision changes arise from the correction.

## Other remaining acceptance work

- Run the full suite on **Node.js >=24**.
- Real-model evaluation of Pregnant Interpretations using the intended GLM model is needed to judge creative/coherent image quality; mocked results cannot validate quality of generated narrative.
- No additional performance optimization, new model selection, changes in Maintenance cadence, or user-facing editing features are requested by this review.

## Review result

**One P2, zero P1.** The implementation appears close to ready. Request a narrowly scoped fix and regression, then re-review the next GitHub Actions snapshot. This document does not authorize implementation changes, deployment or architectural expansion beyond the already approved specification.
