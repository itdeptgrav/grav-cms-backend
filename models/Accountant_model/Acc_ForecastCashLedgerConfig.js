// models/Accountant_model/Acc_ForecastCashLedgerConfig.js
//
// CHUNK 1-D — which ledgers count as OPERATING CASH for the cash-flow forecast.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// Until now the forecast's opening cash was every ledger under the
// "Cash-in-Hand", "Bank Accounts" and "Bank OD A/c" groups, automatically.
// On real data that swept in three accounts that are not company operating
// cash at all — two personal bank accounts and a personal cash account
// belonging to an officer of the company — and would sweep in overdraft
// accounts too. An overstated opening balance is the most dangerous kind of
// forecast error: every downstream day inherits it, and it looks like cash
// the business does not have.
//
// Which accounts are genuinely spendable operating cash is a FINANCE
// JUDGEMENT, not something a name heuristic can settle. So this collection
// records that judgement explicitly, per company, and the forecast reads it.
// The heuristics in the service only ever produce a SUGGESTION for an
// unsaved company; they never decide.
//
// ── THREE ROLES, DELIBERATELY SEPARATE ──────────────────────────────────────
//   · included — spendable operating cash. Summed into opening cash.
//   · excluded — a cash/bank-shaped ledger that is NOT operating cash
//                (personal accounts, escrow, accounts held for someone else).
//                Recorded rather than merely absent, so the decision is
//                visible and auditable later: "nobody considered this" and
//                "finance looked at this and said no" must not look the same.
//   · od       — overdraft / borrowing headroom. Kept apart from cash on
//                purpose. An OD balance is money OWED, and netting it into
//                "cash on hand" either overstates cash (if the sign is
//                mishandled) or hides available headroom. Reported
//                separately; never added to opening cash.
//
// This model stores CHOICES, never balances. Balances are always recomputed
// from posted vouchers at read time — a cached cash figure that can drift is
// exactly what the rest of this module refuses to keep.

const mongoose = require("mongoose");

const forecastCashLedgerConfigSchema = new mongoose.Schema(
  {
    // Unique per company: one company has exactly one answer to "what counts
    // as our cash", and two competing configs would make the forecast depend
    // on which one happened to be read.
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      required: true,
      unique: true,
      index: true,
    },

    includedLedgerIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Acc_Ledger" }],
    excludedLedgerIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Acc_Ledger" }],
    odLedgerIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Acc_Ledger" }],

    // Why this selection. Free text, and worth having: "excluded the CEO's
    // personal accounts" is the sort of decision someone will need explained
    // to them a year later.
    notes: { type: String, trim: true, default: "" },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Department", default: null },
    updatedByName: { type: String, trim: true, default: null },
  },
  { timestamps: true, collection: "acc_forecast_cash_ledger_config" },
);

module.exports = mongoose.model(
  "Acc_ForecastCashLedgerConfig",
  forecastCashLedgerConfigSchema,
);
