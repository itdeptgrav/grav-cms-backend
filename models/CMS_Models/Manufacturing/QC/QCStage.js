// models/CMS_Models/Manufacturing/QC/QCStage.js
//
// A CHECKPOINT ON THE QC LINE.
//
// Inspection used to be one event: an inspector scanned a piece and it was
// either passed or defective, once, forever. On a real line a garment is
// checked several times over — in-line, end-line, finishing, final audit — and
// "who checked it" is only half the answer. The other half is "at which
// checkpoint", which is what this collection names.
//
// SERIAL IS THE POINT, NOT DECORATION. The stages are ORDERED, and that order
// is what lets the system say which checkpoint a piece is waiting at, refuse a
// final pass while an earlier checkpoint is still in rework, and draw the
// piece's progress as a strip rather than a pile of unrelated scans. `serial`
// is therefore kept dense and unique among active stages by the reorder route
// — two stages sharing a serial makes "which comes after which" unanswerable.
//
// CODE IS THE STABLE HANDLE. A stage gets renamed ("End line" → "End-line
// audit") far more often than it gets replaced. Inspections store the code and
// the name as a snapshot, so a rename never rewrites history, and the code is
// what any later reconciliation should join on.

"use strict";

const mongoose = require("mongoose");

const qcStageSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },

    // Short, uppercase, unique. Typed by the owner or derived from the name.
    code: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      unique: true,
      index: true,
    },

    description: { type: String, default: "", trim: true },

    // Position in the line. Lower runs first. Unique among ACTIVE stages —
    // enforced by the reorder/create routes rather than by a unique index,
    // because a retired stage keeps its old serial for the history it owns.
    serial: { type: Number, required: true, index: true },

    // Retiring a stage never deletes the inspections recorded at it, so it is
    // a flag rather than a removal once anything has been scanned there.
    isActive: { type: Boolean, default: true, index: true },

    createdByEmail: { type: String, default: "", lowercase: true, trim: true },
    createdByName: { type: String, default: "" },
    updatedByEmail: { type: String, default: "", lowercase: true, trim: true },
    updatedByName: { type: String, default: "" },
  },
  { timestamps: true, collection: "qc_stages" },
);

qcStageSchema.index({ isActive: 1, serial: 1 });

module.exports =
  mongoose.models.QCStage || mongoose.model("QCStage", qcStageSchema, "qc_stages");
