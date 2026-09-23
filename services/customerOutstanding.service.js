/**
 * GRAV-CMS-BACKEND/services/customerOutstanding.service.js
 *
 * The receivable side, bound to the shared party engine.
 *
 * ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
 * `partyOutstanding.service.js` holds the arithmetic, the company scoping, the
 * Sundry-group tree walk, the id re-resolution, the as-of cut-off and the
 * statement builder — all of it identical for customers and suppliers. This
 * file binds that engine to `PARTY_KINDS.customer` and keeps the public names
 * the Customers report route and its tests already use.
 *
 * ── WHY THE ENGINE IS SHARED ────────────────────────────────────────────────
 * When Chunk 2 added suppliers, the alternative was a second copy of the
 * company scoping, the spoofed-id re-resolution and the as-of default. Those
 * are the parts a cross-company leak hides in, and two copies of them is how
 * one gets fixed and the other does not. `openItems.service.js` makes the same
 * argument for the same reason: three implementations of "what is outstanding"
 * will disagree eventually, and on the day they do nobody will know which
 * screen is lying.
 *
 * ── THE CUSTOMER READING ────────────────────────────────────────────────────
 *   signed balance = ledger opening + Σ debits − Σ credits
 *   Dr (positive) → RECEIVABLE — they owe us
 *   Cr (negative) → a credit or advance we are holding for them
 * The two are reported side by side and never netted.
 *
 * Nothing here reads a quotation, a Customer Request, an order total or a
 * cached summary field, and nothing here writes.
 */

"use strict";

const party = require("./partyOutstanding.service");

/** This module's party kind. Every call below is bound to it. */
const KIND = party.PARTY_KINDS.customer;

/**
 * The receivable side of the chart of accounts. Kept exported under its
 * original name: `Acc_parties.js` and the Customers screen both describe
 * customers this way, and a report that used a different regex would disagree
 * with the list it was exported from.
 */
const SUNDRY_DEBTORS_RX = KIND.groupRx;

/**
 * Which side a signed balance sits on, in CUSTOMER terms.
 *
 * The engine returns the party-neutral halves (`debit`/`credit`); this adds
 * `receivable` as the name the receivable side is actually called, so callers
 * reading a customer figure never have to remember that Dr means "they owe us"
 * here and the opposite for a supplier.
 */
function classifyBalance(signed) {
  const c = party.classifyBalance(signed);
  return { ...c, receivable: c.debit };
}

/** One customer row: `receivable` / `customerCredit` are the two halves. */
function buildOutstandingRow(ledger, movement = {}) {
  return party.buildOutstandingRow(KIND, ledger, movement);
}

/** Receivables and customer credits, counted separately and never netted. */
function totalsOf(rows) {
  return party.totalsOf(KIND, rows);
}

/** The applied-filters line, in customer wording. */
function describeFilters(filters = {}, opts = {}) {
  return party.describeFilters(KIND, filters, opts);
}

/** A stable, human-quotable customer code (`C-XXXXX`), matching the code the
 * Customers screen shows for the same ledger. */
function ledgerCode(objectId) {
  return KIND.codeOf(objectId);
}

/** Every group id under this company's "Sundry Debtors" tree. */
function debtorGroupIds(companyId) {
  return party.partyGroupIds(KIND, companyId);
}

/**
 * The customer ledgers a request is allowed to see.
 *
 * Ids from a browser are never used as a lookup result — they are an extra
 * NARROWING clause on a query already scoped to this company and to its Sundry
 * Debtors groups, so an id belonging to another company or to a supplier
 * simply is not in the answer. See the engine for the full note.
 */
function resolveDebtorLedgers(companyId, opts = {}) {
  return party.resolvePartyLedgers(KIND, companyId, opts);
}

/** THE CUSTOMER OUTSTANDING SUMMARY. */
function customerOutstandingReport(filters = {}) {
  return party.partyOutstandingReport(KIND, filters);
}

/** THE INDIVIDUAL CUSTOMER LEDGER / STATEMENT OF ACCOUNT. */
function customerLedgerStatement(filters = {}) {
  return party.partyLedgerStatement(KIND, filters);
}

module.exports = {
  // Constants
  KIND,
  SUNDRY_DEBTORS_RX,
  ZERO_TOLERANCE: party.ZERO_TOLERANCE,
  MAX_EXPORT_LEDGERS: party.MAX_EXPORT_LEDGERS,
  BUSINESS_UTC_OFFSET_MINUTES: party.BUSINESS_UTC_OFFSET_MINUTES,

  // Pure — shared with the engine unchanged
  oid: party.oid,
  escapeRx: party.escapeRx,
  startOfBusinessDay: party.startOfBusinessDay,
  endOfBusinessDay: party.endOfBusinessDay,
  effectiveAsOf: party.effectiveAsOf,
  parseDateBoundary: party.parseDateBoundary,
  openingSignedOf: party.openingSignedOf,
  signedBalance: party.signedBalance,
  round2: party.round2,
  applyBalanceFilters: party.applyBalanceFilters,
  parseReportQuery: party.parseReportQuery,
  movementByLedger: party.movementByLedger,
  companyHeader: party.companyHeader,

  // Pure — bound to the customer kind
  classifyBalance,
  ledgerCode,
  buildOutstandingRow,
  totalsOf,
  describeFilters,

  // Database — bound to the customer kind
  debtorGroupIds,
  resolveDebtorLedgers,
  customerOutstandingReport,
  customerLedgerStatement,
};
