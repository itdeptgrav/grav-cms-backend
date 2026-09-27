"use strict";
// services/ppc/customerMaterialAvailability.service.js
//
// WHAT A PLANNER MAY KNOW ABOUT SOMEBODY ELSE'S FABRIC.
//
// PPC's question is narrow and practical: can this line start? For a job-work
// order that turns on whether the customer's material is here and how much of it
// production already has. This answers exactly that and nothing more.
//
// ── IT IS A READ THROUGH A KEYHOLE ──────────────────────────────────────────
// Shaped field by field, like Merchandising's own catalogue read, and for the
// same reason: a planner needs quantities and a material name, not the customer's
// commercial document. So there is no document text, no instructions, no challan,
// no receipt history and no customer contact — and a field added to the lot or the
// expectation tomorrow does not appear here by accident.
//
// ── AND THE LINK IS PROVEN, NOT ASSUMED ─────────────────────────────────────
// A production order sees material only where stored references agree. An order
// with no provable link gets `linked: false` and an empty list, which is a
// different answer from "there is no material" — and the difference matters,
// because one is a data problem somebody can fix and the other is a shortage.

const mongoose = require("mongoose");

const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const {
  CustomerMaterialExpectation, STATE,
} = require("../../models/CMS_Models/Merchandising/CustomerMaterialExpectation");
const receipts = require("../storePurchase/customerMaterialReceipt.service");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

/** What a planner may see about one material line. Identity and quantities only. */
function lineView(line, doc) {
  const required = r4(line.requiredQuantity);
  const available = r4(line.availableQuantity);
  const issued = r4(line.issuedQuantity);
  /* What is still to be issued to production, from what is on the shelf. NOT the
     same as what is still expected from the customer — a planner asking "can I
     start" needs the first; chasing the customer is Merchandising's. */
  const leftToIssue = r4(Math.max(0, required - issued));
  return {
    /* Named by the material, never by an internal reference. */
    material: line.lots?.[0]?.material?.name || str(line.name) || str(line.lineRef),
    sku: line.lots?.[0]?.material?.sku || "",
    variant: (line.lots?.[0]?.material?.variantCombination || []).join(" · "),
    unit: str(line.unit),
    requiredForThisLine: required,
    availableInStore: available,
    issuedToThisOrder: issued,
    remainingToIssue: leftToIssue,
    /* ── IS THIS STOPPING PRODUCTION ──────────────────────────────────────
         A shortage is only blocking when what is left to issue exceeds what Store
         is holding: the difference is material that has not arrived. Saying
         "blocked" for anything else would train a planner to ignore the word. */
    shortage: r4(Math.max(0, leftToIssue - available)),
    blocking: r4(leftToIssue - available) > 0,
    receiptStatus: str(line.status),
    operationalStanding: str(line.operationalStanding),
    /* Where the authoritative record lives. Store owns it; this is a pointer,
       not a copy. */
    storeDocumentRef: str(doc.documentRef),
    storeRecordId: str(doc._id),
  };
}

/** The issued customer-material document for one execution file, or null. */
async function issuedDoc(ctx, executionFileId) {
  return CustomerMaterialExpectation.findOne({
    companyId: ctx.companyId, executionFileId, state: STATE.ISSUED,
  }).sort({ revisionNo: -1 });
}

/**
 * Every customer material for one Manufacturing Order.
 *
 * The order is a CustomerRequest, and the link is the execution files opened from
 * handovers whose source record IS that order. Walked rather than matched.
 */
async function forManufacturingOrder(ctx, { orderId } = {}) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  if (!isId(orderId)) throw fail("NOT_FOUND", "That production order was not found.");

  const order = await CustomerRequest.findById(orderId).select("requestId").lean();
  if (!order) throw fail("NOT_FOUND", "That production order was not found.");

  /* Which execution files belong to this order, proven through the handover
     chain rather than by matching an order reference string. */
  const customerIdentity = require("../merchandising/customerIdentity.service");
  const files = await ExecutionFile.find({ companyId: ctx.companyId })
    .select("currentHandoverVersionId currentExecutionProjection fileNumber").lean();

  const mine = [];
  for (const file of files) {
    const identity = await customerIdentity.resolveFromFile(ctx, file);
    if (identity.ok && str(identity.customerRequestId) === str(orderId)) mine.push(file);
  }
  if (!mine.length) {
    return {
      linked: false,
      manufacturingOrder: { id: str(order._id), number: str(order.requestId) },
      lines: [],
      /* A different answer from "no material": one is fixable, the other is a
         shortage, and a planner acts differently on each. */
      reason: "NO_EXECUTION_FILE_LINKED",
      message: "No merchandising execution file is linked to this production order, so customer-supplied "
        + "material cannot be shown for it.",
    };
  }

  const lines = [];
  for (const file of mine) {
    const doc = await issuedDoc(ctx, file._id);
    if (!doc) continue;
    const standing = await receipts.standingFor(ctx, doc);
    for (const line of standing.lines) {
      lines.push({
        ...lineView(line, doc),
        orderLineRef: str(doc.salesOrderLineRef),
        executionFileNumber: str(file.fileNumber),
      });
    }
  }

  return {
    linked: true,
    manufacturingOrder: { id: str(order._id), number: str(order.requestId) },
    lines,
    /* Said plainly, because a read-only screen should explain why it has no
       buttons rather than leaving somebody hunting for them. */
    note: "Store holds and issues this material. These figures are read-only here.",
  };
}

/**
 * The same, narrowed to one WorkOrder's own permanent sales line.
 *
 * A work order makes ONE commercial line. Showing the whole order's material on
 * it would invite planning against fabric that belongs to a different line.
 */
async function forWorkOrder(ctx, { workOrderId } = {}) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  if (!isId(workOrderId)) throw fail("NOT_FOUND", "That work order was not found.");

  const wo = await WorkOrder.findById(workOrderId)
    .select("workOrderNumber companyId customerRequestId salesLineLink").lean();
  if (!wo) throw fail("NOT_FOUND", "That work order was not found.");

  const link = wo.salesLineLink || null;
  if (!link || !link.lineRef || str(link.companyId) !== str(ctx.companyId)) {
    /* Not a weak yes. A work order that cannot say which sales line it is making
       cannot be shown material that belongs to one. */
    return {
      linked: false,
      workOrder: { id: str(wo._id), number: str(wo.workOrderNumber) },
      lines: [],
      reason: "WORK_ORDER_LINK_UNPROVEN",
      message: `Work order ${str(wo.workOrderNumber) || "(unnumbered)"} does not record which sales order `
        + "line it is making, so customer-supplied material cannot be shown for it.",
    };
  }

  const whole = await forManufacturingOrder(ctx, { orderId: link.customerRequestId });
  return {
    ...whole,
    workOrder: { id: str(wo._id), number: str(wo.workOrderNumber) },
    orderLineRef: str(link.lineRef),
    /* Only this work order's own line. */
    lines: (whole.lines || []).filter((l) => str(l.orderLineRef) === str(link.lineRef)),
  };
}

module.exports = { forManufacturingOrder, forWorkOrder, lineView };
