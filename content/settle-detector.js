/* MaxLoad — settle detector.
 * Never uses a fixed delay. Waits until the DOM stops mutating (debounced) AND
 * Maximo's own busy indicator is clear. Also exposes a retrying element lookup.
 */
(function () {
  "use strict";
  const MaxLoad = window.MaxLoad;
  const { sleep } = MaxLoad.util;

  // Selectors Maximo commonly uses for its "longop"/busy/wait indicator. We
  // detect by pattern rather than assuming one exact id.
  const BUSY_SELECTORS = [
    "#wait", // classic Maximo longop wait window
    "#longopWaitContainer",
    ".wait", // generic
    "[id*='wait'][style*='block']",
    ".longop_wait",
    "#m_lo",
    "img[src*='wait']"
  ];

  function docsToScan(rootDoc) {
    const docs = [rootDoc || document];
    try {
      const iframes = (rootDoc || document).querySelectorAll("iframe");
      for (const f of iframes) {
        try {
          if (f.contentDocument) docs.push(f.contentDocument);
        } catch (_) {
          /* cross-origin, skip */
        }
      }
    } catch (_) {}
    return docs;
  }

  function isBusy() {
    for (const doc of docsToScan(document)) {
      for (const sel of BUSY_SELECTORS) {
        let els;
        try {
          els = doc.querySelectorAll(sel);
        } catch (_) {
          continue;
        }
        for (const el of els) {
          if (MaxLoad.util.isVisible(el)) return true;
        }
      }
    }
    return false;
  }

  /**
   * Maximo's ACTION CHANNEL state, aggregated across all same-origin frames.
   * action-tracker.js (MAIN world) publishes the in-flight XHR/fetch count and a
   * last-activity timestamp onto each frame's <html> data-attributes; we sum them
   * so a load in a child app-frame is seen from the top frame too. This is the
   * event-driven signal behind whenIdle — Maximo's real round-trip, not a guess.
   */
  function actionState() {
    let inflight = 0;
    let last = 0;
    for (const doc of docsToScan(document)) {
      const de = doc && doc.documentElement;
      if (!de) continue;
      const n = parseInt(de.getAttribute("data-ml-inflight") || "0", 10);
      if (isFinite(n)) inflight += n;
      const t = parseInt(de.getAttribute("data-ml-lastaction") || "0", 10);
      if (isFinite(t) && t > last) last = t;
    }
    return { inflight, last };
  }

  /**
   * Wait until Maximo's action channel is idle: no in-flight request AND a short
   * debounce since the last one (Maximo often chains a follow-up POST). Purely
   * event-driven — returns the instant the condition holds — with a hard cap so a
   * stuck server can't hang the run. Ported from iAMXLS navigator.whenIdle; this
   * is the wait to use around typing/commit, not a fixed sleep.
   */
  async function whenIdle({ settleMs = 120, maxWaitMs = 6000 } = {}) {
    const start = MaxLoad.util.now();
    for (;;) {
      const { inflight, last } = actionState();
      const quiet = MaxLoad.util.now() - (last || start);
      if (inflight <= 0 && quiet >= settleMs) return;
      // STUCK-COUNTER / PERSISTENT-POLL SAFETY: Maximo keeps a long-lived async
      // poll open, so inflight can read > 0 with no real activity. If the channel
      // has been quiet past a short grace, treat it as idle rather than block the
      // whole run. Mirrors iAMXLS whenIdle's 700ms resync — a stuck count can never
      // cost more than this grace on any step.
      if (quiet >= 700) return;
      if (MaxLoad.util.now() - start >= maxWaitMs) return;
      await sleep(15);
    }
  }

  /** True only when the action channel is ACTIVELY working (a request started or
   *  finished within the debounce). A persistent poll with no recent activity is
   *  NOT "busy" — otherwise every settle would block for its full timeout. */
  function channelBusy() {
    const st = actionState();
    return st.inflight > 0 && MaxLoad.util.now() - st.last < 700;
  }

  /**
   * Resolve once the page is quiet: no DOM mutations for `quietMs` AND not busy.
   * Times out after `timeoutMs` and resolves anyway (best-effort).
   */
  async function waitForSettle({ quietMs = 400, timeoutMs = 15000 } = {}) {
    const start = MaxLoad.util.now();
    return new Promise((resolve) => {
      let lastMutation = MaxLoad.util.now();
      const target = document.body || document.documentElement;
      const observer = new MutationObserver(() => {
        lastMutation = MaxLoad.util.now();
      });
      try {
        // Watch STRUCTURAL changes only (nodes added/removed = real content loading).
        // Attribute/characterData churn (spinner animation, focus outlines, aria-live
        // text, a clock) is cosmetic and used to keep the page from EVER going quiet,
        // forcing every wait to its full timeout. Busy indicator + action channel below
        // still catch genuine loading.
        observer.observe(target, { childList: true, subtree: true });
      } catch (_) {}

      const tick = async () => {
        const now = MaxLoad.util.now();
        const idleFor = now - lastMutation;
        const elapsed = now - start;
        const busyVisible = isBusy();
        const chBusy = channelBusy();
        // Resolve when the DOM is structurally quiet AND not busy — OR (the key for
        // never-quiet lookup modals) when Maximo's ACTION CHANNEL has been idle briefly
        // (server round-trip done) with no visible spinner, even if cosmetic DOM churn
        // continues. The elapsed>=200 guard gives a just-fired request time to register.
        const chanQuiet = now - (actionState().last || start);
        const domSettled = idleFor >= quietMs && !busyVisible && !chBusy;
        const chanSettled = elapsed >= 200 && !chBusy && !busyVisible && chanQuiet >= 300;
        if (domSettled || chanSettled || elapsed >= timeoutMs) {
          observer.disconnect();
          resolve({ settled: domSettled || chanSettled, timedOut: elapsed >= timeoutMs });
          return;
        }
        setTimeout(tick, 100);
      };
      setTimeout(tick, 100);
    });
  }

  /**
   * Retry a producer function every `intervalMs` until it returns a truthy
   * value or `timeoutMs` elapses. Used for field lookups that appear late.
   */
  async function retryUntil(producer, { intervalMs = 200, timeoutMs = 8000 } = {}) {
    const start = MaxLoad.util.now();
    for (;;) {
      let val;
      try {
        val = await producer();
      } catch (_) {
        val = null;
      }
      if (val) return val;
      if (MaxLoad.util.now() - start >= timeoutMs) return null;
      await sleep(intervalMs);
    }
  }

  /**
   * Like waitForSettle, but resolves IMMEDIATELY the moment a blocking modal
   * appears — so we react to Maximo popups without waiting out the full timeout.
   */
  async function waitForSettleOrModal({ quietMs = 400, timeoutMs = 10000 } = {}) {
    const start = MaxLoad.util.now();
    let lastMutation = MaxLoad.util.now();
    const target = document.body || document.documentElement;
    const observer = new MutationObserver(() => {
      lastMutation = MaxLoad.util.now();
    });
    try {
      // structural changes only — cosmetic attribute/characterData churn (spinner,
      // clock, focus outline, aria-live) must not keep the page "un-settled" forever.
      observer.observe(target, { childList: true, subtree: true });
    } catch (_) {}

    return new Promise((resolve) => {
      const tick = () => {
        // a popup is up -> handle it now, don't keep waiting
        if (MaxLoad.errorWatcher && MaxLoad.errorWatcher.currentBlocking()) {
          observer.disconnect();
          resolve({ modal: true });
          return;
        }
        const now = MaxLoad.util.now();
        const idleFor = now - lastMutation;
        const elapsed = now - start;
        const busyVisible = isBusy();
        const chBusy = channelBusy();
        const chanQuiet = now - (actionState().last || start);
        const domSettled = idleFor >= quietMs && !busyVisible && !chBusy;
        const chanSettled = elapsed >= 200 && !chBusy && !busyVisible && chanQuiet >= 300;
        if (domSettled || chanSettled || elapsed >= timeoutMs) {
          observer.disconnect();
          resolve({ settled: domSettled || chanSettled, timedOut: elapsed >= timeoutMs });
          return;
        }
        setTimeout(tick, 80);
      };
      setTimeout(tick, 80);
    });
  }

  MaxLoad.settle = { waitForSettle, waitForSettleOrModal, retryUntil, isBusy, docsToScan, whenIdle, actionState };
})();
