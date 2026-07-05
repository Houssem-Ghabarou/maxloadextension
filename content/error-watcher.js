/* MaxLoad — Modal handler (rebuilt from scratch, simple + teachable).
 *
 * One job: when a Maximo popup appears, decide which button to press and whether
 * the current row should continue, fail (skip to next row), or the run aborts.
 *
 * Order of decision (teach-first):
 *   1. A rule YOU taught for this popup  -> press your button, apply your outcome.
 *   2. Session/login popup               -> abort the run.
 *   3. Yes/No/Cancel confirm             -> press No (safe) and CONTINUE.
 *   4. Single OK/Close (error or notice) -> dismiss and FAIL this row (skip it).
 *
 * No severity guessing, no AI. Detection anchors on Maximo's #mb_msg label.
 */
(function () {
  "use strict";
  const MaxLoad = window.MaxLoad;
  const norm = MaxLoad.util.normLabel;
  const RULES_KEY = "ml:modalRules";

  const SESSION_RE = /\b(session|logged out|log ?in again|please log in|timed out|time ?out|expir|connexion|reconnect|déconnect|deconnect)\b/i;

  // ---- detection ------------------------------------------------------------
  function buttonsIn(el) {
    return [
      ...el.querySelectorAll("button, [ctype='pushbutton'], input[type=button], input[type=submit], a[role=button], [role=button]")
    ]
      .filter((b) => MaxLoad.util.isVisible(b))
      .map((b) => ({ el: b, label: norm(b.textContent || b.value || b.getAttribute("alt") || b.getAttribute("aria-label")) }))
      .filter((b) => b.label);
  }

  function findModal() {
    const docs = MaxLoad.dom.collectDocuments(document);
    // Primary: a visible Maximo message label (#mb_msg) => a message box is up.
    for (const doc of docs) {
      let msg;
      try {
        msg = doc.querySelector("[id$='mb_msg'], #mb_msg");
      } catch (_) {
        msg = null;
      }
      if (msg && MaxLoad.util.isVisible(msg)) {
        const dlg =
          msg.closest("[id^='msgbox-dialog'], [role=dialog], table.modal, table[modal='true']") ||
          msg.closest("table") ||
          msg.parentElement;
        return { el: dlg || msg, doc, text: msg.textContent.trim(), buttons: buttonsIn(dlg || msg) };
      }
    }
    // Fallback: ONLY Maximo's own message box (errors / confirms / save prompts).
    // We deliberately do NOT treat arbitrary [role=dialog] as a popup to dismiss —
    // interactive dialogs (lookups, Change Status, Route Workflow, relation
    // sub-records, etc.) are part of the recorded flow and must be left alone.
    for (const doc of docs) {
      let els;
      try {
        els = doc.querySelectorAll("[id^='msgbox-dialog'], [id='errorDialog'], [id$='_msgbox']");
      } catch (_) {
        continue;
      }
      for (const el of els) {
        if (!MaxLoad.util.isVisible(el)) continue;
        const btns = buttonsIn(el);
        if (btns.length) return { el, doc, text: (el.textContent || "").trim().slice(0, 500), buttons: btns };
      }
    }
    return null;
  }

  function currentBlocking() {
    return findModal();
  }

  // ---- rules (taught) -------------------------------------------------------
  function msgSig(text) {
    return norm(text).replace(/\d+/g, "#").slice(0, 180);
  }
  function btnSig(buttons) {
    return (buttons || []).map((b) => b.label).filter(Boolean).sort().join("|");
  }
  function fullSig(text, buttons) {
    return msgSig(text) + " :: " + btnSig(buttons);
  }
  function modalSignature(text, buttons) {
    return fullSig(text, buttons);
  }

  async function getRules() {
    try {
      const o = await chrome.storage.local.get(RULES_KEY);
      return o[RULES_KEY] || {};
    } catch (_) {
      return {};
    }
  }
  async function lookup(text, buttons) {
    const rules = await getRules();
    if (rules[fullSig(text, buttons)]) return rules[fullSig(text, buttons)];
    const ms = msgSig(text);
    for (const k in rules) if (rules[k] && rules[k].msgSig === ms) return rules[k];
    const bs = btnSig(buttons);
    for (const k in rules) if (rules[k] && rules[k].scope === "buttons" && rules[k].btnSig === bs) return rules[k];
    return null;
  }
  async function teachModal(text, buttons, rule) {
    const rules = await getRules();
    const sig = fullSig(text, buttons);
    rules[sig] = {
      button: norm(rule.button),
      outcome: ["continue", "fail", "abort"].includes(rule.outcome) ? rule.outcome : "fail",
      scope: rule.scope === "buttons" ? "buttons" : "message",
      sample: (text || "").slice(0, 200),
      msgSig: msgSig(text),
      btnSig: btnSig(buttons)
    };
    await chrome.storage.local.set({ [RULES_KEY]: rules });
    MaxLoad.log(`modal rule learned (${rules[sig].scope}): press '${rules[sig].button}' -> ${rules[sig].outcome}`);
    return rules;
  }

  // ---- button pickers -------------------------------------------------------
  function byLabel(buttons, label) {
    const w = norm(label);
    return buttons.find((b) => b.label === w);
  }
  function noButton(buttons) {
    return (
      buttons.find((b) => /^(no|non|nein|nao|não)$/.test(b.label)) ||
      buttons.find((b) => /^(cancel|annuler|canceler|cancelar)$/.test(b.label))
    );
  }
  function okButton(buttons) {
    return (
      buttons.find((b) => /^(ok|okay|d'accord|accepter)$/.test(b.label)) ||
      buttons.find((b) => /^(close|fermer|schließen|cerrar)$/.test(b.label)) ||
      buttons[0]
    );
  }
  function isConfirm(buttons) {
    const has = (re) => buttons.some((b) => re.test(b.label));
    return (
      (has(/^(yes|oui|ja|si|sí|sim)$/) && has(/^(no|non|nein|nao|não)$/)) ||
      (has(/^(ok|okay)$/) && has(/^(cancel|annuler)$/)) ||
      has(/^(no|non)$/)
    );
  }

  // ---- press a button + verify the popup actually closed (trusted click) ----
  async function press(modal, btn) {
    if (!btn) return false;
    let m = modal;
    let target = btn;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (MaxLoad.input) await MaxLoad.input.click(target.el);
      else MaxLoad.util.realClick(target.el);
      await MaxLoad.settle.waitForSettle({ quietMs: 300, timeoutMs: 4000 });
      const now = findModal();
      if (!now || now.text !== m.text) return true; // closed or changed
      m = now;
      target = byLabel(now.buttons, target.label) || okButton(now.buttons);
      if (!target) break;
      MaxLoad.warn("popup didn't close, retry #" + (attempt + 1));
    }
    return false;
  }

  // ---- the ONE handler ------------------------------------------------------
  /** Handle whatever popup is present. Returns:
   *  { outcome: 'none'|'continue'|'fail'|'abort', message, button, taught } */
  async function handle(rowNum, screen) {
    const m = findModal();
    if (!m) return { outcome: "none" };

    const rule = await lookup(m.text, m.buttons);
    reportModal(rowNum, m, rule);
    MaxLoad.log(
      `popup detected: "${m.text.slice(0, 70)}" buttons=[${m.buttons.map((b) => b.label).join(",")}] rule=${rule ? "MATCH(press '" + rule.button + "'/" + rule.outcome + ")" : "none→default"}`
    );

    if (!rule && SESSION_RE.test(m.text)) return { outcome: "abort", message: m.text };

    let btn, outcome, taught = false;
    if (rule) {
      taught = true;
      btn = byLabel(m.buttons, rule.button) || okButton(m.buttons);
      outcome = rule.outcome;
    } else if (isConfirm(m.buttons)) {
      btn = noButton(m.buttons) || okButton(m.buttons); // No = safe (don't save/override)
      outcome = "continue";
    } else {
      btn = okButton(m.buttons); // single OK/Close error or notice
      outcome = "fail";
    }

    if (outcome === "abort") {
      await press(m, btn);
      return { outcome: "abort", message: m.text, button: btn && btn.label, taught };
    }
    const closed = await press(m, btn);
    if (!closed) {
      MaxLoad.warn(`could NOT close popup after pressing '${btn && btn.label}' — is it under the panel? text="${m.text.slice(0, 80)}"`);
      return { outcome: "abort", message: "could not close popup: " + m.text.slice(0, 160) };
    }
    MaxLoad.log(`popup handled: pressed '${btn && btn.label}' -> ${outcome}`);
    return { outcome, message: m.text, button: btn && btn.label, taught };
  }

  /**
   * Special handling for the moment right after clicking New/entry: a confirm
   * dialog here is Maximo's "save your changes before continuing?" — i.e. the
   * PREVIOUS record is dirty. We always press No (discard) and CONTINUE onto the
   * fresh record. This is navigation, not a data error, so it must never fail the
   * new row (and it bypasses any taught rule, which is meant for real popups).
   */
  async function handleEntryPrompt(rowNum, screen) {
    for (let k = 0; k < 4; k++) {
      const m = findModal();
      if (!m) return { outcome: "none" };
      if (SESSION_RE.test(m.text)) return { outcome: "abort", message: m.text };
      if (!isConfirm(m.buttons)) {
        // a real error popped at entry -> normal (taught rule / default) handling
        return await handle(rowNum, screen);
      }
      const btn = noButton(m.buttons) || okButton(m.buttons);
      if (MaxLoad.hl) MaxLoad.hl.toast(`Row ${rowNum}: discarding previous record (No)…`, "click");
      MaxLoad.log(`entry: discard previous record via '${btn && btn.label}' -> continue`);
      const closed = await press(m, btn);
      if (!closed) return { outcome: "abort", message: "could not close discard prompt: " + m.text.slice(0, 120) };
      await MaxLoad.settle.waitForSettle({ quietMs: 250, timeoutMs: 3000 });
    }
    return { outcome: "continue" };
  }

  // ---- visible reporting ----------------------------------------------------
  function reportModal(rowNum, m, rule) {
    const label = rule ? "taught" : isConfirm(m.buttons) ? "confirm→No" : "error→dismiss";
    if (MaxLoad.hl) MaxLoad.hl.toast(`Popup [${label}]: ${m.text.slice(0, 60)}`, rule ? "save" : "error");
    try {
      chrome.runtime &&
        chrome.runtime.sendMessage({
          type: "ml:progress",
          ev: { phase: "modal", row: rowNum, classification: rule ? "taught" : label, button: rule ? rule.button : "", text: (m.text || "").slice(0, 200) }
        });
    } catch (_) {}
    MaxLoad.util.log("warn", "popup: " + (rule ? "taught rule" : "default " + label), {
      row: rowNum,
      text: (m.text || "").slice(0, 300),
      buttons: m.buttons.map((b) => b.label)
    });
  }

  // ---- teach the on-screen popup + apply it now -----------------------------
  function currentModalInfo() {
    const m = findModal();
    if (!m) return null;
    return { text: m.text, buttons: m.buttons.map((b) => b.label), signature: fullSig(m.text, m.buttons) };
  }
  async function teachCurrentModal(rule) {
    const m = findModal();
    if (!m) return { ok: false, error: "No popup on screen right now." };
    await teachModal(m.text, m.buttons, rule);
    const btn = byLabel(m.buttons, rule.button) || okButton(m.buttons);
    let applied = false;
    if (btn) {
      applied = await press(m, btn);
      const running = MaxLoad.exec && MaxLoad.exec.isRunning && MaxLoad.exec.isRunning();
      if (!running && MaxLoad.input) setTimeout(() => MaxLoad.input.detach(), 1200);
    }
    return { ok: true, applied, text: m.text };
  }

  // ---- inline (non-blocking) banners — for logging the real reason ----------
  function captureInlineMessages() {
    const docs = MaxLoad.dom.collectDocuments(document);
    const msgs = [];
    for (const doc of docs) {
      let bars;
      try {
        bars = doc.querySelectorAll("[id*='messageArea'], .message, [class*='msgbar'], [class*='statusMessage'], [role=alert]");
      } catch (_) {
        continue;
      }
      for (const bar of bars) {
        if (MaxLoad.util.isVisible(bar) && bar.textContent.trim()) msgs.push(bar.textContent.trim().slice(0, 300));
      }
    }
    return [...new Set(msgs)];
  }

  // ---- compatibility shim for any legacy callers ----------------------------
  async function handleIfPresent(rowNum, screen) {
    const h = await handle(rowNum, screen);
    const map = { none: "none", continue: "row-continue", fail: "row-failed", abort: "abort-run" };
    return { outcome: map[h.outcome] || "none", type: h.taught ? "taught" : "default", message: h.message };
  }

  // ---- global observer (surfaces detection to the panel) --------------------
  let observer = null;
  function startWatching() {
    if (observer) return;
    const target = document.body || document.documentElement;
    observer = new MutationObserver(() => {
      if (!MaxLoad.env.isTop) return;
      const m = findModal();
      if (m) {
        try {
          chrome.runtime && chrome.runtime.sendMessage({ type: "ml:modal-detected", text: m.text.slice(0, 300) });
        } catch (_) {}
      }
    });
    try {
      observer.observe(target, { childList: true, subtree: true, attributes: true });
    } catch (_) {}
  }

  MaxLoad.errorWatcher = {
    startWatching,
    findModal,
    currentBlocking,
    handle,
    handleEntryPrompt,
    handleIfPresent,
    captureInlineMessages,
    teachModal,
    teachCurrentModal,
    currentModalInfo,
    modalSignature
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startWatching, { once: true });
  else startWatching();
})();
