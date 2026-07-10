/* MaxLoad — Status / synonym-domain dropdown (menu) selection.
 *
 * Maximo status menus are custom menus, NOT <select> boxes:
 *   - each option's id encodes the internal CODE:  menu0_INPRG_OPTION_a -> INPRG
 *     (codes may contain underscores, e.g. ATT_EXEC)
 *   - the visible text is localized ("In progress" / "Encours")
 *   - ids regenerate every login; the menu <ul> carries data-opener-id pointing
 *     at the arrow that opened it, and that arrow's `lc` points back at its field.
 *
 * So we drive the menu BY CODE (from the option id) — language-independent and
 * stable. This module is used both while TEACHING (extract the code + capture how
 * the menu was opened) and at REPLAY (open the menu, click the option whose id
 * ends in _CODE_OPTION_a, else exact option text, else fail loudly — never a
 * look-alike).
 */
(function () {
  "use strict";
  const MaxLoad = window.MaxLoad;
  const norm = MaxLoad.util.normLabel;
  const isVisible = MaxLoad.util.isVisible;

  function cssEsc(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\]/g, "\\$&");
  }
  function docs() {
    return MaxLoad.dom.collectDocuments(document);
  }
  function optText(a) {
    return MaxLoad.util.elementText
      ? MaxLoad.util.elementText(a, 60)
      : (a.textContent || "").trim();
  }

  // ---- option code from an id -----------------------------------------------
  // ^menu\d+_<CODE>_OPTION[_a[_tnode]] — ANCHORED like the reference impl, so a
  // generic id (…_ns_menu_queryMenuItem_3) can't false-match. CODE may contain
  // underscores (ATT_EXEC).
  const OPTION_ID_RE = /^menu\d+_(.+?)_OPTION(?:_a(?:_tnode)?)?$/i;
  function codeFromId(id) {
    const m = String(id || "").match(OPTION_ID_RE);
    return m ? m[1] : "";
  }

  // ---- the open menu's option anchors ---------------------------------------
  // The Maximo STATUS value menu is tagged target="status_menus" (see the real
  // markup). The toolbar "Select Action" menu (New Work Order / Change Status /
  // …) is a DIFFERENT menu with _OPTION items too — so we must read options ONLY
  // from the status menu, or we'd match against the wrong list and think the
  // dropdown is "open" when it isn't.
  function statusMenus() {
    const out = [];
    for (const doc of docs()) {
      let uls;
      try {
        uls = doc.querySelectorAll(
          "ul[role=menu][target*='status' i], ul[target*='status' i], [data-menu-div][target*='status' i]"
        );
      } catch (_) {
        continue;
      }
      for (const ul of uls) if (isVisible(ul)) out.push(ul);
    }
    return out;
  }
  function menuOptions() {
    const out = [];
    for (const root of statusMenus()) {
      let els;
      try {
        els = root.querySelectorAll(
          "a[role=menuitem], a[id*='_OPTION'], li[eventtype] > a[href]"
        );
      } catch (_) {
        continue;
      }
      for (const a of els) if (isVisible(a)) out.push(a);
    }
    return out;
  }
  function menuOpen() {
    return menuOptions().length > 0;
  }

  // ==== RECORDER helpers ======================================================

  /** Walk up (<=8) from a clicked node for a status-menu option; return its code. */
  function synonymOption(node) {
    let el = node;
    for (let i = 0; i < 8 && el; i++, el = el.parentElement) {
      const code = codeFromId(el.id);
      if (code) return { code, el };
    }
    return null;
  }

  /** The field element an opener (arrow/image) drives. Maximo: the arrow's `lc`
   *  attribute is its field's id; else the nearest control in its cell. */
  function fieldForOpener(opener) {
    if (!opener) return null;
    const doc = opener.ownerDocument;
    const lc = opener.getAttribute && opener.getAttribute("lc");
    let field = lc ? doc.getElementById(lc) : null;
    if (!field) {
      const cell = opener.closest && opener.closest("td, div, span");
      field = cell && cell.querySelector("input, textarea, [role=combobox]");
    }
    return field || null;
  }

  /** From a clicked option, capture how the menu was opened (id + stable anchors). */
  function openerOf(optionEl) {
    const doc = (optionEl && optionEl.ownerDocument) || document;
    let menu =
      optionEl && optionEl.closest && optionEl.closest("[data-opener-id]");
    if (!menu) {
      const opts = menuOptions();
      if (opts.length && opts[0].closest)
        menu = opts[0].closest("[data-opener-id]");
    }
    const openerId = (menu && menu.getAttribute("data-opener-id")) || "";
    const opener = openerId ? doc.getElementById(openerId) : null;
    const field = fieldForOpener(opener);
    return {
      id: openerId, // live id — fast path only, regenerates between logins
      title: (opener && opener.getAttribute("title")) || "", // e.g. "Image déroulante"
      near: field ? MaxLoad.dom.labelFor(field) : "", // e.g. "Nouveau statut" — stable
      // FULL field fingerprint — the same capture the binder uses for field
      // steps — so replay relocates the status field with binder.locate() (exact,
      // frame-aware, language-independent) instead of fuzzy label matching.
      binding:
        field && MaxLoad.binder && MaxLoad.binder.captureBinding
          ? MaxLoad.binder.captureBinding("field", field)
          : null,
    };
  }

  // ==== REPLAY ================================================================

  // ---- resolve + click the opener (re-open the menu) ------------------------
  function arrowForField(field) {
    if (!field) return null;
    const doc = field.ownerDocument;
    const liId = field.getAttribute && field.getAttribute("li");
    if (liId) {
      const e = doc.getElementById(liId);
      if (e && isVisible(e)) return e;
    }
    const id = field.id || "";
    const base = id.replace(/[-_](tb|input|txt|value)\d*$/i, "");
    if (base && base !== id) {
      for (const suf of ["-img", "_img", "-image", "_image"]) {
        const e = doc.getElementById(base + suf);
        if (e && isVisible(e)) return e;
      }
    }
    const cell = field.closest && field.closest("td, div, span");
    const scope = cell || field.parentElement || doc;
    let e = null;
    try {
      e = scope.querySelector(
        "img[alt*='roulante' i], img[alt*='dropdown' i], img[title*='roulante' i], img[id$='-img'], img[id$='_img'], [aria-haspopup]"
      );
    } catch (_) {}
    return e && isVisible(e) ? e : null;
  }

  function fieldByLabel(label) {
    if (!label) return null;
    let best = null;
    let bestS = 0.7;
    for (const f of MaxLoad.dom.scanFields()) {
      const s = MaxLoad.util.similarity(f.label, label);
      if (s > bestS) {
        bestS = s;
        best = f.el;
      }
    }
    return best;
  }

  /** Locate the opener control from its stable anchors. Order: live id (same
   *  session) -> NEAR field label (unique, e.g. "Nouveau statut") -> title. The
   *  title ("Image déroulante") is shared by every combo, so it comes last. */
  function resolveOpener(opener) {
    if (!opener) return null;
    if (opener.id) {
      for (const d of docs()) {
        const e = d.getElementById(opener.id);
        if (e && isVisible(e)) return e;
      }
    }
    if (opener.near) {
      const arrow = arrowForField(fieldByLabel(opener.near));
      if (arrow) return arrow;
    }
    if (opener.title) {
      for (const d of docs()) {
        let els;
        try {
          els = d.querySelectorAll(`[title="${cssEsc(opener.title)}"]`);
        } catch (_) {
          continue;
        }
        for (const e of els) if (isVisible(e)) return e;
      }
    }
    return null;
  }

  /** Poll (lightweight) until the menu's options appear, or timeout. Returns as
   *  soon as the menu is up, so an already-open menu costs ~0. */
  async function waitForMenu(timeoutMs) {
    const start = MaxLoad.util.now();
    while (MaxLoad.util.now() - start < timeoutMs) {
      if (menuOpen()) return true;
      await MaxLoad.util.sleep(100);
    }
    return menuOpen();
  }
  /** Poll until an element is no longer visible (its menu closed), or timeout. */
  async function pollGone(el, timeoutMs) {
    const start = MaxLoad.util.now();
    while (MaxLoad.util.now() - start < timeoutMs) {
      if (!isVisible(el)) return true;
      await MaxLoad.util.sleep(80);
    }
    return !isVisible(el);
  }

  /** Dispatch a full key sequence directly on an element (Maximo reads keyCode). */
  function fireKeyOn(el, key, keyCode) {
    try {
      el.focus();
      const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      const K = win.KeyboardEvent || KeyboardEvent;
      const opt = {
        key,
        code: key,
        keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true,
      };
      el.dispatchEvent(new K("keydown", opt));
      el.dispatchEvent(new K("keypress", opt));
      el.dispatchEvent(new K("keyup", opt));
    } catch (_) {}
  }

  /** Every visible Maximo combobox on screen — an input carrying an `li` arrow
   *  attribute (Maximo pairs the field with its dropdown image via `li`). The
   *  Change-Status dialog's "New Status" combo is one of these; we don't rely on
   *  its localized label. */
  function comboFields() {
    const out = [];
    for (const doc of docs()) {
      let els;
      try {
        els = doc.querySelectorAll(
          "input[li], [role=combobox][li], input[role=combobox]"
        );
      } catch (_) {
        continue;
      }
      for (const el of els) if (isVisible(el)) out.push(el);
    }
    return out;
  }

  /**
   * Make the STATUS menu VERIFIABLY open — patiently. Three things made this flaky:
   *   1. The Change-Status dialog paints slowly, so a single early attempt found
   *      nothing and gave up. Here we RETRY for up to ~10s, re-resolving the field
   *      each pass as the dialog renders.
   *   2. Relying on the recorded arrow / the localized label broke cross-language
   *      and when the arrow id regenerated. Here we resolve the field by its
   *      captured fingerprint (binder.locate) first, then generically by its `li`
   *      arrow attribute — and, because menuOpen() only accepts a
   *      target="status_menus" menu, trying each combobox is safe: only the
   *      status one counts as "open".
   *   3. Maximo IGNORES synthetic (isTrusted=false) events, so the old order —
   *      synthetic clicks first, a trusted CDP click last and only on the arrow —
   *      meant the menu often never opened. We now lead with a TRUSTED CDP click
   *      (real OS input, exactly like a human click) on the field, then the arrow,
   *      then a trusted key; synthetic clicks are only a last-ditch fallback.
   */
  async function openMenu(opener) {
    const deadline = MaxLoad.util.now() + 10000;
    const tryOpen = async (fn, waitMs) => {
      if (menuOpen()) return true;
      try {
        await fn();
      } catch (_) {}
      return await waitForMenu(waitMs);
    };

    while (MaxLoad.util.now() < deadline) {
      if (menuOpen()) return true;

      // candidates, best-first: the taught field by its captured FINGERPRINT
      // (binder.locate — the exact, frame-aware path field steps rely on), then
      // by its label, then every combobox on screen. Re-resolved each pass so a
      // still-rendering dialog is picked up as soon as it appears.
      const cands = [];
      const push = (el) => {
        if (el && !cands.includes(el)) cands.push(el);
      };
      if (opener && opener.binding && MaxLoad.binder)
        push(MaxLoad.binder.locate(opener.binding));
      if (opener && opener.near) push(fieldByLabel(opener.near));
      // Only when the teach captured NO opener do we scan every combobox on screen.
      // With a taught opener we act ONLY on that field/arrow — clicking every combo
      // to "find" the menu is exactly the "clicking everywhere" you saw.
      const haveTaughtOpener = !!(opener && (opener.binding || opener.near || opener.id));
      if (!haveTaughtOpener) for (const f of comboFields()) push(f);
      if (!cands.length) {
        await MaxLoad.util.sleep(300);
        continue;
      } // taught field not rendered yet — wait and re-resolve, never spray clicks

      for (const field of cands) {
        const arrow = arrowForField(field) || resolveOpener(opener);
        // TRUSTED FIRST. Maximo ignores synthetic (isTrusted=false) events, so a
        // real OS click (CDP) on the field/arrow is the only thing that reliably
        // drops the menu — exactly what your hand does. Escalate: trusted click on
        // the field (big target), trusted click on the arrow, a trusted ArrowDown,
        // then synthetic clicks as a last-ditch (for non-Maximo combos only).
        if (field && (await tryOpen(() => MaxLoad.input.click(field), 800)))
          return true;
        if (arrow && (await tryOpen(() => MaxLoad.input.click(arrow), 800)))
          return true;
        if (
          field &&
          (await tryOpen(async () => {
            try {
              field.focus();
            } catch (_) {}
            await MaxLoad.input.pressKey("ArrowDown");
          }, 500))
        )
          return true;
        if (field && (await tryOpen(() => MaxLoad.util.realClick(field), 400)))
          return true;
        if (arrow && (await tryOpen(() => MaxLoad.util.realClick(arrow), 400)))
          return true;
      }
      await MaxLoad.util.sleep(200);
    }
    return menuOpen();
  }

  /** Select an option BY OUTCOME. Success = the CLICKED option DISAPPEARS (its
   *  menu closed) — verified on the option itself, NOT a global menu check (which
   *  stays true when unrelated _OPTION anchors linger in the DOM). Escalate
   *  through methods until one takes. */
  async function pickOption(optEl) {
    const inner =
      (optEl.querySelector && optEl.querySelector("span, div")) || optEl;
    const methods = [
      () => MaxLoad.util.realClick(optEl), // synthetic click on the anchor
      () => MaxLoad.util.realClick(inner), // synthetic click on the visible label
      () => fireKeyOn(optEl, "Enter", 13), // keyboard Enter on the option
      async () => {
        await MaxLoad.input.click(optEl);
      }, // trusted CDP click
    ];
    for (const m of methods) {
      try {
        await m();
      } catch (_) {}
      if (await pollGone(optEl, 700)) return true;
    }
    return !isVisible(optEl);
  }

  // ---- choose the option -----------------------------------------------------
  function normCode(v) {
    return String(v || "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "_");
  }
  /** Lowercase, strip accents + punctuation — so "Complétée" == "completee" and
   *  "En attente d'approbation" matches regardless of accents/apostrophes. */
  function normText(s) {
    return String(s || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  // Canonical Maximo status CODE -> known display labels (English + French, incl.
  // the custom synonym-domain values seen in the field). The "static real names"
  // bridge: a sheet may hold the CODE (INPRG) or a LABEL in any language ("In
  // progress" / "En cours"), and a menu may be localized either way — we still
  // resolve to the right option. Extend this as new statuses appear.
  const STATUS_SYNONYMS = {
    WAPPR: ["Waiting on Approval", "En attente d'approbation"],
    APPR: ["Approved", "Approuvé", "Approuvée"],
    INPRG: ["In Progress", "En cours"],
    COMP: ["Completed", "Terminé"],
    CLOSE: ["Closed", "Fermé", "Fermée"],
    CAN: ["Canceled", "Cancelled", "Annulé", "Annulée"],
    WMATL: ["Waiting on Material", "En attente de matériel"],
    WSCH: ["Waiting to be Scheduled", "En attente de planification"],
    WPCOND: [
      "Waiting on Plant Conditions",
      "Waiting on plant cond",
      "En attente des conditions d'usine",
    ],
    SCHED: ["Scheduled", "Planifié", "Planifiée"],
    DEFERRED: ["Deferred", "Reporté", "Différé"],
    HISTEDIT: ["History Edited"],
    // custom French synonym-domain values observed in the field
    ATT_EXEC: ["Attente Exécution"],
    ATT_ORD: ["Attente Ordonnancement"],
    ATT_HSE: ["Attente HSE"],
    ANNULEE: ["Annulée"],
    CLOTUREE: ["Clôturée"],
    ABONDONEE: ["Abondonée", "Abandonnée"],
    ACCEPTE: ["Accepté", "Acceptée"],
    COMPLETEE: ["Complétée"],
    ENCOURS: ["Encours"],
    TERMINEE: ["Terminée"],
    REJETEE: ["Rejetée", "Rejeté"],
  };
  // reverse index: normalized code OR label -> canonical code
  const LABEL_TO_CODE = {};
  for (const code in STATUS_SYNONYMS) {
    LABEL_TO_CODE[normCode(code)] = code;
    for (const lbl of STATUS_SYNONYMS[code])
      LABEL_TO_CODE[normText(lbl)] = code;
  }

  /** Any value (code or label, any language) -> canonical code + all aliases. */
  function synonymsFor(value) {
    const code =
      LABEL_TO_CODE[normCode(value)] || LABEL_TO_CODE[normText(value)] || null;
    const wants = new Set();
    if (code) {
      wants.add(normCode(code));
      for (const lbl of STATUS_SYNONYMS[code] || []) wants.add(normText(lbl));
    }
    return { code, wants };
  }

  /** The internal code of an option — from its id, else the menuClick() payload. */
  function optionCode(a) {
    const li = (a.closest && a.closest("li")) || a;
    let c = codeFromId(a.id) || codeFromId(li.id);
    if (c) return c;
    const hay =
      (a.getAttribute("href") || "") + " " + (a.getAttribute("onclick") || "");
    const mv =
      hay.match(/["']value["']\s*:\s*["']([^"']+)["']/i) ||
      hay.match(/["']id["']\s*:\s*["']([^"']+)["']/i);
    return mv ? String(mv[1]).replace(/_OPTION.*$/i, "") : "";
  }

  /** Option whose internal code EXACTLY equals `code` (no WAPPR/APPR collision). */
  function findByCode(code) {
    const c = normCode(code);
    if (!c) return null;
    for (const a of menuOptions()) if (normCode(optionCode(a)) === c) return a;
    return null;
  }
  /** Exact visible-text match (accent/punctuation-insensitive, never substring). */
  function findByExactText(value) {
    const want = normText(value);
    if (!want) return null;
    for (const a of menuOptions()) if (normText(optText(a)) === want) return a;
    return null;
  }

  /**
   * Resolve the option for a sheet value, most-precise first:
   *   1. exact internal CODE (option id / menuClick payload)
   *   2. exact visible TEXT
   *   3. STATIC SYNONYM dictionary — map the value to its canonical code + every
   *      known label (EN/FR) and match any of them against each option's code OR
   *      text. Makes "INPRG" work on a French menu ("En cours"), and a sheet that
   *      stores a label work on any menu — instead of guessing.
   */
  function findOption(value) {
    let opt = findByCode(value) || findByExactText(value);
    if (opt) return opt;
    const syn = synonymsFor(value);
    if (syn.code) {
      opt = findByCode(syn.code);
      if (opt) return opt;
    }
    if (syn.wants.size) {
      for (const a of menuOptions()) {
        const code = normCode(optionCode(a));
        const label = normText(optText(a));
        if ((code && syn.wants.has(code)) || (label && syn.wants.has(label)))
          return a;
      }
    }
    return null;
  }

  function listCodes() {
    return [
      ...new Set(
        menuOptions()
          .map((a) => optionCode(a) || optText(a))
          .filter(Boolean)
      ),
    ]
      .slice(0, 16)
      .join(", ");
  }

  // ==== NATIVE bridge client (talks to maximo-native.js in the MAIN world) ====
  // The bridge can call Maximo's own menuClick(), so it applies a status WITHOUT
  // the menu having to open on screen — the most reliable path. We message it via
  // window.postMessage and take the first frame that owns the status menu.

  let nativeSeq = 0;
  /** Post one request to `win`'s MAIN-world bridge and await its reply. Resolves
   *  { ok, ... } or a { ok:false, reason } on timeout / no bridge. */
  function nativeCall(win, op, args, timeoutMs) {
    return new Promise((resolve) => {
      const id =
        "mln-" + ++nativeSeq + "-" + Math.random().toString(36).slice(2, 7);
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        window.removeEventListener("message", onMsg, false);
        resolve(val);
      };
      const onMsg = (ev) => {
        const d = ev.data;
        if (!d || d.__mlNative !== true || d.dir !== "res" || d.id !== id)
          return;
        finish(
          d.result ||
            (d.ok ? { ok: true } : { ok: false, reason: d.error || "err" })
        );
      };
      window.addEventListener("message", onMsg, false);
      try {
        win.postMessage({ __mlNative: true, dir: "req", id, op, args }, "*");
      } catch (_) {
        finish({ ok: false, reason: "post-failed" });
        return;
      }
      setTimeout(
        () => finish({ ok: false, reason: "timeout" }),
        timeoutMs || 4000
      );
    });
  }

  /** This frame's window + every same-origin child frame's window. */
  function candidateWindows() {
    const wins = [window];
    const seen = new Set(wins);
    for (const doc of docs()) {
      const w = doc.defaultView;
      if (w && !seen.has(w)) {
        seen.add(w);
        wins.push(w);
      }
    }
    return wins;
  }

  /** Resolve as soon as ANY promise reports ok; otherwise the last meaningful
   *  failure once all settle. Avoids blocking on a frame that has no bridge. */
  function firstOk(promises) {
    return new Promise((resolve) => {
      let remaining = promises.length;
      let fallback = { ok: false, reason: "no-frame" };
      if (!remaining) return resolve(fallback);
      const settle = (r) => {
        if (r && r.ok) return resolve(r);
        if (r && r.reason && r.reason !== "not-here" && r.reason !== "timeout")
          fallback = { ok: false, reason: r.reason };
        if (--remaining === 0) resolve(fallback);
      };
      for (const p of promises) p.then(settle, () => settle(null));
    });
  }

  /** Ask Maximo (natively) to set the status. Resolves value -> canonical code +
   *  known labels, then lets the MAIN-world bridge invoke menuClick. Returns the
   *  bridge result, or { ok:false, reason } if no frame could do it. */
  async function nativeSetStatus(value, opener) {
    const syn = synonymsFor(value);
    const code = syn.code || normCode(value);
    const labels = [];
    if (syn.code && STATUS_SYNONYMS[syn.code])
      labels.push(...STATUS_SYNONYMS[syn.code]);
    labels.push(value);
    const args = {
      code,
      labels,
      openerId: (opener && opener.id) || "",
      fieldId: (opener && opener.binding && opener.binding.id) || "",
      near: (opener && opener.near) || "", // the field label, e.g. "New Status"
    };
    return firstOk(
      candidateWindows().map((w) => nativeCall(w, "setStatus", args, 6000))
    );
  }

  /**
   * Open the status menu (if not already open) and click the option matching
   * `value`. Resolution order: NATIVE menuClick (bridge) -> CODE (option id) ->
   * exact option TEXT -> fail (no look-alike click). Returns { ok } or
   * { ok:false, message }.
   */
  async function selectSynonym(value, opener) {
    const v = String(value == null ? "" : value).trim();
    if (!v) return { ok: true, skipped: true };

    // 0. NATIVE FIRST — have Maximo apply the status via its own menuClick(). This
    //    works whether or not the menu is visually open, so it removes the whole
    //    "the dropdown never opens" failure class. Falls through to the click flow
    //    below if the bridge isn't present or the menu isn't built in any frame.
    try {
      const nat = await nativeSetStatus(v, opener);
      if (nat && nat.ok) {
        await MaxLoad.settle.waitForSettleOrModal({
          quietMs: 200,
          timeoutMs: 600,
        });
        return { ok: true, code: nat.code, label: nat.label, via: "native" };
      }
      MaxLoad.log &&
        MaxLoad.log(
          "native status set unavailable (" +
            (nat && nat.reason) +
            ") — using click flow"
        );
    } catch (e) {
      MaxLoad.warn &&
        MaxLoad.warn(
          "native status set error: " + String(e && e.message ? e.message : e)
        );
    }

    // 1. OPEN the menu — by OUTCOME (several methods, each verified). Returns fast
    //    if the preceding opener click already opened it.
    let open = await openMenu(opener);
    if (!open)
      return { ok: false, message: "could not open the status dropdown" };

    // 2. find the option: exact code -> exact text -> static synonym dictionary
    let opt = findOption(v);

    // 2b. WRONG menu open (the opener-click may have hit a different combo's
    //     arrow)? Close it and re-open the RIGHT one via the field label, retry.
    if (!opt && opener && (opener.near || opener.title || opener.id)) {
      try {
        await MaxLoad.input.pressKey("Escape");
      } catch (_) {}
      await MaxLoad.util.sleep(150);
      if (await openMenu(opener)) opt = findOption(v);
    }

    if (!opt) {
      try {
        await MaxLoad.input.pressKey("Escape");
      } catch (_) {}
      return {
        ok: false,
        message: `"${v}" not offered by the list (options: ${listCodes()})`,
      };
    }

    // 3. PICK — by OUTCOME (synthetic first, verify the menu closed, else CDP).
    MaxLoad.hl && MaxLoad.hl.flash(opt, "field");
    const code = codeFromId(opt.id);
    const label = optText(opt);
    const picked = await pickOption(opt);
    await MaxLoad.settle.waitForSettleOrModal({ quietMs: 200, timeoutMs: 600 });
    if (!picked)
      return {
        ok: false,
        message: `found "${v}" but the option click didn't register`,
      };
    return { ok: true, code, label };
  }

  MaxLoad.menu = {
    // recorder
    codeFromId,
    synonymOption,
    openerOf,
    // replay
    selectSynonym,
    menuOpen,
    menuOptions,
    openMenu,
    resolveOpener,
  };
})();
