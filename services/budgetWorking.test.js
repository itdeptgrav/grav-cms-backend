// services/budgetWorking.test.js
//
// The arithmetic behind a proposed amount, and what the server refuses to
// store. The route test proves it over HTTP; this proves the rules.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const w = require("./budgetWorking.service");

const row = (over = {}) => ({
  label: "Claude Team",
  quantity: 5,
  unit: "users",
  rate: 6000,
  multiplier: 12,
  multiplierUnit: "months",
  ...over,
});

/* ── recomputation ───────────────────────────────────────────────────────── */

test("a row's amount is quantity x rate x multiplier", () => {
  const { lines, total } = w.normaliseWorkingLines([row()]);
  assert.equal(lines[0].amount, 360000);
  assert.equal(total, 360000);
});

test("the client's own amount is discarded, not trusted", () => {
  const { lines } = w.normaliseWorkingLines([row({ amount: 99 })]);
  assert.equal(lines[0].amount, 360000, "a browser sending 99 must not set the stored figure");
});

test("the worked example adds up", () => {
  const { total } = w.normaliseWorkingLines([
    row(),
    row({ label: "Codex usage", quantity: 1, rate: 20000, multiplier: 12 }),
    row({ label: "Copilot", quantity: 5, rate: 1000, multiplier: 12 }),
  ]);
  assert.equal(total, 660000);
});

test("missing multipliers default to 1 rather than collapsing to nothing", () => {
  const { lines } = w.normaliseWorkingLines([
    { label: "Supplier quote", rate: 450000 },
  ]);
  assert.equal(lines[0].amount, 450000);
  assert.equal(lines[0].quantity, 1);
  assert.equal(lines[0].multiplier, 1);
});

test("no breakdown at all is not an empty breakdown", () => {
  assert.deepEqual(w.normaliseWorkingLines(undefined), { lines: [], total: null });
  assert.deepEqual(w.normaliseWorkingLines([]), { lines: [], total: null });
});

/* ── refusals ────────────────────────────────────────────────────────────── */

test("a row with no name is refused", () => {
  assert.throws(() => w.normaliseWorkingLines([row({ label: "  " })]), (e) => e.code === "WORKING_NO_LABEL");
});

test.each = undefined;
for (const field of ["quantity", "rate", "multiplier"]) {
  test(`a negative ${field} is refused`, () => {
    assert.throws(
      () => w.normaliseWorkingLines([row({ [field]: -1 })]),
      (e) => e.code === "WORKING_NEGATIVE",
    );
  });
}

test("a manual row must actually carry an amount", () => {
  assert.throws(
    () => w.normaliseWorkingLines([{ label: "Negotiated", manualAmount: true }]),
    (e) => e.code === "WORKING_NO_MANUAL_AMOUNT",
  );
});

test("a manual row keeps its own amount and is marked", () => {
  const { lines, total } = w.normaliseWorkingLines([
    { label: "Negotiated retainer", manualAmount: true, amount: 275000 },
  ]);
  assert.equal(lines[0].amount, 275000);
  assert.equal(lines[0].manualAmount, true);
  assert.equal(total, 275000);
});

test("a negative manual amount is refused", () => {
  assert.throws(
    () => w.normaliseWorkingLines([{ label: "x", manualAmount: true, amount: -5 }]),
    (e) => e.code === "WORKING_NEGATIVE",
  );
});

test("an absurd number of rows is refused", () => {
  const many = Array.from({ length: w.MAX_LINES + 1 }, (_, i) => row({ label: `L${i}` }));
  assert.throws(() => w.normaliseWorkingLines(many), (e) => e.code === "WORKING_TOO_MANY_LINES");
});

test("something that is not a list is refused", () => {
  assert.throws(() => w.normaliseWorkingLines({ label: "x" }), (e) => e.code === "WORKING_NOT_A_LIST");
});

/* ── reconciliation ──────────────────────────────────────────────────────── */

test("an amount matching its breakdown needs no override", () => {
  const out = w.reconcileAmount({ total: 660000, requestedAmount: 660000 });
  assert.equal(out.manualAmountOverride, false);
});

test("a rupee of rounding is tolerated", () => {
  const out = w.reconcileAmount({ total: 660000, requestedAmount: 660001 });
  assert.equal(out.manualAmountOverride, false);
});

test("a mismatch with no override is refused", () => {
  assert.throws(
    () => w.reconcileAmount({ total: 660000, requestedAmount: 800000 }),
    (e) => e.code === "WORKING_SUM_MISMATCH",
  );
});

test("an override with no reason is refused", () => {
  assert.throws(
    () => w.reconcileAmount({ total: 660000, requestedAmount: 800000, manualAmountOverride: true }),
    (e) => e.code === "WORKING_OVERRIDE_NO_REASON",
  );
});

test("an override with a reason is accepted and the reason kept", () => {
  const out = w.reconcileAmount({
    total: 660000,
    requestedAmount: 800000,
    manualAmountOverride: true,
    manualOverrideReason: "The quote covers year one; I am asking for the whole contract.",
  });
  assert.equal(out.manualAmountOverride, true);
  assert.match(out.manualOverrideReason, /whole contract/);
});

test("an override flag on an amount that DOES match is dropped", () => {
  /* A stale "manual override" on a line that reconciles perfectly is a lie
     about its own history. */
  const out = w.reconcileAmount({
    total: 660000,
    requestedAmount: 660000,
    manualAmountOverride: true,
    manualOverrideReason: "left over from an earlier edit",
  });
  assert.equal(out.manualAmountOverride, false);
  assert.equal(out.manualOverrideReason, undefined);
});

test("with no breakdown there is nothing to reconcile", () => {
  const out = w.reconcileAmount({ total: null, requestedAmount: 500000 });
  assert.equal(out.manualAmountOverride, false);
});

test("a breakdown with no amount to check against is refused", () => {
  assert.throws(
    () => w.reconcileAmount({ total: 660000, requestedAmount: null }),
    (e) => e.code === "WORKING_NO_AMOUNT",
  );
});

/* ── the note carried onto an approved line ──────────────────────────────── */

test("the summary names the rows without copying the breakdown", () => {
  const { lines, total } = w.normaliseWorkingLines([
    row(),
    row({ label: "Codex usage", quantity: 1, rate: 20000 }),
    row({ label: "Copilot", quantity: 5, rate: 1000 }),
    row({ label: "Figma", quantity: 3, rate: 1500 }),
  ]);
  const note = w.summarise({ purpose: "Team tooling for FY26-27", lines, total });
  assert.match(note, /Team tooling/);
  assert.match(note, /Built from 4 lines/);
  assert.match(note, /\+1 more/);
});

test("a purpose with no breakdown still produces the old note", () => {
  assert.equal(w.summarise({ purpose: "Peak season freight" }), "Peak season freight");
});

test("nothing at all produces nothing, not an empty string", () => {
  assert.equal(w.summarise({}), undefined);
});

/* ── AN ASK WITH NO ARITHMETIC ───────────────────────────────────────────────
   The proposal form now offers a manual amount for a line that genuinely has
   no rows — a single fixed annual contract. It sends the override flag and a
   reason alongside an empty breakdown, so that shape has to survive rather
   than throw. */

test("an override with no breakdown is accepted rather than refused", () => {
  const out = w.reconcileAmount({
    total: null,
    requestedAmount: 480000,
    manualAmountOverride: true,
    manualOverrideReason: "Single fixed annual contract.",
  });
  /* Nothing to reconcile against, so the flag itself is dropped — an amount
     cannot disagree with a breakdown that does not exist. The department's
     sentence still travels on the request for finance to read. */
  assert.equal(out.manualAmountOverride, false);
});

test("rows that reconcile drop a stale override flag", () => {
  const out = w.reconcileAmount({
    total: 660000,
    requestedAmount: 660000,
    manualAmountOverride: true,
    manualOverrideReason: "left over from an earlier edit",
  });
  assert.equal(out.manualAmountOverride, false);
  assert.equal(out.manualOverrideReason, undefined);
});

test("an override that genuinely disagrees still needs a reason", () => {
  assert.throws(
    () =>
      w.reconcileAmount({
        total: 660000,
        requestedAmount: 800000,
        manualAmountOverride: true,
        manualOverrideReason: "   ",
      }),
    /reason/i,
  );
});

/* ── A ROW THAT IS ITSELF MONTH-WISE ─────────────────────────────────────────
   A month-wise line describes what each item costs in each month. The row's
   amount is the sum of its own months, exactly as a quantity row's amount is
   the product of its own inputs — and the client's `amount` is ignored for the
   same reason. */

test("a row's amount is the sum of its months, not what the client sent", () => {
  const { lines, total } = w.normaliseWorkingLines([
    { label: "Campaign", amount: 999999, monthly: [
      { month: "2026-04", amount: 100000 },
      { month: "2026-09", amount: 50000 },
    ]},
  ]);
  assert.equal(lines[0].amount, 150000);
  assert.equal(total, 150000);
});

test("zero months are dropped, so a row states the months it actually uses", () => {
  const { lines } = w.normaliseWorkingLines([
    { label: "Campaign", monthly: [
      { month: "2026-04", amount: 100000 },
      { month: "2026-05", amount: 0 },
    ]},
  ]);
  assert.deepEqual(lines[0].monthly, [{ month: "2026-04", amount: 100000 }]);
});

test("all-zero months are the same as no months at all", () => {
  /* Twelve zeroes would claim a month-wise plan that plans nothing. */
  const { lines } = w.normaliseWorkingLines([
    { label: "Campaign", manualAmount: true, amount: 5000,
      monthly: [{ month: "2026-04", amount: 0 }] },
  ]);
  assert.equal(lines[0].monthly, undefined);
  assert.equal(lines[0].amount, 5000);   // falls back to the manual amount
});

test("a row with no months behaves exactly as it always has", () => {
  const { lines } = w.normaliseWorkingLines([
    { label: "Seats", quantity: 5, rate: 6000, multiplier: 12 },
  ]);
  assert.equal(lines[0].amount, 360000);
  assert.equal(lines[0].monthly, undefined);
});

test("a bad month key is refused, and named", () => {
  assert.throws(
    () => w.normaliseWorkingLines([{ label: "X", monthly: [{ month: "April", amount: 1 }] }]),
    /2026-04/,
  );
});

test("the same month twice is refused", () => {
  assert.throws(
    () => w.normaliseWorkingLines([{ label: "X", monthly: [
      { month: "2026-04", amount: 1 }, { month: "2026-04", amount: 2 }] }]),
    /twice/i,
  );
});

test("a negative month is refused", () => {
  assert.throws(
    () => w.normaliseWorkingLines([{ label: "X", monthly: [{ month: "2026-04", amount: -5 }] }]),
    /negative/i,
  );
});

test("monthly amounts must arrive as a list", () => {
  assert.throws(
    () => w.normaliseWorkingLines([{ label: "X", monthly: { "2026-04": 5 } }]),
    /list/i,
  );
});

/* ══ WHAT A ROW IS WORTH ═══════════════════════════════════════════════════
 * `rowAmount` is the one derivation the whole system uses — the stored total,
 * the review screen's "Requested" column, the row roll-up and the head figure
 * approval takes. It exists because those four had drifted into three
 * different answers, and the wrong one reached the screen.
 * ═════════════════════════════════════════════════════════════════════════ */

test("a quantity row is quantity × rate × multiplier", () => {
  assert.equal(w.rowAmount({ quantity: 5, rate: 6000, multiplier: 12 }), 360000);
});

test("a missing multiplier is once, not nothing", () => {
  assert.equal(w.rowAmount({ quantity: 2, rate: 200000 }), 400000);
  assert.equal(w.rowAmount({ quantity: 2, rate: 200000, multiplier: null }), 400000);
});

test("A MULTIPLIER OF ZERO IS ALSO ONCE — the bug this helper exists for", () => {
  /* The screenshot: a row reading "2 events × ₹2,00,000" and, beside it, ₹0.
     Nothing in a budget is bought "× 0 months"; the field means "and this many
     times over", so absent and zero are the same statement. */
  assert.equal(w.rowAmount({ quantity: 2, rate: 200000, multiplier: 0, amount: 0 }), 400000);
});

test("a quantity of zero IS zero, because that is a thing to mean", () => {
  // "We are not buying any of these this year." The two fields look alike and
  // are not: a zero multiplier is a missing answer, a zero quantity is one.
  assert.equal(w.rowAmount({ quantity: 0, rate: 200000, multiplier: 1 }), 0);
});

test("a month-wise row is the sum of its own months", () => {
  assert.equal(
    w.rowAmount({
      quantity: 99, rate: 99, // deliberately present and deliberately ignored
      monthly: [{ month: "2026-09", amount: 60000 }, { month: "2026-10", amount: 40000 }],
    }),
    100000,
  );
});

test("a manual row is the only one whose stored amount is believed", () => {
  // A quoted price or a negotiated lump sum — asserted rather than computed,
  // which is the whole point of the flag.
  assert.equal(w.rowAmount({ manualAmount: true, amount: 150000, quantity: 0, rate: 0 }), 150000);
});

test("a stale stored amount never wins over the inputs that contradict it", () => {
  // The failure mode in one line: the row says 2 × 2,00,000 and the document
  // says 0. The inputs are the derivation; the stored figure is a cache of it.
  assert.equal(w.rowAmount({ quantity: 2, rate: 200000, amount: 0 }), 400000);
  assert.equal(w.rowAmount({ quantity: 2, rate: 200000, amount: 999 }), 400000);
});

test("an empty row is zero rather than NaN", () => {
  for (const row of [undefined, null, {}, { label: "x" }]) {
    assert.equal(w.rowAmount(row), 0, JSON.stringify(row));
  }
});

/* ══ AND THE STORED ROW IS FIXED ON THE WAY IN ═════════════════════════════ */

test("normalising rewrites a zero multiplier to one, so the row stops lying", () => {
  /* The read side is defended by `rowAmount`, but a document that stores a
     figure disagreeing with its own inputs is a trap for the next reader. */
  const { lines, total } = w.normaliseWorkingLines([
    { label: "Festival", quantity: 2, rate: 200000, multiplier: 0, amount: 0 },
    { label: "Annual day", quantity: 1, rate: 200000, multiplier: 0, amount: 0 },
  ]);
  assert.equal(lines[0].amount, 400000);
  assert.equal(lines[0].multiplier, 1);
  assert.equal(lines[1].amount, 200000);
  assert.equal(total, 600000);
});

test("the screenshot case reconciles to the head's own figure", () => {
  // Festival 4,00,000 + Annual day 2,00,000 = 6,00,000, which is what the
  // header said all along while the rows said nothing.
  const { total } = w.normaliseWorkingLines([
    { label: "Festival", quantity: 2, rate: 200000, multiplier: 0 },
    { label: "Annual day", quantity: 1, rate: 200000, multiplier: 0 },
  ]);
  assert.equal(total, 600000);
});

test("a manual row keeps the multiplier it was given", () => {
  // Its amount does not come from the multiplier, so there is nothing to fix
  // and nothing to gain from overwriting what the department typed.
  const { lines } = w.normaliseWorkingLines([
    { label: "Quoted", manualAmount: true, amount: 50000 },
  ]);
  assert.equal(lines[0].amount, 50000);
});
