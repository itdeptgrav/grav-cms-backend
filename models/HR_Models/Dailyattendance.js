/**
 * DailyAttendance.js  –  v4  (GRAV Clothing)
 *
 * One document per employee per calendar day.
 *
 * Punch sequence (per HR spec):
 *   punch1  → In Time        (mcid=1)
 *   punch2  → Lunch Out      (mcid=3)
 *   punch3  → Lunch In       (mcid=4)
 *   punch4  → Tea Break Out  (mcid=5)
 *   punch5  → Tea Break In   (mcid=6)
 *   punch6  → Final Out      (mcid=2)
 *
 * Status codes:
 *   P   – Present (on time)
 *   P*  – Present (late arrival)
 *   P~  – Present (early departure)
 *   HD  – Half Day
 *   AB  – Absent
 *   WO  – Weekly Off
 *   PH  – Public / Company Holiday
 *   L   – On Approved Leave
 *   MP  – Present but has Missing Punches (has check-in, no check-out)
 *   WFH – Work From Home
 */

"use strict";

const mongoose = require("mongoose");

// ── Raw punch (as received from biometric device) ────────────────────────────
const rawPunchSchema = new mongoose.Schema(
    {
        seq: { type: Number },                        // 1–6
        time: { type: Date },
        mcid: { type: Number, default: null },         // eTimeOffice machine direction ID
        mFlag: { type: String, default: null },
        punchType: {
            type: String,
            enum: ["in", "lunch_out", "lunch_in", "tea_out", "tea_in", "out", "unknown"],
            default: "unknown",
        },
        source: { type: String, enum: ["device", "manual", "miss_punch"], default: "device" },
    },
    { _id: false }
);

// ── Miss punch request ────────────────────────────────────────────────────────
const missPunchRequestSchema = new mongoose.Schema(
    {
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
    },
    { _id: true }
);

// ── Main daily attendance schema ──────────────────────────────────────────────
const dailyAttendanceSchema = new mongoose.Schema(
    {
        // ── Identity ───────────────────────────────────────────────────────────────
        biometricId: { type: String, required: true, index: true },
        employeeDbId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", index: true },
        employeeName: { type: String, default: "" },
        department: { type: String, default: "—" },
        designation: { type: String, default: "—" },

        // ── Date ───────────────────────────────────────────────────────────────────
        date: { type: Date, required: true },
        dateStr: { type: String, required: true, index: true }, // "YYYY-MM-DD"
        yearMonth: { type: String, required: true, index: true }, // "YYYY-MM"

        // ── Shift snapshot ─────────────────────────────────────────────────────────
        shiftName: { type: String, default: "GEN" },
        shiftStart: { type: String, default: "09:00" },
        shiftEnd: { type: String, default: "18:30" },

        // ── Raw punches ────────────────────────────────────────────────────────────
        rawPunches: { type: [rawPunchSchema], default: [] },
        punchCount: { type: Number, default: 0 },

        // ── Named punch times ──────────────────────────────────────────────────────
        inTime: { type: Date, default: null },  // punch 1
        lunchOut: { type: Date, default: null },  // punch 2
        lunchIn: { type: Date, default: null },  // punch 3
        teaOut: { type: Date, default: null },  // punch 4
        teaIn: { type: Date, default: null },  // punch 5
        finalOut: { type: Date, default: null },  // punch 6

        // ── Computed durations (minutes) ───────────────────────────────────────────
        totalSpanMins: { type: Number, default: 0 },  // finalOut − inTime
        lunchBreakMins: { type: Number, default: 0 },
        teaBreakMins: { type: Number, default: 0 },
        totalBreakMins: { type: Number, default: 0 },
        netWorkMins: { type: Number, default: 0 },  // totalSpan − totalBreak
        otMins: { type: Number, default: 0 },  // after shiftEnd + grace

        // ── Flags ──────────────────────────────────────────────────────────────────
        lateMins: { type: Number, default: 0 },
        earlyDepartureMins: { type: Number, default: 0 },
        isLate: { type: Boolean, default: false },
        isEarlyDeparture: { type: Boolean, default: false },
        hasOT: { type: Boolean, default: false },
        hasMissPunch: { type: Boolean, default: false },

        // ── Status ─────────────────────────────────────────────────────────────────
        status: {
            type: String,
            enum: ["P", "P*", "P~", "HD", "AB", "WO", "PH", "L", "MP", "WFH"],
            default: "AB",
        },

        // ── Miss punch requests ────────────────────────────────────────────────────
        missPunchRequests: { type: [missPunchRequestSchema], default: [] },

        // ── Holiday / Leave ────────────────────────────────────────────────────────
        isWeeklyOff: { type: Boolean, default: false },
        isHoliday: { type: Boolean, default: false },
        holidayName: { type: String, default: null },
        holidayType: { type: String, enum: ["national", "company", "optional", "restricted", null], default: null },
        isOnLeave: { type: Boolean, default: false },
        leaveType: { type: String, default: null },
        leaveApplicationId: { type: mongoose.Schema.Types.ObjectId, ref: "LeaveApplication" },

        // ── eTimeOffice raw fields ─────────────────────────────────────────────────
        etimeRemark: { type: String, default: "" },  // "MIS-LT", "P/2", etc.
        etimeStatus: { type: String, default: "" },  // raw status from API

        // ── Sync metadata ──────────────────────────────────────────────────────────
        syncedAt: { type: Date, default: Date.now },
        syncSource: { type: String, default: "api" }, // "api" | "manual"
    },
    { timestamps: true }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
dailyAttendanceSchema.index({ biometricId: 1, dateStr: 1 }, { unique: true });
dailyAttendanceSchema.index({ yearMonth: 1, biometricId: 1 });
dailyAttendanceSchema.index({ dateStr: 1, department: 1 });
dailyAttendanceSchema.index({ employeeDbId: 1, yearMonth: 1 });
dailyAttendanceSchema.index({ yearMonth: 1, status: 1 });

module.exports = mongoose.model("DailyAttendance", dailyAttendanceSchema);