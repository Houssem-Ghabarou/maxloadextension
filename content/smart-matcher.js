/* MaxLoad — smart matcher.
 * Scores each candidate control 0..100 against a target field intent using
 * weighted signals, and extracts a stable key by stripping Maximo's volatile
 * session-hash prefixes and numeric suffixes.
 */
(function () {
  "use strict";
  const MaxLoad = window.MaxLoad;
  const { normLabel, similarity } = MaxLoad.util;

  // Weights per plan section 3 (Smart Matcher confidence table).
  const W = {
    exactLabel: 40,
    ariaTitle: 25,
    nameId: 20,
    tabContext: 10,
    controlType: 5
  };

  const THRESHOLD = {
    execute: 70, // >=70 -> execute directly
    ruleAssist: 40 // 40..69 -> rule-engine re-scope then re-score; <40 -> AI
  };

  // Maximo control-type suffixes carry no field identity on their own — a bare
  // "-tb"/"-pb"/"tb2" would otherwise make every textbox look identical.
  const CTRL_SUFFIX = /^(tb|tbb|pb|cb|lb|mb|hb|rb|chk|ta|img|image|txt|tab|value|input)\d*(_image|_anchor|_input)?$/i;

  // Maximo grid internals (the per-row select control "tempselect", list-toggle
  // helpers) get captured as clicks but are noise that makes replay misfire.
  // Recognized here so the recorder skips capturing them AND the executor skips
  // replaying any that were recorded before this filter existed.
  const JUNK_CLICK_RE = /tempselect|listtoggle/i;
  function isJunkClick(binding) {
    if (!binding) return false;
    const hay = [binding.stableKey, binding.id, binding.name, binding.text, binding.label]
      .filter(Boolean)
      .join(" ");
    return JUNK_CLICK_RE.test(hay);
  }

  /** Return the key only if it carries real meaning, else null. */
  function meaningfulKey(str) {
    if (!str) return null;
    const cleaned = String(str).replace(/^[-_]+/, "").replace(/[-_]+$/, "");
    if (cleaned.length < 3) return null;
    if (CTRL_SUFFIX.test(cleaned)) return null;
    return cleaned;
  }

  /**
   * Strip Maximo's volatile prefix (e.g. "m1a2b3c_") and numeric suffixes
   * ("_12", "_3_7") to expose the stable attribute key. Returns null when what
   * remains is only a control-type suffix (e.g. "-tb"), because that can't
   * distinguish one field from another — callers must fall back to the label.
   */
  function getStableKey(elOrFp) {
    const el = elOrFp && elOrFp.el ? elOrFp.el : elOrFp;
    if (!el || !el.getAttribute) return null;
    const candidates = [
      el.getAttribute("name"),
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
      el.id
    ];
    for (const c of candidates) {
      if (!c) continue;
      const cleaned = String(c)
        .replace(/^m[0-9a-f]{5,}_?/i, "") // session hash prefix
        .replace(/^tb[0-9]+_/i, "") // textbox counter prefix
        .replace(/_\d+(_\d+)*$/g, "") // numeric row/col suffixes
        .replace(/[-_]+$/, "");
      const mk = meaningfulKey(cleaned);
      if (mk) return mk.toLowerCase();
    }
    return null;
  }

  /**
   * Score one fingerprint against a target spec.
   * target: { label, stableKey?, controlType?, tabContext? }
   * activeCtxs: array of normalized active tab/section labels.
   * Returns { score, reasons:[] }.
   */
  function scoreCandidate(fp, target, activeCtxs) {
    let score = 0;
    const reasons = [];

    // 1. exact / fuzzy visible label match
    if (target.label && fp.label) {
      const sim = similarity(fp.label, target.label);
      if (sim >= 0.95) {
        score += W.exactLabel;
        reasons.push("exact-label");
      } else if (sim >= 0.6) {
        score += Math.round(W.exactLabel * sim);
        reasons.push("fuzzy-label:" + sim.toFixed(2));
      }
    }

    // 2. aria-label / title contains stable key
    const key = target.stableKey || (target.label ? normLabel(target.label) : "");
    const ariaTitle = normLabel(fp.ariaLabel + " " + fp.title);
    if (key && ariaTitle && ariaTitle.includes(normLabel(key))) {
      score += W.ariaTitle;
      reasons.push("aria/title-key");
    }

    // 3. name/id substring matches stable key (after normalizing both)
    const candKey = getStableKey(fp);
    if (target.stableKey && candKey) {
      if (candKey === normLabel(target.stableKey)) {
        score += W.nameId;
        reasons.push("stablekey-exact");
      } else if (
        candKey.includes(normLabel(target.stableKey)) ||
        normLabel(target.stableKey).includes(candKey)
      ) {
        score += Math.round(W.nameId * 0.6);
        reasons.push("stablekey-partial");
      }
    } else if (key && candKey && candKey.includes(normLabel(key).replace(/\s+/g, ""))) {
      score += Math.round(W.nameId * 0.5);
      reasons.push("id-contains-label");
    }

    // 4. correct tab/section context
    if (target.tabContext) {
      if (activeCtxs && activeCtxs.some((c) => c.includes(normLabel(target.tabContext)))) {
        score += W.tabContext;
        reasons.push("tab-context");
      }
    } else if (activeCtxs && activeCtxs.length) {
      // no explicit context required, but being in an active context is mildly good
      score += Math.round(W.tabContext * 0.3);
      reasons.push("in-active-context");
    }

    // 5. expected control type matches
    if (target.controlType) {
      const ct = fp.type;
      const want = target.controlType;
      if (ct === want || (want === "textbox" && (ct === "lookup" || ct === "textarea"))) {
        score += W.controlType;
        reasons.push("control-type");
      }
    } else {
      score += Math.round(W.controlType * 0.5);
    }

    return { score: Math.min(100, score), reasons };
  }

  /**
   * Match a target field spec against all currently visible controls.
   * Returns { best:{fp,score,reasons}, ranked:[...], decision }.
   * decision ∈ 'execute' | 'rule-assist' | 'ai'.
   */
  function match(target, options) {
    options = options || {};
    const fields = options.fields || MaxLoad.dom.scanFields();
    const activeCtxs = options.activeCtxs || MaxLoad.dom.activeContexts(document);
    const ranked = fields
      .map((fp) => {
        const s = scoreCandidate(fp, target, activeCtxs);
        return { fp, score: s.score, reasons: s.reasons };
      })
      .sort((a, b) => b.score - a.score);

    const best = ranked[0] || null;
    let decision = "ai";
    if (best) {
      if (best.score >= THRESHOLD.execute) decision = "execute";
      else if (best.score >= THRESHOLD.ruleAssist) decision = "rule-assist";
      else decision = "ai";
    }
    return { best, ranked: ranked.slice(0, 5), decision, activeCtxs };
  }

  MaxLoad.matcher = { match, scoreCandidate, getStableKey, meaningfulKey, isJunkClick, THRESHOLD, W };
})();
