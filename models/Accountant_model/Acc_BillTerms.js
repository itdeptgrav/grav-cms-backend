// models/Accountant_model/Acc_BillTerms.js
//
// The sidecar that gives historical open bills a due date without ever
// touching the voucher they came from.
//
// ── WHY A SIDECAR, NOT A WRITE ONTO Acc_Voucher ─────────────────────────────
// `dueDate` is not a financial field — writing it changes no debit, credit,
// amount or trial-balance figure, which makes it *tempting* to backfill
// straight onto the posted voucher. That should still never happen:
//
//   1. A bulk script writing to hundreds of posted vouchers bypasses the
//      approval trail this module deliberately builds around posted
//      records. The precedent is worse than the benefit.
//   2. `updatedAt` would move on every touched voucher at once, corrupting
//      any audit reading of "what changed recently".
//   3. A DERIVED date written into the same field as a STATED one becomes
//      indistinguishable from fact the moment it lands. This collection
//      keeps "we inferred this" and "the document says this" permanently
//      separable.
//   4. Rollback of a sidecar is `deleteMany({ backfillRunId })`. Rollback of
//      an in-place mutation across hundreds of posted vouchers is a restore
//      from backup.
//
// See docs/tasks/accountant-cash-flow-forecast.md §C1.6 for the full
// argument. This model is the ONLY write target C0-F's backfill is allowed
// to touch — `Acc_Voucher` and `billAllocations` stay exactly as they were.
//
// ── THE KEY ──────────────────────────────────────────────────────────────
// A bill is an aggregate, not a document — it can span however many vouchers
// carry the same `billName` under one ledger (see openItems.service.js's own
// definition of "open item"). A due date therefore belongs to the BILL, keyed
// `(companyId, ledgerId, billName)`, not to any one voucher.
//
// ── READ PRECEDENCE (established, not built here) ───────────────────────────
// `billAllocations[].dueDate` → `Acc_Voucher.dueDate` → THIS collection →
// derive on the fly → none. A row here is what a reader falls back to only
// once the document itself has nothing to say.

const mongoose = require("mongoose");

const accBillTermsSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      required: true,
      index: true,
    },
    ledgerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Ledger",
      required: true,
      index: true,
    },
    // Matches `ledgerEntries[].billAllocations[].billName` on the vouchers
    // that make up this bill. Not a foreign key — bill names are free text
    // carried over from Tally/manual entry, same as everywhere else this
    // codebase groups by billName.
    billName: { type: String, required: true, trim: true },

    dueDate: { type: Date, required: true },

    // Where this date came from. "manual" is reserved for a future
    // human-override feature — C0-F's backfill never writes it, but the
    // schema declares it now so that feature does not need a migration
    // later. See `isManual` below, which is what actually protects a row
    // from being silently overwritten by a re-run.
    source: {
      type: String,
      enum: ["party_terms", "company_default", "manual"],
      required: true,
    },

    // The credit-period figure actually used to derive `dueDate` — the
    // party's own term, or the company default, whichever `source` names.
    // Always a positive integer; there is no "0 means unset" reading here,
    // because a row with no usable days never gets written in the first
    // place (see services/billTermsBackfillPlanner.service.js).
    creditDaysUsed: { type: Number, required: true, min: 1 },

    // The date the derivation started from — the bill's earliest voucher
    // date, per openItems.service.js's `firstVoucherDate`. Kept so a reader
    // (or a person reviewing the backfill) can see the arithmetic:
    // dueDate = basisDate + creditDaysUsed days.
    basisDate: { type: Date, required: true },

    // Which backfill run produced this row — the whole mechanism rollback
    // depends on. Absent (null) for a manually-created row, since a manual
    // override was never "a run".
    backfillRunId: { type: mongoose.Schema.Types.ObjectId, index: true, default: null },

    // Set once, by a human, on a row a future manual-override feature
    // creates or takes over. A backfill re-run must never touch a row where
    // this is true — see the apply route, which enforces this at write time
    // rather than merely documenting it here.
    isManual: { type: Boolean, default: false },

    /* ── CHUNK 1-C — FORECAST EXPECTED DATE ──────────────────────────────
       When someone actually expects an ALREADY-OVERDUE bill to settle.

       ── THIS IS NOT A DUE DATE, AND MUST NEVER BE READ AS ONE ────────────
       `dueDate` above is the contractual/accounting date: when the money was
       owed. This field is a forecasting ASSUMPTION about when it will really
       move, and it exists only because the two genuinely differ once a bill
       is late. They are deliberately separate fields rather than one field
       with a flag, so that no reader — a report, an ageing bucket, a future
       chunk — can accidentally treat a collection guess as a contractual
       term. Nothing outside the cash-flow forecast reads these.

       Set only by a human, only through
       `PATCH /api/accountant/bill-terms/forecast-expected-date`, and only
       ever on a bill that is already overdue. There is no derivation, no
       default and no backfill for it: predicting collection timing is the
       behavioural model that Chunk 1-C explicitly does NOT build. Absent
       (null) means "nobody has said", and such a bill stays OUT of the
       forecast rather than being assumed to arrive. */
    forecastExpectedDate: { type: Date, default: null },
    // Always "manual" when set — declared as an enum so a later derived
    // source has somewhere to go without a migration, and so a null here is
    // unambiguously "no expectation recorded".
    forecastExpectedDateSource: {
      type: String,
      enum: ["manual", null],
      default: null,
    },
    forecastExpectedDateNotes: { type: String, trim: true, default: "" },
    forecastExpectedDateUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Department",
      default: null,
    },
    forecastExpectedDateUpdatedByName: { type: String, trim: true, default: null },
    forecastExpectedDateUpdatedAt: { type: Date, default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Department" },
    createdByName: { type: String, trim: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Department" },
    updatedByName: { type: String, trim: true },
  },
  { timestamps: true, collection: "acc_bill_terms" },
);

// The one constraint this whole model exists to enforce: at most one due
// date per bill. A backfill re-run resolves to this same key and upserts —
// it can update the row, it can never duplicate it.
accBillTermsSchema.index(
  { companyId: 1, ledgerId: 1, billName: 1 },
  { unique: true },
);

module.exports = mongoose.model("Acc_BillTerms", accBillTermsSchema);
