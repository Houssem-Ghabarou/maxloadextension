/* MaxLoad — trusted input bridge (client side). DOM-ELEMENT DRIVEN.
 *
 * Maximo (TPAE/Dojo) ignores synthetic (isTrusted=false) events — a bare
 * `el.value = x` re-renders empty on tab-out, so a mandatory field would save
 * blank, and a plain el.click() on a Dojo widget often does nothing. We therefore
 * need TRUSTED OS-level input from the service worker via the DevTools Protocol.
 *
 * EVERYTHING starts from the RESOLVED ELEMENT (found in the DOM by binder /
 * matcher via stableKey/label/fingerprint). NOTHING positional is ever stored:
 * a saved/exported teach contains DOM identity only — never pixels — so it
 * replays on any browser, machine, DPI or window size.
 *
 * Model (mirrors how Playwright drives an element, not a point):
 *   click  → resolve the element, let a re-render settle, then tag THAT node and
 *            let the BROWSER compute its box (CDP DOM.getBoxModel) and dispatch
 *            ONE trusted click at the box centre. This is exactly what
 *            Playwright's locator.click() does — CDP has no "click this node"
 *            API, Input.dispatchMouseEvent only takes a point, so the point is
 *            DERIVED BY THE BROWSER from the live DOM at click time, in the same
 *            coordinate space it clicks in. It is never stored, never exported,
 *            and never hand-summed in page JS — which is why it stays correct
 *            across zoom, devicePixelRatio/display scale, window resize, scroll
 *            and iframes. (Hand-summing getBoundingClientRect + frame offsets in
 *            JS is what made clicks drift onto neighbours — don't reintroduce it.)
 *            The trusted click is NEVER gated behind an elementFromPoint()
 *            hit-test: Maximo menu items fail that test yet must still be clicked,
 *            and skipping the trusted click leaves only a synthetic one, which
 *            Dojo ignores — the element flashes but nothing happens. Only if the
 *            trusted click could not RUN do we fall back to an ELEMENT-PINNED DOM
 *            click (+ trusted Enter/Space for keyboard-activatable controls).
 *   type   → focus the element in JS, then CDP types trusted keystrokes into the
 *            focused node (no coordinates at all); if the value doesn't land,
 *            correct it straight onto the SAME element (never a neighbour).
 *   key    → trusted key into the focused node (no coordinates).
 */
(function () {
  "use strict";
  const MaxLoad = window.MaxLoad;

  /** Center of `el` in the TOP-LEVEL page's viewport coordinates, summing each
   *  enclosing iframe's offset (same-origin frames only). Used ONLY as the final
   *  trusted-click escalation when synthetic input didn't register. */
  function topCoords(el) {
    const r = el.getBoundingClientRect();
    let x = r.left + r.width / 2;
    let y = r.top + r.height / 2;
    let win = el.ownerDocument.defaultView;
    let guard = 0;
    while (win && win !== win.parent && guard++ < 12) {
      let fe = null;
      try { fe = win.frameElement; } catch (_) { break; }
      if (!fe) break;
      const fr = fe.getBoundingClientRect();
      x += fr.left;
      y += fr.top;
      win = win.parent;
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  /**
   * Our own panel is a fixed overlay at the top of the stacking order. A TRUSTED
   * click is a real browser input event, so it goes through real HIT-TESTING — if
   * the panel happens to sit over the target (the user dragged/resized it there),
   * the click lands on the toolbar instead of Maximo. The element still flashes,
   * because the highlighter is pointer-events:none and purely visual, so it looks
   * like "it clicked somewhere else".
   *
   * Make the panel click-THROUGH for the instant of the click: it stays visible
   * (no flicker, unlike hiding it) but stops swallowing the event, so the click
   * reaches whatever is underneath. Needs no coordinates, so it holds no matter
   * where the panel is moved or how it's resized. Always paired with a restore.
   */
  function panelClickThrough() {
    const host = document.getElementById("maxload-panel-host");
    if (!host || host.style.display === "none") return null;
    const prev = host.style.pointerEvents;
    host.style.pointerEvents = "none";
    return () => { host.style.pointerEvents = prev || ""; };
  }

  /** Compact, log-friendly description of an element — so an exported run log
   *  says exactly WHAT we acted on (id/tag/text/role/visibility/frame). */
  function describeEl(el) {
    if (!el) return null;
    const g = (a) => (el.getAttribute && el.getAttribute(a)) || "";
    let text = "";
    try { text = MaxLoad.util.elementText ? MaxLoad.util.elementText(el, 40) : (el.textContent || "").trim().slice(0, 40); } catch (_) {}
    let frame = "top";
    try { frame = (el.ownerDocument.defaultView === window.top) ? "top" : "iframe:" + (el.ownerDocument.defaultView.location.href || "").slice(0, 60); } catch (_) { frame = "iframe"; }
    let rect = null;
    try { const r = el.getBoundingClientRect(); rect = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; } catch (_) {}
    const cn = el.className;
    const cls = (typeof cn === "string" ? cn : (cn && cn.baseVal) || "").trim();
    const fldinfo = g("fldinfo");
    // kind: distinguishes a lookup MODAL's query/filter field from the BASE record's
    // lookup-trigger field — the exact thing to check when debugging "typed in the
    // wrong Location box".
    const kind = /queryfield|tablefilterfield/i.test(cls) || /"query"\s*:\s*true/i.test(fldinfo) ? "modal-query"
      : /"lookup"/i.test(fldinfo) ? "base-lookup" : "";
    return {
      tag: el.tagName,
      id: el.id || "",
      cls: cls.slice(0, 90),
      kind: kind,
      name: g("name"),
      type: g("type"),
      role: g("role"),
      title: g("title"),
      text: text,
      readonly: el.readOnly != null ? el.readOnly : (g("readonly") !== ""),
      disabled: !!el.disabled,
      visible: MaxLoad.util.isVisible ? MaxLoad.util.isVisible(el) : null,
      rect: rect,
      frame: frame
    };
  }

  /** Read the current value/text of a field, for read-back verification. */
  function readVal(el) {
    if (!el) return "";
    const role = (el.getAttribute && (el.getAttribute("role") || "").toLowerCase()) || "";
    if (
      el.isContentEditable ||
      (el.getAttribute && (el.getAttribute("contenteditable") || "") === "true") ||
      (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && role === "textbox")
    ) {
      return (el.textContent || "").trim();
    }
    return String(el.value == null ? "" : el.value).trim();
  }

  /**
   * Did the page REACT to acting on `el` within `ms`? We look only for STRONG,
   * click-consumed signals — an element node added to the DOM (new row / dialog /
   * menu), focus moving into the control, its own aria-expanded/pressed/checked
   * flipping, or Maximo going busy. We deliberately ignore text/attribute churn
   * (clocks, aria-live tickers) so background noise can't fake a reaction. Biased
   * toward "yes it reacted", because a false yes just means we DON'T fire the
   * second (Enter/Space) activation — safe — whereas a false no could double a
   * New Row / Save.
   */
  function reactedTo(el, ms) {
    return new Promise((resolve) => {
      const doc = el.ownerDocument;
      const beforeFocus = doc.activeElement;
      const flag = (x) => (el.getAttribute ? (el.getAttribute(x) || "") : "");
      const beforeState = flag("aria-expanded") + "|" + flag("aria-pressed") + "|" + (el.checked ? "1" : "0");
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        try { obs.disconnect(); } catch (_) {}
        clearTimeout(timer);
        resolve(v);
      };
      // resolve the INSTANT a real element node is added (new row / dialog / menu)
      // so a successful click isn't slowed by the full wait window.
      const obs = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === "childList" && m.addedNodes) {
            for (const n of m.addedNodes) if (n.nodeType === 1) return finish(true);
          }
        }
      });
      try { obs.observe(doc.documentElement, { childList: true, subtree: true }); } catch (_) {}
      const timer = setTimeout(() => {
        const af = doc.activeElement;
        const focusMoved = af && af !== beforeFocus && af !== doc.body && (af === el || (el.contains && el.contains(af)));
        const afterState = flag("aria-expanded") + "|" + flag("aria-pressed") + "|" + (el.checked ? "1" : "0");
        const busy = MaxLoad.settle && MaxLoad.settle.isBusy && MaxLoad.settle.isBusy();
        finish(focusMoved || afterState !== beforeState || busy);
      }, ms);
    });
  }

  /** Is `el` a control that a keyboard user activates with Enter/Space? Buttons,
   *  links, tabs, menu items, checkboxes, tree/grid nodes — NEVER a plain text
   *  input (where Enter would submit a search / commit unexpectedly). */
  function isKeyActivatable(el) {
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "INPUT") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      return ["button", "submit", "image", "reset", "checkbox", "radio"].includes(t);
    }
    if (tag === "BUTTON" || tag === "A") return true;
    const role = (el.getAttribute && (el.getAttribute("role") || "").toLowerCase()) || "";
    if (["button", "tab", "menuitem", "option", "treeitem", "checkbox", "link", "gridcell"].includes(role)) return true;
    // Icons / spans Maximo wires with onclick are activatable when focusable.
    if (el.hasAttribute && (el.hasAttribute("onclick") || el.getAttribute("tabindex") != null)) return true;
    return false;
  }

  /**
   * Coordinate-free trusted activation: put keyboard focus on the exact element
   * (JS focus — reliable and needs no pixels), confirm it landed, then ask the
   * worker to dispatch a TRUSTED key into the focused node. Returns true if a key
   * was sent. Used only as an escalation when the synthetic click did nothing.
   */
  async function activateByKey(el, key) {
    try {
      el.scrollIntoView({ block: "center", inline: "center" });
      el.focus({ preventScroll: true });
    } catch (_) {}
    const doc = el.ownerDocument;
    const af = doc.activeElement;
    const focused = af === el || (el.contains && af && el.contains(af)) || (af && af.contains && af.contains(el));
    if (!focused) return false; // couldn't focus it → nothing trustworthy to press
    try {
      const k = key === "space"
        ? { key: " ", code: "Space", vk: 32 }
        : { key: "Enter", code: "Enter", vk: 13 };
      const r = await chrome.runtime.sendMessage({ type: "ml:cdp:key", key: k.key, code: k.code, vk: k.vk });
      return !!(r && r.ok);
    } catch (e) {
      MaxLoad.warn("cdp activate-key message failed: " + String(e));
      return false;
    }
  }

  /**
   * Playwright-style ACTIONABILITY gate. Wait until the EXACT resolved element is
   * genuinely ready to receive a real click, then return the trustworthy TOP-LEVEL
   * click point. All of these, retried until met or timeout: attached, visible +
   * enabled, scrolled into view, its box STABLE across checks (not animating/moving),
   * and a HIT-TEST at its centre resolves to IT (not an overlay/neighbour). Returns
   * { x, y } for a trusted click, or null when it never became actionable.
   */
  async function actionable(el, timeoutMs) {
    const deadline = MaxLoad.util.now() + (timeoutMs || 5000);
    let lastBox = null, stable = 0;
    while (MaxLoad.util.now() < deadline) {
      if (!el.isConnected) return null; // detached from the DOM
      if (!MaxLoad.util.isVisible(el)) { await MaxLoad.util.sleep(80); lastBox = null; stable = 0; continue; }
      try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (_) {}
      const doc = el.ownerDocument;
      const win = doc.defaultView || window;
      const r = el.getBoundingClientRect();
      // STABLE: same box as the previous check (a Maximo re-render / animation settled).
      if (lastBox && Math.abs(r.left - lastBox.left) < 1 && Math.abs(r.top - lastBox.top) < 1 &&
          Math.abs(r.width - lastBox.width) < 1 && Math.abs(r.height - lastBox.height) < 1) stable++;
      else stable = 0;
      lastBox = r;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const inView = cx >= 0 && cy >= 0 && cx <= win.innerWidth && cy <= win.innerHeight;
      if (inView && stable >= 1) {
        let hit = null;
        try { hit = doc.elementFromPoint(cx, cy); } catch (_) {}
        // HIT-TEST: the centre must resolve to us (or a child/parent), i.e. NOT covered.
        if (hit && (hit === el || el.contains(hit) || hit.contains(el))) {
          const { x, y } = topCoords(el); // sum enclosing iframe offsets → top-level point
          if (x > 0 && y > 0) return { x, y };
        }
      }
      await MaxLoad.util.sleep(60);
    }
    return null;
  }

  /**
   * Click a control — the extension's `actOn` for clicks. ACTIONABILITY → a HIT-TESTED
   * TRUSTED click. Because the point is verified (elementFromPoint === this element)
   * BEFORE clicking, it can't drift onto a neighbour; because it's a trusted CDP click,
   * Maximo (Dojo) can't ignore it as synthetic. If the element can't be made actionable
   * in time (covered/animating), we fall back to an ELEMENT-PINNED DOM click — still
   * coordinate-free, so never a neighbour.
   */
  async function click(el) {
    if (!el) return false;
    const d = describeEl(el);
    const t0 = Date.now();

    // 1. Let a pending re-render settle so the box we click is where the element is
    //    now. Best-effort and SHORT — deliberately NOT an actionability/hit-test gate.
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (_) {}
    if (MaxLoad.settle) await MaxLoad.settle.waitForSettle({ quietMs: 100, timeoutMs: 800 });

    // 2. TRUSTED click where the BROWSER computes the box (CDP DOM.getBoxModel via a
    //    unique marker attribute) — composited across frames and zoom-aware, so it
    //    can't drift onto a neighbour the way hand-summed coordinates could.
    //
    //    DO NOT gate this on an elementFromPoint() hit-test. A Maximo menu item
    //    ("Changer le statut", id …_ns_menu_STATUS_OPTION_a) routinely fails that
    //    test — it sits under an overlay / isn't painted where its box says — yet it
    //    IS exactly what must be clicked. Gating it skipped the trusted click and
    //    left only the synthetic fallback, which Dojo ignores: the element flashed
    //    blue, no click landed, and the Change Status modal never opened.
    const marker = "ml" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    let sel = null;
    try { el.setAttribute("data-mlclick", marker); sel = '[data-mlclick="' + marker + '"]'; } catch (_) {}
    if (sel) {
      const watch = reactedTo(el, 500);
      let r = null;
      // Our panel must not swallow this real click if it happens to sit on top.
      const restorePanel = panelClickThrough();
      try {
        r = await chrome.runtime.sendMessage({ type: "ml:cdp:click-selector", selector: sel });
      } catch (e) {
        MaxLoad.warn("click ▸ cdp box message failed", { el: d, error: String(e) });
      } finally {
        if (restorePanel) restorePanel();
      }
      try { el.removeAttribute("data-mlclick"); } catch (_) {}
      if (r && r.ok) {
        const reacted = await watch;
        MaxLoad.log("click ▸ trusted CDP box click", { el: d, x: r.x, y: r.y, reacted, ms: Date.now() - t0 });
        return true;
      }
      MaxLoad.warn("click ▸ CDP box click could not run — element DOM fallback", { el: d, error: (r && r.error) || null });
    }

    // 3. ELEMENT-PINNED fallback — ONLY when the trusted click could not run, so a
    //    New Row / Save can never double-fire (coordinate-free, never a neighbour).
    const w2 = reactedTo(el, 300);
    MaxLoad.util.realClick(el, true);
    try { el.click(); } catch (_) {}
    const reacted = await w2;
    if (!reacted && isKeyActivatable(el)) { await activateByKey(el, "enter"); }
    MaxLoad.log("click ▸ element DOM fallback", { el: d, reacted, ms: Date.now() - t0 });
    return true;
  }

  async function settleShort(timeoutMs) {
    if (MaxLoad.settle) await MaxLoad.settle.waitForSettle({ quietMs: 120, timeoutMs: timeoutMs || 1200 });
    else await MaxLoad.util.sleep(150);
  }

  /** Did `value` end up in THIS element? Lenient — Maximo may reformat/expand. */
  function didLand(el, before, want) {
    const after = readVal(el);
    return after !== before || after === want || (!!want && after.includes(want));
  }

  function commitField(el) {
    try {
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    } catch (_) {}
    return true;
  }

  /**
   * TRUSTED typing path — coordinate-free. Scroll the field into view, focus it in
   * JS, then type TRUSTED per-character keystrokes into the FOCUSED node via CDP.
   * Because it follows focus (not a pixel), it's immune to scroll position,
   * off-screen fields, overlays, zoom, and the mouse moving during a run. Returns
   * false if focus can't be confirmed, so the caller falls back to a direct set on
   * the same element.
   */
  async function focusType(el, value, commitKey) {
    // ACTIONABILITY gate before typing: wait until the field is visible, enabled, and
    // its box is stable/uncovered — so we never type into a still-painting or covered
    // field (a lookup modal that hasn't settled). Best-effort: proceed on timeout.
    await actionable(el, 4000);
    try {
      // scroll into view like Playwright's scrollIntoViewIfNeeded (the field may
      // be below the fold — "scrolling not detected" otherwise).
      el.scrollIntoView({ block: "center", inline: "center" });
      el.focus({ preventScroll: true });
    } catch (_) {}
    const doc = el.ownerDocument;
    const active = doc.activeElement;
    const focused =
      active === el ||
      (el.contains && active && el.contains(active)) ||
      (active && active.contains && active.contains(el));
    if (!focused) return false; // focus didn't land -> use direct-set fallback
    // A field that just round-tripped (e.g. right after New) briefly LOCKS input,
    // and keystrokes typed during the lock are dropped ("Inspection" -> "Ins").
    // Settle first — event-driven, like iAMXLS's whenIdle before typing.
    if (MaxLoad.settle) await MaxLoad.settle.waitForSettle({ quietMs: 100, timeoutMs: 600 });
    try {
      const r = await chrome.runtime.sendMessage({
        type: "ml:cdp:type-focused",
        text: String(value),
        commitKey: commitKey || "tab"
      });
      return !!(r && r.ok);
    } catch (e) {
      MaxLoad.warn("cdp type-focused message failed: " + String(e));
      return false;
    }
  }

  async function type(el, value, commitKey) {
    if (!el) return false;
    const d = describeEl(el);
    const before = readVal(el);
    const want = String(value == null ? "" : value).trim();
    MaxLoad.log("type ▸ start", { el: d, want: want.slice(0, 80), before: before.slice(0, 60), commitKey: commitKey || "tab" });

    // 1. coordinate-free focus + trusted keystrokes into the focused node.
    const focused = await focusType(el, value, commitKey);
    if (focused) {
      await settleShort(1200);
      let after = readVal(el);
      if (didLand(el, before, want)) { MaxLoad.log("type ▸ landed (tier1 trusted keystrokes)", { el: d, after: after.slice(0, 60) }); return commitField(el); }
      MaxLoad.warn("type ▸ tier1 keystrokes didn't stick — retrying once", { el: d, after: after.slice(0, 60) });
      // Trusted keys fired but the value didn't stick (locked field, re-render).
      await settleShort(1400);
      if (await focusType(el, value, commitKey)) {
        await settleShort(1200);
        after = readVal(el);
        if (didLand(el, before, want)) { MaxLoad.log("type ▸ landed (tier1 retry)", { el: d, after: after.slice(0, 60) }); return commitField(el); }
      }
    } else {
      MaxLoad.warn("type ▸ focus did NOT land — cannot deliver trusted keystrokes", { el: d });
    }

    // 2. last resort — set the value straight onto the CORRECT element so it can
    //    never end up in a NEIGHBOURING field. No coordinates involved.
    MaxLoad.warn("type ▸ tier2 fallback — setting value directly on the element (focus/lock drift?)", { el: d, want: want.slice(0, 80), after: readVal(el).slice(0, 60) });
    MaxLoad.util.realClick(el);
    syntheticSet(el, value);
    return false;
  }

  function syntheticSet(el, value) {
    try {
      // rich-text / contenteditable (no .value) — set editable content
      const rich =
        el.isContentEditable ||
        (el.getAttribute && (el.getAttribute("contenteditable") || "") === "true") ||
        (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && el.getAttribute && (el.getAttribute("role") || "").toLowerCase() === "textbox");
      if (rich) {
        el.focus();
        el.textContent = String(value);
      } else {
        const proto = Object.getPrototypeOf(el);
        const desc =
          Object.getOwnPropertyDescriptor(el, "value") || Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(el, value);
        else el.value = value;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    } catch (_) {}
  }

  const KEYMAP = {
    enter: { key: "Enter", code: "Enter", vk: 13 },
    tab: { key: "Tab", code: "Tab", vk: 9 },
    space: { key: " ", code: "Space", vk: 32 },
    escape: { key: "Escape", code: "Escape", vk: 27 },
    esc: { key: "Escape", code: "Escape", vk: 27 },
    arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
    arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 }
  };

  /** Press a key (trusted, via CDP) on whatever is focused; synthetic fallback. */
  async function pressKey(keyName) {
    const k = KEYMAP[String(keyName || "").toLowerCase()] || { key: keyName, code: keyName, vk: 0 };
    try {
      const af = document.activeElement;
      MaxLoad.debug("pressKey", { key: k.key, on: af ? describeEl(af) : null });
    } catch (_) {}
    try {
      const r = await chrome.runtime.sendMessage({ type: "ml:cdp:key", key: k.key, code: k.code, vk: k.vk });
      if (r && r.ok) return true;
      MaxLoad.warn("cdp key failed, synthetic fallback: " + (r && r.error));
    } catch (e) {
      MaxLoad.warn("cdp key message failed: " + String(e));
    }
    try {
      const el = document.activeElement || document.body;
      const K = (el.ownerDocument.defaultView || window).KeyboardEvent || KeyboardEvent;
      const opt = { key: k.key, code: k.code, keyCode: k.vk, which: k.vk, bubbles: true, cancelable: true };
      el.dispatchEvent(new K("keydown", opt));
      el.dispatchEvent(new K("keypress", opt));
      el.dispatchEvent(new K("keyup", opt));
    } catch (_) {}
    return false;
  }

  async function detach() {
    try {
      await chrome.runtime.sendMessage({ type: "ml:cdp:detach" });
    } catch (_) {}
  }

  MaxLoad.input = { click, type, pressKey, detach, describeEl };
})();
