// services/requestIntake.test.js
//
// WHO DECIDES WHAT, AND IN WHAT ORDER.
//
// The rules that decide where a request starts, who may move it and what may
// be asked of whom. Pure functions, so they are tested without a database:
// every one of these is a decision about people and none of them needs a row.
//
// The thing under test is a claim about the company, not about code: the
// requester is never asked how the company fulfils things, the manager is
// never asked about money, and stock the company already owns never waits for
// finance.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const intake = require("./requestIntake.service");

/* ══ WHERE A REQUEST STARTS ═════════════════════════════════════════════════ */

test("a request with a department chain waits for the first approver", () => {
  assert.equal(intake.startingStatus({ chainLength: 2 }), intake.PENDING_TL);
});

test("the most senior person in a department skips approval entirely", () => {
  /* The rule that replaced "do they manage anybody". A lead with two reports
     still has a department head above them; the question is whether anybody
     stands above this person INSIDE their own department. An empty chain means
     nobody does — which is an answer, not a failure. */
  assert.equal(intake.startingStatus({ chainLength: 0 }), intake.NEEDS_CLASSIFICATION);
});

test("no arguments is the safe reading, not a crash", () => {
  assert.equal(intake.startingStatus(), intake.NEEDS_CLASSIFICATION);
});

/* ══ THE MANAGER STEP ═══════════════════════════════════════════════════════ */

const waiting = (over = {}) => ({
  status: intake.PENDING_TL,
  requestedById: "E-100",
  ...over,
});

test("a manager may approve their own report's request", () => {
  const v = intake.decisionFor({
    request: waiting(),
    viewer: { employeeId: "E-900", managedIds: ["E-100", "E-101"] },
  });
  assert.equal(v.can, true);
  assert.equal(v.step, "tl");
});

test("a manager of another department may not", () => {
  const v = intake.decisionFor({
    request: waiting(),
    viewer: { employeeId: "E-900", managedIds: ["E-500"] },
  });
  assert.equal(v.can, false);
  assert.match(v.reason, /waiting for the requester's manager/i);
});

test("nobody approves their own request, even a manager who reports to nobody", () => {
  const v = intake.decisionFor({
    request: waiting({ requestedById: "E-900" }),
    viewer: { employeeId: "E-900", managedIds: ["E-900"] },
  });
  assert.equal(v.can, false);
  assert.match(v.reason, /your own request/i);
});

test("a request past the manager step is not decided there again", () => {
  const v = intake.decisionFor({
    request: waiting({ status: intake.NEEDS_CLASSIFICATION }),
    viewer: { employeeId: "E-900", managedIds: ["E-100"] },
  });
  assert.equal(v.can, false);
  // The refusal names where the request actually is, in the desk's own words.
  assert.match(v.reason, /With Store for fulfilment/);
});

/* ══ THE CLASSIFICATION STEP ════════════════════════════════════════════════ */

const toClassify = (over = {}) => ({ status: intake.NEEDS_CLASSIFICATION, ...over });

test("store and purchase may classify", () => {
  const v = intake.classificationFor({
    request: toClassify(),
    viewer: { canFulfil: true },
  });
  assert.equal(v.can, true);
});

test("an ordinary employee may not — that is the whole point of the unified intake", () => {
  const v = intake.classificationFor({
    request: toClassify(),
    viewer: { canFulfil: false },
  });
  assert.equal(v.can, false);
  assert.match(v.reason, /Store & Purchase or finance/i);
});

test("a request the manager has not seen yet cannot be classified", () => {
  const v = intake.classificationFor({
    request: toClassify({ status: intake.PENDING_TL }),
    viewer: { canFulfil: true },
  });
  assert.equal(v.can, false);
  assert.match(v.reason, /Waiting for department approval/);
});

test("classifying twice is refused in those words, not as a generic state error", () => {
  const v = intake.classificationFor({
    request: toClassify({ status: intake.PURCHASE_REQUIRED }),
    viewer: { canFulfil: true },
  });
  assert.equal(v.can, false);
  assert.match(v.reason, /already been classified/i);
});

/* ══ WHICH WAYS OUT NEED FINANCE ════════════════════════════════════════════ */

test("stock the company already owns needs no finance approval", () => {
  // Nothing leaves the bank account, so there is no money question to ask.
  assert.equal(intake.needsFinance("store_issue"), false);
});

test("everything that leaves the bank account needs finance", () => {
  assert.equal(intake.needsFinance("purchase"), true);
  assert.equal(intake.needsFinance("service"), true);
  assert.equal(intake.needsFinance("recurring"), true);
});

test("an unknown way out is not quietly treated as free", () => {
  assert.equal(intake.needsFinance("teleportation"), false);
  assert.equal(intake.kindOf("teleportation"), null);
});

test("each way out knows which collection it becomes", () => {
  assert.equal(intake.KINDS.store_issue.becomes, "mrf");
  assert.equal(intake.KINDS.purchase.becomes, "spend");
  assert.equal(intake.KINDS.purchase.spendType, "PRODUCT");
  assert.equal(intake.KINDS.service.spendType, "SERVICE");
});

/* ══ WHAT THE MANAGER MUST DECIDE ═══════════════════════════════════════════ */

test("a manager cannot approve without naming a budget head", () => {
  // The choice moved off the requester, who does not know it, and off Store,
  // who knows the shelf rather than the department's envelope.
  const r = intake.readyToApprove({});
  assert.equal(r.ok, false);
  assert.match(r.reason, /budget head/i);
});

test("an approved head is enough", () => {
  assert.equal(intake.readyToApprove({ ledgerId: "64b000000000000000000001" }).ok, true);
});

test("or a head asked for in words, with a reason", () => {
  // The escape hatch, and the reason requiring a head is not a trap: a
  // department with nothing approved must still be able to ask.
  assert.equal(
    intake.readyToApprove({ unbudgetedHead: true, requestedHeadName: "Drone hire" }).ok,
    false,
  );
  assert.equal(
    intake.readyToApprove({
      unbudgetedHead: true, requestedHeadName: "", requestedHeadReason: "Nothing fits",
    }).ok,
    false,
  );
  assert.equal(
    intake.readyToApprove({
      unbudgetedHead: true, requestedHeadName: "Drone hire", requestedHeadReason: "Nothing fits",
    }).ok,
    true,
  );
});

/* ══ WHAT CLASSIFICATION MAY BE BLOCKED ON ══════════════════════════════════ */

test("a store issue needs no head — nothing leaves the bank account", () => {
  assert.equal(intake.readyToClassify({ kind: "store_issue", hasApprovedHead: false }).ok, true);
});

test("a spend route without a head is sent back, not given one here", () => {
  // Store is fulfilling a decision, not making one. A request that arrived
  // headless goes back to the manager rather than being patched up by the
  // person on this chain who knows the budget least.
  for (const kind of ["purchase", "service", "recurring"]) {
    const r = intake.readyToClassify({ kind, hasApprovedHead: false, schedule: { frequency: "MONTHLY" } });
    assert.equal(r.ok, false, kind);
    assert.match(r.reason, /back to the requester's manager/i);
  }
});

test("with the manager's head in place, the spend routes are ready", () => {
  assert.equal(intake.readyToClassify({ kind: "purchase", hasApprovedHead: true }).ok, true);
  assert.equal(intake.readyToClassify({ kind: "service", hasApprovedHead: true }).ok, true);
});

test("a recurring spend still needs a frequency of its own", () => {
  const noFreq = intake.readyToClassify({ kind: "recurring", hasApprovedHead: true });
  assert.equal(noFreq.ok, false);
  assert.match(noFreq.reason, /how often/i);

  const bad = intake.readyToClassify({
    kind: "recurring", hasApprovedHead: true, schedule: { frequency: "FORTNIGHTLY" },
  });
  assert.equal(bad.ok, false);

  const good = intake.readyToClassify({
    kind: "recurring", hasApprovedHead: true, schedule: { frequency: "QUARTERLY" },
  });
  assert.equal(good.ok, true);
});

/* ══ THE TWO KINDS OF ASK ═══════════════════════════════════════════════════ */

test("there are two request types and there is no third", () => {
  // A subscription is work and access bought from a vendor — which is what
  // SERVICE already means. A third option only asked people to draw a line
  // that does not exist.
  assert.deepEqual(intake.REQUEST_TYPES, ["PRODUCT", "SERVICE"]);
  assert.equal(intake.REQUEST_TYPE_LABEL.PRODUCT, "Product");
  assert.equal(intake.REQUEST_TYPE_LABEL.SERVICE, "Service");
  assert.equal(intake.REQUEST_TYPES.includes("SOFTWARE"), false);
});

test("each type says what belongs in it, so nobody has to guess", () => {
  assert.match(intake.REQUEST_TYPE_HINT.PRODUCT, /stock|purchase/i);
  // The list that stops somebody hunting for a "software" option.
  assert.match(intake.REQUEST_TYPE_HINT.SERVICE, /software/i);
  assert.match(intake.REQUEST_TYPE_HINT.SERVICE, /AMC/);
});

/* ══ THE WORDS ══════════════════════════════════════════════════════════════ */

test("no state label leaks a backend type name at the requester", () => {
  for (const [status, label] of Object.entries(intake.STAGE_LABEL)) {
    assert.ok(label.length > 0, `${status} has no label`);
    assert.doesNotMatch(label, /_/, `${status} reads as an enum: ${label}`);
    assert.doesNotMatch(label, /MRF|SpendRequest/i, `${status} names a collection: ${label}`);
  }
});

test("every status has a label and every label belongs to a status", () => {
  assert.deepEqual(Object.keys(intake.STAGE_LABEL).sort(), [...intake.STATUSES].sort());
});

test("every way out has a label a person would say out loud", () => {
  for (const id of intake.KIND_IDS) {
    assert.doesNotMatch(intake.KINDS[id].label, /_/);
  }
});

test("every MRF state the desk can meet has a sentence for it", () => {
  // Composed here rather than read from MRF's router, which builds its labels
  // for its own screens. A state with no entry would render as PARTIALLY_ISSUED.
  for (const s of [
    "PENDING", "APPROVED", "PARTIALLY_ISSUED", "ISSUED",
    "PARTIALLY_RETURNED", "COMPLETED", "REJECTED", "UNFULFILLED", "CANCELLED",
  ]) {
    assert.ok(intake.MRF_STAGE_LABEL[s], `${s} has no label`);
    assert.doesNotMatch(intake.MRF_STAGE_LABEL[s], /_/);
  }
});

test("the settled MRF states are the ones nothing further happens in", () => {
  assert.deepEqual(intake.SETTLED_MRF.slice().sort(), [
    "CANCELLED", "COMPLETED", "REJECTED", "UNFULFILLED",
  ]);
  // Deliberately NOT issued or partly issued: a request whose stock is out is
  // still moving — it has returns ahead of it.
  assert.ok(!intake.SETTLED_MRF.includes("ISSUED"));
});
