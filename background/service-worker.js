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
const LOG_CAP = 3000;
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

async function cdpClick(tabId, x, y) {
  await ensureAttached(tabId);
  const p = { x, y, button: "left" };
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...p, buttons: 0 });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...p, buttons: 1, clickCount: 1 });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...p, buttons: 0, clickCount: 1 });
}

async function cdpKey(tabId, key, code, vk, modifiers) {
  const base = { key, code, windowsVirtualKeyCode: vk || 0, nativeVirtualKeyCode: vk || 0, modifiers: modifiers || 0 };
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

// select existing content (Ctrl+A + Delete) then overwrite via trusted text
// insertion, and optionally commit with Tab/Enter — all on the FOCUSED element.
async function cdpClearInsert(tabId, text, commitKey) {
  await cdpKey(tabId, "a", "KeyA", 65, 2 /* Ctrl */);
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  if (text) await cdp(tabId, "Input.insertText", { text: String(text) });
  if (commitKey === "tab") await cdpKey(tabId, "Tab", "Tab", 9);
  else if (commitKey === "enter") await cdpKey(tabId, "Enter", "Enter", 13);
}

async function cdpType(tabId, x, y, text, commitKey) {
  await ensureAttached(tabId);
  await cdpClick(tabId, x, y); // focus the field with a real click at (x,y)
  await cdpClearInsert(tabId, text, commitKey);
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

    case "ml:cdp:type": {
      const tabId = sender.tab && sender.tab.id;
      if (tabId == null) { sendResponse({ ok: false, error: "no tab" }); return true; }
      cdpType(tabId, msg.x, msg.y, msg.text, msg.commitKey).then(
        () => sendResponse({ ok: true }),
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
