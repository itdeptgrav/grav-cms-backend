"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const s = require("./spendApproval.service");

const REQ = (over = {}) => ({ status: s.PENDING_TL, requestedById: "GR0069", ...over });
const TL = { employeeId: "GR0063", managedIds: ["GR0069", "GR0070"], isFinance: false };
const OTHER_TL = { employeeId: "GR0099", managedIds: ["GR0088"], isFinance: false };
const FIN = { employeeId: "GR0001", managedIds: [], isFinance: true };
const SELF = { employeeId: "GR0069", managedIds: [], isFinance: false };

/* ── WHERE A REQUEST STARTS ──────────────────────────────────────────────── */

test("an ordinary employee's request waits for their TL", () => {
  assert.equal(s.startingStatus({ managesPeople: false, hasApprover: true }), s.PENDING_TL);
});

test("a TL's own request skips the TL step and starts at finance", () => {
  /* A TL approving their own request is not an approval. Two other people are
     still between them and the money. */
  assert.equal(s.startingStatus({ managesPeople: true, hasApprover: true }), s.PENDING_FINANCE);
});

test("somebody with no manager at all starts at finance rather than nowhere", () => {
  /* Parking it against an approver who does not exist is a request nobody will
     ever action. */
  assert.equal(s.startingStatus({ managesPeople: false, hasApprover: false }), s.PENDING_FINANCE);
});

/* ── WHO MAY DECIDE ──────────────────────────────────────────────────────── */

test("the requester's own TL may take the TL step", () => {
  const d = s.decisionFor({ request: REQ(), viewer: TL });
  assert.deepEqual([d.can, d.step], [true, "tl"]);
});

test("a TL of another department may not", () => {
  const d = s.decisionFor({ request: REQ(), viewer: OTHER_TL });
  assert.equal(d.can, false);
  assert.match(d.reason, /waiting for the requester's TL/);
});

test("finance may not take the TL step, even though they will see it next", () => {
  /* Letting finance clear both steps would make a two-approval chain one
     person long. */
  const d = s.decisionFor({ request: REQ(), viewer: FIN });
  assert.equal(d.can, false);
});

test("finance takes the finance step; a TL cannot", () => {
  const atFinance = REQ({ status: s.PENDING_FINANCE });
  assert.equal(s.decisionFor({ request: atFinance, viewer: FIN }).step, "finance");
  const tl = s.decisionFor({ request: atFinance, viewer: TL });
  assert.equal(tl.can, false);
  assert.match(tl.reason, /Only finance/);
});

test("nobody approves their own request, at either step", () => {
  /* Including a TL who somehow reports to themselves, and a finance approver
     asking for their own software. */
  for (const status of [s.PENDING_TL, s.PENDING_FINANCE]) {
    const d = s.decisionFor({ request: REQ({ status }), viewer: { ...SELF, isFinance: true, managedIds: ["GR0069"] } });
    assert.equal(d.can, false, status);
    assert.match(d.reason, /your own request/);
  }
});

/* ── A REQUEST THAT IS NOT OPEN ──────────────────────────────────────────── */

test("an approved, ordered, rejected or withdrawn request takes no more decisions", () => {
  for (const status of [s.APPROVED, s.ORDERED, s.REJECTED, s.CANCELLED, s.DRAFT]) {
    const d = s.decisionFor({ request: REQ({ status }), viewer: FIN });
    assert.equal(d.can, false, status);
    assert.ok(d.reason.length, "and it says which state it is in");
  }
});

/* ── A ROW FROM BEFORE THE CHAIN EXISTED ─────────────────────────────────── */

test("a legacy `submitted` row is treated as waiting on the TL", () => {
  /* Written by the first version of the router. It must still be actionable
     rather than stuck in a state nothing recognises. */
  const legacy = REQ({ status: s.LEGACY_SUBMITTED });
  assert.equal(s.decisionFor({ request: legacy, viewer: TL }).step, "tl");
  assert.ok(s.OPEN_STATUSES.includes(s.LEGACY_SUBMITTED));
});

/* ── WHERE A YES LEAVES IT ───────────────────────────────────────────────── */

test("the TL's yes sends it to finance; finance's yes sends it to the store", () => {
  assert.equal(s.statusAfter("tl"), s.PENDING_FINANCE);
  assert.equal(s.statusAfter("finance"), s.APPROVED);
});

/* ── WHO FINANCE IS ──────────────────────────────────────────────────────── */

test("only the books' owners and approvers count as finance", () => {
  assert.equal(s.isFinanceApprover({ role: "owner" }), true);
  assert.equal(s.isFinanceApprover({ role: "approver" }), true);
  /* An editor enters vouchers. That is not the same as agreeing to spend. */
  assert.equal(s.isFinanceApprover({ role: "editor" }), false);
  assert.equal(s.isFinanceApprover({ role: "viewer" }), false);
  assert.equal(s.isFinanceApprover(null), false);
});

test("every state has a word for a screen", () => {
  for (const st of [s.DRAFT, s.PENDING_TL, s.PENDING_FINANCE, s.APPROVED,
                    s.ORDERED, s.REJECTED, s.CANCELLED, s.LEGACY_SUBMITTED]) {
    assert.ok(s.STAGE_LABEL[st], st);
  }
  assert.equal(s.STAGE_LABEL[s.APPROVED], "Approved — with Store for fulfilment");
});
