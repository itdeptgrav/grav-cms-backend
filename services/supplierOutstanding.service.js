/**
 * GRAV-CMS-BACKEND/services/supplierOutstanding.service.js
 *
 * The payable side, bound to the shared party engine.
 *
 * ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
 * `partyOutstanding.service.js` holds the arithmetic, the company scoping, the
 * Sundry-group tree walk, the id re-resolution, the as-of cut-off and the
 * statement builder. This file binds it to `PARTY_KINDS.supplier`.
 *
 * ── THE SUPPLIER READING — AND WHY IT IS THE MIRROR IMAGE ───────────────────
 * The arithmetic is identical to the customer side:
 *
 *     signed balance = ledger opening + Σ debits − Σ credits
 *
 * What flips is which side is the number people care about. A Sundry Creditor
 * is a liability, so:
 *
 *   Cr (negative signed) → PAYABLE. We owe them. A purchase bill credits the
 *                          supplier ledger, so bills push the balance further
 *                          Cr and increase the payable.
 *   Dr (positive signed) → ADVANCE / OVERPAYMENT. We have paid ahead, or paid
 *                          more than we owed and they hold our money. A
 *                          payment or a debit note debits the supplier ledger,
 *                          so both REDUCE the payable — and past zero they
 *                          turn it into an advance.
 *
 * Reading a Cr balance as "negative payable" is the mistake this exists to
 * prevent: a supplier we have overpaid does not reduce what we owe every other
 * supplier, and a netted total understates the liability the business is
 * actually carrying. Payables and advances are reported side by side and never
 * summed; `netBalance` exists only as a named extra for reconciling against
 * the Sundry Creditors control account.
 *
 * ── AUTHORITY ───────────────────────────────────────────────────────────────
 * Ledgers under Sundry Creditors and its descendants, and posted vouchers.
 * NOT purchase orders, NOT PO payment records, NOT the CMS `Vendor` model, and
 * NOT the cached `currentBalance` field. `Acc_vendors.js` already computes a
 * procurement view from purchase orders; that view answers a different
 * question and does not reconcile with the General Ledger. A supplier ledger
 * imported from Tally with no CMS `Vendor` row at all is a first-class party
 * here — the ledger is the authority, and the CMS record is optional metadata
 * that this report does not need and does not read.
 *
 * Nothing here writes.
 */

"use strict";

const party = require("./partyOutstanding.service");

/** This module's party kind. Every call below is bound to it. */
const KIND = party.PARTY_KINDS.supplier;

/**
 * The payable side of the chart of accounts. Matches the regex
 * `Acc_parties.js` uses for `kind: "vendor"` and the one `Acc_vendors.js`
 * uses for its imported-creditor bridge, so the report and the Vendors screen
 * can never disagree about who is a supplier.
 */
const SUNDRY_CREDITORS_RX = KIND.groupRx;

/**
 * Which side a signed balance sits on, in SUPPLIER terms.
 *
 * The engine returns the party-neutral halves (`debit`/`credit`); this names
 * them the way the payable side is read: `payable` is the Cr half, `advance`
 * the Dr half.
 */
function classifyBalance(signed) {
  const c = party.classifyBalance(signed);
  return { ...c, payable: c.credit, advance: c.debit };
}

/** One supplier row: `payable` / `supplierAdvance` are the two halves. */
function buildOutstandingRow(ledger, movement = {}) {
  return party.buildOutstandingRow(KIND, ledger, movement);
}

/** Payables and supplier advances, counted separately and never netted. */
function totalsOf(rows) {
  return party.totalsOf(KIND, rows);
}

/** The applied-filters line, in supplier wording. */
function describeFilters(filters = {}, opts = {}) {
  return party.describeFilters(KIND, filters, opts);
}

/** A stable, human-quotable supplier code (`VEN-XXXXXX`), matching the
 * code the Vendors screen shows for the same ledger. */
function ledgerCode(objectId) {
  return KIND.codeOf(objectId);
}

/** Validate a report request, wording its one message for suppliers. */
function parseReportQuery(query = {}) {
  return party.parseReportQuery(query, { partyLabel: KIND.partyLabel });
}

/** Every group id under this company's "Sundry Creditors" tree. */
function creditorGroupIds(companyId) {
  return party.partyGroupIds(KIND, companyId);
}

/**
 * The supplier ledgers a request is allowed to see.
 *
 * ── WHY IDS ARE RE-RESOLVED ────────────────────────────────────────────────
 * `ledgerIds` come from a checkbox list in a browser. They are never used as a
 * lookup result; they are an extra NARROWING clause on a query already scoped
 * to this company and to its Sundry Creditors groups. So a ledger id pasted
 * from another company, or a customer's ledger id pasted into a supplier
 * report, simply is not in the answer — the company-access check on
 * `companyId` would still have passed, because the id spoofed is not the
 * company that was asked for.
 *
 * ── AND WHY THIS ALSO SOLVES THE GHOST-VENDOR PROBLEM ──────────────────────
 * The population is ledgers, not CMS vendors. Two CMS `Vendor` rows that are
 * duplicates of one another point at ONE Sundry Creditor ledger (or at none),
 * so a duplicate cannot contribute its balance twice — there is only one
 * ledger to contribute it. A CMS vendor with no linked ledger has no books
 * presence and correctly does not appear at all.
 */
function resolveCreditorLedgers(companyId, opts = {}) {
  return party.resolvePartyLedgers(KIND, companyId, opts);
}

/** THE SUPPLIER OUTSTANDING SUMMARY. */
function supplierOutstandingReport(filters = {}) {
  return party.partyOutstandingReport(KIND, filters);
}

/** THE INDIVIDUAL SUPPLIER LEDGER / STATEMENT OF ACCOUNT. */
function supplierLedgerStatement(filters = {}) {
  return party.partyLedgerStatement(KIND, filters);
}

module.exports = {
  // Constants
  KIND,
  SUNDRY_CREDITORS_RX,
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
  movementByLedger: party.movementByLedger,
  companyHeader: party.companyHeader,

  // Pure — bound to the supplier kind
  classifyBalance,
  ledgerCode,
  buildOutstandingRow,
  totalsOf,
  describeFilters,
  parseReportQuery,

  // Database — bound to the supplier kind
  creditorGroupIds,
  resolveCreditorLedgers,
  supplierOutstandingReport,
  supplierLedgerStatement,
};
