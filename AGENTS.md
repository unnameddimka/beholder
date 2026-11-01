# Beholder repository instructions

These instructions apply to this repository and **override** any `AGENTS.md` in parent directories. The parent
folder's file describes a different project (a SugarCube RPG) and does not apply here.

## Scope

- The authoritative requirements are `docs/specs/0000-beholder-poc.md`. Implement only what an approved spec says.
  Scope expansion needs a new, explicitly approved spec.
- Society (`../society/society`) is a read-only implementation donor. Never modify it.

## Invariants

- The OpenRouter key lives only in Node.js process memory (`RuntimeKey`). Never persist, log, or return it, or put it
  in browser storage, dumps, or diagnostics. Sanitize every diagnostic entry.
- The Dialogue model receives the active experiment intentions, but **never interpretation texts**. Image prompts come
  only from the Dialogue model.
- The prefetch input is exactly the whole interpretation pool plus up to the last 100 verbatim messages of the
  triggering chat. No consolidated memory.
- Experiment planning input is only the interpretation pool and the active experiment array. Its output replaces the
  whole array atomically, guarded by interpretation and experiment revisions.
- A maintenance batch applies all-or-nothing. Maintenance, then generation, then at most one experiment review. One
  serial pipeline per interpretation pool. Contemplation never blocks dialogue.
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
