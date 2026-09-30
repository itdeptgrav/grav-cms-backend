// models/Customer_Models/BuyerDailyReport.js
//
// A saved copy of one of the buyer's daily reports: the Cutting Report or
// the Daily Production Report of one order for one India day, as it stood
// when the day ended. Written once by the nightly save in
// services/buyerReports.js and never overwritten, so the buyer reads a past
// day the same way later even if the raw scans behind it are cleaned up.

const mongoose = require("mongoose");

const buyerDailyReportSchema = new mongoose.Schema(
  {
    customerRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CustomerRequest",
      required: true,
    },
    // The India day it covers, "YYYY-MM-DD" (Asia/Kolkata).
    day: { type: String, required: true },
    kind: { type: String, enum: ["cutting", "production"], required: true },
    // The report exactly as the buyer's route returns it.
    report: { type: mongoose.Schema.Types.Mixed, required: true },
    savedAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

// One copy per order, day and report.
buyerDailyReportSchema.index(
  { customerRequestId: 1, day: 1, kind: 1 },
  { unique: true },
);

module.exports =
  mongoose.models.BuyerDailyReport ||
  mongoose.model("BuyerDailyReport", buyerDailyReportSchema);
