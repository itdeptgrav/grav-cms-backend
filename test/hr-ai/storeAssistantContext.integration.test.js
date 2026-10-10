"use strict";

const mongoose = require("mongoose");
const PurchaseOrder = require("../../models/CMS_Models/Store/PurchaseOrder");
const WorkerWorkOrder = require("../../models/CMS_Models/Store/WorkerWorkOrder");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const ManufacturingWorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const { resolveRecord, materialRequirements } = require("../../services/storeAssistantContext");

describe("Store deterministic read adapter", () => {
  beforeEach(async () => {
    await Promise.all([
      PurchaseOrder.deleteMany({}), WorkerWorkOrder.deleteMany({}), CustomerRequest.deleteMany({}),
      ManufacturingWorkOrder.deleteMany({}), RawItem.deleteMany({}),
    ]);
  });

  test("exact business numbers resolve the right order type and suppress internal/sensitive fields", async () => {
    await PurchaseOrder.create({ poNumber: "PO-100", vendorName: "Acme", status: "Ordered", grandTotal: 1200 });
    await WorkerWorkOrder.create({
      workOrderNumber: "WO-100", workerName: "Ravi", status: "Issued",
      paymentMethod: "Bank Transfer", paymentAccountNumber: "123456", paymentIfscCode: "SECRET",
    });

    const po = await resolveRecord("purchase_order", "status of PO-100");
    expect(po).toEqual(expect.objectContaining({ found: true, identity: "PO-100" }));
    expect(po.record).toEqual(expect.objectContaining({ poNumber: "PO-100", vendorName: "Acme", status: "Ordered" }));
    expect(po.record._id).toBeUndefined();

    const worker = await resolveRecord("worker_work_order", "payment method for WO-100");
    expect(worker.record.paymentMethod).toBe("Bank Transfer");
    expect(worker.record.paymentAccountNumber).toBeUndefined();
    expect(worker.record.paymentIfscCode).toBeUndefined();
    expect(worker.record._id).toBeUndefined();
  });

  test("material shortfall is computed from the stored requirement and live stock", async () => {
    const requestId = new mongoose.Types.ObjectId();
    const rawItemId = new mongoose.Types.ObjectId();
    await CustomerRequest.collection.insertOne({
      _id: requestId, requestId: "CR-1", status: "in_progress", customerInfo: { name: "Buyer" }, items: [],
    });
    await ManufacturingWorkOrder.collection.insertOne({
      _id: new mongoose.Types.ObjectId(), customerRequestId: requestId, workOrderNumber: "MWO-1",
      stockItemName: "Shirt", quantity: 2,
      rawMaterials: [{ rawItemId, name: "Cotton", sku: "RAW-1", unit: "m", quantityRequired: 10, totalCost: 500 }],
    });
    await RawItem.collection.insertOne({
      _id: rawItemId, name: "Cotton", sku: "RAW-1", unit: "m", quantity: 4, minStock: 1, variants: [],
    });

    const result = await materialRequirements("order_request", "raw material shortfalls for CR-1");
    expect(result).toEqual(expect.objectContaining({ found: true, identity: "CR-1" }));
    expect(result.items).toEqual([expect.objectContaining({
      rawItemName: "Cotton", quantityRequired: 10, available: 4, shortfall: 6, status: "shortage",
    })]);
    expect(result.summary).toEqual(expect.objectContaining({ shortfallCount: 1, totalRequired: 10, totalAvailable: 4 }));
  });
});
