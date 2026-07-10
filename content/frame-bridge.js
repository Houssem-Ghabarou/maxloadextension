/* MaxLoad — Frame bridge.
 * Runs in every frame but only the TOP frame acts on commands (it can reach all
 * same-origin child frames via the DOM analyzer). Routes commands coming from
 * the panel/service worker to the recorder / execution engine and returns
 * results.
 */
(function () {
  "use strict";
  const MaxLoad = window.MaxLoad;
  if (!MaxLoad.env.isTop) return; // only the top frame coordinates

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("ml:cmd:")) return;

    (async () => {
      try {
        switch (msg.type) {
          case "ml:cmd:ping":
            sendResponse({ ok: true, frame: MaxLoad.env.frameLabel, tenant: MaxLoad.env.tenant });
            break;

          case "ml:cmd:start-recording":
            MaxLoad.recorder.start(msg.action, msg.columns);
            sendResponse({ ok: true });
            break;

          case "ml:cmd:set-step-column":
            MaxLoad.recorder.setStepColumn(msg.stepId, msg.column);
            sendResponse({ ok: true });
            break;

          case "ml:cmd:set-step-operator":
            MaxLoad.recorder.setStepOperator(msg.stepId, msg.operator);
            sendResponse({ ok: true });
            break;

          case "ml:cmd:set-step-search":
            MaxLoad.recorder.setStepSearch(msg.stepId, msg.on);
            sendResponse({ ok: true });
            break;

          case "ml:cmd:remove-step":
            MaxLoad.recorder.removeStep(msg.stepId);
            sendResponse({ ok: true });
            break;

          case "ml:cmd:move-step":
            MaxLoad.recorder.moveStep(msg.stepId, msg.dir);
            sendResponse({ ok: true });
            break;

          case "ml:cmd:stop-recording": {
            const wf = MaxLoad.recorder.stop();
            sendResponse({ ok: true, workflow: wf });
            break;
          }

          case "ml:cmd:build-workflow": {
            // Rebuild the workflow from the CURRENT (possibly post-stop-edited)
            // recorder state, with a chosen name — lets the panel keep Stop and
            // Save separate without re-stopping the recorder.
            const wf = MaxLoad.recorder.buildWorkflow(msg.name);
            sendResponse({ ok: true, workflow: wf });
            break;
          }

          case "ml:cmd:recorder-status":
            // So the panel can recover its OWN UI (steps + "still teaching?") after
            // a reload — the recorder may have auto-resumed a session from storage.
            sendResponse({ ok: true, status: MaxLoad.recorder.status() });
            break;

          case "ml:cmd:discard-recording":
            MaxLoad.recorder.discard();
            sendResponse({ ok: true });
            break;

          case "ml:cmd:set-new-button":
            // Store the taught "Add / New" button (upsert: click it when a row isn't found).
            MaxLoad.recorder.setNewButton(msg.binding);
            sendResponse({ ok: true });
            break;

          case "ml:cmd:dry-run": {
            const results = await MaxLoad.exec.dryRunWorkflow(msg.workflow);
            sendResponse({ ok: true, results });
            break;
          }

          case "ml:cmd:run-batch": {
            // fire-and-progress: respond immediately, stream via ml:progress
            MaxLoad.exec
              .runBatch({ rows: msg.rows, workflow: msg.workflow, fileName: msg.fileName, createIfNotFound: !!msg.createIfNotFound })
              .then((res) =>
                chrome.runtime.sendMessage({ type: "ml:batch-result", result: res })
              );
            sendResponse({ ok: true, started: true });
            break;
          }

          case "ml:cmd:check-record":
            // Validate the UPSERT detector on the current screen (for a test button).
            sendResponse({ ok: true, decision: MaxLoad.exec.classifyLocate() });
            break;

          case "ml:cmd:cancel":
            MaxLoad.exec.cancel();
            sendResponse({ ok: true });
            break;

          case "ml:cmd:detect-controls":
            sendResponse({ ok: true, controls: MaxLoad.binder.detectControls() });
            break;

          case "ml:cmd:state":
            sendResponse({ ok: true, state: MaxLoad.dom.describeState() });
            break;

          case "ml:cmd:current-modal":
            sendResponse({ ok: true, modal: MaxLoad.errorWatcher.currentModalInfo() });
            break;

          case "ml:cmd:teach-modal": {
            const res = await MaxLoad.errorWatcher.teachCurrentModal({ button: msg.button, outcome: msg.outcome, scope: msg.scope, workflowId: msg.workflowId });
            sendResponse(res);
            break;
          }

          case "ml:cmd:analyze": {
            const fields = MaxLoad.dom.scanFields().map((f) => ({
              label: f.label,
              stableKey: MaxLoad.matcher.getStableKey(f.el),
              type: f.type,
              id: f.id,
              name: f.name
            }));
            sendResponse({ ok: true, fields, activeCtxs: MaxLoad.dom.activeContexts(document) });
            break;
          }

          case "ml:cmd:toggle-panel":
            MaxLoad.panel && MaxLoad.panel.toggle();
            sendResponse({ ok: true });
            break;

          case "ml:cmd:cache-stats": {
            const stats = await MaxLoad.cache.stats();
            sendResponse({ ok: true, stats });
            break;
          }

          case "ml:cmd:clear-cache":
            await MaxLoad.cache.clearAll();
            sendResponse({ ok: true });
            break;

          default:
            sendResponse({ ok: false, error: "unknown command " + msg.type });
        }
      } catch (e) {
        MaxLoad.error("frame-bridge error", String(e));
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();

    return true; // async response
  });

  MaxLoad.log("frame-bridge ready (top)");
})();
