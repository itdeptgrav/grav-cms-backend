"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  cleanQuery,
  rawLayout,
  formatMatrix,
  runAccountingReport,
  INDIAN_FINANCIAL_YEAR,
  PROJECT,
  verifyPreview,
} = require("../../services/ai/accountingReportQuery");

const QUERY = Object.freeze({
  rowFields: ["ledger.name"],
  measures: [{ field: "amount.debit", calculation: "total" }],
  filters: [],
  sort: [{ field: "amount.debit", direction: "desc" }],
  limit: 5,
});

test("the general report query accepts only the server semantic catalogue", () => {
  assert.deepEqual(cleanQuery(QUERY), QUERY);
  assert.equal(cleanQuery({ ...QUERY, rowFields: ["organization_id"] }), null);
  assert.equal(cleanQuery({ ...QUERY, measures: [{ field: "amount.debit", calculation: "eval" }] }), null);
});

test("the model cannot supply organisation or company scope", () => {
  const layout = rawLayout(QUERY, ["64f000000000000000000001"]);
  assert.deepEqual(layout.companyIds, ["64f000000000000000000001"]);
  assert.equal(Object.prototype.hasOwnProperty.call(QUERY, "companyIds"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(QUERY, "organizationId"), false);
});

test("a validated report executes with only the signed-in accounting scope", async () => {
  let received;
  const result = await runAccountingReport({
    user: {
      accountingAccess: {
        allowed: true,
        organizationId: "64f000000000000000000000",
        companyIds: ["64f000000000000000000001"],
      },
    },
    query: QUERY,
    runPreview: async (input) => {
      received = input;
      return {
        mode: "summary",
        leafColumns: [{ heading: "Debit", type: "money" }],
        rows: [{ kind: "data", labels: ["Cash"], cells: [{ value: 125000, semanticType: "currency" }] }],
        previewRowCount: 1,
        totalRowCount: 1,
        truncated: false,
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(received.organizationId, "64f000000000000000000000");
  assert.deepEqual(received.companyIds, ["64f000000000000000000001"]);
  assert.match(result.reply, /Cash/);
  assert.match(result.reply, /1,25,000/);
});

test("missing verified scope fails closed before the engine runs", async () => {
  let called = false;
  const result = await runAccountingReport({
    user: { accountingAccess: { allowed: true } },
    query: QUERY,
    runPreview: async () => { called = true; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "accounting_scope_unavailable");
  assert.equal(called, false);
});

test("matrix formatting is deterministic and bounded by the validated preview", () => {
  const reply = formatMatrix({
    leafColumns: [{ heading: "Credit", type: "money" }],
    rows: [{ kind: "data", labels: ["Supplier A"], cells: [{ value: 9876.5 }] }],
    previewRowCount: 1,
    totalRowCount: 4,
    truncated: true,
  });
  assert.match(reply, /^1\. Supplier A/);
  assert.match(reply, /₹9,876\.5/);
  assert.match(reply, /Showing 1 of 4/);
});

test("native reports derive Indian FY from voucher date and resolve ledger dimensions from master data", () => {
  const fy = JSON.stringify(INDIAN_FINANCIAL_YEAR);
  assert.match(fy, /calendarMonth/);
  assert.match(fy, /\$gte/);
  assert.match(fy, /\$subtract/);
  assert.doesNotMatch(fy, /financialYear/);

  const ledgerName = JSON.stringify(PROJECT["ledger.name"]);
  const ledgerGroup = JSON.stringify(PROJECT["ledger.group"]);
  assert.match(ledgerName, /ledgerMaster\.name/);
  assert.match(ledgerName, /ledgerEntries\.ledgerName/);
  assert.match(ledgerGroup, /ledgerMaster\.groupName/);
  assert.match(ledgerGroup, /ledgerEntries\.groupName/);
});

test("report verification rejects unresolved ledger groups, non-numeric totals and wrong ordering", () => {
  const layout = {
    mode: "summary",
    limit: 5,
    rows: [{ field: { id: "ledger.group", type: "text" } }],
    values: [{ field: { id: "amount.debit", type: "money" } }],
    sort: [{ field: { id: "amount.debit" }, direction: "desc" }],
  };
  const matrix = (rows) => ({ leafColumns: [{}], rows, previewRowCount: rows.length, totalRowCount: rows.length });
  assert.deepEqual(verifyPreview(layout, matrix([
    { kind: "data", labels: [null], cells: [{ value: 100 }] },
  ])), { ok: false, reason: "report_unresolved_ledger_dimension" });
  assert.deepEqual(verifyPreview(layout, matrix([
    { kind: "data", labels: ["Bank Accounts"], cells: [{ value: "not-a-number" }] },
  ])), { ok: false, reason: "report_non_numeric_measure" });
  assert.deepEqual(verifyPreview(layout, matrix([
    { kind: "data", labels: ["A"], cells: [{ value: 10 }] },
    { kind: "data", labels: ["B"], cells: [{ value: 20 }] },
  ])), { ok: false, reason: "report_sort_not_enforced" });
  assert.deepEqual(verifyPreview(layout, matrix([
    { kind: "data", labels: ["A"], cells: [{ value: 20 }] },
    { kind: "data", labels: ["B"], cells: [{ value: 10 }] },
  ])), { ok: true });
});
