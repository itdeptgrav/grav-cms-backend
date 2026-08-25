const test = require("node:test");
const assert = require("node:assert/strict");
const {
  foldAllocations,
  countUnnamed,
  isOpen,
  summariseByLedger,
  SETTLED_TOLERANCE,
} = require("./openItems.service");

const L1 = "aaaaaaaaaaaaaaaaaaaaaaa1";
const L2 = "aaaaaaaaaaaaaaaaaaaaaaa2";

const alloc = (o = {}) => ({
  ledgerId: L1,
  billName: "INV-1",
  amount: 1000,
  billType: "new_ref",
  entryType: "Dr",
  voucherDate: "2026-04-01T00:00:00.000Z",
  ...o,
});

const fold = (rows) => foldAllocations(rows);
const one = (rows, key = `${L1}||INV-1`) => fold(rows).get(key);

/* ── The signed fold ─────────────────────────────────────────────────────── */

test("a lone invoice is outstanding for its full amount", () => {
  const b = one([alloc()]);
  assert.equal(b.remaining, 1000);
  assert.equal(b.originalAmount, 1000);
  assert.equal(isOpen(b), true);
});

test("a settlement against the bill reduces what remains", () => {
  const b = one([alloc(), alloc({ billType: "agst_ref", entryType: "Cr", amount: 400 })]);
  assert.equal(b.remaining, 600);
  assert.equal(isOpen(b), true);
});

test("a fully settled bill is NOT open", () => {
  const b = one([alloc(), alloc({ billType: "agst_ref", entryType: "Cr", amount: 1000 })]);
  assert.equal(b.remaining, 0);
  assert.equal(isOpen(b), false);
});

test("only new_ref builds the original amount — settlements do not inflate it", () => {
  const b = one([alloc(), alloc({ billType: "agst_ref", entryType: "Cr", amount: 400 })]);
  assert.equal(b.originalAmount, 1000);
});

test("a bill spanning several vouchers folds into ONE item", () => {
  const bills = fold([
    alloc(),
    alloc({ billType: "agst_ref", entryType: "Cr", amount: 300 }),
    alloc({ billType: "agst_ref", entryType: "Cr", amount: 200 }),
  ]);
  assert.equal(bills.size, 1);
  assert.equal([...bills.values()][0].remaining, 500);
});

test("an over-payment leaves a credit balance, which is still open", () => {
  const b = one([alloc(), alloc({ billType: "agst_ref", entryType: "Cr", amount: 1500 })]);
  assert.equal(b.remaining, -500);
  assert.equal(isOpen(b), true, "money owed back is outstanding too");
});

/* ── Tolerance ───────────────────────────────────────────────────────────── */

test("rounding dust under a rupee is settled, not an open bill", () => {
  const b = one([alloc({ amount: 1000 }), alloc({ billType: "agst_ref", entryType: "Cr", amount: 999.5 })]);
  assert.ok(Math.abs(b.remaining) <= SETTLED_TOLERANCE);
  assert.equal(isOpen(b), false);
});

test("a real two-rupee balance is NOT swallowed by the tolerance", () => {
  const b = one([alloc({ amount: 1000 }), alloc({ billType: "agst_ref", entryType: "Cr", amount: 998 })]);
  assert.equal(isOpen(b), true);
});

/* ── Bad input never throws ──────────────────────────────────────────────── */

test("allocations with no bill name are skipped, not crashed on", () => {
  const bills = fold([alloc(), alloc({ billName: null }), alloc({ billName: "" })]);
  assert.equal(bills.size, 1);
});

test("unnamed allocations are countable — the blind spot is measurable", () => {
  assert.equal(countUnnamed([alloc(), alloc({ billName: null }), alloc({ billName: "" })]), 2);
});

test("a null or missing amount is zero, not NaN", () => {
  const b = one([alloc({ amount: null }), alloc({ amount: undefined })]);
  assert.equal(b.remaining, 0);
  assert.ok(Number.isFinite(b.remaining));
});

test("holes in the row array are ignored", () => {
  assert.equal(fold([null, undefined, alloc()]).size, 1);
});

test("an empty input yields an empty map, never a throw", () => {
  assert.equal(fold([]).size, 0);
  assert.equal(fold(undefined).size, 0);
});

test("a missing voucher date does not become the epoch", () => {
  const b = one([alloc({ voucherDate: null })]);
  assert.equal(b.firstVoucherDate, null);
});

test("the earliest voucher date wins as the bill's first date", () => {
  const b = one([
    alloc({ voucherDate: "2026-06-01T00:00:00.000Z" }),
    alloc({ billType: "agst_ref", entryType: "Cr", amount: 1, voucherDate: "2026-01-01T00:00:00.000Z" }),
  ]);
  assert.equal(b.firstVoucherDate, "2026-01-01T00:00:00.000Z");
});

/* ── Per-ledger summary ──────────────────────────────────────────────────── */

test("receivable and payable are kept APART, never netted", () => {
  const s = summariseByLedger(
    fold([
      alloc({ billName: "INV-A", amount: 500000 }),                       // Dr → owed to us
      alloc({ billName: "BILL-B", amount: 500000, entryType: "Cr" }),     // Cr → we owe
    ]),
  ).get(L1);
  assert.equal(s.openItemCount, 2);
  assert.equal(s.receivable, 500000);
  assert.equal(s.payable, 500000);
});

test("two ledgers do not bleed into each other", () => {
  const s = summariseByLedger(fold([alloc(), alloc({ ledgerId: L2, billName: "INV-9", amount: 250 })]));
  assert.equal(s.get(L1).receivable, 1000);
  assert.equal(s.get(L2).receivable, 250);
});

test("the same bill name under two parties stays two separate bills", () => {
  const bills = fold([alloc({ billName: "INV-1" }), alloc({ ledgerId: L2, billName: "INV-1" })]);
  assert.equal(bills.size, 2, "bills are keyed by ledger AND name");
});

test("settled bills contribute no count and no amount", () => {
  const s = summariseByLedger(
    fold([alloc(), alloc({ billType: "agst_ref", entryType: "Cr", amount: 1000 })]),
  ).get(L1);
  assert.equal(s.openItemCount, 0);
  assert.equal(s.receivable, 0);
  assert.equal(s.payable, 0);
});

test("a ledger with only unnamed allocations still gets a row", () => {
  const s = summariseByLedger(new Map(), new Map([[L1, 4]])).get(L1);
  assert.equal(s.openItemCount, 0);
  assert.equal(s.unnamedAllocations, 4, "so the UI can say 'no bill-wise data', not 'nothing owed'");
});

test("the oldest open bill's date surfaces on the summary", () => {
  const s = summariseByLedger(
    fold([
      alloc({ billName: "OLD", voucherDate: "2025-07-17T00:00:00.000Z" }),
      alloc({ billName: "NEW", voucherDate: "2026-08-01T00:00:00.000Z" }),
    ]),
  ).get(L1);
  assert.equal(s.oldestOpenDate, "2025-07-17T00:00:00.000Z");
});

test("a settled bill does not set the oldest-open date", () => {
  const s = summariseByLedger(
    fold([
      alloc({ billName: "SETTLED", voucherDate: "2020-01-01T00:00:00.000Z" }),
      alloc({ billName: "SETTLED", billType: "agst_ref", entryType: "Cr", amount: 1000, voucherDate: "2020-02-01T00:00:00.000Z" }),
      alloc({ billName: "OPEN", voucherDate: "2026-05-01T00:00:00.000Z" }),
    ]),
  ).get(L1);
  assert.equal(s.oldestOpenDate, "2026-05-01T00:00:00.000Z");
});

/* ── C0-A is visibility only ─────────────────────────────────────────────── */

test("no due date is INVENTED when the source never carried one (C0-D: reading is not deriving)", () => {
  // foldAllocations now READS a dueDate straight off the row when present
  // (the ledger-detail statement needs this), but it must never FABRICATE
  // one. Absent on input ⇒ falsy on output, never a real Date.
  const b = one([alloc()]);
  assert.ok(!b.dueDate, "no dueDate on the source row means no dueDate on the bill");
  // The per-LEDGER summary (parties list) has no concept of a due date at
  // all — that's a per-BILL detail, not something a ledger-level rollup
  // could meaningfully carry.
  const s = summariseByLedger(fold([alloc()])).get(L1);
  assert.equal("dueDate" in s, false);
});

/* ── C0-D: dueDate/creditDays/voucherCount capture (foldAllocations) ─────── */

const { agedBillsForLedger, LEDGER_DETAIL_SETTLED_THRESHOLD } = require("./openItems.service");

const allocWithBill = (o = {}) => ({
  ledgerId: L1,
  billName: "INV-1",
  amount: 1000,
  billType: "new_ref",
  entryType: "Dr",
  voucherDate: "2026-04-01T00:00:00.000Z",
  voucherNumber: "SV-1",
  ...o,
});

test("dueDate/creditDays are captured from the FIRST row for a bill, never updated by later rows", () => {
  const b = one([
    allocWithBill({ dueDate: "2026-05-01T00:00:00.000Z", creditDays: 30 }),
    allocWithBill({
      billType: "agst_ref",
      entryType: "Cr",
      amount: 200,
      dueDate: "2026-09-09T00:00:00.000Z", // a LATER row claiming a different date
      creditDays: 90,
      voucherNumber: "RC-1",
    }),
  ]);
  assert.equal(new Date(b.dueDate).toISOString().slice(0, 10), "2026-05-01");
  assert.equal(b.creditDays, 30);
});

test("creditDays defaults to 0 at creation when the first row carries none", () => {
  const b = one([allocWithBill({ creditDays: undefined })]);
  assert.equal(b.creditDays, 0);
});

test("voucherNumbers accumulate every distinct voucher touching the bill", () => {
  const b = one([
    allocWithBill({ voucherNumber: "SV-1" }),
    allocWithBill({ billType: "agst_ref", entryType: "Cr", amount: 100, voucherNumber: "RC-1" }),
    allocWithBill({ billType: "agst_ref", entryType: "Cr", amount: 100, voucherNumber: "RC-1" }), // same voucher twice
  ]);
  assert.equal(b.voucherNumbers.size, 2, "RC-1 counted once despite two allocation rows");
});

test("a row with no voucherNumber does not add to the set", () => {
  const b = one([allocWithBill({ voucherNumber: undefined })]);
  assert.equal(b.voucherNumbers.size, 0);
});

/* ── C0-D: agedBillsForLedger — the migrated ledger-detail aging logic ───── */

const ASOF = new Date("2026-08-24T00:00:00.000Z");

function billFixture(o = {}) {
  return {
    ledgerId: L1,
    billName: "INV-1",
    originalAmount: 1000,
    remaining: 1000,
    firstVoucherDate: "2026-07-01T00:00:00.000Z",
    dueDate: null,
    creditDays: 0,
    voucherNumbers: new Set(["SV-1"]),
    ...o,
  };
}

test("agedBillsForLedger: settled bills (< ₹0.01) are excluded — the TIGHTER ledger-detail threshold", () => {
  const r = agedBillsForLedger([billFixture({ remaining: 0.005 })], { asOf: ASOF, closingBalance: 0 });
  assert.equal(r.bills.filter((b) => b.billName === "INV-1").length, 0);
});

test("agedBillsForLedger: a bill just at/above the threshold IS included", () => {
  const r = agedBillsForLedger([billFixture({ remaining: 0.02 })], { asOf: ASOF, closingBalance: 0.02 });
  assert.equal(r.bills.filter((b) => b.billName === "INV-1").length, 1);
});

test("agedBillsForLedger: this ₹0.01 threshold is deliberately tighter than the shared ₹1 SETTLED_TOLERANCE", () => {
  // A bill the parties-list summary would call SETTLED (well under ₹1) still
  // shows on the ledger-detail statement — that is the pre-existing,
  // preserved inconsistency, not a bug this migration introduces.
  assert.equal(LEDGER_DETAIL_SETTLED_THRESHOLD, 0.01);
  assert.ok(LEDGER_DETAIL_SETTLED_THRESHOLD < SETTLED_TOLERANCE);
  const r = agedBillsForLedger([billFixture({ remaining: 0.5 })], { asOf: ASOF, closingBalance: 0.5 });
  assert.equal(r.bills.filter((b) => b.billName === "INV-1").length, 1, "open on ledger-detail");
});

test("agedBillsForLedger: daysOverdue computed from dueDate when present", () => {
  const r = agedBillsForLedger(
    [billFixture({ dueDate: "2026-08-04T00:00:00.000Z" })], // 20 days before ASOF
    { asOf: ASOF, closingBalance: 1000 },
  );
  const bill = r.bills.find((b) => b.billName === "INV-1");
  assert.equal(bill.daysOverdue, 20);
});

test("agedBillsForLedger: falls back to firstVoucherDate minus creditDays when dueDate is absent", () => {
  // firstVoucherDate 2026-07-01, ASOF 2026-08-24 → 54 raw days, minus 10 credit days = 44
  const r = agedBillsForLedger(
    [billFixture({ dueDate: null, firstVoucherDate: "2026-07-01T00:00:00.000Z", creditDays: 10 })],
    { asOf: ASOF, closingBalance: 1000 },
  );
  const bill = r.bills.find((b) => b.billName === "INV-1");
  assert.equal(bill.daysOverdue, 44);
});

test("agedBillsForLedger: bucket boundaries — 0, 30, 60, 90 days", () => {
  const at = (days) =>
    agedBillsForLedger(
      [billFixture({ dueDate: new Date(ASOF.getTime() - days * 86400000).toISOString() })],
      { asOf: ASOF, closingBalance: 1000 },
    ).bills.find((b) => b.billName === "INV-1").bucket;

  assert.equal(at(0), "current");
  assert.equal(at(1), "0-30");
  assert.equal(at(30), "0-30");
  assert.equal(at(31), "31-60");
  assert.equal(at(60), "31-60");
  assert.equal(at(61), "61-90");
  assert.equal(at(90), "61-90");
  assert.equal(at(91), "90+");
});

test("agedBillsForLedger: voucherCount reflects distinct vouchers on the bill", () => {
  const r = agedBillsForLedger(
    [billFixture({ voucherNumbers: new Set(["SV-1", "RC-1", "RC-2"]) })],
    { asOf: ASOF, closingBalance: 1000 },
  );
  assert.equal(r.bills.find((b) => b.billName === "INV-1").voucherCount, 3);
});

test("agedBillsForLedger: reconciles a gap to the ledger's real closing balance with an Opening/Unallocated line", () => {
  // One open bill worth 1000 Dr, but the ledger's actual closing balance is
  // 1500 — the extra 500 (opening balance / unallocated entries) must appear.
  const r = agedBillsForLedger([billFixture({ remaining: 1000 })], {
    asOf: ASOF,
    closingBalance: 1500,
    fallbackFirstDate: "2025-04-01",
  });
  const unalloc = r.bills.find((b) => b.billName === "Opening / Unallocated");
  assert.ok(unalloc, "an unallocated line must appear to reconcile the gap");
  assert.equal(unalloc.remaining, 500);
  assert.equal(unalloc.remainingType, "Dr");
  assert.equal(unalloc.bucket, "current");
  assert.equal(unalloc.firstDate, "2025-04-01");
  assert.equal(r.buckets.current, 500);
});

test("agedBillsForLedger: no Unallocated line when the bills already reconcile exactly", () => {
  const r = agedBillsForLedger([billFixture({ remaining: 1000 })], { asOf: ASOF, closingBalance: 1000 });
  assert.equal(r.bills.some((b) => b.billName === "Opening / Unallocated"), false);
});

test("agedBillsForLedger: a non-number closingBalance reconciles to zero unallocated, not NaN", () => {
  const r = agedBillsForLedger([billFixture()], { asOf: ASOF, closingBalance: undefined });
  assert.equal(r.unallocated, 0);
  assert.equal(r.bills.some((b) => b.billName === "Opening / Unallocated"), false);
});

test("agedBillsForLedger: bills are sorted by daysOverdue, most overdue first", () => {
  const r = agedBillsForLedger(
    [
      billFixture({ billName: "NEW", dueDate: "2026-08-20T00:00:00.000Z" }), // 4 days
      billFixture({ billName: "OLD", dueDate: "2026-06-01T00:00:00.000Z" }), // ~84 days
    ],
    { asOf: ASOF, closingBalance: 2000 },
  );
  const names = r.bills.filter((b) => b.billName !== "Opening / Unallocated").map((b) => b.billName);
  assert.deepEqual(names, ["OLD", "NEW"]);
});

test("agedBillsForLedger: an empty bills array with a real balance still reconciles", () => {
  const r = agedBillsForLedger([], { asOf: ASOF, closingBalance: 300, fallbackFirstDate: null });
  assert.equal(r.bills.length, 1);
  assert.equal(r.bills[0].billName, "Opening / Unallocated");
});

test("agedBillsForLedger: holes in the bills array are ignored, not crashed on", () => {
  const r = agedBillsForLedger([null, undefined, billFixture()], { asOf: ASOF, closingBalance: 1000 });
  assert.equal(r.bills.filter((b) => b.billName === "INV-1").length, 1);
});

/* ── Golden parity: the full response shape survives the migration ──────── */

test("agedBillsForLedger response shape matches the pre-migration inline output exactly", () => {
  const r = agedBillsForLedger([billFixture({ dueDate: "2026-08-10T00:00:00.000Z" })], {
    asOf: ASOF,
    closingBalance: 1000,
  });
  const bill = r.bills.find((b) => b.billName === "INV-1");
  assert.deepEqual(Object.keys(bill).sort(), [
    "billName",
    "bucket",
    "creditDays",
    "daysOverdue",
    "dueDate",
    "firstDate",
    "originalAmount",
    "remaining",
    "remainingAbs",
    "remainingType",
    "voucherCount",
  ].sort());
  assert.deepEqual(Object.keys(r.buckets).sort(), ["0-30", "31-60", "61-90", "90+", "current"].sort());
});
