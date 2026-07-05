/* MaxLoad — Excel Engine (row model + per-row Create/Update dispatch).
 *
 * File PARSING (xlsx via SheetJS, or csv) happens in the panel UI, which can
 * load SheetJS normally. This content-script module owns the ROW MODEL: it
 * validates the MaxLoad Excel schema and turns each parsed row into an
 * execution plan the Execution Engine runs. It also ships a dependency-free CSV
 * parser so CSV works with zero setup.
 *
 * Schema (minimum):
 *   _action            CREATE | UPDATE
 *   _key_field         (UPDATE only) attribute to locate the record by, e.g. wonum
 *   _key_value         (UPDATE only) its value, e.g. 1234
 *   <attr columns>     one per Maximo attribute (description, location, ...)
 *
 * Only NON-EMPTY columns are written — an UPDATE never blanks fields the user
 * didn't intend to touch.
 */
(function () {
  "use strict";
  const MaxLoad = window.MaxLoad;

  const META_COLS = new Set(["_action", "_key_field", "_key_value"]);

  /** Dependency-free CSV parser (handles quotes, embedded commas/newlines). */
  function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else inQuotes = false;
        } else field += c;
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field);
        field = "";
        if (row.some((v) => v !== "")) rows.push(row);
        row = [];
      } else {
        field += c;
      }
    }
    if (field !== "" || row.length) {
      row.push(field);
      if (row.some((v) => v !== "")) rows.push(row);
    }
    if (!rows.length) return [];
    const headers = rows[0].map((h) => h.trim());
    return rows.slice(1).map((r) => {
      const obj = {};
      headers.forEach((h, idx) => (obj[h] = (r[idx] ?? "").trim()));
      return obj;
    });
  }

  /** Validate the parsed rows against the schema; returns { ok, errors, rows }. */
  function validate(rows) {
    const errors = [];
    if (!Array.isArray(rows) || !rows.length) {
      return { ok: false, errors: ["No data rows found."], rows: [] };
    }
    rows.forEach((r, i) => {
      const action = String(r._action || "").toUpperCase().trim();
      if (action !== "CREATE" && action !== "UPDATE") {
        errors.push(`Row ${i + 1}: _action must be CREATE or UPDATE (got "${r._action || ""}").`);
      }
      if (action === "UPDATE") {
        if (!r._key_field || !String(r._key_value).length) {
          errors.push(`Row ${i + 1}: UPDATE requires _key_field and _key_value.`);
        }
      }
    });
    return { ok: errors.length === 0, errors, rows };
  }

  /**
   * Turn one parsed row into an execution plan.
   * Returns:
   *   { action, keyField, keyValue, fields:[{column,value}], rawIndex }
   * Only non-empty, non-meta columns become field writes.
   */
  function planRow(row, index) {
    const action = String(row._action || "").toUpperCase().trim();
    const fields = [];
    for (const [col, val] of Object.entries(row)) {
      if (META_COLS.has(col)) continue;
      if (val == null) continue;
      const v = String(val).trim();
      if (v === "") continue; // never write empty -> avoids blanking on UPDATE
      fields.push({ column: col, value: v });
    }
    return {
      rawIndex: index,
      action,
      keyField: row._key_field || "",
      keyValue: row._key_value != null ? String(row._key_value).trim() : "",
      fields
    };
  }

  /** Convenience: validate + plan all rows. */
  function buildPlans(rows) {
    const v = validate(rows);
    const plans = v.rows.map((r, i) => planRow(r, i));
    return { ...v, plans };
  }

  MaxLoad.excel = { parseCSV, validate, planRow, buildPlans, META_COLS };
})();
