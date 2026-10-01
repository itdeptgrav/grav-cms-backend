// services/sales/deliveryDeadlineGate.js
//
// NO ORDER LEAVES SALES WITHOUT THE CUSTOMER'S DELIVERY DEADLINE (26 Sep 2026).
//
// Every department plans against `customerInfo.deliveryDeadline` — PPC's
// targets, the "behind / at risk" verdicts, the department queues' due
// ordering — and half the orders on the board had none, so those screens
// honestly said "Not set" and nothing could be planned against them. The
// request form never required it, and none of the four doors that turn a
// request into production (quotation sales-approve, approve-on-behalf,
// mark-internal-order, a sample style's production run) checked.
//
// This is the one check they all make. The caller may hand the date in the
// body (`deliveryDeadline`, or `customerInfoOverride.deliveryDeadline` on the
// on-behalf door) and it is recorded on the request first; only a request
// that STILL has none is refused, with a code the UI can act on.

"use strict";

const CODE = "DELIVERY_DEADLINE_REQUIRED";

/** A date from the body, or null when absent; NaN-safe. */
function parseDate(v) {
  if (v === undefined || v === null || v === "") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Record a deadline handed in the body onto `request.customerInfo`, then
 * insist one exists. Returns `null` when the request may proceed, or a
 * `{ status, body }` refusal for the route to send.
 */
function requireDeliveryDeadline(request, body = {}) {
  const handed = parseDate(body?.deliveryDeadline ?? body?.customerInfoOverride?.deliveryDeadline);
  if (handed) {
    if (!request.customerInfo) request.customerInfo = {};
    request.customerInfo.deliveryDeadline = handed;
    if (typeof request.markModified === "function") request.markModified("customerInfo");
  }
  const has = parseDate(request.customerInfo?.deliveryDeadline);
  if (has) return null;
  return {
    status: 400,
    body: {
      success: false,
      code: CODE,
      message: "Set the customer's delivery deadline before this order goes to production — every department plans against it. Send it as deliveryDeadline, or set it on the request first.",
    },
  };
}

module.exports = { requireDeliveryDeadline, parseDate, CODE };
