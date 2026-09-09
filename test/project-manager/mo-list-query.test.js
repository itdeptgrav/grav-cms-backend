// test/project-manager/mo-list-query.test.js
//
// Chunk 3A. The pure query policy behind the manufacturing-order register.
//
// These need no database and no HTTP server, which is the point of extracting
// them: the rules that decide what a URL is allowed to ask for are small,
// total, and worth pinning one case at a time. The route-level suite proves the
// same rules survive the aggregation; this one proves the rules themselves.
//
// Every deadline case names its own reference instant. Nothing here reads the
// wall clock, so none of it starts failing at midnight or in another timezone.
"use strict";

const {
  DISPLAY_STATUSES,
  PRIORITIES,
  DEADLINE_RISKS,
  DUE_SOON_DAYS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_PAGE,
  escapeRegex,
  normalisePagination,
  normaliseSearch,
  normaliseStatus,
  normalisePriority,
  normaliseDeadlineRisk,
  classifyDeadlineRisk,
  normaliseListQuery,
} = require("../../services/manufacturing/moListQuery");

const {
  searchMatch,
  buildListPipeline,
  projectRow,
} = require("../../services/manufacturing/moListProjection");

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-03T09:00:00Z");
const inDays = (n) => new Date(NOW.getTime() + n * DAY);

/* ═══ 1 · PAGINATION ══════════════════════════════════════════════════════ */

describe("pagination normalisation", () => {
  test("the defaults are the register's existing ones", () => {
    expect(normalisePagination({})).toEqual({ page: 1, limit: DEFAULT_LIMIT, skip: 0 });
    expect(DEFAULT_LIMIT).toBe(12);
  });

  test("a valid page and limit are used as given", () => {
    expect(normalisePagination({ page: 3, limit: 20 })).toEqual({ page: 3, limit: 20, skip: 40 });
    // Strings, because everything arrives from a query string.
    expect(normalisePagination({ page: "3", limit: "20" })).toEqual({ page: 3, limit: 20, skip: 40 });
  });

  test("every input that used to answer 500 resolves to a default", () => {
    // Each of these reached the database as a NaN skip or limit and threw.
    for (const bad of ["abc", "", " ", null, undefined, NaN, 0, -3, "-3", "0", {}, []]) {
      const { page, limit, skip } = normalisePagination({ page: bad, limit: bad });
      expect(page).toBe(1);
      expect(limit).toBe(DEFAULT_LIMIT);
      expect(skip).toBe(0);
    }
  });

  test("a fractional page size floors, as it always did", () => {
    expect(normalisePagination({ limit: "2.7" }).limit).toBe(2);
    expect(normalisePagination({ page: "2.9" }).page).toBe(2);
  });

  test("a page size beyond the maximum is clamped, not refused", () => {
    // Clamped rather than 400: no existing caller can break on it, and
    // `pagination.limit` reports what was actually applied.
    expect(normalisePagination({ limit: 1e9 }).limit).toBe(MAX_LIMIT);
    expect(normalisePagination({ limit: MAX_LIMIT + 1 }).limit).toBe(MAX_LIMIT);
    expect(normalisePagination({ limit: MAX_LIMIT }).limit).toBe(MAX_LIMIT);
    expect(MAX_LIMIT).toBe(100);
  });

  test("an oversized page is clamped, so skip can never be Infinity", () => {
    // The hole the first pass left. Clamping the page SIZE was not enough:
    // skip is (page - 1) x limit, so `?page=1e308` produced `skip: Infinity`
    // and reached the database as an invalid $skip — the same 500 by a
    // different door.
    expect(MAX_PAGE).toBe(1_000_000);

    for (const huge of ["1e308", 1e308, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER + 2, MAX_PAGE + 1]) {
      const { page, skip } = normalisePagination({ page: huge, limit: MAX_LIMIT });
      expect(page).toBe(MAX_PAGE);
      expect(Number.isSafeInteger(skip)).toBe(true);
      expect(skip).toBeGreaterThanOrEqual(0);
    }
  });

  test("the largest permitted page is honoured exactly, not clamped away", () => {
    const { page, skip } = normalisePagination({ page: MAX_PAGE, limit: MAX_LIMIT });
    expect(page).toBe(MAX_PAGE);
    expect(skip).toBe((MAX_PAGE - 1) * MAX_LIMIT);
    // The worst case the two clamps together permit, and it is exact.
    expect(skip).toBe(99_999_900);
    expect(Number.isSafeInteger(skip)).toBe(true);
  });

  test("page and limit are clamped independently", () => {
    const { page, limit } = normalisePagination({ page: 1e308, limit: 1e308 });
    expect(page).toBe(MAX_PAGE);
    expect(limit).toBe(MAX_LIMIT);
  });

  test("skip is a safe integer for every input, however hostile", () => {
    const inputs = [
      "abc", "", " ", null, undefined, NaN, 0, -3, "0", "-3", {}, [],
      1, 2.7, 1e6, 1e7, 1e308, -1e308, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 2, Infinity, -Infinity, "1e308",
    ];
    for (const page of inputs) {
      for (const limit of inputs) {
        const r = normalisePagination({ page, limit });
        expect(Number.isSafeInteger(r.skip)).toBe(true);
        expect(r.skip).toBeGreaterThanOrEqual(0);
        expect(Number.isSafeInteger(r.page)).toBe(true);
        expect(r.page).toBeGreaterThanOrEqual(1);
        expect(r.page).toBeLessThanOrEqual(MAX_PAGE);
        expect(r.limit).toBeGreaterThanOrEqual(1);
        expect(r.limit).toBeLessThanOrEqual(MAX_LIMIT);
      }
    }
  });

  test("skip can never be negative or fractional", () => {
    for (const page of ["abc", 0, -9, "1.5", 4]) {
      const { skip } = normalisePagination({ page, limit: 10 });
      expect(Number.isInteger(skip)).toBe(true);
      expect(skip).toBeGreaterThanOrEqual(0);
    }
  });
});

/* ═══ 2 · SEARCH ══════════════════════════════════════════════════════════ */

describe("search normalisation", () => {
  test("nothing to search for is null, not an empty pattern", () => {
    // An empty regex matches everything, which is the opposite of "no filter
    // was asked for" only by accident.
    for (const empty of ["", "   ", null, undefined]) {
      expect(normaliseSearch(empty)).toBeNull();
    }
  });

  test("the term is trimmed", () => {
    // "  Cust 1  " pasted from a spreadsheet used to match nothing at all.
    expect(normaliseSearch("  Cust 1  ").term).toBe("Cust 1");
  });

  test("regex punctuation is escaped into literal text", () => {
    // `(` was an unterminated group and threw a 500; `.*` silently matched the
    // whole register. Both are now just characters.
    expect(escapeRegex("(")).toBe("\\(");
    expect(escapeRegex(".*")).toBe("\\.\\*");
    expect(escapeRegex("[a-z]")).toBe("\\[a-z\\]");
    expect(() => new RegExp(normaliseSearch("([a-z").escapedTerm)).not.toThrow();
    expect(() => new RegExp(normaliseSearch("*").escapedTerm)).not.toThrow();
  });

  test("an escaped term still matches the literal characters", () => {
    const re = new RegExp(normaliseSearch("Acme (Delhi)").escapedTerm, "i");
    expect(re.test("Acme (Delhi) Pvt Ltd")).toBe(true);
    expect(re.test("Acme Delhi")).toBe(false);
  });

  test("a displayed MO- number resolves to the stored requestId", () => {
    // The register shows `MO-<requestId>`; the stored field is the bare id.
    const s = normaliseSearch("MO-REQ-0007");
    expect(s.term).toBe("MO-REQ-0007");
    expect(s.reference).toBe("REQ-0007");
    expect(normaliseSearch("mo-req-0007").reference).toBe("req-0007");
  });

  test("a term with no MO- prefix keeps one reference", () => {
    const s = normaliseSearch("REQ-0007");
    expect(s.reference).toBe(s.term);
    // …and produces no redundant second clause.
    expect(searchMatch(s).$or).toHaveLength(3);
  });

  test("an MO- term produces the extra requestId clause", () => {
    expect(searchMatch(normaliseSearch("MO-REQ-0007")).$or).toHaveLength(4);
  });

  test("search covers name, email and requestId", () => {
    const keys = searchMatch(normaliseSearch("x")).$or.map((c) => Object.keys(c)[0]);
    expect(keys).toContain("customerInfo.name");
    expect(keys).toContain("customerInfo.email");
    expect(keys).toContain("requestId");
  });
});

/* ═══ 3 · ENUM FILTERS ════════════════════════════════════════════════════ */

describe("filter normalisation", () => {
  test("absent filters are null, so they add no stage at all", () => {
    for (const f of [normaliseStatus(""), normalisePriority(undefined), normaliseDeadlineRisk(null)]) {
      expect(f).toBeNull();
    }
  });

  test("known values are recognised, case and padding insensitively", () => {
    expect(normaliseStatus(" In_Progress ")).toEqual({ value: "in_progress", known: true });
    expect(normalisePriority("URGENT")).toEqual({ value: "urgent", known: true });
    expect(normaliseDeadlineRisk("Overdue")).toEqual({ value: "overdue", known: true });
  });

  test("an unknown value is kept, so it narrows to nothing rather than widening", () => {
    // The failure mode being avoided: dropping an unrecognised filter turns a
    // typo into "return the entire register".
    const bogus = normaliseStatus("bogus");
    expect(bogus).toEqual({ value: "bogus", known: false });

    const pipeline = buildListPipeline(normaliseListQuery({ status: "bogus" }, NOW));
    const matches = pipeline.filter((s) => s.$match);
    expect(JSON.stringify(matches)).toContain("bogus");
  });

  test("the vocabularies are the established ones", () => {
    expect(DISPLAY_STATUSES).toEqual(["pending", "in_progress", "completed", "cancelled"]);
    expect(PRIORITIES).toEqual(["low", "medium", "high", "urgent"]);
    expect(DEADLINE_RISKS.sort()).toEqual(
      ["closed", "due_soon", "none", "on_track", "overdue"],
    );
  });
});

/* ═══ 4 · DEADLINE RISK ═══════════════════════════════════════════════════ */

describe("deadline risk", () => {
  const risk = (deadline, displayStatus = "in_progress") =>
    classifyDeadlineRisk({ deadline, displayStatus }, NOW);

  test("a deadline before the reference instant is overdue", () => {
    expect(risk(inDays(-1))).toBe("overdue");
    expect(risk(inDays(-60))).toBe("overdue");
  });

  test("a deadline inside the horizon is due soon", () => {
    expect(DUE_SOON_DAYS).toBe(7);
    expect(risk(inDays(0.1))).toBe("due_soon");
    expect(risk(inDays(6.9))).toBe("due_soon");
  });

  test("the horizon boundary is exact and documented", () => {
    // Exactly seven days out is NOT due soon — the band is [now, now + 7d).
    expect(risk(new Date(NOW.getTime() + DUE_SOON_DAYS * DAY - 1))).toBe("due_soon");
    expect(risk(new Date(NOW.getTime() + DUE_SOON_DAYS * DAY))).toBe("on_track");
  });

  test("a deadline beyond the horizon is on track", () => {
    expect(risk(inDays(8))).toBe("on_track");
    expect(risk(inDays(400))).toBe("on_track");
  });

  test("no deadline is its own answer, never overdue", () => {
    // The honesty rule the dashboard already follows: an order nobody gave a
    // date to must not be reported as late.
    expect(risk(null)).toBe("none");
    expect(risk(undefined)).toBe("none");
    expect(risk("")).toBe("none");
    expect(risk("not a date")).toBe("none");
  });

  test("a finished or abandoned order is closed, whatever its date says", () => {
    // Reported ahead of the date check: a completed order with a deadline last
    // March is not an overdue order, it is a finished one.
    expect(risk(inDays(-30), "completed")).toBe("closed");
    expect(risk(inDays(-30), "cancelled")).toBe("closed");
    expect(risk(null, "completed")).toBe("closed");
    expect(risk(inDays(90), "cancelled")).toBe("closed");
  });

  test("classification is a total function over the vocabulary", () => {
    const seen = new Set();
    for (const s of DISPLAY_STATUSES) {
      for (const d of [null, inDays(-1), inDays(3), inDays(30)]) {
        seen.add(risk(d, s));
      }
    }
    for (const v of seen) expect(DEADLINE_RISKS).toContain(v);
  });
});

/* ═══ 5 · PIPELINE SHAPE ══════════════════════════════════════════════════ */

describe("pipeline assembly", () => {
  test("an unfiltered query narrows only to sales-approved", () => {
    const [first] = buildListPipeline(normaliseListQuery({}, NOW));
    expect(first.$match).toEqual({ status: "quotation_sales_approved" });
  });

  test("priority joins the base match, before the work-order lookup", () => {
    const pipeline = buildListPipeline(normaliseListQuery({ priority: "high" }, NOW));
    expect(pipeline[0].$match).toEqual({
      status: "quotation_sales_approved",
      priority: "high",
    });
  });

  test("derived filters are matched after the stages that compute them", () => {
    const pipeline = buildListPipeline(
      normaliseListQuery({ status: "completed", deadlineRisk: "overdue" }, NOW),
    );
    const derived = pipeline.findIndex(
      (s) => s.$match && ("displayStatus" in s.$match || "deadlineRisk" in s.$match),
    );
    const facet = pipeline.findIndex((s) => s.$facet);
    const computesRisk = pipeline.findIndex(
      (s) => s.$addFields && "deadlineRisk" in s.$addFields,
    );

    expect(computesRisk).toBeGreaterThan(-1);
    expect(derived).toBeGreaterThan(computesRisk);
    // Before $facet — which is what makes the total a count of the filtered set.
    expect(derived).toBeLessThan(facet);
  });

  test("no filter stage is added when nothing was asked for", () => {
    const pipeline = buildListPipeline(normaliseListQuery({}, NOW));
    const matches = pipeline.filter((s) => s.$match);
    expect(matches).toHaveLength(1);
  });

  test("sorting carries a deterministic tie-breaker", () => {
    const [{ $facet }] = buildListPipeline(normaliseListQuery({}, NOW)).filter((s) => s.$facet);
    const sort = $facet.paginated.find((s) => s.$sort);
    expect(sort.$sort).toEqual({ updatedAt: -1, _id: -1 });
  });

  test("the projection keeps every established field and adds only two", () => {
    const [{ $facet }] = buildListPipeline(normaliseListQuery({}, NOW)).filter((s) => s.$facet);
    const project = $facet.paginated.find((s) => s.$project).$project;
    for (const key of [
      "_id", "requestId", "customerInfo", "estimatedCompletion", "finalOrderPrice",
      "totalQuantity", "priority", "createdAt", "requestType", "measurementName",
      "workOrdersCount", "completionPercentage", "completedQuantity", "status",
      "displayStatus",
    ]) {
      expect(project).toHaveProperty(key);
    }
    expect(project).toHaveProperty("deadline");
    expect(project).toHaveProperty("deadlineRisk");
  });
});

/* ═══ 6 · PUBLISHED PERCENTAGE ════════════════════════════════════════════ */

describe("completion percentage is bounded where it is published", () => {
  const pct = (completionPercentage) =>
    projectRow({ requestId: "R", completionPercentage }).completionPercentage;

  test("an ordinary ratio is published unchanged", () => {
    expect(pct(0)).toBe(0);
    expect(pct(15)).toBe(15);
    expect(pct(70)).toBe(70);
    expect(pct(99)).toBe(99);
    expect(pct(100)).toBe(100);
  });

  test("over-completion publishes 100, never more", () => {
    // 25 units completed against a quantity of 10 is a real state after a
    // re-issue, and it used to publish "250% complete" — a broken gauge and an
    // unusable progress bar, not extra information.
    expect(pct(250)).toBe(100);
    expect(pct(101)).toBe(100);
    expect(pct(1e6)).toBe(100);
  });

  test("nothing negative or non-finite is ever published", () => {
    expect(pct(-5)).toBe(0);
    expect(pct(-1e9)).toBe(0);
    for (const bad of [NaN, Infinity, -Infinity, undefined, null, "", "abc", {}, []]) {
      const v = pct(bad);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  test("a missing percentage reads as no progress, not as invented progress", () => {
    // Matches the "no work orders yet" answer rather than guessing.
    expect(pct(undefined)).toBe(0);
    expect(projectRow({ requestId: "R" }).completionPercentage).toBe(0);
  });

  test("the pipeline bounds it too, so the database never stores the wrong figure", () => {
    // Structural, because the mapper would mask a missing pipeline clamp: the
    // published value would still be right while anything filtering or sorting
    // on the aggregated field saw 250. The end-to-end proof is in
    // manufacturing-order-list.route.test.js, which reads the raw row.
    const pipeline = buildListPipeline(normaliseListQuery({}, NOW));
    const stage = pipeline.find(
      (s) => s.$addFields && "completionPercentage" in s.$addFields,
    );
    const expr = JSON.stringify(stage.$addFields.completionPercentage);
    expect(expr).toContain("$min");
    expect(expr).toContain("$max");
    expect(expr).toContain("100");
  });

  test("bounding cannot move a status", () => {
    // derivedStatus and displayStatus test `>= 100` and `>= 70`. Anything
    // clamped DOWN to 100 satisfied `>= 100` before and satisfies it after;
    // anything clamped UP to 0 failed every branch before and fails them after.
    const branchOutcome = (v) => ({
      complete: v >= 100,
      nearlyDone: v >= 70,
      started: v > 0,
    });
    for (const raw of [250, 1e6, 100, 99, 70, 15, 0, -5, -1e9]) {
      const bounded = Math.min(100, Math.max(0, raw));
      expect(branchOutcome(bounded)).toEqual(branchOutcome(raw));
    }
  });
});
