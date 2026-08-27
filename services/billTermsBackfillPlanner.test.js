const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BLOCKED_REASON,
  SOURCE,
  ALREADY_DATED_SOURCE,
  STATUS,
  planOne,
  planBackfill,
} = require("./billTermsBackfillPlanner.service");

const L1 = "aaaaaaaaaaaaaaaaaaaaaaa1";
const L2 = "aaaaaaaaaaaaaaaaaaaaaaa2";

const bill = (o = {}) => ({
  ledgerId: L1,
  billName: "INV-1",
  remaining: 1000,
  firstVoucherDate: "2026-04-01T00:00:00.000Z",
  dueDate: null,
  voucherDueDate: null,
  ...o,
});

const sidecar = (o = {}) => ({
  dueDate: "2026-05-01T00:00:00.000Z",
  source: SOURCE.PARTY_TERMS,
  creditDaysUsed: 30,
  basisDate: "2026-04-01T00:00:00.000Z",
  isManual: false,
  ...o,
});

/* ═══════════════════════════════════════════════════════════════════════
   Rung 1 — billAllocations[].dueDate
   ═══════════════════════════════════════════════════════════════════════ */

test("rung 1: a bill with a billAllocations dueDate is already_dated, source bill_allocation_due_date", () => {
  const r = planOne(bill({ dueDate: "2026-05-01T00:00:00.000Z" }), { partyCreditDays: 30 });
  assert.equal(r.status, STATUS.ALREADY_DATED);
  assert.equal(r.alreadyDatedSource, ALREADY_DATED_SOURCE.BILL_ALLOCATION_DUE_DATE);
  assert.equal(new Date(r.existingDueDate).toISOString().slice(0, 10), "2026-05-01");
  assert.equal(r.proposedDueDate, null);
});

test("rung 1 wins even when a sidecar row ALSO exists — the document's own date is more specific", () => {
  const r = planOne(bill({ dueDate: "2026-05-01T00:00:00.000Z" }), {
    partyCreditDays: 30,
    existingBillTerm: sidecar({ dueDate: "2026-09-09T00:00:00.000Z" }),
  });
  assert.equal(r.alreadyDatedSource, ALREADY_DATED_SOURCE.BILL_ALLOCATION_DUE_DATE);
});

/* ═══════════════════════════════════════════════════════════════════════
   Rung 2 — voucher header dueDate
   ═══════════════════════════════════════════════════════════════════════ */

test("rung 2: a voucher-header dueDate (no billAllocations date) is already_dated, source voucher_due_date", () => {
  const r = planOne(bill({ voucherDueDate: "2026-06-01T00:00:00.000Z" }), { partyCreditDays: 30 });
  assert.equal(r.status, STATUS.ALREADY_DATED);
  assert.equal(r.alreadyDatedSource, ALREADY_DATED_SOURCE.VOUCHER_DUE_DATE);
  assert.equal(new Date(r.existingDueDate).toISOString().slice(0, 10), "2026-06-01");
});

test("rung 2 outranks the sidecar", () => {
  const r = planOne(bill({ voucherDueDate: "2026-06-01T00:00:00.000Z" }), {
    existingBillTerm: sidecar(),
  });
  assert.equal(r.alreadyDatedSource, ALREADY_DATED_SOURCE.VOUCHER_DUE_DATE);
});

/* ═══════════════════════════════════════════════════════════════════════
   Rung 3 — the sidecar (Acc_BillTerms) — the actual bug fixed this turn
   ═══════════════════════════════════════════════════════════════════════ */

test("rung 3: an existing sidecar row that matches what current terms would derive is already_dated, not to_apply", () => {
  const r = planOne(bill(), {
    partyCreditDays: 30, // would derive 2026-05-01, exactly what the sidecar already says
    existingBillTerm: sidecar({ dueDate: "2026-05-01T00:00:00.000Z", source: SOURCE.PARTY_TERMS, creditDaysUsed: 30 }),
  });
  assert.equal(r.status, STATUS.ALREADY_DATED, "THIS is the bug this correction fixes — must not be to_apply");
  assert.equal(r.alreadyDatedSource, ALREADY_DATED_SOURCE.BILL_TERMS);
  assert.equal(r.source, SOURCE.PARTY_TERMS);
  assert.equal(r.creditDaysUsed, 30);
  assert.equal(r.alreadyBackfilled, true);
});

test("rung 3: a MANUAL sidecar row is ALWAYS already_dated, never re-evaluated against current terms, even on a mismatch", () => {
  const r = planOne(bill(), {
    partyCreditDays: 90, // would derive a COMPLETELY different date
    existingBillTerm: sidecar({ dueDate: "2026-12-25T00:00:00.000Z", source: "manual", creditDaysUsed: 1, isManual: true }),
  });
  assert.equal(r.status, STATUS.ALREADY_DATED);
  assert.equal(r.isManual, true);
  assert.equal(new Date(r.existingDueDate).toISOString().slice(0, 10), "2026-12-25", "the manual value, untouched");
});

test("rung 3: a NON-manual sidecar row that no longer matches (terms changed) becomes to_apply — a genuine change updates it", () => {
  const r = planOne(bill(), {
    partyCreditDays: 90, // would now derive a DIFFERENT date than what's stored
    existingBillTerm: sidecar({ dueDate: "2026-05-01T00:00:00.000Z", source: SOURCE.PARTY_TERMS, creditDaysUsed: 30, isManual: false }),
  });
  assert.equal(r.status, STATUS.TO_APPLY);
  assert.equal(r.source, SOURCE.PARTY_TERMS);
  assert.equal(r.creditDaysUsed, 90);
  assert.equal(r.proposedDueDate.toISOString().slice(0, 10), "2026-06-30");
  assert.equal(r.alreadyBackfilled, true, "still flagged — a sidecar row existed, it's just being updated");
});

test("rung 3: source changing (party terms replacing a company-default-derived row) also counts as a genuine change", () => {
  const r = planOne(bill(), {
    partyCreditDays: 20, // party now has terms; the sidecar was derived from the company default
    companyDefaultCreditDays: 45,
    existingBillTerm: sidecar({ dueDate: "2026-05-16T00:00:00.000Z", source: SOURCE.COMPANY_DEFAULT, creditDaysUsed: 45, isManual: false }),
  });
  assert.equal(r.status, STATUS.TO_APPLY);
  assert.equal(r.source, SOURCE.PARTY_TERMS);
});

test("rung 3: a non-manual sidecar row with NOTHING new to propose (terms since cleared) stays already_dated — losing today's justification does not un-date it", () => {
  const r = planOne(bill(), {
    partyCreditDays: null, // no longer set
    companyDefaultCreditDays: null, // never set
    existingBillTerm: sidecar({ dueDate: "2026-05-01T00:00:00.000Z", source: SOURCE.PARTY_TERMS, creditDaysUsed: 30, isManual: false }),
  });
  assert.equal(r.status, STATUS.ALREADY_DATED);
  assert.equal(r.alreadyDatedSource, ALREADY_DATED_SOURCE.BILL_TERMS);
  assert.equal(new Date(r.existingDueDate).toISOString().slice(0, 10), "2026-05-01");
});

test("rung 3: a non-manual sidecar row survives even when the bill itself has since lost its basis date", () => {
  const r = planOne(bill({ firstVoucherDate: null }), {
    partyCreditDays: 30,
    existingBillTerm: sidecar({ dueDate: "2026-05-01T00:00:00.000Z", source: SOURCE.PARTY_TERMS, creditDaysUsed: 30 }),
  });
  assert.equal(r.status, STATUS.ALREADY_DATED);
});

/* ═══════════════════════════════════════════════════════════════════════
   Rung 4 — no basis date (only reached with no sidecar at all)
   ═══════════════════════════════════════════════════════════════════════ */

test("rung 4: no basis date, no sidecar — blocked, regardless of terms availability", () => {
  const r = planOne(bill({ firstVoucherDate: null }), { partyCreditDays: 30, companyDefaultCreditDays: 45 });
  assert.equal(r.status, STATUS.BLOCKED);
  assert.equal(r.blockedReason, BLOCKED_REASON.NO_BASIS_DATE);
});

/* ═══════════════════════════════════════════════════════════════════════
   Rungs 5–7 — fresh derivation (no document date, no sidecar)
   ═══════════════════════════════════════════════════════════════════════ */

test("rung 5: party terms derive basisDate + creditDays", () => {
  const r = planOne(bill(), { partyCreditDays: 30 });
  assert.equal(r.status, STATUS.TO_APPLY);
  assert.equal(r.source, SOURCE.PARTY_TERMS);
  assert.equal(r.proposedDueDate.toISOString().slice(0, 10), "2026-05-01");
});

test("rung 5: party terms outrank the company default even when both are set", () => {
  const r = planOne(bill(), { partyCreditDays: 15, companyDefaultCreditDays: 60 });
  assert.equal(r.source, SOURCE.PARTY_TERMS);
  assert.equal(r.creditDaysUsed, 15);
});

test("creditPeriodDays of 0 is unset at the party rung, falls through to company default", () => {
  const r = planOne(bill(), { partyCreditDays: 0, companyDefaultCreditDays: 30 });
  assert.equal(r.source, SOURCE.COMPANY_DEFAULT);
});

test("a negative or absent partyCreditDays is also unset", () => {
  const r1 = planOne(bill(), { partyCreditDays: -5, companyDefaultCreditDays: 30 });
  const r2 = planOne(bill(), { companyDefaultCreditDays: 30 });
  assert.equal(r1.source, SOURCE.COMPANY_DEFAULT);
  assert.equal(r2.source, SOURCE.COMPANY_DEFAULT);
});

test("rung 6: no party terms AND no company default: blocked, never a built-in guess", () => {
  const r = planOne(bill(), { partyCreditDays: null, companyDefaultCreditDays: null });
  assert.equal(r.status, STATUS.BLOCKED);
  assert.equal(r.blockedReason, BLOCKED_REASON.COMPANY_DEFAULT_UNSET);
});

test("companyDefaultCreditDays of 0 is ALSO unset — no exception for the company rung", () => {
  const r = planOne(bill(), { partyCreditDays: null, companyDefaultCreditDays: 0 });
  assert.equal(r.status, STATUS.BLOCKED);
  assert.equal(r.blockedReason, BLOCKED_REASON.COMPANY_DEFAULT_UNSET);
});

test("rung 7: company default derives when explicitly set and no party terms exist", () => {
  const r = planOne(bill(), { partyCreditDays: null, companyDefaultCreditDays: 45 });
  assert.equal(r.status, STATUS.TO_APPLY);
  assert.equal(r.source, SOURCE.COMPANY_DEFAULT);
  assert.equal(r.proposedDueDate.toISOString().slice(0, 10), "2026-05-16");
});

test("a bill with no sidecar at all has alreadyBackfilled: false", () => {
  const r = planOne(bill(), { partyCreditDays: 30 });
  assert.equal(r.alreadyBackfilled, false);
  assert.equal(r.isManual, false);
});

/* ═══════════════════════════════════════════════════════════════════════
   planBackfill — whole-run orchestration
   ═══════════════════════════════════════════════════════════════════════ */

test("planBackfill filters to OPEN bills only", () => {
  const settled = bill({ billName: "SETTLED", remaining: 0.5 });
  const open = bill({ billName: "OPEN", remaining: 1000 });
  const plan = planBackfill([settled, open], { partyCreditDaysByLedgerId: new Map([[L1, 30]]) });
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].billName, "OPEN");
});

test("planBackfill: after a matching sidecar exists, the SAME bill counts toward already-dated coverage, not to_apply — the exact regression this turn fixes", () => {
  const bills = [bill()];
  const existingBillTermsByKey = new Map([[`${L1}||INV-1`, sidecar({ dueDate: "2026-05-01T00:00:00.000Z", creditDaysUsed: 30 })]]);
  const plan = planBackfill(bills, {
    partyCreditDaysByLedgerId: new Map([[L1, 30]]),
    existingBillTermsByKey,
  });
  assert.equal(plan.totals.toApplyCount, 0);
  assert.equal(plan.totals.alreadyDatedCount, 1);
  assert.equal(plan.totals.alreadyDatedBySource.bill_terms, 1);
  assert.equal(plan.coverage.before, 100);
  assert.equal(plan.coverage.after, 100);
});

test("planBackfill categorises a mixed batch across every already-dated source plus to_apply and blocked", () => {
  const bills = [
    bill({ billName: "ALLOC-DATED", dueDate: "2026-06-01" }),
    bill({ billName: "HEADER-DATED", voucherDueDate: "2026-06-02" }),
    bill({ billName: "SIDECAR-DATED", ledgerId: L1 }),
    bill({ billName: "PARTY-TERMS", ledgerId: L1 }),
    bill({ billName: "COMPANY-DEFAULT", ledgerId: L2 }),
    bill({ billName: "NO-BASIS", ledgerId: L2, firstVoucherDate: null }),
  ];
  const existingBillTermsByKey = new Map([
    [`${L1}||SIDECAR-DATED`, sidecar({ dueDate: "2026-05-01T00:00:00.000Z", creditDaysUsed: 30 })],
  ]);
  const plan = planBackfill(bills, {
    partyCreditDaysByLedgerId: new Map([[L1, 30]]), // L2 has no terms
    companyDefaultCreditDays: 45,
    existingBillTermsByKey,
  });
  assert.equal(plan.totals.totalOpen, 6);
  assert.equal(plan.totals.alreadyDatedCount, 3); // ALLOC + HEADER + SIDECAR
  assert.equal(plan.totals.alreadyDatedBySource.bill_allocation_due_date, 1);
  assert.equal(plan.totals.alreadyDatedBySource.voucher_due_date, 1);
  assert.equal(plan.totals.alreadyDatedBySource.bill_terms, 1);
  assert.equal(plan.totals.toApplyCount, 2); // PARTY-TERMS + COMPANY-DEFAULT
  assert.equal(plan.totals.blockedCount, 1); // NO-BASIS
});

test("planBackfill: coverage reflects sidecar-dated bills as dated, not pending", () => {
  const bills = [
    bill({ billName: "A", ledgerId: L1 }), // sidecar-matched, already dated
    bill({ billName: "B", ledgerId: L1 }), // will derive fresh via party terms
    bill({ billName: "C", ledgerId: L2 }), // blocked
  ];
  const existingBillTermsByKey = new Map([
    [`${L1}||A`, sidecar({ dueDate: "2026-05-01T00:00:00.000Z", creditDaysUsed: 30 })],
  ]);
  const plan = planBackfill(bills, {
    partyCreditDaysByLedgerId: new Map([[L1, 30]]),
    companyDefaultCreditDays: null,
    existingBillTermsByKey,
  });
  // before: A already dated (sidecar) = 1 of 3 = 33.3%; after: A + B = 2 of 3 = 66.7%
  assert.equal(plan.coverage.before, 33.3);
  assert.equal(plan.coverage.after, 66.7);
});

test("planBackfill: zero open bills reports null coverage", () => {
  const plan = planBackfill([]);
  assert.equal(plan.coverage.before, null);
  assert.equal(plan.coverage.after, null);
});

test("planBackfill: holes in the bills array are ignored, not crashed on", () => {
  const plan = planBackfill([null, undefined, bill()], { partyCreditDaysByLedgerId: new Map([[L1, 30]]) });
  assert.equal(plan.rows.length, 1);
});

test("planBackfill: a bill with no matching sidecar entry in the map behaves exactly as if none exists", () => {
  const plan = planBackfill([bill({ billName: "UNMAPPED" })], {
    partyCreditDaysByLedgerId: new Map([[L1, 30]]),
    existingBillTermsByKey: new Map([["some-other-key", sidecar()]]),
  });
  assert.equal(plan.rows[0].alreadyBackfilled, false);
  assert.equal(plan.rows[0].status, STATUS.TO_APPLY);
});
