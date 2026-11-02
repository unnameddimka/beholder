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

const SVG_NS = "http://www.w3.org/2000/svg";
// A decorative stroke icon; the button that holds it carries the accessible name.
function icon(d) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}
const ICON_PAPERCLIP = "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48";
const ICON_SEND = "M22 2 11 13M22 2l-7 20-4-9-9-4z";

// Software keyboards: size the app to the visible viewport so the chat composer stays above the keyboard where the
// browser does not resize the layout viewport itself.
if (window.visualViewport) {
  const fitViewport = () => document.documentElement.style.setProperty("--viewport-height", `${Math.round(window.visualViewport.height)}px`);
  window.visualViewport.addEventListener("resize", fitViewport);
  fitViewport();
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
        h("div", { className: "muted", text: character.lastMessageAt ? `${character.messageCount} messages, last ${formatTime(character.lastMessageAt)}` : "No messages yet" })),
      h("div", { className: "row" },
        h("a", { className: "btn small", href: `#/edit/${character.id}`, text: "Edit" }),
        h("a", { className: "btn small", href: `#/contemplation/${character.id}`, text: "Contemplation" }))))
      : [h("p", { className: "muted", text: "No characters yet." })]));
  };
  fill();
  root.append(
    h("div", { className: "row spread" }, h("h2", { text: "Characters" }), h("a", { className: "btn primary", href: "#/new", text: "Add Character" })),
    list
  );
  return {
    kind: "home",
    poll: async () => { state.characters = await api("/api/characters"); fill(); }
  };
}

// ---- character editor ------------------------------------------------------------------------------------------

// Specification 0005 A1-A3: the character owns its three AI-facing descriptions and its whole AI configuration. A
// new character starts from the built-in defaults, never from another character.
function renderEditor(characterId) {
  const root = els.root;
  const existing = characterId ? state.characters.find((character) => character.id === characterId) : null;
  if (characterId && !existing) throw new Error("Character not found.");
  setTitle(root, existing ? `Edit ${existing.name}` : "New character");
  const config = structuredClone(existing?.config || state.status.defaultConfig);
  const name = h("input", { type: "text", maxLength: 100, value: existing?.name || "", required: true });
  const descriptionField = (label, hint, value, rows, placeholder) => {
    const input = h("textarea", { rows, maxLength: 20000, value, placeholder });
    return { input, el: h("label", { className: "field" }, label, h("span", { className: "field-hint", text: hint }), input) };
  };
  const characterDescription = descriptionField("Character Description", "Who the character is: identity, personality, voice, manner.", existing?.description || "", 8, "Who is this character?");
  const sceneDescription = descriptionField("Scene Description", "Where and in what circumstances the conversation takes place. Only you write it.", existing?.sceneDescription || "", 5, "Optional");
  const userDescription = descriptionField("User Description", "How you describe yourself to this character. Pinned as your self-description, not as a chat message.", existing?.userDescription || "", 5, "Optional");
  const models = modelSelectors(config);
  const save = h("button", { className: "btn primary", type: "submit", text: existing ? "Save" : "Create" });
  root.append(h("form", { className: "stack", onSubmit: async (event) => {
    event.preventDefault();
    save.disabled = true;
    const body = { name: name.value, description: characterDescription.input.value, sceneDescription: sceneDescription.input.value, userDescription: userDescription.input.value, config };
    try {
      const saved = await api(existing ? `/api/characters/${existing.id}` : "/api/characters", { method: existing ? "PUT" : "POST", body });
      location.hash = `#/chat/${saved.id}`;
    } catch (error) { showBanner(error.message); save.disabled = false; }
  } },
  h("div", { className: "card stack" }, h("label", { className: "field" }, "Display name", name)),
  h("div", { className: "card stack" }, h("h3", { text: "Descriptions" }),
    h("p", { className: "muted", text: "All three are given to every AI role of this character as labeled context. They are never chat messages." }),
    characterDescription.el, sceneDescription.el, userDescription.el),
  h("h3", { className: "section-title", text: "AI Models" }),
  models.el,
  h("div", { className: "row form-actions" }, save, h("a", { className: "btn", href: existing ? `#/chat/${existing.id}` : "#/", text: "Cancel" }))));
  name.focus();
  return { kind: "editor", onActivity: models.onActivity };
}

// The four role cards of one character's configuration, edited in place on config. Models are chosen from the
// curated and catalogue lists (or typed as an id); a configured id stays shown even when the catalogue lacks it.
function modelSelectors(config) {
  let models = null;
  const catalogNote = h("p", { className: "muted", text: "Loading the model list..." });
  const textList = h("datalist", { id: "text-models" });
  const visionList = h("datalist", { id: "vision-models" });
  const imageList = h("datalist", { id: "image-models" });
  const fillLists = () => {
    const text = new Map([...(models?.curated || state.status.curatedModels).map((m) => [m.id, m.label || m.name]), ...(models?.text || []).map((m) => [m.id, m.name])]);
    textList.replaceChildren(...[...text].map(([id, label]) => h("option", { value: id, text: label })));
    // Vision offers exactly the curated models (Specification 0003 V2); another image-capable id can still be typed.
    const vision = new Map(state.status.curatedVisionModels.map((m) => [m.id, m.label]));
    visionList.replaceChildren(...[...vision].map(([id, label]) => h("option", { value: id, text: label })));
    const images = new Map([[state.status.defaultImageModel, "Default (Society)"], ...(models?.image || []).map((m) => [m.id, m.name])]);
    imageList.replaceChildren(...[...images].map(([id, label]) => h("option", { value: id, text: label })));
    catalogNote.textContent = !models ? "Loading the model list..." : models.catalogError
      ? `The OpenRouter model list is unavailable (${models.catalogError}); the curated models are listed and any model id can be typed.`
      : "Pick a model from the list or type any OpenRouter model id.";
  };
  const load = (refresh) => api(`/api/models${refresh ? "?refresh=1" : ""}`).then((value) => { models = value; fillLists(); })
    .catch((error) => { models = { catalogError: error.message }; fillLists(); });
  fillLists();
  load(false);
  const dots = {};
  const modelRow = (role, label, list) => {
    const input = h("input", { type: "text", value: config.models[role], list, autocomplete: "off", spellcheck: false, "aria-label": `${label} model`, onInput: (event) => { config.models[role] = event.target.value.trim(); } });
    dots[role] = h("span", { className: "dot", title: `${label} activity` });
    return h("label", { className: "field" }, "Model", h("div", { className: "model-row" }, input, dots[role]));
  };
  const textModelCard = (role, label, hint, list = "text-models", extra = null) => {
    const temperature = config.temperature[role];
    const valueLabel = h("span", { text: temperature.value.toFixed(2) });
    const range = h("input", { type: "range", min: 0, max: 2, step: 0.05, value: temperature.value, disabled: !temperature.enabled, "aria-label": `${label} temperature`,
      onInput: (event) => { temperature.value = Number(event.target.value); valueLabel.textContent = temperature.value.toFixed(2); } });
    const toggle = h("input", { type: "checkbox", checked: temperature.enabled, onChange: (event) => { temperature.enabled = event.target.checked; range.disabled = !temperature.enabled; } });
    const maxTokens = h("input", { type: "number", min: 256, max: 200000, step: 256, value: config.maxTokens[role], onInput: (event) => { config.maxTokens[role] = Number(event.target.value); } });
    return h("div", { className: "card stack" }, h("h3", { text: label }), h("p", { className: "muted", text: hint }), modelRow(role, label, list),
      h("label", { className: "check" }, toggle, h("span", {}, "Override temperature ", h("span", { className: "muted", text: "(off: provider default; ignored for models that do not support it)" }))),
      h("div", { className: "row" }, range, valueLabel),
      h("label", { className: "field" }, "Maximum output tokens (includes reasoning tokens on reasoning models)", maxTokens), extra);
  };
  const imageEnabled = h("input", { type: "checkbox", checked: config.imageEnabled, onChange: (event) => { config.imageEnabled = event.target.checked; } });
  const contemplationEnabled = h("input", { type: "checkbox", checked: config.contemplationEnabled, onChange: (event) => { config.contemplationEnabled = event.target.checked; } });
  const el = h("div", { className: "stack" }, textList, visionList, imageList, catalogNote,
    textModelCard("dialogue", "Dialogue", "Chat replies, openers and follow-ups, memory retrieval and memory consolidation."),
    textModelCard("contemplation", "Contemplation", "Prefetch, interpretations, maintenance, gestalt and experiments.", "text-models",
      h("label", { className: "check" }, contemplationEnabled, h("span", { text: "Automatic Contemplation (off: nothing runs on its own and the gestalt and experiments are not sent to dialogue; Force on the Contemplation page still works)" }))),
    textModelCard("vision", "Vision", "Looks at images you attach; needs a model with image input and text output.", "vision-models"),
    h("div", { className: "card stack" }, h("h3", { text: "Image Generation" }), h("p", { className: "muted", text: "Pictures the character shows you. Attaching your own images works either way." }),
      modelRow("image", "Image Generation", "image-models"),
      h("label", { className: "check" }, imageEnabled, h("span", { text: "Enable image generation" }))),
    h("div", { className: "row" }, h("button", { className: "btn", type: "button", text: "Refresh model list", onClick: () => load(true) })));
  const onActivity = (activity) => {
    for (const [role, dot] of Object.entries(dots)) {
      const info = activity.roles[role];
      dot.classList.toggle("working", Boolean(info?.working));
      dot.classList.toggle("error", !info?.working && Boolean(info?.lastError));
      dot.title = info?.working ? `${info.pendingCount} request(s): ${info.purposes.join(", ")}` : info?.lastError ? `Last error: ${info.lastError.message}` : "idle";
    }
  };
  if (state.activity) onActivity(state.activity);
  return { el, onActivity };
}

// ---- chat ------------------------------------------------------------------------------------------------------

async function renderChat(characterId) {
  const root = els.root;
  const data = await api(`/api/characters/${characterId}/chat`);
  const character = data.character;
  setTitle(root, character.name);
  const messagesEl = h("div", { className: "messages", "aria-live": "polite" });
  const statusEl = h("div");
  // Specification 0004 U1/U2: a growing multiline field between two compact icon buttons. Enter and Shift+Enter insert
  // a newline; the Send button sends, and so does Ctrl+Enter on a desktop keyboard (Specification 0005 section 4).
  const input = h("textarea", { rows: 1, placeholder: `Message ${character.name}...`, value: state.drafts.get(characterId) || "", "aria-label": "Message", enterkeyhint: "enter" });
  const sendButton = h("button", { className: "composer-button primary", type: "button", "aria-label": "Send message", title: "Send message" }, icon(ICON_SEND));
  // One attached image per message (Specification 0003 U1), validated again by the server.
  const fileInput = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", className: "hidden", "aria-hidden": "true" });
  const attachButton = h("button", { className: "composer-button", type: "button", "aria-label": "Attach image", title: "Attach image (PNG, JPEG, or WebP)", onClick: () => fileInput.click() }, icon(ICON_PAPERCLIP));
  const previewEl = h("div", { className: "attachment-preview hidden" });
  const nodes = new Map();
  let lastId = 0;
  let chatState = data.chat;
  let sending = false;
  let attachment = null;
  const maxBytes = state.status.uploadMaxBytes;

  const setAttachment = (file) => {
    if (attachment?.url) URL.revokeObjectURL(attachment.url);
    attachment = file ? { file, url: URL.createObjectURL(file) } : null;
    fileInput.value = "";
    previewEl.classList.toggle("hidden", !attachment);
    previewEl.replaceChildren(...(attachment ? [h("img", { src: attachment.url, alt: "Selected image" }), h("span", { text: file.name }),
      h("button", { className: "btn small", type: "button", text: "Remove", onClick: () => setAttachment(null) })] : []));
  };
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) { showBanner("Only PNG, JPEG, and WebP images can be attached."); fileInput.value = ""; return; }
    if (maxBytes && file.size > maxBytes) { showBanner(`The image exceeds ${Math.floor(maxBytes / (1024 * 1024))} MiB.`); fileInput.value = ""; return; }
    setAttachment(file);
    sendPresence({ typingStarted: true });
  });

  const nearBottom = () => messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
  const renderImage = (container, image) => {
    container.querySelector(".image-slot")?.remove();
    if (!image) return;
    const slot = image.status === "ready" ? h("img", { className: "image-slot", src: image.url, alt: "Image from the character", loading: "lazy" })
      : image.status === "pending" ? h("div", { className: "image-slot image-placeholder", text: "Image is being generated..." })
        : h("div", { className: "image-slot image-error", text: `Image could not be generated${image.error ? `: ${image.error}` : "."}` });
    container.insertBefore(slot, container.querySelector(".meta"));
  };
  // The user's own attachment with a collapsed note on what the character perceived; never a chat utterance.
  const renderUpload = (container, upload) => {
    container.querySelector(".upload-slot")?.remove();
    if (!upload) return;
    const note = upload.status === "observed" && upload.observation
      ? h("details", { className: "upload-note" }, h("summary", { text: `What ${character.name} saw` }), h("div", { className: "observation", text: upload.observation }))
      : upload.status === "pending" ? h("div", { className: "upload-note", text: "Viewing..." })
        : h("div", { className: "upload-note failed", text: "Could not be viewed" });
    const slot = h("div", { className: "upload-slot" },
      upload.url ? h("img", { src: upload.url, alt: "Image you attached", loading: "lazy" }) : h("div", { className: "image-error", text: "The attached image file is unavailable." }), note);
    container.insertBefore(slot, container.querySelector(".meta"));
  };
  const upsertMessage = (message) => {
    let node = nodes.get(message.id);
    if (!node) {
      node = { el: h("div", { className: `message ${message.role}` }, renderMessageText(message.text), h("span", { className: "meta", text: formatTime(message.createdAt) })), image: null, upload: null };
      nodes.set(message.id, node);
      messagesEl.append(node.el);
    }
    if (JSON.stringify(node.image) !== JSON.stringify(message.image)) { node.image = message.image; renderImage(node.el, message.image); }
    if (JSON.stringify(node.upload) !== JSON.stringify(message.upload ?? null)) { node.upload = message.upload ?? null; renderUpload(node.el, node.upload); }
    lastId = Math.max(lastId, message.id);
  };
  const applyMessages = (messages) => {
    const stick = nearBottom();
    for (const message of messages) upsertMessage(message);
    if (stick && messages.length) messagesEl.scrollTop = messagesEl.scrollHeight;
  };
  const renderStatus = () => {
    const children = [];
    if (chatState.pending) children.push(h("div", { className: "typing", text: chatState.pending.stage === "vision" ? `${character.name} is looking at the image...` : `${character.name} is writing...` }));
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
    attachButton.disabled = Boolean(chatState.pending) || sending;
  };
  // Image placeholders and attachments being viewed are re-read until they settle; other messages are fetched
  // incrementally.
  const refresh = async () => {
    const pendingImages = [...nodes.entries()].filter(([, node]) => node.image?.status === "pending" || node.upload?.status === "pending").map(([id]) => id);
    const after = pendingImages.length ? Math.min(...pendingImages) - 1 : lastId;
    const next = await api(`/api/characters/${characterId}/chat?after=${after}`);
    chatState = next.chat;
    applyMessages(next.messages);
    renderStatus();
  };
  // A message with an attachment goes as multipart/form-data; a rejected upload keeps the draft and the attachment.
  const sendWithImage = async () => {
    const form = new FormData();
    form.append("text", input.value);
    form.append("timeZone", browserTimeZone() || "");
    form.append("image", attachment.file, attachment.file.name);
    const response = await fetch(`/api/characters/${characterId}/messages`, { method: "POST", body: form });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || `HTTP ${response.status}`);
  };
  const submit = async () => {
    const text = input.value.trim();
    if ((!text && !attachment) || chatState.pending || sending) return;
    sending = true;
    renderStatus();
    try {
      if (attachment) await sendWithImage();
      else await api(`/api/characters/${characterId}/messages`, { method: "POST", body: { text: input.value, timeZone: browserTimeZone() } });
      input.value = "";
      fitInput();
      setAttachment(null);
      state.drafts.delete(characterId);
      await refresh();
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } catch (error) { showBanner(error.message); }
    finally { sending = false; renderStatus(); }
  };
  sendButton.addEventListener("click", submit);
  // Ctrl+Enter runs the same submit as the button. Nothing else is intercepted: plain and Shift+Enter keep their
  // newline, an IME composition or an auto-repeated key is ignored, and Meta (Command) is not a send shortcut.
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (event.repeat) return;
    submit();
  });
  // Grows with its lines up to the CSS max-height, then scrolls inside.
  const fitInput = () => {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight + input.offsetHeight - input.clientHeight}px`;
  };
  // Typing (not only Send) cancels any pending follow-up timer on the server.
  input.addEventListener("input", () => {
    fitInput();
    state.drafts.set(characterId, input.value);
    if (input.value.trim() && Date.now() - state.typingSentAt > TYPING_THROTTLE_MS) { state.typingSentAt = Date.now(); sendPresence({ typingStarted: true }); }
  });
  root.append(h("div", { className: "chat" },
    h("div", { className: "row chat-links" }, h("a", { className: "btn small", href: `#/contemplation/${characterId}`, text: "Contemplation" }), h("a", { className: "btn small", href: `#/edit/${characterId}`, text: "Edit" })),
    messagesEl, statusEl, previewEl, h("div", { className: "composer" }, attachButton, fileInput, input, sendButton)));
  fitInput();
  applyMessages(data.messages);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  renderStatus();
  return { kind: "chat", characterId, poll: refresh };
}

// Specification 0005 F3: the last persisted Maintenance attempt, never a prediction of the next one.
const MAINTENANCE_OUTCOMES = { running: "running", applied: "succeeded, interpretations updated", unchanged: "succeeded, nothing needed changing",
  stale: "discarded as stale", skipped: "skipped", failed: "failed", interrupted: "interrupted by a server restart" };
function maintenanceText(last) {
  if (!last) return "Never";
  const when = formatTime(last.finishedAt || last.startedAt);
  return [`${when}: ${MAINTENANCE_OUTCOMES[last.status] || last.status} (${last.source === "forced" ? "forced" : "automatic"})`, last.reason].filter(Boolean).join(". ");
}

// Review 0005 P2-B: one Force kind's current state and the terminal outcome of its last forced run. While a new
// request is queued or running, the previous outcome is labeled as previous so it is never read as the new result.
const FORCE_RESULTS = { applied: "interpretations updated", unchanged: "nothing needed changing", stale: "discarded as stale", empty: "no interpretations",
  added: "interpretation added", declined: "nothing new to add", stale_discarded: "discarded as stale", rejected_after_pool_change: "discarded after the pool changed",
  committed: "experiments updated", not_needed: "nothing to review", superseded: "superseded" };
function forceText(entry) {
  if (!entry) return "";
  const last = entry.last;
  const outcome = last ? [`${formatTime(last.finishedAt)}: ${last.status === "failed" ? "failed" : "completed"}${last.result ? `, ${FORCE_RESULTS[last.result] || last.result}` : ""}`,
    last.status === "failed" ? last.reason : null, last.followUpError ? `the follow-up ${last.followUpError.stage} failed: ${last.followUpError.reason}` : null].filter(Boolean).join(". ") : "never forced since the server started";
  if (entry.state === "idle") return `Last run ${outcome}`;
  return `${entry.state === "running" ? "Running now" : "Queued"}. Previous run ${outcome}`;
}

// ---- contemplation ---------------------------------------------------------------------------------------------

// Results stay read-only (Specification 0002 U1/U2): no control writes interpretation, experiment or gestalt text.
// The Force buttons only ask the model to run an existing stage (Specification 0005 F1/F2).
async function renderContemplation(characterId) {
  const root = els.root;
  const character = state.characters.find((entry) => entry.id === characterId);
  if (!character) throw new Error("Character not found.");
  setTitle(root, `Contemplation: ${character.name}`);
  let data = await api(`/api/characters/${characterId}/contemplation`);
  const statusEl = h("div", { className: "card" });
  const forceEl = h("div", { className: "card stack" });
  const gestaltEl = h("div", { className: "card" });
  const interpretationsEl = h("div", { className: "card" });
  const experimentsEl = h("div", { className: "card" });

  const renderStatusCard = () => {
    const s = data.status;
    const roles = state.activity?.roles?.contemplation;
    const rows = [
      ["Automatic", data.contemplationEnabled ? "on" : "off (nothing runs on its own; gestalt and experiments are not sent to dialogue)"],
      ["Maintenance now", s.maintenance],
      ["Last Maintenance", maintenanceText(s.lastMaintenance)],
      ["Stage", s.running ? `${s.stage}${s.stageCharacterId ? ` (chat ${state.characters.find((c) => c.id === s.stageCharacterId)?.name || s.stageCharacterId})` : ""}` : "idle"],
      ["Parallel", s.parallel.total ? `${s.parallel.inFlight} running of ${s.parallel.total} maintenance requests` : "-"],
      ["Model requests", roles ? `${roles.pendingCount} in flight` : "-"],
      ["Queued", [s.queued.pendingCharacterIds.length ? `${s.queued.pendingCharacterIds.length} chat(s) with new messages` : null, s.queued.forced.length ? `forced: ${s.queued.forced.join(", ")}` : null,
        s.queued.gestaltDue ? "gestalt update pending" : null, s.queued.planningRequested ? "experiment review pending" : null].filter(Boolean).join("; ") || "nothing"],
      ["Last cycle", s.lastCycle ? `${s.lastCycle.status}${s.lastCycle.flags ? ` (generation ${s.lastCycle.flags.generation}, maintenance ${s.lastCycle.flags.maintenance})` : ""}` : "-"],
      ["Last error", s.lastError ? `${s.lastError.stage}: ${s.lastError.message}` : "none"]
    ];
    statusEl.replaceChildren(h("div", { className: "row spread" }, h("h3", { text: "Status" }), h("span", { className: `dot${s.running ? " working" : s.lastError ? " error" : ""}` })),
      h("div", { className: "stage-grid" }, ...rows.flatMap(([label, value]) => [h("span", { className: "muted", text: label }), h("span", { text: value })])));
    renderForce();
  };

  // A kind already queued or running cannot be queued again; a click is disabled until the server answers.
  const FORCE = [["maintenance", "Force Maintenance"], ["generation", "Force Generation"], ["experimentation", "Force Experimentation"]];
  const sending = new Set();
  let forceNote = "";
  const forceButtons = new Map(FORCE.map(([kind, label]) => [kind, h("button", { className: "btn", type: "button", text: label, onClick: async () => {
    sending.add(kind);
    renderForce();
    try {
      data = await api(`/api/characters/${characterId}/contemplation/force`, { method: "POST", body: { kind } });
      forceNote = data.force.queued ? `${label.slice(6)} queued. Its result appears below once it has run.` : `${label.slice(6)} is already ${data.force.reason === "running" ? "running" : "queued"}.`;
      renderAll();
    } catch (error) { showBanner(error.message); }
    finally { sending.delete(kind); renderForce(); }
  } })]));
  const renderForce = () => {
    const s = data.status;
    for (const [kind, button] of forceButtons) {
      const busy = s.force?.[kind]?.state !== "idle" ? s.force?.[kind]?.state : null;
      button.disabled = sending.has(kind) || Boolean(busy);
      button.title = busy ? `Already ${busy}` : "";
    }
    forceEl.replaceChildren(h("h3", { text: "Run now" }),
      h("p", { className: "muted", text: "Asks the Contemplation model to run one stage now, even while automatic Contemplation is off. It never edits text directly." }),
      h("div", { className: "row" }, ...forceButtons.values()),
      h("div", { className: "stage-grid" }, ...FORCE.flatMap(([kind, label]) => [h("span", { className: "muted", text: label.slice(6) }), h("span", { text: forceText(s.force?.[kind]) })])),
      ...(forceNote ? [h("p", { className: "muted", text: forceNote })] : []));
  };

  const renderGestalt = () => {
    const g = data.gestalt;
    const label = g.status === "pending" ? (g.text ? "Update pending: this gestalt predates the latest interpretation changes." : "Not formed yet; the first synthesis is pending.")
      : g.status === "none" ? "Not formed yet." : "Current.";
    gestaltEl.replaceChildren(h("h3", { text: "Gestalt" }),
      h("p", { className: "muted", text: `${label}${g.updatedAt ? ` Last updated ${formatTime(g.updatedAt)}.` : ""}` }),
      ...(g.text ? [h("div", { className: "text" }, g.text)] : []));
  };

  const listSection = (container, title, items) => {
    const entries = items.map((item) => h("div", { className: "list-entry" }, h("div", { className: "text" }, item.text), h("span", { className: "muted", text: formatTime(item.updatedAt) })));
    container.replaceChildren(h("h3", { text: `${title} (${items.length})` }), ...(entries.length ? entries : [h("p", { className: "muted", text: "None yet." })]));
  };

  let signature = "";
  const renderAll = () => {
    renderStatusCard();
    const next = JSON.stringify([data.gestalt, data.interpretations, data.experiments]);
    if (next === signature) return;
    signature = next;
    renderGestalt();
    listSection(interpretationsEl, "Interpretations", data.interpretations);
    listSection(experimentsEl, "Active experiments", data.experiments);
  };
  root.append(statusEl, forceEl, gestaltEl, interpretationsEl, experimentsEl,
    h("p", { className: "muted", text: "Interpretations, experiments and the gestalt cannot be edited here. The dialogue model receives the gestalt and the active experiments, never the interpretations themselves." }));
  renderAll();
  return {
    kind: "contemplation",
    poll: async () => { data = await api(`/api/characters/${characterId}/contemplation`); renderAll(); },
    onActivity: () => renderStatusCard()
  };
}

// ---- main loop -------------------------------------------------------------------------------------------------

setInterval(async () => {
  if (document.visibilityState !== "visible") return;
  await pollActivity();
  try { await state.view?.poll?.(); } catch { /* transient; next poll retries */ }
}, POLL_MS);

route();
pollActivity();
