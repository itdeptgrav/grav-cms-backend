// models/CMS_Models/PPC/PpcStageSchedule.js
//
// PPC'S STAGE SCHEDULE FOR ONE PLANNING FILE — planned start and finish per
// production stage, as PPC-INTERNAL PLANNING TARGETS.
//
// ── WHAT IT IS ──────────────────────────────────────────────────────────────
// One document per planning file (company + planningFileId), so a successor
// plan starts a new schedule and the old one stays readable beside its plan.
// The stages are exactly the REQUIRED stages of the IE process route frozen in
// that planning file's release, copied at the first save and keyed by IE's own
// `stageId` — never by process name or label, because a process may repeat.
//
// ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
// Not a capacity commitment: the sewing booking is a separate record and is
// never touched from here. Not a deadline anybody has accepted: nothing is
// published to Cutting, Embroidery or any other app, because a WorkOrder is
// not yet provably linked to the Sales line. Not a start authorization for
// Production. There is no field for actual progress and no completion flag.
//
// ── NOTHING IS OVERWRITTEN SILENTLY ─────────────────────────────────────────
// Every save is a new schedule version with its own history entry listing each
// changed stage's old and new dates; a change to dates already set is a
// REPLAN and carries its reason. History is append-only.
"use strict";

const mongoose = require("mongoose");

const PROCESS_KINDS = Object.freeze([
  "CUTTING", "EMBROIDERY", "PRINTING", "SEWING", "WASHING", "FINISHING", "PACKING", "OTHER",
]);

const LIMITS = Object.freeze({ REASON: 2000, HISTORY: 200, STAGES: 40 });

const businessDate = {
  type: String, default: null, trim: true,
  validate: { validator: (v) => v === null || /^\d{4}-\d{2}-\d{2}$/.test(v), message: "A date is YYYY-MM-DD." },
};

const stagePlanSchema = new mongoose.Schema(
  {
    /* IE's identity for the stage, frozen with the route. */
    stageId: { type: String, required: true, trim: true, immutable: true },
    process: { type: String, enum: PROCESS_KINDS, required: true, immutable: true },
    label: { type: String, trim: true, default: "", immutable: true },
    sequence: { type: Number, required: true, min: 1, immutable: true },
    predecessorStageIds: { type: [{ type: String, trim: true }], default: () => [], immutable: true },

    /* PPC's planning target — a calendar day, never a promise. */
    plannedStart: businessDate,
    plannedEnd: businessDate,
    /* The schedule version that last set these dates. */
    setInVersion: { type: Number, default: null, min: 1 },
  },
  { _id: false },
);

const changeSchema = new mongoose.Schema(
  {
    stageId: { type: String, required: true, trim: true },
    process: { type: String, trim: true, default: "" },
    label: { type: String, trim: true, default: "" },
    fromStart: { type: String, default: null },
    fromEnd: { type: String, default: null },
    toStart: { type: String, default: null },
    toEnd: { type: String, default: null },
  },
  { _id: false },
);

const versionSchema = new mongoose.Schema(
  {
    versionNo: { type: Number, required: true, min: 1 },
    /* PLANNED: dates set where none were. REPLANNED: a set date moved. */
    kind: { type: String, enum: ["PLANNED", "REPLANNED"], required: true },
    reason: { type: String, trim: true, default: "", maxlength: LIMITS.REASON },
    changes: { type: [changeSchema], default: () => [] },
    at: { type: Date, required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, default: null },
    actorName: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId, default: null },
  name: { type: String, trim: true, default: "" },
  email: { type: String, trim: true, default: "" },
});

const stageScheduleSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    /* The permanent Sales line identity — the same key the planning file uses. */
    orderLineRef: { type: String, required: true, trim: true, immutable: true },
    planningFileId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    planningFileRef: { type: String, trim: true, default: "", immutable: true },
    planningGeneration: { type: Number, default: null, immutable: true },

    /* The exact IE release whose route these stages came from. */
    ieReleaseId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    ieReleaseRef: { type: String, trim: true, default: "", immutable: true },
    ieReleaseVersionNo: { type: Number, default: null, immutable: true },

    stages: {
      type: [stagePlanSchema],
      default: () => [],
      validate: [(v) => v.length <= LIMITS.STAGES, `At most ${LIMITS.STAGES} stages.`],
    },

    /* The schedule's own version — one per save. */
    versionNo: { type: Number, required: true, min: 1 },
    /* Optimistic concurrency: a save names the revision it read. */
    revision: { type: Number, required: true, min: 1 },

    history: {
      type: [versionSchema],
      default: () => [],
      validate: [(v) => v.length <= LIMITS.HISTORY, `A schedule keeps at most ${LIMITS.HISTORY} versions.`],
    },

    createdBy: actorRef(),
    updatedBy: actorRef(),
  },
  { timestamps: true, collection: "ppc_stage_schedules" },
);

stageScheduleSchema.index({ companyId: 1, planningFileId: 1 }, { unique: true });
stageScheduleSchema.index({ companyId: 1, orderLineRef: 1 });

const PpcStageSchedule = mongoose.models.PpcStageSchedule
  || mongoose.model("PpcStageSchedule", stageScheduleSchema);

module.exports = { PpcStageSchedule, PROCESS_KINDS, LIMITS };
