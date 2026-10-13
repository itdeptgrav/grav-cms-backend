// test/hr-ai/accountingCollectionCoverage.test.js
//
// EVERY ACCOUNTING COLLECTION IS SEARCHED, OR LEFT OUT WITH A REASON.
//
// Ownership is the model's directory (services/ai/storeCollectionOwnership.js
// declares models/Accountant_model/ as "accounting"), so a model added there
// tomorrow appears here and fails until somebody decides it.
"use strict";

const { audit } = require("../../scripts/audits/store-collection-coverage");
const own = require("../../services/ai/storeCollectionOwnership");
const { ACCOUNTING_SEARCHED, ACCOUNTING_NOT_SEARCHED } = require("../../services/ai/accountingCommandExclusions");
const { PROJECTIONS } = require("../../services/ai/accountingCommandContract");

let accounting;
beforeAll(() => {
  accounting = audit().rows
    .filter((row) => row.modelFiles.some((file) => own.ownerOfFile(file) === "accounting"))
    .map((row) => row.name)
    .sort();
});

test("every accounting collection is decided — searched, or left out with a reason", () => {
  expect(accounting.length).toBeGreaterThan(40);
  const undecided = accounting.filter((name) => !ACCOUNTING_SEARCHED[name] && !ACCOUNTING_NOT_SEARCHED[name]);
  expect(undecided).toEqual([]);
});

test("no collection is both, and every listed one exists", () => {
  const both = Object.keys(ACCOUNTING_SEARCHED).filter((name) => ACCOUNTING_NOT_SEARCHED[name]);
  expect(both).toEqual([]);
  const listed = [...Object.keys(ACCOUNTING_SEARCHED), ...Object.keys(ACCOUNTING_NOT_SEARCHED)];
  expect(listed.filter((name) => !accounting.includes(name))).toEqual([]);
});

test("every exclusion says why and what answers instead", () => {
  for (const [name, entry] of Object.entries(ACCOUNTING_NOT_SEARCHED)) {
    expect([name, entry.why.length > 15]).toEqual([name, true]);
    expect([name, entry.instead.length > 5]).toEqual([name, true]);
  }
});

test("the searched collections are exactly the ones the search reads", () => {
  /* Five families, five readers — a sixth reader added without a decision
     here would be searching a collection nobody listed. */
  expect(Object.keys(PROJECTIONS).sort()).toEqual(["group", "ledger", "proforma_invoice", "stock_item", "voucher"]);
  expect(Object.keys(ACCOUNTING_SEARCHED).length).toBe(5);
});

test("a ledger's bank details, phone and email are never read", () => {
  expect(PROJECTIONS.ledger).not.toMatch(/bankDetails|contactDetails\.phone|contactDetails\.email|upiId/);
});
