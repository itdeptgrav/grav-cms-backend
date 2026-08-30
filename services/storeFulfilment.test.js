// services/storeFulfilment.test.js
//
// The store's fulfilment rules, without a database.
//
// These are the three numbers that decide how much money leaves the company:
// what is still owed on a line, how much of that is being bought, and what tax
// makes the total. Every one of them is arithmetic, so it is tested as
// arithmetic — the route tests cover the parts that genuinely need stock
// levels and documents behind them.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const f = require("./storeFulfilment.service");

/** One line, ten owed, nothing issued yet. */
const ITEM = (over = {}) => ({
  _id: "line1",
  rawItemName: "Cutting blade",
  unit: "pcs",
  requestedQty: 10,
  issuedQty: 0,
  itemStatus: "APPROVED",
  ...over,
});

const stock = (n) => new Map([["line1", n]]);

/* ── WHAT IS STILL OWED ──────────────────────────────────────────────────── */

test("what is owed is the request less what has already gone out", () => {
  assert.equal(f.remainingOn(ITEM()), 10);
  assert.equal(f.remainingOn(ITEM({ issuedQty: 4 })), 6);
  assert.equal(f.remainingOn(ITEM({ issuedQty: 10 })), 0);
});

test("a settled line owes nothing, however much was asked for", () => {
  /* Rejected and written-off lines are CLOSED, not short. Treating them as a
     shortfall would put them on a purchase order somebody deliberately
     declined to raise. */
  assert.equal(f.remainingOn(ITEM({ itemStatus: "REJECTED" })), 0);
  assert.equal(f.remainingOn(ITEM({ itemStatus: "UNFULFILLED" })), 0);
});

/* ── ISSUE FROM STOCK ────────────────────────────────────────────────────── */

test("issuing from stock takes the whole outstanding quantity", () => {
  const r = f.planFor({ decision: f.ISSUE_FROM_STOCK, items: [ITEM()], availableByItem: stock(25) });
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.lines.map((l) => [l.issueQty, l.buyQty]),
    [[10, 0]],
  );
});

test("and is refused when the shelf cannot cover it", () => {
  /* The important negative. Letting this through would issue four and drop
     the other six on the floor with nobody buying them. */
  const r = f.planFor({ decision: f.ISSUE_FROM_STOCK, items: [ITEM()], availableByItem: stock(4) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /short — 4 pcs in stock against 10 pcs owed/);
  assert.match(r.reason, /Partly issue/);
});

test("an unmatched line has no stock figure, and that is not zero", () => {
  /* `null` means "we cannot know", and answering it as though the shelf were
     empty would send a catalogue item nobody has looked up out to be bought. */
  const r = f.planFor({ decision: f.ISSUE_FROM_STOCK, items: [ITEM()], availableByItem: stock(null) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not matched to a catalogue item/);
});

/* ── BUY / SERVICE ───────────────────────────────────────────────────────── */

test("buying takes the whole outstanding quantity and issues none of it", () => {
  const r = f.planFor({ decision: f.BUY_OR_SERVICE, items: [ITEM()], availableByItem: stock(25) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.lines.map((l) => [l.issueQty, l.buyQty]), [[0, 10]]);
});

test("buying is allowed even when the shelf could have covered it", () => {
  /* A repair, an AMC, or simply stock the store is holding for something
     else. The store person is the one who knows; the rule does not overrule
     them on the strength of a quantity. */
  assert.equal(
    f.planFor({ decision: f.BUY_OR_SERVICE, items: [ITEM()], availableByItem: stock(500) }).ok,
    true,
  );
});

/* ── PARTLY ISSUE, BUY THE BALANCE ───────────────────────────────────────── */

test("the split is taken as entered", () => {
  const r = f.planFor({
    decision: f.PARTIAL_BUY_BALANCE,
    items: [ITEM()],
    plan: [{ itemId: "line1", issueQty: 4, buyQty: 6, rate: 50 }],
    availableByItem: stock(4),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.lines.map((l) => [l.issueQty, l.buyQty, l.rate]), [[4, 6, 50]]);
});

test("it cannot issue more than the shelf holds", () => {
  const r = f.planFor({
    decision: f.PARTIAL_BUY_BALANCE,
    items: [ITEM()],
    plan: [{ itemId: "line1", issueQty: 9, buyQty: 1 }],
    availableByItem: stock(4),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /only 4 pcs is in stock/);
});

test("nor more than is owed", () => {
  const r = f.planFor({
    decision: f.PARTIAL_BUY_BALANCE,
    items: [ITEM()],
    plan: [{ itemId: "line1", issueQty: 12, buyQty: 0 }],
    availableByItem: stock(50),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /only 10 pcs is owed/);
});

test("nor issue and buy more than the line between them", () => {
  const r = f.planFor({
    decision: f.PARTIAL_BUY_BALANCE,
    items: [ITEM()],
    plan: [{ itemId: "line1", issueQty: 6, buyQty: 6 }],
    availableByItem: stock(50),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /comes to more than the 10 pcs owed/);
});

test("issuing less than is owed and buying less than the gap is allowed", () => {
  /* Two of five issued, two bought, one no longer needed. It is recorded as
     what it is — still owed — rather than silently rounded into the purchase. */
  const r = f.planFor({
    decision: f.PARTIAL_BUY_BALANCE,
    items: [ITEM({ requestedQty: 5 })],
    plan: [{ itemId: "line1", issueQty: 2, buyQty: 2, rate: 10 }],
    availableByItem: stock(2),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.lines.map((l) => [l.issueQty, l.buyQty]), [[2, 2]]);
});

test("a split that buys nothing is the wrong decision, and says so", () => {
  const r = f.planFor({
    decision: f.PARTIAL_BUY_BALANCE,
    items: [ITEM()],
    plan: [{ itemId: "line1", issueQty: 10, buyQty: 0 }],
    availableByItem: stock(50),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Issue from stock/);
});

test("a split that issues nothing is the other wrong decision", () => {
  const r = f.planFor({
    decision: f.PARTIAL_BUY_BALANCE,
    items: [ITEM()],
    plan: [{ itemId: "line1", issueQty: 0, buyQty: 10 }],
    availableByItem: stock(0),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Buy or arrange a service/);
});

/* ── SETTLED WORK ────────────────────────────────────────────────────────── */

test("a request with nothing outstanding has nothing to decide", () => {
  const r = f.planFor({
    decision: f.ISSUE_FROM_STOCK,
    items: [ITEM({ issuedQty: 10 })],
    availableByItem: stock(50),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Nothing is outstanding/);
});

test("an unknown decision is refused rather than guessed at", () => {
  assert.equal(f.planFor({ decision: "maybe", items: [ITEM()] }).ok, false);
});

/* ── WHAT FINANCE IS BEING ASKED TO AGREE TO ─────────────────────────────── */

test("tax rides on top of the lines, not inside them", () => {
  assert.deepEqual(f.priceFor({ lines: [{ buyQty: 6, rate: 50 }], gstPercent: 18 }), {
    subtotal: 300,
    gstPercent: 18,
    taxAmount: 54,
    grandTotal: 354,
  });
});

test("no tax rate is zero tax, not a missing total", () => {
  assert.deepEqual(f.priceFor({ lines: [{ buyQty: 2, rate: 125.5 }] }), {
    subtotal: 251,
    gstPercent: 0,
    taxAmount: 0,
    grandTotal: 251,
  });
});

test("a nonsense tax rate is clamped rather than trusted", () => {
  assert.equal(f.priceFor({ lines: [{ buyQty: 1, rate: 100 }], gstPercent: -5 }).gstPercent, 0);
  assert.equal(f.priceFor({ lines: [{ buyQty: 1, rate: 100 }], gstPercent: 900 }).gstPercent, 100);
});

/* ── THE GATE FINANCE SITS BEHIND ────────────────────────────────────────── */

test("a request whose lines carry rates is priced", () => {
  const r = f.pricingGate({ items: [{ rate: 50 }, { rate: 12 }], totalAmount: 62 });
  assert.equal(r.ok, true);
});

test("a line with no rate is not priced, and the refusal counts them", () => {
  const r = f.pricingGate({ items: [{ rate: 50 }, { rate: 0 }], totalAmount: 50 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /1 line carries no rate/);
});

test("a zero total is not priced either", () => {
  /* Belt and braces: rates could be present and the stored total still wrong,
     and it is the total the commitment is made against. */
  const r = f.pricingGate({ items: [{ rate: 5 }], totalAmount: 0 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /total is zero/);
});

test("a request with no lines at all is not priced", () => {
  assert.equal(f.pricingGate({ items: [], totalAmount: 100 }).ok, false);
});

/* ── WHICH ANSWERS COST MONEY ────────────────────────────────────────────── */

test("only the two buying answers reach finance", () => {
  assert.equal(f.needsPurchase(f.ISSUE_FROM_STOCK), false);
  assert.equal(f.needsPurchase(f.PARTIAL_BUY_BALANCE), true);
  assert.equal(f.needsPurchase(f.BUY_OR_SERVICE), true);
});
