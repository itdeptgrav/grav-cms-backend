// services/storePurchase/purchaseOrderMail.service.js
//
// THE PERSON WHO RAISED AN MRF IS TOLD WHAT HAPPENED TO IT  (10 Oct 2026, owner)
//
//   purchase order created against the MRF  → "your request has been ordered":
//       the PO number, the supplier, every line with variant, quantity, unit
//       and rate, the expected delivery — and the PO as a PDF.
//   goods receipt recorded against that PO  → "your material has arrived":
//       the GRN number, the lines received against ordered, where it went —
//       and the GRN as a PDF.
//
// The requester is resolved from the MRF (`requestedFor` → Employee, else
// the badge id, else the ProjectManager who raised it on their behalf). The
// letters go through departmentNotify.notifyEvent with `alsoTo`, so the
// requester receives it whatever their department, and Sales' switch and CC
// list still apply. Never throws; call without awaiting.
"use strict";

const mongoose = require("mongoose");
const { notifyEvent, APP_URL, escapeHtml } = require("../departmentNotify.service");
const { buildDocumentPdf } = require("../mail/documentPdf");

const str = (v) => (v === null || v === undefined ? "" : String(v));
const qty = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 4 }));
const money = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? "—" : `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const day = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "Not set");
const model = (name, path) => (mongoose.models[name] || require(path));
const MRF = () => model("MRF", "../../models/CMS_Models/Inventory/Operations/MRF");
const Employee = () => model("Employee", "../../models/Employee");
const ProjectManager = () => model("ProjectManager", "../../models/ProjectManager");
const PurchaseOrder = () => model("PurchaseOrder", "../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const GoodsReceipt = () => model("GoodsReceipt", "../../models/CMS_Models/StorePurchase/GoodsReceipt");
/* `populate("vendor")` needs the Vendor model registered — it is on the
   server, not necessarily in a script that loads this module alone. */
const Vendor = () => model("Vendor", "../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const RawItem = () => model("RawItem", "../../models/CMS_Models/Inventory/Products/RawItem");

const TH = 'style="padding:6px 8px;text-align:left;font-size:11px;color:#666;border-bottom:1px solid #e2e8f0"';
const TD = 'style="padding:6px 8px;font-size:12px;border-bottom:1px solid #eee;vertical-align:top"';
const TDR = 'style="padding:6px 8px;font-size:12px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;vertical-align:top"';

/** The e-mail and name of whoever raised the MRF, or null. */
async function requesterOf(mrfId) {
  if (!mongoose.isValidObjectId(str(mrfId))) return null;
  const mrf = await MRF().findById(mrfId).select("mrfNumber requestedFor requestedForName requestedForId requestedForDept createdByRef createdByModel createdByName").lean();
  if (!mrf) return null;
  const name = mrf.requestedForName || mrf.createdByName || "";
  let email = "";
  if (mongoose.isValidObjectId(str(mrf.requestedFor))) {
    const e = await Employee().findById(mrf.requestedFor).select("email firstName lastName").lean().catch(() => null);
    if (e?.email) email = e.email;
  }
  if (!email && mrf.requestedForId) {
    const e = await Employee().findOne({ $or: [{ biometricId: mrf.requestedForId }, { identityId: mrf.requestedForId }] }).select("email").lean().catch(() => null);
    if (e?.email) email = e.email;
  }
  if (!email && mrf.createdByModel === "ProjectManager" && mongoose.isValidObjectId(str(mrf.createdByRef))) {
    const p = await ProjectManager().findById(mrf.createdByRef).select("email").lean().catch(() => null);
    if (p?.email) email = p.email;
  }
  if (!email && mongoose.isValidObjectId(str(mrf.createdByRef))) {
    const e = await Employee().findById(mrf.createdByRef).select("email").lean().catch(() => null);
    if (e?.email) email = e.email;
  }
  return { mrf, name, email: str(email).toLowerCase(), department: mrf.requestedForDept || "" };
}

const poLine = (it, i) => ({
  no: i + 1, item: it.itemName || it.rawItem?.name || "—", variant: it.variantName || (it.variantCombination || []).join(" · ") || "—",
  sku: it.sku || it.rawItem?.sku || "", qty: qty(it.quantity), unit: it.unit || it.rawItem?.unit || "", rate: money(it.unitPrice), amount: money(it.totalPrice),
});

/** A purchase order was created against an MRF: tell the person who raised the MRF. */
async function notifyPurchaseOrderCreatedForMrf(purchaseOrderId, { onlyTo } = {}) {
  try {
    Vendor(); RawItem();
    const po = await PurchaseOrder().findById(purchaseOrderId).populate("vendor", "companyName contactPerson email phone").populate("items.rawItem", "name sku unit").lean();
    if (!po || !po.sourceMrfId) return { sent: 0, skipped: "no-mrf" };
    const who = await requesterOf(po.sourceMrfId);
    if (!who?.email) { console.warn(`[purchaseOrderMail] ${po.poNumber}: the MRF's requester has no e-mail`); return { sent: 0, skipped: "no-requester-email" }; }
    const lines = (po.items || []).map(poLine);
    const supplier = po.vendor?.companyName || po.vendorName || "—";
    let attachments;
    try {
      const pdf = await buildDocumentPdf({
        title: "Purchase order", reference: po.poNumber,
        subtitle: `Raised against your material request ${who.mrf.mrfNumber}`,
        facts: [
          ["Supplier", supplier], ["Supplier contact", [po.vendor?.contactPerson, po.vendor?.phone, po.vendor?.email].filter(Boolean).join(" · ")],
          ["Material request", who.mrf.mrfNumber], ["Requested by", who.name], ["Department", who.department],
          ["Order date", day(po.orderDate || po.createdAt)], ["Expected delivery", day(po.expectedDeliveryDate)],
          ["Status", str(po.status).replace(/_/g, " ")], ["Order value", money(po.grandTotal ?? po.totalAmount)],
        ],
        sections: [{
          heading: "Lines ordered",
          columns: [
            { key: "no", label: "#", width: 0.4 }, { key: "item", label: "Raw item", width: 2.4, bold: true }, { key: "variant", label: "Variant", width: 1.3 },
            { key: "qty", label: "Quantity", width: 0.9, align: "right" }, { key: "unit", label: "Unit", width: 0.6 },
            { key: "rate", label: "Rate", width: 1, align: "right" }, { key: "amount", label: "Amount", width: 1.1, align: "right" },
          ],
          rows: lines,
        }],
        notes: po.notes || po.termsAndConditions || "",
        footer: "Purchase order · Store & Purchase",
      });
      attachments = [{ name: `${str(po.poNumber).replace(/\//g, "-")}.pdf`, content: pdf }];
    } catch (err) { console.warn("[purchaseOrderMail] PO PDF failed, sending without it:", err.message); }

    const rows = lines.map((l) => `<tr><td ${TD}>${l.no}</td><td ${TD}><strong>${escapeHtml(l.item)}</strong>${l.variant !== "—" ? `<br><span style="color:#64748b">${escapeHtml(l.variant)}</span>` : ""}</td><td ${TDR}>${l.qty} ${escapeHtml(l.unit)}</td><td ${TDR}>${l.rate}</td><td ${TDR}>${l.amount}</td></tr>`).join("");
    const table = `<table style="width:100%;border-collapse:collapse;border:1px solid #eee;margin-top:12px"><thead><tr style="background:#f3f4f6"><th ${TH}>#</th><th ${TH}>Raw item · variant</th><th ${TH} style="text-align:right">Quantity</th><th ${TH} style="text-align:right">Rate</th><th ${TH} style="text-align:right">Amount</th></tr></thead><tbody>${rows}</tbody></table>`;

    return await notifyEvent("po_created_for_mrf", {
      subject: `Purchase order ${po.poNumber} raised for your material request ${who.mrf.mrfNumber}`,
      heading: `Your material request has been ordered`,
      bodyHtml: `<p style="font-size:13px;color:#333;margin:0 0 12px">Dear ${escapeHtml(who.name || "colleague")},</p><p style="font-size:13px;color:#333;margin:0 0 12px">The Store has raised purchase order <strong>${escapeHtml(po.poNumber)}</strong> with <strong>${escapeHtml(supplier)}</strong> against your material request <strong>${escapeHtml(who.mrf.mrfNumber)}</strong>. The lines below are what has been ordered on your behalf; the purchase order is attached. You will be told again when the material is received.</p>`,
      bodyText: `Purchase order ${po.poNumber} was raised with ${supplier} against your material request ${who.mrf.mrfNumber}: ${lines.length} lines, expected ${day(po.expectedDeliveryDate)}.`,
      details: [
        ["Purchase order", po.poNumber], ["Supplier", supplier], ["Material request", who.mrf.mrfNumber],
        ["Order date", day(po.orderDate || po.createdAt)], ["Expected delivery", day(po.expectedDeliveryDate)],
        ["Lines", String(lines.length)], ["Order value", money(po.grandTotal ?? po.totalAmount)],
      ],
      extraHtml: table,
      ctaLabel: "View the purchase order", ctaUrl: `${APP_URL}/store/dashboard/operations/purchase-order/${po._id}`,
      alsoTo: [who.email],
      attachments,
      ...(Array.isArray(onlyTo) && onlyTo.length ? { onlyTo } : {}),
    });
  } catch (err) {
    console.error("[purchaseOrderMail] created:", err.message);
    return { sent: 0, skipped: "error" };
  }
}

/** A goods receipt was recorded against a purchase order raised for an MRF: tell the requester. */
async function notifyGoodsReceiptForMrf(goodsReceiptId, { onlyTo } = {}) {
  try {
    const grn = await GoodsReceipt().findById(goodsReceiptId).lean();
    if (!grn || !grn.purchaseOrderId) return { sent: 0, skipped: "no-po" };
    Vendor();
    const po = await PurchaseOrder().findById(grn.purchaseOrderId).select("poNumber sourceMrfId vendorName vendor status expectedDeliveryDate").populate("vendor", "companyName").lean();
    if (!po?.sourceMrfId) return { sent: 0, skipped: "no-mrf" };
    const who = await requesterOf(po.sourceMrfId);
    if (!who?.email) return { sent: 0, skipped: "no-requester-email" };
    const supplier = po.vendor?.companyName || po.vendorName || grn.supplierName || "—";
    const lines = (grn.lines || []).map((g, i) => ({
      no: i + 1, item: g.itemName || "—", variant: (g.variantCombination || []).join(" · ") || "—", sku: g.sku || "",
      ordered: qty(g.quantityOrdered), received: qty(g.receivedQuantity), unit: g.poUnit || "", pendingAfter: qty(g.pendingAfter),
      base: g.baseQuantity != null && g.baseUnit && g.baseUnit !== (g.poUnit || "") ? `${qty(g.baseQuantity)} ${g.baseUnit}` : "",
    }));
    const totalReceived = (grn.lines || []).reduce((n, g) => n + (Number(g.receivedQuantity) || 0), 0);
    const stillPending = (grn.lines || []).reduce((n, g) => n + (Number(g.pendingAfter) || 0), 0);
    let attachments;
    try {
      const pdf = await buildDocumentPdf({
        title: "Goods receipt", reference: grn.receiptNumber,
        subtitle: `Recorded against purchase order ${po.poNumber} · raised for your material request ${who.mrf.mrfNumber}`,
        facts: [
          ["Receipt date", day(grn.receiptDate || grn.createdAt)], ["Recorded by", grn.recordedBy?.name || "Store"],
          ["Purchase order", po.poNumber], ["Supplier", supplier], ["Supplier invoice", grn.invoiceNumber || "—"],
          ["Material request", who.mrf.mrfNumber], ["Requested by", who.name],
          ["Warehouse", grn.warehouseName || "—"], ["Location", grn.locationCode || grn.locationName || "Put-away pending"],
          ["Purchase order standing", str(po.status).replace(/_/g, " ")],
        ],
        sections: [{
          heading: "Lines on this receipt",
          columns: [
            { key: "no", label: "#", width: 0.4 }, { key: "item", label: "Raw item", width: 2.4, bold: true }, { key: "variant", label: "Variant", width: 1.3 },
            { key: "ordered", label: "Ordered", width: 0.9, align: "right" }, { key: "received", label: "Received", width: 0.9, align: "right" },
            { key: "unit", label: "Unit", width: 0.6 }, { key: "pendingAfter", label: "Pending after", width: 1, align: "right" }, { key: "base", label: "Into stock", width: 1.1 },
          ],
          rows: lines,
        }],
        notes: grn.notes || "",
        footer: "Goods receipt · Store & Purchase",
      });
      attachments = [{ name: `${str(grn.receiptNumber).replace(/\//g, "-")}.pdf`, content: pdf }];
    } catch (err) { console.warn("[purchaseOrderMail] GRN PDF failed, sending without it:", err.message); }

    const rows = lines.map((l) => `<tr><td ${TD}>${l.no}</td><td ${TD}><strong>${escapeHtml(l.item)}</strong>${l.variant !== "—" ? `<br><span style="color:#64748b">${escapeHtml(l.variant)}</span>` : ""}</td><td ${TDR}>${l.ordered} ${escapeHtml(l.unit)}</td><td ${TDR}><strong>${l.received} ${escapeHtml(l.unit)}</strong></td><td ${TDR}>${l.pendingAfter}</td></tr>`).join("");
    const table = `<table style="width:100%;border-collapse:collapse;border:1px solid #eee;margin-top:12px"><thead><tr style="background:#f3f4f6"><th ${TH}>#</th><th ${TH}>Raw item · variant</th><th ${TH} style="text-align:right">Ordered</th><th ${TH} style="text-align:right">Received now</th><th ${TH} style="text-align:right">Pending after</th></tr></thead><tbody>${rows}</tbody></table>`;

    return await notifyEvent("grn_recorded_for_mrf", {
      subject: `Material received: goods receipt ${grn.receiptNumber} against ${po.poNumber} (your request ${who.mrf.mrfNumber})`,
      heading: `Your requested material has been received`,
      bodyHtml: `<p style="font-size:13px;color:#333;margin:0 0 12px">Dear ${escapeHtml(who.name || "colleague")},</p><p style="font-size:13px;color:#333;margin:0 0 12px">The Store has recorded goods receipt <strong>${escapeHtml(grn.receiptNumber)}</strong> from <strong>${escapeHtml(supplier)}</strong> against purchase order <strong>${escapeHtml(po.poNumber)}</strong>, which was raised for your material request <strong>${escapeHtml(who.mrf.mrfNumber)}</strong>. ${stillPending > 0 ? `<strong>${qty(stillPending)}</strong> units of the order are still to come.` : "The purchase order is now received in full."} The receipt is attached; the material is in the Store and can be issued against your request.</p>`,
      bodyText: `Goods receipt ${grn.receiptNumber} recorded against ${po.poNumber} for your material request ${who.mrf.mrfNumber}: ${qty(totalReceived)} units received.`,
      details: [
        ["Goods receipt", grn.receiptNumber], ["Receipt date", day(grn.receiptDate || grn.createdAt)], ["Recorded by", grn.recordedBy?.name || "Store"],
        ["Purchase order", po.poNumber], ["Supplier", supplier], ["Material request", who.mrf.mrfNumber],
        ["Warehouse", grn.warehouseName || "—"],
        ["Received now", `${qty(totalReceived)} units across ${lines.length} line${lines.length === 1 ? "" : "s"}`],
        ["Purchase order standing", stillPending > 0 ? `${qty(stillPending)} units still to come` : "Received in full"],
      ],
      extraHtml: table,
      ctaLabel: "View the goods receipt", ctaUrl: `${APP_URL}/store/dashboard/operations/goods-receipts/${grn._id}/document`,
      alsoTo: [who.email],
      attachments,
      ...(Array.isArray(onlyTo) && onlyTo.length ? { onlyTo } : {}),
    });
  } catch (err) {
    console.error("[purchaseOrderMail] received:", err.message);
    return { sent: 0, skipped: "error" };
  }
}

module.exports = { notifyPurchaseOrderCreatedForMrf, notifyGoodsReceiptForMrf, requesterOf };
