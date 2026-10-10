"use strict";

const { CONTRACTS } = require("../../services/storeApplicationFieldContracts");

describe("Store application source contracts", () => {
  test("every Store-owned schema and shared operational view audits cleanly", () => {
    expect(CONTRACTS).toHaveLength(8);
    for (const contract of CONTRACTS) {
      expect(contract.audit()).toEqual(expect.objectContaining({ ok: true, issues: [] }));
    }
  });

  test("large shared models are narrow projection views, not falsely claimed whole schemas", () => {
    const views = CONTRACTS.filter((contract) => contract.coverageMode === "projection_view");
    expect(views.map((contract) => contract.id).sort()).toEqual([
      "store.customer_request_view",
      "store.manufacturing_work_order_view",
      "store.stock_issuance_view",
      "store.stock_item_bom_view",
    ]);
    for (const view of views) {
      const report = view.audit();
      expect(report.classifiedFieldCount).toBeLessThan(report.schemaFieldCount);
      expect(view.projection()).not.toMatch(/password|token|secret/i);
    }
  });

  test("worker payment identifiers and attachment links cannot enter context", () => {
    const worker = CONTRACTS.find((contract) => contract.id === "store.worker_work_order");
    expect(worker.excluded).toEqual(expect.objectContaining({
      paymentUpiId: expect.any(String),
      paymentAccountNumber: expect.any(String),
      paymentIfscCode: expect.any(String),
      "documents.url": expect.any(String),
    }));
    expect(worker.projection()).not.toMatch(/paymentUpiId|paymentAccountNumber|paymentIfscCode|documents\.url/);
  });
});
