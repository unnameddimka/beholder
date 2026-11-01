# Beholder — Code Review of Specification 0000

**Snapshot:** GitHub Actions `Repository snapshot`, run `41266292188`, artifact `13067895175`, source commit `9adf254bf872e404be73a50fa2a28b78b426c6a0`.

**Verdict:** **Changes requested** before accepting Spec 0000. The implementation is a credible, substantial vertical slice, but two confirmed concurrency defects can violate the invariants on preserving newer edits and preventing stale LLM results from altering current state.

**Review approach:** Inspected the ZIP artifact, read the specification and affected implementation, ran `npm test` (`47/47` tests passed, 33 JavaScript syntax checks passed), and reproduced findings 1 and 2 using the project's mocked OpenRouter helpers. No live model calls or Docker/Android smoke test were performed. The locally available runtime was Node.js `22.16.0` rather than the project's declared Node.js 24 minimum.

## Required fixes

### P1-1 — Stale maintenance can delete a manually revised experiment (confirmed)

**Location:** `src/contemplation.js:275-315`, especially lines `282-283` and `310-312`.

Maintenance snapshots active experiment IDs before issuing asynchronous per-interpretation model calls. At commit time it checks that interpretations have not been edited, but it unconditionally deletes experiments named by the old LLM responses, even if the user has since changed the corresponding experiments. Furthermore, completion suggestions from superseded interpretation results are applied even when their interpretation action was skipped.

**Reproduction:** Create an interpretation and experiment `Original experiment`, start Force Maintenance using a delayed mocked response `{action:"unchanged",text:null,completedExperimentIds:["exp_1"]}`, edit that experiment to `MANUAL EDIT during maintenance`, release the response. **Observed:** `experiments(pool)` becomes empty; the user edit is lost. The existing tests do not cover this case.

**Fix:** Capture the experiment revision and/or per-item snapshot text at maintenance input creation. Apply a completion only if the target experiment is still the same revision/content examined by the LLM and the originating interpretation was not superseded. Keep the maintenance result batch atomic. Add a race regression test.

### P1-2 — Generation can commit a candidate reviewed against an outdated interpretation pool (confirmed)

**Location:** `src/contemplation.js:321-353`, especially the `interpretations` snapshot and final insertion.

The generation/review calls examine an interpretation pool snapshot but do not validate the pool revision before insertion. A concurrent manual interpretation edit may make the candidate a duplicate or inconsistent with the new pool; the old reviewer approval is still accepted.

**Reproduction:** Start Force Generation with an interpretation `Old theory`, delay the model response `NEW THEORY`, manually add interpretation `NEW THEORY`, then release generation and let its reviewer accept the original snapshot. **Observed:** `['Old theory', 'NEW THEORY', 'NEW THEORY']` — a duplicate interpretation was committed.

**Fix:** Capture `interpretationRevision` before generation and check it inside the insertion transaction. If it changed, perform a bounded re-review against the current pool (or safely discard and request a new generation). Add a concurrent-edit regression test. Revision checks should cover changes during retrieval, generation, and reviewer calls.

## Spec-level decision required

### SPEC-1 — Prefetch lacks the active experiments needed to detect completion

**Locations:** `docs/specs/0000-beholder-poc.md:90-104`, `AGENTS.md` (prefetch invariant), `src/contemplation.js:253-257`, `src/prompts/contemplation.js`.

The spec explicitly tells prefetch to set `maintenance=true` when an experiment appears to have produced a result, yet the only supplied context is the interpretations and chat messages; **the active experiment intentions are not sent**. Consequently the triage model cannot reliably know what earlier probes were intended to test. The implementation faithfully follows the *written* spec here; this is a specification gap, not an implementation-only bug.

**Proposal for owner approval:** Add the current active experiment intentions to the prefetch input while continuing to exclude STM/LTM. Update Spec 0000, `AGENTS.md`, the prefetch prompt and acceptance test together. Alternatively explicitly accept that experiment completion detection is heuristic and may be missed.

## Other findings

### P2-1 — Downloaded image byte limit is enforced only after buffering

**Location:** `src/images.js:100-107`, and `src/images.js:65-82`.

`downloadImage` trusts an optional `Content-Length` but calls `response.arrayBuffer()` before checking the actual size in `verifiedRaster`. A response without a reliable length can consume arbitrarily large memory before rejection. Also any HTTPS URL from the image provider is fetched, without a host/private-network restriction. The existing tests exercise format checks and non-HTTPS rejection but not streaming size enforcement or internal-network URL rejection.

**Fix:** Read the body as a bounded stream, stop at `IMAGE_MAX_BYTES`, and enforce a conservative URL/network destination policy for externally returned URLs. Preserve the supported temporary-URL workflow.

### P2-2 — Asynchronous route results can mount the wrong chat

**Location:** `public/app.js:126-146` and `248-251`.

`route()` performs several awaits without a navigation generation token. If the user navigates A → B quickly and A's fetch completes last, the stale A route can append A's view and assign `state.view` after B. Presence tracking may then point to A despite the browser URL being B. Navigation also reports presence only after the awaited route, so cancellation of an existing follow-up can be delayed.

**Fix:** Add a navigation epoch/cancellation guard before rendering results, and send navigation-away presence immediately rather than after the fetch chain. Test rapid switching with delayed API responses.

### P2-3 — Arbitrary active-experiment cap contradicts Spec 0000

**Location:** `src/prompts/contemplation.js:5-7,73-74` and `src/contemplation.js:68-71`.

The specification explicitly rejects an arbitrary concurrent experiment-count limit; the implementation hard caps the replacement experiment list at `50`. For a PoC, a reasonable request/output-size safety constraint is legitimate, but it should not silently become a semantic rule. Remove the count cap or get explicit product approval for a limit and update the spec.

## What is working well

- One application service, persistent SQLite and local image files, no key persistence; straightforward, dependency-free Node.js backend.
- Correct high-level separation: dialogue receives experiment intentions, not interpretation texts; contemplation runs independently of normal dialogue.
- 100/20/80 verbatim-to-STM batching; transactional commits with a failed-draft preservation path; per-pool LTM scheduling and semantic retrieval.
- Model-purpose routing, structured output validation and LLM repairs; bounded transport retries and useful diagnostic exchange records.
- Follow-up and opener timers are server-side, with presence/race protections and no automatic follow-up chaining.
- On-demand Emergency Dump and focused test coverage are unusually solid for an initial PoC.

## Recommended next steps for Claude

1. Fix **P1-1** and **P1-2** with deterministic mocked-provider race tests; re-run `npm test`.
2. Fix **P2-1** and **P2-2** with failure/race tests, keeping the solution small and within PoC scope.
3. Wait for an owner decision on **SPEC-1** and the experiment-count cap, then update the authoritative spec, prompts, and tests consistently.
4. Repeat the test suite on Node.js 24 and perform the documented Docker Compose + Android LAN smoke procedure; the current review cannot attest to either runtime environment.

No repository files were modified by this review.
