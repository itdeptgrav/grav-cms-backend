// models/Accountant_model/Acc_PayrollBridge.js
//
// How a payroll run becomes ledger lines, and which runs were posted by hand.
//
// ── WHY A MAP AND NOT A RULE IN CODE ────────────────────────────────────────
// Every payroll run was posting its whole salary expense to one ledger
// ("Salaries (Office Staff)"), because that is the only thing code can guess.
// Accounts actually wants Production wages in one head and office salaries in
// another — and the split is knowable: every payroll item already carries the
// employee's `department`. What was missing was the half only Accounts can
// answer: which ledger each department belongs in. That answer is data, so it
// lives here, once per company, instead of being re-typed into a voucher every
// month.
//
// ── ONE LEDGER PER DEPARTMENT, MANY DEPARTMENTS PER LEDGER ──────────────────
// A department maps to exactly one salary ledger. The reverse is deliberately
// open: point Cutting, Finishing and Washing at one "Wages" head if that is how
// the books read, or give each its own. What is NOT offered is splitting one
// department across several ledgers by percentage — that is an allocation
// rule, it needs a basis nobody has stated, and a wrong guess silently
// misstates the P&L every month.
//
// ── THE KEY IS CASE-FOLDED ──────────────────────────────────────────────────
// HR's department strings are free text and already contain both "DESIGNING"
// and "Designing" for the same department. Mapping on the raw string would ask
// Accounts to map the same department twice and let the second spelling fall
// silently back to the default ledger. `key` is the folded form; `label` keeps
// the spelling to show.
//
// ── DEDUCTIONS ARE PART OF THE SAME ANSWER ──────────────────────────────────
// PF / ESI / other deductions / net payable rarely differ by department, so
// they are configured once here rather than per row. They are pre-filled from
// the same find-or-create resolution the bridge has always used, so a company
// that never opens this screen posts exactly as it does today.

"use strict";

const mongoose = require("mongoose");

/** Fold a department string to its mapping key. Empty stays empty. */
function departmentKey(name) {
  return String(name || "").trim().toUpperCase().replace(/\s+/g, " ");
}

const ledgerRefSchema = new mongoose.Schema(
  {
    ledgerId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Ledger" },
    ledgerName: { type: String, default: "" },
  },
  { _id: false },
);

const payrollLedgerMapSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      required: true,
      unique: true,
      index: true,
    },

    /* department → salary expense ledger */
    departments: {
      type: [
        {
          _id: false,
          key: { type: String, required: true },
          label: { type: String, default: "" },
          ledgerId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Ledger" },
          ledgerName: { type: String, default: "" },
        },
      ],
      default: [],
    },

    /* Everything below the salary line. Absent → the bridge resolves it the
       way it always has, so an unconfigured company is unaffected. */
    pfPayable: { type: ledgerRefSchema, default: () => ({}) },
    esiPayable: { type: ledgerRefSchema, default: () => ({}) },
    otherDeductions: { type: ledgerRefSchema, default: () => ({}) },
    salaryPayable: { type: ledgerRefSchema, default: () => ({}) },
    stipendExpense: { type: ledgerRefSchema, default: () => ({}) },
    stipendPayable: { type: ledgerRefSchema, default: () => ({}) },

    /* The ledger for any department with no row of its own. Left empty, the
       bridge falls back to the auto-resolved Salaries ledger — the behaviour
       before this map existed. */
    defaultSalaryLedger: { type: ledgerRefSchema, default: () => ({}) },

    updatedByEmail: { type: String, default: "", lowercase: true },
    updatedByName: { type: String, default: "" },
  },
  { timestamps: true, collection: "acc_payroll_ledger_maps" },
);

/**
 * A run that was posted OUTSIDE this bridge — someone entered the voucher by
 * hand before the accountant module could do it.
 *
 * Recorded rather than faked: the run genuinely has no bridge voucher, so
 * pretending it does would make `unpost` offer to void something that is not
 * there and reconciliation chase a voucher number that was never issued. This
 * row says "posted, by hand, by this person, here is where it lives", and the
 * runs list reads it as a third posting state next to complete and not_posted.
 *
 * `voucherNumber` is free text on purpose: the manual voucher may predate any
 * numbering this module controls.
 */
const payrollExternalPostSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      required: true,
      index: true,
    },
    payrollRunId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Payroll",
      required: true,
    },
    /* What the run is, in case the run is ever deleted from HR. */
    month: { type: Number },
    year: { type: Number },

    voucherNumber: { type: String, default: "", trim: true },
    note: { type: String, default: "", trim: true },

    markedByEmail: { type: String, default: "", lowercase: true },
    markedByName: { type: String, default: "" },
  },
  { timestamps: true, collection: "acc_payroll_external_posts" },
);

payrollExternalPostSchema.index({ companyId: 1, payrollRunId: 1 }, { unique: true });

const Acc_PayrollLedgerMap =
  mongoose.models.Acc_PayrollLedgerMap ||
  mongoose.model("Acc_PayrollLedgerMap", payrollLedgerMapSchema, "acc_payroll_ledger_maps");

const Acc_PayrollExternalPost =
  mongoose.models.Acc_PayrollExternalPost ||
  mongoose.model("Acc_PayrollExternalPost", payrollExternalPostSchema, "acc_payroll_external_posts");

module.exports = { Acc_PayrollLedgerMap, Acc_PayrollExternalPost, departmentKey };
