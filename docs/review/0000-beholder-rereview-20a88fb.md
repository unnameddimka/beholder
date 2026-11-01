# Beholder — Follow-up review of Spec 0000 fixes

**Snapshot:** GitHub Actions `Repository snapshot`, run `41269882355`, artifact `13068812351`, commit `20a88fb327f4d1ad587f06e5e671466d6e39f431`.

**Verdict:** **Implementation findings accepted, with one approved spec correction required before closing review 0000.** The five previously reported implementation findings have been addressed in the examined code. No new blocking code defect was found in this focused re-review.

## Verification

- `npm test` on the snapshot: **54 passed, 0 failed**, including seven new regression cases. The local reviewer runtime was Node.js `22.16.0`, whereas this project declares Node.js `>=24`; a Node.js 24 run remains a follow-up check.
- **P1-1 — stale maintenance:** experiment completions are applied only when backed by non-superseded interpretation results and unchanged experiment text.
- **P1-2 — stale generation:** interpretation pool revision is verified at commit; changed pool prompts bounded re-review.
- **P2-1 — image downloads:** byte-bounded streaming, no redirects, and initial internal/private URL rejection. DNS rebinding between initial hostname validation and download remains a documented residual limitation.
- **P2-2 — navigation:** route epochs, detached view roots and immediate navigate-away presence prevent stale fetches from mounting an outdated chat. A real-browser navigation test is still appropriate.
- **P2-3 — experiment count:** the arbitrary 50-experiment limit is gone.

## SPEC-1 — Owner decision: APPROVED

**The project owner explicitly approved providing the currently active experiment intentions to prefetch on 2026-11-01, after this re-review.** The previous exclusion was **not** an owner decision. The explanation claiming otherwise in the current specification and README must be corrected.

### Required behavior

On each user message, the Contemplation model's prefetch input must include **all three** of the following, from the relevant interpretation pool and triggering chat:

1. The **entire current interpretation pool**.
2. Up to the **last 100 verbatim chat messages** for the triggering chat.
3. The **current active experiment intentions** for that interpretation pool (an empty list if none).

**Do not supply STM, LTM or other consolidated memories to prefetch.** Prefetch still returns the independent `generation` and `maintenance` Booleans. It should be able to select `maintenance: true` when an observation plausibly completes or materially advances an active experiment, in addition to the existing interpretation-change trigger. Nothing about experiment completion becomes automatic or deterministic; prefetch is still an LLM judgment, but it must see the intent it is evaluating.

The dialogue model must **still not receive interpretation texts**; dialogue receives only active experiment intentions. All other phase ordering, scheduling and queue invariants are unchanged.

### Implementation instructions for Claude

1. Update the authoritative `docs/specs/0000-beholder-poc.md` sections 5.1 and acceptance scenario 7, explicitly specifying the three prefetch inputs above. Delete the erroneous “owner decision” clarification about excluding experiments.
2. Update `AGENTS.md`'s exact prefetch invariant accordingly.
3. Update the prefetch context assembly in `src/contemplation.js` and its prompt in `src/prompts/contemplation.js` to actually pass and use active experiments.
4. Update `README.md` to remove the incorrect owner-approval statement and document the new behavior.
5. Add mocked-provider regression tests asserting (a) prefetch sees the experiment intentions and (b) it still receives no consolidated memory. Include a test where the model chooses maintenance based on an experiment referenced by the latest dialogue, and ensure empty arrays are supported.
6. Run `npm test` and, if feasible, validate on Node.js 24.

Keep this change minimal. Do **not** introduce a broader experiment-tracking subsystem, interpretation leakage into dialogue, additional screens, or new model requests.

## Remaining end-to-end checks (not blockers to this focused code review)

- Docker Compose deployment with the project's Node.js 24 environment.
- Android/LAN browser smoke test, including rapid character changes and follow-up cancellation.
- Real OpenRouter behavior and image-model integration. Passing mocked-provider tests establishes structure and invariants, not generation quality.

Once SPEC-1 is implemented and its tests pass, **review 0000 can be closed** without further architectural changes.
