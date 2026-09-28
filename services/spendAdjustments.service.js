// services/spendAdjustments.service.js
//
// THE COMMERCIAL ADJUSTMENTS ON A PURCHASE REQUEST, AND THE TOTAL THEY MAKE.
//
// ── WHY THESE LIVE ON THE REQUEST ───────────────────────────────────────────
// Shipping, a negotiated discount and charges like handling or insurance read
// like delivery arrangements. They are not: each one moves what the company
// will owe. A freight line added to a purchase order after approval changes the
// figure Finance agreed to, against a budget committed for a smaller one — so
// the order is the wrong place to decide them.
//
// Store enters them while quoting, because Store is who negotiates with the
// supplier. The requester then confirms the FULL payable figure rather than a
// line subtotal that quietly grows later, Finance approves that same figure and
// commits against it, and the purchase order carries it read-only.
//
// ── ONE PLACE, SO THE FIGURE CANNOT DISAGREE WITH ITSELF ────────────────────
// Every screen that shows a total and every step that commits money computes it
// here. A second rounding rule somewhere else is a second answer to "what do we
// owe", and the paise it differs by surfaces at a reconciliation nobody can
// settle.
"use strict";

/** Money to the paise, never accumulated in floating rupees. */
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const finite = (v) => Number.isFinite(Number(v));

/** The most a label can usefully say on a voucher line. */
const LABEL_MAX = 80;
/** More than this many separate charges is a data-entry accident. */
const MAX_CHARGES = 20;

const refuse = (message, field) => ({ ok: false, message, field });

/**
 * Read, validate and normalise what Store entered.
 *
 * ── REFUSED, NEVER QUIETLY CORRECTED ────────────────────────────────────────
 * A negative shipping charge, a blank label or a discount larger than the bill
 * are all things somebody typed on purpose and got wrong. Clamping them to zero
 * would leave a person certain they had recorded something they had not, and
 * the first anyone would know is the invoice.
 *
 * @param {object} body        what the client sent
 * @param {number} payableBefore  subtotal + tax, so a discount can be bounded
 */
function readAdjustments(body = {}, payableBefore = 0) {
  const out = { shipping: 0, discount: 0, custom: [] };

  if (body.shippingCharges !== undefined && body.shippingCharges !== null && body.shippingCharges !== "") {
    if (!finite(body.shippingCharges)) return refuse("Shipping charges must be a number.", "shippingCharges");
    const v = Number(body.shippingCharges);
    if (v < 0) return refuse("Shipping charges cannot be negative.", "shippingCharges");
    out.shipping = money(v);
  }

  if (body.discount !== undefined && body.discount !== null && body.discount !== "") {
    if (!finite(body.discount)) return refuse("The discount must be a number.", "discount");
    const v = Number(body.discount);
    if (v < 0) return refuse("The discount cannot be negative. To add a cost, use a charge.", "discount");
    out.discount = money(v);
  }

  if (body.customCharges !== undefined && body.customCharges !== null) {
    if (!Array.isArray(body.customCharges)) return refuse("Charges must be a list.", "customCharges");
    if (body.customCharges.length > MAX_CHARGES) {
      return refuse(`A request can carry at most ${MAX_CHARGES} separate charges.`, "customCharges");
    }
    for (const c of body.customCharges) {
      /* An entirely empty row is somebody who started typing and stopped — it
         is dropped. A row with an amount and no label is not: it is a cost
         nobody can explain, and Finance would be approving a blank. */
      const label = String(c?.label ?? "").trim();
      const hasAmount = c?.amount !== undefined && c?.amount !== null && c?.amount !== "";
      if (!label && !hasAmount) continue;
      if (!label) return refuse("Every charge needs a label saying what it is for.", "customCharges");
      if (label.length > LABEL_MAX) return refuse(`"${label.slice(0, 20)}…" is too long a charge label.`, "customCharges");
      if (!hasAmount || !finite(c.amount)) return refuse(`"${label}" needs an amount.`, "customCharges");
      const amount = Number(c.amount);
      if (amount < 0) return refuse(`"${label}" cannot be a negative amount.`, "customCharges");
      out.custom.push({ label, amount: money(amount) });
    }
  }

  const customTotal = money(out.custom.reduce((t, c) => t + c.amount, 0));
  const beforeDiscount = money(money(payableBefore) + out.shipping + customTotal);

  /* A discount larger than the bill is not a refund — it is a figure that would
     commit a negative amount against a budget head, which nobody can act on. */
  if (out.discount > beforeDiscount) {
    return refuse(
      `The discount of ${out.discount} is more than the ${beforeDiscount} payable before it.`,
      "discount",
    );
  }

  return { ok: true, ...out, customTotal, beforeDiscount };
}

/**
 * The figure the requester confirms, Finance approves and the budget commits.
 *
 *   line subtotal + tax + shipping + charges − discount
 *
 * Returned as a breakdown rather than one number, because every screen that
 * shows the total also has to show why it is that number.
 */
function summarise({ subtotal, taxAmount, shipping = 0, customCharges = [], discount = 0 } = {}) {
  const custom = (customCharges || []).map((c) => ({ label: String(c.label || "").trim(), amount: money(c.amount) }));
  const customTotal = money(custom.reduce((t, c) => t + c.amount, 0));
  const net = money(subtotal);
  const tax = money(taxAmount);
  return {
    subtotal: net,
    taxAmount: tax,
    shippingCharges: money(shipping),
    customCharges: custom,
    customChargesTotal: customTotal,
    discount: money(discount),
    grandTotal: money(net + tax + money(shipping) + customTotal - money(discount)),
  };
}

/**
 * Does a stored request's own grand total still follow from its parts?
 *
 * ── WHY THIS IS CHECKED AGAIN DOWNSTREAM ────────────────────────────────────
 * `grandTotal` is stored, and a stored derived figure can go stale: a line
 * edited by a path that forgot to recompute, a partial write, a migration. It
 * is what the budget commitment was made for and what the allocator splits, so
 * trusting it silently means committing to a number nobody can reproduce.
 * Checked rather than recomputed, because quietly substituting a different
 * total would hide exactly the inconsistency worth knowing about.
 */
function reconciles(request, tolerance = 0.005) {
  const lines = request.items || [];
  const subtotal = money(lines.reduce((t, l) => t + (Number(l.amount) || 0), 0));
  const taxAmount = money(lines.reduce((t, l) => t + (Number(l.taxAmount) || 0), 0));
  const expected = summarise({
    subtotal,
    taxAmount,
    shipping: request.approvedShippingCharges,
    customCharges: request.approvedCustomCharges,
    discount: request.approvedDiscount,
  });
  const stored = money(request.grandTotal);
  return {
    ok: Math.abs(stored - expected.grandTotal) <= tolerance,
    stored,
    expected: expected.grandTotal,
    breakdown: expected,
  };
}

module.exports = {
  readAdjustments, summarise, reconciles,
  money, LABEL_MAX, MAX_CHARGES,
};
