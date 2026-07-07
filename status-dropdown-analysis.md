# Status-Change Dropdown — How It Works

How the app opens, clicks, and chooses a value in a Maximo status (synonym-domain)
dropdown — end to end, across **teaching** (recording) and **replay**.

---

## The core problem

Maximo status menus are **not** typable `<select>` boxes. They are custom menus where:

- Each option's **id encodes the internal code** — `menu0_INPRG_OPTION_a` → `INPRG`.
- The visible text is **localized and duplicated** ("In progress" vs "Encours",
  "Completed" vs "Complétée").
- The element **ids regenerate on every login**.

So the code deliberately drives the menu **by internal code** (pulled from the option
id), which is language-independent and stable. That is the whole design.

---

## Phase 1 — Teaching (recording)

File: [`src/maximo/recorder.ts`](../src/maximo/recorder.ts)

When you arm a column and then click an option in an open status menu:

1. **`synonymOption(node)`** — `recorder.ts:340`
   Walks up from the clicked element (up to 8 ancestors) looking for an id matching
   `menu\d+_(.+?)_OPTION`. If found, it extracts the code (e.g. `INPRG`). Codes may
   contain underscores (e.g. `ATT_EXEC`).

2. **`openerOf(el)`** — `recorder.ts:354`
   Records *how the menu was opened* so replay can re-open it. Maximo tags the menu
   `<ul>` with `data-opener-id` pointing at the arrow/image you clicked. It captures
   that opener's **stable anchors** — the nearby field label (e.g. "New Status") and
   its `title` — because the raw id will not survive a re-login.

3. **`select` map event emitted** — `recorder.ts:378`
   Binds the column → dropdown by code, plus the opener anchors.

At compile time (`recorder.ts:1028`) this becomes a `select` step:

```ts
{ kind: 'select', column, code, opener, near }
```

The opener is also inferred from the immediately-preceding click when the select is
unbound/fixed (`recorder.ts:996`).

### SelectOpener shape

```ts
interface SelectOpener {
  id?: string;    // live id (regenerates between logins — fast path only)
  near?: string;  // label of the field the opener sits next to ("New Status") — stable
  title?: string; // opener control's title ("Drop-down image") — stable
}
```

---

## Phase 2 — Replay

Files: [`src/execution/executor.ts`](../src/execution/executor.ts) →
[`src/maximo/navigator.ts`](../src/maximo/navigator.ts)

### `setSelectStep` — `executor.ts:533`

Resolves the value for the current row:

- **Column-bound** → value comes from the sheet per row (trimmed).
- **Unbound** → the fixed demonstrated `code` is used.
- Empty → step is skipped.

Then calls `nav.selectSynonym(value, step.opener)`. On failure it pushes a row
exception: *"value not offered in the list"*.

### `selectSynonym(value, opener)` — `navigator.ts:1311`

The open → choose logic:

1. **Open if needed** — `navigator.ts:1320`
   Checks for any visible `a[role="menuitem"][id*="_OPTION"]`. If none, re-opens the
   menu via `clickControl` using the opener's stable anchors (id → title → near
   label), patiently (4s) — the Change-Status dialog paints slowly and a bulk-load
   opener click may have missed.

2. **Choose BY CODE** — `navigator.ts:1328`
   Normalizes the value to a code and clicks the option whose id ends in
   `_CODE_OPTION_a`. The leading underscore in the suffix prevents `WAPPR` vs `APPR`
   collisions. Case-insensitive on the id.

3. **Fallback BY exact TEXT** — `navigator.ts:1345`
   Case-insensitive **exact** match only — never a substring, so "Approved" cannot
   match "Not Approved". Covers a sheet that stores the description instead of the
   code.

4. **Fail loudly** — `navigator.ts:1362`
   If the value is not offered, returns `false` and the row is flagged, rather than
   clicking a look-alike.

Resolution order: **code → id (primary) → exact option text → fail.**

### The opener click — `clickControl` — `navigator.ts:945`

Opens the menu with the same exact-match discipline:

- Exact text/title first, then id.
- **Stable id-suffix fallback** (`_bg_button_addrow-pb` style) — the hash regenerates
  every login and text is localized, but the suffix is constant and
  language-independent.
- **Explicitly refuses substring `has-text` matching** (`navigator.ts:958`) because
  "Active" would match "Inactive" and silently click the wrong option.

---

## One important orchestration detail

In the executor's replay loop (`executor.ts:260`–`311`):

- A click whose **next** step is a `select` is recognized as the **dropdown opener**
  (`opensDropdown`, `executor.ts:265`).
- It gets patient treatment (4s) and its miss is **never allowed to abort the row**
  (`executor.ts:312`) — because `selectSynonym` re-opens the menu itself anyway.

---

## Flow summary

```
Teaching
  arm column → click status option
    → synonymOption()  extracts INPRG from the option id
    → openerOf()       captures how the menu was opened (near label + title)
    → select step { column, code, opener }

Replay (per row)
  setSelectStep()  resolves value (sheet column | fixed code)
    → selectSynonym(value, opener)
        1. menu open?  no → clickControl(opener)   [re-open, patient 4s]
        2. click option by CODE   (#..._INPRG_OPTION_a)
        3. else click by EXACT text
        4. else fail → flag row (no look-alike click)
```

---

## Key files & symbols

| Concern | File | Symbol / line |
| --- | --- | --- |
| Detect option code from id | `src/maximo/recorder.ts` | `synonymOption` — `340` |
| Capture how menu opened | `src/maximo/recorder.ts` | `openerOf` — `354` |
| Emit select map event | `src/maximo/recorder.ts` | `378` |
| Compile select step | `src/maximo/recorder.ts` | `1028` |
| Resolve per-row value | `src/execution/executor.ts` | `setSelectStep` — `533` |
| Opener = click before select | `src/execution/executor.ts` | `260`–`312` |
| Open + choose value | `src/maximo/navigator.ts` | `selectSynonym` — `1311` |
| Click the opener control | `src/maximo/navigator.ts` | `clickControl` — `945` |

---

## Example DOM

See [`data/exampleshtml/dropddownstatus.html`](../data/exampleshtml/dropddownstatus.html)
and [`data/exampleshtml/dropownsstatusmaximo7.html`](../data/exampleshtml/dropownsstatusmaximo7.html)
for real captured menu markup.
