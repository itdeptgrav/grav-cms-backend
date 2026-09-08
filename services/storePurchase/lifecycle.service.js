// services/storePurchase/lifecycle.service.js
//
// Store & Purchase — Chunk 1. WHAT MAY BE DELETED, AND WHAT MUST BE CANCELLED.
//
// ── THE RULE ────────────────────────────────────────────────────────────────
// A draft nobody has acted on may be deleted. Anything that has moved stock,
// money or a supplier's expectations is CANCELLED — a recorded decision with
// an actor and a reason — because deleting it destroys the only evidence that
// it happened. Chunk 0 found the opposite in place: `DELETE /api/cms/raw-items/:id`
// removes an item together with its entire embedded movement history, with no
// guard against open purchase orders or material requests referencing it.
//
// ── WHY NO ARCHIVE FIELDS HERE ──────────────────────────────────────────────
// "Used masters are archived, not deleted" needs an archive lifecycle on the
// item master — which is Chunk 2's model. Adding one now would be starting
// that chunk. So Chunk 1 adds the GUARD (a used master cannot be destroyed)
// and leaves the archive state to the chunk that owns the model.
"use strict";

const { fail } = require("./errors");

/**
 * Refuse a delete that would destroy evidence.
 *
 * @param {Array<{collection, count, describe}>} references
 */
function assertDeletable({ entityLabel, state, deletableStates, references = [] }) {
  const blocking = references.filter((r) => r && r.count > 0);

  if (deletableStates && !deletableStates.includes(state)) {
    throw fail(
      "LIFECYCLE_BLOCKED",
      `A ${entityLabel} that is ${humanState(state)} cannot be deleted. Cancel it instead, so the record of what happened is kept.`,
      {
        reason: "STATE_NOT_DELETABLE",
        state,
        deletableStates,
        suggestedAction: "CANCEL",
        blockingReferences: blocking.map(describeRef),
      },
    );
  }

  if (blocking.length) {
    throw fail(
      "LIFECYCLE_BLOCKED",
      `This ${entityLabel} is referenced by other records and cannot be deleted.`,
      {
        reason: "HAS_REFERENCES",
        suggestedAction: "CANCEL",
        blockingReferences: blocking.map(describeRef),
      },
    );
  }
}

const describeRef = (r) => ({
  collection: r.collection,
  count: r.count,
  description: r.describe || `${r.count} referencing record(s) in ${r.collection}`,
});

/** User-facing state wording. Never the raw enum. */
function humanState(state) {
  const map = {
    DRAFT: "still a draft",
    ISSUED: "issued to a supplier",
    PARTIALLY_RECEIVED: "partly received",
    COMPLETED: "completed",
    CANCELLED: "cancelled",
  };
  return map[state] || "past the draft stage";
}

/** A cancellation is a decision: it needs an actor's reason, always. */
function assertCancellable({ entityLabel, state, cancellableStates, reason }) {
  if (!cancellableStates.includes(state)) {
    throw fail(
      "INVALID_TRANSITION",
      `A ${entityLabel} that is ${humanState(state)} cannot be cancelled.`,
      { state, cancellableStates },
    );
  }
  if (!String(reason || "").trim()) {
    throw fail("VALIDATION", "Cancelling needs a reason, so the record explains itself later.", {
      field: "reason",
    });
  }
}

/**
 * The purchase-order transition table, stated once.
 *
 * Everything not listed is refused. Two absences are deliberate:
 *
 *   · Nothing returns a commercial document to DRAFT. An issued order has
 *     been sent to a supplier; "un-issuing" it would erase a commitment
 *     somebody else is acting on. Chunk 6's amendment document is how an
 *     issued order changes.
 *   · PARTIALLY_RECEIVED and COMPLETED are not reachable by request at all.
 *     They are consequences of receiving goods, computed from the received
 *     quantities, and letting a caller assert them would let an order claim
 *     receipts that never happened.
 */
const PO_TRANSITIONS = Object.freeze({
  DRAFT: ["ISSUED", "CANCELLED"],
  ISSUED: ["CANCELLED"],           // and only with no receipts — checked separately
  PARTIALLY_RECEIVED: [],
  COMPLETED: [],
  CANCELLED: [],
});

/** Statuses a caller may ask for. The rest are derived by receiving. */
const PO_REQUESTABLE = Object.freeze(["ISSUED", "CANCELLED"]);

/**
 * @returns {{noop: boolean}} `noop` is true for a same-state request, which
 *          the caller must treat as success WITHOUT appending history — a
 *          re-issue of an issued order is not a second issuance.
 */
function assertTransition({ entityLabel = "purchase order", from, to, table = PO_TRANSITIONS }) {
  if (from === to) return { noop: true };

  const allowed = table[from];
  if (!allowed) {
    throw fail("INVALID_TRANSITION", `A ${entityLabel} in this state cannot be changed.`, {
      state: from, requested: to,
    });
  }
  if (!allowed.includes(to)) {
    throw fail(
      "INVALID_TRANSITION",
      `A ${entityLabel} that is ${humanState(from)} cannot be ${humanState(to).replace(/^still a /, "")}.`,
      { state: from, requested: to, allowed },
    );
  }
  return { noop: false };
}

module.exports = {
  assertDeletable, assertCancellable, humanState, describeRef,
  assertTransition, PO_TRANSITIONS, PO_REQUESTABLE,
};
