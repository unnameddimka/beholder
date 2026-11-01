# Beholder — Spec 0001 Re-review of Review Fixes

**Snapshot:** GitHub Actions `Repository snapshot`, run `41304308578`, artifact `13082446342`, commit `da43988ec0138ee029f496bd97c61e5a240dd215`.

**Verdict:** **Prior review findings resolved; one new P2 format-classification defect remains. Changes requested before accepting Spec 0001.**

## Executive summary

1. **Architectural decisions:** None. The change stays inside the approved Dialogue response-format/time-awareness design. No unapproved changes to contemplation, memory or persistence were found in this focused review.
2. **User-visible behavior:** Ordinary bracketed/backtick-led roleplay prose no longer triggers a repair LLM call; rejected JSON Schema correctly skips unsupported JSON-object mode; direct Send/Retry uses its own browser time zone, falling back to UTC when invalid.
3. **Objections / risks:** An obviously structured *unbraced envelope fragment* is now treated as plain RP text, and the user sees raw fields such as `"message"` and `"followUpDelaySeconds"`. This violates Spec 0001 R3. See the reproducible finding below.
4. **Owner decisions required:** None. The remaining change is a local technical correction. Do not broaden scope.

## Verification

- Source was the successful GitHub Actions snapshot above, not a live checkout.
- `npm test`: **80 passed, 0 failed** (up from 76); JavaScript syntax checks passed.
- Local Node.js runtime: **22.16.0**, below the project's declared Node.js 24 minimum. No Docker, browser-device or real OpenRouter execution in this review.
- Reviewed the diff against snapshot `a54a843` and executed an extra mocked-OpenRouter reproduction for the remaining issue.

## Previously reported findings — resolved

- **P1 — overbroad attempted-JSON detection:** `[laughs softly] You're impossible.` and backtick-led ordinary RP text now use plain-text fallback, with no additional repair request; regression test added.
- **P2 — unsupported downgrade:** a schema-only catalogue entry now goes directly from rejected `json_schema` to `prompt` mode, preserving the selected model; regression test added.
- **Minor — direct Send/Retry time-zone selection:** invalid or missing browser zone now explicitly falls back to UTC instead of silently borrowing another browser session's zone; regression test added.

## New finding — P2: Unbraced dialogue envelope fragments are incorrectly displayed as RP prose

**Location:** `src/llm.js:163–166` (`looksLikeAttemptedJson`), called at `src/llm.js:132–139`.

**Spec requirement:** R3 (`2, lines 58–68) says a response *evidently intended to be structured JSON* but invalid must enter bounded, context-isolated repair, not the plain-text fallback.

**Reproduction:** Set the mocked `dialogue_reply` response to:

```text
"message": "Hello there", "followUpDelaySeconds": null, "imageRequest": null
```

It is a clearly recognizable fragment of the exact required three-field envelope, merely lacking the surrounding `{}`. Because the predicate only detects a leading `{`, particular JSON-array prefixes, an actual fenced JSON value, or a *braced* field name, it returns `false` for this input. The Dialogue path then accepts the entire fragment as the character's spoken text.

**Observed on the snapshot with the project's mocked-provider helper:**

- `dialogue_reply` calls: **1**.
- Committed character text: **`"message": "Hello there", "followUpDelaySeconds": null, "imageRequest": null`**.
- `dialogue-plain-text-normalized` events: **1**.
- `llm-repair` events: **0**.

A ` ```json ` fenced fragment lacking braces is misclassified similarly. This is not an argument for reverting to the original overly broad predicate: normal speech quoting the word `"message"` should continue to be accepted as RP text.

**Suggested correction:** Recognize envelope-shaped fragments at the start of the response, for example an initial quoted `"message"` key followed by a colon, preferably with supporting envelope structure, and true JSON-fenced fragments. Do **not** classify arbitrary prose containing a quoted field name or bracketed actions as structured. Preserve all existing truncation and validation safeguards.

**Regression tests:**

1. The three-field unbraced fragment enters an isolated repair invocation; it is not committed verbatim as RP speech.
2. A malformed JSON-fenced fragment without an opening brace enters repair.
3. The existing bracketed-action, backtick prose and quoted-field-name RP tests remain green.
4. Full `npm test` passes.

## Recommendation

Fix the small classification gap and rerun regression tests. No architectural decisions, additional subsystem or specification change is needed. **Spec 0001 can be accepted after that**, subject to the standing caveat that mocked tests are not a live-provider smoke test.

**Repository was not modified by this review.**
