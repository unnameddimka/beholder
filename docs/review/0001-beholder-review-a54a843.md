# Beholder — Review of Specification 0001

**Reviewed source:** GitHub Actions `Repository snapshot`, run `41302527497`, artifact `13081932912`, commit `a54a843ace3bcb3bca7bd0a72f3bc0785f693004`.

**Verdict:** **Changes requested**, narrowly scoped to response-format detection and capability downgrade. The timestamp implementation and general recovery architecture are acceptable on inspection.

## Executive summary

1. **Architectural decisions:** No unapproved architectural replacement was found. The patch extends the existing Dialogue request builder and LLM transport, with browser-provided time zones and no SQLite schema migration.
2. **Behavioral changes:** Dialogue now accepts ordinary text without a repair call, isolates repair requests, progressively downgrades rejected provider format parameters, and passes persisted message times plus a request-time clock to every Dialogue mode.
3. **Objections / risks:** A leading `[` or backtick in valid RP prose is incorrectly classified as attempted JSON and sent to the repair LLM. Format downgrade can also send JSON-object mode to a model whose catalogue entry did not advertise that mode. See findings.
4. **Owner decisions required:** None. These are corrections within the approved Spec 0001. Do not change the interpretation/memory architecture or add configuration UI.

## Verification performed

- Downloaded and inspected the **GitHub Actions snapshot**, not a fresh checkout of `main`.
- `npm test`: **76 tests passed, 0 failed**.
- Syntax checks: **36/36 JavaScript files OK**.
- Runtime for this review: **Node.js 22.16.0**; the repository declares `>=24`. No Docker, Android browser, or live OpenRouter/DeepSeek execution in this review.

## Findings

### P1 — Ordinary bracketed RP prose is falsely classified as attempted JSON

**Location:** `src/llm.js:154–158`, invoked from `src/llm.js:126–148`.

`looksLikeAttemptedJson()` returns true for **every** reply starting with `[` or a backtick, regardless of whether a JSON object/array or a JSON fence actually follows. Example: `[laughs softly] You're impossible.` is ordinary nonempty RP dialogue rather than an envelope. Nevertheless it is routed to the repair LLM, not accepted as text with null optional fields. This reintroduces the exact unnecessary extra generation, possible content modification/duplication, and cost that R2 was intended to eliminate. Backtick-prefixed ordinary prose and prose mentioning a quoted envelope key can produce similar false positives.

**Required correction:** Distinguish an *actual attempt to represent the JSON envelope* from normal prose. A bare `[` or backtick should not suffice. Retain bounded repair for malformed objects, arrays, and actual JSON/code-fenced envelopes; preserve the existing truncation precedence. Avoid a broad rewrite of the output parser.

**Regression cases:** A bracketed action/plain RP response should be persisted verbatim with **one** Dialogue request, no repair, `followUpDelaySeconds: null`, `imageRequest: null` and a normalization diagnostic. Test malformed JSON arrays/fences separately to ensure they still route to validation/repair. The existing tests exercise `*action*` but not bracketed text.

*Confidence:* Directly established by the source predicate and branch conditions; not separately executed against a mocked provider in this review.

### P2 — Downgrade may request a mode not advertised by the selected model

**Location:** `src/llm.js:77–82` and `src/llm.js:99–105`.

The initial format mode is chosen from `supportedParameters`, but after any recognized rejection the implementation blindly steps from `json_schema` to `json_object`. It does not check whether the selected model advertises `response_format`. A model with `supportedParameters: ["structured_outputs"]`, but not `"response_format"`, can therefore receive a `json_object` request despite R1's explicit **“Do not request unsupported parameters.”** The original source's use of `require_parameters` can turn this into an additional unnecessary failed provider attempt.

**Required correction:** On downgrade, skip modes not supported by the available model capabilities; go directly to prompt-only when JSON-object support is not advertised. If a model has no trustworthy capability metadata, do not invent support. Keep the selected model unchanged, retain diagnostic reporting and bounded retries.

**Regression case:** A model advertises schema only, schema gets a format-related 400/404, and the *next* Dialogue call must be prompt-only; no JSON-object request is sent.

*Confidence:* Direct source analysis; the current downgrade test uses a model advertising both capabilities, so it does not cover this combination.

## Minor observation — invalid send time zone with another valid presence session

`src/dialogue.js:118` chooses `progress.timeZone || this.timeZoneFor(characterId)`. A send/retry with an invalid or omitted browser zone can consequently pick a different currently active session's valid time zone rather than UTC. Spec 0001 T2 explicitly calls for UTC when the browser's zone is unavailable/invalid, although reusing a current session's valid time zone is a reasonable interpretation for automatic messages. Recommend clarifying this behavior in a targeted test and keeping the explicit browser's zone authoritative for direct Send/Retry. This is not treated as a separate blocker in this review.

## Checks that passed / boundaries respected

- The main `darling` regression and isolation of malformed JSON repair are covered by mocked tests and code paths.
- A complete plain reply that is *not* incorrectly classified as JSON is accepted without another model call.
- Truncated provider outputs are retried before plain-text fallback.
- Valid envelopes still supply follow-up/image requests; failed repairs preserve Retry without duplicating user messages.
- Current time and the browser's IANA zone are passed in normal responses, Retry, follow-ups, and empty-chat openers.
- Each history message uses its persisted UTC instant and localized time. DST conversion and UTC fallback are tested.
- The pinned user self-description remains untimestamped; interpretation texts still do not enter Dialogue.

## Requested follow-up

Please fix the two findings above and add focused provider-mocked regression tests. Run the full suite under a supported Node.js version if available. No architecture changes, no new settings, and no modifications to contemplation or memory are necessary.

This review did **not** change the repository. It does not authorize any work outside Spec 0001.
