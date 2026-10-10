// services/storePurchase/goodsReceiptDocument.service.js
//
// ONE GOODS RECEIPT, AS A DOCUMENT  (7 Oct 2026)
//
// The GRN view page and its PDF read this. It describes any receipt the same
// way — header, the source it discharges, its lines — and says which kind of
// source that is, so the page and the PDF can word themselves per kind:
//
//   purchase          against a purchase order: the PO and its supplier, the
//                     supplier's invoice / challan reference, ordered vs
//                     received per line;
//   material-request  against a merchandiser's material request: the request,
//                     the order it serves and that order's customer, requested
//                     vs received, and the invoiced figure beside the actual;
//   customer-material against a customer-supplied document: the customer and
//                     the document.
//
// It reads; nothing here writes. Figures are the GRN's own (what was written
// when it was recorded), never recomputed.
"use strict";

const mongoose = require("mongoose");
const { fail } = require("./errors");
const tenantContext = require("./tenantContext.service");

const model = (name, path) => (mongoose.models[name] || require(path));
const GoodsReceipt = () => model("GoodsReceipt", "../../models/CMS_Models/StorePurchase/GoodsReceipt");
const PurchaseOrder = () => model("PurchaseOrder", "../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const Vendor = () => model("Vendor", "../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const CustomerRequest = () => model("CustomerRequest", "../../models/Customer_Models/CustomerRequest");
const Barcode = () => model("Barcode", "../../models/CMS_Models/Inventory/Operations/Barcode");

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

const KIND = Object.freeze({ PURCHASE: "purchase", MATERIAL: "material-request", CUSTOMER: "customer-material" });
const kindOf = (g) => (g.sourceType === "MATERIAL_REQUEST" ? KIND.MATERIAL
  : g.sourceType === "CUSTOMER_MATERIAL" ? KIND.CUSTOMER : KIND.PURCHASE);

const addressText = (a) => {
  if (!a) return "";
  if (typeof a === "string") return a;
  return [a.street, a.city, a.state, a.pincode, a.country].map(str).filter(Boolean).join(", ");
};

async function sourceFor(tenant, g, kind) {
  if (kind === KIND.PURCHASE) {
    const po = g.purchaseOrderId
      ? await PurchaseOrder().findOne({ _id: g.purchaseOrderId, ...tenantContext.tenantFilter(tenant) })
        .select("poNumber orderDate expectedDeliveryDate vendor vendorName status").lean()
      : null;
    const vendorId = g.supplierId || po?.vendor || null;
    const vendor = vendorId
      ? await Vendor().findOne({ _id: vendorId }).select("companyName gstNumber phone email address contactPerson").lean().catch(() => null)
      : null;
    return {
      kind,
      purchaseOrderId: g.purchaseOrderId ? str(g.purchaseOrderId) : null,
      poNumber: str(g.poNumber || po?.poNumber),
      poDate: po?.orderDate || null,
      expectedDate: po?.expectedDeliveryDate || null,
      poStatus: str(po?.status),
      supplier: {
        name: str(g.supplierName || vendor?.companyName || po?.vendorName),
        gstin: str(vendor?.gstNumber), phone: str(vendor?.phone), email: str(vendor?.email),
        contact: str(vendor?.contactPerson), address: addressText(vendor?.address),
      },
      invoiceNumber: str(g.invoiceNumber),
    };
  }
  if (kind === KIND.MATERIAL) {
    const orderId = g.materialRequest?.customerRequestId || null;
    const order = orderId
      ? await CustomerRequest().findById(orderId)
        .select("requestId status customerInfo.name customerInfo.deliveryDeadline quotations.quotationNumber materialRequests").lean()
      : null;
    const request = (order?.materialRequests || []).find((r) => str(r._id) === str(g.materialRequest?.requestId)) || null;
    return {
      kind,
      requestId: g.materialRequest?.requestId ? str(g.materialRequest.requestId) : null,
      requestNumber: str(g.materialRequest?.requestNumber || g.sourceDocumentNumber),
      orderId: orderId ? str(orderId) : null,
      orderRef: str(g.materialRequest?.orderRef || order?.requestId),
      customerName: str(order?.customerInfo?.name),
      piNumber: str(order?.quotations?.[0]?.quotationNumber),
      deliveryDeadline: order?.customerInfo?.deliveryDeadline || null,
      raisedBy: str(request?.createdBy?.name) || "Merchandising",
      submittedAt: request?.submittedAt || request?.createdAt || null,
      neededBy: request?.neededBy || null,
      requestNote: str(request?.reason),
    };
  }
  return {
    kind,
    documentId: g.sourceDocumentId ? str(g.sourceDocumentId) : null,
    documentRef: str(g.sourceDocumentNumber),
    customerName: str(g.customerMaterial?.customerLabel),
    orderRef: str(g.customerMaterial?.orderRef),
    customerReference: str(g.customerMaterial?.customerReference),
  };
}

async function document(tenant, grnId) {
  if (!mongoose.isValidObjectId(str(grnId))) throw fail("NOT_FOUND", "Goods receipt not found.");
  const g = await GoodsReceipt().findOne({ _id: grnId, ...tenantContext.tenantFilter(tenant) }).lean();
  if (!g) throw fail("NOT_FOUND", "Goods receipt not found.");
  const kind = kindOf(g);
  const source = await sourceFor(tenant, g, kind);

  /* Labels that went live under this receipt, per line — the traceability a
     printed GRN can quote. */
  const labels = await Barcode().find({ goodsReceiptId: g._id }).select("goodsReceiptLineId").lean().catch(() => []);
  const labelsByLine = new Map();
  for (const b of labels) {
    const k = str(b.goodsReceiptLineId);
    labelsByLine.set(k, (labelsByLine.get(k) || 0) + 1);
  }

  const lines = (g.lines || []).map((l, i) => {
    const received = num(l.receivedQuantity) || 0;
    const invoiced = num(l.invoicedQuantity);
    return {
      no: i + 1,
      id: str(l._id),
      itemName: str(l.itemName), sku: str(l.sku),
      variant: (l.variantCombination || []).map(str).filter(Boolean).join(" · "),
      unit: str(l.poUnit),
      ordered: num(l.quantityOrdered),
      previouslyReceived: num(l.previouslyReceived),
      received,
      invoiced,
      difference: invoiced === null ? null : Math.round((received - invoiced) * 10000) / 10000,
      pendingAfter: num(l.pendingAfter),
      baseQuantity: num(l.baseQuantity), baseUnit: str(l.baseUnit),
      conversionNote: str(l.conversionNote),
      labels: labelsByLine.get(str(l._id)) || 0,
    };
  });

  return {
    grn: {
      id: str(g._id),
      receiptNumber: str(g.receiptNumber),
      kind,
      status: str(g.status) || "RECORDED",
      receiptDate: g.receiptDate || g.createdAt || null,
      recordedAt: g.createdAt || null,
      recordedBy: str(g.recordedBy?.name),
      warehouseName: str(g.warehouseName),
      location: [g.locationName, g.locationCode].map(str).filter(Boolean).join(" · "),
      notes: str(g.notes),
    },
    source,
    lines,
    totals: {
      lineCount: lines.length,
      labelCount: labels.length,
      linesShortOfInvoice: lines.filter((l) => l.difference !== null && l.difference < 0).length,
      linesOverInvoice: lines.filter((l) => l.difference !== null && l.difference > 0).length,
    },
  };
}

/** Every GRN recorded against one source document, newest first. */
async function listForSource(tenant, { purchaseOrderId = null, materialRequestId = null } = {}) {
  const where = purchaseOrderId
    ? { purchaseOrderId }
    : materialRequestId ? { "materialRequest.requestId": materialRequestId } : null;
  if (!where) return [];
  const rows = await GoodsReceipt().find({ ...where, ...tenantContext.tenantFilter(tenant) })
    .select("receiptNumber receiptDate createdAt recordedBy lines.receivedQuantity status")
    .sort({ receiptDate: -1, _id: -1 }).lean();
  return rows.map((g) => ({
    id: str(g._id), receiptNumber: str(g.receiptNumber), receiptDate: g.receiptDate || g.createdAt || null,
    recordedBy: str(g.recordedBy?.name), lineCount: (g.lines || []).length, status: str(g.status) || "RECORDED",
    href: `/store/dashboard/operations/goods-receipts/${str(g._id)}/document`,
  }));
}

module.exports = { KIND, document, listForSource };
