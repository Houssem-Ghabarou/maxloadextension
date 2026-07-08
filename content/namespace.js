/* MaxLoad — namespace bootstrap.
 * Runs first in every frame (all_frames:true). All content-script modules in a
 * frame share the same isolated-world `window`, so `window.MaxLoad` is the single
 * shared namespace every module hangs off of.
 */
(function () {
  "use strict";
  if (window.__MAXLOAD_BOOTSTRAPPED__) return;
  window.__MAXLOAD_BOOTSTRAPPED__ = true;

  const isTop = window.top === window.self;

  const MaxLoad = (window.MaxLoad = window.MaxLoad || {});

  MaxLoad.env = {
    isTop,
    frameLabel: isTop ? "top" : "frame:" + (location.href || "about:blank").slice(0, 80),
    tenant: location.hostname || "unknown-host",
    version: "0.1.0"
  };

  // ---- tiny shared utilities -------------------------------------------------
  const util = (MaxLoad.util = {});

  util.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  util.now = () => Date.now();

  util.uid = () =>
    "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

  /** Normalize a human label for comparison: lowercase, collapse whitespace,
   *  strip trailing punctuation/asterisks that Maximo uses to mark required. */
  util.normLabel = (s) =>
    String(s || "")
      .replace(/ /g, " ")
      .replace(/[\*:]+\s*$/g, "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();

  /**
   * Visible text of an element for use as a label — EXCLUDES the source of any
   * <script>/<style>/<noscript> descendant (plain `.textContent` leaks inline JS
   * like "if(browserSupportsLocalStorage()){…}" into captured step labels when a
   * clicked wrapper happens to contain a script). Whitespace-collapsed, clamped.
   */
  util.elementText = function (el, maxLen) {
    if (!el || !el.ownerDocument) return "";
    let out = "";
    try {
      const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          const p = n.parentNode;
          return p && /^(script|style|noscript)$/i.test(p.nodeName)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT;
        }
      });
      let n;
      while ((n = walker.nextNode())) {
        out += n.nodeValue + " ";
        if (out.length > 400) break; // enough to label with; don't walk huge subtrees
      }
    } catch (_) {
      out = el.textContent || "";
    }
    out = out.replace(/\s+/g, " ").trim();
    return maxLen ? out.slice(0, maxLen) : out;
  };

  /** Levenshtein-based similarity 0..1 for fuzzy label comparison. */
  util.similarity = function (a, b) {
    a = util.normLabel(a);
    b = util.normLabel(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.includes(b) || b.includes(a)) return 0.85;
    const m = a.length, n = b.length;
    const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) d[i][0] = i;
    for (let j = 0; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      }
    }
    const dist = d[m][n];
    return 1 - dist / Math.max(m, n);
  };

  /** Is an element actually visible / interactable right now. */
  util.isVisible = function (el) {
    if (!el || !el.getBoundingClientRect) return false;
    if (el.disabled) return false;
    const cs = (el.ownerDocument.defaultView || window).getComputedStyle(el);
    if (!cs || cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0")
      return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    // hidden Maximo duplicates are usually positioned way off-screen
    if (r.bottom < 0 || r.right < 0) return false;
    return true;
  };

  /**
   * A REAL click — the full pointer/mouse event sequence a browser fires for a
   * user click. Maximo (Dojo/JSF) binds toolbar buttons and fields to
   * mousedown/mouseup/pointer events, so a bare element.click() is ignored.
   * This dispatches over→down→up→click (+ pointer + focus) at the element's
   * center, in the element's own frame.
   */
  util.realClick = function (el, skipClick) {
    if (!el) return false;
    const doc = el.ownerDocument;
    const win = doc.defaultView || window;
    try {
      el.scrollIntoView({ block: "center", inline: "center" });
    } catch (_) {}
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const base = { bubbles: true, cancelable: true, view: win, clientX: cx, clientY: cy, screenX: cx, screenY: cy, button: 0 };
    const M = win.MouseEvent || MouseEvent;
    const P = win.PointerEvent || null;
    const mouse = (type, buttons) => {
      try {
        el.dispatchEvent(new M(type, { ...base, buttons: buttons }));
      } catch (_) {}
    };
    const pointer = (type, buttons) => {
      if (!P) return;
      try {
        el.dispatchEvent(new P(type, { ...base, buttons: buttons, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      } catch (_) {}
    };
    pointer("pointerover", 0);
    mouse("mouseover", 0);
    mouse("mousemove", 0);
    pointer("pointerenter", 0);
    pointer("pointerdown", 1);
    mouse("mousedown", 1);
    try {
      if (el.focus) el.focus();
    } catch (_) {}
    pointer("pointerup", 0);
    mouse("mouseup", 0);
    // skipClick: caller will fire the actual click via el.click() (which also
    // runs inline onclick + javascript: hrefs) — avoids dispatching TWO click
    // events (which would double a New Row / Save).
    if (!skipClick) mouse("click", 0);
    return true;
  };

  /** Simple structured logger that also forwards to the service worker. */
  util.log = function (level, msg, data) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      frame: MaxLoad.env.frameLabel,
      msg,
      data: data || null
    };
    try {
      // eslint-disable-next-line no-console
      console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
        "[MaxLoad]",
        msg,
        data || ""
      );
    } catch (_) {}
    try {
      chrome.runtime?.sendMessage({ type: "ml:log", entry });
    } catch (_) {}
    return entry;
  };

  MaxLoad.log = (m, d) => util.log("log", m, d);
  MaxLoad.warn = (m, d) => util.log("warn", m, d);
  MaxLoad.error = (m, d) => util.log("error", m, d);

  MaxLoad.log("namespace bootstrapped (" + MaxLoad.env.frameLabel + ")");
})();
