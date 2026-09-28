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
/* ── AND THE ONE B3B ADDED ──────────────────────────────────────────────────
 * `partially_released`: some of this promise has been billed and the rest has
 * not. The state did not exist, so a bill for one line of a four-line request
 * had only two options — leave the whole thing live, or release all of it —
 * and it released all of it, freeing budget on three heads nothing had been
 * billed against. A document is `released` only when every allocation has
 * nothing left. */
const STATUSES = ["committed", "unbudgeted", "partially_released", "released"];

/* ── ONE ROW PER APPROVED REQUEST LINE ──────────────────────────────────────
 * A request buys fabric from Raw Materials, packaging from Packaging and a
 * repair from Repairs & Maintenance. Forcing all three into one head was the
 * only thing this document could express, so finance either split the request
 * or charged two of the three to a head they do not belong to — and the budget
 * report then said something untrue about all three.
 *
 * ── AND WHY THIS IS AN ARRAY, NOT THREE DOCUMENTS ───────────────────────────
 * One approval is one promise. `spendRequestId` is unique precisely so a
 * repeated approval cannot double-count, and one commitment per LINE would
 * hand that guarantee back — three documents, three chances to write a fourth.
 * The allocations live inside the one document the uniqueness protects.
 *
 * Additive: a commitment written before this has no `allocations` at all, and
 * `committedByLine` reads such a row through its top-level `amount` exactly as
 * it always did. Absence is the legacy signal, so there is NO default — a
 * default `[]` would make every historical commitment look line-wise with
 * nothing in it, and it would then contribute zero to its own head.
 */
const allocationSchema = new mongoose.Schema(
  {
    /* The request line this row is the promise for. */
    spendLineId: { type: mongoose.Schema.Types.ObjectId, required: true },
    /* Readable without a join. A commitment is read by whoever reconciles,
       months later, when the request may have been edited around it. */
    name: { type: String, trim: true },
    /* Whichever the line was. Both optional: a free-typed line has neither. */
    itemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem" },
    itemSku: { type: String, trim: true },
    serviceId: { type: mongoose.Schema.Types.ObjectId, ref: "Service" },
    serviceCode: { type: String, trim: true },

    /* Absent on an unbudgeted allocation — there is no line to charge. */
    budgetId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Budget" },
    budgetLineId: { type: mongoose.Schema.Types.ObjectId },
    financialYear: { type: String, trim: true },
    ledgerId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Ledger" },
    ledgerName: { type: String, trim: true },

    amount: { type: Number, required: true, min: 0 },
    /* The header discount/freight/round-off share this line absorbed. Kept so
       "why is this line committing less than it was quoted" has an answer. */
    adjustment: { type: Number, default: 0 },

    /* `committed` reduces its head; `unbudgeted` reduces nothing and is still
       a promise finance has to be able to total.

       ── AND THE TWO B3B ADDED ────────────────────────────────────────────
       `partially_released` is the state that did not exist and had to: a bill
       for one line of a four-line request used to release the WHOLE
       commitment, freeing budget on three heads nothing had been billed
       against. `released` is the end of that road, per allocation. */
    status: {
      type: String,
      enum: ["committed", "unbudgeted", "partially_released", "released"],
      required: true,
    },

    /* ── WHAT WAS RESERVED STAYS WHAT WAS RESERVED ───────────────────────
       `amount` above is the approved figure and is NEVER rewritten by a
       release: it is the record of what finance agreed, on a date, against
       numbers that were true then. Releasing subtracts into its own field, so
       "what was promised" and "what is still promised" remain two separate
       questions with two separate answers. */
    releasedAmount: { type: Number, default: 0, min: 0 },
    /* Derived and stored, because the availability aggregation sums it inside
       a pipeline and cannot compute `amount - releasedAmount` per row without
       a second stage on every budget read. */
    remainingAmount: { type: Number, min: 0 },

    /* ── ONE ROW PER VOUCHER LINE THAT DISCHARGED PART OF THIS ───────────
       Append-only. A cancellation removes the rows THAT voucher wrote and
       nothing else — which is the whole reason they carry the voucher id
       rather than a running total. Without them, cancelling one of two bills
       would restore the other one's release too. */
    releases: {
      type: [new mongoose.Schema({
        voucherId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Voucher", required: true },
        voucherNumber: { type: String, trim: true },
        /* The voucher's own line. Kept for a single-line discharge, and the
           FIRST of `contributions` when several lines mapped here. */
        voucherLineId: { type: mongoose.Schema.Types.ObjectId },
        /* ── EVERY LINE THAT CONTRIBUTED, WITH ITS SHARE ──────────────────
           Several bill lines can map to one request line — two deliveries of
           the same fabric on one invoice. Storing only the first left the
           other lines with no audit evidence at all, and a cancellation could
           not say which contributions it was reversing. */
        contributions: {
          type: [new mongoose.Schema({
            voucherLineId: { type: mongoose.Schema.Types.ObjectId },
            amount: { type: Number, required: true, min: 0 },
          }, { _id: false })],
          default: undefined,
        },
        amount: { type: Number, required: true, min: 0 },
        at: { type: Date, default: Date.now },
        by: { type: String, trim: true },
        byName: { type: String, trim: true },
      }, { _id: false })],
      default: undefined,
    },

    /* Which rule produced this head — see budgetAllocationVocabulary. */
    resolutionSource: { type: String, trim: true },
    /* Required by the ROUTE where a person overrode a configured default, not
       by the schema: a line that simply took its default has no reason to
       give, and a mandatory field would produce "n/a" on most rows. */
    resolutionReason: { type: String, trim: true, default: "" },
    selectedByName: { type: String, trim: true, default: "" },
    selectedAt: { type: Date },

    /* What was true about THIS head when the promise was made. The top-level
       snapshot could only ever describe one of them. */
    snapshot: {
      approved: { type: Number },
      committedBefore: { type: Number },
      actual: { type: Number },
      availableBefore: { type: Number },
      availableAfter: { type: Number },
    },
  },
  { _id: false },
);

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

    /* ── THE LINE-WISE SPLIT ────────────────────────────────────────────
       One row per approved line. `undefined` on every commitment written
       before this existed, and that absence is load-bearing: it is what tells
       the availability calculation to read the top-level `amount` instead.
       See the note on `allocationSchema`. */
    allocations: { type: [allocationSchema], default: undefined },

    /* ── AND WHICH SHAPE THIS DOCUMENT IS ───────────────────────────────
       `single_head` keeps the top-level ledger/budget fields populated, as
       every commitment always has. `line_wise` does NOT invent a primary
       head: with three heads on one request, naming one of them at the top
       would be a figure every report reads and no human chose. Those fields
       are left absent, and `headCount` says how many there really are. */
    allocationMode: { type: String, enum: ["single_head", "line_wise"] },
    headCount: { type: Number, min: 0 },

    /* ── WHEN THE RELEASE COULD NOT BE WORKED OUT ────────────────────────
       A posted voucher whose lines carry no request-line identity cannot say
       which allocation it discharges. The posting still stands — it is the
       actual, and refusing it would be worse — but the commitment stays live
       and says why, rather than being released on a guess or silently left
       looking correct. Cleared the moment a later voucher does map. */
    reconciliationWarning: { type: String, trim: true, default: undefined },

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
module.exports.ALLOCATION_MODES = ["single_head", "line_wise"];
module.exports.ALLOCATION_STATUSES =
  ["committed", "unbudgeted", "partially_released", "released"];
