/**
 * GRAV-CMS-BACKEND/services/budgetEscalation.service.js
 *
 * WHO HAS TO SAY YES BEFORE A BUDGET IS BROKEN.
 *
 * ── THE HOLE THIS CLOSES ────────────────────────────────────────────────────
 * The budget control refused an over-budget post until somebody typed a
 * reason, and then let it through. That reads like an approval and is not one:
 * posting vouchers is the accounts job, and everyone who does that job — the
 * accountant, the owner, an approver, an admin — is on the direct-post list.
 * So the person spending past the budget was always also the person allowed to
 * wave it through. It was a log, not a gate. The department whose money it was
 * never even heard about it.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * Going past a budget needs TWO people, and one of them is the CEO:
 *
 *   · one signature from finance   — anybody who may approve
 *   · one signature from the CEO   — the organisation's owner
 *
 * They must be two DIFFERENT people. An owner cannot fill both slots, and a
 * voucher cannot be cleared by whoever raised it unless they hold approval
 * authority — in which case their own written case IS their signature, because
 * finance saying "here is why" is finance approving it. Nobody signs twice.
 *
 * No threshold. Every rupee past an allocation escalates, which is the whole
 * point: a budget that can be broken quietly by any amount is not a budget.
 *
 * ── WHY THIS IS ITS OWN FILE ────────────────────────────────────────────────
 * The same rule governs three different things — an over-budget voucher, a
 * supplementary that raises an allocation, and a transfer that moves one. If
 * only the voucher escalated, the way round the CEO would be obvious: ask the
 * department to raise a top-up instead, have finance approve it alone, and the
 * voucher then posts inside budget with nobody escalating anything. Same
 * money, no CEO. One rule, in one place, applied to all three.
 */

"use strict";

/** The two signatures, in the order a case for them is normally made. */
const FINANCE = "finance";
const CEO = "ceo";
const REQUIRED = [FINANCE, CEO];

/** Which slots a person is allowed to fill. */
function slotsFor(user) {
  const role = String(user?.role || "").toLowerCase();
  const canApprove = Boolean(user?.permissions?.canApprove) || role === "owner";
  const slots = [];
  if (canApprove) slots.push(FINANCE);
  /* Only the owner is the CEO. Deliberately a role and not a permission: an
     approver can be given canApprove by anybody who can edit the team, and a
     gate whose second signature is handed out by the first is not a gate. */
  if (role === "owner") slots.push(CEO);
  return slots;
}

/** May this person sign at all? */
const maySign = (user) => slotsFor(user).length > 0;

const idOf = (user) => String(user?.id ?? user?._id ?? "").trim();

/**
 * Which slot this person should fill next, given what is already signed.
 *
 * An owner can stand in for finance when finance has not signed, and the other
 * way round is impossible — that asymmetry is the rule. Returns null when the
 * person has nothing left to add, either because they cannot sign or because
 * every slot they could fill is taken.
 */
function slotToFill(signatures = [], user) {
  const taken = new Set(signatures.map((s) => s.slot));
  const already = signatures.some((s) => s.userId && s.userId === idOf(user));
  /* Nobody signs twice. Two signatures from one person is one person. */
  if (already) return null;

  const mine = slotsFor(user);
  /* CEO first when they can fill it: an owner who signs the finance slot and
     then finds nobody else can sign the CEO one has blocked their own
     voucher. */
  if (mine.includes(CEO) && !taken.has(CEO)) return CEO;
  if (mine.includes(FINANCE) && !taken.has(FINANCE)) return FINANCE;
  return null;
}

/** Are both signatures in, from two different people? */
function isComplete(signatures = []) {
  const slots = new Set(signatures.map((s) => s.slot));
  const people = new Set(signatures.map((s) => s.userId).filter(Boolean));
  return REQUIRED.every((r) => slots.has(r)) && people.size >= REQUIRED.length;
}

/** What it is still waiting for — "finance", "ceo", or null when it is done. */
function waitingOn(signatures = []) {
  if (isComplete(signatures)) return null;
  const taken = new Set(signatures.map((s) => s.slot));
  return REQUIRED.find((r) => !taken.has(r)) ?? null;
}

/** The sentence a screen shows about where it has got to. */
function describe(signatures = []) {
  const next = waitingOn(signatures);
  if (!next) return "Approved by finance and the CEO.";
  const signed = signatures.find((s) => s.slot !== next);
  if (!signed) return "Waiting for finance, then the CEO.";
  return next === CEO ? "Finance has approved. Waiting for the CEO." : "Waiting for finance.";
}

/**
 * Add one person's signature.
 *
 * Returns `{ signatures }` on success or `{ error, code }` on refusal, rather
 * than throwing: every caller turns this into an HTTP response and a thrown
 * error there is just a try/catch that says the same thing.
 *
 * The first signature has to carry a reason — it is the case being made. The
 * second may add a note but is not forced to invent one, because a required
 * second reason produces "ok" and "approved", which read like reasons and are
 * not.
 */
function addSignature(signatures = [], { user, reason, at = new Date() } = {}) {
  if (!maySign(user)) {
    return {
      error: "Only finance or the CEO can approve going past a budget.",
      code: "BUDGET_ESCALATION_NOT_A_SIGNATORY",
    };
  }

  const slot = slotToFill(signatures, user);
  if (!slot) {
    const already = signatures.some((s) => s.userId && s.userId === idOf(user));
    return already
      ? {
          error: "You have already approved this. It needs a second person.",
          code: "BUDGET_ESCALATION_SAME_PERSON",
        }
      : {
          error: "This has already been approved.",
          code: "BUDGET_ESCALATION_ALREADY_SIGNED",
        };
  }

  const text = String(reason || "").trim();
  if (!signatures.length && !text) {
    return {
      error: "Say why this budget should be exceeded.",
      code: "BUDGET_ESCALATION_REASON_REQUIRED",
    };
  }

  return {
    signatures: [
      ...signatures,
      {
        slot,
        userId: idOf(user) || null,
        name: user?.name || user?.email || "",
        role: String(user?.role || "").toLowerCase() || null,
        reason: text || null,
        at,
      },
    ],
  };
}

/**
 * Can this organisation satisfy the rule at all?
 *
 * Two distinct people, one of them the owner. An organisation where only the
 * owner can approve cannot produce two signatures, and the honest answer there
 * is to say so at the moment somebody tries — not to leave a voucher sitting
 * in a queue that nothing will ever clear.
 */
function canEverBeSigned(signatories = []) {
  const owners = signatories.filter((u) => String(u?.role || "").toLowerCase() === "owner");
  const approvers = signatories.filter(maySign);
  return owners.length > 0 && approvers.length >= 2;
}

module.exports = {
  FINANCE,
  CEO,
  REQUIRED,
  slotsFor,
  maySign,
  slotToFill,
  isComplete,
  waitingOn,
  describe,
  addSignature,
  canEverBeSigned,
};
