"use strict";
// services/ppc/materialRequestsNotify.service.js
//
// The two mails of a material request (4 Oct 2026): PPC raised one → the Store;
// the Store issued against one → PPC. Both carry the lines as a table. Best
// effort: a failed mail never fails the write that triggered it.

const { notifyEvent, APP_URL, escapeHtml } = require("../departmentNotify.service");

const td = "padding:6px 10px 6px 0;border-bottom:1px solid #eef1f5;vertical-align:top";
const th = "padding:0 10px 6px 0;font-weight:600";

function linesTable(request, { issued = false } = {}) {
  const rows = (request?.lines || []).map((l) => `<tr>
  <td style="${td}"><strong>${escapeHtml(l.rawItemName || "")}</strong>${l.rawItemSku ? `<br/><span style="color:#94a3b8;font-size:12px">${escapeHtml(l.rawItemSku)}</span>` : ""}</td>
  <td style="${td};color:#475569">${escapeHtml(l.variantLabel || (l.variantCombination || []).join(" · ") || "—")}</td>
  <td style="${td};text-align:right">${l.quantity} ${escapeHtml(l.unit || "")}</td>
  ${issued ? `<td style="${td};text-align:right">${l.issuedQty ?? 0} ${escapeHtml(l.unit || "")}</td><td style="${td};text-align:right">${l.remaining ?? ""}</td>` : ""}
  <td style="${td};color:#64748b;font-style:italic">${escapeHtml(l.note || "")}</td>
</tr>`).join("");
  return `<p style="margin:16px 0 6px;font-size:12px;color:#64748b;font-weight:600">MATERIAL LINES</p>
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px">
  <thead><tr style="text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:#94a3b8">
    <th style="${th}">Raw item</th><th style="${th}">Variant</th><th style="${th};text-align:right">Requested</th>${issued ? `<th style="${th};text-align:right">Issued</th><th style="${th};text-align:right">Remaining</th>` : ""}<th style="${th}">Note</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
}

async function notifyMaterialRequestRaised(order, request, actor) {
  if (!order || !request) return { sent: 0 };
  const who = actor?.name || "PPC";
  return notifyEvent("ppc_material_request_raised", {
    vars: { moNumber: order.moNumber || "", customer: order.customerName || "", requestNumber: request.requestNumber, person: who },
    heading: `Material request ${request.requestNumber} for ${order.moNumber || "an order"}`,
    bodyHtml: `<p><strong>${escapeHtml(who)}</strong> asked the Store for material against <strong>${escapeHtml(order.moNumber || "")}</strong>${order.customerName ? ` (${escapeHtml(order.customerName)})` : ""}.</p><p style="margin:10px 0 0;color:#475569">${escapeHtml(request.reason || "")}</p>${request.neededBy ? `<p style="margin:6px 0 0;color:#475569">Needed by ${new Date(request.neededBy).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}.</p>` : ""}` + linesTable(request),
    details: [["Order", order.moNumber], ["Customer", order.customerName], ["Request", request.requestNumber], ["Lines", String(request.lineCount || (request.lines || []).length)], ["Raised by", who]],
    bodyText: `${who} raised ${request.requestNumber} on ${order.moNumber}: ${(request.lines || []).map((l) => `${l.rawItemName}${l.variantLabel ? ` (${l.variantLabel})` : ""} ${l.quantity} ${l.unit}`).join(", ")}. ${request.reason || ""}`,
    ctaLabel: "Open in Store", ctaUrl: `${APP_URL}/store/dashboard/order-requests/${order.moId}?tab=requests`,
  });
}

async function notifyMaterialRequestIssued(order, request, { who = "Store", issuedLines = [] } = {}) {
  if (!order || !request) return { sent: 0 };
  return notifyEvent("store_material_request_issued", {
    vars: { moNumber: order.moNumber || "", customer: order.customerName || "", requestNumber: request.requestNumber, person: who },
    heading: `Issued against ${request.requestNumber} (${order.moNumber || "order"})`,
    bodyHtml: `<p><strong>${escapeHtml(who)}</strong> issued material against <strong>${escapeHtml(request.requestNumber)}</strong> on ${escapeHtml(order.moNumber || "")}.</p>${issuedLines.length ? `<p style="margin:10px 0 0;color:#475569">This issue: ${escapeHtml(issuedLines.map((l) => `${l.rawItemName}${l.variantLabel ? ` (${l.variantLabel})` : ""} ${l.qty} ${l.unit}`).join(", "))}</p>` : ""}` + linesTable(request, { issued: true }),
    details: [["Order", order.moNumber], ["Request", request.requestNumber], ["Status", String(request.status || "").replace(/_/g, " ")], ["Issued by", who]],
    bodyText: `${who} issued against ${request.requestNumber} on ${order.moNumber}. Status: ${request.status}.`,
    ctaLabel: "Open in PPC", ctaUrl: `${APP_URL}/ppc/orders/${order.moId}?tab=materials`,
  });
}

module.exports = { notifyMaterialRequestRaised, notifyMaterialRequestIssued };
