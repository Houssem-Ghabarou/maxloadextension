# lib/

Optional third-party libraries.

## SheetJS (xlsx) — enables `.xlsx` upload

CSV works out of the box with no dependency. To also read native `.xlsx`
workbooks, drop the SheetJS standalone build here as **`xlsx.full.min.js`**:

1. Download from https://cdn.sheetjs.com/ (or `https://cdn.sheetjs.com/xlsx-latest/package/dist/xlsx.full.min.js`).
2. Save it as `lib/xlsx.full.min.js` (exact name — the panel and manifest
   reference it).
3. Reload the extension.

The panel detects it automatically (`typeof XLSX`). If it's missing, uploads are
parsed as CSV/text and a hint is shown. `xlsx.full.min.js` is already listed in
`manifest.json` under `web_accessible_resources`, so no manifest change is needed.
