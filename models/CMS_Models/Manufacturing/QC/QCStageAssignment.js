// models/CMS_Models/Manufacturing/QC/QCStageAssignment.js
//
// WHO IS STANDING AT WHICH CHECKPOINT, AND WHEN.
//
// A ROSTER, NOT A PROPERTY OF THE PERSON. The obvious design — a `stageId` on
// the team member — cannot answer the question the floor actually asks, which
// is "who was at end-line at 11:09 this morning". QC rotates: the owner may
// move three people between checkpoints at the top of the hour, or after ten
// minutes when a line stalls. If the stage lived on the person, every rotation
// would silently rewrite the past, and yesterday's defect would be attributed
// to whichever checkpoint that inspector happens to be standing at today.
//
// So an assignment is a ROW WITH A TIME WINDOW. Rotating someone does not edit
// their old row; it closes it (`validTo = now`) and opens a new one. The
// history stays true, and "who was where at time T" is a query rather than a
// guess.
//
// TWO KEYS, DELIBERATELY. `email` is how the CMS knows a person — it is the
// join key `department_roles` uses, and the only identifier shared by
// Employee, DeptUser and accounting accounts. `biometricId` is how the QC
// STATION knows them: the inspection screen's day-session is opened by
// scanning an ID card, and a defect carries that biometric id and no email at
// all. Both are stored, resolved once at assignment time from the Employee
// record, so a scan can be matched to a stage without a lookup per scan and a
// roster can be managed by email as everything else is.
//
// OVERLAP IS ALLOWED. Two people may hold the same stage at once (the ask was
// explicitly "in each stage there can be multiple users"), and one person may
// hold two stages at once. What is NOT allowed is two people passing the same
// piece at the same stage — that is enforced on the inspection, not here.

"use strict";

const mongoose = require("mongoose");

const qcStageAssignmentSchema = new mongoose.Schema(
  {
    stageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "QCStage",
      required: true,
      index: true,
    },
    // Snapshots, so a stage rename or retirement leaves the roster readable.
    stageCode: { type: String, default: "", uppercase: true, trim: true },
    stageName: { type: String, default: "", trim: true },

    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    name: { type: String, default: "", trim: true },

    // Resolved from the Employee record at assignment time. Empty when the
    // person has no employee record with a biometric id yet — the assignment is
    // still valid, it simply cannot be matched from a station scan until the
    // link exists, and the team screen says so rather than failing quietly.
    biometricId: { type: String, default: "", trim: true, index: true },

    // The department role held when the assignment was made. Informational —
    // authority is always re-read from department_roles, never from here.
    deptRole: { type: String, default: "" },

    validFrom: { type: Date, required: true, default: Date.now, index: true },
    // null = open-ended, i.e. "until somebody moves them".
    validTo: { type: Date, default: null, index: true },

    // Revoking outright (a mistake, not a rotation). A revoked row is excluded
    // from every window query but stays for the audit trail.
    isActive: { type: Boolean, default: true, index: true },

    assignedByEmail: { type: String, default: "", lowercase: true, trim: true },
    assignedByName: { type: String, default: "" },
    note: { type: String, default: "", trim: true },
  },
  { timestamps: true, collection: "qc_stage_assignments" },
);

// The two questions asked on every scan and every roster render.
qcStageAssignmentSchema.index({ biometricId: 1, isActive: 1, validFrom: -1 });
qcStageAssignmentSchema.index({ stageId: 1, isActive: 1, validFrom: -1 });
qcStageAssignmentSchema.index({ email: 1, isActive: 1, validFrom: -1 });

/**
 * The filter for "in force at `at`".
 *
 * Half-open on purpose: [validFrom, validTo). Closing a window at 11:00 and
 * opening the next one at 11:00 must not leave both in force for that instant,
 * which is exactly what a rotation does.
 */
qcStageAssignmentSchema.statics.windowFilter = function (at = new Date()) {
  return {
    isActive: true,
    validFrom: { $lte: at },
    $or: [{ validTo: null }, { validTo: { $gt: at } }],
  };
};

module.exports =
  mongoose.models.QCStageAssignment ||
  mongoose.model("QCStageAssignment", qcStageAssignmentSchema, "qc_stage_assignments");
