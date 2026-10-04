// models/CMS_Models/Maintenance/MaintenanceOrder.js
//
// A MAINTENANCE ORDER — collection `maintenance_orders`. Two kinds in one
// collection (the Atlas cluster is at its collection cap, and the two share
// their whole shape):
//
//   service  MSO-0001  Service Maintenance: Maintenance's own repair job, typed
//                      free-form (`serviceInfo`: what, category, location); a
//                      machine or item may be linked, never required.
//   product  MPO-0001  Product Maintenance: an exact existing machine or Item
//                      Master item, chosen by barcode or search, put into
//                      maintenance and solved.
//
// The rules (states, steps, repair time) are services/maintenance/
// maintenanceOrderFlow.js; this file is the shape and the guards.
//
// ── WHAT IT REFERENCES, AND WHAT IT KEEPS ───────────────────────────────────
// `subject` POINTS at the master record — a Machine (`machine`) or a RawItem
// (`item`) — and is never a copy of it. `subjectAtOpen` keeps four facts of
// the moment the order was raised (name, code, type, location), because an
// order is history and the master record will move on: a machine renamed next
// year must not rename last year's repair. Nothing else is copied.
//
// ── APPEND-ONLY ─────────────────────────────────────────────────────────────
// What was raised (type, number, subject, problem, who, when) is immutable.
// The lifecycle fields are written by the steps, each once, forward only
// (the service filters every write on the current status). `events` only
// grows. Replacing or deleting an order is refused at the model.
//
// ── NO IMPLICIT COLLECTION ──────────────────────────────────────────────────
// `autoCreate`/`autoIndex` are off: the unique number and idempotency indexes
// must exist before the first write, and on Atlas the collection needs a free
// slot. scripts/migrations/machine-maintenance-storage.js makes both.
"use strict";

const mongoose = require("mongoose");

const { ObjectId } = mongoose.Schema.Types;

const COLLECTION = "maintenance_orders";
const ORDER_TYPES = Object.freeze(["service", "product"]);
/* Open → In progress → Done → Closed, and Cancelled (owner, 3 Oct 2026). The
   first version's words stay valid so a job not yet converted
   (scripts/migrations/maintenance-order-statuses.js) still loads; every
   reader turns them into the new ones (maintenanceOrderFlow.normalizeStatus),
   and no new job is ever given one. */
const ALL_STATUSES = Object.freeze([
  "OPEN", "IN_PROGRESS", "DONE", "CLOSED", "CANCELLED",
  "DRAFT", "REPAIR_COMPLETED", "CREATED", "IN_MAINTENANCE", "WORK_IN_PROGRESS", "SOLVED", "COMPLETED",
]);

const ORDER_INDEXES = Object.freeze([
  Object.freeze({ key: { orderNumber: 1 }, options: { name: "orderNumber_unique", unique: true }, required: true }),
  Object.freeze({ key: { idempotencyKey: 1 }, options: { name: "idempotencyKey_unique", unique: true }, required: true }),
  Object.freeze({ key: { "subject.machine": 1, openedAt: -1 }, options: { name: "subject_machine_openedAt" } }),
  Object.freeze({ key: { "subject.item": 1, openedAt: -1 }, options: { name: "subject_item_openedAt" } }),
  Object.freeze({ key: { orderType: 1, status: 1, openedAt: -1 }, options: { name: "type_status_openedAt" } }),
]);

const actorSchema = new mongoose.Schema(
  {
    id: { type: ObjectId, default: null },
    name: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

/* "none": a Service order raised free-form, about no register record ("AC
   servicing – office"). Product orders always point at a machine or item. */
const SUBJECT_KINDS = Object.freeze(["machine", "item", "none"]);

const subjectSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: SUBJECT_KINDS, required: true },
    machine: { type: ObjectId, ref: "Machine", default: undefined },
    item: { type: ObjectId, ref: "RawItem", default: undefined },
    variantId: { type: ObjectId, default: undefined },
    /* The barcode the order was raised from, as scanned: a machine tag
       (MCH-…) or a Store sticker id. Empty when it was picked by search. */
    barcode: { type: String, trim: true, default: "" },
    barcodeKind: { type: String, enum: ["", "machine-tag", "store-sticker"], default: "" },
  },
  { _id: false },
);

const subjectAtOpenSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: "" },
    code: { type: String, trim: true, default: "" },
    type: { type: String, trim: true, default: "" },
    location: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

/* What a Service order is about, as the person typed it. A linked machine,
   when there is one, is in `subject`; this is the job's own description. */
const serviceInfoSchema = new mongoose.Schema(
  {
    /* The Store service form's identity: service name, category, description
       or specification — its limits (services/maintenance/maintenanceServiceTerms.js). */
    title: { type: String, trim: true, maxlength: 200, required: true },
    category: { type: String, trim: true, maxlength: 120, default: "" },
    description: { type: String, trim: true, maxlength: 5000, default: "" },
    location: { type: String, trim: true, maxlength: 160, default: "" },
  },
  { _id: false },
);

/* The rest of the Store service form, kept when the work is done by an
   OUTSIDE vendor: how they bill, an estimate, lead time, the supplier and
   budget head (ids checked against the Store's suppliers and Finance's heads,
   names kept as they were then), tax, and the renewal cycle. Planning facts,
   never an approval: nothing here orders, prices or reserves anything. */
const serviceTermsSchema = new mongoose.Schema(
  {
    billingUnit: { type: String, trim: true, maxlength: 60, default: "" },
    defaultRate: { type: Number, min: 0, default: null },
    leadTimeDays: { type: Number, min: 0, default: null },
    preferredVendorId: { type: ObjectId, ref: "Vendor", default: null },
    preferredVendorName: { type: String, trim: true, default: "" },
    budgetLedgerId: { type: ObjectId, default: null },
    budgetLedgerName: { type: String, trim: true, default: "" },
    sacCode: { type: String, trim: true, maxlength: 20, default: "" },
    defaultGstRate: { type: Number, min: 0, max: 100, default: null },
    recurring: {
      frequency: { type: String, enum: ["NONE", "MONTHLY", "QUARTERLY", "HALF_YEARLY", "YEARLY"], default: "NONE" },
      noticeDays: { type: Number, min: 0, default: null },
    },
  },
  { _id: false },
);

/* The job's planning facts, typed when it was raised (both kinds). All
   optional; nothing here is a commitment — an estimate is an estimate. */
const PRIORITIES = Object.freeze(["low", "normal", "high", "urgent"]);
const MAINTENANCE_TYPES = Object.freeze(["breakdown", "preventive", "routine", "inspection", "installation", "other"]);
const detailsSchema = new mongoose.Schema(
  {
    priority: { type: String, enum: PRIORITIES, default: "normal" },
    maintenanceType: { type: String, enum: ["", ...MAINTENANCE_TYPES], default: "" },
    /* Service: what is covered, and what is not. */
    specification: { type: String, trim: true, maxlength: 2000, default: "" },
    department: { type: String, trim: true, maxlength: 120, default: "" },
    targetDate: { type: Date, default: undefined },
    estimatedCost: { type: Number, min: 0, default: undefined },
    /* Who does the work: Maintenance itself, or an outside vendor/technician. */
    provider: {
      kind: { type: String, enum: ["in-house", "outside"], default: "in-house" },
      name: { type: String, trim: true, maxlength: 160, default: "" },
      contact: { type: String, trim: true, maxlength: 160, default: "" },
    },
    /* Product: the state it came in, what came with it, who handed it over. */
    conditionReceived: { type: String, trim: true, maxlength: 1000, default: "" },
    accessories: { type: String, trim: true, maxlength: 500, default: "" },
    handedOverBy: { type: String, trim: true, maxlength: 160, default: "" },
    notes: { type: String, trim: true, maxlength: 2000, default: "" },
  },
  { _id: false },
);

/* A photo or document kept on Google Drive (the CMS's /api/upload-to-drive).
   Only the reference is stored here; the file lives on Drive. Appended, never
   removed. */
const attachmentSchema = new mongoose.Schema(
  {
    fileId: { type: String, required: true, trim: true, maxlength: 200 },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    mimeType: { type: String, trim: true, maxlength: 120, default: "" },
    size: { type: Number, min: 0, default: undefined },
    /* raised: with the job; proof: with "Mark done", as proof of the work
       (owner, 4 Oct 2026); later: added on the job page at any time. */
    stage: { type: String, enum: ["raised", "proof", "later"], default: "raised" },
    uploadedAt: { type: Date, required: true },
    uploadedBy: { type: actorSchema, required: true },
  },
  { _id: false },
);

const partSchema = new mongoose.Schema(
  {
    item: { type: ObjectId, ref: "RawItem", default: null },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    quantity: { type: Number, min: 0, default: 1 },
    unit: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const reportSchema = new mongoose.Schema(
  {
    diagnosis: { type: String, trim: true, maxlength: 4000, default: "" },
    workPerformed: { type: String, trim: true, maxlength: 4000, default: "" },
    notes: { type: String, trim: true, maxlength: 4000, default: "" },
  },
  { _id: false },
);

const eventSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    by: { type: actorSchema, required: true },
    action: { type: String, required: true, trim: true },
    from: { type: String, trim: true, default: "" },
    to: { type: String, trim: true, default: "" },
    note: { type: String, trim: true, maxlength: 2000, default: "" },
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    orderType: { type: String, enum: ORDER_TYPES, required: true, immutable: true },
    orderNumber: { type: String, required: true, trim: true, immutable: true },
    subject: { type: subjectSchema, required: true, immutable: true },
    subjectAtOpen: { type: subjectAtOpenSchema, required: true, immutable: true },
    serviceInfo: { type: serviceInfoSchema, default: undefined, immutable: true },
    serviceTerms: { type: serviceTermsSchema, default: undefined, immutable: true },
    details: { type: detailsSchema, default: undefined, immutable: true },
    attachments: { type: [attachmentSchema], default: () => [] },
    problem: { type: String, required: true, trim: true, maxlength: 2000, immutable: true },
    openedAt: { type: Date, required: true, immutable: true },
    openedBy: { type: actorSchema, required: true, immutable: true },

    status: { type: String, enum: ALL_STATUSES, required: true },
    assignedTo: { type: actorSchema, default: undefined },

    /* Product orders only: when the item was handed to Maintenance. */
    inMaintenanceAt: { type: Date, default: undefined },
    inMaintenanceBy: { type: actorSchema, default: undefined },
    /* The repair clock: started by "Start repair" / "Start work", stopped by
       "Complete repair" / "Mark solved". `repairMinutes` is derived from the
       two and stored so history and averages need no recomputation. */
    workStartedAt: { type: Date, default: undefined },
    workStartedBy: { type: actorSchema, default: undefined },
    workDoneAt: { type: Date, default: undefined },
    workDoneBy: { type: actorSchema, default: undefined },
    repairMinutes: { type: Number, min: 0, default: undefined },
    report: { type: reportSchema, default: undefined },
    partsUsed: { type: [partSchema], default: undefined },
    /* "Close" (service) / "Complete" (product). */
    closedAt: { type: Date, default: undefined },
    closedBy: { type: actorSchema, default: undefined },
    cancelledAt: { type: Date, default: undefined },
    cancelledBy: { type: actorSchema, default: undefined },
    cancelReason: { type: String, trim: true, default: undefined },

    events: { type: [eventSchema], default: () => [] },
    idempotencyKey: { type: String, required: true, trim: true, immutable: true },
  },
  { collection: COLLECTION, timestamps: true, autoCreate: false, autoIndex: false },
);

/* Copies: mongoose writes into the options object it is handed. */
for (const { key, options } of ORDER_INDEXES) orderSchema.index({ ...key }, { ...options });

orderSchema.pre("validate", function oneSubject(next) {
  const s = this.get("subject");
  if (s) {
    const machine = s.machine != null;
    const item = s.item != null;
    if (s.kind === "none") {
      if (machine || item) this.invalidate("subject", "A free-form order points at no machine or item.");
      if (this.get("orderType") !== "service") this.invalidate("subject", "A Product order is about an exact existing machine or item.");
      if (!this.get("serviceInfo")?.title) this.invalidate("serviceInfo", "Say what is being serviced.");
    } else if (machine === item || (s.kind === "machine") !== machine) {
      this.invalidate("subject", "An order is about exactly one machine or one item.");
    }
  }
  next();
});

const REFUSAL =
  "A maintenance order is never replaced or deleted, and what was raised never changes; only its next step may be recorded.";

/* What a step may write. Everything else on an order is immutable. */
const LIFECYCLE = new Set([
  "status", "assignedTo", "inMaintenanceAt", "inMaintenanceBy", "workStartedAt", "workStartedBy",
  "workDoneAt", "workDoneBy", "repairMinutes", "report", "partsUsed", "closedAt", "closedBy",
  "cancelledAt", "cancelledBy", "cancelReason", "updatedAt",
]);
/* `attachments` only grows: a photo or document may be added to a job at any
   time (a vendor's invoice after closing), never taken away. */
const ALLOWED = Object.freeze({ $set: LIFECYCLE, $setOnInsert: new Set(["createdAt"]), $push: new Set(["events", "attachments"]) });
const rootOf = (key) => String(key).split(".")[0];

function updateIsStepOnly(update) {
  if (!update || Array.isArray(update)) return false;
  return Object.entries(update).every(([op, body]) => {
    const allowed = op.startsWith("$") ? ALLOWED[op] : ALLOWED.$set;
    if (!allowed) return false;
    if (!op.startsWith("$")) return allowed.has(rootOf(op));
    return Object.keys(body || {}).every((k) => allowed.has(rootOf(k)));
  });
}

orderSchema.pre(["updateOne", "updateMany", "findOneAndUpdate"], function guardSteps(next) {
  if (!updateIsStepOnly(this.getUpdate())) return next(new Error(REFUSAL));
  return next();
});
orderSchema.pre(
  ["replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"],
  { document: false, query: true },
  function guardNoRewrite(next) { return next(new Error(REFUSAL)); },
);
orderSchema.pre("deleteOne", { document: true, query: false }, function guardNoDocDelete(next) {
  return next(new Error(REFUSAL));
});

const MaintenanceOrder = mongoose.models.MaintenanceOrder || mongoose.model("MaintenanceOrder", orderSchema);

module.exports = MaintenanceOrder;
module.exports.COLLECTION = COLLECTION;
module.exports.ORDER_INDEXES = ORDER_INDEXES;
module.exports.updateIsStepOnly = updateIsStepOnly;
module.exports.PRIORITIES = PRIORITIES;
module.exports.MAINTENANCE_TYPES = MAINTENANCE_TYPES;
