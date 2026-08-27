"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { roundName, fyMonthIndex, roundDates } = require("./budgetRoundName.service");

/* The financial year runs April to March, so every date below is chosen to sit
   inside the period it is meant to name. */
const APR = "2026-04-01";
const JUL = "2026-07-01";
const OCT = "2026-10-01";
const JAN = "2027-01-01";

test("an annual round is named for the year alone", () => {
  assert.equal(
    roundName({ financialYear: "2026-27", period: "yearly", startDate: APR }),
    "Budget FY 2026-27",
  );
});

test("quarters count from April, not from January", () => {
  const q = (startDate) =>
    roundName({ financialYear: "2026-27", period: "quarterly", startDate });
  assert.equal(q(APR), "Budget FY 2026-27 Q1");
  assert.equal(q(JUL), "Budget FY 2026-27 Q2");
  assert.equal(q(OCT), "Budget FY 2026-27 Q3");
  /* January is Q4 of the PREVIOUS financial year, and the name says so. */
  assert.equal(q(JAN), "Budget FY 2026-27 Q4");
});

test("a monthly round carries the month it covers", () => {
  const m = (startDate) =>
    roundName({ financialYear: "2026-27", period: "monthly", startDate });
  assert.equal(m(APR), "Budget FY 2026-27 Apr");
  assert.equal(m("2026-08-01"), "Budget FY 2026-27 Aug");
  assert.equal(m("2027-03-01"), "Budget FY 2026-27 Mar");
});

test("halves split at October", () => {
  const h = (startDate) =>
    roundName({ financialYear: "2026-27", period: "half_yearly", startDate });
  assert.equal(h(APR), "Budget FY 2026-27 H1");
  assert.equal(h("2026-09-01"), "Budget FY 2026-27 H1");
  assert.equal(h(OCT), "Budget FY 2026-27 H2");
});

test("the same inputs always produce the same name", () => {
  const args = { financialYear: "2026-27", period: "quarterly", startDate: JUL };
  assert.equal(roundName(args), roundName({ ...args }));
});

test("a mid-period date names the period it falls in, not the one it starts", () => {
  /* Dates come from a form that auto-fills them, but an API caller may send
     any date inside the period. 20 August is still Q2. */
  assert.equal(
    roundName({ financialYear: "2026-27", period: "quarterly", startDate: "2026-08-20" }),
    "Budget FY 2026-27 Q2",
  );
});

test("an unreadable date degrades to the year rather than guessing a quarter", () => {
  /* A wrong quarter in a title is worse than no quarter: it would be read as
     a fact about which months the round covers. */
  for (const bad of [undefined, null, "", "not a date"]) {
    assert.equal(
      roundName({ financialYear: "2026-27", period: "quarterly", startDate: bad }),
      "Budget FY 2026-27",
    );
  }
});

test("no financial year means no name, so a caller can tell it failed", () => {
  assert.equal(roundName({ period: "yearly", startDate: APR }), "");
  assert.equal(roundName({}), "");
  assert.equal(roundName(), "");
});

test("an unrecognised period still names the year correctly", () => {
  assert.equal(
    roundName({ financialYear: "2026-27", period: "fortnightly", startDate: APR }),
    "Budget FY 2026-27",
  );
});

test("fyMonthIndex is April-based", () => {
  assert.equal(fyMonthIndex("2026-04-15"), 0);
  assert.equal(fyMonthIndex("2027-03-31"), 11);
  assert.equal(fyMonthIndex("not a date"), null);
});

/* ── THE RANGE A ROUND COVERS ────────────────────────────────────────────── */

test("an annual round runs April to March", () => {
  assert.deepEqual(roundDates({ financialYear: "2026-27", period: "yearly" }), {
    startDate: "2026-04-01",
    endDate: "2027-03-31",
  });
});

test("quarters run Apr-Jun, Jul-Sep, Oct-Dec, and Jan-Mar of the next year", () => {
  const q = (index) => roundDates({ financialYear: "2026-27", period: "quarterly", index });
  assert.deepEqual(q(0), { startDate: "2026-04-01", endDate: "2026-06-30" });
  assert.deepEqual(q(1), { startDate: "2026-07-01", endDate: "2026-09-30" });
  assert.deepEqual(q(2), { startDate: "2026-10-01", endDate: "2026-12-31" });
  /* Q4 crosses into the next calendar year — the case an April-based index
     exists to get right. */
  assert.deepEqual(q(3), { startDate: "2027-01-01", endDate: "2027-03-31" });
});

test("a month ends on its own last day, leap years included", () => {
  const m = (fy, index) => roundDates({ financialYear: fy, period: "monthly", index });
  assert.deepEqual(m("2026-27", 0), { startDate: "2026-04-01", endDate: "2026-04-30" });
  assert.deepEqual(m("2026-27", 11), { startDate: "2027-03-01", endDate: "2027-03-31" });
  /* February 2028 has 29 days; the FY starting 2027 covers it as month 10. */
  assert.deepEqual(m("2027-28", 10), { startDate: "2028-02-01", endDate: "2028-02-29" });
});

test("halves are Apr-Sep and Oct-Mar", () => {
  assert.deepEqual(roundDates({ financialYear: "2026-27", period: "half_yearly", index: 0 }), {
    startDate: "2026-04-01", endDate: "2026-09-30",
  });
  assert.deepEqual(roundDates({ financialYear: "2026-27", period: "half_yearly", index: 1 }), {
    startDate: "2026-10-01", endDate: "2027-03-31",
  });
});

test("an out-of-range index is clamped rather than producing a wild date", () => {
  assert.deepEqual(roundDates({ financialYear: "2026-27", period: "quarterly", index: 9 }),
    roundDates({ financialYear: "2026-27", period: "quarterly", index: 3 }));
  assert.deepEqual(roundDates({ financialYear: "2026-27", period: "monthly", index: -4 }),
    roundDates({ financialYear: "2026-27", period: "monthly", index: 0 }));
});

test("an unreadable year yields nulls, so a caller can tell it failed", () => {
  assert.deepEqual(roundDates({ financialYear: "", period: "yearly" }),
    { startDate: null, endDate: null });
  assert.deepEqual(roundDates(), { startDate: null, endDate: null });
});
