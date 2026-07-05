/* MaxLoad — merged Rule + Validation engine.
 * A single config-driven rules table describes predefined behavior for known
 * situations (spinners, confirm dialogs, lookup popups, required/readonly
 * fields). Adding a new situation is a data change (default-rules.json), not
 * new code.
 */
(function () {
  "use strict";
  const MaxLoad = window.MaxLoad;
  const { sleep } = MaxLoad.util;

  let RULES = [];
  let loaded = false;

  const FALLBACK_RULES = [
    { trigger: "spinner-visible", action: "wait-for-disappear" },
    { trigger: "dialog:confirm", action: "click-ok" },
    { trigger: "dialog:lookup", action: "type-search-select-first" },
    { trigger: "field:required-empty-on-save", action: "abort-row-log-error" },
    { trigger: "field:readonly", action: "skip-and-log-warning" }
  ];

  async function load() {
    if (loaded) return RULES;
    try {
      const url = chrome.runtime.getURL("rules/default-rules.json");
      const res = await fetch(url);
      RULES = await res.json();
    } catch (e) {
      MaxLoad.warn("rule-engine: falling back to built-in rules", String(e));
      RULES = FALLBACK_RULES;
    }
    loaded = true;
    return RULES;
  }

  /** Detect which triggers currently apply, in priority order. */
  function detectTriggers() {
    const hits = [];
    if (MaxLoad.settle.isBusy()) hits.push("spinner-visible");
    // lookup popup: a visible dialog that contains a filter/search row + result table
    const docs = MaxLoad.dom.collectDocuments(document);
    for (const doc of docs) {
      const lookup = doc.querySelector(
        "[id*='lookup'][style*='block'], .lookupWrapper, [id*='_LOOKUP_']"
      );
      if (lookup && MaxLoad.util.isVisible(lookup)) {
        hits.push("dialog:lookup");
        break;
      }
    }
    return hits;
  }

  /** Wait for the busy/spinner indicator to clear. */
  async function waitForDisappear(timeoutMs = 20000) {
    const start = MaxLoad.util.now();
    while (MaxLoad.settle.isBusy()) {
      if (MaxLoad.util.now() - start > timeoutMs) return false;
      await sleep(150);
    }
    return true;
  }

  /**
   * Handle a lookup popup: type the search term into its filter, trigger the
   * search, and select the first result row.
   */
  async function handleLookup(searchTerm) {
    const docs = MaxLoad.dom.collectDocuments(document);
    for (const doc of docs) {
      const popup = doc.querySelector(
        "[id*='lookup'][style*='block'], .lookupWrapper, [id*='_LOOKUP_']"
      );
      if (!popup || !MaxLoad.util.isVisible(popup)) continue;

      const filter = popup.querySelector("input[type=text], input:not([type])");
      if (filter && searchTerm != null) {
        MaxLoad.util.realClick(filter);
        MaxLoad.exec.setNativeValue(filter, String(searchTerm));
        filter.dispatchEvent(new Event("input", { bubbles: true }));
        filter.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        filter.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
        filter.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await MaxLoad.settle.waitForSettle({ quietMs: 400, timeoutMs: 8000 });

      // select the first data row
      const row = popup.querySelector(
        "tr[id*='_tr_'] a, table tbody tr a, .tablerow a, tr[onclick]"
      );
      if (row) {
        MaxLoad.util.realClick(row);
        await MaxLoad.settle.waitForSettle({ quietMs: 300, timeoutMs: 6000 });
        return true;
      }
      return false;
    }
    return false;
  }

  /**
   * Run any rule whose trigger currently applies. Returns an array of actions
   * taken. `ctx` provides { searchTerm } for lookups.
   */
  async function applyRules(ctx) {
    ctx = ctx || {};
    await load();
    const triggers = detectTriggers();
    const taken = [];
    for (const trig of triggers) {
      const rule = RULES.find((r) => r.trigger === trig);
      if (!rule) continue;
      switch (rule.action) {
        case "wait-for-disappear":
          await waitForDisappear();
          taken.push({ trigger: trig, action: rule.action });
          break;
        case "type-search-select-first":
          await handleLookup(ctx.searchTerm);
          taken.push({ trigger: trig, action: rule.action });
          break;
        default:
          taken.push({ trigger: trig, action: rule.action, note: "no-op-here" });
      }
    }
    return taken;
  }

  MaxLoad.rules = {
    load,
    detectTriggers,
    applyRules,
    waitForDisappear,
    handleLookup,
    get table() {
      return RULES;
    }
  };
})();
