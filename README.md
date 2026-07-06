# MaxLoad — Maximo Excel Automation (Chrome Extension)

Teach MaxLoad a Maximo business process once (**Create** *and* **Update**), then
execute it reliably hundreds/thousands of times from Excel/CSV — entirely from
the browser, no Maximo REST API.

MaxLoad is a **deterministic automation engine with an AI fallback**: weighted
confidence scoring handles ~90%+ of field matches for free; Grok (xAI) is called
only when confidence is low, and every AI answer is cached so it's never asked
again for that field/screen/tenant.

---

## Install (unpacked)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this `maxload/` folder.
3. Open your Maximo tab and click the MaxLoad toolbar icon to toggle the panel.
   (If Maximo was already open before installing, click the icon once — the
   service worker injects the content scripts on demand.)

Optional: for native `.xlsx` upload, add SheetJS — see [`lib/README.md`](lib/README.md).
CSV works with no setup.

---

## How it works (the pipeline)

```
Recorder ──► Workflow JSON (intent-based, action=CREATE|UPDATE)
                     │
                     ▼
             Execution Engine ──► per field: cache ─► Smart Matcher ─► Rule-assist ─► AI Recovery
                     │                                     (≥70 exec) (40–69 re-scope) (<40 Grok)
                     ▼
             Error Watcher (always-on, global) guards before AND during every action
                     │
                     ▼
             Resume + Log ring (overnight-run debuggable)
```

- **Transaction engine** — each Excel row runs as a transaction, not a blind
  replay: reach a clean base → enter (New / search) and verify the form opened →
  fill each field with **read-back verification** → **save and confirm it
  committed** (capture the new record #) → classify any error → **recover to a
  clean base** → retry transient failures. On a row error: skip + log the exact
  Maximo message; session/server death aborts the run. See `runRowTxn` in
  [`content/execution-engine.js`](content/execution-engine.js).
- **Teach = record + bind in one pass** — as you demonstrate the flow, every
  field / button / Enter step is captured with its *binding* (visible label +
  *stable key* with Maximo's volatile `m<hash>_` prefix and `_12` row suffixes
  stripped, plus id/name/tab context) — not brittle selectors. So recorded steps
  resolve deterministically at run time (label-first), falling to matcher / AI
  only when a binding doesn't resolve. See [`content/recorder.js`](content/recorder.js).
- **Confidence scoring** — weighted signals (label 40 / aria-title 25 / name-id
  20 / tab-context 10 / control-type 5). ≥70 execute, 40–69 rule-assist, <40 AI.
  See [`content/smart-matcher.js`](content/smart-matcher.js).
- **Iframe-aware** — walks the top document plus every same-origin iframe,
  scoped to the active tab/section. See [`content/dom-analyzer.js`](content/dom-analyzer.js).
- **Modal handler (teach-first)** — a standalone global observer detects Maximo's
  message-box popups. A rule *you taught* for that popup wins first; otherwise it
  acts conservatively: session/login → **abort the run**, Yes/No/Cancel confirm →
  press **No** + continue (never auto-commit), single OK/Close error → **dismiss +
  fail the row**. You can **teach any popup live during a run** — which button to
  press and whether the row should fail / continue / abort, scoped to that message
  or to any popup with the same buttons. See
  [`content/error-watcher.js`](content/error-watcher.js).
- **Settle detection** — never a fixed delay; `MutationObserver` debounce + busy
  indicator + retrying lookups. See [`content/settle-detector.js`](content/settle-detector.js).
- **Learning cache** — keyed by `(tenant, app, screen, fieldStableKey)` with a
  14-day recheck. See [`engines/learning-cache.js`](engines/learning-cache.js).
- **Resume** — per-row progress persisted; a killed browser resumes at the right
  row. See [`engines/resume-engine.js`](engines/resume-engine.js).

---

## Excel / CSV schema

| Column | Purpose |
|---|---|
| `_action` | `CREATE` or `UPDATE` |
| `_key_field` / `_key_value` | UPDATE only — locate the record (e.g. `wonum` = `1234`) |
| one column per Maximo attribute | `description`, `location`, `assetnum`, … |

**Empty cells are never written** — an UPDATE only touches columns present in the
row, so it can't blank fields you didn't intend to change. Sample:
[`examples/sample-workorders.csv`](examples/sample-workorders.csv).

---

## Using it

You teach a process by **demonstrating it once — teaching and binding happen at
the same time**. As you act on the real Maximo screen, MaxLoad captures each step
*and* its binding (the element's stable key + label), so at run time it resolves
every step deterministically, not by guessing.

### A) Teach — record + auto-bind (recommended)
1. **Teach** tab → load your Excel/CSV so MaxLoad pulls the column names → pick
   CREATE or UPDATE → **Start**.
2. Perform the flow once on the Maximo screen: click **New**, type in fields,
   press **Enter** to search, click a record, edit fields, click **Save**.
   MaxLoad follows along, listing each step and capturing its binding as it goes.
3. **Stop**, then map each field step to its Excel column (default is "don't
   fill"), reorder or delete steps, and name it. The sequence replays per row,
   injecting each row's column value into its mapped field.

### B) Bind — point & click (precise / manual)
1. **Bind** tab → load your file (or type column names) → **Build field list**.
2. For each row click **Bind**, then click the matching field/button on the page
   (a blue highlight follows your cursor; <kbd>Esc</kbd> cancels). Bind the
   **New** button, **Save** button, and — for updates — the **Key/search field**.
3. Name it → **Save binding workflow**. Bound elements resolve at confidence
   **100** on every row; CREATE vs UPDATE is decided per row by `_action`.

### Teach a popup mid-run (errors, confirms, anything)
When a Maximo popup isn't handled the way you want, **leave it open** and use
**Teach the modal on screen** (Run tab): choose which button MaxLoad should press
and whether the row should **fail / continue / abort**, scoped to that exact
message or to any popup with the same buttons. It applies immediately and is
saved for next time — manage learned rules in **Settings**.

### Then run
1. **Run** tab → pick the workflow, upload your file → **Dry-run** to verify every
   step resolves on the current screen → **Run batch** (or **Watch row 1** first).
2. **Logs** tab → full per-row + modal event history (exportable).
3. **Settings** tab → paste your AI key to enable the Grok/Groq fallback
   (optional); view/clear the knowledge-base cache and learned modal rules.

> At run time each step tries its **binding first** (label-first, deterministic),
> then cache → smart matcher → rule-assist → AI. So a taught or bound step never
> depends on fuzzy label matching alone, and low-confidence fields still get the
> deterministic-plus-AI treatment.

---

## Project layout

```
maxload/
├── manifest.json               # MV3, all_frames, on-demand injection
├── background/service-worker.js # AI proxy (Grok), log ring, toolbar toggle
├── content/                    # namespace, settle, dom-analyzer, smart-matcher,
│                               # rule-engine, error-watcher, recorder,
│                               # execution-engine, frame-bridge, panel-inject
├── engines/                    # excel, ai-recovery, learning-cache, resume
├── ui/                         # panel + workflow-editor
├── rules/                      # default-rules.json, error-patterns.json (data, not code)
├── storage/schema.md           # chrome.storage keys & shapes
├── examples/                   # sample CSV
└── lib/                        # optional SheetJS for .xlsx
```

---

## Notes & scope

- **Same-origin iframes** are handled by recursing from the top frame; the error
  watcher also runs in every frame. Truly cross-origin embedded frames can't be
  reached from JS (browser security) — Maximo is typically same-origin.
- **Grok is billed per token** (needs a key from console.x.ai). It's the low-
  confidence fallback only; deterministic matching + cache keep calls rare.
- This is a v0.1 vertical slice per `MaxLoad_Plan.md` Phase 0–2. Test against one
  screen (Work Order Tracking) for both Create and Update before scaling out.
