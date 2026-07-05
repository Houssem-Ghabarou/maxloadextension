/* MaxLoad — Learning Cache (Knowledge Base).
 * Caches AI/deterministic field resolutions so a given field is resolved once
 * per (tenant, app, screen, fieldStableKey) and never asked again. Includes a
 * lightweight periodic recheck: cached mappings older than N days are re-verified
 * before being trusted, else they fall through to AI Recovery again.
 */
(function () {
  "use strict";
  const MaxLoad = window.MaxLoad;

  const STORE_KEY = "ml:knowledgeBase";
  const RECHECK_DAYS = 14;
  let memCache = null;

  function keyFor({ tenant, app, screen, fieldStableKey }) {
    return [
      tenant || MaxLoad.env.tenant,
      app || "app",
      screen || "screen",
      fieldStableKey || "field"
    ]
      .map((s) => String(s).toLowerCase().replace(/\s+/g, "_"))
      .join("|");
  }

  async function loadAll() {
    if (memCache) return memCache;
    const obj = await chrome.storage.local.get(STORE_KEY);
    memCache = obj[STORE_KEY] || {};
    return memCache;
  }

  async function persist() {
    await chrome.storage.local.set({ [STORE_KEY]: memCache });
  }

  /** Get a cached resolution, or null. Marks whether a recheck is due. */
  async function get(spec) {
    const all = await loadAll();
    const entry = all[keyFor(spec)];
    if (!entry) return null;
    const ageDays = (Date.now() - (entry.resolvedAt || 0)) / 86400000;
    entry.recheckDue = ageDays >= RECHECK_DAYS;
    return entry;
  }

  /** Store a resolution. `pattern` is the resolved selector pattern / stable id. */
  async function set(spec, pattern, source) {
    const all = await loadAll();
    all[keyFor(spec)] = {
      pattern,
      source: source || "deterministic", // 'deterministic' | 'ai'
      resolvedAt: Date.now(),
      hits: (all[keyFor(spec)]?.hits || 0) + 1
    };
    memCache = all;
    await persist();
    return all[keyFor(spec)];
  }

  /** Invalidate a single mapping (e.g. recheck failed). */
  async function invalidate(spec) {
    const all = await loadAll();
    delete all[keyFor(spec)];
    memCache = all;
    await persist();
  }

  async function clearAll() {
    memCache = {};
    await chrome.storage.local.set({ [STORE_KEY]: {} });
  }

  async function stats() {
    const all = await loadAll();
    const entries = Object.values(all);
    return {
      total: entries.length,
      ai: entries.filter((e) => e.source === "ai").length,
      deterministic: entries.filter((e) => e.source === "deterministic").length
    };
  }

  MaxLoad.cache = { get, set, invalidate, clearAll, stats, keyFor, RECHECK_DAYS };
})();
