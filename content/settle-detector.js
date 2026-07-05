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
        observer.observe(target, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true
        });
      } catch (_) {}

      const tick = async () => {
        const idleFor = MaxLoad.util.now() - lastMutation;
        const elapsed = MaxLoad.util.now() - start;
        const busy = isBusy();
        if ((idleFor >= quietMs && !busy) || elapsed >= timeoutMs) {
          observer.disconnect();
          resolve({ settled: idleFor >= quietMs && !busy, timedOut: elapsed >= timeoutMs });
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
      observer.observe(target, { childList: true, subtree: true, attributes: true, characterData: true });
    } catch (_) {}

    return new Promise((resolve) => {
      const tick = () => {
        // a popup is up -> handle it now, don't keep waiting
        if (MaxLoad.errorWatcher && MaxLoad.errorWatcher.currentBlocking()) {
          observer.disconnect();
          resolve({ modal: true });
          return;
        }
        const idleFor = MaxLoad.util.now() - lastMutation;
        const elapsed = MaxLoad.util.now() - start;
        if ((idleFor >= quietMs && !isBusy()) || elapsed >= timeoutMs) {
          observer.disconnect();
          resolve({ settled: idleFor >= quietMs, timedOut: elapsed >= timeoutMs });
          return;
        }
        setTimeout(tick, 80);
      };
      setTimeout(tick, 80);
    });
  }

  MaxLoad.settle = { waitForSettle, waitForSettleOrModal, retryUntil, isBusy, docsToScan };
})();
