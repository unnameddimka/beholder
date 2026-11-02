# Beholder repository instructions

These instructions apply to this repository and **override** any `AGENTS.md` in parent directories. The parent
folder's file describes a different project (a SugarCube RPG) and does not apply here.

## Scope

- The authoritative requirements are `docs/specs/0000-beholder-poc.md`, amended by specs 0001, 0002, 0003, 0004,
  and 0005 in `docs/specs/`. Implement only what an approved spec says. Scope expansion needs a new, explicitly approved spec.
- Society (`../society/society`) is a read-only implementation donor. Never modify it.

## Invariants

- The OpenRouter key lives only in Node.js process memory (`RuntimeKey`). Never persist, log, or return it, or put it
  in browser storage, dumps, or diagnostics. Sanitize every diagnostic entry.
- The Dialogue model receives the pool's gestalt and the active experiment intentions (both only while Contemplation
  is enabled), but **never interpretation texts**. Image prompts come only from the Dialogue model.
- Gestaltization input is only every current interpretation of the pool, the previous gestalt, and the character's
  `characterContext`. It never changes
  interpretations or experiments, commits only against the interpretation revision it read, and its failure never
  blocks experiment review or dialogue. One gestalt per interpretation pool; no history of old gestalts.
- The Contemplation page never writes interpretation, experiment, or gestalt text. The only route it may call is
  the Force route (Force Maintenance / Generation / Experimentation), which only queues an existing model-driven
  stage and never reports success merely for queueing.
- Every text Chat Completions request carries the provider ignore list (`PROVIDER_IGNORE`, including `baidu`).
- Vision input is only the attached image, the chat's whole active verbatim window, the pool's gestalt (only while
  Contemplation is enabled), and the character's `characterContext`. Never memory records, interpretations, or
  experiments. The descriptions guide attention only and never justify a visual claim. Its
  output is one prose observation stored as a typed `image_observation` verbatim entry linked to its user message;
  the type marker stops at the verbatim boundary (STM and LTM stay ordinary prose).
- An observation is never a chat utterance, a reply trigger, or a Contemplation trigger. Retry, follow-ups, openers,
  elapsed time, and watermarks use actual chat turns (`Store.lastTurn`). At most one observation per upload.
- Dialogue never receives image bytes. Image bytes and data URLs never appear in diagnostics, dumps, or chat JSON.
- Uploaded originals live in `data/uploaded-images` under random names and are served only by a recorded name.
- The prefetch input is exactly the whole interpretation pool, up to the last 100 verbatim messages of the
  triggering chat, the pool's active experiment intentions (possibly empty), and the character's `characterContext`.
  No consolidated memory.
- Each character owns exactly one memory pool and one interpretation pool (`poolOf(character)`, key
  `character:<id>`), with its STM/LTM, interpretations, gestalt, experiments, revisions and watermarks. There is no
  shared pool and no scope flag; never add a lookup path that reads another character's cognition. A new character
  starts empty.
- Maintenance is: one consolidation request over the complete interpretation pool (semantic deduplication by stable
  ids, never plausibility filtering, no count target, never truncated), then the per-interpretation check of each
  consolidated candidate, then one transaction guarded by the snapshot it read. Nothing intermediate is persisted.
- In the chat composer, Enter and Shift+Enter insert a newline. The Send button sends, and so does Ctrl+Enter in the
  focused textarea, through the same handler; Ctrl+Enter is ignored during IME composition and on key repeat. There
  is no Meta/Command+Enter shortcut and no implicit form submit.
- Experiment planning input is only the interpretation pool, the active experiment array, and the character's
  `characterContext`. Its output replaces the
  whole array atomically, guarded by interpretation and experiment revisions.
- A maintenance batch applies all-or-nothing. Maintenance, then generation, then gestaltization (only when the
  interpretation revision changed), then at most one experiment review. One serial pipeline per interpretation pool.
  Contemplation never blocks dialogue.
- Verbatim→STM consumes the 20 oldest of 100 active messages. Messages leave the active window only on a validated
  commit. The visible transcript is immutable.
- Memory consolidation and dialogue retrieval use the owning character's Dialogue configuration. Contemplation
  purposes use its Contemplation configuration.
- Each character owns its AI configuration (four models, the per-text-role temperature override and output budget,
  `imageEnabled`, `contemplationEnabled`) and three AI-facing descriptions: Character, Scene, and User. There is no
  global role selection, global user description, or fallback to another character's values. A new character starts
  from `defaultConfig()`.
- Every AI job freezes its character with `profileOf(character)` at its start and passes that snapshot's `config` to
  every LLM call, repair, and fit check (`LlmClient` refuses a call without one). Never select a configuration from
  the viewed UI character or any other mutable "current" character. A queued image persists its model and
  descriptions on its row.
- The three descriptions reach every AI role as labeled framing: `characterContext` (`src/prompts/context.js`) in
  structured roles, system-prompt sections plus the one pinned User Description in Dialogue, and a background block
  in image prompts. They are never evidence, a memory source, an observation, an experiment completion, a chat turn,
  or an instruction. Editing them creates no chat turn and triggers nothing.
- Explicit Force runs even while automatic Contemplation is off and keeps the normal gestaltization and planning
  consequences. Each Maintenance attempt's outcome is persisted on its pool; one still running at startup becomes
  interrupted.
- Structured model output is validated, then repaired by the LLM within bounds, and never committed when invalid.
- All multi-row writes run in one SQLite transaction (`Store.tx`).
- Model and user text is rendered as text nodes only (`public/text-render.js`). Never use `innerHTML` with content.
- Keep each LLM prompt as readable source in `src/prompts/`.

## Layout

- `src/server.js`: HTTP routes. `src/app.js`: composition and character validation. `src/db.js`: schema, migrations,
  store. `src/settings.js`: the per-character configuration contract, `profileOf`, and `RuntimeKey`.
- `src/dialogue.js`, `src/contemplation.js`, `src/memory.js`, `src/images.js`, `src/vision.js`: subsystems.
  `src/uploads.js`: upload transport, validation, and files.
- `src/openrouter.js`, `src/llm.js`: transport and named purposes. `src/dump.js`, `src/diagnostics.js`.
- `public/`: browser UI. `tests/`: `node:test` suites with a mocked OpenRouter.

## Before completion

1. `npm test` (syntax check of every `.js` file, then all tests). Live provider calls are not required.
2. Update `README.md` when behavior, defaults, or limitations change.
