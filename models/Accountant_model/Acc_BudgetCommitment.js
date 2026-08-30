// models/Accountant_model/Acc_BudgetCommitment.js
//
// MONEY PROMISED BUT NOT YET SPENT.
//
// ── THE THREE FIGURES A BUDGET HEAD HAS ─────────────────────────────────────
//
//   approved   the envelope finance agreed — an allocation line
//   committed  what has been promised out of it and not yet paid  ← this file
//   actual     what has actually been posted, from real vouchers
//
// Until now a head had two of the three, so a department could have four
// purchase requests approved against a ₹50,000 head and every screen would
// still report ₹50,000 available, right up until the invoices arrived. The
// budget was correct about the past and blind to what it had already agreed to.
//
// ── WHY ITS OWN COLLECTION ──────────────────────────────────────────────────
// Not an array on Acc_Budget. A commitment belongs to the REQUEST that created
// it as much as to the line it consumes: it is created by one approval, it has
// to be findable from either side, and there will be one per approved request
// for as long as the year runs. Appending them to the budget document would
// make every budget read carry all of them and every approval a write to a
// document several other flows are also writing to.
//
// ── AND WHY IT IS NOT AN ACTUAL ─────────────────────────────────────────────
// A commitment is a promise. It reduces what is available to promise NEXT; it
// does not appear in the books, it is not a voucher, and it must never be
// added to `actual`. When the invoice is finally posted the voucher becomes
// the actual — and this commitment should stop counting, which is the release
// step this chunk deliberately does not build. See the note on `status`.

const mongoose = require("mongoose");

/**
 * `committed`   live: finance has approved the request and nothing has been
 *               posted against it yet. Counts against what is available.
 * `unbudgeted`  approved with no budget line to charge — still a promise the
 *               company has made, and finance needs to see the total of them,
 *               so it is recorded rather than dropped. It has no line to
 *               reduce, which is exactly why it must be visible.
 * `released`    replaced by something real, and no longer counts against the
 *               line. Written when the voucher for this spend is posted — the
 *               promise has become an actual — or when the request behind it
 *               is cancelled after approval.
 *
 *               A release NEVER deletes the row. The commitment stays exactly
 *               as it was written, because it is the record of a promise
 *               finance made on a date against numbers that were true then,
 *               and that does not stop being true because the invoice arrived.
 */
const STATUSES = ["committed", "unbudgeted", "released"];

const budgetCommitmentSchema = new mongoose.Schema(
  {
    /* The request that created it. Unique: one approval, one commitment, and
       the index is what makes a repeated approval idempotent rather than
       double-counted — a check in code alone races itself. */
    spendRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SpendRequest",
      required: true,
      unique: true,
      index: true,
    },
    spendRequestNumber: { type: String, trim: true },

    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", index: true },
    /* Absent on an unbudgeted commitment — there was no line to charge. */
    budgetId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Budget", index: true },
    budgetLineId: { type: mongoose.Schema.Types.ObjectId },
    financialYear: { type: String, trim: true },

    department: { type: String, trim: true },
    ledgerId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Ledger", index: true },
    ledgerName: { type: String, trim: true },

    amount: { type: Number, required: true, min: 0 },
    status: { type: String, enum: STATUSES, default: "committed", index: true },

    /* Who turned the request into a promise, and when. */
    committedBy: { type: String, trim: true },
    committedByName: { type: String, trim: true },
    committedAt: { type: Date, default: Date.now },

    /* ── WHEN THE MONEY IS EXPECTED TO LEAVE ──────────────────────────────
     * Cash-flow timing, and NOT the same thing as the request's `neededBy`.
     * `neededBy` is when the department needs the thing; this is when the
     * company expects to pay for it. A compressor needed on the 1st, on 30-day
     * terms, is an outflow on the 31st — treating the two as one would put
     * every commitment a month early in the forecast.
     *
     * Optional. Finance may not know the terms at approval, and a required
     * date would only be guessed. A commitment without one is simply not in
     * the forecast, and the forecast says how many are in that state rather
     * than quietly leaving the money out. */
    expectedPaymentDate: { type: Date },

    /* ── WHAT REPLACED IT ─────────────────────────────────────────────────
     * Set when the promise stops counting. Additive: a live commitment carries
     * none of it, and the fields are what a later reader needs to answer "why
     * is this no longer blocking the line" without guessing. */
    releasedAt: { type: Date },
    releasedBy: { type: String, trim: true },
    releasedByName: { type: String, trim: true },
    /* "voucher_posted" | "request_cancelled" */
    releaseReason: { type: String, trim: true },
    releasedByVoucherId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Voucher" },
    releasedByVoucherNumber: { type: String, trim: true },
    releasedAmount: { type: Number },

    /* What was true at the moment it was made. A commitment approved against
       ₹12,000 of headroom stays a record of that decision even after the line
       is topped up or spent down — the reason somebody said yes does not
       change retrospectively. */
    snapshot: {
      approved: { type: Number },
      committedBefore: { type: Number },
      actual: { type: Number },
      availableBefore: { type: Number },
      availableAfter: { type: Number },
    },
  },
  { timestamps: true },
);

/* The read every availability check makes: what is live against this line. */
budgetCommitmentSchema.index({ budgetLineId: 1, status: 1 });

module.exports =
  mongoose.models.Acc_BudgetCommitment ||
  mongoose.model("Acc_BudgetCommitment", budgetCommitmentSchema);
module.exports.STATUSES = STATUSES;
