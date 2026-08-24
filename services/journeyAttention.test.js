// services/journeyAttention.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { journeyAttention, STALE_DAYS } = require("./journeyAttention");

const NOW = new Date("2026-08-22T10:00:00Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000);
const daysAhead = (n) => new Date(NOW.getTime() + n * 86400000);

/* ── revisitDue: the payout for parking ───────────────────────────────────── */

test("a parked journey whose revisit date has arrived asks to be looked at", () => {
  const r = journeyAttention({ outcome: "parked", revisitOn: NOW }, NOW);
  assert.equal(r.needsDecision, true);
  assert.equal(r.reason, "revisitDue");
});

test("a parked journey whose date has PASSED still asks — it does not go quiet again", () => {
  assert.equal(journeyAttention({ outcome: "parked", revisitOn: daysAgo(30) }, NOW).reason, "revisitDue");
});

test("a parked journey not yet due stays silent — that is the system working", () => {
  assert.equal(journeyAttention({ outcome: "parked", revisitOn: daysAhead(70) }, NOW).needsDecision, false);
});

test("a parked journey with no date at all never nags, and never goes stale either", () => {
  // The planner refuses to park without a date, so this is only reachable on
  // legacy data. Silence is the safe answer: inventing a decision prompt for a
  // record that predates the rule would be noise nobody can act on.
  assert.equal(journeyAttention({ outcome: "parked", updatedAt: daysAgo(400) }, NOW).needsDecision, false);
});

/* ── outsideOverdue ───────────────────────────────────────────────────────── */

test("an outside party past its expected-back date is chased, by name", () => {
  const r = journeyAttention({ outcome: "active", hold: { on: "Vardhman — fabric dyeing", expectedBack: daysAgo(3) } }, NOW);
  assert.equal(r.reason, "outsideOverdue");
  assert.match(r.label, /Vardhman/);
});

test("an outside party still within its date is not chased", () => {
  assert.equal(journeyAttention({ outcome: "active", hold: { on: "SGS", expectedBack: daysAhead(7) } }, NOW).needsDecision, false);
});

test("a hold with no date cannot be overdue", () => {
  assert.equal(journeyAttention({ outcome: "active", hold: { on: "SGS" }, updatedAt: NOW }, NOW).needsDecision, false);
});

/* ── stale ────────────────────────────────────────────────────────────────── */

test(`no date and nothing moved for ${STALE_DAYS} days asks for a decision`, () => {
  const r = journeyAttention({ outcome: "active", updatedAt: daysAgo(STALE_DAYS) }, NOW);
  assert.equal(r.reason, "stale");
  assert.match(r.label, new RegExp(`${STALE_DAYS} days`));
});

test("one day short of the threshold stays quiet", () => {
  assert.equal(journeyAttention({ outcome: "active", updatedAt: daysAgo(STALE_DAYS - 1) }, NOW).needsDecision, false);
});

test("A DATED JOURNEY IS NEVER STALE — the Overdue band already has it", () => {
  // Saying the same thing in two bands helps nobody, and would make the new
  // band the noisiest thing on the page on day one.
  const withAction = { outcome: "active", nextAction: { dueDate: daysAgo(60) }, updatedAt: daysAgo(90) };
  const withTarget = { outcome: "active", targetDate: { date: daysAhead(5) }, updatedAt: daysAgo(90) };
  assert.equal(journeyAttention(withAction, NOW).needsDecision, false);
  assert.equal(journeyAttention(withTarget, NOW).needsDecision, false);
});

/* ── already decided ──────────────────────────────────────────────────────── */

test("lost and closed journeys are never asked about again", () => {
  for (const outcome of ["lost", "closed"]) {
    assert.equal(journeyAttention({ outcome, updatedAt: daysAgo(500), revisitOn: daysAgo(500) }, NOW).needsDecision, false);
  }
});

test("a journey with no outcome field at all is treated as active", () => {
  assert.equal(journeyAttention({ updatedAt: daysAgo(60) }, NOW).reason, "stale");
});

/* ── precedence ───────────────────────────────────────────────────────────── */

test("the revisit date wins over everything — it is what the salesperson asked for", () => {
  const r = journeyAttention(
    { outcome: "parked", revisitOn: daysAgo(1), hold: { on: "SGS", expectedBack: daysAgo(40) }, updatedAt: daysAgo(90) },
    NOW,
  );
  assert.equal(r.reason, "revisitDue");
});

test("an overdue outside party wins over staleness — it names someone to chase", () => {
  const r = journeyAttention({ outcome: "active", hold: { on: "SGS", expectedBack: daysAgo(2) }, updatedAt: daysAgo(90) }, NOW);
  assert.equal(r.reason, "outsideOverdue");
});
