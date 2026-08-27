// models/Accountant_model/Acc_RecurringItem.js
//
// THE RECURRING-ITEMS REGISTER — predictable FUTURE cash movements.
//
// C0-E's whole job. Payroll, rent, EMI, utilities and statutory dues are the
// cash movements a business already knows are coming but which exist nowhere
// in the books until someone posts them. An open-item due date (C0-F) can
// only ever tell you about money already invoiced; a forecast built from
// those alone would show a company with no salary bill and no rent. This
// collection is where the other half lives.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
// It is NOT `Acc_CashFlowAdjustment`. That collection holds manual rows an
// accountant adds to explain HISTORICAL cash on the Cash Flow report, is
// scoped by `organizationId`, carries SIGNED amounts, and runs an approval
// lifecycle. This one describes the FUTURE, is scoped by `companyId` like the
// rest of C0, keeps amounts as unsigned magnitudes with `direction` carrying
// the sign, and has no approval flow. The two never read each other. They
// were checked for overlap before this model was added, and there is none.
//
// It is also NOT a voucher generator. Nothing here posts, schedules a
// posting, or writes `Acc_Voucher`. A row is a STATEMENT OF INTENT that a
// later forecast engine (Chunk 1, deliberately not started) will read to
// project cash. Turning a projection into a real posting is a human act
// through the normal voucher screens, and stays that way.
//
// ── nextDueDate VS dayOfMonth/dayOfWeek — BOTH, ON PURPOSE ──────────────────
// These look redundant (you could read "the 5th" off a nextDueDate of
// 2026-09-05) but they answer different questions, and collapsing them loses
// real information:
//
//   · `nextDueDate` is the NEXT OCCURRENCE — a concrete instance, which a
//     forecast reads directly and which can legitimately sit off-cycle (a
//     pro-rated first month, a payment deferred by agreement).
//   · `dayOfMonth`/`dayOfWeek` is the RECURRENCE RULE — the intent for every
//     occurrence after the next one.
//
// The case that proves they must be separate is month-end. "Rent on the last
// day" is dayOfMonth 31, and a projector that clamps it correctly yields
// 31 Jan → 28 Feb → 31 Mar. A projector deriving the rule from a nextDueDate
// that has already been clamped once to 28 Feb would emit the 28th forever
// after — the classic recurring-date drift bug, silently wrong and very hard
// to spot in a forecast. The rule is stored so it can never be lost that way.
//
// They are deliberately NOT cross-validated against each other; see
// services/recurringItems.service.js for why an off-cycle first occurrence is
// legitimate rather than a typo to reject.

const mongoose = require("mongoose");

const accRecurringItemSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      required: true,
      index: true,
    },

    name: { type: String, required: true, trim: true },

    type: {
      type: String,
      enum: ["payroll", "rent", "emi", "utility", "statutory", "other"],
      required: true,
    },

    // Which way the cash moves. `amount` below is an unsigned magnitude, so
    // this field is the ONLY thing carrying the sign — a reader that ignores
    // it turns every outflow into an inflow, which is why it is required
    // rather than defaulted to something plausible.
    direction: {
      type: String,
      enum: ["inflow", "outflow"],
      required: true,
    },

    // Optional link to the ledger this movement will hit. Optional because a
    // recurring item is useful before anyone has decided its posting account
    // — "we pay ~₹8L of salaries on the 1st" is forecastable without knowing
    // which expense ledger it lands in. `ledgerName` is denormalised for
    // display so the register lists without an N+1 lookup; it is a snapshot,
    // not a source of truth, and the id is what any real join should use.
    ledgerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Ledger",
      default: null,
    },
    ledgerName: { type: String, trim: true, default: null },

    // Unsigned magnitude — see `direction`. Positive, never zero: a recurring
    // movement of nothing is not a schedule, it is an empty row, and letting
    // one in would quietly add a no-op line to every future forecast.
    amount: { type: Number, required: true, min: 0 },

    frequency: {
      type: String,
      enum: ["monthly", "weekly", "quarterly", "yearly"],
      required: true,
    },

    // The recurrence RULE — see the header note on why this coexists with
    // `nextDueDate`. 1..31; 29/30/31 mean "that day, clamped to the month's
    // length", which is how "last day of the month" is expressed.
    dayOfMonth: { type: Number, default: null, min: 1, max: 31 },

    // 0 = Sunday … 6 = Saturday. NOTE that 0 is a REAL, meaningful value
    // here, unlike `creditPeriodDays`/`defaultCreditDays` elsewhere in C0
    // where 0 means "unset". Any reader doing `if (!dayOfWeek)` silently
    // turns every Sunday schedule into a missing one.
    dayOfWeek: { type: Number, default: null, min: 0, max: 6 },

    // The next occurrence. Required — an item that cannot say when it next
    // happens cannot be forecast, and a register full of undated intentions
    // is exactly the "looks authoritative while being invented" failure this
    // document's credit-terms rules exist to prevent.
    nextDueDate: { type: Date, required: true },

    startDate: { type: Date, required: true },
    endDate: { type: Date, default: null },

    status: {
      type: String,
      enum: ["active", "paused", "ended"],
      default: "active",
    },

    // How this row came to exist. Server-controlled, never read from a
    // request body — a client that could set `seeded_from_history` on
    // something a person typed by hand would be claiming an origin the data
    // does not have, the same provenance lie `creditTermsSource` is
    // protected against in creditTerms.service.js. C0-E only ever writes
    // "manual"; the seeding path the other value names is a later slice.
    source: {
      type: String,
      enum: ["manual", "seeded_from_history"],
      default: "manual",
    },

    notes: { type: String, trim: true, default: "" },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Department" },
    createdByName: { type: String, trim: true, default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Department" },
    updatedByName: { type: String, trim: true, default: null },
  },
  { timestamps: true, collection: "acc_recurring_items" },
);

// The forecast's own read: "what is due, for this company, between now and
// the horizon" — company + status + date, in that order, so the index serves
// both the equality prefix and the range scan on the tail.
accRecurringItemSchema.index({ companyId: 1, status: 1, nextDueDate: 1 });

// The register screen's read: "this company's payroll items", and the
// grouping a forecast uses to explain a projected figure by category.
accRecurringItemSchema.index({ companyId: 1, type: 1, status: 1 });

module.exports = mongoose.model("Acc_RecurringItem", accRecurringItemSchema);
