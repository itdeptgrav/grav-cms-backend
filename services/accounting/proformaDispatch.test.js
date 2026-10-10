// services/accounting/proformaDispatch.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  variantLabel, challanProductLines, challanSummary, dispatchRollup,
} = require("./proformaDispatch");

const bulkChallan = {
  _id: "c1",
  challanNumber: "DC-2026-0001",
  dispatchDate: "2026-10-01T00:00:00Z",
  dispatchType: "bulk",
  cartonCount: 3,
  bulkProducts: [
    { productName: "Blazer", quantity: 10, variantAttributes: [{ name: "Size", value: "M" }] },
    { productName: "Blazer", quantity: 5, variantAttributes: [{ name: "Size", value: "L" }] },
  ],
  transport: { vehicleNumber: "OD02AB1234", transporter: "VRL" },
};

const personChallan = {
  _id: "c2",
  challanNumber: "DC-2026-0002",
  dispatchType: "person_wise",
  cartons: [{ cartonNumber: "CTN-2026-0007", lines: [] }],
  persons: [
    { employeeName: "A", products: [{ productName: "Blazer", quantity: 2, variantAttributes: [{ name: "Size", value: "M" }] }] },
    { employeeName: "B", products: [{ productName: "Shirt", quantity: 4, variantAttributes: [] }] },
  ],
};

const piItems = [
  { stockItemName: "Blazer — Size: M", rate: 1200, unit: "Nos", hsnCode: "6203", taxRate: 12 },
  { stockItemName: "Blazer — Size: L", rate: 1300, unit: "Nos", hsnCode: "6203", taxRate: 12 },
];

test("a variant reads as Name: value, joined", () => {
  assert.equal(variantLabel([{ name: "Size", value: "M" }, { name: "Colour", value: "Red" }]),
    "Size: M · Colour: Red");
  assert.equal(variantLabel([{ value: "M" }]), "M");
  assert.equal(variantLabel([{ name: "Size", value: "" }]), "");
  assert.equal(variantLabel(null), "");
});

test("bulk and person-wise flatten to the same billable shape", () => {
  assert.equal(challanProductLines(bulkChallan).length, 2);
  const person = challanProductLines(personChallan);
  assert.equal(person.length, 2);
  assert.equal(person[0].person, "A");
  // A zero or nameless line is not a billable fact.
  assert.equal(challanProductLines({ bulkProducts: [{ productName: "X", quantity: 0 }] }).length, 0);
});

test("a challan summarises without its packing detail", () => {
  const s = challanSummary(bulkChallan);
  assert.equal(s.challanNumber, "DC-2026-0001");
  assert.equal(s.totalUnits, 15);
  assert.equal(s.productCount, 2);
  assert.equal(s.cartonCount, 3);
  assert.equal(s.transport.transporter, "VRL");
  // cartonCount falls back to counting the cartons it carries.
  assert.equal(challanSummary(personChallan).cartonCount, 1);
});

test("the same product and variant across challans is ONE billable line", () => {
  const r = dispatchRollup([bulkChallan, personChallan], piItems);
  const m = r.lines.find((l) => l.variant === "Size: M");
  assert.equal(m.quantity, 12, "10 bulk + 2 person-wise");
  assert.deepEqual(m.challanNumbers, ["DC-2026-0001", "DC-2026-0002"]);
  assert.equal(r.totals.units, 21);
  assert.equal(r.totals.challanCount, 2);
  assert.equal(r.totals.cartonCount, 4);
});

test("the rate comes from the proforma line for the same product and variant", () => {
  const r = dispatchRollup([bulkChallan], piItems);
  const m = r.lines.find((l) => l.variant === "Size: M");
  const l = r.lines.find((l) => l.variant === "Size: L");
  assert.equal(m.rate, 1200);
  assert.equal(m.amount, 12000);
  assert.equal(l.rate, 1300);
  assert.equal(l.amount, 6500);
  assert.equal(m.hsnCode, "6203");
  assert.equal(m.taxRate, 12);
  assert.equal(r.totals.value, 18500);
});

/* A zero rate would bill the customer nothing and look like a decision. */
test("a dispatched product the proforma does not price is null, never zero", () => {
  const r = dispatchRollup([personChallan], piItems);
  const shirt = r.lines.find((l) => l.productName === "Shirt");
  assert.equal(shirt.rate, null);
  assert.equal(shirt.amount, null);
  assert.equal(shirt.pricedFrom, null);
  assert.equal(r.totals.unpriced, 1);
  // …and the total counts only what is priced.
  assert.equal(r.totals.value, 2 * 1200);
});

test("a proforma line that names no variant still prices the product", () => {
  const r = dispatchRollup([personChallan], [{ stockItemName: "Shirt", rate: 500, unit: "Nos" }]);
  const shirt = r.lines.find((l) => l.productName === "Shirt");
  assert.equal(shirt.rate, 500);
  assert.equal(shirt.amount, 2000);
  assert.equal(r.totals.unpriced, 1, "the Blazer is the unpriced one now");
});

test("names are matched past punctuation and case", () => {
  const r = dispatchRollup(
    [{ challanNumber: "X", bulkProducts: [{ productName: "G.R.A.V. Blazer", quantity: 1 }] }],
    [{ stockItemName: "grav blazer", rate: 99 }],
  );
  assert.equal(r.lines[0].rate, 99);
});

test("no challans is an empty answer, not a crash", () => {
  const r = dispatchRollup([], piItems);
  assert.deepEqual(r.lines, []);
  assert.equal(r.totals.units, 0);
  assert.equal(r.totals.value, 0);
  assert.deepEqual(dispatchRollup(null, null).lines, []);
});
