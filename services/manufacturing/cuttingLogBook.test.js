// services/manufacturing/cuttingLogBook.test.js — the cutting log book's arithmetic,
// checked against the sample row in "Daily Cutting Report Grav.xlsx".
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("./cuttingLogBook");

/* Row 7 of the owner's Cutting Log Book sheet. */
const SAMPLE = {
  date: "2026-09-22", tableNo: "T-1", cuttingMaster: "Bablu", styleNo: "RC-2041", colour: "Navy", layNo: "L-01",
  fabricLot: "Lot 7 / Shade A", markerLength: 8.6, markerWidth: 58, markerEff: 84,
  ratio: { XS: 0, S: 1, M: 2, L: 2, XL: 1, XXL: 0, "3XL": 0 }, plies: 60, fabricIssued: 540, fabricReturned: 10, bomCons: 1.45,
};

test("the sample lay works out exactly as the workbook's formulas do", () => {
  const { lay, error } = L.normaliseLay(SAMPLE);
  assert.equal(error, undefined);
  assert.equal(lay.markerEff, 0.84, "84 typed is 84% stored as 0.84");
  const c = L.computeLay(lay);
  assert.equal(c.garmentsPerPly, 6);
  assert.equal(c.pcsCut, 360);
  assert.equal(c.fabricConsumed, 530);
  assert.equal(c.markerReq, 516);
  assert.equal(c.wastage, 14);
  assert.ok(Math.abs(c.wastagePct - 0.026415) < 1e-6);
  assert.ok(Math.abs(c.actualCons - 1.472222) < 1e-6);
  assert.ok(Math.abs(c.consVarPct - 0.015326) < 1e-6, "the workbook shows 1.5%");
  assert.equal(c.status, "OK");
});

test("status: within ±3% of BOM is OK, otherwise over or under", () => {
  const base = { ...L.normaliseLay(SAMPLE).lay };
  assert.equal(L.computeLay({ ...base, bomCons: 1.3 }).status, "Over BOM");
  assert.equal(L.computeLay({ ...base, bomCons: 1.6 }).status, "Under BOM");
  assert.equal(L.computeLay({ ...base, bomCons: null }).status, "", "no BOM, no verdict — the workbook leaves it blank");
  assert.equal(L.computeLay({ ...base, fabricIssued: null, fabricReturned: null }).fabricConsumed, null);
});

test("refusals name the problem", () => {
  assert.match(L.normaliseLay({ ...SAMPLE, plies: 0 }).error, /plies/);
  assert.match(L.normaliseLay({ ...SAMPLE, ratio: {} }).error, /size ratio/);
  assert.match(L.normaliseLay({ ...SAMPLE, styleNo: "" }).error, /style/);
  assert.match(L.normaliseLay({ ...SAMPLE, fabricReturned: 600 }).error, /More fabric returned/);
  assert.match(L.normaliseLay({ ...SAMPLE, markerEff: 140 }).error, /percentage/);
  assert.match(L.normaliseLay({ ...SAMPLE, ratio: { M: 1.5 } }).error, /whole number/);
});

test("the daily summary adds the lays up, size by size", () => {
  const a = L.normaliseLay(SAMPLE).lay;
  const b = L.normaliseLay({ ...SAMPLE, layNo: "L-02", plies: 40, ratio: { M: 3, L: 3 }, fabricIssued: 400, fabricReturned: 20, bomCons: 1.2 }).lay;
  const s = L.summarize([a, b]);
  assert.equal(s.lays, 2);
  assert.equal(s.totalPlies, 100);
  assert.equal(s.pcsCut, 360 + 240);
  assert.equal(s.fabricIssued, 940);
  assert.equal(s.fabricReturned, 30);
  assert.equal(s.fabricConsumed, 910);
  assert.equal(s.markerReq, 516 + 344);
  assert.equal(s.wastage, 14 + 36);
  assert.deepEqual(s.sizeWise, { XS: 0, S: 60, M: 120 + 120, L: 120 + 120, XL: 60, XXL: 0, "3XL": 0 });
  assert.equal(s.sizeTotal, s.pcsCut, "size-wise adds up to the pieces cut");
  assert.ok(Math.abs(s.avgCons - 910 / 600) < 1e-6);
  assert.equal(s.flaggedLays, 1, "the second lay is 26% over its BOM");
});

test("an empty season summarises to zeros and blanks, never NaN", () => {
  const s = L.summarize([]);
  assert.equal(s.lays, 0);
  assert.equal(s.pcsCut, 0);
  assert.equal(s.fabricConsumed, null);
  assert.equal(s.avgCons, null);
  assert.equal(JSON.stringify(s).includes("NaN"), false);
});

test("a lay may carry sizes that are not columns; they count in garments a ply and pieces cut (17 Oct 2026)", () => {
  const lb = require("./cuttingLogBook");
  const { lay, error } = lb.normaliseLay({ date: "2026-10-17", styleNo: "S-1", markerLength: 10, markerUnit: "ft", plies: 2, ratio: { M: 1, "30": 3, "32.5": 1 } });
  assert.equal(error, undefined);
  assert.deepEqual(lay.ratioExtra, { 30: 3, "32-5": 1 });
  assert.equal(lb.computeLay(lay).pcsCut, 10);
  assert.equal(lb.summarize([lay]).sizeTotal, 10);
  assert.equal(lb.normaliseLay({ date: "2026-10-17", styleNo: "S-1", markerLength: 10, plies: 1, ratio: { "30": 3 } }).error, undefined, "a lay of only such sizes is a lay");
});
