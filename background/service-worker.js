/* MaxLoad — background service worker (MV3, module).
 * Responsibilities:
 *   1. Toolbar click -> ensure content scripts are injected, toggle the panel.
 *   2. AI resolve -> call Grok (xAI) with the sanitized snippet (no page CSP here).
 *   3. Log ring -> persist ml:log / ml:progress / modal events for overnight
 *      debugging, capped in size.
 * Workflows and settings are read/written directly from the panel via
 * chrome.storage; the SW only owns the log ring + AI proxy.
 */

const LOG_KEY = "ml:logRing";
const LOG_CAP = 6000; // detailed run tracing is chatty — keep more history for diagnosis
const SETTINGS_KEY = "ml:settings";

// Supported AI providers. All are OpenAI-chat-completions compatible, so only
// the base endpoint + default model differ.
const PROVIDERS = {
  xai: { label: "xAI (Grok)", endpoint: "https://api.x.ai/v1/chat/completions", model: "grok-4.3" },
  groq: { label: "Groq", endpoint: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.3-70b-versatile" },
  custom: { label: "Custom (OpenAI-compatible)", endpoint: "", model: "" }
};

const DEFAULT_SETTINGS = {
  aiEnabled: true,
  provider: "xai", // "xai" | "groq" | "custom"
  apiKey: "",
  model: "", // empty => provider default
  endpoint: "", // only used for "custom"
  confidenceThreshold: 70
};

// ---- toolbar click ----------------------------------------------------------
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "ml:cmd:toggle-panel" });
  } catch (e) {
    // content scripts not present (e.g. installed while page already open) —
    // inject them, then toggle.
    try {
      await injectContentScripts(tab.id);
      await new Promise((r) => setTimeout(r, 300));
      await chrome.tabs.sendMessage(tab.id, { type: "ml:cmd:toggle-panel" });
    } catch (e2) {
      console.warn("[MaxLoad] cannot toggle panel:", e2);
    }
  }
});

async function injectContentScripts(tabId) {
  const files = [
    "content/namespace.js",
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
    "engines/excel-engine.js",
    "engines/ai-recovery.js",
    "content/menu-select.js",
    "content/execution-engine.js",
    "content/frame-bridge.js",
    "content/panel-inject.js"
  ];
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files
  });
}

// ---- settings helpers -------------------------------------------------------
async function getSettings() {
  const obj = await chrome.storage.local.get(SETTINGS_KEY);
  const s = { ...DEFAULT_SETTINGS, ...(obj[SETTINGS_KEY] || {}) };
  // migrate the old xAI-only shape
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

// ---- AI proxy (Grok / xAI) --------------------------------------------------
async function aiResolveField(targetLabel, snippet) {
  const settings = await getSettings();
  if (!settings.aiEnabled) return { ok: false, error: "AI disabled in settings" };
  if (!settings.apiKey) return { ok: false, error: "No API key configured" };
  const { endpoint, model, label } = resolveProvider(settings);
  if (!endpoint) return { ok: false, error: "No endpoint configured for provider " + settings.provider };

  const body = {
    model,
    messages: [
      {
        role: "system",
        content:
          "You match form fields from sanitized HTML structure only. Return ONLY the id or name attribute value of the single best-matching element, nothing else."
      },
      {
        role: "user",
        content: `Target field meaning: "${targetLabel}"\nHTML fragment:\n${snippet}`
      }
    ],
    temperature: 0
  };

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`
      },
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

// ---- AI: classify an unknown error dialog -----------------------------------
async function aiClassifyError(text) {
  const settings = await getSettings();
  if (!settings.aiEnabled || !settings.apiKey) return { ok: false, error: "AI unavailable" };
  const { endpoint, model, label } = resolveProvider(settings);
  if (!endpoint) return { ok: false, error: "No endpoint" };

  const body = {
    model,
    messages: [
      {
        role: "system",
        content:
          'Classify an ERP (IBM Maximo) dialog/banner message into exactly one class: ' +
          '"skip" = a row-level data problem (invalid/required/duplicate value) — fail this row but keep processing others; ' +
          '"retryable" = a transient/timing/UI glitch that is safe to retry; ' +
          '"abort" = session expired, not logged in, or a server/system failure that will break every remaining row. ' +
          'Return ONLY compact JSON: {"class":"skip|retryable|abort","reason":"few words"}.'
      },
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

// ---- CDP trusted input (chrome.debugger) ------------------------------------
// Maximo (like many enterprise apps) ignores synthetic events (isTrusted=false).
// We dispatch real OS-level input via the DevTools Protocol, exactly like
// Selenium/Puppeteer, so the page cannot tell it from a human.
const attached = new Set();

function cdp(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

function attach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  await attach(tabId);
  attached.add(tabId);
}

function detach(tabId) {
  return new Promise((resolve) => {
    if (!attached.has(tabId)) return resolve();
    chrome.debugger.detach({ tabId }, () => {
      attached.delete(tabId);
      resolve();
    });
  });
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) attached.delete(source.tabId);
});

// Input is coordinate-free on the hot path: typing and key presses go to the
// FOCUSED node (no pixels). The ONE exception is the last-resort trusted click
// below — it fires only when a Dojo widget ignored BOTH synthetic events and
// keyboard activation, at a point the content script already hit-tested against
// the element, so it never lands on a neighbour.
async function cdpClick(tabId, x, y) {
  await ensureAttached(tabId);
  const p = { x, y, button: "left" };
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...p, buttons: 0 });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...p, buttons: 1, clickCount: 1 });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...p, buttons: 0, clickCount: 1 });
}

// PLAYWRIGHT-STYLE trusted click: resolve the element by a unique selector, ask
// the BROWSER for its box (DOM.getBoxModel — composited across frames, zoom-aware),
// and dispatch a real click at the box centre. This is exactly how Playwright's
// locator.click() targets a node (iAMXLS's click), so it can't drift to a
// neighbour and works under zoom / in iframes — no hand-summed pixel math.
async function cdpClickSelector(tabId, selector) {
  await ensureAttached(tabId);
  // DOM.performSearch traverses the whole tree INCLUDING frames (what DevTools
  // "search" uses), so it finds our marked node wherever it lives. Needs the DOM
  // domain enabled + a document fetched so nodeIds resolve.
  await cdp(tabId, "DOM.enable", {}).catch(() => {});
  await cdp(tabId, "DOM.getDocument", { depth: 1 }).catch(() => {});
  const search = await cdp(tabId, "DOM.performSearch", { query: selector, includeUserAgentShadowDOM: true });
  const count = search && search.resultCount ? search.resultCount : 0;
  if (!count) {
    if (search) await cdp(tabId, "DOM.discardSearchResults", { searchId: search.searchId }).catch(() => {});
    throw new Error("node not found for selector " + selector);
  }
  const got = await cdp(tabId, "DOM.getSearchResults", { searchId: search.searchId, fromIndex: 0, toIndex: count });
  await cdp(tabId, "DOM.discardSearchResults", { searchId: search.searchId }).catch(() => {});
  const nodeIds = (got && got.nodeIds) || [];
  // Get a box; take the last match (deepest/freshest) that yields a real quad.
  let quad = null;
  let nodeId = null;
  for (let i = nodeIds.length - 1; i >= 0 && !quad; i--) {
    const q = await quadFor(tabId, nodeIds[i]);
    if (q) { quad = q; nodeId = nodeIds[i]; }
  }
  if (!quad) throw new Error("no box model for selector " + selector);

  // The box must hold STILL before we dispatch. While the window is being resized
  // (or Maximo is re-flowing) the element moves between measuring and clicking, and
  // a trusted click at the stale point lands on a NEIGHBOUR. Re-measure until two
  // reads agree. The 2nd read is normally instant and matches, so this costs ~nothing
  // on a settled page. Bounded and BEST-EFFORT: if it never settles we click the last
  // known centre anyway — never skip, or Dojo-only controls would stop working.
  let c = quadCenter(quad);
  for (let i = 0; i < 4; i++) {
    const q2 = await quadFor(tabId, nodeId);
    if (!q2) break; // detached mid-measure — go with what we have
    const c2 = quadCenter(q2);
    const settled = Math.abs(c.x - c2.x) < 1 && Math.abs(c.y - c2.y) < 1;
    c = c2;
    if (settled) break;
    await new Promise((r) => setTimeout(r, 50)); // still moving — let it land
  }

  await cdpClick(tabId, c.x, c.y);
  return { x: Math.round(c.x), y: Math.round(c.y) };
}

/** The element's border-box quad, or null if it has no layout / is detached. */
async function quadFor(tabId, nodeId) {
  try {
    const box = await cdp(tabId, "DOM.getBoxModel", { nodeId });
    if (box && box.model && box.model.content && box.model.width > 0 && box.model.height > 0) return box.model.content;
  } catch (_) { /* node may be detached */ }
  return null;
}

/** Centre of a CDP content quad [x1,y1, x2,y2, x3,y3, x4,y4]. */
function quadCenter(q) {
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

async function cdpKey(tabId, key, code, vk, modifiers) {
  const base = { key, code, windowsVirtualKeyCode: vk || 0, nativeVirtualKeyCode: vk || 0, modifiers: modifiers || 0 };
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

// Type ONE character as a genuine key press (keyDown carrying the char text, then
// keyUp) — the way a human keyboard does it. Maximo commits a field change only
// from real key events; a bulk Input.insertText leaves the Dojo bean unchanged, so
// the field re-renders EMPTY on tab-out (a mandatory field then saves blank). This
// mirrors Playwright's pressSequentially, which iAMXLS relies on.
async function cdpTypeChar(tabId, ch) {
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch, key: ch });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: ch });
}

// select existing content (Ctrl+A + Delete) then type the value CHARACTER BY
// CHARACTER with real key events, and optionally commit with Tab/Enter — all on
// the FOCUSED element.
async function cdpClearInsert(tabId, text, commitKey) {
  await cdpKey(tabId, "a", "KeyA", 65, 2 /* Ctrl */);
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  const s = String(text == null ? "" : text);
  for (const ch of s) await cdpTypeChar(tabId, ch);
  if (commitKey === "tab") await cdpKey(tabId, "Tab", "Tab", 9);
  else if (commitKey === "enter") await cdpKey(tabId, "Enter", "Enter", 13);
}

// Coordinate-free typing: the content script has already focused the element in
// JS (el.focus()), so we insert trusted text straight into the focused node —
// no pixel math, immune to scroll position / off-screen fields / mouse movement.
async function cdpTypeFocused(tabId, text, commitKey) {
  await ensureAttached(tabId);
  await cdpClearInsert(tabId, text, commitKey);
}

// ---- log ring ---------------------------------------------------------------
let logBuffer = [];
let flushTimer = null;

async function appendLog(entry) {
  logBuffer.push(entry);
  if (!flushTimer) {
    flushTimer = setTimeout(flushLogs, 500);
  }
}

async function flushLogs() {
  flushTimer = null;
  if (!logBuffer.length) return;
  const obj = await chrome.storage.local.get(LOG_KEY);
  let ring = obj[LOG_KEY] || [];
  ring = ring.concat(logBuffer);
  logBuffer = [];
  if (ring.length > LOG_CAP) ring = ring.slice(ring.length - LOG_CAP);
  await chrome.storage.local.set({ [LOG_KEY]: ring });
}

// ---- message router ---------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;

  switch (msg.type) {
    case "ml:ai-resolve":
      aiResolveField(msg.targetLabel, msg.snippet).then(sendResponse);
      return true; // async

    case "ml:ai-classify-error":
      aiClassifyError(msg.text).then(sendResponse);
      return true; // async

    case "ml:cdp:click": {
      const tabId = sender.tab && sender.tab.id;
      if (tabId == null) { sendResponse({ ok: false, error: "no tab" }); return true; }
      cdpClick(tabId, msg.x, msg.y).then(
        () => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) })
      );
      return true;
    }

    case "ml:cdp:click-selector": {
      const tabId = sender.tab && sender.tab.id;
      if (tabId == null) { sendResponse({ ok: false, error: "no tab" }); return true; }
      cdpClickSelector(tabId, msg.selector).then(
        (r) => sendResponse({ ok: true, x: r.x, y: r.y }),
        (e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) })
      );
      return true;
    }

    case "ml:cdp:type-focused": {
      const tabId = sender.tab && sender.tab.id;
      if (tabId == null) { sendResponse({ ok: false, error: "no tab" }); return true; }
      cdpTypeFocused(tabId, msg.text, msg.commitKey).then(
        () => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) })
      );
      return true;
    }

    case "ml:cdp:key": {
      const tabId = sender.tab && sender.tab.id;
      if (tabId == null) { sendResponse({ ok: false, error: "no tab" }); return true; }
      ensureAttached(tabId)
        .then(() => cdpKey(tabId, msg.key, msg.code, msg.vk, msg.modifiers))
        .then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "ml:cdp:detach": {
      const tabId = sender.tab && sender.tab.id;
      if (tabId != null) detach(tabId);
      sendResponse({ ok: true });
      return false;
    }

    case "ml:log":
      appendLog({ ...msg.entry, tabId: sender.tab?.id ?? null });
      // also forward to any open panel for live view (fire-and-forget)
      return false;

    case "ml:progress":
      appendLog({
        ts: new Date().toISOString(),
        level: "log",
        kind: "progress",
        msg: "progress",
        data: msg.ev
      });
      return false;

    case "ml:modal-detected":
      appendLog({
        ts: new Date().toISOString(),
        level: "warn",
        kind: "modal",
        msg: "modal detected",
        data: { text: msg.text }
      });
      return false;

    case "ml:store:get-logs":
      chrome.storage.local.get(LOG_KEY).then((o) => sendResponse({ ok: true, logs: o[LOG_KEY] || [] }));
      return true;

    case "ml:store:clear-logs":
      chrome.storage.local.set({ [LOG_KEY]: [] }).then(() => sendResponse({ ok: true }));
      return true;

    case "ml:store:get-settings":
      getSettings().then((s) => sendResponse({ ok: true, settings: s }));
      return true;

    case "ml:store:save-settings":
      chrome.storage.local
        .set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, ...(msg.settings || {}) } })
        .then(() => sendResponse({ ok: true }));
      return true;

    default:
      return false;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("[MaxLoad] installed / updated");
});
