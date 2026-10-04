// services/maintenance/sewingMachines.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { sewingFamilyOf, isSewingMachineType, normaliseType } = require("./sewingMachines");

/* Every distinct `machines.type` on 3 Oct 2026, with its machine count. The
   owner chose stitching + embroidery + snap button: 79 of the 90. */
const LIVE = {
  SNLS: 54, "4THO/L": 4, "F/L": 3, "5THO/L": 3, SNEC: 2, BA: 2, "3THO/L": 2, DNLS: 2,
  KANSAI: 1, BT: 1, EYELET_BH: 1, FOA: 1, BH: 1, EMBROIDERY: 1, "SNAP BUTTON": 1,
  IRONER: 5, "WASHING MACHINE": 3, TABLE: 2, "F/M": 1,
};
const EXCLUDED = ["IRONER", "WASHING MACHINE", "TABLE", "F/M"];

test("the live register resolves to the owner's 79 sewing machines", () => {
  let sewing = 0;
  for (const [type, n] of Object.entries(LIVE)) if (isSewingMachineType(type)) sewing += n;
  assert.equal(sewing, 79);
});

test("irons, washers, tables and the fusing machine are not sewing machines", () => {
  for (const type of EXCLUDED) assert.equal(sewingFamilyOf(type), null, type);
});

test("F/M is the fusing machine here, never feed-off-the-arm", () => {
  /* The floor designer reads FM as feed-of-the-arm; this register's only F/M
     is FUSING_MACHINE_1. FOA is feed-off-the-arm. */
  assert.equal(sewingFamilyOf("F/M"), null);
  assert.equal(sewingFamilyOf("FOA").key, "feedOffArm");
});

test("the factory's alternate spellings land on one family", () => {
  for (const t of ["4THO/L", "4TH O/L", "4T-O/L"]) assert.equal(sewingFamilyOf(t).key, "overlock4", t);
  for (const t of ["5THO/L", "5T-O/L"]) assert.equal(sewingFamilyOf(t).key, "overlock5", t);
  assert.equal(sewingFamilyOf("EMBROIDERY*1").key, "embroidery");
  assert.equal(sewingFamilyOf("KEYHOLE").key, "keyhole");
  assert.equal(sewingFamilyOf("EYELET_BH").key, "eyeletButtonhole");
  assert.equal(sewingFamilyOf("bh").key, "buttonhole");
});

test("the machinetypes register's non-machines are not sewing machines", () => {
  for (const t of ["FUSING M/C", "IRON", "IRON TABLE", "CHECKER", "CHECKING TABLE",
    "HANDKNIFE CUTTING MACHINE", "Helper", "INDIRECT"]) {
    assert.equal(sewingFamilyOf(t), null, t);
  }
});

test("blank and missing types are not sewing machines", () => {
  for (const t of ["", "   ", null, undefined]) assert.equal(isSewingMachineType(t), false);
  assert.equal(normaliseType(" 4t-o/l "), "4TOL");
});
