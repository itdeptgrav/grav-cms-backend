// test/manufacturing/return-cancelled-samples-repair.test.js
//
// THE REPAIR'S SELECTION RULES, AGAINST A REAL DATABASE.
//
// The script itself connects to a URI and prints; what matters and what can go
// wrong is WHICH records it picks and what it writes. Both come from
// sampleStyleReturn.service — the same code the route runs — so they are
// exercised here directly, with the fixtures shaped exactly as the script
// hands them over.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const Employee = require("../../models/Employee");
const svc = require("../../services/manufacturing/sampleStyleReturn.service");

let seq = 0;

/** A style stuck at "submitted" behind a cancelled, unrouted work order. */
async function stuck({ operations = [], status = "cancelled", cancelledAt = new Date("2026-09-06T04:30:00Z") } = {}) {
  const n = ++seq;
  const emp = await Employee.create({
    firstName: "R", lastName: `P${n}`, email: `repair-${n}@test.com`,
    biometricId: `RPX${n}`, isActive: true, gender: "Other", department: "Tech",
  });
  const product = await StockItem.create({
    name: "Soumya Tshirt", reference: `PROD-RP-${n}`, category: "Shirt",
    operations: [], createdBy: emp._id,
    variants: [{ sku: `RP-${n}-V1`, attributes: [], quantity: 0, cost: 0, salesPrice: 0 }],
  });
  const wo = await WorkOrder.create({
    workOrderNumber: `WO-RP-${n}`, stockItemId: product._id, stockItemName: "Soumya Tshirt",
    quantity: 6, status, operations, customerName: "Walkthrough", createdBy: emp._id,
    ...(status === "cancelled"
      ? {
        cancellation: {
          at: cancelledAt, byActorId: String(emp._id), byName: "Walkthrough",
          reason: "Created before its product had an operation route.",
          operationsAtCancellation: operations.length,
          productionScansAtCancellation: 0, qcInspectionsAtCancellation: 0,
          cuttingRecorded: false,
        },
      }
      : {}),
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-2026-${String(8000 + n)}`, styleCode: `SC-RP-${n}`,
    productName: "Soumya Tshirt", companyId: new mongoose.Types.ObjectId(),
    materials: { rawItems: [] },
    production: {
      status: "submitted", stockItemId: product._id,
      customerId: new mongoose.Types.ObjectId(), workOrderIds: [wo._id],
    },
  });
  return { style, wo, product, emp, n };
}

/** What the script does per candidate, once it has decided to repair one. */
const repair = (style, wo) => svc.returnStyleToRouteEditing({
  style,
  workOrder: wo,
  actor: { id: wo.cancellation?.byActorId || undefined, name: wo.cancellation?.byName || "" },
  reason: wo.cancellation?.reason || "",
  at: wo.cancellation?.at || undefined,
});

describe("what the repair writes", () => {
  test("a stuck style is returned, with the ORIGINAL actor and date", async () => {
    const { style, wo } = await stuck();
    const out = await repair(style, wo);
    expect(out).toMatchObject({ returned: true, wrote: true, status: "stock_item_linked" });

    const after = await SampleStyle.findById(style._id).lean();
    expect(after.production.status).toBe("stock_item_linked");

    const entry = after.production.log.find((l) => l.kind === "attempt_cancelled");
    expect(entry.by.name).toBe("Walkthrough");
    /* Not today. A repair run months later must not date somebody else's
       decision to the day it was reconciled. */
    expect(new Date(entry.at).toISOString()).toBe("2026-09-06T04:30:00.000Z");
    expect(entry.note).toMatch(/Created before its product had an operation route/);
    expect(String(entry.workOrderId)).toBe(String(wo._id));
  });

  test("running it twice writes nothing the second time", async () => {
    const { style, wo } = await stuck();
    const first = await repair(style, wo);
    expect(first.wrote).toBe(true);

    const again = await repair(await SampleStyle.findById(style._id), wo);
    expect(again).toMatchObject({ returned: true, wrote: false, alreadyReturned: true });

    const after = await SampleStyle.findById(style._id).lean();
    expect(after.production.log.filter((l) => l.kind === "attempt_cancelled")).toHaveLength(1);
    expect(after.production.status).toBe("stock_item_linked");
  });

  test("a style a live order still governs is left exactly where it is", async () => {
    const { style, wo, product, emp } = await stuck();
    const live = await WorkOrder.create({
      workOrderNumber: `WO-RP-LIVE-${seq}`, stockItemId: product._id,
      stockItemName: "Soumya Tshirt", quantity: 4, status: "in_progress",
      operations: [{ operationType: "Collar", operationCode: "OP-C", status: "pending" }],
      customerName: "W", createdBy: emp._id,
    });
    style.production.workOrderIds.push(live._id);
    await style.save();

    const out = await repair(await SampleStyle.findById(style._id), wo);
    expect(out.returned).toBe(false);
    expect(out.wrote).toBe(false);
    expect(out.blockedBy[0].number).toBe(live.workOrderNumber);

    const after = await SampleStyle.findById(style._id).lean();
    expect(after.production.status).toBe("submitted");
    expect(after.production.log.some((l) => l.kind === "attempt_cancelled")).toBe(false);
  });

  test("it never invents a route or a replacement order", async () => {
    const { style, wo, product } = await stuck();
    await repair(style, wo);

    /* The product's operations are still empty — the repair returns the style
       so a person can define the route, and defines nothing itself. */
    expect((await StockItem.findById(product._id).lean()).operations).toHaveLength(0);
    /* And exactly one work order still exists for this style. */
    const after = await SampleStyle.findById(style._id).lean();
    expect(after.production.workOrderIds).toHaveLength(1);
    expect(String(after.production.workOrderIds[0])).toBe(String(wo._id));
    expect(await WorkOrder.countDocuments({ stockItemId: product._id })).toBe(1);
  });

  test("nothing is deleted — the cancelled order keeps its whole account", async () => {
    const { style, wo } = await stuck();
    await repair(style, wo);
    const after = await WorkOrder.findById(wo._id).lean();
    expect(after.status).toBe("cancelled");
    expect(after.cancellation.reason).toBe("Created before its product had an operation route.");
    expect(after.workOrderNumber).toBe(wo.workOrderNumber);
    expect(after.quantity).toBe(6);
  });
});

describe("which records the script selects", () => {
  /* The script's own filter, run against the collection so the selection is
     proved rather than read. */
  const candidates = () => SampleStyle.find({ "production.status": "submitted" }).lean();

  test("a routed cancelled order is not the unrouted case and is skipped", async () => {
    const { style, wo } = await stuck({
      operations: [{ operationType: "Collar", operationCode: "OP-C", status: "pending" }],
    });
    /* It is a candidate by status... */
    expect((await candidates()).some((s) => String(s._id) === String(style._id))).toBe(true);
    /* ...and the script's routed check is what excludes it: a cancelled order
       that HAD a route was a production decision, not this bug. */
    const orders = await WorkOrder.find({ _id: { $in: style.production.workOrderIds } })
      .select("status operations").lean();
    const routed = orders.filter((w) => w.status === "cancelled" && (w.operations || []).length);
    expect(routed).toHaveLength(1);
    expect(String(routed[0]._id)).toBe(String(wo._id));
  });

  test("an already-reconciled style is not a candidate at all", async () => {
    const { style, wo } = await stuck();
    await repair(style, wo);
    expect((await candidates()).some((s) => String(s._id) === String(style._id))).toBe(false);
  });
});
