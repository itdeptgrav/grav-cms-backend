// What a department head is told when they open /budget.
//
// Pure, so the cases that matter are cheap: a nature the department does not
// have must produce nothing, revenue must never be called over budget, and a
// beaten target must not be a risk.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ac = require("./budgetActionCentre.service");

const NOW = new Date("2026-09-01T00:00:00.000Z");
const inDays = (n) => new Date(NOW.getTime() + n * 86400000).toISOString();

const req = (over = {}) => ({
  _id: "r1", budgetId: "b1", budgetName: "FY26-27", ledgerName: "Raw Material",
  nature: "expense", requestedAmount: 100000, state: "submitted", requestedHead: null, ...over,
});

const head = (over = {}) => ({
  key: "expense::L1", ledgerId: "L1", ledgerName: "Raw Material", nature: "expense",
  approved: 1000000, actual: 400000, remaining: 600000, toGo: null,
  utilizationPct: 40, expectedToDate: 420000, paceGap: 20000, severity: "info",
  unbound: false, budgetId: "b1", ...over,
});

const build = (o) => ac.buildActionCentre({ now: NOW, ...o });

/* ── nothing at all ──────────────────────────────────────────────────────── */

test("an empty department gets empty groups, not zeros", () => {
  const r = build({});
  assert.equal(r.counts.actionable, 0);
  for (const g of ["needsYourAnswer", "waitingOnFinance", "financeUpdates", "financialRisks", "deadlines"]) {
    assert.deepEqual(r[g], []);
  }
});

/* ── needs your answer ───────────────────────────────────────────────────── */

test("a countered proposal needs an answer and links to the revise page", () => {
  const r = build({ requests: [req({ state: "countered", counterAmount: 80000 })] });
  assert.equal(r.needsYourAnswer.length, 1);
  assert.equal(r.needsYourAnswer[0].type, "proposal_countered");
  assert.equal(r.needsYourAnswer[0].actionHref, "/budget/cycles/b1/propose?request=r1");
});

test("a head finance questioned needs an answer", () => {
  const r = build({
    requests: [req({ requestedHead: { name: "Claude Team", state: "clarification", financeNote: "Per seat?" } })],
  });
  assert.equal(r.needsYourAnswer[0].type, "head_clarification");
  assert.match(r.needsYourAnswer[0].description, /Per seat/);
});

test("a refused head outranks a counter", () => {
  const r = build({
    requests: [
      req({ _id: "r1", state: "countered", counterAmount: 1 }),
      req({ _id: "r2", requestedHead: { name: "X", state: "rejected" } }),
    ],
  });
  assert.equal(r.needsYourAnswer[0].severity, "risk");
  assert.equal(r.needsYourAnswer[0].type, "head_rejected");
});

/* ── waiting on finance stays calm ───────────────────────────────────────── */

test("submitted work is info, never a warning", () => {
  const r = build({ requests: [req(), req({ _id: "r2" })] });
  assert.equal(r.needsYourAnswer.length, 0);
  assert.equal(r.waitingOnFinance.length, 1);
  assert.equal(r.waitingOnFinance[0].severity, "info");
  assert.equal(r.waitingOnFinance[0].amount, 200000);
});

test("an open adjustment waits on finance", () => {
  const r = build({
    adjustments: [{ _id: "a1", budgetId: "b1", ledgerName: "Raw Material", type: "supplementary",
      requestedDeltaAmount: 5000, requestedNewAmount: 15000, state: "submitted" }],
  });
  assert.equal(r.waitingOnFinance[0].type, "adjustment_pending");
});

/* ── finance updates ─────────────────────────────────────────────────────── */

test("approvals are positive, refusals are calm", () => {
  const r = build({
    requests: [req({ state: "agreed", agreedAmount: 90000 })],
    adjustments: [{ _id: "a1", budgetId: "b1", ledgerName: "X", type: "revision",
      requestedNewAmount: 5, state: "rejected", financeNote: "No." }],
  });
  const kinds = r.financeUpdates.map((u) => `${u.type}:${u.severity}`);
  assert.ok(kinds.includes("proposals_agreed:positive"));
  assert.ok(kinds.includes("adjustment_rejected:info"));
  assert.equal(r.needsYourAnswer.length, 0, "a decision is not an action");
});

/* ── financial risk ──────────────────────────────────────────────────────── */

test("an expense head over its budget is a risk", () => {
  const r = build({ tracker: { heads: [head({ actual: 1200000, remaining: -200000, utilizationPct: 120, severity: "critical" })] } });
  assert.equal(r.financialRisks[0].type, "expense_over_budget");
  assert.equal(r.financialRisks[0].amount, 200000);
  assert.equal(r.financialRisks[0].actionHref, "/budget/heads/L1?nature=expense");
});

test("a comfortable expense head raises nothing", () => {
  assert.deepEqual(build({ tracker: { heads: [head()] } }).financialRisks, []);
});

test("a revenue head is never called over budget", () => {
  /* Earned far past the target — a triumph, not a risk. */
  const r = build({
    tracker: { heads: [head({ key: "revenue::L3", ledgerId: "L3", ledgerName: "Export Sales", nature: "revenue",
      approved: 1000000, actual: 1400000, remaining: null, toGo: 0, utilizationPct: 140,
      expectedToDate: 420000, paceGap: 980000, severity: "info" })] },
  });
  assert.deepEqual(r.financialRisks, []);
});

test("a revenue head behind its plan is a risk, in revenue words", () => {
  const r = build({
    tracker: { heads: [head({ key: "revenue::L3", ledgerId: "L3", ledgerName: "Export Sales", nature: "revenue",
      approved: 1000000, actual: 100000, remaining: null, toGo: 900000, utilizationPct: 10,
      expectedToDate: 420000, paceGap: -320000, severity: "critical" })] },
  });
  assert.equal(r.financialRisks[0].type, "revenue_behind_target");
  assert.match(r.financialRisks[0].title, /behind target/);
  assert.doesNotMatch(JSON.stringify(r.financialRisks[0]), /over budget|spent/i);
  assert.equal(r.financialRisks[0].actionHref, "/budget/heads/L3?nature=revenue");
});

test("a department with no revenue heads gets no revenue alert", () => {
  const r = build({ tracker: { heads: [head({ severity: "warning", utilizationPct: 92 })] } });
  assert.equal(r.financialRisks.length, 1);
  assert.equal(r.financialRisks[0].type, "expense_near_limit");
});

test("an unbound head cannot be at risk", () => {
  assert.deepEqual(
    build({ tracker: { heads: [head({ unbound: true, severity: "critical", remaining: -1 })] } }).financialRisks,
    [],
  );
});

/* ── deadlines ───────────────────────────────────────────────────────────── */

test("a cycle closing soon with nothing in it is a risk", () => {
  const r = build({ cycles: [{ _id: "b1", name: "Autumn", endDate: inDays(5) }] });
  assert.equal(r.deadlines[0].type, "cycle_closing_empty");
  assert.equal(r.deadlines[0].severity, "risk");
  assert.match(r.deadlines[0].title, /closes in 5 days/);
  assert.equal(r.deadlines[0].actionHref, "/budget/cycles/b1/propose");
});

test("a cycle closing soon with lines already in it is not", () => {
  const r = build({
    cycles: [{ _id: "b1", name: "Autumn", endDate: inDays(5) }],
    requests: [req({ state: "submitted" })],
  });
  assert.deepEqual(r.deadlines, []);
});

test("a cycle closing soon with an unanswered line asks for the answer", () => {
  const r = build({
    cycles: [{ _id: "b1", name: "Autumn", endDate: inDays(3) }],
    requests: [req({ state: "countered" })],
  });
  assert.equal(r.deadlines[0].type, "cycle_closing_incomplete");
  assert.equal(r.deadlines[0].actionHref, "/budget/cycles/b1/propose?request=r1");
});

test("a cycle far off is not a deadline", () => {
  assert.deepEqual(build({ cycles: [{ _id: "b1", name: "Later", endDate: inDays(90) }] }).deadlines, []);
});

test("a cycle already closed is not a deadline", () => {
  assert.deepEqual(build({ cycles: [{ _id: "b1", name: "Gone", endDate: inDays(-2) }] }).deadlines, []);
});

test("actionable counts only the groups that block work", () => {
  const r = build({
    cycles: [{ _id: "b1", name: "Autumn", endDate: inDays(4) }],
    requests: [req({ _id: "r9", state: "submitted", budgetId: "bZ" })],
    tracker: { heads: [head({ actual: 1200000, remaining: -200000, severity: "critical" })] },
  });
  assert.equal(r.counts.waitingOnFinance, 1);
  assert.equal(r.counts.financialRisks, 1);
  /* One empty closing cycle; risk and pending work are not "actionable". */
  assert.equal(r.counts.actionable, 1);
});

/* ── the net, which spans both natures ───────────────────────────────────── */

const totals = (rev, exp) => ({
  revenue: { approved: 0, actual: 0, expectedToDate: 0, count: 1, ...rev },
  expense: { approved: 0, actual: 0, expectedToDate: 0, count: 1, ...exp },
  hasRevenue: true,
  hasExpense: true,
});

test("a net behind its plan is a warning", () => {
  /* Expected 25,00,000 − 7,00,000 = 18,00,000 by now; actual is
     15,00,000 − 6,00,000 = 9,00,000. Nine lakh short. */
  const r = build({
    tracker: { heads: [], totals: totals(
      { actual: 1500000, expectedToDate: 2500000 },
      { actual: 600000, expectedToDate: 700000 },
    ) },
  });
  const net = r.financialRisks.find((x) => x.type === "net_behind_plan");
  assert.ok(net, "expected a net alert");
  assert.equal(net.amount, 900000);
  assert.match(net.description, /₹ 9,00,000/);
});

test("a net ahead of plan is not a risk", () => {
  const r = build({
    tracker: { heads: [], totals: totals(
      { actual: 3000000, expectedToDate: 2500000 },
      { actual: 500000, expectedToDate: 700000 },
    ) },
  });
  assert.deepEqual(r.financialRisks.filter((x) => x.type === "net_behind_plan"), []);
});

test("no net alert when the department has only one nature", () => {
  const only = {
    revenue: { approved: 0, actual: 0, expectedToDate: 0, count: 0 },
    expense: { approved: 1000000, actual: 900000, expectedToDate: 400000, count: 1 },
    hasRevenue: false,
    hasExpense: true,
  };
  const r = build({ tracker: { heads: [], totals: only } });
  assert.deepEqual(r.financialRisks.filter((x) => x.type === "net_behind_plan"), []);
});

test("a rounding-sized gap is not an alert", () => {
  const r = build({
    tracker: { heads: [], totals: totals(
      { actual: 2499000, expectedToDate: 2500000 },
      { actual: 700000, expectedToDate: 700000 },
    ) },
  });
  assert.deepEqual(r.financialRisks.filter((x) => x.type === "net_behind_plan"), []);
});

test("no net alert before the plan expects anything", () => {
  /* Both sides expect nothing yet — the year has not started. */
  const r = build({ tracker: { heads: [], totals: totals({ actual: 0 }, { actual: 0 }) } });
  assert.deepEqual(r.financialRisks.filter((x) => x.type === "net_behind_plan"), []);
});
