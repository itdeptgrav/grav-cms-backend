// models/CMS_Models/PPC/PpcStagePublication.js
//
// ONE PPC TARGET, PUBLISHED TO ONE EXECUTING DEPARTMENT.
//
// PPC's stage schedule is internal: dates PPC is working towards, which no
// other department has seen or agreed. Publishing is the separate, explicit
// act that shows one stage's dates to the department that will do the work —
// today CUTTING, EMBROIDERY, SEWING and PACKING — and asks it to accept or
// refuse them. Each department answers only its own targets, on its own door.
//
// ── WHAT A PUBLICATION IS ───────────────────────────────────────────────────
// A frozen statement, not a live view. Everything it names — the company, the
// permanent Sales line, the planning file and its generation, the schedule
// version, the frozen IE release and stage, the confirmed quantity, the dates,
// and every WorkOrder the work will be done against — is copied at publish
// time and never edited afterwards. A later change is a NEW version that
// supersedes this one and carries the old dates beside the new ones with the
// reason; the superseded version stays readable, with whatever answer the
// receiving department had already given it.
//
// ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
// Not an accepted deadline. A published target is `AWAITING` until the
// receiving department itself answers: only that department's own acceptance
// makes it `ACCEPTED`, and a refusal changes nothing about PPC's schedule.
//
// Not a capacity booking. A sewing target NAMES the booking it was published
// against — `capacityBooking` below, frozen like everything else — because a
// sewing window nobody reserved a line for is a date with no factory behind
// it. Naming is all it does: booking is PPC's own decision, made in Capacity
// before this record exists, and neither publishing a target nor answering
// one creates, moves, releases or supersedes a booking. A refused target and
// an active booking coexist until PPC itself replans or releases it.
//
// Not a Production release: nothing here starts work,
// creates a WorkOrder or authorises a run. And not progress: there is no
// field for quantity cut, and no completion flag, because the cut record is
// Cutting's own and stays Cutting's.
"use strict";

const mongoose = require("mongoose");

/* The processes that have a receiving department today. Each one has its own
   door, its own grant and its own answer; a process not on this list stays
   "not connected" in the schedule's own handoff view rather than getting an
   unbacked value here. */
const PUBLISHED_PROCESSES = Object.freeze(["CUTTING", "EMBROIDERY", "SEWING", "PACKING"]);

const PUBLICATION_STATE = Object.freeze({
  AWAITING: "AWAITING",
  ACCEPTED: "ACCEPTED",
  REFUSED: "REFUSED",
  SUPERSEDED: "SUPERSEDED",
});
const PUBLICATION_STATES = Object.freeze(Object.values(PUBLICATION_STATE));

const LIMITS = Object.freeze({ REASON: 2000, WORK_ORDERS: 200 });

const businessDate = {
  type: String, required: true, trim: true, immutable: true,
  validate: { validator: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v), message: "A date is YYYY-MM-DD." },
};

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true, default: "" },
});

/* The work this target covers, as the Sales-line ↔ WorkOrder bridge proved it:
   a WorkOrder of this company, carrying this exact permanent line. Copied, so
   the target says what it was published against even if a WorkOrder is later
   split or cancelled. */
const publishedWorkOrderSchema = new mongoose.Schema(
  {
    workOrderId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    workOrderNumber: { type: String, trim: true, default: "", immutable: true },
    lineRef: { type: String, trim: true, required: true, immutable: true },
    basis: { type: String, trim: true, default: "", immutable: true },
    variantId: { type: String, trim: true, default: "", immutable: true },
    quantity: { type: Number, default: null, immutable: true },
  },
  { _id: false },
);

/* THE CAPACITY BOOKING A SEWING TARGET WAS PUBLISHED AGAINST.
   Copied at publish time from the ACTIVE booking the command proved, so the
   target says which reservation backed these dates even after that booking is
   later released or superseded. Absent on every process that books no line —
   cutting and embroidery reserve nothing, and a target for them carries no
   empty booking block pretending otherwise. Nothing here is a pointer the
   receiver may act on: it is evidence, and the booking itself is PPC's. */
const publishedBookingSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    bookingRef: { type: String, trim: true, required: true, immutable: true },
    generation: { type: Number, required: true, min: 1, immutable: true },
    lineId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    lineRef: { type: String, trim: true, required: true, immutable: true },
    calendarVersionNo: { type: Number, required: true, immutable: true },
    /* The booked window, which the publish command proved equals the planned
       stage window exactly. Kept beside the dates rather than inferred from
       them, so a later reader can see they agreed. */
    windowStart: businessDate,
    windowEnd: businessDate,
  },
  { _id: false },
);

/* What moved since the version this one replaces — old dates beside new. */
const changeSchema = new mongoose.Schema(
  {
    fromStart: { type: String, default: null, immutable: true },
    fromEnd: { type: String, default: null, immutable: true },
    toStart: { type: String, required: true, immutable: true },
    toEnd: { type: String, required: true, immutable: true },
  },
  { _id: false },
);

const publicationSchema = new mongoose.Schema(
  {
    /* ── IDENTITY, ALL SERVER-DERIVED AND FROZEN ─────────────────────── */
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    orderLineRef: { type: String, trim: true, required: true, index: true, immutable: true },

    planningFileId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    planningFileRef: { type: String, trim: true, default: "", immutable: true },
    planningGeneration: { type: Number, default: null, immutable: true },
    /* The stage-schedule version these dates were read from. */
    scheduleVersionNo: { type: Number, required: true, min: 1, immutable: true },

    ieReleaseId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    ieReleaseRef: { type: String, trim: true, default: "", immutable: true },
    ieReleaseVersionNo: { type: Number, default: null, immutable: true },
    /* IE's own identity for the stage — never a process name, which repeats. */
    stageId: { type: String, trim: true, required: true, immutable: true },
    process: { type: String, enum: PUBLISHED_PROCESSES, required: true, immutable: true },
    stageLabel: { type: String, trim: true, default: "", immutable: true },

    /* Sales' confirmed quantity, from the planning file's frozen basis. */
    confirmedQuantity: { type: Number, required: true, min: 0, immutable: true },
    plannedStart: businessDate,
    plannedEnd: businessDate,

    workOrders: { type: [publishedWorkOrderSchema], default: () => [], immutable: true },

    /* Set for SEWING, absent otherwise — see the schema above. */
    capacityBooking: { type: publishedBookingSchema, default: null, immutable: true },

    /* THE CUTTING RESERVATION A CUTTING TARGET WAS PUBLISHED AGAINST.
       Its own shape, because a cutting resource is not a sewing line: it
       names a table or knife Cutting owns, at the roster version the booking
       was proved on. Absent on every process that reserves no cutting
       resource — and absent on cutting targets published before reservations
       existed, which read as LEGACY_CAPACITY_UNVERIFIED rather than as
       capacity-backed. */
    cuttingBooking: {
      type: new mongoose.Schema({
        bookingId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
        bookingRef: { type: String, trim: true, required: true, immutable: true },
        generation: { type: Number, required: true, min: 1, immutable: true },
        resourceId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
        resourceRef: { type: String, trim: true, required: true, immutable: true },
        resourceName: { type: String, trim: true, default: "", immutable: true },
        resourceType: { type: String, trim: true, required: true, immutable: true },
        resourceVersionNo: { type: Number, required: true, immutable: true },
        usableCrew: { type: Number, required: true, min: 1, immutable: true },
        reservedMinutes: { type: Number, required: true, min: 1, immutable: true },
        windowStart: businessDate,
        windowEnd: businessDate,
        /* The standard the reservation was calculated from, so a target can
           be checked against the engineering without re-reading the release. */
        standardFingerprint: { type: String, trim: true, required: true, immutable: true },
      }, { _id: false }),
      default: null, immutable: true,
    },

    /* ── VERSIONING ──────────────────────────────────────────────────── */
    publicationVersionNo: { type: Number, required: true, min: 1, immutable: true },
    supersedesVersionId: { type: mongoose.Schema.Types.ObjectId, default: null, immutable: true },
    supersededByVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    /* Empty on version 1; on a successor, what moved and why PPC moved it. */
    changes: { type: [changeSchema], default: () => [], immutable: true },
    replanReason: { type: String, trim: true, default: "", maxlength: LIMITS.REASON, immutable: true },

    /* ── STANDING, AND THE RECEIVER'S OWN ANSWER ─────────────────────── */
    state: { type: String, enum: PUBLICATION_STATES, default: PUBLICATION_STATE.AWAITING, index: true },
    /* Exactly one version per stage is the one in force; the partial unique
       index below is what makes that true in the database rather than in
       prose. Cleared when superseded. */
    isCurrent: { type: Boolean, default: true },

    /* Written only by the receiving department, through its own door. */
    response: {
      state: { type: String, enum: [PUBLICATION_STATE.ACCEPTED, PUBLICATION_STATE.REFUSED], default: undefined },
      at: { type: Date, default: null },
      by: actorRef(),
      /* Required for a refusal — a target sent back without a reason tells
         PPC nothing it can act on. */
      reason: { type: String, trim: true, default: "", maxlength: LIMITS.REASON },
    },

    publishedBy: actorRef(),
    publishedAt: { type: Date, required: true, immutable: true },
  },
  { timestamps: true, collection: "ppc_stage_publications" },
);

/* One version number per stage of a planning file. */
publicationSchema.index(
  { companyId: 1, planningFileId: 1, stageId: 1, publicationVersionNo: 1 },
  { unique: true },
);
/* And at most one in force. */
publicationSchema.index(
  { companyId: 1, planningFileId: 1, stageId: 1 },
  { unique: true, partialFilterExpression: { isCurrent: true } },
);
/* The receiver's queue: this company's live targets, by WorkOrder. */
publicationSchema.index({ companyId: 1, "workOrders.workOrderId": 1, isCurrent: 1 });

/*
 * A published statement is frozen. Only its standing, the receiver's answer
 * and the supersession pointer may change after it is written — everything
 * the immutable fields above already refuse individually, said once more
 * here so a future writer reaching past them is told what it is doing.
 */
const MUTABLE_AFTER_PUBLISH = new Set([
  "state", "isCurrent", "response", "supersededByVersionId", "updatedAt", "__v",
]);
publicationSchema.pre("save", function freezePublished(next) {
  if (this.isNew) return next();
  const touched = this.modifiedPaths().filter((p) => !MUTABLE_AFTER_PUBLISH.has(p.split(".")[0]));
  if (touched.length) {
    const err = new Error(
      `A published target is frozen. ${touched.join(", ")} cannot change — publish a new version instead.`,
    );
    err.name = "PpcStagePublicationImmutable";
    return next(err);
  }
  return next();
});

const PpcStagePublication = mongoose.models.PpcStagePublication
  || mongoose.model("PpcStagePublication", publicationSchema);

module.exports = { PpcStagePublication, PUBLICATION_STATE, PUBLICATION_STATES, PUBLISHED_PROCESSES, LIMITS };
