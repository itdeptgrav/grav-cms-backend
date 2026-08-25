// services/commercialLadder.js
//
// One commercial fact, restated as a journey advances.
//
// A deal's value is claimed four times, by four different people, with four
// different amounts of evidence behind it:
//
//   1. LEAD        researched, before anyone was asked. "About 4,800 pcs a
//                  year, ~₹36L" — with a confidence (assumed → researched →
//                  contact-confirmed → document-confirmed) and a stated source.
//   2. ENQUIRY     indicative, once the requirement is known. Quantity now comes
//                  from real product rows; price is a rough range we usually
//                  make this for. Still subject to sampling and costing.
//   3. QUOTE       costed and quotable. The first number that could be held to.
//   4. ORDER       what was actually ordered, and eventually invoiced.
//
// Each of those already existed somewhere. What did not exist was any way to
// see them TOGETHER, so nobody could answer the question the sequence is for:
// did the deal grow or shrink as we learned about it, and was the original
// research any good? A salesperson who researches carefully and a salesperson
// who guesses looked identical the moment conversion happened.
//
// WHAT THIS IS NOT: a forecast, and not a correction. A rung is never rewritten
// by a later one — the Lead's figure stays exactly what was believed then, and
// the drift between rungs is the point rather than an error to fix.
//
// Pure and dependency-free: it is handed records, it returns rungs. Nothing is
// fetched here and nothing is written.

"use strict";

/** Ordered worst-to-best evidence. Used to rank, never to reject. */
const CONFIDENCE_RANK = { assumed: 1, researched: 2, contact_confirmed: 3, document_confirmed: 4 };
const CONFIDENCE_LABEL = {
  assumed: "Assumed",
  researched: "Researched",
  contact_confirmed: "Confirmed by the contact",
  document_confirmed: "Confirmed by a document",
};

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const sum = (list, pick) => {
  const vals = (list || []).map(pick).filter((v) => num(v) !== null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
};

/**
 * Build the rungs for one journey.
 *
 * Every argument is optional — a journey sitting at Enquiry has no quote and no
 * order, and the ladder says so by marking those rungs `reached: false` rather
 * than omitting them. Showing the whole ladder greyed is what makes it read as
 * a sequence; showing only what exists reads as a list of unrelated numbers.
 *
 * @param {object}  p
 * @param {object} [p.enquiry]   lean Enquiry — carries `leadEstimate`, products, price range
 * @param {number} [p.quotedTotal]  the costed/quoted whole-deal value, when one exists
 * @param {object} [p.order]     lean CustomerRequest — grandTotal / totalPaidAmount
 * @returns {{rungs: Array, currency: string, drift: object|null}}
 */
function buildCommercialLadder({ enquiry = null, quotedTotal = null, order = null } = {}) {
  const currency = enquiry?.pricingCurrency || "INR";
  const le = enquiry?.leadEstimate || null;

  // ── 1. Lead ───────────────────────────────────────────────────────────────
  const leadValue = num(le?.annualRevenue);
  const lead = {
    key: "lead",
    label: "Researched at Lead",
    reached: Boolean(le),
    value: leadValue,
    quantity: num(le?.annualQuantity),
    unitPrice: num(le?.unitPrice),
    confidence: le?.annualRevenueConfidence || le?.unitPriceConfidence || null,
    confidenceLabel: CONFIDENCE_LABEL[le?.annualRevenueConfidence || le?.unitPriceConfidence] || null,
    basis: le?.annualRevenueSource || le?.annualQuantitySource || null,
    at: le?.capturedAt || null,
    note: le
      ? "What was believed before anyone was asked. Frozen at conversion."
      : "This enquiry did not come from a Lead, so there is no earlier estimate.",
  };

  // ── 2. Enquiry ────────────────────────────────────────────────────────────
  // Quantity is now real product rows rather than an annual guess, and the
  // price is a range. The midpoint is used so the rung has one comparable
  // number; the range itself is carried alongside so nothing is hidden.
  const qty = sum(enquiry?.products, (p) => p?.quantity);
  const lo = num(enquiry?.estimatedPriceMin);
  const hi = num(enquiry?.estimatedPriceMax);
  const mid = lo !== null && hi !== null ? (lo + hi) / 2 : (lo ?? hi);
  const enquiryValue = num(enquiry?.opportunitySize) ?? (qty !== null && mid !== null ? Math.round(qty * mid) : null);
  const enquiryRung = {
    key: "enquiry",
    label: "Indicative at Enquiry",
    reached: Boolean(enquiry) && (enquiryValue !== null || qty !== null),
    value: enquiryValue,
    quantity: qty,
    unitPrice: mid,
    unitPriceRange: lo !== null || hi !== null ? { min: lo, max: hi } : null,
    confidence: null,
    confidenceLabel: "Indicative",
    basis: qty !== null ? "Quantity from the enquiry's product rows" : null,
    at: enquiry?.updatedAt || enquiry?.createdAt || null,
    note: "Subject to sampling and final costing.",
  };

  // ── 3. Quote ──────────────────────────────────────────────────────────────
  const quote = {
    key: "quote",
    label: "Quoted",
    reached: num(quotedTotal) !== null,
    value: num(quotedTotal),
    quantity: qty,
    unitPrice: num(quotedTotal) !== null && qty ? num(quotedTotal) / qty : null,
    confidence: null,
    confidenceLabel: "Costed",
    basis: "Built from the costing sheet",
    at: null,
    note: "The first number that could be held to.",
  };

  // ── 4. Order ──────────────────────────────────────────────────────────────
  const ordered = num(order?.grandTotal);
  const orderRung = {
    key: "order",
    label: "Ordered",
    reached: ordered !== null,
    value: ordered,
    quantity: null,
    unitPrice: null,
    confidence: null,
    confidenceLabel: "Actual",
    basis: order?.requestId ? `Order ${order.requestId}` : null,
    at: order?.updatedAt || null,
    note: num(order?.totalPaidAmount) ? `${order.totalPaidAmount} received so far.` : "Nothing received yet.",
  };

  const rungs = [lead, enquiryRung, quote, orderRung];

  // ── Drift ─────────────────────────────────────────────────────────────────
  // First to last, of the rungs actually reached. This is the whole reason to
  // draw the ladder: a deal that halved between research and order is a
  // different story from one that doubled, and neither is visible from any
  // single rung.
  const hit = rungs.filter((r) => r.reached && r.value !== null);
  const drift = hit.length >= 2
    ? (() => {
        const from = hit[0];
        const to = hit[hit.length - 1];
        return {
          fromKey: from.key,
          toKey: to.key,
          from: from.value,
          to: to.value,
          delta: to.value - from.value,
          // Guarded: a zero baseline has no percentage, and reporting Infinity
          // would be worse than reporting nothing.
          percent: from.value ? Math.round(((to.value - from.value) / from.value) * 100) : null,
        };
      })()
    : null;

  return { rungs, currency, drift };
}

module.exports = { buildCommercialLadder, CONFIDENCE_RANK, CONFIDENCE_LABEL };
