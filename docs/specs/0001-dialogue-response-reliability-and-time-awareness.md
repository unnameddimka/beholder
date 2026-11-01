# Specification 0001 — Dialogue Response Reliability and Time Awareness

**Project:** Beholder
**Status:** Specification prepared for owner review. This document does not, by itself, authorize implementation.
**Target:** Next patch after review 0000
**Scope:** Dialogue response format recovery and temporal context for the Dialogue model
**Baseline:** Spec 0000; repository main after commit 6ee2cf37128de60929aa8f6a9c2876467e5fc582

## 0. Executive summary

1. **Architectural decisions:** Keep the existing single-server, SQLite, memory, contemplation, experiment, image and follow-up architecture. Adjust only the Dialogue response-handling path and the Dialogue prompt/context builder. Reuse existing persisted message timestamps; obtain the user's current time zone from the browser. Do not add a new subsystem.
2. **User-visible behavior:** When a model such as DeepSeek responds with ordinary RP text rather than the requested JSON envelope, the reply appears as written instead of being rewritten or duplicated during repair. Characters are aware of the dates/times of conversation messages and the current local date/time when responding, including autonomous messages.
3. **Objections and risks:** An ordinary RP reply must be distinguished from malformed or truncated JSON. Provider capabilities may vary. Incorrect time-zone assumptions would be worse than an explicit UTC fallback. Existing fixes already committed to main have not been accepted as the implementation of this specification merely because they exist.
4. **Owner decisions required:** None to define these two changes. Implementation and any further scope additions still require explicit owner authorization.

This specification covers **two agreed changes**, not a general rewrite of conversation behavior. Do not infer authorization for other future-patch ideas.

## 1. Context and observed failure

Dialogue responses use the established envelope with exactly three fields:

- **message:** nonempty character reply text, including RP actions surrounded by single asterisks.
- **followUpDelaySeconds:** integer seconds or null.
- **imageRequest:** image prompt string or null.

Selected models sometimes ignore the format instructions and return normal roleplay prose. In the reported incident, an existing repair request reintroduced a previous “darling” message and duplicated it in the visible reply. The original plain-text response was usable; the duplication was created by recovery.

Separately, the database already records message timestamps, and the browser displays them. However, the Dialogue model currently receives the messages as role + text without individual timestamps, and does not receive an explicit current clock/time zone. Thus, it cannot reliably distinguish a short pause from an overnight or multi-day absence.

## 2. Requirements — response reliability

### R1. Provider-supported structured output

- For each Dialogue request (normal reply, follow-up or opener), request **strict JSON Schema** with the existing three-field envelope if the selected OpenRouter model/provider actually supports it.
- Otherwise request **JSON-object mode** if supported.
- When neither is supported, retain prompt-level format instructions and local validation, but do not send unsupported parameters.
- Do not silently switch the user-selected model or route the request to an incompatible provider to satisfy formatting.
- Keep the existing Dialogue system-prompt instructions and the same locally validated response contract.
- Provider-support detection must be honest about what is known: avoid treating a model-catalogue hint as proof that every provider endpoint supports a parameter. A formatting-parameter rejection should be handled as a controlled error or compatible downgrade, without unwanted model changes.
- Existing diagnostics must capture the chosen formatting mode and provider-level failures without exposing the OpenRouter key.

This is a provider-preference and validation improvement, not a requirement that all DeepSeek endpoints always return JSON.

### R2. Lossless plain-text fallback (Dialogue only)

If the **original non-truncated** Dialogue response is nonempty ordinary roleplay prose rather than an attempted JSON envelope:

- Accept that text directly as **message**, retaining its meaning, actions, line breaks and ordering.
- Set **followUpDelaySeconds = null** and **imageRequest = null**.
- Do not make another LLM request to reformat it.
- Emit a diagnostic event describing the plain-text normalization.
- Do not insert, paraphrase, prepend or repeat previous dialogue turns.

The fallback applies only to Dialogue purposes. Contemplation, memory, selection and other structured purposes retain strict validation and existing repair rules.

A legitimate plain-text RP reply is not considered a provider failure simply because it lacks JSON. This fallback sacrifices autonomous follow-up and image-request metadata for that one reply; do not invent these fields from prose.

### R3. Malformed structured responses

If the original response is evidently **intended to be structured JSON** but parsing/validation fails:

- Use the existing bounded repair mechanism.
- The repair invocation receives **only** the invalid response, the required output contract and relevant validation errors. It must **not** receive the preceding chat transcript, pinned self-description, retrieved memories, experiment intentions or the previous Dialogue prompt.
- Instruct the repair model to preserve the response content and not invent new speech, actions or previous turns.
- Validate every repair result locally against the same envelope. Do not commit malformed responses or partial repairs.
- Keep the existing attempt limits and user-visible Retry behavior when repair cannot produce a valid result.

The implementation must explicitly distinguish ordinary prose from attempted JSON rather than routing all invalid text through repair. A response that is actually truncated or incomplete must not be mistaken for ordinary RP prose.

### R4. Failure and success behavior

- Empty outputs remain errors.
- Outputs marked as **truncated** by the provider follow the existing truncation-recovery path **before** consideration of plain-text fallback.
- Valid structured responses retain all existing behavior: message text, image generation, follow-up delay selection, mode-specific rules, concurrency guards and persistence.
- If recovery ultimately fails, leave the user's single committed message unanswered and enable the existing **Retry answer** path. Never duplicate the user's message or commit a broken character reply.
- Preserve diagnostics, including original and repair exchanges, under the existing key-redaction rules.

## 3. Requirements — temporal context for Dialogue

### T1. Message timestamp context

- Include the **persisted creation timestamp of every verbatim message supplied to Dialogue** (the current history window), in original chronological order.
- Preserve exact speaker roles and message text. Timestamps are metadata for model context, **not** new transcript messages, changes to the visible text, or content attributed to either speaker.
- The pinned user self-description is not a real timestamped chat event and must not be presented as one.
- Existing image-continuity notes stay associated with their source assistant message.
- No new message-table columns or backfill are needed: reuse the stored timestamp values.

Prefer an unambiguous representation using the persisted instant (e.g. ISO 8601 UTC), with the equivalent user-local time clearly labeled when a time zone is known. A repeated unambiguous timestamp marker per message is sufficient. Do not allow timestamp annotations to be confused with user-authored RP speech.

### T2. Current time and user time zone

- On **every** Dialogue model invocation, provide a current timestamp and the user's **local date/time and time zone**. This covers normal answers, retries, autonomous follow-ups and the first opener message.
- Use the **browser/device time zone**, not the Docker server's locale. The browser should provide a validated IANA time-zone identifier (for example, Europe/Kyiv), through the smallest suitable extension of existing chat/presence request data. The Node.js server determines the current instant from its own clock and formats it in that time zone.
- For autonomously generated messages, reuse the time zone of a currently active connected browser session for that chat. If more than one active session exists, choose one deterministically (for example, the most recently active).
- If the browser's time zone is absent, invalid or unavailable (including after restart), use **UTC and explicitly label it UTC**; do not quietly assume the server's local time zone or claim a guessed user location.
- Compute “now” when assembling the **actual Dialogue request**, not from the time of the last user message or a stale browser wall-clock value.
- Time-zone changes and daylight-saving transitions must be represented correctly by formatting each stored instant in the chosen zone; a fixed offset should not be assumed for all historical messages.
- This is **request-time awareness**, not an always-running clock or independent agency between model calls.

No time-zone settings screen, geolocation permission, IP-based inference, persistence of a user profile preference, or additional LLM call is required.

### T3. Roleplay semantics

- The Dialogue prompt should identify time data as reliable **message metadata and current clock context**, not as instructions from the user or a new conversational turn.
- The character may naturally acknowledge elapsed time, time of day, days passed, or a previously stated future plan when relevant.
- The character is **not required** to announce the date, mention inactivity, apologize for the passage of time, or change personality.
- Leave current scheduling unchanged: idle timers, presence, typing cancellation, image generation and non-chaining follow-ups all operate as in Spec 0000.
- Do **not** expose interpretations to Dialogue. Existing active-experiment intentions and memory retrieval remain unchanged.
- No modifications to Contemplation prefetch, experiment planning, STM/LTM architecture or their respective input contracts.

## 4. Integration boundaries

Relevant existing areas to inspect (paths are implementation guidance, not permission for wholesale refactoring):

- **src/llm.js**, **src/openrouter.js**: Dialogue response-format selection, plain-text fallback, malformed JSON repair, truncation precedence, diagnostics.
- **src/prompts/dialogue.js**: Dialogue prompt and history rendering; keep all non-time-related roleplay constraints.
- **src/dialogue.js**: Assemble the Dialogue request with current-clock context and the correct user time zone.
- **public/app.js**, **src/server.js**: Minimal browser-to-server time-zone propagation, including active-chat presence for follow-ups.
- **src/db.js**: Source of the existing persisted message timestamp; **do not change schema without a concrete necessity**.
- **tests/**: Provider-mocked format and temporal-context regression scenarios.

Some response-format changes were already committed to main before this specification. Treat them as an **unverified candidate implementation**: compare each behavior with these requirements, retain conforming parts, fix deviations, and only then claim the change complete. Do not replace working code merely because it was written before this spec.

No changes to character-persona semantics, interpretation or experiment state, memory retrieval architecture, model-selection policy, global configuration UI, image generation implementation, or user data format.

## 5. Acceptance scenarios

### Response formatting

1. **Original “darling” regression:** reproduce a prior-character-reply context followed by a plain-text model reply. The visible new answer must not contain the preceding “darling” message because of repair.
2. **Plain RP text:** the provider returns an ordinary nonempty text answer with asterisks and multiple lines. **Exactly one** Dialogue LLM request occurs; the displayed/persisted answer preserves the original RP content and line breaks, and both optional envelope fields are null. A normalization diagnostic is present.
3. **Malformed JSON:** an attempted JSON envelope is invalid. The repair request contains the original invalid response, schema/format contract and validation errors **but no historical chat messages, pinned description, memories or experiments**.
4. **Truncated output:** when the provider marks an output truncated, the existing truncation recovery runs instead of accepting it as plain-text prose.
5. **Valid envelope:** all three fields continue to work; valid image requests and follow-up scheduling remain available.
6. **Capability routing:** provider-enforced schema mode is sent only where supported; JSON-object mode and prompt-only fallback are selected where applicable, without silently switching the selected model or accepting unsupported provider parameters.
7. **Exhausted repair:** the single user message remains stored, there is no broken assistant message, and Retry can respond without re-inserting the user message.
8. **Isolation:** fallback changes affect Dialogue only; other structured purposes preserve their existing validation and repair behavior.

### Time awareness

9. **Message metadata:** two messages separated by more than a day are supplied with their **distinct original timestamps**, in the correct order. Neither message text nor roles change.
10. **Clock in all modes:** normal reply, manual retry, timed follow-up and empty-chat opener each receive the then-current time and selected user time zone. A later autonomous follow-up uses its **own generation-time clock**, not the preceding answer's clock.
11. **User versus server zone:** with a browser reporting Europe/Kyiv and a server running in UTC, the Dialogue context shows the same instant in Kyiv local time, with a clear zone label; it is not mistaken for UTC local time.
12. **DST and elapsed time:** messages around a daylight-saving transition are represented by consistent absolute timestamps and correctly localized times; elapsed-time reasoning is not based solely on subtracting local clock labels.
13. **Unavailable/invalid zone:** the Dialogue context explicitly falls back to UTC with no guessed user locale; generation still succeeds.
14. **Existing invariants:** the pinned self-description is not a timestamped event; only the Dialogue model receives the new per-message timestamps/current-time annotation; no interpretation text leaks into Dialogue.
15. **No regressions:** the complete existing test suite passes, including contemplation, memory, concurrency, follow-up, image, and format tests.

Use mocked OpenRouter where applicable. A real-model smoke test with DeepSeek is desirable but **not** an acceptance prerequisite because provider behavior may vary by route and time.

## 6. Completion and review deliverables

- Keep the patch narrow and preserve approved Spec 0000 behavior.
- Add deterministic regression tests for the behavior described above.
- Run the complete project test suite with the project's supported Node.js version where available.
- Update README only to describe implemented and verified behavior.
- Report which existing committed response-format changes were reused, corrected or rejected.
- Give the reviewer the source commit and GitHub Actions snapshot artifact for assessment.
- Do not implement this specification until the project owner explicitly authorizes the implementation stage.
