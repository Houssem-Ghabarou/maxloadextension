/* MaxLoad — Panel injector.
 * Injects the floating MaxLoad toolbar as an isolated iframe (extension origin,
 * so its DOM/CSS can't collide with Maximo). Only runs in the top frame.
 */
(function () {
  "use strict";
  const MaxLoad = window.MaxLoad;
  if (!MaxLoad.env.isTop) return;

  const HOST_ID = "maxload-panel-host";
  let host = null;
  let visible = false;

  function ensureHost() {
    if (host && document.body.contains(host)) return host;
    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = [
      "position:fixed",
      "top:16px",
      "right:16px",
      "width:380px",
      "height:560px",
      "max-height:90vh",
      "z-index:2147483647",
      "box-shadow:0 8px 32px rgba(0,0,0,.35)",
      "border-radius:10px",
      "overflow:hidden",
      "display:none",
      "background:#fff"
    ].join(";");

    const iframe = document.createElement("iframe");
    iframe.src = chrome.runtime.getURL("ui/panel.html");
    iframe.style.cssText = "width:100%;height:100%;border:0;display:block;";
    iframe.setAttribute("allowtransparency", "true");
    host.appendChild(iframe);
    document.documentElement.appendChild(host);
    return host;
  }

  function show() {
    ensureHost();
    host.style.display = "block";
    visible = true;
  }
  function hide() {
    if (host) host.style.display = "none";
    visible = false;
  }
  function toggle() {
    if (visible) hide();
    else show();
  }

  // ---- dragging (the panel header drives this via postMessage) --------------
  function anchorTopLeft() {
    if (!host) return;
    const r = host.getBoundingClientRect();
    host.style.left = r.left + "px";
    host.style.top = r.top + "px";
    host.style.right = "auto";
    host.style.bottom = "auto";
  }
  function moveBy(dx, dy) {
    if (!host) return;
    const r = host.getBoundingClientRect();
    // keep at least a corner on-screen
    const left = Math.max(-r.width + 90, Math.min(r.left + dx, window.innerWidth - 60));
    const top = Math.max(0, Math.min(r.top + dy, window.innerHeight - 34));
    host.style.left = left + "px";
    host.style.top = top + "px";
  }

  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || d.source !== "maxload-panel" || !visible) return;
    if (d.type === "drag-start") anchorTopLeft();
    else if (d.type === "drag-move") moveBy(d.dx || 0, d.dy || 0);
    else if (d.type === "reset-pos") {
      host.style.left = "auto";
      host.style.right = "16px";
      host.style.top = "16px";
    }
  });

  MaxLoad.panel = { show, hide, toggle, get visible() { return visible; } };

  // Auto-show once on injection so the user sees MaxLoad is active. Comment out
  // if you prefer it hidden until the toolbar button is clicked.
  // show();

  MaxLoad.log("panel injector ready");
})();
