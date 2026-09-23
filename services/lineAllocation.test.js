"use strict";
/**
 * services/lineAllocation.test.js
 *
 * The arithmetic that splits one approved total across several budget heads.
 * Pure — no database — because the failure mode is a paise that appears or
 * vanishes, and that is only catchable by trying a great many awkward totals.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const svc = require("./lineAllocation.service");

const line = (over = {}) => ({ _id: "l1", name: "Item", amount: 1000, ...over });

/* ══ ONE LINE'S FIGURE ═════════════════════════════════════════════════════ */

test("lineTotal is preferred, because it is what was approved", () => {
  const r = svc.lineAmountOf(line({ amount: 1000, taxAmount: 180, lineTotal: 1180 }));
  assert.equal(r.ok, true);
  assert.equal(r.paise, 118000);
  assert.equal(r.basis, "lineTotal");
});

test("a lineTotal that disagrees with amount+tax still wins", () => {
  /* Store quoted 1181; recomputing would silently disagree with the figure
     the requester confirmed. */
  const r = svc.lineAmountOf(line({ amount: 1000, taxAmount: 180, lineTotal: 1181 }));
  assert.equal(r.paise, 118100);
});

test("without a lineTotal it is amount plus tax", () => {
  const r = svc.lineAmountOf(line({ amount: 1000, taxAmount: 180 }));
  assert.equal(r.paise, 118000);
  assert.equal(r.basis, "amount+tax");
});

test("no tax at all is not an error", () => {
  assert.equal(svc.lineAmountOf(line({ amount: 1000 })).paise, 100000);
});

test("an explicit zero survives, and is not an absence", () => {
  assert.equal(svc.lineAmountOf(line({ lineTotal: 0 })).paise, 0);
  assert.equal(svc.lineAmountOf(line({ amount: 0 })).paise, 0);
  assert.equal(svc.lineAmountOf(line({ amount: 0, taxAmount: 0 })).paise, 0);
});

test("a missing amount is refused, and reads differently from zero", () => {
  const r = svc.lineAmountOf(line({ amount: undefined }));
  assert.equal(r.ok, false);
  assert.equal(r.code, "MISSING_LINE_AMOUNT");
});

test("a present-but-unreadable amount is a fault, never a free line", () => {
  /* NaN from a bad parse must not silently mean "this costs nothing". */
  for (const bad of [NaN, Infinity, "abc"]) {
    const r = svc.lineAmountOf(line({ amount: bad }));
    assert.equal(r.ok, false, `${bad} was accepted`);
    assert.equal(r.code, "INVALID_LINE_AMOUNT");
  }
});

test("negative figures are refused wherever they appear", () => {
  assert.equal(svc.lineAmountOf(line({ lineTotal: -1 })).code, "NEGATIVE_LINE_AMOUNT");
  assert.equal(svc.lineAmountOf(line({ amount: -1 })).code, "NEGATIVE_LINE_AMOUNT");
  assert.equal(svc.lineAmountOf(line({ amount: 10, taxAmount: -1 })).code, "NEGATIVE_LINE_AMOUNT");
});

test("a non-numeric tax is refused rather than treated as none", () => {
  assert.equal(svc.lineAmountOf(line({ amount: 10, taxAmount: "x" })).code, "INVALID_LINE_AMOUNT");
});

/* ══ THE SPLIT ═════════════════════════════════════════════════════════════ */

const sum = (r) => r.allocations.reduce((t, a) => t + Math.round(a.amount * 100), 0);

test("with no header adjustment every line keeps its own figure", () => {
  const r = svc.allocateLines({
    lines: [line({ _id: "a", lineTotal: 1180 }), line({ _id: "b", lineTotal: 820 })],
    grandTotal: 2000,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.allocations.map((a) => a.amount), [1180, 820]);
  assert.deepEqual(r.allocations.map((a) => a.adjustment), [0, 0]);
  assert.equal(r.totals.adjustment, 0);
});

test("a header discount is spread proportionally and the parts add up", () => {
  const r = svc.allocateLines({
    lines: [line({ _id: "a", lineTotal: 6000 }), line({ _id: "b", lineTotal: 4000 })],
    grandTotal: 9000,
  });
  assert.equal(r.ok, true);
  /* 60/40 of −1000. */
  assert.deepEqual(r.allocations.map((a) => a.adjustment), [-600, -400]);
  assert.deepEqual(r.allocations.map((a) => a.amount), [5400, 3600]);
  assert.equal(sum(r), 900000);
});

test("a header charge is spread the same way", () => {
  const r = svc.allocateLines({
    lines: [line({ _id: "a", lineTotal: 5000 }), line({ _id: "b", lineTotal: 5000 })],
    grandTotal: 10500,
  });
  assert.deepEqual(r.allocations.map((a) => a.amount), [5250, 5250]);
});

test("the remainder lands on the last eligible line, deterministically", () => {
  /* 1/3 each of a 10-paise adjustment does not divide. */
  const r = svc.allocateLines({
    lines: [line({ _id: "a", lineTotal: 100 }), line({ _id: "b", lineTotal: 100 }), line({ _id: "c", lineTotal: 100 })],
    grandTotal: 300.1,
  });
  assert.equal(r.ok, true);
  assert.equal(sum(r), 30010);
  /* Same input, same output, every time. */
  const again = svc.allocateLines({
    lines: [line({ _id: "a", lineTotal: 100 }), line({ _id: "b", lineTotal: 100 }), line({ _id: "c", lineTotal: 100 })],
    grandTotal: 300.1,
  });
  assert.deepEqual(again.allocations.map((a) => a.amount), r.allocations.map((a) => a.amount));
});

test("a zero line takes no share of an adjustment", () => {
  const r = svc.allocateLines({
    lines: [line({ _id: "a", lineTotal: 1000 }), line({ _id: "b", lineTotal: 0 })],
    grandTotal: 900,
  });
  assert.deepEqual(r.allocations.map((a) => a.adjustment), [-100, 0]);
  assert.deepEqual(r.allocations.map((a) => a.amount), [900, 0]);
  assert.equal(r.allocations[1].adjustmentEligible, false);
});

test("an adjustment with nothing to spread it across is refused, not dropped", () => {
  const r = svc.allocateLines({
    lines: [line({ _id: "a", lineTotal: 0 }), line({ _id: "b", lineTotal: 0 })],
    grandTotal: 500,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "ADJUSTMENT_NOT_ALLOCATABLE");
  assert.match(r.message, /no proportion to spread it across/i);
});

test("a discount larger than the lines is refused", () => {
  const r = svc.allocateLines({
    lines: [line({ _id: "a", lineTotal: 100 })],
    grandTotal: -50,
  });
  assert.equal(r.ok, false);
});

test("an absent grandTotal falls back to the lines, inventing no adjustment", () => {
  /* Requests raised before tax was captured carry no grand total, and
     manufacturing a difference for them would restate what they committed. */
  const r = svc.allocateLines({
    lines: [line({ _id: "a", lineTotal: 1180 }), line({ _id: "b", lineTotal: 820 })],
  });
  assert.equal(r.ok, true);
  assert.equal(r.totals.adjustment, 0);
  assert.equal(r.totals.allocated, 2000);
});

test("one bad line refuses the whole allocation", () => {
  const r = svc.allocateLines({
    lines: [line({ _id: "a", lineTotal: 1000 }), line({ _id: "b", amount: -5 })],
    grandTotal: 995,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "NEGATIVE_LINE_AMOUNT");
  assert.equal(r.index, 1);
});

test("no lines is refused", () => {
  assert.equal(svc.allocateLines({ lines: [], grandTotal: 100 }).code, "NO_LINES");
});

/* ══ THE PAISE, ACROSS MANY AWKWARD TOTALS ═════════════════════════════════ */

test("the parts always equal the whole, over a wide sweep", () => {
  /* Deterministic inputs — a fixed lattice rather than random figures, so a
     failure is reproducible from the test name alone. */
  let checked = 0;
  for (const count of [2, 3, 5, 7]) {
    for (const base of [1, 33.33, 1000.07, 12345.67]) {
      for (const delta of [-0.01, 0.01, -7.77, 7.77, -100, 250.55, 0]) {
        const lines = Array.from({ length: count }, (_, i) => line({
          _id: `l${i}`, lineTotal: Math.round((base * (i + 1)) * 100) / 100,
        }));
        const linesTotal = lines.reduce((t, l) => t + Math.round(l.lineTotal * 100), 0);
        const grandTotal = Math.round(linesTotal + delta * 100) / 100;
        if (grandTotal < 0) continue;

        const r = svc.allocateLines({ lines, grandTotal });
        assert.equal(r.ok, true, `refused ${count}×${base}${delta}`);
        assert.equal(
          sum(r), Math.round(grandTotal * 100),
          `${count} lines of ~${base} with ${delta}: parts do not equal the whole`,
        );
        checked += 1;
      }
    }
  }
  assert.ok(checked >= 100, `only ${checked} combinations exercised`);
});

test("no paise is ever duplicated: the adjustments themselves sum exactly", () => {
  const lines = [
    line({ _id: "a", lineTotal: 333.33 }),
    line({ _id: "b", lineTotal: 333.33 }),
    line({ _id: "c", lineTotal: 333.34 }),
  ];
  const r = svc.allocateLines({ lines, grandTotal: 900 });
  const adj = r.allocations.reduce((t, a) => t + Math.round(a.adjustment * 100), 0);
  assert.equal(adj, Math.round(-100 * 100));
  assert.equal(sum(r), 90000);
});

/* ══ GROUPING ══════════════════════════════════════════════════════════════ */

const alloc = (over = {}) => ({
  spendLineId: "l1", amount: 1000, budgetLineId: "bl1", budgetId: "b1",
  ledgerId: "led1", ledgerName: "Raw Materials", financialYear: "2026-27", ...over,
});

test("two lines on one head become one claim", () => {
  const { heads } = svc.groupByBudgetLine([
    alloc({ spendLineId: "a", amount: 6000 }),
    alloc({ spendLineId: "b", amount: 5000 }),
  ]);
  assert.equal(heads.length, 1);
  assert.equal(heads[0].amount, 11000);
  assert.equal(heads[0].lineCount, 2);
  assert.deepEqual(heads[0].spendLineIds, ["a", "b"]);
});

test("different heads stay separate", () => {
  const { heads } = svc.groupByBudgetLine([
    alloc({ spendLineId: "a", budgetLineId: "bl1", ledgerName: "Raw Materials" }),
    alloc({ spendLineId: "b", budgetLineId: "bl2", ledgerName: "Freight" }),
  ]);
  assert.equal(heads.length, 2);
  assert.deepEqual(heads.map((h) => h.ledgerName).sort(), ["Freight", "Raw Materials"]);
});

test("unbudgeted lines are grouped apart, and reduce nothing", () => {
  const { heads, unbudgeted } = svc.groupByBudgetLine([
    alloc({ spendLineId: "a", amount: 1000 }),
    alloc({ spendLineId: "b", amount: 500, budgetLineId: null }),
  ]);
  assert.equal(heads.length, 1);
  assert.equal(heads[0].amount, 1000);
  assert.equal(unbudgeted.amount, 500);
  assert.deepEqual(unbudgeted.spendLineIds, ["b"]);
});

/* ══ THE CUMULATIVE CHECK ══════════════════════════════════════════════════ */

test("the brief's example: 10,000 against 6,000 + 5,000 reports a 1,000 shortage", () => {
  const { heads } = svc.groupByBudgetLine([
    alloc({ spendLineId: "a", amount: 6000 }),
    alloc({ spendLineId: "b", amount: 5000 }),
  ]);
  const checked = svc.checkGroups({
    groups: heads,
    availability: new Map([["bl1", { approved: 10000, committed: 0, actual: 0, available: 10000 }]]),
  });

  assert.equal(checked.length, 1);
  assert.equal(checked[0].status, "insufficient");
  /* Both lines must not independently claim they fit. */
  assert.equal(checked[0].availableBefore, 10000);
  assert.equal(checked[0].availableAfter, -1000);
  assert.equal(checked[0].shortfall, 1000);
});

test("either line alone would have fitted — which is exactly the trap", () => {
  const availability = new Map([["bl1", { approved: 10000, committed: 0, actual: 0, available: 10000 }]]);
  for (const amount of [6000, 5000]) {
    const { heads } = svc.groupByBudgetLine([alloc({ amount })]);
    assert.equal(svc.checkGroups({ groups: heads, availability })[0].status, "within_budget");
  }
});

test("a group that fits reports what is left", () => {
  const { heads } = svc.groupByBudgetLine([alloc({ amount: 4000 })]);
  const [g] = svc.checkGroups({
    groups: heads,
    availability: new Map([["bl1", { approved: 10000, committed: 2000, actual: 1000, available: 7000 }]]),
  });
  assert.equal(g.status, "within_budget");
  assert.equal(g.approved, 10000);
  assert.equal(g.committedBefore, 2000);
  assert.equal(g.actual, 1000);
  assert.equal(g.availableAfter, 3000);
  assert.equal(g.shortfall, 0);
});

test("a head with no approved line is unknown, not silently within budget", () => {
  const { heads } = svc.groupByBudgetLine([alloc({ amount: 100 })]);
  const [g] = svc.checkGroups({ groups: heads, availability: new Map() });
  assert.equal(g.known, false);
  assert.equal(g.status, "unknown_head");
  assert.notEqual(g.status, "within_budget");
});
