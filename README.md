# Beholder — local AI roleplay companion (PoC, Specification 0000)

Beholder is a local, single-user roleplay chat. Each character has its own chat. Behind every chat, an independent
**Contemplation** process keeps free-form *interpretations* of the user, synthesizes them into one evolving
*gestalt* (a tentative impression of the user as one whole, ultimately unknown person), and turns them into
*experiments* (intentions to learn more). The dialogue model receives the gestalt and the experiment intentions, never
the interpretations themselves. You can attach an image to a message: a separate **Vision** model perceives it in the
context of the chat, and the character reacts to that observation.

Full requirements: [docs/specs/0000-beholder-poc.md](docs/specs/0000-beholder-poc.md), amended by
[0001](docs/specs/0001-dialogue-response-reliability-and-time-awareness.md),
[0002](docs/specs/0002-gestaltization-readonly-contemplation-baidu.md), and
[0003](docs/specs/0003-contextual-vision-image-observations.md).

> **Trusted LAN only.** Plain HTTP, no authentication, no HTTPS. Never expose the port to the internet.

## Start

With Docker Compose (one service; `./data` on the host is mounted at `/app/data`):

```sh
docker compose up -d --build          # http://<host>:3000
BEHOLDER_PORT=8080 docker compose up -d --build   # another host port
SOURCE_COMMIT_SHA=$(git rev-parse HEAD) docker compose build   # optional: commit id shown in Emergency Dumps
```

Without Docker (Node.js 24 or newer, no npm dependencies):

```sh
node src/server.js                    # PORT, HOST, BEHOLDER_DATA_DIR are optional environment variables
```

SQLite (`data/beholder.sqlite`), generated images (`data/images/`), and images you attach
(`data/uploaded-images/`, the original files) survive container recreation. Back up the whole `data` directory.

## First use

1. Open `http://<host>:3000` from a desktop or Android browser on the LAN.
2. **Enter the OpenRouter API key.** The server keeps it only in memory. It is never written to disk, SQLite, the
   browser, logs, or dumps. After a server restart you enter it again.
3. **Settings** (gear icon): pick the **Dialogue**, **Contemplation**, **Vision**, and **Image** models. The text fields
   suggest models from OpenRouter's catalogue; Vision suggests exactly Google Gemini 3 Flash Preview (the default),
   Qwen3-VL-235B-A22B Instruct, and Google Gemini 3.1 Flash Lite. Every field also accepts a typed model id. Optionally
   enable a temperature override and set the maximum output tokens (defaults: 8,192 for Dialogue, 16,384 for
   Contemplation, 4,096 for Vision). Image generation is off by default; it does not affect attaching your own images.
   Contemplation is on by default. Save.
4. On the home page, optionally fill in **About you**. It is pinned as the first user message for every character.
5. **Add Character**: a display name, an AI-facing description, and the two scope flags:
   - *Use shared memory*: reads and writes the shared memory pool instead of the character's private pool.
   - *Use shared interpretations*: reads and writes the shared interpretation and experiment pool.

   Changing a flag later only switches which pool is active. Nothing is merged, copied, or deleted.

## Testing Contemplation by hand

1. Create a character and chat for a few messages. After each user message the header shows activity, and the
   Contemplation model runs a cheap prefetch. It sees the interpretations, the last 100 messages and the active
   experiments (never consolidated memory), and requests maintenance when an interpretation needs revisiting or an
   experiment appears to have produced a result.
   When the prefetch sees a genuinely new angle, generation adds an interpretation.
2. Open **Contemplation** (from the chat header). The page is read-only. It shows the gestalt (with "Not formed yet" or
   "Update pending" when that applies), the interpretations, the active experiments, the current stage, the number of
   parallel maintenance requests, queued work, the last cycle's flags, and errors. It has no edit or Force controls.
3. Every interpretation change leads to one gestalt update and then one experiment review, so the gestalt and active
   experiments appear shortly after the first interpretation.
4. Keep chatting. The dialogue model receives the gestalt as its own tentative impression of the user and the active
   experiments as private, optional intentions.
5. To compare behavior, untick **Enable Contemplation** in Settings. Automatic contemplation (including gestalt
   updates) stops, and neither the gestalt nor the experiments are sent to dialogue. Stored state stays visible.

## Attaching an image

Use **Attach Image** (left of the message field) to pick one PNG, JPEG, or WebP file of at most 10 MiB. A preview
appears above the field; **Remove** takes it off again. Send it with or without text. The chat shows the image in
your message with a small note: "Viewing..." while the Vision model looks at it, then a collapsed **What <name> saw**
with the observation, or "Could not be viewed". The character's reply waits for the observation. If Vision fails, the
reply knows only that an image could not be viewed and never pretends to have seen it.

**Emergency Dump** (the red **Dump** button, always in the header) downloads a sanitized ZIP of state and diagnostics.
It works while the server is busy and never changes state.

## Checks and tests

```sh
npm test        # node --check on every .js file, then node --test with a mocked OpenRouter (no paid calls)
```

The tests cover the acceptance scenarios that can be automated: key secrecy across restarts, dumps, and data files;
scope flags; context assembly (pinned self-description, gestalt and experiments in, interpretations out); envelope
repair; Retry
without duplication; the 100/20/80 Verbatim→STM threshold and failure safety; daily STM→LTM catch-up without double
consolidation; prefetch inputs; both-flags ordering with concurrent maintenance; coalescing; stale-result protection;
follow-up timers and races; asynchronous images; bounded retries; HTTP safety; the spec 0001 scenarios (plain-text
fallback, isolated repair, truncation precedence, format step-down, message timestamps, clock in every mode, time zones,
DST, and the UTC fallback); and the spec 0002 scenarios (schema migration and initial synthesis, gestalt inputs and
prompt semantics, empty pools, one synthesis per cycle, stale-result protection, failure and restart recovery, the
disabled state, the gestalt in every Dialogue mode and scope, the read-only page, and the Baidu exclusion on every text
request); and the spec 0003 scenarios (settings and schema migration, the exact Vision inputs, perception before the
reply, typed observations in Dialogue, Contemplation and STM, the failure fallback, incompatible models and oversized
context, Retry and restart without duplicates, upload validation and serving, file reconciliation, the STM batch
boundary, and no image data in diagnostics or dumps). Whether a live model writes a good gestalt or an accurate,
non-interpretive observation is a manual judgment, not something the tests can certify.

### Manual smoke procedure (Android / LAN)

1. Start with Compose and open `http://<lan-ip>:3000` in Chrome on Android. Enter the key.
2. Create two characters with different flag combinations. Send a message containing `*waves*`: it shows in italics
   without asterisks. While the reply is pending, keep typing: Send and Enter stay disabled, and the draft is kept.
3. Open an empty chat and wait 60 s without typing: one opener arrives. Start typing in another case: nothing arrives.
4. Enable images, then ask a character to show you something: the text appears first, the picture later.
5. Restart the container (`docker compose restart`): the key is required again, and chats and images are still there.
6. Download an Emergency Dump while a reply is pending, then search it for your key: it is not there.
7. Attach a real selfie with the text "Вот моё селфи": the reply arrives after the observation, and **What <name> saw**
   describes only what is visible (no identity, personality, or intentions).

## Implementation choices (simple defaults, per spec section 12)

- **Stack:** Node.js 24, plain `node:http`, built-in `node:sqlite` (`DatabaseSync`, WAL), vanilla JS frontend. No npm
  dependencies.
- **Model selection:** curated defaults from Society's model list plus the live OpenRouter catalogue as suggestions.
  Any model id is accepted. The temperature override is sent only when enabled, and is left out when the catalogue
  lists the model without `temperature` (an uncatalogued model receives it). `max_tokens` is clamped to the
  catalogue's maximum completion tokens. No reasoning controls are sent, so reasoning tokens count against
  `max_tokens`. A truncated output gets one compact retry.
- **Transport reliability:** 3 attempts per request for timeouts, network errors, 429 (honoring `Retry-After`, capped at
  30 s), 5xx, and empty or provider-error completions, with exponential backoff. 401 is never retried. The model is
  never switched. Every text request asks OpenRouter to ignore the providers `alibaba`, `Phala`, `SiliconFlow`,
  `GMICloud`, and `baidu` (spec 0002), while still allowing fallback among the others. Image requests are unchanged.
- **Structured output:** every structured purpose is parsed and validated. Invalid output gets up to 2 LLM repairs and
  is never committed. Dialogue replies, follow-ups, and openers differ in three ways (spec 0001):
  - OpenRouter receives a strict JSON schema when the catalogue lists `structured_outputs` for the Dialogue model, or
    JSON-object mode when it lists only `response_format`. Such requests set `require_parameters`, so only providers
    that honor the format are used. If the model is uncatalogued or the catalogue is unavailable, the format is
    enforced by the prompt alone. If OpenRouter rejects the format because no endpoint supports it, the request steps
    down to the next mode the catalogue lists for the model (JSON object only if `response_format` is listed,
    otherwise straight to prompt-only) and is retried with the same model. The step is remembered for that model
    until restart. The chosen mode and every step are recorded in diagnostics.
  - A non-empty plain-text answer is accepted as the message as written, with no follow-up or image request, and costs
    no extra model call. A diagnostic event records it. This applies only to a complete answer generated from the full
    context (including the retry after a truncated output), never to a repair answer. Only an actual attempt at the
    envelope goes to repair: a code fence tagged `json`, or text (after any opening fence) starting with `{`, with `[`
    followed by `{`, `[`, `"`, or `]`, with a `"message"` key and a string value, or with a `"followUpDelaySeconds"`
    or `"imageRequest"` key, or containing an object literal with an envelope field. Prose such as
    `[laughs softly] ...` or a sentence that quotes a field name is accepted as written.
  - A repair request contains only the invalid output, the validation errors, and the format instructions, never the
    chat transcript, self-description, memories, or experiments.
- **Time awareness (spec 0001):** every Dialogue request (reply, Retry, follow-up, opener) states the current time,
  taken when the request is assembled, and the user's time zone. Each history message starts with a
  `[sent <UTC instant> | <local time>]` marker built from its stored timestamp. The pinned self-description has none.
  The time zone is the browser's IANA zone, sent with presence, Send, and Retry. A Send or Retry uses only its own
  browser's zone. Follow-ups and openers use the most recently active session in that chat. Each instant is localized
  with its own offset, so DST is correct. The time since the latest message, and its gap to the one before, are
  computed from instants. Without a valid browser zone, all times are labeled UTC and the prompt says the zone is
  unknown; the server's own time zone is never used. A marker that the model copies to the start of its reply is
  removed before commit and logged. Only Dialogue requests carry time data.
- **Memory retrieval:** Society's semantic selector runs before every dialogue reply when the memory pool is not empty
  (Dialogue model; limits: 12 STM, 8 LTM). Contemplation runs it with the Contemplation model. Divergence from
  Society: if the selector fails after retries, Beholder falls back to importance ranking (recorded in diagnostics)
  rather than failing the reply.
- **Memory port:** topic, summary, retrievalBrief, importance, selective retention, strict citation validation,
  repartition rules, LTM selector + writer with exhaustive retirement groups, and size partitioning are ported. Society's
  fictional-calendar temporal anchors, protected records, and old-LTM reconsolidation are not. Records keep real
  source timestamps (period) and conversation attribution (character name and message ids) instead. Records are written
  in neutral third person so they work in shared pools.
- **Verbatim→STM:** triggered when a chat has 100 active messages. The 20 oldest are consumed and the other 80 are
  read-only context. Writable STM is limited to records from the same chat in the same pool, so another character's
  conversation is never rewritten. On failure, the sources stay active and an automatic retry waits 5 minutes (the
  next qualifying message after that retries).
- **STM→LTM:** checked at startup, every minute, and at local midnight. Each pool records its own last successful
  date. The global date advances only when every pool succeeds. Each LTM job commits atomically, so a later failure
  keeps the remaining STM for the retry (15-minute backoff). Every STM present when the boundary runs is consolidated.
- **Contemplation:** one serial pipeline per interpretation pool. Maintenance requests within a batch run in parallel
  (up to 16 at once). The batch applies all-or-nothing. A result for an interpretation that was edited through the
  API in the meantime is skipped as superseded, including the experiment completions it reported. A completion
  retires an experiment only if its text is still exactly what the model examined, so an experiment edit made through
  the API is never lost. Generation is reviewed by a second Contemplation-model call (distinct and compatible?), with
  one retry using the reviewer's feedback, otherwise it declines. The candidate commits only if the interpretation
  pool revision is unchanged since the snapshot. If it changed, the candidate is re-reviewed against the current pool
  (at most twice) and discarded if rejected. Experiment planning commits only when neither the interpretation
  revision nor the experiment revision changed during the request. Otherwise it reruns (up to 3 times).
  Interpretation edits through the API are debounced by 200 ms so quick edits produce one review.
  A per-(pool, chat) watermark of the last processed user message is persisted. It advances only after a successful
  cycle, so restarts and failures re-evaluate unprocessed evidence.
- **Gestalt (spec 0002):** one gestalt per interpretation pool, so a shared pool has one gestalt shared by its
  characters. It is stored in SQLite with the interpretation revision it reflects and its update time. Order in a
  cycle: prefetch, maintenance, generation, gestaltization, experiment review. Gestaltization runs only when the
  interpretation revision changed (generation, maintenance, or an edit through the API), once per cycle against the
  final interpretations. Experiment changes and messages that change no interpretation cost no gestalt call. The
  Contemplation model receives every current interpretation and the previous gestalt (as continuity, not evidence),
  and nothing else: no chat, memory, or experiments. A result commits only if the interpretation revision is unchanged
  (otherwise it reruns, up to 3 times). An empty pool with no gestalt gets none; a pool that becomes empty has its old
  gestalt reconsidered. If the interpretations would not fit the model's context (estimated at 3 characters per token
  plus the output budget, using the catalogue's context length), the call is skipped and recorded instead of sending
  a truncated set. A failure keeps the last valid gestalt, records the \`contemplation_gestaltization\` stage, and does
  not stop experiment review or dialogue. It retries at the next opportunity (a user message, an interpretation
  change, a restart, entering the key, or re-enabling Contemplation), never in a loop. Pools upgraded from an older
  database get their first gestalt automatically. Gestalt text is at most 16,000 characters.
- **Vision (spec 0003):** a fourth model role with its own output budget and temperature setting, called through the
  same OpenRouter Chat Completions transport (provider ignore list included) with one image content part. Its input is
  only the attached image, the chat's whole active verbatim window (up to 100 entries, including earlier observations),
  and the current gestalt of the character's interpretation pool when Contemplation is enabled. It never receives
  memory records, interpretations, experiments, or the pinned self-description. The output is one prose observation
  (at most 6,000 characters); empty, oversized, or JSON-shaped output is rejected rather than repaired, because a repair
  would need the image again. A model the catalogue lists without image input or text output, and a request that would
  not fit the model's context (estimated, with 3,000 tokens per image), fail before any call; the model is never
  switched. Transport retries are the usual bounded ones.
- **Image observations in the verbatim stream:** an observation is its own entry (role `observation`, kind
  `image_observation`) linked to the user message the image belongs to, so it counts toward the 100/20/80 window like
  any message. Every consumer sees it as a typed non-speech entry that names its message and that message's text, so its
  source stays clear even when consolidation separates the two. Dialogue gets it as a labeled `[IMAGE OBSERVATION]`
  entry with a `[viewed ...]` marker, never the image itself; a user message whose image failed carries "The attached
  image could not be viewed". The STM prompt records it in ordinary third-person prose ("The user showed Mira a photo
  they called their selfie; the person pictured had ...") with no special memory field. Retry, follow-up and opener
  checks, elapsed time, and Contemplation watermarks use actual chat turns and ignore observations.
- **Image turn lifecycle:** the upload is validated by its bytes (PNG, JPEG, WebP; at most 10 MiB, within a bounded
  multipart body), written under a random name via a temporary file, and committed with its message in one
  transaction; a rejected upload leaves no message and no file. The reply first runs Vision, then triggers Contemplation
  once and the reply. Verbatim consolidation for that chat waits while an image is pending. Retry reuses the
  observation or the recorded failure. After a restart, once the key is entered, a pending image that is still the
  chat's latest turn is perceived and answered once; one a later message overtook is marked failed. At startup,
  partial and unreferenced files in `data/uploaded-images` are deleted, and a pending upload whose file is missing is
  marked failed. Uploads are served only by their recorded name with the recorded type and `nosniff`.
- **Follow-ups:** presence is a 5-second heartbeat with a 20-second TTL plus a `sendBeacon` on page close. A hidden
  tab counts as away. The opener timer starts whenever an empty chat is opened. A canceled follow-up is never
  reinstated. Autonomous messages are discarded at commit if anything changed in the chat.
- **Images:** the OpenRouter Images API as in Society. Only options that every endpoint advertises are sent (`n: 1`,
  `aspect_ratio: 1:1`, `quality: medium`, `output_format: webp`, `stream: false`). Inline base64, data URIs, and
  temporary https URLs are accepted. A temporary URL is downloaded at once: https on the default port only, no
  credentials, no redirects, and the host must not be local or resolve to a loopback, private, link-local, CGNAT, or
  other internal address. The body is read as a stream and aborted past the limit. PNG, JPEG, and WebP only, at most
  16 MiB, signature checked. No re-encoding (Society's `sharp` normalization is omitted to stay dependency-free).
  Pending images resume after a restart once the key is entered.
- **Limits:** JSON request bodies 256 KiB; an attached image 10 MiB (multipart body 10 MiB + 256 KiB); messages
  20,000 characters; interpretations 4,000; each experiment 1,000; an observation 6,000. There is no limit on the
  number of experiments (spec 5.4); an oversized planning request fails visibly rather than truncating.
- **Browser navigation:** each navigation renders into its own root, guarded by an epoch counter, so a slow response
  from an earlier route can never mount over the current one. Leaving a chat reports presence immediately.

## Known limitations

- Because the key exists only in memory, model-backed background work after a restart (missed STM→LTM catch-up,
  contemplation recovery, pending images) starts when the key is entered, not at process start.
- No live-provider evaluation has been run. Prompt quality is untested against real models, including how DeepSeek
  routes handle the format modes and whether models use the time markers well.
- The format step-down recognizes OpenRouter's "requested parameters" rejection and format-related 4xx messages. A
  provider that rejects the format with different wording fails the reply visibly (Retry stays available).
- The image URL check resolves DNS before the download; a DNS answer that changes between the check and the fetch is
  not defended against.
- The browser UI has no automated tests; the navigation guard (review P2-2) is covered only by code review. The
  read-only Contemplation page is checked only by a source scan for mutation requests and controls.
- The gestalt's context check is an estimate. A model whose tokenizer is less efficient than 3 characters per token can
  still reject an oversized request; that also fails visibly and keeps the previous gestalt.
- The interpretation and experiment edit routes and the Force route remain on the server for compatibility (spec 0002
  U2), but no page uses them.
- That OpenRouter no longer routes text to Baidu can only be confirmed from a live Emergency Dump after deployment.
- The Emergency Dump ZIP is uncompressed (Society's stored-ZIP writer) and does not include image bytes, generated or
  uploaded; it includes upload metadata, perception states, and observation texts. Inline image data is redacted from
  LLM diagnostics.
- **Release gate (spec 0003 F3):** the 10 MiB upload bound is a provisional technical limit for the trusted LAN. Before
  any public release, a product upload maximum must be decided and enforced in the browser and authoritatively on the
  server, with tests for oversize rejection. This patch does not make the server safe to expose.
- Whether a Vision model's observation is accurate and free of interpretation is checked only by its prompt and manual
  testing; the mechanical checks are emptiness, length, and JSON shape.
- There is no UI to retry a failed perception; the user can send the image again.

## Society sources reused

The Society checkout at `../society/society` (commit `a9e3c2a`) was the donor. It was not modified.

| Beholder | Society source |
| --- | --- |
| `src/sanitize.js`, `src/zip.js` | `src/sanitize.js`, `src/zip.js` (copied) |
| `src/openrouter.js` | `src/openrouter.js` `performProviderAttempt` (diagnostics, timeout, truncation and empty-completion detection, provider ignore list) |
| `src/llm.js`, `src/prompts/repair.js` | `src/memory-generation.js` `generateValidatedDraft` (bounded repair, truncation recovery wording) |
| `src/memory.js`, `src/prompts/memory.js` | `src/memory-stm.js` (STM contract, `validateStmDraft`, live-wave consume/retain), `src/memory-ltm.js` (selector, LTM contract, `validateLtmDraft`, `partitionDailySources`), `src/memory-generation.js` (epistemic rules, text rules, `idListErrors`, `isNoOp`), `src/mind-runtime.js` `selectMindContext` and `src/mind.js` `sanitizeRetrievalSelection` (retrieval) |
| `src/diagnostics.js` | `src/diagnostics.js` (`beginLlmExchange`, `finalizeLlmExchange`, `runtimeActivityView`) |
| `src/dump.js` | `src/dump.js` (independent sanitized sections, manifest) |
| `src/images.js` | `src/world-illustration.js` (Images API request, capability lookup, descriptor matching, response parsing, raster signatures) |
| `src/settings.js` | `src/models.js` (curated model list) |
| `Dockerfile`, `docker-compose.yml` | `Dockerfile` (`SOURCE_COMMIT_SHA` build info), `docker-compose.yml` (`./data:/app/data`) |
