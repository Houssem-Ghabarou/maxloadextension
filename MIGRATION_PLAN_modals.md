# Migration Plan — MaxLoad (extension) → iAMXLS (Playwright engine), with hardened modals

**Goal:** keep every MaxLoad feature, but run teaching+replay on the iAMXLS Playwright
engine so the *hard cases (lookup modals, timing, clicks)* stop failing. This is an
**evolution of iAMXLS**, not a rewrite — it folds in what MaxLoad does well and closes
the modal/lookup gap.

> Source note: this repo folder is the compiled build (`dist/` + `desktop/`). Implement
> against the iAMXLS **source** (`ssh://…/iAMXLS.git`, `src/*.ts`). File refs below point
> at the source paths named in `docs/teaching-accuracy-analysis.md`.

---

## 0. Why move (what the engine gives you for free)

| Problem you kept hitting | Root cause in the extension | How the Playwright engine fixes it |
|---|---|---|
| Clicks drift / don't register | hand-rolled pixel or synthetic clicks | Playwright **hit-tested trusted clicks** + actionability |
| Steps take 12–14 s | DOM-mutation settle never goes quiet | Playwright **auto-wait on the element + network**, plus iAMXLS `whenIdle()` action channel |
| Typed into the base field, not the modal | whole-page resolution, ambiguous label | Playwright **scoped locators** (`dialog.locator(…)`) — dialog-scoping is native and robust |
| Enter didn't submit in modal | key focused the wrong field | resolve the filter field **scoped to the dialog**, then press Enter on it |

The accuracy foundation is already specified in `teaching-accuracy-analysis.md` (Phases 0–5).
This plan **adds the modal/lookup hardening (Part D)** and the **feature parity (Part B)**.

---

## A. Feature parity — what moves over from the extension (keep these)

Map each MaxLoad feature onto an iAMXLS teach-step field / executor option:

| MaxLoad feature | Where it lives now (extension) | iAMXLS home |
|---|---|---|
| Teach-by-demonstration (record clicks/typing) | `content/recorder.js` | `src/maximo/recorder.ts` (already exists) |
| Map each field → Excel column | `ui/panel.js` step editor | teach template `steps[].column` |
| Per-field **commit key** (Tab/Space/…) | `step.commitKey` | add `steps[].commitKey`, applied in `navigator.setFieldValue` |
| **Upsert** (not found → create) | taught "record not found" modal → `create` | `executor` finder result: 0 rows → run the create tail |
| **Teach a modal rule** (press X, outcome) | `content/error-watcher.js` | `executor` message handler + a per-teach rule table |
| **Dialog-scoped field resolution** | `fieldInActiveDialog()` | native: scope locator to the open dialog (Part D) |
| Live run log / results & failed CSV | `ui/panel.js` | `desktop/renderer` run view (already present) |

**Rule:** nothing is dropped; each becomes a field on the teach step or an executor option.

---

## B. Adopt the iAMXLS accuracy foundation (already planned — do it first)

From `teaching-accuracy-analysis.md`, land Phases 0–3 before the modal work, because the
modal fix depends on stable, verified field identity:

- **Phase 0 — Field fingerprint** (`attribute? + tabPath + section + label + ordinal + controlType`,
  `idStem` as hint only). Replaces the volatile `fieldId`.
- **Phase 1 — Explicit click is the only mapping source** (demote the value-diff watcher).
- **Phase 2 — Stable-first, single-match resolve** (attribute → tab+section+label → label+ordinal
  → aria → idStem → AI heal). **Ambiguous = failure, never pick the first.**
- **Phase 3 — Read-back verify** (teach shows `Code immo → ASSETNUM`; validate asserts the value landed).

---

## C. Route everything through one action primitive (the "Playwright discipline")

Add a single `actOn(fingerprint, action)` in the navigator that every step uses:

1. **resolve** → exactly one Playwright `Locator` (Part B rules) — scoped to the current
   surface (open dialog if any → active tab → page).
2. **actionability** → Playwright's built-in: attached, visible, stable, enabled,
   receives-events (hit-test). Auto-retries until ready or a bounded timeout.
3. **act** → trusted click / `fill` + commit key / press.
4. **verify** → read-back (Phase 3).

This kills the timing + click classes in one place.

---

## D. The hard part — lookup modals as a **structured sub-flow** (the core ask)

Today a lookup is captured as loose clicks + a field that resolves against the whole page.
Model it explicitly instead.

### D.1 Teach — capture the lookup as one unit
When the user demonstrates a lookup, record a `lookup` step with:
```ts
interface LookupStep {
  open: ControlRef;          // how the modal was opened: magnifier img / "Select Value" menuitem / detail-menu
  filterField: FieldFingerprint; // the modal's query/filter field — captured DIALOG-SCOPED
  submit: 'enter' | 'go';    // how the search ran (Enter key, or the GO/magnifier button)
  select: {                  // how the result was chosen
    by: 'value' | 'firstRow';
    column?: string;         // the Excel column whose value matches the result row
  };
  notFound?: 'create' | 'fail' | 'skip'; // upsert policy for 0 results
}
```
- **Dialog-scoped capture:** when the pointed field is inside an open dialog, store
  `context: 'dialog'` on its fingerprint and capture its discriminators
  (`class~=queryField|tablefilterfield`, `fldinfo.query===true`, column ordinal) — this is
  the extension's `isLookupField` logic, but recorded once at teach time.

### D.2 Replay — scope to the dialog, never the base field
```ts
async function runLookup(step: LookupStep, rowValue: string) {
  await actOn(step.open, 'click');                          // open the modal
  const dlg = page.locator('.modaldialog,[role="dialog"]').last();
  await dlg.waitFor({ state: 'visible' });                  // Playwright auto-wait
  const filter = resolveIn(dlg, step.filterField);          // SCOPED to the dialog → never base field
  await filter.fill(rowValue);
  if (step.submit === 'enter') await filter.press('Enter');
  else await actOn(step.goButton, 'click');
  await whenIdle();                                         // wait the filter round-trip
  const rows = dlg.locator('tr[id*="_tr["]');
  if (await rows.count() === 0) return onNotFound(step);    // upsert: create / fail / skip
  const target = step.select.by === 'value'
    ? dlg.getByText(rowValue, { exact: false }).first()
    : rows.first();
  await actOn(target, 'click');                             // select result
}
```
The single most important line is `resolveIn(dlg, …)` — **all filter/field/result resolution
is scoped to the dialog Locator**, so it is structurally impossible to type into or click the
identically-labelled base field underneath. That is the native, robust version of the
extension's `fieldInActiveDialog`.

### D.3 Submit + finder robustness
- Capture **which** submit the user used (Enter vs GO magnifier vs List filter) and replay
  *that one* (analysis P8 / §5). Don't assume `#quicksearch`.
- For the "record not found → create" upsert: 0 result rows → dismiss the dialog and run the
  create tail (New + same fills + Save), reusing the executor — the extension's `runCreateForRow`
  mapped onto iAMXLS.

---

## E. Execution order (smallest-risk first)

1. **Phase 0 fingerprint** in the teach schema + recorder (source of all accuracy).
2. **`actOn()` primitive** in the navigator (resolve → actionability → act → verify).
3. **Dialog scoping** (`resolveIn(dialog, …)`) — immediate win for your modal case.
4. **`LookupStep` sub-flow** (D) — capture + replay lookups as a unit.
5. **Feature parity** (A): commit keys, upsert, modal rules, column mapping.
6. **Read-back verify** (Phase 3) + honest fail-loud on ambiguity.
7. Surface detection + hard field types (Phases 4–5) as follow-ups.

---

## F. Acceptance (how we know modals are fixed)
1. A taught lookup fills the **modal's** filter field on every row (0 base-field hits), across sessions.
2. Enter (or GO) submits the filter; the correct result row is selected by the row's value.
3. 0 results → the taught not-found policy runs (create/fail/skip) — never a wrong pick, never a duplicate.
4. Per-row time is seconds, not tens of seconds (auto-wait, not fixed settles).
5. Ambiguous resolution **stops and reports**; it never silently fills the wrong field.
