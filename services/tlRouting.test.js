// services/tlRouting.test.js
//
// The TL entitlement rule, without a database.
//
// The route tests prove this end to end across three collections; these prove
// the rule itself, which is where the edge cases actually live: a blank
// viewer id, a request that names nobody, a manager whose session presents
// their other id. Those are cheap to state here and expensive to arrange
// through HTTP.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const r = require("./tlRouting.service");

/** A request as stored: addressed to GR-MGR, raised by GR-EMP. */
const REQ = (over = {}) => ({
  requestedById: "GR-EMP",
  approverBiometricId: "GR-MGR",
  approverAltIds: ["GR-MGR"],
  approverName: "Meera Lenka",
  ...over,
});

/** One raised before approver routing existed: nobody is named. */
const LEGACY = (over = {}) => ({ requestedById: "GR-EMP", ...over });

const MGR = { employeeId: "GR-MGR", managedIds: ["GR-EMP"] };
const OTHER_MGR = { employeeId: "GR-OTH", managedIds: ["GR-SOMEONE"] };
const PEER = { employeeId: "GR-PEER", managedIds: [] };
const SELF = { employeeId: "GR-EMP", managedIds: [] };

/* ── THE STORED APPROVER IS THE ANSWER ───────────────────────────────────── */

test("the manager the request was addressed to may take the TL step", () => {
  const v = r.tlEntitlement({ request: REQ(), viewer: MGR });
  assert.equal(v.can, true);
  assert.equal(v.via, "stored");
});

test("another manager may not, and is told who it is waiting for", () => {
  const v = r.tlEntitlement({ request: REQ(), viewer: OTHER_MGR });
  assert.equal(v.can, false);
  assert.match(v.reason, /waiting for Meera Lenka/);
});

test("somebody who manages nobody may not", () => {
  assert.equal(r.tlEntitlement({ request: REQ(), viewer: PEER }).can, false);
});

test("the requester may not, even when they are their own manager in HR", () => {
  /* The one arrangement where "do I manage this person" answers yes for the
     requester. The self-check runs first, so it cannot be reached. */
  const v = r.tlEntitlement({
    request: LEGACY(),
    viewer: { employeeId: "GR-EMP", managedIds: ["GR-EMP"] },
  });
  assert.equal(v.can, false);
  assert.match(v.reason, /your own request/i);
});

test("managing the requester today does NOT override who was actually asked", () => {
  /* HR moved this person under a new manager after the request was raised.
     An approval is a record of who was asked, not a function of the org
     chart's current state. */
  const v = r.tlEntitlement({
    request: REQ(),
    viewer: { employeeId: "GR-NEW", managedIds: ["GR-EMP"] },
  });
  assert.equal(v.can, false);
});

test("the manager's other id matches too", () => {
  /* A CoWork session presents whichever of biometricId/identityId its own doc
     carries, and only the session knows which. Both are stored for exactly
     this. */
  const req = REQ({ approverBiometricId: "BIO-9", approverAltIds: ["BIO-9", "ID-9"] });
  assert.equal(r.tlEntitlement({ request: req, viewer: { employeeId: "ID-9" } }).can, true);
});

/* ── AND LIVE HR ONLY WHEN NOBODY WAS NAMED ──────────────────────────────── */

test("a request that names nobody falls back to the live reporting line", () => {
  const v = r.tlEntitlement({ request: LEGACY(), viewer: MGR });
  assert.equal(v.can, true);
  assert.equal(v.via, "legacy_hr");
});

test("and the fallback is still only for the viewer's own people", () => {
  assert.equal(r.tlEntitlement({ request: LEGACY(), viewer: OTHER_MGR }).can, false);
  assert.equal(r.tlEntitlement({ request: LEGACY(), viewer: PEER }).can, false);
});

test("a viewer with no id at all matches nothing", () => {
  /* An employee whose HR record carries neither id has no identity here, and
     an empty string must never be treated as one — it would equal every
     request whose approver field is blank. */
  const v = r.tlEntitlement({ request: REQ(), viewer: { employeeId: "", managedIds: [] } });
  assert.equal(v.can, false);
});

test("the refusal is worded for the desk that asked", () => {
  const asManager = r.tlEntitlement({ request: LEGACY(), viewer: PEER });
  const asTl = r.tlEntitlement({ request: LEGACY(), viewer: PEER, roleWord: "TL" });
  assert.match(asManager.reason, /manager/);
  assert.match(asTl.reason, /TL/);
});

/* ── THE QUEUE ASKS THE SAME QUESTION ────────────────────────────────────── */

test("the queue clause selects what is addressed to me and my legacy rows", () => {
  const c = r.tlQueueClause({ viewer: MGR, statuses: ["pending_tl"] });
  assert.deepEqual(c.status, { $in: ["pending_tl"] });
  /* Addressed by either id, or a legacy row from one of my own people. */
  assert.equal(c.$or.length, 3);
  assert.deepEqual(c.$or[0], { approverBiometricId: "GR-MGR" });
  assert.deepEqual(c.$or[1], { approverAltIds: "GR-MGR" });
  /* Never my own, at any step. */
  assert.deepEqual(c.requestedById, { $ne: "GR-MGR" });
});

test("the legacy branch requires BOTH no stored approver and my own report", () => {
  const c = r.tlQueueClause({ viewer: MGR, statuses: ["pending_tl"] });
  const legacy = c.$or.find((b) => b.$and);
  assert.ok(legacy, "there is a legacy branch");
  assert.deepEqual(legacy.$and[1], { requestedById: { $in: ["GR-EMP"] } });
});

test("somebody who is neither an approver nor a manager holds no TL rows", () => {
  assert.equal(
    r.tlQueueClause({ viewer: { employeeId: "", managedIds: [] }, statuses: ["pending_tl"] }),
    null,
  );
});

test("a manager with no reports still sees what is addressed to them", () => {
  /* Their last report left the company. The requests they were asked about do
     not stop being theirs. */
  const c = r.tlQueueClause({ viewer: { employeeId: "GR-MGR", managedIds: [] }, statuses: ["x"] });
  assert.equal(c.$or.length, 2);
  assert.ok(!c.$or.some((b) => b.$and));
});

/* ── READING WHAT IS STORED ──────────────────────────────────────────────── */

test("stored ids are de-duplicated and blanks dropped", () => {
  assert.deepEqual(
    r.storedApproverIds({ approverBiometricId: "A", approverAltIds: ["A", "", null, "B"] }),
    ["A", "B"],
  );
});

test("a request with only alt ids still counts as addressed", () => {
  assert.equal(r.hasStoredApprover({ approverAltIds: ["ID-9"] }), true);
  assert.equal(r.hasStoredApprover({ approverBiometricId: "" }), false);
  assert.equal(r.hasStoredApprover({}), false);
});
