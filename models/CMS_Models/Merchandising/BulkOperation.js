// models/CMS_Models/Merchandising/BulkOperation.js
//
// A PREVIEWED BULK COMMAND, AND ITS PER-ROW RESULT.
//
// ── WHY A PREVIEW IS A RECORD AND NOT A COMPUTATION ─────────────────────────
// Apply must run against the rows somebody actually LOOKED AT. If the preview
// were recomputed at apply time, a person could read forty outcomes, click
// apply, and have forty different things happen because a file moved in
// between — which is the bulk equivalent of M5's `TNA_IMPACT_STALE`, and worse
// because it is forty rows rather than one.
//
// So the preview is stored, with a checksum of the rows it was computed from
// and an expiry. Apply names the preview, and a preview whose source has moved
// is refused rather than silently applied to something else.
//
// ── AND WHY THE RESULT IS STORED TOO ────────────────────────────────────────
// A bulk apply produces per-row outcomes that somebody has to act on — the
// eleven that were refused, and why. Returning them only in the HTTP response
// means a lost tab loses them. They are written here and downloadable as CSV.
//
// ── NEITHER IS A QUEUE ──────────────────────────────────────────────────────
// Nothing drains this collection. A preview is created by a request and read
// by the next request; a result is written by an apply and read by a download.
// There is no worker, no timer, and expiry is a timestamp compared at read
// time, not a job that deletes rows.
"use strict";

const mongoose = require("mongoose");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
});

/** Every bulk command, and nothing else may be named in a URL. */
const BULK_COMMAND = Object.freeze({
  ASSIGNMENT: "assignment",
  FORECAST: "forecast",
  RESCHEDULE: "reschedule",
  CHANGE_COORDINATION: "change-coordination",
  DOWNSTREAM_SUBMIT: "downstream-submit",
  IMPORT: "import",
  ARCHIVE: "archive",
});

const BULK_COMMANDS = Object.freeze(Object.values(BULK_COMMAND));

/** What happened to one row. `APPLIED` in a PREVIEW means "would apply". */
const ROW_OUTCOME = Object.freeze({
  APPLIED: "APPLIED",
  SKIPPED: "SKIPPED",
  REFUSED: "REFUSED",
});

/** The cap, and it is a refusal rather than a truncation. */
const MAX_ROWS = 500;
/** How long a preview stays answerable. Long enough to read, short enough
 *  that the world has probably not moved underneath it. */
const PREVIEW_TTL_MINUTES = 30;

const rowSchema = new mongoose.Schema(
  {
    rowIndex: { type: Number, required: true },
    fileId: { type: mongoose.Schema.Types.ObjectId, default: null },
    ref: { type: String, trim: true, default: "" },
    outcome: { type: String, enum: Object.values(ROW_OUTCOME), required: true },
    reason: { type: String, trim: true, default: "", maxlength: 500 },
    /* What the row would do, or did — the before/after a person checks. */
    detail: { type: String, trim: true, default: "", maxlength: 500 },
  },
  { _id: false },
);

const bulkSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    previewId: { type: String, trim: true, required: true, immutable: true },
    command: { type: String, enum: BULK_COMMANDS, required: true, immutable: true },

    state: { type: String, enum: ["PREVIEWED", "APPLIED"], default: "PREVIEWED", index: true },

    /* ── WHAT THE PREVIEW WAS COMPUTED FROM ───────────────────────────────
       The request rows, and a checksum of the SOURCE state they were computed
       against. Apply recomputes the checksum; a mismatch means the world moved
       and the person would be approving something they never saw. */
    requestRows: { type: [mongoose.Schema.Types.Mixed], default: [] },
    sourceChecksum: { type: String, trim: true, default: "" },

    previewRows: { type: [rowSchema], default: [] },
    resultRows: { type: [rowSchema], default: [] },

    summary: {
      total: { type: Number, default: 0 },
      applied: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
      refused: { type: Number, default: 0 },
    },

    previewedBy: actorRef(),
    previewedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    appliedBy: actorRef(),
    appliedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "merchandising_bulk_operations" },
);

bulkSchema.index({ companyId: 1, previewId: 1 }, { unique: true });
bulkSchema.index({ companyId: 1, command: 1, createdAt: -1 });

module.exports = {
  BULK_COMMAND, BULK_COMMANDS, ROW_OUTCOME, MAX_ROWS, PREVIEW_TTL_MINUTES,
  BulkOperation: mongoose.models.BulkOperation || mongoose.model("BulkOperation", bulkSchema),
};
