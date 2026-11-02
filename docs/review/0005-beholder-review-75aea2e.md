# Beholder — Spec 0005 Code Review

**Reviewed commit:** `75aea2e2d3009f383c4d00850165df37d4c62bc8`  
**Basis:** GitHub Actions source snapshot, run `41463076866`, artifact `repo-75aea2e2d3009f383c4d00850165df37d4c62bc8`  
**Disposition:** CHANGES REQUESTED — two P2 findings; no P1 findings.

## Executive summary for owner / Claude

1. **Architectural decisions:** No new architecture is proposed. The approved character-owned role configuration, three AI-facing descriptions, personal migration, manual Force controls and Ctrl+Enter are substantially implemented. Corrections should remain within Spec 0005.
2. **Behavior changes:** Existing behavior is largely aligned with the spec. Two issues remain: a reply with an attached image can mix two configuration snapshots across Vision and Dialogue; forced Generation/Experimentation do not expose an unambiguous completed/failed outcome after running.
3. **Objections and risks:** **P2-A:** Freeze the originating character profile **before** starting Vision, rather than only when Dialogue generation begins. **P2-B:** Preserve and expose the result of each Force kind, not just queued/running state and a generic last error. Regression tests required. A real-device mobile keyboard check and Node.js >=24 test run remain separate acceptance work.
4. **Owner decisions required:** **None.** Both fixes are covered by the approved specification. Do not change architecture, invent a new scheduling mechanism or expose manual editing of cognitive text.

## Review scope and evidence

- Reviewed implementation commit `75aea2e` against Spec 0005 from the exact GitHub Actions source snapshot.
- Reported local test run: **150/150 passing** on **Node.js 22**. Project minimum is **Node.js >=24**. Actions success confirms snapshot creation, not an independent CI test run.
- Character-owned model selection, role settings, descriptions, migration, prompt composition, Force UI and Ctrl+Enter were examined. The findings below are implementation-specific and do not question the owner's approved design.

## P2-A — Vision and Dialogue can use different snapshots for one submitted message

**Location:** `src/dialogue.js`, `startReply()` and `generate()` (around lines 146–173).

**Observed sequence:** `startReply()` creates `pending`, starts `perceive(characterId, userMessageId, pending)`, then calls `generate(characterId, "reply", pending)`. `generate()` reads `profileOf(this.store.getCharacter(characterId))` and assigns `progress.profile` **after** Vision completes. As a result, the initial Vision operation and the later Dialogue/retrieval stage are not guaranteed to use the same character configuration and three descriptions.

**Reproduction:** Submit a user message with an attached image. Hold Vision in flight. Edit the character's Dialogue model, Scene or User Description and save. Release Vision. Dialogue obtains the new profile in `generate()`, although this is still processing the original logical reply job. Thus an existing job can switch configuration mid-flight, contrary to **Spec 0005 A5 / acceptance criterion 12**.

**Required correction:** Capture the character's complete immutable profile **at the start of the logical reply job**, before `perceive()`, and pass that same profile through Vision, Dialogue memory retrieval, Dialogue generation and model format-repair/retry steps; use the same snapshot for any image request queued by that reply. Preserve owner-based routing and the current character's pending/recovery semantics. Ensure Retry is treated as a newly started job (and takes a new snapshot), but a single Retry attempt likewise cannot change its profile mid-flight.

**Regression tests:** Hold an image perception request; modify model/Scene/User Description while it is pending; assert both the Vision provider call and the subsequent Dialogue provider call use the original snapshot, and that a later newly started message uses the edited values. Include concurrent characters to ensure no leakage.

## P2-B — Force Generation / Force Experimentation lack an explicit terminal result

**Location:** `src/contemplation.js`, forced branch of `loop()` (around lines 253–272), with the corresponding Contemplation status endpoint/UI.

**Observed behavior:** The forced queue carries the kind and the runtime exposes queued/running information. Once a forced Generation or Experimentation finishes (or fails), the forced operation is cleared and a general `lastError` may be set, but no unambiguous **per-kind last outcome** is retained for the UI. The user cannot reliably tell whether their just-clicked operation completed successfully or failed. Maintenance already has a richer status mechanism and need not be redesigned.

**Spec reference:** **Spec 0005 F2** explicitly requires surfacing `queued`, `running`, `completed` and `failed` without treating queue acceptance as completion. **F3** separately requires persisted last-Maintenance attempts.

**Required correction:** Expose terminal completion/failure for **each** Force kind, associated with its character, with operation time and a safe error reason on failure. Use the existing queue/state/status plumbing rather than a second scheduler or user-editable cognition. Avoid confusing a previous run's success with the currently queued one or mixing statuses across characters. Preserve the existing Maintenance history/interrupt semantics.

**Regression tests:** Force Generation and Force Experimentation separately in successful and failing cases; assert visible/returned queued → running → completed/failed transitions and correct per-character isolation. Ensure error and repeated-click deduplication work and maintenance status is not regressed.

## Remaining validation / acceptance

- Run the complete suite on **Node.js >=24** (tests on Node.js 22 are informative but not sufficient for the declared engine).
- Owner to verify the existing mobile composer on a physical phone with its software keyboard open.
- Re-review both P2 fixes using the **new GitHub Actions source snapshot** after the implementation commit.

## Conclusion

**No P1; two P2 requiring narrow corrections and regressions.** The patch is close to completion, but do not declare Spec 0005 fully accepted until the above issues are addressed and outstanding environment/device checks are reported. This is a review document only; no implementation is authorized by adding it.
