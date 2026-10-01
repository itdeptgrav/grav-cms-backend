// models/CMS_Models/Merchandising/DepartmentStatusProjection.js
//
// WHAT ANOTHER DEPARTMENT SAID ABOUT THIS ORDER — RECORDED, NEVER AUTHORED.
//
// One row per (file, department, source record, source version). Written by
// exactly one thing: `departmentStatusIntake.service.js`, applying an event
// the owning application published. There is no route, no service export and
// no model path that lets Merchandising state a department's status, and the
// absence is the guarantee the plan asks for — "Merchandising coordinates
// visibility; it cannot mark another department ready."
//
// ── NO `updatedBy`, BY CONSTRUCTION ─────────────────────────────────────────
// A projection has no Merchandising actor. Nobody here decided it; an event
// carried it. Giving the row an actor field would invite somebody to fill it,
// and a name against another department's statement is a signature on a
// sentence that person never said. The same rule `handoverIntake` follows for
// Sales-driven events, which record `source: "sales"` and no actor.
//
// ── WHY THE PREVIOUS ROW IS KEPT ────────────────────────────────────────────
// A superseded projection is marked `isCurrent: false` and stays. "Store said
// PARTIALLY_RECEIVED on the 3rd and RECEIVED on the 9th" is the history a
// coordinator actually needs when a shortage appears later, and an update in
// place would destroy it. The partial unique index is what makes "one current
// row per source record" a database fact rather than a property of however
// carefully the intake service was written.
//
// ── AND WHY THE MOMENT IS PART OF THE IDENTITY ──────────────────────────────
// The unique index spans `sourceObservedAt`, not the source's version number.
// Both were candidates and the moment is the correct one: a source record
// legitimately speaks several times without its version changing — a GRN that
// is partially received on the 3rd and fully received on the 9th is one record
// at one version making two true statements, and an index on the version would
// reject the second as a duplicate of the first.
//
// The moment cannot collide that way. An exact redelivery carries the same
// observation time and is refused by the index; a genuinely new statement
// carries a later one and is accepted. `sourceRecordVersion` is still recorded
// beside it, because a reader needs to know which version spoke.
"use strict";

const mongoose = require("mongoose");

const { DEPARTMENTS, AVAILABILITY } = require("../../../services/merchandising/departmentStatus.contract");

const projectionSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    fileId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },

    projectionRef: { type: String, trim: true, required: true, immutable: true },

    department: { type: String, enum: DEPARTMENTS, required: true, immutable: true },

    /* ── THE SOURCE, NAMED EXACTLY ────────────────────────────────────────
       What the owning application calls this record, and which version of it
       spoke. A reader who doubts a status must be able to go and look at the
       thing that said it. */
    sourceApp: { type: String, trim: true, required: true, immutable: true },
    sourceRecordType: { type: String, trim: true, default: "" },
    sourceRecordRef: { type: String, trim: true, required: true, immutable: true },
    sourceRecordVersion: { type: Number, default: null },

    /* Allowlisted at intake — see departmentStatus.contract.js. A code outside
       the department's list never reaches this document. */
    statusCode: { type: String, trim: true, required: true },
    /* The source's own display text. Shown beside the code, never instead of
       it: the code is what the contract vouches for. */
    statusLabel: { type: String, trim: true, default: "", maxlength: 200 },

    availability: {
      type: String, enum: Object.values(AVAILABILITY), default: AVAILABILITY.AVAILABLE,
    },

    /* Set when the statement is about one execution unit rather than the
       whole file. Empty means it speaks for the order. */
    unitDiscriminator: { type: String, trim: true, default: "" },

    /* When the SOURCE says it happened, and when we heard. Both, because they
       differ and the difference is the whole of freshness. */
    sourceObservedAt: { type: Date, required: true },
    receivedAt: { type: Date, required: true },

    sourceEventId: { type: mongoose.Schema.Types.ObjectId, default: null, immutable: true },

    supersededByProjectionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    isCurrent: { type: Boolean, default: true },
  },
  { timestamps: true, collection: "merchandising_department_status_projections" },
);

/* One row per (source record, moment) — an exact redelivery cannot mint a
   second, and a later statement about the same record is not mistaken for one.
   See the header for why this is the observation time, not the version. */
projectionSchema.index(
  { companyId: 1, fileId: 1, department: 1, sourceRecordRef: 1, sourceObservedAt: 1 },
  { unique: true },
);

/* ── ONE CURRENT ROW PER SOURCE RECORD, ENFORCED BY THE DATABASE ──────────
   The invariant the whole register reads against. Partial, so superseded rows
   accumulate freely beside the one in force. */
projectionSchema.index(
  { companyId: 1, fileId: 1, department: 1, sourceRecordRef: 1 },
  { unique: true, partialFilterExpression: { isCurrent: true }, name: "one_current_projection" },
);

/* The register's own read: every current row for one file. */
projectionSchema.index({ companyId: 1, fileId: 1, department: 1, isCurrent: 1 });
/* One department's history, newest first. */
projectionSchema.index({ companyId: 1, fileId: 1, department: 1, sourceObservedAt: -1 });

module.exports = {
  DepartmentStatusProjection: mongoose.models.DepartmentStatusProjection
    || mongoose.model("DepartmentStatusProjection", projectionSchema),
};
