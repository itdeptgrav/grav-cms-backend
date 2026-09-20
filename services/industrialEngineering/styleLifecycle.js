// services/industrialEngineering/styleLifecycle.js
//
// IE LANE A — WHAT A STYLE'S LIFECYCLE MEANS TO A PRODUCTION ORDER.
//
// ── THE DECISION THIS IMPLEMENTS ────────────────────────────────────────────
// Company ownership is permanent record provenance. Lifecycle status controls
// QUEUE PARTICIPATION, not ownership. A completed, cancelled or archived style
// still proves whose work order this is — it just does not belong in an active
// Merchandising work queue.
//
// Before Lane A, a terminal style made its work order vanish from IE entirely.
// The audit measured the cost: of the seven orders whose two style references
// AGREED, only ONE was attributable. Lane A recovered FIVE of the remaining six
// — those refused because the style at the other end was completed, cancelled
// or inactive. The seventh is still refused, for a different and legitimate
// reason: its style has no provable company parentage, which Lane A did not
// touch and must not. A production order disappearing because somebody closed a
// development record is not a tenant boundary — it is data loss wearing one.
//
// ── AND A WARNING IS NOT A DEFECT ───────────────────────────────────────────
// A COMPLETED style feeding production is the normal case: development finished
// and the factory is making it. It gets no warning, ever. What gets a warning is
// a genuine contradiction between two stored facts — a style somebody cancelled
// while the floor is still working on it, or an archived record behind an open
// order. Anything else would be a warning nobody can act on, and a screen of
// those teaches people to ignore all of them.
"use strict";

const { STATUS_CLASS } = require("./orderStatus");

const str = (v) => String(v ?? "").trim();

/** `SampleStyle.status` — the style's own lifecycle. Default is `active`. */
const STYLE_STATUS = Object.freeze({
  ACTIVE: "active",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
});

/** The statuses that end a style's development. Terminal is not defective. */
const TERMINAL_STYLE_STATUSES = Object.freeze([STYLE_STATUS.COMPLETED, STYLE_STATUS.CANCELLED]);

/** Typed, so a screen can branch on the code rather than parse the prose. */
const LIFECYCLE_WARNING = Object.freeze({
  CANCELLED_STYLE_ON_ACTIVE_ORDER: "CANCELLED_STYLE_ON_ACTIVE_ORDER",
  INACTIVE_STYLE_ON_ACTIVE_ORDER: "INACTIVE_STYLE_ON_ACTIVE_ORDER",
});

const MESSAGE = Object.freeze({
  [LIFECYCLE_WARNING.CANCELLED_STYLE_ON_ACTIVE_ORDER]:
    "This order's style has been cancelled, but the order is still open. Either the cancellation "
    + "has not reached production or the order should not continue.",
  [LIFECYCLE_WARNING.INACTIVE_STYLE_ON_ACTIVE_ORDER]:
    "This order's style record has been archived, but the order is still open. The engineering "
    + "standard behind open work is no longer being maintained.",
});

/**
 * The safe lifecycle facts about ONE linked style, and any contradiction
 * between it and the order it is on.
 *
 * Every field is the style's OWN lifecycle. Nothing here reads or publishes a
 * Sales parent, a customer, a journey or an enquiry — the provenance that
 * proved the company stops at the proof, exactly as it does everywhere else in
 * this boundary.
 *
 * @param {object} style           lean SampleStyle with `status` and `isActive`
 * @param {string} orderStatusClass  from `orderStatus.statusClassOf`
 * @returns {{lifecycleStatus, recordActive, historical, warnings: object[]}}
 */
function styleLifecycleOf(style, orderStatusClass) {
  /* The model defaults `status` to `active`, so an absent value reads as
     active rather than as unknown — the stored fact, not a guess. */
  const lifecycleStatus = str(style?.status) || STYLE_STATUS.ACTIVE;
  const recordActive = style?.isActive !== false;
  const terminal = TERMINAL_STYLE_STATUSES.includes(lifecycleStatus);

  const warnings = [];
  /* ── ONLY WHERE THE ORDER IS STILL OPEN ──────────────────────────────────
     A cancelled or archived style behind a COMPLETED or CANCELLED order is
     ordinary history: the work finished, or it did not, and the record was
     closed afterwards. Warning about it would be a warning nobody can act on.
     The contradiction worth naming is the one that is still happening. */
  const orderOpen = orderStatusClass === STATUS_CLASS.OPERATIONAL;

  if (orderOpen && lifecycleStatus === STYLE_STATUS.CANCELLED) {
    warnings.push({
      code: LIFECYCLE_WARNING.CANCELLED_STYLE_ON_ACTIVE_ORDER,
      message: MESSAGE[LIFECYCLE_WARNING.CANCELLED_STYLE_ON_ACTIVE_ORDER],
    });
  }
  if (orderOpen && !recordActive) {
    warnings.push({
      code: LIFECYCLE_WARNING.INACTIVE_STYLE_ON_ACTIVE_ORDER,
      message: MESSAGE[LIFECYCLE_WARNING.INACTIVE_STYLE_ON_ACTIVE_ORDER],
    });
  }
  /* COMPLETED gets nothing, deliberately and permanently. Development that
     finished is what production is supposed to be built on. */

  return {
    lifecycleStatus,
    recordActive,
    /* "This is a record of past work, not current development." True for a
       terminal status OR an archived record — both are reasons a style is
       absent from an active Merchandising queue, and neither removes the
       order it proves. */
    historical: terminal || !recordActive,
    warnings,
  };
}

module.exports = {
  STYLE_STATUS, TERMINAL_STYLE_STATUSES, LIFECYCLE_WARNING, styleLifecycleOf,
};
