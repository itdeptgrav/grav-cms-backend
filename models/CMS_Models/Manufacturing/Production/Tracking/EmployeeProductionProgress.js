// models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress.js

const mongoose = require("mongoose");

const dispatchRecordSchema = new mongoose.Schema(
  {
    dispatchedAt:  { type: Date, default: Date.now },
    dispatchedBy:  { type: String }, // employee name / id who created dispatch
    notes:         { type: String, trim: true },
  },
  { _id: true }
);

const employeeProductionProgressSchema = new mongoose.Schema(
  {
    // ── Context ──────────────────────────────────────────────────────────────
    measurementId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Measurement",
      required: true,
    },
    manufacturingOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CustomerRequest",
      required: true,
      index: true,
    },
    workOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WorkOrder",
      required: true,
    },

    // ── Employee (denormalised for fast reads) ────────────────────────────
    employeeId:   { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeMpc", required: true },
    employeeName: { type: String, required: true },
    employeeUIN:  { type: String, required: true },
    gender:       { type: String },

    // ── Unit assignment ───────────────────────────────────────────────────
    unitStart:  { type: Number, required: true },
    unitEnd:    { type: Number, required: true },
    totalUnits: { type: Number, required: true },

    // ── Progress (updated by cron) ────────────────────────────────────────
    completedUnits:       { type: Number, default: 0 },
    completedUnitNumbers: [{ type: Number }],
    completionPercentage: { type: Number, default: 0, min: 0, max: 100 },

    lastSyncedAt: { type: Date, default: null },

    // ── Dispatch tracking ─────────────────────────────────────────────────
    // dispatched = true means all units for this employee have been dispatched
    isDispatched:   { type: Boolean, default: false },
    dispatchedAt:   { type: Date, default: null },
    dispatchedBy:   { type: String, default: null },
    dispatchNotes:  { type: String, trim: true, default: null },
    dispatchHistory: [dispatchRecordSchema],  // full audit trail
  },
  { timestamps: true }
);

employeeProductionProgressSchema.index({ workOrderId: 1, employeeId: 1 }, { unique: true });
employeeProductionProgressSchema.index({ manufacturingOrderId: 1, employeeName: 1 });
employeeProductionProgressSchema.index({ manufacturingOrderId: 1, employeeUIN: 1 });
employeeProductionProgressSchema.index({ manufacturingOrderId: 1, isDispatched: 1 });

module.exports = mongoose.model("EmployeeProductionProgress", employeeProductionProgressSchema);