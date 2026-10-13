// services/maintenance/machineTag.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mintTagCode, isTagCode, readScannedCode, TAG_ALPHABET } = require("./machineTag");

test("a minted code is MCH- and eight unambiguous characters", () => {
  for (let i = 0; i < 500; i += 1) {
    const code = mintTagCode();
    assert.match(code, /^MCH-[A-Z2-9]{8}$/);
    assert.ok(isTagCode(code), code);
    assert.doesNotMatch(code.slice(4), /[01OI]/);
  }
  assert.equal(TAG_ALPHABET.length, 32);
});

test("minting is driven by the random source alone", () => {
  assert.equal(mintTagCode(() => 0), "MCH-AAAAAAAA");
  assert.equal(mintTagCode(() => 31), "MCH-99999999");
});

test("a scanned tag is read whatever the case and surrounding whitespace", () => {
  assert.deepEqual(readScannedCode("MCH-7KQ2XW9P"), { ok: true, code: "MCH-7KQ2XW9P" });
  assert.deepEqual(readScannedCode("  mch-7kq2xw9p\r\n"), { ok: true, code: "MCH-7KQ2XW9P" });
});

test("another department's label is named, never read as a machine", () => {
  const cases = {
    "itemid=6512ab34cd56ef7890123456": "store-item",
    "https://cms.grav.in/store/dashboard/item-info?itemid=6512ab34cd56ef7890123456": "store-item",
    "6512ab34cd56ef7890123456": "store-item",
    "loc=LOC-ABCD2345": "store-location",
    "LOC-ABCD2345": "store-location",
    "WO-359e7172-009": "garment-piece",
    "ops:A12": "scanner-config",
    "opsgp:G1": "scanner-config",
  };
  for (const [raw, kind] of Object.entries(cases)) {
    const r = readScannedCode(raw);
    assert.equal(r.ok, false, raw);
    assert.equal(r.kind, kind, raw);
    assert.ok(r.reason.length > 0);
  }
});

test("malformed tags and junk are refused, never guessed", () => {
  for (const raw of ["MCH-", "MCH-1234567", "MCH-ABCDEFG0", "MCH-ABCDEFGHI", "MCH 7KQ2XW9P", "hello", "12345"]) {
    const r = readScannedCode(raw);
    assert.equal(r.ok, false, raw);
    assert.equal(r.kind, "unknown", raw);
  }
  assert.equal(readScannedCode("").kind, "empty");
  assert.equal(readScannedCode(null).kind, "empty");
});
