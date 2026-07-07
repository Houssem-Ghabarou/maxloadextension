/* MaxLoad — panel UI logic (runs as an extension page inside an injected iframe).
 * Talks to the content scripts in the host tab via chrome.tabs.sendMessage, and
 * to the service worker via chrome.runtime.sendMessage. Reads/writes workflows
 * directly from chrome.storage.local.
 */
(function () {
  "use strict";

  const WF_KEY = "ml:workflows";
  let hostTabId = null;
  let parsedRows = null;
  let currentBatch = { total: 0, done: 0, failed: 0 };
  let runResults = {}; // rowIndex -> { status, message }

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };

  // ---- host tab + messaging -------------------------------------------------
  async function resolveHostTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    hostTabId = tabs[0] ? tabs[0].id : null;
    return hostTabId;
  }

  async function sendCmd(msg) {
    if (hostTabId == null) await resolveHostTab();
    try {
      return await chrome.tabs.sendMessage(hostTabId, msg);
    } catch (e) {
      return { ok: false, error: "content-script not reachable: " + String(e && e.message ? e.message : e) };
    }
  }

  async function ping() {
    const r = await sendCmd({ type: "ml:cmd:ping" });
    const conn = $("#conn");
    if (r && r.ok) {
      conn.textContent = r.tenant || "connected";
      conn.className = "chip ok";
    } else {
      conn.textContent = "not on Maximo?";
      conn.className = "chip";
    }
  }

  // ---- tabs -----------------------------------------------------------------
  $$("nav button").forEach((b) =>
    b.addEventListener("click", () => {
      $$("nav button").forEach((x) => x.classList.toggle("active", x === b));
      const id = b.dataset.tab;
      $$(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + id));
      if (id === "workflows") renderWorkflows();
      if (id === "logs") loadLogs();
      if (id === "settings") loadSettings();
      if (id === "run") { renderWorkflowOptions(); refreshState(); renderScenario(); }
      if (id === "bind") renderBind();
    })
  );

  $("#closeBtn").addEventListener("click", () => sendCmd({ type: "ml:cmd:toggle-panel" }));

  // ---- drag the whole panel by its header -----------------------------------
  (function setupDrag() {
    const header = document.querySelector("header");
    if (!header) return;
    header.style.cursor = "move";
    header.title = "Drag to move • double-click to reset position";
    let dragging = false, lastX = 0, lastY = 0;
    header.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return; // let the close button work
      dragging = true;
      lastX = e.screenX;
      lastY = e.screenY;
      try { header.setPointerCapture(e.pointerId); } catch (_) {}
      window.parent.postMessage({ source: "maxload-panel", type: "drag-start" }, "*");
      e.preventDefault();
    });
    header.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.screenX - lastX;
      const dy = e.screenY - lastY;
      lastX = e.screenX;
      lastY = e.screenY;
      if (dx || dy) window.parent.postMessage({ source: "maxload-panel", type: "drag-move", dx, dy }, "*");
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      try { header.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    header.addEventListener("pointerup", end);
    header.addEventListener("pointercancel", end);
    header.addEventListener("dblclick", (e) => {
      if (e.target.closest("button")) return;
      window.parent.postMessage({ source: "maxload-panel", type: "reset-pos" }, "*");
    });
  })();

  // ---- TEACH (record + auto-bind) -------------------------------------------
  let teachColumns = [];

  $("#recFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const rows = await readFile(file);
      parsedRows = rows;
      teachColumns = Object.keys(rows[0] || {}).filter((c) => !["_action", "_key_value"].includes(c));
      $("#recCols").innerHTML = `Loaded <b>${rows.length}</b> rows. Columns: <code>${teachColumns.join(", ")}</code>`;
    } catch (err) {
      $("#recCols").innerHTML = `<span style="color:#d64545">Parse error: ${escapeHtml(err.message)}</span>`;
    }
  });

  $("#recStart").addEventListener("click", async () => {
    const action = $("#recAction").value;
    const r = await sendCmd({ type: "ml:cmd:start-recording", action, columns: teachColumns });
    if (r && r.ok) {
      $("#recStart").disabled = true;
      $("#recStop").disabled = false;
      const s = $("#recState");
      s.textContent = "teaching " + action;
      s.className = "chip rec";
    } else {
      alert("Could not start — is the MaxLoad content script on this page? " + (r && r.error || ""));
    }
  });

  $("#recStop").addEventListener("click", async () => {
    const r = await sendCmd({ type: "ml:cmd:stop-recording" });
    $("#recStart").disabled = false;
    $("#recStop").disabled = true;
    $("#recState").textContent = "idle";
    $("#recState").className = "chip";
    if (r && r.ok && r.workflow) {
      const wf = r.workflow;
      const nMapped = (wf.columns || []).length;
      const name = prompt(`Name this workflow (${wf.steps.length} steps, ${nMapped} mapped fields):`, wf.name) || wf.name;
      wf.name = name;
      await saveWorkflow(wf);
      alert(`Saved "${name}" — ${wf.steps.length} steps, ${nMapped} fields mapped to columns.`);
      renderWorkflowOptions();
    }
  });

  function colMenu(step) {
    const sel = document.createElement("select");
    sel.style.maxWidth = "160px";
    const add = (label, value) => {
      const o = el("option", null, label);
      o.value = value;
      sel.appendChild(o);
    };
    add("— don't fill —", "__ignore__");
    (teachColumns || [])
      .filter((c) => !["_action", "_key_field", "_key_value"].includes(c))
      .forEach((c) => add(c, c));
    add("★ search/key value (_key_value)", "__key__");
    add(`＝ fixed: "${(step.sampleValue || "").slice(0, 14)}"`, "__fixed__");
    sel.value = step.column || "__ignore__";
    sel.addEventListener("change", () =>
      sendCmd({ type: "ml:cmd:set-step-column", stepId: step.id, column: sel.value })
    );
    return sel;
  }

  function opMenu(step) {
    const sel = document.createElement("select");
    sel.style.maxWidth = "130px";
    const add = (label, value) => {
      const o = el("option", null, label);
      o.value = value;
      sel.appendChild(o);
    };
    add("(no operator)", "none");
    add("=  equals", "=");
    add(">  greater", ">");
    add("<  less", "<");
    add("≥  >=", ">=");
    add("≤  <=", "<=");
    add("≠  not", "!=");
    add("contains  %v%", "contains");
    add("starts  v%", "starts");
    add("ends  %v", "ends");
    sel.value = step.operator || "none";
    sel.addEventListener("change", () =>
      sendCmd({ type: "ml:cmd:set-step-operator", stepId: step.id, operator: sel.value })
    );
    return sel;
  }

  function stepControls(step) {
    const wrap = el("div", "row");
    wrap.style.gap = "4px";
    const up = el("button", "btn", "▲");
    const down = el("button", "btn", "▼");
    const del = el("button", "btn danger", "✕");
    [up, down, del].forEach((b) => (b.style.padding = "2px 7px"));
    up.title = "move up"; down.title = "move down"; del.title = "delete step";
    up.addEventListener("click", () => sendCmd({ type: "ml:cmd:move-step", stepId: step.id, dir: "up" }));
    down.addEventListener("click", () => sendCmd({ type: "ml:cmd:move-step", stepId: step.id, dir: "down" }));
    del.addEventListener("click", () => sendCmd({ type: "ml:cmd:remove-step", stepId: step.id }));
    wrap.append(up, down, del);
    return wrap;
  }

  function renderRecSteps(steps, columns) {
    if (columns) teachColumns = columns;
    const ul = $("#recSteps");
    ul.innerHTML = "";
    if (!steps || !steps.length) {
      ul.appendChild(el("li", "hint", "Nothing recorded yet — press Start, then act on the Maximo screen."));
      return;
    }
    steps.forEach((s, i) => {
      const li = el("li", "card");
      const head = el("div", "row");
      const info = el("div");
      info.style.flex = "1";

      if (s.type === "click") {
        const role = (s.binding && s.binding.role) || "";
        const kind = /save/.test(role) ? "💾" : /new/.test(role) ? "➕" : "👆";
        info.appendChild(el("strong", null, `${i + 1}. ${kind} click “${s.text || (s.binding && s.binding.stableKey) || "element"}”`));
        info.appendChild(el("div", "meta", `key: ${(s.binding && (s.binding.stableKey || s.binding.id)) || "—"}`));
        head.append(info, stepControls(s));
        li.appendChild(head);
      } else if (s.type === "key") {
        const where = s.target && (s.target.label || s.target.stableKey);
        info.appendChild(el("strong", null, `${i + 1}. ⌨ press ${s.key}${where ? " in " + where : ""}`));
        head.append(info, stepControls(s));
        li.appendChild(head);
      } else if (s.type === "select") {
        info.appendChild(el("strong", null, `${i + 1}. 🔽 status = “${s.sampleLabel || s.code}”`));
        info.appendChild(el("div", "meta", `code: ${s.code}${s.opener && s.opener.near ? " · via " + s.opener.near : ""}`));
        head.append(info, stepControls(s));
        li.appendChild(head);
        const row2 = el("div", "row");
        row2.style.marginTop = "5px";
        row2.style.flexWrap = "wrap";
        row2.appendChild(el("span", "muted", "set from:"));
        row2.appendChild(colMenu(s));
        li.appendChild(row2);
      } else {
        info.appendChild(el("strong", null, `${i + 1}. ✎ ${(s.target && s.target.label) || (s.binding && s.binding.stableKey) || "field"}`));
        info.appendChild(el("div", "meta", `[${s.target && s.target.controlType}] key: ${(s.binding && (s.binding.stableKey || s.binding.id)) || "—"}`));
        head.append(info, stepControls(s));
        li.appendChild(head);
        const row2 = el("div", "row");
        row2.style.marginTop = "5px";
        row2.style.flexWrap = "wrap";
        row2.appendChild(el("span", "muted", "fill with:"));
        row2.appendChild(colMenu(s));
        row2.appendChild(el("span", "muted", "op:"));
        row2.appendChild(opMenu(s));
        li.appendChild(row2);
      }
      ul.appendChild(li);
    });
  }

  // ---- WORKFLOWS storage ----------------------------------------------------
  async function getWorkflows() {
    const o = await chrome.storage.local.get(WF_KEY);
    return o[WF_KEY] || [];
  }
  async function saveWorkflow(wf) {
    const list = await getWorkflows();
    const idx = list.findIndex((w) => w.id === wf.id);
    if (idx >= 0) list[idx] = wf;
    else list.push(wf);
    await chrome.storage.local.set({ [WF_KEY]: list });
  }
  async function deleteWorkflow(id) {
    const list = (await getWorkflows()).filter((w) => w.id !== id);
    await chrome.storage.local.set({ [WF_KEY]: list });
  }

  async function renderWorkflows() {
    const list = await getWorkflows();
    const box = $("#wfList");
    box.innerHTML = "";
    if (!list.length) {
      box.appendChild(el("p", "muted", "No workflows yet — record one from the Record tab."));
      return;
    }
    for (const wf of list) {
      const card = el("div", "card");
      card.appendChild(el("h3", null, wf.name));
      card.appendChild(
        el("div", "meta", `${wf.action} · ${wf.steps.length} steps · cols: ${(wf.columns || []).join(", ") || "—"} · ${wf.tenant || ""}`)
      );
      const row = el("div", "row");
      row.style.marginTop = "6px";
      const edit = el("button", "btn", "Edit JSON");
      edit.addEventListener("click", () => openEditor(wf.id));
      const exp = el("button", "btn", "Export");
      exp.addEventListener("click", () => download(wf.name + ".json", JSON.stringify(wf, null, 2)));
      const del = el("button", "btn danger", "Delete");
      del.addEventListener("click", async () => {
        if (confirm(`Delete "${wf.name}"?`)) {
          await deleteWorkflow(wf.id);
          renderWorkflows();
          renderWorkflowOptions();
        }
      });
      row.append(edit, exp, del);
      card.appendChild(row);
      box.appendChild(card);
    }
  }

  function openEditor(id) {
    const url = chrome.runtime.getURL("ui/workflow-editor.html") + "?id=" + encodeURIComponent(id);
    chrome.tabs.create({ url });
  }

  async function renderWorkflowOptions() {
    const list = await getWorkflows();
    const sel = $("#runWorkflow");
    const prev = sel.value;
    sel.innerHTML = "";
    list.forEach((wf) => {
      const o = el("option", null, `${wf.name} (${wf.action})`);
      o.value = wf.id;
      sel.appendChild(o);
    });
    if (prev) sel.value = prev;
    updateRunEnabled();
  }

  // ---- RUN: file parsing ----------------------------------------------------
  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some((v) => v !== "")) rows.push(row);
        row = [];
      } else field += c;
    }
    if (field !== "" || row.length) { row.push(field); if (row.some((v) => v !== "")) rows.push(row); }
    if (!rows.length) return [];
    const headers = rows[0].map((h) => h.trim());
    return rows.slice(1).map((r) => {
      const o = {};
      headers.forEach((h, i) => (o[h] = (r[i] ?? "").trim()));
      return o;
    });
  }

  async function readFile(file) {
    const isCsv = /\.csv$/i.test(file.name);
    if (isCsv) {
      return parseCSV(await file.text());
    }
    // .xlsx / .xls — must use SheetJS. Never parse a binary workbook as text
    // (that produces the "PK…_rels/.rels" ZIP garbage).
    if (typeof XLSX === "undefined") {
      throw new Error(
        "This is an Excel workbook but SheetJS isn't loaded. Reload the extension, " +
          "or save the sheet as .csv. (Expected lib/xlsx.full.min.js.)"
      );
    }
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });
    // normalize: trim header keys and string values
    return rows.map((r) => {
      const o = {};
      for (const [k, v] of Object.entries(r)) o[String(k).trim()] = typeof v === "string" ? v.trim() : v;
      return o;
    });
  }

  $("#runFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      parsedRows = await readFile(file);
      renderPreview(parsedRows);
    } catch (err) {
      $("#preview").innerHTML = `<p class="hint" style="color:#d64545">Parse error: ${err.message}</p>`;
      parsedRows = null;
    }
    updateRunEnabled();
  });

  function renderPreview(rows) {
    const box = $("#preview");
    box.innerHTML = "";
    if (!rows || !rows.length) {
      box.appendChild(el("p", "hint", "No rows found."));
      return;
    }
    const creates = rows.filter((r) => String(r._action).toUpperCase() === "CREATE").length;
    const updates = rows.filter((r) => String(r._action).toUpperCase() === "UPDATE").length;
    box.appendChild(el("p", "hint", `${rows.length} rows — ${creates} CREATE, ${updates} UPDATE. Columns: ${Object.keys(rows[0]).join(", ")}`));
  }

  function updateRunEnabled() {
    const ok = !!parsedRows && !!$("#runWorkflow").value;
    $("#runStart").disabled = !ok;
    $("#runOne").disabled = !ok;
  }
  $("#runWorkflow").addEventListener("change", () => {
    updateRunEnabled();
    renderScenario();
  });

  // ---- situational awareness: "where am I?" ---------------------------------
  async function refreshState() {
    const r = await sendCmd({ type: "ml:cmd:state" });
    const line = $("#stateLine");
    if (!r || !r.ok) {
      line.textContent = "📍 can't read page (is MaxLoad injected here?)";
      line.className = "chip";
      return;
    }
    const s = r.state;
    const rec = s.recordId ? ` · record ${s.recordId}` : "";
    line.textContent = `📍 ${s.app || s.host} · ${s.view} view${rec} · ${s.fieldCount} fields, ${s.frames} frame(s)`;
    line.className = "chip " + (s.fieldCount > 0 ? "ok" : "");
  }
  $("#stateRefresh").addEventListener("click", refreshState);

  // ---- human scenario description -------------------------------------------
  function describeWorkflow(wf) {
    if (!wf || !wf.steps) return [];
    const lines = [];
    wf.steps.forEach((s) => {
      if (s.type === "click") {
        const role = (s.binding && s.binding.role) || "";
        if (/save/.test(role)) lines.push("Save the record & confirm it committed");
        else if (/new/.test(role)) lines.push(`Click “${s.text}” (start a new record)`);
        else lines.push(`Click “${s.text}”`);
      } else if (s.type === "key") {
        lines.push(`Press ${s.key}`);
      } else if (s.type === "set-field") {
        const nm = (s.target && s.target.label) || (s.binding && s.binding.stableKey) || "field";
        const op = s.operator ? ` (operator ${s.operator})` : "";
        const src = s.column === "__key__" ? "_key_value" : `column “${s.column}”`;
        if (s.column === "__ignore__" || !s.column) lines.push(`↷ ${nm} — not filled`);
        else if (s.column === "__fixed__") lines.push(`Fill ${nm} with fixed “${s.sampleValue}”${op}`);
        else lines.push(`Fill ${nm} with ${src}${op}`);
      } else if (s.type === "select") {
        const nm = (s.target && s.target.label) || "status";
        if (!s.column || s.column === "__ignore__" || s.column === "__fixed__")
          lines.push(`Set ${nm} to fixed “${s.code}” (open the dropdown & pick by code)`);
        else if (s.column === "__key__") lines.push(`Set ${nm} from _key_value`);
        else lines.push(`Set ${nm} from column “${s.column}” (open the dropdown & pick by code)`);
      }
    });
    return lines;
  }

  async function renderScenario() {
    const wf = await currentWorkflow();
    const box = $("#scenario");
    if (!wf) { box.style.display = "none"; return; }
    const lines = describeWorkflow(wf);
    box.style.display = "block";
    box.innerHTML =
      `<h3 style="margin:0 0 4px">Scenario · ${escapeHtml(wf.name)} (${wf.action})</h3>` +
      `<div class="meta" style="margin-bottom:6px">For each row, MaxLoad will:</div>` +
      "<ol style='margin:0;padding-left:18px'>" +
      lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("") +
      "</ol>";
  }

  // ---- RUN: dry-run + batch -------------------------------------------------
  $("#dryRun").addEventListener("click", async () => {
    const wf = await currentWorkflow();
    if (!wf) return alert("Pick a workflow first.");
    feed("Dry-run: resolving fields on the current screen…");
    const r = await sendCmd({ type: "ml:cmd:dry-run", workflow: wf });
    if (!r || !r.ok) return feed("Dry-run failed: " + (r && r.error), "error");
    r.results.forEach((res) =>
      feed(`${res.found ? "✓" : "✗"} ${res.step} — ${res.via} (score ${res.score})`, res.found ? "" : "warn")
    );
  });

  $("#runStart").addEventListener("click", async () => {
    const wf = await currentWorkflow();
    if (!wf || !parsedRows) return;
    currentBatch = { total: parsedRows.length, done: 0, failed: 0 };
    runResults = {};
    $("#resultRow").style.display = "none";
    $("#runFeed").innerHTML = "";
    $("#progBar").style.width = "0%";
    $("#runCancel").disabled = false;
    $("#runStart").disabled = true;
    $("#runOne").disabled = true;
    const fileName = ($("#runFile").files[0] || {}).name || "rows";
    feed(`Starting batch: ${parsedRows.length} rows against "${wf.name}"…`);
    const r = await sendCmd({ type: "ml:cmd:run-batch", rows: parsedRows, workflow: wf, fileName });
    if (!r || !r.ok) {
      feed("Could not start: " + (r && r.error), "error");
      $("#runStart").disabled = false;
      $("#runCancel").disabled = true;
    }
  });

  $("#runOne").addEventListener("click", async () => {
    const wf = await currentWorkflow();
    if (!wf || !parsedRows || !parsedRows.length) return;
    currentBatch = { total: 1, done: 0, failed: 0 };
    runResults = {};
    $("#resultRow").style.display = "none";
    $("#runFeed").innerHTML = "";
    $("#progBar").style.width = "0%";
    $("#runCancel").disabled = false;
    $("#runStart").disabled = true;
    $("#runOne").disabled = true;
    feed(`Watch mode: running row 1 of "${wf.name}" — watch the page for the moving highlight.`);
    const fileName = ($("#runFile").files[0] || {}).name || "rows";
    const r = await sendCmd({ type: "ml:cmd:run-batch", rows: [parsedRows[0]], workflow: wf, fileName: fileName + "#1" });
    if (!r || !r.ok) feed("Could not start: " + (r && r.error), "error");
  });

  $("#runCancel").addEventListener("click", () => sendCmd({ type: "ml:cmd:cancel" }));

  $("#teachModal").addEventListener("click", async () => {
    const info = await sendCmd({ type: "ml:cmd:current-modal" });
    if (!info || !info.ok || !info.modal) {
      alert("No modal detected on screen. Trigger the popup in Maximo first, leave it open, then click this.");
      return;
    }
    const m = info.modal;
    const btns = m.buttons.length ? m.buttons.join(", ") : "(none found)";
    const button = prompt(
      `Modal detected:\n\n"${m.text.slice(0, 240)}"\n\nButtons: ${btns}\n\nWhich button should MaxLoad press? (type it exactly)`,
      m.buttons[0] || "OK"
    );
    if (!button) return;
    const outcome = (
      prompt("After pressing it, is this row FAILED or is it FINE to continue?\nType: fail  /  continue  /  abort", "fail") || ""
    ).toLowerCase().trim();
    if (!["fail", "continue", "abort"].includes(outcome)) return alert("Cancelled — outcome must be fail, continue, or abort.");
    const scope = (
      prompt(
        "Apply this rule to:\n\n• message  — only this exact popup text\n• buttons  — EVERY popup that has the same buttons (e.g. all error dialogs with just OK)\n\nType: message  /  buttons",
        "buttons"
      ) || "buttons"
    ).toLowerCase().trim();
    const r = await sendCmd({ type: "ml:cmd:teach-modal", button, outcome, scope: scope === "message" ? "message" : "buttons" });
    if (r && r.ok) {
      alert(
        `Learned!${r.applied ? ` Pressed "${button}" now.` : ""}\n\nWhenever this modal appears, MaxLoad will press "${button}" and mark the row "${outcome}". Manage saved rules in Settings.`
      );
      loadModalRules();
    } else {
      alert("Could not save: " + (r && r.error));
    }
  });

  async function currentWorkflow() {
    const id = $("#runWorkflow").value;
    return (await getWorkflows()).find((w) => w.id === id) || null;
  }

  function feed(text, level) {
    const line = el("li", "l " + (level || ""));
    line.innerHTML = `<span class="t">${new Date().toLocaleTimeString()}</span>  ${text}`;
    $("#runFeed").appendChild(line);
    $("#runFeed").scrollTop = $("#runFeed").scrollHeight;
  }

  // ---- results export -------------------------------------------------------
  function csvEscape(v) {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function rowsToCsv(rows, headers) {
    const head = headers.map(csvEscape).join(",");
    const body = rows.map((r) => headers.map((h) => csvEscape(r[h])).join(",")).join("\n");
    return head + "\n" + body;
  }
  function showResults() {
    if (parsedRows && parsedRows.length) $("#resultRow").style.display = "flex";
  }
  function buildResultRows(failedOnly) {
    if (!parsedRows) return { rows: [], headers: [] };
    const baseHeaders = Object.keys(parsedRows[0] || {});
    const headers = failedOnly ? [...baseHeaders, "_error"] : [...baseHeaders, "_status", "_message"];
    const rows = [];
    parsedRows.forEach((row, i) => {
      const res = runResults[i];
      const status = res ? res.status : "not-run";
      if (failedOnly && status !== "failed" && status !== "aborted") return;
      const out = { ...row };
      if (failedOnly) out._error = res ? res.message : "";
      else {
        out._status = status;
        out._message = res ? res.message : "";
      }
      rows.push(out);
    });
    return { rows, headers };
  }
  $("#dlResults").addEventListener("click", () => {
    const { rows, headers } = buildResultRows(false);
    if (!rows.length) return alert("No results yet.");
    download("maxload-results.csv", rowsToCsv(rows, headers));
  });
  $("#dlFailed").addEventListener("click", () => {
    const { rows, headers } = buildResultRows(true);
    if (!rows.length) return alert("No failed rows 🎉");
    download("maxload-failed-rows.csv", rowsToCsv(rows, headers));
  });

  function onProgress(ev) {
    if (ev.phase === "start") {
      feed(`Run ${ev.runId.slice(0, 24)}… resuming from row ${ev.resumingFrom + 1} of ${ev.total}.`);
    } else if (ev.phase === "row-start") {
      feed(`Row ${ev.index + 1} [${ev.action}] …`);
    } else if (ev.phase === "step") {
      if (ev.kind === "skip") {
        feed(`&nbsp;&nbsp;⏭ skipped ${escapeHtml(ev.name)}`, "warn");
      } else {
        const viaIcon = ev.via === "ai" || ev.via === "cache:ai" ? "🤖 AI" : ev.via === "label" || ev.via === "binding" ? "✓ direct" : "≈ " + ev.via;
        feed(`&nbsp;&nbsp;• ${ev.kind} “${escapeHtml(ev.name)}” — ${viaIcon}`, ev.via === "ai" ? "warn" : "");
      }
    } else if (ev.phase === "modal") {
      feed(`&nbsp;&nbsp;⚠ modal [${escapeHtml(ev.classification)}] → press “${escapeHtml(ev.button || "?")}” — ${escapeHtml((ev.text || "").slice(0, 120))}`, ev.action === "abort-run" ? "error" : "warn");
    } else if (ev.phase === "row-done") {
      runResults[ev.index] = { status: ev.status, message: ev.message || "" };
      if (ev.status === "done") currentBatch.done++;
      else if (ev.status === "failed") currentBatch.failed++;
      else if (ev.status === "skipped") currentBatch.skipped = (currentBatch.skipped || 0) + 1;
      const done = currentBatch.done + currentBatch.failed + (currentBatch.skipped || 0);
      const pct = Math.round((done / currentBatch.total) * 100);
      $("#progBar").style.width = pct + "%";
      $("#progText").textContent = `${done}/${currentBatch.total} · ${currentBatch.done} ok · ${currentBatch.failed} failed${currentBatch.skipped ? " · " + currentBatch.skipped + " skipped" : ""}`;
      feed(`Row ${ev.index + 1}: ${ev.status.toUpperCase()} — ${ev.message || ""} (${ev.ms}ms)`, ev.status === "failed" ? "warn" : "");
    } else if (ev.phase === "abort") {
      runResults[ev.index] = { status: "aborted", message: ev.message || "" };
      feed(`RUN ABORTED at row ${ev.index + 1}: ${ev.message}`, "error");
      showResults();
      $("#runCancel").disabled = true;
      updateRunEnabled();
    } else if (ev.phase === "complete") {
      const c = ev.summary.counts;
      feed(`Complete — ${c.done || 0} done, ${c.failed || 0} failed, ${c.skipped || 0} skipped.`, "");
      $("#runCancel").disabled = true;
      updateRunEnabled();
      refreshState();
      showResults();
    } else if (ev.phase === "cancelled") {
      feed("Run cancelled by user.", "warn");
      $("#runCancel").disabled = true;
      updateRunEnabled();
      showResults();
    }
  }

  // ---- LOGS -----------------------------------------------------------------
  async function loadLogs() {
    const r = await chrome.runtime.sendMessage({ type: "ml:store:get-logs" });
    const view = $("#logView");
    view.innerHTML = "";
    const logs = (r && r.logs) || [];
    logs.slice(-500).forEach((e) => {
      const line = el("div", "l " + (e.level || ""));
      const data = e.data ? "  " + JSON.stringify(e.data) : "";
      line.innerHTML = `<span class="t">${(e.ts || "").replace("T", " ").slice(0, 19)}</span> [${e.level}] ${escapeHtml(e.msg || "")}${escapeHtml(data)}`;
      view.appendChild(line);
    });
    view.scrollTop = view.scrollHeight;
  }
  $("#logRefresh").addEventListener("click", loadLogs);
  $("#logClear").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "ml:store:clear-logs" });
    loadLogs();
  });
  $("#logExport").addEventListener("click", async () => {
    const r = await chrome.runtime.sendMessage({ type: "ml:store:get-logs" });
    download("maxload-logs.json", JSON.stringify((r && r.logs) || [], null, 2));
  });

  // ---- SETTINGS -------------------------------------------------------------
  const PROVIDERS = {
    xai: { model: "grok-4.3", hint: "e.g. grok-4.3", keyHint: "xai-…" },
    groq: { model: "llama-3.3-70b-versatile", hint: "e.g. llama-3.3-70b-versatile, openai/gpt-oss-120b", keyHint: "gsk_…" },
    custom: { model: "", hint: "your model id", keyHint: "sk-…" }
  };

  function applyProviderUi(provider, model) {
    const p = PROVIDERS[provider] || PROVIDERS.xai;
    $("#modelHint").textContent = p.hint;
    $("#setKey").placeholder = p.keyHint;
    $("#endpointWrap").style.display = provider === "custom" ? "block" : "none";
    if (!$("#setModel").value) $("#setModel").placeholder = p.model ? "(default: " + p.model + ")" : "(provider default)";
  }

  $("#setProvider").addEventListener("change", () => {
    const provider = $("#setProvider").value;
    // when switching, offer the provider's default model as a hint (don't clobber a custom one)
    $("#setModel").value = "";
    applyProviderUi(provider, "");
  });

  async function loadSettings() {
    const r = await chrome.runtime.sendMessage({ type: "ml:store:get-settings" });
    const s = (r && r.settings) || {};
    const provider = s.provider || "xai";
    $("#setProvider").value = provider;
    $("#setKey").value = s.apiKey || s.xaiApiKey || "";
    $("#setModel").value = s.model || "";
    $("#setEndpoint").value = s.endpoint || "";
    $("#setAiEnabled").checked = s.aiEnabled !== false;
    applyProviderUi(provider, s.model);
    const stat = await sendCmd({ type: "ml:cmd:cache-stats" });
    const tbody = $("#cacheStat").querySelector("tbody");
    tbody.innerHTML = "";
    const st = (stat && stat.stats) || { total: 0, ai: 0, deterministic: 0 };
    [["Cached fields", st.total], ["Resolved by AI", st.ai], ["Deterministic", st.deterministic]].forEach(([k, v]) => {
      const tr = el("tr");
      tr.append(el("td", null, k), el("td", null, String(v)));
      tbody.appendChild(tr);
    });
    loadModalRules();
  }
  $("#setSave").addEventListener("click", async () => {
    const settings = {
      provider: $("#setProvider").value,
      apiKey: $("#setKey").value.trim(),
      model: $("#setModel").value.trim(), // empty => provider default in the SW
      endpoint: $("#setEndpoint").value.trim(),
      aiEnabled: $("#setAiEnabled").checked
    };
    await chrome.runtime.sendMessage({ type: "ml:store:save-settings", settings });
    const s = $("#setStatus");
    s.textContent = "saved";
    s.className = "chip ok";
    setTimeout(() => (s.textContent = ""), 2000);
  });
  $("#cacheClear").addEventListener("click", async () => {
    if (confirm("Clear the entire knowledge base cache?")) {
      await sendCmd({ type: "ml:cmd:clear-cache" });
      loadSettings();
    }
  });

  // ---- learned modal rules manager ------------------------------------------
  const MODAL_RULES_KEY = "ml:modalRules";
  async function loadModalRules() {
    const box = $("#modalRules");
    if (!box) return;
    const o = await chrome.storage.local.get(MODAL_RULES_KEY);
    const rules = o[MODAL_RULES_KEY] || {};
    const keys = Object.keys(rules);
    box.innerHTML = "";
    if (!keys.length) {
      box.appendChild(el("p", "hint", "None yet. Use “Teach the modal on screen” (Run tab) when a popup isn't handled right."));
      return;
    }
    keys.forEach((sig) => {
      const r = rules[sig];
      const card = el("div", "card");
      const scopeLabel = r.scope === "buttons" ? "any popup with these buttons" : "this message";
      card.appendChild(el("div", null, `“${(r.sample || sig).slice(0, 90)}”`));
      const meta = el("div", "meta", `press “${r.button}” → row ${r.outcome} · applies to: ${scopeLabel}`);
      card.appendChild(meta);
      const del = el("button", "btn danger", "Delete");
      del.style.marginTop = "5px";
      del.style.padding = "2px 8px";
      del.addEventListener("click", async () => {
        const cur = (await chrome.storage.local.get(MODAL_RULES_KEY))[MODAL_RULES_KEY] || {};
        delete cur[sig];
        await chrome.storage.local.set({ [MODAL_RULES_KEY]: cur });
        loadModalRules();
      });
      card.appendChild(del);
      box.appendChild(card);
    });
  }
  $("#modalRulesExport").addEventListener("click", async () => {
    const o = await chrome.storage.local.get(MODAL_RULES_KEY);
    download("maxload-modal-rules.json", JSON.stringify(o[MODAL_RULES_KEY] || {}, null, 2));
  });
  $("#modalRulesClear").addEventListener("click", async () => {
    if (confirm("Delete ALL learned modal rules?")) {
      await chrome.storage.local.set({ [MODAL_RULES_KEY]: {} });
      loadModalRules();
    }
  });

  // ---- BIND: point-and-click binding ----------------------------------------
  const bindState = { columns: {}, buttons: {}, keyField: null };
  let armRole = null;

  const SPECIAL = [
    { role: "button:new", label: "“New” button (CREATE entry)" },
    { role: "button:save", label: "“Save” button" },
    { role: "keyfield", label: "Key / search field (UPDATE locate)" }
  ];

  function colsFromInput() {
    return $("#bindCols").value.split(",").map((s) => s.trim()).filter(Boolean);
  }

  $("#bindFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const rows = await readFile(file);
      parsedRows = rows; // also usable by the Run tab
      const cols = Object.keys(rows[0] || {}).filter(
        (c) => !["_action", "_key_value"].includes(c)
      );
      // keep _key_field out of the field list but note it drives the key binding
      $("#bindCols").value = cols.filter((c) => c !== "_key_field").join(", ");
      bindFeed(`Loaded ${rows.length} rows, columns: ${cols.join(", ")}`);
      renderBind();
    } catch (err) {
      bindFeed("Parse error: " + err.message, "error");
    }
  });

  $("#bindBuildRows").addEventListener("click", renderBind);

  $("#bindAutoDetect").addEventListener("click", async () => {
    bindFeed("Scanning the current screen for New / Save / Search…");
    const r = await sendCmd({ type: "ml:cmd:detect-controls" });
    if (!r || !r.ok) return bindFeed("Auto-detect failed: " + (r && r.error), "error");
    const c = r.controls || {};
    let found = 0;
    if (c.new) { bindState.buttons.new = c.new; found++; bindFeed(`New → “${c.new.text || c.new.label}”`); }
    if (c.save) { bindState.buttons.save = c.save; found++; bindFeed(`Save → “${c.save.text || c.save.label}”`); }
    if (c.keyField) { bindState.keyField = c.keyField; found++; bindFeed(`Search/key → “${c.keyField.label || c.keyField.stableKey}”`); }
    if (!found) bindFeed("Couldn't auto-detect any — bind them by hand below with the Bind buttons.", "warn");
    else bindFeed(`Auto-detected ${found}. Check them, and re-bind any that look wrong.`);
    renderBind();
  });

  function renderBind() {
    // special rows
    const sp = $("#bindSpecial");
    sp.innerHTML = "";
    SPECIAL.forEach((s) => sp.appendChild(bindRow(s.role, s.label, currentBinding(s.role))));
    // field rows
    const ff = $("#bindFields");
    ff.innerHTML = "";
    const cols = colsFromInput();
    if (!cols.length) {
      ff.appendChild(el("li", "hint", "Add column names above (or load a file), then click “Build field list”."));
    }
    cols.forEach((col) => {
      const role = "field:" + col;
      ff.appendChild(bindRow(role, col, bindState.columns[col]));
    });
  }

  function currentBinding(role) {
    if (role === "button:new") return bindState.buttons.new;
    if (role === "button:save") return bindState.buttons.save;
    if (role === "keyfield") return bindState.keyField;
    return null;
  }

  function bindRow(role, label, binding) {
    const li = el("li", "card");
    const row = el("div", "row");
    const title = el("div");
    title.style.flex = "1";
    title.appendChild(el("strong", null, label));
    const status = el("div", "meta");
    status.textContent = binding
      ? `✓ bound: ${binding.text || binding.label || binding.stableKey || binding.id || "element"} [${binding.controlType || binding.tag}]`
      : "not bound";
    if (binding) status.style.color = "#1f9d55";
    title.appendChild(status);
    const btn = el("button", "btn" + (armRole === role ? " primary" : ""), armRole === role ? "Click field…" : binding ? "Re-bind" : "Bind");
    btn.addEventListener("click", () => arm(role));
    row.append(title, btn);
    li.appendChild(row);
    return li;
  }

  async function arm(role) {
    if (armRole) await disarmAll();
    armRole = role;
    renderBind();
    $("#bindArmHint").innerHTML = `<b>Armed:</b> now click the element on the Maximo page for “${role}”. Press <kbd>Esc</kbd> to cancel.`;
    await sendToAllFrames({ type: "ml:bind:arm", role });
  }

  async function disarmAll() {
    armRole = null;
    await sendToAllFrames({ type: "ml:bind:disarm" });
  }

  async function sendToAllFrames(msg) {
    if (hostTabId == null) await resolveHostTab();
    try {
      // no frameId => delivered to all frames in the tab
      await chrome.tabs.sendMessage(hostTabId, msg);
    } catch (e) {
      bindFeed("cannot reach page frames: " + (e && e.message), "error");
    }
  }

  function storeBinding(role, binding) {
    if (role === "button:new") bindState.buttons.new = binding;
    else if (role === "button:save") bindState.buttons.save = binding;
    else if (role === "keyfield") bindState.keyField = binding;
    else if (role.startsWith("field:")) bindState.columns[role.slice(6)] = binding;
  }

  function onBindCaptured(role, binding) {
    storeBinding(role, binding);
    armRole = null;
    $("#bindArmHint").innerHTML = 'Bound. Click another <b>Bind</b> button, or save below.';
    bindFeed(`Bound “${role}” → ${binding.text || binding.label || binding.stableKey || binding.id}`);
    disarmAll();
    renderBind();
  }

  function bindFeed(text, level) {
    const line = el("li", "l " + (level || ""));
    line.innerHTML = `<span class="t">${new Date().toLocaleTimeString()}</span>  ${escapeHtml(text)}`;
    $("#bindFeed").appendChild(line);
    $("#bindFeed").scrollTop = $("#bindFeed").scrollHeight;
  }

  function buildBindingWorkflow() {
    const cols = colsFromInput();
    const columns = {};
    cols.forEach((c) => {
      if (bindState.columns[c]) columns[c] = bindState.columns[c];
    });
    return {
      id: "wf-" + Date.now().toString(36),
      name: $("#bindName").value.trim() || "Bound workflow",
      action: "BOTH",
      screen: "",
      tenant: $("#conn").textContent || "",
      createdAt: new Date().toISOString(),
      mode: "binding",
      steps: [],
      columns: Object.keys(columns),
      bindings: {
        columns,
        buttons: {
          new: bindState.buttons.new || null,
          save: bindState.buttons.save || null
        },
        keyField: bindState.keyField || null
      }
    };
  }

  $("#bindDryRun").addEventListener("click", async () => {
    const wf = buildBindingWorkflow();
    if (!Object.keys(wf.bindings.columns).length) return bindFeed("Bind at least one field first.", "warn");
    bindFeed("Testing resolution on the current screen…");
    const r = await sendCmd({ type: "ml:cmd:dry-run", workflow: wf });
    if (!r || !r.ok) return bindFeed("Test failed: " + (r && r.error), "error");
    r.results.forEach((res) =>
      bindFeed(`${res.found ? "✓" : "✗"} ${res.step} — ${res.via} (${res.score})`, res.found ? "" : "warn")
    );
  });

  $("#bindSave").addEventListener("click", async () => {
    const wf = buildBindingWorkflow();
    if (!Object.keys(wf.bindings.columns).length) return bindFeed("Bind at least one field first.", "warn");
    if (!wf.bindings.buttons.save) bindFeed("Note: no Save button bound — it will fall back to a button labelled “Save”.", "warn");
    await saveWorkflow(wf);
    bindFeed(`Saved “${wf.name}” with ${wf.columns.length} bound fields.`);
    const s = $("#bindStatus");
    s.textContent = "saved";
    s.className = "chip ok";
    setTimeout(() => (s.textContent = ""), 2500);
    renderWorkflowOptions();
  });

  // ---- shared inbound messages ----------------------------------------------
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "ml:recorder-state") renderRecSteps(msg.steps, msg.columns);
    else if (msg.type === "ml:progress") onProgress(msg.ev);
    else if (msg.type === "ml:batch-result") {
      if (msg.result && msg.result.aborted) feed("Batch stopped (aborted).", "error");
    } else if (msg.type === "ml:bind:captured") {
      onBindCaptured(msg.role, msg.binding);
    } else if (msg.type === "ml:bind:cancelled" || msg.type === "ml:bind:broadcast-disarm") {
      if (armRole) {
        armRole = null;
        $("#bindArmHint").innerHTML = "Pick cancelled. Click a <b>Bind</b> button to try again.";
        disarmAll();
        renderBind();
      }
    }
  });

  // ---- helpers --------------------------------------------------------------
  function download(name, text) {
    const blob = new Blob([text], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }

  // ---- init -----------------------------------------------------------------
  (async function init() {
    await resolveHostTab();
    await ping();
    await renderWorkflowOptions();
    renderRecSteps([]); // Teach (record) is the default tab
    setInterval(ping, 5000);
  })();
})();
