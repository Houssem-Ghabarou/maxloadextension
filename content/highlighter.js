/* MaxLoad — execution highlighter + action toast.
 * Makes automation VISIBLE: outlines the exact element being clicked/typed (in
 * whatever frame it lives) and shows a floating status line, so you can watch
 * MaxLoad drive the browser and instantly see where it is / what it's doing.
 */
(function () {
  "use strict";
  const MaxLoad = window.MaxLoad;

  const COLORS = { click: "#1266d6", field: "#14b85a", save: "#8b5cf6", error: "#d64545" };

  function overlayIn(doc) {
    let o = doc.getElementById("maxload-exec-overlay");
    if (!o) {
      o = doc.createElement("div");
      o.id = "maxload-exec-overlay";
      o.style.cssText = [
        "position:fixed",
        "pointer-events:none",
        "z-index:2147483644",
        "border:3px solid #14b85a",
        "border-radius:5px",
        "background:rgba(20,184,90,.14)",
        "box-shadow:0 0 0 2px rgba(255,255,255,.7)",
        "transition:all .09s ease",
        "display:none"
      ].join(";");
      (doc.documentElement || doc.body).appendChild(o);
    }
    return o;
  }

  /** Outline an element in its own frame. kind ∈ click|field|save|error. */
  function flash(el, kind) {
    try {
      if (!el || !el.getBoundingClientRect) return;
      const doc = el.ownerDocument;
      const o = overlayIn(doc);
      const c = COLORS[kind] || COLORS.field;
      o.style.borderColor = c;
      o.style.background = c + "22";
      const r = el.getBoundingClientRect();
      o.style.top = r.top - 3 + "px";
      o.style.left = r.left - 3 + "px";
      o.style.width = r.width + 6 + "px";
      o.style.height = r.height + 6 + "px";
      o.style.display = "block";
    } catch (_) {}
  }

  function clear() {
    try {
      for (const doc of MaxLoad.dom.collectDocuments(document)) {
        const o = doc.getElementById("maxload-exec-overlay");
        if (o) o.style.display = "none";
      }
    } catch (_) {}
  }

  // ---- floating status toast (top frame only) -------------------------------
  let toastEl = null;
  let toastTimer = null;
  function toast(text, kind) {
    if (!MaxLoad.env.isTop) return;
    try {
      if (!toastEl) {
        toastEl = document.createElement("div");
        toastEl.id = "maxload-toast";
        toastEl.style.cssText = [
          "position:fixed",
          "bottom:22px",
          "left:50%",
          "transform:translateX(-50%)",
          "z-index:2147483646",
          "background:#111a24",
          "color:#fff",
          "padding:9px 16px",
          "border-radius:9px",
          "font:13px/1.3 -apple-system,Segoe UI,Roboto,sans-serif",
          "box-shadow:0 8px 26px rgba(0,0,0,.35)",
          "pointer-events:none",
          "max-width:72vw",
          "border-left:4px solid #14b85a"
        ].join(";");
        document.documentElement.appendChild(toastEl);
      }
      toastEl.style.borderLeftColor = COLORS[kind] || COLORS.field;
      toastEl.textContent = "MaxLoad · " + text;
      toastEl.style.display = "block";
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        if (toastEl) toastEl.style.display = "none";
      }, 3000);
    } catch (_) {}
  }

  // ---- big, unmissable KEY badge — flashes when a special key is pressed so the
  //      user can visually confirm Tab / Space / Enter actually fired (top frame). ---
  let keyEl = null, keyTimer = null;
  function keyFlash(label) {
    if (!MaxLoad.env.isTop || !label) return;
    try {
      if (!keyEl) {
        keyEl = document.createElement("div");
        keyEl.id = "maxload-keyflash";
        keyEl.style.cssText = [
          "position:fixed", "top:18%", "left:50%", "transform:translateX(-50%)",
          "z-index:2147483647", "background:#b7791f", "color:#fff",
          "padding:14px 28px", "border-radius:12px",
          "font:800 22px/1 -apple-system,Segoe UI,Roboto,sans-serif",
          "letter-spacing:1px", "box-shadow:0 12px 34px rgba(0,0,0,.45)",
          "border:2px solid #fff", "pointer-events:none", "white-space:nowrap",
          "transition:opacity .15s ease"
        ].join(";");
        document.documentElement.appendChild(keyEl);
      }
      keyEl.textContent = "⌨ " + String(label).toUpperCase() + " pressed";
      keyEl.style.display = "block";
      keyEl.style.opacity = "1";
      clearTimeout(keyTimer);
      keyTimer = setTimeout(() => { if (keyEl) keyEl.style.display = "none"; }, 1100);
    } catch (_) {}
  }

  MaxLoad.hl = { flash, clear, toast, keyFlash };
})();
