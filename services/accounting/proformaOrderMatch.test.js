// services/accounting/proformaOrderMatch.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  referencesOn, resolveOrderForProforma, isProvenMatch,
  customerLookupFor, customerLookupForMany,
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

/* ── WHICH CUSTOMER IS THIS BUYER? ────────────────────────────────────────
   The bug these pin: a route whose projection left `buyer` out built
   `{ $or: [] }`, Mongoose stripped it, the query became `{}` and returned
   the FIRST customer in the collection. That customer's sole order then
   resolved as a proven match and was WRITTEN to the proforma — binding it
   permanently to a stranger's order, with that stranger's dispatches
   offered to invoice. Returning null is what stops the query running. */
test("a buyer with nothing to identify them produces NO query, not an empty one", () => {
  for (const buyer of [undefined, null, {}, { name: "" }, { gstin: "" }, { name: "   ", gstin: "  " }]) {
    assert.equal(customerLookupFor(buyer), null,
      `expected no query for ${JSON.stringify(buyer)} — an empty $or matches everything`);
  }
});

test("a gstin alone, a name alone, and both", () => {
  assert.deepEqual(customerLookupFor({ gstin: "21AABCR1234M1Z7" }),
    { $or: [{ gstin: "21AABCR1234M1Z7" }] });
  assert.deepEqual(customerLookupFor({ name: "Riverside Hotels" }),
    { $or: [{ name: "Riverside Hotels" }] });
  const both = customerLookupFor({ name: "Riverside Hotels", gstin: " 21aabcr1234m1z7 " });
  assert.deepEqual(both.$or[0], { gstin: "21AABCR1234M1Z7" }, "gstin is trimmed and upper-cased");
  assert.deepEqual(both.$or[1], { name: "Riverside Hotels" });
});

test("the page form: no identifiable buyer on the page means no query at all", () => {
  assert.equal(customerLookupForMany([]), null);
  assert.equal(customerLookupForMany([{}, { name: "" }, null]), null);
  assert.equal(customerLookupForMany(undefined), null);
});

test("the page form asks once for every buyer, de-duplicated", () => {
  const w = customerLookupForMany([
    { name: "A", gstin: "G1" }, { name: "A", gstin: "g1" }, { name: "B" }, { gstin: "G2" },
  ]);
  assert.deepEqual(w.$or[0], { gstin: { $in: ["G1", "G2"] } });
  assert.deepEqual(w.$or[1], { name: { $in: ["A", "B"] } });
});

test("an unidentifiable buyer ends as 'none', never a stranger's sole order", () => {
  /* The two halves together: no query, so no candidates, so no match — and
     `none` is not a proven match, so nothing is written to the proforma. */
  const r = resolveOrderForProforma({ buyersReference: "no order number here" }, []);
  assert.equal(r.how, "none");
  assert.equal(r.orderId, null);
  assert.equal(isProvenMatch(r), false);
});
