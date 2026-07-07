/* MaxLoad — Maximo NATIVE bridge (MAIN world).
 *
 * Runs in the PAGE's own JS realm (manifest `world:"MAIN"`), so it can call
 * Maximo's own functions — something a normal content script (isolated world)
 * and even Playwright cannot do. This is the most reliable way to drive the
 * status/synonym dropdown, because we stop *simulating* a user and instead ask
 * Maximo to do exactly what clicking the option does.
 *
 * The whole trick: every status option is an <a> whose href is
 *   javascript: … topLevelMenus['shared'].menuClick({text,id,value,target,event})
 * and that <ul target="status_menus" id="menu0"> is BUILT INTO THE DOM the moment
 * the change-status context exists — visible or not. So we can select a status by
 * invoking that menuClick payload directly, WITHOUT the menu ever having to open
 * on screen. That removes the entire "the dropdown never opens" failure class.
 *
 * If the menu isn't built yet (some renderings build it lazily on first open) we
 * fall back to invoking the opener's NATIVE handlers in the page realm, wait for
 * the menu to appear, then select.
 *
 * Talks to the isolated-world code (menu-select.js) over window.postMessage:
 *   req  { __mlNative:true, dir:'req', id, op, args }
 *   res  { __mlNative:true, dir:'res', id, ok, result, error }
 * It runs in EVERY frame; only the frame that actually owns the status menu
 * answers with ok — the rest reply { ok:false, reason:'not-here' } quickly.
 */
(function () {
  "use strict";
  if (window.__MAXLOAD_NATIVE__) return;
  window.__MAXLOAD_NATIVE__ = true;

  const TAG = "__mlNative";
  const BRIDGE_VERSION = 3;
  const OPTION_ID_RE = /^menu\d+_(.+?)_OPTION(?:_a(?:_tnode)?)?$/i;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => Date.now();

  function codeFromId(id) {
    const m = String(id || "").match(OPTION_ID_RE);
    return m ? m[1] : "";
  }
  function normCode(v) {
    return String(v || "").trim().toUpperCase().replace(/\s+/g, "_");
  }
  function normText(s) {
    return String(s || "")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }
  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const cs = window.getComputedStyle(el);
    if (!cs || cs.visibility === "hidden" || cs.display === "none") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // ---- option discovery (this frame's document only) ------------------------
  /** Every status-menu option anchor, whether the menu is shown or hidden. We
   *  scope to a status_menus menu so a "Select Action" toolbar menu (which also
   *  has _OPTION items) can't be mistaken for the status list. */
  function statusOptionAnchors() {
    const out = [];
    // 1. options inside a menu container explicitly tagged target="status_menus".
    let uls;
    try {
      uls = document.querySelectorAll(
        "ul[target*='status' i], [data-menu-div][target*='status' i]"
      );
    } catch (_) {
      uls = [];
    }
    for (const ul of uls) {
      let els;
      try {
        els = ul.querySelectorAll("a[role='menuitem'], a[id*='_OPTION']");
      } catch (_) {
        continue;
      }
      for (const a of els) out.push(a);
    }
    if (out.length) return out;

    // 2. fallback for renderings that don't tag the <ul>: accept an _OPTION
    //    menuitem ONLY if its menuClick payload targets status_menus. This is
    //    critical — the "Select Action" toolbar menu (New Work Order, Change
    //    Status, …) is ALSO built from _OPTION items, and we must never mistake
    //    it for the status list.
    let els;
    try {
      els = document.querySelectorAll("a[role='menuitem'][id*='_OPTION']");
    } catch (_) {
      els = [];
    }
    for (const a of els) {
      const src = (a.getAttribute("href") || "") + " " + (a.getAttribute("onclick") || "");
      if (/status_menus/i.test(src)) out.push(a);
    }
    return out;
  }
  function menuBuilt() {
    return statusOptionAnchors().length > 0;
  }

  /** The internal code of an option — from its id, else the menuClick payload. */
  function optionCode(a) {
    let c = codeFromId(a.id);
    if (c) return c;
    const li = a.closest && a.closest("li");
    if (li) c = codeFromId(li.id);
    if (c) return c;
    const hay = (a.getAttribute("href") || "") + " " + (a.getAttribute("onclick") || "");
    const mv = hay.match(/["']value["']\s*:\s*["']([^"']+)["']/i) || hay.match(/["']id["']\s*:\s*["']([^"']+)["']/i);
    return mv ? String(mv[1]).replace(/_OPTION.*$/i, "") : "";
  }
  function optionText(a) {
    return (a.textContent || "").replace(/\s+/g, " ").trim();
  }

  /** Find the option anchor for a code + candidate labels. Code is exact (no
   *  WAPPR/APPR collision); text is exact and accent/punctuation-insensitive. */
  function findOption(code, labels) {
    const anchors = statusOptionAnchors();
    const wantCode = normCode(code);
    if (wantCode) {
      for (const a of anchors) if (normCode(optionCode(a)) === wantCode) return a;
    }
    const wantTexts = new Set((labels || []).map(normText).filter(Boolean));
    if (wantTexts.size) {
      for (const a of anchors) if (wantTexts.has(normText(optionText(a)))) return a;
    }
    return null;
  }

  // ---- native selection (the reliable path) ---------------------------------
  /** Apply a status by running Maximo's OWN menuClick for the option — the exact
   *  thing clicking it does, no coordinates, no visibility needed. Prefer the
   *  payload embedded in the option's href; fall back to invoking the anchor's
   *  javascript: href via .click() (which also runs menuClick in the page realm). */
  function invokeOption(a) {
    const src = (a.getAttribute("href") || "") + " " + (a.getAttribute("onclick") || "");
    const m = src.match(/menuClick\(\s*(\{[\s\S]*?\})\s*\)/);
    if (m) {
      try {
        const payload = JSON.parse(m[1]);
        const menus = window.topLevelMenus;
        const bag = menus && (menus.shared || menus["shared"]);
        if (bag && typeof bag.menuClick === "function") {
          bag.menuClick(payload);
          return true;
        }
      } catch (_) {
        /* fall through to the click path */
      }
    }
    // fallback: the anchor's own javascript: href runs menuClick in the page realm
    try { a.click(); return true; } catch (_) {}
    return false;
  }

  // ---- native OPEN (only needed when the menu isn't built yet) ---------------
  /** The dropdown arrow paired with a combo field: Maximo links them via the
   *  field's `li` attribute; else the arrow image in the field's cell. */
  function arrowForField(f) {
    if (!f) return null;
    const li = f.getAttribute && f.getAttribute("li");
    if (li) {
      const e = document.getElementById(li);
      if (e) return e;
    }
    const cell = f.closest && f.closest("td, div, span");
    if (cell) {
      let e = null;
      try {
        e = cell.querySelector("img[id$='-img'], img[id$='_img'], [aria-haspopup]");
      } catch (_) {}
      if (e) return e;
    }
    return null;
  }

  /** The status combo field, located by its label ("New Status" / "Nouveau
   *  statut"). Maximo mirrors the label into aria-label/title on the input. */
  function fieldByLabel(label) {
    const wants = [];
    if (label) wants.push(normText(label));
    for (const d of ["new status", "nouveau statut"]) if (!wants.includes(d)) wants.push(d);
    let els;
    try {
      els = document.querySelectorAll(
        "input[aria-label], textarea[aria-label], [role='combobox'][aria-label], input[title], input[li]"
      );
    } catch (_) {
      return null;
    }
    for (const el of els) {
      const hay = normText(el.getAttribute("aria-label") || el.getAttribute("title") || "");
      if (!hay) continue;
      for (const w of wants) if (w && (hay === w || hay.includes(w) || w.includes(hay))) return el;
    }
    return null;
  }

  /** Locate the arrow/opener that builds+shows the status menu, most-specific
   *  first: live opener id -> taught field id -> field BY LABEL ("New Status")
   *  -> a generic combo arrow on screen. */
  function findOpener(args) {
    args = args || {};
    if (args.openerId) {
      const e = document.getElementById(args.openerId);
      if (e) return e;
    }
    if (args.fieldId) {
      const arrow = arrowForField(document.getElementById(args.fieldId));
      if (arrow) return arrow;
    }
    const byLabel = arrowForField(fieldByLabel(args.near));
    if (byLabel && isVisible(byLabel)) return byLabel;
    // generic: a status combobox's arrow image next to a visible combo field
    let e = null;
    try {
      e = document.querySelector(
        "img[alt*='roulante' i], img[alt*='dropdown' i], img[title*='roulante' i], img[id$='-img'], img[id$='_img'], [aria-haspopup]"
      );
    } catch (_) {}
    return e && isVisible(e) ? e : null;
  }

  /** Fire the opener's native handlers in the page realm (inline onclick /
   *  onmousedown reference page globals, which resolve here). */
  function invokeOpener(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (_) {}
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const base = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
    const fire = (Ctor, type, extra) => {
      try { el.dispatchEvent(new Ctor(type, { ...base, ...(extra || {}) })); } catch (_) {}
    };
    const P = window.PointerEvent;
    if (P) fire(P, "pointerdown", { pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1 });
    fire(window.MouseEvent || MouseEvent, "mousedown", { buttons: 1 });
    try { el.focus && el.focus(); } catch (_) {}
    if (P) fire(P, "pointerup", { pointerId: 1, pointerType: "mouse", isPrimary: true });
    fire(window.MouseEvent || MouseEvent, "mouseup", {});
    // .click() runs an inline onclick AND follows an <a href="javascript:">
    try { el.click(); } catch (_) {}
    fire(window.MouseEvent || MouseEvent, "click", {});
    return true;
  }

  async function ensureBuilt(args, timeoutMs) {
    if (menuBuilt()) return true;
    const opener = findOpener(args);
    if (!opener) return menuBuilt();
    const deadline = now() + (timeoutMs || 3000);
    while (now() < deadline) {
      invokeOpener(opener);
      const t = now() + 600;
      while (now() < t) {
        if (menuBuilt()) return true;
        await sleep(60);
      }
    }
    return menuBuilt();
  }

  // ---- ops ------------------------------------------------------------------
  async function op_probe() {
    const built = menuBuilt();
    return {
      v: BRIDGE_VERSION, // bump on every change so a stale bridge is obvious
      here: built || !!(window.topLevelMenus && window.topLevelMenus.shared),
      built,
      codes: built ? statusOptionAnchors().map((a) => optionCode(a) || optionText(a)).filter(Boolean).slice(0, 24) : []
    };
  }

  async function op_setStatus(args) {
    args = args || {};
    // 1. make sure the menu exists in the DOM (build it natively if lazy).
    if (!menuBuilt()) {
      if (!(window.topLevelMenus && window.topLevelMenus.shared) && !findOpener(args)) {
        return { ok: false, reason: "not-here" }; // this frame doesn't own the status menu
      }
      await ensureBuilt(args, args.openTimeoutMs || 3000);
    }
    if (!menuBuilt()) return { ok: false, reason: "menu-not-built" };

    // 2. select by Maximo's own menuClick — no open, no coordinates.
    const a = findOption(args.code, args.labels);
    if (!a) {
      return { ok: false, reason: "option-not-offered", codes: statusOptionAnchors().map((x) => optionCode(x) || optionText(x)).filter(Boolean).slice(0, 24) };
    }
    const code = optionCode(a);
    const label = optionText(a);
    const done = invokeOption(a);
    return done ? { ok: true, code, label } : { ok: false, reason: "menuclick-failed" };
  }

  const OPS = { probe: op_probe, setStatus: op_setStatus };

  // ---- message plumbing -----------------------------------------------------
  window.addEventListener(
    "message",
    async (ev) => {
      const d = ev.data;
      if (!d || d[TAG] !== true || d.dir !== "req" || !d.id) return;
      const fn = OPS[d.op];
      const reply = (payload) => {
        try {
          const src = ev.source || window;
          src.postMessage({ [TAG]: true, dir: "res", id: d.id, ...payload }, "*");
        } catch (_) {}
      };
      if (!fn) {
        reply({ ok: false, error: "unknown-op" });
        return;
      }
      try {
        const result = await fn(d.args || {});
        reply({ ok: result.ok !== false, result });
      } catch (e) {
        reply({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    },
    false
  );

  try {
    console.log("[MaxLoad] native bridge ready (MAIN world) v" + BRIDGE_VERSION);
  } catch (_) {}
})();
