// models/sopmodel/sop_model.js

const mongoose = require("mongoose");

const sopSchema = new mongoose.Schema(
    {
        name: { type: String, trim: true },

        // ── What a breach costs ────────────────────────────────────────────
        // A PERCENTAGE, not a point count. C1, C2 and C4 are all percentages,
        // and C3 is subtracted from their average — so "5" here means the score
        // drops by five percentage points, which is the only reading under
        // which the arithmetic is dimensionally consistent.
        //
        // `points` is kept and still written, because every bleach already
        // recorded on an employee stores its cost in that field and the score
        // for past quarters has to keep computing. New SOPs set both to the
        // same number; readers prefer `percent` and fall back.
        percent: { type: Number, min: 0.1, default: null },
        points: { type: Number, min: 0.5 },
        // Severity tag drives the deduction amount (PDF §3.4 C3 table).
        // Null = legacy SOP created before this field existed; keeps its stored `points` as-is.
        severity: {
            type: String,
            enum: ["minor", "moderate", "serious", "falsification", "idle_pool", null],
            default: null,
        },
        description: { type: String, trim: true },
        department: { type: String, trim: true },

        // Who created
        createdBy: { type: String }, // employeeId e.g. GR001
        createdByName: { type: String },
        createdByRole: { type: String },

        // Folder grouping
        folderId: { type: mongoose.Schema.Types.ObjectId, ref: "SopFolder", default: null },
        folderName: { type: String, default: "Uncategorized" },

        // ── Approval ───────────────────────────────────────────────────────
        // A manager writes the rule; THEIR OWN primary manager approves it.
        // Not the CEO by role — the reporting line, one step up from whoever
        // created it. `approverId` is stamped at creation so the queue is
        // addressed to one named person rather than broadcast to everyone with
        // a senior role, and so a later reorganisation cannot silently move a
        // pending decision to somebody who was never asked for it.
        //
        // An administrator may also decide, for the case the line cannot cover:
        // the creator has nobody above them, or the named approver has left.
        status: {
            type: String,
            enum: ["approved", "pending", "rejected"],
            default: "pending",
        },
        approverId: { type: String, default: null },
        approverName: { type: String, default: null },
        approvedBy: { type: String, default: null },
        approvedByName: { type: String, default: null },
        approvedAt: { type: Date, default: null },
        rejectedReason: { type: String, default: "" },
    },
    { timestamps: true }
);

sopSchema.index({ department: 1, status: 1 });
sopSchema.index({ createdBy: 1 });

module.exports = mongoose.model("Sop", sopSchema);