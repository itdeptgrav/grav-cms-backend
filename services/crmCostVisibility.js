// services/crmCostVisibility.js
//
// WHO MAY SEE WHAT OF A COSTING, as pure functions.
//
// Extracted from routes/CMS_Routes/Sales/enquiries.js so the rules can be
// tested without booting the route — that file lazily requires the Cowork
// sheets service, which requires firebaseAdmin, which throws without
// FIREBASE_SERVICE_ACCOUNT. Access rules that cannot be tested in the
// environment they ship from are access rules nobody checks.
//
// Sibling of crmVisibility.js, which does the same job for an Account's credit
// fields. Same shape, same reasoning: enforced on the server, because hiding a
// column in React while the endpoint still serves the rows is theatre.
//
// ── THE RULES (22 Aug 2026, explicit decisions) ────────────────────────────
//
// 1. SALES DOES NOT SEE COST. The deal owner and the sales manager used to get
//    cost per piece, on the reasoning that you cannot negotiate a number you
//    cannot see. That is reversed: Sales gets the floor price and nothing else,
//    so what they act on is "may I quote this" rather than "how much room is in
//    it". Cost stays with the people who build it and the people who own the
//    P&L — admin and CEO.
//
// 2. EACH DISCIPLINE SEES ITS OWN PART. A merchandiser on the raw-materials
//    sheet sees raw materials; an industrial engineer on operations sees
//    operations. Enforced through the membership the sheets already carry
//    (`assignee`, `members[]`, per part) rather than through a job title,
//    because the sheets are filled by Cowork identities and the CRM's JWT has
//    no reliable "is an industrial engineer" bit to read.
//
// 3. THE FLOOR IS A MARKUP, NOT A MARGIN. `cost × (1 + pct/100)`. See
//    services/costingTotals.js for why the distinction is load-bearing.

"use strict";

/** Cost per piece and its split. Org leadership and finance only. */
const COST_TIER_ROLES = new Set(["admin", "ceo"]);

/**
 * `isAdmin` is checked separately from `role`: an org admin browsing INTO Sales
 * has `role` overwritten to Sales' own legacy literal by deptAuth's
 * buildTokenPayload, so `role` alone cannot answer "is this an admin" once they
 * are inside a department. `isAdmin` is signed into the token unconditionally.
 */
function canSeeCost(user) {
  return Boolean(user?.isAdmin) || COST_TIER_ROLES.has(user?.role);
}

/**
 * Which tier of a costing this caller gets.
 *
 *   sheet  the workbook rows — vendor names with prices, SAM, cost per minute —
 *          for the parts they hold. See visibleParts.
 *   cost   cost per piece and its materials/operations split, whole.
 *   floor  the lowest sellable price. One number, no structure behind it.
 *
 * `isSalesManager` is deliberately NOT consulted: it returns true for admin and
 * CEO as well as Sales approvers, so it cannot separate the two, and separating
 * them is the entire point of rule 1.
 */
function costingTier(user, myRoleOnAnySheet) {
  if (myRoleOnAnySheet === "owner" || myRoleOnAnySheet === "editor") return "sheet";
  if (canSeeCost(user)) return "cost";
  return "floor";
}

/**
 * The parts of a costing this caller may open.
 *
 * A `combined` sheet is one document by definition and is shown whole to its
 * own members — it is not split back into halves it was never stored as.
 *
 * @param {object[]} parts   as built by the costing-sheet data route
 * @param {object|null} me   the Cowork identity, `{coworkEmployeeId}`
 * @param {boolean} all      true for a caller who may see everything
 */
function visibleParts(parts = [], me = null, all = false) {
  if (all) return parts;
  if (!me?.coworkEmployeeId) return [];
  return parts.filter(
    (p) =>
      p?.assignee?.employeeId === me.coworkEmployeeId ||
      (p?.members || []).some((m) => m?.employeeId === me.coworkEmployeeId),
  );
}

/**
 * The cost ledger, reduced to what this caller may have.
 *
 * `cost` is REMOVED, not nulled: a null would say "this product has no cost",
 * which is a different and untrue statement. What replaces it is the one number
 * a non-cost caller is allowed — the floor price — plus a `costed` flag so the
 * UI can tell "not costed yet" from "costed, and you may not see it".
 */
function reduceCostLedger(costLedger, canSee, markupPct = 22) {
  if (!Array.isArray(costLedger)) return costLedger;
  if (canSee) return costLedger;
  const pct = Math.min(500, Math.max(0, Number(markupPct) || 0));
  return costLedger.map((row) => {
    const l = row?.toObject ? row.toObject() : { ...row };
    const cost = Number(l.cost);
    const costed = Number.isFinite(cost) && cost > 0;
    delete l.cost;
    return { ...l, costed, floorPrice: costed ? +(cost * (1 + pct / 100)).toFixed(2) : null };
  });
}

module.exports = { COST_TIER_ROLES, canSeeCost, costingTier, visibleParts, reduceCostLedger };
