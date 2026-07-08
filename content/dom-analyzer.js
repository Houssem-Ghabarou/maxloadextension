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
    "[contenteditable]:not([contenteditable='false'])"
  ].join(",");

  /** Recursively collect the root document plus every reachable iframe document
   *  (same-origin, incl. Maximo's javascript:/designMode rich-text editors). */
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
        cdoc = f.contentDocument || (f.contentWindow && f.contentWindow.document);
      } catch (_) {
        cdoc = null; // cross-origin
      }
      if (cdoc && out.indexOf(cdoc) === -1) collectDocuments(cdoc, out, depth + 1);
    }
    return out;
  }

  /** Find the visible label text associated with a control. */
  function labelFor(el, depth) {
    depth = depth || 0;
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
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const alby = el.getAttribute && el.getAttribute("aria-labelledby");
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
    const cell = el.closest && el.closest("td");
    if (cell && cell.previousElementSibling) {
      const t = cell.previousElementSibling.textContent.trim();
      if (t) return t;
    }
    const own = (el.getAttribute && (el.getAttribute("title") || el.getAttribute("placeholder")) || "").trim();
    if (own) return own;
    // 5. element inside an iframe (rich-text editor): the caption lives in the
    //    PARENT document next to the <iframe>. Resolve it from there.
    if (depth < 3) {
      try {
        const win = doc.defaultView;
        if (win && win.frameElement && win.frameElement.ownerDocument !== doc) {
          const l = labelFor(win.frameElement, depth + 1);
          if (l) return l;
        }
      } catch (_) {}
    }
    return "";
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

  /** Determine the control type for matching (textbox|lookup|select|checkbox|richtext). */
  function controlType(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "select") return "select";
    if (tag === "textarea") return "textarea";
    // rich-text editor: a role=textbox / contenteditable div (often inside an
    // iframe with designMode) — no .value, filled as editable content.
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (role === "textbox" || el.isContentEditable || (el.getAttribute("contenteditable") || "") === "true") {
      if (tag !== "input") return "richtext";
    }
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox" || type === "radio") return "checkbox";
    // Maximo lookup fields have a sibling lookup/menu button
    const parent = el.closest("td, div, span") || el.parentElement;
    if (parent && parent.querySelector("img[src*='lookup'], [id*='_img'], .lookup, [class*='menu']"))
      return "lookup";
    return "textbox";
  }

  /** Numeric maxlength of an input, or -1 when unset — a strong verification
   *  signal for disambiguating same-label fields (cheap attribute read). */
  function maxLenOf(el) {
    const n = parseInt((el.getAttribute && el.getAttribute("maxlength")) || "-1", 10);
    return isFinite(n) ? n : -1;
  }

  /** Build a fingerprint object for one control. Kept CHEAP — it runs for every
   *  control on every scan, so it only reads attributes (no ancestor walks). The
   *  durable stable fp (section/tab) is computed on demand via fieldFingerprint(). */
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
      ctype: (el.getAttribute && el.getAttribute("ctype")) || "",
      maxLength: maxLenOf(el),
      visible: isVisible(el),
      doc: el.ownerDocument
    };
  }

  /**
   * The DURABLE, cross-session field fingerprint — Maximo's own stable structure,
   * NOT the volatile generated id. Captured at teach time on the pointed field and
   * used at replay to re-derive the live input even after its id regenerates on a
   * new login. Mirrors iAMXLS `fpOf`: visible label + section + active tab +
   * control type + maxlength + required/lookup flags. More expensive than
   * fingerprint() (ancestor walks for section) — call it per pointed field, not per
   * scanned field.
   */
  function fieldFingerprint(el) {
    let fi = {};
    try { fi = JSON.parse((el.getAttribute && el.getAttribute("fldinfo")) || "{}"); } catch (_) {}
    return {
      label: labelFor(el) || "",
      section: sectionAnchor(el) || "",
      tab: (activeContexts(el.ownerDocument)[0]) || "",
      ctype: (el.getAttribute && el.getAttribute("ctype")) || "",
      maxLength: maxLenOf(el),
      required: (el.getAttribute && el.getAttribute("aria-required") === "true") || !!fi.required,
      lookup: !!fi.lookup || !!(el.getAttribute && el.getAttribute("li")),
      idStem: MaxLoad.matcher ? (MaxLoad.matcher.getStableKey(el) || "") : ""
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

  // ---- disambiguating REPEATED controls (e.g. many identical "New Row" buttons) ----
  const CLICKABLE_SIG =
    "button, a, input[type=button], input[type=submit], input[type=image], " +
    "[role=button], [role=menuitem], [onclick], img[id]";

  /** Normalized visible signature of a clickable (its text / alt / title). */
  function clickText(el) {
    const t =
      MaxLoad.util.elementText(el, 60) ||
      el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("aria-label") || el.value || "";
    return normLabel(t);
  }

  /**
   * Best-effort STABLE label of the section/table an element sits in — walks up a
   * few ancestors and reads the nearest section/table header or caption. This is
   * what tells apart repeated controls: every editable Maximo table has its own
   * "New Row" button with identical text, but a different section header above it
   * ("Plans", "Tâches", "Matériel", …).
   */
  function sectionAnchor(el) {
    let node = el && el.parentElement;
    for (let i = 0; i < 12 && node; i++, node = node.parentElement) {
      let hdr = null;
      try {
        hdr = node.querySelector(
          "caption, legend, [role='heading'], h1, h2, h3, h4, h5, " +
          "[class*='sectionheader' i], [class*='sectionhdr' i], [class*='tablehdr' i], " +
          "[class*='sectiontitle' i], [class*='tabletitle' i], [class*='mtb_header' i]"
        );
      } catch (_) {}
      if (hdr && !hdr.contains(el) && isVisible(hdr)) {
        const t = (hdr.textContent || "").replace(/\s+/g, " ").trim();
        if (t && t.length <= 80) return normLabel(t);
      }
    }
    return "";
  }

  /** Every visible clickable sharing a signature, in document order across frames. */
  function sameSignatureClickables(sig) {
    const out = [];
    if (!sig) return out;
    for (const doc of collectDocuments(document)) {
      let els;
      try {
        els = doc.querySelectorAll(CLICKABLE_SIG);
      } catch (_) {
        continue;
      }
      for (const el of els) if (isVisible(el) && clickText(el) === sig) out.push(el);
    }
    return out;
  }

  /** Which same-signature clickable this is (0-based), or -1. Stable across runs
   *  because the number of tables/sections on a screen is fixed. */
  function ordinalOf(el) {
    const sig = clickText(el);
    return sig ? sameSignatureClickables(sig).indexOf(el) : -1;
  }

  MaxLoad.dom = {
    collectDocuments,
    scanFields,
    fingerprint,
    fieldFingerprint,
    maxLenOf,
    labelFor,
    controlType,
    activeContexts,
    findButton,
    describeState,
    clickText,
    sectionAnchor,
    sameSignatureClickables,
    ordinalOf,
    CONTROL_SELECTOR
  };
})();
