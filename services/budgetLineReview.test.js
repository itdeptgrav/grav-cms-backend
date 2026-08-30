// services/budgetLineReview.test.js
//
// FINANCE ARGUES WITH ROWS; THE LEDGER ONLY EVER SEES THE HEAD.
//
// The whole point of this layer is that it changes what finance can SAY without
// changing what accounting RECEIVES. So the properties under test are:
//
//   1 · a head total is always the sum of its rows' settled values;
//   2 · a mixed head never reads as approved;
//   3 · a countered row stops the head until the department answers;
//   4 · the monthly shape always sums to the final amount, by both routes;
//   5 · a head with no rows behaves exactly as it did before any of this.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const review = require("./budgetLineReview.service");

const row = (over = {}) => ({ label: "Festival", amount: 200000, ...over });

const HEAD = [
  row({ rowId: "r1", label: "Festival", amount: 200000 }),
  row({ rowId: "r2", label: "Annual day", amount: 150000 }),
  row({ rowId: "r3", label: "Team lunch", amount: 70000 }),
];

/* ══ A ROW HAD NO IDENTITY, AND NEEDED ONE ═════════════════════════════════ */

test("rows are given ids without disturbing the ones that have them", () => {
  const out = review.ensureRowIds([{ amount: 1 }, { rowId: "keep", amount: 2 }, { amount: 3 }]);
  assert.equal(out[1].rowId, "keep");
  assert.equal(new Set(out.map((r) => r.rowId)).size, 3);
});

test("an id is never handed to two rows", () => {
  // The collision that matters: an existing row already holds the id the
  // counter would generate for a later one.
  const out = review.ensureRowIds([{ rowId: "r2", amount: 1 }, { amount: 2 }, { amount: 3 }]);
  assert.equal(new Set(out.map((r) => r.rowId)).size, 3);
  assert.equal(out[0].rowId, "r2");
});

test("ids survive a re-run, so deciding a row twice hits the same row", () => {
  const once = review.ensureRowIds([{ amount: 1 }, { amount: 2 }]);
  const twice = review.ensureRowIds(once);
  assert.deepEqual(once.map((r) => r.rowId), twice.map((r) => r.rowId));
});

test("no rows is not an error", () => {
  assert.deepEqual(review.ensureRowIds(undefined), []);
  assert.deepEqual(review.ensureRowIds(null), []);
});

/* ══ WHAT A ROW IS WORTH ═══════════════════════════════════════════════════ */

test("an undecided row counts as what was asked, not as nothing", () => {
  // A half-reviewed head should read as "what it would be if I stopped here".
  // Counting undecided rows as zero made the total collapse toward zero as
  // finance worked down the page, which reads as though refusing was default.
  assert.equal(review.settledOn(row({ amount: 200000 })), 200000);
});

test("an approved row is worth the ask, a refused row nothing", () => {
  assert.equal(review.settledOn(row({ decision: "approved", amount: 200000 })), 200000);
  assert.equal(review.settledOn(row({ decision: "refused", amount: 200000, approvedAmount: 0 })), 0);
});

test("a countered row is worth what finance countered at", () => {
  assert.equal(
    review.settledOn(row({ decision: "countered", amount: 150000, approvedAmount: 75000 })),
    75000,
  );
});

/* ══ THE HEAD IS THE SUM OF ITS ROWS ═══════════════════════════════════════ */

test("approve one, counter one, refuse one — the head is their sum", () => {
  const rows = [
    { ...HEAD[0], decision: "approved", approvedAmount: 200000 },
    { ...HEAD[1], decision: "countered", approvedAmount: 75000, financeNote: "Half." },
    { ...HEAD[2], decision: "refused", approvedAmount: 0, financeNote: "No." },
  ];
  const up = review.rollUp(rows);
  assert.equal(up.asked, 420000);
  assert.equal(up.financeAmount, 275000);
  assert.equal(up.variance, -145000);
  assert.deepEqual(up.counts, { total: 3, pending: 0, approved: 1, countered: 1, refused: 1 });
  assert.equal(up.allDecided, true);
});

test("a refused row contributes nothing even if it kept an amount", () => {
  // Defence against a row written by an older path that never zeroed it.
  const rows = [{ ...HEAD[0], decision: "refused", approvedAmount: 200000 }];
  assert.equal(review.rollUp(rows).financeAmount, 0);
});

test("no rows rolls up to zero rather than to NaN", () => {
  const up = review.rollUp([]);
  assert.equal(up.asked, 0);
  assert.equal(up.financeAmount, 0);
  assert.equal(up.allDecided, false);
  assert.equal(up.anyDecided, false);
});

/* ══ A MIXED HEAD NEVER READS AS APPROVED ══════════════════════════════════ */

const statusOf = (rows, request = {}) => review.headStatus({ request, rows });

test("untouched rows are pending review", () => {
  assert.equal(statusOf(HEAD), "pending_review");
});

test("some decided, some not, is partially reviewed", () => {
  assert.equal(statusOf([{ ...HEAD[0], decision: "approved" }, HEAD[1]]), "partially_reviewed");
});

test("every row approved is approved", () => {
  assert.equal(statusOf(HEAD.map((r) => ({ ...r, decision: "approved" }))), "approved");
});

test("approved AND refused together is partially approved, never approved", () => {
  // The failure this exists to prevent: the department reads the word, not the
  // rows, and discovers at year end that a third of the ask was never funded.
  const rows = [
    { ...HEAD[0], decision: "approved" },
    { ...HEAD[1], decision: "refused", approvedAmount: 0 },
  ];
  assert.equal(statusOf(rows), "partially_approved");
});

test("every row refused is refused", () => {
  assert.equal(
    statusOf(HEAD.map((r) => ({ ...r, decision: "refused", approvedAmount: 0 }))),
    "refused",
  );
});

test("a countered row nobody has answered outranks everything else", () => {
  const rows = [
    { ...HEAD[0], decision: "approved" },
    { ...HEAD[1], decision: "countered", approvedAmount: 75000 },
  ];
  assert.equal(statusOf(rows), "needs_department_response");
});

test("once the department accepts, the head reads on its merits again", () => {
  const rows = [
    { ...HEAD[0], decision: "approved" },
    { ...HEAD[1], decision: "countered", approvedAmount: 75000, departmentAccepted: true },
  ];
  assert.equal(statusOf(rows), "partially_approved");
});

test("a refused head is refused whatever its rows were mid-argument", () => {
  assert.equal(statusOf([{ ...HEAD[0], decision: "approved" }], { state: "rejected" }), "refused");
});

test("an agreed head is approved, and does not re-derive itself", () => {
  assert.equal(statusOf([{ ...HEAD[0], decision: "refused" }], { state: "agreed" }), "approved");
});

test("a head with no rows still has a status", () => {
  assert.equal(statusOf([], { state: "submitted" }), "pending_review");
  assert.equal(statusOf([], { state: "countered" }), "countered");
});

/* ══ RECORDING A DECISION ══════════════════════════════════════════════════ */

test("approving a row takes the amount asked, and needs no note", () => {
  const d = review.decideRow({ row: HEAD[0], decision: "approved" });
  assert.equal(d.decision, "approved");
  assert.equal(d.approvedAmount, 200000);
});

test("a refusal is zero, stated rather than implied", () => {
  const d = review.decideRow({ row: HEAD[0], decision: "refused", financeNote: "Not this year." });
  assert.equal(d.approvedAmount, 0);
});

test("countering and refusing both demand a note", () => {
  for (const decision of ["countered", "refused"]) {
    assert.throws(
      () => review.decideRow({ row: HEAD[0], decision, amount: 1000 }),
      (e) => e.code === "ROW_NOTE_REQUIRED",
      decision,
    );
  }
  // Whitespace is not a reason.
  assert.throws(
    () => review.decideRow({ row: HEAD[0], decision: "refused", financeNote: "   " }),
    (e) => e.code === "ROW_NOTE_REQUIRED",
  );
});

test("a counter at the amount asked is refused as not being a counter", () => {
  // It reads to the department as a rejection they must answer, costs a draft
  // round, and ends exactly where it started.
  assert.throws(
    () => review.decideRow({ row: HEAD[0], decision: "countered", amount: 200000, financeNote: "x" }),
    (e) => e.code === "ROW_COUNTER_UNCHANGED",
  );
});

test("a counter needs a number, and not a negative one", () => {
  for (const amount of [undefined, null, "lots", -1]) {
    assert.throws(
      () => review.decideRow({ row: HEAD[0], decision: "countered", amount, financeNote: "x" }),
      (e) => e.code === "ROW_AMOUNT_INVALID",
      String(amount),
    );
  }
});

test("countering to zero is allowed, and is not the same act as refusing", () => {
  // "Fund this at nothing this year" and "this row should not exist" are
  // different sentences; only the second is a refusal.
  const d = review.decideRow({ row: HEAD[0], decision: "countered", amount: 0, financeNote: "Defer." });
  assert.equal(d.approvedAmount, 0);
  assert.equal(d.decision, "countered");
});

test("a decision nobody recognises is refused rather than stored", () => {
  assert.throws(
    () => review.decideRow({ row: HEAD[0], decision: "maybe", financeNote: "x" }),
    (e) => e.code === "ROW_DECISION_INVALID",
  );
});

test("a fresh decision clears a stale acceptance", () => {
  // Otherwise an acceptance recorded against the PREVIOUS counter makes the new
  // one look already answered, and the head walks straight into an allocation.
  const d = review.decideRow({
    row: { ...HEAD[0], departmentAccepted: true },
    decision: "countered", amount: 100000, financeNote: "Less.",
  });
  assert.equal(d.departmentAccepted, false);
});

/* ══ THE HEAD BUTTON, PUSHED DOWN ══════════════════════════════════════════ */

test("approving a head approves everything unresolved", () => {
  const out = review.applyHeadDecision({ rows: HEAD, decision: "approved" });
  assert.equal(out.every((r) => r.decision === "approved"), true);
  assert.equal(review.rollUp(out).financeAmount, 420000);
});

test("approving a head does NOT undo the argument already had", () => {
  // The head button must not be a silent way to discard every row decision on
  // the page — a row cut to half stays cut.
  const rows = [
    { ...HEAD[0], decision: "countered", approvedAmount: 75000, financeNote: "Half." },
    HEAD[1],
  ];
  const out = review.applyHeadDecision({ rows, decision: "approved" });
  assert.equal(out[0].approvedAmount, 75000);
  assert.equal(out[0].decision, "countered");
  assert.equal(out[1].decision, "approved");
});

test("refusing a head refuses every row, including ones already approved", () => {
  // A row reading "approved" under a refused head is a contradiction the
  // department would reasonably read as a promise.
  const rows = [{ ...HEAD[0], decision: "approved", approvedAmount: 200000 }, HEAD[1]];
  const out = review.applyHeadDecision({ rows, decision: "refused", financeNote: "Not this year." });
  assert.equal(out.every((r) => r.decision === "refused"), true);
  assert.equal(review.rollUp(out).financeAmount, 0);
});

test("refusing a head demands a reason", () => {
  assert.throws(
    () => review.applyHeadDecision({ rows: HEAD, decision: "refused" }),
    (e) => e.code === "HEAD_NOTE_REQUIRED",
  );
});

test("a refusal does not overwrite a note a row already carries", () => {
  const rows = [{ ...HEAD[0], financeNote: "Specific to this row." }];
  const out = review.applyHeadDecision({ rows, decision: "refused", financeNote: "Whole head." });
  assert.equal(out[0].financeNote, "Specific to this row.");
});

test("head decisions give unidentified rows their ids on the way through", () => {
  const out = review.applyHeadDecision({ rows: [{ amount: 5 }], decision: "approved" });
  assert.ok(out[0].rowId);
});

/* ══ THE SHAPE FOLLOWS THE MONEY ═══════════════════════════════════════════ */

test("rows carrying their own months sum into the head's months", () => {
  const rows = [
    { rowId: "r1", amount: 200000, decision: "approved",
      monthly: [{ month: "2026-10", amount: 200000 }] },
    { rowId: "r2", amount: 100000, decision: "approved",
      monthly: [{ month: "2026-10", amount: 40000 }, { month: "2026-11", amount: 60000 }] },
  ];
  const out = review.phasingForDecisions({ rows, finalAmount: 300000 });
  assert.equal(out.phasingMode, "custom_monthly");
  assert.deepEqual(out.monthlyPhasing, [
    { month: "2026-10", amount: 240000 },
    { month: "2026-11", amount: 60000 },
  ]);
});

test("a refused row takes its months out with it", () => {
  const rows = [
    { rowId: "r1", amount: 200000, decision: "approved", monthly: [{ month: "2026-10", amount: 200000 }] },
    { rowId: "r2", amount: 100000, decision: "refused", approvedAmount: 0,
      monthly: [{ month: "2026-11", amount: 100000 }] },
  ];
  const out = review.phasingForDecisions({ rows, finalAmount: 200000 });
  assert.deepEqual(out.monthlyPhasing, [{ month: "2026-10", amount: 200000 }]);
});

test("a countered row is scaled inside its own months, not trimmed off the end", () => {
  // "Half the annual day" is half of it wherever it fell.
  const rows = [
    { rowId: "r1", amount: 100000, decision: "countered", approvedAmount: 50000,
      monthly: [{ month: "2026-10", amount: 60000 }, { month: "2026-11", amount: 40000 }] },
  ];
  const out = review.phasingForDecisions({ rows, finalAmount: 50000 });
  assert.deepEqual(out.monthlyPhasing, [
    { month: "2026-10", amount: 30000 },
    { month: "2026-11", amount: 20000 },
  ]);
});

test("with no row months, the head's own shape is scaled proportionally", () => {
  // Scaling preserves what the shape SAID — a festival quarter stays a festival
  // quarter — where straight-lining would move money into months the
  // department had explicitly kept empty.
  const out = review.phasingForDecisions({
    rows: [{ rowId: "r1", amount: 400000, decision: "countered", approvedAmount: 200000 }],
    phasingMode: "custom_monthly",
    monthlyPhasing: [{ month: "2026-09", amount: 300000 }, { month: "2026-10", amount: 100000 }],
    finalAmount: 200000,
  });
  assert.deepEqual(out.monthlyPhasing, [
    { month: "2026-09", amount: 150000 },
    { month: "2026-10", amount: 50000 },
  ]);
});

test("an even head stays even", () => {
  const out = review.phasingForDecisions({
    rows: [{ rowId: "r1", amount: 400000, decision: "approved" }],
    phasingMode: "even",
    finalAmount: 400000,
  });
  assert.equal(out.phasingMode, "even");
  assert.deepEqual(out.monthlyPhasing, []);
});

test("the months always add up to the final amount, whatever the rounding", () => {
  // The one outcome that must not be reachable: a plan whose months disagree
  // with its own total.
  const out = review.phasingForDecisions({
    rows: [{ rowId: "r1", amount: 100000, decision: "countered", approvedAmount: 33333.33 }],
    phasingMode: "custom_monthly",
    monthlyPhasing: [
      { month: "2026-04", amount: 33333 },
      { month: "2026-05", amount: 33333 },
      { month: "2026-06", amount: 33334 },
    ],
    finalAmount: 33333.33,
  });
  const sum = out.monthlyPhasing.reduce((s, m) => s + m.amount, 0);
  assert.ok(Math.abs(sum - 33333.33) < 0.01, `${sum} ≠ 33333.33`);
});

test("a head refused down to nothing has no months to spread", () => {
  const out = review.phasingForDecisions({
    rows: [{ rowId: "r1", amount: 100000, decision: "refused", approvedAmount: 0,
             monthly: [{ month: "2026-10", amount: 100000 }] }],
    finalAmount: 0,
  });
  assert.equal(out.phasingMode, "even");
  assert.deepEqual(out.monthlyPhasing, []);
});

test("rounding drift lands on the biggest month, not always on March", () => {
  const out = review.settleRemainder(
    [{ month: "2026-04", amount: 10 }, { month: "2026-05", amount: 100 }],
    111,
  );
  assert.deepEqual(out.monthlyPhasing, [
    { month: "2026-04", amount: 10 },
    { month: "2026-05", amount: 101 },
  ]);
});

/* ══ THE RULE THAT PROTECTS THE LEDGER ═════════════════════════════════════ */

test("a head with an unanswered counter cannot be approved", () => {
  const rows = [{ ...HEAD[0], decision: "countered", approvedAmount: 75000 }];
  const gate = review.readyToApprove({ rows });
  assert.equal(gate.ok, false);
  assert.equal(gate.code, "ROWS_AWAITING_DEPARTMENT");
  // And it names the row, so finance does not have to hunt.
  assert.match(gate.reason, /Festival/);
});

test("once accepted, the same head is approvable", () => {
  const rows = [{ ...HEAD[0], decision: "countered", approvedAmount: 75000, departmentAccepted: true }];
  assert.equal(review.readyToApprove({ rows }).ok, true);
});

test("approvals and refusals never block — only open questions do", () => {
  const rows = [
    { ...HEAD[0], decision: "approved" },
    { ...HEAD[1], decision: "refused", approvedAmount: 0 },
  ];
  assert.equal(review.readyToApprove({ rows }).ok, true);
});

test("a head with no rows is approvable, exactly as it always was", () => {
  assert.equal(review.readyToApprove({ rows: [] }).ok, true);
  assert.equal(review.readyToApprove({}).ok, true);
});

/* ══ THE FIGURE APPROVAL TAKES ═════════════════════════════════════════════ */

test("with rows decided, the standing figure is their sum", () => {
  const rows = [
    { ...HEAD[0], decision: "approved" },
    { ...HEAD[1], decision: "refused", approvedAmount: 0 },
    HEAD[2],
  ];
  // 200000 approved + 0 refused + 70000 still asked
  assert.equal(review.standingAmount({ request: { requestedAmount: 420000 }, rows }), 270000);
});

test("with no rows touched, it is the head counter if there is one", () => {
  assert.equal(
    review.standingAmount({
      request: { requestedAmount: 600000, counterAmount: 400000, state: "countered" },
      rows: [],
    }),
    400000,
  );
});

test("and otherwise it is simply what was asked", () => {
  assert.equal(
    review.standingAmount({ request: { requestedAmount: 600000 }, rows: [] }),
    600000,
  );
});

test("a stale counterAmount on a request no longer countered is ignored", () => {
  // The department revised after a counter: state went back to submitted, and
  // the old counter figure must not be what approval silently takes.
  assert.equal(
    review.standingAmount({
      request: { requestedAmount: 500000, counterAmount: 400000, state: "submitted" },
      rows: [],
    }),
    500000,
  );
});

/* ══ A ROW'S WORTH COMES FROM ITS INPUTS, NOT ITS STORED TOTAL ═════════════
 * The head's figure is the sum of its rows, and approval takes that figure. So
 * a row that reads as ₹0 because of a stale stored amount does not merely look
 * wrong — it ALLOCATES wrong. This is the same defect as the review screen's
 * "₹0 beside 2 × ₹2,00,000", one layer down where it costs money.
 * ═════════════════════════════════════════════════════════════════════════ */

const STALE = [
  { rowId: "r1", label: "Festival", quantity: 2, rate: 200000, multiplier: 0, amount: 0 },
  { rowId: "r2", label: "Annual day", quantity: 1, rate: 200000, multiplier: 0, amount: 0 },
];

test("a stale stored zero does not roll up as zero", () => {
  const up = review.rollUp(STALE);
  assert.equal(up.asked, 600000);
  assert.equal(up.financeAmount, 600000);
});

test("the rows reconcile to the head's own requested figure", () => {
  // The screenshot: header ₹6,00,000, rows ₹0. They agree now.
  assert.equal(review.rollUp(STALE).asked, 600000);
});

test("approving a stale row approves what it is worth, not what it stored", () => {
  // Otherwise the head is agreed at zero and the department is allocated
  // nothing, with the screen having said ₹6,00,000 throughout.
  const d = review.decideRow({ row: STALE[0], decision: "approved" });
  assert.equal(d.approvedAmount, 400000);
});

test("a counter is judged against the derived figure", () => {
  // `ROW_COUNTER_UNCHANGED` compares against what was asked; comparing against
  // a stale zero would let a counter at ₹0 through as a real change and refuse
  // a genuine counter at ₹4,00,000.
  assert.throws(
    () => review.decideRow({ row: STALE[0], decision: "countered", amount: 400000, financeNote: "x" }),
    (e) => e.code === "ROW_COUNTER_UNCHANGED",
  );
  const ok = review.decideRow({ row: STALE[0], decision: "countered", amount: 250000, financeNote: "Less." });
  assert.equal(ok.approvedAmount, 250000);
});

test("a month-wise row rolls up on its months", () => {
  const rows = [{ rowId: "r1", label: "Campaign", amount: 0,
    monthly: [{ month: "2026-09", amount: 60000 }, { month: "2026-10", amount: 40000 }] }];
  assert.equal(review.rollUp(rows).asked, 100000);
});

test("a manual row still rolls up on the figure it asserted", () => {
  const rows = [{ rowId: "r1", label: "Quoted", manualAmount: true, amount: 150000 }];
  assert.equal(review.rollUp(rows).asked, 150000);
});

test("the phasing of a stale row scales on its derived worth", () => {
  /* `phasingForDecisions` divides settled by asked to scale a row's months. On
     a stale row both were zero, so the factor was 0/0 and the months vanished
     — a cut request silently losing its whole plan. */
  const rows = [{ rowId: "r1", quantity: 2, rate: 200000, multiplier: 0, amount: 0,
    decision: "countered", approvedAmount: 200000,
    monthly: [{ month: "2026-09", amount: 300000 }, { month: "2026-10", amount: 100000 }] }];
  const out = review.phasingForDecisions({ rows, finalAmount: 200000 });
  const sum = out.monthlyPhasing.reduce((s, m) => s + m.amount, 0);
  assert.ok(Math.abs(sum - 200000) < 1, `${sum} ≠ 200000`);
  assert.equal(out.monthlyPhasing.length, 2);
});
