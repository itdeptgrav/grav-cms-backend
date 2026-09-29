// test/accountant/reporting-mutation.test.js
//
// DOES THE SUITE ACTUALLY HOLD ANYTHING UP?
//
// A green suite proves the code passes its tests. It does not prove the tests
// would notice if the code stopped doing the one thing that matters. So each
// test here BREAKS a guarantee on purpose — in a throwaway copy of the module,
// never in the real one — and fails if the assertion that is supposed to catch
// it still passes.
//
// Three guarantees are covered, because these are the three whose absence is
// invisible in every other way: the tenant filters (wrong company's money),
// the compatibility check (a meaningless total nobody can tell is meaningless)
// and placement validation (a field used where it cannot be used).
"use strict";

process.env.TEST_WITHOUT_MONGO = "1";

const fs = require("fs");
const path = require("path");

const SERVICES = path.join(__dirname, "..", "..", "services", "reporting");
const written = [];

/**
 * A copy of a module with `edits` applied, required fresh.
 *
 * The copy is written BESIDE the original rather than in a temp directory,
 * because the module's own `require("./fieldCatalogue")` has to keep resolving
 * — a mutant that fails to load would "pass" every one of these tests for
 * entirely the wrong reason.
 */
function mutate(file, edits) {
  const source = fs.readFileSync(path.join(SERVICES, file), "utf8");
  let mutated = source;
  for (const [find, replace] of edits) {
    if (!mutated.includes(find)) {
      throw new Error(
        `Mutation target not found in ${file}:\n${find}\n` +
        "The code moved. Re-point the mutation — do not delete the test.",
      );
    }
    mutated = mutated.replace(find, replace);
  }
  expect(mutated).not.toBe(source);

  const target = path.join(SERVICES, `__mutant_${Date.now()}_${written.length}__.js`);
  fs.writeFileSync(target, mutated);
  written.push(target);
  return require(target);
}

afterAll(() => {
  for (const f of written) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
});

/** The assertion under examination must pass for the real module... */
const survives = (fn) => expect(fn).not.toThrow();
/** ...and must FAIL for the mutant. */
const kills = (fn) => expect(fn).toThrow();

const catalogue = require("../../services/reporting/fieldCatalogue");
const realCompiler = require("../../services/reporting/mbqlCompiler");
const { validateLayout } = require("../../services/reporting/reportLayout.validate");

const ORG = "org-1";
const COMPANIES = ["company-a"];
const FIELD_IDS = Object.fromEntries(
  [...catalogue.FIELDS.map((f) => f.column), "organization_id", "company_id"]
    .map((c, i) => [c, 6000 + i]),
);
/* The same shape `metabaseEngine.resolveView` hands the compiler. */
const RESOLVED = { databaseId: 2, tableId: 1, fieldIds: FIELD_IDS };
const LAYOUT = {
  companyIds: COMPANIES,
  rows: [{ field: "ledger.group" }],
  columns: [{ field: "date.month" }],
  values: [{ field: "amount.debit", calculation: "total" }],
  filters: [{ field: "date.voucher", operation: "between", value: ["2025-08-01", "2025-10-31"] }],
};
const validated = () => validateLayout(LAYOUT, { approvedCompanyIds: COMPANIES });

/** Every query the CHART path would run — there is only ever one. */
const chartQuery = (compiler, layout) => compiler.compileChartQuery({
  layout, resolved: { databaseId: 2, tableId: 1, fieldIds: FIELD_IDS },
  organizationId: ORG, companyIds: COMPANIES,
});

/** Every query in a plan, flattened — the totals and subtotals included. */
const everyQuery = (plan) => [
  plan.main, plan.rowTotals, plan.colTotals, plan.grand,
  ...(plan.subtotals || []), ...(plan.comparison || []).map((c) => c.query),
].filter(Boolean);

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. THE TENANT FILTERS
 * ══════════════════════════════════════════════════════════════════════════ */

describe("removing a tenant filter is caught", () => {
  /** The assertion the real suite makes: both clauses, in every query. */
  function assertScoped(compiler) {
    const plan = compiler.compilePlan({
      layout: validated(), resolved: RESOLVED, organizationId: ORG, companyIds: COMPANIES,
    });
    const queries = everyQuery(plan);
    expect(queries.length).toBeGreaterThan(1);
    for (const q of queries) {
      const filters = JSON.stringify(q.query.filter);
      expect(filters).toContain(String(FIELD_IDS.organization_id));
      expect(filters).toContain(String(FIELD_IDS.company_id));
      expect(filters).toContain(ORG);
      expect(filters).toContain(COMPANIES[0]);
    }
  }

  test("the real compiler scopes every query it emits", () => {
    survives(() => assertScoped(realCompiler));
  });

  test("DROPPING BOTH TENANT FILTERS FAILS THE ASSERTION", () => {
    const m = mutate("mbqlCompiler.js", [[
      `  return [
    ["=", ref(orgId), String(organizationId)],
    ["=", ref(coId), ...companyIds.map(String)],
  ];`,
      "  return [];",
    ]]);
    kills(() => assertScoped(m));
  });

  test("DROPPING ONLY THE COMPANY FILTER ALSO FAILS", () => {
    /* The mutant that would survive a lazy assertion: the organisation clause
       is still there, so a test that merely looked for "a tenant filter" would
       pass while every company in the organisation leaked into the figures. */
    const m = mutate("mbqlCompiler.js", [[
      `    ["=", ref(coId), ...companyIds.map(String)],\n`, "",
    ]]);
    kills(() => assertScoped(m));
  });

  test("THE CHART'S SINGLE QUERY IS SCOPED TOO", () => {
    /* A chart is one question and one query, and it is the query a browser
       renders directly. If anything were going to be given a shortcut past the
       tenant filters, it would be this. */
    const assertChartScoped = (compiler) => {
      for (const layout of [
        validated(),
        validateLayout({
          companyIds: COMPANIES,
          rows: [{ field: "ledger.group" }],
          values: [{ field: "amount.debit", calculation: "total" }],
          comparisons: [{ field: "amount.debit", mode: "previous_period", display: "difference" }],
          filters: [{ field: "date.voucher", operation: "between", value: ["2025-08-01", "2025-10-31"] }],
        }, { approvedCompanyIds: COMPANIES }),
      ]) {
        const filters = JSON.stringify(chartQuery(compiler, layout).query.filter);
        expect(filters).toContain(String(FIELD_IDS.organization_id));
        expect(filters).toContain(String(FIELD_IDS.company_id));
        expect(filters).toContain(ORG);
        expect(filters).toContain(COMPANIES[0]);
      }
    };

    survives(() => assertChartScoped(realCompiler));

    kills(() => assertChartScoped(mutate("mbqlCompiler.js", [[
      `  return [
    ["=", ref(orgId), String(organizationId)],
    ["=", ref(coId), ...companyIds.map(String)],
  ];`,
      "  return [];",
    ]])));

    kills(() => assertChartScoped(mutate("mbqlCompiler.js", [[
      `    ["=", ref(coId), ...companyIds.map(String)],\n`, "",
    ]])));
  });

  test("A COMPARISON CHART CANNOT WIDEN ITS WAY OUT OF THE COMPANY FILTER", () => {
    /* The comparison query is the one that deliberately widens a filter — the
       date one. A mutation that widened the COMPANY filter the same way would
       look like the same kind of change and would be a cross-tenant leak. */
    const m = mutate("mbqlCompiler.js", [[
      "const query = buildQuery({\n    resolved, organizationId, companyIds, filters, breakout, orderBy, limit,",
      "const query = buildQuery({\n    resolved, organizationId, companyIds: [...companyIds, \"6ab1459d11fca003ca6f6062\"], filters, breakout, orderBy, limit,",
    ]]);
    const layout = validateLayout({
      companyIds: COMPANIES,
      rows: [{ field: "ledger.group" }],
      values: [{ field: "amount.debit", calculation: "total" }],
      comparisons: [{ field: "amount.debit", mode: "previous_period", display: "difference" }],
      filters: [{ field: "date.voucher", operation: "between", value: ["2025-08-01", "2025-10-31"] }],
    }, { approvedCompanyIds: COMPANIES });

    kills(() => {
      const companyClause = chartQuery(m, layout).query.filter[2];
      // Exactly the companies the guard approved, and no others.
      expect(companyClause.slice(2)).toEqual(COMPANIES);
    });
    survives(() => {
      const companyClause = chartQuery(realCompiler, layout).query.filter[2];
      expect(companyClause.slice(2)).toEqual(COMPANIES);
    });
  });

  test("SCOPING ONLY THE MAIN QUERY, AND NOT THE TOTALS, ALSO FAILS", () => {
    /* The subtlest one: the body of the matrix is correct and only the totals
       row is another company's money — which is exactly the bug that would be
       shipped by scoping at the one call site that was easy to see. */
    const m = mutate("mbqlCompiler.js", [[
      "function tenantFilters(fieldIds, { organizationId, companyIds }) {",
      `let __calls = 0;
function tenantFilters(fieldIds, { organizationId, companyIds }) {
  if (__calls++ > 0) return [];`,
    ]]);
    kills(() => assertScoped(m));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. THE COMPATIBILITY CHECK
 * ══════════════════════════════════════════════════════════════════════════ */

describe("removing the compatibility check is caught", () => {
  /* The live catalogue is a single grain and declares no clashes, so a
     mutation test on it would be vacuous — nothing to refuse means nothing to
     stop refusing. The grain split the mechanism exists for is injected here:
     a voucher-header total that may be combined with header fields only. */
  const withGrains = () => {
    const real = jest.requireActual("../../services/reporting/fieldCatalogue");
    const header = {
      ...real.fieldOf("amount.debit"),
      id: "amount.voucher_total", column: "voucher_total", label: "Voucher Total",
      compatibleWith: ["date.voucher", "voucher.number", "amount.voucher_total"],
    };
    /* Only the header field declares a list. Ledger Group stays exactly as the
       live catalogue has it — unrestricted — because that is the pairing an
       asymmetric check gets WRONG: asked "(unrestricted, restricted)" it looks
       only at the first field, finds no list, and says yes. */
    const FIELDS = [...real.FIELDS, header];
    return { ...real, FIELDS, fieldOf: (id) => FIELDS.find((f) => f.id === id) || null };
  };

  /* THE SAME CLASH, DRAGGED IN BOTH ORDERS. One layout would not do: the
     fields are checked in shelf order, so a single order lets a check that
     reads only its first argument pass while the other order is refused. */
  const LINE_THEN_HEADER = {
    companyIds: COMPANIES,
    rows: [{ field: "ledger.group" }],
    values: [{ field: "amount.voucher_total", calculation: "total" }],
  };
  // Detail mode (no values, no columns), which is what lets a money field sit
  // in Rows and puts the header field first.
  const HEADER_THEN_LINE = {
    companyIds: COMPANIES,
    rows: [{ field: "amount.voucher_total" }, { field: "ledger.group" }],
  };

  /** The assertion: a cross-grain layout is refused, and says so plainly. */
  function assertRefusesCrossGrain(validate) {
    for (const layout of [LINE_THEN_HEADER, HEADER_THEN_LINE]) {
      let error = null;
      try { validate(layout, { approvedCompanyIds: COMPANIES }); } catch (e) { error = e; }
      expect(error).not.toBeNull();
      expect(error.message).toMatch(/cannot be combined/i);
      // And never leaks the reason: no tables, joins, grains or columns.
      expect(error.message).not.toMatch(/\b(grain|join|table|voucher_total|group_name)\b/);
    }
  }

  const loadValidatorWith = (mockCatalogue) => {
    let validate;
    jest.isolateModules(() => {
      jest.doMock("../../services/reporting/fieldCatalogue", () => mockCatalogue);
      validate = require("../../services/reporting/reportLayout.validate").validateLayout;
    });
    jest.dontMock("../../services/reporting/fieldCatalogue");
    return validate;
  };

  test("the real validator refuses a cross-grain layout", () => {
    survives(() => assertRefusesCrossGrain(loadValidatorWith(withGrains())));
  });

  test("MAKING EVERYTHING COMPATIBLE FAILS THE ASSERTION", () => {
    kills(() => assertRefusesCrossGrain(
      loadValidatorWith({ ...withGrains(), mutuallyCompatible: () => true }),
    ));
  });

  test("CHECKING ONE DIRECTION ONLY FAILS THE ASSERTION", () => {
    /* The asymmetric mutant: it still refuses SOME pairs, so the feature looks
       alive. It refuses them depending on the order the user dragged fields
       in, which is the least reproducible bug on the list. */
    const base = withGrains();
    kills(() => assertRefusesCrossGrain(loadValidatorWith({
      ...base,
      mutuallyCompatible: (a, b) =>
        !Array.isArray(a.compatibleWith) || a.compatibleWith.includes(b.id),
    })));
  });

  test("and the one-sided mutant is caught by the symmetry test too", () => {
    const oneSided = (a, b) => !Array.isArray(a.compatibleWith) || a.compatibleWith.includes(b.id);
    const A = { id: "a.one", compatibleWith: null };
    const restricted = { id: "c.three", compatibleWith: ["z.other"] };
    survives(() => {
      expect(catalogue.mutuallyCompatible(A, restricted)).toBe(false);
      expect(catalogue.mutuallyCompatible(restricted, A)).toBe(false);
    });
    kills(() => {
      expect(oneSided(A, restricted)).toBe(false);
      expect(oneSided(restricted, A)).toBe(false);
    });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. PLACEMENT VALIDATION
 * ══════════════════════════════════════════════════════════════════════════ */

describe("removing placement validation is caught", () => {
  /** The assertion: the descriptor decides where a field may go. */
  function assertPlacementEnforced(validate) {
    // Narration is text with no `columns` placement: it would make one column
    // per distinct sentence.
    expect(() => validate(
      { ...LAYOUT, columns: [{ field: "voucher.narration" }] },
      { approvedCompanyIds: COMPANIES },
    )).toThrow(/cannot go in Columns/i);

    // A money field cannot be grouped by in a summary.
    expect(() => validate(
      { ...LAYOUT, rows: [{ field: "amount.debit" }] },
      { approvedCompanyIds: COMPANIES },
    )).toThrow(/cannot be grouped by/i);

    // And a field with no `filters` placement cannot be filtered on.
    expect(() => validate(
      { ...LAYOUT, filters: [{ field: "amount.signed", operation: "is", value: 1 }] },
      { approvedCompanyIds: COMPANIES },
    )).toThrow();
  }

  test("the real validator enforces placements", () => {
    survives(() => assertPlacementEnforced(validateLayout));
  });

  test("ACCEPTING ANY SHELF FOR ANY FIELD FAILS THE ASSERTION", () => {
    const m = mutate("reportLayout.validate.js", [[
      `      if (!def.placements.includes(key)) {`,
      `      if (false && !def.placements.includes(key)) {`,
    ]]);
    kills(() => assertPlacementEnforced(m.validateLayout));
  });

  test("ALLOWING MONEY TO BE GROUPED BY FAILS THE ASSERTION", () => {
    const m = mutate("reportLayout.validate.js", [[
      `      if (["money", "number"].includes(r.field.type)) {`,
      `      if (false) {`,
    ]]);
    kills(() => assertPlacementEnforced(m.validateLayout));
  });

  test("TRUSTING THE REQUEST'S OWN FIELD DESCRIPTOR FAILS THE ASSERTION", () => {
    /* The mutation that matters most, because it is the one a reasonable
       person might write: take the descriptor from the request when it has
       one, "to save a lookup". The browser then grants itself every placement
       it likes — and names a column while it is there. */
    const m = mutate("reportLayout.validate.js", [[
      `      const def = catalogue.fieldOf(entry.field);`,
      `      const def = entry.__field || catalogue.fieldOf(entry.field);`,
    ]]);
    kills(() => {
      expect(() => m.validateLayout(
        {
          ...LAYOUT,
          columns: [{
            field: "voucher.narration",
            __field: { ...catalogue.fieldOf("voucher.narration"), placements: ["columns"] },
          }],
        },
        { approvedCompanyIds: COMPANIES },
      )).toThrow(/cannot go in Columns/i);
    });
  });
});
