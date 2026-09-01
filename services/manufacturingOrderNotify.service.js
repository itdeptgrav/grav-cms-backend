// services/manufacturingOrderNotify.service.js
//
// "A MANUFACTURING ORDER HAS BEEN RAISED" → the Project Manager.
//
// Explicit request, 31 Aug 2026: "in the product manager side basically it is
// needed to notify about the order ok, means when when the manufacturing order
// goona create (means the customer request sent to production)... but make sure
// situation wise mo also need to modify like which type of mo it is whether it
// is for sampling order, genuine customer order or like testing order... So
// basically properly describe about that order properly ok, which type of
// order, which customer, what's the total qty, total WO, wo wise. which type of
// order, lists (product name, photo, qty and all)... and one more thing that is
// in that mail the pdf also need to attach about that order".
//
// ── WHERE THIS IS CALLED FROM, AND WHY THERE ────────────────────────────
// From inside `createWorkOrdersAndProgress` (quotationRoutes.js) — the single
// factory every route that raises an MO goes through. There are at least three
// such routes today (quotation sales-approve, mark-internal-order, and R&D's
// sampling production submit) and hooking each one individually is how the
// fourth, added later, silently sends nothing.
//
// ── FAILURE POSTURE ────────────────────────────────────────────────────
// Never throws, never blocks. An MO that was successfully created must not be
// rolled back because Brevo was down or a PDF photo 404'd — the order is the
// real work, the email is a courtesy. Every failure is logged and swallowed,
// and the caller is expected to invoke this WITHOUT awaiting it.
"use strict";

const { notifyEvent, APP_URL } = require("./departmentNotify.service");
const { buildManufacturingOrderPdf } = require("./manufacturingOrderPdf");
const { resolveOrderOrigin } = require("./orderOrigin");
const { personsOnOrder } = require("./personRoster");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

/** Same rule the PDF uses — see manufacturingOrderPdf.js's own note: real work
 *  orders carry no `workOrderNumber`, and the short `_id` form is what the
 *  shop-floor barcode encodes, so it is what people can actually match. */
const workOrderLabel = (wo) =>
  wo?.workOrderNumber || (wo?._id ? `WO-${String(wo._id).slice(-8)}` : "—");

const prettyDate = (d) =>
  d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "Not set";

/**
 * Tell the Project Manager an order has reached production.
 *
 * @param {object} request     the CustomerRequest just moved to production
 * @param {Array}  workOrders  the WorkOrders raised for it
 */
async function notifyManufacturingOrderCreated(request, workOrders = []) {
  try {
    if (!request) return { sent: 0, skipped: "no-request" };

    const origin = resolveOrderOrigin(request);
    const moNumber = `MO-${request.requestId}`;
    const items = request.items || [];
    const totalQty = items.reduce((s, i) => s + (i.totalQuantity || 0), 0);
    const productNames = items.map((i) => i.stockItemName).filter(Boolean);

    // ── The PDF, if the PM wants one ────────────────────────────────────
    // Its own switch, separate from the template's — see ProductionSettings.
    // A failure here costs the attachment, never the email.
    let attachments;
    try {
      const ProductionSettings = require("../models/CMS_Models/Manufacturing/ProductionSettings");
      const settings = await ProductionSettings.findOne({ key: "production" }).select("attachOrderPdf").lean();
      if (settings?.attachOrderPdf !== false) {
        const pdf = await buildManufacturingOrderPdf(request, workOrders);
        attachments = [{ name: `${moNumber}.pdf`, content: pdf }];
      }
    } catch (err) {
      console.warn("[moNotify] order PDF failed, sending without it:", err.message);
    }

    // ── Work-order table, in the body ───────────────────────────────────
    // The request asked for "total WO, wo wise" — a count alone does not let
    // the PM plan, and the PDF is the formal record rather than the thing
    // somebody reads on a phone.
    const woRows = workOrders.slice(0, 40).map((wo) => `
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-family:monospace;font-size:12px">${esc(workOrderLabel(wo))}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px">${esc(wo.stockItemName || wo.productName || "—")}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;text-align:right">${esc(wo.quantity ?? wo.totalQuantity ?? "—")}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px">${esc(String(wo.status || "pending").replace(/_/g, " "))}</td>
      </tr>`).join("");

    const woTable = workOrders.length ? `
      <h4 style="margin:20px 0 6px;font-size:13px">Work orders (${workOrders.length})</h4>
      <table style="width:100%;border-collapse:collapse;border:1px solid #eee">
        <thead><tr style="background:#f3f4f6">
          <th style="padding:6px 8px;text-align:left;font-size:11px;color:#666">WORK ORDER</th>
          <th style="padding:6px 8px;text-align:left;font-size:11px;color:#666">PRODUCT</th>
          <th style="padding:6px 8px;text-align:right;font-size:11px;color:#666">QTY</th>
          <th style="padding:6px 8px;text-align:left;font-size:11px;color:#666">STATUS</th>
        </tr></thead>
        <tbody>${woRows}</tbody>
      </table>
      ${workOrders.length > 40 ? `<p style="font-size:11px;color:#888">…and ${workOrders.length - 40} more. The attached PDF lists every one.</p>` : ""}` : "";

    // Per-product breakdown with quantities and variants.
    const productRows = items.map((i) => {
      const variants = (i.variants || [])
        .map((v) => {
          const attrs = Array.isArray(v.attributes) ? v.attributes.map((a) => a?.value).filter(Boolean).join(" / ") : "";
          return `${esc(attrs || "base")} &times; ${esc(v.quantity || 0)}`;
        }).join(" &nbsp;·&nbsp; ");
      return `
        <tr>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px">
            <strong>${esc(i.stockItemName || "Unnamed product")}</strong>
            ${i.stockItemReference ? `<br><span style="font-size:11px;color:#888">${esc(i.stockItemReference)}</span>` : ""}
            ${variants ? `<br><span style="font-size:11px;color:#666">${variants}</span>` : ""}
          </td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;text-align:right;white-space:nowrap">${esc(i.totalQuantity || 0)} pcs</td>
        </tr>`;
    }).join("");

    const productTable = items.length ? `
      <h4 style="margin:20px 0 6px;font-size:13px">Products (${items.length})</h4>
      <table style="width:100%;border-collapse:collapse;border:1px solid #eee">
        <tbody>${productRows}</tbody>
      </table>` : "";

    // The order-type banner. First thing in the body, for the same reason it
    // is first in the PDF: a sampling run must not read as a customer's order.
    const banner = `
      <div style="border-left:4px solid ${origin.key === "customer" ? "#0E8F76" : "#B4680A"};background:#f7f8fa;padding:12px 14px;margin:0 0 16px">
        <div style="font-size:11px;color:#666;letter-spacing:.06em">ORDER TYPE</div>
        <div style="font-size:16px;font-weight:700;color:#111;margin-top:2px">${esc(origin.label)}</div>
        <div style="font-size:12px;color:#555;margin-top:4px">${esc(origin.description)}</div>
      </div>`;

    return await notifyEvent("manufacturing_order_created", {
      subject: `New Manufacturing Order ${moNumber} — ${origin.label}`,
      heading: `Manufacturing Order ${moNumber} raised`,
      // Placeholders for a PM-authored template. The banner and tables below
      // are facts about the record and stay with this call site — same rule
      // the sampling templates follow.
      vars: buildVars(request, workOrders),
      details: [
        ["Order type", origin.label],
        ["Order shape", personWiseOf(request) ? "Person-wise (measurement conversion)" : "Size-wise (bulk)"],
        ["MO number", moNumber],
        ["Customer", request.customerInfo?.name || "—"],
        ["Total quantity", `${totalQty} pcs`],
        ["Work orders", String(workOrders.length)],
        ["Priority", String(request.priority || "medium").toUpperCase()],
        ["Delivery deadline", prettyDate(request.customerInfo?.deliveryDeadline)],
      ],
      extraHtml: banner + productTable + woTable,
      ctaLabel: "Open Manufacturing Order",
      ctaUrl: moUrl(request),
      attachments,
    });
  } catch (err) {
    // Never let a courtesy email break a real order.
    console.error("[moNotify] failed:", err.message);
    return { sent: 0, skipped: "error" };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// THE OTHER THREE AUDIENCES
//
// Same moment, three more letters, each saying what its reader is accountable
// for. See ProductionSettings' PRODUCTION_TEMPLATE_DEFAULTS for the wording
// and why the formats differ rather than one letter going to everyone.
// ═══════════════════════════════════════════════════════════════════════════

const moUrl = (request) =>
  `${APP_URL}/project-manager/dashboard/production/manufacturing-orders/${request._id}`;

const personWiseOf = (r) => Boolean(r?.requestType === "measurement_conversion" || r?.measurementId);

/** Every placeholder any of the four templates can use. Built once, shared —
 *  a template edited to use `{peopleCount}` should work whichever letter it
 *  is, rather than resolving on some and standing literal on others. */
function buildVars(request, workOrders) {
  const origin = resolveOrderOrigin(request);
  const items = request.items || [];
  const totalQty = items.reduce((s, i) => s + (i.totalQuantity || 0), 0);
  const personWise = personWiseOf(request);
  const persons = personWise ? personsOnOrder(items) : [];
  return {
    moNumber: `MO-${request.requestId}`,
    requestId: String(request.requestId || ""),
    orderType: origin.label,
    orderShape: personWise ? "Person-wise (measurement conversion)" : "Size-wise (bulk)",
    customer: request.customerInfo?.name || "—",
    totalQty: `${totalQty} pcs`,
    workOrderCount: String(workOrders.length),
    productCount: String(items.length),
    products: items.map((i) => i.stockItemName).filter(Boolean).join(", ") || "—",
    priority: String(request.priority || "medium"),
    deliveryDeadline: prettyDate(request.customerInfo?.deliveryDeadline),
    peopleCount: personWise ? String(persons.length) : "—",
    // Filled by the caller when the order came from a sample style; the R&D
    // letter is the one that leans on these.
    sampleRef: request.__sampleRef || "—",
    sampleProduct: request.__sampleProduct || items[0]?.stockItemName || "—",
  };
}

/** Shared detail rows, trimmed per audience by the caller. */
function baseDetails(request, workOrders) {
  const origin = resolveOrderOrigin(request);
  const totalQty = (request.items || []).reduce((s, i) => s + (i.totalQuantity || 0), 0);
  return {
    orderType: ["Order type", origin.label],
    shape: ["Order shape", personWiseOf(request) ? "Person-wise (measurement conversion)" : "Size-wise (bulk)"],
    mo: ["MO number", `MO-${request.requestId}`],
    customer: ["Customer", request.customerInfo?.name || "—"],
    qty: ["Total quantity", `${totalQty} pcs`],
    wos: ["Work orders", String(workOrders.length)],
    priority: ["Priority", String(request.priority || "medium").toUpperCase()],
    deadline: ["Delivery deadline", prettyDate(request.customerInfo?.deliveryDeadline)],
  };
}

/**
 * Send one of the three non-PM notices.
 *
 * Factored rather than written three times: the only real differences are the
 * event key, which detail rows are shown, and which cut of the PDF is attached
 * — everything else (the banner, the failure posture, the PDF on/off switch)
 * is identical, and three copies is how they drift.
 */
async function sendAudienceNotice({ eventKey, audience, request, workOrders, detailKeys, extraHtml, ctaLabel }) {
  try {
    if (!request) return { sent: 0, skipped: "no-request" };
    const moNumber = `MO-${request.requestId}`;

    let attachments;
    try {
      const ProductionSettings = require("../models/CMS_Models/Manufacturing/ProductionSettings");
      const settings = await ProductionSettings.findOne({ key: "production" }).select("attachOrderPdf").lean();
      if (settings?.attachOrderPdf !== false) {
        const pdf = await buildManufacturingOrderPdf(request, workOrders, { audience });
        attachments = [{ name: `${moNumber}.pdf`, content: pdf }];
      }
    } catch (err) {
      console.warn(`[moNotify:${audience}] PDF failed, sending without it:`, err.message);
    }

    const d = baseDetails(request, workOrders);
    return await notifyEvent(eventKey, {
      vars: buildVars(request, workOrders),
      details: detailKeys.map((k) => d[k]).filter(Boolean),
      extraHtml,
      ctaLabel,
      ctaUrl: moUrl(request),
      attachments,
    });
  } catch (err) {
    console.error(`[moNotify:${audience}] failed:`, err.message);
    return { sent: 0, skipped: "error" };
  }
}

/**
 * Tell everyone an order reached production.
 *
 * Fired as ONE call from `createWorkOrdersAndProgress`, so no route has to
 * remember four separate notifications. Each audience's own on/off switch and
 * template still applies independently inside `notifyEvent`.
 *
 * Runs the four in parallel and never rejects: one department's Brevo failure
 * must not stop the other three being told.
 */
async function notifyOrderReleasedToProduction(request, workOrders = []) {
  const origin = resolveOrderOrigin(request);
  const items = request.items || [];
  const totalQty = items.reduce((s, i) => s + (i.totalQuantity || 0), 0);

  // If this order came from a sample style, carry its reference so the R&D
  // letter can name the thing they actually developed rather than the generic
  // product. Read once, here, rather than inside each letter.
  if (request.sampleStyleId && !request.__sampleRef) {
    try {
      const SampleStyle = require("../models/CMS_Models/Sales/SampleStyle");
      const st = await SampleStyle.findById(request.sampleStyleId).select("sampleStyleId productName").lean();
      if (st) { request.__sampleRef = st.sampleStyleId; request.__sampleProduct = st.productName; }
    } catch { /* the letter falls back to the product name */ }
  }

  const banner = `
    <div style="border-left:4px solid ${origin.key === "customer" ? "#0E8F76" : "#B4680A"};background:#f7f8fa;padding:12px 14px;margin:0 0 16px">
      <div style="font-size:11px;color:#666;letter-spacing:.06em">ORDER TYPE</div>
      <div style="font-size:16px;font-weight:700;color:#111;margin-top:2px">${esc(origin.label)}</div>
      <div style="font-size:12px;color:#555;margin-top:4px">${esc(origin.description)}</div>
    </div>`;

  const productRows = items.map((i) => `
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px">
          <strong>${esc(i.stockItemName || "Unnamed product")}</strong>
          ${i.stockItemReference ? `<br><span style="font-size:11px;color:#888">${esc(i.stockItemReference)}</span>` : ""}
        </td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;text-align:right;white-space:nowrap">${esc(i.totalQuantity || 0)} pcs</td>
      </tr>`).join("");
  const productTable = items.length
    ? `<h4 style="margin:20px 0 6px;font-size:13px">Products (${items.length})</h4>
       <table style="width:100%;border-collapse:collapse;border:1px solid #eee"><tbody>${productRows}</tbody></table>`
    : "";

  const [pm, rnd, merch, sales] = await Promise.all([
    notifyManufacturingOrderCreated(request, workOrders),
    sendAudienceNotice({
      eventKey: "mo_rnd_notice", audience: "rnd", request, workOrders,
      detailKeys: ["mo", "orderType", "shape", "qty", "deadline"],
      extraHtml: banner + productTable,
      ctaLabel: "View the order",
    }),
    sendAudienceNotice({
      eventKey: "mo_merchandiser_notice", audience: "merchandiser", request, workOrders,
      detailKeys: ["mo", "customer", "orderType", "qty", "deadline"],
      extraHtml: banner + productTable +
        `<p style="font-size:12px;color:#555;margin-top:14px">The consolidated material requirement for this run — every raw item and the quantity it consumes — is set out in the attached sheet.</p>`,
      ctaLabel: "View the order",
    }),
    sendAudienceNotice({
      eventKey: "mo_sales_notice", audience: "sales", request, workOrders,
      detailKeys: ["mo", "customer", "orderType", "qty", "deadline"],
      extraHtml: banner + productTable,
      ctaLabel: "Open the order",
    }),
  ]);

  console.log(
    `[moNotify] MO-${request.requestId} (${origin.key}, ${totalQty} pcs) — ` +
    `pm:${pm.sent ?? 0} rnd:${rnd.sent ?? 0} merch:${merch.sent ?? 0} sales:${sales.sent ?? 0}`,
  );
  return { pm, rnd, merch, sales };
}

module.exports = { notifyManufacturingOrderCreated, notifyOrderReleasedToProduction, buildVars };
