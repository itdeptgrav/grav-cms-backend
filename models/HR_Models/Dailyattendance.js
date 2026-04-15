/**
 * Dailyattendance.js — v6 (day-based)
 * ONE document per DATE, embedding all employees for that day.
 */

"use strict";
const mongoose = require("mongoose");

const STATUS_ENUM = ["P", "P*", "P~", "HD", "AB", "WO", "PH", "L-CL", "L-SL", "L-EL", "LWP", "MP", "WFH", "CO"];

// ── Raw punch ───────────────────────────────────────────────────────────────
const rawPunchSchema = new mongoose.Schema({
    seq: Number,
    time: Date,
    mcid: { type: Number, default: null },
    mFlag: { type: String, default: null },
    punchType: {
        type: String,
        enum: ["in", "lunch_out", "lunch_in", "tea_out", "tea_in", "out", "unknown"],
        default: "unknown",
    },
    source: { type: String, enum: ["device", "manual", "miss_punch"], default: "device" },
}, { _id: false });

// ── Employee day entry (embedded) ───────────────────────────────────────────
const employeeEntrySchema = new mongoose.Schema({
    employeeDbId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    biometricId: { type: String, required: true },
    numericId: Number,
    identityId: { type: String, default: "" },
    employeeName: { type: String, default: "" },
    department: { type: String, default: "—" },
    designation: { type: String, default: "—" },
    employeeType: { type: String, enum: ["operator", "executive"], default: "operator" },

    rawPunches: [rawPunchSchema],
    punchCount: { type: Number, default: 0 },

    inTime: Date, lunchOut: Date, lunchIn: Date, teaOut: Date, teaIn: Date, finalOut: Date,

    totalSpanMins: { type: Number, default: 0 },
    lunchBreakMins: { type: Number, default: 0 },
    teaBreakMins: { type: Number, default: 0 },
    totalBreakMins: { type: Number, default: 0 },
    netWorkMins: { type: Number, default: 0 },
    otMins: { type: Number, default: 0 },

    isLate: { type: Boolean, default: false },
    lateMins: { type: Number, default: 0 },
    isEarlyDeparture: { type: Boolean, default: false },
    earlyDepartureMins: { type: Number, default: 0 },
    hasOT: { type: Boolean, default: false },
    hasMissPunch: { type: Boolean, default: false },

    systemPrediction: { type: String, enum: STATUS_ENUM, default: "AB" },
    hrFinalStatus: { type: String, enum: STATUS_ENUM, default: null },
    hrRemarks: { type: String, default: null },

    shiftStart: { type: String, default: "09:00" },
    shiftEnd: { type: String, default: "18:30" },
}, { _id: false });

// ── Main day schema ─────────────────────────────────────────────────────────
const dailyAttendanceSchema = new mongoose.Schema({
    dateStr: { type: String, required: true, unique: true, index: true }, // "YYYY-MM-DD"
    date: { type: Date, required: true },
    yearMonth: { type: String, required: true, index: true },               // "YYYY-MM"
    dayOfWeek: Number,

    employees: [employeeEntrySchema],

    summary: {
        total: { type: Number, default: 0 },
        P: { type: Number, default: 0 },
        "P*": { type: Number, default: 0 },
        "P~": { type: Number, default: 0 },
        HD: { type: Number, default: 0 },
        AB: { type: Number, default: 0 },
        MP: { type: Number, default: 0 },
        WO: { type: Number, default: 0 },
        PH: { type: Number, default: 0 },
        presentCount: { type: Number, default: 0 },
        totalLateMins: { type: Number, default: 0 },
        totalOtMins: { type: Number, default: 0 },
    },

    unmatchedPunches: [{
        _id: false,
        empcode: String,
        name: String,
        count: Number,
        lastPunch: String,
    }],

    syncedAt: { type: Date, default: Date.now },
    syncSource: { type: String, default: "etimeoffice" },
    syncCount: { type: Number, default: 0 },

    hrFinalised: { type: Boolean, default: false },
    finalisedAt: Date,
    finalisedBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
}, { timestamps: true });

dailyAttendanceSchema.index({ yearMonth: 1, dateStr: 1 });
dailyAttendanceSchema.index({ "employees.biometricId": 1 });
dailyAttendanceSchema.index({ "employees.numericId": 1 });
dailyAttendanceSchema.index({ "employees.employeeDbId": 1 });

module.exports = mongoose.model("DailyAttendance", dailyAttendanceSchema);