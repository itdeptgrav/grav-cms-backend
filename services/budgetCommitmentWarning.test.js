// services/budgetCommitmentWarning.test.js
//
// COMMITMENTS INFORM FINANCE; THEY DO NOT STOP THEM.
//
// The posting gate blocks on ACTUAL posted spend and nothing else, and this
// chunk did not change that. What it added is the sentence the posting screen
// was missing: every other screen in the module — the head picker, the
// submissions desk, the cash-flow forecast — subtracts commitments, and the one
// place finance actually spends money did not even mention them.
//
// So what is under test here is the WORDING and the THRESHOLDS, and one
// property that matters more than either: nothing this produces can block.
//
// `commitmentNote` is pure, so all of it is testable without a database.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const control = require("./budgetControl.service");

const note = (over = {}) =>
  control.commitmentNote({
    ledgerName: "Repairs & Maintenance",
    allocated: 100000,
    projectedActual: 50000,
    openCommitments: 40000,
    ...over,
  });

/* ══ THE CHUNK'S OWN EXAMPLE ════════════════════════════════════════════════ */

test("the worked example comes out as specified", () => {
  // Budget 1,00,000 · actual 20,000 · committed 40,000 · this voucher 30,000.
  // Actual after the voucher is 50,000, so posting is allowed — and pressure
  // including promises is 90,000.
  const n = note({ projectedActual: 50000, openCommitments: 40000 });

  assert.equal(n.committed, 40000);
  assert.equal(n.pressure, 90000);
  assert.equal(n.availableExcludingCommitments, 50000);
  assert.equal(n.availableIncludingCommitments, 10000);
  assert.match(n.detail, /Repairs & Maintenance already has ₹40,000 committed/);
  assert.match(n.detail, /₹90,000 of ₹1,00,000 will be spoken for including commitments/);
});

/* ══ NOTHING HERE BLOCKS ════════════════════════════════════════════════════ */

test("no severity is ever a blocker", () => {
  for (const openCommitments of [1, 40000, 500000]) {
    const n = note({ openCommitments });
    assert.equal(n.blocking, false, String(openCommitments));
  }
});

test("even pressure far past the allocation only warns", () => {
  const n = note({ allocated: 100000, projectedActual: 50000, openCommitments: 400000 });
  assert.equal(n.severity, "high");
  assert.equal(n.blocking, false);
  // Says so in the message itself, so a screen cannot present it as a refusal.
  assert.match(n.headline, /Posting is still allowed/);
});

/* ══ HOW LOUDLY IT SPEAKS ═══════════════════════════════════════════════════ */

test("nothing committed says nothing at all", () => {
  // Not "₹0 committed" — a screen that reports the absence of a thing on every
  // voucher is a screen people learn to stop reading.
  assert.equal(note({ openCommitments: 0 }), null);
  assert.equal(note({ openCommitments: null }), null);
  assert.equal(note({ openCommitments: undefined }), null);
});

test("room for everything is stated plainly", () => {
  const n = note({ allocated: 1000000, projectedActual: 50000, openCommitments: 40000 });
  assert.equal(n.severity, "info");
  assert.match(n.headline, /Approved requests already use part of this budget head/);
});

test("close to spoken for is the middle warning", () => {
  // 91,000 of 1,00,000 — past the module's 90% mark, still inside the budget.
  const n = note({ allocated: 100000, projectedActual: 51000, openCommitments: 40000 });
  assert.equal(n.severity, "near");
  assert.equal(n.pressurePct, 91);
});

test("past the allocation once promises count is the strong warning", () => {
  const n = note({ allocated: 100000, projectedActual: 70000, openCommitments: 40000 });
  assert.equal(n.severity, "high");
  assert.equal(n.availableIncludingCommitments, -10000);
  // And still not the same thing as being over budget on actuals.
  assert.equal(n.availableExcludingCommitments, 30000);
});

/* ══ THE HEAD IS NAMED ══════════════════════════════════════════════════════ */

test("the message names the head, because a voucher can touch four", () => {
  const a = note({ ledgerName: "Repairs & Maintenance" });
  const b = note({ ledgerName: "Software Subscription" });
  assert.match(a.detail, /^Repairs & Maintenance/);
  assert.match(b.detail, /^Software Subscription/);
  assert.notEqual(a.detail, b.detail);
});

test("an unnamed head still reads as a sentence", () => {
  assert.match(note({ ledgerName: null }).detail, /^This head already has/);
});

/* ══ EDGES ══════════════════════════════════════════════════════════════════ */

test("a head with no allocation reports pressure without a fraction of nothing", () => {
  const n = note({ allocated: 0, projectedActual: 0, openCommitments: 25000 });
  assert.equal(n.pressure, 25000);
  assert.equal(n.pressurePct, null);
  assert.equal(n.severity, "info");
  // No "of ₹0" in the sentence — that reads as a divide-by-zero, not a fact.
  assert.doesNotMatch(n.detail, /of ₹0/);
});

test("percentages are rounded for reading, not for arithmetic", () => {
  const n = note({ allocated: 30000, projectedActual: 10000, openCommitments: 1000 });
  assert.equal(n.pressurePct, 36.7);
  // The money keeps its paise.
  assert.equal(n.pressure, 11000);
});
