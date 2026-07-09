/* MaxLoad — Recorder / Teach (follow-what-you-do).
 *
 * You demonstrate the process once on the real Maximo screen. MaxLoad FOLLOWS
 * every action in order and turns it into an editable list of steps:
 *   - click a button / tab / link / icon             -> { type:'click' }
 *   - click a field (explicit click, not auto-focus) -> { type:'set-field' }
 *   - type/change a field's value                    -> updates that step's sample
 *   - press Enter (e.g. to submit a search)          -> { type:'key', key:'Enter' }
 *
 * Fields are recorded only on a real user CLICK — never on programmatic/tab
 * focus or a form auto-focusing on load — so no phantom field steps appear.
 * Meaningless clicks (a wrapper/container with no real label or stable key, or
 * text that is actually inline script) are ignored — only genuine controls are
 * recorded.
 *
 * Then you edit manually in the panel: map each field step to a CSV column
 * (default is "don't fill"), delete steps you don't want, reorder. The recorded
 * SEQUENCE is what replays per row (navigation, search, New, Save all included),
 * with the row's column value injected into each mapped field step.
 */
(function () {
  "use strict";
  if (window.__MAXLOAD_RECORDER__) return; // one recorder per page context (guards double-injection)
  window.__MAXLOAD_RECORDER__ = true;
  const MaxLoad = window.MaxLoad;

  const state = {
    recording: false,
    action: "CREATE",
    steps: [],
    screen: "",
    columns: [],
    startedAt: 0,
    newButton: null // taught "Add / New" button binding (upsert: create-if-not-found)
  };

  function isControl(el) {
    return el && el.matches && el.matches(MaxLoad.dom.CONTROL_SELECTOR);
  }

  function captureBinding(role, el) {
    if (MaxLoad.binder && MaxLoad.binder.captureBinding) return MaxLoad.binder.captureBinding(role, el);
    const fp = MaxLoad.dom.fingerprint(el);
    return {
      role,
      stableKey: MaxLoad.matcher.getStableKey(el) || "",
      id: el.id || "",
      name: el.getAttribute("name") || "",
      controlType: role && role.startsWith("button") ? "button" : fp.type,
      label: fp.label || "",
      tabContext: MaxLoad.dom.activeContexts(el.ownerDocument)[0] || null,
      tag: el.tagName.toLowerCase(),
      text: ""
    };
  }

  function sameBinding(a, b) {
    if (!a || !b) return false;
    if (a.id && b.id) return a.id === b.id;
    if (a.stableKey && b.stableKey) return a.stableKey === b.stableKey && a.name === b.name;
    return false;
  }

  // ---- field steps (created on focus, value updated on change) --------------
  function addOrUpdateFieldStep(el, fromChange) {
    const binding = captureBinding("field", el);
    if (!binding.label && !binding.stableKey && !binding.id) return;
    const value = el.type === "checkbox" ? String(el.checked) : el.value;

    // update the most recent matching field step if it exists
    for (let i = state.steps.length - 1; i >= 0; i--) {
      const s = state.steps[i];
      if (s.type === "set-field" && sameBinding(s.binding, binding)) {
        if (fromChange) s.sampleValue = value;
        broadcast();
        return;
      }
      if (s.type !== "set-field") break; // only merge with adjacent field steps
    }
    state.steps.push({
      id: MaxLoad.util.uid(),
      type: "set-field",
      binding,
      target: { label: binding.label, stableKey: binding.stableKey, controlType: binding.controlType, tabContext: binding.tabContext },
      column: "__ignore__", // manual mapping — default: don't fill
      sampleValue: value
    });
    MaxLoad.log("teach: field " + (binding.label || binding.stableKey));
    broadcast();
  }

  // ---- click steps (buttons, tabs, links, icons) ----------------------------
  /** Stray inline script / code text that must never become a step label. */
  function looksLikeCode(s) {
    return /[{};]|=>|\bfunction\b|\bvar\b|\bif\s*\(/.test(s || "");
  }

  function addClickStep(el) {
    let text = (
      MaxLoad.util.elementText(el, 60) ||
      el.value || el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("aria-label") || ""
    ).trim().slice(0, 60);
    if (looksLikeCode(text)) text = ""; // don't label a step with stray script/code

    const norm = MaxLoad.util.normLabel(text);
    let role = "button:other";
    if (/^save/.test(norm)) role = "button:save";
    else if (/^(new|insert|add|create)/.test(norm) || norm === "+") role = "button:new";
    const binding = captureBinding(role, el);

    // Maximo grid internals (row-select "tempselect", list toggles) get captured
    // as clicks but are noise that makes replay misfire — never record them.
    if (MaxLoad.matcher.isJunkClick({ ...binding, text: text || binding.text })) return;

    // Only record clicks with a REAL identity — a human label OR a meaningful
    // stable key. This drops the meaningless container/script clicks (no label,
    // just a volatile Maximo id) that appeared as junk steps.
    const meaningfulKey = MaxLoad.matcher.meaningfulKey(binding.stableKey);
    if (!text && !meaningfulKey) return;

    // Capture WHICH one it is when the page has repeats (many identical "Nouvelle
    // ligne" / New Row buttons, one per table): the section header above it, and
    // its index among same-labelled controls. Replay uses these to click the
    // exact one you did — not the first look-alike.
    try {
      binding.anchor = {
        section: MaxLoad.dom.sectionAnchor(el),
        ord: MaxLoad.dom.ordinalOf(el)
      };
    } catch (_) {}

    const step = { id: MaxLoad.util.uid(), type: "click", binding, text };
    const last = state.steps[state.steps.length - 1];
    if (last && last.type === "click" && sameBinding(last.binding, binding) && last.text === text) return; // dedupe
    state.steps.push(step);
    MaxLoad.log("teach: click " + (text || binding.stableKey));
    broadcast();
  }

  // ---- status/synonym dropdown option -> a `select` step (by internal code) --
  function addSelectStep(syn) {
    const opener = MaxLoad.menu.openerOf(syn.el);
    const label = MaxLoad.util.elementText(syn.el.closest("a,li") || syn.el, 40) || syn.code;
    state.steps.push({
      id: MaxLoad.util.uid(),
      type: "select",
      code: syn.code, // internal status code from the option id (e.g. INPRG)
      sampleValue: syn.code, // shown as the "fixed" choice in the column menu
      sampleLabel: label, // the visible option text (e.g. "In progress")
      opener, // { id, title, near } — how to re-open the menu at replay
      target: { label: (opener && opener.near) || "status", stableKey: syn.code },
      column: "__fixed__" // default: replay the demonstrated status; map to a column for per-row
    });
    MaxLoad.log("teach: select status " + syn.code + " (" + label + ")");
    broadcast();
  }

  // ---- key steps (only Enter — e.g. to submit a search) ---------------------
  function onKeyDown(ev) {
    if (!state.recording) return;
    const key = ev.key;
    if (key !== "Enter") return; // Enter is the only recorded key
    const el = ev.target;
    const binding = isControl(el) ? captureBinding("field", el) : null;
    state.steps.push({
      id: MaxLoad.util.uid(),
      type: "key",
      key,
      binding,
      target: binding
        ? { label: binding.label, stableKey: binding.stableKey, controlType: binding.controlType, tabContext: binding.tabContext }
        : null
    });
    MaxLoad.log("teach: key " + key + (binding ? " in " + (binding.label || binding.stableKey) : ""));
    broadcast();
  }

  /** A fillable field (text/checkbox/select/…) — NOT a button-type input. */
  function isFieldControl(el) {
    if (!isControl(el)) return false;
    if (el.tagName === "INPUT") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      return !["button", "submit", "image", "reset"].includes(t);
    }
    return true; // textarea, select, contenteditable, role=textbox/combobox
  }
  function onChange(ev) {
    if (!state.recording) return;
    if (!isFieldControl(ev.target)) return;
    addOrUpdateFieldStep(ev.target, true);
  }
  // Broad set of "clickable" things so ANY flow is captured — toolbar icons,
  // tabs, links, menu items, tree nodes (relations), table rows, anything with
  // an onclick. Fillable fields are handled by the click branch below, not here.
  const CLICKABLE =
    "button, a, input[type=button], input[type=submit], input[type=image], " +
    "[role=button], [role=tab], [role=menuitem], [role=treeitem], [role=option], [role=gridcell], " +
    "[onclick], img, [id*='_ti'], tr[onclick], td[onclick], .tablerow, [class*='menuitem'], [class*='treenode']";

  function onClick(ev) {
    if (!state.recording) return;
    if (ev.target.closest && ev.target.closest("#maxload-panel-host, #maxload-bind-overlay")) return;
    // a click on a status-menu OPTION -> a `select` step, driven by internal code
    if (MaxLoad.menu && MaxLoad.menu.synonymOption) {
      const syn = MaxLoad.menu.synonymOption(ev.target);
      if (syn) {
        addSelectStep(syn);
        return;
      }
    }
    // an explicit click INTO a fillable field records it — this is the ONLY way
    // a field is captured now (never on auto/tab focus).
    const field = ev.target.closest(MaxLoad.dom.CONTROL_SELECTOR);
    if (field && isFieldControl(field) && MaxLoad.util.isVisible(field)) {
      addOrUpdateFieldStep(field, false);
      return;
    }
    // otherwise a button / tab / link / icon (incl. button-type inputs)
    const el = ev.target.closest(CLICKABLE);
    if (!el) return;
    addClickStep(el);
  }

  function eachDoc(fn) {
    for (const doc of MaxLoad.dom.collectDocuments(document)) fn(doc);
  }
  function attach() {
    eachDoc((doc) => {
      doc.addEventListener("change", onChange, true);
      doc.addEventListener("click", onClick, true);
      doc.addEventListener("keydown", onKeyDown, true);
    });
  }
  function detach() {
    eachDoc((doc) => {
      doc.removeEventListener("change", onChange, true);
      doc.removeEventListener("click", onClick, true);
      doc.removeEventListener("keydown", onKeyDown, true);
    });
  }

  // ---- manual editing (from the panel) --------------------------------------
  function findIndex(stepId) {
    return state.steps.findIndex((s) => s.id === stepId);
  }
  function setStepColumn(stepId, value) {
    const s = state.steps[typeof stepId === "number" ? stepId : findIndex(stepId)];
    if (!s || (s.type !== "set-field" && s.type !== "select")) return;
    s.column = value || (s.type === "select" ? "__fixed__" : "__ignore__");
    broadcast();
  }
  function setStepOperator(stepId, op) {
    const s = state.steps[typeof stepId === "number" ? stepId : findIndex(stepId)];
    if (!s || s.type !== "set-field") return;
    s.operator = op && op !== "none" ? op : null;
    broadcast();
  }
  function setStepSearch(stepId, on) {
    const s = state.steps[typeof stepId === "number" ? stepId : findIndex(stepId)];
    if (!s || s.type !== "set-field") return;
    s.search = !!on; // this field searches & opens the record (UPDATE)
    broadcast();
  }
  function removeStep(stepId) {
    const i = typeof stepId === "number" ? stepId : findIndex(stepId);
    if (i >= 0) state.steps.splice(i, 1);
    broadcast();
  }
  function moveStep(stepId, dir) {
    const i = typeof stepId === "number" ? stepId : findIndex(stepId);
    const j = i + (dir === "up" ? -1 : 1);
    if (i < 0 || j < 0 || j >= state.steps.length) return;
    const tmp = state.steps[i];
    state.steps[i] = state.steps[j];
    state.steps[j] = tmp;
    broadcast();
  }

  // ---- lifecycle -------------------------------------------------------------
  function start(action, columns) {
    state.recording = true;
    // A teach is action-agnostic: the SAME recorded steps serve CREATE, UPDATE and
    // UPSERT rows (per-row `_action` decides at run time). "ANY" tells the batch
    // runner not to skip rows by action. Legacy CREATE/UPDATE still accepted.
    const a = String(action || "ANY").toUpperCase();
    state.action = ["CREATE", "UPDATE", "UPSERT", "ANY"].includes(a) ? a : "ANY";
    state.steps = [];
    state.columns = Array.isArray(columns) ? columns.filter((c) => c && c !== "_action") : [];
    state.screen = document.title || location.pathname;
    state.startedAt = MaxLoad.util.now();
    state.newButton = null; // cleared each fresh teach; set via setNewButton (upsert)
    attach();
    MaxLoad.log("teach started: " + state.action);
    broadcast();
  }
  function stop() {
    state.recording = false;
    detach();
    const wf = buildWorkflow();
    MaxLoad.log("teach stopped, " + state.steps.length + " steps");
    broadcast();
    return wf;
  }

  function buildWorkflow(name) {
    const mappedCols = state.steps
      .filter((s) => (s.type === "set-field" || s.type === "select") && s.column && !["__ignore__", "__fixed__", "__key__"].includes(s.column))
      .map((s) => s.column);
    return {
      id: "wf-" + Date.now().toString(36),
      name: name || (state.action + " — " + (state.screen || "workflow")),
      action: state.action,
      mode: "sequence", // replayed in order, injecting row values into mapped fields
      screen: state.screen,
      url: location.href,
      tenant: MaxLoad.env.tenant,
      createdAt: new Date().toISOString(),
      steps: JSON.parse(JSON.stringify(state.steps)),
      columns: [...new Set(mappedCols)],
      newButton: state.newButton || null // upsert: where to click when a row isn't found
    };
  }

  /** Store the taught "Add / New" button binding (from the point-and-click pick).
   *  Used by the upsert branch to create a record the search didn't find. */
  function setNewButton(binding) {
    state.newButton = binding || null;
    MaxLoad.log("teach: Add button " + (binding ? "learned (" + (binding.text || binding.label || "New") + ")" : "cleared"));
    broadcast();
  }

  function broadcast() {
    if (!MaxLoad.env.isTop) return;
    persist(); // survive a page refresh / navigation mid-teach (see below)
    chrome.runtime?.sendMessage({
      type: "ml:recorder-state",
      recording: state.recording,
      action: state.action,
      columns: state.columns,
      stepCount: state.steps.length,
      steps: state.steps
    });
  }

  // ---- durable session: survive a page refresh / navigation mid-teach -------
  // The recorded steps + "am I recording?" live only in this page-context memory,
  // which a Maximo navigation (Save / New / search / re-login) destroys — silently
  // ending the teach and losing every click. We mirror the session to storage on
  // every change and, on the NEXT content-script load, restore it and RE-ATTACH the
  // listeners so capture continues without a gap. Works in the extension
  // (chrome.storage) and the desktop app (the same chrome.storage shim → file store).
  const SESSION_KEY = "ml:recSession";
  const LS_KEY = "__maxload_recSession"; // synchronous mirror — catches the click that triggers the reload
  const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

  function snapshot() {
    return {
      v: 1, recording: state.recording, action: state.action, columns: state.columns,
      steps: state.steps, screen: state.screen, startedAt: state.startedAt,
      newButton: state.newButton, savedAt: Date.now()
    };
  }
  function persist() {
    const snap = snapshot();
    // localStorage is SYNCHRONOUS, so it flushes even when the click's very next act
    // is to navigate away (chrome.storage.set is async and could be lost in that race).
    try { localStorage.setItem(LS_KEY, JSON.stringify(snap)); } catch (_) {}
    try { chrome.storage && chrome.storage.local.set({ [SESSION_KEY]: snap }); } catch (_) {}
  }
  function clearSession() {
    try { localStorage.removeItem(LS_KEY); } catch (_) {}
    try { chrome.storage && chrome.storage.local.remove(SESSION_KEY); } catch (_) {}
  }
  function applySnapshot(snap) {
    if (!snap || !Array.isArray(snap.steps)) return false;
    if (Date.now() - (snap.savedAt || 0) > SESSION_TTL_MS) return false; // ignore ancient sessions
    state.action = snap.action || "CREATE";
    state.columns = Array.isArray(snap.columns) ? snap.columns : [];
    state.steps = snap.steps;
    state.screen = snap.screen || state.screen;
    state.startedAt = snap.startedAt || MaxLoad.util.now();
    state.newButton = snap.newButton || null;
    if (snap.recording) {
      state.recording = true;
      attach();                                                    // resume capturing NOW
      setTimeout(() => { if (state.recording) attach(); }, 1500);  // re-attach to late-built iframes
      MaxLoad.log("teach: resumed after reload — " + state.steps.length + " steps kept");
    } else {
      MaxLoad.log("teach: recovered " + state.steps.length + " stopped-but-unsaved steps");
    }
    broadcast();
    return true;
  }
  function restoreSession() {
    if (!MaxLoad.env.isTop) return;
    let applied = false;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) applied = applySnapshot(JSON.parse(raw)); // instant — no gap in listening
    } catch (_) {}
    // chrome.storage is authoritative (survives cross-origin nav where localStorage can't).
    try {
      const p = chrome.storage && chrome.storage.local.get(SESSION_KEY);
      if (p && p.then) p.then((o) => { const s = o && o[SESSION_KEY]; if (s && !applied) applySnapshot(s); }).catch(() => {});
    } catch (_) {}
  }
  /** Forget the in-progress session entirely (fresh slate). */
  function discard() {
    state.recording = false;
    detach();
    state.steps = [];
    clearSession();
    broadcast();
  }
  /** Current recorder state — lets the panel recover its UI after ITS own reload. */
  function status() {
    return {
      recording: state.recording, action: state.action,
      columns: state.columns, steps: state.steps, stepCount: state.steps.length,
      newButton: state.newButton
    };
  }

  MaxLoad.recorder = {
    start, stop, buildWorkflow, discard, status, setNewButton,
    setStepColumn, setStepOperator, setStepSearch, removeStep, moveStep,
    get state() { return state; }
  };

  restoreSession(); // auto-recover a teach interrupted by a refresh/navigation
})();
