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

    /* ── SCANS THAT WERE RECORDED AND SHOULD NOT HAVE BEEN ────────────────
       A completion scan against a work order with no operation route records
       progress that never happened: there was nothing for it to complete.
       The routes refuse those now, but the ones already written have to be
       cleared before the same barcodes can be scanned again — the duplicate
       check would otherwise refuse them as already recorded.

       Voided, not deleted. A row removed with no record of having existed
       cannot be asked about later, and "why is this piece unscanned" is
       exactly the question somebody will ask. */
    voidedScans: [
      {
        barcodeId: { type: String, required: true },
        scannedAt: { type: Date },
        scannedBy: { type: String, default: "" },
        voidedAt: { type: Date, default: Date.now },
        reason: { type: String, default: "" },
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model(
  "ProductionCompletionScanRecord",
  productionCompletionScanRecordSchema
);