# MaxLoad — Reliability & Known Limits

> How MaxLoad drives the browser, what it is resilient to, and where its edges
> are. Read this before running large/unattended batches in production.
>
> _Last updated: 2026-07-06 · applies to extension v0.1.0_

---

## 1. How MaxLoad enters data (the input pipeline)

MaxLoad does **not** blindly fire events at pixels. Typing and clicking take
different paths, because Maximo ignores synthetic (`isTrusted=false`) events for
some controls, so real OS-level input is generated through the Chrome DevTools
Protocol (CDP), the same mechanism Selenium/Puppeteer use.

### Typing a field — three tiers, best-first

The engine stops at the first tier whose result it can **verify** landed in the
target element (`content/cdp-input.js` → `type()`).

| Tier | Method | Why it exists |
|---|---|---|
| **1. Focus + insertText** (primary) | `el.focus()` in JS (browser scrolls it into view natively), then trusted `Input.insertText` into the **focused** node — no coordinates | Immune to scroll position, off-screen fields, overlays, and mouse movement, because keystrokes follow *focus*, not a pixel |
| **2. Coordinate CDP** (fallback) | `scrollIntoView` → settle → **hit-test** the point → trusted click-to-focus at a verified pixel → type | Used only if focus can't be confirmed |
| **3. Direct set** (last resort) | Sets the value straight onto the correct element reference (synthetic) | Guarantees the value can never land in a *neighbouring* field |

After tiers 1 and 2, a **read-back** (`didLand`) confirms the value actually
reached *this* element before continuing; if not, it drops to the next tier.

### Clicking a button (Save / New / tabs)

Still **coordinate-based** CDP (`scrollIntoView` → settle → hit-test → trusted
click), with a synthetic `realClick` fallback. There is no focus-based
equivalent for a trusted toolbar-button click.

---

## 2. Disturbing a batch in real time

What you can and cannot safely do **while a run is in progress**:

| Action mid-run | Safe? | What happens |
|---|---|---|
| Scroll the page | ✅ | Typing follows focus, not a pixel — values still land correctly |
| Move the mouse | ✅ | Mouse movement never changes `document.activeElement` |
| Switch to another browser tab | ✅ | CDP targets the tab, not window focus |
| Let a field render off-screen (e.g. last field on a long form) | ✅ | `el.focus()` scrolls it into view natively before typing |
| **Click into a field on the running form** | ⚠️ | The **target** field self-corrects via read-back, **but** the field you click into can get stray text / be cleared — MaxLoad doesn't know to clean a field that was never its target |
| **Click a button on the running form** | ⚠️ | Can steal focus / cause a coordinate click to miss; that step may fail (row fails cleanly — not wrong data) |
| Navigate away / open an unrelated Maximo dialog | ❌ | Breaks the flow for the current row; the run may abort or fail rows |

**Rule of thumb:** glancing, scrolling, and moving the mouse are fine. Do **not
actively click into the live form** during a run — the field MaxLoad is filling
will self-heal, but a field you hijack focus into can be corrupted.

### Why the click case can't be fully closed

A physical click changes `document.activeElement`. If it happens in the
millisecond window between MaxLoad focusing field A and the trusted keystrokes
arriving, those keystrokes land in field B. Read-back detects that A is empty and
re-fills A directly — but B has already received stray input, and B was never a
target MaxLoad tracks.

---

## 3. Field matching & resolution limits

- **Binding beats matching.** A bound field (Bind tab: you point at the element)
  resolves at confidence **100** by its stable key/label. Recorded/fuzzy fields
  are scored 0–100 (label 40 / aria-title 25 / name-id 20 / tab 10 / type 5);
  ≥70 execute, 40–69 rule-assist, <40 AI.
- **Maximo stable keys are often meaningless.** IDs are per-session hashes and the
  stripped key is frequently just a control suffix (`-tb`) shared by *every*
  textbox. That's why `locate()` is **label-first** and refuses to act without a
  real signal (matching label, same-session id, or a *meaningful* key) — it
  returns `null` and lets the caller retry rather than type into the wrong box.
- **Ambiguous / duplicate labels** can still mis-resolve. If two visible fields
  share a caption, fuzzy matching may pick the wrong one — bind those explicitly.
- **Late-rendering fields** are retried (up to a timeout) but can still be missed
  if Maximo renders them very slowly or behind a tab you didn't record entering.

---

## 4. AI fallback limits

- **Opt-in and billed.** The Grok/xAI (or Groq/custom) fallback only runs when you
  configure an API key. It's billed per token, not free.
- **Only structure is sent.** Sanitization strips all field **values**; only tag
  names, labels, and `id`/`name`/`aria-label`/`type`/`role` structure go to the
  model. Live record data is never transmitted.
- **It can still be wrong.** The model returns a single `id`/`name`; if it picks
  the wrong element, MaxLoad will act on it. Every AI answer is cached per
  `(tenant, app, screen, field)` with a 14-day recheck — so a wrong cached answer
  persists until the recheck or a manual cache clear (Settings tab).

---

## 5. Modal / error-dialog limits

The rebuilt modal handler (`content/error-watcher.js`) is deliberately narrow and
conservative:

- **It only anchors on Maximo's own message box** (`#mb_msg` / `msgbox-dialog`).
  Interactive dialogs (lookups, Change Status, Route Workflow, relation
  sub-records) are treated as part of the flow and left alone **by design**.
- **Default outcomes:** session/login popup → **abort the run**; Yes/No/Cancel
  confirm → press **No** (safe, never auto-commit) and continue; single OK/Close
  error → dismiss and **fail the row**. You can override any popup with a **taught
  rule** (Run tab → "Teach the modal on screen").
- **A popup that won't close** after pressing its button (e.g. hidden under the
  panel) → the run **aborts** rather than looping.
- **Not wired in:** `rules/error-patterns.json` and the AI error-classifier
  (`classifyError`) exist in the codebase but are **not** used by the current
  handler. Classification is inline (session regex + confirm-button detection +
  taught rules), not pattern-file or AI driven.

---

## 6. Iframe & environment limits

- **Cross-origin iframes are unreachable.** MaxLoad recurses through the top
  document and every *same-origin* iframe. A truly cross-origin embedded frame
  can't be touched from JS (browser security). Maximo classic is typically
  same-origin, so this is usually fine.
- **CDP debugger banner.** Attaching the debugger shows Chrome's "MaxLoad started
  debugging this browser" bar. It's cosmetic, but it means MaxLoad **cannot share
  a tab with an open DevTools session or another debugger** — only one CDP client
  per tab.
- **Runs in the active tab.** The panel drives whichever tab is active when you
  start; keep the Maximo tab focused as the active tab for the run.
- **State lives in `chrome.storage.local`** (per-profile, not synced). Clearing
  browser data / using a different profile loses workflows, cache, logs, resume.

---

## 7. Data & transaction limits

- **Empty cells are never written.** This protects UPDATE from blanking fields —
  but it also means you **cannot blank a field on purpose** with an empty cell.
- **No real rollback.** A row is a best-effort sequence, not an atomic
  transaction. If a row fails after some fields were filled, those partial edits
  are **not** rolled back (Save wasn't clicked, so usually nothing commits — but
  verify per screen).
- **CREATE verification is heuristic.** Success after Save is inferred from a
  new-record-id snapshot; "id unchanged" is treated as a soft-OK, which can
  occasionally false-pass. Check exported results for large runs.
- **Resume is keyed by `workflowId::fileName::rowCount`.** Renaming the file or
  changing the row count starts a **new** run (no resume). Same file + same count
  resumes at the first non-done/failed/skipped row.
- **Excel = first sheet only**, and `.xlsx` requires SheetJS present
  (`lib/xlsx.full.min.js`); `.csv` works with zero setup.

---

## 8. Recorder (Teach) limits

- Records **field focus/typing**, **button/tab/link clicks**, and the **Enter**
  key. It does **not** record Escape or arbitrary key chords.
- **Meaningless clicks are filtered:** inline-script wrappers and identity-less
  containers are skipped, and Maximo grid internals (`tempselect`, list toggles)
  are dropped at record time, run time, and dry-run. Other internal controls that
  sneak in as clicks may need adding to the junk list (`isJunkClick`).
- Teaching stores **who** an element is (stable key, label, id/name, tab context)
  — never **where** it is. So scrolling around while teaching has zero effect on
  accuracy; coordinates are computed fresh at run time only.

---

## 9. Recommended production practice

1. **Bind** the key fields, New, and Save rather than relying on recorded fuzzy
   matching — bound fields resolve deterministically at confidence 100.
2. **Dry-run** on the target screen first — it resolves every step without acting
   and flags anything unresolved.
3. **Watch mode** (run row 1) before a full batch, to confirm the visible
   highlight lands on the right controls.
4. Don't click into the live form mid-run; scrolling/mouse are fine.
5. Keep the **Logs** tab / exported results — every row and modal event is
   recorded for the morning-after review of an overnight run.
6. Test both CREATE and UPDATE on one screen across a few sessions before scaling
   out.

---

## 10. Quick reference — is it safe?

| Situation | Verdict |
|---|---|
| Scroll / move mouse during a run | ✅ Safe |
| Off-screen / bottom-of-form field | ✅ Safe (focus scrolls it in) |
| Value landing in the wrong field | ✅ Prevented (read-back self-corrects the target) |
| Switch tabs during a run | ✅ Safe |
| Click into the running form | ⚠️ Target self-heals; hijacked field can corrupt |
| Trusted button click while scrolling | ⚠️ May be missed → row fails cleanly |
| Cross-origin embedded frame | ❌ Unreachable |
| Blank a field via empty cell | ❌ Not possible (by design) |
| Share the tab with open DevTools | ❌ CDP conflict |
