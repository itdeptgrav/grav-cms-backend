// services/budgetTracker.test.js
//
// The department tracker's projection and arithmetic.
//
// What these prove that a route test cannot cheaply prove:
//   - revenue and expense are never added together, at any level;
//   - the same head budgeted twice merges into ONE row, with percentages
//     re-derived rather than averaged;
//   - a cost-centre-bound line's zero stays explainable;
//   - the public projection carries no field a department may not see;
//   - the monthly series honours a custom phasing split instead of averaging.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const t = require("./budgetTracker.service");

const FY_FROM = "2026-03-31T18:30:00.000Z";
const FY_TO = "2027-03-31T18:29:59.999Z";

const line = (over = {}) => ({
  ledgerId: "L1",
  ledgerName: "Fabric & Trims",
  nature: "expense",
  department: "Merchandising",
  allocated: 1200000,
  actual: 300000,
  remaining: 900000,
  toGo: null,
  variance: 900000,
  variancePct: 75,
  favourable: true,
  utilizationPct: 25,
  expectedToDate: 400000,
  paceGap: 100000,
  pace: "ahead",
  severity: "ok",
  voucherCount: 4,
  ...over,
});

/* ── the projection ──────────────────────────────────────────────────────── */

test("publicHead carries no field a department may not see", () => {
  const h = t.publicHead(
    { ...line(), costCentreId: "CC9", _id: "ITEM1", costCentreBound: true, unattributed: 50000 },
    { _id: "B1", name: "FY26-27 Operating", financialYear: "2026-27" },
  );
  assert.equal(h.costCentreId, undefined, "cost centre identity must not leak");
  assert.equal(h._id, undefined, "the raw line id must not leak");
  // but the zero stays explainable
  assert.equal(h.costCentreBound, true);
  assert.equal(h.unattributed, 50000);
  assert.equal(h.budgetName, "FY26-27 Operating");
});

test("an unbound head is reported as untracked, not as unspent", () => {
  const h = t.publicHead(line({ unbound: true, actual: 0, ledgerId: null }));
  assert.equal(h.unbound, true);
  assert.equal(h.actual, 0);
  const totals = t.totals([h]);
  assert.equal(totals.untracked, 1, "the screen must be able to say how much is not tracked");
});

test("a NaN anywhere becomes 0 rather than poisoning a total", () => {
  const h = t.publicHead(line({ actual: Number.NaN, allocated: undefined }));
  assert.equal(h.actual, 0);
  assert.equal(h.approved, 0);
  assert.ok(Number.isFinite(t.totals([h]).expense.actual));
});

/* ── merging ─────────────────────────────────────────────────────────────── */

test("the same head budgeted twice is one row, with both budgets named", () => {
  const a = t.publicHead(line({ allocated: 1000000, actual: 200000 }), { _id: "B1", name: "Annual" });
  const b = t.publicHead(line({ allocated: 500000, actual: 100000 }), { _id: "B2", name: "Capex" });
  const merged = t.mergeHeads([a, b]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].approved, 1500000);
  assert.equal(merged[0].actual, 300000);
  assert.deepEqual(merged[0].budgets, ["Annual", "Capex"]);
  // 300000/1500000 — re-derived, NOT the average of 20% and 20% by luck
  assert.equal(merged[0].utilizationPct, 20);
});

test("merging re-derives the percentage instead of averaging two denominators", () => {
  const a = t.publicHead(line({ allocated: 100000, actual: 90000 }));   // 90%
  const b = t.publicHead(line({ allocated: 900000, actual: 90000 }));   // 10%
  const [m] = t.mergeHeads([a, b]);
  // the honest answer is 180000/1000000 = 18%, not (90+10)/2 = 50%
  assert.equal(m.utilizationPct, 18);
});

test("heads of different natures never merge, even on the same ledger", () => {
  const e = t.publicHead(line({ nature: "expense" }));
  const r = t.publicHead(line({ nature: "revenue" }));
  assert.equal(t.mergeHeads([e, r]).length, 2);
});

test("unbound lines keep their own rows rather than collapsing into one", () => {
  const a = t.publicHead(line({ ledgerId: null, ledgerName: "Old line A" }));
  const b = t.publicHead(line({ ledgerId: null, ledgerName: "Old line B" }));
  assert.equal(t.mergeHeads([a, b]).length, 2);
});

test("every merged row carries a key unique across the whole set", () => {
  /* Two unbound heads with the SAME name is the case a nature+name key
     collapses — a list rendered on it would silently show one budget line. */
  const same = () => t.publicHead(line({ ledgerId: null, ledgerName: "Unnamed head" }));
  const rows = t.mergeHeads([same(), same(), t.publicHead(line())]);
  const keys = rows.map((r) => r.key);
  assert.equal(rows.length, 3);
  assert.equal(new Set(keys).size, 3, "keys must be unique");
  assert.ok(keys.every(Boolean), "every row must carry a key");
});

/* ── totals ──────────────────────────────────────────────────────────────── */

test("revenue and expense are never added together", () => {
  const e = t.publicHead(line({ nature: "expense", allocated: 1000000, actual: 400000 }));
  const r = t.publicHead(line({ nature: "revenue", allocated: 5000000, actual: 2000000 }));
  const totals = t.totals([e, r]);
  assert.equal(totals.expense.approved, 1000000);
  assert.equal(totals.revenue.approved, 5000000);
  assert.equal(totals.hasRevenue, true);
  assert.equal(totals.hasExpense, true);
  assert.equal(totals.expense.approved + totals.revenue.approved, 6000000);
  assert.ok(!("approved" in totals), "there must be no single combined approved figure");
});

test("an asset or liability head is counted but kept out of both sides", () => {
  const o = t.publicHead(line({ nature: "other", allocated: 700000, actual: 700000 }));
  const totals = t.totals([o]);
  assert.equal(totals.other.count, 1);
  assert.equal(totals.expense.approved, 0);
  assert.equal(totals.revenue.approved, 0);
});

test("expense remaining may go negative; revenue to-go floors at zero", () => {
  const over = t.publicHead(line({ nature: "expense", allocated: 100000, actual: 130000 }));
  const beat = t.publicHead(line({ nature: "revenue", allocated: 100000, actual: 130000 }));
  const a = t.totals([over]);
  const b = t.totals([beat]);
  assert.equal(a.expense.remaining, -30000, "overspend must be visible as a negative");
  assert.equal(b.revenue.remaining, 0, "a beaten target has nothing left to earn");
});

/* ── the monthly series ──────────────────────────────────────────────────── */

test("an even plan spreads across twelve months and sums to the allocation", () => {
  const s = t.monthlySeries({
    lines: [{ ledgerId: "L1", nature: "expense", allocated: 1200000, phasingMode: "even" }],
    movements: [],
    from: FY_FROM,
    to: FY_TO,
    nature: "expense",
  });
  assert.equal(s.length, 12);
  assert.equal(Math.round(s.reduce((a, m) => a + m.planned, 0)), 1200000);
  assert.equal(Math.round(s[0].planned), 100000);
});

test("a custom split is honoured instead of averaged", () => {
  const s = t.monthlySeries({
    lines: [
      {
        ledgerId: "L1",
        nature: "expense",
        allocated: 1200000,
        phasingMode: "custom_monthly",
        monthlyPhasing: [
          { month: "2026-04", amount: 200000 },
          { month: "2027-03", amount: 1000000 },
        ],
      },
    ],
    movements: [],
    from: FY_FROM,
    to: FY_TO,
    nature: "expense",
  });
  const at = (k) => s.find((m) => m.key === k);
  assert.equal(Math.round(at("2026-04").planned), 200000);
  assert.equal(Math.round(at("2027-03").planned), 1000000);
  // the month the split left out plans NOTHING — not the 100000 an average shows
  assert.equal(Math.round(at("2026-09").planned), 0);
});

test("expense actuals read the debit side and revenue the credit side", () => {
  const mv = [{ key: "2026-04", ledgerId: "L1", debit: 150000, credit: 20000 }];
  const e = t.monthlySeries({
    lines: [{ ledgerId: "L1", nature: "expense", allocated: 1200000 }],
    movements: mv,
    from: FY_FROM,
    to: FY_TO,
    nature: "expense",
  });
  const r = t.monthlySeries({
    lines: [{ ledgerId: "L1", nature: "revenue", allocated: 1200000 }],
    movements: mv,
    from: FY_FROM,
    to: FY_TO,
    nature: "revenue",
  });
  assert.equal(e.find((m) => m.key === "2026-04").actual, 130000);
  assert.equal(r.find((m) => m.key === "2026-04").actual, -130000);
});

test("movement on a ledger this department does not budget is ignored", () => {
  const s = t.monthlySeries({
    lines: [{ ledgerId: "L1", nature: "expense", allocated: 100000 }],
    movements: [{ key: "2026-04", ledgerId: "SOMEONE_ELSE", debit: 999999, credit: 0 }],
    from: FY_FROM,
    to: FY_TO,
    nature: "expense",
  });
  assert.equal(s.reduce((a, m) => a + m.actual, 0), 0);
});

test("a series with no readable window is empty rather than guessed", () => {
  assert.deepEqual(t.monthlySeries({ lines: [], movements: [], from: null, to: null }), []);
});

/* ── the join back to the request that funded the line ───────────────────── */

test("a head carries the request it was agreed from", () => {
  const h = t.publicHead(
    { ledgerId: "L1", ledgerName: "Fabric", nature: "expense", allocated: 600000, actual: 0, sourceRequestId: "RQ1" },
    { _id: "B1", name: "FY26-27" },
  );
  assert.equal(h.sourceRequestId, "RQ1");
});

test("a line finance created directly has no source request", () => {
  const h = t.publicHead(
    { ledgerId: "L1", ledgerName: "Fabric", nature: "expense", allocated: 600000, actual: 0 },
    { _id: "B1", name: "FY26-27" },
  );
  assert.equal(h.sourceRequestId, null);
});

test("a head funded by two agreed requests names both", () => {
  const line = (rq, budget) => ({
    ledgerId: "L1", ledgerName: "Fabric", nature: "expense", allocated: 300000, actual: 0, sourceRequestId: rq,
  });
  const rows = t.mergeHeads([
    t.publicHead(line("RQ1"), { _id: "B1", name: "Annual" }),
    t.publicHead(line("RQ2"), { _id: "B2", name: "Capex" }),
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].sourceRequestIds, ["RQ1", "RQ2"]);
  assert.equal(rows[0].approved, 600000);
});

test("the same request is not listed twice on one head", () => {
  const l = { ledgerId: "L1", ledgerName: "Fabric", nature: "expense", allocated: 100000, actual: 0, sourceRequestId: "RQ1" };
  const rows = t.mergeHeads([
    t.publicHead(l, { _id: "B1", name: "Annual" }),
    t.publicHead(l, { _id: "B1", name: "Annual" }),
  ]);
  assert.deepEqual(rows[0].sourceRequestIds, ["RQ1"]);
});

/* ── the allocation line behind a head ───────────────────────────────────── */

test("a head carries the allocation line it stands for", () => {
  const h = t.publicHead(
    { _id: "ITEM1", ledgerId: "L1", ledgerName: "Fabric", nature: "expense", allocated: 100, actual: 0 },
    { _id: "B1", name: "FY26-27" },
  );
  assert.equal(h.lineId, "ITEM1");
});

test("a head funded by two allocations names both lines", () => {
  const mk = (id) => ({ _id: id, ledgerId: "L1", ledgerName: "Fabric", nature: "expense", allocated: 100, actual: 0 });
  const rows = t.mergeHeads([
    t.publicHead(mk("ITEM1"), { _id: "B1", name: "Annual" }),
    t.publicHead(mk("ITEM2"), { _id: "B2", name: "Capex" }),
  ]);
  assert.deepEqual(rows[0].lineIds, ["ITEM1", "ITEM2"]);
});
