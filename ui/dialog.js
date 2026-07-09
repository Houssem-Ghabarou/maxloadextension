/* MaxLoad — dialog helpers (alert / confirm / prompt).
 *
 * The panel uses mlAlert/mlConfirm/mlPrompt instead of the native
 * window.alert/confirm/prompt so the SAME panel code works in both hosts:
 *
 *   • Browser EXTENSION — native dialogs work fine, so we delegate straight to
 *     window.alert/confirm/prompt. Behavior is byte-for-byte what it was before.
 *
 *   • DESKTOP app (Electron BrowserView) — window.prompt() is a documented no-op
 *     and alert/confirm on a docked BrowserView are unreliable, so the native
 *     calls silently do nothing (e.g. "name this workflow" returned null and the
 *     save happened with no visible modal). Here we render a real in-panel modal.
 *
 * Detection: the desktop chrome-shim sets chrome.__maxloadShim; the real
 * extension never does. So the extension path below is 100% native + unchanged.
 *
 * All three helpers are async (return a Promise) so the desktop modal can await
 * a click. mlAlert()/mlConfirm() resolve to undefined/boolean; mlPrompt()
 * resolves to the string entered, or null if cancelled — matching the DOM API.
 */
(function () {
  "use strict";

  var IS_DESKTOP = !!(window.chrome && window.chrome.__maxloadShim);

  // ---- Extension: delegate to the native dialogs (unchanged behavior) --------
  if (!IS_DESKTOP) {
    window.mlAlert = function (msg) {
      window.alert(msg);
      return Promise.resolve();
    };
    window.mlConfirm = function (msg) {
      return Promise.resolve(window.confirm(msg));
    };
    window.mlPrompt = function (msg, def) {
      return Promise.resolve(window.prompt(msg, def == null ? "" : def));
    };
    return;
  }

  // ---- Desktop: an in-panel modal that actually renders ----------------------
  var open = null; // the currently-open modal's cleanup, so a second call replaces it

  function build(opts) {
    // opts: { message, kind: 'alert'|'confirm'|'prompt', defaultValue }
    return new Promise(function (resolve) {
      if (open) open(); // dismiss any modal already up

      var overlay = document.createElement("div");
      overlay.className = "ml-dialog-overlay";
      overlay.style.cssText = [
        "position:fixed", "inset:0", "z-index:2147483647",
        "display:flex", "align-items:center", "justify-content:center",
        "background:rgba(6,10,15,.55)",
        "font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif"
      ].join(";");

      var box = document.createElement("div");
      box.style.cssText = [
        "width:min(420px,90vw)", "box-sizing:border-box",
        "background:#141c26", "color:#eef2f6",
        "border:1px solid #2a3644", "border-radius:12px",
        "box-shadow:0 18px 50px rgba(0,0,0,.5)",
        "padding:18px 18px 14px"
      ].join(";");

      var msg = document.createElement("div");
      msg.textContent = String(opts.message == null ? "" : opts.message);
      msg.style.cssText = "white-space:pre-wrap;margin-bottom:14px;";
      box.appendChild(msg);

      var input = null;
      if (opts.kind === "prompt") {
        input = document.createElement("input");
        input.type = "text";
        input.value = opts.defaultValue == null ? "" : String(opts.defaultValue);
        input.style.cssText = [
          "width:100%", "box-sizing:border-box", "margin-bottom:14px",
          "padding:8px 10px", "border-radius:7px",
          "border:1px solid #34455a", "background:#0e151d", "color:#eef2f6",
          "font:inherit", "outline:none"
        ].join(";");
        box.appendChild(input);
      }

      var actions = document.createElement("div");
      actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";

      function mkBtn(label, primary) {
        var b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.style.cssText = [
          "padding:7px 15px", "border-radius:7px", "cursor:pointer",
          "font:inherit", "border:1px solid " + (primary ? "#1266d6" : "#34455a"),
          "background:" + (primary ? "#1266d6" : "transparent"),
          "color:" + (primary ? "#fff" : "#cdd8e3")
        ].join(";");
        return b;
      }

      function done(value) {
        if (!open) return;
        open = null;
        document.removeEventListener("keydown", onKey, true);
        try { overlay.remove(); } catch (_) {}
        resolve(value);
      }

      var okValue = opts.kind === "confirm" ? true
        : opts.kind === "prompt" ? null /* set on OK */ : undefined;

      var okBtn = mkBtn(opts.kind === "alert" ? "OK" : "OK", true);
      okBtn.addEventListener("click", function () {
        done(opts.kind === "prompt" ? input.value : okValue);
      });

      // alert has only OK; confirm/prompt add Cancel (native cancel => false/null)
      if (opts.kind !== "alert") {
        var cancelBtn = mkBtn("Cancel", false);
        cancelBtn.addEventListener("click", function () {
          done(opts.kind === "confirm" ? false : null);
        });
        actions.appendChild(cancelBtn);
      }
      actions.appendChild(okBtn);
      box.appendChild(actions);
      overlay.appendChild(box);

      // Clicking the backdrop = cancel (for confirm/prompt) / dismiss (alert).
      overlay.addEventListener("mousedown", function (e) {
        if (e.target === overlay) done(opts.kind === "confirm" ? false : opts.kind === "prompt" ? null : undefined);
      });

      function onKey(e) {
        if (e.key === "Escape") {
          e.preventDefault();
          done(opts.kind === "confirm" ? false : opts.kind === "prompt" ? null : undefined);
        } else if (e.key === "Enter") {
          // In a prompt, let Enter in the input confirm; otherwise Enter = OK.
          e.preventDefault();
          done(opts.kind === "prompt" ? input.value : okValue);
        }
      }
      document.addEventListener("keydown", onKey, true);

      open = function () { done(opts.kind === "confirm" ? false : opts.kind === "prompt" ? null : undefined); };
      (document.body || document.documentElement).appendChild(overlay);
      if (input) { input.focus(); input.select(); } else okBtn.focus();
    });
  }

  window.mlAlert = function (msg) { return build({ message: msg, kind: "alert" }); };
  window.mlConfirm = function (msg) { return build({ message: msg, kind: "confirm" }); };
  window.mlPrompt = function (msg, def) { return build({ message: msg, kind: "prompt", defaultValue: def }); };
})();
