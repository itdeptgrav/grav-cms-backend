// services/accounting/proformaOrderMatch.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  referencesOn, resolveOrderForProforma, isProvenMatch,
} = require("./proformaOrderMatch");

const order = (id, requestId, customerName = "Riverside") => ({
  _id: id, requestId, customerName,
});

test("an order number is found wherever it was typed", () => {
  assert.deepEqual(referencesOn({ buyersReference: "MO-REQ-2026-0041" }), ["MO-REQ-2026-0041"]);
  assert.deepEqual(referencesOn({ narration: "against mo-req-2026-0041 pls" }), ["MO-REQ-2026-0041"]);
  assert.deepEqual(referencesOn({ otherReferences: "REQ-1042 and REQ-1042" }), ["REQ-1042"]);
  assert.deepEqual(referencesOn({ buyersReference: "RFQ/RH/2026/118" }), [], "an RFQ is not an order");
  assert.deepEqual(referencesOn({}), []);
});

test("a stored link is never second-guessed", () => {
  const r = resolveOrderForProforma({ customerRequestId: "o1", requestRef: "MO-REQ-X" },
    [order("o2", "MO-REQ-Y")]);
  assert.equal(r.how, "stored");
  assert.equal(r.orderId, "o1");
});

test("the order number written on the proforma wins", () => {
  const r = resolveOrderForProforma(
    { buyersReference: "MO-REQ-2026-0041" },
    [order("o1", "MO-REQ-2026-0041"), order("o2", "MO-REQ-2026-0099")],
  );
  assert.equal(r.how, "reference");
  assert.equal(r.orderId, "o1");
  assert.ok(isProvenMatch(r));
});

test("one order and nothing else it could be", () => {
  const r = resolveOrderForProforma({}, [order("o1", "MO-REQ-2026-0041")]);
  assert.equal(r.how, "sole-order");
  assert.equal(r.orderId, "o1");
  assert.ok(isProvenMatch(r));
});

/* The case that must never be guessed: picking wrong puts another order's
   dispatches on this proforma and bills them. */
test("several orders and no reference is ambiguous, not a guess", () => {
  const r = resolveOrderForProforma({}, [
    order("o1", "MO-REQ-2026-0041"), order("o2", "MO-REQ-2026-0099"),
  ]);
  assert.equal(r.how, "ambiguous");
  assert.equal(r.orderId, null);
  assert.equal(isProvenMatch(r), false);
  assert.match(r.reason, /2 orders/);
  assert.match(r.reason, /Write the order number/);
});

test("a reference matching two orders is ambiguous too", () => {
  const r = resolveOrderForProforma(
    { buyersReference: "MO-REQ-A MO-REQ-B" },
    [order("o1", "MO-REQ-A"), order("o2", "MO-REQ-B")],
  );
  assert.equal(r.how, "ambiguous");
  assert.equal(r.orderId, null);
});

test("no order at all means the proforma is not approved, and says so", () => {
  const r = resolveOrderForProforma({}, []);
  assert.equal(r.how, "none");
  assert.equal(r.orderId, null);
  assert.match(r.reason, /not approved yet/);
  assert.equal(isProvenMatch(r), false);
});

test("a reference that names no known order falls through to the count rule", () => {
  // The buyer has one order; the typed reference simply is not it.
  const r = resolveOrderForProforma({ buyersReference: "MO-REQ-GONE" },
    [order("o1", "MO-REQ-2026-0041")]);
  assert.equal(r.how, "sole-order");
  assert.equal(r.orderId, "o1");
});
