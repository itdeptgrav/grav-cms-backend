"use strict";
// services/ppc/targetScope.test.js — node --test
const { test } = require("node:test");
const assert = require("node:assert/strict");
const s = require("./targetScope");

const CTX = {
  quantity: 1200,
  workOrders: [
    { id: "a1", number: "WO-1a2b3c4d", product: "Oxford shirt", quantity: 400 },
    { id: "b2", number: "WO-5e6f7a8b", product: "Oxford shirt", quantity: 500 },
    { id: "c3", number: "WO-9c0d1e2f", product: "Oxford shirt", quantity: 300 },
  ],
};

test("no work orders named is the whole order", () => {
  for (const body of [undefined, {}, { workOrderIds: [] }, { workOrderIds: ["", null] }]) {
    const r = s.resolveScope(body, CTX, "production");
    assert.equal(r.ok, true);
    assert.equal(r.scope.kind, "order");
    assert.equal(r.scope.quantity, 1200, "the order's quantity, not a sum of the ones named");
  }
});

test("a mix of work orders carries its own quantity", () => {
  const r = s.resolveScope({ workOrderIds: ["a1", "c3"] }, CTX, "production");
  assert.equal(r.ok, true);
  assert.equal(r.scope.kind, "work_orders");
  assert.equal(r.scope.quantity, 700, "400 + 300 — what the target may ask for");
  assert.equal(r.scope.count, 2);
  assert.equal(r.scope.label, "2 of 3 work orders");
  assert.match(s.describeScope(r.scope), /WO-1a2b3c4d/);
});

test("naming every work order IS the order", () => {
  const r = s.resolveScope({ workOrderIds: ["a1", "b2", "c3"] }, CTX, "production");
  assert.equal(r.scope.kind, "order", "or the replace rule could be dodged by listing them all");
  assert.equal(r.scope.quantity, 1200);
});

test("a work order that is not on this order is refused by name", () => {
  const r = s.resolveScope({ workOrderIds: ["a1", "zz"] }, CTX, "production");
  assert.equal(r.ok, false);
  assert.match(r.error, /does not belong to this order/);
  assert.equal(r.scope, null);
});

test("dispatch cannot be scoped, and says why", () => {
  const r = s.resolveScope({ workOrderIds: ["a1"] }, CTX, "dispatch");
  assert.equal(r.ok, false);
  assert.match(r.error, /challan/);
  /* …but the whole order is fine for dispatch. */
  assert.equal(s.resolveScope({}, CTX, "dispatch").ok, true);
});

test("every other department can be scoped", () => {
  for (const d of ["cutting", "production", "qc", "packaging", "trimming", "ironing", "embroidery", "printing", "washing"]) {
    assert.equal(s.canScope(d), true, d);
  }
  assert.equal(s.canScope("dispatch"), false);
});

test("only the scope's events count", () => {
  const events = [
    { at: 1, qty: 1, woId: "a1" }, { at: 2, qty: 1, woId: "b2" },
    { at: 3, qty: 1, woId: "c3" }, { at: 4, qty: 5, woId: null },
  ];
  const scope = s.resolveScope({ workOrderIds: ["a1", "c3"] }, CTX, "production").scope;
  assert.equal(s.scopedEvents(events, scope).length, 2);
  assert.equal(s.scopedEvents(events, s.wholeOrder(CTX)).length, 4, "the order counts everything, named or not");
});

test("two targets on different work orders both stand", () => {
  const one = s.resolveScope({ workOrderIds: ["a1"] }, CTX, "production").scope;
  const two = s.resolveScope({ workOrderIds: ["b2"] }, CTX, "production").scope;
  const both = s.resolveScope({ workOrderIds: ["a1", "b2"] }, CTX, "production").scope;
  assert.equal(s.scopesOverlap(one, two), false, "different work orders are two live commitments");
  assert.equal(s.scopesOverlap(one, both), true, "sharing one work order is the same promise twice");
  assert.equal(s.scopesOverlap(one, s.wholeOrder(CTX)), true, "the whole order covers every one of them");
  assert.equal(s.scopesOverlap(s.wholeOrder(CTX), s.wholeOrder(CTX)), true);
});

test("allocations: the target's quantity is the sum of its lines", () => {
  const r = s.resolveScope({ allocations: [{ workOrderId: "a1", quantity: 150 }, { workOrderId: "c3", quantity: 90 }] }, CTX, "cutting");
  assert.equal(r.ok, true);
  assert.equal(r.scope.kind, "work_orders");
  assert.equal(r.scope.quantity, 240);
  assert.deepEqual(r.scope.allocations, [{ workOrderId: "a1", quantity: 150 }, { workOrderId: "c3", quantity: 90 }]);
  assert.equal(r.scope.label, "2 of 3 work orders");
});

test("allocations: a line cannot ask for more than its work order has left", () => {
  const left = new Map([["a1", 120], ["c3", 300]]);
  const r = s.resolveScope({ allocations: [{ workOrderId: "a1", quantity: 150 }] }, CTX, "cutting", left);
  assert.equal(r.ok, false);
  assert.match(r.error, /WO-1a2b3c4d: 150 requested, but only 120 remain at this stage/);
});

test("allocations: every work order allocated is still per-line, and says so", () => {
  const r = s.resolveScope({ allocations: CTX.workOrders.map((w) => ({ workOrderId: w.id, quantity: 10 })) }, CTX, "cutting");
  assert.equal(r.scope.kind, "work_orders", "per-line quantities are kept even across the whole order");
  assert.equal(r.scope.label, "all 3 work orders");
  assert.equal(r.scope.quantity, 30);
});

test("allocations: refusals are precise", () => {
  assert.match(s.resolveScope({ allocations: [{ workOrderId: "zz", quantity: 1 }] }, CTX, "cutting").error, /does not belong to the order/);
  assert.match(s.resolveScope({ allocations: [{ workOrderId: "a1", quantity: 0 }] }, CTX, "cutting").error, /whole number of at least 1/);
  assert.match(s.resolveScope({ allocations: [{ workOrderId: "a1", quantity: 1 }, { workOrderId: "a1", quantity: 2 }] }, CTX, "cutting").error, /appears twice/);
  assert.match(s.resolveScope({ allocations: [{ workOrderId: "a1", quantity: 5 }] }, CTX, "dispatch").error, /per challan/);
});
