// models/CMS_Models/Manufacturing/QC/DefectRecord.js

const mongoose = require("mongoose");

const defectOperatorSchema = new mongoose.Schema(
  {
    operatorId:   { type: String, default: "" },
    operatorName: { type: String, default: "" },
  },
  { _id: false }
);

const defectEntrySchema = new mongoose.Schema(
  {
    operationCode: { type: String, required: true, trim: true },
    operationName: { type: String, default: "",   trim: true },
    operators:     { type: [defectOperatorSchema], default: [] },
  },
  { _id: false }
);

const defectRecordSchema = new mongoose.Schema(
  {
    // ── Piece identification ────────────────────────────────────────────────
    date:             { type: String, index: true },          // "YYYY-MM-DD" IST
    barcodeId:        { type: String, index: true },          // full barcode e.g. WO-abc123-005
    workOrderShortId: { type: String },                       // abc123
    workOrderId:      { type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder",       default: null },
    moRequestId:      { type: String },
    manufacturingOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerRequest", default: null },

    // ── Inspection result ───────────────────────────────────────────────────
    status:  { type: String, enum: ["passed", "defective"], required: true },
    defects: { type: [defectEntrySchema], default: [] },

    // ── QC person who performed the inspection ──────────────────────────────
    inspectedByQCName:        { type: String, default: "QC" },
    inspectedByBiometricId:   { type: String, default: "" },  // from employee ID card scan
    inspectedByQCId:          { type: String, default: "" },  // legacy / session id fallback

    inspectedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

// ── Indexes ──────────────────────────────────────────────────────────────────
defectRecordSchema.index({ barcodeId: 1, inspectedAt: -1 });
defectRecordSchema.index({ date: 1, status: 1 });
defectRecordSchema.index({ workOrderId: 1 });
defectRecordSchema.index({ manufacturingOrderId: 1 });
defectRecordSchema.index({ inspectedByBiometricId: 1 });   // query by QC person

module.exports = mongoose.model("QCInspection", defectRecordSchema);