// services/reporting/reportLayout.validate.js
//
// EVERY PIVOT LAYOUT, CHECKED AGAINST THE SERVER'S OWN CATALOGUE.
//
// Run before a preview, before an export and before a save — and again before
// running anything that was saved. A layout stored in March under one set of
// permissions may be opened in September under another, and the stored copy is
// exactly as untrusted as a fresh POST.
//
// ── WHAT "VALID" MEANS ──────────────────────────────────────────────────────
// Not "well-formed JSON". It means every identifier was issued by this server,
// every placement and calculation was granted by this server, every pair of
// fields may truthfully share a report, and every value is of the right type
// and a bounded size. A layout that passes cannot express anything the compiler
// is not already willing to emit.
//
// ── UNKNOWN KEYS ARE REFUSED, NOT IGNORED ───────────────────────────────────
// Ignoring what you do not recognise is the usual instinct and it is wrong
// here: an unknown key is the shape a `{"sql": …}`, `{"native": …}` or
// `{"source-table": …}` attempt takes, and ignoring it means nobody finds out
// it was tried.
//
// ── ERRORS SAY WHAT, NOT WHERE ──────────────────────────────────────────────
// A refusal names the field's LABEL and the rule it broke. Never a column, a
// table, a view or a database error — a validation endpoint that echoes
// internals is a schema-discovery endpoint.

"use strict";

const catalogue = require("./fieldCatalogue");

/** Bounds. A legitimate report never meets them; a probe does. */
const LIMITS = Object.freeze({
  MAX_COMPANIES: 10,
  MAX_ROWS: 5,
  MAX_COLUMNS: 3,
  MAX_VALUES: 8,
  MAX_FILTERS: 20,
  MAX_COMPARISONS: 4,
  MAX_SORTS: 3,
  MAX_HEADING: 120,
  MAX_NAME: 120,
  MAX_VALUE_LENGTH: 200,
  MAX_IN_VALUES: 50,
  MAX_PREVIEW_ROWS: 100,
  MAX_EXPORT_ROWS: 100_000,
  MAX_DETAIL_COLUMNS: 20,
});

/** Keys each object may carry, and nothing else. */
const ALLOWED_KEYS = Object.freeze({
  layout: [
    "name", "companyIds", "rows", "columns", "values", "filters", "comparisons",
    "sort", "showRowTotals", "showColumnTotals", "showGrandTotal", "limit",
  ],
  shelfEntry: ["field", "heading"],
  valueEntry: ["field", "heading", "calculation"],
  filter: ["field", "operation", "value"],
  comparison: ["field", "mode", "display", "with"],
  sort: ["field", "direction"],
});

class LayoutError extends Error {
  constructor(problems) {
    super(problems[0] || "The report layout could not be validated.");
    this.code = "REPORTING_INVALID_SPEC";
    this.problems = problems;
  }
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

function unknownKeys(object, allowed, where, problems) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      problems.push(`${where} has an unrecognised property "${String(key).slice(0, 40)}".`);
    }
  }
}

/** Bounded, single-line text, or null. */
function safeText(value, max) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!cleaned || cleaned.length > max) return null;
  return cleaned;
}

/** A filter value of the right type for a field, or `{error}`. */
function validateFilterValue(def, operation, value) {
  const numeric = ["money", "number", "integer"].includes(def.type);
  const temporal = ["date", "datetime"].includes(def.type);

  const one = (v) => {
    if (numeric) {
      const n = typeof v === "number" ? v : Number(String(v).trim());
      if (!Number.isFinite(n)) return { error: "must be a number" };
      return { value: n };
    }
    if (temporal) {
      const s = typeof v === "string" ? v.trim() : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { error: "must be a date (YYYY-MM-DD)" };
      const d = new Date(`${s}T00:00:00Z`);
      // `2026-02-31` parses in JavaScript and must not pass.
      if (Number.isNaN(d.getTime()) || !d.toISOString().startsWith(s)) {
        return { error: "is not a real date" };
      }
      return { value: s };
    }
    if (def.type === "boolean") {
      if (typeof v === "boolean") return { value: v };
      if (v === "true" || v === "false") return { value: v === "true" };
      return { error: "must be true or false" };
    }
    if (def.type === "choice") {
      const s = String(v);
      if (!(def.choices || []).some((c) => c.value === s)) {
        return { error: "is not one of the offered choices" };
      }
      return { value: s };
    }
    const s = safeText(v, LIMITS.MAX_VALUE_LENGTH);
    if (s === null) return { error: `must be text of at most ${LIMITS.MAX_VALUE_LENGTH} characters` };
    return { value: s };
  };

  if (operation === "between") {
    if (!Array.isArray(value) || value.length !== 2) return { error: "needs exactly two values" };
    const a = one(value[0]);
    const b = one(value[1]);
    if (a.error) return { error: a.error };
    if (b.error) return { error: b.error };
    if (temporal && a.value > b.value) return { error: "starts after it ends" };
    return { value: [a.value, b.value] };
  }

  if (operation === "in") {
    if (!Array.isArray(value) || value.length === 0) return { error: "needs at least one value" };
    if (value.length > LIMITS.MAX_IN_VALUES) {
      return { error: `accepts at most ${LIMITS.MAX_IN_VALUES} values` };
    }
    const out = [];
    for (const v of value) {
      const r = one(v);
      if (r.error) return { error: r.error };
      out.push(r.value);
    }
    return { value: out };
  }

  if (Array.isArray(value)) return { error: "takes a single value" };
  return one(value);
}

/**
 * Validate a layout, and return the form the compiler will use.
 *
 * REBUILT from the catalogue, not from the input: every entry carries the
 * server's own descriptor, and nothing downstream sees the request object
 * again. There is therefore no path by which an unvalidated key reaches the
 * compiler.
 *
 * @param {object} raw
 * @param {object} o
 * @param {string[]} o.approvedCompanyIds  the companies the SCOPE GUARD approved
 * @param {"preview"|"export"|"save"} o.mode
 */
function validateLayout(raw, { approvedCompanyIds, mode = "preview" } = {}) {
  const problems = [];
  if (!isPlainObject(raw)) throw new LayoutError(["The report layout must be an object."]);
  unknownKeys(raw, ALLOWED_KEYS.layout, "The report", problems);

  /* ── Companies ─────────────────────────────────────────────────────────
   * The authority is the guard's approved list. They are compared only so a
   * layout naming a company the guard did not approve is refused outright
   * rather than quietly run against the ones that were. */
  const approved = (approvedCompanyIds || []).map(String);
  if (approved.length === 0) throw new LayoutError(["No company was approved for this request."]);
  const namedRaw = Array.isArray(raw.companyIds) ? raw.companyIds : [];
  if (namedRaw.length) {
    const named = [...new Set(namedRaw.map((c) => String(c)))];
    const stranger = named.find((c) => !approved.includes(c));
    if (stranger) throw new LayoutError(["The report names a company this request did not approve."]);
  }
  const companyIds = approved;

  /* ── Shelves ───────────────────────────────────────────────────────────── */
  const placed = [];

  const readShelf = (key, max, allowedKeys, extra) => {
    const list = Array.isArray(raw[key]) ? raw[key] : [];
    if (list.length > max) {
      problems.push(`A report may have at most ${max} field(s) in ${SHELF_LABEL[key]}.`);
    }
    const out = [];
    const seen = new Set();
    for (const entry of list.slice(0, max)) {
      if (!isPlainObject(entry)) {
        problems.push(`An entry in ${SHELF_LABEL[key]} is not an object.`);
        continue;
      }
      unknownKeys(entry, allowedKeys, `An entry in ${SHELF_LABEL[key]}`, problems);

      const def = catalogue.fieldOf(entry.field);
      if (!def) {
        problems.push(`"${String(entry.field).slice(0, 40)}" is not a field.`);
        continue;
      }
      // THE PERMISSION IS THE DESCRIPTOR'S, never the request's.
      if (!def.placements.includes(key)) {
        problems.push(`${def.label} cannot go in ${SHELF_LABEL[key]}.`);
        continue;
      }
      /* Values may legitimately hold the same amount twice (Total and Average
         of Debit); the other shelves may not. */
      if (key !== "values" && key !== "filters" && seen.has(def.id)) {
        problems.push(`${def.label} is used more than once in ${SHELF_LABEL[key]}.`);
        continue;
      }
      seen.add(def.id);

      const heading = entry.heading === undefined || entry.heading === null
        ? def.label
        : safeText(entry.heading, LIMITS.MAX_HEADING);
      if (heading === null) {
        problems.push(`The heading for ${def.label} must be text of at most ${LIMITS.MAX_HEADING} characters.`);
        continue;
      }

      const built = extra ? extra(entry, def, heading, problems) : { field: def, heading };
      if (built) {
        out.push(built);
        placed.push(def);
      }
    }
    return out;
  };

  const rows = readShelf("rows", LIMITS.MAX_ROWS, ALLOWED_KEYS.shelfEntry);
  const columns = readShelf("columns", LIMITS.MAX_COLUMNS, ALLOWED_KEYS.shelfEntry);

  const values = readShelf("values", LIMITS.MAX_VALUES, ALLOWED_KEYS.valueEntry,
    (entry, def, heading) => {
      const calculation = entry.calculation === undefined || entry.calculation === null
        ? def.calculations[0]
        : entry.calculation;
      if (!catalogue.CALCULATIONS.includes(calculation)) {
        problems.push(`"${String(calculation).slice(0, 30)}" is not a calculation.`);
        return null;
      }
      if (!def.calculations.includes(calculation)) {
        problems.push(`${def.label} cannot be calculated with "${calculation}".`);
        return null;
      }
      return { field: def, heading, calculation };
    });

  /* ── Filters ───────────────────────────────────────────────────────────── */
  const filters = [];
  const rawFilters = Array.isArray(raw.filters) ? raw.filters : [];
  if (rawFilters.length > LIMITS.MAX_FILTERS) {
    problems.push(`A report may have at most ${LIMITS.MAX_FILTERS} filters.`);
  }
  for (const f of rawFilters.slice(0, LIMITS.MAX_FILTERS)) {
    if (!isPlainObject(f)) {
      problems.push("A filter is not an object.");
      continue;
    }
    unknownKeys(f, ALLOWED_KEYS.filter, "A filter", problems);
    const def = catalogue.fieldOf(f.field);
    if (!def) {
      problems.push(`"${String(f.field).slice(0, 40)}" is not a field.`);
      continue;
    }
    if (!def.placements.includes("filters")) {
      problems.push(`${def.label} cannot be used as a filter.`);
      continue;
    }
    if (!def.filterOperations.includes(f.operation)) {
      problems.push(`${def.label} cannot be filtered by "${String(f.operation).slice(0, 30)}".`);
      continue;
    }
    const value = validateFilterValue(def, f.operation, f.value);
    if (value.error) {
      problems.push(`The value for ${def.label} ${value.error}.`);
      continue;
    }
    filters.push({ field: def, operation: f.operation, value: value.value });
    placed.push(def);
  }

  /* ── Comparisons ───────────────────────────────────────────────────────── */
  const comparisons = [];
  const rawComparisons = Array.isArray(raw.comparisons) ? raw.comparisons : [];
  if (rawComparisons.length > LIMITS.MAX_COMPARISONS) {
    problems.push(`A report may have at most ${LIMITS.MAX_COMPARISONS} comparisons.`);
  }
  for (const c of rawComparisons.slice(0, LIMITS.MAX_COMPARISONS)) {
    if (!isPlainObject(c)) {
      problems.push("A comparison is not an object.");
      continue;
    }
    unknownKeys(c, ALLOWED_KEYS.comparison, "A comparison", problems);
    const def = catalogue.fieldOf(c.field);
    if (!def) {
      problems.push(`"${String(c.field).slice(0, 40)}" is not a field.`);
      continue;
    }
    if (!def.comparisons) {
      problems.push(`${def.label} cannot be compared.`);
      continue;
    }
    if (!def.comparisons.modes.includes(c.mode)) {
      problems.push(`${def.label} cannot be compared with "${String(c.mode).slice(0, 30)}".`);
      continue;
    }
    if (!def.comparisons.displays.includes(c.display)) {
      problems.push(`"${String(c.display).slice(0, 30)}" is not a way of showing a comparison.`);
      continue;
    }
    /* A comparison compares a VALUE. Comparing a field that is not being
       calculated has nothing to compare, and would silently produce an empty
       column. */
    const valueEntry = values.find((v) => v.field.id === def.id);
    if (!valueEntry) {
      problems.push(`${def.label} must be in Values before it can be compared.`);
      continue;
    }
    let withValue = null;
    if (c.mode === "other_company") {
      withValue = c.with === undefined || c.with === null ? null : String(c.with);
      if (!withValue || !OBJECT_ID_RE.test(withValue)) {
        problems.push("A company comparison must name the company to compare with.");
        continue;
      }
      if (!companyIds.includes(withValue)) {
        // Not "no such company" — the guard already approved what it approved.
        problems.push("The company to compare with is not one this request approved.");
        continue;
      }
    } else if (c.with !== undefined && c.with !== null) {
      problems.push(`A "${c.mode}" comparison does not take a value to compare with.`);
      continue;
    }

    /* A period comparison has to know what period to shift. The layout's date
       filter is the only thing that says so, and it has to be a BOUNDED one —
       "before 2026-04-01" has no span to step back by, and silently comparing
       against nothing would produce a column of nulls that looks like zero
       movement. */
    if (c.mode === "previous_period" || c.mode === "previous_year") {
      const dated = filters.find(
        (f) => ["date", "datetime"].includes(f.field.type) && f.operation === "between",
      );
      if (!dated) {
        problems.push(
          `Comparing ${def.label} with an earlier period needs a date range in Filters.`,
        );
        continue;
      }
    }

    comparisons.push({ field: def, calculation: valueEntry.calculation, mode: c.mode, display: c.display, with: withValue });
    placed.push(def);
  }

  /* ── Compatibility, symmetric, across everything placed ────────────────── */
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      if (!catalogue.mutuallyCompatible(placed[i], placed[j])) {
        /* The user is never told WHY — no tables, no joins, no grains. The
           frontend shows the same sentence. */
        problems.push(
          `${placed[i].label} and ${placed[j].label} cannot be combined in one report.`,
        );
      }
    }
  }

  /* ── Mode ──────────────────────────────────────────────────────────────── */
  /* Not a flag the caller sets: the layout says which it is, exactly as the
     builder decides. Values or Columns present means a pivot; neither means a
     plain list of records. */
  const detail = values.length === 0 && columns.length === 0;

  /* AN AMOUNT IS A COLUMN IN A LIST, NEVER A GROUPING KEY IN A PIVOT.
     In a detail report Rows are the record's displayed columns and "Date,
     Number, Party, Debit, Credit" is exactly the report a bookkeeper asks for.
     In a summary, Rows are GROUP BY — and grouping by Debit produces one row
     per distinct amount, which is not a report and would be indistinguishable
     from a bug. The catalogue allows the placement; this decides what it
     meant. */
  if (!detail) {
    for (const r of rows) {
      if (["money", "number"].includes(r.field.type)) {
        problems.push(
          `${r.field.label} cannot be grouped by. Move it to Values to calculate it.`,
        );
      }
    }
  }
  if (detail && rows.length > LIMITS.MAX_DETAIL_COLUMNS) {
    problems.push(`A detail report may show at most ${LIMITS.MAX_DETAIL_COLUMNS} columns.`);
  }
  if (!detail && values.length === 0) {
    problems.push("A summary report needs at least one field in Values.");
  }
  if (rows.length === 0 && columns.length === 0 && values.length === 0) {
    problems.push("The report is empty.");
  }

  /* ── Sort ──────────────────────────────────────────────────────────────── */
  const sort = [];
  const rawSort = Array.isArray(raw.sort) ? raw.sort : [];
  if (rawSort.length > LIMITS.MAX_SORTS) {
    problems.push(`A report may be sorted by at most ${LIMITS.MAX_SORTS} columns.`);
  }
  for (const s of rawSort.slice(0, LIMITS.MAX_SORTS)) {
    if (!isPlainObject(s)) {
      problems.push("The sort is not an object.");
      continue;
    }
    unknownKeys(s, ALLOWED_KEYS.sort, "The sort", problems);
    const def = catalogue.fieldOf(s.field);
    if (!def) {
      problems.push(`"${String(s.field).slice(0, 40)}" is not a field.`);
      continue;
    }
    if (!["asc", "desc"].includes(s.direction)) {
      problems.push(`"${String(s.direction).slice(0, 20)}" is not a sort direction.`);
      continue;
    }
    /* Sorting by something the report does not show produces an order nobody
       can explain from what is on screen. */
    const sortable = detail
      ? rows.map((r) => r.field.id)
      : [...rows.map((r) => r.field.id), ...values.map((v) => v.field.id)];
    if (!sortable.includes(def.id)) {
      problems.push(`${def.label} is not in this report, so it cannot be sorted by.`);
      continue;
    }
    sort.push({ field: def, direction: s.direction });
  }

  /* ── Limit ─────────────────────────────────────────────────────────────── */
  let limit;
  if (mode === "export") {
    limit = LIMITS.MAX_EXPORT_ROWS;
  } else {
    const asked = raw.limit === undefined || raw.limit === null ? LIMITS.MAX_PREVIEW_ROWS : raw.limit;
    const n = Number(asked);
    if (!Number.isInteger(n) || n < 1) {
      problems.push("The preview row limit must be a whole number of at least 1.");
      limit = LIMITS.MAX_PREVIEW_ROWS;
    } else {
      limit = Math.min(n, LIMITS.MAX_PREVIEW_ROWS);
    }
  }

  const name = raw.name === undefined || raw.name === null
    ? "Untitled report"
    : safeText(raw.name, LIMITS.MAX_NAME);
  if (name === null) {
    problems.push(`A report name must be text of at most ${LIMITS.MAX_NAME} characters.`);
  }

  if (problems.length) throw new LayoutError(problems);

  return {
    name,
    companyIds,
    rows,
    columns,
    values,
    filters,
    comparisons,
    sort,
    showRowTotals: raw.showRowTotals !== false,
    showColumnTotals: raw.showColumnTotals !== false,
    showGrandTotal: raw.showGrandTotal !== false,
    limit,
    mode: detail ? "detail" : "summary",
    requestMode: mode,
  };
}

const SHELF_LABEL = {
  rows: "Rows", columns: "Columns", values: "Values",
  filters: "Filters", comparisons: "Compare",
};

/**
 * The stored form: safe identifiers only, versioned.
 *
 * Rebuilt from validated descriptors, so what reaches Mongo is what the server
 * understood — never the caller's object.
 */
function toStoredLayout(v) {
  /* `schemaVersion` is NOT in here. It is a property of the DOCUMENT, and the
     document already carries it — putting it inside the layout too meant the
     stored object no longer validated as a layout, so every saved report came
     back stale with "unrecognised property schemaVersion". One fact, one
     place. */
  return {
    rows: v.rows.map((r) => ({ field: r.field.id, heading: r.heading })),
    columns: v.columns.map((c) => ({ field: c.field.id, heading: c.heading })),
    values: v.values.map((x) => ({ field: x.field.id, heading: x.heading, calculation: x.calculation })),
    filters: v.filters.map((f) => ({ field: f.field.id, operation: f.operation, value: f.value })),
    comparisons: v.comparisons.map((c) => ({
      field: c.field.id, mode: c.mode, display: c.display, with: c.with,
    })),
    sort: v.sort.map((s) => ({ field: s.field.id, direction: s.direction })),
    showRowTotals: v.showRowTotals,
    showColumnTotals: v.showColumnTotals,
    showGrandTotal: v.showGrandTotal,
  };
}

/** A one-line description of a layout, for the saved list. */
function layoutSummary(v) {
  const rows = v.rows.map((r) => r.heading);
  const cols = v.columns.map((c) => c.heading);
  if (v.mode === "detail") {
    return rows.length ? `Detail: ${rows.join(", ")}` : "Detail report";
  }
  const values = v.values.map((x) => x.heading);
  if (rows.length && cols.length) return `${rows.join(" / ")} by ${cols.join(" / ")}`;
  if (rows.length) return `${values.join(", ")} by ${rows.join(" / ")}`;
  if (cols.length) return `${values.join(", ")} by ${cols.join(" / ")}`;
  return values.join(", ") || "Empty report";
}

module.exports = {
  LIMITS,
  ALLOWED_KEYS,
  SHELF_LABEL,
  LayoutError,
  validateLayout,
  toStoredLayout,
  layoutSummary,
  safeText,
};
