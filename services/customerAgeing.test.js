// services/customerAgeing.test.js
//
// DUE DATES, BUCKETS, AND THE RECONCILIATION IDENTITY.
//
// Three things decide whether an ageing report is evidence or decoration:
// where the due date came from, which side of a bucket boundary a bill falls,
// and whether the buckets plus the disclosures add back to the ledger. All
// three are pure, and all three are here.
//
// The database-facing behaviour — company scoping, spoofed ids, as-of
// cut-offs, partial receipts through real vouchers, and the tie-out to the
// Customer Outstanding Summary — lives in
// test/accountant/customer-ageing.route.test.js.
//
// Run by `npm test` — node --test "services/**/*.test.js".

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const ageing = require("./customerAgeing.service");

const LEDGER = { _id: "6650a1b2c3d4e5f6010203a1", name: "Acme Exports", gstin: "27AAAAA0000A1Z5" };

/** A folded bill, as `openItems.foldAllocations` produces one. */
const bill = (o = {}) => ({
  ledgerId: String(LEDGER._id),
  billName: "INV-1",
  originalAmount: 100000,
  remaining: 100000,
  firstVoucherDate: new Date("2026-04-01"),
  dueDate: null,
  creditDays: 0,
  voucherDueDate: null,
  voucherType: "sales",
  voucherTypeName: "Tax Invoice",
  voucherNumbers: new Set(["INV-1"]),
  ...o,
});

const ASOF = new Date("2026-06-30T18:29:59.999Z"); // 30 Jun 2026, end of day IST

/* ── Due-date precedence ─────────────────────────────────────────────────── */

test("the bill allocation's own due date wins over everything", () => {
  const r = ageing.resolveDueDate(
    bill({
      dueDate: new Date("2026-05-01"),
      voucherDueDate: new Date("2026-07-01"),
      creditDays: 90,
    }),
  );
  assert.equal(r.source, "allocation");
  assert.equal(r.dueDate.toISOString().slice(0, 10), "2026-05-01");
});

test("the voucher header's due date is used when the allocation has none", () => {
  const r = ageing.resolveDueDate(bill({ voucherDueDate: new Date("2026-07-01"), creditDays: 90 }));
  assert.equal(r.source, "voucher");
  assert.equal(r.dueDate.toISOString().slice(0, 10), "2026-07-01");
});

test("invoice date plus EXPLICIT credit days is the third choice", () => {
  const r = ageing.resolveDueDate(
    bill({ firstVoucherDate: new Date("2026-04-01"), creditDays: 45 }),
  );
  assert.equal(r.source, "creditDays");
  assert.equal(r.dueDate.toISOString().slice(0, 10), "2026-05-16");
});

test("ZERO credit days is 'unset', not 'due on receipt' — no date is invented", () => {
  // 0 is the schema default on every allocation. Reading it as due-on-receipt
  // would date every undated bill from its invoice and manufacture a 90+
  // balance out of a data gap.
  const r = ageing.resolveDueDate(bill({ creditDays: 0 }));
  assert.equal(r.source, "none");
  assert.equal(r.dueDate, null);
});

test("a negative or non-numeric creditDays yields no date either", () => {
  assert.equal(ageing.resolveDueDate(bill({ creditDays: -30 })).source, "none");
  assert.equal(ageing.resolveDueDate(bill({ creditDays: "soon" })).source, "none");
});

test("credit days with no invoice date yields no date", () => {
  assert.equal(
    ageing.resolveDueDate(bill({ firstVoucherDate: null, creditDays: 30 })).source,
    "none",
  );
});

test("an unparseable stored date is treated as absent, not as 1970", () => {
  assert.equal(ageing.resolveDueDate(bill({ dueDate: "not-a-date" })).source, "none");
});

/* ── Bucket boundaries ───────────────────────────────────────────────────── */

const at = (dueIso) => ageing.ageOf(new Date(dueIso), ASOF);

test("a bill due AFTER the as-of date is not yet due", () => {
  assert.equal(at("2026-07-15").bucket, "notYetDue");
  assert.equal(at("2026-07-15").daysOverdue, 0);
});

test("a bill due ON the as-of date is NOT overdue — the first overdue day is the next one", () => {
  assert.equal(at("2026-06-30").bucket, "notYetDue");
  assert.equal(at("2026-06-30").daysOverdue, 0);
});

test("one day past due is the 1–30 bucket", () => {
  assert.equal(at("2026-06-29").bucket, "d1_30");
  assert.equal(at("2026-06-29").daysOverdue, 1);
});

test("every bucket boundary falls on the documented side", () => {
  const cases = [
    ["2026-06-29", "d1_30", 1],
    ["2026-05-31", "d1_30", 30],
    ["2026-05-30", "d31_60", 31],
    ["2026-05-01", "d31_60", 60],
    ["2026-04-30", "d61_90", 61],
    ["2026-04-01", "d61_90", 90],
    ["2026-03-31", "d90plus", 91],
  ];
  for (const [due, bucket, days] of cases) {
    const r = at(due);
    assert.equal(r.bucket, bucket, `${due} → ${bucket}`);
    assert.equal(r.daysOverdue, days, `${due} → ${days} days`);
  }
});

test("no due date is 'Date unavailable', never a number of days", () => {
  const r = ageing.ageOf(null, ASOF);
  assert.equal(r.bucket, "unknown");
  assert.equal(r.daysOverdue, null);
});

test("the age is computed in business days, so a UTC-midnight due date does not round early", () => {
  // The due date is stored at UTC midnight; the as-of is 23:59:59.999 IST.
  // A naive millisecond subtraction makes these 0.77 of a day apart.
  assert.equal(ageing.ageOf(new Date("2026-06-30T00:00:00.000Z"), ASOF).daysOverdue, 0);
});

test("the six buckets are exactly the ones the report promises, in order", () => {
  assert.deepEqual(ageing.BUCKET_KEYS, [
    "notYetDue",
    "d1_30",
    "d31_60",
    "d61_90",
    "d90plus",
    "unknown",
  ]);
  assert.deepEqual(
    ageing.AGEING_BUCKETS.map((b) => b.label),
    ["Not yet due", "1–30 days", "31–60 days", "61–90 days", "90+ days", "Date unavailable"],
  );
});

/* ── Ageing one ledger ───────────────────────────────────────────────────── */

const age = (bills, ledgerSigned) =>
  ageing.ageLedger(LEDGER, bills, { asOf: ASOF, ledgerSigned });

test("an open invoice is aged into its bucket at its remaining amount", () => {
  const r = age([bill({ dueDate: new Date("2026-05-01"), remaining: 100000 })], 100000);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].bucket, "d31_60");
  assert.equal(r.rows[0].remaining, 100000);
  assert.equal(r.party.buckets.d31_60, 100000);
  assert.equal(r.party.agedTotal, 100000);
  assert.equal(r.party.reconciles, true);
});

test("a partially received invoice ages only what is left", () => {
  // 1,00,000 invoiced, 40,000 received against it.
  const r = age([bill({ dueDate: new Date("2026-05-01"), remaining: 60000 })], 60000);
  assert.equal(r.rows[0].remaining, 60000);
  assert.equal(r.rows[0].originalAmount, 100000, "the invoice value is still shown");
  assert.equal(r.party.agedTotal, 60000);
});

test("a fully settled invoice is not aged at all", () => {
  const r = age([bill({ dueDate: new Date("2026-05-01"), remaining: 0 })], 0);
  assert.deepEqual(r.rows, []);
  assert.equal(r.party.agedTotal, 0);
  assert.equal(r.party.openBillCount, 0);
});

test("rounding dust does not keep a bill open", () => {
  const r = age([bill({ dueDate: new Date("2026-05-01"), remaining: 0.005 })], 0.005);
  assert.deepEqual(r.rows, []);
});

test("an OVER-settled invoice is a bill credit, never a negative age", () => {
  const r = age([bill({ dueDate: new Date("2026-05-01"), remaining: -7000 })], -7000);
  assert.deepEqual(r.rows, [], "a credit is not an age");
  assert.equal(r.party.billCredits, 7000);
  assert.equal(r.party.agedTotal, 0);
  for (const k of ageing.BUCKET_KEYS) assert.equal(r.party.buckets[k], 0);
  assert.equal(r.party.reconciles, true);
});

test("several invoices land in several buckets and are not merged", () => {
  const r = age(
    [
      bill({ billName: "INV-1", dueDate: new Date("2026-06-20"), remaining: 10000 }),
      bill({ billName: "INV-2", dueDate: new Date("2026-05-20"), remaining: 20000 }),
      bill({ billName: "INV-3", dueDate: new Date("2026-01-01"), remaining: 30000 }),
      bill({ billName: "INV-4", dueDate: new Date("2026-08-01"), remaining: 40000 }),
      bill({ billName: "INV-5", remaining: 50000 }), // undated
    ],
    150000,
  );
  assert.equal(r.rows.length, 5);
  assert.equal(r.party.buckets.d1_30, 10000);
  assert.equal(r.party.buckets.d31_60, 20000);
  assert.equal(r.party.buckets.d90plus, 30000);
  assert.equal(r.party.buckets.notYetDue, 40000);
  assert.equal(r.party.buckets.unknown, 50000);
  assert.equal(r.party.agedTotal, 150000);
  assert.equal(r.party.undatedBillCount, 1);
  assert.equal(r.party.reconciles, true);
});

/* ── Unallocated, and the reconciliation identity ────────────────────────── */

test("an opening balance no bill explains is disclosed as unallocated, not aged", () => {
  // Ledger is 80,000 Dr; only 50,000 of it is bill-wise.
  const r = age([bill({ dueDate: new Date("2026-05-01"), remaining: 50000 })], 80000);
  assert.equal(r.party.agedTotal, 50000);
  assert.equal(r.party.unallocatedReceivable, 30000);
  assert.equal(r.party.unallocatedCredit, 0);
  assert.equal(r.party.reconciles, true);
});

test("an on-account advance is disclosed as an unallocated CREDIT, never netted off a bucket", () => {
  // INV-1 open at 1,00,000; a 3,00,000 advance sits on account.
  // Ledger = 1,00,000 − 3,00,000 = −2,00,000 (the customer is in credit).
  const r = age([bill({ dueDate: new Date("2026-05-01"), remaining: 100000 })], -200000);
  assert.equal(r.party.agedTotal, 100000, "the invoice is still overdue");
  assert.equal(r.party.buckets.d31_60, 100000);
  assert.equal(r.party.unallocatedCredit, 300000);
  assert.equal(r.party.unallocatedReceivable, 0);
  assert.equal(r.party.ledgerBalanceType, "Cr");
  assert.equal(r.party.ledgerBalance, 200000);
  assert.equal(r.party.reconciles, true, "aged − credits + unallocated = ledger");
});

test("the identity holds for every combination of the three components", () => {
  const combos = [
    { bills: [bill({ remaining: 100000, dueDate: new Date("2026-05-01") })], ledger: 100000 },
    { bills: [bill({ remaining: 100000, dueDate: new Date("2026-05-01") })], ledger: 130000 },
    { bills: [bill({ remaining: 100000, dueDate: new Date("2026-05-01") })], ledger: 70000 },
    { bills: [bill({ remaining: -5000 })], ledger: -5000 },
    { bills: [bill({ remaining: -5000 })], ledger: -25000 },
    { bills: [], ledger: 42000 },
    { bills: [], ledger: -42000 },
    { bills: [], ledger: 0 },
  ];
  for (const { bills, ledger } of combos) {
    const p = age(bills, ledger).party;
    assert.ok(
      Math.abs(p.agedTotal - p.billCredits + p.unallocatedSigned - p.ledgerSigned) < 0.02,
      `aged ${p.agedTotal} − credits ${p.billCredits} + unallocated ${p.unallocatedSigned} ≠ ledger ${p.ledgerSigned}`,
    );
    assert.equal(p.reconciles, true);
  }
});

test("a settled bill still counts toward the reconciliation, so it cannot create a phantom unallocated", () => {
  // INV-1 raised and fully received; the ledger nets to zero. If the fold's
  // zero remainder were skipped in the reconciliation, unallocated would be 0
  // here too — but only by luck. The signed sum has to include it.
  const r = age([bill({ remaining: 0, dueDate: new Date("2026-05-01") })], 0);
  assert.equal(r.party.unallocatedSigned, 0);
  assert.equal(r.party.reconciles, true);
});

/* ── Totals ──────────────────────────────────────────────────────────────── */

test("totals sum the buckets and keep the disclosures apart", () => {
  const owed = age([bill({ remaining: 100000, dueDate: new Date("2026-05-01") })], 100000).party;
  const inCredit = age([], -40000).party;
  const t = ageing.totalsOf([owed, inCredit]);

  assert.equal(t.partyCount, 2);
  assert.equal(t.buckets.d31_60, 100000);
  assert.equal(t.agedTotal, 100000);
  assert.equal(t.unallocatedCredit, 40000);
  /* Clamped PER LEDGER, exactly as the Outstanding Summary clamps it — these
   * two are what the tie-out compares. */
  assert.equal(t.ledgerReceivable, 100000);
  assert.equal(t.ledgerCredit, 40000);
  assert.notEqual(t.ledgerReceivable, t.ledgerReceivable - t.ledgerCredit);
});

test("a customer in credit never reduces the aged receivable total", () => {
  const owed = age([bill({ remaining: 500000, dueDate: new Date("2026-05-01") })], 500000).party;
  const inCredit = age([], -400000).party;
  const t = ageing.totalsOf([owed, inCredit]);
  assert.equal(t.agedTotal, 500000);
  assert.equal(t.buckets.d31_60, 500000);
  assert.equal(t.ledgerReceivable, 500000, "the clamp is per ledger, so credits do not net in");
});

/* ── The applied-filters line ────────────────────────────────────────────── */

test("the filter line says the report ages by due date and discloses undated bills", () => {
  const s = ageing.describeFilters({ scope: "all" }, {});
  assert.match(s, /all accounting customers/);
  assert.match(s, /Ageing: by due date/);
  assert.match(s, /undated bills shown separately/);
});

test("the filter line does NOT claim a balanceSide it cannot honour", () => {
  const s = ageing.describeFilters({ scope: "all", balanceSide: "credit" }, {});
  assert.ok(!/Balances:/.test(s), "a bill has no Dr/Cr side to filter on");
});

test("an id scope does not claim the screen's search either", () => {
  const s = ageing.describeFilters(
    { scope: "filtered", search: "acme", restrictToIds: true },
    { resolvedCount: 4 },
  );
  assert.match(s, /current filtered result \(4\)/);
  assert.ok(!/acme/.test(s));
});

test("the minimum is described as a threshold on the AGED receivable", () => {
  const s = ageing.describeFilters({ scope: "all", minOutstanding: 5000 }, {});
  assert.match(s, /Minimum aged receivable: ₹5,000/);
});
