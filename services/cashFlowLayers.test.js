"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const l = require("./cashFlowLayers.service");

/* ── WHICH LAYER WAS ASKED FOR ───────────────────────────────────────────── */

test("the three layers are named, and an unknown one falls back", () => {
  assert.deepEqual(l.LAYERS, ["confirmed", "with_commitments", "budget_scenario"]);
  assert.equal(l.parseLayer("confirmed"), "confirmed");
  assert.equal(l.parseLayer("budget_scenario"), "budget_scenario");
  assert.equal(l.parseLayer("BUDGET_SCENARIO"), "budget_scenario");
  /* A forecast that refuses to draw because of a query string is worse than
     one that draws the usual view. */
  assert.equal(l.parseLayer("nonsense"), l.DEFAULT_LAYER);
  assert.equal(l.parseLayer(""), l.DEFAULT_LAYER);
  assert.equal(l.parseLayer(undefined), l.DEFAULT_LAYER);
});

/* ── SPREADING A YEAR ────────────────────────────────────────────────────── */

test("an even spread covers every month of the period and totals the allocation", () => {
  const months = l.evenSpread(120000, "2026-04-01", "2027-03-31");
  assert.equal(months.length, 12);
  assert.equal(months[0].month, "2026-04");
  assert.equal(months[11].month, "2027-03");
  assert.equal(months.reduce((s, m) => s + m.amount, 0), 120000);
});

test("the remainder lands on the last month rather than vanishing to rounding", () => {
  /* ₹100 over 12 months is ₹8.33 with 4 paise left over. Those paise have to
     be somewhere, or twelve months quietly total ₹99.96. */
  const months = l.evenSpread(100, "2026-04-01", "2027-03-31");
  assert.equal(Math.round(months.reduce((s, m) => s + m.amount, 0) * 100) / 100, 100);
  assert.notEqual(months[11].amount, months[0].amount);
});

test("a one-month period is one month", () => {
  const months = l.evenSpread(5000, "2026-04-01", "2026-04-30");
  assert.deepEqual(months, [{ month: "2026-04", amount: 5000 }]);
});

test("an unreadable period spreads nothing rather than throwing", () => {
  assert.deepEqual(l.evenSpread(1000, "not a date", "2027-03-31"), []);
});

test("month keys are UTC and zero-padded, so they sort as strings", () => {
  assert.equal(l.monthKey(new Date("2026-09-15T00:00:00Z")), "2026-09");
  assert.equal(l.monthKey("2026-01-01"), "2026-01");
  assert.equal(l.monthKey("not a date"), null);
  /* The whole join between plan, commitment and actual is this key. */
  assert.ok("2026-09" > "2026-08" && "2026-10" > "2026-09");
});
