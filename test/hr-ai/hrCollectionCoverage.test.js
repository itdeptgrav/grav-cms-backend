// test/hr-ai/hrCollectionCoverage.test.js
//
// EVERY HR COLLECTION IS SEARCHED, OR LEFT OUT WITH A REASON.
//
// Ownership is the model's directory (services/ai/storeCollectionOwnership.js
// gives models/HR_Models/, Employee.js and Salaryconfig.js to HR), so a model
// added there tomorrow appears here and fails until somebody decides it.
"use strict";

const { audit } = require("../../scripts/audits/store-collection-coverage");
const own = require("../../services/ai/storeCollectionOwnership");
const { HR_SEARCHED, HR_NOT_SEARCHED } = require("../../services/ai/hrCommandExclusions");
const { PROJECTIONS } = require("../../services/ai/hrCommandContract");

let hr;
beforeAll(() => {
  hr = audit().rows
    .filter((row) => row.modelFiles.some((file) => own.ownerOfFile(file) === "HR"))
    .map((row) => row.name)
    .sort();
});

test("every HR collection is decided — searched, or left out with a reason", () => {
  expect(hr.length).toBeGreaterThan(20);
  const undecided = hr.filter((name) => !HR_SEARCHED[name] && !HR_NOT_SEARCHED[name]);
  expect(undecided).toEqual([]);
});

test("no collection is both, and every listed one exists", () => {
  expect(Object.keys(HR_SEARCHED).filter((name) => HR_NOT_SEARCHED[name])).toEqual([]);
  const listed = [...Object.keys(HR_SEARCHED), ...Object.keys(HR_NOT_SEARCHED)];
  expect(listed.filter((name) => !hr.includes(name))).toEqual([]);
});

test("every exclusion says why and what answers instead", () => {
  for (const [name, entry] of Object.entries(HR_NOT_SEARCHED)) {
    expect([name, entry.why.length > 15]).toEqual([name, true]);
    expect([name, entry.instead.length > 5]).toEqual([name, true]);
  }
});

test("per-person pay is never searched", () => {
  expect(HR_NOT_SEARCHED.payrollitems).toBeTruthy();
  expect(Object.keys(PROJECTIONS)).not.toContain("payroll_item");
});

test("the searched collections are exactly the ones the search reads", () => {
  /* One projection per reader; designations come from departments. */
  expect(Object.keys(PROJECTIONS).length).toBe(Object.keys(HR_SEARCHED).length - 1);
});
