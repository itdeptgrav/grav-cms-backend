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

/**
 * The key for a department, or for one designation inside it.
 *
 * "DESIGNING" and "DESIGNING::GRAPHIC DESIGNER" are both valid rows, and the
 * bridge prefers the more specific one — a company that pays its designers out
 * of one head and its design managers out of another says so with two rows,
 * and a company that does not simply never adds the second.
 *
 * "::" cannot appear in a department name, so a designation row can never
 * collide with a department one.
 */
function mapKey(department, designation) {
  const d = departmentKey(department);
  const g = departmentKey(designation);
  return g ? `${d}::${g}` : d;
}

const ledgerRefSchema = new mongoose.Schema(
  {
    ledgerId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Ledger" },
    ledgerName: { type: String, default: "" },
  },
  { _id: false },
);

/**
 * A choice somebody actually made, kept so the screen can offer it again.
 *
 * ── WHY REMEMBER RATHER THAN JUST DEFAULT ───────────────────────────────────
 * The bridge falls back to a hardcoded list of ledger names when a slot is not
 * mapped. That guess is fine the first time and wrong forever after: Accounts
 * corrects it, and the next company, the next new department, the next slot
 * that nobody has mapped yet gets the same hardcoded guess again.
 *
 * So every explicit choice is recorded here with when and how often it was
 * made. Anything still unmapped can then be offered what this company has
 * chosen before, instead of what the code guessed.
 *
 * ── SUGGESTED, NEVER APPLIED ────────────────────────────────────────────────
 * A remembered choice is shown as a suggestion for a human to accept. It is
 * never posted to on its own. A wrong ledger silently adopted from history
 * misstates the P&L every month afterwards and looks exactly like a correct
 * one, which is precisely the failure the mapping screen exists to prevent.
 */
const learnedChoiceSchema = new mongoose.Schema(
  {
    /** Which slot, or "department" for a department/designation row. */
    slot: { type: String, required: true, trim: true },
    /** The department key for a department row; empty for a fixed slot. */
    key: { type: String, default: "", trim: true },
    ledgerId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Ledger" },
    ledgerName: { type: String, default: "" },
    /** How many separate saves picked this. Ties break by recency. */
    count: { type: Number, default: 1 },
    lastChosenAt: { type: Date, default: Date.now },
    lastChosenByName: { type: String, default: "" },
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

    /* department (or department::designation) → salary expense ledger */
    departments: {
      type: [
        {
          _id: false,
          key: { type: String, required: true },
          label: { type: String, default: "" },
          /* Kept apart so the UI can group rows under their department without
             re-splitting the key, and so a designation row reads as one. */
          department: { type: String, default: "" },
          designation: { type: String, default: "" },
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

    /* Every choice ever saved — see learnedChoiceSchema. Not a mapping in
       itself: the fields above are what the bridge posts to. */
    learned: { type: [learnedChoiceSchema], default: [] },
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

module.exports = { Acc_PayrollLedgerMap, Acc_PayrollExternalPost, departmentKey, mapKey };
