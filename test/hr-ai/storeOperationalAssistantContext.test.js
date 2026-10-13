"use strict";

const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const SupplierOffer = require("../../models/CMS_Models/Inventory/Sourcing/SupplierOffer");
const ServiceOrder = require("../../models/CMS_Models/Inventory/Operations/ServiceOrder");
const StockCount = require("../../models/CMS_Models/Inventory/Operations/StockCount");
const StockReservation = require("../../models/CMS_Models/Inventory/Operations/StockReservation");
const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");
const { operationsSummary, renderStoreOperational } = require("../../services/storeOperationalAssistantContext");
const { claimOperationalWorkspace } = require("../../services/ai/tools/storeOperationalTools");

describe("Store operational assistant projections", () => {
  afterEach(() => jest.restoreAllMocks());

  test("operations summary uses the same stored queues as the Store overview", async () => {
    jest.spyOn(MRF, "countDocuments").mockResolvedValue(1);
    jest.spyOn(SupplierOffer, "countDocuments").mockResolvedValue(2);
    jest.spyOn(PurchaseOrder, "countDocuments").mockResolvedValueOnce(3).mockResolvedValueOnce(4);
    jest.spyOn(StockReservation, "countDocuments").mockResolvedValueOnce(5).mockResolvedValueOnce(6).mockResolvedValueOnce(7);
    jest.spyOn(ServiceOrder, "countDocuments").mockResolvedValue(8);
    jest.spyOn(StockCount, "countDocuments").mockResolvedValue(9);
    const rows = await operationsSummary({ companyId: "507f1f77bcf86cd799439011" });
    expect(rows.map((row) => row.count)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(rows.map((row) => row.label)).toEqual(expect.arrayContaining([
      "requests to classify", "purchase orders to receive", "open stock counts",
    ]));
  });

  test("rendering keeps operational and reconciliation meanings separate", () => {
    expect(renderStoreOperational({ data: {
      ok: true, view: "operations", rows: [{ label: "reservation shortages", count: 4 }],
    } })).toBe("Store operations: reservation shortages: 4.");
    expect(renderStoreOperational({ data: {
      ok: true, view: "purchase_exceptions", coverageComplete: true,
      storedMatchCount: 2, inspectedCount: 2,
      summary: { ordersNeedingAttention: 2, pastExpectedDelivery: 1, stillToReceive: 1 }, rows: [],
    } })).toContain("orders needing attention 2");
  });

  test("workspace language claims the typed operational view before generic entity routing", () => {
    expect(claimOperationalWorkspace({ message: "show the store operations overview" })).toEqual({
      view: "operations", operation: "summary", limit: 5,
    });
    expect(claimOperationalWorkspace({ message: "list the top 7 purchase exceptions" })).toEqual({
      view: "purchase_exceptions", operation: "list", limit: 7,
    });
    expect(claimOperationalWorkspace({ message: "inventory valuation summary" })).toEqual({
      view: "inventory_valuation", operation: "summary", limit: 5,
    });
  });
});
