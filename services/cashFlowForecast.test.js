// services/cashFlowForecast.test.js
//
// Pure tests for Chunk 1-A's Base forecast engine. No database, no clock —
// every date in here is supplied, so these assertions mean the same thing on
// any machine in any timezone at any time.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const fc = require("./cashFlowForecast.service");

const AS_OF = "2026-09-01";

/** Shorthand: the row for a given YYYY-MM-DD. */
function rowOn(result, ymd) {
  return result.rows.find((r) => fc.dayKey(r.date) === ymd);
}

function recurring(overrides = {}) {
  return {
    direction: "outflow",
    amount: 1000,
    frequency: "monthly",
    dayOfMonth: 5,
    nextDueDate: "2026-09-05",
    startDate: "2026-01-05",
    endDate: null,
    ...overrides,
  };
}

/* ── Roll-forward ────────────────────────────────────────────────────────── */

test("empty inputs produce a flat cash line at the opening balance", () => {
  const r = fc.buildForecast({ asOfDate: AS_OF, horizonDays: 7, openingCash: 50000 });

  assert.equal(r.rows.length, 7);
  assert.equal(r.openingCash, 50000);
  for (const row of r.rows) {
    assert.equal(row.opening, 50000);
    assert.equal(row.closing, 50000);
    assert.equal(row.netMovement, 0);
  }
  assert.equal(r.totals.closingCash, 50000);
  assert.equal(r.totals.minimumCash, 50000);
});

test("each day's opening is the previous day's closing", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 5,
    openingCash: 1000,
    openItems: [
      { dueDate: "2026-09-02", amount: 500, direction: "inflow" },
      { dueDate: "2026-09-04", amount: 200, direction: "outflow" },
    ],
  });

  for (let i = 1; i < r.rows.length; i += 1) {
    assert.equal(
      r.rows[i].opening,
      r.rows[i - 1].closing,
      `day ${i} opening should equal day ${i - 1} closing`,
    );
  }
  assert.equal(r.rows[0].opening, 1000);
  assert.equal(r.totals.closingCash, 1300); // 1000 + 500 - 200
});

test("an inflow increases cash on its due date and not before", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 5,
    openingCash: 0,
    openItems: [{ dueDate: "2026-09-03", amount: 750, direction: "inflow" }],
  });

  assert.equal(rowOn(r, "2026-09-02").closing, 0);
  assert.equal(rowOn(r, "2026-09-03").inflows, 750);
  assert.equal(rowOn(r, "2026-09-03").closing, 750);
  assert.equal(rowOn(r, "2026-09-04").closing, 750, "cash stays up afterwards");
});

test("an outflow decreases cash, and cash may go negative", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 3,
    openingCash: 100,
    openItems: [{ dueDate: "2026-09-02", amount: 400, direction: "outflow" }],
  });

  assert.equal(rowOn(r, "2026-09-02").outflows, 400);
  assert.equal(rowOn(r, "2026-09-02").closing, -300);
  assert.equal(r.totals.minimumCash, -300, "a negative low point is reported, not floored at 0");
});

test("a same-day inflow and outflow net correctly, and both are reported gross", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 2,
    openingCash: 0,
    openItems: [
      { dueDate: "2026-09-01", amount: 900, direction: "inflow" },
      { dueDate: "2026-09-01", amount: 400, direction: "outflow" },
    ],
  });

  const day1 = rowOn(r, "2026-09-01");
  assert.equal(day1.inflows, 900, "gross in, not netted away");
  assert.equal(day1.outflows, 400, "gross out");
  assert.equal(day1.netMovement, 500);
  assert.equal(day1.closing, 500);
});

test("sources break the day's movement down by origin", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 2,
    openingCash: 0,
    openItems: [
      { dueDate: "2026-09-01", amount: 100, direction: "inflow" },
      { dueDate: "2026-09-01", amount: 40, direction: "outflow" },
    ],
    recurringItems: [
      recurring({ direction: "inflow", amount: 7, frequency: "weekly", dayOfMonth: null, nextDueDate: "2026-09-01" }),
      recurring({ direction: "outflow", amount: 3, frequency: "weekly", dayOfMonth: null, nextDueDate: "2026-09-01" }),
    ],
  });

  const s = rowOn(r, "2026-09-01").sources;
  assert.deepEqual(s, {
    openReceivables: 100,
    openPayables: 40,
    recurringInflows: 7,
    recurringOutflows: 3,
  });
  assert.equal(rowOn(r, "2026-09-01").inflows, 107);
  assert.equal(rowOn(r, "2026-09-01").outflows, 43);
});

/* ── Minimum cash ────────────────────────────────────────────────────────── */

test("minimum cash and its date are the lowest closing balance", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 5,
    openingCash: 1000,
    openItems: [
      { dueDate: "2026-09-02", amount: 900, direction: "outflow" }, // dips to 100
      { dueDate: "2026-09-04", amount: 500, direction: "inflow" }, // recovers
    ],
  });

  assert.equal(r.totals.minimumCash, 100);
  assert.equal(fc.dayKey(r.totals.minimumCashDate), "2026-09-02");
});

test("on a tie, the EARLIEST date wins — 'when does it first get this low'", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 4,
    openingCash: 500,
    openItems: [],
  });
  // Flat line: every closing is 500, so the tie is total.
  assert.equal(r.totals.minimumCash, 500);
  assert.equal(fc.dayKey(r.totals.minimumCashDate), "2026-09-01");
});

test("with no rows at all, minimum cash falls back to the opening figure", () => {
  const r = fc.buildForecast({ asOfDate: AS_OF, horizonDays: 0, openingCash: 4200 });
  assert.equal(r.rows.length, 0);
  assert.equal(r.totals.minimumCash, 4200);
  assert.equal(r.totals.minimumCashDate, null);
});

/* ── Recurring expansion ─────────────────────────────────────────────────── */

test("weekly recurring expands every 7 days from nextDueDate", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 30,
    openingCash: 0,
    recurringItems: [
      recurring({ frequency: "weekly", dayOfMonth: null, nextDueDate: "2026-09-04", amount: 10 }),
    ],
  });

  const hits = r.rows.filter((x) => x.outflows > 0).map((x) => fc.dayKey(x.date));
  assert.deepEqual(hits, ["2026-09-04", "2026-09-11", "2026-09-18", "2026-09-25"]);
  assert.equal(r.totals.outflows, 40);
});

test("monthly recurring clamps a 31st rule to each month's last day — and does NOT drift", () => {
  // The bug this pins: stepping from the CLAMPED result would give
  // 31 Jan → 28 Feb → 28 Mar. Anchoring on the rule gives 31 Mar.
  const r = fc.buildForecast({
    asOfDate: "2026-01-01",
    horizonDays: 120, // Jan, Feb, Mar, Apr
    openingCash: 0,
    recurringItems: [
      recurring({ frequency: "monthly", dayOfMonth: 31, nextDueDate: "2026-01-31", startDate: "2026-01-31", amount: 1 }),
    ],
  });

  const hits = r.rows.filter((x) => x.outflows > 0).map((x) => fc.dayKey(x.date));
  assert.deepEqual(hits, ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
});

test("monthly recurring on a safe day is simply that day each month", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 90,
    openingCash: 0,
    recurringItems: [recurring({ dayOfMonth: 5, nextDueDate: "2026-09-05", amount: 2 })],
  });

  const hits = r.rows.filter((x) => x.outflows > 0).map((x) => fc.dayKey(x.date));
  assert.deepEqual(hits, ["2026-09-05", "2026-10-05", "2026-11-05"]);
});

test("quarterly recurring steps three months at a time", () => {
  const r = fc.buildForecast({
    asOfDate: "2026-01-01",
    horizonDays: 366,
    openingCash: 0,
    recurringItems: [
      recurring({ frequency: "quarterly", dayOfMonth: 20, nextDueDate: "2026-01-20", startDate: "2026-01-20", amount: 5 }),
    ],
  });

  const hits = r.rows.filter((x) => x.outflows > 0).map((x) => fc.dayKey(x.date));
  assert.deepEqual(hits, ["2026-01-20", "2026-04-20", "2026-07-20", "2026-10-20"]);
});

test("yearly recurring steps twelve months, clamping 29 Feb in a non-leap year", () => {
  const r = fc.buildForecast({
    asOfDate: "2028-01-01",
    horizonDays: 800, // 2028 (leap) → 11 Mar 2030, so three occurrences fall inside
    openingCash: 0,
    recurringItems: [
      recurring({ frequency: "yearly", dayOfMonth: 29, nextDueDate: "2028-02-29", startDate: "2028-02-29", amount: 3 }),
    ],
  });

  const hits = r.rows.filter((x) => x.outflows > 0).map((x) => fc.dayKey(x.date));
  assert.deepEqual(hits, ["2028-02-29", "2029-02-28", "2030-02-28"]);
});

test("a leap-day yearly rule RECOVERS to the 29th in the next leap year", () => {
  // The anchoring payoff: because every occurrence is computed from the
  // original rule rather than stepped from the last clamped result, 2032
  // returns to the 29th instead of being stuck on the 28th forever.
  const occurrences = fc.expandOccurrences(
    recurring({ frequency: "yearly", dayOfMonth: 29, nextDueDate: "2028-02-29", startDate: "2028-02-29" }),
    { from: "2028-01-01", to: "2032-12-31" },
  );
  assert.deepEqual(
    occurrences.map(fc.dayKey),
    ["2028-02-29", "2029-02-28", "2030-02-28", "2031-02-28", "2032-02-29"],
  );
});

test("a recurring INFLOW adds to inflows, not outflows", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 10,
    openingCash: 0,
    recurringItems: [recurring({ direction: "inflow", amount: 60, nextDueDate: "2026-09-05" })],
  });

  assert.equal(rowOn(r, "2026-09-05").inflows, 60);
  assert.equal(rowOn(r, "2026-09-05").outflows, 0);
  assert.equal(r.totals.closingCash, 60);
});

test("endDate stops occurrences", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 90,
    openingCash: 0,
    recurringItems: [
      recurring({ dayOfMonth: 5, nextDueDate: "2026-09-05", endDate: "2026-10-10", amount: 1 }),
    ],
  });

  const hits = r.rows.filter((x) => x.outflows > 0).map((x) => fc.dayKey(x.date));
  assert.deepEqual(hits, ["2026-09-05", "2026-10-05"], "November is past the end date");
});

test("startDate suppresses occurrences before the schedule begins", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 90,
    openingCash: 0,
    recurringItems: [
      recurring({ dayOfMonth: 5, nextDueDate: "2026-09-05", startDate: "2026-10-01", amount: 1 }),
    ],
  });

  const hits = r.rows.filter((x) => x.outflows > 0).map((x) => fc.dayKey(x.date));
  assert.deepEqual(hits, ["2026-10-05", "2026-11-05"]);
});

test("an occurrence exactly on the first and last day of the horizon is included", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 7, // 01 Sep .. 07 Sep
    openingCash: 0,
    recurringItems: [
      recurring({ frequency: "weekly", dayOfMonth: null, nextDueDate: "2026-09-01", amount: 1 }),
      recurring({ frequency: "weekly", dayOfMonth: null, nextDueDate: "2026-09-07", amount: 10 }),
    ],
  });

  assert.equal(rowOn(r, "2026-09-01").outflows, 1, "inclusive at the start");
  assert.equal(rowOn(r, "2026-09-07").outflows, 10, "inclusive at the end");
  assert.equal(r.rows.length, 7);
});

test("an unknown frequency contributes nothing rather than throwing", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 10,
    openingCash: 100,
    recurringItems: [recurring({ frequency: "fortnightly", amount: 99 })],
  });
  assert.equal(r.totals.outflows, 0);
  assert.equal(r.coverage.recurringItemsIncluded, 0);
});

/* ── Open items: overdue and beyond-horizon ──────────────────────────────── */

test("an OVERDUE open item is excluded from the rows and counted in coverage", () => {
  // Not dropped onto day 1: that would assume money already late arrives
  // today. Not silently lost either — it is counted where a reader sees it.
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 5,
    openingCash: 1000,
    openItems: [{ dueDate: "2026-08-20", amount: 5000, direction: "inflow" }],
  });

  assert.equal(r.totals.inflows, 0);
  assert.equal(r.totals.closingCash, 1000);
  assert.equal(r.coverage.openItemsOverdue, 1);
  assert.equal(r.coverage.openItemsOverdueAmount, 5000);
  assert.equal(r.coverage.openItemsIncluded, 0);
});

test("an item due beyond the horizon is excluded and counted separately", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 7,
    openingCash: 0,
    openItems: [{ dueDate: "2026-12-01", amount: 900, direction: "inflow" }],
  });

  assert.equal(r.totals.inflows, 0);
  assert.equal(r.coverage.openItemsBeyondHorizon, 1);
  assert.equal(r.coverage.openItemsIncluded, 0);
});

test("an item due exactly ON the as-of date is included, not treated as overdue", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 3,
    openingCash: 0,
    openItems: [{ dueDate: AS_OF, amount: 250, direction: "inflow" }],
  });
  assert.equal(rowOn(r, AS_OF).inflows, 250);
  assert.equal(r.coverage.openItemsIncluded, 1);
  assert.equal(r.coverage.openItemsOverdue, 0);
});

test("an undated open item never reaches the engine, and the caller's count is echoed", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 5,
    openingCash: 0,
    openItems: [{ dueDate: null, amount: 100, direction: "inflow" }],
    counts: { openItemsUndated: 205, openItemsTotal: 208 },
  });

  assert.equal(r.totals.inflows, 0, "a dateless item is not guessed onto any day");
  assert.equal(r.coverage.openItemsUndated, 205);
  assert.equal(r.coverage.openItemsTotal, 208);
});

/* ── Shape and horizons ──────────────────────────────────────────────────── */

test("every supported horizon produces exactly that many rows", () => {
  for (const h of [7, 15, 30, 60, 90]) {
    const r = fc.buildForecast({ asOfDate: AS_OF, horizonDays: h, openingCash: 0 });
    assert.equal(r.rows.length, h, `horizon ${h}`);
    assert.equal(fc.dayKey(r.rows[0].date), AS_OF, "day 1 is the as-of date");
  }
});

test("the result carries the full documented shape", () => {
  const r = fc.buildForecast({
    companyId: "abc",
    asOfDate: AS_OF,
    horizonDays: 2,
    openingCash: 10,
  });

  assert.equal(r.companyId, "abc");
  assert.equal(r.horizonDays, 2);
  assert.equal(r.scenario, "base");
  assert.deepEqual(Object.keys(r.totals).sort(), [
    "closingCash",
    "inflows",
    "minimumCash",
    "minimumCashDate",
    "netMovement",
    "outflows",
  ]);
  assert.deepEqual(Object.keys(r.rows[0].sources).sort(), [
    "openPayables",
    "openReceivables",
    "recurringInflows",
    "recurringOutflows",
  ]);
  assert.ok("openItemsIncluded" in r.coverage);
  assert.ok("recurringItemsIncluded" in r.coverage);
});

test("days with no activity still produce a row — the date series has no gaps", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 10,
    openingCash: 0,
    openItems: [{ dueDate: "2026-09-08", amount: 5, direction: "inflow" }],
  });

  assert.equal(r.rows.length, 10);
  for (let i = 1; i < r.rows.length; i += 1) {
    const prev = new Date(r.rows[i - 1].date).getTime();
    const cur = new Date(r.rows[i].date).getTime();
    assert.equal(cur - prev, 86400000, "consecutive rows are exactly one day apart");
  }
});

/* ── Purity ──────────────────────────────────────────────────────────────── */

test("inputs are never mutated", () => {
  const openItems = [{ dueDate: "2026-09-03", amount: 100, direction: "inflow" }];
  const recurringItems = [recurring({ nextDueDate: "2026-09-05", amount: 20 })];

  const openBefore = JSON.stringify(openItems);
  const recurringBefore = JSON.stringify(recurringItems);

  fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 30,
    openingCash: 1000,
    openItems,
    recurringItems,
  });

  assert.equal(JSON.stringify(openItems), openBefore, "openItems untouched");
  assert.equal(
    JSON.stringify(recurringItems),
    recurringBefore,
    "recurringItems untouched — nextDueDate is never advanced",
  );
});

test("nextDueDate is read, never advanced — two runs agree exactly", () => {
  const items = [recurring({ nextDueDate: "2026-09-05", amount: 20 })];
  const a = fc.buildForecast({ asOfDate: AS_OF, horizonDays: 60, openingCash: 0, recurringItems: items });
  const b = fc.buildForecast({ asOfDate: AS_OF, horizonDays: 60, openingCash: 0, recurringItems: items });
  assert.equal(a.totals.outflows, b.totals.outflows);
  assert.equal(items[0].nextDueDate, "2026-09-05");
});

/* ── Date arithmetic helpers ─────────────────────────────────────────────── */

test("addMonthsClampedUTC anchors on the rule, not on the clamped result", () => {
  const jan31 = new Date("2026-01-31T00:00:00Z");
  assert.equal(fc.dayKey(fc.addMonthsClampedUTC(jan31, 1, 31)), "2026-02-28");
  assert.equal(fc.dayKey(fc.addMonthsClampedUTC(jan31, 2, 31)), "2026-03-31");
  assert.equal(fc.dayKey(fc.addMonthsClampedUTC(jan31, 3, 31)), "2026-04-30");
});

test("expandOccurrences returns an empty list for a malformed schedule", () => {
  assert.deepEqual(fc.expandOccurrences(null, { from: AS_OF, to: "2026-09-30" }), []);
  assert.deepEqual(
    fc.expandOccurrences(recurring({ nextDueDate: null }), { from: AS_OF, to: "2026-09-30" }),
    [],
  );
  assert.deepEqual(fc.expandOccurrences(recurring(), { from: null, to: null }), []);
});

/* ── Scope guard, asserted in code ───────────────────────────────────────── */

test("scope guard: no scenario, band, alert or actual-comparison machinery exists here", () => {
  const exported = Object.keys(fc);
  for (const forbidden of [
    "buildScenarios",
    "applyScenarioMultiplier",
    "confidenceBand",
    "bestCase",
    "worstCase",
    "alerts",
    "forecastVsActual",
    "whatIf",
  ]) {
    assert.ok(!exported.includes(forbidden), `${forbidden} is a later chunk, not 1-A`);
  }
  const r = fc.buildForecast({ asOfDate: AS_OF, horizonDays: 3, openingCash: 0 });
  assert.equal(r.scenario, "base");
  assert.ok(!("best" in r) && !("worst" in r));
  assert.ok(!("confidence" in r) && !("alerts" in r));
  assert.ok(!("bandLow" in r.rows[0]) && !("bandHigh" in r.rows[0]));
});

/* ═══════════════════════════════════════════════════════════════════════════
 * CHUNK 1-B — EXPLAINABILITY
 *
 * Everything below is additive. The 32 tests above are Chunk 1-A's and were
 * NOT edited for this chunk — that they still pass unchanged is itself the
 * proof that the roll-forward math was not touched.
 * ═══════════════════════════════════════════════════════════════════════════ */

const S = fc.SOURCE;

/** An open item carrying the drilldown fields the orchestrator now supplies. */
function openItem(overrides = {}) {
  return {
    id: "L1||INV-1",
    dueDate: "2026-09-03",
    amount: 1000,
    direction: "inflow",
    partyOrLedgerName: "Acme Textiles",
    billName: "INV-1",
    voucherNumber: "SV/001",
    source: S.BILL_ALLOCATION_DUE_DATE,
    backfillRunId: null,
    ...overrides,
  };
}

/* ── Drilldown ───────────────────────────────────────────────────────────── */

test("1-B: items are grouped onto the date they fall on", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 10,
    openingCash: 0,
    openItems: [
      openItem({ id: "a", billName: "A", dueDate: "2026-09-03", amount: 100 }),
      openItem({ id: "b", billName: "B", dueDate: "2026-09-03", amount: 200 }),
      openItem({ id: "c", billName: "C", dueDate: "2026-09-05", amount: 300 }),
    ],
  });

  const d3 = rowOn(r, "2026-09-03");
  const d5 = rowOn(r, "2026-09-05");
  assert.equal(d3.items.length, 2);
  assert.deepEqual(d3.items.map((i) => i.billName), ["B", "A"], "largest first");
  assert.equal(d5.items.length, 1);
  assert.equal(rowOn(r, "2026-09-04").items.length, 0, "a quiet day has an empty list, not a missing one");
});

test("1-B: a row's items sum to that row's own inflow/outflow figures", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 5,
    openingCash: 0,
    openItems: [
      openItem({ id: "a", dueDate: "2026-09-02", amount: 700, direction: "inflow" }),
      openItem({ id: "b", dueDate: "2026-09-02", amount: 250, direction: "outflow" }),
    ],
    recurringItems: [
      recurring({ direction: "outflow", amount: 50, frequency: "weekly", dayOfMonth: null, nextDueDate: "2026-09-02", name: "Wages" }),
    ],
  });

  const row = rowOn(r, "2026-09-02");
  const inSum = row.items.filter((i) => i.direction === "inflow").reduce((s, i) => s + i.amount, 0);
  const outSum = row.items.filter((i) => i.direction === "outflow").reduce((s, i) => s + i.amount, 0);
  assert.equal(inSum, row.inflows);
  assert.equal(outSum, row.outflows);
});

test("1-B: a recurring item appears in the drilldown, labelled as a schedule", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 10,
    openingCash: 0,
    recurringItems: [recurring({ nextDueDate: "2026-09-05", amount: 8000, name: "Office rent", ledgerName: "Rent Expense" })],
  });

  const it = rowOn(r, "2026-09-05").items[0];
  assert.equal(it.kind, "recurring_item");
  assert.equal(it.source, S.RECURRING_SCHEDULE);
  assert.equal(it.sourceLabel, "Recurring schedule");
  assert.equal(it.derived, false, "a stated schedule is not a derivation");
  assert.equal(it.partyOrLedgerName, "Rent Expense");
  assert.equal(it.voucherNumber, null, "a schedule has not been posted");
});

test("1-B: a recurring item recurring several times gets a distinct id per occurrence", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 90,
    openingCash: 0,
    recurringItems: [recurring({ nextDueDate: "2026-09-05", amount: 1, name: "Rent" })],
  });
  const ids = r.rows.flatMap((x) => x.items).map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique across occurrences");
  assert.ok(ids.length >= 3);
});

test("1-B: every drilldown item carries the full documented shape", () => {
  // EXTENDED BY CHUNK 1-C: the five `forecast*`/`dueDate` keys were added when
  // overdue treatment landed. This assertion is deliberately exhaustive — it
  // is what forced that extension to be an explicit decision rather than a
  // field quietly appearing in a payload.
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 5,
    openingCash: 0,
    openItems: [openItem({ dueDate: "2026-09-02" })],
  });
  const it = rowOn(r, "2026-09-02").items[0];
  assert.deepEqual(Object.keys(it).sort(), [
    "ageDays",
    "amount",
    "backfillRunId",
    "billName",
    "date",
    "derived",
    "direction",
    "dueDate",
    "forecastDateSource",
    "forecastExpectedDate",
    "forecastExpectedDateNotes",
    "forecastExpectedDateUpdatedByName",
    "id",
    "kind",
    "overdue",
    "partyOrLedgerName",
    "source",
    "sourceLabel",
    "voucherNumber",
  ]);
});

test("1-C: a recurring item carries the same key set, so drilldown rows are uniform", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 10,
    openingCash: 0,
    openItems: [openItem({ dueDate: "2026-09-02" })],
    recurringItems: [recurring({ nextDueDate: "2026-09-05" })],
  });
  const openKeys = Object.keys(rowOn(r, "2026-09-02").items[0]).sort();
  const recKeys = Object.keys(rowOn(r, "2026-09-05").items[0]).sort();
  assert.deepEqual(recKeys, openKeys);
});

test("1-B: ageDays is negative for a future due date and zero on the as-of date", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 10,
    openingCash: 0,
    openItems: [
      openItem({ id: "today", dueDate: AS_OF }),
      openItem({ id: "later", dueDate: "2026-09-06" }),
    ],
  });
  assert.equal(rowOn(r, AS_OF).items[0].ageDays, 0);
  assert.equal(rowOn(r, "2026-09-06").items[0].ageDays, -5, "five days until due");
});

/* ── Source breakdown ────────────────────────────────────────────────────── */

test("1-B: the source breakdown totals match the items that produced them", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 10,
    openingCash: 0,
    openItems: [
      openItem({ id: "1", dueDate: "2026-09-02", amount: 100, source: S.BILL_ALLOCATION_DUE_DATE }),
      openItem({ id: "2", dueDate: "2026-09-02", amount: 200, source: S.VOUCHER_DUE_DATE }),
      openItem({ id: "3", dueDate: "2026-09-03", amount: 400, source: S.COMPANY_DEFAULT }),
      openItem({ id: "4", dueDate: "2026-09-03", amount: 800, source: S.PARTY_TERMS }),
      openItem({ id: "5", dueDate: "2026-09-04", amount: 1600, source: S.BILL_TERMS_MANUAL }),
    ],
    recurringItems: [recurring({ nextDueDate: "2026-09-05", amount: 3200 })],
  });

  const b = r.sourceBreakdown;
  assert.deepEqual(b.explicitBillAllocationDueDate, { count: 1, amount: 100 });
  assert.deepEqual(b.voucherDueDate, { count: 1, amount: 200 });
  assert.deepEqual(b.companyDefaultDerived, { count: 1, amount: 400 });
  assert.deepEqual(b.partyTermsDerived, { count: 1, amount: 800 });
  assert.deepEqual(b.billTermsSidecar, { count: 1, amount: 1600 });
  assert.deepEqual(b.recurringManual, { count: 1, amount: 3200 });

  // The buckets are mutually exclusive, so they sum to everything projected.
  const summed = Object.values(b).reduce((s, x) => s + x.amount, 0);
  assert.equal(summed, r.totals.inflows + r.totals.outflows);
});

test("1-B: a sidecar row derived from the COMPANY DEFAULT is exposed distinctly, not as generic sidecar", () => {
  // The question this whole breakdown exists to answer: how much of the
  // forecast rests on a blanket default nobody negotiated per party.
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 10,
    openingCash: 0,
    openItems: [
      openItem({ id: "cd", dueDate: "2026-09-02", amount: 5000, source: S.COMPANY_DEFAULT, backfillRunId: "run-1" }),
    ],
  });

  assert.deepEqual(r.sourceBreakdown.companyDefaultDerived, { count: 1, amount: 5000 });
  assert.deepEqual(r.sourceBreakdown.billTermsSidecar, { count: 0, amount: 0 });

  const it = rowOn(r, "2026-09-02").items[0];
  assert.equal(it.sourceLabel, "Backfilled from company default");
  assert.equal(it.derived, true);
  assert.equal(it.backfillRunId, "run-1", "the run that produced it is traceable");
});

test("1-B: explicit and manual dates are NOT marked derived", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 10,
    openingCash: 0,
    openItems: [
      openItem({ id: "x", dueDate: "2026-09-02", source: S.BILL_ALLOCATION_DUE_DATE }),
      openItem({ id: "y", dueDate: "2026-09-03", source: S.VOUCHER_DUE_DATE }),
      openItem({ id: "z", dueDate: "2026-09-04", source: S.BILL_TERMS_MANUAL }),
    ],
  });
  for (const ymd of ["2026-09-02", "2026-09-03", "2026-09-04"]) {
    assert.equal(rowOn(r, ymd).items[0].derived, false, ymd);
  }
});

test("1-B: an unknown source is not invented into a bucket", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 5,
    openingCash: 0,
    openItems: [openItem({ dueDate: "2026-09-02", amount: 90, source: null })],
  });
  const summed = Object.values(r.sourceBreakdown).reduce((s, x) => s + x.count, 0);
  assert.equal(summed, 0, "counted nowhere rather than guessed somewhere");
  // …but the money still moves, because the date was real.
  assert.equal(r.totals.inflows, 90);
});

/* ── Inclusion summary ───────────────────────────────────────────────────── */

test("1-B: the inclusion summary counts included, undated and overdue separately", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 10,
    openingCash: 0,
    openItems: [
      openItem({ id: "in1", dueDate: "2026-09-02", amount: 1000 }),
      openItem({ id: "in2", dueDate: "2026-09-03", amount: 500 }),
      openItem({ id: "late", dueDate: "2026-08-01", amount: 7000 }),
    ],
    recurringItems: [recurring({ nextDueDate: "2026-09-05", amount: 20 })],
    counts: { openItemsUndated: 4, openItemsUndatedAmount: 9999, openItemsTotal: 7 },
  });

  assert.deepEqual(r.inclusion, {
    includedOpenItems: 2,
    includedOpenItemAmount: 1500,
    includedRecurringItems: 1,
    excludedUndatedOpenItems: 4,
    excludedUndatedAmount: 9999,
    excludedOverdueOpenItems: 1,
    excludedOverdueAmount: 7000,
  });
});

test("1-B: an overdue item is in the inclusion summary but NOT in any row's items", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 10,
    openingCash: 0,
    openItems: [openItem({ id: "late", dueDate: "2026-08-01", amount: 7000 })],
  });

  assert.equal(r.inclusion.excludedOverdueOpenItems, 1);
  assert.equal(r.inclusion.excludedOverdueAmount, 7000);
  assert.equal(r.rows.flatMap((x) => x.items).length, 0, "excluded means excluded from the projection");
  assert.equal(r.totals.inflows, 0);
});

/* ── Diagnostics ─────────────────────────────────────────────────────────── */

test("1-B: concentration reports the heaviest date and its share of movement", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 10,
    openingCash: 0,
    openItems: [
      openItem({ id: "a", dueDate: "2026-09-02", amount: 750 }),
      openItem({ id: "b", dueDate: "2026-09-04", amount: 150 }),
      openItem({ id: "c", dueDate: "2026-09-06", amount: 100 }),
    ],
  });

  const c = r.diagnostics.concentration;
  assert.equal(fc.dayKey(c.maxDate), "2026-09-02");
  assert.equal(c.maxDateAmount, 750);
  assert.equal(c.maxDateShareOfMovement, 75); // 750 of 1000 gross
  assert.equal(c.movingDays, 3);
  assert.equal(c.horizonDays, 10);
});

test("1-B: topMovementDates are sorted heaviest-first and carry an item count", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 10,
    openingCash: 0,
    openItems: [
      openItem({ id: "a", dueDate: "2026-09-02", amount: 10 }),
      openItem({ id: "b", dueDate: "2026-09-04", amount: 400 }),
      openItem({ id: "c", dueDate: "2026-09-04", amount: 100 }),
    ],
  });

  const top = r.diagnostics.topMovementDates;
  assert.equal(fc.dayKey(top[0].date), "2026-09-04");
  assert.equal(top[0].itemCount, 2);
  assert.equal(top[0].inflows, 500);
  assert.equal(fc.dayKey(top[1].date), "2026-09-02");
  assert.ok(!("gross" in top[0]), "the sort key is not leaked as an output field");
});

test("1-B: topParties are sorted by amount and carry a share", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 10,
    openingCash: 0,
    openItems: [
      openItem({ id: "1", dueDate: "2026-09-02", amount: 600, partyOrLedgerName: "Mayfair" }),
      openItem({ id: "2", dueDate: "2026-09-03", amount: 300, partyOrLedgerName: "Mayfair" }),
      openItem({ id: "3", dueDate: "2026-09-04", amount: 100, partyOrLedgerName: "Divaksh" }),
    ],
  });

  const p = r.diagnostics.topParties;
  assert.equal(p[0].name, "Mayfair");
  assert.equal(p[0].amount, 900);
  assert.equal(p[0].count, 2);
  assert.equal(p[0].shareOfMovement, 90);
  assert.equal(p[1].name, "Divaksh");
});

test("1-B: a party's inflows and outflows are reported separately, not netted", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 10,
    openingCash: 0,
    openItems: [
      openItem({ id: "1", dueDate: "2026-09-02", amount: 500, partyOrLedgerName: "Both Ways", direction: "inflow" }),
      openItem({ id: "2", dueDate: "2026-09-03", amount: 200, partyOrLedgerName: "Both Ways", direction: "outflow" }),
    ],
  });

  const p = r.diagnostics.topParties;
  assert.equal(p.length, 2, "one row per party-and-direction");
  assert.deepEqual(
    p.map((x) => [x.name, x.direction, x.amount]),
    [["Both Ways", "inflow", 500], ["Both Ways", "outflow", 200]],
  );
});

test("1-B: an item with no party name is attributed honestly, not dropped", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 5,
    openingCash: 0,
    openItems: [openItem({ dueDate: "2026-09-02", amount: 42, partyOrLedgerName: null })],
  });
  assert.equal(r.diagnostics.topParties[0].name, "Unattributed");
  assert.equal(r.diagnostics.topParties[0].amount, 42);
});

test("1-B: empty inputs give empty diagnostics rather than throwing", () => {
  const r = fc.buildForecast({ asOfDate: AS_OF, horizonDays: 7, openingCash: 100 });
  assert.deepEqual(r.diagnostics.topMovementDates, []);
  assert.deepEqual(r.diagnostics.topParties, []);
  assert.equal(r.diagnostics.concentration.maxDate, null);
  assert.equal(r.diagnostics.concentration.maxDateShareOfMovement, 0);
  assert.equal(r.diagnostics.concentration.movingDays, 0);
});

/* ── The load-bearing guarantee: 1-B changed no number ───────────────────── */

test("1-B: diagnostics and drilldown do NOT affect the roll-forward totals", () => {
  const input = {
    asOfDate: AS_OF,
    horizonDays: 30,
    openingCash: 100000,
    openItems: [
      openItem({ id: "a", dueDate: "2026-09-03", amount: 40000, direction: "inflow" }),
      openItem({ id: "b", dueDate: "2026-09-10", amount: 15000, direction: "outflow" }),
      openItem({ id: "late", dueDate: "2026-08-01", amount: 99999, direction: "inflow" }),
    ],
    recurringItems: [recurring({ nextDueDate: "2026-09-05", amount: 30000 })],
  };

  const r = fc.buildForecast(input);

  // These are the exact figures Chunk 1-A produced for this shape.
  assert.equal(r.openingCash, 100000);
  assert.equal(r.totals.inflows, 40000);
  assert.equal(r.totals.outflows, 45000); // 15000 payable + 30000 rent
  assert.equal(r.totals.netMovement, -5000);
  assert.equal(r.totals.closingCash, 95000);
  assert.equal(rowOn(r, "2026-09-03").closing, 140000);
  assert.equal(rowOn(r, "2026-09-05").closing, 110000);
  assert.equal(rowOn(r, "2026-09-10").closing, 95000);

  // And the 1-A row shape is intact beneath the new field.
  assert.deepEqual(Object.keys(r.rows[0].sources).sort(), [
    "openPayables",
    "openReceivables",
    "recurringInflows",
    "recurringOutflows",
  ]);
});

test("1-B: inputs are still never mutated, drilldown included", () => {
  const openItems = [openItem({ dueDate: "2026-09-03" })];
  const recurringItems = [recurring({ nextDueDate: "2026-09-05" })];
  const a = JSON.stringify(openItems);
  const b = JSON.stringify(recurringItems);

  fc.buildForecast({ asOfDate: AS_OF, horizonDays: 30, openingCash: 0, openItems, recurringItems });

  assert.equal(JSON.stringify(openItems), a);
  assert.equal(JSON.stringify(recurringItems), b);
});

test("1-B scope guard: still no scenario, band, alert or actual-comparison output", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 7,
    openingCash: 0,
    openItems: [openItem({ dueDate: "2026-09-02" })],
  });
  assert.equal(r.scenario, "base");
  for (const forbidden of ["best", "worst", "confidence", "alerts", "whatIf", "actuals", "bands"]) {
    assert.ok(!(forbidden in r), `${forbidden} is a later chunk`);
  }
  // Diagnostics are descriptive: no severity, threshold or verdict fields.
  for (const k of ["severity", "level", "warning", "breached", "threshold"]) {
    assert.ok(!(k in r.diagnostics.concentration), `concentration must not carry a ${k}`);
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * CHUNK 1-C — OVERDUE TREATMENT
 *
 * Default stays conservative: an overdue bill is NOT assumed to arrive today.
 * It enters the forecast only when a person has recorded an expected date.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** An already-overdue open item (due before AS_OF). */
function overdueItem(overrides = {}) {
  return openItem({
    id: "L1||OLD-1",
    billName: "OLD-1",
    dueDate: "2026-07-01", // ~62 days before AS_OF
    amount: 50000,
    source: S.COMPANY_DEFAULT,
    ...overrides,
  });
}

test("1-C: an overdue item with NO expected date stays excluded — the default is conservative", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 30,
    openingCash: 1000,
    openItems: [overdueItem()],
  });

  assert.equal(r.totals.inflows, 0, "not assumed to arrive today");
  assert.equal(r.rows.flatMap((x) => x.items).length, 0);
  assert.equal(r.inclusion.excludedOverdueOpenItems, 1);
  assert.equal(r.inclusion.excludedOverdueAmount, 50000);
});

test("1-C: an overdue item WITH an expected date inside the horizon is included on that date", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 30,
    openingCash: 1000,
    openItems: [overdueItem({ forecastExpectedDate: "2026-09-12" })],
  });

  const row = rowOn(r, "2026-09-12");
  assert.equal(row.inflows, 50000);
  assert.equal(row.items.length, 1);
  assert.equal(r.totals.inflows, 50000);
  assert.equal(r.inclusion.excludedOverdueOpenItems, 0, "no longer excluded");
  assert.equal(r.inclusion.excludedOverdueAmount, 0);
  assert.equal(r.inclusion.includedOpenItems, 1);

  // It is placed on the EXPECTED date, never on its due date or on day 1.
  assert.equal(rowOn(r, AS_OF).inflows, 0);
});

test("1-C: an included overdue item keeps its ORIGINAL due date and true age", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 30,
    openingCash: 0,
    openItems: [overdueItem({ dueDate: "2026-07-01", forecastExpectedDate: "2026-09-12" })],
  });

  const it = rowOn(r, "2026-09-12").items[0];
  assert.equal(it.overdue, true);
  assert.equal(fc.dayKey(it.dueDate), "2026-07-01", "the contractual date is preserved");
  assert.equal(fc.dayKey(it.forecastExpectedDate), "2026-09-12");
  assert.equal(fc.dayKey(it.date), "2026-09-12", "placed on the expectation");
  // 1 Jul → 1 Sep is 62 days. Age is measured from the DUE date: an
  // expectation does not make a bill less late.
  assert.equal(it.ageDays, 62);
});

test("1-C: an included overdue item is sourced as a manual expected date, not its ladder rung", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 30,
    openingCash: 0,
    openItems: [
      overdueItem({
        source: S.COMPANY_DEFAULT, // how its DUE date was derived
        forecastExpectedDate: "2026-09-12",
        forecastExpectedDateNotes: "AP confirmed 12 Sep",
        forecastExpectedDateUpdatedByName: "Priya Editor",
      }),
    ],
  });

  const it = rowOn(r, "2026-09-12").items[0];
  assert.equal(it.source, "manual_expected_date");
  assert.equal(it.sourceLabel, "Manual expected date");
  assert.equal(it.forecastDateSource, "manual_expected_date");
  assert.equal(it.derived, false, "a person stated this; nothing was inferred");
  assert.equal(it.forecastExpectedDateNotes, "AP confirmed 12 Sep");
  assert.equal(it.forecastExpectedDateUpdatedByName, "Priya Editor");

  assert.deepEqual(r.sourceBreakdown.manualExpectedDate, { count: 1, amount: 50000 });
  assert.deepEqual(
    r.sourceBreakdown.companyDefaultDerived,
    { count: 0, amount: 0 },
    "counted once, under the source that actually placed it",
  );
});

test("1-C: an overdue item expected BEYOND the horizon is not in rows, but is not 'missing a date' either", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 30, // 1–30 Sep
    openingCash: 0,
    openItems: [overdueItem({ forecastExpectedDate: "2026-12-01" })],
  });

  assert.equal(r.totals.inflows, 0);
  assert.equal(r.inclusion.excludedOverdueOpenItems, 0, "it HAS a date; it is just further out");
  assert.equal(r.coverage.openItemsBeyondHorizon, 1);
});

test("1-C: an expectation that has itself gone stale keeps the bill excluded", () => {
  // The write endpoint refuses a past date, but a date set weeks ago can be
  // overtaken by time. Defensive: a stale expectation must not resurrect the
  // bill onto some earlier row.
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 30,
    openingCash: 0,
    openItems: [overdueItem({ forecastExpectedDate: "2026-08-15" })],
  });

  assert.equal(r.totals.inflows, 0);
  assert.equal(r.inclusion.excludedOverdueOpenItems, 1);
  assert.equal(r.rows.flatMap((x) => x.items).length, 0);
});

test("1-C: an expectation on a NOT-overdue item is ignored — it is already correctly dated", () => {
  // The feature is scoped to overdue bills. A future-dated bill keeps its due
  // date; an expectation must not quietly move a contractual date.
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 30,
    openingCash: 0,
    openItems: [
      openItem({ dueDate: "2026-09-10", amount: 900, forecastExpectedDate: "2026-09-25" }),
    ],
  });

  assert.equal(rowOn(r, "2026-09-10").inflows, 900, "placed on its due date");
  assert.equal(rowOn(r, "2026-09-25").inflows, 0);
  assert.equal(rowOn(r, "2026-09-10").items[0].overdue, false);
  assert.equal(rowOn(r, "2026-09-10").items[0].forecastExpectedDate, null);
});

test("1-C: an overdue OUTFLOW with an expectation lands in outflows", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 30,
    openingCash: 100000,
    openItems: [
      overdueItem({ direction: "outflow", amount: 25000, forecastExpectedDate: "2026-09-08" }),
    ],
  });

  assert.equal(rowOn(r, "2026-09-08").outflows, 25000);
  assert.equal(rowOn(r, "2026-09-08").sources.openPayables, 25000);
  assert.equal(r.totals.closingCash, 75000);
});

test("1-C: an expectation exactly ON the as-of date is honoured", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 7,
    openingCash: 0,
    openItems: [overdueItem({ forecastExpectedDate: AS_OF })],
  });
  assert.equal(rowOn(r, AS_OF).inflows, 50000);
  assert.equal(r.inclusion.excludedOverdueOpenItems, 0);
});

/* ── excludedOverdue list ────────────────────────────────────────────────── */

test("1-C: excluded overdue bills are listed so a person can act on them", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 30,
    openingCash: 0,
    openItems: [
      overdueItem({ id: "a", billName: "OLD-A", dueDate: "2026-07-01", amount: 100 }),
      overdueItem({ id: "b", billName: "OLD-B", dueDate: "2026-05-01", amount: 200 }),
      openItem({ id: "fine", dueDate: "2026-09-10", amount: 300 }),
    ],
  });

  assert.equal(r.excludedOverdue.length, 2);
  // Oldest first — the most overdue is what someone chases first.
  assert.deepEqual(r.excludedOverdue.map((x) => x.billName), ["OLD-B", "OLD-A"]);
  const b = r.excludedOverdue[0];
  assert.equal(b.amount, 200);
  assert.equal(fc.dayKey(b.dueDate), "2026-05-01");
  assert.ok(b.ageDays > 100);
  assert.equal(b.forecastExpectedDate, null);
});

test("1-C: a bill excluded because its expectation went stale still shows that expectation", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 30,
    openingCash: 0,
    openItems: [overdueItem({ forecastExpectedDate: "2026-08-15" })],
  });
  assert.equal(r.excludedOverdue.length, 1);
  assert.equal(
    fc.dayKey(r.excludedOverdue[0].forecastExpectedDate),
    "2026-08-15",
    "so a person can see WHY it is still out",
  );
});

test("1-C: an included overdue bill is not in the excluded list", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 30,
    openingCash: 0,
    openItems: [overdueItem({ forecastExpectedDate: "2026-09-12" })],
  });
  assert.deepEqual(r.excludedOverdue, []);
});

/* ── Diagnostics include manually-expected rows ──────────────────────────── */

test("1-C: a manually-expected overdue bill counts in diagnostics movement", () => {
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 30,
    openingCash: 0,
    openItems: [
      overdueItem({ amount: 90000, partyOrLedgerName: "Mayfair", forecastExpectedDate: "2026-09-12" }),
      openItem({ id: "x", dueDate: "2026-09-20", amount: 10000, partyOrLedgerName: "Other" }),
    ],
  });

  assert.equal(fc.dayKey(r.diagnostics.concentration.maxDate), "2026-09-12");
  assert.equal(r.diagnostics.concentration.maxDateAmount, 90000);
  assert.equal(r.diagnostics.topParties[0].name, "Mayfair");
  assert.equal(r.diagnostics.topParties[0].amount, 90000);
  // Still descriptive: no severity anywhere.
  for (const k of ["severity", "level", "warning"]) {
    assert.ok(!(k in r.diagnostics.concentration));
  }
});

/* ── The load-bearing guarantee ──────────────────────────────────────────── */

test("1-C: with NO expected dates anywhere, every 1-B figure is unchanged", () => {
  const input = {
    asOfDate: AS_OF,
    horizonDays: 30,
    openingCash: 100000,
    openItems: [
      openItem({ id: "a", dueDate: "2026-09-03", amount: 40000, direction: "inflow" }),
      openItem({ id: "b", dueDate: "2026-09-10", amount: 15000, direction: "outflow" }),
      openItem({ id: "late", dueDate: "2026-08-01", amount: 99999, direction: "inflow" }),
    ],
    recurringItems: [recurring({ nextDueDate: "2026-09-05", amount: 30000 })],
  };

  const r = fc.buildForecast(input);

  assert.equal(r.openingCash, 100000);
  assert.equal(r.totals.inflows, 40000);
  assert.equal(r.totals.outflows, 45000);
  assert.equal(r.totals.netMovement, -5000);
  assert.equal(r.totals.closingCash, 95000);
  assert.equal(r.inclusion.excludedOverdueOpenItems, 1);
  assert.equal(r.inclusion.excludedOverdueAmount, 99999);
  assert.deepEqual(r.sourceBreakdown.manualExpectedDate, { count: 0, amount: 0 });
});

test("1-C: inputs are still never mutated", () => {
  const openItems = [overdueItem({ forecastExpectedDate: "2026-09-12" })];
  const before = JSON.stringify(openItems);
  fc.buildForecast({ asOfDate: AS_OF, horizonDays: 30, openingCash: 0, openItems });
  assert.equal(JSON.stringify(openItems), before);
});

test("1-C scope guard: nothing predicts a date", () => {
  const exported = Object.keys(fc);
  for (const forbidden of ["predictExpectedDate", "collectionLag", "estimateArrival", "suggestDate"]) {
    assert.ok(!exported.includes(forbidden), `${forbidden} is the behavioural model, not 1-C`);
  }
  const r = fc.buildForecast({
    asOfDate: AS_OF,
    horizonDays: 7,
    openingCash: 0,
    openItems: [overdueItem()],
  });
  // An excluded overdue bill is offered no suggested date.
  assert.equal(r.excludedOverdue[0].forecastExpectedDate, null);
  assert.ok(!("suggestedDate" in r.excludedOverdue[0]));
  assert.ok(!("predictedDate" in r.excludedOverdue[0]));
});

/* ═══════════════════════════════════════════════════════════════════════════
 * CHUNK 1-E — WEEKLY GROUPING (presentation only)
 *
 * Weekly rows are aggregated FROM the daily rows, never recomputed. The 70
 * tests above are 1-A/B/C/D's and were not edited — that they still pass is
 * the proof no forecast math moved.
 * ═══════════════════════════════════════════════════════════════════════════ */

// 2026-09-01 is a Tuesday, so a horizon starting here gives a partial first
// week (Tue–Sun) — exactly the clipping case worth pinning.
test("1-E: startOfWeekUTC returns the Monday, including for a Sunday", () => {
  const mon = (d) => fc.dayKey(fc.startOfWeekUTC(d));
  assert.equal(mon("2026-09-01"), "2026-08-31", "Tuesday → that Monday");
  assert.equal(mon("2026-08-31"), "2026-08-31", "Monday → itself");
  // Sunday is 6 days INTO its week, not the start of a new one — the usual
  // off-by-one in week bucketing.
  assert.equal(mon("2026-09-06"), "2026-08-31", "Sunday → the preceding Monday");
  assert.equal(mon("2026-09-07"), "2026-09-07", "the next Monday starts a new week");
});

test("1-E: default grouping is daily for 7/15/30 and weekly for 60/90", () => {
  for (const h of [7, 15, 30]) {
    assert.equal(fc.defaultGroupingFor(h), "daily", `${h}d`);
    assert.equal(
      fc.buildForecast({ asOfDate: AS_OF, horizonDays: h, openingCash: 0 }).grouping.defaultMode,
      "daily",
    );
  }
  for (const h of [60, 90]) {
    assert.equal(fc.defaultGroupingFor(h), "weekly", `${h}d`);
    assert.equal(
      fc.buildForecast({ asOfDate: AS_OF, horizonDays: h, openingCash: 0 }).grouping.defaultMode,
      "weekly",
    );
  }
});

test("1-E: an explicit groupBy overrides the default, and a bad one falls back", () => {
  const weekly30 = fc.buildForecast({ asOfDate: AS_OF, horizonDays: 30, openingCash: 0, groupBy: "weekly" });
  assert.equal(weekly30.grouping.mode, "weekly");
  assert.equal(weekly30.grouping.defaultMode, "daily", "the default is still reported");

  const daily90 = fc.buildForecast({ asOfDate: AS_OF, horizonDays: 90, openingCash: 0, groupBy: "daily" });
  assert.equal(daily90.grouping.mode, "daily");

  // The route refuses an invalid value; the engine simply does not honour one.
  const bad = fc.buildForecast({ asOfDate: AS_OF, horizonDays: 90, openingCash: 0, groupBy: "monthly" });
  assert.equal(bad.grouping.mode, "weekly", "falls back to the horizon default");
  assert.deepEqual(bad.grouping.available, ["daily", "weekly"]);
});

test("1-E: weekly rows are always present, whatever the mode — grouping is presentation", () => {
  const r = fc.buildForecast({ asOfDate: AS_OF, horizonDays: 30, openingCash: 0 });
  assert.equal(r.grouping.mode, "daily");
  assert.ok(r.weeklyRows.length > 0, "the payload carries both views");
  assert.equal(r.rows.length, 30, "daily rows are never replaced");
});

/* ── Aggregation correctness ─────────────────────────────────────────────── */

/** A 30-day forecast with movement spread across several weeks. */
function weeklyFixture(horizonDays = 30) {
  return fc.buildForecast({
    asOfDate: AS_OF, // Tuesday
    horizonDays,
    openingCash: 100000,
    openItems: [
      openItem({ id: "a", billName: "A", dueDate: "2026-09-02", amount: 5000, direction: "inflow" }),
      openItem({ id: "b", billName: "B", dueDate: "2026-09-04", amount: 3000, direction: "outflow" }),
      openItem({ id: "c", billName: "C", dueDate: "2026-09-09", amount: 20000, direction: "inflow" }),
      openItem({ id: "d", billName: "D", dueDate: "2026-09-19", amount: 40000, direction: "inflow" }),
      openItem({ id: "e", billName: "E", dueDate: "2026-09-20", amount: 15000, direction: "inflow" }),
    ],
    recurringItems: [recurring({ nextDueDate: "2026-09-05", amount: 8000 })],
  });
}

test("1-E: the first week is clipped to the horizon, not to the calendar Monday", () => {
  const r = weeklyFixture();
  const w0 = r.weeklyRows[0];
  // The horizon starts Tuesday 1 Sep, so week 1 is Tue–Sun, six days.
  assert.equal(fc.dayKey(w0.weekStart), "2026-09-01");
  assert.equal(fc.dayKey(w0.weekEnd), "2026-09-06");
  assert.equal(w0.dayCount, 6, "a partial first week reports its real length");
});

test("1-E: the last week is clipped to the horizon too", () => {
  const r = weeklyFixture(30); // 1–30 Sep; 30 Sep is a Wednesday
  const last = r.weeklyRows[r.weeklyRows.length - 1];
  assert.equal(fc.dayKey(last.weekEnd), "2026-09-30");
  assert.ok(last.dayCount < 7, "the final partial week is not padded past the horizon");
});

test("1-E: every day of the horizon lands in exactly one week", () => {
  const r = weeklyFixture(90);
  const total = r.weeklyRows.reduce((s, w) => s + w.dayCount, 0);
  assert.equal(total, 90, "no day is dropped or double-counted");

  const seen = new Set();
  for (const w of r.weeklyRows) {
    for (const row of r.rows) {
      if (row.date >= w.weekStart && row.date <= w.weekEnd) seen.add(fc.dayKey(row.date));
    }
  }
  assert.equal(seen.size, 90);
});

test("1-E: weekly opening is the week's FIRST daily opening", () => {
  const r = weeklyFixture();
  for (const w of r.weeklyRows) {
    const firstDay = r.rows.find((x) => fc.dayKey(x.date) === fc.dayKey(w.weekStart));
    assert.equal(w.opening, firstDay.opening, fc.dayKey(w.weekStart));
  }
  assert.equal(r.weeklyRows[0].opening, 100000, "week 1 opens on the opening cash");
});

test("1-E: weekly closing is the week's LAST daily closing", () => {
  const r = weeklyFixture();
  for (const w of r.weeklyRows) {
    const lastDay = r.rows.find((x) => fc.dayKey(x.date) === fc.dayKey(w.weekEnd));
    assert.equal(w.closing, lastDay.closing, fc.dayKey(w.weekEnd));
  }
});

test("1-E: weekly rows roll forward — each week opens where the last one closed", () => {
  const r = weeklyFixture(90);
  for (let i = 1; i < r.weeklyRows.length; i += 1) {
    assert.equal(
      r.weeklyRows[i].opening,
      r.weeklyRows[i - 1].closing,
      `week ${i} should open on week ${i - 1}'s close`,
    );
  }
});

test("1-E: weekly inflow/outflow/net are the sums of their days", () => {
  const r = weeklyFixture();
  for (const w of r.weeklyRows) {
    const days = r.rows.filter((x) => x.date >= w.weekStart && x.date <= w.weekEnd);
    const inSum = fc.round2(days.reduce((s, d) => s + d.inflows, 0));
    const outSum = fc.round2(days.reduce((s, d) => s + d.outflows, 0));
    assert.equal(w.inflows, inSum);
    assert.equal(w.outflows, outSum);
    assert.equal(w.netMovement, fc.round2(inSum - outSum));
  }
});

test("1-E: weekly sources sum their days' sources", () => {
  const r = weeklyFixture();
  for (const w of r.weeklyRows) {
    const days = r.rows.filter((x) => x.date >= w.weekStart && x.date <= w.weekEnd);
    for (const k of ["openReceivables", "openPayables", "recurringInflows", "recurringOutflows"]) {
      assert.equal(
        w.sources[k],
        fc.round2(days.reduce((s, d) => s + d.sources[k], 0)),
        `${k} in week starting ${fc.dayKey(w.weekStart)}`,
      );
    }
  }
});

test("1-E: weekly minimum cash is the lowest daily CLOSING inside the week", () => {
  const r = weeklyFixture();
  for (const w of r.weeklyRows) {
    const days = r.rows.filter((x) => x.date >= w.weekStart && x.date <= w.weekEnd);
    const lowest = Math.min(...days.map((d) => d.closing));
    assert.equal(w.minimumCash, fc.round2(lowest));
    const expectedDate = days.find((d) => d.closing === lowest).date;
    assert.equal(fc.dayKey(w.minimumCashDate), fc.dayKey(expectedDate));
  }
});

test("1-E: on a tie the weekly minimum keeps the earliest date", () => {
  // A flat week: every closing is identical.
  const r = fc.buildForecast({ asOfDate: AS_OF, horizonDays: 7, openingCash: 500 });
  const w = r.weeklyRows[0];
  assert.equal(w.minimumCash, 500);
  assert.equal(fc.dayKey(w.minimumCashDate), AS_OF);
});

test("1-E: dayCount and movingDayCount describe the week honestly", () => {
  const r = weeklyFixture();
  const w0 = r.weeklyRows[0]; // 1–6 Sep: movement on 2, 4, 5
  assert.equal(w0.dayCount, 6);
  assert.equal(w0.movingDayCount, 3);

  for (const w of r.weeklyRows) {
    const days = r.rows.filter((x) => x.date >= w.weekStart && x.date <= w.weekEnd);
    assert.equal(w.movingDayCount, days.filter((d) => d.inflows > 0 || d.outflows > 0).length);
    assert.ok(w.movingDayCount <= w.dayCount);
  }
});

/* ── Items ───────────────────────────────────────────────────────────────── */

test("1-E: items concatenate into the correct week, losing none", () => {
  const r = weeklyFixture();
  const dailyItemCount = r.rows.reduce((s, d) => s + d.items.length, 0);
  const weeklyItemCount = r.weeklyRows.reduce((s, w) => s + w.items.length, 0);
  assert.equal(weeklyItemCount, dailyItemCount, "every drilldown item survives grouping");

  const w0Bills = r.weeklyRows[0].items.map((i) => i.billName).filter(Boolean).sort();
  assert.deepEqual(w0Bills, ["A", "B"], "week 1 holds only its own bills");
});

test("1-E: a week's items sum to that week's own inflow/outflow figures", () => {
  const r = weeklyFixture();
  for (const w of r.weeklyRows) {
    const inSum = fc.round2(
      w.items.filter((i) => i.direction === "inflow").reduce((s, i) => s + i.amount, 0),
    );
    const outSum = fc.round2(
      w.items.filter((i) => i.direction === "outflow").reduce((s, i) => s + i.amount, 0),
    );
    assert.equal(inSum, w.inflows, `inflows for week ${fc.dayKey(w.weekStart)}`);
    assert.equal(outSum, w.outflows, `outflows for week ${fc.dayKey(w.weekStart)}`);
  }
});

/* ── The load-bearing guarantee: the two views agree ─────────────────────── */

test("1-E: daily and weekly totals are identical", () => {
  for (const h of [7, 15, 30, 60, 90]) {
    const r = weeklyFixture(h);

    const wIn = fc.round2(r.weeklyRows.reduce((s, w) => s + w.inflows, 0));
    const wOut = fc.round2(r.weeklyRows.reduce((s, w) => s + w.outflows, 0));

    assert.equal(wIn, r.totals.inflows, `inflows at ${h}d`);
    assert.equal(wOut, r.totals.outflows, `outflows at ${h}d`);
    assert.equal(
      fc.round2(wIn - wOut),
      r.totals.netMovement,
      `net at ${h}d`,
    );
    // The last week's closing IS the horizon's closing cash.
    assert.equal(
      r.weeklyRows[r.weeklyRows.length - 1].closing,
      r.totals.closingCash,
      `closing at ${h}d`,
    );
    // And the lowest weekly minimum is the horizon's minimum.
    const lowestWeekly = Math.min(...r.weeklyRows.map((w) => w.minimumCash));
    assert.equal(lowestWeekly, r.totals.minimumCash, `minimum at ${h}d`);
  }
});

test("1-E: grouping changes no figure the earlier chunks published", () => {
  const daily = fc.buildForecast({ asOfDate: AS_OF, horizonDays: 90, openingCash: 100000, groupBy: "daily" });
  const weekly = fc.buildForecast({ asOfDate: AS_OF, horizonDays: 90, openingCash: 100000, groupBy: "weekly" });

  assert.deepEqual(weekly.totals, daily.totals);
  assert.deepEqual(weekly.inclusion, daily.inclusion);
  assert.deepEqual(weekly.sourceBreakdown, daily.sourceBreakdown);
  assert.deepEqual(weekly.diagnostics, daily.diagnostics);
  assert.equal(weekly.rows.length, daily.rows.length);
});

/* ── Edge cases ──────────────────────────────────────────────────────────── */

test("1-E: a horizon of zero days produces no weekly rows rather than throwing", () => {
  const r = fc.buildForecast({ asOfDate: AS_OF, horizonDays: 0, openingCash: 4200 });
  assert.deepEqual(r.weeklyRows, []);
  assert.deepEqual(fc.buildWeeklyRows([]), []);
  assert.deepEqual(fc.buildWeeklyRows(null), []);
});

test("1-E: a horizon starting exactly on a Monday gives a full first week", () => {
  const r = fc.buildForecast({ asOfDate: "2026-08-31", horizonDays: 14, openingCash: 0 });
  assert.equal(r.weeklyRows.length, 2);
  assert.equal(r.weeklyRows[0].dayCount, 7);
  assert.equal(r.weeklyRows[1].dayCount, 7);
  assert.equal(fc.dayKey(r.weeklyRows[0].weekStart), "2026-08-31");
  assert.equal(fc.dayKey(r.weeklyRows[0].weekEnd), "2026-09-06");
});

test("1-E: a 7-day horizon from a Tuesday spans two partial weeks", () => {
  const r = fc.buildForecast({ asOfDate: AS_OF, horizonDays: 7, openingCash: 0 });
  assert.equal(r.weeklyRows.length, 2);
  assert.deepEqual(r.weeklyRows.map((w) => w.dayCount), [6, 1]);
});

test("1-E: weekly aggregation does not mutate the daily rows", () => {
  const r = weeklyFixture();
  const before = JSON.stringify(r.rows);
  fc.buildWeeklyRows(r.rows);
  assert.equal(JSON.stringify(r.rows), before);
});

test("1-E scope guard: grouping adds no scenario, band or alert output", () => {
  const r = fc.buildForecast({ asOfDate: AS_OF, horizonDays: 90, openingCash: 0, groupBy: "weekly" });
  assert.equal(r.scenario, "base");
  for (const k of ["best", "worst", "confidence", "alerts", "bands"]) {
    assert.ok(!(k in r), `${k} is a later chunk`);
  }
  const w = r.weeklyRows[0];
  for (const k of ["severity", "trend", "forecastQuality", "confidence"]) {
    assert.ok(!(k in w), `a weekly row must not carry ${k}`);
  }
});
