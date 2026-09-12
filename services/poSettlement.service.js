// services/poSettlement.service.js
//
// When is a purchase order fully billed, and when is it fully paid?
//
// ── THE SYMPTOM ─────────────────────────────────────────────────────────────
// A PO reads "✓ Fully billed" on the accounts page and "pending" on the store
// page, with a card underneath saying "LEFT TO BILL ₹0.32 — 100% billed". All
// three are produced from the same data by three different rules.
//
// ── THE THREE CAUSES ────────────────────────────────────────────────────────
// 1. PO totals carry sub-paisa fractions. PO26091239 is stored as ₹12,006.323
//    — quantity × rate, never rounded. 24 of 101 POs are like this. A bill can
//    never equal that number, because no bill can be raised for a third of a
//    paisa.
//
// 2. The status and the residual disagreed with each other. "Fully billed" was
//    decided with a 1% tolerance while "left to bill" was computed exactly, so
//    the same response said a PO was complete and still owed ₹0.32.
//
// 3. A percentage tolerance is the wrong shape. The gap being forgiven here is
//    ROUNDING — a bill written to the rupee against a total carrying paise, at
//    most a rupee or so per bill. 1% of a ₹10 lakh PO is ₹10,000, and treating
//    that as "fully billed" would hide real unbilled money. Measured on this
//    database: 22 of 46 billed POs have a residual, and they come to ₹4.06 in
//    total. Every one is under a rupee. A rupee per bill is the honest
//    tolerance; a percentage is not.
//
// So money is rounded to paise before anything is compared, the tolerance is
// absolute and scales with the number of bills rather than the value, and one
// function answers the question everywhere.
//
// ── WHAT IT DELIBERATELY DOES NOT HIDE ──────────────────────────────────────
// Over-billing. `remainingToBill` used to be Math.max(total - billed, 0), so a
// PO billed ₹697 against a ₹508.20 order — a real one in this database, 37%
// over — reported nothing left to bill and no problem. Over-billing is now its
// own field, because a vendor invoicing more than was ordered is exactly the
// thing an accounts page exists to notice.

"use strict";

/** Money, to the paisa. The only rounding this module does. */
const paise = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * How much difference is rounding rather than a shortfall.
 *
 * One rupee per document, because each bill is independently rounded to the
 * rupee, plus one for the order's own sub-paisa total. Two bills can therefore
 * be out by two rupees for reasons nobody needs to look into; three hundred
 * cannot, whatever the order is worth.
 */
function roundingTolerance(documentCount = 1) {
  return 1 + Math.max(0, Number(documentCount) || 0);
}

/**
 * Billing and payment position of one purchase order.
 *
 * @param {object} po        { totalAmount }
 * @param {object} actuals   { billedAmount, billCount, paidAmount, paymentCount, pendingAmount }
 */
function settlementOf(po, actuals = {}) {
  const total = paise(po?.totalAmount);
  const billed = paise(actuals.billedAmount);
  const paid = paise(actuals.paidAmount);
  const billTol = roundingTolerance(actuals.billCount || 1);
  const payTol = roundingTolerance(actuals.paymentCount || 1);

  const billGap = paise(total - billed);
  const payGap = paise(total - paid);

  const billingStatus =
    billed <= 0
      ? "NOT_BILLED"
      : billGap <= billTol
        ? "FULLY_BILLED"
        : "PARTIALLY_BILLED";

  const paymentStatus =
    paid <= 0 ? "PENDING" : payGap <= payTol ? "COMPLETED" : "PARTIAL";

  return {
    totalAmount: total,
    billedAmount: billed,
    paidAmount: paid,
    billingStatus,
    paymentStatusComputed: paymentStatus,
    /* Zero once the difference is rounding — the status and the residual are
       two statements of one fact and must never contradict each other. */
    remainingToBill: billingStatus === "FULLY_BILLED" ? 0 : Math.max(billGap, 0),
    remainingToPay: paymentStatus === "COMPLETED" ? 0 : Math.max(payGap, 0),
    /* Surfaced, not clamped away. */
    overBilledBy: billGap < -billTol ? paise(-billGap) : 0,
    overPaidBy: payGap < -payTol ? paise(-payGap) : 0,
    pendingBillAmount: paise(actuals.pendingAmount),
    voucherCount: actuals.billCount || 0,
    paymentCount: actuals.paymentCount || 0,
  };
}

/** True when the PO's STORED paymentStatus disagrees with the vouchers. */
function paymentStatusIsStale(po, computed) {
  return String(po?.paymentStatus || "PENDING") !== computed;
}

module.exports = {
  paise,
  roundingTolerance,
  settlementOf,
  paymentStatusIsStale,
};
