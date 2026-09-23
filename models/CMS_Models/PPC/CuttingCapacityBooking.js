// models/CMS_Models/PPC/CuttingCapacityBooking.js
//
// PPC RESERVES CALCULATED CAPACITY ON A CUTTING-OWNED RESOURCE.
//
// A booking is PPC saying: this plan takes these minutes, on that table, on
// these days. It is made from a preview PPC read, against a standard
// Industrial Engineering approved and a roster Cutting published, and it is
// the thing that makes a cutting date real rather than typed.
//
// ── THE FOUR THINGS IT IS NOT ───────────────────────────────────────────────
//   1  Not Cutting's acceptance. Cutting answers a published target on its own
//      door, and that answer is a different record with a different owner.
//      A booking can exist that Cutting has refused, and a refusal releases
//      nothing here.
//   2  Not a departmental deadline. Reserving a table does not commit the
//      cutting room to a date; only Cutting's own acceptance does.
//   3  Not actual output. What was cut is `CuttingMasterRecord`'s and stays
//      there. There is no field here for a quantity cut and no completion.
//   4  Not a Production release. Nothing here starts work or authorises a run.
//
// ── WHY TWO COLLECTIONS ─────────────────────────────────────────────────────
// A booking is a DECISION: which plan, which resource, which days, how many
// minutes each, and what it was proved against. It is permanent evidence and
// is never edited — it is RELEASED or SUPERSEDED by a successor.
//
// The resource-day counter is a SUM: how many minutes are reserved on one
// resource on one day. It exists so that "never more than the day offers" is
// a fact the DATABASE enforces. A sum cannot be a unique index, so it is one
// document per (company, resource, day) — unique — whose `reservedMinutes` is
// only ever moved by a conditional `$inc` that matches when the result still
// fits. Two planners racing for the last free hour both issue that update;
// exactly one matches, and the other's whole transaction rolls back.
//
// This is the same shape `PpcCapacityBooking` uses for sewing lines, and it is
// deliberately a SEPARATE pair rather than a discriminator on that one: a
// sewing line is PPC's own record and a cutting resource is Cutting's, the two
// ledgers are keyed on different owners' ids, and one collection holding both
// would make a Cutting roster change a risk to a sewing booking.
"use strict";

const mongoose = require("mongoose");

const BOOKING_STATE = Object.freeze({
  ACTIVE: "ACTIVE",
  RELEASED: "RELEASED",
  SUPERSEDED: "SUPERSEDED",
});
const BOOKING_STATES = Object.freeze(Object.values(BOOKING_STATE));

const RELEASE_REASON = Object.freeze([
  "PLAN_CHANGED", "ORDER_CANCELLED", "STANDARD_CHANGED", "RESOURCE_CHANGED",
  "CALENDAR_CHANGED", "CAPACITY_CONFLICT", "OTHER",
]);

const LIMITS = Object.freeze({ REASON: 2000, ALLOCATIONS: 400, ROLES: 10, HISTORY: 200 });

const businessDate = {
  type: String, required: true, trim: true,
  validate: { validator: (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v)), message: "A date is YYYY-MM-DD." },
};

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true, default: "" },
});

/** One day of the reservation: what the resource offered, what this plan took. */
const allocationSchema = new mongoose.Schema(
  {
    date: businessDate,
    /* What the resource offered that day, after its own efficiency — kept so
       a reader can see the reservation against the day it was made on, even
       after Cutting republishes the roster. */
    availableMinutes: { type: Number, required: true, min: 0 },
    reservedMinutes: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const crewRoleSchema = new mongoose.Schema(
  {
    role: { type: String, trim: true, required: true },
    count: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const eventSchema = new mongoose.Schema(
  {
    type: { type: String, required: true },
    at: { type: Date, required: true },
    actorName: { type: String, trim: true, default: "" },
    fromState: { type: String, trim: true, default: "" },
    toState: { type: String, trim: true, default: "" },
    reason: { type: String, trim: true, default: "", maxlength: LIMITS.REASON },
  },
  { _id: false },
);

const bookingSchema = new mongoose.Schema(
  {
    /* ── IDENTITY, ALL SERVER-DERIVED AND FROZEN ─────────────────────── */
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    bookingRef: { type: String, trim: true, required: true, immutable: true },
    /* The permanent Sales line, so a booking is readable without the plan. */
    orderLineRef: { type: String, trim: true, required: true, index: true, immutable: true },

    planningFileId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    planningFileRef: { type: String, trim: true, default: "", immutable: true },
    planningGeneration: { type: Number, default: null, immutable: true },
    planningFileRevision: { type: Number, required: true, immutable: true },

    /* IE's own identity for the stage — never a process name, which repeats. */
    stageId: { type: String, trim: true, required: true, immutable: true },

    /* ── WHAT IT WAS PROVED AGAINST ──────────────────────────────────── */
    ieReleaseId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    ieReleaseRef: { type: String, trim: true, default: "", immutable: true },
    ieReleaseVersionNo: { type: Number, default: null, immutable: true },
    /**
     * A hash of the exact cutting standard this booking was calculated from.
     *
     * The release id and version say WHICH release; this says the standard
     * inside it had not been re-approved under the same numbers. Two figures
     * that differ produce different hashes, so a changed minute-per-piece is
     * caught even when everything else reads identical.
     */
    standardFingerprint: { type: String, trim: true, required: true, immutable: true },

    confirmedQuantity: { type: Number, required: true, min: 0, immutable: true },
    workloadMinutes: { type: Number, required: true, min: 0, immutable: true },
    timeBasis: { type: String, trim: true, required: true, immutable: true },

    /* ── THE RESOURCE, AS CUTTING PUBLISHED IT ───────────────────────── */
    resourceId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    resourceRef: { type: String, trim: true, required: true, immutable: true },
    resourceName: { type: String, trim: true, default: "", immutable: true },
    resourceType: { type: String, trim: true, required: true, immutable: true },
    resourceVersionNo: { type: Number, required: true, immutable: true },
    siteRef: { type: String, trim: true, default: "", immutable: true },

    /* The crew and efficiency the calculation used — Cutting's figures, copied
       so the arithmetic stays checkable after Cutting re-rosters. */
    crew: { type: [crewRoleSchema], default: () => [], immutable: true },
    headcount: { type: Number, required: true, min: 0, immutable: true },
    usableCrew: { type: Number, required: true, min: 1, immutable: true },
    scalingMethod: { type: String, trim: true, required: true, immutable: true },
    /* Cutting's own, and the only one applied. IE's is recorded beside it as
       the figure deliberately NOT applied a second time. */
    operationalEfficiencyPercent: { type: Number, required: true, min: 1, immutable: true },
    ieStandardEfficiencyPercent: { type: Number, default: null, immutable: true },

    /* ── THE RESERVATION ITSELF ──────────────────────────────────────── */
    windowStart: businessDate,
    windowEnd: businessDate,
    allocations: {
      type: [allocationSchema], required: true, immutable: true,
      validate: [(v) => Array.isArray(v) && v.length > 0 && v.length <= LIMITS.ALLOCATIONS,
        `Between 1 and ${LIMITS.ALLOCATIONS} days.`],
    },
    reservedMinutes: { type: Number, required: true, min: 1, immutable: true },

    /**
     * The preview this booking was taken from, hashed.
     *
     * A booking is only ever made from a preview a planner actually read. The
     * hash is recomputed server-side at booking time from the same inputs; if
     * anything moved underneath — the plan, the quantity, the release, the
     * standard, the roster, the calendar or what somebody else has since
     * reserved — the hashes differ and nothing is booked.
     */
    proofHash: { type: String, trim: true, required: true, immutable: true },

    /* ── LIFECYCLE ──────────────────────────────────────────────────── */
    state: { type: String, enum: BOOKING_STATES, required: true, default: BOOKING_STATE.ACTIVE },
    releaseReason: { type: String, enum: [...RELEASE_REASON, null], default: null },
    releaseNote: { type: String, trim: true, default: "", maxlength: LIMITS.REASON },
    releasedAt: { type: Date, default: null },
    releasedBy: actorRef(),

    supersedesBookingId: { type: mongoose.Schema.Types.ObjectId, default: null, immutable: true },
    supersedesBookingRef: { type: String, trim: true, default: "", immutable: true },
    supersededByBookingId: { type: mongoose.Schema.Types.ObjectId, default: null },
    supersededByBookingRef: { type: String, trim: true, default: "" },
    generation: { type: Number, required: true, min: 1, default: 1, immutable: true },

    revision: { type: Number, required: true, min: 1, default: 1 },
    history: {
      type: [eventSchema], default: () => [],
      validate: [(v) => !Array.isArray(v) || v.length <= LIMITS.HISTORY, "History is bounded."],
    },
    createdBy: actorRef(),
  },
  { timestamps: true, collection: "ppc_cutting_capacity_bookings" },
);

bookingSchema.index({ companyId: 1, bookingRef: 1 }, { unique: true, name: "cut_booking_ref_unique" });
/**
 * ONE ACTIVE BOOKING PER PLANNING FILE AND STAGE.
 *
 * A partial unique index, so a second concurrent booking for the same stage
 * loses at the index rather than at a check that races itself, and a released
 * or superseded booking does not block its successor.
 */
bookingSchema.index(
  { companyId: 1, planningFileId: 1, stageId: 1 },
  {
    unique: true, name: "cut_booking_one_active_per_stage",
    partialFilterExpression: { state: BOOKING_STATE.ACTIVE },
  },
);
bookingSchema.index({ companyId: 1, resourceId: 1, state: 1 });

/* A booking's decision is permanent: only its lifecycle may move, one at a
   time, never in bulk and never by deletion. */
bookingSchema.pre(["updateMany", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany",
  "findOneAndDelete"], function refuse(next) {
  const err = new Error(
    "A cutting capacity booking is permanent evidence; it is released or superseded, never rewritten or deleted.",
  );
  err.name = "CuttingCapacityBookingImmutable";
  err.code = "PPC_CUTTING_BOOKING_IMMUTABLE";
  next(err);
});

/* ══ THE RESOURCE-DAY COUNTER ═════════════════════════════════════════════ */

const resourceDaySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    /**
     * THE TABLE, NOT THE VERSION OF IT.
     *
     * Cutting publishes a resource as a new version DOCUMENT each time, so a
     * republished roster has a new `_id` for the same physical table. Keying
     * this counter on that id would hand every existing reservation back the
     * moment Cutting re-rostered — the day would read empty and be sold
     * twice. The stable identity is the reference Cutting itself gave the
     * table, and that is what a day is counted against.
     */
    resourceRef: { type: String, trim: true, required: true, immutable: true },
    date: businessDate,

    /* What the resource offered on this day when the last booking proved it,
       and what it was proved against. A later booking re-states both in the
       same conditional update that takes its minutes, so a roster change can
       shrink a day only while what is already reserved still fits. */
    availableMinutes: { type: Number, required: true, min: 0 },
    resourceVersionNo: { type: Number, required: true },

    reservedMinutes: { type: Number, required: true, min: 0, default: 0 },
  },
  { timestamps: true, collection: "ppc_cutting_resource_days" },
);

resourceDaySchema.index({ companyId: 1, resourceRef: 1, date: 1 }, { unique: true, name: "cut_resource_day_unique" });

const CuttingCapacityBooking = mongoose.models.CuttingCapacityBooking
  || mongoose.model("CuttingCapacityBooking", bookingSchema);
const CuttingResourceDay = mongoose.models.CuttingResourceDay
  || mongoose.model("CuttingResourceDay", resourceDaySchema);

module.exports = {
  CuttingCapacityBooking, CuttingResourceDay,
  BOOKING_STATE, BOOKING_STATES, RELEASE_REASON, LIMITS,
};
