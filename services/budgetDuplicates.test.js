// "Have you already asked for this?" — the rules, without a database.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const d = require("./budgetDuplicates.service");

const id = (n) => `id${n}`;
const budget = (over = {}) => ({ budgetRequests: [], adjustments: [], transfers: [], ...over });

/* ── the vocabulary itself ───────────────────────────────────────────────── */

test("every open state is one the model can actually hold", () => {
  /* A guard naming a state that cannot occur never fires, and nothing tells
     you. These four lists are the enums, trimmed to the undecided values. */
  assert.deepEqual(d.OPEN.proposal, ["awaiting", "submitted", "countered"]);
  assert.deepEqual(d.OPEN.requestedHead, ["requested", "clarification"]);
  assert.deepEqual(d.OPEN.adjustment, ["submitted", "reviewed"]);
  assert.deepEqual(d.OPEN.transfer, ["submitted"]);
});

test("a transfer is never 'reviewed'", () => {
  assert.equal(d.isOpen("transfer", "reviewed"), false);
});

test("a proposal is never 'cancelled'", () => {
  assert.equal(d.isOpen("proposal", "cancelled"), false);
});

/* ── proposals ───────────────────────────────────────────────────────────── */

const req = (over = {}) => ({
  _id: id(1), department: "Logistics", ledgerId: "L1", nature: "expense", state: "submitted", ...over,
});

test("a second open line on the same head is a duplicate", () => {
  const b = budget({ budgetRequests: [req()] });
  assert.ok(d.openProposalFor(b, { department: "Logistics", ledgerId: "L1", nature: "expense" }));
});

test.each = undefined;
for (const state of ["agreed", "defaulted"]) {
  test(`a ${state} line does not block a new one`, () => {
    const b = budget({ budgetRequests: [req({ state })] });
    assert.equal(d.openProposalFor(b, { department: "Logistics", ledgerId: "L1", nature: "expense" }), null);
  });
}

test("the same ledger in the other nature is a different line", () => {
  const b = budget({ budgetRequests: [req({ nature: "revenue" })] });
  assert.equal(d.openProposalFor(b, { department: "Logistics", ledgerId: "L1", nature: "expense" }), null);
});

test("another department's line on the same head does not block", () => {
  const b = budget({ budgetRequests: [req({ department: "Board" })] });
  assert.equal(d.openProposalFor(b, { department: "Logistics", ledgerId: "L1", nature: "expense" }), null);
});

test("a line does not collide with itself when revised", () => {
  const b = budget({ budgetRequests: [req()] });
  assert.equal(
    d.openProposalFor(b, { department: "Logistics", ledgerId: "L1", nature: "expense", exceptId: id(1) }),
    null,
  );
});

test("a line with no ledger yet cannot duplicate on ledger", () => {
  const b = budget({ budgetRequests: [req({ ledgerId: null })] });
  assert.equal(d.openProposalFor(b, { department: "Logistics", ledgerId: null, nature: "expense" }), null);
});

/* ── requested heads ─────────────────────────────────────────────────────── */

const headReq = (over = {}) => ({
  _id: id(2), department: "Logistics",
  requestedHead: { name: "Claude Team", nature: "expense", state: "requested" }, ...over,
});

test("the same head asked twice, typed differently, is one ask", () => {
  const b = budget({ budgetRequests: [headReq()] });
  assert.ok(d.openHeadRequestFor(b, { name: "  claude   TEAM ", nature: "expense", department: "Logistics" }));
});

for (const state of ["mapped", "created", "rejected"]) {
  test(`a ${state} head does not block a fresh ask`, () => {
    const b = budget({ budgetRequests: [headReq({ requestedHead: { name: "Claude Team", nature: "expense", state } })] });
    assert.equal(d.openHeadRequestFor(b, { name: "Claude Team", nature: "expense", department: "Logistics" }), null);
  });
}

test("a head finance has questioned is still open", () => {
  const b = budget({ budgetRequests: [headReq({ requestedHead: { name: "Claude Team", nature: "expense", state: "clarification" } })] });
  assert.ok(d.openHeadRequestFor(b, { name: "Claude Team", nature: "expense", department: "Logistics" }));
});

test("the same name as a revenue head is a different ask", () => {
  const b = budget({ budgetRequests: [headReq()] });
  assert.equal(d.openHeadRequestFor(b, { name: "Claude Team", nature: "revenue", department: "Logistics" }), null);
});

test("another department may ask for the same head name", () => {
  const b = budget({ budgetRequests: [headReq({ department: "Board" })] });
  assert.equal(d.openHeadRequestFor(b, { name: "Claude Team", nature: "expense", department: "Logistics" }), null);
});

/* ── adjustments ─────────────────────────────────────────────────────────── */

const adj = (over = {}) => ({
  _id: id(3), targetItemId: "ITEM1", type: "supplementary", state: "submitted", origin: "department", ...over,
});

test("a second open supplementary on one line is a duplicate", () => {
  const b = budget({ adjustments: [adj()] });
  assert.ok(d.openAdjustmentFor(b, { lineId: "ITEM1", type: "supplementary", origin: "department" }));
});

test("a revision is a different intent from a supplementary", () => {
  const b = budget({ adjustments: [adj()] });
  assert.equal(d.openAdjustmentFor(b, { lineId: "ITEM1", type: "revision", origin: "department" }), null);
});

for (const state of ["approved", "rejected", "cancelled"]) {
  test(`a ${state} adjustment does not block a new ask`, () => {
    const b = budget({ adjustments: [adj({ state })] });
    assert.equal(d.openAdjustmentFor(b, { lineId: "ITEM1", type: "supplementary", origin: "department" }), null);
  });
}

test("finance's own open ask does not block the department's", () => {
  /* Different conversations. Blocking finance on a department's ask would be
     the budget module refusing its owner. */
  const b = budget({ adjustments: [adj({ origin: "finance" })] });
  assert.equal(d.openAdjustmentFor(b, { lineId: "ITEM1", type: "supplementary", origin: "department" }), null);
  assert.ok(d.openAdjustmentFor(b, { lineId: "ITEM1", type: "supplementary" }), "unscoped still sees it");
});

/* ── transfers ───────────────────────────────────────────────────────────── */

const tr = (over = {}) => ({
  _id: id(4), fromItemId: "ITEM1", toItemId: "ITEM2", amount: 100000, state: "submitted", ...over,
});

test("the same route asked twice is a duplicate", () => {
  const b = budget({ transfers: [tr()] });
  assert.ok(d.openTransferFor(b, { fromLineId: "ITEM1", toLineId: "ITEM2" }));
});

test("the reverse route is a different transfer", () => {
  const b = budget({ transfers: [tr()] });
  assert.equal(d.openTransferFor(b, { fromLineId: "ITEM2", toLineId: "ITEM1" }), null);
});

for (const state of ["approved", "rejected", "cancelled"]) {
  test(`a ${state} transfer does not block the same route again`, () => {
    const b = budget({ transfers: [tr({ state })] });
    assert.equal(d.openTransferFor(b, { fromLineId: "ITEM1", toLineId: "ITEM2" }), null);
  });
}

test("open asks out of one line are added up", () => {
  const b = budget({
    transfers: [
      tr({ _id: id(5), toItemId: "ITEM2", amount: 100000 }),
      tr({ _id: id(6), toItemId: "ITEM3", amount: 250000 }),
      tr({ _id: id(7), toItemId: "ITEM4", amount: 900000, state: "rejected" }),
    ],
  });
  assert.equal(d.committedFromLine(b, { fromLineId: "ITEM1" }), 350000);
});

test("the ask being edited does not count against itself", () => {
  const b = budget({ transfers: [tr({ _id: id(5), amount: 100000 })] });
  assert.equal(d.committedFromLine(b, { fromLineId: "ITEM1", exceptId: id(5) }), 0);
});

test("transfers out of another line are not committed against this one", () => {
  const b = budget({ transfers: [tr({ fromItemId: "ITEM9", amount: 500000 })] });
  assert.equal(d.committedFromLine(b, { fromLineId: "ITEM1" }), 0);
});
