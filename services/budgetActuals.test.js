const test = require("node:test");
const assert = require("node:assert/strict");
const { oid, actualFrom } = require("./budgetActuals.service");

/* ── The sign convention, which is where a budget silently lies ──────────── */

test("an expense head consumes budget on the debit side", () => {
  // ₹80,000 of fabric bought: Dr 80,000.
  assert.equal(actualFrom({ debit: 80000, credit: 0, signed: 80000 }, "expense"), 80000);
});

test("a credit against an expense head reduces the spend, e.g. a purchase return", () => {
  assert.equal(actualFrom({ debit: 80000, credit: 5000, signed: 75000 }, "expense"), 75000);
});

test("a revenue head earns on the CREDIT side — the sign flips", () => {
  // ₹1,00,000 of sales: Cr 1,00,000, signed = -100000.
  assert.equal(actualFrom({ debit: 0, credit: 100000, signed: -100000 }, "revenue"), 100000);
});

test("a sales return debits revenue and lowers what was earned", () => {
  assert.equal(actualFrom({ debit: 12000, credit: 100000, signed: -88000 }, "revenue"), 88000);
});

test("the identical movement reads opposite by nature — why nature is required", () => {
  const movement = { debit: 0, credit: 50000, signed: -50000 };
  assert.equal(actualFrom(movement, "revenue"), 50000);
  assert.equal(actualFrom(movement, "expense"), -50000);
});

test("a ledger with no posted movement is zero, not NaN", () => {
  assert.equal(actualFrom(null, "expense"), 0);
  assert.equal(actualFrom(undefined, "revenue"), 0);
});

/* ── Id coercion never throws on user input ──────────────────────────────── */

test("a malformed id is rejected as null rather than throwing", () => {
  assert.equal(oid("not-an-id"), null);
  assert.equal(oid(""), null);
  assert.equal(oid(null), null);
  assert.equal(oid(undefined), null);
});

test("a valid 24-hex id is accepted", () => {
  assert.notEqual(oid("507f1f77bcf86cd799439011"), null);
});
