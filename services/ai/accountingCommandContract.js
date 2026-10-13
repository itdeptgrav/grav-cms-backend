"use strict";
/**
 * services/ai/accountingCommandContract.js — what Accounting's Cmd/Ctrl K
 * knows: the families of record, the words people use for them, the statuses
 * they record, the page each opens, and the facts each card shows.
 *
 * ── WHY NOT THE ASSISTANT'S TOOLS, AS STORE DOES ──────────────────────────
 * Store's palette reuses Store's assistant capabilities, because they own the
 * tenant scope. Accounting's do not: `services/accountingContext.js` reads the
 * PRIMARY company, whichever company the person has selected. Reusing it here
 * would show company A's balances to somebody looking at company B. So the
 * accounting palette reads through its own small readers, every one of them
 * filtered by the companyId the accounting middleware has already checked
 * against the organisation (`requireCompanyScope`). The balance calculation
 * IS shared — `computeLedgerBalances(companyId, …)` takes the company — so a
 * balance here is the same figure the ledger page shows.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────
 * - Company-wide financial figures (revenue, net profit, …): the assistant's
 *   calculation reads the primary company only. The Profit & Loss and Balance
 *   Sheet pages answer them for the selected company; the palette opens them.
 * - Legacy collections with no companyId (acc_invoices, acc_expenses,
 *   acc_bank_transactions, acc_credit_debit_notes, acc_tax_filings): they
 *   cannot be scoped to a company, so they are not searched. The vouchers
 *   that replaced them are.
 * - Bank details, contact phone and email on a ledger: never selected.
 *
 * No database access here.
 */

const { FORMAT } = require("./commandSearch/cards");

const { text, date, number, money, words, count } = FORMAT;

/* ── VOUCHER TYPES ─────────────────────────────────────────────────────────
   The enum `Acc_Voucher.voucherType` records, with the words people type for
   each. Longest name wins, so "receipt note" is not read as "receipt". */
const VOUCHER_TYPES = Object.freeze([
  { type: "sales", label: "sales voucher", names: ["sales voucher", "sales invoice", "sales bill", "invoice", "sale", "sales"] },
  { type: "purchase", label: "purchase voucher", names: ["purchase voucher", "purchase bill", "purchase invoice", "purchase"] },
  { type: "receipt", label: "receipt", names: ["receipt voucher", "receipt", "collection"] },
  { type: "payment", label: "payment", names: ["payment voucher", "payment"] },
  { type: "contra", label: "contra voucher", names: ["contra voucher", "contra", "contra entry"] },
  { type: "journal", label: "journal voucher", names: ["journal voucher", "journal entry", "journal", "jv"] },
  { type: "credit_note", label: "credit note", names: ["credit note", "cn"] },
  { type: "debit_note", label: "debit note", names: ["debit note", "dn"] },
  { type: "stock_journal", label: "stock journal", names: ["stock journal"] },
  { type: "delivery_note", label: "delivery note", names: ["delivery note"] },
  { type: "receipt_note", label: "receipt note", names: ["receipt note"] },
  { type: "rejection_in", label: "rejection in", names: ["rejection in"] },
  { type: "rejection_out", label: "rejection out", names: ["rejection out"] },
  { type: "physical_stock", label: "physical stock voucher", names: ["physical stock"] },
]);

/** Voucher statuses, as recorded, and the words for each. */
const VOUCHER_STATUSES = Object.freeze([
  { status: "draft", names: ["draft", "drafts", "unposted"] },
  { status: "pending_approval", names: ["pending approval", "awaiting approval", "pending", "for approval"] },
  { status: "posted", names: ["posted", "approved", "final"] },
  { status: "cancelled", names: ["cancelled", "canceled"] },
  { status: "void", names: ["void", "voided"] },
]);

const PROFORMA_STATUSES = Object.freeze([
  { status: "draft", names: ["draft"] },
  { status: "sent", names: ["sent"] },
  { status: "accepted", names: ["accepted"] },
  { status: "expired", names: ["expired"] },
  { status: "cancelled", names: ["cancelled", "canceled"] },
]);

/* ── FAMILIES ──────────────────────────────────────────────────────────────
   `party` narrows ledgers to the Sundry Debtors / Sundry Creditors trees —
   customers and suppliers ARE ledgers in these books. */
const FAMILIES = Object.freeze([
  { id: "voucher", label: "voucher", names: ["voucher", "transaction", "entry", "entries"] },
  { id: "ledger", label: "ledger", names: ["ledger", "account", "a/c"] },
  { id: "customer", label: "customer", names: ["customer", "debtor", "sundry debtor", "sundry debtors"], party: "customer" },
  { id: "supplier", label: "supplier", names: ["supplier", "vendor", "creditor", "sundry creditor", "sundry creditors"], party: "supplier" },
  { id: "group", label: "account group", names: ["account group", "ledger group", "group"] },
  { id: "stock_item", label: "stock item", names: ["stock item", "inventory item", "item"] },
  { id: "proforma_invoice", label: "proforma invoice", names: ["proforma invoice", "proforma", "pi"] },
]);

/* ── THE PAGE EACH RECORD OPENS ────────────────────────────────────────────
   The same routes Accounting's own screens use. A stock item has no page of
   its own; its card answers in the palette, and its vouchers are found by its
   name. */
const ACCOUNTING_RECORD_ROUTES = Object.freeze({
  ledger: (id) => `/accountant/ledger/${id}`,
  sales_voucher: (id) => `/accountant/invoices/${id}`,
  voucher: (id) => `/accountant/vouchers/view/${id}`,
  group: (id) => `/accountant/chart-of-accounts/group/${id}`,
  proforma_invoice: (id) => `/accountant/proforma-invoices/${id}`,
});

const voucherTypeLabel = (type) => VOUCHER_TYPES.find((t) => t.type === type)?.label || words(type);
const voucherRoute = (voucher) => (voucher?.voucherType === "sales"
  ? ACCOUNTING_RECORD_ROUTES.sales_voucher(voucher._id)
  : ACCOUNTING_RECORD_ROUTES.voucher(voucher._id));

/** A ledger balance as a person reads it — or why it cannot be trusted yet. */
function balanceText(balance) {
  if (!balance) return null;
  if (balance.reconciliation?.status === "source_incomplete") return "Needs reconciliation";
  return `${money(balance.abs)} ${balance.drCr || ""}`.trim();
}

/* ── CARDS ─────────────────────────────────────────────────────────────────
   The facts that matter about one record. Shape and look are SHARED (see
   services/ai/commandSearch/cards.js); these say only which facts. */
const CARDS = Object.freeze({
  ledger: {
    title: (r) => r.name,
    status: (r) => words(r.nature),
    facts: (r, extra) => [
      ["Group", text(r.groupName)],
      ["Balance", balanceText(extra.balance)],
      ["GSTIN", text(r.gstin)],
      ["PAN", text(r.panNumber)],
      ["City", text(r.contactDetails?.city)],
      ["Credit period", number(r.creditPeriodDays) ? `${number(r.creditPeriodDays)} days` : null],
      ["Credit limit", Number(r.creditLimit) > 0 ? money(r.creditLimit) : null],
    ],
  },
  voucher: {
    title: (r) => r.voucherNumber,
    status: (r) => words(r.status),
    facts: (r) => [
      ["Type", words(voucherTypeLabel(r.voucherType))],
      ["Date", date(r.voucherDate)],
      ["Party", text(r.partyLedgerName)],
      ["Total", money(r.grandTotal)],
      ["Reference", text(r.referenceNumber)],
      ["Items", Array.isArray(r.inventoryEntries) && r.inventoryEntries.length ? count(r.inventoryEntries) : null],
      ["Narration", text(r.narration)],
    ],
  },
  stock_item: {
    title: (r) => r.name,
    status: () => null,
    facts: (r) => [
      ["Group", text(r.stockGroupName)],
      ["HSN", text(r.hsnCode)],
      ["In stock", number(r.closingQuantity) === null ? null : `${number(r.closingQuantity)} ${text(r.baseUnit) || ""}`.trim()],
      ["Value", money(r.closingValue)],
      ["Tax rate", number(r.taxRate) === null ? null : `${number(r.taxRate)}%`],
    ],
  },
  group: {
    title: (r) => r.name,
    status: (r) => words(r.nature),
    facts: (r, extra) => [
      ["Under", text(r.parentName)],
      ["Ledgers", extra.ledgers ?? null],
    ],
  },
  proforma_invoice: {
    title: (r) => r.voucherNumber,
    status: (r) => words(r.status),
    facts: (r) => [
      ["Buyer", text(r.buyer?.name)],
      ["Date", date(r.voucherDate)],
      ["Valid till", date(r.validTill)],
      ["Total", money(r.grandTotal)],
    ],
  },
});

/* The fields each family's reader may select. Anything not here is never
   read — bank details, phone and email on a ledger included. */
const PROJECTIONS = Object.freeze({
  ledger: "_id name aliases groupName nature gstin panNumber contactDetails.city creditPeriodDays creditLimit openingBalance balanceFromTrialBalance currentBalance currentBalanceType isActive",
  voucher: "_id voucherNumber voucherType voucherDate partyLedgerName partyLedgerId grandTotal narration status referenceNumber inventoryEntries.stockItemName",
  stock_item: "_id name aliases stockGroupName hsnCode baseUnit closingQuantity closingValue taxRate isActive",
  group: "_id name parentName nature isActive",
  proforma_invoice: "_id voucherNumber status voucherDate validTill grandTotal buyer.name",
});

module.exports = {
  VOUCHER_TYPES, VOUCHER_STATUSES, PROFORMA_STATUSES, FAMILIES,
  ACCOUNTING_RECORD_ROUTES, CARDS, PROJECTIONS,
  voucherTypeLabel, voucherRoute, balanceText,
};
