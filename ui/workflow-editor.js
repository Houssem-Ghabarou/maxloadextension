/* MaxLoad — workflow editor page. View/edit a recorded workflow's step JSON. */
(function () {
  "use strict";
  const WF_KEY = "ml:workflows";
  const $ = (s) => document.querySelector(s);
  const id = new URLSearchParams(location.search).get("id");
  let workflow = null;

  async function getWorkflows() {
    const o = await chrome.storage.local.get(WF_KEY);
    return o[WF_KEY] || [];
  }
  async function setWorkflows(list) {
    await chrome.storage.local.set({ [WF_KEY]: list });
  }

  function status(text, cls) {
    const s = $("#status");
    s.textContent = text;
    s.className = "chip " + (cls || "");
    if (text) setTimeout(() => (s.textContent = ""), 2500);
  }

  async function load() {
    const list = await getWorkflows();
    workflow = list.find((w) => w.id === id);
    if (!workflow) {
      $("#wfName").textContent = "Workflow not found";
      $("#json").value = "// No workflow with id " + id;
      return;
    }
    $("#wfName").textContent = workflow.name;
    $("#json").value = JSON.stringify(workflow, null, 2);
  }

  $("#format").addEventListener("click", () => {
    try {
      const obj = JSON.parse($("#json").value);
      $("#json").value = JSON.stringify(obj, null, 2);
      status("formatted", "ok");
    } catch (e) {
      status("invalid JSON: " + e.message, "");
    }
  });

  $("#save").addEventListener("click", async () => {
    let obj;
    try {
      obj = JSON.parse($("#json").value);
    } catch (e) {
      status("Cannot save — invalid JSON: " + e.message, "");
      return;
    }
    if (!obj.id) obj.id = id;
    const list = await getWorkflows();
    const idx = list.findIndex((w) => w.id === obj.id);
    if (idx >= 0) list[idx] = obj;
    else list.push(obj);
    await setWorkflows(list);
    workflow = obj;
    $("#wfName").textContent = obj.name || "(unnamed)";
    status("saved", "ok");
  });

  $("#export").addEventListener("click", () => {
    const blob = new Blob([$("#json").value], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (workflow ? workflow.name : "workflow") + ".json";
    a.click();
  });

  load();
})();
