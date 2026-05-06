"use strict";
const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
//  OVERTIME REPORT — Employee submits when they stay past work hours
//  HOD approves → grace time applied to NEXT day's attendance
// ─────────────────────────────────────────────────────────────────────────────
//
//  Grace Policy:
//    Punch out up to 7:30 PM   → No grace      → Expected 9:30 AM next day
//    7:30 PM – 8:30 PM         → +15 min grace  → Expected 9:45 AM next day
//    8:30 PM – 10:00 PM        → +30 min grace  → Expected 10:00 AM next day
//    After 10:00 PM            → +60 min (max)   → Expected 10:30 AM next day
// ─────────────────────────────────────────────────────────────────────────────

const overtimeReportSchema = new mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
      index: true,
    },
    biometricId: { type: String, index: true },
    employeeName: { type: String },
    designation: { type: String },
    department: { type: String },

    // The date they stayed late
    dateStr: { type: String, required: true }, // "2026-05-05"
    // The NEXT working day that gets the grace
    nextDateStr: { type: String }, // "2026-05-06"

    // Punch data
    scheduledOutTime: { type: String }, // "18:30" (6:30 PM)
    actualOutTime: { type: String, required: true }, // "21:45" (9:45 PM)
    actualOutDate: { type: Date }, // Full Date object
    stayOverMins: { type: Number, default: 0 }, // Minutes past scheduled out

    // Grace calculation
    graceMinutes: { type: Number, default: 0 }, // 0, 15, 30, or 60
    adjustedReportTime: { type: String }, // "09:45", "10:00", "10:30"

    // Employee submission
    description: { type: String, required: true }, // What they did
    documentUrl: { type: String, default: null }, // Proof (image/PDF)
    documentFileId: { type: String, default: null },
    documentFileName: { type: String, default: null },
    documentUploadedAt: { type: Date, default: null },

    // Approval workflow
    status: {
      type: String,
      enum: [
        "pending",
        "manager_approved",
        "manager_rejected",
        "hr_approved",
        "hr_rejected",
        "expired",
      ],
      default: "pending",
      index: true,
    },

    managersNotified: [
      {
        managerId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
        managerName: { type: String },
        type: { type: String, enum: ["primary", "secondary"] },
      },
    ],

    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    approvedByName: { type: String },
    approvedAt: { type: Date },
    approvalRemarks: { type: String },

    rejectedBy: { type: mongoose.Schema.Types.ObjectId },
    rejectedAt: { type: Date },
    rejectionReason: { type: String },

    // Whether grace was applied to next day's attendance
    graceApplied: { type: Boolean, default: false },
    graceAppliedAt: { type: Date },

    // Notification tracking
    notificationSentToEmployee: { type: Boolean, default: false },
    notificationSentToManager: { type: Boolean, default: false },
  },
  { timestamps: true },
);

overtimeReportSchema.index({ employeeId: 1, dateStr: 1 }, { unique: true });
overtimeReportSchema.index({ status: 1 });
overtimeReportSchema.index({ dateStr: 1 });

// ─── Static: Calculate grace from out time ───
overtimeReportSchema.statics.calculateGrace = function (outTimeStr) {
  // outTimeStr = "HH:MM" in 24h format
  if (!outTimeStr) return { graceMinutes: 0, adjustedReportTime: "09:30" };

  const [h, m] = outTimeStr.split(":").map(Number);
  const totalMins = h * 60 + m; // minutes since midnight

  // 19:30 = 7:30 PM, 20:30 = 8:30 PM, 22:00 = 10:00 PM
  const PM_730 = 19 * 60 + 30;
  const PM_830 = 20 * 60 + 30;
  const PM_1000 = 22 * 60;

  let graceMinutes = 0;
  let adjustedReportTime = "09:30";

  if (totalMins <= PM_730) {
    graceMinutes = 0;
    adjustedReportTime = "09:30";
  } else if (totalMins <= PM_830) {
    graceMinutes = 15;
    adjustedReportTime = "09:45";
  } else if (totalMins <= PM_1000) {
    graceMinutes = 30;
    adjustedReportTime = "10:00";
  } else {
    graceMinutes = 60;
    adjustedReportTime = "10:30";
  }

  return { graceMinutes, adjustedReportTime };
};

// ─── Static: Get next working day ───
overtimeReportSchema.statics.getNextWorkingDay = function (dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  let next = new Date(y, m - 1, d);
  next.setDate(next.getDate() + 1);
  // Skip Sundays
  while (next.getDay() === 0) {
    next.setDate(next.getDate() + 1);
  }
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
};

const OvertimeReport = mongoose.model("OvertimeReport", overtimeReportSchema);

module.exports = OvertimeReport;
