// services/sales/handoverAuthority.js
//
// WHO MAY HAND A CONFIRMED ORDER LINE TO MERCHANDISING.
//
// ── WHY THIS EXISTS RATHER THAN `bypassesApproval` ──────────────────────────
// The producer originally reused `bypassesApproval(req.user)`, the rule the
// older Sales approval paths use. It answers from the JWT alone:
//
//     ["sales", "ceo"].includes(user.role) || Boolean(user.isAdmin)
//
// Every part of that is a claim minted at sign-in and carried for seven days.
// A Sales grant withdrawn this morning still reads as authority until the
// token expires. A platform administrator, who may hold no Sales grant at all
// and appear nowhere in Access Control's Sales list, is admitted everywhere.
// And `role` is department text, so anyone whose token says "sales" passes
// regardless of what level they were actually granted.
//
// That is legacy behaviour in the routes that already have it, and this does
// not touch them: rewriting the quotation and costing approval gates is its
// own piece of work with its own regression surface. But issuing a handover is
// a NEW permanent commercial contract — it states what the company has
// promised a buyer and when, and it opens an Execution File that a factory
// will work to. A new contract does not get to inherit an old shortcut.
//
// ── WHAT IS CHECKED, EVERY REQUEST ──────────────────────────────────────────
// The LIVE `sales` department grant, re-read from `DepartmentRole` through
// `getEffectiveRole`, which returns null for a row whose `isActive` is false.
// A revoked or downgraded grant therefore fails on the very NEXT request
// rather than whenever a token happens to expire.
//
//   viewer / editor   may INSPECT the order's handover panel
//   approver / owner  may ISSUE, SUPERSEDE and CANCEL
//
// Inspection sits at viewer because seeing which lines are eligible, and why
// one is not, is reading the order — anybody trusted with the order can see
// it. Issuing sits at approver because it is a commitment.
//
// ── AND WHAT GRANTS NOTHING HERE ────────────────────────────────────────────
// `isAdmin`. The CEO or Board seat. A `merchandiser` grant of any level — the
// receiving department cannot author the statement it receives. Any other
// department. Being the person who created the order, or who is named on it:
// relationship to a record has never been authority in this system and does
// not become authority here.
//
// The acting company is proven separately, by the Sales scope resolver. Holding
// a Sales approver grant does not say WHICH company's orders you may act on,
// and this deliberately does not answer that question.
"use strict";

const { getEffectiveRole } = require("../departmentRoles");
const { roleAtLeast } = require("../../models/Access/DepartmentRole");
const { fail, sendError } = require("../storePurchase/errors");

const DEPARTMENT = "sales";

const ROLE = Object.freeze({
  VIEWER: "viewer", EDITOR: "editor", APPROVER: "approver", OWNER: "owner",
});

/** The two things this door is asked to authorise. */
const HANDOVER_ACTION = Object.freeze({
  INSPECT: "sales.merchandising_handover.inspect",
  ISSUE: "sales.merchandising_handover.issue",
});

/** The weakest Sales role that may take each action. */
const ACTION_MINIMUM_ROLE = Object.freeze({
  [HANDOVER_ACTION.INSPECT]: ROLE.VIEWER,
  [HANDOVER_ACTION.ISSUE]: ROLE.APPROVER,
});

/** The live Sales role this actor holds right now, or null. */
async function liveSalesRole(req) {
  return (await getEffectiveRole(DEPARTMENT, req)) || null;
}

/**
 * Refuse unless this actor's LIVE Sales grant allows `action`.
 *
 * The refusal names the department, the action and the level required — never
 * anything about the record being reached for, so a refusal cannot be used to
 * ask whether an order exists.
 *
 * @returns {Promise<string>} the role they actually hold.
 */
async function requireSalesHandoverAuthority(req, action) {
  const minimumRole = ACTION_MINIMUM_ROLE[action];
  if (!minimumRole) throw fail("FORBIDDEN", "That is not an action this door offers.");

  const role = await liveSalesRole(req);
  if (!role || !roleAtLeast(role, minimumRole)) {
    throw fail(
      "FORBIDDEN",
      minimumRole === ROLE.VIEWER
        ? "This order is the sales team's."
        : "Handing an order to Merchandising is a commercial commitment, and it needs a Sales role that allows it.",
      { requires: { department: DEPARTMENT, action, minimumRole } },
    );
  }
  return role;
}

/** The same rule as Express middleware, so a route states its level once. */
const salesHandoverAuthority = (action) => async (req, res, next) => {
  try {
    req.salesHandoverRole = await requireSalesHandoverAuthority(req, action);
    next();
  } catch (err) {
    sendError(res, err);
  }
};

module.exports = {
  DEPARTMENT, ROLE, HANDOVER_ACTION, ACTION_MINIMUM_ROLE,
  liveSalesRole, requireSalesHandoverAuthority, salesHandoverAuthority,
};
