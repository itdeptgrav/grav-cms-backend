// models/CMS_Models/Sales/paymentPlanRow.js
//
// ONE TRANCHE OF A PAYMENT PLAN, DEFINED ONCE.
//
// The customer's standing plan (Account) and the plan one deal agreed
// (Enquiry) are the same shape, because the second is a copy of the first
// taken at the moment Sales confirmed it. Two definitions would drift, and
// the day they drifted an inherited plan would stop being comparable with the
// one it came from.
//
// ── RELATIVE, ALWAYS ───────────────────────────────────────────────────────
// A row says WHICH EVENT and HOW FAR FROM IT — never a date. A date belongs
// to one order; these rows outlive every order the customer places. Dates are
// resolved per enquiry, against that order's own canonical dates, and stored
// beside the row there.
"use strict";

const mongoose = require("mongoose");
const {
  PAYMENT_DUE_EVENT_CODES,
  PAYMENT_OFFSET_DIRECTION_CODES,
} = require("../../../constants/crm");

/**
 * @param {object} [extra] additional paths (the enquiry's copy carries the
 *   resolved date; the account's does not).
 */
const paymentPlanRow = (extra = {}) => new mongoose.Schema(
  {
    /* What the customer's own document calls it — "Advance payment",
       "Final payment", "Retention". Presentation, and only presentation:
       nothing is ever parsed out of it. */
    name: { type: String, trim: true, required: true, maxlength: 80 },
    /* The share of the order value. The plan's shares add to exactly 100 —
       enforced in the service, where a refusal can say which. */
    percentage: { type: Number, required: true, min: 0.01, max: 100 },
    dueEvent: { type: String, enum: PAYMENT_DUE_EVENT_CODES, required: true },
    /* Kept apart from the days, deliberately: "before dispatch" and "on
       dispatch" are different promises and a signed offset collapses them
       the moment somebody types a zero. */
    offsetDirection: { type: String, enum: PAYMENT_OFFSET_DIRECTION_CODES, required: true, default: "ON" },
    offsetDays: { type: Number, min: 0, default: 0 },
    ...extra,
  },
  { _id: false },
);

module.exports = { paymentPlanRow };
