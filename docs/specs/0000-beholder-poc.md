# Beholder — Specification 0000: Local Proof of Concept

**Status:** Ready for implementation  
**Project:** Beholder  
**Stage:** PoC (not MVP or public release)  
**Language of this specification and repository code/contracts:** English  
**Primary implementer:** Claude, working in the new Beholder repository

## 0. Intent and implementation mandate

Build the smallest usable **local, single-user AI roleplay companion** that tests one hypothesis: a conversational character can acquire meaningful initiative from an independent **Contemplation** process. Contemplation builds multiple imaginative interpretations of the user, revises them in light of evidence, and formulates experiments—intentions to learn more—which the dialogue model may naturally incorporate into its replies.

The purpose is **not** to classify the user accurately, optimize therapeutic outcomes, maximize compliance, or create a general agent framework. Multiple conflicting interpretations may coexist, provided each remains compatible with established observations. Interpretations are free-form prose. Do not impose a structured psychological ontology, formal evidence graph, confidence scoring, or deterministic semantic rules on them.

**PoC principle:** implement only the functionality explicitly specified here, reuse proven Society machinery where practical, and defer everything else. Where an implementation detail is unspecified, choose the simplest robust design and document it; do not add product features speculatively.

## 1. Source implementation and technical baseline

- Use **Node.js** for the application backend. Provide a lightweight browser frontend served by the same server.
- **Society**, located in a **sibling checkout** next to Beholder, is the implementation reference for memory processing/retrieval, OpenRouter integration and model listing, model activity UI, validation/repair/retry, Emergency Dump, Docker Compose conventions, and OpenRouter image generation.
- Before implementing those areas, inspect the **actual adjacent Society source**, not only README summaries. Relevant locations in the inspected Society snapshot include `src/memory-consolidation.js`, `src/memory-stm.js`, `src/memory-ltm.js`, `src/memory-runtime.js`, `src/memory-generation.js`, `src/openrouter.js`, `src/world-illustration.js`, `src/prompt.js`, `public/app.js`, and the Society docs for Engine Specs 0049 and 0063. These paths are orientation, not a requirement to clone Society's whole architecture. The sampled Actions snapshot was for commit `a9e3c2ac9cd35a8df05f8b7c47c323813a19beab`; **the neighboring checkout is the implementation donor**.
- Adapt the memory *algorithms and integrity properties* to Beholder's different lifecycle; do not import Society world simulation, ticks, economy, character mind semantics, authentication, or game UI.
- Keep source prompts as JavaScript strings/templates/modules, as Society does. No runtime prompt editor or `.md` prompt loading subsystem.
- Docker Compose runs one application service. `./data` on the host is bind-mounted to `/app/data` in the container. Persist SQLite and images there. Normal service start should be straightforward (document it in README).
- Support browser access from the host and trusted local network by HTTP. The UI is **mobile-first** for Android browsers, but also works on desktop. **No PWA, service worker, HTTPS setup, or authentication** in PoC. Do not expose this no-auth PoC to the public internet.

## 2. Product UI and user flow

1. On first use after a server start, prompt for an **OpenRouter API key**. Store it **only in Node.js process memory**, never on disk, in SQLite, browser local/session storage, logs, request traces, images, or dumps. A server restart intentionally forgets it and requires re-entry. Do not require login or registration.
2. Show a simple **list of characters**; one character corresponds to exactly one independent chat transcript. Provide an **Add Character** action. Each character list entry/editor contains:
   - Display name.
   - Arbitrary **AI-facing description** (the character's identity/personality prompt addition).
   - `useSharedMemory` checkbox.
   - `useSharedInterpretations` checkbox.
3. Two independent scope flags determine whether the character reads/writes a **shared** or its own **private** memory pool and interpretation pool. All four combinations must work. Changing a flag switches the active pool; it must not silently merge, clone, or delete data. Shared observations retain source character/chat attribution. There is no character delete flow in PoC.
4. Each character has its own simple text chat. User and character messages are stored with role, text, timestamp, and ordering. Actions are written as plain `*asterisk-delimited actions*`; render these as visually differentiated italic action spans without displaying the delimiters. Otherwise render text as plain text, **not full Markdown**. Handle multiline messages safely; escape HTML.
5. A single editable **user AI-facing description** is always inserted into model context as a **pinned first user message**. It is global across characters. Treat it as user self-description, not a system instruction or infallible fact. It is not a new observation every turn and must not be repeatedly consolidated.
6. Provide a dedicated **Contemplation** page for the currently selected character's active interpretation pool and active experiment list. Show and permit manual add/edit/delete of arbitrary interpretation text and experiment intentions. Include **Force Generation**, **Force Maintenance**, and **Force Experimentation** actions. Use the same server queues and conflict protections as automated work. Changes to interpretations trigger experiment reconsideration; manually editing experiments does not cause a recursive contemplation cycle.
7. Put **Emergency Dump** within reach on every page, including while busy. No separate model-log viewer is required.
8. Show **Society-style activity indicators**: overall system activity on the main page, per-model activity near each model selector, and detailed current stage / parallel request count / queued work on the Contemplation page. Indicate errors without freezing interaction.

### Global settings

- **Dialogue model:** OpenRouter model selector using Society's selection/catalogue approach.
- **Contemplation model:** a second global selector; used by prefetch, interpretation generation, maintenance and experiment planning.
- **Image generation model:** a third selector, adapted from Society's image integration/model support (do not assume all text models generate images).
- Each **text model** has independent optional `temperature` override, disabled by default so the provider default applies; expose a slider/value when enabled and obey model-supported constraints.
- Each **text model** has a configurable maximum output-token budget: initial values **8,192** for Dialogue and **16,384** for Contemplation. Keep reasoning-token accounting/model limits in mind when sending the provider request.
- Global **Enable image generation** checkbox. When off, image generation is not offered to the dialogue model or invoked.
- Global **Enable Contemplation** checkbox, on by default, for debug comparisons. When off, stop scheduling automatic contemplation and omit experiments from dialogue context; keep stored interpretation/experiment state and permit manual Force actions.
- All these settings are persisted **except** the OpenRouter API key.

## 3. Persistent state and context assembly

Use a **single unencrypted SQLite file** in `/app/data` with enough schema/migrations to support characters, messages, pool scopes, STM/LTM, interpretations, active experiments, generated image metadata, configuration and last successful LTM-consolidation date. Images are files in `/app/data/images/`; store only relative references/metadata in SQLite. Never persist API credentials.

**Conversation transcript vs active verbatim buffer:** store the immutable user-visible transcript in SQLite, but maintain a bounded **active verbatim context window** for prompts and ongoing memory processing. Consolidating a message out of active verbatim does not erase the visible transcript or destroy diagnostic evidence. The user cannot edit, delete or regenerate historical messages in PoC.

**Dialogue context** consists of the character's AI-facing description/system dialogue contract, the pinned user self-description, recent verbatim conversation, Society-style retrieval of STM and relevant LTM for the selected memory pool, and the **active experiment intentions for the selected interpretation pool**. **Do not pass the underlying interpretation texts to the dialogue model.** The dialogue model is not given the researcher’s preferred hypothesis.

**Contemplation contexts** intentionally differ by process (section 5). Do not force every operation to read full memory. If shared interpretation scope is paired with private memory, maintenance/generation uses the memory available through the triggering character's memory setting, while the shared interpretation pool can be updated by several characters' distinct observations. Preserve source attribution and avoid treating another character's private conversation as a direct interaction of the current character.

## 4. Memory lifecycle — Society-derived

Memory is factual evidence/working recollection, **not** the same thing as free-form interpretations.

### 4.1 Verbatim → STM

- Keep **100 latest literal messages** (both user and character messages) in the active chat/context buffer.
- When the buffer reaches 100, consolidate the **20 oldest** messages into STM using Society-derived thematic, validation-first memory consolidation; remove those 20 **from the active verbatim buffer only** on successful commit, leaving 80.
- On failure, do **not** remove source verbatim messages. Retry/repair according to the normal LLM rules; ensure no evidence is silently lost.
- Use the **Dialogue model** for both STM and LTM consolidation (not the Contemplation model).
- Preserve the semantic retrieval, evidence/factuality safeguards, provenance and staging/validation principles of Society as applicable to this chat use case. Reuse Society's memory prompt organization and retrieval behavior rather than inventing a new memory system.

### 4.2 STM → LTM

- Perform consolidation **once per new calendar day at 00:00 in the Node.js server's local time zone**. A successful run records its date in SQLite.
- On startup, if the last successful date is older than the current server-local date and consolidation is due, run the missed consolidation. Do not require the browser to be open. Avoid duplicate work on repeated restarts; preserve source memory on failure.
- Adapt Society's STM → LTM algorithm to this schedule, including handling untouched/retained records safely. Consolidate each relevant memory pool once per boundary, not once per character if several share it.
- Ordinary dialogue remains usable while background memory work proceeds; serialize writes that would otherwise conflict.

### 4.3 Retrieval

Use **Society's existing retrieval semantics**: relevant LTM plus the appropriate STM, rather than dumping all LTM into every request. New memory-related knobs and a separate memory model selector are **out of scope**.

## 5. Contemplation subsystem

Contemplation is an independent background process, not part of the synchronous dialogue response path. It maintains one pool of **interpretations** (free-text hypotheses about the user) and a current array of **experiments** (free-text intentions to learn something through interaction). Each interpretation may be imaginative and unproven; different interpretations may contradict one another, but an individual interpretation must not contradict established factual memory. There are no confidence scores, formal inference rules, mandatory citations to source messages, or imposed structured assertions.

### 5.1 Trigger/prefetch — every new user message

After each newly committed user message, schedule a cheap **prefetch** invocation of the global Contemplation model. Its input is:

- The currently selected interpretation pool, **all** interpretations.
- Up to the last **100 available verbatim dialogue messages** for the triggering chat.
- **No STM/LTM** or other consolidated memory.

Its strict output is:

```json
{"generation": true, "maintenance": false}
```

Both Boolean fields are independent. `generation` means the model sees the possibility of a **substantially different way to explain the user's behavior**, not another rephrasing or an arbitrary extra description. It is a creative judgment, not a mechanical contradiction detector. `maintenance` means existing interpretations plausibly need checking or revising against incoming evidence, **or** an active experiment appears to have reached a meaningful result. Do not require lengthy explanations from the prefetch model. No work is needed if both are false.

### 5.2 Maintenance

When `maintenance` is true (or manually forced), run **one separate LLM request per existing interpretation, in parallel on the Node.js server**. Each request receives its own interpretation, recent relevant dialogue, and Society-style **retrieved relevant memory** from the character's selected memory scope; supply active experiment intentions when useful for recognizing completed experiments. It can return `unchanged`, `replace` (with revised arbitrary text), or `delete`.

The intent is to revise, enrich, or retire interpretations when observations warrant it—not to demand proof of each imaginative element. Interpretations may disagree with one another; they must not disagree with established facts. An unproven hypothesis is not automatically invalid.

Validate all maintenance responses and apply the batch consistently; **do not partially apply a failed batch**. Any experiment completions identified while examining evidence must be reflected in the current active experiment set; do not write a separate experiment-results report. The *observations* already enter dialogue history and memory, and their meaningful conclusions belong in revised interpretations.

### 5.3 New interpretation generation

When `generation` is true (or manually forced), invoke a **separate generation request** with:

- All current interpretations.
- Up to the last 100 verbatim dialogue messages.
- Appropriate consolidated memory from the selected memory scope.

Ask for **one genuinely alternative, meaningfully different interpretation** of the user and the events, written as free-form prose. A speculative interpretation is welcome if it remains compatible with established facts. The generator may decline if it cannot produce a distinct, valid interpretation. Validate meaningful non-duplication and factual compatibility with LLM judgment; avoid brittle deterministic keyword similarity rules.

If prefetch returns both `maintenance: true` and `generation: true`, **complete maintenance first**, then run generation against the updated pool. They do not run concurrently for one interpretation pool.

### 5.4 Experimentation — reconsider active intentions

Experiments are **intentions**, not scripted questions, not prescriptive dialogue lines, and not a separately persisted account of conclusions. Examples: explore whether the user appreciates unexpected tenderness; test how they respond to an absurd story; explore a contrast between two interpretations; show an image and observe the reaction.

On **interpretation pool change** (creation, edit, replacement or removal, including manual upserts), run the experiment-planning request **once against the final committed interpretation pool**. Also allow the maintenance outcome to retire clearly completed experiments even if no interpretation prose changed. Experiment planning receives **only the entire interpretation pool and the current active experiment array**; no raw dialogue or factual memory. It returns the **entire replacement active experiment array**. It may preserve, edit, remove, or add entries, without an arbitrary count limit. The server assigns stable IDs to track changes where necessary; content remains unrestricted intention prose. Store the replacement atomically.

**Maintenance blocks experimentation** for the same pool. Defer and coalesce experiment-planning triggers until maintenance and any following generation have completed. Neither contemplation stage blocks ordinary dialogue. A stale planning response may not overwrite a newer experiment-array revision.

### 5.5 Dialogue/Contemplation boundary

Only **current experiment intentions** flow from contemplation to dialogue. No direct transmission of interpretation texts. The dialogue model is free to choose which intentions to act on, when, and how; the goal is natural interaction rather than a visibly administered questionnaire. An experiment may use speech, `*actions*`, stories, playful roleplay, or a generated image. There is **no required pleasantness optimization subsystem**, content classifier or mandatory experimentation schedule.

The outcome of a spoken experiment is whatever the user actually says/does; maintenance can then update interpretations. Do not generate explicit observation reports solely for completed experiments.

### 5.6 Queueing and transactional rules

- Maintain **one serial contemplation pipeline per interpretation pool**, although the maintenance requests *within* one maintenance batch are parallel.
- A prefetch that returns both flags runs **maintenance → generation → one experiment review if indicated**.
- If the user sends more messages while a contemplation cycle runs, **coalesce** them into a later cycle that covers all newly available evidence; do not create one full backlog item per message. Use a persisted or safely tracked processed message watermark so nothing is permanently skipped.
- Contemplation continues after the browser closes as long as the Node.js process is running. A server restart should recover/reevaluate pending work safely; avoid duplicate commits.
- Use revisions/snapshots to guard against out-of-order or stale LLM results. Writes to interpretation/experiment pools are atomic. When a request fails after retries, leave the last valid state intact, record diagnostics and permit later/forced recovery. Avoid starvation of dialogue by contemplation.

## 6. Dialogue generation and initiative

### 6.1 Normal response

On user send, immediately persist the message and start the **Dialogue model**, without waiting for any contemplation prefetch, maintenance, generation or experiment planning. The model sees a **snapshot** of the current active experiments. A later experiment update is visible on the *next* dialogue request, never retroactively in a running request.

The dialogue model returns a structured envelope (validate and repair if malformed):

```json
{
  "message": "*sits beside you* Let me tell you something.",
  "followUpDelaySeconds": 45,
  "imageRequest": null
}
```

`message` is ordinary character speech/action text; `followUpDelaySeconds` is **an integer count of seconds or `null`**; `imageRequest` is null or a short description/prompt and context for a single image-generation subagent request. The model chooses its own tone according to its character description. Do not force positive tone, therapy, filtering or mandatory questions.

Show a loading indicator while waiting and display the **whole completed answer** (no token streaming). The user can **continue typing while generation is in progress**, but submission by button and Enter is disabled until the current response succeeds or fails. Keep unsent draft text intact.

If all retries fail, leave the user message in history and show an error with **Retry response** (without sending a duplicate user message). There is no general Stop button. If a user switches characters while a response is generating, finish and persist that response to the original chat in the background.

### 6.2 Follow-up scheduling

- **Zero follow-up:** when a user opens an entirely empty chat, start a **60-second** idle timer. If still open, no typing has started, and no message was sent, generate one unsolicited opening message. Then wait for the user. It is displayed exactly like any other character message.
- For a **normal reply to a user message**, start a timer for `followUpDelaySeconds` **after that answer is committed**; `null` schedules nothing.
- If the timer fires while that chat is still actively open and idle, invoke the Dialogue model for **one autonomous follow-up message**. This request does **not** schedule another timer, regardless of any follow-up value returned; no endless self-dialogue.
- **Cancel** the timer when the user starts typing (not just on Send), sends a message, switches away from that chat, closes the page, or disconnects. Do not reinstate a canceled/expired timer when the chat is reopened. The zero follow-up follows the same cancellation rules.
- Ordinary generation can complete in the background after switching chats, but it must **not** schedule a follow-up for an inactive chat.
- Follow-up messages are stored as normal character messages and count as regular dialogue evidence for memory and later contemplation; do not visually mark them as special.
- Guard timer races server-side: a stale timer or simultaneous Send must not create an extra follow-up or clobber another reply. The server must know whether the chat is actively open (a modest presence/heartbeat mechanism is fine); do not rely solely on a browser-side timer.

## 7. Images — Dialogue-only subagent

- Global enable/disable and separately selected image model, using Society's image-generation/provider integration as a starting point.
- When enabled, the Dialogue model **may** request an image autonomously, including to carry out an experiment intent. No user confirmation is needed. When disabled, the tool is absent/inoperable.
- Treat this as a **Dialogue feature**: the image generation subagent receives a prompt/scene context composed by the Dialogue model, **not** raw interpretation texts or direct instructions from Contemplation. There is no image-analysis or user-image-upload feature.
- **Asynchronous:** commit/show the dialogue text immediately, render a pending-image placeholder, generate in a background job, then attach the finished image to the originating character message. Other chats and subsequent text messages remain usable. On failure show an image-specific error without deleting the text message.
- Store image files under `/app/data/images/`, with relative metadata in SQLite. If the provider yields a temporary URL, download and persist the actual bytes. Enforce reasonable format, size and source checks following Society practice.
- No standalone gallery, voice input/STT or TTS in PoC.

## 8. OpenRouter reliability and diagnostics

- Follow Society-style provider integration, model selection, per-request visibility and appropriate transport timeouts.
- On transient errors, rate limiting (`429`), timeouts and `5xx`, use bounded retries with backoff. Do not infinitely retry or silently switch to an unselected paid model.
- Structured model outputs must be schema-validated. On malformed JSON, wrong types, incomplete output or truncation, attempt **LLM repair** with bounded retries; do not commit malformed output. Plain dialogue text is extracted from the validated response envelope.
- A failed memory, contemplation or image job must not corrupt previously committed state. Errors are captured for diagnostic dumps and exposed in status indicators.
- Adapt **Society's Emergency Dump** as a persistent UI escape hatch: best-effort downloadable ZIP containing application state snapshots, chats, memory, interpretations, experiments, relevant model request/response diagnostics (including failures and in-flight work metadata), exception traces and source/build identification where available. The dump must remain callable during other busy operations and must not modify state or cancel them. **Redact the OpenRouter key and other secrets from all entries**, including raw exchanges and headers. Do not introduce a full diagnostic-log UI.
- An activity/status API should expose pending/running/error status per stage and per model, including parallel maintenance request counts. Reuse Society's UI approach.

## 9. Privacy, policy and explicit non-goals

This is an **owner-operated local PoC**, not a hosted service. It intentionally has **no account system, auth workflow, GDPR UI, data-export/delete-account workflow, content-compliance layer, NSFW filter, disclosure banner or model-response moderation pipeline** of its own. The underlying OpenRouter providers may still enforce their own policies. Do not build an extra custom moderation layer in Beholder under this spec.

Nevertheless, standard engineering safeguards still apply: API keys never leave process memory except outbound to OpenRouter, no key in dumps/logs/storage, no HTML injection from model/user content, no arbitrary file-path requests, limits on payloads, atomic persistence, and operation failure isolation. The HTTP-only, no-auth build is for a trusted LAN, not the internet. Do not add public deployment capabilities or a key-vault sidecar in PoC.

**Not in 0000:** accounts; cloud hosting; HTTPS/PWA; public release; voice recognition or speech generation; user-provided image understanding; editing/deleting/regenerating previous chat messages; deleting characters; advanced tuning per sub-process or character; a formal ontology/confidence system for interpretations; manual moderation; analytics dashboard; experiment result archives; general workflow builders; forced stop buttons; unlimited autonomous self-messaging.

## 10. Delivery / project organization

- Create a self-contained new Beholder Node.js project with source, minimal responsive frontend, schema/migrations, Dockerfile, `docker-compose.yml`, README, basic checks and automated tests.
- Build/run via Compose. Mount `./data:/app/data`; SQLite and images must survive container recreation. Publish one configurable local/LAN HTTP port. The key must not survive Node.js process restart.
- Follow Society's style of **English-language code contracts**, named LLM purposes, explicit validators, safe staged state mutation and diagnostically useful failures, without copying its application domain.
- Document how to start, enter the key, select three models, create a character, and test contemplation; reference Society source locations actually reused. Avoid modifying the Society repository.
- Preserve readable source for each distinct LLM prompt: dialogue, contemplation prefetch, maintenance, generation, experiment review, memory consolidation and necessary repair prompts. Prompt text may be in code. Add tests with mocked OpenRouter calls; live provider spending is **not required** for completion.
- Prioritize a **working vertical slice** over abstract frameworks or cosmetic refinement. An implementer may choose framework/libraries provided the above behavior remains intact.

## 11. Minimum acceptance scenarios

Each item below should be covered by automated tests where feasible and/or a short manual smoke procedure. No paid live evaluation is necessary for acceptance.

1. **New local start:** Compose starts; in-browser key entry works. Restart requires re-entry; SQLite and images remain. Key cannot be found in database, browser storage, logs or dump.
2. **Character scope:** create two characters, vary each of the two scope flags independently; shared pools expose updates as designed; private pools remain separate; switching flags preserves both pools.
3. **Description:** the current character prompt and pinned user self-description are included in model context; the self-description is not repeatedly ingested as new evidence.
4. **Dialogue:** user submits text containing `*actions*`; full model answer renders safely with action styling. While pending, the input stays editable, Send is disabled, and the typed draft survives.
5. **Memory threshold:** at 100 active literal messages the 20 oldest enter Society-derived STM processing and only disappear from active verbatim after successful validated commit; the newest 80 remain. Failures preserve source observations and visible chat history.
6. **LTM boundary:** once per server-local day, STM→LTM executes. If the server misses midnight, restart catches up safely without double consolidating. Uses Dialogue model.
7. **Prefetch:** every user message schedules prefetch with exactly the interpretation pool and the available last 100 verbatim messages (no consolidated memory). Flags are independent and validated.
8. **Both flags:** on `generation=true, maintenance=true`, maintenance processes every interpretation separately and concurrently; the generation request sees the post-maintenance pool; experiment review executes once against the final relevant state.
9. **Interpretation quality:** generator produces new free-form prose or declines; variants need not be mutually consistent, but maintenance/generation must not assert known contradictions as facts. Manual Force actions and text edits work.
10. **Experiments:** after an interpretation change, the planner sees all interpretations plus current experiments and returns a replacement array. The Dialogue model receives **only active intentions**, not interpretations. A completed experiment can be removed through maintenance/experiment reconsideration without extra results storage.
11. **Concurrency:** contemplation does not delay speaking; maintenance locks experiment review, not dialogue. Multiple new user messages during a slow contemplation run are coalesced into a later cycle without loss; stale work cannot overwrite newer state.
12. **Follow-up:** an empty open chat produces at most one opener at 60 seconds. After a normal reply, integer seconds or null controls one optional follow-up. Typing, navigation, disconnect or an incoming message cancels it. Follow-ups cannot chain and are not visually distinguished.
13. **Image generation:** model-requested image starts asynchronously when enabled; text shows first, image arrives later and persists to file. Disabled tool does nothing. Switching chats does not lose pending image work.
14. **Recovery:** invalid JSON triggers repair and never corrupts state. Transport failures retry with bounds. Final dialogue failure leaves the user message and allows a single **Retry response** without duplication.
15. **Diagnostics:** activity indicators reflect ongoing dialogue, background contemplation and individual maintenance calls; Emergency Dump works while busy and contains useful sanitized context.
16. **Android:** all core screens and typing behavior work at narrow mobile viewport widths on an Android browser over the LAN (no PWA/HTTPS requirement).

## 12. Implementation judgment / questions

Avoid blocking implementation for trivial choices (schema names, frontend framework, index selection, queue representation, basic timeout constants). Choose simple defaults and note them in README. **Escalate only a genuine contradiction with a requirement above or an unavoidable provider capability constraint.** This is Specification **0000**; defer scope expansion to a later, explicitly approved spec.
