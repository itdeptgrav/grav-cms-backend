// models/CMS_Models/Manufacturing/CuttingMaster/CuttingMasterRecord.js
//
// One document per cutting master per calendar day.
// Each entry records a WO cut session (units + timestamp).

const mongoose = require("mongoose");

const cuttingEntrySchema = new mongoose.Schema(
  {
    woId:          { type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder" },
    woNumber:      { type: String, default: "" },
    stockItemName: { type: String, default: "" },
    variants:      { type: String, default: "" },  // e.g. "M · Blue"
    quantityCut:   { type: Number, default: 0 },
    startUnit:     { type: Number, default: 0 },
    endUnit:       { type: Number, default: 0 },
    timestamp:     { type: Date, default: Date.now }
  },
  { _id: true }
);

const cuttingMasterRecordSchema = new mongoose.Schema(
  {
    // ── Employee info (snapshotted at record time) ────────────────────────
    employeeId:   { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true },
    employeeName: { type: String, required: true, trim: true },
    biometricId:  { type: String, default: "" },
    department:   { type: String, default: "" },
    designation:  { type: String, default: "" },

    // ── One doc per employee per day ──────────────────────────────────────
    date:  { type: String, required: true }, // "YYYY-MM-DD"

    // ── Cut sessions for this day ─────────────────────────────────────────
    entries:       [cuttingEntrySchema],
    totalUnitsCut: { type: Number, default: 0 }
  },
  { timestamps: true }
);

// Unique: one record per cutting master per calendar day
cuttingMasterRecordSchema.index({ employeeId: 1, date: 1 }, { unique: true });
cuttingMasterRecordSchema.index({ date: 1 });

module.exports =
  mongoose.models.CuttingMasterRecord ||
  mongoose.model("CuttingMasterRecord", cuttingMasterRecordSchema);