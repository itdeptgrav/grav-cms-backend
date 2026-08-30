// services/budgetRequestContext.test.js
//
// WHETHER AGREEING THIS ASK IS SAFE.
//
// `buildOne` is pure — every figure it needs is handed to it — so the whole
// decision surface is testable without a database. What is under test is not
// arithmetic for its own sake but two claims about the desk:
//
//   1 · agreeing a budget request RAISES an envelope, so the danger is a head
//       already spent past what the new allocation would cover — not the
//       allocation itself.
//   2 · a revenue head has a target, not a budget. No word of spend, nothing
//       "available", and nothing that can be over.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const ctx = require("./budgetRequestContext.service");

const id = (n) => ({ toString: () => `id${n}` });

const req = (over = {}) => ({
  _id: id(1),
  department: "Tech",
  ledgerId: id(99),
  ledgerName: "Repairs & Maintenance",
  nature: "expense",
  requestedAmount: 40000,
  state: "submitted",
  ...over,
});

const line = (allocated, over = {}) => ({
  _id: id(Math.random()),
  ledgerId: id(99),
  department: "Tech",
  allocatedAmount: allocated,
  ...over,
});

const build = ({ request = req(), actual = 0, allocations = [], committed = new Map() } = {}) =>
  ctx.buildOne({
    request,
    hydratedLine: { actual, nature: request.nature },
    allocations,
    committedByLine: committed,
  });

/* ══ AN EXPENSE ASK ═════════════════════════════════════════════════════════ */

test("a head with nothing on it yet reports the ask as the whole envelope", () => {
  const c = build();
  assert.equal(c.kind, "expense");
  assert.equal(c.approved, 0);
  assert.equal(c.approvedAfter, 40000);
  assert.equal(c.availableBefore, 0);
  assert.equal(c.availableAfter, 40000);
  assert.equal(c.verdict, "within");
});

test("approved, spent, committed, available and after-approval all line up", () => {
  const l = line(100000);
  const c = build({
    actual: 30000,
    allocations: [l],
    committed: new Map([[String(l._id), 20000]]),
  });

  assert.equal(c.approved, 100000);
  assert.equal(c.actual, 30000);
  assert.equal(c.committed, 20000);
  assert.equal(c.availableBefore, 50000); // 100000 − 30000 − 20000
  // Agreeing RAISES the envelope. This is the arithmetic that looks backwards
  // and is not: a budget request asks to be allocated, not to spend.
  assert.equal(c.approvedAfter, 140000);
  assert.equal(c.availableAfter, 90000);
  // Of the envelope this would create, 50k of 140k is already gone.
  assert.equal(c.usageAfterPct, 35.7);
});

test("a head already spent past the new envelope is the case worth shouting about", () => {
  const l = line(50000);
  const c = build({
    actual: 200000,
    allocations: [l],
    committed: new Map([[String(l._id), 10000]]),
  });
  // 50000 + 40000 − 200000 − 10000
  assert.equal(c.availableAfter, -120000);
  assert.equal(c.verdict, "exceeds");
  assert.equal(c.verdictLabel, "Will exceed budget");
  assert.ok(c.usageAfterPct > 100);
});

test("several lines on the same head for the same department add up", () => {
  const a = line(30000);
  const b = line(20000);
  const c = build({
    allocations: [a, b],
    committed: new Map([[String(a._id), 5000], [String(b._id), 1000]]),
  });
  assert.equal(c.approved, 50000);
  assert.equal(c.committed, 6000);
  assert.equal(c.allocationLines, 2);
});

test("a cost-centre-bound allocation is flagged rather than silently mixed", () => {
  // The envelope is the line's; the actual beside it is the whole head's. A
  // figure broader than the line it sits against is one to be told about.
  const c = build({ allocations: [line(10000, { costCentreId: id(7) })] });
  assert.equal(c.costCentreBound, true);
});

/* ══ WHICH FIGURE IS BEING DECIDED ══════════════════════════════════════════ */

test("finance's counter is what the context is computed against", () => {
  // A countered request is finance saying "not that, this". Modelling the
  // department's original figure would model a decision nobody will make.
  const c = build({
    request: req({ state: "countered", counterAmount: 15000 }),
    allocations: [line(10000)],
  });
  assert.equal(c.amount, 15000);
  assert.equal(c.amountBasis, "countered");
  assert.equal(c.approvedAfter, 25000);
});

test("an agreed request reports what was agreed, not what was asked", () => {
  const c = build({ request: req({ state: "agreed", agreedAmount: 8000 }) });
  assert.equal(c.amount, 8000);
  assert.equal(c.amountBasis, "agreed");
});

test("an untouched request is computed against the ask", () => {
  const c = build();
  assert.equal(c.amount, 40000);
  assert.equal(c.amountBasis, "requested");
});

/* ══ A REVENUE ASK ══════════════════════════════════════════════════════════ */

test("a revenue head speaks target and earned, and never spend", () => {
  const c = build({
    request: req({ nature: "revenue", requestedAmount: 300000, ledgerName: "Export Sales" }),
    actual: 120000,
    allocations: [],
  });

  assert.equal(c.kind, "revenue");
  assert.equal(c.target, 0);
  assert.equal(c.targetAfter, 300000);
  assert.equal(c.earned, 120000);
  assert.equal(c.toGo, 180000);
  assert.equal(c.achievedPct, 40);
  assert.equal(c.verdictLabel, "Revenue target change");

  // The expense vocabulary must not be reachable on this shape at all — a
  // screen reading `available` off a revenue context would get undefined and
  // render nothing, rather than rendering a number that means something else.
  assert.equal(c.available, undefined);
  assert.equal(c.availableAfter, undefined);
  assert.equal(c.approved, undefined);
  assert.equal(c.usageAfterPct, undefined);
});

test("a revenue head is never over budget, however far past its target it is", () => {
  const c = build({
    request: req({ nature: "revenue", requestedAmount: 100000 }),
    actual: 900000,
  });
  assert.equal(c.verdict, "revenue_target");
  assert.notEqual(c.verdict, "exceeds");
  // Beaten, not overspent. To-go floors at zero rather than going negative.
  assert.equal(c.toGo, 0);
  assert.equal(c.achievedPct, 900);
});

test("a target's direction compares before against after, not ask against standing", () => {
  // The comparison that matters is what happens to the HEAD. Agreeing writes a
  // new line rather than replacing the old one, so a small ask on a big target
  // raises it — and comparing the ask against the standing figure would print
  // "reduced" beside a target going up.
  assert.equal(ctx.targetDirection(0, 300000), "new");
  assert.equal(ctx.targetDirection(200000, 300000), "increased");
  assert.equal(ctx.targetDirection(400000, 300000), "reduced");
  assert.equal(ctx.targetDirection(300000, 300000), "unchanged");
});

test("a small ask on a large standing target still reads as increased", () => {
  const c = build({
    request: req({ nature: "revenue", requestedAmount: 300000 }),
    allocations: [line(2000000)],
  });
  assert.equal(c.target, 2000000);
  assert.equal(c.targetAfter, 2300000);
  // The word and the figure beside it have to agree.
  assert.equal(c.direction, "increased");
});

test("through this door a target can never read as reduced", () => {
  // The schema floors a request at zero, so nothing raised here lowers one.
  for (const standing of [0, 1000, 5000000]) {
    const c = build({
      request: req({ nature: "revenue", requestedAmount: 1 }),
      allocations: standing ? [line(standing)] : [],
    });
    assert.notEqual(c.direction, "reduced");
  }
});

/* ══ THE HEADS NOBODY HAS SETTLED ═══════════════════════════════════════════ */

test("a request with no ledger has no numbers, and says so", () => {
  // Inventing zeroes would render as "no budget used" rather than "nobody has
  // decided what this posts against".
  const c = build({ request: req({ ledgerId: null }) });
  assert.equal(c.kind, "no_head");
  assert.equal(c.verdictLabel, "No approved budget head");
  assert.equal(c.hasHead, false);
  assert.equal(c.approved, undefined);
});

test("a new head still under discussion is treated the same way", () => {
  for (const state of ["requested", "clarification", "rejected"]) {
    const c = build({ request: req({ requestedHead: { state, name: "Drone hire" } }) });
    assert.equal(c.kind, "no_head", state);
  }
});

test("a new head finance has since mapped reads normally", () => {
  const c = build({
    request: req({ requestedHead: { state: "resolved", resolvedLedgerName: "Drone hire" } }),
    allocations: [line(5000)],
  });
  assert.equal(c.kind, "expense");
  assert.equal(c.approved, 5000);
});

test("an asset or liability head gets neither vocabulary", () => {
  // natureOf maps those to "other" rather than coercing them to expense. The
  // screen says the nature is not classified and offers no wrong label.
  const c = build({ request: req({ nature: "asset" }) });
  assert.equal(c.kind, "unknown");
  assert.equal(c.verdictLabel, "Head nature not classified");
  assert.equal(c.availableAfter, undefined);
  assert.equal(c.toGo, undefined);
});

/* ══ THE HEADLINE ═══════════════════════════════════════════════════════════ */

const budgetOf = (items = []) => ({ items, startDate: new Date(), endDate: new Date() });

test("the headline counts what is waiting, not what is settled", () => {
  const rows = [
    req({ _id: id(1) }),
    req({ _id: id(2), state: "agreed", agreedAmount: 5000 }),
    req({ _id: id(3), state: "rejected" }),
  ];
  const contexts = Object.fromEntries(
    rows.map((r) => [String(r._id), build({ request: r })]),
  );
  const s = ctx.summarise(rows, contexts, budgetOf());

  assert.equal(s.waiting, 1);
  assert.equal(s.requestedExpense, 40000);
});

test("expense and revenue asks are totalled apart", () => {
  const rows = [req({ _id: id(1) }), req({ _id: id(2), nature: "revenue", requestedAmount: 500000 })];
  const contexts = Object.fromEntries(
    rows.map((r) => [String(r._id), build({ request: r })]),
  );
  const s = ctx.summarise(rows, contexts, budgetOf());

  assert.equal(s.requestedExpense, 40000);
  assert.equal(s.requestedRevenue, 500000);
});

test("an unresolved head still counts as money being asked for", () => {
  // Leaving it out would understate the queue by exactly the requests nobody
  // has classified yet.
  const rows = [req({ _id: id(1), ledgerId: null })];
  const contexts = { id1: build({ request: rows[0] }) };
  const s = ctx.summarise(rows, contexts, budgetOf());

  assert.equal(s.unresolvedHeads, 1);
  assert.equal(s.requestedExpense, 40000);
});

test("the biggest risk is the overspend, not the largest number", () => {
  const big = req({ _id: id(1), requestedAmount: 9000000 });
  const risky = req({ _id: id(2), requestedAmount: 1000, ledgerName: "Repairs" });
  const contexts = {
    id1: build({ request: big }),
    id2: build({ request: risky, actual: 500000, allocations: [line(1000)] }),
  };
  const s = ctx.summarise([big, risky], contexts, budgetOf());

  assert.equal(s.biggestRisk.verdict, "exceeds");
  assert.equal(s.biggestRisk.ledgerName, "Repairs");
  assert.equal(s.exceeding, 1);
  // And it says WHY it is the risk, in rupees.
  assert.equal(s.biggestRisk.shortfall, 498000);
});

test("a cycle pushed into deficit by the queue is flagged even when no single ask is", () => {
  const rows = [req({ _id: id(1), requestedAmount: 300000 })];
  const contexts = { id1: build({ request: rows[0], allocations: [line(300000)] }) };
  const s = ctx.summarise(
    rows,
    contexts,
    budgetOf([
      { nature: "revenue", allocatedAmount: 1000000 },
      { nature: "expense", allocatedAmount: 800000 },
    ]),
  );

  assert.equal(s.plannedNet, 200000);
  assert.equal(s.netAfterPending, -100000);
  assert.equal(s.biggestRisk.verdict, "net_risk");
});

test("a queue with nothing in it produces a headline of zeroes, not nulls", () => {
  const s = ctx.summarise([], {}, budgetOf());
  assert.equal(s.waiting, 0);
  assert.equal(s.requestedExpense, 0);
  assert.equal(s.biggestRisk, null);
});

test("a percentage of nothing is null rather than zero or Infinity", () => {
  assert.equal(ctx.pct(5, 0), null);
  assert.equal(ctx.pct(0, 100), 0);
  assert.equal(ctx.pct(50, 200), 25);
});
