// models/CMS_Models/IndustrialEngineering/IeRampProfile.js
//
// IE CHUNK 7B — A CONFIGURED RAMP ASSUMPTION, OWNED BY IE.
//
// A new line does not reach its steady-state efficiency on the first morning.
// A ramp profile states what efficiency the line is PLANNED to hold on each
// stage of a run — day one to three at forty per cent, day four to ten at
// sixty, and so on — so a capacity target for the first week is an engineering
// decision somebody wrote down rather than a number quietly assumed.
//
// ── IT IS AN ASSUMPTION, AND IT KNOWS IT ────────────────────────────────────
// A stage says what is PLANNED, never what happened. This record cannot infer
// progress from a date, a scan, a piece of production output or an operator's
// attendance, and there is no field one could be put in: a stage is a
// production-day RANGE and a target percentage, and nothing else. Which stage
// applies to a given capacity standard is stated explicitly by the person
// planning it. Nothing here reads the clock.
//
// ── WHY THE STAGES MUST TILE THE RUN ────────────────────────────────────────
// Stages start at production day one and each begins the day after the last one
// ended; only the final stage may run open-ended. Overlaps are refused because
// two stages claiming day five give a target that depends on which one a reader
// happens to pick. GAPS are refused for the same reason in reverse: a profile
// with nothing to say about day five would answer that day with silence, and
// silence in a capacity chunk has already been decided — it is a gap, never a
// zero. A profile that tiles its own range cannot produce either.
//
// ── AND A PROFILE IS EVIDENCE ONCE IT HAS BEEN USED ─────────────────────────
// Editing or retiring a profile never rewrites a capacity standard that already
// froze it. The standard copies the profile id, its revision, the stage and the
// stage's percentage at the moment it was applied, and reads none of them back.
// So this record may be corrected freely without silently restating a target
// somebody has already planned a shipment against.
"use strict";

const mongoose = require("mongoose");

const STATUS = Object.freeze({ ACTIVE: "ACTIVE", RETIRED: "RETIRED" });

/* No approval, release, publication or acknowledgement type. Chunk 7B states an
   assumption; it approves nothing, and an audit trail that could name such an
   event would invite a screen to render a control for it. */
const EVENT_TYPES = Object.freeze([
  "RAMP_PROFILE_CREATED",
  "RAMP_PROFILE_EDITED",
  "RAMP_PROFILE_RETIRED",
  "RAMP_PROFILE_RESTORED",
]);

const LIMITS = Object.freeze({
  NAME: 160,
  LABEL: 120,
  DESCRIPTION: 1000,
  SUMMARY: 300,
  STAGES: 60,
  /* A run long enough for any ramp anybody plans, and short enough that a typo
     of 1e9 is refused rather than stored. */
  PRODUCTION_DAY: 3650,
  HISTORY: 200,
});

/** The uniqueness form of a name. Derived, never accepted from a caller. */
const nameKeyOf = (v) => String(v ?? "").trim().replace(/\s+/g, " ").toUpperCase();

/**
 * One stage of the ramp.
 *
 * `stageId` is minted by the server once and survives relabelling and
 * re-ordering, because a capacity standard freezes it and the audit trail has to
 * be able to name the same stage twice.
 *
 * `toProductionDay` is null on the last stage only, and means "from here on".
 */
const rampStageSchema = new mongoose.Schema(
  {
    stageId: { type: String, required: true, trim: true },
    sequence: { type: Number, required: true, min: 1 },
    label: { type: String, trim: true, default: "", maxlength: LIMITS.LABEL },
    fromProductionDay: { type: Number, required: true, min: 1, max: LIMITS.PRODUCTION_DAY },
    toProductionDay: { type: Number, default: null, min: 1, max: LIMITS.PRODUCTION_DAY },
    /* A percentage, everywhere, named so no reader has to guess whether 0.4
       means forty per cent or four tenths of one. Greater than zero and at most
       100, the same rule Chunk 7A's steady-state target obeys. */
    targetEfficiencyPercent: { type: Number, required: true, min: 0, max: 100 },
  },
  { _id: false },
);

/** A bounded audit line. Never a copy of the stages. */
const rampEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true },
    type: { type: String, enum: EVENT_TYPES, required: true },
    at: { type: Date, required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, default: null },
    actorName: { type: String, trim: true, default: "" },
    profileRevision: { type: Number, required: true, min: 1 },
    changed: { type: [{ type: String, trim: true }], default: () => [] },
    summary: { type: String, trim: true, default: "", maxlength: LIMITS.SUMMARY },
  },
  { _id: false },
);

const ieRampProfileSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true, index: true },

    name: { type: String, required: true, trim: true, maxlength: LIMITS.NAME },
    /* Derived, never accepted from a caller — see `nameKeyOf`. */
    nameKey: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "", maxlength: LIMITS.DESCRIPTION },

    stages: { type: [rampStageSchema], default: () => [] },

    status: { type: String, enum: Object.values(STATUS), default: STATUS.ACTIVE, required: true },
    revision: { type: Number, default: 1, min: 1 },
    history: { type: [rampEventSchema], default: () => [] },

    statusChangedAt: { type: Date, default: null },
    statusChangedByName: { type: String, trim: true, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    createdByName: { type: String, trim: true, default: "" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    updatedByName: { type: String, trim: true, default: "" },
  },
  { timestamps: true, collection: "ie_ramp_profiles" },
);

/* ── ONE ACTIVE NAME PER COMPANY ────────────────────────────────────────────
 * Partial on ACTIVE, so retiring a profile RELEASES its name and a replacement
 * may take it — the same rule the operation library has held since Chunk 2A and
 * line templates since 6C. Restoring can therefore be refused, which is correct:
 * two active profiles called "Standard ramp" would be picked between by
 * whichever a screen happened to list first.
 *
 * The index is what decides this, not a look-then-insert: two simultaneous
 * creates both pass a pre-check and only the index can settle it. */
ieRampProfileSchema.index(
  { companyId: 1, nameKey: 1 },
  { unique: true, partialFilterExpression: { status: STATUS.ACTIVE }, name: "one_active_ramp_name" },
);
ieRampProfileSchema.index({ companyId: 1, createdAt: -1, _id: -1 });
ieRampProfileSchema.index({ companyId: 1, status: 1, createdAt: -1, _id: -1 });

module.exports = mongoose.models.IeRampProfile
  || mongoose.model("IeRampProfile", ieRampProfileSchema);

module.exports.STATUS = STATUS;
module.exports.EVENT_TYPES = EVENT_TYPES;
module.exports.LIMITS = LIMITS;
module.exports.nameKeyOf = nameKeyOf;
