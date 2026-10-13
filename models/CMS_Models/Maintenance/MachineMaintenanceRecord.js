// models/CMS_Models/Maintenance/MachineMaintenanceRecord.js
//
// ONE MAINTENANCE OR BREAKDOWN EVENT ON ONE MACHINE OR ONE ITEM — collection
// `machine_maintenance_records`.
//
// ── SUPERSEDED BY MAINTENANCE ORDERS (3 Oct 2026) ───────────────────────────
// These were the first version's "Report Maintenance / Breakdown" records.
// Service Orders and Product Orders (MaintenanceOrder.js) replaced them; the
// app no longer writes one. Those already written stay readable in every
// machine's history, and the guards below still keep them unchanged.
//
// The SUBJECT is exactly one of: a Machine register entry (`machine`) or an
// Item Master record (`item`, a RawItem — an Asset, a spare part, whatever
// type Maintenance has been allowed to see). Since 3 Oct 2026, owner: "make
// own maintenance ... and completed it" on the items Maintenance can see. The
// collection keeps its name; every record written before then is a machine
// record and reads exactly as it did.
//
// Kept apart from the Machine register on purpose: the machine is master data
// (what it is, where it stands), a record is something that HAPPENED to it.
// A record references the machine by its `_id` and copies nothing about it
// except two facts of the moment — where the machine stood and what status the
// register gave it when the problem was reported — because those are part of
// the event and the register's own values will move on.
//
// ── APPEND-ONLY ─────────────────────────────────────────────────────────────
// Every report is a new record. A record is never replaced and never deleted,
// and what was reported (kind, problem, notes, who, when, where) is immutable.
// The one thing that moves is the record's own state, forward only:
// `open` → `completed`, with `completion` written once beside it. The guards
// below refuse anything else at the model layer, so a careless update
// elsewhere fails loudly instead of rewriting history.
//
// ── NO IMPLICIT COLLECTION ──────────────────────────────────────────────────
// `autoCreate` and `autoIndex` are off. The cluster is at its 500-collection
// cap, and the idempotency index below must exist BEFORE the first record is
// written, or a double-submitted report could land twice. So the collection
// and its indexes are made by one explicit step —
// scripts/migrations/machine-maintenance-storage.js — and the service refuses
// to write until it has run (services/maintenance/maintenanceStorage.js).
"use strict";

const mongoose = require("mongoose");

const { ObjectId } = mongoose.Schema.Types;

const COLLECTION = "machine_maintenance_records";
const RECORD_KINDS = Object.freeze(["maintenance", "breakdown"]);
const RECORD_STATUSES = Object.freeze(["open", "completed"]);

/* Built by the storage step, not at boot. Listed here so the schema documents
   them and so the storage check and the migration read one definition. */
const RECORD_INDEXES = Object.freeze([
  Object.freeze({ key: { machine: 1, reportedAt: -1 }, options: { name: "machine_reportedAt" } }),
  /* REQUIRED before any write: without it a retried report could land twice.
     The others are for speed; the storage check waits only for this one. */
  Object.freeze({ key: { idempotencyKey: 1 }, options: { name: "idempotencyKey_unique", unique: true }, required: true }),
  Object.freeze({ key: { status: 1, reportedAt: -1 }, options: { name: "status_reportedAt" } }),
  Object.freeze({ key: { item: 1, reportedAt: -1 }, options: { name: "item_reportedAt" } }),
]);

const actorSchema = new mongoose.Schema(
  {
    id: { type: ObjectId, default: null },
    name: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const machineAtReportSchema = new mongoose.Schema(
  {
    location: { type: String, trim: true, default: "" },
    status: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const completionSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    by: { type: actorSchema, required: true },
    notes: { type: String, required: true, trim: true, maxlength: 2000 },
  },
  { _id: false },
);

const recordSchema = new mongoose.Schema(
  {
    /* Exactly one of the two — see the validate hook below. */
    machine: { type: ObjectId, ref: "Machine", default: undefined, immutable: true },
    item: { type: ObjectId, ref: "RawItem", default: undefined, immutable: true },
    kind: { type: String, enum: RECORD_KINDS, required: true, immutable: true },
    problem: { type: String, required: true, trim: true, maxlength: 2000, immutable: true },
    notes: { type: String, trim: true, maxlength: 2000, default: "", immutable: true },
    reportedAt: { type: Date, required: true, immutable: true },
    reportedBy: { type: actorSchema, required: true, immutable: true },
    /* Where the machine stood when reported. Machines only. */
    machineAtReport: { type: machineAtReportSchema, default: undefined, immutable: true },
    status: { type: String, enum: RECORD_STATUSES, default: "open" },
    completion: { type: completionSchema, default: undefined },
    /* One per submission, minted by the form. A retried or double-clicked
       report carries the same key and is answered with the record it made. */
    idempotencyKey: { type: String, required: true, trim: true, immutable: true },
  },
  { collection: COLLECTION, timestamps: true, autoCreate: false, autoIndex: false },
);

recordSchema.pre("validate", function oneSubject(next) {
  const machine = this.get("machine") != null;
  const item = this.get("item") != null;
  if (machine === item) this.invalidate("machine", "A maintenance record is about exactly one machine or one item.");
  if (machine && !this.get("machineAtReport")) this.invalidate("machineAtReport", "A machine record keeps where the machine stood.");
  next();
});

/* Copies: mongoose writes into the options object it is handed. */
for (const { key, options } of RECORD_INDEXES) recordSchema.index({ ...key }, { ...options });

const REFUSAL =
  "Maintenance history is append-only: a record is never replaced or deleted, and only its completion may be added.";

/* The only paths an update may write: the forward state change, and the
   timestamps mongoose adds to an update (`updatedAt` under $set, and
   `createdAt` under $setOnInsert, which only acts on an upsert — never used). */
const ALLOWED = Object.freeze({
  $set: new Set(["status", "completion", "updatedAt"]),
  $setOnInsert: new Set(["createdAt"]),
});
const rootOf = (key) => String(key).split(".")[0];

function updateIsCompletionOnly(update) {
  if (!update || Array.isArray(update)) return false;
  return Object.entries(update).every(([op, body]) => {
    const allowed = op.startsWith("$") ? ALLOWED[op] : ALLOWED.$set;
    if (!allowed) return false;
    if (!op.startsWith("$")) return allowed.has(rootOf(op));
    return Object.keys(body || {}).every((k) => allowed.has(rootOf(k)));
  });
}

recordSchema.pre(["updateOne", "updateMany", "findOneAndUpdate"], function guardAppendOnly(next) {
  if (!updateIsCompletionOnly(this.getUpdate())) return next(new Error(REFUSAL));
  return next();
});
recordSchema.pre(
  ["replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"],
  { document: false, query: true },
  function guardNoRewrite(next) {
    return next(new Error(REFUSAL));
  },
);
recordSchema.pre("deleteOne", { document: true, query: false }, function guardNoDocDelete(next) {
  return next(new Error(REFUSAL));
});

const MachineMaintenanceRecord = mongoose.model("MachineMaintenanceRecord", recordSchema);

module.exports = MachineMaintenanceRecord;
module.exports.COLLECTION = COLLECTION;
module.exports.RECORD_KINDS = RECORD_KINDS;
module.exports.RECORD_STATUSES = RECORD_STATUSES;
module.exports.RECORD_INDEXES = RECORD_INDEXES;
module.exports.updateIsCompletionOnly = updateIsCompletionOnly;
