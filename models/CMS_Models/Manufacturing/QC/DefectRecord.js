const mongoose = require("mongoose");

// Embedded — one entry per defective operation in an inspection.
const DefectEntrySchema = new mongoose.Schema({
  operationCode: { type: String, required: true },
  operationName: { type: String },
  // Informational — who performed this op (if scan data exists)
  operators: [{
    operatorId:   { type: String },
    operatorName: { type: String },
    _id: false,
  }],
}, { _id: false });

// One doc per QC inspection action. Re-inspections create new docs.
const QCInspectionSchema = new mongoose.Schema({
  date: { type: String, required: true, index: true }, // YYYY-MM-DD (IST)

  barcodeId:        { type: String, required: true, index: true },
  workOrderShortId: { type: String, required: true },
  workOrderId:      { type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder" },

  moRequestId:          { type: String },
  manufacturingOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerRequest" },

  status:  { type: String, enum: ["passed", "defective"], required: true },
  defects: [DefectEntrySchema], // empty when status === "passed"

  inspectedByQCName: { type: String },
  inspectedByQCId:   { type: String },
  inspectedAt:       { type: Date, default: Date.now, index: true },
}, { timestamps: false });

QCInspectionSchema.index({ barcodeId: 1, inspectedAt: -1 });
QCInspectionSchema.index({ date: 1, status: 1 });
QCInspectionSchema.index({ "defects.operationCode": 1 });

module.exports = mongoose.model("QCInspection", QCInspectionSchema);