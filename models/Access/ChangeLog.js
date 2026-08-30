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

/**
 * One changed field, spelled out.
 *
 * `before`/`after` above are the raw patch and answer "what did the record look
 * like". This answers the question a person actually asks — "what did somebody
 * change" — in the words of the screen they changed it on. `path` is a dotted
 * path so a nested edit ("punches.1.inTime") stays locatable, and `label` is
 * what the page calls that field, resolved at write time because the page may
 * be renamed later and the history must keep saying what it said.
 */
const changedFieldSchema = new mongoose.Schema(
  {
    path: { type: String, required: true },
    label: { type: String, default: "" },
    from: { type: mongoose.Schema.Types.Mixed },
    to: { type: mongoose.Schema.Types.Mixed },
    // added | removed | changed — so a UI can render a "+"/"−" without
    // re-deriving it from two mixed values that may legitimately be null.
    kind: { type: String, enum: ["added", "removed", "changed"], default: "changed" },
  },
  { _id: false },
);

/**
 * One value from the per-field diff, cleaned the same way `sanitise` cleans a
 * patch. Needed separately because the deep diff reports dotted paths, so the
 * name to check against the redaction list is the LEAF — a salary nested at
 * `components.2.basicSalary` must redact just as reliably as a top-level one.
 */
function sanitiseValue(path, value) {
  const leaf = String(path || "")
    .split(".")
    .filter((seg) => !/^\d+$/.test(seg))
    .pop();
  if (REDACTED.has(leaf)) return "[redacted]";
  if (value === null || value === undefined) return value;
  if (typeof value === "object") {
    const s = JSON.stringify(value);
    return s.length > 500 ? `${s.slice(0, 500)}…` : value;
  }
  return typeof value === "string" && value.length > 500 ? `${value.slice(0, 500)}…` : value;
}

const changeLogSchema = new mongoose.Schema(
  {
    // Where it happened. Slug rather than id so a log entry stays readable
    // after a department is renamed.
    departmentSlug: { type: String, index: true, lowercase: true, trim: true },

    // WHICH SCREEN. The department alone is too coarse to be useful: HR is
    // forty pages, and "somebody changed something in HR last Tuesday" is not
    // an answer. `section` is a stable key ("hr:attendance-daily") owned by
    // services/auditSections.js, so every page has its own history and the
    // sections can be listed without scanning the collection.
    section: { type: String, index: true, trim: true },
    sectionLabel: { type: String, default: "" },

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

    // The same change, field by field, with labels. See changedFieldSchema.
    fields: { type: [changedFieldSchema], default: [] },

    // Who. Denormalised on purpose: the account may later be renamed, deleted,
    // or moved between identity collections, and the log must still say who did
    // it at the time.
    actorId: { type: mongoose.Schema.Types.ObjectId },
    actorName: { type: String, default: "" },
    actorEmail: { type: String, default: "", index: true },
    actorRole: { type: String, default: "" },

    // HOW IT GOT IN.
    //   direct   — the actor had the standing to commit it themselves
    //   approval — the actor is an editor; it was held as a ChangeRequest and
    //              only landed because somebody accepted it. The approver is
    //              recorded below, which is what turns the entry into
    //              "changed by X, approved by Y".
    //   import   — arrived through a bulk/file import rather than a form
    //   system   — no human actor (a sync, a scheduled job)
    origin: {
      type: String,
      enum: ["direct", "approval", "import", "system"],
      default: "direct",
      index: true,
    },
    changeRequestId: { type: String, default: "", index: true },
    approvedById: { type: String, default: "" },
    approvedByName: { type: String, default: "" },
    approvedByEmail: { type: String, default: "" },
    approvedAt: { type: Date },
    decisionNote: { type: String, default: "" },

    // Which call did it. Kept because "the same edit through a different route"
    // is a real class of bug and the summary alone cannot distinguish them.
    requestMethod: { type: String, default: "" },
    requestPath: { type: String, default: "" },
  },
  { timestamps: true, collection: "change_logs" },
);

// The three questions actually asked: "what happened to this record", "what did
// this department change recently", and — the one this module was extended for
// — "what happened on THIS page".
changeLogSchema.index({ entity: 1, entityId: 1, createdAt: -1 });
changeLogSchema.index({ departmentSlug: 1, createdAt: -1 });
changeLogSchema.index({ section: 1, createdAt: -1 });
changeLogSchema.index({ departmentSlug: 1, section: 1, createdAt: -1 });

changeLogSchema.statics.sanitise = sanitise;
changeLogSchema.statics.sanitiseValue = sanitiseValue;
changeLogSchema.statics.REDACTED = REDACTED;

module.exports =
  mongoose.models.ChangeLog ||
  mongoose.model("ChangeLog", changeLogSchema, "change_logs");
