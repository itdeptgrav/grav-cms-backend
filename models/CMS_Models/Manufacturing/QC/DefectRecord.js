const mongoose = require("mongoose");

// One doc per defect mark. Kept minimal as per spec — only
// MO, WO, scanned barcode, operator, the operations they did,
// plus a date string for fast date-range queries.
const DefectRecordSchema = new mongoose.Schema({
  date: { type: String, required: true, index: true }, // YYYY-MM-DD (IST)

  barcodeId:        { type: String, required: true, index: true },
  workOrderShortId: { type: String, required: true },
  workOrderId:      { type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder" },

  moRequestId:          { type: String }, // CustomerRequest.requestId
  manufacturingOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerRequest" },

  operatorId:   { type: String },
  operatorName: { type: String, required: true },
  operations:   [{ type: String }], // operation codes only — names are looked up

  markedByQCName: { type: String },
  markedByQCId:   { type: String },

  markedAt: { type: Date, default: Date.now },
}, { timestamps: false });

DefectRecordSchema.index({ date: 1, operatorId: 1 });
DefectRecordSchema.index({ markedAt: -1 });

module.exports = mongoose.model("DefectRecord", DefectRecordSchema);