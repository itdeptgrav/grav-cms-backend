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
 * The walk itself, over a caller-supplied node loader.
 *
 * ── WHY A LOADER AND NOT A MODEL ───────────────────────────────────────────
 * This used to take a Mongoose model and call `Model.findById(cursor)`, which
 * reads across every company. That made the guard a tenancy hole in the shape
 * of a safety check: propose a foreign account as your parent and the walk
 * happily loaded it, confirmed no cycle, and the edge was written — joining
 * your account to somebody else's group. Worse, the walk UP then read that
 * company's whole ancestor chain to decide.
 *
 * The loader is where the company clause lives. This function cannot read
 * anything the caller has not already scoped, and it never sees a model.
 *
 * `requireParent` decides what a parent that does not load means. For the
 * account tree it is a refusal, and deliberately the SAME refusal a genuinely
 * missing parent gets: a distinct "that account belongs to another company"
 * would confirm the account exists. For an ancestor further up, a node that
 * does not load simply ends the walk — a chain that leaves the company is a
 * chain this company may not traverse.
 *
 * @throws {HierarchyError}
 */
async function walkForCycle(loadNode, parentField, childId, proposedParentId, { requireParent = false } = {}) {
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
    const node = await loadNode(cursor);
    if (!node && hops === 0 && requireParent) {
      throw new HierarchyError("That parent account was not found.");
    }
    hops += 1;
    cursor = node?.[parentField] ? String(node[parentField]) : null;
  }
}

/**
 * Would setting `childId`'s parent to `proposedParentId` create a cycle?
 * Walks UP from the proposed parent; if we ever reach the child, the edge would
 * close a loop. Also rejects self-parenting outright. Bounded by a depth guard
 * so even a pre-existing corrupt loop can't hang the walk.
 *
 * Model-based, and therefore UNSCOPED — kept for the Site tree, which has no
 * company of its own yet. Do not reach for it from an Account path: use
 * `assertNoAccountCycle` with a scoped loader.
 *
 * @throws {HierarchyError}
 */
async function assertNoCycle(Model, parentField, childId, proposedParentId) {
  return walkForCycle(
    (id) => Model.findById(id).select(parentField).lean(),
    parentField, childId, proposedParentId,
  );
}

/**
 * Account cycle-safety, within one company.
 *
 * `loadAccount` is `(id) => Promise<{parentAccountId}|null>` and MUST carry the
 * company clause — from `scopedFilter(req, …)` on a route, or from the trusted
 * service context in a service. Passing a model is a programming error and
 * fails loudly rather than reading globally: that is exactly the mistake this
 * signature exists to make impossible.
 *
 * The company is never inferred from the proposed parent. The actor's company
 * decides what may be loaded; the parent either falls inside it or is absent.
 */
async function assertNoAccountCycle(loadAccount, accountId, parentAccountId) {
  if (typeof loadAccount !== "function") {
    throw new TypeError(
      "assertNoAccountCycle needs a company-scoped loader function, not a model. " +
      "An unscoped account walk can join records across companies.",
    );
  }
  return walkForCycle(loadAccount, "parentAccountId", accountId, parentAccountId, { requireParent: true });
}

const assertNoSiteCycle = (Site, siteId, parentSiteId) =>
  assertNoCycle(Site, "parentSiteId", siteId, parentSiteId);

module.exports = {
  HierarchyError,
  walkForCycle,
  assertNoCycle,
  assertNoAccountCycle,
  assertNoSiteCycle,
};
