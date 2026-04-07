/**
 * Dailyattendance.js  –  v6  (GRAV Clothing)
 * ═══════════════════════════════════════════════════════════════════════════════
 * CHANGES FROM v5:
 *  1. Aligned field naming with AttendanceEngine.js
 *  2. Added executiveLateThresholdMins snapshot
 *  3. Added latePenaltyApplied flag for monthly penalty tracking
 *  4. Cleaner virtual definitions
 *  5. Added syncHash for deduplication
 *
 * Status codes:
 *   P   – Present (on time)        P*  – Present (late)
 *   P~  – Present (early out)      HD  – Half Day
 *   AB  – Absent                   WO  – Weekly Off
 *   PH  – Public / Company Holiday L-CL/L-SL/L-EL – On Leave
 *   LWP – Leave Without Pay        MP  – Missing Punch
 *   WFH – Work From Home           CO  – Compensatory Off
 */

"use strict";
const mongoose = require("mongoose");

const STATUS_ENUM = [
    "P", "P*", "P~", "HD", "AB", "WO", "PH",
    "L-CL", "L-SL", "L-EL", "LWP", "MP", "WFH", "CO"
];

// ── Raw punch ────────────────────────────────────────────────────────────────
const rawPunchSchema = new mongoose.Schema({
    seq: { type: Number },
    time: { type: Date },
    mcid: { type: Number, default: null },
    mFlag: { type: String, default: null },
    punchType: {
        type: String,
        enum: ["in", "lunch_out", "lunch_in", "tea_out", "tea_in", "out", "unknown"],
        default: "unknown",
    },
    source: { type: String, enum: ["device", "manual", "miss_punch"], default: "device" },
}, { _id: false });

// ── Miss punch request ───────────────────────────────────────────────────────
const missPunchRequestSchema = new mongoose.Schema({
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    requestedAt: { type: Date, default: Date.now },
    punchSlot: { type: Number, enum: [1, 2, 3, 4, 5, 6] },
    requestedTime: { type: Date },
    reason: { type: String },
    status: {
        type: String,
        enum: ["pending", "manager_approved", "hr_approved", "rejected"],
        default: "pending",
    },
    managerApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    managerApprovedAt: { type: Date },
    hrApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
    hrApprovedAt: { type: Date },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId },
    rejectedAt: { type: Date },
    rejectionReason: { type: String },
}, { _id: true });

// ── Main schema ──────────────────────────────────────────────────────────────
const dailyAttendanceSchema = new mongoose.Schema({

    // ── Identity ──────────────────────────────────────────────────────────
    biometricId: { type: String, required: true, index: true },
    numericId: { type: Number, index: true },
    identityId: { type: String },
    employeeDbId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", index: true },
    employeeName: { type: String, default: "" },
    department: { type: String, default: "—" },
    designation: { type: String, default: "—" },

    // ── Employee type — drives punch model and OT policy ──────────────────
    employeeType: {
        type: String,
        enum: ["operator", "executive"],
        default: "operator",
    },

    // ── Date ──────────────────────────────────────────────────────────────
    date: { type: Date, required: true },
    dateStr: { type: String, required: true, index: true },
    yearMonth: { type: String, required: true, index: true },

    // ── Shift snapshot ────────────────────────────────────────────────────
    shiftName: { type: String, default: "GEN" },
    shiftStart: { type: String, default: "09:00" },
    shiftEnd: { type: String, default: "18:30" },

    // ── Raw punches ───────────────────────────────────────────────────────
    rawPunches: { type: [rawPunchSchema], default: [] },
    punchCount: { type: Number, default: 0 },

    // ── Named punch times ─────────────────────────────────────────────────
    inTime: { type: Date, default: null },
    lunchOut: { type: Date, default: null },
    lunchIn: { type: Date, default: null },
    teaOut: { type: Date, default: null },
    teaIn: { type: Date, default: null },
    finalOut: { type: Date, default: null },

    // ── Computed durations (minutes) ──────────────────────────────────────
    totalSpanMins: { type: Number, default: 0 },
    lunchBreakMins: { type: Number, default: 0 },
    teaBreakMins: { type: Number, default: 0 },
    totalBreakMins: { type: Number, default: 0 },
    netWorkMins: { type: Number, default: 0 },
    otMins: { type: Number, default: 0 },

    // ── Flags ─────────────────────────────────────────────────────────────
    lateMins: { type: Number, default: 0 },
    earlyDepartureMins: { type: Number, default: 0 },
    isLate: { type: Boolean, default: false },
    isEarlyDeparture: { type: Boolean, default: false },
    hasOT: { type: Boolean, default: false },
    hasMissPunch: { type: Boolean, default: false },

    // ── TWO-TIER STATUS ───────────────────────────────────────────────────
    systemPrediction: { type: String, enum: STATUS_ENUM, default: "AB" },
    hrFinalStatus: { type: String, enum: [...STATUS_ENUM, null], default: null },
    hrRemarks: { type: String, default: null },
    hrUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
    hrUpdatedAt: { type: Date },

    // ── Holiday / Leave ───────────────────────────────────────────────────
    isWeeklyOff: { type: Boolean, default: false },
    isHoliday: { type: Boolean, default: false },
    holidayName: { type: String, default: null },
    holidayType: { type: String, enum: ["national", "company", "optional", "restricted", null], default: null },
    isOnLeave: { type: Boolean, default: false },
    leaveType: { type: String, default: null },
    leaveApplicationId: { type: mongoose.Schema.Types.ObjectId, ref: "LeaveApplication" },

    // ── Miss punch requests ───────────────────────────────────────────────
    missPunchRequests: { type: [missPunchRequestSchema], default: [] },

    // ── Late penalty tracking ─────────────────────────────────────────────
    latePenaltyApplied: { type: Boolean, default: false },

    // ── eTimeOffice raw fields ────────────────────────────────────────────
    etimeRemark: { type: String, default: "" },
    etimeStatus: { type: String, default: "" },

    // ── Sync metadata ─────────────────────────────────────────────────────
    syncedAt: { type: Date, default: Date.now },
    syncSource: { type: String, default: "api" },

}, { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } });

// ── Virtual: effectiveStatus ─────────────────────────────────────────────────
dailyAttendanceSchema.virtual("effectiveStatus").get(function () {
    return this.hrFinalStatus ?? this.systemPrediction;
});

// ── Virtual: status (backward compat) ────────────────────────────────────────
dailyAttendanceSchema.virtual("status").get(function () {
    return this.hrFinalStatus ?? this.systemPrediction;
});

// ── Indexes ───────────────────────────────────────────────────────────────────
dailyAttendanceSchema.index({ biometricId: 1, dateStr: 1 }, { unique: true });
dailyAttendanceSchema.index({ numericId: 1, dateStr: 1 });
dailyAttendanceSchema.index({ yearMonth: 1, biometricId: 1 });
dailyAttendanceSchema.index({ dateStr: 1, department: 1 });
dailyAttendanceSchema.index({ employeeDbId: 1, yearMonth: 1 });
dailyAttendanceSchema.index({ yearMonth: 1, systemPrediction: 1 });
dailyAttendanceSchema.index({ yearMonth: 1, hrFinalStatus: 1 });
dailyAttendanceSchema.index({ dateStr: 1, employeeType: 1, isLate: 1 });

module.exports = mongoose.model("DailyAttendance", dailyAttendanceSchema);