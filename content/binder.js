/* MaxLoad — Interactive Binder (point-and-click).
 *
 * Instead of guessing a field from its label (fuzzy, fragile), the user clicks
 * the real element once. We capture its STABLE KEY (Maximo's volatile
 * m<hash>_ prefix and _12 row suffixes stripped) plus id/name/type/label/tab.
 * At run time `locate()` finds the element again by exact stable key — so the
 * same field resolves at confidence 100 on every row, in whatever frame it lives.
 *
 * Runs in EVERY frame (all_frames): a click event only fires in the frame that
 * owns the element, so each frame must be able to capture. Arming/disarming is
 * broadcast to all frames; whichever frame the user clicks in reports the
 * binding back to the panel and everyone disarms.
 */
(function () {
  "use strict";
  const MaxLoad = window.MaxLoad;

  let armed = null; // { role } while waiting for a click
  let overlay = null;

  // ---- highlight overlay (drawn in the frame of the hovered element) --------
  function ensureOverlay(doc) {
    if (overlay && overlay.ownerDocument === doc && doc.body.contains(overlay)) return overlay;
    if (overlay && overlay.remove) overlay.remove();
    overlay = doc.createElement("div");
    overlay.id = "maxload-bind-overlay";
    overlay.style.cssText = [
      "position:fixed",
      "pointer-events:none",
      "z-index:2147483646",
      "border:2px solid #1266d6",
      "background:rgba(18,102,214,.14)",
      "border-radius:4px",
      "transition:all .05s ease",
      "box-shadow:0 0 0 2px rgba(255,255,255,.6)"
    ].join(";");
    doc.documentElement.appendChild(overlay);
    return overlay;
  }

  function moveOverlay(el) {
    const doc = el.ownerDocument;
    const o = ensureOverlay(doc);
    const r = el.getBoundingClientRect();
    o.style.top = r.top - 2 + "px";
    o.style.left = r.left - 2 + "px";
    o.style.width = r.width + 4 + "px";
    o.style.height = r.height + 4 + "px";
    o.style.display = "block";
  }

  function removeOverlay() {
    if (overlay && overlay.remove) overlay.remove();
    overlay = null;
  }

  // ---- which element counts as bindable, depending on role ------------------
  function pickTarget(role, rawEl) {
    if (role && role.startsWith("button")) {
      return rawEl.closest(
        "button, a, input[type=button], input[type=submit], [role=button], img"
      ) || rawEl;
    }
    // field roles: climb to the nearest form control
    if (rawEl.matches && rawEl.matches(MaxLoad.dom.CONTROL_SELECTOR)) return rawEl;
    const inside = rawEl.querySelector && rawEl.querySelector(MaxLoad.dom.CONTROL_SELECTOR);
    if (inside) return inside;
    const near = rawEl.closest && rawEl.closest("td, div, span, label");
    if (near) {
      const c = near.querySelector(MaxLoad.dom.CONTROL_SELECTOR);
      if (c) return c;
    }
    return rawEl;
  }

  function captureBinding(role, el) {
    const isButton = role && role.startsWith("button");
    const fp = MaxLoad.dom.fingerprint(el);
    const binding = {
      role,
      stableKey: MaxLoad.matcher.getStableKey(el) || "",
      id: el.id || "",
      name: el.getAttribute("name") || "",
      controlType: isButton ? "button" : fp.type,
      label: fp.label || "",
      tabContext: MaxLoad.dom.activeContexts(el.ownerDocument)[0] || null,
      tag: el.tagName.toLowerCase(),
      text: isButton
        ? (el.textContent || el.value || el.getAttribute("alt") || el.getAttribute("title") || "").trim().slice(0, 60)
        : "",
      frameUrl: (el.ownerDocument.defaultView || window).location.href.slice(0, 120)
    };
    // Durable, cross-session fingerprint for FIELDS (label+section+tab+maxlength+…).
    // This is what re-locates a field after Maximo regenerates its id on next login.
    if (!isButton) binding.fp = MaxLoad.dom.fieldFingerprint(el);
    return binding;
  }

  /**
   * Re-derive a field's LIVE element from its stable fingerprint using Maximo's own
   * DOM contract: find the `label[for]` whose text matches, follow `for` to the
   * input, disambiguate same-label fields by VISIBLE (active tab) → section →
   * maxlength, and accept ONLY an unambiguous single match — then verify the input
   * points back via `aria-labelledby`. Returns the element or null (never guesses).
   * Ported from iAMXLS navigator.resolveByFingerprint, run directly in the isolated
   * world across all same-origin frames. Pure perception (writes nothing).
   */
  function resolveByFingerprint(fp) {
    if (!fp || !fp.label) return null;
    const want = norm(fp.label);
    const wantSec = fp.section ? norm(fp.section) : "";
    const wantLen = typeof fp.maxLength === "number" ? fp.maxLength : -1;
    let cands = [];
    for (const doc of docs()) {
      let labels;
      try { labels = doc.querySelectorAll("label[for]"); } catch (_) { continue; }
      for (const l of labels) {
        if (norm(l.textContent) !== want) continue;
        let inp = null;
        try { inp = doc.getElementById(l.getAttribute("for")); } catch (_) {}
        if (inp) cands.push({ l, inp });
      }
    }
    if (!cands.length) return null;
    // Prefer the VISIBLE field (the active tab's) — resolves "same label on two
    // tabs" with no tab bookkeeping. Only narrow when it leaves ≥1 candidate.
    const vis = cands.filter((c) => MaxLoad.util.isVisible(c.inp));
    if (vis.length) cands = vis;
    if (wantSec) {
      const bySec = cands.filter((c) => norm(MaxLoad.dom.sectionAnchor(c.inp)) === wantSec);
      if (bySec.length) cands = bySec;
    }
    if (wantLen > 0) {
      const byLen = cands.filter((c) => MaxLoad.dom.maxLenOf(c.inp) === wantLen);
      if (byLen.length) cands = byLen;
    }
    if (cands.length !== 1) return null; // 0 or still many → never guess
    const input = cands[0].inp;
    // Verify the round-trip: the input must point back to a label of the same text.
    const ref = input.getAttribute && input.getAttribute("aria-labelledby");
    if (ref) {
      let back = null;
      try { back = input.ownerDocument.getElementById(ref); } catch (_) {}
      if (back && norm(back.textContent) !== want) return null;
    }
    return input;
  }

  // ---- event handlers (attached only while armed) ---------------------------
  function onMove(ev) {
    if (!armed) return;
    const el = pickTarget(armed.role, ev.target);
    if (el && el.getBoundingClientRect) moveOverlay(el);
  }

  function onClick(ev) {
    if (!armed) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();
    const el = pickTarget(armed.role, ev.target);
    if (!el) return;
    const binding = captureBinding(armed.role, el);
    const role = armed.role;
    disarmLocal();
    try {
      chrome.runtime.sendMessage({ type: "ml:bind:captured", role, binding });
    } catch (_) {}
    // tell every frame to disarm too
    try {
      chrome.runtime.sendMessage({ type: "ml:bind:broadcast-disarm" });
    } catch (_) {}
  }

  function onKey(ev) {
    if (armed && ev.key === "Escape") {
      disarmLocal();
      try {
        chrome.runtime.sendMessage({ type: "ml:bind:cancelled", role: armed && armed.role });
      } catch (_) {}
      try {
        chrome.runtime.sendMessage({ type: "ml:bind:broadcast-disarm" });
      } catch (_) {}
    }
  }

  function docs() {
    return MaxLoad.dom.collectDocuments(document);
  }

  function armLocal(role) {
    armed = { role };
    for (const d of docs()) {
      d.addEventListener("mousemove", onMove, true);
      d.addEventListener("click", onClick, true);
      d.addEventListener("keydown", onKey, true);
      try {
        d.body && (d.body.style.cursor = "crosshair");
      } catch (_) {}
    }
  }

  function disarmLocal() {
    armed = null;
    removeOverlay();
    for (const d of docs()) {
      d.removeEventListener("mousemove", onMove, true);
      d.removeEventListener("click", onClick, true);
      d.removeEventListener("keydown", onKey, true);
      try {
        d.body && (d.body.style.cursor = "");
      } catch (_) {}
    }
  }

  // ---- runtime relocation (used by the execution engine) --------------------
  // DETERMINISTIC, selector-first — modelled on iAMXLS/Playwright, NOT a fuzzy
  // scorer. We match a stored binding to a live element by EXACT signals in
  // priority order (exact label/text → stable id-suffix → same-session id), and
  // commit to a single visible match. When several identical controls match (many
  // "New Row" buttons, a label repeated across sections) we narrow by the active
  // tab/section and the taught section+ordinal anchor — never by "points". If
  // nothing matches exactly we return null and let the caller fall back (matcher /
  // AI) rather than guess.

  const norm = (s) => MaxLoad.util.normLabel(s);
  function keyN(v) {
    const k = MaxLoad.matcher.meaningfulKey(v || "");
    return k ? norm(k) : "";
  }
  /** Is `el` inside the currently active tab/section named `wantTab`? */
  function inTab(el, wantTab) {
    if (!wantTab) return true;
    const ctxs = MaxLoad.dom.activeContexts(el.ownerDocument) || [];
    return ctxs.some((c) => norm(c).includes(wantTab));
  }

  /**
   * Find the field element for a stored binding — EXACT match, most-durable first.
   * For a Maximo field the visible label ("Location:") is the durable identity;
   * the stable id-suffix and same-session id refine it. Never fuzzy — so it can't
   * drift into a look-alike box.
   */
  function locate(binding) {
    if (!binding) return null;

    // 0. DURABLE FINGERPRINT — Maximo's own label[for]↔aria-labelledby contract,
    // disambiguated + verified. This survives id regeneration across sessions and
    // is the strongest key, so try it first. Null (ambiguous/absent) → fall through.
    if (binding.fp) {
      const byFp = resolveByFingerprint(binding.fp);
      if (byFp) return byFp;
    }

    const fields = MaxLoad.dom.scanFields(); // visible only
    const wantLabel = norm(binding.label || "");
    const wantKeyN = keyN(binding.stableKey);
    const wantId = binding.id || "";
    const wantName = binding.name || "";
    const wantTab = binding.tabContext ? norm(binding.tabContext) : "";

    // Among several matches, commit to ONE deterministically: prefer a matching
    // stable key, then same-session id, then the active tab/section, else the
    // first in document order.
    const narrow = (cands) => {
      if (cands.length <= 1) return cands[0] ? cands[0].el : null;
      let c = cands;
      if (wantKeyN) {
        const byKey = c.filter((fp) => { const k = MaxLoad.matcher.getStableKey(fp.el); return k && norm(k) === wantKeyN; });
        if (byKey.length === 1) return byKey[0].el;
        if (byKey.length) c = byKey;
      }
      if (wantId) {
        const byId = c.filter((fp) => fp.id === wantId);
        if (byId.length === 1) return byId[0].el;
        if (byId.length) c = byId;
      }
      if (wantTab) {
        const t = c.filter((fp) => inTab(fp.el, wantTab));
        if (t.length === 1) return t[0].el;
        if (t.length) c = t;
      }
      return c[0].el;
    };

    // 1. EXACT label (Maximo's durable field identity)
    if (wantLabel) {
      const byLabel = fields.filter((fp) => norm(fp.label) === wantLabel);
      if (byLabel.length) return narrow(byLabel);
    }
    // 2. EXACT stable id-suffix / key
    if (wantKeyN) {
      const byKey = fields.filter((fp) => { const k = MaxLoad.matcher.getStableKey(fp.el); return k && norm(k) === wantKeyN; });
      if (byKey.length) return narrow(byKey);
    }
    // 3. EXACT same-session id
    if (wantId) {
      const byId = fields.filter((fp) => fp.id === wantId);
      if (byId.length) return narrow(byId);
    }
    // 4. name
    if (wantName) {
      const byName = fields.filter((fp) => fp.name === wantName);
      if (byName.length) return narrow(byName);
    }
    return null;
  }

  /** PRESENT (rendered) — laid out and not display:none. Unlike isVisible() this
   *  does NOT drop off-screen / below-the-fold controls: a tab that is momentarily
   *  outside the viewport, or a New-Row button far down a tall form, is still a
   *  valid target — the click path scrolls it into view (like Playwright). */
  function present(el) {
    if (!el || !el.getBoundingClientRect) return false;
    if (el.disabled) return false;
    let cs = null;
    try { cs = (el.ownerDocument.defaultView || window).getComputedStyle(el); } catch (_) {}
    if (cs && (cs.display === "none" || cs.visibility === "hidden")) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  }

  /** The node Maximo actually BINDS the click to. A taught target is often a child
   *  (the toolbar <img> inside <a onclick>, a <span> inside a tab <a>); clicking the
   *  child misses the handler. Climb to the nearest real control so the trusted
   *  click lands where the onclick / javascript: href lives. */
  function actionable(el) {
    if (!el) return el;
    const isCtrl = (n) => {
      if (!n || n.nodeType !== 1) return false;
      const tag = n.tagName;
      if (tag === "A" || tag === "BUTTON") return true;
      if (n.getAttribute && n.getAttribute("onclick")) return true;
      const role = (n.getAttribute && (n.getAttribute("role") || "").toLowerCase()) || "";
      return role === "button" || role === "tab" || role === "menuitem" || role === "link";
    };
    if (isCtrl(el)) return el;
    let cur = el.parentElement;
    for (let i = 0; i < 4 && cur; i++, cur = cur.parentElement) if (isCtrl(cur)) return cur;
    return el;
  }

  /**
   * Find a bound button/link/icon/tab — DOM-first, most-durable key first:
   *   0. same-session id via getElementById (Maximo ids are stable within a login)
   *   1. exact visible text/label   2. stable id-suffix / key
   * Off-screen but present controls are eligible (the click scrolls them in). The
   * result is normalized to the actionable ancestor so the trusted click hits the
   * node Maximo bound. When several identical controls match (many "New Row"
   * buttons), narrow by active tab/section + the taught section+ordinal anchor.
   */
  function locateButton(binding) {
    if (!binding) return null;
    const wantText = norm(binding.text || "");
    const wantId = binding.id || "";
    const wantKeyN = keyN(binding.stableKey);
    const wantTab = binding.tabContext ? norm(binding.tabContext) : "";

    // 0. EXACT same-session id — fastest and most reliable within a run. Finds the
    //    control DIRECTLY even when a visible-only scan would drop it (off-screen,
    //    mid-re-render). This is what fixes "Plans"/"Nouvelle ligne" NOT FOUND.
    if (wantId) {
      for (const d of docs()) {
        let el = null;
        try { el = d.getElementById(wantId); } catch (_) {}
        if (el && present(el)) { MaxLoad.log("locateButton ✓ by id", { id: wantId }); return actionable(el); }
      }
    }

    const clickables = [];
    for (const d of docs()) {
      let els;
      try {
        els = d.querySelectorAll(
          "button, a, input[type=button], input[type=submit], input[type=image], [role=button], [role=menuitem], [role=tab], [id$='_tab_anchor'], [id$='-tab_anchor'], [onclick], img[id]"
        );
      } catch (_) {
        continue;
      }
      for (const el of els) if (present(el)) clickables.push(el);
    }

    const narrow = (cands) => {
      if (cands.length <= 1) return cands[0] || null;
      let c = cands;
      if (wantTab) {
        const t = c.filter((el) => inTab(el, wantTab));
        if (t.length === 1) return t[0];
        if (t.length) c = t;
      }
      // repeated controls: pin the exact one by section header, then ordinal.
      const anc = binding.anchor;
      if (anc) {
        if (anc.section) {
          const inSec = c.filter((el) => MaxLoad.dom.sectionAnchor(el) === anc.section);
          if (inSec.length === 1) return inSec[0];
          if (inSec.length) c = inSec;
        }
        if (typeof anc.ord === "number" && wantText) {
          const list = MaxLoad.dom.sameSignatureClickables(wantText);
          if (anc.ord >= 0 && anc.ord < list.length) return list[anc.ord];
        }
      }
      return c[0]; // deterministic: first in document order
    };

    // 1. EXACT text/label (never substring)
    if (wantText) {
      const byText = clickables.filter((el) => norm(textOf(el)) === wantText);
      if (byText.length) { MaxLoad.log("locateButton ✓ by text", { text: wantText, n: byText.length }); return actionable(narrow(byText)); }
    }
    // 2. EXACT stable id-suffix / key (durable across sessions)
    if (wantKeyN) {
      const byKey = clickables.filter((el) => {
        const k = MaxLoad.matcher.meaningfulKey(MaxLoad.matcher.getStableKey(el) || "");
        return k && norm(k) === wantKeyN;
      });
      if (byKey.length) { MaxLoad.log("locateButton ✓ by key", { key: wantKeyN, n: byKey.length }); return actionable(narrow(byKey)); }
    }
    MaxLoad.log("locateButton ✗ NOT FOUND", { wantText, wantId, wantKeyN, scanned: clickables.length });
    return null;
  }

  // ---- smart auto-detection of New / Save / Search controls -----------------
  function textOf(el) {
    return (
      el.textContent || el.value || el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("aria-label") || ""
    ).trim();
  }

  function findClickable(regexes) {
    const ds = docs();
    for (const re of regexes) {
      for (const d of ds) {
        let els;
        try {
          els = d.querySelectorAll(
            "button, a, input[type=button], input[type=submit], [role=button], img[title], img[alt]"
          );
        } catch (_) {
          continue;
        }
        const cands = [];
        for (const el of els) {
          if (!MaxLoad.util.isVisible(el)) continue;
          const t = MaxLoad.util.normLabel(textOf(el));
          if (t && re.test(t)) cands.push({ el, t });
        }
        if (cands.length) {
          cands.sort((a, b) => a.t.length - b.t.length); // shortest = most likely the actual button
          return cands[0].el;
        }
      }
    }
    return null;
  }

  function findSearchField() {
    const fields = MaxLoad.dom.scanFields();
    const re = /search|filter|find|quicksearch|lookup|qbe/i;
    // prefer a visible text input whose id/name/placeholder/label hints "search"
    const hit = fields.find((f) => {
      if (f.type !== "textbox" && f.type !== "lookup") return false;
      const hay = f.id + " " + f.name + " " + (f.el.getAttribute("placeholder") || "") + " " + f.label;
      return re.test(hay);
    });
    return hit ? hit.el : null;
  }

  /** Best-effort detect the New/Add, Save, and Search/key controls on screen. */
  function detectControls() {
    const newEl = findClickable([/^new\b/, /^insert\b/, /new row/, /insert row/, /^add\b/, /^create\b/, /new record/]);
    const saveEl = findClickable([/^save\b/, /save record/, /save changes/]);
    const searchEl = findSearchField();
    return {
      new: newEl ? captureBinding("button:new", newEl) : null,
      save: saveEl ? captureBinding("button:save", saveEl) : null,
      keyField: searchEl ? captureBinding("field", searchEl) : null
    };
  }

  // ---- message listener (every frame) ---------------------------------------
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "ml:bind:arm") armLocal(msg.role);
    else if (msg.type === "ml:bind:disarm" || msg.type === "ml:bind:broadcast-disarm") disarmLocal();
  });

  MaxLoad.binder = { locate, locateButton, armLocal, disarmLocal, captureBinding, detectControls, resolveByFingerprint };
})();
