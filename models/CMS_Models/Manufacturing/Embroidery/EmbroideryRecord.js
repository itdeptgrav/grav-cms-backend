// models/CMS_Models/Manufacturing/Embroidery/EmbroideryRecord.js
//
// One document = one piece whose embroidery is finished.
//
// If a row exists for a barcode, that piece is done. If it doesn't, it isn't.
// There is no status field, because there is only one status.
//
// barcodeId is UNIQUE — the database itself refuses a duplicate scan, so a
// double-tap on the scanner can never inflate the day's count.

const mongoose = require("mongoose");

const EmbroideryRecordSchema = new mongoose.Schema({
  // IST calendar day, "YYYY-MM-DD". Stored as a string so day-grouping is a
  // plain equality match instead of a timezone-sensitive date range.
  date: { type: String, required: true, index: true },

  // ── The piece ──────────────────────────────────────────────────────────────
  barcodeId: { type: String, required: true, unique: true, trim: true },
  workOrderShortId: { type: String, required: true, index: true },
  unitNumber: { type: Number, required: true },

  workOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder" },

  // ── WHOSE WORK IT WAS ──────────────────────────────────────────────────────
  //
  // The company and the permanent Sales line, copied from the work order's own
  // Sales-line link at the moment of the scan — the one authoritative source
  // there is. Absent on every row written before this existed, and never
  // filled in afterwards by matching a style, a buyer, a work-order number, a
  // barcode prefix or a product name: a row that cannot prove its company
  // stays unproven, and is read through its work order's link instead.
  companyId: { type: mongoose.Schema.Types.ObjectId, index: true },
  orderLineRef: { type: String, trim: true, default: "" },
  moRequestId: { type: mongoose.Schema.Types.ObjectId },
  manufacturingOrderId: { type: String, default: "" },

  // Denormalised so the records table and CSV export never need a join.
  productName: { type: String, default: "" },
  variantLabel: { type: String, default: "" },

  // ── Who scanned it ─────────────────────────────────────────────────────────
  operatorName: { type: String, required: true },
  operatorBiometricId: { type: String, required: true, index: true },
  operatorIdentityId: { type: String, default: "" },
  // The employee record the operator was resolved from — the identity the
  // name and biometric id above were READ from, never typed into a body.
  operatorEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
  // Whether that operator's own company could be proved from membership
  // records. Employee records carry no company, so on most floors this is
  // "unproven" and says so rather than assuming one.
  operatorCompanyProof: { type: String, enum: ["membership", "unproven"], default: undefined },

  // ── AND WHO SUBMITTED IT ───────────────────────────────────────────────────
  //
  // The signed-in user or station the scan arrived from, which on a shared
  // floor terminal is not the person who did the embroidery. Both are kept:
  // one did the work, the other sent the record.
  submittedBy: {
    id: { type: mongoose.Schema.Types.ObjectId },
    name: { type: String, default: "" },
    email: { type: String, default: "" },
  },

  notes: { type: String, default: "" },

  scannedAt: { type: Date, default: Date.now, index: true },
});

// The three queries this collection actually serves.
EmbroideryRecordSchema.index({ date: -1, scannedAt: -1 });          // records list
EmbroideryRecordSchema.index({ date: 1, operatorBiometricId: 1 });  // per-operator counts
EmbroideryRecordSchema.index({ workOrderId: 1, unitNumber: 1 });    // work-order progress

module.exports = mongoose.model("EmbroideryRecord", EmbroideryRecordSchema);
