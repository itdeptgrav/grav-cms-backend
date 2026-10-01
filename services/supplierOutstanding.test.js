// services/supplierOutstanding.test.js
//
// THE PAYABLE SIDE IS THE MIRROR IMAGE, AND THAT IS WHERE THE MISTAKES ARE.
//
// The arithmetic is shared with the customer report, so this file does not
// re-test it. What it tests is the one thing that flips — which side of the
// balance is the money we owe — because reading a supplier's Cr balance the
// way a customer's is read turns every payable into a negative receivable and
// every advance into a debt.
//
// The database-facing behaviour (company isolation, spoofed ids, as-of
// cut-offs, statement reconciliation) needs real collections and lives in
// test/accountant/supplier-outstanding.route.test.js.
//
// Run by `npm test` — node --test "services/**/*.test.js".

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const svc = require("./supplierOutstanding.service");
const customer = require("./customerOutstanding.service");

const COMPANY = new mongoose.Types.ObjectId().toString();

const ledger = (o = {}) => ({
  _id: "bbbbbbbbbbbbbbbbbbbbbbb1",
  name: "Northline Fabrics Pvt Ltd",
  gstin: "27BBBBB0000B1Z5",
  groupName: "Sundry Creditors",
  openingBalance: 0,
  openingBalanceType: "Cr",
  ...o,
});

/* ── Which ledgers are suppliers ─────────────────────────────────────────── */

test("suppliers are Sundry Creditors, and customers are not", () => {
  assert.ok(svc.SUNDRY_CREDITORS_RX.test("Sundry Creditors"));
  assert.ok(svc.SUNDRY_CREDITORS_RX.test("sundry creditors — imports"));
  assert.ok(!svc.SUNDRY_CREDITORS_RX.test("Sundry Debtors"));
  assert.notEqual(String(svc.SUNDRY_CREDITORS_RX), String(customer.SUNDRY_DEBTORS_RX));
});

/* ── The sign convention ─────────────────────────────────────────────────── */

test("a CREDIT balance is a payable — we owe them", () => {
  const c = svc.classifyBalance(-40000);
  assert.equal(c.type, "Cr");
  assert.equal(c.payable, 40000);
  assert.equal(c.advance, 0);
  assert.equal(c.amount, 40000, "the reported amount is unsigned; the type carries the side");
});

test("a DEBIT balance is an advance — they hold our money", () => {
  const d = svc.classifyBalance(9000);
  assert.equal(d.type, "Dr");
  assert.equal(d.advance, 9000);
  assert.equal(d.payable, 0);
});

test("the supplier reading is the exact mirror of the customer reading", () => {
  // Same signed number, opposite meaning. This is the whole difference.
  const signed = -40000;
  assert.equal(svc.classifyBalance(signed).payable, 40000);
  assert.equal(customer.classifyBalance(signed).receivable, 0);
  assert.equal(customer.classifyBalance(-signed).receivable, 40000);
  assert.equal(svc.classifyBalance(-signed).payable, 0);
});

test("rounding dust is neither a payable nor an advance", () => {
  const nil = svc.classifyBalance(-0.001);
  assert.equal(nil.type, "Nil");
  assert.equal(nil.payable, 0);
  assert.equal(nil.advance, 0);
});

/* ── What each document does to the payable ──────────────────────────────── */

const row = (opts) => svc.buildOutstandingRow(ledger(), opts);

test("a purchase bill CREDITS the supplier and increases the payable", () => {
  const r = row({ credit: 118000, transactionCount: 1 });
  assert.equal(r.balanceType, "Cr");
  assert.equal(r.payable, 118000);
  assert.equal(r.supplierAdvance, 0);
});

test("a payment DEBITS the supplier and reduces the payable", () => {
  const r = row({ credit: 118000, debit: 50000, transactionCount: 2 });
  assert.equal(r.balanceType, "Cr");
  assert.equal(r.payable, 68000);
});

test("a debit note also DEBITS the supplier and reduces the payable", () => {
  // A debit note (goods returned, a rate correction) posts on the same side as
  // a payment: both reduce what we owe.
  const r = row({ credit: 118000, debit: 118000 });
  assert.equal(r.balanceType, "Nil");
  assert.equal(r.payable, 0);
  assert.equal(r.balance, 0);
});

test("paying MORE than the bill turns the payable into a supplier advance", () => {
  const r = row({ credit: 100000, debit: 130000 });
  assert.equal(r.balanceType, "Dr");
  assert.equal(r.payable, 0, "we owe them nothing");
  assert.equal(r.supplierAdvance, 30000, "they hold 30,000 of ours");
  assert.equal(r.balance, 30000);
});

test("an opening Cr balance is a payable brought forward", () => {
  const r = svc.buildOutstandingRow(
    ledger({ openingBalance: 25000, openingBalanceType: "Cr" }),
    { credit: 10000 },
  );
  assert.equal(r.openingBalance, 25000);
  assert.equal(r.openingType, "Cr");
  assert.equal(r.payable, 35000);
});

test("an opening Dr balance is an advance carried forward and offsets new bills", () => {
  const r = svc.buildOutstandingRow(
    ledger({ openingBalance: 25000, openingBalanceType: "Dr" }),
    { credit: 10000 },
  );
  assert.equal(r.openingType, "Dr");
  assert.equal(r.balanceType, "Dr");
  assert.equal(r.supplierAdvance, 15000);
  assert.equal(r.payable, 0);
});

test("a supplier ledger with no vouchers still reports its opening balance", () => {
  const r = svc.buildOutstandingRow(
    ledger({ openingBalance: 7500, openingBalanceType: "Cr" }),
    {},
  );
  assert.equal(r.payable, 7500);
  assert.equal(r.transactionCount, 0);
});

/* ── The code on the report is the code on the screen ────────────────────── */

/**
 * `Acc_vendors.js` builds the code the Vendors screen displays as
 *   `VEN-${(vendorLedger?._id || vendor._id).toString().substring(18, 24).toUpperCase()}`
 * and every row on that screen has a ledger, so the code is always
 * ledger-derived. A report that invented its own derivation would print
 * identifiers matching nothing the user can see or search for — which is what
 * the first version of this module did, with a base-36 `V-` code.
 */
const screenVendorCode = (id) => `VEN-${String(id).substring(18, 24).toUpperCase()}`;

test("a supplier code is VEN- plus the ledger id's last six hex characters", () => {
  const id = "6650a1b2c3d4e5f6010203b1";
  assert.equal(svc.ledgerCode(id), "VEN-0203B1");
  assert.equal(svc.ledgerCode(id), screenVendorCode(id));
  assert.match(svc.ledgerCode(id), /^VEN-[0-9A-F]{6}$/);
});

test("the code on a report row is the same code, for any ledger id", () => {
  for (const id of [
    "6650a1b2c3d4e5f6010203b1",
    "000000000000000000000000",
    "ffffffffffffffffffffffff",
    "6650a1b2c3d4e5f60102abcd",
  ]) {
    const r = svc.buildOutstandingRow(ledger({ _id: id }), { credit: 1000 });
    assert.equal(r.code, screenVendorCode(id), `code for ${id}`);
  }
});

test("an IMPORTED ledger-only supplier and a CMS vendor LINKED to the same ledger share one code", () => {
  // The screen derives the code from the ledger whenever one exists, and the
  // report always does — so a Tally import with no CMS vendor row and a CMS
  // vendor linked to that very ledger cannot show different identifiers.
  const id = "6650a1b2c3d4e5f6010203b1";
  const importedOnly = svc.buildOutstandingRow(
    ledger({ _id: id, name: "Tally Only Mills" }),
    { credit: 5000 },
  );
  const linkedToCmsVendor = svc.buildOutstandingRow(
    ledger({ _id: id, name: "Tally Only Mills", linkedVendorId: "aaaaaaaaaaaaaaaaaaaaaaaa" }),
    { credit: 5000 },
  );
  assert.equal(importedOnly.code, linkedToCmsVendor.code);
  assert.equal(importedOnly.code, screenVendorCode(id));
});

test("a supplier code is NOT a customer code, and the customer format is unchanged", () => {
  const id = "6650a1b2c3d4e5f6010203b1";
  assert.notEqual(svc.ledgerCode(id), customer.ledgerCode(id));
  assert.match(customer.ledgerCode(id), /^C-[0-9A-Z]{5}$/);
  assert.equal(customer.ledgerCode(id), "C-02TV5");
});

test("a malformed id degrades to a well-formed placeholder rather than NaN", () => {
  assert.equal(svc.ledgerCode("zzzzzz"), "VEN-000000");
  assert.equal(customer.ledgerCode("zzzzzz"), "C-00000");
});

/* ── The two halves are never netted ─────────────────────────────────────── */

test("a supplier we have overpaid does NOT reduce what we owe the others", () => {
  const owed = svc.buildOutstandingRow(ledger({ _id: "bbbbbbbbbbbbbbbbbbbbbbb1" }), {
    credit: 500000,
  });
  const prepaid = svc.buildOutstandingRow(ledger({ _id: "bbbbbbbbbbbbbbbbbbbbbbb2" }), {
    debit: 80000,
  });

  const t = svc.totalsOf([owed, prepaid]);
  assert.equal(t.payable, 500000, "the liability the business is carrying is 5,00,000");
  assert.equal(t.supplierAdvance, 80000);
  assert.equal(t.payableCount, 1);
  assert.equal(t.advanceCount, 1);
  assert.equal(
    t.netBalance,
    420000,
    "netting is offered separately, for the Sundry Creditors control account",
  );
  assert.notEqual(t.payable, t.netBalance, "the headline is never the netted figure");
});

test("the party-neutral aliases point at the supplier halves, not the customer ones", () => {
  const t = svc.totalsOf([
    svc.buildOutstandingRow(ledger(), { credit: 500000 }),
    svc.buildOutstandingRow(ledger({ _id: "bbbbbbbbbbbbbbbbbbbbbbb2" }), { debit: 80000 }),
  ]);
  assert.equal(t.primaryTotal, t.payable);
  assert.equal(t.secondaryTotal, t.supplierAdvance);
});

/* ── Filters ─────────────────────────────────────────────────────────────── */

const mixed = () => [
  svc.buildOutstandingRow(ledger({ _id: "bbbbbbbbbbbbbbbbbbbbbbb1", name: "Big Payable" }), { credit: 500000 }),
  svc.buildOutstandingRow(ledger({ _id: "bbbbbbbbbbbbbbbbbbbbbbb2", name: "Small Payable" }), { credit: 400 }),
  svc.buildOutstandingRow(ledger({ _id: "bbbbbbbbbbbbbbbbbbbbbbb3", name: "In Advance" }), { debit: 80000 }),
  svc.buildOutstandingRow(ledger({ _id: "bbbbbbbbbbbbbbbbbbbbbbb4", name: "Settled" }), { credit: 900, debit: 900 }),
];

test("balanceSide=credit keeps only what we owe", () => {
  assert.deepEqual(
    svc.applyBalanceFilters(mixed(), { balanceSide: "credit" }).map((r) => r.name),
    ["Big Payable", "Small Payable"],
  );
});

test("balanceSide=debit keeps only suppliers holding an advance", () => {
  assert.deepEqual(
    svc.applyBalanceFilters(mixed(), { balanceSide: "debit" }).map((r) => r.name),
    ["In Advance"],
  );
});

test("balanceSide=both keeps every non-nil balance and drops the settled ledger", () => {
  assert.deepEqual(
    svc.applyBalanceFilters(mixed(), { balanceSide: "both" }).map((r) => r.name),
    ["Big Payable", "Small Payable", "In Advance"],
  );
});

test("minOutstanding is a materiality threshold on the magnitude, not a sign filter", () => {
  assert.deepEqual(
    svc.applyBalanceFilters(mixed(), { minOutstanding: 1000, balanceSide: "both" }).map((r) => r.name),
    ["Big Payable", "In Advance"],
  );
});

/* ── Request validation ──────────────────────────────────────────────────── */

test("a missing or malformed companyId is refused", () => {
  assert.ok(svc.parseReportQuery({}).errors.some((e) => /companyId/.test(e)));
  assert.ok(svc.parseReportQuery({ companyId: "nope" }).errors.some((e) => /companyId/.test(e)));
});

test("scope=selected with nothing usable names SUPPLIERS in its message", () => {
  const { errors } = svc.parseReportQuery({
    companyId: COMPANY,
    scope: "selected",
    ledgerIds: "not-an-id",
  });
  assert.ok(errors.some((e) => /Select at least one supplier/.test(e)));
});

test("scope=filtered with an EMPTY list is valid and stays empty", () => {
  const { errors, filters } = svc.parseReportQuery({
    companyId: COMPANY,
    scope: "filtered",
    ledgerIds: "",
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(filters.ledgerIds, []);
  assert.equal(filters.restrictToIds, true);
});

test("scope=filtered with NO ledgerIds at all is refused, never widened", () => {
  const { errors } = svc.parseReportQuery({ companyId: COMPANY, scope: "filtered" });
  assert.ok(errors.some((e) => /must send the ledger ids/.test(e)));
});

test("a missing asOf resolves to the end of today in business time", () => {
  const now = new Date("2026-09-08T04:00:00.000Z");
  const eff = svc.effectiveAsOf(null, now);
  const offsetMs = svc.BUSINESS_UTC_OFFSET_MINUTES * 60000;
  assert.equal(eff.getTime(), Date.UTC(2026, 8, 8, 23, 59, 59, 999) - offsetMs);
  assert.ok(eff > now);
});

/* ── The applied-filters line speaks supplier ────────────────────────────── */

test("the filter summary uses payable/advance wording, not receivable/credit", () => {
  const s = svc.describeFilters(
    { scope: "filtered", minOutstanding: 5000, balanceSide: "credit", restrictToIds: true },
    { resolvedCount: 7 },
  );
  assert.match(s, /current filtered result \(7\)/);
  assert.match(s, /Minimum balance: ₹5,000/);
  assert.match(s, /Balances: payable \(Cr\) only/);
  assert.ok(!/receivable/i.test(s));
});

test("the all-scope summary counts suppliers, not customers", () => {
  const s = svc.describeFilters({ scope: "all", balanceSide: "both" }, {});
  assert.match(s, /all accounting suppliers/);
  assert.match(s, /Balances: payable and supplier advance/);
});

test("the customer summary is untouched by any of this", () => {
  const s = customer.describeFilters({ scope: "all", balanceSide: "debit" }, {});
  assert.match(s, /all accounting customers/);
  assert.match(s, /Balances: receivable \(Dr\) only/);
});
