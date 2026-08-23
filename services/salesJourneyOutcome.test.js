// services/salesJourneyOutcome.test.js
//
// The outcome axis: parking, losing and reviving a Sales Journey.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { planStageTransition, JourneyTransitionError } = require("./salesJourneyProgress");

const J = (over = {}) => ({
  currentStage: "costQuote",
  stageStates: { enquiry: "complete", styleSample: "complete", costQuote: "inProgress" },
  outcome: "active",
  ...over,
});
const throws = (fn, re) => assert.throws(fn, (e) => e instanceof JourneyTransitionError && re.test(e.message), String(re));

/* ── park ─────────────────────────────────────────────────────────────── */

test("parking records the stage it happened at and does not move the pointer", () => {
  const p = planStageTransition(J(), { action: "park", reason: "customerQuiet", revisitOn: "2026-10-01", note: "GM on leave" });
  assert.equal(p.set.outcome, "parked");
  assert.equal(p.set.outcomeStage, "costQuote");
  assert.equal(p.set.outcomeReason, "customerQuiet");
  assert.equal(p.set.outcomeNote, "GM on leave");
  assert.equal(p.set.currentStage, undefined, "parking is not progress and not a setback");
});

test("parking demands a revisit date — a park without one is an abandoned deal", () => {
  throws(() => planStageTransition(J(), { action: "park", reason: "customerQuiet" }), /date to look at this again/);
  throws(() => planStageTransition(J(), { action: "park", reason: "customerQuiet", revisitOn: "not-a-date" }), /date to look at this again/);
});

test("parking demands a reason off the list", () => {
  throws(() => planStageTransition(J(), { action: "park", revisitOn: "2026-10-01" }), /why this Journey is being parked/);
  throws(() => planStageTransition(J(), { action: "park", reason: "invented", revisitOn: "2026-10-01" }), /why this Journey is being parked/);
});

test("an already-parked journey can be parked again to push the date", () => {
  const p = planStageTransition(J({ outcome: "parked" }), { action: "park", reason: "seasonal", revisitOn: "2027-01-15" });
  assert.equal(p.set.outcome, "parked");
});

/* ── lose ─────────────────────────────────────────────────────────────── */

test("losing records stage and reason and clears any revisit date", () => {
  const p = planStageTransition(J(), { action: "lose", reason: "price", note: "20% under us" });
  assert.equal(p.set.outcome, "lost");
  assert.equal(p.set.outcomeStage, "costQuote");
  assert.equal(p.set.revisitOn, null, "a lost deal is not waiting for a date");
});

test("lost is available from EVERY pre-PO stage, not just Enquiry", () => {
  for (const stage of ["enquiry", "styleSample", "costQuote", "poContract"]) {
    const p = planStageTransition(J({ currentStage: stage, stageStates: { [stage]: "inProgress" } }),
      { action: "lose", reason: "competitor" });
    assert.equal(p.set.outcomeStage, stage);
  }
});

test("a PO on file refuses `lose` — that is a cancellation, not a loss", () => {
  throws(
    () => planStageTransition(J({ currentStage: "poContract" }), { action: "lose", reason: "price", context: { poOnFile: true } }),
    /PO on this Journey/,
  );
});

test("losing demands a reason off the list", () => {
  throws(() => planStageTransition(J(), { action: "lose" }), /why this Journey was lost/);
  throws(() => planStageTransition(J(), { action: "lose", reason: "because" }), /why this Journey was lost/);
});

/* ── the axis gates every other verb ──────────────────────────────────── */

test("a parked or lost journey cannot be advanced, set, blocked or closed", () => {
  for (const outcome of ["parked", "lost"]) {
    for (const action of ["advance", "setState", "block", "reopen", "close"]) {
      throws(
        () => planStageTransition(J({ outcome }), { action, toState: "complete", reason: "x", stage: "enquiry" }),
        /Revive it before working it again/,
      );
    }
  }
});

test("a closed order says so rather than offering a revive", () => {
  throws(() => planStageTransition(J({ outcome: "closed" }), { action: "advance" }), /order is closed/);
  throws(() => planStageTransition(J({ outcome: "closed" }), { action: "revive", reason: "x" }), /cannot be revived/);
});

/* ── revive ───────────────────────────────────────────────────────────── */

test("reviving returns to active and keeps the record of what happened", () => {
  const p = planStageTransition(J({ outcome: "parked", outcomeStage: "styleSample", outcomeReason: "seasonal" }),
    { action: "revive", reason: "they called back" });
  assert.equal(p.set.outcome, "active");
  assert.equal(p.set.revisitOn, null);
  assert.equal(p.set.outcomeStage, undefined, "the stage it died at is history, not a live field to clear");
  assert.equal(p.set.outcomeReason, undefined);
});

test("a lost journey can be revived — customers come back", () => {
  const p = planStageTransition(J({ outcome: "lost" }), { action: "revive", reason: "reopened the tender" });
  assert.equal(p.set.outcome, "active");
});

test("reviving demands a reason, and refuses on an active journey", () => {
  throws(() => planStageTransition(J({ outcome: "lost" }), { action: "revive" }), /why this Journey is being picked up/);
  throws(() => planStageTransition(J(), { action: "revive", reason: "x" }), /already active/);
});

test("the unknown-action message lists the new verbs", () => {
  throws(() => planStageTransition(J(), { action: "yeet" }), /park, lose, revive/);
});

/* ── Hold: why the current stage is not moving ────────────────────────────── */

test("waiting on an outside party stores WHO, free text", () => {
  const p = planStageTransition(J(), {
    action: "setState", toState: "waitingOutside",
    on: "Vardhman — fabric dyeing", expectedBack: "2026-09-05", actor: { name: "Ray" },
  });
  assert.equal(p.set["stageStates.costQuote"], "waitingOutside");
  assert.equal(p.set.hold.kind, "waitingOutside");
  assert.equal(p.set.hold.on, "Vardhman — fabric dyeing");
  assert.equal(p.set.hold.expectedBack.toISOString().slice(0, 10), "2026-09-05");
  assert.equal(p.set.hold.stage, "costQuote", "records which stage was waiting");
});

test("waiting with no name is refused — that is the state it replaces", () => {
  throws(() => planStageTransition(J(), { action: "setState", toState: "waitingOutside" }), /who this is waiting on/);
  throws(() => planStageTransition(J(), { action: "setState", toState: "waitingOutside", on: "   " }), /who this is waiting on/);
});

test("the date is optional — not every mill commits to one", () => {
  const p = planStageTransition(J(), { action: "setState", toState: "waitingOutside", on: "SGS lab" });
  assert.equal(p.set.hold.expectedBack, null);
  assert.equal(p.set.hold.on, "SGS lab");
});

test("blocking now STORES its reason instead of losing it to the change log", () => {
  const p = planStageTransition(J(), { action: "block", reason: "Customer changed the spec mid-sample" });
  assert.equal(p.set.hold.kind, "blocked");
  assert.equal(p.set.hold.on, "Customer changed the spec mid-sample");
});

test("any other state clears the hold — a stale one is worse than none", () => {
  for (const to of ["inProgress", "waitingCustomer", "waitingInternal", "complete"]) {
    const p = planStageTransition(J({ stageStates: { costQuote: "waitingOutside" } }), { action: "setState", toState: to });
    assert.equal(p.set.hold.on, null, `${to} must clear it`);
    assert.equal(p.set.hold.kind, null);
  }
});

test("advancing clears the hold, so the next stage does not inherit it", () => {
  const p = planStageTransition(J({ stageStates: { costQuote: "waitingOutside" } }), { action: "advance" });
  assert.equal(p.set.currentStage, "poContract");
  assert.equal(p.set.hold.on, null);
});

test("waitingOutside does NOT block advancing — it is not a fault", () => {
  assert.doesNotThrow(() => planStageTransition(J({ stageStates: { costQuote: "waitingOutside" } }), { action: "advance" }));
});

test("blocked still blocks advancing", () => {
  throws(() => planStageTransition(J({ stageStates: { costQuote: "blocked" } }), { action: "advance" }), /is blocked/);
});

/* ── Payment terms gate the start of production ───────────────────────────── */

const atPo = (over = {}) => ({
  currentStage: "poContract",
  stageStates: { poContract: "inProgress" },
  outcome: "active",
  ...over,
});
// Built through the REAL gate rather than hand-shaped, so these fixtures cannot
// drift from what the route actually passes in. `required` here is the rupee
// amount the advance comes to; the order value is worked back from the percent.
const { advanceGate } = require("./paymentTerms");
const adv = (required, received, percent = 40) =>
  advanceGate({ advancePercent: percent }, {
    orderValue: (required * 100) / percent,
    received,
    currency: "INR",
  });

test("no terms recorded means no gate — the rule enforces the deal that was struck", () => {
  assert.doesNotThrow(() => planStageTransition(atPo(), { action: "advance", context: { poOnFile: true } }));
});

test("a PO on file is not enough — the agreed advance has to have arrived", () => {
  throws(
    () => planStageTransition(atPo(), { action: "advance", context: { poOnFile: true, advance: adv(400000, 0) } }),
    /agreed advance/,
  );
});

test("a PART payment is still short", () => {
  throws(
    () => planStageTransition(atPo(), { action: "advance", context: { poOnFile: true, advance: adv(400000, 399999) } }),
    /agreed advance/,
  );
});

test("the advance in full opens production", () => {
  assert.doesNotThrow(
    () => planStageTransition(atPo(), { action: "advance", context: { poOnFile: true, advance: adv(400000, 400000) } }),
  );
});

test("the refusal names the number, not just the rule", () => {
  try {
    planStageTransition(atPo(), { action: "advance", context: { poOnFile: true, advance: adv(400000, 150000) } });
    assert.fail("should have refused");
  } catch (e) {
    assert.match(e.message, /40%/);
    assert.match(e.message, /4,00,000/);
    assert.match(e.message, /1,50,000 received/);
  }
});

test("a manager with a written reason may start anyway, and it is recorded", () => {
  const p = planStageTransition(atPo(), {
    action: "advance",
    context: { poOnFile: true, advance: adv(400000, 0), isManager: true, overrideReason: "Cheque in hand, clears Monday" },
  });
  assert.match(p.summary, /WITHOUT agreed advance/);
  assert.equal(p.append.path, "advancedWithoutPrerequisites");
  assert.match(p.append.value.reason, /Cheque in hand/);
});

test("a reason without the manager is not enough", () => {
  throws(
    () => planStageTransition(atPo(), { action: "advance", context: { poOnFile: true, advance: adv(400000, 0), overrideReason: "trust me" } }),
    /Only a Sales manager/,
  );
});

test("a missing PO and a short advance are reported together, not one at a time", () => {
  try {
    planStageTransition(atPo(), { action: "advance", context: { poOnFile: false, advance: adv(400000, 0) } });
    assert.fail("should have refused");
  } catch (e) {
    assert.match(e.message, /customer PO/);
    assert.match(e.message, /agreed advance/);
  }
});

test("the gate is Production's alone — earlier stages are untouched", () => {
  const atQuote = { currentStage: "costQuote", stageStates: { costQuote: "inProgress" }, outcome: "active" };
  assert.doesNotThrow(() => planStageTransition(atQuote, { action: "advance", context: { advance: adv(400000, 0) } }));
});
