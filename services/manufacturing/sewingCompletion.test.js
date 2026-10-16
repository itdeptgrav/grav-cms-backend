// services/manufacturing/sewingCompletion.test.js
//
// The pure half of the sewing-completion rule (15 Oct 2026): which QC pass
// records a piece as sewn, and how a piece barcode is read. The ledger write
// itself needs a database and is checked by hand against the dev server.
const test = require("node:test");
const assert = require("node:assert/strict");
const { isCompletingStage, parseBarcode, canonicalOf } = require("./sewingCompletion");

const inline = { _id: "a1", code: "P1-CP", serial: 1, isActive: true };
const endline = { _id: "b2", code: "P2-CP", serial: 2, isActive: true };
const retired = { _id: "c0", code: "OLD", serial: 0, isActive: false };

test("a pass at the lowest-serial active stage completes sewing", () => {
  assert.equal(isCompletingStage(inline, [inline, endline]), true);
  assert.equal(isCompletingStage(endline, [inline, endline]), false);
});

test("stage order is by serial, not by list position", () => {
  assert.equal(isCompletingStage(inline, [endline, inline]), true);
});

test("a retired stage with a lower serial does not steal first place", () => {
  assert.equal(isCompletingStage(inline, [retired, inline, endline]), true);
  assert.equal(isCompletingStage(retired, [retired, inline, endline]), false);
});

test("with no stages configured every pass is the first pass", () => {
  assert.equal(isCompletingStage(null, []), true);
  assert.equal(isCompletingStage(null, undefined), true);
});

test("stages configured but no stage on the verdict never completes", () => {
  assert.equal(isCompletingStage(null, [inline, endline]), false);
});

test("piece barcodes are found in the text and stored in canonical form", () => {
  assert.deepEqual(parseBarcode("WO-6A79A59CDA39E282A6B17029-003").canonical, "WO-6a79a59cda39e282a6b17029-003");
  assert.equal(parseBarcode("WO-a6b17029-12").unitNumber, 12);
  assert.equal(canonicalOf("https://x/scan?c=WO-A6B17029-007"), "WO-a6b17029-007");
  assert.equal(parseBarcode("hello").success, false);
  assert.equal(parseBarcode("WO-a6b17029-0").success, false);
});
