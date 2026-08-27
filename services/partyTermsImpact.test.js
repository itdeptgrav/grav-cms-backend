// services/partyTermsImpact.test.js
//
// Pure tests for Chunk 1-F — party credit-terms impact and preview.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const svc = require("./partyTermsImpact.service");

function throwsCode(fn, code, msg) {
  assert.throws(
    fn,
    (e) => {
      assert.ok(e instanceof svc.PartyTermsImpactError, `got ${e && e.name}: ${e && e.message}`);
      assert.equal(e.code, code, `expected ${code}, got ${e.code} (${e.message})`);
      return true;
    },
    msg,
  );
}

/** An open bill dated from the blanket company default — the recalculable case. */
function bill(overrides = {}) {
  return {
    billName: "RC/0091/26-27",
    amount: 100000,
    basisDate: "2026-06-01",
    currentDueDate: "2026-07-17", // 46-day company default
    source: "company_default",
    isManualSidecar: false,
    hasManualExpectedDate: false,
    ...overrides,
  };
}

/* ── Proposed days validation ────────────────────────────────────────────── */

test("proposed days accepts 0..365, including the boundaries", () => {
  assert.equal(svc.parseProposedDays(0), 0);
  assert.equal(svc.parseProposedDays(365), 365);
  assert.equal(svc.parseProposedDays("30"), 30, "form inputs arrive as strings");
});

test("proposed days rejects out-of-range, fractional and coercible values", () => {
  throwsCode(() => svc.parseProposedDays(-1), "OUT_OF_RANGE");
  throwsCode(() => svc.parseProposedDays(366), "OUT_OF_RANGE");
  throwsCode(() => svc.parseProposedDays(30.5), "NOT_INTEGER");
  throwsCode(() => svc.parseProposedDays("abc"), "INVALID_TYPE");
  throwsCode(() => svc.parseProposedDays(true), "INVALID_TYPE");
  throwsCode(() => svc.parseProposedDays({ days: 30 }), "INVALID_TYPE");
  throwsCode(() => svc.parseProposedDays([30]), "INVALID_TYPE");
  throwsCode(() => svc.parseProposedDays(null), "REQUIRED");
  throwsCode(() => svc.parseProposedDays(""), "REQUIRED");
});

/* ── Ranking ─────────────────────────────────────────────────────────────── */

test("parties rank by company-default-derived amount first", () => {
  // The question is "where would real terms change the forecast most", which
  // is money sitting on an invented date — not simply the biggest customer.
  const ranked = svc.rankParties([
    { ledgerName: "Big but explicit", companyDefaultDerivedAmount: 0, projectedAmount: 9000000 },
    { ledgerName: "Mayfair", companyDefaultDerivedAmount: 3151410, projectedAmount: 3151410 },
    { ledgerName: "Small default", companyDefaultDerivedAmount: 50000, projectedAmount: 50000 },
  ]);
  assert.deepEqual(ranked.map((p) => p.ledgerName), ["Mayfair", "Small default", "Big but explicit"]);
});

test("total projected amount breaks a tie on default-derived amount", () => {
  const ranked = svc.rankParties([
    { ledgerName: "B", companyDefaultDerivedAmount: 1000, projectedAmount: 2000 },
    { ledgerName: "A", companyDefaultDerivedAmount: 1000, projectedAmount: 5000 },
  ]);
  assert.deepEqual(ranked.map((p) => p.ledgerName), ["A", "B"]);
});

test("ranking does not mutate its input", () => {
  const input = [
    { ledgerName: "A", companyDefaultDerivedAmount: 1, projectedAmount: 1 },
    { ledgerName: "B", companyDefaultDerivedAmount: 2, projectedAmount: 2 },
  ];
  const before = JSON.stringify(input);
  svc.rankParties(input);
  assert.equal(JSON.stringify(input), before);
});

test("the priority reason is factual and never proposes a number", () => {
  const r = svc.suggestedPriorityReason({
    companyDefaultDerivedCount: 29,
    overdueCount: 4,
    manualExpectedDateCount: 1,
    topDates: [{ date: "2026-09-19", amount: 2062762, count: 23 }],
  });
  assert.match(r, /29 bills dated from the company default/);
  assert.match(r, /23 land on 2026-09-19/);
  assert.match(r, /4 already overdue/);
  // Suggesting a term would be inventing the very thing this chunk exists to
  // stop the company default from inventing.
  assert.ok(!/\bdays\b/.test(r), "no proposed credit-days figure");

  assert.equal(
    svc.suggestedPriorityReason({ companyDefaultDerivedCount: 0, topDates: [] }),
    "No company-default-derived bills",
  );
});

/* ── Preview arithmetic ──────────────────────────────────────────────────── */

test("the proposed due date is basisDate + proposed days", () => {
  const { rows } = svc.buildPreview({ bills: [bill()], proposedDays: 30 });
  assert.equal(rows[0].proposedDueDate.toISOString().slice(0, 10), "2026-07-01");
  assert.equal(rows[0].canRecalculate, true);
});

test("deltaDays is the signed shift from the current date to the proposed one", () => {
  // 46-day default → 17 Jul. Proposing 30 days → 1 Jul, i.e. 16 days earlier.
  const earlier = svc.buildPreview({ bills: [bill()], proposedDays: 30 });
  assert.equal(earlier.rows[0].deltaDays, -16);

  const later = svc.buildPreview({ bills: [bill()], proposedDays: 60 });
  assert.equal(later.rows[0].proposedDueDate.toISOString().slice(0, 10), "2026-07-31");
  assert.equal(later.rows[0].deltaDays, 14);
});

test("a month-end basis date rolls over correctly", () => {
  const { rows } = svc.buildPreview({
    bills: [bill({ basisDate: "2026-01-31", currentDueDate: "2026-03-18" })],
    proposedDays: 30,
  });
  assert.equal(rows[0].proposedDueDate.toISOString().slice(0, 10), "2026-03-02");
});

test("the weighted shift is weighted by amount, not a plain average", () => {
  // A ₹30L bill moving 40 days matters far more than a ₹300 one moving 40
  // days; an unweighted mean would call them the same.
  const { totals } = svc.buildPreview({
    bills: [
      bill({ billName: "big", amount: 1000000, basisDate: "2026-06-01", currentDueDate: "2026-07-17" }),
      bill({ billName: "small", amount: 1000, basisDate: "2026-06-01", currentDueDate: "2026-06-11" }),
    ],
    proposedDays: 30, // big: 17 Jul → 1 Jul = -16 ; small: 11 Jun → 1 Jul = +20
  });
  const expected = (1000000 * -16 + 1000 * 20) / 1001000;
  assert.equal(totals.netDateShiftDaysWeighted, Math.round(expected * 10) / 10);
  assert.ok(totals.netDateShiftDaysWeighted < 0, "the big bill dominates");
});

test("totals split recalculable from blocked by count and amount", () => {
  const { totals } = svc.buildPreview({
    bills: [
      bill({ billName: "ok1", amount: 100 }),
      bill({ billName: "ok2", amount: 200 }),
      bill({ billName: "manual", amount: 400, isManualSidecar: true }),
    ],
    proposedDays: 30,
  });
  assert.equal(totals.recalculableCount, 2);
  assert.equal(totals.recalculableAmount, 300);
  assert.equal(totals.blockedCount, 1);
  assert.equal(totals.blockedAmount, 400);
});

/* ── What is protected ───────────────────────────────────────────────────── */

test("a manual sidecar row is blocked, and still shown", () => {
  const { rows } = svc.buildPreview({ bills: [bill({ isManualSidecar: true })], proposedDays: 30 });
  assert.equal(rows[0].canRecalculate, false);
  assert.equal(rows[0].blockedReason, "manual_sidecar");
  assert.match(rows[0].blockedLabel, /a person set this date/i);
  // Still visible, and still shows what WOULD have happened.
  assert.ok(rows[0].proposedDueDate, "the row is surfaced, not hidden");
});

test("a row with a manual expected date is blocked — a deliberate refusal", () => {
  // Moving the due date underneath a recorded expectation changes the bill's
  // age and can stop it being overdue at all, at which point Chunk 1-C
  // ignores the expectation entirely.
  const { rows } = svc.buildPreview({
    bills: [bill({ hasManualExpectedDate: true })],
    proposedDays: 30,
  });
  assert.equal(rows[0].canRecalculate, false);
  assert.equal(rows[0].blockedReason, "manual_expected_date");
});

test("manual sidecar outranks every other block reason", () => {
  const { rows } = svc.buildPreview({
    bills: [
      bill({ isManualSidecar: true, hasManualExpectedDate: true, source: "party_terms", basisDate: null }),
    ],
    proposedDays: 30,
  });
  assert.equal(rows[0].blockedReason, "manual_sidecar", "reports the strongest protection");
});

test("a stated date is blocked — it outranks any derivation", () => {
  for (const source of ["bill_allocation_due_date", "voucher_due_date", "bill_terms_manual"]) {
    const { rows } = svc.buildPreview({ bills: [bill({ source })], proposedDays: 30 });
    assert.equal(rows[0].blockedReason, "not_company_default_derived", source);
  }
});

test("a row already on party terms is blocked — it is already the goal", () => {
  const { rows } = svc.buildPreview({ bills: [bill({ source: "party_terms" })], proposedDays: 30 });
  assert.equal(rows[0].blockedReason, "not_company_default_derived");
});

test("a bill with no basis date cannot be recalculated", () => {
  const { rows } = svc.buildPreview({ bills: [bill({ basisDate: null })], proposedDays: 30 });
  assert.equal(rows[0].blockedReason, "no_basis_date");
  assert.equal(rows[0].proposedDueDate, null, "nothing is invented from nothing");
});

test("proposing 0 days blocks every row rather than refusing the call", () => {
  // 0 means unset. Showing 'what if we cleared this' is more useful than an
  // error, and it can derive nothing, so every row says so.
  const { rows, totals } = svc.buildPreview({
    bills: [bill(), bill({ billName: "b2" })],
    proposedDays: 0,
  });
  assert.equal(totals.recalculableCount, 0);
  assert.equal(totals.blockedCount, 2);
  for (const r of rows) {
    assert.equal(r.blockedReason, "no_proposed_term");
    assert.equal(r.proposedDueDate, null);
  }
});

/* ── Purity ──────────────────────────────────────────────────────────────── */

test("preview does not mutate its inputs", () => {
  const bills = [bill(), bill({ billName: "b2", isManualSidecar: true })];
  const before = JSON.stringify(bills);
  svc.buildPreview({ bills, proposedDays: 30 });
  assert.equal(JSON.stringify(bills), before);
});

test("preview tolerates empty and malformed input", () => {
  assert.deepEqual(svc.buildPreview({ bills: [], proposedDays: 30 }).rows, []);
  assert.deepEqual(svc.buildPreview({}).rows, []);
  const t = svc.buildPreview({ bills: [], proposedDays: 30 }).totals;
  assert.equal(t.recalculableCount, 0);
  assert.equal(t.netDateShiftDaysWeighted, 0, "no division by zero");
});

test("preview uses the same resolver an apply would, so the two cannot disagree", () => {
  const creditTerms = require("./creditTerms.service");
  const expected = creditTerms.resolveDueDate({
    voucherDate: "2026-06-01",
    partyLedger: { creditPeriodDays: 30 },
  });
  const { rows } = svc.buildPreview({ bills: [bill()], proposedDays: 30 });
  assert.equal(rows[0].proposedDueDate.getTime(), expected.getTime());
});

/* ── Scope guard ─────────────────────────────────────────────────────────── */

test("scope guard: this service proposes no terms and writes nothing", () => {
  const exported = Object.keys(svc);
  for (const forbidden of ["applyTerms", "writeTerms", "suggestCreditDays", "recommendDays", "predict"]) {
    assert.ok(!exported.includes(forbidden), `${forbidden} is not this service's job`);
  }
  const { rows } = svc.buildPreview({ bills: [bill()], proposedDays: 30 });
  assert.ok(!("suggestedDays" in rows[0]));
  assert.ok(!("recommendedDays" in rows[0]));
});
