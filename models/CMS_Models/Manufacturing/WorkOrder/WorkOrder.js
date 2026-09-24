// models/CMS_Models/Manufacturing/WorkOrder/WorkOrder.js

const mongoose = require("mongoose");
const {
  PLANNING_STATES,
  PLANNING_STATE_NOT_STARTED,
} = require("../../../../constants/workOrderPlanningState");

// ── operationAssignmentSchema ─────────────────────────────────────────────────
// Stores operation identity (name + code) and planned timing only.
// Machine assignment is NOT done at planning time.
// The device sends activeOps (array of operation codes) at scan time.
const operationAssignmentSchema = new mongoose.Schema(
  {
    operationType: {
      // Human-readable name from the Operation registry (e.g. "Sleeve Join")
      type: String,
      trim: true,
    },
    operationCode: {
      // Short code from the Operation registry (e.g. "SJ-01").
      // This is what the device compares against during scanning.
      type: String,
      trim: true,
      default: "",
    },
    plannedTimeSeconds: {
      type: Number,
      min: 0,
      default: 0,
    },
    status: {
      type: String,
      enum: ["pending", "scheduled", "in_progress", "completed", "delayed"],
      default: "pending",
    },
    notes: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { _id: true },
);

// ── rawMaterialAllocationSchema ───────────────────────────────────────────────
const rawMaterialAllocationSchema = new mongoose.Schema(
  {
    rawItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RawItem",
      required: true,
    },
    name: { type: String, trim: true, required: true },
    sku: { type: String, trim: true, required: true },
    rawItemVariantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    rawItemVariantCombination: [{ type: String, trim: true }],
    // BOM breakdown snapshot: quantityRequired = requiredQuantity * (1 + allowancePercent/100)
    requiredQuantity: { type: Number, min: 0 },
    allowancePercent: { type: Number, default: 0, min: 0 },
    quantityRequired: { type: Number, required: true, min: 0 },
    quantityAllocated: { type: Number, default: 0, min: 0 },
    quantityIssued: { type: Number, default: 0, min: 0 },
    unit: { type: String, trim: true, required: true },
    unitCost: { type: Number, required: true, min: 0 },
    totalCost: { type: Number, required: true, min: 0 },
    allocationStatus: {
      type: String,
      enum: ["not_allocated", "partially_allocated", "fully_allocated", "issued"],
      default: "not_allocated",
    },
    notes: { type: String, trim: true, default: "" },
  },
  { _id: true },
);

// ── timelineSchema ────────────────────────────────────────────────────────────
const timelineSchema = new mongoose.Schema({
  plannedStartDate: { type: Date, default: null },
  plannedEndDate: { type: Date, default: null },
  actualStartDate: { type: Date, default: null },
  actualEndDate: { type: Date, default: null },
  scheduledStartDate: { type: Date, default: null },
  scheduledEndDate: { type: Date, default: null },
  totalEstimatedSeconds: { type: Number, default: 0, min: 0 },
  totalPlannedSeconds: { type: Number, default: 0, min: 0 },
  efficiencyPercentage: { type: Number, default: 100, min: 0, max: 100 },
});

// ── Production Completion Tracking (written by cron from scan data) ───────────
const operationCompletionSchema = new mongoose.Schema(
  {
    operationNumber: { type: Number, required: true },
    operationType: { type: String, trim: true },
    operationCode: { type: String, trim: true, default: "" },
    completedQuantity: { type: Number, default: 0, min: 0 },
    completedUnitNumbers: [{ type: Number }],
    totalQuantity: { type: Number, required: true },
    completionPercentage: { type: Number, default: 0, min: 0, max: 100 },
    status: {
      type: String,
      enum: ["pending", "in_progress", "completed"],
      default: "pending",
    },
  },
  { _id: false },
);

const operatorDetailSchema = new mongoose.Schema(
  {
    operatorId: { type: String, required: true },
    operatorName: { type: String, required: true },
    operationNumber: { type: Number, required: true },
    operationType: { type: String },
    operationCode: { type: String, default: "" },
    machineId: { type: mongoose.Schema.Types.ObjectId, ref: "Machine" },
    machineName: { type: String },
    totalScans: { type: Number, default: 0 },
    signInTime: { type: Date },
    signOutTime: { type: Date },
  },
  { _id: false },
);

const efficiencyMetricSchema = new mongoose.Schema(
  {
    operationNumber: { type: Number, required: true },
    operationType: { type: String },
    operationCode: { type: String, default: "" },
    machineId: { type: mongoose.Schema.Types.ObjectId, ref: "Machine" },
    machineName: { type: String },
    operatorId: { type: String },
    operatorName: { type: String },
    unitsCompleted: { type: Number, default: 0 },
    avgTimePerUnit: { type: Number, default: 0 },
    estimatedTimePerUnit: { type: Number, default: 0 },
    plannedTimePerUnit: { type: Number, default: 0 },
    efficiencyPercentage: { type: Number, default: 0 },
    utilizationRate: { type: Number, default: 0 },
    totalProductiveTime: { type: Number, default: 0 },
    totalSessionTime: { type: Number, default: 0 },
  },
  { _id: false },
);

const timeMetricSchema = new mongoose.Schema(
  {
    operationNumber: { type: Number, required: true },
    operationType: { type: String },
    operationCode: { type: String, default: "" },
    machineId: { type: mongoose.Schema.Types.ObjectId, ref: "Machine" },
    machineName: { type: String },
    avgCompletionTimeSeconds: { type: Number, default: 0 },
    minCompletionTimeSeconds: { type: Number, default: 0 },
    maxCompletionTimeSeconds: { type: Number, default: 0 },
    totalUnitsAnalyzed: { type: Number, default: 0 },
  },
  { _id: false },
);

const invalidScanSchema = new mongoose.Schema(
  {
    barcodeId: { type: String, required: true },
    timestamp: { type: Date, required: true },
    unitNumber: { type: Number, default: null },
    operatorId: { type: String },
    operatorName: { type: String },
    machineId: { type: mongoose.Schema.Types.ObjectId, ref: "Machine" },
    machineName: { type: String },
    reason: {
      type: String,
      enum: ["invalid_format", "exceeds_quantity", "duplicate", "other"],
      default: "other",
    },
    details: { type: String },
  },
  { _id: false },
);

const productionCompletionSchema = new mongoose.Schema(
  {
    overallCompletedQuantity: { type: Number, default: 0, min: 0 },
    overallCompletionPercentage: { type: Number, default: 0, min: 0, max: 100 },
    operationCompletion: [operationCompletionSchema],
    operatorDetails: [operatorDetailSchema],
    efficiencyMetrics: [efficiencyMetricSchema],
    timeMetrics: [timeMetricSchema],
    invalidScansCount: { type: Number, default: 0 },
    invalidScans: [invalidScanSchema],
    lastSyncedAt: { type: Date, default: null },
  },
  { _id: false },
);

const dispatchRecordSchema = new mongoose.Schema(
  {
    dispatchedQuantity: { type: Number, required: true, min: 1 },
    dispatchedAt: { type: Date, default: Date.now },
    dispatchedBy: { type: String },
    notes: { type: String, trim: true },
    dispatchType: {
      type: String,
      enum: ["person_wise", "bulk"],
      default: "bulk",
    },
    employeeIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "EmployeeMpc" }],
    employeeNames: [{ type: String }],
  },
  { _id: true },
);

// ── Bulk Order Tracking tab's own dispatch ledger (Manufacturing-Order routes) ──
// Kept separate from `dispatchRecordSchema`/`dispatchRecords` above, which is the
// person-wise/bulk dispatch ledger used elsewhere — this one backs the
// PM-facing "Bulk Order Tracking" tab's dispatch-bulk / bulk-dispatch-history routes.
const bulkDispatchHistoryEntrySchema = new mongoose.Schema(
  {
    quantity: { type: Number, required: true, min: 1 },
    notes: { type: String, trim: true, default: "" },
    dispatchedBy: { type: String, default: "" },
    dispatchedAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

// ── WorkOrder ─────────────────────────────────────────────────────────────────
const workOrderSchema = new mongoose.Schema(
  {
    workOrderNumber: { type: String, unique: true, trim: true },
    customerRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerRequest" },

    /* ── THE STYLE THIS ORDER IS MAKING (IE Chunk 1D) ─────────────────────
     *
     * The canonical, ORDER-SPECIFIC link from a work order to the exact
     * SampleStyle it was created from. It is written as part of the work
     * order's original creation, by every live creation path, and never
     * appended afterwards by a second best-effort write.
     *
     * ── WHY IT LIVES HERE AND NOT ONLY ON THE STYLE ──────────────────────
     * `SampleStyle.production.workOrderIds[]` already exists and stays as a
     * legacy compatibility reference — but it is the wrong authority. It is
     * written from the style's side, after the fact, so a work order created
     * without it looks identical to one whose style was never linked; and two
     * writers on opposite ends of the same relationship drift. The fact "this
     * order makes that style" belongs to the ORDER, is known at the moment the
     * order is built, and is one value rather than an array somebody appends
     * to.
     *
     * ── AND WHY IT HAS NO DEFAULT AT ALL ────────────────────────────────
     * Not even `null`. 147 existing work orders do not have the field and no
     * backfill is approved, so absence must stay genuinely ABSENT: a
     * `default: null` writes a null onto every legacy document the moment an
     * unrelated field is saved, which fabricates a claim ("this order was
     * considered and has no style") that nothing supports, and puts those
     * documents into a sparse index built to exclude them.
     *
     * No live writer stores `null` either. Since the Chunk 1D correction,
     * every creation path proves an ObjectId or refuses before writing — there
     * is no third outcome.
     *
     * Sparse index: the IE order boundary looks orders up BY style, and the
     * field is absent on most rows today, so a sparse index covers the read
     * without indexing the absent ones. */
    sampleStyleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SampleStyle",
      index: true,
      sparse: true,
    },
    /* ── THE CONFIRMED SALES LINE THIS ORDER MAKES ────────────────────────
     *
     * `customerRequestId` names the order, not the line, and one order holds
     * several lines — the same product twice among them. This names exactly
     * ONE permanent Sales line (`CustomerRequest.items[].lineRef`) and the
     * ONE company it was proved to belong to, so PPC can join a planned line
     * to its WorkOrders without guessing by product, style, size or number.
     *
     * Written by the creation path in the order's original save, from the
     * stored request line and the server-proved company — never from a
     * request body — and never changed afterwards (see the hook below).
     * services/production/salesLineWorkOrderLink.service.js is the one place
     * that builds it.
     *
     * `basis` says how the line was reached: the Sales line itself, a split
     * inheriting its parent's line, or a return/remake naming its OWN return
     * line (with `origin` recording the source WorkOrders and their lines,
     * without claiming to be them).
     *
     * NO DEFAULT, like `sampleStyleId`: historical WorkOrders have no provable
     * line, and absence must stay absent — read as `unlinked`, never filled. */
    salesLineLink: {
      type: new mongoose.Schema({
        companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
        customerRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerRequest", required: true },
        lineRef: { type: String, trim: true, required: true, match: /^LN-[0-9a-f]{12}$/ },
        basis: { type: String, enum: ["sales_line", "split_parent", "return_line"], required: true },
        parentWorkOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder", default: undefined },
        origin: {
          type: new mongoose.Schema({
            returnRequestId: { type: mongoose.Schema.Types.ObjectId, default: null },
            originalCustomerRequestId: { type: mongoose.Schema.Types.ObjectId, default: null },
            sourceWorkOrderIds: [{ type: mongoose.Schema.Types.ObjectId }],
            sourceLines: [new mongoose.Schema({
              customerRequestId: { type: mongoose.Schema.Types.ObjectId },
              lineRef: { type: String, trim: true },
            }, { _id: false })],
          }, { _id: false }),
          default: undefined,
        },
        linkedAt: { type: Date },
      }, { _id: false }),
      default: undefined,
    },
    stockItemId: { type: mongoose.Schema.Types.ObjectId, ref: "StockItem" },
    stockItemName: { type: String, trim: true },
    stockItemReference: { type: String, trim: true },
    variantId: { type: String },
    variantAttributes: [
      {
        name: { type: String, trim: true },
        value: { type: String, trim: true },
      },
    ],
    quantity: { type: Number, min: 1 },
    originalQuantity: { type: Number, min: 1 },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
    customerName: { type: String, trim: true },
    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      default: "medium",
    },
    status: {
      type: String,
      enum: [
        "pending", "planned", "scheduled", "ready_to_start",
        "in_progress", "paused", "completed", "cancelled",
        "delayed", "partial_allocation", "forwarded",
      ],
      default: "pending",
    },

    /* ── WHY IT WAS CANCELLED, KEPT ──────────────────────────────────────
       `cancelled` was already an allowed status and already excluded from
       QC's listing, but nothing recorded WHY — and "there is a manufacturing
       order here that never produced anything" is a question somebody asks
       six months later, which a status alone does not answer.

       A cancelled order stays exactly where it was, with its cutting records
       and its history. This is the account beside it.

       An explicit sub-schema rather than a bare nested path: assigning a
       whole object to a nested path leaves mongoose to infer the shape, and
       a key it does not recognise is dropped silently — which is how the
       account of why can go missing while the status saves. */
    cancellation: {
      type: new mongoose.Schema({
        at: { type: Date },
        byActorId: { type: String, trim: true, default: "" },
        byName: { type: String, trim: true, default: "" },
        reason: { type: String, trim: true, default: "", maxlength: 1000 },
        /* The facts that made cancelling permissible, frozen at the moment
           it was permitted — so a later re-route cannot make the decision
           look wrong in hindsight. */
        operationsAtCancellation: { type: Number, default: null },
        productionScansAtCancellation: { type: Number, default: null },
        qcInspectionsAtCancellation: { type: Number, default: null },
        /* Cutting already done belongs to the cancelled attempt. Recorded
           here so the replacement order does not silently inherit it. */
        cuttingRecorded: { type: Boolean, default: false },
      }, { _id: false }),
      default: undefined,
    },

    /*
     * The PLANNING axis, additive and independent of `status` above, which is
     * left exactly as it was (decision 1, approved 3 Sep 2026).
     *
     * NO `default`, and NOT `required`, both deliberately:
     *
     * - A default was measured to MASK legacy absence. `findOne()` would
     *   hydrate `not_started` while `.lean()` showed no stored field, so every
     *   legacy record would silently read as "planning has not begun" — a
     *   claim nothing in those records supports. Absence is interpreted as
     *   `unknown` on READ instead (normalizePlanningState), so reading never
     *   writes and the stored document stays honest.
     * - `required` would refuse to save a legacy record for an unrelated edit,
     *   which is the same reason `workOrderNumber` is not required either.
     *
     * New records get `not_started` from the invariant below, where the
     * `isNew` guard makes the claim true by construction.
     */
    planningState: {
      type: String,
      enum: PLANNING_STATES,
    },

    // Operations — name + code + timing only. No machine assignment at planning.
    operations: [operationAssignmentSchema],

    rawMaterials: [rawMaterialAllocationSchema],
    timeline: timelineSchema,

    assignedDeadline: {
      type: Date,
      default: null,
    },
    assignedDeadlineMeta: {
      assignedAt: { type: Date, default: null },
      assignedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "SalesDepartment",
        default: null,
      },
    },

    storeDepartmentVerified: {
      type: Boolean,
      default: false,
      index: true,   // useful for "show me unverified WOs" queries
    },
    storeDepartmentVerifiedAt: {
      type: Date,
      default: null,
    },
    storeDepartmentVerifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StoreDepartment",
      default: null,
    },
    storeDepartmentNotes: {
      type: String,
      trim: true,
      default: "",
    },

    productionCompletion: productionCompletionSchema,

    specialInstructions: [{ type: String, trim: true }],
    estimatedCost: { type: Number, min: 0, default: 0 },
    actualCost: { type: Number, min: 0, default: 0 },

    productionNotes: [
      {
        note: { type: String, trim: true },
        addedBy: {
          type: mongoose.Schema.Types.ObjectId,
          refPath: "productionNotes.addedByModel",
        },
        addedByModel: {
          type: String,
          enum: ["SalesDepartment", "ProjectManager", "Operator"],
        },
        addedAt: { type: Date, default: Date.now },
      },
    ],

    qualityCheck: {
      passed: { type: Boolean, default: false },
      checkedBy: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager" },
      checkedAt: { type: Date },
      notes: { type: String, trim: true },
    },

    // ── QC quantity tracking (PM manual mark — QC has no per-unit aggregate
    // elsewhere: real QC results live in the separate QCInspection collection,
    // keyed by individual barcode, with nothing rolled up onto the WorkOrder).
    // Mirrors productionCompletion's shape at the scale this needs (19 Aug 2026).
    qcCompletion: {
      completedQuantity: { type: Number, default: 0, min: 0 },
      history: [
        {
          quantity: { type: Number, required: true, min: 1 },
          notes: { type: String, trim: true, default: "" },
          checkedBy: { type: String, default: "" },
          checkedAt: { type: Date, default: Date.now },
        },
      ],
    },

    /* Marked by the web's "Send to cutting"; the offline cutting desktop pulls
       every work order with this set (see cuttingSyncRoutes.js). */
    sentToCutting: { type: Boolean, default: false },
    sentToCuttingAt: { type: Date, default: null },
    cuttingStatus: {
      type: String,
      enum: ["pending", "in_progress", "completed"],
      default: "pending",
    },
    cuttingProgress: {
      completed: { type: Number, default: 0, min: 0 },
      remaining: {
        type: Number,
        default: function () { return this.quantity || 0; },
        min: 0,
      },
    },


    // ── Packaging tracking (for bulk orders mainly, also used by measurement) ──
    packagedQuantity: { type: Number, default: 0, min: 0 },
    packagingRecords: [
      {
        packagedQuantity: { type: Number, required: true, min: 1 },
        packagedAt: { type: Date, default: Date.now },
        packagedBy: { type: String, default: "" },
        packagingType: { type: String, enum: ["person_wise", "bulk"], default: "bulk" },
        employeeIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "EmployeeMpc" }],
        employeeNames: [{ type: String }],
        notes: { type: String, trim: true, default: "" },
        unitNumbers: [{ type: Number }], // ← ADD
        /* The carton these units went into (24 Sep 2026). Packing is
           carton-wise now — see models/.../Packaging/PackingCarton.js — and
           this record is kept in step so every screen reading
           packagedQuantity keeps working while the carton is one hop away.
           Absent on records written before cartons existed. */
        cartonId: { type: mongoose.Schema.Types.ObjectId, ref: "PackingCarton" },
        cartonNumber: { type: String, trim: true },
        /* `packagedBy` above is a display name. This is the session user id,
           so "who packed this" resolves to a person, not a string. */
        packedByUserId: { type: String, trim: true },
      },
    ],

    dispatchedQuantity: { type: Number, default: 0, min: 0 },
    dispatchRecords: [dispatchRecordSchema],
    bulkDispatchHistory: [bulkDispatchHistoryEntrySchema],

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "SalesDepartment" },
    plannedBy: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },
    plannedAt: { type: Date, default: null },
    planningNotes: { type: String, trim: true, default: "" },

    isSplitOrder: { type: Boolean, default: false },
    parentWorkOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder", default: null },
    splitReason: { type: String, trim: true, default: "" },

    forwardedToVendor: { type: mongoose.Schema.Types.ObjectId, ref: "VendorDetails", default: null },
    forwardedAt: { type: Date, default: null },
    forwardedBy: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },
    vendorWorkOrderReference: { type: String, trim: true, default: null },
  },
  { timestamps: true },
);

// ── Indexes (added 29 Aug 2026, chasing QC dashboard load time) ──────────────
// The collection carries ~9 KB per document, so a scan here is expensive well
// before the row count looks alarming. Both shapes below are issued by the QC
// order screens on every load and neither was indexed.
workOrderSchema.index({ status: 1, createdAt: -1 });
workOrderSchema.index({ customerRequestId: 1, status: 1 });
// The Sales-line bridge is always read within one company. Partial, so the
// historical WorkOrders that carry no link are not indexed at all.
workOrderSchema.index(
  { "salesLineLink.companyId": 1, "salesLineLink.lineRef": 1 },
  { partialFilterExpression: { "salesLineLink.lineRef": { $type: "string" } } },
);
workOrderSchema.index(
  { "salesLineLink.companyId": 1, "salesLineLink.origin.sourceLines.lineRef": 1 },
  { partialFilterExpression: { "salesLineLink.basis": "return_line" } },
);

// ── Identity ────────────────────────────────────────────────────────────────
//
// `workOrderNumber` is declared unique, and until now NOTHING assigned it.
// Neither Sales generator (routes/CMS_Routes/Sales/quotationRoutes.js:1868 and
// :2768) nor either return/rework generator
// (routes/CMS_Routes/Manufacturing/Return/returnRequestRoutes.js:340 and :375)
// set a number, there was no hook, and there is no counter. On a database where
// the unique index is actually built, the first numberless work order stores
// `null` and the SECOND fails with E11000 — work-order creation capped at one
// document. The scattered `workOrderNumber || "WO-" + _id.slice(-8)` reads
// throughout the codebase exist because the field is normally empty.
//
// The rule lives here, at the model boundary, rather than in the four call
// sites, so a creation path added tomorrow cannot reintroduce the defect.
//
// WHY THE FULL ObjectId, NOT ITS LAST EIGHT CHARACTERS
// ----------------------------------------------------
// The eight-character form some readers display is a PRESENTATION fallback. As
// an identity it keeps 32 bits, and 32 bits behind a unique index is a
// collision waiting for enough rows — a handful of passing fixtures proves
// nothing about that. The full id is unique wherever ObjectIds are, needs no
// counter or coordination service, and is known before the first write.
//
// It stays compatible with the scan subsystem because that subsystem is
// independent: every unit barcode is BUILT from `_id.slice(-8)` and RESOLVED
// the same way, and none of it reads `workOrderNumber`. Appending the usual
// `-<unit>` suffix still satisfies every parser's `parts.length >= 3 &&
// parts[0] === "WO"` guard, and no parser asserts a segment length.

/** The canonical number for a work order that has none of its own. */
function canonicalWorkOrderNumber(id) {
  return `WO-${String(id)}`;
}

/** Shared so a caller that needs the value early uses the same rule. */
workOrderSchema.statics.canonicalNumber = canonicalWorkOrderNumber;

/*
 * ONE hook for both new-record invariants, not two.
 *
 * `validate` rather than `save`: it is the one document hook that fires for
 * every persistence API this repository uses — `new X().save()`,
 * `Model.create()` (single and array) and `Model.insertMany()`, which does not
 * run save middleware at all.
 *
 * Both invariants are guarded on `isNew`, so an EXISTING record — of which
 * production holds many with neither field — is never silently rewritten by an
 * unrelated save. Populating those records is a migration, deliberately
 * separate from this invariant. For the same reason neither field is marked
 * `required`: that would refuse to save a legacy document for an unrelated
 * edit.
 *
 * They share a hook rather than getting one each because two hooks on the same
 * event would leave their relative order implicit, and a later reader would
 * have no way to tell whether that order mattered. It does not — the two are
 * independent — and keeping them in one function is how that stays visible.
 */
workOrderSchema.pre("validate", function assignNewWorkOrderInvariants(next) {
  if (!this.isNew) {
    /* The Sales-line link is part of the order's creation, not an edit: an
       existing order may neither gain one (that would be a backfill nobody
       proved) nor change or lose the one it was created with. */
    if (this.isModified("salesLineLink")) {
      this.invalidate("salesLineLink",
        "A work order's Sales line link is set when it is created and cannot be added or changed afterwards.");
    }
    return next();
  }

  /* A new order's link must describe the order it sits on — for a return,
     its own return request, never the original. */
  if (this.salesLineLink
    && String(this.salesLineLink.customerRequestId) !== String(this.customerRequestId)) {
    this.invalidate("salesLineLink.customerRequestId",
      "The Sales line link names a different customer request from this work order's.");
  }

  if (!String(this.workOrderNumber ?? "").trim()) {
    this.workOrderNumber = canonicalWorkOrderNumber(this._id);
  }

  // Only when the caller supplied nothing. An explicit value — including an
  // invalid one — is left alone so schema validation still rejects it rather
  // than having it quietly replaced with a valid-looking default.
  if (this.planningState === undefined || this.planningState === null) {
    this.planningState = PLANNING_STATE_NOT_STARTED;
  }

  next();
});

module.exports = mongoose.model("WorkOrder", workOrderSchema);