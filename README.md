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
- **Intent-based recording** — captures a field's label + *stable key* (Maximo's
  volatile `m<hash>_` prefix and `_12` row suffixes stripped), not brittle
  selectors. See [`content/recorder.js`](content/recorder.js).
- **Confidence scoring** — weighted signals (label 40 / aria-title 25 / name-id
  20 / tab-context 10 / control-type 5). ≥70 execute, 40–69 rule-assist, <40 AI.
  See [`content/smart-matcher.js`](content/smart-matcher.js).
- **Iframe-aware** — walks the top document plus every same-origin iframe,
  scoped to the active tab/section. See [`content/dom-analyzer.js`](content/dom-analyzer.js).
- **Error Watcher** — a standalone global observer that detects Maximo's blocking
  modals *by pattern*, classifies them (validation / business-rule / session /
  server / Yes-No confirm) and acts conservatively: unknown Yes/No dialogs
  default to **No + fail-the-row**; session dialogs **abort the run**. See
  [`content/error-watcher.js`](content/error-watcher.js) and
  [`rules/error-patterns.json`](rules/error-patterns.json).
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

There are two ways to teach a process. **Binding is the recommended one** —
it's deterministic (no label guessing) and directly fixes "field unresolved"
misses, because you point at the real element and MaxLoad stores its stable key.

### A) Bind (point & click — recommended)
1. **Bind** tab → load your Excel/CSV so MaxLoad pulls the column names (or type
   them in).
2. Open your Maximo screen. Click **Build field list**, then for each row click
   **Bind** and click the matching field/button on the page (a blue highlight
   follows your cursor; <kbd>Esc</kbd> cancels a pick).
3. Bind the **New** button, **Save** button, and — for updates — the **Key/search
   field**. Fields you bind resolve at confidence **100** on every row.
4. Name it → **Save binding workflow**. CREATE vs UPDATE is decided per row by the
   `_action` column — one binding set handles both.

### B) Record (demonstrate the flow)
1. **Record** tab → pick CREATE or UPDATE → *Start recording* → perform the flow
   once → *Stop & save*. Falls back to fuzzy matching + AI at run time.

### Then run
2. **Run** tab → pick the workflow, upload your file → *Dry-run match* to verify
   resolution on the current screen → *Run batch*.
3. **Logs** tab → full per-row + modal event history (exportable).
4. **Settings** tab → paste your xAI key to enable the Grok fallback (optional);
   view/clear the knowledge-base cache.

> The execution pipeline tries an explicit **binding first**, then cache → smart
> matcher → rule-assist → AI. So a bound field never depends on label matching,
> and unbound columns still get the deterministic+AI treatment.

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
