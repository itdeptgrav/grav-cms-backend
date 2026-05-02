const mongoose = require("mongoose");

// One doc per (barcode, operator, operation) defect mark.
const DefectRecordSchema = new mongoose.Schema({
  date: { type: String, required: true, index: true }, // YYYY-MM-DD (IST)

  barcodeId:        { type: String, required: true, index: true },
  workOrderShortId: { type: String, required: true },
  workOrderId:      { type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder" },

  moRequestId:          { type: String },
  manufacturingOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerRequest" },

  operatorId:   { type: String },
  operatorName: { type: String, required: true },

  // Single operation per record now
  operationCode: { type: String, required: true, index: true },
  operationName: { type: String }, // snapshot at mark time; routes also re-resolve from WO

  markedByQCName: { type: String },
  markedByQCId:   { type: String },

  markedAt: { type: Date, default: Date.now },
}, { timestamps: false });

DefectRecordSchema.index({ date: 1, operatorId: 1 });
DefectRecordSchema.index({ markedAt: -1 });
// Prevent the same op being marked twice for the same piece+operator
DefectRecordSchema.index(
  { barcodeId: 1, operatorId: 1, operationCode: 1 },
  { unique: true, partialFilterExpression: { operatorId: { $exists: true, $ne: null } } }
);

module.exports = mongoose.model("DefectRecord", DefectRecordSchema);