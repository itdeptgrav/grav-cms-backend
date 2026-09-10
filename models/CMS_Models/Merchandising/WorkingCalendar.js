// models/CMS_Models/Merchandising/WorkingCalendar.js
//
// WHICH DAYS THIS COMPANY WORKS — as versions, for the same reason templates
// are versioned.
//
// A holiday declared in June must not silently move every baseline computed in
// March. If the calendar were a single mutable document, adding one festival
// day would retroactively change what "twelve working days before delivery"
// meant on every plan that had already committed to it — and nobody would see
// it happen. So a calendar has versions, a published one is frozen, and a plan
// pins the version it was baselined against.
//
// ── THE HORIZON IS A FEATURE ────────────────────────────────────────────────
// `horizonTo` is the last date a version can answer for. Past it the engine
// refuses rather than assuming Saturdays are holidays for ever. A plan whose
// forecast reaches the horizon is a real operational signal: somebody has to
// extend the calendar before the company can promise dates that far out.
//
// ── AND AN EXCEPTION WORKS IN BOTH DIRECTIONS ───────────────────────────────
// A declared holiday on a Tuesday, and a worked Sunday before a shipment. Both
// are the same kind of fact — "this one date differs from the pattern" — and a
// model that only knew about holidays would force the second to be expressed
// as a permanent change to the week.
"use strict";

const mongoose = require("mongoose");

const { dateOnly, actorRef, VERSION_STATE } = require("./TnaTemplate");

const calendarSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company",
      required: true, index: true, immutable: true,
    },
    calendarRef: { type: String, trim: true, required: true, immutable: true },
    name: { type: String, trim: true, required: true, maxlength: 160 },
    /* ── THE ZONE IS USED FOR EXACTLY ONE THING ───────────────────────
       Deciding what "today" is when a milestone is called due or overdue. It
       is never used to store or shift a milestone date: those are calendar
       dates and carry no zone at all. */
    timezone: { type: String, trim: true, default: "Asia/Kolkata" },
    isActive: { type: Boolean, default: true },
    createdBy: actorRef(),
  },
  { timestamps: true, collection: "merchandising_working_calendars" },
);

calendarSchema.index({ companyId: 1, calendarRef: 1 }, { unique: true });

const exceptionSchema = new mongoose.Schema(
  {
    date: dateOnly({ required: true }),
    /* True is a worked Sunday; false is a declared holiday. */
    working: { type: Boolean, required: true },
    reason: { type: String, trim: true, default: "", maxlength: 200 },
  },
  { _id: false },
);

const calendarVersionSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    calendarId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    versionNo: { type: Number, min: 1, required: true, immutable: true },
    state: {
      type: String, enum: Object.values(VERSION_STATE),
      default: VERSION_STATE.DRAFT, index: true,
    },
    effectiveFrom: dateOnly(),
    effectiveTo: dateOnly({ default: null }),

    /* Index 0 is Monday. Seven booleans, no more: a week is a week. */
    weekPattern: {
      type: [Boolean],
      default: () => [true, true, true, true, true, true, false],
      validate: [(v) => Array.isArray(v) && v.length === 7, "A week pattern has seven days, Monday first."],
    },
    exceptions: { type: [exceptionSchema], default: [] },

    /* The last date this version can answer for. */
    horizonTo: dateOnly(),

    publishedBy: actorRef(),
    publishedAt: { type: Date, default: null },
    retiredAt: { type: Date, default: null },
    createdBy: actorRef(),
  },
  { timestamps: true, collection: "merchandising_working_calendar_versions" },
);

calendarVersionSchema.index({ companyId: 1, calendarId: 1, versionNo: 1 }, { unique: true });
calendarVersionSchema.index(
  { companyId: 1, calendarId: 1 },
  { unique: true, partialFilterExpression: { state: VERSION_STATE.DRAFT }, name: "one_cal_draft" },
);

/** Published means frozen — the same rule, and the same three exceptions. */
const CAL_MUTABLE_AFTER_PUBLISH = new Set(["state", "effectiveTo", "retiredAt", "updatedAt", "__v"]);

calendarVersionSchema.pre("save", function freezePublished(next) {
  if (this.isNew) return next();
  const wasPublished = (this.state !== VERSION_STATE.DRAFT && !this.isModified("state"))
    || (this.publishedAt && !this.isModified("publishedAt"));
  if (!wasPublished) return next();

  const touched = this.modifiedPaths().filter(
    (p) => !CAL_MUTABLE_AFTER_PUBLISH.has(p.split(".")[0]),
  );
  if (touched.length) {
    const err = new Error(
      `A published working calendar is frozen. ${touched.join(", ")} cannot change — publish a new version instead.`,
    );
    err.name = "TnaCalendarImmutable";
    err.touched = touched;
    return next(err);
  }
  return next();
});

module.exports = {
  CAL_MUTABLE_AFTER_PUBLISH,
  WorkingCalendar: mongoose.models.MerchandisingWorkingCalendar
    || mongoose.model("MerchandisingWorkingCalendar", calendarSchema),
  WorkingCalendarVersion: mongoose.models.MerchandisingWorkingCalendarVersion
    || mongoose.model("MerchandisingWorkingCalendarVersion", calendarVersionSchema),
};
