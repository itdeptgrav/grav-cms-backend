"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

jest.mock("../../services/access/fulfilmentAccess", () => ({
  resolveFulfilmentAccess: jest.fn().mockResolvedValue({ allowed: true, via: "store" }),
}));

const mongoose = require("mongoose");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");
const RawItemAddRequest = require("../../models/CMS_Models/Inventory/Operations/RawItemAddRequest");
const IntakeRequest = require("../../models/CMS_Models/Requests/IntakeRequest");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const Employee = require("../../models/Employee");
const { CAPABILITIES } = require("../../services/storePurchase/capabilities");
const {
  queryRequestDesk, renderRequestDesk,
} = require("../../services/storeRequestDeskAssistantContext");

const companyId = new mongoose.Types.ObjectId();
const access = {
  companyId,
  capabilitySet: new Set([CAPABILITIES.READ, CAPABILITIES.LEGACY_READ]),
};

describe("Store Request Desk assistant projection", () => {
  let user, employeeId;

  beforeEach(async () => {
    await Promise.all([
      CustomerRequest.deleteMany({}), WorkOrder.deleteMany({}), MRF.deleteMany({}),
      RawItemAddRequest.deleteMany({}), IntakeRequest.deleteMany({}), SpendRequest.deleteMany({}),
      Employee.deleteMany({}),
    ]);
    const employee = await Employee.create({ biometricId: "STORE-1", gender: "Other", email: "store@example.com" });
    employeeId = employee._id;
    user = { id: String(employee._id), employeeId: "STORE-1", email: "store@example.com", storePurchaseAccess: access };
  });

  test("unifies all five screen sources and sorts newest first", async () => {
    const manufacturing = await CustomerRequest.create({
      requestId: "CR-1", status: "in_progress", customerInfo: { name: "Customer A" }, createdAt: new Date("2026-09-01") ,
    });
    await WorkOrder.create({
      workOrderNumber: "WO-1", customerRequestId: manufacturing._id, stockItemName: "Shirt", quantity: 1,
    });
    await MRF.create({
      companyId, mrfNumber: "MRF-1", requestedFor: employeeId, createdByRef: employeeId,
      requestType: "TIME_BASED", requestedForName: "Asha", reason: "Need cotton", status: "APPROVED",
      tlApproved: true, createdAt: new Date("2026-09-02"),
    });
    await RawItemAddRequest.create({
      requestedBy: employeeId, requestedByName: "Bina", products: [{ itemName: "New Button" }], status: "PENDING",
      approvalStatus: "TL_APPROVED", createdAt: new Date("2026-09-03"),
    });
    await IntakeRequest.create({
      requestNumber: "REQ-4", title: "Repair lift", purpose: "Maintenance", requestType: "SERVICE",
      requestedBy: new mongoose.Types.ObjectId(), requestedByName: "Chirag", requestedById: "C-1",
      department: "Admin", status: "needs_classification", createdAt: new Date("2026-09-04"),
      items: [{ name: "Lift AMC", quantity: 1, unit: "Job" }],
    });
    await SpendRequest.create({
      companyId, requestNumber: "REQ-5", title: "Buy pipe", requestType: "PRODUCT",
      requestedBy: new mongoose.Types.ObjectId(), requestedByName: "Deepa", requestedById: "D-1",
      department: "Maintenance", purpose: "Repair", status: "pending_finance",
      intakeRequestId: new mongoose.Types.ObjectId(), updatedAt: new Date("2026-09-05"),
      items: [{ name: "Pipe", whyNeeded: "Repair", quantity: 1, unit: "Pcs", rate: 10, amount: 10 }],
      totalAmount: 10,
    });

    const data = await queryRequestDesk({
      user,
      args: { operation: "list", type: "all", stage: "all", sort: "newest", limit: 5 },
    });
    expect(data.failed).toEqual([]);
    expect(data.unavailable).toEqual([]);
    expect(data.rows).toHaveLength(5);
    expect(data.rows.map((row) => row.number)).toEqual(["REQ-5", "REQ-4", "New Button", "MRF-1", "CR-1"]);
    expect(renderRequestDesk({ data })).toContain("REQ-5 — purchase or service requests");
  });

  test("filters by source, stage, date and search without exposing raw documents", async () => {
    await MRF.create({
      companyId, mrfNumber: "MRF-NEW", requestedFor: employeeId, createdByRef: employeeId,
      requestType: "TIME_BASED", requestedForName: "Asha", requestedForDept: "Cutting",
      reason: "Blue cotton", status: "APPROVED", tlApproved: true, createdAt: new Date("2026-09-10"),
    });
    await MRF.create({
      companyId, mrfNumber: "MRF-OLD", requestedFor: employeeId, createdByRef: employeeId,
      requestType: "TIME_BASED", requestedForName: "Bina", requestedForDept: "Cutting",
      reason: "Red cotton", status: "COMPLETED", tlApproved: true, createdAt: new Date("2026-08-10"),
    });
    const data = await queryRequestDesk({
      user,
      args: {
        operation: "count", type: "material", stage: "needs_action", query: "blue",
        from: "2026-09-01", to: "2026-09-30", sort: "newest", limit: 10,
      },
    });
    expect(data.count).toBe(1);
    expect(data.rows).toEqual([]);
    expect(renderRequestDesk({ data })).toBe("1 matching request found.");
  });

  test("names unavailable sources instead of blending them into a zero", async () => {
    user.storePurchaseAccess = { ...access, capabilitySet: new Set([CAPABILITIES.READ]) };
    const data = await queryRequestDesk({
      user,
      args: { operation: "count", type: "all", stage: "all", sort: "newest", limit: 10 },
    });
    expect(data.unavailable).toContain("item addition requests");
    expect(renderRequestDesk({ data })).toMatch(/Unavailable to you: item addition requests/i);
  });
});
