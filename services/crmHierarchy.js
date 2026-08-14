// services/crmHierarchy.js
//
// Cycle-safety for the two self-referential trees in the CRM foundation:
// account parent/child and site parent/child. A cycle here is not a cosmetic
// bug — the detail page walks the chain to render a hierarchy, so a loop is an
// infinite render and a hang. These are pure async guards so they can be unit
// tested against an in-memory database without any route or auth.

"use strict";

class HierarchyError extends Error {
  constructor(message) {
    super(message);
    this.name = "HierarchyError";
    this.status = 400;
  }
}

/**
 * Would setting `childId`'s parent to `proposedParentId` create a cycle?
 * Walks UP from the proposed parent; if we ever reach the child, the edge would
 * close a loop. Also rejects self-parenting outright. Bounded by a depth guard
 * so even a pre-existing corrupt loop can't hang the walk.
 *
 * @throws {HierarchyError}
 */
async function assertNoCycle(Model, parentField, childId, proposedParentId) {
  if (!proposedParentId) return; // detaching / root — always fine
  const child = String(childId);
  const parent = String(proposedParentId);

  if (child === parent) {
    throw new HierarchyError("A record cannot be its own parent.");
  }

  let cursor = parent;
  const seen = new Set();
  let hops = 0;
  while (cursor && hops < 1000) {
    if (cursor === child) {
      throw new HierarchyError("This change would create a circular hierarchy.");
    }
    if (seen.has(cursor)) break; // pre-existing loop elsewhere — not ours to fix here
    seen.add(cursor);
    hops += 1;
    const node = await Model.findById(cursor).select(parentField).lean();
    cursor = node?.[parentField] ? String(node[parentField]) : null;
  }
}

const assertNoAccountCycle = (Account, accountId, parentAccountId) =>
  assertNoCycle(Account, "parentAccountId", accountId, parentAccountId);

const assertNoSiteCycle = (Site, siteId, parentSiteId) =>
  assertNoCycle(Site, "parentSiteId", siteId, parentSiteId);

module.exports = {
  HierarchyError,
  assertNoCycle,
  assertNoAccountCycle,
  assertNoSiteCycle,
};
