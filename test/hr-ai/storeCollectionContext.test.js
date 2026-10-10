"use strict";

const PurchaseOrder = require("../../models/CMS_Models/Store/PurchaseOrder");
const {
  ENTITY_SPECS, DEFINITIONS_BY_ENTITY, RECORDS, NONE, RESOLVE_FROM_RECORDS,
  validate, reconcileArgs, queryCollection, renderCollectionQuery,
} = require("../../services/storeCollectionContext");

const base = (overrides = {}) => ({
  operation: "list", metric: RECORDS, outputMetric2: NONE, outputMetric3: NONE,
  filterMetric: NONE, filterOperator: NONE, filterValue: "",
  filterMetric2: NONE, filterOperator2: NONE, filterValue2: "",
  filterMetric3: NONE, filterOperator3: NONE, filterValue3: "",
  dateMetric: NONE, ...overrides,
});

const field = (entity, path) => DEFINITIONS_BY_ENTITY[entity].find((item) => item.path === path)?.id;

describe("legacy Store collection query contract", () => {
  beforeEach(async () => {
    await PurchaseOrder.deleteMany({});
  });

  test("all six Store record families have closed safe definitions", () => {
    expect(ENTITY_SPECS).toHaveLength(6);
    for (const entity of ENTITY_SPECS) {
      expect(entity.contract).toBeDefined();
      expect(DEFINITIONS_BY_ENTITY[entity.id].length).toBeGreaterThan(0);
      expect(validate(entity.id, base())).not.toHaveProperty("error");
    }
  });

  test("fields cannot cross entity boundaries", () => {
    const result = validate("purchase_order", base({ metric: field("worker_work_order", "status") }));
    expect(result.error).toMatch(/outside the safe catalogue/i);
  });

  test("server reconciliation removes invented slots and keeps grounded status", () => {
    const args = reconcileArgs("purchase_order", base({
      operation: "count",
      outputMetric2: field("purchase_order", "vendorName"),
      filterMetric: field("purchase_order", "vendorName"), filterOperator: "equals", filterValue: "Invented Vendor",
      filterMetric2: field("purchase_order", "status"), filterOperator2: "equals", filterValue2: "ordered",
      dateMetric: field("purchase_order", "poDate"),
    }), "how many ordered purchase orders?");
    expect(args.outputMetric2).toBe(NONE);
    expect(args.filterMetric).toBe(field("purchase_order", "status"));
    expect(String(args.filterValue).toLowerCase()).toBe("ordered");
    expect(args.filterMetric2).toBe(NONE);
    expect(args.dateMetric).toBe(NONE);
  });

  test("multi-output filtered lists are executed and rendered deterministically", async () => {
    await PurchaseOrder.create({ poNumber: "PO-1", vendorName: "Acme Textiles", status: "Ordered", grandTotal: 1250 });
    await PurchaseOrder.create({ poNumber: "PO-2", vendorName: "Other", status: "Ordered", grandTotal: 500 });
    const message = "list PO number, vendor name and total amount from vendor Acme Textiles";
    const data = await queryCollection({
      entity: "purchase_order", message,
      args: base({
        metric: field("purchase_order", "poNumber"),
        outputMetric2: field("purchase_order", "vendorName"),
        outputMetric3: field("purchase_order", "grandTotal"),
        filterMetric: field("purchase_order", "vendorName"), filterOperator: "equals",
        filterValue: RESOLVE_FROM_RECORDS,
      }),
    });
    expect(data).toEqual(expect.objectContaining({ ok: true, count: 1 }));
    const answer = renderCollectionQuery({ data });
    expect(answer).toContain("PO-1");
    expect(answer).toContain("Acme Textiles");
    expect(answer).not.toContain("PO-2");
  });

  test("counts, date ranges and numeric aggregates stay within catalogued types", () => {
    expect(validate("purchase_order", base({ operation: "sum", metric: field("purchase_order", "grandTotal") }))).not.toHaveProperty("error");
    expect(validate("purchase_order", base({ operation: "sum", metric: field("purchase_order", "vendorName") })).error).toMatch(/numeric field/i);
    expect(validate("purchase_order", base({ dateMetric: field("purchase_order", "vendorName"), from: "2026-01-01" })).error).toMatch(/date field/i);
  });
});
