/**
 * GRAV-CMS-BACKEND/services/customerAgeing.service.js
 *
 * Invoice-wise ageing of customer receivables, bound to the shared engine.
 *
 * ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
 * `partyAgeing.service.js` holds the buckets, the due-date precedence, the
 * unallocated derivation and the reconciliation identity — all of it identical
 * for customers and suppliers. This file binds that engine to
 * `PARTY_KINDS.customer` and keeps the public names the Customers report route
 * and its tests already use.
 *
 * ── THE CUSTOMER READING ────────────────────────────────────────────────────
 * A folded bill's `remaining` is Dr-positive, the ledger's own convention. An
 * unpaid invoice DEBITS the customer, so a positive remainder IS the
 * receivable and `agedSign` is +1 — the customer side needs no flip, which is
 * exactly why the sign was easy to leave implicit until the supplier report
 * arrived. It is explicit now.
 *
 *   aged receivables − bill credits + unallocated = ledger balance
 *
 * Payments, credit notes and adjustments allocated to a bill reduce it; an
 * over-receipt against one invoice becomes a bill credit rather than a
 * negative age. Nothing here reads a quotation, a Customer Request or an order
 * total, and nothing here writes.
 */

"use strict";

const engine = require("./partyAgeing.service");
const party = require("./partyOutstanding.service");

/** This module's party kind. Every call below is bound to it. */
const KIND = party.PARTY_KINDS.customer;

/** Age one customer ledger's bills. */
function ageLedger(ledger, bills, opts = {}) {
  return engine.ageLedger(KIND, ledger, bills, opts);
}

/** Roll the per-customer rows up, keeping the disclosures apart. */
function totalsOf(parties) {
  return engine.totalsOf(KIND, parties);
}

/** The applied-filters line, in customer wording. */
function describeFilters(filters = {}, opts = {}) {
  return engine.describeFilters(KIND, filters, opts);
}

/** THE CUSTOMER INVOICE-WISE AGEING REPORT. */
function customerAgeingReport(filters = {}) {
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

  // Pure — bound to the customer kind
  ageLedger,
  totalsOf,
  describeFilters,

  // Database — bound to the customer kind
  customerAgeingReport,
};
