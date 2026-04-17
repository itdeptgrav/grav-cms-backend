/**
 * Dailyattendance.js — v7 (day-based)
 * ONE document per DATE, embedding all employees for that day.
 *
 * Changes from v6:
 *  - STATUS_ENUM extended: FH, NH, OH, RH added (used in route layer)
 *  - employeeEntrySchema: hrReviewedAt, appliedExtraGraceMins, attendanceValue,
 *    lateDisplay, missingPunchType added; rawPunch schema gets addedBy/addedAt
 *  - summary: FH, NH, OH, RH count fields + ghostCount
 *  - holiday field added to day doc (was being written but not declared)
 *  - unmatchedPunches: biometricId field added
 */

"use strict";
const mongoose = require("mongoose");

const STATUS_ENUM = [
    "P", "P*", "P~", "HD", "AB", "WO", "PH",
    "FH", "NH", "OH", "RH",
    "L-CL", "L-SL", "L-EL", "LWP", "MP", "WFH", "CO",
];

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
    addedBy: { type: String, default: null },    // HR / employee ID who added manual punch
    addedAt: { type: Date, default: null },
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
    /** Human-readable late duration e.g. "1h 30m" — computed by route layer */
    lateDisplay: { type: String, default: "" },

    isEarlyDeparture: { type: Boolean, default: false },
    earlyDepartureMins: { type: Number, default: 0 },
    hasOT: { type: Boolean, default: false },
    hasMissPunch: { type: Boolean, default: false },
    /** Which punch role was detected as missing, e.g. "lunch_in" */
    missingPunchType: { type: String, default: null },

    /** Grace carry-forward bonus applied on this day */
    appliedExtraGraceMins: { type: Number, default: 0 },

    /**
     * Payroll weight:
     *   1   = present / paid full day  (P, P*, P~, MP, WO, holiday, leave)
     *   0.5 = half day                 (HD)
     *   0   = absent / unpaid          (AB, LWP)
     */
    attendanceValue: { type: Number, default: 0 },

    systemPrediction: { type: String, enum: STATUS_ENUM, default: "AB" },
    hrFinalStatus: { type: String, enum: [...STATUS_ENUM, null], default: null },
    hrRemarks: { type: String, default: null },
    hrReviewedAt: { type: Date, default: null },

    shiftStart: { type: String, default: "09:30" },
    shiftEnd: { type: String, default: "18:30" },
    matchMethod: { type: String, default: "" },
    isGhost: { type: Boolean, default: false },
    providerName: { type: String, default: null },
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
        FH: { type: Number, default: 0 },
        NH: { type: Number, default: 0 },
        OH: { type: Number, default: 0 },
        RH: { type: Number, default: 0 },
        presentCount: { type: Number, default: 0 },
        totalLateMins: { type: Number, default: 0 },
        totalOtMins: { type: Number, default: 0 },
        ghostCount: { type: Number, default: 0 },
    },

    /** Holiday metadata for this day (if any) */
    holiday: {
        name: { type: String },
        type: { type: String },
        statusCode: { type: String },
    },

    unmatchedPunches: [{
        _id: false,
        biometricId: String,
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