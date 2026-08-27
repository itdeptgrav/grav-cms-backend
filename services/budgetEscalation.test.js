"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const e = require("./budgetEscalation.service");

/* The four kinds of person this rule cares about. */
const CEO_USER = { id: "u-ceo", name: "Ray", role: "owner", permissions: { canApprove: true } };
const CEO_TWO = { id: "u-ceo2", name: "Second Owner", role: "owner", permissions: { canApprove: true } };
const FINANCE_USER = { id: "u-fin", name: "Priya", role: "approver", permissions: { canApprove: true } };
const FINANCE_TWO = { id: "u-fin2", name: "Anil", role: "approver", permissions: { canApprove: true } };
const ACCOUNTANT = { id: "u-acc", name: "Sam", role: "accountant", permissions: { canEdit: true } };
const CLERK = { id: "u-clerk", name: "Riya", role: "editor", permissions: { canEdit: true } };

const sign = (sigs, user, reason) => {
  const r = e.addSignature(sigs, { user, reason, at: new Date("2026-08-27T10:00:00Z") });
  assert.equal(r.error, undefined, `expected a signature, got: ${r.error}`);
  return r.signatures;
};

/* ── WHO MAY SIGN AT ALL ─────────────────────────────────────────────────── */

test("an accountant who posts vouchers cannot approve going past a budget", () => {
  /* The whole point. Posting is their job; deciding a budget may be broken is
     not, and it was the two being the same person that made the old control a
     log rather than a gate. */
  assert.equal(e.maySign(ACCOUNTANT), false);
  assert.equal(e.maySign(CLERK), false);
  const { error, code } = e.addSignature([], { user: ACCOUNTANT, reason: "urgent" });
  assert.match(error, /Only finance or the CEO/);
  assert.equal(code, "BUDGET_ESCALATION_NOT_A_SIGNATORY");
});

test("finance fills the finance slot; only the owner can fill the CEO one", () => {
  assert.deepEqual(e.slotsFor(FINANCE_USER), ["finance"]);
  assert.deepEqual(e.slotsFor(CEO_USER), ["finance", "ceo"]);
});

test("the CEO slot is a role, never a permission", () => {
  /* An approver can be handed canApprove by anyone who edits the team. If the
     second signature could be handed out by the first, it is not a second. */
  const dressedUp = { id: "x", name: "Not the CEO", role: "approver", permissions: { canApprove: true, canPostDirectly: true } };
  assert.equal(e.slotsFor(dressedUp).includes("ceo"), false);
});

/* ── THE TWO SIGNATURES ──────────────────────────────────────────────────── */

test("finance then the CEO completes it", () => {
  let s = sign([], FINANCE_USER, "Peak-season surcharge outside our control.");
  assert.equal(e.isComplete(s), false);
  assert.equal(e.waitingOn(s), "ceo");
  assert.equal(e.describe(s), "Finance has approved. Waiting for the CEO.");

  s = sign(s, CEO_USER);
  assert.equal(e.isComplete(s), true);
  assert.equal(e.waitingOn(s), null);
  assert.deepEqual(s.map((x) => x.slot), ["finance", "ceo"]);
});

test("the CEO can go first, and finance closes it", () => {
  let s = sign([], CEO_USER, "I have agreed this with the plant.");
  assert.equal(e.waitingOn(s), "finance");
  s = sign(s, FINANCE_USER);
  assert.equal(e.isComplete(s), true);
});

test("nothing is approved until both have signed", () => {
  assert.equal(e.isComplete([]), false);
  assert.equal(e.isComplete(sign([], FINANCE_USER, "case")), false);
  assert.equal(e.isComplete(sign([], CEO_USER, "case")), false);
});

/* ── ONE PERSON IS NEVER TWO ─────────────────────────────────────────────── */

test("the CEO cannot sign both slots", () => {
  const s = sign([], CEO_USER, "case");
  const { error, code } = e.addSignature(s, { user: CEO_USER });
  assert.match(error, /already approved this/);
  assert.equal(code, "BUDGET_ESCALATION_SAME_PERSON");
  assert.equal(e.isComplete(s), false);
});

test("finance signing twice does not count as two", () => {
  const s = sign([], FINANCE_USER, "case");
  assert.equal(e.addSignature(s, { user: FINANCE_USER }).code, "BUDGET_ESCALATION_SAME_PERSON");
});

test("two approvers are still not enough — one has to be the CEO", () => {
  /* Both hold canApprove; neither is the owner. */
  const s = sign([], FINANCE_USER, "case");
  const second = e.addSignature(s, { user: FINANCE_TWO });
  /* Finance is taken and they cannot fill the CEO slot, so there is nothing
     for them to add. */
  assert.equal(second.code, "BUDGET_ESCALATION_ALREADY_SIGNED");
  assert.equal(e.isComplete(s), false);
  assert.equal(e.waitingOn(s), "ceo");
});

test("two owners are two people, and that is allowed", () => {
  const s = sign(sign([], CEO_USER, "case"), CEO_TWO);
  assert.equal(e.isComplete(s), true);
});

/* ── THE FIRST SIGNATURE MAKES THE CASE ──────────────────────────────────── */

test("the first signature has to say why", () => {
  const { error, code } = e.addSignature([], { user: FINANCE_USER, reason: "   " });
  assert.match(error, /Say why this budget should be exceeded/);
  assert.equal(code, "BUDGET_ESCALATION_REASON_REQUIRED");
});

test("the second may add a note but is not made to invent one", () => {
  /* A forced second reason produces "ok" and "approved", which read like
     reasons and are not. */
  const s = sign(sign([], FINANCE_USER, "Contracted rate rise."), CEO_USER);
  assert.equal(s[0].reason, "Contracted rate rise.");
  assert.equal(s[1].reason, null);
  const withNote = sign(sign([], FINANCE_USER, "Rate rise."), CEO_USER, "Once only — renegotiate.");
  assert.equal(withNote[1].reason, "Once only — renegotiate.");
});

test("a signature records who, in which slot, and when", () => {
  const s = sign([], FINANCE_USER, "case");
  assert.deepEqual(
    { slot: s[0].slot, userId: s[0].userId, name: s[0].name, role: s[0].role },
    { slot: "finance", userId: "u-fin", name: "Priya", role: "approver" },
  );
  assert.ok(s[0].at instanceof Date);
});

/* ── WHAT A SCREEN SAYS ──────────────────────────────────────────────────── */

test("the waiting-on sentence tracks the state", () => {
  assert.equal(e.describe([]), "Waiting for finance, then the CEO.");
  assert.equal(e.describe(sign([], CEO_USER, "c")), "Waiting for finance.");
  assert.equal(e.describe(sign(sign([], FINANCE_USER, "c"), CEO_USER)),
    "Approved by finance and the CEO.");
});

/* ── AN ORGANISATION THAT COULD NEVER SATISFY IT ─────────────────────────── */

test("one owner alone cannot produce two signatures, and that is said out loud", () => {
  /* Better to refuse at the moment somebody tries than to leave a voucher in
     a queue nothing will ever clear. */
  assert.equal(e.canEverBeSigned([CEO_USER]), false);
  assert.equal(e.canEverBeSigned([CEO_USER, ACCOUNTANT, CLERK]), false);
  assert.equal(e.canEverBeSigned([CEO_USER, FINANCE_USER]), true);
  assert.equal(e.canEverBeSigned([FINANCE_USER, FINANCE_TWO]), false, "no owner, no CEO signature");
  assert.equal(e.canEverBeSigned([]), false);
});
