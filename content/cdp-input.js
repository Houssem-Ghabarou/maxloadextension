/* MaxLoad — trusted input bridge (client side). COORDINATE-FREE / DOM-FIRST.
 *
 * Maximo (TPAE/Dojo) ignores synthetic (isTrusted=false) key events — a bare
 * `el.value = x` re-renders empty on tab-out, so a mandatory field would save
 * blank. We therefore still need TRUSTED OS-level input from the service worker
 * via the DevTools Protocol. The important part: we NEVER target a screen pixel.
 *
 * Every interaction acts on the RESOLVED ELEMENT (found in the DOM by binder /
 * matcher) or on the FOCUSED NODE. CDP only ever types/keys into whatever the
 * page has focused — it is given no coordinates. That makes input immune to
 * browser zoom, devicePixelRatio, scroll position, off-screen fields, moved
 * layout, and cross-origin iframe offsets — the exact things pixel math broke on.
 *
 * Model (mirrors how Playwright drives an element, not a point):
 *   click  → realClick(el) + el.click() on the element reference; if the widget
 *            ignored it, focus the element and send a trusted Enter/Space (still
 *            coordinate-free) — only for keyboard-activatable controls.
 *   type   → focus the element in JS, then CDP types trusted keystrokes into the
 *            focused node; if the value doesn't land, correct it straight onto the
 *            SAME element (never a neighbour).
 *   key    → trusted key into the focused node.
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

  /** If the click point sits under MaxLoad's own panel, hide it for the click so
   *  the OS click lands on the page, not our toolbar. Returns a restore fn or null. */
  function uncoverPanel(x, y) {
    const host = document.getElementById("maxload-panel-host");
    if (!host || host.style.display === "none") return null;
    const r = host.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      host.style.visibility = "hidden";
      return () => { host.style.visibility = ""; };
    }
    return null;
  }

  /**
   * Settle `el` into view and return trustworthy TOP-LEVEL click coordinates — or
   * null when the point can't be trusted (off-screen in its frame, zero-size, or
   * the spot is covered). Returning null makes the caller skip the coordinate click
   * so a scroll/overlay can never send it to a NEIGHBOUR.
   */
  async function stableCoords(el) {
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (_) {}
    if (MaxLoad.settle) await MaxLoad.settle.waitForSettle({ quietMs: 120, timeoutMs: 1000 });
    else await MaxLoad.util.sleep(120);
    const doc = el.ownerDocument;
    const win = doc.defaultView || window;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const lx = r.left + r.width / 2;
    const ly = r.top + r.height / 2;
    if (lx < 0 || ly < 0 || lx > win.innerWidth || ly > win.innerHeight) return null;
    let hit = null;
    try { hit = doc.elementFromPoint(lx, ly); } catch (_) {}
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) return null;
    const { x, y } = topCoords(el);
    if (x <= 0 || y <= 0) return null;
    return { x, y };
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
    return {
      tag: el.tagName,
      id: el.id || "",
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
   * Click a control — DOM-FIRST, COORDINATE-FREE.
   *
   * 1. Act on the EXACT element reference: realClick fires the pointer/mouse
   *    sequence Maximo binds to, then el.click() runs inline onclick handlers AND
   *    javascript: hrefs. Because it targets the element, it can never land on a
   *    neighbour, and it's immune to scroll/zoom.
   * 2. If the page visibly reacted, we're done.
   * 3. ONLY if nothing happened (a rare Dojo widget that ignores synthetic input)
   *    do we escalate to a TRUSTED key activation on the focused element — still
   *    coordinate-free. Because we escalate only when step 1 did nothing, this
   *    can't double-fire a New Row / Save.
   */
  async function click(el) {
    if (!el) return false;
    const d = describeEl(el);
    const t0 = Date.now();
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (_) {}
    // let a pending re-render settle so the box we click is where the element is now
    if (MaxLoad.settle) await MaxLoad.settle.waitForSettle({ quietMs: 100, timeoutMs: 800 });

    // PRIMARY — PLAYWRIGHT / iAMXLS: one TRUSTED click at the element's box centre,
    // where the BROWSER computes the box (CDP DOM.getBoxModel — composited across
    // frames, zoom-aware). We tag THIS exact node with a unique attribute so the
    // worker targets it — never a hand-summed pixel, never a neighbour. Exactly one
    // click, so a New Row / Save can't be double-fired.
    const marker = "ml" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    let sel = null;
    try { el.setAttribute("data-mlclick", marker); sel = '[data-mlclick="' + marker + '"]'; } catch (_) {}
    if (sel) {
      const watch = reactedTo(el, 500);
      let r = null;
      try { r = await chrome.runtime.sendMessage({ type: "ml:cdp:click-selector", selector: sel }); }
      catch (e) { MaxLoad.warn("click ▸ cdp box message failed", { el: d, error: String(e) }); }
      try { el.removeAttribute("data-mlclick"); } catch (_) {}
      if (r && r.ok) {
        const reacted = await watch;
        MaxLoad.log("click ▸ trusted CDP box click (Playwright-style)", { el: d, x: r.x, y: r.y, reacted, ms: Date.now() - t0 });
        return true;
      }
      MaxLoad.warn("click ▸ CDP box click could not run — using synthetic fallback", { el: d, error: (r && r.error) || null });
    }

    // FALLBACK — only when the trusted click could NOT run (so no double-fire):
    // synthetic pointer/mouse sequence + el.click() on the element reference.
    const w2 = reactedTo(el, 300);
    MaxLoad.util.realClick(el, true);
    try { el.click(); } catch (_) {}
    MaxLoad.log("click ▸ synthetic fallback", { el: d, reacted: await w2, ms: Date.now() - t0 });
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
    escape: { key: "Escape", code: "Escape", vk: 27 },
    esc: { key: "Escape", code: "Escape", vk: 27 },
    arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
    arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 }
  };

  /** Press a key (trusted, via CDP) on whatever is focused; synthetic fallback. */
  async function pressKey(keyName) {
    const k = KEYMAP[String(keyName || "").toLowerCase()] || { key: keyName, code: keyName, vk: 0 };
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
