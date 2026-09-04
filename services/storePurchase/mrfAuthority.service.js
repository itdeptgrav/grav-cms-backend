// services/storePurchase/mrfAuthority.service.js
//
// Store & Purchase — Chunk 1B. WHO MAY DO WHAT TO A MATERIAL REQUEST.
//
// ── TWO KINDS OF AUTHORITY, AND WHY THEY MUST NOT BE MERGED ─────────────────
// The purchase-order side is entirely capability-based: you may issue an order
// because somebody granted you `sp.po.issue`. Material requests are not like
// that, and forcing them into the same shape would break the app for the
// people who use it most.
//
//   RELATIONSHIP authority — a requester may read and cancel THEIR OWN
//     request; a manager may decide the requests ROUTED TO THEM by the org
//     chart. Neither needs a Store & Purchase grant, and giving every
//     employee one so they can ask for a screwdriver would make the grant
//     meaningless. This authority comes from the document: `requestedFor`,
//     `approverBiometricId`, `approverAltIds`.
//
//   CAPABILITY authority — the Store's work on somebody else's request:
//     matching a line to the catalogue, recording availability, deciding
//     fulfilment, issuing and returning stock. That is a job, it is granted,
//     and `sp.mrf.fulfil` / `sp.stock.issue` / `sp.stock.return` name it.
//
// The rule that ties them together: relationship authority NEVER grants a
// Store power, and a Store capability never makes somebody the assigned
// approver. A requester cannot approve their own request by holding a grant,
// and a storekeeper cannot decide a request the org chart routed elsewhere.
"use strict";

const { CAPABILITIES, hasAll } = require("./capabilities");
const { fail } = require("./errors");

/** Every id a person could be known by across the two doors. */
function actorIdentifiers(ctx, employee) {
  const ids = new Set();
  if (employee?.biometricId) ids.add(String(employee.biometricId));
  if (employee?.identityId) ids.add(String(employee.identityId));
  if (ctx?.actorEmployeeId) ids.add(String(ctx.actorEmployeeId));
  return ids;
}

/** Is this actor the person the request is FOR? */
function isRequester(mrf, ctx, employee) {
  if (!mrf) return false;
  const requestedFor = mrf.requestedFor?._id || mrf.requestedFor;
  if (employee?._id && requestedFor && String(requestedFor) === String(employee._id)) return true;
  /* `requestedForId` is the badge number, and the cowork door knows a person
     by exactly that — so a requester arriving through Cowork is recognised
     even when the ObjectId is not to hand. */
  const ids = actorIdentifiers(ctx, employee);
  return Boolean(mrf.requestedForId && ids.has(String(mrf.requestedForId)));
}

/**
 * Is this actor the approver the ORG CHART routed this request to?
 *
 * Matched against every id the request recorded at creation
 * (`approverBiometricId` plus `approverAltIds`, which exist because an HR
 * record can carry both a biometricId and an identityId and a session may
 * present either). Being *a* manager is not enough — it must be THIS request.
 */
function isAssignedApprover(mrf, ctx, employee) {
  if (!mrf) return false;
  const ids = actorIdentifiers(ctx, employee);
  if (employee?._id && mrf.approverEmployee && String(mrf.approverEmployee) === String(employee._id)) {
    return true;
  }
  if (mrf.approverBiometricId && ids.has(String(mrf.approverBiometricId))) return true;
  return (mrf.approverAltIds || []).some((id) => ids.has(String(id)));
}

/** Does this actor hold the Store's fulfilment authority? */
const isStoreActor = (ctx) => hasAll(ctx.capabilitySet, CAPABILITIES.MRF_FULFIL);

/**
 * May this actor SEE this request at all?
 *
 * Tenancy has already been applied by the query — this decides visibility
 * within the company.
 */
function canView(mrf, ctx, employee) {
  return (
    isRequester(mrf, ctx, employee) ||
    isAssignedApprover(mrf, ctx, employee) ||
    hasAll(ctx.capabilitySet, CAPABILITIES.READ)
  );
}

/**
 * The store may only act once the request has actually reached it.
 *
 * Preserved exactly as the route already defines it — TL-approved, or
 * auto-forwarded because no TL could be resolved, or raised by the store on
 * somebody's behalf. Chunk 1B changes who may act, not when.
 */
const isStoreActionable = (mrf) =>
  Boolean(mrf?.tlApproved || mrf?.autoForwarded || mrf?.creationMode === "BYPASS" || mrf?.pmApproved);

/** Terminal states nothing may act on further. */
const CLOSED_STATES = new Set(["REJECTED", "CANCELLED", "COMPLETED", "UNFULFILLED"]);

/**
 * The authority matrix, asserted in one place.
 *
 * @param {string} action  one of the keys below
 */
function assertMay(action, { mrf, ctx, employee }) {
  const requester = isRequester(mrf, ctx, employee);
  const approver = isAssignedApprover(mrf, ctx, employee);
  const store = isStoreActor(ctx);

  const forbid = (message, details = {}) => { throw fail("FORBIDDEN", message, details); };
  /* A request the actor may not even see is answered as missing, so the
     endpoint cannot be used to discover that a request exists. */
  const hide = () => { throw fail("NOT_FOUND", "That material request was not found."); };

  switch (action) {
    case "VIEW":
      if (!canView(mrf, ctx, employee)) hide();
      return { via: requester ? "requester" : approver ? "approver" : "store" };

    case "CANCEL":
      /* The requester may withdraw their own ask; the store may cancel one it
         is handling. Nobody else, and not once it is closed. */
      if (!requester && !store) {
        if (!canView(mrf, ctx, employee)) hide();
        forbid("Only the person who raised this request, or the store, can cancel it.");
      }
      if (CLOSED_STATES.has(mrf.status)) {
        throw fail("INVALID_TRANSITION", "This request is already closed.", { state: mrf.status });
      }
      return { via: requester ? "requester" : "store" };

    case "APPROVE":
    case "REJECT":
      /* THE decision that must not be spoofable. Holding a Store capability
         does not make somebody the assigned approver, and being the requester
         certainly does not. */
      if (!approver) {
        if (!canView(mrf, ctx, employee)) hide();
        forbid("This request is not waiting for your approval.");
      }
      /* Self-approval, unconditionally. The earlier guard only fired when no
         approver was recorded, so a malformed record naming the requester as
         its own approver — which the routing fallback can produce when a
         person's manager is themselves — passed straight through. Whether the
         collision is data entry or a bug, one person must not be both sides of
         a decision. */
      if (requester) {
        forbid("A request cannot be approved by the person who raised it.", {
          reason: "SELF_APPROVAL",
        });
      }
      if (mrf.status !== "PENDING") {
        throw fail("INVALID_TRANSITION",
          mrf.tlApproved ? "This request has already been approved."
            : mrf.tlRejected ? "This request has already been rejected."
              : "This request is not waiting for a decision.",
          { state: mrf.status });
      }
      return { via: "approver" };

    case "MATCH":
    case "REGISTER":
    case "AVAILABILITY":
    case "FULFILMENT_DECISION":
    case "UNFULFILLED":
      if (!store) {
        if (!canView(mrf, ctx, employee)) hide();
        forbid("You do not have permission to fulfil material requests.",
          { required: [CAPABILITIES.MRF_FULFIL] });
      }
      if (!isStoreActionable(mrf)) {
        throw fail("INVALID_TRANSITION",
          "This request has not been approved yet, so the store cannot act on it.",
          { state: mrf.status });
      }
      if (CLOSED_STATES.has(mrf.status)) {
        throw fail("INVALID_TRANSITION", "This request is already closed.", { state: mrf.status });
      }
      return { via: "store" };

    case "ISSUE":
      if (!hasAll(ctx.capabilitySet, CAPABILITIES.STOCK_ISSUE)) {
        if (!canView(mrf, ctx, employee)) hide();
        forbid("You do not have permission to issue stock.", { required: [CAPABILITIES.STOCK_ISSUE] });
      }
      if (!isStoreActionable(mrf)) {
        throw fail("INVALID_TRANSITION",
          "This request has not been approved yet, so nothing can be issued against it.",
          { state: mrf.status });
      }
      if (CLOSED_STATES.has(mrf.status)) {
        throw fail("INVALID_TRANSITION", "This request is already closed.", { state: mrf.status });
      }
      return { via: "store" };

    case "RETURN":
      if (!hasAll(ctx.capabilitySet, CAPABILITIES.STOCK_RETURN)) {
        if (!canView(mrf, ctx, employee)) hide();
        forbid("You do not have permission to record returns.", { required: [CAPABILITIES.STOCK_RETURN] });
      }
      /* A return is possible after closure — material comes back after a
         request completes — so CLOSED_STATES is deliberately not applied. */
      return { via: "store" };

    case "CHAT":
      /* Anybody who may see the request may talk about it. */
      if (!canView(mrf, ctx, employee)) hide();
      return { via: requester ? "requester" : approver ? "approver" : "store" };

    default:
      throw fail("VALIDATION", `Unknown material-request action "${action}".`);
  }
}

module.exports = {
  assertMay, canView, isRequester, isAssignedApprover, isStoreActor,
  isStoreActionable, CLOSED_STATES,
};
