/**
 * GRAV-CMS-BACKEND/services/supplierAgeing.service.js
 *
 * Invoice-wise ageing of supplier payables, bound to the shared engine.
 *
 * ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
 * `partyAgeing.service.js` holds the buckets, the due-date precedence, the
 * unallocated derivation and the reconciliation identity. This file binds it
 * to `PARTY_KINDS.supplier`.
 *
 * ── THE SUPPLIER READING — AND WHY IT IS THE MIRROR ─────────────────────────
 * A folded bill's `remaining` is Dr-positive, the ledger's own convention. A
 * purchase bill CREDITS the supplier, so an unpaid bill leaves `remaining`
 * NEGATIVE. `agedSign: -1` flips it, and that single multiplier is the whole
 * difference between the two reports:
 *
 *   purchase bill   credits the supplier   → increases the payable
 *   payment         debits the supplier    → reduces the referenced bill
 *   debit note      debits the supplier    → reduces it the same way
 *   paid past zero  a positive remainder   → a BILL ADVANCE, not a negative
 *                                            payable
 *
 * Every figure this module reports is positive and party-facing: a payable is
 * a positive number, an advance is a positive number, and the two are never
 * summed. A supplier we have overpaid does not reduce what we owe the others.
 *
 *     aged payables − bill advances + unallocated = ledger balance
 *
 * ── AUTHORITY ───────────────────────────────────────────────────────────────
 * Ledgers under Sundry Creditors and its descendants, and the bill allocations
 * on posted, non-optional vouchers. NOT purchase orders, NOT PO payment
 * records, NOT the CMS `Vendor` model. `Acc_reports.js`'s `/payables-aging`
 * ages Purchase Orders by `orderDate` across every company at once; that
 * answers a different question and reconciles with nothing in the books.
 *
 * Nothing here writes.
 */

"use strict";

const engine = require("./partyAgeing.service");
const party = require("./partyOutstanding.service");

/** This module's party kind. Every call below is bound to it. */
const KIND = party.PARTY_KINDS.supplier;

/** Age one supplier ledger's bills. */
function ageLedger(ledger, bills, opts = {}) {
  return engine.ageLedger(KIND, ledger, bills, opts);
}

/** Roll the per-supplier rows up, keeping payables and advances apart. */
function totalsOf(parties) {
  return engine.totalsOf(KIND, parties);
}

/** The applied-filters line, in supplier wording. */
function describeFilters(filters = {}, opts = {}) {
  return engine.describeFilters(KIND, filters, opts);
}

/** THE SUPPLIER INVOICE-WISE AGEING REPORT. */
function supplierAgeingReport(filters = {}) {
  return engine.partyAgeingReport(KIND, filters);
}

module.exports = {
  KIND,
  AGEING_BUCKETS: engine.AGEING_BUCKETS,
  BUCKET_KEYS: engine.BUCKET_KEYS,
  SETTLED_TOLERANCE: engine.SETTLED_TOLERANCE,

  // Pure — shared with the engine unchanged
  resolveDueDate: engine.resolveDueDate,
  ageOf: engine.ageOf,
  emptyBuckets: engine.emptyBuckets,

  // Pure — bound to the supplier kind
  ageLedger,
  totalsOf,
  describeFilters,

  // Database — bound to the supplier kind
  supplierAgeingReport,
};
