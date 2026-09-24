// services/salesJourneyStageConsolidation.test.js
//
// THE STATE MACHINE AFTER COST & INVOICING WAS FOLDED IN.
//
// `costQuote` was retired on 24 Sep 2026 and its work moved to
// `purchaseInvoice`. The code itself could not be deleted: journeys store it
// as `currentStage`, the `stageStates` sub-schema is built from the same list,
// and dropping it would fail validation on every existing record.
//
// So the machine has to do two things at once — never walk INTO the retired
// stage again, and keep working for journeys already standing on it. That is
// what this file pins.
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  planStageTransition, resolveStage, RETIRED_STAGE_FORWARDS, JourneyTransitionError,
} = require("./salesJourneyProgress");
const { SALES_JOURNEY_STAGE_CODES } = require("../constants/crm");

/** A journey, lifecycle-shaped. */
const J = (patch = {}) => ({
  currentStage: "styleSample",
  outcome: "active",
  stageStates: {
    enquiry: "complete",
    styleSample: "inProgress",
    costQuote: "notStarted",
    purchaseInvoice: "notStarted",
    poContract: "notStarted",
    production: "notStarted",
    shipment: "notStarted",
    retention: "notStarted",
  },
  ...patch,
});

/* ── THE CODE SURVIVES, THE STAGE DOES NOT ──────────────────────────────── */

test("the retired code is still a valid stage code", () => {
  // The schema enum is built from this list. Removing the code would make
  // every stored journey that carries it unsaveable.
  assert.ok(SALES_JOURNEY_STAGE_CODES.includes("costQuote"));
  assert.ok(SALES_JOURNEY_STAGE_CODES.includes("purchaseInvoice"));
});

test("a retired code resolves to where its work went", () => {
  assert.equal(RETIRED_STAGE_FORWARDS.costQuote, "purchaseInvoice");
  assert.equal(resolveStage("costQuote"), "purchaseInvoice");
  assert.equal(resolveStage("account"), "enquiry");
  // Anything current is untouched.
  for (const code of ["enquiry", "styleSample", "purchaseInvoice", "poContract"]) {
    assert.equal(resolveStage(code), code);
  }
});

/* ── ADVANCE NEVER LANDS ON THE RETIRED STAGE ───────────────────────────── */

test("style & sample advances straight to purchase invoice", () => {
  const plan = planStageTransition(J(), { action: "advance" });
  assert.equal(plan.set.currentStage, "purchaseInvoice");
  // The stage just left is closed off, and the one arrived at is opened.
  assert.equal(plan.set["stageStates.styleSample"], "complete");
  assert.equal(plan.set["stageStates.purchaseInvoice"], "inProgress");
  // And nothing was written against the retired stage on the way past.
  assert.equal(plan.set["stageStates.costQuote"], undefined);
});

test("the retired stage is skipped even when it is the only one marked applicable", () => {
  // A journey whose purchaseInvoice was marked notApplicable has nowhere left
  // in the commercial slot — it must move past both, not into costQuote.
  const plan = planStageTransition(
    J({ stageStates: { ...J().stageStates, purchaseInvoice: "notApplicable" } }),
    { action: "advance" },
  );
  assert.equal(plan.set.currentStage, "poContract");
});

test("enquiry still advances to style & sample", () => {
  const plan = planStageTransition(
    J({ currentStage: "enquiry", stageStates: { ...J().stageStates, enquiry: "inProgress" } }),
    { action: "advance" },
  );
  assert.equal(plan.set.currentStage, "styleSample");
});

/* ── HISTORICAL JOURNEYS KEEP WORKING ───────────────────────────────────── */

test("a journey standing on the retired stage can still advance", () => {
  const plan = planStageTransition(
    J({ currentStage: "costQuote", stageStates: { ...J().stageStates, costQuote: "inProgress" } }),
    { action: "advance" },
  );
  // Forward, not sideways into itself.
  assert.equal(plan.set.currentStage, "purchaseInvoice");
  assert.equal(plan.set["stageStates.costQuote"], "complete");
});

test("a journey beyond the retired stage is unaffected", () => {
  const plan = planStageTransition(
    J({
      currentStage: "purchaseInvoice",
      stageStates: { ...J().stageStates, costQuote: "complete", purchaseInvoice: "inProgress" },
    }),
    { action: "advance" },
  );
  assert.equal(plan.set.currentStage, "poContract");
});

test("work recorded against the consolidated stage opens it", () => {
  // This is what raising a proforma does. It used to be recorded against
  // costQuote, which left purchaseInvoice reading "not started" on a journey
  // whose invoice had already been raised.
  const plan = planStageTransition(J(), { action: "recordWork", stage: "purchaseInvoice" });
  assert.equal(plan.set["stageStates.purchaseInvoice"], "inProgress");
  // It never moves the pointer — that is `advance`'s job alone.
  assert.equal(plan.set.currentStage, undefined);
});

test("recording the same work twice changes nothing the second time", () => {
  // Retries must not produce a second costing, quotation or invoice state.
  const started = J({ stageStates: { ...J().stageStates, purchaseInvoice: "inProgress" } });
  const plan = planStageTransition(started, { action: "recordWork", stage: "purchaseInvoice" });
  assert.ok(plan.noop || Object.keys(plan.set).length === 0, "a repeat must be a no-op");
});

/* ── GOING BACK ─────────────────────────────────────────────────────────── */

test("the consolidated stage can be reopened once complete", () => {
  const plan = planStageTransition(
    J({
      currentStage: "poContract",
      stageStates: { ...J().stageStates, purchaseInvoice: "complete", poContract: "inProgress" },
    }),
    /* Reopening always needs a reason — that rule is the machine's and is
       unchanged by the consolidation. */
    { action: "reopen", stage: "purchaseInvoice", reason: "The customer changed the quantity." },
  );
  assert.equal(plan.set.currentStage, "purchaseInvoice");
  assert.equal(plan.set["stageStates.purchaseInvoice"], "reopened");
});

test("a stage that has not been done cannot be reopened", () => {
  assert.throws(
    () => planStageTransition(J(), { action: "reopen", stage: "purchaseInvoice", reason: "Too early." }),
    /* From Style & Sample, Purchase Invoice is AHEAD — the machine refuses on
       that ground before it ever reaches the "only a completed stage" rule. */
    (e) => e instanceof JourneyTransitionError && /ahead of the current stage/.test(e.message),
  );
});

test("a reopened commercial stage advances forward again, not back through the retired one", () => {
  const plan = planStageTransition(
    J({
      currentStage: "purchaseInvoice",
      stageStates: { ...J().stageStates, purchaseInvoice: "reopened" },
    }),
    { action: "advance" },
  );
  assert.equal(plan.set.currentStage, "poContract");
});

/* ── THE GATES ARE UNCHANGED ────────────────────────────────────────────── */

test("the sample-approval gate still guards the move off style & sample", () => {
  // It guarded the move into Cost & Invoicing; it now guards the move into
  // Purchase Invoice, which is the same step by another name.
  assert.throws(
    () => planStageTransition(J(), { action: "advance", context: { samplesAwaitingCustomer: 2 } }),
    (e) => /approval on 2 samples/.test(e.message),
  );
});

test("a manager may still override that gate, on the record", () => {
  const plan = planStageTransition(J(), {
    action: "advance",
    context: { samplesAwaitingCustomer: 1, isManager: true, overrideReason: "Buyer confirmed by email." },
  });
  assert.equal(plan.set.currentStage, "purchaseInvoice");
  assert.ok(plan.append, "the override is recorded");
});

test("a blocked stage still refuses to advance", () => {
  assert.throws(
    () => planStageTransition(J({ stageStates: { ...J().stageStates, styleSample: "blocked" } }), { action: "advance" }),
    (e) => e instanceof JourneyTransitionError,
  );
});

/* ── JOB WORK IS CARRIED, NOT DECIDED, HERE ─────────────────────────────── */

test("the stage machine does not read the order's fulfilment model", () => {
  /* `fulfilmentModel` (FULL_PACKAGE / JOB_WORK) lives on the Enquiry and is
     copied onto the order. No transition has ever depended on it, and folding
     two stages into one must not invent a dependency — a Job Work order moves
     through the consolidated stage exactly as a full-package one does. */
  const jobWork = planStageTransition(J({ fulfilmentModel: "JOB_WORK" }), { action: "advance" });
  const fullPackage = planStageTransition(J({ fulfilmentModel: "FULL_PACKAGE" }), { action: "advance" });
  assert.deepEqual(jobWork.set, fullPackage.set);
  assert.equal(jobWork.set.currentStage, "purchaseInvoice");
  // And the classification is never written by a stage move.
  assert.equal("fulfilmentModel" in jobWork.set, false);
});
