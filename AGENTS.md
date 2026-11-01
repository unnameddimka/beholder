# Beholder repository instructions

These instructions apply to this repository and **override** any `AGENTS.md` in parent directories. The parent
folder's file describes a different project (a SugarCube RPG) and does not apply here.

## Scope

- The authoritative requirements are `docs/specs/0000-beholder-poc.md`, amended by specs 0001 and 0002 in
  `docs/specs/`. Implement only what an approved spec says. Scope expansion needs a new, explicitly approved spec.
- Society (`../society/society`) is a read-only implementation donor. Never modify it.

## Invariants

- The OpenRouter key lives only in Node.js process memory (`RuntimeKey`). Never persist, log, or return it, or put it
  in browser storage, dumps, or diagnostics. Sanitize every diagnostic entry.
- The Dialogue model receives the pool's gestalt and the active experiment intentions (both only while Contemplation
  is enabled), but **never interpretation texts**. Image prompts come only from the Dialogue model.
- Gestaltization input is only every current interpretation of the pool and the previous gestalt. It never changes
  interpretations or experiments, commits only against the interpretation revision it read, and its failure never
  blocks experiment review or dialogue. One gestalt per interpretation pool; no history of old gestalts.
- The Contemplation page is read-only: it must not expose or call any mutation or Force route.
- Every text Chat Completions request carries the provider ignore list (`PROVIDER_IGNORE`, including `baidu`).
- The prefetch input is exactly the whole interpretation pool, up to the last 100 verbatim messages of the
  triggering chat, and the pool's active experiment intentions (possibly empty). No consolidated memory.
- Experiment planning input is only the interpretation pool and the active experiment array. Its output replaces the
  whole array atomically, guarded by interpretation and experiment revisions.
- A maintenance batch applies all-or-nothing. Maintenance, then generation, then gestaltization (only when the
  interpretation revision changed), then at most one experiment review. One serial pipeline per interpretation pool.
  Contemplation never blocks dialogue.
- Verbatim→STM consumes the 20 oldest of 100 active messages. Messages leave the active window only on a validated
  commit. The visible transcript is immutable.
- Memory consolidation and dialogue retrieval use the Dialogue model. Contemplation purposes use the Contemplation model.
- Structured model output is validated, then repaired by the LLM within bounds, and never committed when invalid.
- All multi-row writes run in one SQLite transaction (`Store.tx`).
- Model and user text is rendered as text nodes only (`public/text-render.js`). Never use `innerHTML` with content.
- Keep each LLM prompt as readable source in `src/prompts/`.

## Layout

- `src/server.js`: HTTP routes. `src/app.js`: composition. `src/db.js`: schema, migrations, store.
- `src/dialogue.js`, `src/contemplation.js`, `src/memory.js`, `src/images.js`: subsystems.
- `src/openrouter.js`, `src/llm.js`: transport and named purposes. `src/dump.js`, `src/diagnostics.js`.
- `public/`: browser UI. `tests/`: `node:test` suites with a mocked OpenRouter.

## Before completion

1. `npm test` (syntax check of every `.js` file, then all tests). Live provider calls are not required.
2. Update `README.md` when behavior, defaults, or limitations change.
