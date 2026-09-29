// services/supplierAgeing.test.js
//
// THE PAYABLE SIDE OF THE AGEING, WHERE THE SIGN FLIPS.
//
// The buckets, the due-date precedence and the reconciliation identity are
// shared with the customer report and tested there. What this file tests is
// the one thing that differs and the one place a mistake would be invisible:
// `foldAllocations` returns `remaining` Dr-positive, so an unpaid purchase
// bill — which CREDITS the supplier — arrives NEGATIVE. Read it the customer
// way and every payable becomes a negative receivable, every overpayment
// becomes a debt, and the totals still add up.
//
// Database behaviour lives in test/accountant/supplier-ageing.route.test.js.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const svc = require("./supplierAgeing.service");
const customer = require("./customerAgeing.service");

const LEDGER = {
  _id: "6650a1b2c3d4e5f6010203b1",
  name: "Northline Fabrics Pvt Ltd",
  gstin: "27BBBBB0000B1Z5",
};

/**
 * A folded bill as `openItems.foldAllocations` produces one.
 *
 * `remaining` is in the LEDGER's convention: Dr-positive. A purchase bill
 * credits the supplier, so an unpaid one is NEGATIVE here — every fixture
 * below spells that out rather than hiding it behind a helper.
 */
const bill = (o = {}) => ({
  ledgerId: String(LEDGER._id),
  billName: "PB-1",
  originalAmount: 118000,
  remaining: -118000, // unpaid purchase bill
  firstVoucherDate: new Date("2026-04-01"),
  dueDate: null,
  refDueDate: null,
  creditDays: 0,
  voucherDueDate: null,
  voucherType: "purchase",
  voucherTypeName: "Purchase Bill",
  voucherNumbers: new Set(["PB-1"]),
  ...o,
});

const ASOF = new Date("2026-06-30T18:29:59.999Z");
const age = (bills, ledgerSigned) =>
  svc.ageLedger(LEDGER, bills, { asOf: ASOF, ledgerSigned });

/* ── The sign, and what it means ─────────────────────────────────────────── */

test("an unpaid purchase bill is a POSITIVE payable, not a negative receivable", () => {
  const r = age([bill({ refDueDate: new Date("2026-05-01") })], -118000);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].remaining, 118000, "payables are shown as positive figures");
  assert.equal(r.rows[0].bucket, "d31_60");
  assert.equal(r.party.agedTotal, 118000);
  assert.equal(r.party.buckets.d31_60, 118000);
  assert.equal(r.party.reconciles, true);
});

test("the supplier reading is the exact mirror of the customer reading", () => {
  const remaining = -118000; // the same folded bill
  assert.equal(age([bill({ remaining })], remaining).party.agedTotal, 118000);
  // Read the customer way, that same bill is not a receivable at all.
  assert.equal(
    customer.ageLedger(LEDGER, [bill({ remaining })], { asOf: ASOF, ledgerSigned: remaining })
      .party.agedTotal,
    0,
  );
});

/* ── What each document does to the bill ─────────────────────────────────── */

test("a PARTIAL payment reduces the bill and the bill value is still shown", () => {
  // 1,18,000 billed, 50,000 paid → −118000 + 50000 = −68000.
  const r = age([bill({ remaining: -68000, refDueDate: new Date("2026-05-01") })], -68000);
  assert.equal(r.rows[0].remaining, 68000);
  assert.equal(r.rows[0].originalAmount, 118000);
});

test("SEVERAL payments against one bill all reduce it", () => {
  const r = age([bill({ remaining: -43000, refDueDate: new Date("2026-05-01") })], -43000);
  assert.equal(r.party.agedTotal, 43000);
});

test("a DEBIT NOTE reduces the bill the same way a payment does", () => {
  const r = age([bill({ remaining: -100000, refDueDate: new Date("2026-05-01") })], -100000);
  assert.equal(r.rows[0].remaining, 100000);
});

test("a FULLY settled bill is not aged at all", () => {
  const r = age([bill({ remaining: 0, refDueDate: new Date("2026-05-01") })], 0);
  assert.deepEqual(r.rows, []);
  assert.equal(r.party.agedTotal, 0);
  assert.equal(r.party.openBillCount, 0);
});

test("rounding dust does not keep a bill open", () => {
  assert.deepEqual(age([bill({ remaining: -0.005 })], -0.005).rows, []);
});

test("OVERPAYING a bill becomes a bill ADVANCE, never a negative payable", () => {
  // 1,00,000 billed, 1,30,000 paid → −100000 + 130000 = +30000.
  const r = age([bill({ remaining: 30000, refDueDate: new Date("2026-05-01") })], 30000);
  assert.deepEqual(r.rows, [], "an advance is not an age");
  assert.equal(r.party.billAdvances, 30000);
  assert.equal(r.party.billOpposite, 30000, "the party-neutral alias agrees");
  assert.equal(r.party.agedTotal, 0);
  for (const k of svc.BUCKET_KEYS) assert.equal(r.party.buckets[k], 0);
  assert.equal(r.party.reconciles, true);
});

test("several bills land in several buckets and are not merged", () => {
  const r = age(
    [
      bill({ billName: "PB-1", refDueDate: new Date("2026-06-20"), remaining: -10000 }),
      bill({ billName: "PB-2", refDueDate: new Date("2026-05-20"), remaining: -20000 }),
      bill({ billName: "PB-3", refDueDate: new Date("2026-01-01"), remaining: -30000 }),
      bill({ billName: "PB-4", refDueDate: new Date("2026-08-01"), remaining: -40000 }),
      bill({ billName: "PB-5", remaining: -50000 }), // undated
    ],
    -150000,
  );
  assert.equal(r.party.buckets.d1_30, 10000);
  assert.equal(r.party.buckets.d31_60, 20000);
  assert.equal(r.party.buckets.d90plus, 30000);
  assert.equal(r.party.buckets.notYetDue, 40000);
  assert.equal(r.party.buckets.unknown, 50000);
  assert.equal(r.party.agedTotal, 150000);
  assert.equal(r.party.undatedBillCount, 1);
  assert.equal(r.party.reconciles, true);
});

/* ── Opening balances and unallocated money ──────────────────────────────── */

test("an opening Cr balance no bill explains is an unallocated PAYABLE", () => {
  // Ledger 80,000 Cr; only 50,000 of it is bill-wise.
  const r = age([bill({ remaining: -50000, refDueDate: new Date("2026-05-01") })], -80000);
  assert.equal(r.party.agedTotal, 50000);
  assert.equal(r.party.unallocatedPayable, 30000);
  assert.equal(r.party.unallocatedAdvance, 0);
  assert.equal(r.party.unallocatedPrimary, 30000, "party-neutral alias");
  assert.equal(r.party.ledgerBalanceType, "Cr");
  assert.equal(r.party.ledgerOwed, 80000, "positive: this is what we owe");
  assert.equal(r.party.reconciles, true);
});

test("an on-account PAYMENT is an unallocated advance and does not reduce a bucket", () => {
  // PB-1 open at 1,00,000; 3,00,000 paid on account.
  // Ledger = −100000 + 300000 = +200000 → we are 2,00,000 in advance.
  const r = age([bill({ remaining: -100000, refDueDate: new Date("2026-05-01") })], 200000);
  assert.equal(r.party.agedTotal, 100000, "the bill is still overdue");
  assert.equal(r.party.buckets.d31_60, 100000);
  assert.equal(r.party.unallocatedAdvance, 300000);
  assert.equal(r.party.unallocatedPayable, 0);
  assert.equal(r.party.ledgerBalanceType, "Dr");
  assert.equal(r.party.ledgerOwed, -200000);
  assert.equal(r.party.reconciles, true);
});

test("the identity holds for every combination of the three components", () => {
  const combos = [
    { bills: [bill({ remaining: -100000, refDueDate: new Date("2026-05-01") })], ledger: -100000 },
    { bills: [bill({ remaining: -100000, refDueDate: new Date("2026-05-01") })], ledger: -130000 },
    { bills: [bill({ remaining: -100000, refDueDate: new Date("2026-05-01") })], ledger: -70000 },
    { bills: [bill({ remaining: 5000 })], ledger: 5000 },
    { bills: [bill({ remaining: 5000 })], ledger: 25000 },
    { bills: [], ledger: -42000 },
    { bills: [], ledger: 42000 },
    { bills: [], ledger: 0 },
  ];
  for (const { bills, ledger } of combos) {
    const p = age(bills, ledger).party;
    assert.ok(
      Math.abs(p.agedTotal - p.billOpposite + p.unallocatedSigned - p.ledgerOwed) < 0.02,
      `aged ${p.agedTotal} − advances ${p.billOpposite} + unallocated ${p.unallocatedSigned} ≠ owed ${p.ledgerOwed}`,
    );
    assert.equal(p.reconciles, true);
  }
});

/* ── Totals ──────────────────────────────────────────────────────────────── */

test("a supplier we have overpaid does NOT reduce what we owe the others", () => {
  const owed = age([bill({ remaining: -500000, refDueDate: new Date("2026-05-01") })], -500000).party;
  const prepaid = age([], 400000).party;
  const t = svc.totalsOf([owed, prepaid]);

  assert.equal(t.agedTotal, 500000);
  assert.equal(t.buckets.d31_60, 500000);
  assert.equal(t.unallocatedAdvance, 400000);
  /* Clamped PER LEDGER, exactly as the Supplier Outstanding Summary clamps
   * it — these two are what the tie-out compares. */
  assert.equal(t.ledgerPayable, 500000);
  assert.equal(t.ledgerAdvance, 400000);
  assert.equal(t.ledgerPrimary, t.ledgerPayable, "party-neutral alias");
  assert.notEqual(t.ledgerPayable, t.ledgerPayable - t.ledgerAdvance);
});

test("the totals carry supplier names, not customer ones", () => {
  const t = svc.totalsOf([age([bill({ remaining: -1000 })], -1000).party]);
  assert.ok("billAdvances" in t);
  assert.ok("unallocatedPayable" in t);
  assert.ok("ledgerPayable" in t);
  assert.ok(!("billCredits" in t));
  assert.ok(!("ledgerReceivable" in t));
});

test("a supplier code is a VEN- code", () => {
  const r = age([bill({ remaining: -1000 })], -1000);
  assert.match(r.party.code, /^VEN-[0-9A-F]{6}$/);
});

/* ── The applied-filters line ────────────────────────────────────────────── */

test("the filter line speaks supplier, and never claims a balanceSide", () => {
  const s = svc.describeFilters({ scope: "all", balanceSide: "credit", minOutstanding: 5000 }, {});
  assert.match(s, /all accounting suppliers/);
  assert.match(s, /Minimum aged payable: ₹5,000/);
  assert.match(s, /Ageing: by due date/);
  assert.ok(!/Balances:/.test(s), "a bill has no Dr/Cr side to filter on");
  assert.ok(!/receivable/i.test(s));
});

test("the customer filter line is untouched by any of this", () => {
  const s = customer.describeFilters({ scope: "all", minOutstanding: 5000 }, {});
  assert.match(s, /all accounting customers/);
  assert.match(s, /Minimum aged receivable: ₹5,000/);
  assert.match(s, /undated bills shown separately/);
});

/* ── The two reports share one bucket definition ─────────────────────────── */

test("both kinds use the same buckets, in the same order", () => {
  assert.deepEqual(svc.BUCKET_KEYS, customer.BUCKET_KEYS);
  assert.deepEqual(
    svc.AGEING_BUCKETS.map((b) => b.label),
    ["Not yet due", "1–30 days", "31–60 days", "61–90 days", "90+ days", "Date unavailable"],
  );
});

test("both kinds resolve due dates by the same rules", () => {
  const b = bill({ refDueDate: new Date("2026-05-01"), voucherDueDate: new Date("2026-07-01") });
  assert.deepEqual(svc.resolveDueDate(b), customer.resolveDueDate(b));
  assert.equal(svc.resolveDueDate(bill({ creditDays: 0 })).source, "none");
});
