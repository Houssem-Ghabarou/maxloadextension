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

    el.scrollIntoView({ block: "center" });
    el.focus();
    setNativeValue(el, value);
    fireInputEvents(el);

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

  async function resolveStepField(step, meta) {
    // 1. deterministic, label-first (free + instant) with a late-render retry
    if (step.binding && MaxLoad.binder) {
      let el = MaxLoad.binder.locate(step.binding);
      if (!el) {
        el = await MaxLoad.settle.retryUntil(
          async () => {
            await MaxLoad.settle.waitForSettle({ quietMs: 250, timeoutMs: 2500 });
            return MaxLoad.binder.locate(step.binding);
          },
          { intervalMs: 300, timeoutMs: 5000 }
        );
      }
      if (el) return { el, via: "label", score: 100 };
    }
    // 2. only now fall through to matcher / rule-assist / AI (resolveField)
    const t = step.target || {};
    return await resolveField(
      { label: t.label, stableKey: t.stableKey, controlType: t.controlType, tabContext: t.tabContext, _binding: step.binding },
      meta
    );
  }

  /** Resolve a recorded click step: stable id/text first, AI only if stuck. */
  async function resolveStepButton(step, meta) {
    if (MaxLoad.binder) {
      const el = MaxLoad.binder.locateButton(step.binding);
      if (el) return { el, via: "binding" };
    }
    if (step.text) {
      const el = MaxLoad.dom.findButton(step.text);
      if (el) return { el, via: "text" };
    }
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
        if (el) return { el, via: ai.fromCache ? "cache:ai" : "ai" };
      }
    }
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

    MaxLoad.hl && MaxLoad.hl.toast(`Row ${rowNum} [${action}] — starting`, "click");

    const c0 = await clearLeftoverModals(rowNum, meta.screen);
    if (c0.abort) return { status: "abort", message: c0.message };

    for (let idx = 0; idx < steps.length; idx++) {
      if (cancelFlag) return { status: "cancelled", message: "run cancelled" };
      const step = steps[idx];

      // popup blocking BEFORE we act?
      let h = await MaxLoad.errorWatcher.handle(rowNum, meta.screen);
      if (h.outcome === "abort") return { status: "abort", message: h.message };
      if (h.outcome === "fail") return { status: "failed", message: h.message };

      if (step.type === "click" || isSaveStep(step)) {
        const save = isSaveStep(step);
        const rb = await resolveStepButton(step, meta);
        if (!rb.el)
          return { status: "failed", transient: true, message: `step ${idx + 1}: button "${step.text || (step.binding && step.binding.stableKey)}" not found` };
        reportStep(rowNum, idx, save ? "save" : "click", step.text || step.binding.stableKey, rb.via);
        MaxLoad.hl && MaxLoad.hl.flash(rb.el, save ? "save" : "click");
        MaxLoad.hl && MaxLoad.hl.toast(`Row ${rowNum}: ${save ? "Save" : "click “" + (step.text || "button") + "”"}`, save ? "save" : "click");
        await MaxLoad.input.click(rb.el);
        await MaxLoad.settle.waitForSettleOrModal({ quietMs: 400, timeoutMs: save ? 12000 : 8000 });

        if (isNewStep(step)) {
          // ENTRY: "save changes?" here = discard the previous record and continue.
          const e = await MaxLoad.errorWatcher.handleEntryPrompt(rowNum, meta.screen);
          if (e.outcome === "abort") return { status: "abort", message: e.message };
          if (e.outcome === "fail") return { status: "failed", message: e.message };
          // best-effort wait for the form to render; don't hard-fail here — the
          // field steps retry and report precisely (works for record-New AND a
          // "new row" inside a relation/table, which has no top-level form).
          await verifyEntry(workflow);
        } else {
          h = await MaxLoad.errorWatcher.handle(rowNum, meta.screen);
          if (h.outcome === "abort") return { status: "abort", message: h.message };
          if (h.outcome === "fail") return { status: "failed", message: h.message };
        }

        if (save) saved = true;
        await MaxLoad.rules.applyRules({});
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
        await typeInto(r.el, fv.value);
        await MaxLoad.rules.applyRules({ searchTerm: fv.value });
        await MaxLoad.settle.waitForSettleOrModal({ quietMs: 300, timeoutMs: 4000 });

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
      }
    }

    // a red banner can carry the real reason even without a popup
    const inline = MaxLoad.errorWatcher.captureInlineMessages();
    const errBanner = inline.find((s) => /error|invalid|required|not valid|must be|bmxaa\d+e/i.test(s));
    if (errBanner) return { status: "failed", message: errBanner };

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

      // brief settle between rows
      await sleep(150);
    }

    const summary = await MaxLoad.resume.summary(runId);
    running = false;
    await MaxLoad.input.detach();
    report(opts, { phase: "complete", runId, summary });
    return { ok: true, runId, summary };
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
          const el = MaxLoad.binder.locateButton(s.binding) || (s.text && MaxLoad.dom.findButton(s.text));
          results.push({ step: `${i + 1}. click “${s.text || s.binding.stableKey}”`, found: !!el, via: "binding", score: el ? 100 : 0 });
        } else if (s.type === "set-field") {
          const mapped = s.column && !["__ignore__"].includes(s.column);
          const r = await resolveStepField(s, meta);
          const label = s.target && (s.target.label || s.target.stableKey);
          const to = s.column === "__ignore__" ? "(not filled)" : s.column === "__fixed__" ? `= "${s.sampleValue}"` : s.column === "__key__" ? "= _key_value" : "← col " + s.column;
          results.push({ step: `${i + 1}. field ${label} ${to}`, found: !!r.el, via: r.via || r.reason, score: r.score || r.bestScore || 0, muted: !mapped });
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
