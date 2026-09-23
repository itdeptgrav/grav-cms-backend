// models/CMS_Models/PPC/PpcCapacityLine.js
//
// A PPC CAPACITY LINE — A SEWING LINE AS PPC PLANS AGAINST IT.
//
// ── WHY PPC DECLARES ITS OWN ────────────────────────────────────────────────
// There is no authoritative line register anywhere in this system to reuse.
// IE's line template is, in its own words, "the pattern, not the line";
// Production's canvas layout is a drawing of machine positions scoped to an
// organisation rather than a company; ProductionSchedule has shifts but no line
// dimension; and every factory reference in the order data is a free string
// that nothing resolves. A capacity booking needs a stable line identity with a
// company, a manned headcount and a calendar, and none of those exists.
//
// So PPC declares its planning lines itself, as configuration an OWNER sets and
// a booking freezes by revision. `externalRef` is reserved so that if a
// Production line master is ever built, each PPC line can name the physical
// line it plans, and this register becomes a view onto that one rather than a
// rival to it.
//
// ── WHAT A LINE CARRIES, AND WHAT IT DOES NOT ───────────────────────────────
// The manned OPERATOR count and the calendar it works to. Capacity is operator
// count × the calendar's net minutes on a date — operator-minutes, which do not
// depend on which style is sewn, so one line-day can be capped for every style
// at once. Efficiency is not here: it is a property of the STYLE, and it comes
// from the engineering release the booking was made for.
//
// No machines, no operators by name, no attendance, no work orders.
"use strict";

const mongoose = require("mongoose");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true, default: "" },
});

const LINE_STATUS = Object.freeze({ ACTIVE: "ACTIVE", RETIRED: "RETIRED" });

const eventSchema = new mongoose.Schema(
  {
    type: { type: String, required: true },
    at: { type: Date, required: true },
    actorName: { type: String, trim: true, default: "" },
    revision: { type: Number, required: true },
    changed: [{ type: String, trim: true }],
    note: { type: String, trim: true, default: "", maxlength: 500 },
  },
  { _id: false },
);

const lineSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    lineRef: { type: String, trim: true, required: true, immutable: true, maxlength: 40 },
    name: { type: String, trim: true, required: true, maxlength: 120 },
    /* The factory or site this line is in — the same free reference the order
       data uses, so a planner can match a nomination by eye. Not a join key. */
    factoryRef: { type: String, trim: true, default: "", maxlength: 120 },
    externalRef: { type: String, trim: true, default: "", maxlength: 120 },

    calendarId: { type: mongoose.Schema.Types.ObjectId, required: true },
    /* Manned sewing operators. Helpers are not capacity, exactly as IE's own
       formula treats them. */
    operatorCount: { type: Number, required: true, min: 1, max: 500 },

    status: { type: String, enum: Object.values(LINE_STATUS), default: LINE_STATUS.ACTIVE },
    /* Frozen by every booking. An edit moves it, which makes a later booking
       against the old figure stale rather than silently re-sized. */
    revision: { type: Number, required: true, min: 1, default: 1 },
    /* Bumped by every booking that relies on this line, inside the booking's
       transaction, with a filter pinning the revision it read. A headcount edit
       writes this same document, so an edit and a booking that overlap in time
       CONFLICT at the database — one retries and then sees the other — instead
       of a booking committing against a headcount that had already changed. */
    bookingFence: { type: Number, default: 0 },
    history: {
      type: [eventSchema],
      default: () => [],
      validate: [(v) => !Array.isArray(v) || v.length <= 200, "History is bounded."],
    },
    createdBy: actorRef(),
    updatedBy: actorRef(),
  },
  { timestamps: true, collection: "ppc_capacity_lines" },
);

lineSchema.index({ companyId: 1, lineRef: 1 }, { unique: true, name: "ppc_line_ref_unique" });

const PpcCapacityLine = mongoose.models.PpcCapacityLine
  || mongoose.model("PpcCapacityLine", lineSchema);

module.exports = { PpcCapacityLine, LINE_STATUS };
