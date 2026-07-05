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
    return binding;
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
  /**
   * Find the element for a stored binding. LABEL-FIRST, because for Maximo the
   * label ("Location:") is the only durable identity — ids are per-session hashes
   * and the stripped key is often just a control suffix ("-tb") shared by every
   * textbox. We only accept a candidate that carries a real signal (matching
   * label, same-session id, or a *meaningful* stable key), so when the target
   * form isn't rendered yet we return null and let the caller retry rather than
   * type into the wrong box (e.g. a list-view filter).
   */
  function locate(binding) {
    if (!binding) return null;
    const fields = MaxLoad.dom.scanFields(); // visible only
    const wantLabel = binding.label || "";
    const bindingKey = MaxLoad.matcher.meaningfulKey(binding.stableKey || "");

    const scored = [];
    for (const fp of fields) {
      let s = 0;
      if (wantLabel && fp.label) {
        const sim = MaxLoad.util.similarity(fp.label, wantLabel);
        if (sim >= 0.95) s += 55;
        else if (sim >= 0.7) s += Math.round(55 * sim);
      }
      if (binding.id && fp.id === binding.id) s += 35; // same-session exact
      if (bindingKey) {
        const fpKey = MaxLoad.matcher.getStableKey(fp.el);
        if (fpKey && MaxLoad.util.normLabel(fpKey) === MaxLoad.util.normLabel(bindingKey)) s += 28;
      }
      if (binding.name && fp.name && fp.name === binding.name) s += 20;
      if (binding.controlType && fp.type === binding.controlType) s += 8;
      const ctxs = MaxLoad.dom.activeContexts(fp.doc);
      if (binding.tabContext && ctxs.some((c) => c.includes(MaxLoad.util.normLabel(binding.tabContext)))) s += 8;
      if (fp.visible) s += 6;
      scored.push({ el: fp.el, s, visible: fp.visible });
    }
    scored.sort((a, b) => (b.visible - a.visible) || (b.s - a.s));
    const top = scored[0];
    // require a real identity signal (label match ~55, id 35, or key 28), not
    // just "it's a visible textbox".
    if (top && top.s >= 34) return top.el;
    return null;
  }

  /** Find a bound button/link by stable key or visible text. */
  function locateButton(binding) {
    if (!binding) return null;
    // 1. by stable key among clickable elements
    if (binding.stableKey) {
      for (const d of docs()) {
        let els;
        try {
          els = d.querySelectorAll("button, a, input[type=button], input[type=submit], [role=button], img[id], [id]");
        } catch (_) {
          continue;
        }
        for (const el of els) {
          const key = MaxLoad.util.normLabel(MaxLoad.matcher.getStableKey(el) || "");
          if (key && key === MaxLoad.util.normLabel(binding.stableKey) && MaxLoad.util.isVisible(el)) return el;
        }
      }
    }
    // 2. by id / name
    for (const d of docs()) {
      if (binding.id) {
        const byId = d.getElementById(binding.id);
        if (byId && MaxLoad.util.isVisible(byId)) return byId;
      }
    }
    // 3. by visible text
    if (binding.text) return MaxLoad.dom.findButton(binding.text);
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

  MaxLoad.binder = { locate, locateButton, armLocal, disarmLocal, captureBinding, detectControls };
})();
