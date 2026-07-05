/* MaxLoad — Resume Engine.
 * Persists per-row progress so a run is resumable after a browser restart.
 * Progress is keyed by a runId derived from the workflow + file, stored in
 * chrome.storage.local.
 */
(function () {
  "use strict";
  const MaxLoad = window.MaxLoad;

  const STORE_KEY = "ml:runs";

  async function loadRuns() {
    const obj = await chrome.storage.local.get(STORE_KEY);
    return obj[STORE_KEY] || {};
  }
  async function saveRuns(runs) {
    await chrome.storage.local.set({ [STORE_KEY]: runs });
  }

  function makeRunId(workflowId, fileName, rowCount) {
    return [workflowId, fileName || "rows", rowCount].join("::");
  }

  /** Create or fetch a run record. rows: array length; statuses default 'pending'. */
  async function begin(runId, meta) {
    const runs = await loadRuns();
    if (!runs[runId]) {
      runs[runId] = {
        runId,
        meta: meta || {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        rows: {}, // index -> { status, message, at }
        aborted: false
      };
      await saveRuns(runs);
    }
    return runs[runId];
  }

  async function getRun(runId) {
    const runs = await loadRuns();
    return runs[runId] || null;
  }

  /** Mark a row's outcome. status: pending|running|done|failed|skipped */
  async function setRow(runId, index, status, message) {
    const runs = await loadRuns();
    const run = runs[runId];
    if (!run) return;
    run.rows[index] = { status, message: message || "", at: new Date().toISOString() };
    run.updatedAt = new Date().toISOString();
    await saveRuns(runs);
  }

  async function markAborted(runId, reason) {
    const runs = await loadRuns();
    if (!runs[runId]) return;
    runs[runId].aborted = true;
    runs[runId].abortReason = reason || "";
    runs[runId].updatedAt = new Date().toISOString();
    await saveRuns(runs);
  }

  /** Index of the next row to process (first not done/failed/skipped). */
  function nextIndex(run, total) {
    for (let i = 0; i < total; i++) {
      const r = run.rows[i];
      if (!r || r.status === "pending" || r.status === "running") return i;
    }
    return total; // finished
  }

  async function summary(runId) {
    const run = await getRun(runId);
    if (!run) return null;
    const counts = { done: 0, failed: 0, skipped: 0, pending: 0 };
    for (const r of Object.values(run.rows)) counts[r.status] = (counts[r.status] || 0) + 1;
    return { runId, counts, aborted: run.aborted, updatedAt: run.updatedAt };
  }

  async function clear(runId) {
    const runs = await loadRuns();
    delete runs[runId];
    await saveRuns(runs);
  }

  MaxLoad.resume = {
    makeRunId,
    begin,
    getRun,
    setRow,
    markAborted,
    nextIndex,
    summary,
    clear,
    loadRuns
  };
})();
