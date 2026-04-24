const mongoose = require("mongoose");

const productionCompletionScanRecordSchema = new mongoose.Schema(
  {
    // Date bucket — one doc per calendar day (IST midnight)
    date: { type: Date, required: true, unique: true, index: true },

    // Raw scan strings accumulated for this day
    scans: [
      {
        barcodeId: { type: String, required: true, trim: true },
        scannedAt: { type: Date, default: Date.now },
        scannedBy: { type: String, default: "" },
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model(
  "ProductionCompletionScanRecord",
  productionCompletionScanRecordSchema
);