// Beholder browser UI: a small hash-routed single page app. All server text is inserted with textContent or the
// action renderer, never as HTML. The API key is sent once to the server and never stored in the browser.
import { renderMessageText } from "/text-render.js";

const $ = (id) => document.getElementById(id);
const els = { view: $("view"), title: $("page-title"), back: $("back-button"), activity: $("activity"), activityLabel: $("activity-label"), banner: $("error-banner") };
const POLL_MS = 1500;
const HEARTBEAT_MS = 5000;
const TYPING_THROTTLE_MS = 2000;

const state = {
  status: null,
  activity: null,
  characters: [],
  drafts: new Map(),
  clientId: randomId(),
  view: null,
  typingSentAt: 0
};

function randomId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- DOM helpers -----------------------------------------------------------------------------------------------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "className") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "value") el.value = value;
    else if (key in el && typeof value !== "string") el[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return el;
}

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(path, { method, headers: body !== undefined ? { "Content-Type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload?.error?.message || `HTTP ${response.status}`), { code: payload?.error?.code, status: response.status });
  return payload;
}

function showBanner(message) {
  els.banner.textContent = message;
  els.banner.classList.toggle("hidden", !message);
  if (message) setTimeout(() => { if (els.banner.textContent === message) showBanner(""); }, 6000);
}

function formatTime(iso) {
  try { return new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" }); } catch { return ""; }
}

function poolLabel(pool, characters = state.characters) {
  if (pool === "shared") return "Shared pool";
  const id = Number(String(pool).split(":")[1]);
  const owner = characters.find((character) => character.id === id);
  return `Private pool of ${owner ? owner.name : `character ${id}`}`;
}

window.addEventListener("error", (event) => reportFrontendError(event.message, event.error?.stack));
window.addEventListener("unhandledrejection", (event) => reportFrontendError(String(event.reason?.message || event.reason), event.reason?.stack));
function reportFrontendError(message, stack) {
  fetch("/api/frontend-error", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, stack, page: location.hash }) }).catch(() => {});
}

// ---- presence ------------------------------------------------------------------------------------------------

// The device's IANA time zone for the Dialogue model's clock context; the server validates it and falls back to UTC.
function browserTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}

function currentChatId() { return state.view?.kind === "chat" && document.visibilityState === "visible" ? state.view.characterId : null; }

function sendPresence(extra = {}) {
  const characterId = currentChatId();
  const draft = characterId ? (state.drafts.get(characterId) || "") : "";
  return fetch("/api/presence", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: state.clientId, characterId, draftNonEmpty: draft.trim().length > 0, timeZone: browserTimeZone(), ...extra }) }).catch(() => {});
}

setInterval(() => sendPresence(), HEARTBEAT_MS);
document.addEventListener("visibilitychange", () => sendPresence());
window.addEventListener("pagehide", () => navigator.sendBeacon?.("/api/presence/leave", new Blob([JSON.stringify({ clientId: state.clientId })], { type: "application/json" })));

// ---- activity ------------------------------------------------------------------------------------------------

async function pollActivity() {
  try {
    state.activity = await api("/api/activity");
    renderActivity();
  } catch { /* best effort */ }
}

function renderActivity() {
  const activity = state.activity;
  if (!activity) return;
  const pending = Object.values(activity.roles).reduce((sum, role) => sum + role.pendingCount, 0);
  const recentError = activity.recentErrors.find((entry) => Date.now() - Date.parse(entry.at) < 60_000);
  els.activity.classList.toggle("working", activity.working);
  els.activity.classList.toggle("has-error", Boolean(recentError) && !activity.working);
  els.activityLabel.textContent = activity.working ? `Working${pending ? ` (${pending})` : ""}` : recentError ? "Error" : "Idle";
  els.activity.title = [
    ...Object.entries(activity.roles).map(([role, info]) => `${role}: ${info.working ? `${info.pendingCount} running (${info.purposes.join(", ")})` : "idle"}${info.lastError ? ` - last error: ${info.lastError.message}` : ""}`),
    ...activity.contemplation.filter((pool) => pool.running).map((pool) => `contemplation ${pool.pool}: ${pool.stage}`),
    recentError ? `Recent error (${recentError.stage}): ${recentError.message}` : ""
  ].filter(Boolean).join("\n");
  state.view?.onActivity?.(activity);
}

// ---- routing -------------------------------------------------------------------------------------------------

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "chat" && parts[1]) return { kind: "chat", characterId: Number(parts[1]) };
  if (parts[0] === "contemplation" && parts[1]) return { kind: "contemplation", characterId: Number(parts[1]) };
  if (parts[0] === "edit" && parts[1]) return { kind: "edit", characterId: Number(parts[1]) };
  if (parts[0] === "new") return { kind: "new" };
  if (parts[0] === "settings") return { kind: "settings" };
  return { kind: "home" };
}

// Each navigation renders into its own root. A slower, superseded navigation keeps writing only into its detached
// root and never becomes the current view, so a late response cannot mount the wrong chat.
let routeEpoch = 0;

function setTitle(root, text) { if (root === els.root) els.title.textContent = text; }

async function route() {
  const epoch = ++routeEpoch;
  state.view?.dispose?.();
  state.view = null;
  // Tell the server immediately that the previous chat is no longer open (cancels its follow-up timer).
  sendPresence();
  const root = h("div", { className: "view-root" });
  els.root = root;
  els.view.replaceChildren(root);
  const target = parseRoute();
  els.back.classList.toggle("hidden", target.kind === "home");
  let view = null;
  try {
    const status = await api("/api/status");
    if (epoch !== routeEpoch) return;
    state.status = status;
    if (!state.status.apiKeyConfigured) { renderKeyGate(); return; }
    const characters = await api("/api/characters");
    if (epoch !== routeEpoch) return;
    state.characters = characters;
    if (target.kind === "home") view = renderHome();
    else if (target.kind === "new") view = renderEditor(null);
    else if (target.kind === "edit") view = renderEditor(target.characterId);
    else if (target.kind === "chat") view = await renderChat(target.characterId);
    else if (target.kind === "contemplation") view = await renderContemplation(target.characterId);
    else if (target.kind === "settings") view = await renderSettings();
  } catch (error) {
    if (epoch !== routeEpoch) return;
    root.append(h("div", { className: "card" }, h("h2", { text: "Something went wrong" }), h("p", { className: "muted", text: error.message }), h("a", { href: "#/", text: "Back to characters" })));
  }
  if (epoch !== routeEpoch) { view?.dispose?.(); return; }
  state.view = view;
  sendPresence();
}

els.back.addEventListener("click", () => {
  const target = parseRoute();
  if (target.kind === "contemplation" || target.kind === "edit") location.hash = `#/chat/${target.characterId}`;
  else location.hash = "#/";
});
window.addEventListener("hashchange", route);

// ---- key gate ------------------------------------------------------------------------------------------------

function renderKeyGate() {
  const root = els.root;
  setTitle(root, "API key");
  const input = h("input", { type: "password", autocomplete: "off", placeholder: "sk-or-v1-...", "aria-label": "OpenRouter API key" });
  const button = h("button", { className: "btn primary", type: "submit", text: "Use this key" });
  const form = h("form", { className: "card stack", onSubmit: async (event) => {
    event.preventDefault();
    button.disabled = true;
    try {
      await api("/api/key", { method: "POST", body: { apiKey: input.value } });
      input.value = "";
      route();
    } catch (error) { showBanner(error.message); button.disabled = false; }
  } },
  h("h2", { text: "Enter your OpenRouter API key" }),
  h("p", { className: "muted", text: "The key is kept only in the server's memory. It is never saved to disk, the database, this browser, logs, or dumps; after a server restart you enter it again." }),
  input, button);
  root.append(form);
  input.focus();
}

// ---- home ----------------------------------------------------------------------------------------------------

function renderHome() {
  const root = els.root;
  setTitle(root, "Characters");
  const list = h("div");
  const fill = () => {
    list.replaceChildren(...(state.characters.length ? state.characters.map((character) => h("div", { className: "card" },
      h("a", { className: "character-item", href: `#/chat/${character.id}` },
        h("div", { className: "row spread" }, h("span", { className: "name", text: character.name }),
          character.chat.pending ? h("span", { className: "badge busy", text: "replying..." }) : null),
        h("div", { className: "muted", text: character.lastMessageAt ? `${character.messageCount} messages, last ${formatTime(character.lastMessageAt)}` : "No messages yet" }),
        h("div", { className: "badges" },
          h("span", { className: "badge", text: character.useSharedMemory ? "shared memory" : "private memory" }),
          h("span", { className: "badge", text: character.useSharedInterpretations ? "shared interpretations" : "private interpretations" }))),
      h("div", { className: "row" },
        h("a", { className: "btn small", href: `#/edit/${character.id}`, text: "Edit" }),
        h("a", { className: "btn small", href: `#/contemplation/${character.id}`, text: "Contemplation" }))))
      : [h("p", { className: "muted", text: "No characters yet." })]));
  };
  fill();
  const description = h("textarea", { rows: 4, value: state.status.userDescription, placeholder: "Describe yourself for the characters (optional)." });
  const saveDescription = h("button", { className: "btn small", type: "button", text: "Save", onClick: async () => {
    try { await api("/api/user-description", { method: "PUT", body: { text: description.value } }); showBanner(""); saveDescription.textContent = "Saved"; setTimeout(() => { saveDescription.textContent = "Save"; }, 1500); }
    catch (error) { showBanner(error.message); }
  } });
  root.append(
    h("div", { className: "row spread" }, h("h2", { text: "Characters" }), h("a", { className: "btn primary", href: "#/new", text: "Add Character" })),
    list,
    h("div", { className: "card stack" },
      h("h3", { text: "About you" }),
      h("p", { className: "muted", text: "Pinned as the first user message for every character. It is your self-description, not an instruction." }),
      description, h("div", { className: "row" }, saveDescription))
  );
  return {
    kind: "home",
    poll: async () => { state.characters = await api("/api/characters"); fill(); }
  };
}

// ---- character editor ------------------------------------------------------------------------------------------

function renderEditor(characterId) {
  const root = els.root;
  const existing = characterId ? state.characters.find((character) => character.id === characterId) : null;
  if (characterId && !existing) throw new Error("Character not found.");
  setTitle(root, existing ? `Edit ${existing.name}` : "New character");
  const name = h("input", { type: "text", maxLength: 100, value: existing?.name || "", required: true });
  const description = h("textarea", { rows: 10, value: existing?.description || "", placeholder: "Who is this character? Identity, personality, voice, situation..." });
  const sharedMemory = h("input", { type: "checkbox", checked: existing?.useSharedMemory || false });
  const sharedInterpretations = h("input", { type: "checkbox", checked: existing?.useSharedInterpretations || false });
  const save = h("button", { className: "btn primary", type: "submit", text: existing ? "Save" : "Create" });
  root.append(h("form", { className: "card stack", onSubmit: async (event) => {
    event.preventDefault();
    save.disabled = true;
    const body = { name: name.value, description: description.value, useSharedMemory: sharedMemory.checked, useSharedInterpretations: sharedInterpretations.checked };
    try {
      const saved = await api(existing ? `/api/characters/${existing.id}` : "/api/characters", { method: existing ? "PUT" : "POST", body });
      location.hash = `#/chat/${saved.id}`;
    } catch (error) { showBanner(error.message); save.disabled = false; }
  } },
  h("label", { className: "field" }, "Display name", name),
  h("label", { className: "field" }, "AI-facing description", description),
  h("label", { className: "check" }, sharedMemory, h("span", {}, "Use shared memory", h("br"), h("span", { className: "muted", text: "Read and write the memory pool shared with other characters instead of this character's private pool." }))),
  h("label", { className: "check" }, sharedInterpretations, h("span", {}, "Use shared interpretations", h("br"), h("span", { className: "muted", text: "Read and write the shared interpretation and experiment pool instead of the private one." }))),
  existing ? h("p", { className: "muted", text: "Changing a flag only switches which pool is active. No pool is merged, copied, or deleted." }) : null,
  h("div", { className: "row" }, save, h("a", { className: "btn", href: existing ? `#/chat/${existing.id}` : "#/", text: "Cancel" }))));
  name.focus();
  return { kind: "editor" };
}

// ---- chat ------------------------------------------------------------------------------------------------------

async function renderChat(characterId) {
  const root = els.root;
  const data = await api(`/api/characters/${characterId}/chat`);
  const character = data.character;
  setTitle(root, character.name);
  const messagesEl = h("div", { className: "messages", "aria-live": "polite" });
  const statusEl = h("div");
  const input = h("textarea", { rows: 2, placeholder: `Message ${character.name}...`, value: state.drafts.get(characterId) || "", "aria-label": "Message" });
  const sendButton = h("button", { className: "btn primary", type: "button", text: "Send" });
  const nodes = new Map();
  let lastId = 0;
  let chatState = data.chat;
  let sending = false;

  const nearBottom = () => messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
  const renderImage = (container, image) => {
    container.querySelector(".image-slot")?.remove();
    if (!image) return;
    const slot = image.status === "ready" ? h("img", { className: "image-slot", src: image.url, alt: "Image from the character", loading: "lazy" })
      : image.status === "pending" ? h("div", { className: "image-slot image-placeholder", text: "Image is being generated..." })
        : h("div", { className: "image-slot image-error", text: `Image could not be generated${image.error ? `: ${image.error}` : "."}` });
    container.insertBefore(slot, container.querySelector(".meta"));
  };
  const upsertMessage = (message) => {
    let node = nodes.get(message.id);
    if (!node) {
      node = { el: h("div", { className: `message ${message.role}` }, renderMessageText(message.text), h("span", { className: "meta", text: formatTime(message.createdAt) })), image: null };
      nodes.set(message.id, node);
      messagesEl.append(node.el);
    }
    if (JSON.stringify(node.image) !== JSON.stringify(message.image)) { node.image = message.image; renderImage(node.el, message.image); }
    lastId = Math.max(lastId, message.id);
  };
  const applyMessages = (messages) => {
    const stick = nearBottom();
    for (const message of messages) upsertMessage(message);
    if (stick && messages.length) messagesEl.scrollTop = messagesEl.scrollHeight;
  };
  const renderStatus = () => {
    const children = [];
    if (chatState.pending) children.push(h("div", { className: "typing", text: `${character.name} is writing...` }));
    else if (chatState.retryAvailable) {
      children.push(h("div", { className: "reply-error" },
        h("span", { text: chatState.error ? `The reply failed: ${chatState.error.message}` : "This message has no reply yet." }),
        h("button", { className: "btn small", type: "button", text: "Retry response", onClick: async (event) => {
          event.target.disabled = true;
          try { await api(`/api/characters/${characterId}/retry`, { method: "POST", body: { timeZone: browserTimeZone() } }); await refresh(); }
          catch (error) { showBanner(error.message); event.target.disabled = false; }
        } })));
    }
    statusEl.replaceChildren(...children);
    sendButton.disabled = Boolean(chatState.pending) || sending;
  };
  // Image placeholders are re-read until they settle; other messages are fetched incrementally.
  const refresh = async () => {
    const pendingImages = [...nodes.entries()].filter(([, node]) => node.image?.status === "pending").map(([id]) => id);
    const after = pendingImages.length ? Math.min(...pendingImages) - 1 : lastId;
    const next = await api(`/api/characters/${characterId}/chat?after=${after}`);
    chatState = next.chat;
    applyMessages(next.messages);
    renderStatus();
  };
  const submit = async () => {
    const text = input.value.trim();
    if (!text || chatState.pending || sending) return;
    sending = true;
    renderStatus();
    try {
      await api(`/api/characters/${characterId}/messages`, { method: "POST", body: { text: input.value, timeZone: browserTimeZone() } });
      input.value = "";
      state.drafts.delete(characterId);
      await refresh();
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } catch (error) { showBanner(error.message); }
    finally { sending = false; renderStatus(); }
  };
  sendButton.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
  });
  // Typing (not only Send) cancels any pending follow-up timer on the server.
  input.addEventListener("input", () => {
    state.drafts.set(characterId, input.value);
    if (input.value.trim() && Date.now() - state.typingSentAt > TYPING_THROTTLE_MS) { state.typingSentAt = Date.now(); sendPresence({ typingStarted: true }); }
  });
  root.append(h("div", { className: "chat" },
    h("div", { className: "row spread" }, h("span", { className: "muted", text: `${poolLabel(character.memoryPool)} memory, ${poolLabel(character.interpretationPool).toLowerCase()} interpretations` }),
      h("span", { className: "row" }, h("a", { className: "btn small", href: `#/contemplation/${characterId}`, text: "Contemplation" }), h("a", { className: "btn small", href: `#/edit/${characterId}`, text: "Edit" }))),
    messagesEl, statusEl, h("div", { className: "composer" }, input, sendButton)));
  applyMessages(data.messages);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  renderStatus();
  return { kind: "chat", characterId, poll: refresh };
}

// ---- contemplation ---------------------------------------------------------------------------------------------

async function renderContemplation(characterId) {
  const root = els.root;
  const character = state.characters.find((entry) => entry.id === characterId);
  if (!character) throw new Error("Character not found.");
  setTitle(root, `Contemplation: ${character.name}`);
  let data = await api(`/api/characters/${characterId}/contemplation`);
  const editing = new Set();
  const statusEl = h("div", { className: "card" });
  const interpretationsEl = h("div", { className: "card" });
  const experimentsEl = h("div", { className: "card" });
  const forceRow = h("div", { className: "row" },
    ...[["generation", "Force Generation"], ["maintenance", "Force Maintenance"], ["experimentation", "Force Experimentation"]].map(([kind, label]) => h("button", { className: "btn small", type: "button", text: label, onClick: async (event) => {
      event.target.disabled = true;
      try { data = await api(`/api/characters/${characterId}/contemplation/force`, { method: "POST", body: { kind } }); renderAll(); }
      catch (error) { showBanner(error.message); }
      finally { event.target.disabled = false; }
    } })));

  const renderStatusCard = () => {
    const s = data.status;
    const roles = state.activity?.roles?.contemplation;
    const rows = [
      ["Pool", poolLabel(data.pool)],
      ["Contemplation", data.contemplationEnabled ? "enabled" : "disabled (manual Force actions only; experiments are not sent to dialogue)"],
      ["Stage", s.running ? `${s.stage}${s.stageCharacterId ? ` (chat ${state.characters.find((c) => c.id === s.stageCharacterId)?.name || s.stageCharacterId})` : ""}` : "idle"],
      ["Parallel", s.parallel.total ? `${s.parallel.inFlight} running of ${s.parallel.total} maintenance requests` : "-"],
      ["Model requests", roles ? `${roles.pendingCount} in flight` : "-"],
      ["Queued", [s.queued.pendingCharacterIds.length ? `${s.queued.pendingCharacterIds.length} chat(s) with new messages` : null, s.queued.forced.length ? `forced: ${s.queued.forced.join(", ")}` : null,
        s.queued.planningRequested ? "experiment review pending" : null].filter(Boolean).join("; ") || "nothing"],
      ["Last cycle", s.lastCycle ? `${s.lastCycle.status}${s.lastCycle.flags ? ` (generation ${s.lastCycle.flags.generation}, maintenance ${s.lastCycle.flags.maintenance})` : ""}` : "-"],
      ["Last error", s.lastError ? `${s.lastError.stage}: ${s.lastError.message}` : "none"]
    ];
    statusEl.replaceChildren(h("div", { className: "row spread" }, h("h3", { text: "Status" }), h("span", { className: `dot${s.running ? " working" : s.lastError ? " error" : ""}` })),
      h("div", { className: "stage-grid" }, ...rows.flatMap(([label, value]) => [h("span", { className: "muted", text: label }), h("span", { text: value })])), h("div", { className: "row" }, forceRow));
  };

  const listSection = (container, title, items, endpoint, hint) => {
    const addInput = h("textarea", { rows: 3, placeholder: hint });
    const entries = items.map((item) => {
      const key = `${endpoint}:${item.id}`;
      const text = h("div", { className: "text" }, item.text);
      const editor = h("textarea", { rows: 5, value: item.text, className: editing.has(key) ? "" : "hidden" });
      const edit = h("button", { className: "btn small", type: "button", text: editing.has(key) ? "Save" : "Edit", onClick: async () => {
        if (!editing.has(key)) { editing.add(key); editor.classList.remove("hidden"); text.classList.add("hidden"); edit.textContent = "Save"; return; }
        try { data = await api(`/api/characters/${characterId}/${endpoint}/${item.id}`, { method: "PUT", body: { text: editor.value } }); editing.delete(key); renderAll(); }
        catch (error) { showBanner(error.message); }
      } });
      if (editing.has(key)) text.classList.add("hidden");
      const del = h("button", { className: "btn small danger", type: "button", text: "Delete", onClick: async () => {
        if (!confirm("Delete this entry?")) return;
        try { data = await api(`/api/characters/${characterId}/${endpoint}/${item.id}`, { method: "DELETE" }); editing.delete(key); renderAll(); }
        catch (error) { showBanner(error.message); }
      } });
      return h("div", { className: "list-entry" }, text, editor, h("div", { className: "row" }, edit, del, h("span", { className: "muted", text: formatTime(item.updatedAt) })));
    });
    const add = h("button", { className: "btn small primary", type: "button", text: "Add", onClick: async () => {
      if (!addInput.value.trim()) return;
      try { data = await api(`/api/characters/${characterId}/${endpoint}`, { method: "POST", body: { text: addInput.value } }); renderAll(); }
      catch (error) { showBanner(error.message); }
    } });
    container.replaceChildren(h("h3", { text: `${title} (${items.length})` }), ...(entries.length ? entries : [h("p", { className: "muted", text: "None yet." })]), h("div", { className: "stack" }, addInput, add));
  };

  let signature = "";
  const renderAll = () => {
    renderStatusCard();
    const next = JSON.stringify([data.interpretations, data.experiments]);
    if (next === signature || editing.size) return;
    signature = next;
    listSection(interpretationsEl, "Interpretations", data.interpretations, "interpretations", "Add an interpretation of the user (free-form prose).");
    listSection(experimentsEl, "Active experiments", data.experiments, "experiments", "Add an experiment intention (what to learn, not a script).");
  };
  root.append(statusEl, interpretationsEl, experimentsEl,
    h("p", { className: "muted", text: "Only the active experiments reach the dialogue model; interpretations never do. Editing interpretations triggers one experiment review; editing experiments does not." }));
  renderAll();
  return {
    kind: "contemplation",
    poll: async () => { data = await api(`/api/characters/${characterId}/contemplation`); renderAll(); },
    onActivity: () => renderStatusCard()
  };
}

// ---- settings --------------------------------------------------------------------------------------------------

async function renderSettings() {
  const root = els.root;
  setTitle(root, "Settings");
  const settings = structuredClone(state.status.settings);
  const container = h("div");
  root.append(container);
  let models = null;
  api("/api/models").then((value) => { models = value; fillLists(); }).catch(() => {});
  const textList = h("datalist", { id: "text-models" });
  const imageList = h("datalist", { id: "image-models" });
  const fillLists = () => {
    const text = new Map([...(models?.curated || state.status.curatedModels).map((m) => [m.id, m.label || m.name]), ...(models?.text || []).map((m) => [m.id, m.name])]);
    textList.replaceChildren(...[...text].map(([id, label]) => h("option", { value: id, text: label })));
    const images = new Map([[state.status.defaultImageModel, "Default (Society)"], ...(models?.image || []).map((m) => [m.id, m.name])]);
    imageList.replaceChildren(...[...images].map(([id, label]) => h("option", { value: id, text: label })));
  };
  fillLists();
  const dots = {};
  const modelRow = (role, label, list) => {
    const input = h("input", { type: "text", value: settings.models[role], list, autocomplete: "off", spellcheck: false, onInput: (event) => { settings.models[role] = event.target.value.trim(); } });
    dots[role] = h("span", { className: "dot", title: `${label} activity` });
    return h("label", { className: "field" }, label, h("div", { className: "model-row" }, input, dots[role]));
  };
  const textModelCard = (role, label) => {
    const temperature = settings.temperature[role];
    const valueLabel = h("span", { text: temperature.value.toFixed(2) });
    const range = h("input", { type: "range", min: 0, max: 2, step: 0.05, value: temperature.value, disabled: !temperature.enabled,
      onInput: (event) => { temperature.value = Number(event.target.value); valueLabel.textContent = temperature.value.toFixed(2); } });
    const toggle = h("input", { type: "checkbox", checked: temperature.enabled, onChange: (event) => { temperature.enabled = event.target.checked; range.disabled = !temperature.enabled; } });
    const maxTokens = h("input", { type: "number", min: 256, max: 200000, step: 256, value: settings.maxTokens[role], onInput: (event) => { settings.maxTokens[role] = Number(event.target.value); } });
    return h("div", { className: "card stack" }, h("h3", { text: label }), modelRow(role, "Model", "text-models"),
      h("label", { className: "check" }, toggle, h("span", {}, "Override temperature ", h("span", { className: "muted", text: "(off: provider default; ignored for models that do not support it)" }))),
      h("div", { className: "row" }, range, valueLabel),
      h("label", { className: "field" }, "Maximum output tokens (includes reasoning tokens on reasoning models)", maxTokens));
  };
  const imageEnabled = h("input", { type: "checkbox", checked: settings.imageEnabled, onChange: (event) => { settings.imageEnabled = event.target.checked; } });
  const contemplationEnabled = h("input", { type: "checkbox", checked: settings.contemplationEnabled, onChange: (event) => { settings.contemplationEnabled = event.target.checked; } });
  const save = h("button", { className: "btn primary", type: "button", text: "Save settings", onClick: async () => {
    save.disabled = true;
    try { state.status.settings = await api("/api/settings", { method: "PUT", body: settings }); save.textContent = "Saved"; setTimeout(() => { save.textContent = "Save settings"; }, 1500); }
    catch (error) { showBanner(error.message); }
    finally { save.disabled = false; }
  } });
  container.append(textList, imageList,
    textModelCard("dialogue", "Dialogue model (chat replies and memory consolidation)"),
    textModelCard("contemplation", "Contemplation model (prefetch, interpretations, maintenance, experiments)"),
    h("div", { className: "card stack" }, h("h3", { text: "Images" }), modelRow("image", "Image generation model", "image-models"),
      h("label", { className: "check" }, imageEnabled, h("span", { text: "Enable image generation (the dialogue model may then show pictures)" }))),
    h("div", { className: "card stack" }, h("h3", { text: "Contemplation" }),
      h("label", { className: "check" }, contemplationEnabled, h("span", { text: "Enable Contemplation (off: no automatic contemplation and no experiments in dialogue; stored state and Force actions remain)" }))),
    h("div", { className: "row" }, save, h("button", { className: "btn", type: "button", text: "Refresh model list", onClick: () => api("/api/models?refresh=1").then((value) => { models = value; fillLists(); }).catch((error) => showBanner(error.message)) })));
  const onActivity = (activity) => {
    for (const [role, dot] of Object.entries(dots)) {
      const info = activity.roles[role];
      dot.classList.toggle("working", Boolean(info?.working));
      dot.classList.toggle("error", !info?.working && Boolean(info?.lastError));
      dot.title = info?.working ? `${info.pendingCount} request(s): ${info.purposes.join(", ")}` : info?.lastError ? `Last error: ${info.lastError.message}` : "idle";
    }
  };
  if (state.activity) onActivity(state.activity);
  return { kind: "settings", onActivity };
}

// ---- main loop -------------------------------------------------------------------------------------------------

setInterval(async () => {
  if (document.visibilityState !== "visible") return;
  await pollActivity();
  try { await state.view?.poll?.(); } catch { /* transient; next poll retries */ }
}, POLL_MS);

route();
pollActivity();
