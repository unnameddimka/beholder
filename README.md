# Beholder — local AI roleplay companion (PoC, Specification 0000)

Beholder is a local, single-user roleplay chat. Each character has its own chat. Behind every chat, an independent
**Contemplation** process keeps free-form *interpretations* of the user, synthesizes them into one evolving
*gestalt* (a tentative impression of the user as one whole, ultimately unknown person), and turns them into
*experiments* (intentions to learn more). The dialogue model receives the gestalt and the experiment intentions, never
the interpretations themselves. You can attach an image to a message: a separate **Vision** model perceives it in the
context of the chat, and the character reacts to that observation.

Full requirements: [docs/specs/0000-beholder-poc.md](docs/specs/0000-beholder-poc.md), amended by
[0001](docs/specs/0001-dialogue-response-reliability-and-time-awareness.md),
[0002](docs/specs/0002-gestaltization-readonly-contemplation-baidu.md),
[0003](docs/specs/0003-contextual-vision-image-observations.md),
[0004](docs/specs/0004-interpretation-consolidation-personal-cognition-mobile-composer.md),
[0005](docs/specs/0005-character-ai-config-three-descriptions-force-and-ctrl-enter.md), and
[0006](docs/specs/0006-pregnant-interpretations-llm-contracts-contemplation-refactoring.md).

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
3. **Add Character** (or **Edit** an existing one). Everything about a character lives in its own editor (spec 0005):
   - **Descriptions**, all optional and up to 20,000 characters each:
     - *Character Description*: who the character is.
     - *Scene Description*: where and in what circumstances the conversation takes place.
     - *User Description*: how you describe yourself to this character. It is pinned as your self-description, not
       sent as a chat message.

     Every AI role of the character receives all three as labeled context.
   - **AI Models**: one card each for **Dialogue**, **Contemplation**, **Vision**, and **Image Generation**.
     - The fields suggest the curated models and OpenRouter's catalogue (**Refresh model list** reloads it). Vision
       suggests exactly Google Gemini 3 Flash Preview (the default), Qwen3-VL-235B-A22B Instruct, and Google Gemini
       3.1 Flash Lite.
     - Every field also accepts a typed model id. A configured id stays shown even when the catalogue is unavailable.
     - The three text roles each have a temperature override and a maximum output tokens setting (defaults: 8,192
       Dialogue, 16,384 Contemplation, 4,096 Vision).
     - Image generation is off by default. It does not affect attaching your own images.
     - Automatic Contemplation is on by default.

   A new character starts from the built-in defaults, never from another character's settings, and with empty Scene
   and User descriptions. Saving changes only this character. Its chat, memory, interpretations, gestalt,
   experiments, and images stay as they are, and work already running finishes with the values it started with.
   There is no global Settings page or shared "About you" any more.

   Each character also owns its cognition (spec 0004): its own short- and long-term memory, interpretations, gestalt,
   experiments, and Contemplation progress. A new character starts with all of them empty; nothing is shared or
   copied between characters. (Older versions had *Use shared memory* / *Use shared interpretations* flags; they are
   gone, and the API ignores them if sent.)

## Testing Contemplation by hand

1. Create a character and chat for a few messages. After each user message the header shows activity, and the
   Contemplation model runs a cheap prefetch. It sees the interpretations, the last 100 messages, the active
   experiments and the character's three descriptions (never consolidated memory), and requests maintenance when an interpretation needs revisiting or an
   experiment appears to have produced a result.
   Maintenance first consolidates the whole interpretation set in one request (duplicates merge, distinct and
   conflicting hypotheses stay separate), then checks each consolidated interpretation against the conversation,
   and saves the result only if every step succeeded.
   When the prefetch sees a genuinely new angle, generation adds an interpretation.
2. Open **Contemplation** (from the chat header). It shows:
   - the gestalt (with "Not formed yet" or "Update pending" when that applies), the interpretations, and the active
     experiments;
   - the current stage, parallel maintenance requests, queued work, the last cycle's flags, and errors;
   - **Maintenance now** (queued, running, or idle);
   - **Last Maintenance**: when it ran, its outcome (succeeded, nothing needed changing, discarded as stale, skipped,
     failed, or interrupted by a restart), whether it was automatic or forced, and the reason when it did not
     succeed. It shows "Never" until the first attempt, and it survives restarts.

   **Run now** offers **Force Maintenance**, **Force Generation**, and **Force Experimentation**. Each one queues the
   normal model-driven stage. Under the buttons, each kind shows whether it is queued or running, and the outcome of
   its last forced run: completed (with what it did) or failed (with the reason), and when. While a new request
   waits or runs, the earlier outcome is labeled "Previous run", so it is never mistaken for the new one. A button is
   disabled while its run is queued or running, so it cannot be queued twice. Force works even while automatic Contemplation is off. A
   forced Maintenance or Generation is then followed by the usual gestalt update and experiment review. No control
   edits interpretation, experiment, or gestalt text.
3. Every interpretation change leads to one gestalt update and then one experiment review, so the gestalt and active
   experiments appear shortly after the first interpretation.
4. Keep chatting. The dialogue model receives the gestalt as its own tentative impression of the user and the active
   experiments as private, optional intentions.
5. To compare behavior, untick **Automatic Contemplation** in the character's editor. For that character only,
   nothing runs on its own (including gestalt updates), and neither the gestalt nor the experiments are sent to its
   dialogue. Stored state stays visible, and Force still works.

## Attaching an image

Use the paperclip button (**Attach image**, left of the message field) to pick one PNG, JPEG, or WebP file of at most
10 MiB. A preview appears above the field; **Remove** takes it off again. Send it with or without text. The chat shows the image in
your message with a small note: "Viewing..." while the Vision model looks at it, then a collapsed **What <name> saw**
with the observation, or "Could not be viewed". The character's reply waits for the observation. If Vision fails, the
reply knows only that an image could not be viewed and never pretends to have seen it.

The message field grows with its lines up to about a third of the screen, then scrolls.
- **Enter** and **Shift+Enter** insert a new line.
- The Send button (the paper plane, right of the field) sends.
- On a desktop keyboard, **Ctrl+Enter** in the message field sends too, through the same action as the button. It is
  ignored while an input method is still composing, while a reply is pending, and for an empty message without an
  image. Command/Meta+Enter is not a shortcut.

**Emergency Dump** (the red **Dump** button, always in the header) downloads a sanitized ZIP of state and diagnostics.
It works while the server is busy and never changes state.

## Checks and tests

```sh
npm test        # node --check on every .js file, then node --test with a mocked OpenRouter (no paid calls)
```

The tests cover the acceptance scenarios that can be automated: key secrecy across restarts, dumps, and data files;
character-owned pools; context assembly (pinned self-description, gestalt and experiments in, interpretations out); envelope
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
boundary, and no image data in diagnostics or dumps); and the spec 0004 scenarios (one consolidation of the whole
pool before verification, the verifier seeing consolidated text, the ID-mapping validator, all-or-nothing and stale
commits, no revision bump for an unchanged set, the context and output-budget refusal, empty cognition for a new
character, the shared-pool migration with its revisions, gestalt and watermarks, restart idempotence, refusal of
ambiguous legacy states, and a source scan of the composer contract); and the spec 0005 scenarios:
- descriptions and AI configuration per character: validation without partial saves, built-in defaults for new
  characters, and no global settings in the API, status, or dump;
- the settings migration on a schema-4 database: exact values for one or several characters, independence
  afterwards, refusal of invalid legacy values, and idempotence;
- routing: each character's own models across overlapping jobs, a frozen snapshot through repairs and through every
  stage of a Maintenance run, and queued images keeping their model and context across an edit and a restart;
- the three descriptions in Dialogue (one pinned User Description), every Contemplation stage, STM, LTM, retrieval,
  Vision and image prompts, with empty fields;
- Force dedupe and separation per character, Force with automatic Contemplation off, and persisted Maintenance
  status including interruption;
- a source scan of the editor and the Ctrl+Enter handler.

And the spec 0006 scenarios:
- golden request traces (`tests/golden-traces.test.js`, fixture `tests/fixtures/golden-traces.json`): five fixed
  scenarios (an automatic cycle with every Contemplation stage and a repair, the three Force kinds, a stale
  Maintenance, Verbatim→STM→LTM, and an image turn with Vision and a Dialogue repair). The test compares every
  outgoing request (purpose, model, parameters, message bytes and order within the Dialogue and Contemplation lanes)
  and the resulting cognitive state with the recording. Wall-clock values are normalized. The fixture was recorded
  before the refactoring. A deliberate prompt change is re-recorded with `BEHOLDER_RECORD_GOLDEN=1 node --test
  tests/golden-traces.test.js` and must be justified by its spec clause;
- the contract registry: one contract per purpose, prompts from `src/prompts/`, unchanged model roles,
  `response_format` and isolated repair only for the Dialogue envelopes, request shapes equal to the contracts, and
  snapshot-scoped validation beyond shape;
- the Contemplation split: stage execution writes nothing, and every application guard runs inside its
  transaction.

Whether a live model writes a good gestalt or an accurate,
non-interpretive observation is a manual judgment, not something the tests can certify.

### Manual smoke procedure (Android / LAN)

1. Start with Compose and open `http://<lan-ip>:3000` in Chrome on Android. Enter the key.
2. Create a character. Send a message containing `*waves*`: it shows in italics without asterisks. While the reply
   is pending, keep typing: Send stays disabled, and the draft is kept. Enter inserts new lines and never sends. On a
   desktop browser, Ctrl+Enter sends once; Enter and Shift+Enter still insert new lines.
   In portrait (320-400 px wide), with the keyboard open, the field spans the width between the two icon buttons,
   grows to its limit, then scrolls; the composer stays visible above the keyboard.
3. Open an empty chat and wait 60 s without typing: one opener arrives. Start typing in another case: nothing arrives.
4. Enable image generation in the character's editor, then ask it to show you something: the text appears first,
   the picture later.
5. Give two characters different Dialogue models and Scene descriptions, and chat with both. In an Emergency Dump,
   each `dialogue_reply` exchange uses its own character's model and scene.
6. Restart the container (`docker compose restart`): the key is required again, and chats and images are still there.
7. Download an Emergency Dump while a reply is pending, then search it for your key: it is not there.
8. Attach a real selfie with the text "Вот моё селфи": the reply arrives after the observation, and **What <name> saw**
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
  in neutral third person.
- **Verbatim→STM:** triggered when a chat has 100 active messages. The 20 oldest are consumed and the other 80 are
  read-only context. On failure, the sources stay active and an automatic retry waits 5 minutes (the
  next qualifying message after that retries).
- **STM→LTM:** checked at startup, every minute, and at local midnight. Each pool records its own last successful
  date. The global date advances only when every pool succeeds. Each LTM job commits atomically, so a later failure
  keeps the remaining STM for the retry (15-minute backoff). Every STM present when the boundary runs is consolidated.
- **Character-owned AI configuration (spec 0005):**
  - *What a character stores.* Each character row holds its three descriptions and a complete configuration: the
    four models, the temperature override and output budget of each text role, `imageEnabled`, and
    `contemplationEnabled`. It is validated strictly as a whole, so a partial update merges role by role and an
    invalid one saves nothing. Global state is only infrastructure: the in-memory key, the model catalogue, network
    and retry policy, and diagnostics.
  - *Frozen per job.* Every AI job takes a frozen snapshot of its character when it starts and uses it for every
    call, retry, repair, fit check, and catalogue clamp. That holds for a reply, follow-up or opener with its memory
    retrieval (a reply to an attached image freezes it before Vision, so the perception, retrieval, reply, and the
    image it queues all use one snapshot; a Retry is a new job), an STM batch, one pool's daily LTM run, a Contemplation cycle or forced run, a Vision perception, and
    a queued image. The LLM client has no global model at all: a request without a configuration is refused.
  - *Queued images.* A queued image stores its model and the descriptions with its row, so an edit or a restart
    never changes it. Images queued before this version have no stored context and are sent as queued.
  - *Migration 5.* It copies the previously effective global settings (the saved object merged onto the defaults,
    exactly as the old code read it) and the global user description into every existing character once, keeps each
    Character Description, and leaves Scene empty. It then deletes the legacy `settings` and `userDescription` meta
    keys. An unreadable or invalid legacy value stops it without changing anything, so the server does not start
    until a backup is restored or the value is repaired.
  - *Turning Contemplation on.* Switching a character's automatic Contemplation on through the editor catches up on
    its unprocessed messages.
- **Descriptions in every role (spec 0005):**
  - *Dialogue.* The system prompt carries the Character Description and the Scene Description (labeled as the
    current setting, not a chat event). The User Description is the one pinned, untimestamped self-description.
  - *Memory and Contemplation.* Memory, retrieval, and every Contemplation stage receive a JSON `characterContext`
    with the three fields, and their prompts state that it is framing, never evidence, a source, an observation, a
    completed experiment, or an instruction.
  - *Vision.* Vision receives `characterContext` too, and may use it only to decide what to notice, never to claim
    anything that is not visible.
  - *Image generation.* The prompt sent to the image model is the Dialogue model's request followed by a labeled
    background block of the non-empty descriptions. The block says not to add those people, places, or objects
    unless the request asks for them. Nothing is shortened: a provider that refuses a long prompt fails the image
    with a message naming the descriptions (shorten them or choose another image model).
  - *Empty fields.* Empty fields are shown as not given and are never invented.
- **Force and Maintenance status (spec 0005):**
  - *Force.* The Force route queues an existing stage on the pool's serial pipeline. It returns whether it queued
    (or that the kind is already queued or running), never an outcome, with a request id. The Contemplation status
    then reports per kind `queued`, `running`, or `idle` and the last finished forced run: `completed` with its
    stage result, or `failed` with a code and a sanitized reason. A follow-up gestalt or experiment review that fails
    after a completed forced Maintenance or Generation is shown beside that outcome, not as it. A forced Maintenance or Generation is followed
    by the normal gestaltization and experiment review even while automatic Contemplation is off (owner decision).
    Dialogue still gets no gestalt or experiments while it is off.
  - *Status record.* Each Maintenance attempt is recorded on its pool: running at the start, then applied,
    unchanged, stale, skipped (no interpretations, or the context or output budget would be exceeded), or failed,
    with its source (automatic or forced), times, counts, and reason. A record still marked running at startup
    becomes "interrupted".
- **Character-owned cognition (spec 0004):** every character has exactly one memory pool and one interpretation pool,
  keyed internally as `character:<id>`. Every subsystem (dialogue retrieval, prefetch, maintenance, generation,
  gestaltization, experiment planning, Vision's gestalt, STM and daily LTM consolidation, watermarks, recovery, the
  dump) uses that pool. Schema migration 4 moves the legacy `shared` pools to the one character that used them,
  keeping every row's id, text, timestamps and provenance and the pool state (revisions, planning flag, gestalt and
  its revision, memory revision and LTM date, watermarks); only the pool key changes. It then drops the two flag
  columns. It refuses, without changing anything, when the owner is ambiguous: nonempty shared data used by zero or
  several characters, contributions from another character's chat, or a character with both a nonempty shared and a
  nonempty personal pool. The server then does not start; restore a backup or move the legacy rows by hand.
- **Contemplation:** one serial pipeline per interpretation pool. Maintenance (spec 0004) starts with one
  consolidation request that sees the whole pool at once and returns groups by stable id (a surviving id, the ids it
  represents, the new text). It is semantic deduplication only: no plausibility judgment, no target count, no new
  hypotheses. The result must account for every id exactly once; otherwise it is repaired or fails. Each consolidated
  interpretation then gets the existing check against the conversation, memory and experiments, in parallel (up to
  16 at once). Only when every request succeeded is the final set committed in one transaction: merged-away ids
  deleted, verified text written, completions applied, and the interpretation revision bumped once if anything
  changed. If the pool changed during the requests (an edit through the API), the whole result is discarded and a
  later run retries. If the pool would not fit the model's context (system prompt, interpretations and output
  budget, estimated at 3 characters per token) or its unmerged rewrite would not fit the max output tokens setting,
  maintenance is skipped and recorded; the set is never truncated. The commit is also discarded
  as stale when an experiment was added, edited or deleted through the API while the checks ran, so neither
  interpretation changes nor completions are derived from experiments the model no longer sees, and an experiment edit
  is never lost. Generation is reviewed by a second Contemplation-model call (distinct and compatible?), with
  one retry using the reviewer's feedback, otherwise it declines. The candidate commits only if the interpretation
  pool revision is unchanged since the snapshot. If it changed, the candidate is re-reviewed against the current pool
  (at most twice) and discarded if rejected. Experiment planning commits only when neither the interpretation
  revision nor the experiment revision changed during the request. Otherwise it reruns (up to 3 times).
  Interpretation edits through the API are debounced by 200 ms so quick edits produce one review.
  A per-(pool, chat) watermark of the last processed user message is persisted. It advances only after a successful
  cycle, so restarts and failures re-evaluate unprocessed evidence.
- **Interpretations as possible people (spec 0006 S):** each interpretation is one pregnant, coherent image of who
  the user could be: motives, relationships, history and circumstances that explain one another. It may invent
  unverified concrete detail; unverified is not disproved, and only a direct conflict with what was observed counts.
  The stored text is the image itself, never a chronicle, quotes, evidence lists, experiment ids or outcomes, or
  maintenance notes. Generation asks for a genuinely different possible person, and its review checks only
  distinctness and direct contradiction, never evidential support. Consolidation merges images of the same person
  and explanatory logic and keeps different people apart even when they explain the same events. Maintenance asks
  whether the imagined person could still be the user: compatible invention stays, a contradiction is repaired
  inside the image without a log, and `delete` remains for an image whose defining logic is destroyed. An experiment
  completion is recorded only in `completedExperimentIds`, never in the text. The gestalt carries invented details
  only as possibilities, and Dialogue is told never to state them to the user as facts. The Prefetch, Experiment
  Planning, memory, Vision and repair prompts are unchanged, as are the 4,000-character limit, every response shape
  and the pipeline. Stored interpretations are not migrated; they follow the new semantics the next time
  Maintenance, Consolidation or Generation touches them. Where this narrows earlier wording, spec 0006 takes
  precedence: spec 0000 §5.2 (meaningful conclusions go into the image, not as a record), the gestalt bullet of spec
  0002 (imagined biography may appear as a possibility, never as fact) and the consolidation strip rule of spec 0004
  (no retelling at all instead of a minimal one).
- **Code boundaries (spec 0006):** every LLM purpose has one contract in `src/contracts/`. It names the model role,
  the system prompt (still in `src/prompts/`), the required response shape, the validator, the snapshot-scoped checks
  and limits, the failure policy, and which transport policy applies. `LlmClient` reads the role and the Dialogue
  envelope policy from it; transport, format step-down, repair and truncation recovery stay in `src/llm.js`.
  Contemplation is split into orchestration (`src/contemplation.js`: triggers, Force, queues, the per-pool loop,
  recovery, status), stage execution (`src/contemplation-stages.js`: reads inputs and calls the model, returns
  uncommitted results, writes nothing) and atomic application (`src/contemplation-apply.js`: every write, with its
  revision/snapshot guard inside the same transaction). Requests, timing, state and endpoints are unchanged by the
  split.
- **Gestalt (spec 0002):** one gestalt per interpretation pool, so one per character. It is stored in SQLite with the interpretation revision it reflects and its update time. Order in a
  cycle: prefetch, maintenance, generation, gestaltization, experiment review. Gestaltization runs only when the
  interpretation revision changed (generation, maintenance, or an edit through the API), once per cycle against the
  final interpretations. Experiment changes and messages that change no interpretation cost no gestalt call. The
  Contemplation model receives every current interpretation, the previous gestalt (as continuity, not evidence) and
  the character's three descriptions as framing (spec 0005), and nothing else: no chat, memory, or experiments. A result commits only if the interpretation revision is unchanged
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
  the current gestalt of the character's interpretation pool when Contemplation is enabled, and the character's three
  descriptions as framing (spec 0005, which added the User Description). It never receives memory records,
  interpretations, or experiments. The output is one prose observation
  (at most 6,000 characters). Empty, oversized, JSON-shaped, or instruction-shaped output (such as "ignore previous
  instructions" or a chat-role prefix, checked outside quoted text so quoted writing seen in the image stays) is
  rejected rather than repaired, because a repair would need the image again. A model the catalogue lists without
  image input or text output, and a request that would not fit the model's context (estimated, with 3,000 tokens per
  image), fail before any call; the model is never switched. Transport retries are the usual bounded ones.
- **Image observations in the verbatim stream:** an observation is its own entry (role `observation`, kind
  `image_observation`) linked to the user message the image belongs to, so it counts toward the 100/20/80 window like
  any message. Every consumer sees it as a typed non-speech entry that names its message and that message's text, so its
  source stays clear even when consolidation separates the two. Dialogue gets it as a labeled `[IMAGE OBSERVATION]`
  entry with a `[viewed ...]` marker that names its source message by its stable id (`msg_<id>`, also shown on that
  user message), sent time, and text, and says when that message has left the history. It never relies on position
  and never includes the image itself. A user message whose image failed carries
  "The attached image could not be viewed". The STM prompt records it in ordinary third-person prose ("The user
  showed Mira a photo they called their selfie; the person pictured had ...") with no special memory field. Retry,
  follow-up and opener checks, elapsed time, and Contemplation watermarks use actual chat turns and ignore
  observations.
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
- Consolidation quality (merging true duplicates while keeping distinct and conflicting hypotheses) needs real-model
  inspection; the tests check the prompt, inputs, ID mapping and commit rules, not semantic judgment. Its size checks
  are estimates like the gestalt's.
- Whether a real model (GLM included) writes pregnant possible-person images, keeps invented detail through
  Maintenance, keeps materially different people apart, and leaves chronicles and bookkeeping out of the stored text
  is a qualitative, owner-run evaluation (spec 0006). The tests check the prompt wording, the unchanged contracts and
  pipeline, and mocked outcomes, not model judgment. Nothing in this patch makes Generation or Maintenance run more
  often, and existing interpretations keep their old style until a stage rewrites them.
- The golden request traces cover five fixed scenarios. Requests outside them (follow-ups, openers, the LTM selector
  with existing LTM, generation re-review after a pool change) are covered by the ordinary suites, not byte for byte.
- The mobile composer is checked by a source scan only. Behavior with real software keyboards (Android and iOS) needs a
  manual check on devices; iOS Safari does not resize the layout for the keyboard, so the page follows the visual
  viewport height instead.
- The gestalt's context check is an estimate. A model whose tokenizer is less efficient than 3 characters per token can
  still reject an oversized request; that also fails visibly and keeps the previous gestalt.
- The interpretation and experiment edit routes remain on the server for compatibility (spec 0002 U2), but no page
  uses them. The Contemplation page calls only the Force route (spec 0005).
- The outcome of the last forced run of each kind is kept in server memory only, like the Force queue itself: after a
  restart it reads "never forced since the server started". The Last Maintenance record is persisted and survives.
- Dialogue, memory, and retrieval requests have no pre-flight context check, so three long descriptions can make one
  of them exceed a small model's context. The provider then rejects it and the job fails visibly; nothing is
  truncated or dropped. Consolidation, gestaltization, and Vision keep their estimated pre-flight checks, which now
  include the descriptions.
- Image prompts carry the descriptions, and many image models accept only a few thousand characters of prompt.
  There is no pre-flight length check, because the Images API does not report a limit. The provider's refusal is
  shown on the image.
- The character editor, the Force buttons, the Maintenance status, and Ctrl+Enter are checked by source scans only;
  there are no browser tests.
- That OpenRouter no longer routes text to Baidu can only be confirmed from a live Emergency Dump after deployment.
- The Emergency Dump ZIP is uncompressed (Society's stored-ZIP writer) and does not include image bytes, generated or
  uploaded; it includes upload metadata, perception states, and observation texts. Inline image data is redacted from
  LLM diagnostics.
- **Release gate (spec 0003 F3):** the 10 MiB upload bound is a provisional technical limit for the trusted LAN. Before
  any public release, a product upload maximum must be decided and enforced in the browser and authoritatively on the
  server, with tests for oversize rejection. This patch does not make the server safe to expose.
- Whether a Vision model's observation is accurate and free of interpretation is checked only by its prompt and manual
  testing; the mechanical checks are emptiness, length, JSON shape, and obvious instruction shapes.
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
| `src/settings.js` | `src/models.js` (curated model list; the per-character configuration contract is Beholder's own) |
| `Dockerfile`, `docker-compose.yml` | `Dockerfile` (`SOURCE_COMMIT_SHA` build info), `docker-compose.yml` (`./data:/app/data`) |
