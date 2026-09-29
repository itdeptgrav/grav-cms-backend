// services/manufacturing/sampleStyleReturn.service.js
//
// RETURNING A SAMPLE STYLE TO R&D WHEN ITS PRODUCTION ATTEMPT IS CANCELLED.
//
// ── THE HALF THAT WAS MISSING ───────────────────────────────────────────────
// Cancelling the work order moved the work order. It did not move the STYLE.
// `SampleStyle.production.status` stayed at "submitted", which is the state
// R&D's own page reads to decide what to show — so it kept rendering the
// "Sent to production" branch, kept hiding the operation-route panel, and told
// the reader to "Define the sample operation route in R&D" while making that
// panel unreachable. The instruction was correct and the door was locked.
//
// The style's production status is the authority for what R&D may do next, so
// returning the style is what actually reopens the work. That is this file.
//
// ── WHAT IT REFUSES TO DO ───────────────────────────────────────────────────
// It reopens route editing only when NO work order still governs the style —
// meaning every work order on it is cancelled. One live or completed order and
// the style stays where it is, because reopening it would invite a second
// production attempt alongside a real one that is still running, and would
// make a finished attempt look unfinished.
//
// Nothing is deleted. The cancelled work order, the manufacturing order, the
// customer request, the cutting records and the whole production log all stay
// exactly as they were; `workOrderIds` keeps every id it ever had. What
// changes is one status field and one appended log entry.

"use strict";

const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");

/* The one status that means an attempt has ended and no longer governs. */
const CANCELLED = "cancelled";

/**
 * The style whose production attempt this work order belongs to.
 *
 * `production.workOrderIds` is the authoritative link and the one the R&D page
 * itself reads back. The CustomerRequest also carries `sampleStyleId`, but
 * that is the commercial paper trail rather than the state R&D acts on, and a
 * request can exist for a style whose ids were never recorded.
 */
async function governingStyleFor(workOrderId) {
  if (!workOrderId) return null;
  return SampleStyle.findOne({ "production.workOrderIds": workOrderId });
}

/**
 * Where a style goes back to when its only production attempt is cancelled.
 *
 * NOT "not_started". The customer and the registered product are still linked
 * and still correct — what failed was the route, and sending R&D back to step
 * one would make them re-link a customer they never unlinked. The step the
 * route is defined on is the one whose product is registered.
 */
function reopenedStatusFor(style) {
  const p = style.production || {};
  if (p.stockItemId || style.sourceStockItemId) return "stock_item_linked";
  if (p.customerId) return "customer_linked";
  return "not_started";
}

/**
 * Which work orders still govern the style — that is, which are not cancelled.
 *
 * Read back from the WorkOrder collection rather than trusted from anything
 * passed in: the caller knows about the one it just cancelled and nothing
 * about the other four.
 */
async function governingWorkOrders(style) {
  const ids = (style.production?.workOrderIds || []).filter(Boolean);
  if (!ids.length) return [];
  const rows = await WorkOrder.find({ _id: { $in: ids } })
    .select("workOrderNumber status quantity completedQuantity").lean();
  return rows.filter((w) => w.status !== CANCELLED);
}

/** The `attempt_cancelled` entry already written for this work order, if any. */
function existingEntryFor(style, workOrderId) {
  return (style.production?.log || []).find(
    (l) => l.kind === "attempt_cancelled" && String(l.workOrderId || "") === String(workOrderId),
  ) || null;
}

/**
 * Return the style to route editing, if nothing still governs it.
 *
 * ── IDEMPOTENT, BECAUSE IT IS REACHED MORE THAN ONCE ────────────────────────
 * Three callers arrive here: the first cancellation, a replay of that same
 * call, and the repair that walks historical records whose style was never
 * reconciled. All three must leave the style in the same place, and only the
 * first may write an account of what happened — a second `attempt_cancelled`
 * entry would report the event twice in the log R&D actually reads.
 *
 * The entry is recognised by `workOrderId`, not by its prose, so rewording the
 * sentence cannot turn one event into two.
 *
 * @param {object} args
 * @param {object} args.style        a live SampleStyle document (not lean)
 * @param {object} args.workOrder    the work order that was cancelled
 * @param {object} args.actor        `{ id, name }` — who cancelled it, NOT
 *                                   whoever is replaying the call
 * @param {string} args.reason       the recorded cancellation reason
 * @param {Date}   [args.at]         when it was cancelled
 * @returns {Promise<{
 *   returned: boolean, alreadyReturned: boolean, wrote: boolean,
 *   status: string, previousStatus: string,
 *   blockedBy: Array<{ id, number, status }>, message: string,
 * }>}
 */
async function returnStyleToRouteEditing({ style, workOrder, actor, reason, at }) {
  const previousStatus = style.production?.status || "not_started";
  const blocking = await governingWorkOrders(style);

  if (blocking.length) {
    /* Named, not counted. "1 other work order" tells somebody nothing about
       which one to go and look at. */
    const blockedBy = blocking.map((w) => ({
      id: String(w._id), number: w.workOrderNumber || String(w._id), status: w.status,
    }));
    return {
      returned: false,
      alreadyReturned: false,
      wrote: false,
      status: previousStatus,
      previousStatus,
      blockedBy,
      message: blockedBy.length === 1
        ? `${blockedBy[0].number} is still ${blockedBy[0].status}, so this style is still in production and route editing stays closed.`
        : `${blockedBy.length} other work orders are still running on this style, so route editing stays closed.`,
    };
  }

  const status = reopenedStatusFor(style);
  style.production = style.production || {};
  style.production.log = style.production.log || [];

  const already = existingEntryFor(style, workOrder._id);
  const statusChanged = style.production.status !== status;

  if (!already) {
    style.production.log.push({
      kind: "attempt_cancelled",
      /* The reason travels into the style's own log, because this is the
         record R&D reads — a reason that lives only on the work order is a
         reason they would have to go and look for. */
      note: `${workOrder.workOrderNumber || "The work order"} was cancelled and the style returned for route editing. ${reason || ""}`.trim(),
      /* ── THE CANCELLATION'S OWN FACTS, NOT THE REPLAYING CALLER'S ────
         A repair run months later must not put its own operator's name and
         today's date against something somebody else did in September. Both
         are passed in from the stored `wo.cancellation`. */
      at: at || new Date(),
      by: actor,
      workOrderId: workOrder._id,
    });
  }

  if (statusChanged) style.production.status = status;

  /* Nothing to write is not a failure — it is what a correctly reconciled
     style looks like on the second call. */
  const wrote = Boolean(!already || statusChanged);
  if (wrote) {
    /* `updatedBy` is touched only when something actually changed, so a
       no-op replay does not restamp the style. */
    style.updatedBy = actor;
    await style.save();
  }

  return {
    returned: true,
    /* True when this call found the work already done — the caller can say
       "already back with R&D" rather than announcing it a second time. */
    alreadyReturned: !statusChanged && Boolean(already),
    wrote,
    status,
    previousStatus,
    blockedBy: [],
    message: !statusChanged && already
      ? "The style is already back with R&D — define the sample operation route, then send a new order to production."
      : "The style is back with R&D. Define the sample operation route, then send a new order to production.",
  };
}

module.exports = {
  CANCELLED,
  existingEntryFor,
  governingStyleFor,
  governingWorkOrders,
  reopenedStatusFor,
  returnStyleToRouteEditing,
};
