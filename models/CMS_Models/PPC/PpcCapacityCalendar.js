// models/CMS_Models/PPC/PpcCapacityCalendar.js
//
// PPC'S CAPACITY CALENDAR — THE WORKING TIME A LINE ACTUALLY HAS.
//
// ── WHY PPC OWNS ONE, AND WHY IT HAD TO BE NEW ──────────────────────────────
// Industrial Engineering's own audit (the `calendarLinkage` block every
// capacity standard carries) found no company-scoped, versioned factory
// working-time calendar anywhere in this system, and rejected the three
// candidates by name:
//
//   · Merchandising's working calendar is versioned and company-scoped, but it
//     models delivery working DAYS — no shift length, no breaks;
//   · ProductionSchedule holds shift minutes and breaks, but has no company
//     scope and no version, and it is Production's own booking record;
//   · HR attendance is per-employee actuals, not a plan.
//
// So every IE capacity standard rests on an explicitly labelled IE planning
// ASSUMPTION of shift minutes and shifts per day, and says so. Booking capacity
// against that assumption would turn a stated guess into a commitment. This is
// the contract IE named as missing — `COMPANY_SCOPED_VERSIONED_WORKING_TIME_
// CALENDAR` — owned by the department that books against it.
//
// ── THE SHAPE IS MERCHANDISING'S, DELIBERATELY ──────────────────────────────
// A calendar is an identity; its content lives in numbered VERSIONS. A version
// is DRAFT while it is being written and becomes PUBLISHED by a separate act;
// once published it is immutable, and publishing its successor moves it to
// SUPERSEDED. That is the shape Merchandising's calendar already proved, and a
// reader who knows one should be able to read the other. What PPC adds is what
// Merchandising never needed: shifts, their clock times and their breaks.
//
// ── DAYS ARE `YYYY-MM-DD`, NEVER INSTANTS ───────────────────────────────────
// A working day is a calendar date in the factory's own frame, written as a
// string. It is never a JavaScript Date, because a Date is an instant, and an
// instant renders as a different day depending on the server's timezone — the
// exact shift `services/ppc/businessDate.js` exists to prevent. `timezone` is
// recorded for a person reading the calendar; no arithmetic here consults it.
"use strict";

const mongoose = require("mongoose");
const { isBusinessDate } = require("../../../services/ppc/businessDate");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true, default: "" },
});

const businessDay = [(v) => v === null || v === undefined || isBusinessDate(v),
  "A calendar date is written YYYY-MM-DD."];
const clock = [(v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v ?? "")),
  "A clock time is written HH:MM, 24-hour."];

const VERSION_STATE = Object.freeze({
  DRAFT: "DRAFT",
  PUBLISHED: "PUBLISHED",
  SUPERSEDED: "SUPERSEDED",
});
const VERSION_STATES = Object.freeze(Object.values(VERSION_STATE));

/**
 * What a dated exception does to one day.
 *
 * HOLIDAY and NON_WORKING both close the day and are kept apart only because a
 * planner reads the difference ("Diwali" versus "maintenance shutdown").
 * WORKING_DAY opens a day the week pattern closes — a Sunday made up — and
 * carries its own shifts, because a make-up day is rarely a full normal day.
 */
const EXCEPTION_KIND = Object.freeze(["HOLIDAY", "NON_WORKING", "WORKING_DAY"]);

const LIMITS = Object.freeze({
  SHIFTS_PER_DAY: 4,
  EXCEPTIONS: 400,
  REASON: 200,
  NAME: 160,
  HISTORY: 200,
});

/** One shift: its clock times and its unpaid break. Overnight is allowed. */
const shiftSchema = new mongoose.Schema(
  {
    shiftKey: { type: String, trim: true, required: true, maxlength: 40 },
    start: { type: String, required: true, validate: clock },
    end: { type: String, required: true, validate: clock },
    breakMinutes: { type: Number, required: true, min: 0, max: 600 },
  },
  { _id: false },
);

/** One weekday in the pattern, Monday first. */
const dayPatternSchema = new mongoose.Schema(
  {
    working: { type: Boolean, required: true },
    shifts: {
      type: [shiftSchema],
      default: () => [],
      validate: [(v) => !Array.isArray(v) || v.length <= LIMITS.SHIFTS_PER_DAY,
        `At most ${LIMITS.SHIFTS_PER_DAY} shifts a day.`],
    },
  },
  { _id: false },
);

const exceptionSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, validate: businessDay },
    kind: { type: String, enum: EXCEPTION_KIND, required: true },
    reason: { type: String, trim: true, required: true, maxlength: LIMITS.REASON },
    /* Only a WORKING_DAY carries shifts; the service refuses them elsewhere. */
    shifts: { type: [shiftSchema], default: () => [] },
  },
  { _id: false },
);

const eventSchema = new mongoose.Schema(
  {
    type: { type: String, required: true },
    at: { type: Date, required: true },
    actorName: { type: String, trim: true, default: "" },
    versionNo: { type: Number, default: null },
    note: { type: String, trim: true, default: "", maxlength: 500 },
  },
  { _id: false },
);

/* ══ THE CALENDAR — AN IDENTITY ═══════════════════════════════════════════ */

const calendarSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    /* The human reference a line points at and a booking freezes. */
    calendarRef: { type: String, trim: true, required: true, immutable: true, maxlength: 60 },
    name: { type: String, trim: true, required: true, maxlength: LIMITS.NAME },
    /* For a person reading it. No date arithmetic consults this field. */
    timezone: { type: String, trim: true, default: "Asia/Kolkata", maxlength: 60 },
    active: { type: Boolean, default: true },
    /* Moved by every publish. A booking pins it, so a publish that lands while
       a booking is being proved makes that booking stale rather than letting it
       commit against the superseded version. */
    revision: { type: Number, required: true, min: 1, default: 1 },
    /* Bumped by every booking on this calendar, in the booking's transaction —
       see the line's `bookingFence` for why. */
    bookingFence: { type: Number, default: 0 },
    history: {
      type: [eventSchema],
      default: () => [],
      validate: [(v) => !Array.isArray(v) || v.length <= LIMITS.HISTORY, "History is bounded."],
    },
    createdBy: actorRef(),
  },
  { timestamps: true, collection: "ppc_capacity_calendars" },
);
calendarSchema.index({ companyId: 1, calendarRef: 1 }, { unique: true, name: "ppc_calendar_ref_unique" });

/* ══ A VERSION — THE CONTENT ══════════════════════════════════════════════ */

const versionSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    calendarId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    versionNo: { type: Number, required: true, min: 1, immutable: true },
    state: { type: String, enum: VERSION_STATES, required: true, default: VERSION_STATE.DRAFT },

    /* The span this version describes. A day outside it is NOT a non-working
       day — it is a day this calendar says nothing about, which is `unknown`. */
    validFrom: { type: String, required: true, validate: businessDay },
    validTo: { type: String, default: null, validate: businessDay },

    weekPattern: {
      type: [dayPatternSchema],
      required: true,
      validate: [(v) => Array.isArray(v) && v.length === 7, "A week pattern has seven days, Monday first."],
    },
    exceptions: {
      type: [exceptionSchema],
      default: () => [],
      validate: [(v) => !Array.isArray(v) || v.length <= LIMITS.EXCEPTIONS, "Too many exceptions."],
    },

    note: { type: String, trim: true, default: "", maxlength: 1000 },
    revision: { type: Number, required: true, min: 1, default: 1 },

    publishedAt: { type: Date, default: null },
    publishedBy: actorRef(),
    supersededAt: { type: Date, default: null },
    supersededByVersionNo: { type: Number, default: null },
    createdBy: actorRef(),
  },
  { timestamps: true, collection: "ppc_capacity_calendar_versions" },
);

versionSchema.index({ companyId: 1, calendarId: 1, versionNo: 1 },
  { unique: true, name: "ppc_calendar_version_unique" });

/* ── EXACTLY ONE PUBLISHED VERSION PER CALENDAR, AT THE DATABASE ────────────
   Two concurrent publishes both reach this index and one loses, so a calendar
   can never answer "which hours apply" with two different published answers. */
versionSchema.index({ companyId: 1, calendarId: 1 }, {
  unique: true,
  name: "ppc_calendar_one_published",
  partialFilterExpression: { state: VERSION_STATE.PUBLISHED },
});

/* ── A PUBLISHED VERSION IS PERMANENT ───────────────────────────────────────
   Its content is what bookings were made against. The only change a published
   or superseded version may undergo is PUBLISHED → SUPERSEDED, which moves
   exactly `state`, `supersededAt` and `supersededByVersionNo`. Everything else
   is refused here, at the model, rather than trusted to every service. */
const CONTENT_PATHS = ["weekPattern", "exceptions", "validFrom", "validTo", "note"];

function guardUpdate(next) {
  const update = this.getUpdate() || {};
  const filter = this.getFilter() || {};
  const set = update.$set || {};
  const touched = [
    ...Object.keys(update).filter((k) => !k.startsWith("$")),
    ...Object.keys(set),
    ...Object.keys(update.$push || {}),
    ...Object.keys(update.$pull || {}),
    ...Object.keys(update.$unset || {}),
  ];
  const content = touched.filter((k) => CONTENT_PATHS.some((p) => k === p || k.startsWith(`${p}.`)));
  if (content.length && filter.state !== VERSION_STATE.DRAFT) {
    const err = new Error(
      "A calendar version's content may only change while it is a DRAFT, and the update must pin `state: \"DRAFT\"`.",
    );
    err.name = "PpcCalendarVersionImmutable";
    err.code = "PPC_CALENDAR_VERSION_IMMUTABLE";
    return next(err);
  }
  return next();
}
versionSchema.pre(["updateOne", "findOneAndUpdate"], guardUpdate);
versionSchema.pre(["updateMany", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany",
  "findOneAndDelete"], function refuse(next) {
  const err = new Error("Calendar versions are changed one at a time, and never deleted or replaced.");
  err.name = "PpcCalendarVersionImmutable";
  err.code = "PPC_CALENDAR_VERSION_IMMUTABLE";
  next(err);
});

const PpcCapacityCalendar = mongoose.models.PpcCapacityCalendar
  || mongoose.model("PpcCapacityCalendar", calendarSchema);
const PpcCapacityCalendarVersion = mongoose.models.PpcCapacityCalendarVersion
  || mongoose.model("PpcCapacityCalendarVersion", versionSchema);

module.exports = {
  PpcCapacityCalendar, PpcCapacityCalendarVersion,
  VERSION_STATE, VERSION_STATES, EXCEPTION_KIND, LIMITS,
};
