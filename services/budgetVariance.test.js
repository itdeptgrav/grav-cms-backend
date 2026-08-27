const test = require("node:test");
const assert = require("node:assert/strict");
const {
  natureOf,
  elapsedFraction,
  expectedToDate,
  evaluateLine,
  rollUp,
  groupBy,
} = require("./budgetVariance.service");

/* A calendar-ish financial year, so pacing assertions read plainly. */
const YEAR = { startDate: "2026-04-01T00:00:00.000Z", endDate: "2027-03-31T00:00:00.000Z" };
const HALFWAY = "2026-09-29T12:00:00.000Z"; // ~50% through

/* ── Nature resolution ───────────────────────────────────────────────────── */

test("nature comes straight from a ledger group when it has one", () => {
  assert.equal(natureOf({ nature: "revenue" }), "revenue");
  assert.equal(natureOf({ nature: "expense" }), "expense");
});

test("an unrecognised nature falls back to expense, not to a crash", () => {
  assert.equal(natureOf({ nature: "asset" }), "expense");
  assert.equal(natureOf({}), "expense");
  assert.equal(natureOf(undefined), "expense");
});

test("the legacy isRevenue flag is honoured when nature is absent", () => {
  assert.equal(natureOf({ isRevenue: true }), "revenue");
});

/* ── The sign rule: positive variance always means good ──────────────────── */

test("expense under budget is favourable", () => {
  const r = evaluateLine({ allocated: 100000, actual: 80000, nature: "expense" });
  assert.equal(r.variance, 20000);
  assert.equal(r.favourable, true);
});

test("expense over budget is adverse", () => {
  const r = evaluateLine({ allocated: 100000, actual: 130000, nature: "expense" });
  assert.equal(r.variance, -30000);
  assert.equal(r.favourable, false);
});

test("revenue INVERTS — under target is adverse, not favourable", () => {
  const r = evaluateLine({ allocated: 100000, actual: 80000, nature: "revenue" });
  assert.equal(r.variance, -20000);
  assert.equal(r.favourable, false);
});

test("revenue over target is favourable", () => {
  const r = evaluateLine({ allocated: 100000, actual: 130000, nature: "revenue" });
  assert.equal(r.variance, 30000);
  assert.equal(r.favourable, true);
});

test("the same numbers give opposite verdicts by nature — the whole point", () => {
  const args = { allocated: 100000, actual: 60000 };
  assert.equal(evaluateLine({ ...args, nature: "expense" }).favourable, true);
  assert.equal(evaluateLine({ ...args, nature: "revenue" }).favourable, false);
});

/* ── remaining vs toGo ───────────────────────────────────────────────────── */

test("remaining is expense-only — revenue headroom is never spendable money", () => {
  const e = evaluateLine({ allocated: 100, actual: 40, nature: "expense" });
  const r = evaluateLine({ allocated: 100, actual: 40, nature: "revenue" });
  assert.equal(e.remaining, 60);
  assert.equal(e.toGo, null);
  assert.equal(r.remaining, null);
  assert.equal(r.toGo, 60);
});

test("toGo never goes negative once the target is beaten", () => {
  assert.equal(evaluateLine({ allocated: 100, actual: 175, nature: "revenue" }).toGo, 0);
});

/* ── Absent values are absent, not zero ──────────────────────────────────── */

test("a null allocation is not read as a deliberate zero budget", () => {
  const r = evaluateLine({ allocated: null, actual: 500, nature: "expense" });
  assert.equal(r.allocated, 0);
  assert.equal(r.utilizationPct, null, "no budget means no percentage, not Infinity");
  assert.equal(r.pace, "no_budget");
});

test("an empty-string amount does not become zero silently", () => {
  const r = evaluateLine({ allocated: "", actual: "", nature: "expense" });
  assert.equal(r.utilizationPct, null);
});

test("a missing asOf does not resolve to the epoch", () => {
  const r = evaluateLine({ allocated: 100, actual: 10, nature: "expense", ...YEAR, asOf: null });
  assert.equal(r.expectedToDate, 100, "unknown clock reads the period as complete, not as 1970");
});

/* ── Elapsed fraction ────────────────────────────────────────────────────── */

test("elapsed clamps outside the period instead of going negative or past 1", () => {
  assert.equal(elapsedFraction({ ...YEAR, asOf: "2026-01-01T00:00:00.000Z" }), 0);
  assert.equal(elapsedFraction({ ...YEAR, asOf: "2030-01-01T00:00:00.000Z" }), 1);
});

test("a zero-length period is complete rather than a division by zero", () => {
  const f = elapsedFraction({ startDate: YEAR.startDate, endDate: YEAR.startDate, asOf: YEAR.startDate });
  assert.equal(f, 1);
  assert.ok(Number.isFinite(f));
});

/* ── Pacing ──────────────────────────────────────────────────────────────── */

test("straight-line expectation is about half the number at the halfway mark", () => {
  const e = expectedToDate({ allocated: 120000, ...YEAR, asOf: HALFWAY });
  assert.ok(Math.abs(e - 60000) < 1500, `expected ~60000, got ${e}`);
});

test("phasing beats straight-lining for a seasonal year", () => {
  // Everything lands in the last quarter.
  const phasing = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1];
  const e = expectedToDate({ allocated: 120000, ...YEAR, asOf: HALFWAY, phasing });
  assert.equal(e, 0, "nothing is expected yet in a back-loaded year");
});

test("phasing weights are normalised, so any scale works", () => {
  const a = expectedToDate({ allocated: 100, ...YEAR, asOf: HALFWAY, phasing: [1, 1, 1, 1] });
  const b = expectedToDate({ allocated: 100, ...YEAR, asOf: HALFWAY, phasing: [25, 25, 25, 25] });
  assert.equal(a, b);
});

test("spending exactly to plan reads as on track, not as a 50% warning", () => {
  const r = evaluateLine({ allocated: 120000, actual: 60000, nature: "expense", ...YEAR, asOf: HALFWAY });
  assert.equal(r.pace, "on_track");
  assert.equal(r.severity, "info");
});

test("burning the year's budget by month six is caught while it still matters", () => {
  const r = evaluateLine({ allocated: 120000, actual: 115000, nature: "expense", ...YEAR, asOf: HALFWAY });
  assert.equal(r.pace, "overspending");
  assert.equal(r.severity, "critical");
});

test("over budget outranks off-pace", () => {
  const r = evaluateLine({ allocated: 100, actual: 150, nature: "expense", ...YEAR, asOf: HALFWAY });
  assert.equal(r.pace, "over_budget");
});

test("a revenue line that hit its full-year target early says so", () => {
  const r = evaluateLine({ allocated: 100, actual: 100, nature: "revenue", ...YEAR, asOf: HALFWAY });
  assert.equal(r.pace, "target_met");
});

test("an untouched line with time already gone is 'not started', not 'behind'", () => {
  const r = evaluateLine({ allocated: 100, actual: 0, nature: "expense", ...YEAR, asOf: HALFWAY });
  assert.equal(r.pace, "not_started");
});

test("a revenue line in January is not critical merely for being early", () => {
  const r = evaluateLine({
    allocated: 1200000, actual: 8000, nature: "revenue", ...YEAR,
    asOf: "2026-04-08T00:00:00.000Z",
  });
  assert.notEqual(r.severity, "critical");
});

test("a revenue line badly short of where it should be IS critical", () => {
  const r = evaluateLine({ allocated: 120000, actual: 20000, nature: "revenue", ...YEAR, asOf: HALFWAY });
  assert.equal(r.severity, "critical");
  assert.equal(r.pace, "behind");
});

/* ── Roll-up ─────────────────────────────────────────────────────────────── */

test("roll-up produces the profit surprise a expense-only budget cannot", () => {
  const lines = [
    evaluateLine({ allocated: 1000000, actual: 900000, nature: "revenue" }),
    evaluateLine({ allocated: 600000, actual: 650000, nature: "expense" }),
  ];
  const r = rollUp(lines);
  assert.equal(r.budgetedNet, 400000);
  assert.equal(r.actualNet, 250000);
  assert.equal(r.netVariance, -150000, "missed revenue and overspend compound");
});

test("margin percentages are null rather than Infinity when revenue is zero", () => {
  const r = rollUp([evaluateLine({ allocated: 100, actual: 50, nature: "expense" })]);
  assert.equal(r.budgetedMarginPct, null);
  assert.equal(r.actualMarginPct, null);
});

test("roll-up ignores holes in the array instead of throwing", () => {
  const r = rollUp([null, undefined, evaluateLine({ allocated: 10, actual: 5, nature: "expense" })]);
  assert.equal(r.expense.count, 1);
});

test("lines with no nature roll into expense, matching every legacy row", () => {
  const r = rollUp([{ allocated: 50, actual: 25, variance: 25 }]);
  assert.equal(r.expense.allocated, 50);
  assert.equal(r.revenue.count, 0);
});

/* ── Grouping ────────────────────────────────────────────────────────────── */

test("grouping splits by department and keeps both natures inside each", () => {
  const lines = [
    { ...evaluateLine({ allocated: 100, actual: 80, nature: "revenue" }), department: "Sales" },
    { ...evaluateLine({ allocated: 40, actual: 45, nature: "expense" }), department: "Sales" },
    { ...evaluateLine({ allocated: 70, actual: 60, nature: "expense" }), department: "Production" },
  ];
  const g = groupBy(lines, "department");
  const sales = g.find((x) => x.name === "Sales");
  assert.equal(sales.revenue.allocated, 100);
  assert.equal(sales.expense.allocated, 40);
  assert.equal(sales.budgetedNet, 60);
});

test("a line with no department is bucketed, never dropped", () => {
  const g = groupBy([{ ...evaluateLine({ allocated: 10, actual: 1, nature: "expense" }) }], "department");
  assert.equal(g.length, 1);
  assert.equal(g[0].name, "Unassigned");
});

/* ── Consumption and pace combine; the worse signal wins ─────────────────── */

test("96% consumed at YEAR END is a budget landing on target, not an alarm", () => {
  const r = evaluateLine({
    allocated: 120000, actual: 115000, nature: "expense", ...YEAR,
    asOf: "2027-03-30T00:00:00.000Z",
  });
  assert.equal(r.severity, "warning", "high consumption late is expected, not critical");
});

test("the SAME 96% at the halfway mark is critical, because the pace damns it", () => {
  const r = evaluateLine({ allocated: 120000, actual: 115000, nature: "expense", ...YEAR, asOf: HALFWAY });
  assert.equal(r.severity, "critical");
});

test("expense pace escalation also respects the warm-up floor", () => {
  // Day 3 of the year, a big one-off purchase. Loud on consumption if it is
  // most of the budget, but never merely because week one outran a rounding.
  const r = evaluateLine({
    allocated: 1000000, actual: 12000, nature: "expense", ...YEAR,
    asOf: "2026-04-04T00:00:00.000Z",
  });
  assert.equal(r.severity, "info");
});

test("modest overspend pace warns without crying critical", () => {
  const r = evaluateLine({ allocated: 120000, actual: 78000, nature: "expense", ...YEAR, asOf: HALFWAY });
  assert.equal(r.severity, "warning");
});
