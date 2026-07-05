# MaxLoad — chrome.storage.local keys & shapes

All state lives in `chrome.storage.local` (per-profile, not synced — data can be large).

## `ml:settings`
Extension settings (edited from the panel Settings tab).
```jsonc
{
  "xaiApiKey": "",          // xAI/Grok API key (from console.x.ai). Empty = AI disabled.
  "model": "grok-4.3",      // Grok model id
  "aiEnabled": true,         // master switch for the AI fallback
  "confidenceThreshold": 70  // >=70 execute; 40-69 rule-assist; <40 AI (informational mirror of matcher)
}
```

## `ml:workflows`
Array of recorded Workflow Definitions (intent-based, one per Create/Update flow).
```jsonc
[
  {
    "id": "id-...",
    "name": "CREATE — Work Order Tracking",
    "action": "CREATE",              // "CREATE" | "UPDATE"
    "screen": "Work Order Tracking",
    "url": "https://maximo.example.com/maximo/ui/...",
    "tenant": "maximo.example.com",  // hostname
    "createdAt": "ISO-8601",
    "columns": ["description", "location", "assetnum"],
    "steps": [
      { "type": "select-record", "keyField": "wonum", "note": "UPDATE entry" },
      { "type": "click-new", "text": "New Work Order" },
      { "type": "set-field", "column": "description",
        "target": { "label": "Description", "stableKey": "description", "controlType": "textbox", "tabContext": "list" },
        "sampleValue": "..." },
      { "type": "save", "text": "Save", "verify": "new-record-id" }
    ],

    // OPTIONAL — present on "binding" workflows created from the Bind tab.
    // When present, the execution engine resolves these deterministically FIRST
    // (locate by exact stable key across all frames), before any fuzzy matching.
    "mode": "binding",
    "action": "BOTH",                  // per-row _action drives create vs update
    "bindings": {
      "columns": {
        "description": { "stableKey": "description", "id": "m1a2b3_tb-...", "name": "...",
                          "controlType": "textbox", "label": "Description", "tabContext": "list",
                          "tag": "input", "frameUrl": "..." }
      },
      "buttons": {
        "new":  { "stableKey": "insertrecord", "text": "New Work Order", "controlType": "button", "tag": "a" },
        "save": { "stableKey": "save", "text": "Save", "controlType": "button", "tag": "img" }
      },
      "keyField": { "stableKey": "wonum", "label": "Work Order", "controlType": "textbox" }  // UPDATE locate
    }
  }
]
```
Binding capture strips Maximo's volatile `m<hash>_` prefix and `_12` row suffixes.
For Maximo the stripped key is often just a control suffix (`-tb`) shared by every
textbox, so `locate()` is **label-first**: it matches on the field's visible caption
("Location:") — the only durable identity — and refuses to act without a real signal
(label match, same-session id, or a *meaningful* key), returning null so the caller
retries rather than typing into the wrong box.

### Transaction execution (`mode: "sequence"`)
Sequence workflows run through the v2 **transaction engine** (`runRowTxn`), one
transaction per row: ENSURE-BASE → ENTER (New, then verify the form opened) →
FILL (set + read-back verify each value) → SAVE + verify commit (capture the new
record #, or fail on an error modal/banner) → CLASSIFY → RECOVER to a clean base →
RETRY transient failures ×2. On a row error the default is **skip + log the exact
Maximo message**; session-expired / server-broken **abort** the run. Unknown dialogs
are classified by AI (skip / retryable / abort), cached by message signature in
`ml:errorClass`. Optional workflow fields: `base: "list"|"app"` and
`resetButton` (binding) to guide return-to-base for UPDATE.

## `ml:knowledgeBase`
Learning cache. Key = `tenant|app|screen|fieldStableKey` (all lowercased).
```jsonc
{
  "maximo.example.com|create — wot|work order tracking|description": {
    "pattern": "m1a2b3_tb_description",  // resolved id/name to relocate the element
    "source": "deterministic",            // "deterministic" | "ai"
    "resolvedAt": 1720000000000,          // ms epoch — used for the >14-day recheck
    "hits": 3
  }
}
```
Recheck: entries older than `RECHECK_DAYS` (14) are re-verified before trusting; a
failed recheck invalidates the entry and falls back through matcher/AI.

## `ml:runs`
Resume state, keyed by `runId` = `workflowId::fileName::rowCount`.
```jsonc
{
  "id-..::rows.csv::20": {
    "runId": "...",
    "meta": { "workflow": "...", "fileName": "rows.csv", "total": 20 },
    "createdAt": "ISO",
    "updatedAt": "ISO",
    "aborted": false,
    "abortReason": "",
    "rows": {
      "0": { "status": "done",   "message": "new record id: 1051", "at": "ISO" },
      "1": { "status": "failed", "message": "Description is required", "at": "ISO" }
    }
  }
}
```
Row status ∈ `pending | running | done | failed | skipped`. On resume, the engine
continues at the first non-`done`/`failed`/`skipped` index.

## `ml:logRing`
Capped ring buffer (max 3000 entries) of log + progress + modal events, written by
the service worker. This is what makes an overnight 500-row run debuggable the next
morning.
```jsonc
[
  { "ts": "ISO", "level": "warn", "kind": "modal", "msg": "modal detected: validation",
    "data": { "row": 214, "screen": "Work Order Tracking", "classification": "validation",
              "actionPlanned": "dismiss-fail-row", "text": "Description is required" } }
]
```
