/* MaxLoad — DOM analyzer (iframe-aware).
 * Walks the top document plus every same-origin iframe recursively, collecting
 * candidate form controls scoped to the *currently active* tab/section so we
 * never grab hidden Maximo duplicates.
 */
(function () {
  "use strict";
  const MaxLoad = window.MaxLoad;
  const { isVisible, normLabel } = MaxLoad.util;

  const CONTROL_SELECTOR = [
    "input:not([type=hidden])",
    "textarea",
    "select",
    "[role=textbox]",
    "[role=combobox]",
    "[contenteditable=true]"
  ].join(",");

  /** Recursively collect { doc, frameEl } for the root doc and same-origin iframes. */
  function collectDocuments(root, out, depth) {
    out = out || [];
    depth = depth || 0;
    if (depth > 8) return out;
    out.push(root);
    let frames;
    try {
      frames = root.querySelectorAll("iframe, frame");
    } catch (_) {
      return out;
    }
    for (const f of frames) {
      let cdoc = null;
      try {
        cdoc = f.contentDocument;
      } catch (_) {
        cdoc = null; // cross-origin
      }
      if (cdoc) collectDocuments(cdoc, out, depth + 1);
    }
    return out;
  }

  /** Find the visible label text associated with a control. */
  function labelFor(el) {
    const doc = el.ownerDocument;
    // 1. explicit <label for=id>
    if (el.id) {
      const lab = doc.querySelector(`label[for="${cssEscape(el.id)}"]`);
      if (lab && lab.textContent.trim()) return lab.textContent.trim();
    }
    // 2. wrapping <label>
    let p = el.parentElement;
    for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
      if (p.tagName === "LABEL" && p.textContent.trim()) return p.textContent.trim();
    }
    // 3. aria-label / aria-labelledby
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const alby = el.getAttribute("aria-labelledby");
    if (alby) {
      const parts = alby
        .split(/\s+/)
        .map((id) => doc.getElementById(id))
        .filter(Boolean)
        .map((n) => n.textContent.trim())
        .filter(Boolean);
      if (parts.length) return parts.join(" ");
    }
    // 4. Maximo pattern: label cell to the left in a table row
    const cell = el.closest("td");
    if (cell && cell.previousElementSibling) {
      const t = cell.previousElementSibling.textContent.trim();
      if (t) return t;
    }
    // 5. title / placeholder
    return (el.getAttribute("title") || el.getAttribute("placeholder") || "").trim();
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\]/g, "\\$&");
  }

  /** Detect the active tab/section container so we can scope field search. */
  function activeContexts(doc) {
    const ctxs = [];
    // Maximo tabs: selected tab usually has a class like 'tabSel' or aria-selected
    const selectedTabs = doc.querySelectorAll(
      "[aria-selected='true'], .tabSel, .tab_selected, [class*='Selected']"
    );
    selectedTabs.forEach((t) => {
      const label = normLabel(t.textContent);
      if (label) ctxs.push(label);
    });
    return ctxs;
  }

  /** Determine the control type for matching (textbox|lookup|select|checkbox). */
  function controlType(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "select") return "select";
    if (tag === "textarea") return "textarea";
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox" || type === "radio") return "checkbox";
    // Maximo lookup fields have a sibling lookup/menu button
    const parent = el.closest("td, div, span") || el.parentElement;
    if (parent && parent.querySelector("img[src*='lookup'], [id*='_img'], .lookup, [class*='menu']"))
      return "lookup";
    return "textbox";
  }

  /** Build a fingerprint object for one control. */
  function fingerprint(el) {
    return {
      el,
      tag: el.tagName.toLowerCase(),
      type: controlType(el),
      id: el.id || "",
      name: el.getAttribute("name") || "",
      ariaLabel: el.getAttribute("aria-label") || "",
      title: el.getAttribute("title") || "",
      label: labelFor(el),
      visible: isVisible(el),
      doc: el.ownerDocument
    };
  }

  /**
   * Return fingerprints of all *visible* controls across all same-origin frames.
   * options.includeHidden – include off-screen ones (used only for diagnostics).
   */
  function scanFields(options) {
    options = options || {};
    const docs = collectDocuments(document);
    const results = [];
    for (const doc of docs) {
      let controls;
      try {
        controls = doc.querySelectorAll(CONTROL_SELECTOR);
      } catch (_) {
        continue;
      }
      for (const el of controls) {
        const vis = isVisible(el);
        if (!vis && !options.includeHidden) continue;
        results.push(fingerprint(el));
      }
    }
    return results;
  }

  /** Find a clickable control (button / link) by its visible text. */
  function findButton(text, options) {
    options = options || {};
    const want = normLabel(text);
    const docs = collectDocuments(document);
    const candidates = [];
    for (const doc of docs) {
      let els;
      try {
        els = doc.querySelectorAll(
          "button, a, input[type=button], input[type=submit], [role=button], img[alt], [title]"
        );
      } catch (_) {
        continue;
      }
      for (const el of els) {
        if (!isVisible(el)) continue;
        const txt = normLabel(
          el.textContent ||
            el.value ||
            el.getAttribute("alt") ||
            el.getAttribute("title") ||
            el.getAttribute("aria-label")
        );
        if (!txt) continue;
        let score = 0;
        if (txt === want) score = 1;
        else if (txt.includes(want) || want.includes(txt)) score = 0.7;
        else score = MaxLoad.util.similarity(txt, want);
        if (score >= (options.minScore || 0.6)) candidates.push({ el, score, txt });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] ? candidates[0].el : null;
  }

  /**
   * Situational awareness: which app, list vs record view, is a record loaded.
   * Best-effort heuristics for Maximo classic. Used for the panel "Where am I?"
   * readout and to sanity-check that the page is actually reachable.
   */
  function describeState() {
    const docs = collectDocuments(document);
    const fields = scanFields();
    let recordId = null;
    const keyFp = fields.find(
      (f) => /wonum|ticketid|assetnum|(^|_)num$|(^|_)id$|recordid/i.test(f.name + " " + f.id) && f.el.value
    );
    if (keyFp) recordId = keyFp.el.value;

    let view = "unknown";
    for (const doc of docs) {
      const sel = doc.querySelector("[aria-selected='true'], .tabSel, [class*='Selected']");
      if (sel) {
        const t = normLabel(sel.textContent);
        if (/list/.test(t)) { view = "list"; break; }
        if (t) view = "record";
      }
    }
    if (view === "unknown") {
      for (const doc of docs) {
        let rows;
        try {
          rows = doc.querySelectorAll("tr[id*='_tr_'], .tablerow, tr[id*='_row_']");
        } catch (_) {
          continue;
        }
        if (rows && rows.length > 2) { view = "list"; break; }
      }
      if (view === "unknown" && recordId) view = "record";
    }
    return {
      app: (document.title || "").trim(),
      view,
      recordId,
      fieldCount: fields.length,
      frames: docs.length,
      host: MaxLoad.env.tenant
    };
  }

  MaxLoad.dom = {
    collectDocuments,
    scanFields,
    fingerprint,
    labelFor,
    controlType,
    activeContexts,
    findButton,
    describeState,
    CONTROL_SELECTOR
  };
})();
