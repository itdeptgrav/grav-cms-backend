// services/merchandising/materialRequestMail.service.js
//
// THE TWO LETTERS OF A MERCHANDISER'S MATERIAL REQUEST  (10 Oct 2026, owner)
//
//   submitted  → the Store ("who gets access of store, he will get that mail"):
//                the order, the customer, the request, every raw item with
//                its variant, quantity and unit, when it is needed, who asked —
//                and the request as a PDF.
//   received   → Merchandising, and the person who raised it: the GRN that
//                was recorded against the request, line by line (requested /
//                received / pending), where it went — and the GRN as a PDF.
//
// Both go through departmentNotify.notifyEvent, so Sales' on/off switch, the
// CC list and Access Control's recipient rules apply, and neither can throw
// into the request that triggered it. Call them without awaiting.
"use strict";

const mongoose = require("mongoose");
const { notifyEvent, APP_URL, escapeHtml } = require("../departmentNotify.service");
const { buildDocumentPdf } = require("../mail/documentPdf");

const str = (v) => (v === null || v === undefined ? "" : String(v));
const qty = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 4 }));
const day = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "Not set");
const when = (d) => (d ? new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const model = (name, path) => (mongoose.models[name] || require(path));
const GoodsReceipt = () => model("GoodsReceipt", "../../models/CMS_Models/StorePurchase/GoodsReceipt");
const CustomerRequest = () => model("CustomerRequest", "../../models/Customer_Models/CustomerRequest");

const TH = 'style="padding:6px 8px;text-align:left;font-size:11px;color:#666;border-bottom:1px solid #e2e8f0"';
const TD = 'style="padding:6px 8px;font-size:12px;border-bottom:1px solid #eee;vertical-align:top"';
const TDR = 'style="padding:6px 8px;font-size:12px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;vertical-align:top"';

function requestLinesHtml(request) {
  const rows = (request.lines || []).map((l, i) => `
    <tr>
      <td ${TD}>${i + 1}</td>
      <td ${TD}><strong>${escapeHtml(l.rawItemName)}</strong>${l.variantLabel ? `<br><span style="color:#64748b">${escapeHtml(l.variantLabel)}</span>` : ""}${l.rawItemSku ? `<br><span style="font-size:11px;color:#94a3b8;font-family:monospace">${escapeHtml(l.rawItemSku)}</span>` : ""}</td>
      <td ${TDR}>${qty(l.quantity)} ${escapeHtml(l.unit)}</td>
      <td ${TD}>${escapeHtml(l.note || "—")}</td>
    </tr>`).join("");
  return `<table style="width:100%;border-collapse:collapse;border:1px solid #eee;margin-top:12px">
    <thead><tr style="background:#f3f4f6"><th ${TH}>#</th><th ${TH}>Raw item · variant</th><th ${TH} style="text-align:right">Quantity</th><th ${TH}>Note</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

/** The merchandiser's order page, where the request lives. */
const orderUrl = (order) => `${APP_URL}/merchandiser/execution/orders/${order.id || order._id}`;
/** The Store's register, filtered to material requests. */
const storeUrl = () => `${APP_URL}/store/dashboard/operations/purchase-order?kind=material-requests`;

/**
 * @param {object} order    the request view's `order` ({id, orderRef, customerName, deliveryDeadline, products[]})
 * @param {object} request  a request view (requestNumber, lines[], neededBy, reason, submittedAt, createdBy)
 */
async function notifyMaterialRequestSubmitted(order, request, { onlyTo } = {}) {
  try {
    if (!order || !request) return { sent: 0, skipped: "no-request" };
    const total = (request.lines || []).reduce((n, l) => n + (Number(l.quantity) || 0), 0);
    const by = request.submittedBy?.name || request.createdBy?.name || "Merchandising";
    let attachments;
    try {
      const pdf = await buildDocumentPdf({
        title: "Material request", reference: request.requestNumber,
        subtitle: `Raised by Merchandising for order ${order.orderRef} · ${order.customerName || "—"}`,
        facts: [
          ["Order", order.orderRef], ["Customer", order.customerName],
          ["Products", (order.products || []).join(", ")],
          ["Delivery deadline", day(order.deliveryDeadline)],
          ["Needed by", day(request.neededBy)],
          ["Raised by", by], ["Submitted", when(request.submittedAt || request.createdAt)],
          ["Lines", String((request.lines || []).length)],
        ],
        sections: [{
          heading: "Raw material requested",
          columns: [
            { key: "no", label: "#", width: 0.4 }, { key: "item", label: "Raw item", width: 2.6, bold: true },
            { key: "variant", label: "Variant", width: 1.4 }, { key: "sku", label: "Code", width: 1.2 },
            { key: "qty", label: "Quantity", width: 1, align: "right" }, { key: "unit", label: "Unit", width: 0.7 },
            { key: "note", label: "Note", width: 1.6 },
          ],
          rows: (request.lines || []).map((l, i) => ({ no: i + 1, item: l.rawItemName, variant: l.variantLabel || "—", sku: l.rawItemSku || "", qty: qty(l.quantity), unit: l.unit, note: l.note || "" })),
        }],
        notes: request.reason || "",
        footer: "Material request · Merchandising → Store",
      });
      attachments = [{ name: `${request.requestNumber}.pdf`, content: pdf }];
    } catch (err) { console.warn("[materialRequestMail] PDF failed, sending without it:", err.message); }

    return await notifyEvent("merch_material_request_submitted", {
      subject: `Material request ${request.requestNumber} — ${order.orderRef} · ${order.customerName || "customer"} · ${qty(total)} units`,
      heading: `Material request ${request.requestNumber} from Merchandising`,
      bodyHtml: `<p style="font-size:13px;color:#333;margin:0 0 12px">Merchandising has raised a material request against order <strong>${escapeHtml(order.orderRef)}</strong> for <strong>${escapeHtml(order.customerName || "—")}</strong>. The lines below are what the Store is asked to receive and keep against this order; the attached sheet is the formal record. Please receive the material on the Purchase register and record the goods receipt against this request, and raise any shortfall or substitution with Merchandising first.</p>`,
      bodyText: `Merchandising raised material request ${request.requestNumber} against order ${order.orderRef} (${order.customerName || "—"}): ${(request.lines || []).length} lines, needed by ${day(request.neededBy)}.`,
      details: [
        ["Order", order.orderRef], ["Customer", order.customerName || "—"],
        ["Products on the order", (order.products || []).join(", ") || "—"],
        ["Delivery deadline", day(order.deliveryDeadline)],
        ["Needed by", day(request.neededBy)],
        ["Raised by", by], ["Submitted", when(request.submittedAt || request.createdAt)],
        ["Lines", `${(request.lines || []).length} · ${qty(total)} units in all`],
        ...(request.reason ? [["Note from Merchandising", request.reason]] : []),
      ],
      extraHtml: requestLinesHtml(request),
      ctaLabel: "Open the Purchase register", ctaUrl: storeUrl(),
      attachments,
      ...(Array.isArray(onlyTo) && onlyTo.length ? { onlyTo } : {}),
    });
  } catch (err) {
    console.error("[materialRequestMail] submitted:", err.message);
    return { sent: 0, skipped: "error" };
  }
}

/**
 * A goods receipt was recorded against the request.
 * @param {object} args.order     request view's order
 * @param {object} args.request   request view (after the receipt)
 * @param {string} args.goodsReceiptId
 * @param {object} [args.recordedBy]  { name }
 */
async function notifyMaterialRequestReceived({ customerRequestId, requestId, goodsReceiptId, recordedBy, onlyTo } = {}) {
  try {
    if (!goodsReceiptId || !mongoose.isValidObjectId(str(customerRequestId))) return { sent: 0, skipped: "no-receipt" };
    const orderDoc = await CustomerRequest().findById(customerRequestId).lean();
    const raw = (orderDoc?.materialRequests || []).find((x) => str(x._id) === str(requestId));
    if (!orderDoc || !raw) return { sent: 0, skipped: "no-request" };
    const { requestView } = require("./orderMaterialRequest.service");
    const request = requestView(raw, orderDoc);
    const order = request.order;
    const grn = await GoodsReceipt().findById(goodsReceiptId).lean();
    if (!grn) return { sent: 0, skipped: "no-receipt" };
    const reqLine = new Map((request.lines || []).map((l) => [str(l.lineId), l]));
    const lines = (grn.lines || []).map((g, i) => {
      const r = reqLine.get(str(g.sourceLineId)) || {};
      return {
        no: i + 1, item: g.itemName || r.rawItemName || "—", variant: (g.variantCombination || []).join(" · ") || r.variantLabel || "—",
        sku: g.sku || r.rawItemSku || "", requested: qty(g.quantityOrdered ?? r.quantity), received: qty(g.receivedQuantity),
        unit: g.poUnit || r.unit || "", pendingAfter: qty(g.pendingAfter ?? r.pending), base: g.baseQuantity != null && g.baseUnit && g.baseUnit !== (g.poUnit || "") ? `${qty(g.baseQuantity)} ${g.baseUnit}` : "",
      };
    });
    const totalReceived = (grn.lines || []).reduce((n, g) => n + (Number(g.receivedQuantity) || 0), 0);
    const stillPending = (request.lines || []).reduce((n, l) => n + (Number(l.pending) || 0), 0);
    const raiser = request.createdBy?.email || request.submittedBy?.email || "";

    let attachments;
    try {
      const pdf = await buildDocumentPdf({
        title: "Goods receipt", reference: grn.receiptNumber,
        subtitle: `Recorded against material request ${request.requestNumber} · order ${order.orderRef} · ${order.customerName || "—"}`,
        facts: [
          ["Receipt date", day(grn.receiptDate || grn.createdAt)], ["Recorded by", grn.recordedBy?.name || recordedBy?.name || "Store"],
          ["Material request", request.requestNumber], ["Order", order.orderRef], ["Customer", order.customerName],
          ["Warehouse", grn.warehouseName || "—"], ["Location", grn.locationCode || grn.locationName || "Put-away pending"],
          ["Lines received", String(lines.length)], ["Still pending on the request", stillPending > 0 ? qty(stillPending) : "Nothing — received in full"],
        ],
        sections: [{
          heading: "Lines on this receipt",
          columns: [
            { key: "no", label: "#", width: 0.4 }, { key: "item", label: "Raw item", width: 2.4, bold: true }, { key: "variant", label: "Variant", width: 1.3 },
            { key: "requested", label: "Requested", width: 0.9, align: "right" }, { key: "received", label: "Received", width: 0.9, align: "right" },
            { key: "unit", label: "Unit", width: 0.6 }, { key: "pendingAfter", label: "Pending after", width: 1, align: "right" }, { key: "base", label: "Into stock", width: 1.1 },
          ],
          rows: lines,
        }],
        notes: grn.notes || "",
        footer: "Goods receipt · Store → Merchandising",
      });
      attachments = [{ name: `${str(grn.receiptNumber).replace(/\//g, "-")}.pdf`, content: pdf }];
    } catch (err) { console.warn("[materialRequestMail] GRN PDF failed, sending without it:", err.message); }

    const rowsHtml = lines.map((l) => `
      <tr><td ${TD}>${l.no}</td><td ${TD}><strong>${escapeHtml(l.item)}</strong>${l.variant !== "—" ? `<br><span style="color:#64748b">${escapeHtml(l.variant)}</span>` : ""}</td>
      <td ${TDR}>${l.requested} ${escapeHtml(l.unit)}</td><td ${TDR}><strong>${l.received} ${escapeHtml(l.unit)}</strong></td><td ${TDR}>${l.pendingAfter}</td></tr>`).join("");
    const table = `<table style="width:100%;border-collapse:collapse;border:1px solid #eee;margin-top:12px">
      <thead><tr style="background:#f3f4f6"><th ${TH}>#</th><th ${TH}>Raw item · variant</th><th ${TH} style="text-align:right">Requested</th><th ${TH} style="text-align:right">Received now</th><th ${TH} style="text-align:right">Pending after</th></tr></thead><tbody>${rowsHtml}</tbody></table>`;

    return await notifyEvent("merch_material_request_received", {
      subject: `Goods receipt ${grn.receiptNumber} recorded against ${request.requestNumber} — ${order.orderRef}`,
      heading: `The Store received material against ${request.requestNumber}`,
      bodyHtml: `<p style="font-size:13px;color:#333;margin:0 0 12px">The Store has recorded goods receipt <strong>${escapeHtml(grn.receiptNumber)}</strong> against your material request <strong>${escapeHtml(request.requestNumber)}</strong> for order <strong>${escapeHtml(order.orderRef)}</strong> (${escapeHtml(order.customerName || "—")}). ${stillPending > 0 ? `<strong>${qty(stillPending)}</strong> units are still pending on the request.` : "The request is now received in full."} The receipt is attached; QC's check of the received raw material is recorded against this receipt and shows on the order page.</p>`,
      bodyText: `Goods receipt ${grn.receiptNumber} recorded against ${request.requestNumber} (order ${order.orderRef}): ${qty(totalReceived)} units received. ${stillPending > 0 ? `${qty(stillPending)} still pending.` : "Received in full."}`,
      details: [
        ["Goods receipt", grn.receiptNumber], ["Receipt date", day(grn.receiptDate || grn.createdAt)],
        ["Recorded by", grn.recordedBy?.name || recordedBy?.name || "Store"],
        ["Material request", request.requestNumber], ["Order", order.orderRef], ["Customer", order.customerName || "—"],
        ["Warehouse", grn.warehouseName || "—"],
        ["Received now", `${qty(totalReceived)} units across ${lines.length} line${lines.length === 1 ? "" : "s"}`],
        ["Request standing", stillPending > 0 ? `${qty(stillPending)} units still pending` : "Received in full"],
      ],
      extraHtml: table,
      ctaLabel: "Open the order in Merchandising", ctaUrl: orderUrl(order),
      alsoTo: raiser ? [raiser] : [],
      attachments,
      ...(Array.isArray(onlyTo) && onlyTo.length ? { onlyTo } : {}),
    });
  } catch (err) {
    console.error("[materialRequestMail] received:", err.message);
    return { sent: 0, skipped: "error" };
  }
}

module.exports = { notifyMaterialRequestSubmitted, notifyMaterialRequestReceived, requestLinesHtml };
