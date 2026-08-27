// services/cashFlowForecastActionCenter.test.js
//
// Pure tests for Chunk 1-G — the guided cleanup queue.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const svc = require("./cashFlowForecastActionCenter.service");

function forecast(overrides = {}) {
  return {
    sourceBreakdown: { companyDefaultDerived: { count: 91, amount: 6306169 } },
    inclusion: {
      includedOpenItems: 91,
      includedRecurringItems: 0,
      excludedOverdueOpenItems: 117,
      excludedOverdueAmount: 7276693,
    },
    excludedOverdue: [],
    openingCashConfig: { status: "saved", includedLedgerCount: 6 },
    ...overrides,
  };
}

function party(name, amount, count = 1, extra = {}) {
  return {
    ledgerId: `id-${name}`,
    ledgerName: name,
    companyDefaultDerivedAmount: amount,
    companyDefaultDerivedCount: count,
    suggestedPriorityReason: `${count} bills dated from the company default`,
    ...extra,
  };
}

const byType = (r, t) => r.actions.filter((a) => a.type === t);

/* ── Party-terms ranking ─────────────────────────────────────────────────── */

test("party actions are ranked by default-derived amount, highest first", () => {
  const r = svc.buildActionCenter({
    forecast: forecast(),
    parties: [
      party("MAYFAIR Lagoon", 3151410, 29),
      party("Mayfair Kalimpong", 1271242, 6),
      party("Divaksh Textiles", 531845, 7),
    ],
    recurring: { activeCount: 5, typesPresent: ["payroll", "rent"] },
  });

  const p = byType(r, "set_party_terms");
  assert.deepEqual(p.map((a) => a.targetLabel), [
    "MAYFAIR Lagoon",
    "Mayfair Kalimpong",
    "Divaksh Textiles",
  ]);
  assert.equal(p[0].amount, 3151410);
  assert.equal(p[0].priority, "high");
});

test("only the top few party actions are high priority; the rest drop to low", () => {
  const parties = Array.from({ length: 6 }, (_, i) => party(`P${i}`, 1000000 - i * 1000, 2));
  const r = svc.buildActionCenter({
    forecast: forecast(),
    parties,
    recurring: { activeCount: 5, typesPresent: ["payroll", "rent"] },
  });
  const p = byType(r, "set_party_terms");
  assert.equal(p.filter((a) => a.priority === "high").length, svc.MAX_PARTY_ACTIONS);
  assert.ok(p.some((a) => a.priority === "low"));
});

test("a party with no default-derived exposure produces no action", () => {
  const r = svc.buildActionCenter({
    forecast: forecast(),
    parties: [party("Already On Terms", 0, 0), party("Needs Terms", 500, 1)],
    recurring: { activeCount: 5, typesPresent: ["payroll", "rent"] },
  });
  const p = byType(r, "set_party_terms");
  assert.equal(p.length, 1);
  assert.equal(p[0].targetLabel, "Needs Terms");
});

/* ── Overdue ─────────────────────────────────────────────────────────────── */

test("overdue actions group by party and rank by amount", () => {
  const r = svc.buildActionCenter({
    forecast: forecast({
      excludedOverdue: [
        { ledgerId: "L1", partyOrLedgerName: "Mayfair", amount: 100000, ageDays: 357 },
        { ledgerId: "L1", partyOrLedgerName: "Mayfair", amount: 50000, ageDays: 120 },
        { ledgerId: "L2", partyOrLedgerName: "Fancy Corner", amount: 2556, ageDays: 327 },
      ],
    }),
    parties: [],
    recurring: { activeCount: 5, typesPresent: ["payroll", "rent"] },
  });

  const o = byType(r, "set_overdue_expected_date");
  assert.equal(o.length, 2, "one action per party, not per bill");
  assert.equal(o[0].targetLabel, "Mayfair");
  assert.equal(o[0].amount, 150000);
  assert.equal(o[0].count, 2);
  assert.match(o[0].reason, /Oldest is 357 days past due/);
  assert.equal(o[1].targetLabel, "Fancy Corner");
});

test("overdue actions are capped so they cannot flood the queue", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    ledgerId: `L${i}`, partyOrLedgerName: `P${i}`, amount: 100000 - i, ageDays: 10,
  }));
  const r = svc.buildActionCenter({
    forecast: forecast({ excludedOverdue: many }),
    parties: [],
    recurring: { activeCount: 5, typesPresent: ["payroll", "rent"] },
  });
  assert.equal(byType(r, "set_overdue_expected_date").length, svc.MAX_OVERDUE_ACTIONS);
});

test("an unattributed overdue bill is still surfaced, not dropped", () => {
  const r = svc.buildActionCenter({
    forecast: forecast({
      excludedOverdue: [{ ledgerId: null, partyOrLedgerName: null, amount: 900, ageDays: 5 }],
    }),
    parties: [],
    recurring: { activeCount: 5, typesPresent: ["payroll", "rent"] },
  });
  assert.equal(byType(r, "set_overdue_expected_date")[0].targetLabel, "Unattributed");
});

/* ── Recurring ───────────────────────────────────────────────────────────── */

test("an empty recurring register creates a medium action", () => {
  const r = svc.buildActionCenter({
    forecast: forecast(),
    parties: [],
    recurring: { activeCount: 0, typesPresent: [] },
  });
  const a = byType(r, "add_recurring_items")[0];
  assert.equal(a.priority, "medium");
  assert.match(a.title, /payroll and rent/i);
  assert.equal(a.href, "/accountant/recurring-items");
  assert.equal(a.amount, null, "no amount is invented for a register that is empty");
});

test("a register missing a key category names exactly what is missing", () => {
  const r = svc.buildActionCenter({
    forecast: forecast(),
    parties: [],
    recurring: { activeCount: 3, typesPresent: ["rent", "utility"] },
  });
  const a = byType(r, "add_recurring_items")[0];
  assert.match(a.title, /payroll/);
  assert.ok(!/rent/.test(a.title), "rent is present, so it is not asked for");
});

test("a register with the key categories produces no recurring action", () => {
  const r = svc.buildActionCenter({
    forecast: forecast(),
    parties: [],
    recurring: { activeCount: 4, typesPresent: ["payroll", "rent", "emi"] },
  });
  assert.equal(byType(r, "add_recurring_items").length, 0);
});

/* ── Cash ledgers ────────────────────────────────────────────────────────── */

test("an unsaved cash config creates a review action", () => {
  const r = svc.buildActionCenter({
    forecast: forecast({ openingCashConfig: { status: "suggested_default", includedLedgerCount: 9 } }),
    parties: [],
    recurring: { activeCount: 5, typesPresent: ["payroll", "rent"] },
  });
  const a = byType(r, "review_cash_ledgers")[0];
  assert.equal(a.priority, "medium");
  assert.equal(a.href, "/accountant/settings#cash-ledgers");
});

test("a SAVED cash config suppresses the review action", () => {
  const r = svc.buildActionCenter({
    forecast: forecast({ openingCashConfig: { status: "saved", includedLedgerCount: 6 } }),
    parties: [],
    recurring: { activeCount: 5, typesPresent: ["payroll", "rent"] },
  });
  assert.equal(byType(r, "review_cash_ledgers").length, 0);
});

/* ── Ordering and cap ────────────────────────────────────────────────────── */

test("the list is capped, and setup actions are not buried by a wall of parties", () => {
  const parties = Array.from({ length: 30 }, (_, i) => party(`P${i}`, 1000000 - i, 3));
  const r = svc.buildActionCenter({
    forecast: forecast({
      excludedOverdue: [{ ledgerId: "L1", partyOrLedgerName: "Late Co", amount: 5000, ageDays: 40 }],
      openingCashConfig: { status: "suggested_default", includedLedgerCount: 9 },
    }),
    parties,
    recurring: { activeCount: 0, typesPresent: [] },
  });

  assert.ok(r.actions.length <= svc.MAX_ACTIONS);
  // Both medium setup actions survive despite 30 competing parties.
  assert.equal(byType(r, "add_recurring_items").length, 1);
  assert.equal(byType(r, "review_cash_ledgers").length, 1);
  assert.equal(byType(r, "set_party_terms").filter((a) => a.priority === "high").length, 3);
});

test("high priority sorts before medium, medium before low", () => {
  const r = svc.buildActionCenter({
    forecast: forecast({
      excludedOverdue: [{ ledgerId: "L1", partyOrLedgerName: "Late", amount: 5000, ageDays: 9 }],
      openingCashConfig: { status: "suggested_default" },
    }),
    parties: Array.from({ length: 5 }, (_, i) => party(`P${i}`, 100 - i, 1)),
    recurring: { activeCount: 0, typesPresent: [] },
  });
  const ranks = r.actions.map((a) => ({ high: 0, medium: 1, low: 2 })[a.priority]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), "never out of priority order");
});

test("the ordering key is not leaked as an output field", () => {
  const r = svc.buildActionCenter({
    forecast: forecast(),
    parties: [party("A", 100, 1)],
    recurring: { activeCount: 5, typesPresent: ["payroll", "rent"] },
  });
  assert.ok(!("sortAmount" in r.actions[0]));
});

/* ── Summary and score ───────────────────────────────────────────────────── */

test("scoreLabel: unsaved cash config means Needs setup, whatever else is true", () => {
  assert.equal(
    svc.scoreLabel({ cashConfigSaved: false, projectedSomething: true, defaultDerivedCount: 0, overdueExcludedCount: 0 }),
    "Needs setup",
  );
});

test("scoreLabel: a forecast with nothing projected is Needs setup", () => {
  assert.equal(
    svc.scoreLabel({ cashConfigSaved: true, projectedSomething: false, defaultDerivedCount: 0, overdueExcludedCount: 0 }),
    "Needs setup",
  );
});

test("scoreLabel: derived dates or excluded overdue means Partially ready", () => {
  assert.equal(
    svc.scoreLabel({ cashConfigSaved: true, projectedSomething: true, defaultDerivedCount: 91, overdueExcludedCount: 0 }),
    "Partially ready",
  );
  assert.equal(
    svc.scoreLabel({ cashConfigSaved: true, projectedSomething: true, defaultDerivedCount: 0, overdueExcludedCount: 117 }),
    "Partially ready",
  );
});

test("scoreLabel: everything settled is Ready for base use", () => {
  assert.equal(
    svc.scoreLabel({ cashConfigSaved: true, projectedSomething: true, defaultDerivedCount: 0, overdueExcludedCount: 0 }),
    "Ready for base use",
  );
});

test("the summary echoes the forecast's own figures", () => {
  const r = svc.buildActionCenter({
    companyId: "C1", asOfDate: "2026-08-24", horizonDays: 90,
    forecast: forecast(),
    parties: [],
    recurring: { activeCount: 2, typesPresent: ["payroll", "rent"] },
  });
  assert.deepEqual(r.summary, {
    scoreLabel: "Partially ready",
    defaultDerivedAmount: 6306169,
    defaultDerivedCount: 91,
    overdueExcludedAmount: 7276693,
    overdueExcludedCount: 117,
    recurringActiveCount: 2,
    openingCashConfigStatus: "saved",
  });
  assert.equal(r.companyId, "C1");
  assert.equal(r.horizonDays, 90);
});

/* ── The boundary this chunk exists to hold ──────────────────────────────── */

test("no action carries a recommended value or a mutation payload", () => {
  // The whole design: this file says WHERE to look, never WHAT the answer is.
  // A "helpful" default here would reintroduce, one layer up, exactly the
  // invented-number problem the earlier slices removed.
  const r = svc.buildActionCenter({
    forecast: forecast({
      excludedOverdue: [{ ledgerId: "L1", partyOrLedgerName: "Late", amount: 5000, ageDays: 40 }],
      openingCashConfig: { status: "suggested_default" },
    }),
    parties: [party("MAYFAIR Lagoon", 3151410, 29)],
    recurring: { activeCount: 0, typesPresent: [] },
  });

  for (const a of r.actions) {
    for (const forbidden of [
      "proposedCreditPeriodDays", "suggestedCreditDays", "recommendedDays",
      "forecastExpectedDate", "suggestedDate", "proposedAmount",
      "includedLedgerIds", "payload", "body", "method",
    ]) {
      assert.ok(!(forbidden in a), `${a.id} must not carry ${forbidden}`);
    }
    // Every action leads somewhere a person supplies the value themselves.
    assert.ok(a.href, `${a.id} must link to a workflow`);
    assert.ok(a.ctaLabel, `${a.id} must have a call to action`);
  }
});

test("no action text proposes a number of days", () => {
  const r = svc.buildActionCenter({
    forecast: forecast(),
    parties: [party("MAYFAIR Lagoon", 3151410, 29)],
    recurring: { activeCount: 5, typesPresent: ["payroll", "rent"] },
  });
  const p = byType(r, "set_party_terms")[0];
  const text = `${p.title} ${p.description} ${p.reason}`;
  assert.ok(!/\b\d+\s*(day|days)\b/i.test(text.replace(/\d+ days past due/gi, "")),
    `must not suggest a term: ${text}`);
});

test("copy is calm and factual — no alert or severity vocabulary", () => {
  const r = svc.buildActionCenter({
    forecast: forecast({
      excludedOverdue: [{ ledgerId: "L1", partyOrLedgerName: "Late", amount: 5000, ageDays: 40 }],
      openingCashConfig: { status: "suggested_default" },
    }),
    parties: [party("MAYFAIR Lagoon", 3151410, 29)],
    recurring: { activeCount: 0, typesPresent: [] },
  });
  const all = r.actions.map((a) => `${a.title} ${a.description} ${a.reason}`).join(" ");
  for (const scary of ["urgent", "critical", "warning", "danger", "risk", "alert", "fail", "wrong", "!"]) {
    assert.ok(!all.toLowerCase().includes(scary), `copy must not contain "${scary}"`);
  }
});

test("empty everything produces a coherent, empty-ish result rather than throwing", () => {
  const r = svc.buildActionCenter({});
  assert.equal(r.summary.scoreLabel, "Needs setup");
  assert.ok(Array.isArray(r.actions));
  // Nothing is configured and nothing is projected, so the two setup actions
  // are exactly what should be offered.
  assert.deepEqual(r.actions.map((a) => a.type).sort(), ["add_recurring_items", "review_cash_ledgers"]);
});

test("inputs are not mutated", () => {
  const parties = [party("A", 100, 1), party("B", 200, 2)];
  const f = forecast({ excludedOverdue: [{ ledgerId: "L", partyOrLedgerName: "X", amount: 1, ageDays: 1 }] });
  const before = JSON.stringify({ parties, f });
  svc.buildActionCenter({ forecast: f, parties, recurring: { activeCount: 0, typesPresent: [] } });
  assert.equal(JSON.stringify({ parties, f }), before);
});
