const test = require("node:test");
const assert = require("node:assert/strict");
const { rosterFor, rosterAgrees, personsOnOrder } = require("./personRoster");

const emp = (uin, name, o = {}) => ({
  employeeId: o.id || `id-${uin}`, employeeUIN: uin, employeeName: name,
  department: o.department || "F&B", designation: o.designation || "",
});
const e = (employee, quantity = 1) => ({ employee, quantity });

/* ── Building the roster for one line ────────────────────────────────────── */

test("a line records every person it was built from", () => {
  const r = rosterFor([e(emp("U2", "Ramesh")), e(emp("U1", "Sita"))]);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((x) => x.employeeName), ["Sita", "Ramesh"]);
});

test("order is stable by UIN, so re-converting produces an identical document", () => {
  const a = rosterFor([e(emp("U10", "Ten")), e(emp("U2", "Two")), e(emp("U1", "One"))]);
  const b = rosterFor([e(emp("U1", "One")), e(emp("U10", "Ten")), e(emp("U2", "Two"))]);
  assert.deepEqual(a.map((x) => x.employeeUIN), b.map((x) => x.employeeUIN));
});

test("UIN sorting is numeric, not lexical — U10 comes after U2", () => {
  const r = rosterFor([e(emp("U10", "Ten")), e(emp("U2", "Two"))]);
  assert.deepEqual(r.map((x) => x.employeeUIN), ["U2", "U10"]);
});

test("two of the same garment for one person is ONE row with quantity 2", () => {
  // Otherwise roster.length stops meaning "how many people", which is exactly
  // what it looks like it means.
  const r = rosterFor([e(emp("U1", "Ramesh"), 1), e(emp("U1", "Ramesh"), 1)]);
  assert.equal(r.length, 1);
  assert.equal(r[0].quantity, 2);
});

test("the person's department and designation ride along", () => {
  const r = rosterFor([e(emp("U1", "Ramesh", { department: "Housekeeping", designation: "Supervisor" }))]);
  assert.equal(r[0].department, "Housekeeping");
  assert.equal(r[0].designation, "Supervisor");
});

test("a populated employeeId object is flattened to its id", () => {
  const r = rosterFor([e({ employeeId: { _id: "abc123" }, employeeUIN: "U1", employeeName: "R" })]);
  assert.equal(r[0].employeeId, "abc123");
});

test("a person with no identifier at all is skipped, not recorded as blank", () => {
  const r = rosterFor([e({}), e(emp("U1", "Ramesh"))]);
  assert.equal(r.length, 1);
});

test("empty and missing input do not throw", () => {
  assert.deepEqual(rosterFor([]), []);
  assert.deepEqual(rosterFor(), []);
  assert.deepEqual(rosterFor([e(null)]), []);
});

/* ── The roster must agree with the money ────────────────────────────────── */

test("a roster that sums to the line quantity agrees", () => {
  assert.equal(rosterAgrees(rosterFor([e(emp("U1", "A")), e(emp("U2", "B"))]), 2), true);
});

test("a roster that is SHORT does not agree — that is a billing discrepancy", () => {
  // The invoice says 12 and the people say 11. Worse than no roster, because
  // it looks authoritative.
  assert.equal(rosterAgrees(rosterFor([e(emp("U1", "A"))]), 2), false);
});

test("a roster that OVERSHOOTS does not agree either", () => {
  assert.equal(rosterAgrees(rosterFor([e(emp("U1", "A"), 3)]), 2), false);
});

test("quantities above one still reconcile", () => {
  const r = rosterFor([e(emp("U1", "A"), 2), e(emp("U2", "B"), 3)]);
  assert.equal(rosterAgrees(r, 5), true);
  assert.equal(rosterAgrees(r, 4), false);
});

test("an empty roster only agrees with an empty line", () => {
  assert.equal(rosterAgrees([], 0), true);
  assert.equal(rosterAgrees([], 12), false);
});

/* ── Reading it back: "did we make Ramesh's uniform?" ────────────────────── */

const order = () => ({
  items: [
    {
      stockItemId: "shirt", stockItemName: "F&B Service Shirt",
      variants: [{
        variantId: "v30", attributes: [{ name: "Size", value: "30" }], quantity: 2,
        persons: [
          { employeeUIN: "U1", employeeName: "Ramesh", department: "F&B", quantity: 1 },
          { employeeUIN: "U2", employeeName: "Sita", department: "F&B", quantity: 1 },
        ],
      }],
    },
    {
      stockItemId: "trouser", stockItemName: "F&B Trouser",
      variants: [{
        variantId: "v32", attributes: [{ name: "Size", value: "32" }], quantity: 1,
        persons: [{ employeeUIN: "U1", employeeName: "Ramesh", department: "F&B", quantity: 1 }],
      }],
    },
  ],
});

test("the question the whole change exists for: what did Ramesh get?", () => {
  const ramesh = personsOnOrder(order().items).find((p) => p.employeeName === "Ramesh");
  assert.equal(ramesh.totalQuantity, 2);
  assert.deepEqual(ramesh.garments.map((g) => g.stockItemName), ["F&B Service Shirt", "F&B Trouser"]);
});

test("a person appearing on two lines is ONE row, not two", () => {
  assert.equal(personsOnOrder(order().items).length, 2);
});

test("the garment's variant travels with it, so the size is answerable too", () => {
  const ramesh = personsOnOrder(order().items).find((p) => p.employeeName === "Ramesh");
  assert.deepEqual(ramesh.garments[0].attributes, [{ name: "Size", value: "30" }]);
});

test("an order with no rosters reads as nobody, rather than throwing", () => {
  assert.deepEqual(personsOnOrder([{ stockItemName: "X", variants: [{ quantity: 5 }] }]), []);
  assert.deepEqual(personsOnOrder([]), []);
  assert.deepEqual(personsOnOrder(), []);
});
