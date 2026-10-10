// services/mrfItemApproval.test.js — node:test, no database.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("./mrfItemApproval.service");

let seq = 0;
const line = (over = {}) => ({
  _id: `L${++seq}`,
  rawItem: `RI${seq}`,
  rawItemName: `Item ${seq}`,
  requestedQty: 10,
  unit: "Pcs",
  issuedQty: 0,
  itemStatus: "PENDING",
  ...over,
});

const pendingRequest = (n = 5, over = {}) => ({
  _id: "M1",
  mrfNumber: "MRF/2026-27/0024",
  status: "PENDING",
  tlApproved: false,
  tlRejected: false,
  approverName: "Rakesh Biswal",
  items: Array.from({ length: n }, () => line()),
  statusHistory: [{ action: "CREATED", actorName: "Pramod" }],
  ...over,
});

const actor = { id: "EMP-TL", name: "Rakesh Biswal", biometricId: "GR010" };
const ids = (m) => m.items.map((l) => l._id);

function decide(mrf, decisions) {
  const v = A.validateDecisions(mrf, decisions);
  assert.equal(v.ok, true, v.message);
  return A.applyDecisions(mrf, v.decisions, actor, new Date("2026-10-09T10:00:00Z"));
}

/* ── The headline case ─────────────────────────────────────────────────────── */

test("5 items: 3 approved and 2 rejected in one submission", () => {
  const m = pendingRequest(5);
  const [a, b, c, d, e] = ids(m);
  const r = decide(m, [
    { itemId: a, decision: "APPROVED" },
    { itemId: b, decision: "APPROVED" },
    { itemId: c, decision: "REJECTED", reason: "Not needed for this order" },
    { itemId: d, decision: "APPROVED" },
    { itemId: e, decision: "REJECTED", reason: "Duplicate of an earlier request" },
  ]);

  assert.equal(r.handedToStore, true);
  assert.equal(r.fullyRejected, false);
  assert.equal(m.status, "APPROVED", "the request is with the Store");
  assert.equal(m.tlApproved, true);
  assert.equal(m.approvalStatus, "PARTIALLY_APPROVED");
  assert.deepEqual(m.items.map((l) => l.itemStatus),
    ["APPROVED", "APPROVED", "REJECTED", "APPROVED", "REJECTED"]);
  assert.deepEqual(m.items.map((l) => A.isWithStore(l, m)), [true, true, false, true, false]);

  const rej = m.items[2].approval;
  assert.equal(rej.decision, "REJECTED");
  assert.equal(rej.reason, "Not needed for this order");
  assert.equal(rej.approvedQty, 0);
  assert.equal(rej.rejectedQty, 10);
  assert.equal(rej.decidedByName, "Rakesh Biswal");
  assert.equal(rej.decidedById, "GR010");
  assert.ok(rej.decidedAt instanceof Date);

  const acts = m.statusHistory.map((h) => h.action);
  assert.equal(acts.filter((x) => x === "ITEM_APPROVED").length, 3);
  assert.equal(acts.filter((x) => x === "ITEM_REJECTED").length, 2);
  assert.equal(acts.filter((x) => x === "TL_APPROVED").length, 1);
  const rejEv = m.statusHistory.find((h) => h.action === "ITEM_REJECTED");
  assert.equal(rejEv.itemId, c);
  assert.match(rejEv.detail, /Reason: Not needed for this order/);
});

/* ── Approved lines go to the Store at once ───────────────────────────────── */

test("approving 3 of 5 hands those 3 to the Store and leaves 2 waiting", () => {
  const m = pendingRequest(5);
  const [a, b, c] = ids(m);
  const r = decide(m, [
    { itemId: a, decision: "APPROVED" },
    { itemId: b, decision: "APPROVED" },
    { itemId: c, decision: "APPROVED" },
  ]);
  assert.equal(r.handedToStore, true);
  assert.equal(m.status, "APPROVED");
  assert.equal(m.approvalStatus, "PARTIALLY_PROCESSED");
  assert.deepEqual(A.awaitingLineIds(m), ids(m).slice(3));
  assert.deepEqual(m.items.map((l) => A.isWithStore(l, m)), [true, true, true, false, false]);
  assert.equal(m.items[3].approval.decision, "PENDING", "waiting lines are recorded, not derived");
  assert.equal(m.items[3].itemStatus, "PENDING");
  const s = A.approvalSummary(m);
  assert.deepEqual([s.awaiting, s.approved, s.rejected], [2, 3, 0]);
});

test("the remaining lines approved later also reach the Store; the hand-off is not repeated", () => {
  const m = pendingRequest(5);
  const [a, b, c, d, e] = ids(m);
  decide(m, [{ itemId: a, decision: "APPROVED" }, { itemId: b, decision: "APPROVED" }, { itemId: c, decision: "APPROVED" }]);
  const firstAt = m.tlApprovedAt;
  const r = A.applyDecisions(
    m,
    A.validateDecisions(m, [{ itemId: d, decision: "APPROVED" }, { itemId: e, decision: "APPROVED" }]).decisions,
    actor,
    new Date("2026-10-10T10:00:00Z"),
  );
  assert.equal(r.handedToStore, false);
  assert.equal(m.tlApprovedAt, firstAt);
  assert.equal(m.approvalStatus, "APPROVED");
  assert.deepEqual(A.awaitingLineIds(m), []);
  assert.ok(m.items.every((l) => A.isWithStore(l, m)));
  assert.equal(m.statusHistory.filter((h) => h.action === "TL_APPROVED").length, 1);
});

test("all approved", () => {
  const m = pendingRequest(3);
  decide(m, ids(m).map((itemId) => ({ itemId, decision: "approve" })));
  assert.equal(m.status, "APPROVED");
  assert.equal(m.approvalStatus, "APPROVED");
  assert.equal(m.tlApproved, true);
});

test("all rejected closes the request as REJECTED with every reason", () => {
  const m = pendingRequest(2);
  const [a, b] = ids(m);
  const r = decide(m, [
    { itemId: a, decision: "REJECTED", reason: "Over budget" },
    { itemId: b, decision: "REJECTED", reason: "Use the old stock" },
  ]);
  assert.equal(r.fullyRejected, true);
  assert.equal(r.handedToStore, false);
  assert.equal(m.status, "REJECTED");
  assert.equal(m.approvalStatus, "REJECTED");
  assert.equal(m.tlRejected, true);
  assert.equal(m.tlApproved, false);
  assert.equal(m.tlRejectionNote, "Over budget; Use the old stock");
  assert.ok(m.items.every((l) => !A.isWithStore(l, m)));
});

test("rejecting some first keeps the request off the Store's desk", () => {
  const m = pendingRequest(4);
  const [a, b, c, d] = ids(m);
  decide(m, [{ itemId: a, decision: "REJECTED", reason: "No" }]);
  assert.equal(m.status, "PENDING", "nothing approved yet — nothing for the Store");
  assert.equal(m.tlApproved, false);
  assert.equal(m.approvalStatus, "PARTIALLY_PROCESSED");

  decide(m, [{ itemId: b, decision: "APPROVED" }, { itemId: c, decision: "REJECTED", reason: "No" }, { itemId: d, decision: "APPROVED" }]);
  assert.equal(m.status, "APPROVED");
  assert.equal(m.approvalStatus, "PARTIALLY_APPROVED");
});

test("an unmatched (typed) line approved waits for the Store to match it", () => {
  const m = pendingRequest(1);
  m.items[0].rawItem = null;
  decide(m, [{ itemId: m.items[0]._id, decision: "APPROVED" }]);
  assert.equal(m.items[0].itemStatus, "UNMATCHED");
  assert.equal(A.isWithStore(m.items[0], m), true);
});

/* ── A reduced quantity ───────────────────────────────────────────────────── */

test("approving less than requested: the Store gets the approved quantity, the original is kept", () => {
  const m = pendingRequest(2);
  const [a, b] = ids(m);
  decide(m, [
    { itemId: a, decision: "APPROVED", approvedQty: 6, reason: "Six is enough this week" },
    { itemId: b, decision: "APPROVED" },
  ]);
  const l = m.items[0];
  assert.equal(l.requestedQty, 6, "the Store issues against requestedQty");
  assert.equal(l.approval.requestedQty, 10);
  assert.equal(l.approval.approvedQty, 6);
  assert.equal(l.approval.rejectedQty, 4);
  assert.equal(m.approvalStatus, "PARTIALLY_APPROVED", "part of the quantity was refused");
  assert.match(m.statusHistory.find((h) => h.action === "ITEM_APPROVED").detail, /6 Pcs of 10 Pcs approved/);
});

test("a reduced quantity needs a reason; the full quantity does not", () => {
  const m = pendingRequest(1);
  const v = A.validateDecisions(m, [{ itemId: m.items[0]._id, decision: "APPROVED", approvedQty: 4 }]);
  assert.equal(v.ok, false);
  assert.equal(v.field, "reason");
  assert.equal(A.validateDecisions(m, [{ itemId: m.items[0]._id, decision: "APPROVED", approvedQty: 10 }]).ok, true);
});

/* ── Refusals ─────────────────────────────────────────────────────────────── */

test("a rejection needs a reason", () => {
  const m = pendingRequest(1);
  const v = A.validateDecisions(m, [{ itemId: m.items[0]._id, decision: "REJECTED", reason: "  " }]);
  assert.equal(v.ok, false);
  assert.equal(v.field, "reason");
  assert.match(v.message, /Give a reason for rejecting/);
});

test("quantities outside 0 < q ≤ requested are refused", () => {
  const m = pendingRequest(1);
  const id = m.items[0]._id;
  for (const q of [0, -1, 11, "abc", Number.NaN]) {
    const v = A.validateDecisions(m, [{ itemId: id, decision: "APPROVED", approvedQty: q, reason: "x" }]);
    assert.equal(v.ok, false, `approvedQty ${q} was accepted`);
    assert.equal(v.field, "approvedQty");
  }
});

test("an empty submission, an unknown item, a duplicate and a bad decision are refused", () => {
  const m = pendingRequest(2);
  const [a] = ids(m);
  assert.equal(A.validateDecisions(m, []).ok, false);
  assert.equal(A.validateDecisions(m, null).ok, false);
  assert.equal(A.validateDecisions(m, [{ itemId: "nope", decision: "APPROVED" }]).ok, false);
  const dup = A.validateDecisions(m, [{ itemId: a, decision: "APPROVED" }, { itemId: a, decision: "REJECTED", reason: "x" }]);
  assert.equal(dup.ok, false);
  assert.match(dup.message, /decided twice/);
  assert.equal(A.validateDecisions(m, [{ itemId: a, decision: "MAYBE" }]).ok, false);
});

test("a decided line cannot be decided again (no duplicate approvals, no flip-flopping)", () => {
  const m = pendingRequest(2);
  const [a, b] = ids(m);
  decide(m, [{ itemId: a, decision: "APPROVED" }]);
  for (const again of [{ decision: "APPROVED" }, { decision: "REJECTED", reason: "changed my mind" }]) {
    const v = A.validateDecisions(m, [{ itemId: a, ...again }]);
    assert.equal(v.ok, false);
    assert.equal(v.code, "ALREADY_DECIDED");
    assert.match(v.message, /already approved by Rakesh Biswal/);
  }
  assert.equal(A.validateDecisions(m, [{ itemId: b, decision: "APPROVED" }]).ok, true);
});

test("nothing can be decided on a withdrawn request", () => {
  const m = pendingRequest(2, { status: "CANCELLED" });
  assert.deepEqual(A.awaitingLineIds(m), []);
  assert.equal(A.approvalSummary(m).status, "CANCELLED");
  assert.equal(A.approvalSummary(m).awaiting, 0);
});

/* ── The Store's status when the last waiting line is decided ─────────────── */

test("rejecting the last waiting line completes a request the Store already issued", () => {
  const m = pendingRequest(2);
  const [a, b] = ids(m);
  decide(m, [{ itemId: a, decision: "APPROVED" }]);
  // the Store issues line a in full while b still waits
  m.items[0].issuedQty = 10;
  m.items[0].itemStatus = "ISSUED";
  m.status = "PARTIALLY_ISSUED";
  decide(m, [{ itemId: b, decision: "REJECTED", reason: "Not needed now" }]);
  assert.equal(m.status, "ISSUED");
  assert.equal(m.approvalStatus, "PARTIALLY_APPROVED");
});

test("a request stays open while a line waits, even if every Store line is issued", () => {
  const m = pendingRequest(2);
  const [a] = ids(m);
  decide(m, [{ itemId: a, decision: "APPROVED" }]);
  m.items[0].itemStatus = "ISSUED";
  m.items[0].issuedQty = 10;
  m.status = "PARTIALLY_ISSUED";
  A.settleStoreStatus(m, new Date());
  assert.equal(m.status, "PARTIALLY_ISSUED");
});

test("rejecting the last waiting line closes a request the Store could not supply", () => {
  const m = pendingRequest(2);
  const [a, b] = ids(m);
  decide(m, [{ itemId: a, decision: "APPROVED" }]);
  m.items[0].itemStatus = "UNFULFILLED";
  decide(m, [{ itemId: b, decision: "REJECTED", reason: "No" }]);
  assert.equal(m.status, "UNFULFILLED");
});

/* ── Requests decided before item-wise approval ───────────────────────────── */

test("legacy: a whole-request rejection reads as every line rejected, with the note", () => {
  const m = pendingRequest(2, {
    status: "REJECTED", tlRejected: true, tlRejectionNote: "Not this month",
    tlRejectedByName: "Rakesh Biswal", tlRejectedAt: new Date("2026-09-01"),
  });
  m.items.forEach((l) => { l.itemStatus = "REJECTED"; });
  const a = A.lineApproval(m.items[0], m);
  assert.equal(a.decision, "REJECTED");
  assert.equal(a.reason, "Not this month");
  assert.equal(a.recorded, false);
  assert.equal(A.approvalStatusOf(m), "REJECTED");
});

test("legacy: an approval with lines rejected reads as partially approved", () => {
  const m = pendingRequest(3, {
    status: "APPROVED", tlApproved: true, tlApprovedByName: "Rakesh Biswal",
    statusHistory: [{ action: "TL_APPROVED", detail: "Approved with 1 item(s) rejected." }],
  });
  m.items[0].itemStatus = "APPROVED";
  m.items[1].itemStatus = "UNMATCHED";
  m.items[2].itemStatus = "REJECTED";
  assert.deepEqual(m.items.map((l) => A.lineApproval(l, m).decision), ["APPROVED", "APPROVED", "REJECTED"]);
  assert.equal(A.approvalStatusOf(m), "PARTIALLY_APPROVED");
});

test("legacy: a line the STORE rejected (its note in storeNotes) was still approved by the manager", () => {
  const m = pendingRequest(2, {
    status: "APPROVED", tlApproved: true,
    statusHistory: [{ action: "TL_APPROVED", detail: "Approved and forwarded to the Store." }],
  });
  m.items[0].itemStatus = "APPROVED";
  m.items[1].itemStatus = "REJECTED";
  m.items[1].storeNotes = "We cannot source this";
  assert.equal(A.lineApproval(m.items[1], m).decision, "APPROVED");
  assert.equal(A.approvalStatusOf(m), "APPROVED");
});

test("legacy: cancelling an approved request does not turn its lines into manager rejections", () => {
  const m = pendingRequest(2, {
    status: "CANCELLED", tlApproved: true,
    statusHistory: [{ action: "TL_APPROVED", detail: "Approved and forwarded to the Store." }],
  });
  m.items.forEach((l) => { l.itemStatus = "REJECTED"; });
  assert.ok(m.items.every((l) => A.lineApproval(l, m).decision === "APPROVED"));
});

test("legacy: auto-forwarded and store-raised requests were approved by nobody", () => {
  for (const over of [{ autoForwarded: true }, { creationMode: "BYPASS" }]) {
    const m = pendingRequest(1, { status: "APPROVED", ...over });
    const a = A.lineApproval(m.items[0], m);
    assert.equal(a.decision, "APPROVED");
    assert.equal(a.automatic, true);
    assert.equal(A.isAwaitingApproval(m.items[0], m), false);
  }
});

test("legacy: a pending request's lines are all awaiting", () => {
  const m = pendingRequest(3);
  assert.equal(A.approvalStatusOf(m), "AWAITING_APPROVAL");
  assert.equal(A.awaitingLineIds(m).length, 3);
});

/* ── What the screens are sent ────────────────────────────────────────────── */

test("annotate stamps every line and the request with the derived answer", () => {
  const m = pendingRequest(2);
  const [a] = ids(m);
  decide(m, [{ itemId: a, decision: "APPROVED", approvedQty: 7, reason: "Seven" }]);
  const plain = JSON.parse(JSON.stringify(m));
  A.annotate(plain);
  assert.equal(plain.approvalStatus, "PARTIALLY_PROCESSED");
  assert.equal(plain.approvalStatusLabel, "Partially processed");
  assert.deepEqual(plain.approvalCounts, { total: 2, awaiting: 1, approved: 1, rejected: 0, reduced: 1 });
  assert.equal(plain.items[0].withStore, true);
  assert.equal(plain.items[0].awaitingApproval, false);
  assert.equal(plain.items[0].approval.approvedQty, 7);
  assert.equal(plain.items[1].awaitingApproval, true);
  assert.equal(plain.items[1].withStore, false);
});

test("the stored-or-legacy match covers requests with no stored approval status", () => {
  const q = A.approvalStatusMatch(A.AWAITING_STATUSES);
  assert.deepEqual(q.$or[0], { approvalStatus: { $in: ["AWAITING_APPROVAL", "PARTIALLY_PROCESSED"] } });
  assert.deepEqual(q.$or[1].$and[1], { $or: [{ status: "PENDING" }] });
});
