// Specification 0006 section 5 / acceptance 17-23: golden request traces. Each scenario drives the real app against a
// deterministic mocked OpenRouter and records every outgoing Chat Completions request (purpose, model, parameters,
// message bytes and order) plus the resulting persisted cognitive state. The fixture was recorded at baseline 4ff65df
// before the Contemplation refactoring, which matched it byte for byte. It was re-recorded once for Specification 0006
// S, where the only differences are the system messages of consolidation, maintenance, generation, its review and
// gestaltization (S1-S6) and the gestalt section of the Dialogue system prompt (S6). Any other difference is a
// regression; an intended change is re-recorded with BEHOLDER_RECORD_GOLDEN=1 and justified by its spec clause.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeApp, closeApp, waitFor, reply, seedMessages, ROOT, configure } from "./helpers.js";
import { createServer } from "../src/server.js";
import { poolOf, characterPool } from "../src/db.js";

const FIXTURE = path.join(ROOT, "tests", "fixtures", "golden-traces.json");
const RECORD = process.env.BEHOLDER_RECORD_GOLDEN === "1";
const base = { name: "Mira", description: "Keeper of the archive.", sceneDescription: "A rainy harbour town.", userDescription: "A traveller." };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

// Wall-clock values are the only nondeterministic request content: ISO instants, localized clock labels, and
// elapsed-time phrases derived from them.
function normalize(text) {
  return text
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z/g, "<iso>")
    .replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}/g, "<local>")
    .replace(/\b(?:less than a minute|\d+ (?:minute|hour|day)s?(?: \d+ (?:minute|hour)s?)?)\b/g, "<elapsed>");
}

// Dialogue (with memory and Vision) and Contemplation are independent pipelines whose requests may interleave in any
// order (acceptance 18); the exact order is compared within each lane.
const lane = (purpose) => purpose.startsWith("contemplation_") ? 1 : 0;
const traceOf = (mock) => mock.calls.map((call) => JSON.parse(normalize(JSON.stringify({ purpose: call.purpose, body: call.body }))))
  .map((call, index) => ({ call, index })).sort((a, b) => lane(a.call.purpose) - lane(b.call.purpose) || a.index - b.index).map(({ call }) => call);

function stateOf(app, pool) {
  const state = app.store.ensureInterpretationPool(pool);
  const last = state.lastMaintenance ? { ...state.lastMaintenance, startedAt: undefined, finishedAt: undefined } : null;
  return JSON.parse(normalize(JSON.stringify({
    interpretations: app.store.interpretations(pool).map((entry) => ({ id: entry.id, text: entry.text })),
    experiments: app.store.experiments(pool).map((entry) => ({ id: entry.id, text: entry.text })),
    gestalt: state.gestalt, gestaltRevision: state.gestaltRevision, interpretationRevision: state.interpretationRevision,
    experimentRevision: state.experimentRevision, planningNeeded: state.planningNeeded, lastMaintenance: last
  })));
}

const wireOf = (body) => JSON.parse(body.messages[1].content);

// ---- scenarios ------------------------------------------------------------------------------------------------

// A full automatic cycle: retrieval, reply, prefetch with both flags, consolidation with a merge and one JSON repair,
// parallel maintenance (replace, delete, unchanged, experiment completion), generation rejected once then accepted,
// gestaltization, and experiment planning.
async function automaticCycle() {
  const { app, mock } = await makeApp({
    dialogue_memory_retrieval: (body) => ({ stmIds: wireOf(body).catalog.shortTermMemories.slice(0, 1).map((m) => m.id), ltmIds: [] }),
    dialogue_reply: () => reply("The tide is high tonight."),
    contemplation_prefetch: () => ({ generation: true, maintenance: true }),
    contemplation_memory_retrieval: (body) => ({ stmIds: wireOf(body).catalog.shortTermMemories.slice(0, 1).map((m) => m.id), ltmIds: [] }),
    contemplation_consolidation: (body, { count }) => {
      if (count === 1) return "not json at all";
      const ids = wireOf(body).interpretations.map((entry) => entry.id);
      return { interpretations: [
        { id: ids[0], sourceIds: [ids[0], ids[1]], text: "A careful collector of lost things who distrusts endings." },
        { id: ids[2], sourceIds: [ids[2]], text: "Someone escaping a crowded family house." },
        { id: ids[3], sourceIds: [ids[3]], text: "A retired lighthouse keeper's daughter." }
      ] };
    },
    contemplation_maintenance: (body) => {
      const payload = wireOf(body);
      const text = payload.interpretation.text;
      if (text.startsWith("A careful")) return { action: "replace", text: "A careful collector of lost things who distrusts endings and keeps every ticket stub.", completedExperimentIds: [payload.activeExperiments[0].id] };
      if (text.startsWith("Someone")) return { action: "delete", text: null, completedExperimentIds: [] };
      return { action: "unchanged", text: null, completedExperimentIds: [] };
    },
    contemplation_generation: (body, { count }) => ({ decision: "add", text: count === 1 ? "A rephrasing of the collector." : "A night-shift nurse who talks to strangers to stay awake." }),
    contemplation_generation_review: (body, { count }) => count === 1 ? { accept: false, problem: "Not distinct from the collector." } : { accept: true, problem: null },
    contemplation_gestaltization: () => ({ gestalt: "One person seen as a collector, a keeper's daughter and a night nurse at once." }),
    contemplation_experiment_planning: (body) => ({ experiments: [{ id: wireOf(body).activeExperiments[0]?.id ?? null, text: "Mention a night shift." }, { id: null, text: "Tell an absurd story about a ticket." }] })
  });
  try {
    const mira = app.createCharacter(base);
    const pool = poolOf(mira);
    configure(app, mira.id, { contemplationEnabled: false });
    for (const text of ["A collector of lost things.", "Someone who keeps lost objects and hates endings.", "Someone escaping a crowded family house.", "A retired lighthouse keeper's daughter."]) app.contemplation.addInterpretation(pool, text);
    app.contemplation.addExperiment(pool, "Ask about the ticket stub.");
    app.contemplation.addExperiment(pool, "Mention the lighthouse.");
    app.store.setPlanningNeeded(pool, false);
    app.store.setGestalt(pool, "An earlier gestalt.", app.store.ensureInterpretationPool(pool).interpretationRevision);
    app.store.insertMemory({ pool: characterPool(mira.id), tier: "stm", topic: "Tickets", summary: "The user keeps old tickets.", retrievalBrief: "tickets", importance: 0.6, sources: [{ characterId: mira.id, characterName: "Mira", messageIds: [1] }], scopeCharacterId: mira.id });
    app.store.insertMemory({ pool: characterPool(mira.id), tier: "ltm", topic: "Harbour", summary: "They met at the harbour.", retrievalBrief: "harbour", importance: 0.5, sources: [] });
    seedMessages(app, mira.id, 6);
    configure(app, mira.id, { contemplationEnabled: true });
    app.dialogue.send(mira.id, "I kept the ticket from that night.");
    await waitFor(() => app.contemplation.status(pool).lastCycle?.status === "succeeded", { message: "cycle" });
    await app.contemplation.idle(pool);
    return { trace: traceOf(mock), state: stateOf(app, pool) };
  } finally { closeApp(app); }
}

// Explicit Force with automatic Contemplation off: Maintenance (identity, unchanged), Generation (declined), and
// Experimentation, each with its follow-up gestaltization/planning consequences.
async function forcedRuns() {
  const { app, mock } = await makeApp({
    contemplation_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    contemplation_consolidation: (body) => ({ interpretations: wireOf(body).interpretations.map((entry) => ({ id: entry.id, sourceIds: [entry.id], text: entry.text })) }),
    contemplation_maintenance: () => ({ action: "unchanged", text: null, completedExperimentIds: [] }),
    contemplation_generation: () => ({ decision: "decline", text: null }),
    contemplation_gestaltization: () => ({ gestalt: "Forced gestalt." }),
    contemplation_experiment_planning: () => ({ experiments: [{ id: null, text: "Offer tea." }] })
  });
  try {
    const mira = app.createCharacter(base);
    const pool = poolOf(mira);
    configure(app, mira.id, { contemplationEnabled: false });
    app.contemplation.addInterpretation(pool, "A quiet cartographer.");
    app.contemplation.addInterpretation(pool, "A loud sailor in disguise.");
    seedMessages(app, mira.id, 4);
    const outcomes = [];
    for (const kind of ["maintenance", "generation", "experimentation"]) {
      outcomes.push(app.contemplation.force(pool, kind, mira.id));
      await app.contemplation.idle(pool);
    }
    const force = app.contemplation.status(pool).force;
    const results = Object.fromEntries(Object.entries(force).map(([kind, entry]) => [kind, { state: entry.state, status: entry.last?.status ?? null, result: entry.last?.result ?? null }]));
    return { trace: traceOf(mock), state: stateOf(app, pool), outcomes, results };
  } finally { closeApp(app); }
}

// An experiment edited while a verifier is held: the verified result is discarded as stale and nothing is written.
async function staleMaintenance() {
  let app;
  const setup = await makeApp({
    contemplation_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    contemplation_consolidation: (body) => ({ interpretations: wireOf(body).interpretations.map((entry) => ({ id: entry.id, sourceIds: [entry.id], text: `${entry.text} (rewritten)` })) }),
    contemplation_maintenance: (body) => {
      const pool = poolOf({ id: 1 });
      app.contemplation.editExperiment(pool, app.store.experiments(pool)[0].id, "Edited while verifying.");
      return { action: "unchanged", text: null, completedExperimentIds: [wireOf(body).activeExperiments[0].id] };
    }
  });
  app = setup.app;
  try {
    const mira = app.createCharacter(base);
    const pool = poolOf(mira);
    configure(app, mira.id, { contemplationEnabled: false });
    app.contemplation.addInterpretation(pool, "A beekeeper.");
    app.contemplation.addExperiment(pool, "Mention honey.");
    seedMessages(app, mira.id, 2);
    app.contemplation.force(pool, "maintenance", mira.id);
    await app.contemplation.idle(pool);
    // Planning/gestalt follow-ups are not mocked; their failure is reported beside the completed Maintenance.
    return { trace: traceOf(setup.mock).filter((call) => call.purpose.startsWith("contemplation_m") || call.purpose === "contemplation_consolidation"), state: stateOf(app, pool) };
  } finally { closeApp(app); }
}

// Verbatim -> STM at 100 messages, then STM -> LTM on the next local date.
async function memoryConsolidation() {
  let now = new Date(2026, 9, 30, 15, 0, 0);
  const { app, mock } = await makeApp({
    memory_stm_consolidation: (body) => {
      const payload = wireOf(body);
      return { shortTermMemoriesToUpsert: [], shortTermMemoriesToAdd: [{ topic: "Early chat", summary: "The user greeted Mira many times.", retrievalBrief: "greetings", importance: 0.4, sourceMessageIds: payload.consumedMessageIds.slice(0, 3), contextStmIds: [] }], stmRepartitions: [] };
    },
    memory_ltm_selection: () => ({ relevantLtmIds: [], contextStmIds: [] }),
    memory_ltm_consolidation: (body) => {
      const ids = wireOf(body).consumableShortTermMemories.map((view) => view.id);
      return { longTermMemoriesToUpsert: [], longTermMemoriesToAdd: [{ ref: "new_ltm_1", topic: "Day", summary: "Many greetings.", retrievalBrief: "day", importance: 0.6, sourceStmIds: ids, sourceLtmIds: [] }],
        retirementGroups: [{ stmIds: ids, disposition: "represented", representedByLtmRefs: ["new_ltm_1"] }] };
    }
  }, { appOptions: { now: () => now } });
  try {
    const mira = app.createCharacter(base);
    seedMessages(app, mira.id, 100);
    await app.memory.maybeConsolidate(mira.id);
    now = new Date(2026, 9, 31, 9, 30, 0);
    await app.memory.runDailyIfDue();
    const records = app.store.memoryRecords(characterPool(mira.id)).map((record) => ({ tier: record.tier, topic: record.topic, summary: record.summary }));
    return { trace: traceOf(mock), records, active: app.store.activeCount(mira.id) };
  } finally { closeApp(app); }
}

// An image turn over HTTP: Vision with the gestalt, then a Dialogue reply with gestalt and experiments, including one
// Dialogue envelope repair.
async function imageTurn() {
  const { app, mock } = await makeApp({
    vision_observation: () => "The image shows a paper ticket with a torn corner on a wooden table.",
    dialogue_memory_retrieval: () => ({ stmIds: [], ltmIds: [] }),
    dialogue_reply: (body, { count }) => count === 1 ? "{\"message\": " : reply("What a well-kept ticket."),
    contemplation_prefetch: () => ({ generation: false, maintenance: false })
  });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const mira = app.createCharacter(base);
    const pool = poolOf(mira);
    configure(app, mira.id, { contemplationEnabled: false });
    app.contemplation.addInterpretation(pool, "A collector of lost things.");
    app.contemplation.addExperiment(pool, "Ask where the ticket is from.");
    app.store.setPlanningNeeded(pool, false);
    app.store.setGestalt(pool, "A collector, perhaps.", app.store.ensureInterpretationPool(pool).interpretationRevision);
    configure(app, mira.id, { contemplationEnabled: true });
    seedMessages(app, mira.id, 2);
    const form = new FormData();
    form.append("text", "Look what I found.");
    form.append("timeZone", "Europe/Kyiv");
    form.append("image", new Blob([PNG], { type: "image/png" }), "ticket.png");
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/characters/${mira.id}/messages`, { method: "POST", body: form });
    assert.equal(response.status, 200);
    await waitFor(() => app.store.lastTurn(mira.id).role === "character", { message: "reply" });
    await app.contemplation.idle(pool);
    return { trace: traceOf(mock), state: stateOf(app, pool) };
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeApp(app);
  }
}

const SCENARIOS = { automaticCycle, forcedRuns, staleMaintenance, memoryConsolidation, imageTurn };

// ---- comparison ---------------------------------------------------------------------------------------------------

if (RECORD) {
  test("record golden traces", async () => {
    const recorded = {};
    for (const [name, run] of Object.entries(SCENARIOS)) recorded[name] = await run();
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, 1)}\n`);
  });
} else {
  const golden = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  for (const [name, run] of Object.entries(SCENARIOS)) {
    test(`golden trace: ${name} matches the recorded requests and state`, async () => {
      const actual = await run();
      assert.ok(golden[name], `no recorded golden trace for ${name}`);
      // Purposes first, so a reordering is reported before byte differences.
      assert.deepEqual(actual.trace.map((call) => call.purpose), golden[name].trace.map((call) => call.purpose));
      assert.deepEqual(actual, golden[name]);
    });
  }
}


