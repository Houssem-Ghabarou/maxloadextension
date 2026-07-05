/* MaxLoad — AI Recovery (Grok / xAI).
 * Called ONLY when the Smart Matcher's confidence is below threshold. Sanitizes
 * the DOM (structure + labels only, NEVER field values) and asks Grok for the
 * best-matching element's id/name. Every resolved answer is cached so it's asked
 * once per (tenant, screen, field). The network call itself runs in the service
 * worker (no page CSP), this module handles sanitization + caching.
 */
(function () {
  "use strict";
  const MaxLoad = window.MaxLoad;

  /**
   * Build a sanitized HTML snippet: tag names, labels, and structural attrs
   * (id/name/aria-label/title/type/role) ONLY. All values/text content that
   * could contain live data are stripped.
   */
  function sanitizeSnippet(rootEl, maxNodes = 400) {
    const root = rootEl || document.body;
    const out = [];
    let count = 0;
    const KEEP_ATTRS = ["id", "name", "aria-label", "title", "type", "role", "for"];
    const KEEP_TAGS = new Set([
      "input", "select", "textarea", "label", "button", "a", "td", "th", "tr",
      "table", "div", "span", "form", "fieldset", "legend"
    ]);

    function labelText(el) {
      // keep only short static label-ish text, never values
      if (["label", "legend", "th", "button", "a"].includes(el.tagName.toLowerCase())) {
        const t = (el.childNodes[0] && el.childNodes[0].nodeType === 3
          ? el.childNodes[0].textContent
          : "").trim();
        return t.slice(0, 40);
      }
      return "";
    }

    function walk(el) {
      if (count >= maxNodes) return;
      const tag = el.tagName ? el.tagName.toLowerCase() : "";
      if (!KEEP_TAGS.has(tag)) {
        for (const c of el.children || []) walk(c);
        return;
      }
      count++;
      const attrs = [];
      for (const a of KEEP_ATTRS) {
        const v = el.getAttribute && el.getAttribute(a);
        if (v) attrs.push(`${a}="${String(v).replace(/"/g, "'").slice(0, 60)}"`);
      }
      const txt = labelText(el);
      out.push(`<${tag}${attrs.length ? " " + attrs.join(" ") : ""}>${txt}`);
      for (const c of el.children || []) walk(c);
    }
    walk(root);
    return out.join("\n").slice(0, 12000);
  }

  /** Find the container to sanitize around a target (active section, else body). */
  function contextRoot() {
    const active = document.querySelector(
      "[aria-selected='true'], .tabSel, [class*='Selected']"
    );
    if (active) {
      const panel = active.closest("form, [role=tabpanel], .content, body") || document.body;
      return panel;
    }
    return document.body;
  }

  /**
   * Resolve a field via AI. Checks cache first. On a cache miss, sanitizes and
   * asks Grok (through the service worker), then caches the result.
   * spec: { app, screen, fieldStableKey, label }
   * Returns { pattern, source, fromCache } or null.
   */
  async function resolveField(spec) {
    const cacheSpec = {
      tenant: MaxLoad.env.tenant,
      app: spec.app,
      screen: spec.screen,
      fieldStableKey: spec.fieldStableKey || spec.label
    };

    const cached = await MaxLoad.cache.get(cacheSpec);
    if (cached && !cached.recheckDue) {
      return { pattern: cached.pattern, source: cached.source, fromCache: true };
    }

    const snippet = sanitizeSnippet(contextRoot());
    let resolved = null;
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "ml:ai-resolve",
        targetLabel: spec.label || spec.fieldStableKey,
        snippet
      });
      if (resp && resp.ok && resp.value) resolved = resp.value.trim();
      else if (resp && !resp.ok) MaxLoad.warn("ai-recovery: " + resp.error);
    } catch (e) {
      MaxLoad.warn("ai-recovery: message failed", String(e));
    }

    if (!resolved) return null;
    await MaxLoad.cache.set(cacheSpec, resolved, "ai");
    return { pattern: resolved, source: "ai", fromCache: false };
  }

  /** Given an AI-returned id/name pattern, locate the live element. */
  function resolveElement(pattern) {
    if (!pattern) return null;
    const docs = MaxLoad.dom.collectDocuments(document);
    const tries = [
      (doc) => doc.getElementById(pattern),
      (doc) => doc.querySelector(`[name="${cssEscape(pattern)}"]`),
      (doc) => doc.querySelector(`#${cssEscape(pattern)}`),
      (doc) => doc.querySelector(`[id*="${cssEscape(pattern)}"]`),
      (doc) => doc.querySelector(`[name*="${cssEscape(pattern)}"]`)
    ];
    for (const doc of docs) {
      for (const t of tries) {
        let el = null;
        try {
          el = t(doc);
        } catch (_) {}
        if (el && MaxLoad.util.isVisible(el)) return el;
      }
    }
    return null;
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\#.\[\]]/g, "\\$&");
  }

  // ---- classify an unknown error dialog (skip vs retry vs abort) ------------
  const ERR_CACHE_KEY = "ml:errorClass";

  /** Reduce a message to a stable signature (drop record numbers/ids). */
  function errSignature(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/\d+/g, "#")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
  }

  async function getErrCache() {
    const o = await chrome.storage.local.get(ERR_CACHE_KEY);
    return o[ERR_CACHE_KEY] || {};
  }

  /**
   * Ask the AI to classify a novel error dialog into skip | retryable | abort.
   * Cached by message signature (durable — keyed by text, not volatile DOM), so
   * each distinct message is classified at most once.
   */
  async function classifyError(text) {
    const sig = errSignature(text);
    if (!sig) return null;
    const cache = await getErrCache();
    if (cache[sig]) return { ...cache[sig], fromCache: true };
    let out = null;
    try {
      const resp = await chrome.runtime.sendMessage({ type: "ml:ai-classify-error", text });
      if (resp && resp.ok && resp.class) out = { class: resp.class, reason: resp.reason || "" };
    } catch (e) {
      MaxLoad.warn("classifyError message failed", String(e));
    }
    if (out) {
      cache[sig] = out;
      await chrome.storage.local.set({ [ERR_CACHE_KEY]: cache });
    }
    return out;
  }

  MaxLoad.ai = { sanitizeSnippet, resolveField, resolveElement, contextRoot, classifyError };
})();
