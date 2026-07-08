/* MaxLoad — Execution Engine.
 * Step-by-step runner with verify-before-continue. Consults the Error Watcher
 * before AND during every action. Resolves each field through the pipeline:
 *   cache -> smart matcher -> rule-assist re-scope -> AI recovery.
 * Drives per-row CREATE/UPDATE plans from the Excel engine, with resume +
 * logging, and honors the guard against blanking fields on UPDATE (excel-engine
 * already drops empty columns).
 */
(function () {
  "use strict";
  const MaxLoad = window.MaxLoad;
  const { sleep } = MaxLoad.util;

  let cancelFlag = false;
  let running = false;

  // ---- detailed run logging (exported to the log ring; export via panel) -----
  const desc = (el) => (el && MaxLoad.input && MaxLoad.input.describeEl ? MaxLoad.input.describeEl(el) : null);
  function describeBinding(b) {
    if (!b) return null;
    return {
      role: b.role || "",
      id: b.id || "",
      stableKey: b.stableKey || "",
      label: b.label || "",
      text: b.text || "",
      tab: b.tabContext || "",
      hasFp: !!b.fp,
      fpLabel: (b.fp && b.fp.label) || "",
      fpSection: (b.fp && b.fp.section) || "",
      fpTab: (b.fp && b.fp.tab) || "",
      fpMaxLen: (b.fp && b.fp.maxLength) || null,
      anchor: b.anchor || null
    };
  }
  /** Structured trace line — prefixed so the exported log is easy to filter. */
  function trace(msg, data) { MaxLoad.log("⟫ " + msg, data || null); }

  // ---- native value setting (works with Maximo/React-style inputs) ----------
  function isRichText(el) {
    return (
      el.isContentEditable ||
      (el.getAttribute && (el.getAttribute("contenteditable") || "") === "true") ||
      (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && (el.getAttribute && (el.getAttribute("role") || "").toLowerCase() === "textbox"))
    );
  }

  function setNativeValue(el, value) {
    if (el.tagName === "SELECT") {
      selectOption(el, value);
      return;
    }
    if (el.type === "checkbox") {
      const want = /^(1|true|yes|y|x|on)$/i.test(String(value));
      if (el.checked !== want) MaxLoad.util.realClick(el);
      return;
    }
    // rich-text editor (contenteditable / role=textbox, often in an iframe) has
    // no .value — set its editable content instead.
    if (isRichText(el)) {
      try {
        el.focus();
        el.textContent = String(value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (_) {}
      return;
    }
    const proto = Object.getPrototypeOf(el);
    const desc =
      Object.getOwnPropertyDescriptor(el, "value") ||
      Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function selectOption(sel, value) {
    const want = MaxLoad.util.normLabel(value);
    let match = [...sel.options].find(
      (o) => MaxLoad.util.normLabel(o.value) === want || MaxLoad.util.normLabel(o.textContent) === want
    );
    if (!match)
      match = [...sel.options].find(
        (o) =>
          MaxLoad.util.normLabel(o.textContent).includes(want) ||
          want.includes(MaxLoad.util.normLabel(o.textContent))
      );
    if (match) sel.value = match.value;
  }

  function fireInputEvents(el) {
    const win = el.ownerDocument.defaultView || window;
    const K = win.KeyboardEvent || KeyboardEvent;
    try { el.dispatchEvent(new K("keydown", { bubbles: true })); } catch (_) {}
    el.dispatchEvent(new Event("input", { bubbles: true }));
    try { el.dispatchEvent(new K("keyup", { bubbles: true })); } catch (_) {}
    // Maximo commits + validates a field on change/blur (fldchange handler)
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  /** Dispatch a full key sequence on a specific element (Maximo reads keyCode). */
  function dispatchKeyOn(el, key) {
    const vk = key === "Enter" ? 13 : key === "Escape" ? 27 : key === "Tab" ? 9 : 0;
    const win = el.ownerDocument.defaultView || window;
    const K = win.KeyboardEvent || KeyboardEvent;
    const opt = { key, code: key, keyCode: vk, which: vk, bubbles: true, cancelable: true };
    try {
      el.focus();
      el.dispatchEvent(new K("keydown", opt));
      el.dispatchEvent(new K("keypress", opt));
      el.dispatchEvent(new K("keyup", opt));
    } catch (_) {}
  }

  /** Type into a field with real trusted input (selects + overwrites + commits). */
  async function typeInto(el, value) {
    if (el.tagName === "SELECT" || el.type === "checkbox") {
      // dropdowns/checkboxes: trusted click to focus, then set via native path
      await MaxLoad.input.click(el);
      setNativeValue(el, value);
      fireInputEvents(el);
      return;
    }
    if (isRichText(el)) {
      // rich-text editor: type into it, but no Tab commit (Tab inserts a tab char)
      await MaxLoad.input.type(el, value, "");
      return;
    }
    await MaxLoad.input.type(el, value, "tab");
  }

  /** Read a field's current value/text (for read-back verification). */
  function readFieldValue(el) {
    if (!el) return "";
    if (isRichText(el)) return (el.textContent || "").trim();
    return String(el.value == null ? "" : el.value).trim();
  }

  /**
   * Enter a value the iAMXLS way: settle first (a field that just round-tripped
   * briefly LOCKS input and drops keystrokes), type with trusted keystrokes + Tab
   * commit (coordinate-free), wait for Maximo's validation round-trip, then READ
   * BACK — and re-type ONLY if Maximo actually WIPED the field (empty). We never
   * re-type a value it merely reformatted (a lookup/domain shows a display value),
   * which was the old "clears then types again" flicker. Returns true if a value
   * ended up in the field. This is what stops a mandatory field saving blank.
   */
  async function setFieldValueLoop(el, value) {
    const want = String(value == null ? "" : value).trim();
    // let any pending round-trip finish before typing (avoids the input-lock drop)
    await MaxLoad.settle.whenIdle({ settleMs: 120, maxWaitMs: 4000 });
    await typeInto(el, value);
    // Tab-out fires Maximo's field validation (a /ui/maximo.jsp round-trip); wait
    // on the action channel going quiet, event-driven — not a fixed sleep.
    await MaxLoad.settle.whenIdle({ settleMs: 150, maxWaitMs: 4000 });
    if (want === "") return true;
    let got = readFieldValue(el);
    const wiped = got === "" && !isRichText(el);
    if (wiped) {
      // Maximo wiped it (bean never registered the change) — re-enter once.
      trace("field wiped after commit — re-typing", { el: desc(el), want: want.slice(0, 60) });
      await typeInto(el, value);
      await MaxLoad.settle.whenIdle({ settleMs: 150, maxWaitMs: 4000 });
      got = readFieldValue(el);
    }
    const ok = got !== "";
    trace("field commit " + (ok ? "✓" : "✗"), { el: desc(el), want: want.slice(0, 60), readback: got.slice(0, 60), reTyped: wiped });
    return ok;
  }

  /**
   * Find the Maximo SAVE control for the guaranteed end-of-row save. Prefer the
   * stable toolbar action id (`toolactions_SAVE…`, unchanged across sessions and
   * locales); fall back to a labelled Save button in the demo's language.
   */
  function findSaveControl() {
    for (const doc of MaxLoad.dom.collectDocuments(document)) {
      let el = null;
      try { el = doc.querySelector('a[id^="toolactions_SAVE"], [id^="toolactions_SAVE"], img[id^="toolactions_SAVE"]'); } catch (_) {}
      if (el && MaxLoad.util.isVisible(el)) return el;
    }
    return (
      MaxLoad.dom.findButton("Save") ||
      MaxLoad.dom.findButton("Enregistrer") ||
      MaxLoad.dom.findButton("Sauvegarder") ||
      null
    );
  }

  // ---- guard: refuse to act while a blocking modal is present ---------------
  async function guardClear(rowNum, screen) {
    const modal = MaxLoad.errorWatcher.currentBlocking();
    if (!modal) return { outcome: "none" };
    // a modal is present before we even acted — handle it
    return await MaxLoad.errorWatcher.handleIfPresent(rowNum, screen);
  }

  // ---- field resolution pipeline --------------------------------------------
  /**
   * Resolve a target field spec to a live element.
   * Returns { el, via, score } or { el:null, reason }.
   */
  async function resolveField(target, meta) {
    const spec = {
      app: meta.app,
      screen: meta.screen,
      // don't key the cache on a meaningless "-tb" (would collide across fields)
      fieldStableKey: MaxLoad.matcher.meaningfulKey(target.stableKey) || target.label || target.stableKey,
      label: target.label
    };

    // 0. explicit binding (user pointed at this field) — deterministic, fastest.
    if (target._binding && MaxLoad.binder) {
      const bound = MaxLoad.binder.locate(target._binding);
      if (bound) return { el: bound, via: "binding", score: 100 };
      // binding present but not found on this screen -> fall through to pipeline
    }

    // 1. cache
    const cached = await MaxLoad.cache.get({
      tenant: MaxLoad.env.tenant,
      app: spec.app,
      screen: spec.screen,
      fieldStableKey: spec.fieldStableKey
    });
    if (cached && !cached.recheckDue) {
      const el = MaxLoad.ai.resolveElement(cached.pattern);
      if (el) return { el, via: "cache:" + cached.source, score: 100 };
      // cache stale -> fall through and re-resolve
    }

    // 2. smart matcher, with retry for late-rendering fields
    const doMatch = async () => {
      await MaxLoad.settle.waitForSettle({ quietMs: 300, timeoutMs: 4000 });
      const m = MaxLoad.matcher.match(target);
      return m && m.best ? m : null;
    };
    let m = await MaxLoad.settle.retryUntil(doMatch, { intervalMs: 250, timeoutMs: 6000 });

    if (m && m.decision === "execute") {
      await cacheResolved(spec, m.best.fp, "deterministic");
      return { el: m.best.fp.el, via: "matcher", score: m.best.score };
    }

    // 3. rule-assist: re-scope to active tab, clear spinners/lookups, re-score
    if (m && m.decision === "rule-assist") {
      await MaxLoad.rules.applyRules({});
      await MaxLoad.settle.waitForSettle({ quietMs: 300, timeoutMs: 3000 });
      const m2 = MaxLoad.matcher.match(target);
      if (m2 && m2.best && m2.best.score >= MaxLoad.matcher.THRESHOLD.execute) {
        await cacheResolved(spec, m2.best.fp, "deterministic");
        return { el: m2.best.fp.el, via: "rule-assist", score: m2.best.score };
      }
      m = m2 || m;
    }

    // 4. AI recovery
    const ai = await MaxLoad.ai.resolveField(spec);
    if (ai && ai.pattern) {
      const el = MaxLoad.ai.resolveElement(ai.pattern);
      if (el) return { el, via: ai.fromCache ? "cache:ai" : "ai", score: 100 };
    }

    return {
      el: null,
      reason: "unresolved",
      bestScore: m && m.best ? m.best.score : 0
    };
  }

  async function cacheResolved(spec, fp, source) {
    const pattern = fp.id || fp.name || MaxLoad.matcher.getStableKey(fp.el);
    if (pattern)
      await MaxLoad.cache.set(
        {
          tenant: MaxLoad.env.tenant,
          app: spec.app,
          screen: spec.screen,
          fieldStableKey: spec.fieldStableKey
        },
        pattern,
        source
      );
  }

  // ---- primitive actions -----------------------------------------------------
  async function setField(target, value, meta, rowNum) {
    const guard = await guardClear(rowNum, meta.screen);
    if (guard.outcome === "abort-run") return { ok: false, abort: true, message: guard.message };
    if (guard.outcome === "row-failed") return { ok: false, message: guard.message };

    const r = await resolveField(target, meta);
    if (!r.el) {
      return { ok: false, message: `Field not found: ${target.label || target.stableKey} (bestScore=${r.bestScore || 0})` };
    }

    const el = r.el;
    if (el.getAttribute("readonly") != null || el.disabled) {
      return { ok: true, skipped: true, message: `readonly: ${target.label} — skipped (warning)` };
    }

    // trusted keystrokes + Tab commit + read-back + re-type-if-wiped (same path
    // the sequence runner uses — SELECT/checkbox/rich-text handled inside typeInto)
    await setFieldValueLoop(el, value);

    // A lookup field may pop a chooser — let the rule engine handle it.
    await MaxLoad.rules.applyRules({ searchTerm: value });
    await MaxLoad.settle.waitForSettle({ quietMs: 300, timeoutMs: 4000 });

    // a blocking modal may have appeared asynchronously (background validation)
    const post = await MaxLoad.errorWatcher.handleIfPresent(rowNum, meta.screen);
    if (post.outcome === "abort-run") return { ok: false, abort: true, message: post.message };
    if (post.outcome === "row-failed") return { ok: false, message: post.message };

    return { ok: true, via: r.via, score: r.score };
  }

  async function clickByText(text, meta, rowNum) {
    const guard = await guardClear(rowNum, meta.screen);
    if (guard.outcome === "abort-run") return { ok: false, abort: true, message: guard.message };

    const btn = await MaxLoad.settle.retryUntil(
      async () => MaxLoad.dom.findButton(text),
      { intervalMs: 200, timeoutMs: 6000 }
    );
    if (!btn) return { ok: false, message: `Button not found: ${text}` };
    MaxLoad.util.realClick(btn);
    await MaxLoad.settle.waitForSettle({ quietMs: 400, timeoutMs: 10000 });
    await MaxLoad.rules.applyRules({});
    return { ok: true };
  }

  // ---- clicking a bound (or text-named) button ------------------------------
  async function clickBound(binding, fallbackText, meta, rowNum) {
    if (binding && MaxLoad.binder) {
      const el = MaxLoad.binder.locateButton(binding);
      if (el) {
        const guard = await guardClear(rowNum, meta.screen);
        if (guard.outcome === "abort-run") return { ok: false, abort: true, message: guard.message };
        MaxLoad.util.realClick(el);
        await MaxLoad.settle.waitForSettle({ quietMs: 400, timeoutMs: 10000 });
        await MaxLoad.rules.applyRules({});
        return { ok: true, via: "binding" };
      }
    }
    return clickByText(fallbackText, meta, rowNum);
  }

  // ---- record location for UPDATE -------------------------------------------
  // keyFieldTarget can be a string (label) or a { _binding } field target.
  async function locateRecord(keyFieldTarget, keyValue, meta, rowNum) {
    // Strategy: use Maximo's list/filter. Find a filter input matching keyField,
    // type the value, submit, wait for the single record to load.
    await MaxLoad.settle.waitForSettle({ quietMs: 300, timeoutMs: 5000 });

    let filter = null;
    let keyField = keyFieldTarget;
    if (keyFieldTarget && keyFieldTarget._binding && MaxLoad.binder) {
      filter = MaxLoad.binder.locate(keyFieldTarget._binding);
      keyField = keyFieldTarget.label || keyFieldTarget.stableKey || "key";
    }
    if (typeof keyField !== "string") keyField = (keyField && (keyField.label || keyField.stableKey)) || "key";

    if (!filter) {
      const target = { label: keyField, stableKey: keyField, controlType: "textbox" };
      const m = MaxLoad.matcher.match(target);
      filter = m && m.best && m.best.score >= 40 ? m.best.fp.el : null;
    }

    // fallback: any visible filter/search box near a header labeled keyField
    if (!filter) {
      const fields = MaxLoad.dom.scanFields();
      filter = (fields.find((f) =>
        MaxLoad.util.normLabel(f.label + " " + f.name + " " + f.id).includes(
          MaxLoad.util.normLabel(keyField)
        )
      ) || {}).el;
    }
    if (!filter) return { ok: false, message: `UPDATE: could not find search field for "${keyField}"` };

    typeInto(filter, keyValue);
    await MaxLoad.settle.waitForSettle({ quietMs: 400, timeoutMs: 8000 });
    await MaxLoad.rules.applyRules({ searchTerm: keyValue });

    // open the first matching row if a result list is shown
    const link = MaxLoad.dom.findButton(String(keyValue), { minScore: 0.9 });
    if (link) {
      MaxLoad.util.realClick(link);
      await MaxLoad.settle.waitForSettle({ quietMs: 400, timeoutMs: 8000 });
    }

    const modal = await MaxLoad.errorWatcher.handleIfPresent(rowNum, meta.screen);
    if (modal.outcome === "abort-run") return { ok: false, abort: true, message: modal.message };
    if (modal.outcome === "row-failed") return { ok: false, message: modal.message };

    return { ok: true };
  }

  // ---- run a single row through a workflow ----------------------------------
  /**
   * plan: { action, keyField, keyValue, fields:[{column,value}] }
   * workflow: recorded steps + meta.
   */
  async function runRow(plan, workflow, rowNum) {
    const meta = { app: workflow.name, screen: workflow.screen };
    const bindings = workflow.bindings || null;
    const columnMap = buildColumnMap(workflow);

    // 1. entry point
    if (plan.action === "CREATE") {
      const newStep = workflow.steps && workflow.steps.find((s) => s.type === "click-new");
      const r = await clickBound(bindings && bindings.buttons && bindings.buttons.new, newStep ? newStep.text : "New", meta, rowNum);
      if (r.abort) return { status: "abort", message: r.message };
      // (not fatal if the New button text differs — user may already be on a blank form)
    } else {
      let keyTarget;
      if (bindings && bindings.keyField) {
        keyTarget = { label: bindings.keyField.label || plan.keyField, stableKey: bindings.keyField.stableKey, _binding: bindings.keyField };
      } else {
        keyTarget = plan.keyField || (workflow.steps && (workflow.steps.find((s) => s.type === "select-record") || {}).keyField);
      }
      const r = await locateRecord(keyTarget, plan.keyValue, meta, rowNum);
      if (r.abort) return { status: "abort", message: r.message };
      if (!r.ok) return { status: "failed", message: r.message };
    }

    // 2. write only the fields present (non-empty) in this row
    const warnings = [];
    for (const f of plan.fields) {
      if (cancelFlag) return { status: "cancelled", message: "run cancelled" };
      const target = columnMap[f.column];
      if (!target) {
        // an Excel column with no binding on this workflow — record it, don't fail hard
        warnings.push(`column "${f.column}" is not bound — skipped`);
        continue;
      }
      const r = await setField(target, f.value, meta, rowNum);
      if (r.abort) return { status: "abort", message: r.message };
      if (!r.ok) return { status: "failed", message: r.message };
      if (r.skipped) warnings.push(r.message);
    }

    // 3. save + verify
    const saveStep = workflow.steps && workflow.steps.find((s) => s.type === "save");
    const before = plan.action === "CREATE" ? snapshotRecordId() : null;
    const s = await clickBound(bindings && bindings.buttons && bindings.buttons.save, saveStep ? saveStep.text : "Save", meta, rowNum);
    if (s.abort) return { status: "abort", message: s.message };

    // post-save modal handling (duplicate key, conflict, confirm dialogs)
    const post = await MaxLoad.errorWatcher.handleIfPresent(rowNum, meta.screen);
    if (post.outcome === "abort-run") return { status: "abort", message: post.message };
    if (post.outcome === "row-failed") return { status: "failed", message: post.message };

    // verify
    const verify = await verifySave(plan.action, before);
    const inline = MaxLoad.errorWatcher.captureInlineMessages();
    if (!verify.ok) {
      return { status: "failed", message: verify.message + (inline.length ? " | " + inline.join(" ; ") : "") };
    }
    return {
      status: "done",
      message: (warnings.length ? warnings.join(" ; ") : "") + (inline.length ? " | " + inline.join(" ; ") : ""),
      via: verify.detail
    };
  }

  function buildColumnMap(workflow) {
    const map = {};
    // recorded steps (legacy path)
    for (const s of workflow.steps || []) {
      if (s.type === "set-field" && s.column) map[s.column] = s.target;
    }
    // explicit bindings take precedence — deterministic, user-pointed.
    if (workflow.bindings && workflow.bindings.columns) {
      for (const [col, b] of Object.entries(workflow.bindings.columns)) {
        map[col] = {
          label: b.label || col,
          stableKey: b.stableKey || col,
          controlType: b.controlType || "textbox",
          tabContext: b.tabContext || null,
          _binding: b
        };
      }
    }
    return map;
  }

  function snapshotRecordId() {
    // best-effort: capture visible key-ish field values to detect a new record
    const fields = MaxLoad.dom.scanFields();
    const key = fields.find((f) =>
      /num|id$|^wonum|ticketid|assetnum/i.test(f.name + " " + f.id)
    );
    return key ? key.el.value : null;
  }

  async function verifySave(action, beforeId) {
    await MaxLoad.settle.waitForSettle({ quietMs: 400, timeoutMs: 6000 });
    const modal = MaxLoad.errorWatcher.currentBlocking();
    if (modal) return { ok: false, message: "Blocking dialog after save: " + modal.text.slice(0, 200) };

    if (action === "CREATE") {
      const afterId = snapshotRecordId();
      if (beforeId != null && afterId != null && afterId === beforeId) {
        // id unchanged could still be fine on some screens; treat as soft-ok
        return { ok: true, detail: "saved (id unchanged)" };
      }
      return { ok: true, detail: "new record id: " + (afterId || "n/a") };
    }
    // UPDATE: success is simply the absence of a conflict/error dialog
    return { ok: true, detail: "updated in place" };
  }

  // ---- sequence replay (the "follow-what-you-do" workflows) -----------------
  /** Apply a Maximo search/QBE operator to a value (e.g. ">", "%…%"). */
  function applyOperator(op, v) {
    if (!op || op === "none") return v;
    if (op === "contains") return "%" + v + "%";
    if (op === "starts") return v + "%";
    if (op === "ends") return "%" + v;
    return op + v; // = > < >= <= != ~
  }

  /** Decide the value to type into a mapped field step for a given row. */
  function fieldValueFor(step, row) {
    const map = step.column || "__ignore__";
    let v;
    if (map === "__ignore__") return { skip: true };
    if (map === "__fixed__") v = step.sampleValue != null ? String(step.sampleValue) : "";
    else if (map === "__key__") v = row._key_value != null ? String(row._key_value).trim() : "";
    else {
      const raw = row[map];
      v = raw != null ? String(raw).trim() : "";
    }
    if (v === "") return { skip: true }; // empty cell -> never write (no blanking)
    return { value: applyOperator(step.operator, v) };
  }

  /** Decide the status value for a `select` step: column | fixed demonstrated
   *  code | key. Unbound falls back to the demonstrated code; empty is skipped. */
  function selectValueFor(step, row) {
    const map = step.column || "__fixed__";
    let v;
    if (map === "__fixed__" || map === "__ignore__") v = step.code != null ? String(step.code) : "";
    else if (map === "__key__") v = row._key_value != null ? String(row._key_value).trim() : "";
    else {
      const raw = row[map];
      v = raw != null ? String(raw).trim() : "";
    }
    if (v === "") return { skip: true };
    return { value: v };
  }

  /** A cheap presence check for the NEXT step's target, used to wait out a dialog
   *  this click just opened (e.g. Change Status → the status dialog) before racing
   *  ahead. Returns null when there's nothing to wait for. */
  function nextTargetProbe(step) {
    if (!step) return null;
    if (step.type === "set-field" && step.binding && MaxLoad.binder) {
      return () => !!MaxLoad.binder.locate(step.binding);
    }
    if (step.type === "select") {
      const b = step.opener && step.opener.binding;
      return () =>
        (MaxLoad.menu && MaxLoad.menu.menuOpen && MaxLoad.menu.menuOpen()) ||
        (!!b && MaxLoad.binder && !!MaxLoad.binder.locate(b));
    }
    return null;
  }

  async function resolveStepField(step, meta) {
    // 1. deterministic, binding-first (fingerprint → label → id) with a late-render retry
    if (step.binding && MaxLoad.binder) {
      let el = MaxLoad.binder.locate(step.binding);
      let retried = false;
      if (!el) {
        retried = true;
        el = await MaxLoad.settle.retryUntil(
          async () => {
            await MaxLoad.settle.waitForSettle({ quietMs: 250, timeoutMs: 2500 });
            return MaxLoad.binder.locate(step.binding);
          },
          { intervalMs: 300, timeoutMs: 5000 }
        );
      }
      if (el) { trace("resolve field ✓ (binding" + (retried ? "/retry" : "") + ")", { binding: describeBinding(step.binding), el: desc(el) }); return { el, via: "binding", score: 100 }; }
      trace("resolve field — binding miss, trying matcher/AI", { binding: describeBinding(step.binding) });
    }
    // 2. only now fall through to matcher / rule-assist / AI (resolveField)
    const t = step.target || {};
    const r = await resolveField(
      { label: t.label, stableKey: t.stableKey, controlType: t.controlType, tabContext: t.tabContext, _binding: step.binding },
      meta
    );
    if (r && r.el) trace("resolve field ✓ (" + (r.via || "?") + ")", { label: t.label, score: r.score, el: desc(r.el) });
    else trace("resolve field ✗ NOT FOUND", { label: t.label, stableKey: t.stableKey, bestScore: r && r.bestScore, binding: describeBinding(step.binding) });
    return r;
  }

  /** Resolve a recorded click step: stable id/text first, AI only if stuck. */
  async function resolveStepButton(step, meta) {
    const quick = () => {
      if (MaxLoad.binder) {
        const el = MaxLoad.binder.locateButton(step.binding);
        if (el) return { el, via: "binding" };
      }
      if (step.text) {
        const el = MaxLoad.dom.findButton(step.text);
        if (el) return { el, via: "text" };
      }
      return null;
    };
    let r = quick();
    if (r) { trace("resolve button ✓ (fast)", { want: step.text || (step.binding && step.binding.stableKey), via: r.via, el: desc(r.el) }); return r; }
    trace("resolve button — fast miss, retrying", { want: step.text, binding: describeBinding(step.binding) });

    // A button in a JUST-OPENED dialog ("OK", "Yes", a sub-record toolbar) is
    // often still painting on the first look — retry briefly before giving up, so
    // a slow dialog doesn't hard-fail the row (which strands every later row too).
    r = await MaxLoad.settle.retryUntil(
      async () => {
        await MaxLoad.settle.waitForSettle({ quietMs: 200, timeoutMs: 1500 });
        return quick();
      },
      { intervalMs: 250, timeoutMs: 2500 }
    );
    if (r) { trace("resolve button ✓ (retry)", { want: step.text, via: r.via, el: desc(r.el) }); return r; }

    // AI fallback — describe the control so the model can pick it from structure
    if (MaxLoad.ai) {
      const ai = await MaxLoad.ai.resolveField({
        app: meta.app,
        screen: meta.screen,
        fieldStableKey: step.binding && step.binding.stableKey,
        label: (step.text || "") + " (button/link)"
      });
      if (ai && ai.pattern) {
        const el = MaxLoad.ai.resolveElement(ai.pattern);
        if (el) { trace("resolve button ✓ (AI)", { want: step.text, el: desc(el) }); return { el, via: ai.fromCache ? "cache:ai" : "ai" }; }
      }
    }
    trace("resolve button ✗ NOT FOUND — nothing to click", { want: step.text, binding: describeBinding(step.binding) });
    return { el: null };
  }

  /** Log a step's resolution and stream it to the panel so AI use is visible. */
  function reportStep(rowNum, idx, kind, name, via) {
    const detail = { row: rowNum, step: idx + 1, kind, name, via };
    MaxLoad.util.log(via === "ai" ? "warn" : "log", `row ${rowNum} · step ${idx + 1} ${kind} “${name}” → ${via}`, detail);
    try {
      chrome.runtime?.sendMessage({ type: "ml:progress", ev: { phase: "step", index: rowNum - 1, stepIndex: idx, kind, name, via } });
    } catch (_) {}
  }

  // ---- simple sequence runner (rebuilt) -------------------------------------
  const norm = MaxLoad.util.normLabel;

  function isSaveStep(step) {
    if (!step || step.type !== "click") return false;
    const role = (step.binding && step.binding.role) || "";
    return /save/.test(role) || /^save\b/.test(norm(step.text || ""));
  }
  function isNewStep(step) {
    if (!step || step.type !== "click") return false;
    const role = (step.binding && step.binding.role) || "";
    return /new/.test(role) || /^(new|insert|add|create)\b/.test(norm(step.text || ""));
  }

  /** Ready once the record form's first mapped field is locatable. */
  async function verifyEntry(workflow) {
    const f = (workflow.steps || []).find(
      (s) => s.type === "set-field" && s.binding && s.column && s.column !== "__ignore__"
    );
    if (!f) {
      await MaxLoad.settle.waitForSettle({ quietMs: 300, timeoutMs: 4000 });
      return true;
    }
    const el = await MaxLoad.settle.retryUntil(
      async () => {
        await MaxLoad.settle.waitForSettle({ quietMs: 250, timeoutMs: 2500 });
        return MaxLoad.binder.locate(f.binding);
      },
      { intervalMs: 300, timeoutMs: 9000 }
    );
    return !!el;
  }

  function tail(inline) {
    return inline && inline.length ? " | " + inline.join(" ; ") : "";
  }

  /** Press-through any leftover popup before starting a row (clean start). */
  async function clearLeftoverModals(rowNum, screen) {
    for (let k = 0; k < 5; k++) {
      if (!MaxLoad.errorWatcher.currentBlocking()) return { ok: true };
      const h = await MaxLoad.errorWatcher.handle(rowNum, screen);
      if (h.outcome === "abort") return { ok: false, abort: true, message: h.message };
      await MaxLoad.settle.waitForSettle({ quietMs: 250, timeoutMs: 3000 });
    }
    return { ok: true };
  }

  /**
   * Replay the recorded scenario for one data row — the SAME simple flow for
   * CREATE and UPDATE. Whatever you taught (click New / type in a search box /
   * press Enter / click a record / edit fields / Save) is replayed in order,
   * with each field filled from its mapped Excel column. Popups are resolved by
   * the modal handler (continue / skip-row / abort).
   */
  async function runRowSeq(workflow, row, rowNum) {
    const meta = { app: workflow.name, screen: workflow.screen };
    const action = String(row._action || workflow.action || "CREATE").toUpperCase();
    const steps = workflow.steps || [];
    const warnings = [];
    let saved = false;
    let filled = 0; // fields/selects actually set — gates never-save-empty
    let emptyRefused = false; // a demo Save reached with nothing filled → refused

    MaxLoad.hl && MaxLoad.hl.toast(`Row ${rowNum} [${action}] — starting`, "click");
    trace(`ROW ${rowNum} [${action}] start — ${steps.length} steps`, {
      row: rowNum,
      action,
      screen: meta.screen,
      steps: steps.map((s, i) => ({ i: i + 1, type: s.type, name: s.text || (s.target && s.target.label) || s.key || s.code || "", column: s.column }))
    });

    const c0 = await clearLeftoverModals(rowNum, meta.screen);
    if (c0.abort) return { status: "abort", message: c0.message };

    for (let idx = 0; idx < steps.length; idx++) {
      if (cancelFlag) return { status: "cancelled", message: "run cancelled" };
      const step = steps[idx];
      trace(`row ${rowNum} · step ${idx + 1}/${steps.length}: ${step.type}`, {
        row: rowNum,
        step: idx + 1,
        type: step.type,
        name: step.text || (step.target && (step.target.label || step.target.stableKey)) || step.key || step.code || "",
        column: step.column,
        binding: describeBinding(step.binding),
        opener: step.opener ? { near: step.opener.near, title: step.opener.title, id: step.opener.id } : undefined
      });

      // popup blocking BEFORE we act?
      let h = await MaxLoad.errorWatcher.handle(rowNum, meta.screen);
      if (h.outcome === "abort") return { status: "abort", message: h.message };
      if (h.outcome === "fail") return { status: "failed", message: h.message };

      if (step.type === "click" || isSaveStep(step)) {
        // skip Maximo grid noise (row-select "tempselect", list toggles) that
        // was recorded before the recorder filtered it — replaying it misfires.
        if (step.type === "click" && !isSaveStep(step) &&
            MaxLoad.matcher.isJunkClick({ ...(step.binding || {}), text: step.text })) {
          reportStep(rowNum, idx, "skip", (step.text || (step.binding && step.binding.stableKey) || "click") + " (grid noise)", "skipped");
          continue;
        }
        const save = isSaveStep(step);
        // NEVER save an empty record: a demo Save reached with nothing filled would
        // commit a blank/invalid row. Refuse it (data safety) and report honestly.
        if (save && filled === 0) {
          reportStep(rowNum, idx, "skip", "Save refused — no fields filled", "empty");
          emptyRefused = true;
          break;
        }
        // a click whose NEXT step is a `select` is the dropdown OPENER — never let
        // its miss abort the row; the select step re-opens the menu itself.
        const opensDropdown = steps[idx + 1] && steps[idx + 1].type === "select";
        const rb = await resolveStepButton(step, meta);
        if (!rb.el) {
          if (opensDropdown) {
            reportStep(rowNum, idx, "click", (step.text || "dropdown") + " (opener — menu handled next)", "skipped");
            continue;
          }
          return { status: "failed", transient: true, message: `step ${idx + 1}: button "${step.text || (step.binding && step.binding.stableKey)}" not found` };
        }
        reportStep(rowNum, idx, save ? "save" : "click", step.text || step.binding.stableKey, rb.via);
        MaxLoad.hl && MaxLoad.hl.flash(rb.el, save ? "save" : "click");
        MaxLoad.hl && MaxLoad.hl.toast(`Row ${rowNum}: ${save ? "Save" : "click “" + (step.text || "button") + "”"}`, save ? "save" : "click");
        await MaxLoad.input.click(rb.el);
        await MaxLoad.settle.waitForSettleOrModal({ quietMs: 400, timeoutMs: save ? 12000 : opensDropdown ? 800 : 5000 });

        // If the next step interacts with a field/dropdown that lives in a dialog
        // this click just opened (Change Status → the status dialog fetches over
        // the network, with a quiet gap isBusy() misses), don't race ahead — wait
        // until that target actually renders. Bounded, and free when it's already
        // there (the common case: normal form fields), so it only costs time when
        // a dialog is genuinely still loading.
        if (!save) {
          const probe = nextTargetProbe(steps[idx + 1]);
          if (probe && !probe()) {
            await MaxLoad.settle.retryUntil(
              async () => {
                await MaxLoad.settle.waitForSettle({ quietMs: 250, timeoutMs: 2000 });
                return probe();
              },
              { intervalMs: 200, timeoutMs: 8000 }
            );
          }
        }

        if (isNewStep(step)) {
          // ENTRY: "save changes?" here = discard the previous record and continue.
          const e = await MaxLoad.errorWatcher.handleEntryPrompt(rowNum, meta.screen);
          if (e.outcome === "abort") return { status: "abort", message: e.message };
          if (e.outcome === "fail") return { status: "failed", message: e.message };
          // best-effort wait for the form to render; don't hard-fail here — the
          // field steps retry and report precisely (works for record-New AND a
          // "new row" inside a relation/table, which has no top-level form).
          await verifyEntry(workflow);
        } else if (!opensDropdown) {
          h = await MaxLoad.errorWatcher.handle(rowNum, meta.screen);
          if (h.outcome === "abort") return { status: "abort", message: h.message };
          if (h.outcome === "fail") return { status: "failed", message: h.message };
        }

        if (save) saved = true;
        // an opener that's about to drop a menu doesn't need lookup/spinner
        // handling — skip it (it was the biggest source of delay on status).
        if (!opensDropdown) await MaxLoad.rules.applyRules({});
      } else if (step.type === "set-field") {
        const fv = fieldValueFor(step, row);
        if (fv.skip) {
          const nm0 = (step.target && (step.target.label || step.target.stableKey)) || "field";
          const why = !step.column || step.column === "__ignore__" ? "(not mapped)" : `(column "${step.column}" empty)`;
          MaxLoad.log(`row ${rowNum}: skip "${nm0}" ${why}`);
          reportStep(rowNum, idx, "skip", nm0 + " " + why, "empty");
          continue;
        }
        const r = await resolveStepField(step, meta);
        const nm = (step.target && (step.target.label || step.target.stableKey)) || "field";
        if (!r.el) return { status: "failed", transient: true, message: `step ${idx + 1}: field "${nm}" not found` };
        if (r.el.getAttribute("readonly") != null || r.el.disabled) {
          warnings.push(`"${nm}" readonly — skipped`);
          continue;
        }
        reportStep(rowNum, idx, "field", nm, r.via);
        MaxLoad.hl && MaxLoad.hl.flash(r.el, "field");
        MaxLoad.hl && MaxLoad.hl.toast(`Row ${rowNum}: ${nm} = “${fv.value}”`, "field");
        // trusted keystrokes + Tab commit + read-back + re-type-if-wiped
        const okv = await setFieldValueLoop(r.el, fv.value);
        if (okv) filled++;
        else warnings.push(`"${nm}" did not accept the value`);
        // a lookup field may pop a chooser — let the rule engine resolve it
        await MaxLoad.rules.applyRules({ searchTerm: fv.value });
        await MaxLoad.settle.waitForSettleOrModal({ quietMs: 250, timeoutMs: 3000 });

        h = await MaxLoad.errorWatcher.handle(rowNum, meta.screen);
        if (h.outcome === "abort") return { status: "abort", message: h.message };
        if (h.outcome === "fail") return { status: "failed", message: h.message };
      } else if (step.type === "key") {
        // press a recorded key (Enter to submit a search, etc.) on its field
        let kel = null;
        if (step.binding) {
          kel = MaxLoad.binder.locate(step.binding);
          if (kel) await MaxLoad.input.click(kel); // re-focus the field first
        }
        reportStep(rowNum, idx, "key", "⌨ " + step.key, "cdp");
        MaxLoad.hl && MaxLoad.hl.toast(`Row ${rowNum}: press ${step.key}`, "click");
        // belt-and-suspenders: dispatch the key on the element (Maximo onkeydown
        // reads keyCode) AND send a trusted CDP key.
        if (kel) dispatchKeyOn(kel, step.key);
        await MaxLoad.input.pressKey(step.key);
        await MaxLoad.settle.waitForSettleOrModal({ quietMs: 500, timeoutMs: 12000 });

        h = await MaxLoad.errorWatcher.handle(rowNum, meta.screen);
        if (h.outcome === "abort") return { status: "abort", message: h.message };
        if (h.outcome === "fail") return { status: "failed", message: h.message };
      } else if (step.type === "select") {
        // Maximo status/synonym dropdown: open the menu (reusing the opener the
        // previous click opened, or re-opening via its stable anchors) and click
        // the option by its internal CODE — from the Excel column, or the fixed
        // demonstrated code when unmapped.
        const sv = selectValueFor(step, row);
        const nm = (step.target && step.target.label) || "status";
        if (sv.skip) {
          reportStep(rowNum, idx, "skip", nm + " (empty)", "empty");
          continue;
        }
        reportStep(rowNum, idx, "select", `${nm} = ${sv.value}`, "menu");
        MaxLoad.hl && MaxLoad.hl.toast(`Row ${rowNum}: ${nm} → “${sv.value}”`, "field");
        const rs = await MaxLoad.menu.selectSynonym(sv.value, step.opener);
        if (!rs.ok) return { status: "failed", message: `step ${idx + 1}: ${nm} — ${rs.message}` };
        filled++;
        h = await MaxLoad.errorWatcher.handle(rowNum, meta.screen);
        if (h.outcome === "abort") return { status: "abort", message: h.message };
        if (h.outcome === "fail") return { status: "failed", message: h.message };
      }
    }

    trace(`row ${rowNum} · steps done`, { row: rowNum, filled, saved, emptyRefused });

    // NEVER SAVE EMPTY: a demo Save was reached with nothing filled and refused.
    if (emptyRefused) {
      const inline0 = MaxLoad.errorWatcher.captureInlineMessages();
      trace(`row ${rowNum} ✗ refused save — nothing filled`, { row: rowNum, filled });
      return { status: "failed", message: "Nothing was filled (map the field steps to Excel columns, or the row's cells are empty) — record not saved." + tail(inline0) };
    }

    // GUARANTEED SAVE (iAMXLS): if the demo never pressed Save, do it now — unless
    // nothing was filled, in which case refuse (never persist a blank record). This
    // is why a taught flow that "did nothing" no longer reports a false success.
    if (!saved) {
      const inline0 = MaxLoad.errorWatcher.captureInlineMessages();
      if (filled === 0) {
        trace(`row ${rowNum} ✗ no fields filled — not saving`, { row: rowNum });
        return { status: "failed", message: "No fields were filled (map the field steps to Excel columns) — record not saved." + tail(inline0) };
      }
      const saveEl = findSaveControl();
      if (!saveEl) {
        trace(`row ${rowNum} ✗ Save control NOT FOUND`, { row: rowNum, filled });
        return { status: "failed", message: `Filled ${filled} field(s) but could not find the Save button — record left unsaved.` + tail(inline0) };
      }
      trace(`row ${rowNum} · guaranteed Save (demo had none)`, { row: rowNum, filled, saveEl: desc(saveEl) });
      reportStep(rowNum, steps.length, "save", "Save (auto)", "auto");
      MaxLoad.hl && MaxLoad.hl.flash(saveEl, "save");
      MaxLoad.hl && MaxLoad.hl.toast(`Row ${rowNum}: Save`, "save");
      await MaxLoad.input.click(saveEl);
      await MaxLoad.settle.waitForSettleOrModal({ quietMs: 400, timeoutMs: 12000 });
      const hs = await MaxLoad.errorWatcher.handle(rowNum, meta.screen);
      if (hs.outcome === "abort") return { status: "abort", message: hs.message };
      if (hs.outcome === "fail") { trace(`row ${rowNum} ✗ save rejected`, { row: rowNum, message: hs.message }); return { status: "failed", message: hs.message }; }
      saved = true;
    }

    // a red banner can carry the real reason even without a popup
    const inline = MaxLoad.errorWatcher.captureInlineMessages();
    const errBanner = inline.find((s) => /error|invalid|required|not valid|must be|bmxaa\d+e/i.test(s));
    if (errBanner) { trace(`row ${rowNum} ✗ error banner`, { row: rowNum, banner: errBanner }); return { status: "failed", message: errBanner }; }

    trace(`ROW ${rowNum} ✔ DONE`, { row: rowNum, filled, saved, warnings });
    MaxLoad.hl && MaxLoad.hl.toast(`Row ${rowNum}: ✔ ${saved ? "saved" : "done"}`, "field");
    return { status: "done", message: (saved ? "saved" : "completed") + (warnings.length ? " | " + warnings.join(" ; ") : "") + tail(inline) };
  }

  // ---- batch runner ----------------------------------------------------------
  /**
   * Run a whole batch against a workflow, with resume + logging.
   * opts: { rows (parsed objects), workflow, fileName, onProgress }
   * Sequence workflows replay the recorded steps; legacy binding workflows use
   * the New/fill/Save plan path.
   */
  async function runBatch(opts) {
    cancelFlag = false;
    running = true;
    const { workflow, fileName } = opts;
    const rows = opts.rows || [];
    const sequence = workflow.mode === "sequence";

    let plans = null;
    if (!sequence) {
      const built = MaxLoad.excel.buildPlans(rows);
      if (!built.ok) return { ok: false, errors: built.errors };
      plans = built.plans;
    }
    const total = sequence ? rows.length : plans.length;
    if (!total) return { ok: false, errors: ["No data rows found."] };

    const runId = MaxLoad.resume.makeRunId(workflow.id, fileName, total);
    const run = await MaxLoad.resume.begin(runId, { workflow: workflow.name, fileName, total });

    let start = MaxLoad.resume.nextIndex(run, total);
    report(opts, { phase: "start", runId, total, resumingFrom: start });

    for (let i = start; i < total; i++) {
      if (cancelFlag) {
        report(opts, { phase: "cancelled", index: i });
        break;
      }

      // for sequence workflows tied to one action, skip rows of the other action
      if (sequence && workflow.action && workflow.action !== "ANY" && rows[i]._action) {
        if (String(rows[i]._action).toUpperCase() !== workflow.action) {
          await MaxLoad.resume.setRow(runId, i, "skipped", "row _action != workflow action");
          report(opts, { phase: "row-done", index: i, status: "skipped", message: `_action ${rows[i]._action} ≠ ${workflow.action}`, ms: 0 });
          continue;
        }
      }

      await MaxLoad.resume.setRow(runId, i, "running");
      report(opts, { phase: "row-start", index: i, action: sequence ? (rows[i]._action || workflow.action) : plans[i].action });

      const t0 = MaxLoad.util.now();
      let result;
      try {
        result = sequence
          ? await runRowSeq(workflow, rows[i], i + 1)
          : await runRow(plans[i], workflow, i + 1);
      } catch (e) {
        result = { status: "failed", message: "exception: " + (e && e.message ? e.message : String(e)) };
      }
      const dt = MaxLoad.util.now() - t0;

      if (result.status === "abort") {
        await MaxLoad.resume.setRow(runId, i, "pending", result.message);
        await MaxLoad.resume.markAborted(runId, result.message);
        report(opts, { phase: "abort", index: i, message: result.message, ms: dt });
        running = false;
        await MaxLoad.input.detach();
        return { ok: false, aborted: true, runId, message: result.message, atRow: i };
      }

      const status =
        result.status === "done" ? "done" : result.status === "cancelled" ? "pending" : "failed";
      await MaxLoad.resume.setRow(runId, i, status, result.message || "");
      report(opts, { phase: "row-done", index: i, status, message: result.message || "", ms: dt, via: result.via });

      // A FAILED row can leave a dialog / half-record open, which would strand
      // EVERY later row (step 1 becomes unfindable forever). Try to get back to a
      // clean baseline before continuing, so one bad row doesn't kill the batch.
      if (status === "failed" && !cancelFlag) {
        await recoverBaseline(workflow, i + 1);
      }

      // brief settle between rows
      await sleep(150);
    }

    const summary = await MaxLoad.resume.summary(runId);
    running = false;
    await MaxLoad.input.detach();
    report(opts, { phase: "complete", runId, summary });
    return { ok: true, runId, summary };
  }

  /**
   * After a failed row, best-effort return to a clean baseline so the failure
   * doesn't cascade into every following row. We dismiss any known blocking popup,
   * press Escape to close stray menus / sub-dialogs, then handle the "save
   * changes?" prompt that discarding a half-built record may raise. Bounded and
   * side-effect-light: on a screen that's actually fine, this is a no-op.
   */
  async function recoverBaseline(workflow, rowNum) {
    const screen = workflow && workflow.screen;
    try { await MaxLoad.errorWatcher.handleIfPresent(rowNum, screen); } catch (_) {}
    try {
      await MaxLoad.input.pressKey("Escape");
      await sleep(120);
      await MaxLoad.input.pressKey("Escape");
    } catch (_) {}
    try { await MaxLoad.settle.waitForSettleOrModal({ quietMs: 300, timeoutMs: 2500 }); } catch (_) {}
    // discarding a dirty record may pop "save changes?" — answer it and move on
    try { await MaxLoad.errorWatcher.handleEntryPrompt(rowNum, screen); } catch (_) {}
    try { await MaxLoad.settle.waitForSettleOrModal({ quietMs: 250, timeoutMs: 2000 }); } catch (_) {}
  }

  function report(opts, ev) {
    try {
      opts.onProgress && opts.onProgress(ev);
    } catch (_) {}
    chrome.runtime?.sendMessage({ type: "ml:progress", ev });
  }

  function cancel() {
    cancelFlag = true;
  }

  // ---- dry run: resolve every step on the current screen without acting ------
  async function dryRunWorkflow(workflow) {
    const meta = { app: workflow.name, screen: workflow.screen };
    const results = [];

    if (workflow.mode === "sequence") {
      const steps = workflow.steps || [];
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        if (s.type === "click") {
          if (MaxLoad.matcher.isJunkClick({ ...(s.binding || {}), text: s.text })) {
            results.push({ step: `${i + 1}. click “${s.text || (s.binding && s.binding.stableKey)}” — grid noise (skipped)`, found: true, via: "skipped", score: 0, muted: true });
            continue;
          }
          const el = MaxLoad.binder.locateButton(s.binding) || (s.text && MaxLoad.dom.findButton(s.text));
          results.push({ step: `${i + 1}. click “${s.text || s.binding.stableKey}”`, found: !!el, via: "binding", score: el ? 100 : 0 });
        } else if (s.type === "set-field") {
          const mapped = s.column && !["__ignore__"].includes(s.column);
          const r = await resolveStepField(s, meta);
          const label = s.target && (s.target.label || s.target.stableKey);
          const to = s.column === "__ignore__" ? "(not filled)" : s.column === "__fixed__" ? `= "${s.sampleValue}"` : s.column === "__key__" ? "= _key_value" : "← col " + s.column;
          results.push({ step: `${i + 1}. field ${label} ${to}`, found: !!r.el, via: r.via || r.reason, score: r.score || r.bestScore || 0, muted: !mapped });
        } else if (s.type === "select") {
          const bound = s.column && !["__ignore__", "__fixed__"].includes(s.column);
          const to = bound ? "← col " + s.column : `= code "${s.code}"`;
          const nm = (s.target && s.target.label) || "status";
          // dry run must not open menus / act; just report the step + opener info
          const opener = s.opener && (s.opener.binding || s.opener.near || s.opener.title || s.opener.id) ? "opener ok" : "no opener";
          results.push({ step: `${i + 1}. status ${nm} ${to}`, found: true, via: "menu (" + opener + ")", score: 100, muted: !bound });
        }
      }
      return results;
    }

    // legacy binding/recorded path
    const columnMap = buildColumnMap(workflow);
    for (const [col, target] of Object.entries(columnMap)) {
      if (col === "__ignore__") continue;
      const r = await resolveField(target, meta);
      results.push({ step: col + " → " + (target.label || target.stableKey), found: !!r.el, via: r.via || r.reason, score: r.score || r.bestScore || 0 });
    }
    const b = workflow.bindings && workflow.bindings.buttons;
    if (b) {
      for (const role of ["new", "save"]) {
        if (b[role]) {
          const el = MaxLoad.binder.locateButton(b[role]);
          results.push({ step: role + " button", found: !!el, via: "binding", score: el ? 100 : 0 });
        }
      }
    }
    if (workflow.bindings && workflow.bindings.keyField) {
      const el = MaxLoad.binder.locate(workflow.bindings.keyField);
      results.push({ step: "key/search field", found: !!el, via: "binding", score: el ? 100 : 0 });
    }
    return results;
  }

  MaxLoad.exec = {
    runBatch,
    runRow,
    runRowSeq,
    dryRunWorkflow,
    resolveField,
    setField,
    clickByText,
    locateRecord,
    setNativeValue,
    fireInputEvents,
    cancel,
    isRunning: () => running
  };
})();
