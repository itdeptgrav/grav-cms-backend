// test/accountant/reporting-layout.test.js
//
// THE CATALOGUE, THE LAYOUT VALIDATOR, THE COMPILER AND THE MATRIX.
//
// No database and no network — every one of these is a pure function of its
// input, which is what makes it worth being exhaustive: the interesting cases
// are hostile inputs and awkward shapes, and there are a lot of both.
//
// The load-bearing assertions:
//   • no field id is a column name, and no column name appears in the payload
//   • every compiled query carries the organisation and company filters
//   • an unsafe grain combination is refused, symmetrically
//   • a matrix row's cells align with `leafColumns`, always
//   • months are chronological, never alphabetical
//   • a percentage change from zero is null, never Infinity
"use strict";

process.env.TEST_WITHOUT_MONGO = "1";

const catalogue = require("../../services/reporting/fieldCatalogue");
const {
  validateLayout, toStoredLayout, layoutSummary, LayoutError, LIMITS,
} = require("../../services/reporting/reportLayout.validate");
const {
  compilePlan, previousPeriod, previousYear,
} = require("../../services/reporting/mbqlCompiler");
const matrix = require("../../services/reporting/matrix");

const ORG = "6a073de21fecacc9bb714481";
const CO = "6a08040a1fecacc9bb7149c2";
const CO2 = "6ab1459d11fca003ca6f6062";

/** Fake Metabase ids, as `resolveView` would return them. */
function resolved() {
  const fieldIds = {};
  let next = 1000;
  for (const column of catalogue.allColumns()) fieldIds[column] = (next += 1);
  return { databaseId: 7, tableId: 42, fieldIds };
}
const idOf = (column) => resolved().fieldIds[column];

const layout = (raw, approved = [CO]) =>
  validateLayout(raw, { approvedCompanyIds: approved });

const plan = (raw, { organizationId = ORG, companyIds = [CO] } = {}) => {
  const l = layout(raw, companyIds);
  return compilePlan({ layout: l, resolved: resolved(), organizationId, companyIds, limit: l.limit });
};

/** Every `["=", ["field", N, null], ...values]` in a filter tree. */
function equalityFilters(node, out = []) {
  if (!Array.isArray(node)) return out;
  if (node[0] === "=" && Array.isArray(node[1]) && node[1][0] === "field") {
    out.push({ fieldId: node[1][1], values: node.slice(2) });
  }
  for (const child of node) if (Array.isArray(child)) equalityFilters(child, out);
  return out;
}

const BASE = {
  name: "R",
  companyIds: [CO],
  rows: [{ field: "ledger.group", heading: "Ledger Group" }],
  columns: [{ field: "date.month", heading: "Month" }],
  values: [{ field: "amount.debit", heading: "Debit", calculation: "total" }],
  filters: [{ field: "date.voucher", operation: "between", value: ["2025-08-01", "2025-10-31"] }],
};

/* ═══════════════════════════════════════════════════════════════════════════
 * The flat catalogue
 * ══════════════════════════════════════════════════════════════════════════ */

describe("the flat field catalogue", () => {
  const pub = catalogue.publicCatalogue();

  test("IT IS FLAT — one `fields` list, no subjects and no templates", () => {
    expect(Object.keys(pub).sort()).toEqual(["fields", "grain"]);
    expect(Array.isArray(pub.fields)).toBe(true);
    expect(pub.subjects).toBeUndefined();
    expect(JSON.stringify(pub)).not.toMatch(/subject|template|report[ _-]?type/i);
  });

  test("NO FIELD ID IS A DATABASE COLUMN NAME", () => {
    const columns = new Set(catalogue.allColumns());
    for (const f of pub.fields) {
      expect(columns.has(f.id)).toBe(false);
      // Opaque semantic ids: `namespace.name`.
      expect(f.id).toMatch(/^[a-z]+\.[a-z_]+$/);
    }
  });

  test("the ids the task named are the ids offered", () => {
    const ids = pub.fields.map((f) => f.id);
    for (const id of ["date.voucher", "ledger.name", "ledger.group", "amount.debit", "amount.credit"]) {
      expect(ids).toContain(id);
    }
  });

  test("NO MART COLUMN APPEARS ANYWHERE IN THE PAYLOAD", () => {
    const serialised = JSON.stringify(pub);
    /* One exemption, and it is a word rather than a reference: the semantic
       vocabulary calls the Indian April-to-March period `financial_year`,
       which is also what the mart's column happens to be called. The concept
       has one name in English and the catalogue is entitled to use it — what
       must not exist is a FIELD ID that resolves to a column, and
       `fieldOf("financial_year")` is still null (asserted below). */
    const CONCEPT_WORDS = new Set(["financial_year"]);
    for (const column of catalogue.allColumns()) {
      if (CONCEPT_WORDS.has(column)) continue;
      expect(serialised).not.toContain(`"${column}"`);
    }
    for (const word of CONCEPT_WORDS) {
      expect(catalogue.fieldOf(word)).toBeNull();
    }
    /* The ones the task called out by name. `ledger_group` was on this list
       and is not a column — the column is `group_name` — so it was checking a
       string the mart does not use; it is now a semantic type, which is the
       business concept and not a source reference. */
    for (const column of ["voucher_date", "group_name", "signed_amount", "company_id", "organization_id"]) {
      expect(serialised).not.toContain(column);
    }
  });

  test("it never exposes a restricted field", () => {
    const text = JSON.stringify(pub).toLowerCase();
    for (const forbidden of [
      "gstin", "pan", "tan", "cin", "ifsc", "password", "token",
      "account_number", "bankdetails", "attachment", "consent", "source_id",
    ]) {
      expect(text).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
  });

  test("every field declares the full contract shape", () => {
    for (const f of pub.fields) {
      expect(typeof f.label).toBe("string");
      expect(f.label).not.toMatch(/_/);
      expect(Object.values(catalogue.TYPES)).toContain(f.type);
      expect(typeof f.description).toBe("string");
      expect(Array.isArray(f.placements)).toBe(true);
      expect(f.placements.every((p) => catalogue.SHELVES.includes(p))).toBe(true);
      expect(Array.isArray(f.calculations)).toBe(true);
      expect(Array.isArray(f.filterOperations)).toBe(true);
      expect(f.comparisons === null || Array.isArray(f.comparisons.modes)).toBe(true);
      expect(f.compatibleWith === null || Array.isArray(f.compatibleWith)).toBe(true);
      expect(Number.isFinite(f.defaultWidth)).toBe(true);
    }
  });

  test("ONLY THE COMPARISON MODES THE SERVER CAN ACTUALLY BUILD ARE ADVERTISED", () => {
    /* Offering a mode the compiler cannot build means a user constructs a
       report that fails when they refresh it — which reads as our bug rather
       than as an unavailable feature. */
    for (const f of pub.fields) {
      if (!f.comparisons) continue;
      for (const m of f.comparisons.modes) {
        expect(catalogue.SUPPORTED_COMPARISON_MODES).toContain(m);
      }
      for (const d of f.comparisons.displays) {
        expect(catalogue.SUPPORTED_COMPARISON_DISPLAYS).toContain(d);
      }
    }
    // `other_field` is in the contract and is NOT implemented, so it is absent.
    const advertised = new Set(pub.fields.flatMap((f) => f.comparisons?.modes || []));
    expect(advertised.has("other_field")).toBe(false);
  });

  test("THE DUPLICATING FIELDS ARE WITHHELD, and the reason is recorded", () => {
    const ids = catalogue.publicCatalogue().fields.map((f) => f.id);
    const columns = catalogue.FIELDS.map((f) => f.column);
    for (const w of catalogue.WITHHELD) {
      expect(columns).not.toContain(w.column);
      expect(typeof w.reason).toBe("string");
    }
    // Specifically the two the task named.
    expect(columns).not.toContain("grand_total");
    expect(columns).not.toContain("opening_balance");
    expect(ids.join(" ")).not.toMatch(/grand|opening/i);
  });

  test("the tenant columns are not fields — there is no id that names them", () => {
    const columns = catalogue.FIELDS.map((f) => f.column);
    expect(columns).not.toContain("organization_id");
    expect(columns).not.toContain("company_id");
    expect(catalogue.fieldOf("company_id")).toBeNull();
    expect(catalogue.fieldOf("organization_id")).toBeNull();
  });

  test("a lookup on an unknown or hostile id is null, never a column", () => {
    for (const id of ["voucher_date", "gstin", "../../etc/passwd", "", null, 42, {}]) {
      expect(catalogue.fieldOf(id)).toBeNull();
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Compatibility, symmetric
 * ══════════════════════════════════════════════════════════════════════════ */

describe("compatibility is symmetric", () => {
  const A = { id: "a.one", label: "A", compatibleWith: null };
  const B = { id: "b.two", label: "B", compatibleWith: null };

  test("a field with no list is compatible with everything", () => {
    expect(catalogue.mutuallyCompatible(A, B)).toBe(true);
    expect(catalogue.mutuallyCompatible(B, A)).toBe(true);
  });

  test("A ONE-SIDED DECLARATION REFUSES IN BOTH DIRECTIONS", () => {
    /* The bug this prevents: a pairing listed on one field and forgotten on the
       other lets the two in or out depending on which was added first — a
       defect that shows up for one user in one order and is never
       reproducible. */
    const restricted = { id: "c.three", label: "C", compatibleWith: ["a.one"] };
    expect(catalogue.mutuallyCompatible(restricted, B)).toBe(false);
    expect(catalogue.mutuallyCompatible(B, restricted)).toBe(false);
    expect(catalogue.mutuallyCompatible(restricted, A)).toBe(true);
    expect(catalogue.mutuallyCompatible(A, restricted)).toBe(true);
  });

  test("a field is always compatible with itself", () => {
    const r = { id: "c.three", compatibleWith: ["a.one"] };
    expect(catalogue.mutuallyCompatible(r, r)).toBe(true);
  });

  test("EVERY DECLARED PAIRING IN THE LIVE CATALOGUE IS DECLARED ON BOTH SIDES", () => {
    for (const f of catalogue.FIELDS) {
      if (!Array.isArray(f.compatibleWith)) continue;
      for (const otherId of f.compatibleWith) {
        const other = catalogue.fieldOf(otherId);
        expect(other).not.toBeNull();
        expect(catalogue.mutuallyCompatible(f, other)).toBe(true);
        expect(catalogue.mutuallyCompatible(other, f)).toBe(true);
      }
    }
  });

  test("AN UNSAFE GRAIN COMBINATION IS REFUSED BY THE VALIDATOR", () => {
    /* The live catalogue is one grain, so it declares no clashes — the
       mechanism is exercised against an injected pair standing in for the
       voucher-header/voucher-line split the task describes. */
    const header = { ...catalogue.fieldOf("amount.debit"), id: "amount.voucher_total",
      label: "Voucher Total", compatibleWith: ["date.voucher", "voucher.number"] };
    const line = catalogue.fieldOf("ledger.name");
    expect(catalogue.mutuallyCompatible(header, line)).toBe(false);
    expect(catalogue.mutuallyCompatible(line, header)).toBe(false);

    const safe = catalogue.fieldOf("date.voucher");
    expect(catalogue.mutuallyCompatible(header, safe)).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Layout validation
 * ══════════════════════════════════════════════════════════════════════════ */

describe("layout validation", () => {
  test("a valid pivot validates and is rebuilt from the catalogue", () => {
    const l = layout(BASE);
    expect(l.mode).toBe("summary");
    expect(l.rows[0].field.column).toBe("group_name");
    expect(l.values[0].calculation).toBe("total");
    expect(l.limit).toBe(LIMITS.MAX_PREVIEW_ROWS);
  });

  test("DETAIL MODE IS DECIDED BY THE LAYOUT, not by a flag", () => {
    const detail = layout({
      name: "D", companyIds: [CO],
      rows: [{ field: "date.voucher" }, { field: "voucher.number" }, { field: "amount.debit" }],
    });
    expect(detail.mode).toBe("detail");
    // One value is enough to make it a summary, with or without columns.
    expect(layout({ ...BASE, columns: [] }).mode).toBe("summary");

    /* Columns but no Values is a summary by the contract's rule — and a pivot
       with headings and no numbers in it renders nothing, so it is refused as
       an empty report rather than returned as a grid of blanks. */
    expect(() => layout({ ...BASE, values: [] })).toThrow(LayoutError);
    const err = (() => { try { layout({ ...BASE, values: [] }); } catch (e) { return e; } })();
    expect(err.problems[0]).toMatch(/needs at least one field in Values/i);
  });

  test("a field cannot go on a shelf its placements do not allow", () => {
    // Narration is not offered on Columns.
    expect(() => layout({ ...BASE, columns: [{ field: "voucher.narration" }] })).toThrow(LayoutError);
    // A text field cannot be a Value.
    expect(() => layout({ ...BASE, values: [{ field: "ledger.name", calculation: "total" }] })).toThrow(LayoutError);
    // A text field cannot be compared.
    expect(() => layout({ ...BASE, comparisons: [{ field: "ledger.name", mode: "previous_period", display: "difference" }] })).toThrow(LayoutError);
  });

  test("AN AMOUNT MAY BE A DETAIL COLUMN BUT NEVER A PIVOT GROUPING KEY", () => {
    /* Grouping by Debit makes one row per distinct amount, which is not a
       report and is indistinguishable from a bug. */
    expect(() => layout({
      name: "D", companyIds: [CO],
      rows: [{ field: "date.voucher" }, { field: "amount.debit" }],
    })).not.toThrow();

    expect(() => layout({ ...BASE, rows: [{ field: "amount.debit" }] })).toThrow(LayoutError);
    const err = (() => { try { layout({ ...BASE, rows: [{ field: "amount.debit" }] }); } catch (e) { return e; } })();
    expect(err.problems[0]).toMatch(/cannot be grouped by/i);
  });

  test("an unknown field is refused, including a real column name", () => {
    for (const field of ["voucher_date", "ledger_group", "signed_amount", "gstin", "company_id", "1; DROP TABLE x"]) {
      expect(() => layout({ ...BASE, rows: [{ field }] })).toThrow(LayoutError);
    }
  });

  test("UNKNOWN KEYS ARE REFUSED, not ignored", () => {
    for (const raw of [
      { ...BASE, sql: "SELECT 1" },
      { ...BASE, native: { query: "SELECT 1" } },
      { ...BASE, "source-table": 200 },
      { ...BASE, database: 2 },
      { ...BASE, query: { breakout: [] } },
      { ...BASE, rows: [{ field: "ledger.group", sql: "x" }] },
      { ...BASE, values: [{ field: "amount.debit", calculation: "total", raw: "x" }] },
      { ...BASE, filters: [{ field: "date.month", operation: "on", value: "2026-01-01", mbql: "x" }] },
    ]) {
      expect(() => layout(raw)).toThrow(LayoutError);
    }
  });

  test("an illegal calculation is refused", () => {
    expect(() => layout({ ...BASE, values: [{ field: "amount.debit", calculation: "median" }] })).toThrow(LayoutError);
    expect(() => layout({ ...BASE, values: [{ field: "amount.debit", calculation: "sum(1)" }] })).toThrow(LayoutError);
    // `count` on a text field IS offered.
    expect(() => layout({ ...BASE, values: [{ field: "amount.debit", calculation: "average" }] })).not.toThrow();
  });

  test("an illegal filter operation or value type is refused", () => {
    const bad = [
      { field: "date.month", operation: "contains", value: "x" },
      { field: "amount.debit", operation: "greater_than", value: "lots" },
      { field: "date.month", operation: "on", value: "01/01/2026" },
      { field: "date.month", operation: "on", value: "2026-02-31" },
      { field: "date.month", operation: "between", value: ["2026-03-01"] },
      { field: "date.month", operation: "between", value: ["2026-03-01", "2026-01-01"] },
      { field: "voucher.type", operation: "is", value: "not-a-type" },
      { field: "ledger.name", operation: "is", value: "x".repeat(LIMITS.MAX_VALUE_LENGTH + 1) },
      { field: "voucher.type", operation: "in", value: [] },
    ];
    for (const f of bad) expect(() => layout({ ...BASE, filters: [f] })).toThrow(LayoutError);
  });

  test("a comparison needs the field in Values and a date range", () => {
    const cmp = { field: "amount.debit", mode: "previous_period", display: "difference" };
    // Not in Values.
    expect(() => layout({ ...BASE, values: [{ field: "amount.credit", calculation: "total" }], comparisons: [cmp] })).toThrow(LayoutError);
    // No date range.
    expect(() => layout({ ...BASE, filters: [], comparisons: [cmp] })).toThrow(LayoutError);
    // Both present.
    expect(() => layout({ ...BASE, comparisons: [cmp] })).not.toThrow();
  });

  test("an other_company comparison must name an APPROVED company", () => {
    const make = (withValue, approved) => layout({
      ...BASE,
      comparisons: [{ field: "amount.debit", mode: "other_company", display: "difference", with: withValue }],
    }, approved);
    expect(() => make(null, [CO])).toThrow(LayoutError);
    expect(() => make(CO2, [CO])).toThrow(LayoutError);
    expect(() => make(CO2, [CO, CO2])).not.toThrow();
  });

  test("A LAYOUT NAMING AN UNAPPROVED COMPANY IS REFUSED OUTRIGHT", () => {
    expect(() => layout({ ...BASE, companyIds: [CO, CO2] }, [CO])).toThrow(LayoutError);
    // And a subset is never silently run.
    const err = (() => { try { layout({ ...BASE, companyIds: [CO, CO2] }, [CO]); } catch (e) { return e; } })();
    expect(err.problems[0]).toMatch(/did not approve/i);
  });

  test("bounds are enforced on every shelf", () => {
    const many = (n, field) => Array.from({ length: n }, () => ({ field }));
    expect(() => layout({ ...BASE, rows: many(LIMITS.MAX_ROWS + 1, "ledger.group") })).toThrow(LayoutError);
    expect(() => layout({ ...BASE, columns: many(LIMITS.MAX_COLUMNS + 1, "date.month") })).toThrow(LayoutError);
    expect(() => layout({ ...BASE, values: many(LIMITS.MAX_VALUES + 1, "amount.debit") })).toThrow(LayoutError);
    expect(() => layout({
      ...BASE,
      filters: Array.from({ length: LIMITS.MAX_FILTERS + 1 }, () => ({ field: "ledger.name", operation: "contains", value: "x" })),
    })).toThrow(LayoutError);
  });

  test("THE PREVIEW LIMIT IS CAPPED AT 100", () => {
    expect(layout({ ...BASE, limit: 100000 }).limit).toBe(100);
    expect(layout({ ...BASE, limit: 25 }).limit).toBe(25);
    expect(layout({ ...BASE, limit: null }).limit).toBe(100);
    expect(() => layout({ ...BASE, limit: 0 })).toThrow(LayoutError);
    expect(() => layout({ ...BASE, limit: 1.5 })).toThrow(LayoutError);
    const exported = validateLayout(BASE, { approvedCompanyIds: [CO], mode: "export" });
    expect(exported.limit).toBe(LIMITS.MAX_EXPORT_ROWS);
  });

  test("headings are bounded plain text", () => {
    expect(() => layout({ ...BASE, rows: [{ field: "ledger.group", heading: "x".repeat(200) }] })).toThrow(LayoutError);
    const l = layout({ ...BASE, rows: [{ field: "ledger.group", heading: "Group\nof\u0000heads" }] });
    expect(l.rows[0].heading).toBe("Group of heads");
  });

  test("a sort must name something the report shows", () => {
    expect(() => layout({ ...BASE, sort: [{ field: "party.name", direction: "asc" }] })).toThrow(LayoutError);
    expect(() => layout({ ...BASE, sort: [{ field: "ledger.group", direction: "asc" }] })).not.toThrow();
    expect(() => layout({ ...BASE, sort: [{ field: "ledger.group", direction: "sideways" }] })).toThrow(LayoutError);
  });

  test("the stored layout is versioned and carries safe ids only", () => {
    const stored = toStoredLayout(layout({ ...BASE, comparisons: [{ field: "amount.debit", mode: "previous_year", display: "difference" }] }));
    /* The version lives on the DOCUMENT, not inside the layout: a stored
       layout must still validate AS a layout when it is re-read, and an extra
       key in it fails the unknown-key rule that keeps SQL out. */
    expect(stored.schemaVersion).toBeUndefined();
    expect(() => validateLayout({ ...stored, name: "R", companyIds: [CO] }, { approvedCompanyIds: [CO] }))
      .not.toThrow();
    const serialised = JSON.stringify(stored);
    /* As a whole quoted value: a bare substring check fails on `amount.debit`
       containing the column `debit`, which is a test bug that reads exactly
       like a leak. */
    for (const column of catalogue.allColumns()) expect(serialised).not.toContain(`"${column}"`);
    expect(stored.rows[0].field).toBe("ledger.group");
    expect(stored.subject).toBeUndefined();
  });

  test("layoutSummary reads like the report", () => {
    expect(layoutSummary(layout(BASE))).toBe("Ledger Group by Month");
    expect(layoutSummary(layout({ ...BASE, columns: [] }))).toBe("Debit by Ledger Group");
    expect(layoutSummary(layout({ name: "D", companyIds: [CO], rows: [{ field: "date.voucher" }] })))
      .toMatch(/^Detail:/);
  });

  test("a refusal names the LABEL and never a column or internal", () => {
    const err = (() => { try { layout({ ...BASE, columns: [{ field: "voucher.narration" }] }); } catch (e) { return e; } })();
    const text = JSON.stringify(err.problems);
    expect(text).toContain("Narration");
    for (const column of catalogue.allColumns()) expect(text).not.toContain(column);
    expect(text.toLowerCase()).not.toContain("metabase");
    expect(text.toLowerCase()).not.toContain("reporting.");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE COMPILER — tenant filters on every query of every plan
 * ══════════════════════════════════════════════════════════════════════════ */

/** Every MBQL payload a plan will send. */
function everyQuery(p) {
  const out = [];
  const take = (q) => { if (q) out.push(q); };
  if (p.mode === "detail") { take(p.main); take(p.count); return out; }
  take(p.main); take(p.rowTotals); take(p.colTotals); take(p.grand);
  for (const s of p.subtotals || []) { take(s.cells); take(s.total); }
  for (const c of p.comparison || []) {
    take(c.main); take(c.rowTotals); take(c.colTotals); take(c.grand);
    for (const s of c.subtotals || []) { take(s.cells); take(s.total); }
  }
  return out;
}

describe("every compiled query carries both tenant filters", () => {
  const SHAPES = {
    "plain pivot": BASE,
    "detail list": { name: "D", companyIds: [CO], rows: [{ field: "date.voucher" }, { field: "amount.debit" }] },
    "two nested rows": { ...BASE, rows: [{ field: "ledger.group" }, { field: "ledger.name" }] },
    "three nested rows": { ...BASE, rows: [{ field: "ledger.group" }, { field: "ledger.name" }, { field: "party.name" }] },
    "two columns": { ...BASE, columns: [{ field: "date.month" }, { field: "voucher.type" }] },
    "two values": { ...BASE, values: [{ field: "amount.debit", calculation: "total" }, { field: "amount.credit", calculation: "average" }] },
    "many filters": { ...BASE, filters: [
      { field: "date.voucher", operation: "between", value: ["2025-08-01", "2025-10-31"] },
      { field: "ledger.name", operation: "contains", value: "Bank" },
      { field: "voucher.type", operation: "in", value: ["sales", "receipt"] },
    ] },
    "with a comparison": { ...BASE, comparisons: [{ field: "amount.debit", mode: "previous_period", display: "difference" }] },
    "no totals": { ...BASE, showRowTotals: false, showColumnTotals: false, showGrandTotal: false },
  };

  test.each(Object.entries(SHAPES))("%s", (_name, raw) => {
    const queries = everyQuery(plan(raw));
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      const eq = equalityFilters(q.query.filter);
      expect(eq).toContainEqual({ fieldId: idOf("organization_id"), values: [ORG] });
      expect(eq).toContainEqual({ fieldId: idOf("company_id"), values: [CO] });
      // And they are the FIRST two clauses, before anything the user asked for.
      expect(q.query.filter[0]).toBe("and");
      expect(q.query.filter[1]).toEqual(["=", ["field", idOf("organization_id"), null], ORG]);
      expect(q.query.filter[2]).toEqual(["=", ["field", idOf("company_id"), null], CO]);
    }
  });

  test("MULTIPLE COMPANIES BECOME ONE `IN`, over exactly the approved list", () => {
    const queries = everyQuery(plan({ ...BASE, companyIds: [CO, CO2] }, { companyIds: [CO, CO2] }));
    for (const q of queries) {
      expect(q.query.filter[2]).toEqual(["=", ["field", idOf("company_id"), null], CO, CO2]);
    }
  });

  test("A LAYOUT CANNOT REMOVE OR REPLACE THEM", () => {
    /* There is no field id that names either tenant column, so the only way to
       try is to invent one — which the validator refuses before the compiler
       is reached. Asserted end to end rather than assumed. */
    for (const raw of [
      { ...BASE, filters: [{ field: "company_id", operation: "is", value: CO2 }] },
      { ...BASE, filters: [{ field: "organization_id", operation: "is", value: "other" }] },
      { ...BASE, rows: [{ field: "company_id" }] },
      { ...BASE, filter: ["and"] },
    ]) {
      expect(() => plan(raw)).toThrow(LayoutError);
    }
  });

  test("a comparison's shifted query is scoped exactly as the main one is", () => {
    const p = plan({ ...BASE, comparisons: [{ field: "amount.debit", mode: "previous_year", display: "difference" }] });
    for (const q of everyQuery({ mode: "summary", main: null, subtotals: [], comparison: p.comparison })) {
      const eq = equalityFilters(q.query.filter);
      expect(eq).toContainEqual({ fieldId: idOf("organization_id"), values: [ORG] });
      expect(eq).toContainEqual({ fieldId: idOf("company_id"), values: [CO] });
    }
  });

  test("an other_company comparison scopes to THAT company, and only an approved one", () => {
    const p = plan(
      { ...BASE, companyIds: [CO, CO2],
        comparisons: [{ field: "amount.debit", mode: "other_company", display: "difference", with: CO2 }] },
      { companyIds: [CO, CO2] },
    );
    expect(p.comparison[0].main.query.filter[2]).toEqual(["=", ["field", idOf("company_id"), null], CO2]);
  });

  test("a missing organisation or company refuses rather than compiling", () => {
    expect(() => plan(BASE, { organizationId: null })).toThrow(/organisation/i);
    expect(() => plan(BASE, { companyIds: [] })).toThrow();
  });
});

describe("the compiled plan", () => {
  test("IS NEVER NATIVE SQL", () => {
    for (const raw of Object.values({ a: BASE, b: { name: "D", companyIds: [CO], rows: [{ field: "date.voucher" }] } })) {
      for (const q of everyQuery(plan(raw))) {
        expect(q.type).toBe("query");
        expect(q.native).toBeUndefined();
        const text = JSON.stringify(q);
        expect(text).not.toMatch(/\bselect\b/i);
        expect(text).not.toMatch(/\bnative\b/i);
      }
    }
  });

  test("rows come first in the breakout, then columns — the nesting order", () => {
    const p = plan({ ...BASE, rows: [{ field: "ledger.group" }, { field: "ledger.name" }],
      columns: [{ field: "date.month" }] });
    expect(p.main.query.breakout).toEqual([
      ["field", idOf("group_name"), null],
      ["field", idOf("ledger_name"), null],
      ["field", idOf("period_month"), null],
    ]);
  });

  test("values compile to the right aggregations, in order", () => {
    const p = plan({ ...BASE, values: [
      { field: "amount.debit", calculation: "total" },
      { field: "amount.credit", calculation: "average" },
      { field: "amount.signed", calculation: "maximum" },
    ] });
    expect(p.main.query.aggregation).toEqual([
      ["sum", ["field", idOf("debit"), null]],
      ["avg", ["field", idOf("credit"), null]],
      ["max", ["field", idOf("signed_amount"), null]],
    ]);
  });

  test("EVERY TOTAL IS ITS OWN AGGREGATE QUERY, at its own grain", () => {
    /* Not arithmetic on displayed values: an average of averages is not an
       average, and three of the five calculations offered are non-additive. */
    const p = plan({ ...BASE, rows: [{ field: "ledger.group" }, { field: "ledger.name" }] });
    expect(p.rowTotals.query.breakout).toEqual([
      ["field", idOf("group_name"), null], ["field", idOf("ledger_name"), null],
    ]);
    expect(p.colTotals.query.breakout).toEqual([["field", idOf("period_month"), null]]);
    expect(p.grand.query.breakout).toBeUndefined();
    expect(p.grand.query.aggregation).toHaveLength(1);
    // One subtotal level for two nested rows: grouped by the outer field alone.
    expect(p.subtotals).toHaveLength(1);
    expect(p.subtotals[0].cells.query.breakout).toEqual([
      ["field", idOf("group_name"), null], ["field", idOf("period_month"), null],
    ]);
    expect(p.subtotals[0].total.query.breakout).toEqual([["field", idOf("group_name"), null]]);
  });

  test("totals that were switched off are not queried for", () => {
    const p = plan({ ...BASE, showRowTotals: false, showColumnTotals: false, showGrandTotal: false });
    expect(p.rowTotals).toBeNull();
    expect(p.colTotals).toBeNull();
    expect(p.grand).toBeNull();
  });

  test("ordering is deterministic even when nothing was sorted", () => {
    const p = plan(BASE);
    expect(p.main.query["order-by"]).toEqual([
      ["asc", ["field", idOf("group_name"), null]],
      ["asc", ["field", idOf("period_month"), null]],
    ]);
    const d = plan({ name: "D", companyIds: [CO], rows: [{ field: "voucher.number" }, { field: "party.name" }] });
    expect(d.main.query["order-by"]).toEqual([["asc", ["field", idOf("voucher_number"), null]]]);
  });

  test("ROW LEVELS ORDER IN NESTING ORDER, each in its own direction", () => {
    /* Slice B3: the nesting order leads, not the order the sorts happen to be
       written in — level 0 has to come first or the groups interleave and a
       subtotal ends up describing rows that are not above it. */
    const p = plan({ ...BASE, rows: [{ field: "ledger.group" }, { field: "ledger.name" }],
      sort: [{ field: "ledger.name", direction: "desc" }] });
    expect(p.main.query["order-by"]).toEqual([
      ["asc", ["field", idOf("group_name"), null]],
      ["desc", ["field", idOf("ledger_name"), null]],
      ["asc", ["field", idOf("period_month"), null]],
    ]);
  });

  test("A SORT BY A CALCULATED VALUE REACHES THE QUERY", () => {
    /* And it sits BEFORE the deepest row level: the level is unique within its
       parent, so ordering by it first would settle every comparison before the
       figure was looked at, and the workbook would come back alphabetically
       while the sheet had it right. */
    const p = plan({ ...BASE, rows: [{ field: "ledger.group" }],
      sort: [{ field: "amount.debit", direction: "desc" }] });
    expect(p.main.query["order-by"]).toEqual([
      ["desc", ["aggregation", 0]],
      ["asc", ["field", idOf("group_name"), null]],
      ["asc", ["field", idOf("period_month"), null]],
    ]);
  });

  test("each filter operation compiles to the right MBQL", () => {
    const cases = [
      [{ field: "date.month", operation: "between", value: ["2026-01-01", "2026-03-31"] },
        ["between", ["field", idOf("period_month"), null], "2026-01-01", "2026-03-31"]],
      [{ field: "date.month", operation: "before", value: "2026-01-01" },
        ["<", ["field", idOf("period_month"), null], "2026-01-01"]],
      [{ field: "amount.debit", operation: "greater_than", value: "50" },
        [">", ["field", idOf("debit"), null], 50]],
      [{ field: "ledger.name", operation: "contains", value: "Bank" },
        ["contains", ["field", idOf("ledger_name"), null], "Bank", { "case-sensitive": false }]],
      [{ field: "ledger.name", operation: "starts_with", value: "HDFC" },
        ["starts-with", ["field", idOf("ledger_name"), null], "HDFC", { "case-sensitive": false }]],
      [{ field: "voucher.type", operation: "in", value: ["sales", "receipt"] },
        ["=", ["field", idOf("voucher_type"), null], "sales", "receipt"]],
    ];
    for (const [filter, expected] of cases) {
      const p = plan({ ...BASE, filters: [filter], comparisons: [] });
      expect(p.main.query.filter[3]).toEqual(expected);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Period shifting
 * ══════════════════════════════════════════════════════════════════════════ */

describe("period shifting", () => {
  test("the previous period is the SAME NUMBER OF DAYS, immediately before", () => {
    /* The semantic, stated explicitly because two reasonable ones exist.
       This is EQUAL-LENGTH, not calendar-aligned: the N days immediately
       before the N days selected. It is the only one that works for an
       arbitrary range — a user comparing 12–26 August has no "previous
       calendar period" — and it is exactly comparable, which a calendar
       alignment is not: Q2 is 91 days and Q1 is 90, so a calendar comparison
       would silently compare 91 days against 90. */
    expect(previousPeriod(["2026-08-01", "2026-08-31"])).toEqual(["2026-07-01", "2026-07-31"]);
    // A single day steps back one day.
    expect(previousPeriod(["2026-08-15", "2026-08-15"])).toEqual(["2026-08-14", "2026-08-14"]);
    // An arbitrary 15-day window, which has no calendar equivalent at all.
    expect(previousPeriod(["2026-08-12", "2026-08-26"])).toEqual(["2026-07-28", "2026-08-11"]);
  });

  test("a whole quarter steps back by ITS OWN length, not to the calendar quarter", () => {
    /* Apr–Jun is 91 days; the 91 days before it start on 31 December, not on
       1 January. That is the equal-length rule doing exactly what it says, and
       it is asserted so nobody "fixes" it into a calendar shift by accident. */
    expect(previousPeriod(["2026-04-01", "2026-06-30"])).toEqual(["2025-12-31", "2026-03-31"]);
    const [from, to] = previousPeriod(["2026-04-01", "2026-06-30"]);
    const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000) + 1;
    expect(days(from, to)).toBe(days("2026-04-01", "2026-06-30"));
  });

  test("the previous year is the same calendar dates, a year earlier", () => {
    expect(previousYear(["2026-08-01", "2026-08-31"])).toEqual(["2025-08-01", "2025-08-31"]);
    expect(previousYear(["2026-04-01", "2027-03-31"])).toEqual(["2025-04-01", "2026-03-31"]);
  });

  test("29 February lands on 28 February, not 1 March", () => {
    expect(previousYear(["2024-02-29", "2024-02-29"])).toEqual(["2023-02-28", "2023-02-28"]);
  });

  test("the shift replaces the date filter and leaves the others alone", () => {
    const p = plan({ ...BASE,
      filters: [
        { field: "date.voucher", operation: "between", value: ["2026-08-01", "2026-08-31"] },
        { field: "ledger.name", operation: "contains", value: "Bank" },
      ],
      comparisons: [{ field: "amount.debit", mode: "previous_period", display: "difference" }] });
    const shifted = p.comparison[0].main.query.filter;
    expect(shifted[3]).toEqual(["between", ["field", idOf("voucher_date"), null], "2026-07-01", "2026-07-31"]);
    expect(shifted[4]).toEqual(["contains", ["field", idOf("ledger_name"), null], "Bank", { "case-sensitive": false }]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE MATRIX
 * ══════════════════════════════════════════════════════════════════════════ */

describe("the matrix", () => {
  /** Metabase's flat answer for rows=[group], columns=[month], values=[debit]. */
  const FLAT = [
    ["Expenses", "2026-02-01", 200],
    ["Expenses", "2026-01-01", 100],
    ["Income", "2026-01-01", 500],
    ["Income", "2026-04-01", 900],
    ["Income", "2026-02-01", 700],
  ];
  const results = {
    main: FLAT,
    rowTotals: [["Expenses", 300], ["Income", 2100]],
    colTotals: [["2026-01-01", 600], ["2026-02-01", 900], ["2026-04-01", 900]],
    grand: [[2400]],
    subtotals: [],
  };
  const L = () => layout(BASE);

  const shape = (over = {}) =>
    matrix.shapeSummary({ layout: L(), results, dataAsOf: "2026-09-24T00:00:00.000Z", ...over });

  test("EVERY ROW'S CELLS ALIGN WITH leafColumns", () => {
    const m = shape();
    expect(m.leafColumns.length).toBeGreaterThan(0);
    for (const r of m.rows) expect(r.cells).toHaveLength(m.leafColumns.length);
    expect(m.grandTotal.cells).toHaveLength(m.leafColumns.length);
  });

  test("A MISSING CELL IS null, NOT SKIPPED", () => {
    /* A short array silently shifts every figure after it one column left,
       which is the worst possible way for this to fail. */
    const m = shape();
    const expenses = m.rows.find((r) => r.labels[0] === "Expenses");
    // Expenses has no April figure.
    expect(expenses.cells.map((c) => c.value)).toEqual([100, 200, null, 300]);
  });

  test("MONTHS ARE CHRONOLOGICAL, never alphabetical", () => {
    const m = shape();
    const monthLevel = m.columnLevels.find((l) => l.heading === "Month");
    /* Full month names since the semantic slice: a month's label is the
       month's own text, the same sentence its cells and keys carry. */
    expect(monthLevel.headers.map((h) => h.label))
      .toEqual(["January 2026", "February 2026", "April 2026", "Total"]);
    // The alphabetical order would be April, February, January — the giveaway.
    expect(monthLevel.headers[0].label).not.toBe("April 2026");
  });

  test("row order follows the field, and text sorts case-insensitively", () => {
    const m = matrix.shapeSummary({
      layout: L(),
      results: { ...results, main: [["zeta", "2026-01-01", 1], ["Alpha", "2026-01-01", 2]] },
      dataAsOf: null,
    });
    expect(m.rows.filter((r) => r.kind === "data").map((r) => r.labels[0])).toEqual(["Alpha", "zeta"]);
  });

  test("row totals, column totals and the grand total are the queried figures", () => {
    const m = shape();
    const income = m.rows.find((r) => r.labels[0] === "Income");
    expect(income.cells.at(-1).value).toBe(2100);
    const totalRow = m.rows.find((r) => r.kind === "total");
    expect(totalRow.cells.map((c) => c.value)).toEqual([600, 900, 900, 2400]);
    expect(m.grandTotal.cells.at(-1).value).toBe(2400);
  });

  test("totals switched off are absent", () => {
    const l = layout({ ...BASE, showRowTotals: false, showColumnTotals: false, showGrandTotal: false });
    const m = matrix.shapeSummary({
      layout: l,
      results: { main: FLAT, rowTotals: null, colTotals: null, grand: null, subtotals: [] },
      dataAsOf: null,
    });
    expect(m.leafColumns.some((c) => c.isTotal)).toBe(false);
    expect(m.rows.some((r) => r.kind === "total")).toBe(false);
    expect(m.grandTotal).toBeNull();
  });

  test("SUBTOTALS APPEAR AFTER EACH GROUP, from their own query", () => {
    const l = layout({ ...BASE, rows: [{ field: "ledger.group" }, { field: "ledger.name" }] });
    const m = matrix.shapeSummary({
      layout: l,
      results: {
        main: [
          ["Income", "Sales", "2026-01-01", 300],
          ["Income", "Other", "2026-01-01", 200],
          ["Expenses", "Rent", "2026-01-01", 50],
        ],
        rowTotals: [["Income", "Sales", 300], ["Income", "Other", 200], ["Expenses", "Rent", 50]],
        colTotals: [["2026-01-01", 550]],
        grand: [[550]],
        subtotals: [{
          depth: 0,
          prefix: [l.rows[0].field],
          cells: [["Income", "2026-01-01", 500], ["Expenses", "2026-01-01", 50]],
          total: [["Income", 500], ["Expenses", 50]],
        }],
      },
      dataAsOf: null,
    });

    const kinds = m.rows.map((r) => `${r.kind}:${r.labels[0]}`);
    expect(kinds).toEqual([
      "data:Expenses", "subtotal:Expenses total",
      "data:Income", "data:Income", "subtotal:Income total",
      "total:Total",
    ]);
    const sub = m.rows.find((r) => r.kind === "subtotal" && r.labels[0] === "Income total");
    // 500 — the subtotal query's figure, not 300+200 added up here.
    expect(sub.cells[0].value).toBe(500);
    for (const r of m.rows) expect(r.cells).toHaveLength(m.leafColumns.length);
  });

  test("detail mode is a plain aligned list", () => {
    const l = layout({ name: "D", companyIds: [CO],
      rows: [{ field: "date.voucher", heading: "Date" }, { field: "amount.debit", heading: "Debit" }] });
    const m = matrix.shapeDetail({
      layout: l, rows: [["2026-01-01", 100], ["2026-01-02", 200]],
      totalRowCount: 57, dataAsOf: null,
    });
    expect(m.mode).toBe("detail");
    expect(m.leafColumns.map((c) => c.heading)).toEqual(["Date", "Debit"]);
    expect(m.rows).toHaveLength(2);
    for (const r of m.rows) expect(r.cells).toHaveLength(2);
    expect(m.previewRowCount).toBe(2);
    expect(m.totalRowCount).toBe(57);
    expect(m.truncated).toBe(true);
    // A list has records, not groups, and says so rather than inventing one.
    expect(m.groupCount).toBeNull();
    expect(m.omitted).toEqual({ rows: 55, values: null });
    expect(m.grandTotal).toBeNull();
  });

  test("the user's Values order is preserved", () => {
    const l = layout({ ...BASE, values: [
      { field: "amount.credit", heading: "Credit", calculation: "total" },
      { field: "amount.debit", heading: "Debit", calculation: "total" },
    ] });
    const m = matrix.shapeSummary({
      layout: l,
      results: { main: [["Income", "2026-01-01", 5, 9]], rowTotals: [["Income", 5, 9]],
        colTotals: [["2026-01-01", 5, 9]], grand: [[5, 9]], subtotals: [] },
      dataAsOf: null,
    });
    expect(m.leafColumns.map((c) => c.heading)).toEqual(["Credit", "Debit", "Credit", "Debit"]);
    expect(m.rows[0].cells.map((c) => c.value)).toEqual([5, 9, 5, 9]);
  });

  test("dataAsOf is passed through untouched, including null", () => {
    expect(shape().dataAsOf).toBe("2026-09-24T00:00:00.000Z");
    expect(shape({ dataAsOf: null }).dataAsOf).toBeNull();
  });

  test("no private bookkeeping key escapes into leafColumns", () => {
    const m = shape();
    for (const c of m.leafColumns) {
      expect(Object.keys(c).some((k) => k.startsWith("_"))).toBe(false);
      /* `semanticType` and `display` joined the contract in slice B2; `type`
         stayed, so a client that reads only the old keys is unaffected. */
      expect(Object.keys(c).sort())
        .toEqual(["display", "heading", "id", "isComparison", "isTotal", "semanticType", "type"]);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Comparisons
 * ══════════════════════════════════════════════════════════════════════════ */

describe("comparisons", () => {
  test("DIVISION BY ZERO IS null, NEVER Infinity", () => {
    expect(matrix.comparisonValue(100, 0, "percentage_difference")).toBeNull();
    expect(matrix.comparisonValue(0, 0, "percentage_difference")).toBeNull();
    expect(matrix.comparisonValue(100, null, "percentage_difference")).toBeNull();
    for (const d of ["percentage_difference", "difference", "side_by_side"]) {
      const v = matrix.comparisonValue(100, 0, d);
      expect(Number.isFinite(v) || v === null).toBe(true);
    }
  });

  test("the arithmetic is right, and signed", () => {
    expect(matrix.comparisonValue(150, 100, "difference")).toBe(50);
    expect(matrix.comparisonValue(50, 100, "difference")).toBe(-50);
    expect(matrix.comparisonValue(150, 100, "percentage_difference")).toBe(50);
    expect(matrix.comparisonValue(50, 100, "percentage_difference")).toBe(-50);
    // A negative base compares by magnitude, so a move toward zero is positive.
    expect(matrix.comparisonValue(-50, -100, "percentage_difference")).toBe(50);
    expect(matrix.comparisonValue(150, 100, "side_by_side")).toBe(100);
  });

  test("both null is null, not zero", () => {
    expect(matrix.comparisonValue(null, null, "difference")).toBeNull();
    expect(matrix.comparisonValue(null, null, "side_by_side")).toBeNull();
  });

  test("a comparison becomes its own leaf column, marked", () => {
    const l = layout({ ...BASE, columns: [],
      comparisons: [{ field: "amount.debit", mode: "previous_period", display: "percentage_difference" }] });
    const m = matrix.shapeSummary({
      layout: l,
      results: { main: [["Income", 150]], rowTotals: null, colTotals: null, grand: [[150]], subtotals: [] },
      comparisonResults: [{ main: [["Income", 100]], rowTotals: null, colTotals: null, grand: [[100]], subtotals: [] }],
      dataAsOf: null,
    });
    const cmp = m.leafColumns.find((c) => c.isComparison);
    expect(cmp).toBeTruthy();
    expect(cmp.heading).toMatch(/% change vs previous period/);
    expect(m.rows[0].cells.map((c) => c.value)).toEqual([150, 50]);
  });

  test("every advertised mode has a heading, and none says 'undefined'", () => {
    for (const mode of catalogue.SUPPORTED_COMPARISON_MODES) {
      for (const display of catalogue.SUPPORTED_COMPARISON_DISPLAYS) {
        const h = matrix.comparisonHeading("Debit", { mode, display });
        expect(typeof h).toBe("string");
        expect(h).not.toMatch(/undefined|comparison$/);
        expect(h).toContain("Debit");
      }
    }
  });
});
