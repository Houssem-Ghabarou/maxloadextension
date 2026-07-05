# MaxLoad — Build Plan for Claude Code

## Mission
Teach MaxLoad a Maximo business process once (Create **and** Update), then execute it reliably hundreds/thousands of times from Excel data — entirely from the browser (Chrome extension), no Maximo REST API.

## Core Philosophy
MaxLoad is a **deterministic automation engine with an AI fallback**, not an AI agent and not a dumb macro recorder.

- Deterministic matching handles ~90%+ of cases (fast, free, reproducible).
- AI (Grok, via xAI API) is called **only** when deterministic matching has low confidence — and every AI-resolved answer is cached so it's never asked again for that field/screen.

---

## 1. Handling CREATE and UPDATE explicitly

These are **different workflows** and must be modeled as such — don't assume one flow covers both.

| | CREATE | UPDATE |
|---|---|---|
| Entry point | Click "New" / "+" on the app list screen | Search/select an existing record first (by key field, e.g. Work Order Num, Asset Num) |
| Record locate step | Not needed | Needed — must wait for record to load into the form before filling fields |
| Fields touched | Usually all required fields | Usually a subset — only columns present in the Excel row that differ from current value |
| Save action | "Save" creates a new row — verify a new record ID appears | "Save" updates in place — verify no "record changed by another user" conflict dialog appears |
| Failure mode to guard against | Duplicate creation if retried blindly | Overwriting a field that wasn't meant to change — only write columns explicitly present in Excel row |

**Workflow definition must include an explicit `action: "CREATE" | "UPDATE"` field per step-group**, and the Excel schema (below) must carry this per row so one engine handles both without special-casing logic scattered through the code.

**Excel schema (minimum):**

| Column | Purpose |
|---|---|
| `_action` | `CREATE` or `UPDATE` |
| `_key_field` / `_key_value` | Only for UPDATE — which field+value to search/select the record by (e.g. `wonum` = `1234`) |
| one column per Maximo attribute | e.g. `description`, `location`, `assetnum`, `priority` |

Only columns that are non-empty for a given row get written — this prevents an UPDATE from blanking fields the user didn't intend to touch.

---

## 2. Revised Roadmap — build a thin vertical slice first

Don't build all 13 layers before validating the core matching approach. Build in this order, testing against **one real Maximo screen (Work Order Tracking)** doing both Create and Update, before expanding.

### Phase 0 — Vertical Slice (prove the concept)
- Chrome extension skeleton (manifest, content script injected into Maximo + all iframes)
- Recorder: capture intent-based steps (not raw selectors) for one screen, both Create and Update
- DOM Analyzer + Smart Matcher (see confidence scoring below) — no AI yet
- Execution Engine: replay recorded steps on the same screen
- Excel Engine: read one Excel file client-side (SheetJS), drive Create + Update rows through the same engine
- **Exit criteria:** 20 Excel rows (mix of Create/Update) execute successfully on Work Order Tracking across 3 separate browser sessions without selector failures.

### Phase 1 — Reliability Layer
- Rule Engine (merged with Validation — see below): dialogs, spinners, lookup popups, required-field checks
- Resume Engine: persist progress per row, resumable after browser restart
- Logging Engine: per-row status, timing, error detail

### Phase 2 — AI Fallback (Grok)
- AI Recovery Engine: called only when Smart Matcher confidence is below threshold
- Learning Engine: cache every AI-resolved mapping, keyed by tenant+screen+field
- Sanitization layer before any HTML goes to the AI (strip field **values**, keep only structure/labels)

### Phase 3 — Scale Out
- Add second and third Maximo screens (Asset, Service Request) to confirm the engine generalizes
- Field-mapping assistant (Excel header → Maximo attribute) using AI once per new sheet, cached after

### Phase 4 — Product polish
- Workflow editor UI, multi-workflow management, exportable logs/reports

---

## 3. Architecture

```
Chrome Extension
   │
   ▼
Recorder ──────────────► Workflow Definition (JSON, intent-based, action=CREATE|UPDATE)
                                │
                                ▼
                        Execution Engine
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
        DOM Analyzer      Smart Matcher      Rule/Validation Engine
              │                 │                 │
              └─────────────────┼─────────────────┘
                                ▼
                          Confidence ≥ threshold?
                          /                  \
                        YES                   NO
                         │                     │
                         ▼                     ▼
                  Execute + Verify      AI Recovery (Grok)
                                                │
                                                ▼
                                        Learning Engine → cache
                                                │
                                                ▼
                                        Execute + Verify
```

### DOM Analyzer — iframe-aware (explicit, not assumed)
Maximo nests forms inside iframes. The content script must be injected with `all_frames: true`, and the analyzer must walk `document.querySelectorAll('iframe')` recursively (same-origin, so `contentDocument` works), scoping every field search to the *currently active* tab/section within that frame to avoid grabbing hidden duplicates.

### Smart Matcher — concrete confidence score
Don't leave "confidence" undefined. Score each candidate element 0–100 using weighted signals, e.g.:

| Signal | Weight |
|---|---|
| Exact label match (visible `<label>` text) | 40 |
| `aria-label` / `title` contains stable key | 25 |
| `name`/`id` substring matches stable key (after stripping session-hash prefix and numeric suffixes) | 20 |
| Correct tab/section context | 10 |
| Expected control type (textbox vs lookup vs select) matches | 5 |

Threshold: **≥70 → execute directly. 40–69 → try Rule Engine adjustments (e.g. re-scope to active tab) then re-score. <40 → AI Recovery.**

Stable-key extraction (regex to strip volatile prefix/suffix):
```js
function getStableKey(el) {
  const candidates = [el.name, el.getAttribute('aria-label'), el.title, el.id];
  for (const c of candidates) {
    if (!c) continue;
    const cleaned = c.replace(/^m[0-9a-f]{6,}_?/, '').replace(/_\d+(_\d+)*$/, '');
    if (cleaned.length > 2) return cleaned;
  }
  return null;
}
```

### Rule Engine + Validation Engine — merged
Both are "predefined behavior for known situations" — keep as **one config-driven rules table** instead of two engines:

```json
[
  { "trigger": "spinner-visible", "action": "wait-for-disappear" },
  { "trigger": "dialog:confirm", "action": "click-ok" },
  { "trigger": "dialog:lookup", "action": "type-search-select-first" },
  { "trigger": "field:required-empty-on-save", "action": "abort-row-log-error" },
  { "trigger": "field:readonly", "action": "skip-and-log-warning" }
]
```
Adding a new situation is a data change, not new code.

### Timing / settle detection
Never use a fixed delay. Use a `MutationObserver` on the main content container, debounce 300–500ms of no mutations, and also watch Maximo's own busy indicator element — proceed only once both are clear. Retry field lookup every 200ms up to a max timeout before failing the step.

### Error Watcher — Maximo's blocking modal dialogs (critical, standalone layer)

This is the layer that actually determines whether a 500-row Excel batch survives unattended. Maximo's modal errors (validation failures, duplicate key, business rule violations, session timeout, server exceptions) render as an overlay that **blocks all interaction with the page underneath** — if your engine doesn't detect it, it will either silently time out on every subsequent field lookup, or worse, misfire actions once the modal is dismissed at the wrong moment.

**Design principle: the Error Watcher runs independently of the current workflow step, not as part of it.** It's a global observer, always on, checking before *and* during every step — not something the execution engine only checks when a step happens to fail.

**1. Detection**

Run a `MutationObserver` on `document.body` (and inside every iframe) watching for the appearance of Maximo's dialog container. In practice this is usually a `div` with `role="dialog"` / `role="alertdialog"`, or a Maximo-specific class (commonly something like `.dialog`, `#errorDialog`, or a fixed-position overlay with a high z-index covering the viewport). Don't hardcode one exact class name — detect by **pattern**: a newly-added, visible element that (a) has a high z-index / covers a large portion of the viewport, and (b) contains a close/OK button. Record its text content for classification.

**2. Classification — not all modals should be handled the same way**

| Type | Signal | Action |
|---|---|---|
| Validation error (missing required field, invalid value) | Message text matches known patterns ("required", "invalid value", field name echoed back) | Dismiss (click OK/X), mark current row FAILED with the message text logged, move to next row |
| Duplicate key / business rule violation | Message matches known business-rule text | Dismiss, mark row FAILED, log, continue |
| Save confirmation (Yes/No buttons, not OK/X) | Dialog has two buttons, typically "Yes"/"No" — e.g. "data may be lost, continue?", "override warning, save anyway?" | **Default to "No" whenever this dialog followed a step the engine already flagged as failed or uncertain** (e.g. a prior validation warning fired first, or confidence was borderline). Only click "Yes" for a small explicit allow-list of known-benign confirmations you've verified are safe (config-driven, see below). If in doubt: No, log, mark row FAILED — never guess "Yes" on an unrecognized Yes/No dialog, since that risks committing bad or partial data. |
| Session expired / login required | Message matches "session", "login", "timed out" | **Abort entire run** — do not continue, this will fail every subsequent row. Surface to user, save resume point. |
| Server error / stack trace / unknown exception | Doesn't match any known pattern | Screenshot + log full modal text, attempt exactly one dismiss. If the same or another modal reappears immediately after, **abort the run** rather than looping — this usually means the underlying state is broken, not just this row. |

**On the Yes/No case specifically:** button-detection logic must distinguish two-button confirm dialogs (Yes/No, OK/Cancel) from single-button error dialogs (OK/X) — they need different handling, not the same "click the one button and move on" logic. Maintain an explicit allow-list in `error-patterns.json` of confirm-dialog texts that are safe to auto-accept with "Yes" (e.g. a routine "field will recalculate, continue?" that always appears on a normal save and isn't actually an error). Everything not on that allow-list defaults to "No" + fail-and-log. This keeps the safe default conservative (never silently save something wrong) while still letting you whitelist known-harmless confirmations over time as you observe them in logs.

Keep the pattern list in a config file (`rules/error-patterns.json`), same philosophy as the Rule Engine — adding a newly-seen error message is a data change, not a code change.

**3. Guarding execution — check before acting, not just after failing**

Before every field interaction, the Execution Engine must check "is a blocking modal currently present?" and refuse to act if so — don't rely solely on the *previous* step's error handling to have caught it, because a modal can appear asynchronously between steps (e.g. a background validation call resolves late).

**4. Watchdog timeout on dismissal**

If a dismiss action (click OK/X) doesn't actually close the modal within ~3–5 seconds, don't retry the same click indefinitely. Treat as an unknown/stuck state → abort row (or abort run, if it's the second occurrence in a row) rather than hanging the whole batch.

**5. Non-blocking inline messages**

Maximo also shows non-blocking inline status/message bars (e.g. a yellow/red banner at the top of the form) that don't halt interaction. These should still be captured for logging (they often contain the real reason a save silently didn't do what was expected) but don't need the abort/dismiss logic above.

**6. Logging requirement**

Every modal event — dismissed or not — gets a log entry: row number, screen, full modal text, classification, action taken. This is what makes a 500-row overnight run debuggable the next morning instead of just showing "row 214 failed" with no context.


### Knowledge Base — cache invalidation (explicit)
Cache key must be `(tenant/hostname, app, screen, fieldStableKey) → resolvedSelectorPattern`, not just field name — otherwise a customized screen in one org silently corrupts matching in another. Add a lightweight periodic recheck: on first execution after N days, re-verify a cached mapping still resolves before trusting it blindly; if it fails, fall through to AI Recovery again and update the cache.

### Sanitization before AI calls
Strip all field **values** from any HTML sent to Grok — send only tag names, labels, `name`/`id`/`aria-label` attributes, and structure. Never send actual work order descriptions, asset data, or other live content.

---

## 4. AI Integration — Grok (xAI API)

Endpoint is OpenAI-SDK-compatible: `POST https://api.x.ai/v1/chat/completions`, Bearer auth, current flagship model `grok-4.3` (or `grok-code-fast-1`-class models are being redirected to `grok-4.3` as of recent retirements — use `grok-4.3` as the default). Note this requires an xAI API key from console.x.ai and is billed per token, not literally free — check current xAI pricing before relying on it as a no-cost layer long-term.

```js
async function aiResolveField(targetLabel, sanitizedHtmlSnippet) {
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${XAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "grok-4.3",
      messages: [
        { role: "system", content: "You match form fields from sanitized HTML structure only. Return ONLY the id or name attribute value of the single best-matching element, nothing else." },
        { role: "user", content: `Target field meaning: "${targetLabel}"\nHTML fragment:\n${sanitizedHtmlSnippet}` }
      ],
      temperature: 0
    })
  });
  const data = await res.json();
  return data.choices[0].message.content.trim();
}
```
Cache the returned key immediately via the Knowledge Base pattern above so this call happens once per field/screen/tenant, not on every run.

---

## 5. File structure for Claude Code

```
maxload/
├── manifest.json                 # all_frames: true, host permissions for Maximo domain
├── background/
│   └── service-worker.js         # storage orchestration, message routing
├── content/
│   ├── recorder.js               # captures intent-based steps
│   ├── dom-analyzer.js           # fingerprints visible fields, iframe-aware
│   ├── smart-matcher.js          # stable-key extraction + confidence scoring
│   ├── rule-engine.js            # config-driven rules table (dialogs/spinners/validation)
│   ├── error-watcher.js          # global blocking-modal detector, classifier, dismisser
│   ├── execution-engine.js       # step-by-step runner, verify-before-continue, checks error-watcher before every action
│   └── settle-detector.js        # MutationObserver + busy-indicator wait logic
├── engines/
│   ├── excel-engine.js           # SheetJS import, per-row Create/Update dispatch
│   ├── ai-recovery.js            # Grok fallback call + sanitization
│   ├── learning-cache.js         # tenant/screen/field-keyed cache, invalidation recheck
│   └── resume-engine.js          # per-row progress persistence
├── ui/
│   ├── panel.html/js             # injected toolbar: record/play/upload Excel/logs
│   └── workflow-editor.html/js   # view/edit recorded step JSON
├── rules/
│   ├── default-rules.json        # the merged rule/validation config table
│   └── error-patterns.json       # known modal error text patterns → classification → action
└── storage/
    └── schema.md                 # chrome.storage keys/shapes documented
```

---

## 6. Acceptance criteria per phase (give these to Claude Code as test targets)

- **Phase 0:** 20 mixed Create/Update Excel rows execute correctly across 3 fresh browser sessions, 0 "element not found" failures.
- **Phase 1:** Killing the browser mid-run and resuming continues from the correct row; a forced validation error (empty required field) logs and skips instead of crashing the run. Force a Maximo blocking modal (e.g. duplicate key on Create, or a required-field save attempt) mid-batch — confirm the run detects it, classifies it, dismisses it, logs the full message, and continues to the next row without hanging. Force a simulated session-timeout modal — confirm the engine aborts the whole run rather than burning through remaining rows against a dead session.
- **Phase 2:** Manually rename/change a field's `id` in a test copy of the screen — AI Recovery resolves it once, second run onward uses cache with zero AI calls.
- **Phase 3:** Same engine, unmodified, handles a second Maximo app (e.g. Asset) with only a new workflow JSON + Excel mapping — no code changes.
