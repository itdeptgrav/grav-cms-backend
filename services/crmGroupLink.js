// services/crmGroupLink.js
//
// One group structure, entered in one place.
//
// THE PROBLEM THIS FIXES. A corporate group — "Mayfair" with twenty hotels that
// each order for themselves — was expressible twice, and the two did not talk:
//
//   1. `Account.parentAccountId` — the real spine. Indexed, cycle-guarded
//      (services/crmHierarchy.js), and the thing GET /accounts/:id/hierarchy
//      walks to produce ancestors, children and siblings. No UI ever set it.
//   2. A `parent_of` / `subsidiary_of` row in CRMAccountRelationship — fully
//      exposed in Related Organizations, and structurally inert. Picking it
//      recorded a label and nothing else.
//
// So the only way a salesperson COULD say "this hotel belongs to Mayfair" was
// the way that did nothing: the group tree stayed empty, and every rollup that
// reads it silently reported one property.
//
// THE RULE (22 Aug 2026): a hierarchy relationship IS the parent link. Creating
// one sets `parentAccountId`; ending one clears it. Related Organizations
// remains the single place a group is entered, and the spine is always in step
// with it.
//
// AN ACCOUNT HAS EXACTLY ONE PARENT. That is what makes ancestor-walking
// terminate and what makes "the group" a single answer rather than a set. So a
// second, conflicting hierarchy link is REFUSED with the existing parent named,
// rather than silently reparenting the account out from under whoever set it.
//
// Pure and dependency-free apart from the cycle guard: it is handed models and
// a row, it returns or throws. Nothing here reads the request.

"use strict";

const { assertNoAccountCycle, HierarchyError } = require("./crmHierarchy");

/**
 * The two relationship types that mean "same corporate group", and which side
 * of the edge is the parent.
 *
 * `parent_of`     — from IS the parent of to.   child = to
 * `subsidiary_of` — from IS a subsidiary of to. child = from
 *
 * Every other type in RELATIONSHIP_TYPES (buying house, brand owner, billing
 * party, agent, freight forwarder, "related company") is a commercial edge, not
 * an ownership one: two accounts can hold several of those at once and none of
 * them implies a single parent. They are deliberately NOT in this map.
 */
const HIERARCHY_TYPES = {
  parent_of: "to",
  subsidiary_of: "from",
};

const isHierarchyType = (type) => Object.hasOwn(HIERARCHY_TYPES, String(type || ""));

/**
 * Which account does this row make a child, and of whom?
 * @returns {{childId: string, parentId: string}|null} null when not a group edge.
 */
function resolveGroupEdge(rel) {
  if (!rel || !isHierarchyType(rel.relationshipType)) return null;
  const childSide = HIERARCHY_TYPES[rel.relationshipType];
  const childId = childSide === "to" ? rel.toAccountId : rel.fromAccountId;
  const parentId = childSide === "to" ? rel.fromAccountId : rel.toAccountId;
  if (!childId || !parentId) return null;
  return { childId: String(childId), parentId: String(parentId) };
}

/**
 * Can this group edge be applied? Throws HierarchyError (status 400) if not.
 *
 * Called BEFORE the relationship row is created, so a refused group link never
 * leaves a dangling relationship behind — there are no transactions on this
 * connection, and validating first is what keeps the two stores consistent
 * without one.
 */
async function assertGroupEdgeApplicable(Account, rel) {
  const edge = resolveGroupEdge(rel);
  if (!edge) return null;

  const child = await Account.findById(edge.childId).select("companyName parentAccountId").lean();
  if (!child) throw new HierarchyError("That account no longer exists.");

  const existing = child.parentAccountId ? String(child.parentAccountId) : null;
  if (existing && existing !== edge.parentId) {
    const current = await Account.findById(existing).select("companyName accountId").lean();
    throw new HierarchyError(
      `${child.companyName} already belongs to ${current?.companyName || "another group"}` +
        `${current?.accountId ? ` (${current.accountId})` : ""}. An account has one parent — end that link first.`,
    );
  }

  await assertNoAccountCycle(Account, edge.childId, edge.parentId);
  return edge;
}

/**
 * Write the group edge onto the child. Assumes assertGroupEdgeApplicable has
 * already passed; idempotent, so re-running it changes nothing.
 */
async function applyGroupLink(Account, rel, actor) {
  const edge = resolveGroupEdge(rel);
  if (!edge) return null;
  await Account.findByIdAndUpdate(edge.childId, {
    parentAccountId: edge.parentId,
    ...(actor ? { updatedBy: actor } : {}),
  });
  return edge;
}

/**
 * Undo the group edge, when its relationship is ended or retyped.
 *
 * Conditional on purpose: it clears `parentAccountId` only when it still points
 * at THIS row's parent. If someone has since moved the account into a different
 * group, ending the old, now-irrelevant row must not detach it from the new
 * one.
 */
async function clearGroupLink(Account, rel, actor) {
  const edge = resolveGroupEdge(rel);
  if (!edge) return null;
  const child = await Account.findById(edge.childId).select("parentAccountId").lean();
  if (!child || String(child.parentAccountId || "") !== edge.parentId) return null;
  await Account.findByIdAndUpdate(edge.childId, {
    $unset: { parentAccountId: "" },
    ...(actor ? { $set: { updatedBy: actor } } : {}),
  });
  return edge;
}

module.exports = {
  HIERARCHY_TYPES,
  isHierarchyType,
  resolveGroupEdge,
  assertGroupEdgeApplicable,
  applyGroupLink,
  clearGroupLink,
};
