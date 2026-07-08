/* MaxLoad Desktop — Electron main process.
 *
 * Replaces background/service-worker.js. Responsibilities:
 *   - Shell window (address bar) + two BrowserViews: Maximo (embedded Chromium)
 *     and the MaxLoad panel (your exact ui/panel.html).
 *   - Inject the unmodified content scripts into the Maximo view on every load.
 *   - Message hub: route chrome.runtime / chrome.tabs traffic between the panel
 *     and the Maximo page, and handle the messages the service worker owned
 *     (storage, AI proxy, CDP input, log ring).
 *
 * LOGIN: we do NOT automate Maximo login. The user logs in manually inside the
 * embedded Chromium (SSO/MFA/password all work — it's a real browser). The
 * session cookie persists in a named partition, so it survives restarts until
 * Maximo's own timeout. The engine only ever runs against that live session.
 */
const { app, BrowserWindow, BrowserView, ipcMain, protocol, session } = require("electron");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const ROOT = path.join(__dirname, ".."); // the extension codebase root
const PRELOAD = path.join(__dirname, "preload.js");
const PARTITION = "persist:maximo"; // persists the Maximo login session

// ---------------------------------------------------------------------------
// Tiny JSON store — the chrome.storage.local replacement
// ---------------------------------------------------------------------------
const store = {
  data: {},
  file: null,
  load() {
    // Resolve the path lazily — app.getPath is only valid after 'ready'.
    this.file = path.join(app.getPath("userData"), "maxload-store.json");
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (_) {
      this.data = {};
    }
  },
  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data));
    } catch (e) {
      console.error("[MaxLoad] store save failed:", e);
    }
  },
  get(keys) {
    if (keys == null) return { ...this.data };
    if (typeof keys === "string") return { [keys]: this.data[keys] };
    if (Array.isArray(keys)) {
      const o = {};
      for (const k of keys) o[k] = this.data[k];
      return o;
    }
    const o = {};
    for (const k of Object.keys(keys)) o[k] = k in this.data ? this.data[k] : keys[k];
    return o;
  },
  set(obj) {
    Object.assign(this.data, obj || {});
    this.save();
    return {};
  },
  remove(keys) {
    const arr = Array.isArray(keys) ? keys : [keys];
    for (const k of arr) delete this.data[k];
    this.save();
    return {};
  }
};

// ---------------------------------------------------------------------------
// AI proxy + settings + log ring (ported from service-worker.js, chrome.* removed)
// ---------------------------------------------------------------------------
const LOG_KEY = "ml:logRing";
const LOG_CAP = 6000;
const SETTINGS_KEY = "ml:settings";

const PROVIDERS = {
  xai: { label: "xAI (Grok)", endpoint: "https://api.x.ai/v1/chat/completions", model: "grok-4.3" },
  groq: { label: "Groq", endpoint: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.3-70b-versatile" },
  custom: { label: "Custom (OpenAI-compatible)", endpoint: "", model: "" }
};
const DEFAULT_SETTINGS = {
  aiEnabled: true,
  provider: "xai",
  apiKey: "",
  model: "",
  endpoint: "",
  confidenceThreshold: 70
};

function getSettings() {
  const s = { ...DEFAULT_SETTINGS, ...(store.get(SETTINGS_KEY)[SETTINGS_KEY] || {}) };
  if (!s.apiKey && s.xaiApiKey) s.apiKey = s.xaiApiKey;
  if (!PROVIDERS[s.provider]) s.provider = "xai";
  return s;
}
function resolveProvider(s) {
  const prov = PROVIDERS[s.provider] || PROVIDERS.xai;
  const endpoint = s.provider === "custom" ? s.endpoint : prov.endpoint;
  const model = s.model || prov.model;
  return { endpoint, model, label: prov.label };
}

async function aiResolveField(targetLabel, snippet) {
  const settings = getSettings();
  if (!settings.aiEnabled) return { ok: false, error: "AI disabled in settings" };
  if (!settings.apiKey) return { ok: false, error: "No API key configured" };
  const { endpoint, model, label } = resolveProvider(settings);
  if (!endpoint) return { ok: false, error: "No endpoint configured for provider " + settings.provider };
  const body = {
    model,
    messages: [
      { role: "system", content: "You match form fields from sanitized HTML structure only. Return ONLY the id or name attribute value of the single best-matching element, nothing else." },
      { role: "user", content: `Target field meaning: "${targetLabel}"\nHTML fragment:\n${snippet}` }
    ],
    temperature: 0
  };
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, error: `${label} ${res.status}: ${txt.slice(0, 200)}` };
    }
    const data = await res.json();
    const value = data?.choices?.[0]?.message?.content?.trim();
    if (!value) return { ok: false, error: "Empty AI response" };
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: "Fetch failed: " + String(e && e.message ? e.message : e) };
  }
}

async function aiClassifyError(text) {
  const settings = getSettings();
  if (!settings.aiEnabled || !settings.apiKey) return { ok: false, error: "AI unavailable" };
  const { endpoint, model, label } = resolveProvider(settings);
  if (!endpoint) return { ok: false, error: "No endpoint" };
  const body = {
    model,
    messages: [
      { role: "system", content:
        'Classify an ERP (IBM Maximo) dialog/banner message into exactly one class: ' +
        '"skip" = a row-level data problem (invalid/required/duplicate value) — fail this row but keep processing others; ' +
        '"retryable" = a transient/timing/UI glitch that is safe to retry; ' +
        '"abort" = session expired, not logged in, or a server/system failure that will break every remaining row. ' +
        'Return ONLY compact JSON: {"class":"skip|retryable|abort","reason":"few words"}.' },
      { role: "user", content: String(text || "").slice(0, 1500) }
    ],
    temperature: 0
  };
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify(body)
    });
    if (!res.ok) return { ok: false, error: `${label} ${res.status}` };
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content?.trim() || "";
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : null;
    const cls = parsed && parsed.class;
    if (!["skip", "retryable", "abort"].includes(cls)) return { ok: false, error: "bad class: " + raw.slice(0, 80) };
    return { ok: true, class: cls, reason: (parsed.reason || "").slice(0, 120) };
  } catch (e) {
    return { ok: false, error: "Fetch failed: " + String(e && e.message ? e.message : e) };
  }
}

let logBuffer = [];
let flushTimer = null;
function appendLog(entry) {
  logBuffer.push(entry);
  if (!flushTimer) flushTimer = setTimeout(flushLogs, 500);
}
function flushLogs() {
  flushTimer = null;
  if (!logBuffer.length) return;
  let ring = store.get(LOG_KEY)[LOG_KEY] || [];
  ring = ring.concat(logBuffer);
  logBuffer = [];
  if (ring.length > LOG_CAP) ring = ring.slice(ring.length - LOG_CAP);
  store.set({ [LOG_KEY]: ring });
}

// ---------------------------------------------------------------------------
// CDP trusted input — ported from service-worker.js, chrome.debugger ->
// webContents.debugger. This is the piece that makes the port worthwhile: the
// exact same DevTools Protocol calls, just a different transport.
// ---------------------------------------------------------------------------
let dbgAttached = false;
function dbg() {
  return maximoView.webContents.debugger;
}
function cdp(method, params) {
  return dbg().sendCommand(method, params || {});
}
function ensureAttached() {
  if (dbgAttached) return;
  try {
    dbg().attach("1.3");
  } catch (e) {
    // "Another debugger is already attached" if DevTools is open on this view.
    throw new Error("CDP attach failed (is DevTools open on the Maximo view?): " + e.message);
  }
  dbgAttached = true;
}
function detach() {
  if (!dbgAttached) return;
  try { dbg().detach(); } catch (_) {}
  dbgAttached = false;
}

async function cdpClick(x, y) {
  ensureAttached();
  const p = { x, y, button: "left" };
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...p, buttons: 0 });
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...p, buttons: 1, clickCount: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...p, buttons: 0, clickCount: 1 });
}

async function cdpClickSelector(selector) {
  ensureAttached();
  await cdp("DOM.enable", {}).catch(() => {});
  await cdp("DOM.getDocument", { depth: 1 }).catch(() => {});
  const search = await cdp("DOM.performSearch", { query: selector, includeUserAgentShadowDOM: true });
  const count = search && search.resultCount ? search.resultCount : 0;
  if (!count) {
    if (search) await cdp("DOM.discardSearchResults", { searchId: search.searchId }).catch(() => {});
    throw new Error("node not found for selector " + selector);
  }
  const got = await cdp("DOM.getSearchResults", { searchId: search.searchId, fromIndex: 0, toIndex: count });
  await cdp("DOM.discardSearchResults", { searchId: search.searchId }).catch(() => {});
  const nodeIds = (got && got.nodeIds) || [];
  let quad = null;
  for (let i = nodeIds.length - 1; i >= 0 && !quad; i--) {
    try {
      const box = await cdp("DOM.getBoxModel", { nodeId: nodeIds[i] });
      if (box && box.model && box.model.content && box.model.width > 0 && box.model.height > 0) quad = box.model.content;
    } catch (_) {}
  }
  if (!quad) throw new Error("no box model for selector " + selector);
  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
  const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
  await cdpClick(x, y);
  return { x: Math.round(x), y: Math.round(y) };
}

async function cdpKey(key, code, vk, modifiers) {
  const base = { key, code, windowsVirtualKeyCode: vk || 0, nativeVirtualKeyCode: vk || 0, modifiers: modifiers || 0 };
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}
async function cdpTypeChar(ch) {
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch, key: ch });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
}
async function cdpClearInsert(text, commitKey) {
  await cdpKey("a", "KeyA", 65, 2 /* Ctrl */);
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  const s = String(text == null ? "" : text);
  for (const ch of s) await cdpTypeChar(ch);
  if (commitKey === "tab") await cdpKey("Tab", "Tab", 9);
  else if (commitKey === "enter") await cdpKey("Enter", "Enter", 13);
}
async function cdpTypeFocused(text, commitKey) {
  ensureAttached();
  await cdpClearInsert(text, commitKey);
}

// ---------------------------------------------------------------------------
// Message hub — routes chrome.runtime / chrome.tabs across contexts
// ---------------------------------------------------------------------------
let shellWin = null;
let maximoView = null;
let panelView = null;
let panelVisible = true;

const pending = new Map(); // reqId -> resolve, for tabs.sendMessage responses
let reqSeq = 1;

function panelWC() { return panelView && panelView.webContents; }
function maximoWC() { return maximoView && maximoView.webContents; }

// Deliver a message to a context's chrome.runtime.onMessage listeners and, when
// expectResponse, resolve with the first sendResponse() the page produces.
function pushTo(wc, msg, expectResponse) {
  if (!wc || wc.isDestroyed()) return Promise.resolve(undefined);
  if (!expectResponse) {
    wc.send("ml:push", { msg, expectResponse: false });
    return Promise.resolve(undefined);
  }
  const reqId = reqSeq++;
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      if (pending.has(reqId)) { pending.delete(reqId); resolve(undefined); }
    }, 30000);
    pending.set(reqId, (resp) => { clearTimeout(t); resolve(resp); });
    wc.send("ml:push", { msg, reqId, expectResponse: true });
  });
}

// The messages the service worker used to own.
async function handleOwned(msg) {
  switch (msg.type) {
    case "ml:ai-resolve": return { handled: true, response: await aiResolveField(msg.targetLabel, msg.snippet) };
    case "ml:ai-classify-error": return { handled: true, response: await aiClassifyError(msg.text) };
    case "ml:cdp:click": {
      try { await cdpClick(msg.x, msg.y); return { handled: true, response: { ok: true } }; }
      catch (e) { return { handled: true, response: { ok: false, error: String(e.message || e) } }; }
    }
    case "ml:cdp:click-selector": {
      try { const r = await cdpClickSelector(msg.selector); return { handled: true, response: { ok: true, x: r.x, y: r.y } }; }
      catch (e) { return { handled: true, response: { ok: false, error: String(e.message || e) } }; }
    }
    case "ml:cdp:type-focused": {
      try { await cdpTypeFocused(msg.text, msg.commitKey); return { handled: true, response: { ok: true } }; }
      catch (e) { return { handled: true, response: { ok: false, error: String(e.message || e) } }; }
    }
    case "ml:cdp:key": {
      try { ensureAttached(); await cdpKey(msg.key, msg.code, msg.vk, msg.modifiers); return { handled: true, response: { ok: true } }; }
      catch (e) { return { handled: true, response: { ok: false, error: String(e.message || e) } }; }
    }
    case "ml:cdp:detach": detach(); return { handled: true, response: { ok: true } };
    case "ml:log": appendLog({ ...msg.entry, tabId: 1 }); return { handled: true, response: undefined };
    case "ml:progress": appendLog({ ts: new Date().toISOString(), level: "log", kind: "progress", msg: "progress", data: msg.ev }); return { handled: true, response: undefined };
    case "ml:modal-detected": appendLog({ ts: new Date().toISOString(), level: "warn", kind: "modal", msg: "modal detected", data: { text: msg.text } }); return { handled: true, response: undefined };
    case "ml:store:get-logs": return { handled: true, response: { ok: true, logs: store.get(LOG_KEY)[LOG_KEY] || [] } };
    case "ml:store:clear-logs": store.set({ [LOG_KEY]: [] }); return { handled: true, response: { ok: true } };
    case "ml:store:get-settings": return { handled: true, response: { ok: true, settings: getSettings() } };
    case "ml:store:save-settings": store.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, ...(msg.settings || {}) } }); return { handled: true, response: { ok: true } };
    default: return { handled: false, response: { ok: true } };
  }
}

function registerIpc() {
  // chrome.runtime.sendMessage: main handles owned types; always broadcast to the
  // OTHER context so its onMessage listeners fire (progress, bind events, batch-result).
  ipcMain.handle("ml:runtime-send", async (event, msg) => {
    if (!msg || typeof msg.type !== "string") return { ok: false, error: "bad message" };
    const fromMaximo = maximoWC() && event.sender.id === maximoWC().id;
    const other = fromMaximo ? panelWC() : maximoWC();
    const owned = await handleOwned(msg);
    // Fire-and-forget broadcast to the peer context (no response collected).
    pushTo(other, msg, false);
    return owned.response;
  });

  // chrome.tabs.sendMessage(tabId, msg): directed at the Maximo page; wait for its
  // frame-bridge response.
  ipcMain.handle("ml:tabs-send", async (_event, payload) => {
    const msg = payload && payload.msg;
    if (!msg) return { ok: false, error: "bad message" };
    return await pushTo(maximoWC(), msg, true);
  });

  ipcMain.handle("ml:storage-get", (_e, keys) => store.get(keys));
  ipcMain.handle("ml:storage-set", (_e, obj) => store.set(obj));
  ipcMain.handle("ml:storage-remove", (_e, keys) => store.remove(keys));

  ipcMain.on("ml:push-response", (_e, payload) => {
    const fn = payload && pending.get(payload.reqId);
    if (fn) { pending.delete(payload.reqId); fn(payload.resp); }
  });

  ipcMain.on("ml:tabs-create", (_e, payload) => openEditorWindow(payload && payload.url));

  // ---- shell controls ----
  ipcMain.on("shell:navigate", (_e, url) => navigateMaximo(url));
  ipcMain.on("shell:back", () => { const w = maximoWC(); if (w && w.canGoBack()) w.goBack(); });
  ipcMain.on("shell:forward", () => { const w = maximoWC(); if (w && w.canGoForward()) w.goForward(); });
  ipcMain.on("shell:reload", () => { const w = maximoWC(); if (w) w.reload(); });
  ipcMain.on("shell:toggle-panel", () => { panelVisible = !panelVisible; layout(); });
}

// ---------------------------------------------------------------------------
// Content-script injection into the Maximo view (the manifest's script list)
// ---------------------------------------------------------------------------
const CONTENT_SCRIPTS = [
  "content/namespace.js",
  "content/action-tracker.js",
  "content/maximo-native.js",
  "content/settle-detector.js",
  "content/dom-analyzer.js",
  "content/highlighter.js",
  "content/cdp-input.js",
  "content/smart-matcher.js",
  "content/rule-engine.js",
  "content/error-watcher.js",
  "content/recorder.js",
  "content/binder.js",
  "engines/learning-cache.js",
  "engines/resume-engine.js",
  "lib/xlsx.full.min.js",
  "engines/excel-engine.js",
  "engines/ai-recovery.js",
  "content/menu-select.js",
  "content/execution-engine.js",
  "content/frame-bridge.js"
  // NOTE: content/panel-inject.js is intentionally skipped — the panel is a
  // docked BrowserView here, not an in-page iframe.
];

async function injectContentScripts() {
  const wc = maximoWC();
  if (!wc) return;
  for (const rel of CONTENT_SCRIPTS) {
    const full = path.join(ROOT, rel);
    let src;
    try {
      src = await fsp.readFile(full, "utf8");
    } catch (e) {
      console.warn("[MaxLoad] missing content script:", rel);
      continue;
    }
    try {
      // Wrap so a throw in one file doesn't abort the rest, and to tag errors.
      await wc.executeJavaScript(
        `;(function(){ try { ${src}\n } catch(e){ console.error("[MaxLoad inject ${rel}]", e); } })();`,
        true
      );
    } catch (e) {
      console.error("[MaxLoad] inject failed:", rel, e && e.message);
    }
  }
  console.log("[MaxLoad] content scripts injected into Maximo view");
}

// ---------------------------------------------------------------------------
// Views + layout
// ---------------------------------------------------------------------------
const TOP_BAR = 48;
const PANEL_W = 400;

function layout() {
  if (!shellWin) return;
  const [w, h] = shellWin.getContentSize();
  const pw = panelVisible ? PANEL_W : 0;
  if (maximoView) maximoView.setBounds({ x: 0, y: TOP_BAR, width: Math.max(0, w - pw), height: Math.max(0, h - TOP_BAR) });
  if (panelView) panelView.setBounds({ x: w - pw, y: TOP_BAR, width: pw, height: Math.max(0, h - TOP_BAR) });
}

function navigateMaximo(url) {
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  maximoWC().loadURL(url).catch((e) => console.warn("[MaxLoad] navigate failed:", e.message));
}

function sendStatus(text) {
  if (shellWin && !shellWin.isDestroyed()) shellWin.webContents.send("shell:status", text);
}

function openEditorWindow(url) {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    title: "MaxLoad — Workflow Editor",
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: false,
      partition: PARTITION,
      additionalArguments: ["--maxload-role=editor"]
    }
  });
  // url arrives as maxload://app/ui/workflow-editor.html?id=... — load the file
  // directly and preserve the query so the editor can read ?id=.
  let search = "";
  try { search = new URL(url).search; } catch (_) {}
  win.loadFile(path.join(ROOT, "ui", "workflow-editor.html"), search ? { search: search.replace(/^\?/, "") } : undefined);
}

function createWindow() {
  shellWin = new BrowserWindow({
    width: 1440,
    height: 900,
    title: "MaxLoad Desktop",
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: false,
      additionalArguments: ["--maxload-role=shell"]
    }
  });
  shellWin.loadFile(path.join(__dirname, "shell.html"));

  const viewPrefs = {
    preload: PRELOAD,
    contextIsolation: true,
    sandbox: false,
    partition: PARTITION
  };

  // Maximo (embedded Chromium) — the user logs in here.
  maximoView = new BrowserView({
    webPreferences: { ...viewPrefs, additionalArguments: ["--maxload-role=maximo"] }
  });
  shellWin.addBrowserView(maximoView);

  // Panel — your exact ui/panel.html.
  panelView = new BrowserView({
    webPreferences: { ...viewPrefs, additionalArguments: ["--maxload-role=panel"] }
  });
  shellWin.addBrowserView(panelView);

  // Enterprise Maximo is often on a self-signed / internal-CA cert. Accept it for
  // the Maximo view so the page isn't silently blocked. (Prototype scope.)
  maximoWC().on("certificate-error", (event, _url, _err, _cert, callback) => {
    event.preventDefault();
    callback(true);
  });

  // Keep target=_blank / window.open popups inside the app (with our preload),
  // instead of handing the URL to the OS ("Windows can't open this link").
  maximoWC().setWindowOpenHandler(() => ({
    action: "allow",
    overrideBrowserWindowOptions: {
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: false, partition: PARTITION, additionalArguments: ["--maxload-role=maximo"] }
    }
  }));

  // Re-inject content scripts on EVERY finished load of the Maximo view (each
  // navigation is a fresh context, exactly like the extension re-injecting at
  // document_idle). 'dom-ready' is per main-frame document.
  maximoWC().on("dom-ready", () => {
    injectContentScripts();
    sendStatus(maximoWC().getURL());
  });
  maximoWC().on("did-navigate", (_e, url) => sendStatus(url));

  // Load the main UI as plain files (robust) — the custom maxload:// scheme is
  // reserved for the few getURL()-fetched assets (rule-engine, editor).
  maximoWC().loadFile(path.join(__dirname, "start.html"));
  panelWC().loadFile(path.join(ROOT, "ui", "panel.html"));

  // Re-assert layout once each view has painted (BrowserView bounds can be lost
  // if set before the window has its real content size).
  panelWC().on("did-finish-load", layout);
  maximoWC().on("did-finish-load", layout);

  // Prototype visibility: open the panel's console so any error is visible
  // instead of a blank pane. Remove for production.
  panelWC().once("did-finish-load", () => {
    if (!process.env.MAXLOAD_SMOKE) panelWC().openDevTools({ mode: "detach" });
  });

  layout();
  shellWin.on("resize", layout);
  shellWin.on("closed", () => { shellWin = null; });
}

// ---------------------------------------------------------------------------
// maxload:// protocol — serves the extension codebase to the panel/editor/iframes
// ---------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([
  { scheme: "maxload", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".csv": "text/csv", ".map": "application/json"
};

function registerProtocol() {
  protocol.handle("maxload", async (request) => {
    try {
      const url = new URL(request.url); // maxload://app/<path>
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const full = path.normalize(path.join(ROOT, rel));
      if (!full.startsWith(ROOT)) return new Response("forbidden", { status: 403 });
      const data = await fsp.readFile(full);
      const ext = path.extname(full).toLowerCase();
      return new Response(data, { headers: { "content-type": MIME[ext] || "application/octet-stream" } });
    } catch (e) {
      return new Response("not found: " + e.message, { status: 404 });
    }
  });
}

// ---------------------------------------------------------------------------
process.on("uncaughtException", (e) => { console.error("[MaxLoad] uncaughtException:", e); });

app.whenReady().then(() => {
  store.load();
  registerProtocol();
  registerIpc();
  createWindow();

  // Smoke test: MAXLOAD_SMOKE=1 makes the app self-report and exit once the
  // Maximo view has loaded + content scripts injected, so headless CI can verify.
  if (process.env.MAXLOAD_SMOKE) {
    maximoWC().on("dom-ready", () => {
      setTimeout(async () => {
        const out = (s) => { process.stdout.write(s + "\n"); };
        try {
          const hasBridge = await maximoWC().executeJavaScript("!!window.__maxload");
          const hasChrome = await maximoWC().executeJavaScript("!!(window.chrome && window.chrome.__maxloadShim)");
          const hasMaxLoad = await maximoWC().executeJavaScript("!!(window.MaxLoad && window.MaxLoad.env)");
          const listenerCount = await maximoWC().executeJavaScript("(window.MaxLoad&&window.MaxLoad.recorder)?'engine-loaded':'no-engine'");
          const panelChrome = await panelWC().executeJavaScript("!!(window.chrome && window.chrome.__maxloadShim)").catch(() => false);
          out("SMOKE1 bridge=" + hasBridge + " chrome=" + hasChrome + " MaxLoad=" + hasMaxLoad + " engine=" + listenerCount + " panelChrome=" + panelChrome);
          // ping the frame-bridge over the full push/response round-trip (4s cap)
          const ping = await Promise.race([
            pushTo(maximoWC(), { type: "ml:cmd:ping" }, true),
            new Promise((r) => setTimeout(() => r("timeout"), 4000))
          ]);
          out("SMOKE2 ping=" + JSON.stringify(ping));
        } catch (e) {
          out("SMOKE error " + (e && e.message));
        }
        setTimeout(() => app.quit(), 300);
      }, 1500);
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  flushLogs();
  if (process.platform !== "darwin") app.quit();
});
