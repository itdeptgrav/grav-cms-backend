"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const cp = require("./cutPlan");

const ROWS = [
  { colour: "Blue", size: "S", quantity: 100 },
  { colour: "Blue", size: "M", quantity: 200 },
  { colour: "Blue", size: "L", quantity: 200 },
  { colour: "Blue", size: "XL", quantity: 100 },
];
const MARKER = { key: "M1", name: "4-way", ratio: [{ size: "S", count: 1 }, { size: "M", count: 2 }, { size: "L", count: 2 }, { size: "XL", count: 1 }], lengthM: 3.8 };

test("the requirement is the order breakdown plus the allowance, rounded up", () => {
  const r = cp.requirementOf(ROWS, 3);
  assert.deepEqual(r.map((x) => x.withAllowance), [103, 206, 206, 103]);
  const zero = cp.requirementOf(ROWS, 0);
  assert.deepEqual(zero.map((x) => x.withAllowance), [100, 200, 200, 100]);
});

test("two work orders of the same colour and size are one requirement", () => {
  const r = cp.requirementOf([{ colour: "Blue", size: "M", quantity: 30 }, { colour: "blue", size: "m", quantity: 20 }], 0);
  assert.equal(r.length, 1);
  assert.equal(r[0].quantity, 50);
});

test("a lay is plies × ratio, size by size, and its fabric is plies × (length + end allowance)", () => {
  const e = cp.evaluate({ allowancePct: 0, maxPlies: 120, endAllowanceCm: 2, markers: [MARKER], lays: [{ no: 1, markerKey: "M1", colour: "Blue", plies: 100 }] }, ROWS);
  const lay = e.lays[0];
  assert.equal(lay.perPly, 6);
  assert.equal(lay.total, 600);
  assert.deepEqual(lay.pieces.map((p) => p.pieces), [100, 200, 200, 100]);
  assert.equal(lay.fabricM, 382, "100 × (3.80 + 0.02)");
  assert.equal(e.totals.fabricM, 382);
  assert.ok(e.ok);
});

test("the balance says, size by size, what is short and what is over", () => {
  const e = cp.evaluate({ allowancePct: 3, maxPlies: 120, markers: [MARKER], lays: [{ no: 1, markerKey: "M1", colour: "Blue", plies: 100 }] }, ROWS);
  assert.deepEqual(e.balance.map((b) => b.balance), [-3, -6, -6, -3], "100 plies cut the order exactly, not the 3% allowance");
  assert.equal(e.totals.shortSizes, 4);
  assert.ok(e.problems.some((p) => /short/.test(p.text)));
});

test("a lay higher than the knife can cut is refused", () => {
  const e = cp.evaluate({ maxPlies: 60, markers: [MARKER], lays: [{ no: 1, markerKey: "M1", colour: "Blue", plies: 80 }] }, ROWS);
  assert.equal(e.ok, false);
  assert.ok(e.problems.some((p) => p.level === "error" && /maximum lay height is 60/.test(p.text)));
});

test("a lay on a marker that does not exist is refused", () => {
  const e = cp.evaluate({ markers: [MARKER], lays: [{ no: 3, markerKey: "nope", colour: "Blue", plies: 10 }] }, ROWS);
  assert.equal(e.ok, false);
  assert.ok(e.problems.some((p) => /Lay 3 refers to a marker/.test(p.text)));
});

test("sizes cut that nobody ordered are reported", () => {
  const e = cp.evaluate({ markers: [{ ...MARKER, ratio: [{ size: "XXL", count: 1 }] }], lays: [{ no: 1, markerKey: "M1", colour: "Blue", plies: 10 }] }, ROWS);
  assert.ok(e.balance.some((b) => b.unrequired && b.planned === 10));
  assert.ok(e.problems.some((p) => /XXL/.test(p.text)));
});

test("suggested lays cover the tightest size and respect the lay height", () => {
  const req = cp.requirementOf(ROWS, 3);
  const lays = cp.suggestLays({ colour: "Blue", marker: MARKER, requirement: req, maxPlies: 60 });
  assert.equal(lays.reduce((n, l) => n + l.plies, 0), 103, "the S size needs 103 at ratio 1");
  assert.ok(lays.every((l) => l.plies <= 60));
  assert.equal(lays.length, 2);
  assert.deepEqual(lays.map((l) => l.no), [1, 2]);
  const e = cp.evaluate({ allowancePct: 3, maxPlies: 60, markers: [MARKER], lays }, ROWS);
  assert.equal(e.totals.shortSizes, 0, "the suggestion leaves nothing short");
});

test("the plan is cleaned before it is trusted", () => {
  const p = cp.normalise({ allowancePct: 99, maxPlies: -4, markers: [{ ratio: [{ size: "M", count: 999 }, { size: "", count: 2 }] }], lays: [{ plies: "12.6", date: "not a date" }] });
  assert.equal(p.allowancePct, 15);
  assert.equal(p.maxPlies, 1);
  assert.deepEqual(p.markers[0].ratio, [{ size: "M", count: 20 }]);
  assert.equal(p.lays[0].plies, 13);
  assert.equal(p.lays[0].date, "");
});
