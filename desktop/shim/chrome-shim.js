/* MaxLoad Desktop — chrome.* compatibility shim (MAIN world).
 *
 * This is the ONE piece that lets the entire unmodified extension codebase run
 * inside Electron. It recreates the small slice of the `chrome.*` API that
 * MaxLoad's content scripts + panel actually use, backed by an IPC bridge
 * (`window.__maxload`, exposed by preload.js) to the main process.
 *
 * The main process plays the role the extension's service worker used to:
 * storage, AI proxy, CDP input, log ring, and message routing between the
 * Maximo page and the panel.
 *
 * Injected into MAIN world by preload.js (via webFrame.executeJavaScript) BEFORE
 * any page/panel script runs, so `chrome` exists by the time panel.js or the
 * content scripts execute.
 */
(function () {
  "use strict";
  if (window.chrome && window.chrome.__maxloadShim) return;

  var bridge = window.__maxload;
  if (!bridge) {
    console.error("[MaxLoad shim] IPC bridge (window.__maxload) missing — preload did not run?");
    return;
  }

  // onMessage listeners registered by page code (frame-bridge, binder, panel…).
  // They all live in this MAIN world, so sendResponse / `return true` async
  // semantics behave exactly like the extension.
  var listeners = [];

  function dispatch(msg, sender, done) {
    var responded = false;
    var willRespondAsync = false;
    function sendResponse(resp) {
      if (responded) return;
      responded = true;
      done && done(resp);
    }
    var snapshot = listeners.slice();
    for (var i = 0; i < snapshot.length; i++) {
      try {
        var r = snapshot[i](msg, sender, sendResponse);
        if (r === true) willRespondAsync = true;
      } catch (e) {
        console.error("[MaxLoad shim] onMessage listener threw:", e);
      }
    }
    // No listener took ownership synchronously or asynchronously — resolve now.
    if (!willRespondAsync && !responded) done && done(undefined);
  }

  // Pushes from the main process: broadcasts (runtime.sendMessage from the other
  // context) and directed messages (tabs.sendMessage) that may need a response.
  bridge.on("ml:push", function (payload) {
    var msg = payload && payload.msg;
    var reqId = payload && payload.reqId;
    var expectResponse = !!(payload && payload.expectResponse);
    var sender = { id: "maxload-desktop", tab: expectResponse ? { id: 1 } : undefined };
    dispatch(msg, sender, function (resp) {
      if (expectResponse) bridge.send("ml:push-response", { reqId: reqId, resp: resp });
    });
  });

  var chrome = {
    __maxloadShim: true,

    runtime: {
      id: "maxload-desktop",
      // Never used as a real error channel here; present so `chrome.runtime.lastError`
      // reads don't throw.
      lastError: null,
      getURL: function (p) {
        return "maxload://app/" + String(p || "").replace(/^\/+/, "");
      },
      // MV3 promise form — the codebase does `await chrome.runtime.sendMessage(...)`.
      sendMessage: function (msg) {
        return bridge.invoke("ml:runtime-send", msg);
      },
      onMessage: {
        addListener: function (fn) {
          if (typeof fn === "function" && listeners.indexOf(fn) === -1) listeners.push(fn);
        },
        removeListener: function (fn) {
          var i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        },
        hasListener: function (fn) {
          return listeners.indexOf(fn) >= 0;
        }
      },
      onInstalled: { addListener: function () {} }
    },

    storage: {
      local: {
        get: function (keys) {
          return bridge.invoke("ml:storage-get", keys === undefined ? null : keys);
        },
        set: function (obj) {
          return bridge.invoke("ml:storage-set", obj);
        },
        remove: function (keys) {
          return bridge.invoke("ml:storage-remove", keys);
        }
      }
    },

    // In the extension the panel targets the "host tab". Here there is exactly one
    // Maximo view, modeled as tab id 1.
    tabs: {
      query: function () {
        return Promise.resolve([{ id: 1, active: true, currentWindow: true, url: location.href }]);
      },
      sendMessage: function (tabId, msg) {
        return bridge.invoke("ml:tabs-send", { tabId: tabId, msg: msg });
      },
      create: function (opts) {
        bridge.send("ml:tabs-create", { url: opts && opts.url });
        return Promise.resolve({ id: 2 });
      }
    }
  };

  window.chrome = chrome;
})();
