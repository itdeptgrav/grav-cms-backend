"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { cellsFromTargets, plansFromCells, fabricOf, layMix } = require("./departmentPlan");

test("the current plan, read back from the orders' targets; paced targets are listed apart", () => {
  const targets = [
    { _id: "t1", department: "cutting", status: "active", manufacturingOrderId: "m1", dayPlan: [
      { date: "2026-10-16", time: "11:30", workOrderId: "a", pieces: 150, label: "Lay 1" },
      { date: "2026-10-17", time: "", workOrderId: "a", pieces: 20 },
    ] },
    { _id: "t2", department: "cutting", status: "active", manufacturingOrderId: "m2", kind: "per_day", pieces: 100, dayPlan: [] },
    { _id: "t3", department: "production", status: "active", manufacturingOrderId: "m1", dayPlan: [{ date: "2026-10-16", workOrderId: "a", pieces: 5 }] },
  ];
  const r = cellsFromTargets(targets, "cutting");
  assert.deepEqual(r.cells, { a: { "2026-10-16T10:30": 150, "2026-10-17": 20 } });
  assert.deepEqual(r.planned, ["t1"]);
  assert.deepEqual(r.other.map((o) => o.targetId), ["t2"]);
});

test("one lay, three orders: the same hour is the same lay on every order, numbered across orders", () => {
  const wo = new Map([
    ["a", { moId: "m1", number: "WO-A", left: 200 }],
    ["b", { moId: "m2", number: "WO-B", left: 200 }],
    ["c", { moId: "m3", number: "WO-C", left: 200 }],
  ]);
  const r = plansFromCells([
    { workOrderId: "a", slot: "2026-10-16T10:30", pieces: 150 },
    { workOrderId: "b", slot: "2026-10-16T10:30", pieces: 100 },
    { workOrderId: "c", slot: "2026-10-16T10:30", pieces: 50 },
    { workOrderId: "a", slot: "2026-10-16T13:30", pieces: 40 },
  ], wo, { department: "cutting", perBatch: 300 });
  assert.deepEqual(r.problems, []);
  assert.deepEqual([...r.orders.keys()], ["m1", "m2", "m3"]);
  const m1 = r.orders.get("m1");
  assert.deepEqual(m1.dayPlan.map((e) => [e.time, e.pieces, e.label, e.layKey]), [
    ["11:30", 150, "Lay 1", "cutting:2026-10-16T10:30"],
    ["14:30", 40, "Lay 2", "cutting:2026-10-16T13:30"],
  ]);
  assert.equal(r.orders.get("m3").dayPlan[0].label, "Lay 1");
  assert.deepEqual(m1.allocations, [{ workOrderId: "a", quantity: 190 }]);
});

test("refusals: beyond the balance, not a shift hour, an hour on dispatch, a closed work order", () => {
  const wo = new Map([["a", { moId: "m1", number: "WO-A", left: 100 }]]);
  const r = plansFromCells([
    { workOrderId: "a", slot: "2026-10-16", pieces: 80 },
    { workOrderId: "a", slot: "2026-10-17", pieces: 40 },
    { workOrderId: "a", slot: "2026-10-16T10:00", pieces: 5 },
    { workOrderId: "z", slot: "2026-10-16", pieces: 5 },
  ], wo, { department: "trimming" });
  assert.equal(r.problems.length, 3);
  assert.match(r.problems.join(" | "), /WO-A: 120 planned, but only 100 remain/);
  assert.match(r.problems.join(" | "), /10:00 is not the start of a shift hour/);
  const d = plansFromCells([{ workOrderId: "a", slot: "2026-10-16T10:30", pieces: 5 }], wo, { department: "dispatch" });
  assert.match(d.problems[0], /dispatch is planned by the day/);
  const ship = plansFromCells([{ workOrderId: "a", slot: "2026-10-18", pieces: 5 }], wo, { department: "dispatch" });
  assert.equal(ship.orders.get("m1").dayPlan[0].label, "Shipment 1");
});

test("a work order's fabric is its fabric-category material, not just anything in metres", () => {
  const cat = new Map([["f1", "Fabric"], ["fu", "Interlining"], ["th", "Thread"], ["f2", "Suiting Fabric"]]);
  const rm = [
    { rawItemId: "fu", name: "Paper Fusing", unit: "Mtr", quantityRequired: 28 },
    { rawItemId: "th", name: "Coats Astra", unit: "Meter", quantityRequired: 71500 },
    { rawItemId: "f1", name: "SuitingFabric 63/37PC Plain", unit: "Mtr", quantityRequired: 343, rawItemVariantCombination: ["Debidutt Mangilall", "Black (WMBR7001)"] },
    { rawItemId: "f2", name: "Lining", unit: "Mtr", quantityRequired: 40, rawItemVariantId: "v9" },
  ];
  assert.deepEqual(fabricOf(rm, cat), { key: "f1:Debidutt Mangilall/Black (WMBR7001)", quality: "f1", name: "SuitingFabric 63/37PC Plain", variant: "Black" });
  assert.equal(fabricOf([{ rawItemId: "fu", unit: "Mtr", quantityRequired: 5 }], cat), null);
  assert.equal(fabricOf([], cat), null);
});

test("what a lay may hold: one fabric; one quality in two shades only for one product; never two qualities", () => {
  const suit = (shade) => ({ key: `s:${shade}`, quality: "s", name: "Suiting", variant: shade });
  const shirt = { key: "sh:w", quality: "sh", name: "Shirting", variant: "White" };
  assert.equal(layMix([{ fabric: suit("Grey"), product: "Jacket" }, { fabric: suit("Grey"), product: "Trouser" }]).level, null);
  assert.equal(layMix([{ fabric: suit("Grey"), product: "Jacket" }, { fabric: shirt, product: "Shirt" }]).level, "error");
  const twoShadesTwoProducts = layMix([{ fabric: suit("Grey"), product: "MT Jacket" }, { fabric: suit("Beige"), product: "F&B Apron" }]);
  assert.equal(twoShadesTwoProducts.level, "error");
  assert.match(twoShadesTwoProducts.text, /one marker/);
  assert.equal(layMix([{ fabric: suit("Grey"), product: "Jacket" }, { fabric: suit("Beige"), product: "Jacket" }]).level, "warning");
  assert.equal(layMix([{ fabric: suit("Grey"), product: "Jacket" }, { fabric: shirt, product: "Shirt" }], 2).level, null);
  assert.equal(layMix([{ fabric: suit("Grey"), product: "Jacket" }, { fabric: null, product: "Shirt" }]).level, null);
});
