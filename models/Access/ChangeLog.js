// models/Access/ChangeLog.js
//
// Who changed what, everywhere.
//
// The accounting module already keeps an activity log; nothing else does. So
// when a salary is different from last week, or a work order's dates moved, the
// only honest answer available today is "somebody changed it". This is the one
// collection every module writes to, so that answer becomes a name and a time.
//
// WHAT IT IS NOT
// --------------
// Not an audit trail in the compliance sense and not a way to undo anything.
// `before` and `after` hold only the fields that actually changed, so the log
// stays small and readable; a full document snapshot per edit would be a second
// copy of the database with none of its indexes.
//
// PII: `before`/`after` are written by the caller, and a caller logging a
// salary change must pass the field NAMES, never the encrypted values. There is
// a redaction list below for the fields that must never be stored in plain.

"use strict";

const mongoose = require("mongoose");

/** Never stored, whatever a caller passes. */
const REDACTED = new Set([
  "password", "passwordHash", "token", "accountantToken", "salary",
  "basicSalary", "grossSalary", "netSalary", "bankAccount", "accountNumber",
  "ifsc", "pan", "aadhaar", "aadhar",
]);

/** Strip secrets and shrink anything unreasonably large. */
function sanitise(patch) {
  if (!patch || typeof patch !== "object") return undefined;
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (REDACTED.has(k)) { out[k] = "[redacted]"; continue; }
    if (v === null || v === undefined) { out[k] = v; continue; }
    if (typeof v === "object") {
      const s = JSON.stringify(v);
      out[k] = s.length > 500 ? s.slice(0, 500) + "…" : v;
      continue;
    }
    out[k] = typeof v === "string" && v.length > 500 ? v.slice(0, 500) + "…" : v;
  }
  return out;
}

const changeLogSchema = new mongoose.Schema(
  {
    // Where it happened. Slug rather than id so a log entry stays readable
    // after a department is renamed.
    departmentSlug: { type: String, index: true, lowercase: true, trim: true },

    // What was touched: "employee", "attendance", "work-order", "voucher"…
    entity: { type: String, required: true, index: true },
    entityId: { type: String, index: true },
    // Something a human recognises without opening the record.
    entityLabel: { type: String, default: "" },

    action: {
      type: String,
      enum: ["create", "update", "delete", "approve", "reject", "import", "export", "other"],
      default: "update",
      index: true,
    },

    // One line, written for the person reading the history later.
    summary: { type: String, default: "" },

    // Only the fields that changed.
    before: { type: mongoose.Schema.Types.Mixed },
    after: { type: mongoose.Schema.Types.Mixed },

    // Who. Denormalised on purpose: the account may later be renamed, deleted,
    // or moved between identity collections, and the log must still say who did
    // it at the time.
    actorId: { type: mongoose.Schema.Types.ObjectId },
    actorName: { type: String, default: "" },
    actorEmail: { type: String, default: "", index: true },
    actorRole: { type: String, default: "" },
  },
  { timestamps: true, collection: "change_logs" },
);

// The two questions actually asked: "what happened to this record" and
// "what did this department change recently".
changeLogSchema.index({ entity: 1, entityId: 1, createdAt: -1 });
changeLogSchema.index({ departmentSlug: 1, createdAt: -1 });

changeLogSchema.statics.sanitise = sanitise;
changeLogSchema.statics.REDACTED = REDACTED;

module.exports =
  mongoose.models.ChangeLog ||
  mongoose.model("ChangeLog", changeLogSchema, "change_logs");
