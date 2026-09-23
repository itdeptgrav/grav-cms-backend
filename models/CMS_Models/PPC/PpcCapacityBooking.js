// models/CMS_Models/PPC/PpcCapacityBooking.js
//
// A CAPACITY BOOKING, AND THE LINE-DAY COUNTER THAT MAKES IT SAFE.
//
// ── A PREVIEW IS NOT A BOOKING ──────────────────────────────────────────────
// Nothing in this file is written by a preview, and nothing is written by a
// planning file becoming PLANNED. A booking exists only as the result of an
// explicit, idempotent command that proved every input first: the planning
// file, its frozen engineering release, the line, the published calendar
// version, and the free capacity on every day it takes.
//
// ── WHY TWO COLLECTIONS ─────────────────────────────────────────────────────
// A booking is a DECISION: which planning file, which line, which days, how many
// operator-minutes each, and what it was proved against. It is permanent
// evidence and it is never edited — it is RELEASED or SUPERSEDED by a successor.
//
// The line-day counter is a SUM: how many operator-minutes are booked on one
// line on one day. It exists so that "never more than the day's capacity" is a
// fact the DATABASE enforces. A sum cannot be a unique index, so it is one
// document per (company, line, day) — unique — whose `bookedOperatorMinutes` is
// only ever moved by a conditional `$inc` that matches only when the result
// still fits. Two concurrent bookings for the last free hour both issue that
// update; exactly one matches, and the other's whole transaction rolls back.
//
// ── ONE ACTIVE BOOKING PER PLANNING FILE ────────────────────────────────────
// A partial unique index over ACTIVE, so a second concurrent booking for the
// same plan loses at the index, and a released or superseded booking does not
// block its successor.
//
// ── AND IT RELEASES NOTHING TO PRODUCTION ───────────────────────────────────
// No work order, no production release number, no scan, no stock. Booking
// reserves a line's time for a plan; releasing an order to Production is a
// later PPC chunk and has no field here.
"use strict";

const mongoose = require("mongoose");
const { isBusinessDate } = require("../../../services/ppc/businessDate");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true, default: "" },
});
const businessDay = [(v) => v === null || v === undefined || isBusinessDate(v),
  "A calendar date is written YYYY-MM-DD."];

const BOOKING_STATE = Object.freeze({
  ACTIVE: "ACTIVE",
  RELEASED: "RELEASED",
  SUPERSEDED: "SUPERSEDED",
});
const BOOKING_STATES = Object.freeze(Object.values(BOOKING_STATE));

const RELEASE_REASON = Object.freeze([
  "PLAN_CHANGED", "ORDER_CANCELLED", "SOURCE_MOVED", "CALENDAR_CHANGED",
  "LINE_CHANGED", "CAPACITY_CONFLICT", "OTHER",
]);

const allocationSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, validate: businessDay },
    operatorMinutes: { type: Number, required: true, min: 1 },
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
    reason: { type: String, trim: true, default: "", maxlength: 2000 },
  },
  { _id: false },
);

/* ══ THE BOOKING ══════════════════════════════════════════════════════════ */

const bookingSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    bookingRef: { type: String, trim: true, required: true, immutable: true },

    /* ── WHAT WAS BOOKED FOR ────────────────────────────────────────────── */
    planningFileId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    planningFileRef: { type: String, trim: true, required: true, immutable: true },
    planningFileRevision: { type: Number, required: true, immutable: true },
    orderLineRef: { type: String, trim: true, required: true, immutable: true },

    /* ── WHERE, AND AGAINST WHICH HOURS ─────────────────────────────────── */
    lineId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    lineRef: { type: String, trim: true, required: true, immutable: true },
    lineRevision: { type: Number, required: true, immutable: true },
    lineOperatorCount: { type: Number, required: true, immutable: true },
    calendarId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    calendarRef: { type: String, trim: true, required: true, immutable: true },
    calendarVersionNo: { type: Number, required: true, immutable: true },

    /* ── THE DEMAND, AS IT WAS PROVED ───────────────────────────────────── */
    basis: {
      type: new mongoose.Schema({
        ieReleaseId: { type: mongoose.Schema.Types.ObjectId, required: true },
        ieReleaseRef: { type: String, trim: true, required: true },
        ieReleaseVersionNo: { type: Number, required: true },
        confirmedQuantity: { type: Number, required: true, min: 1 },
        garmentSamMinutes: { type: Number, required: true, min: 0 },
        efficiencyPercent: { type: Number, required: true, min: 1, max: 200 },
        efficiencySource: { type: String, trim: true, required: true },
        demandStandardMinutes: { type: Number, required: true, min: 0 },
        requiredOperatorMinutes: { type: Number, required: true, min: 1 },
      }, { _id: false }),
      required: true,
      immutable: true,
    },

    windowStart: { type: String, required: true, validate: businessDay, immutable: true },
    windowEnd: { type: String, required: true, validate: businessDay, immutable: true },
    allocations: { type: [allocationSchema], required: true, immutable: true },
    bookedOperatorMinutes: { type: Number, required: true, min: 1, immutable: true },

    /* ── LIFECYCLE ──────────────────────────────────────────────────────── */
    state: { type: String, enum: BOOKING_STATES, required: true, default: BOOKING_STATE.ACTIVE },
    releaseReason: { type: String, enum: [...RELEASE_REASON, null], default: null },
    releaseNote: { type: String, trim: true, default: "", maxlength: 2000 },
    releasedAt: { type: Date, default: null },
    releasedBy: actorRef(),

    supersedesBookingId: { type: mongoose.Schema.Types.ObjectId, default: null, immutable: true },
    supersedesBookingRef: { type: String, trim: true, default: "", immutable: true },
    supersededByBookingId: { type: mongoose.Schema.Types.ObjectId, default: null },
    supersededByBookingRef: { type: String, trim: true, default: "" },
    generation: { type: Number, required: true, min: 1, default: 1, immutable: true },

    revision: { type: Number, required: true, min: 1, default: 1 },
    history: {
      type: [eventSchema],
      default: () => [],
      validate: [(v) => !Array.isArray(v) || v.length <= 200, "History is bounded."],
    },
    createdBy: actorRef(),
  },
  { timestamps: true, collection: "ppc_capacity_bookings" },
);

bookingSchema.index({ companyId: 1, bookingRef: 1 }, { unique: true, name: "ppc_booking_ref_unique" });
bookingSchema.index({ companyId: 1, planningFileId: 1 }, {
  unique: true,
  name: "ppc_booking_one_active_per_plan",
  partialFilterExpression: { state: BOOKING_STATE.ACTIVE },
});
bookingSchema.index({ companyId: 1, lineId: 1, state: 1 });
bookingSchema.index({ companyId: 1, state: 1, _id: -1 });

/* A booking's decision is permanent: only its lifecycle may move, one at a
   time, never in bulk and never by deletion. */
bookingSchema.pre(["updateMany", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany",
  "findOneAndDelete"], function refuse(next) {
  const err = new Error("A capacity booking is permanent evidence; it is released or superseded, never rewritten or deleted.");
  err.name = "PpcCapacityBookingImmutable";
  err.code = "PPC_CAPACITY_BOOKING_IMMUTABLE";
  next(err);
});

/* ══ THE LINE-DAY COUNTER ═════════════════════════════════════════════════ */

const lineDaySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    lineId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    date: { type: String, required: true, validate: businessDay, immutable: true },

    /* The capacity the LAST booking proved, and what it was proved against. A
       later booking re-states both in the same conditional update that takes
       its minutes, so a calendar or headcount change can shrink capacity only
       when what is already booked still fits. */
    capacityOperatorMinutes: { type: Number, required: true, min: 0 },
    calendarVersionNo: { type: Number, required: true },
    lineRevision: { type: Number, required: true },

    bookedOperatorMinutes: { type: Number, required: true, min: 0, default: 0 },
  },
  { timestamps: true, collection: "ppc_capacity_line_days" },
);

lineDaySchema.index({ companyId: 1, lineId: 1, date: 1 }, { unique: true, name: "ppc_line_day_unique" });

const PpcCapacityBooking = mongoose.models.PpcCapacityBooking
  || mongoose.model("PpcCapacityBooking", bookingSchema);
const PpcCapacityLineDay = mongoose.models.PpcCapacityLineDay
  || mongoose.model("PpcCapacityLineDay", lineDaySchema);

module.exports = {
  PpcCapacityBooking, PpcCapacityLineDay,
  BOOKING_STATE, BOOKING_STATES, RELEASE_REASON,
};
