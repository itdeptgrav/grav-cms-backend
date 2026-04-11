/**
 * Attendance.js — Mongoose Model (v3)
 *
 * KEY CHANGES FROM v2:
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Raw punch storage: stores ALL raw biometric punches with timestamps.
 *    The system auto-assigns punch roles using eTimeOffice mcid/M_Flag + time logic.
 *
 * 2. Smart status logic:
 *    - 0 punches  → absent
 *    - 1+ punches → "pending_checkout" (not absent — they came in!)
 *    - End-of-day job or HR can flip pending_checkout → present / half_day etc.
 *
 * 3. 2-punch logic: NOT auto-half-day. Use mcid reason codes:
 *    mcid=1 → in_time, mcid=2 → out_time (final), mcid=3,4,5,6 → mid-punches.
 *    Two punches where P2 time is < halfDay threshold → half_day.
 *    Two punches where employee has lunch reason → just in+out (full day possible).
 *
 * 4. Single general shift only (no shift selector needed).
 *
 * 5. Holidays & weekends stored in settings, referenced here for auto-status.
 *
 * eTimeOffice mcid values:
 *   1 = In Time  (shift start)
 *   2 = Out Time (shift end / final out)
 *   3 = Break Out (Lunch Out)
 *   4 = Break In  (Lunch In)
 *   5 = OT In
 *   6 = OT Out
 *   null/other = auto-sequence assignment
 *
 * Punch Status Abbreviations (muster roll):
 *   P   = Present (on time)
 *   P*  = Present but Late
 *   P~  = Present but Early Departure
 *   HD  = Half Day
 *   AB  = Absent
 *   WO  = Weekly Off
 *   PH  = Public/Company Holiday
 *   L   = On Approved Leave
 */

"use strict";

const mongoose = require("mongoose");

// ── Raw Punch (from biometric device) ─────────────────────────────────────────
const rawPunchSchema = new mongoose.Schema(
    {
        punchTime: { type: Date, required: true },
        timeString: { type: String },                        // "09:05 AM"
        mcid: { type: Number, default: null },               // eTimeOffice machine direction ID
        mFlag: { type: String, default: null },              // M_Flag from API
        deviceId: { type: String },
        source: { type: String, enum: ["biometric", "manual", "miss_punch"], default: "biometric" },
        // After role assignment
        role: {
            type: String,
            enum: ["in_time", "lunch_out", "lunch_in", "tea_break_out", "tea_break_in", "final_out", "unassigned"],
            default: "unassigned",
        },
    },
    { _id: false }
);

// ── Miss Punch Request ─────────────────────────────────────────────────────────
const missPunchSchema = new mongoose.Schema(
    {
        requestedAt: { type: Date, default: Date.now },
        requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
        requestedPunchTime: { type: String },                // "HH:MM"
        requestedRole: {
            type: String,
            enum: ["in_time", "lunch_out", "lunch_in", "tea_break_out", "tea_break_in", "final_out"],
        },
        reason: { type: String },
        attachment: { type: String },

        managerStatus: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
        managerApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
        managerApprovedAt: { type: Date },
        managerRemarks: { type: String },

        hrStatus: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
        hrApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
        hrApprovedAt: { type: Date },
        hrRemarks: { type: String },

        settled: { type: Boolean, default: false },
        settledAt: { type: Date },
    },
    { _id: true }
);

// ── Main Attendance Schema ─────────────────────────────────────────────────────
const attendanceSchema = new mongoose.Schema(
    {
        // Employee info
        employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
        employeeName: { type: String, required: true },
        biometricId: { type: String, required: true },
        department: { type: String, default: "Unknown" },
        designation: { type: String },

        // Date
        date: { type: Date, required: true },
        dateString: { type: String, required: true },        // "YYYY-MM-DD"
        dayOfWeek: { type: Number },                         // 0=Sun … 6=Sat

        // ── Raw Punches (from biometric) ──────────────────────────────────────
        rawPunches: { type: [rawPunchSchema], default: [] },

        // ── Resolved/Named punch times (set by pre-save hook) ─────────────────
        inTime: { type: Date },
        lunchOut: { type: Date },
        lunchIn: { type: Date },
        teaBreakOut: { type: Date },
        teaBreakIn: { type: Date },
        finalOut: { type: Date },

        // Convenience aliases
        checkIn: { type: Date },
        checkOut: { type: Date },
        checkInTime: { type: String },
        checkOutTime: { type: String },

        // ── Computed Minutes ──────────────────────────────────────────────────
        lunchBreakMinutes: { type: Number, default: 0 },
        teaBreakMinutes: { type: Number, default: 0 },
        breakMinutes: { type: Number, default: 0 },
        grossWorkingMinutes: { type: Number, default: 0 },   // finalOut - inTime (minus breaks)
        netWorkingMinutes: { type: Number, default: 0 },
        effectiveMinutes: { type: Number, default: 0 },      // alias
        overtimeMinutes: { type: Number, default: 0 },

        // ── Shift Config (snapshot from settings at time of record) ───────────
        shiftName: { type: String, default: "General Shift" },
        shiftStart: { type: String, default: "09:00" },
        shiftEnd: { type: String, default: "18:30" },
        lateThresholdMinutes: { type: Number, default: 15 },
        halfDayThresholdMinutes: { type: Number, default: 270 }, // 4.5 hrs
        otGracePeriodMins: { type: Number, default: 30 },

        // ── Status ────────────────────────────────────────────────────────────
        // pending_checkout = punched in but no punch out yet (end-of-day job will resolve)
        status: {
            type: String,
            enum: [
                "present",
                "late",
                "half_day",
                "absent",
                "pending_checkout",   // has in-punch, no out yet
                "on_leave",
                "holiday",
                "weekend",
                "work_from_home",
                "early_departure",
            ],
            default: "absent",
        },

        // ── Flags ─────────────────────────────────────────────────────────────
        isLate: { type: Boolean, default: false },
        lateByMinutes: { type: Number, default: 0 },
        isEarlyDeparture: { type: Boolean, default: false },
        earlyByMinutes: { type: Number, default: 0 },
        hasOvertime: { type: Boolean, default: false },
        isHalfDay: { type: Boolean, default: false },
        isManualEntry: { type: Boolean, default: false },
        isMissPunchSettled: { type: Boolean, default: false },

        // eTimeOffice remark (e.g., "MIS-LT", "P/2")
        etimeRemark: { type: String },
        etimeStatus: { type: String },                       // raw status string from API

        // ── Miss Punch Requests ───────────────────────────────────────────────
        missPunchRequests: { type: [missPunchSchema], default: [] },

        // ── Notes ─────────────────────────────────────────────────────────────
        notes: { type: String },
        remarks: { type: String },

        // ── Audit ─────────────────────────────────────────────────────────────
        markedBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
    },
    { timestamps: true }
);

// ── Helpers ────────────────────────────────────────────────────────────────────
function hhmm(str) {
    const [h, m] = (str || "00:00").split(":").map(Number);
    return h * 60 + (isNaN(m) ? 0 : m);
}

function timeToMins(date) {
    if (!date) return null;
    return date.getHours() * 60 + date.getMinutes();
}

/**
 * Assign roles to raw punches using mcid + sequential fallback.
 *
 * eTimeOffice mcid:
 *   1 = In  (shift start)
 *   2 = Out (shift end)
 *   3 = Break Out (Lunch Out)
 *   4 = Break In  (Lunch In)
 *   5 = OT In
 *   6 = OT Out
 *   null = use sequence
 *
 * If mcid not available, assign sequentially:
 *   P1=in_time, P2=lunch_out, P3=lunch_in, P4=tea_break_out,
 *   P5=tea_break_in, P6=final_out
 *   If only 2 punches: P1=in_time, P2=final_out (not half-day by itself!)
 */
function assignPunchRoles(rawPunches) {
    if (!rawPunches || rawPunches.length === 0) return rawPunches;

    // Sort by time
    const sorted = [...rawPunches].sort((a, b) => a.punchTime - b.punchTime);

    // Check if mcid info is available and useful
    const hasMcid = sorted.some(p => p.mcid !== null && p.mcid !== undefined);

    if (hasMcid) {
        for (const p of sorted) {
            switch (p.mcid) {
                case 1: p.role = "in_time"; break;
                case 2: p.role = "final_out"; break;
                case 3: p.role = "lunch_out"; break;
                case 4: p.role = "lunch_in"; break;
                case 5: p.role = "tea_break_out"; break;
                case 6: p.role = "tea_break_in"; break;
                default: p.role = "unassigned";
            }
        }
    } else {
        // Sequential assignment based on count
        const roleSequence = ["in_time", "lunch_out", "lunch_in", "tea_break_out", "tea_break_in", "final_out"];

        if (sorted.length === 1) {
            sorted[0].role = "in_time";
        } else if (sorted.length === 2) {
            // 2 punches = IN + OUT, NOT half day on its own
            sorted[0].role = "in_time";
            sorted[1].role = "final_out";
        } else {
            // 3+ punches: sequential
            for (let i = 0; i < sorted.length && i < 6; i++) {
                sorted[i].role = roleSequence[i];
            }
        }
    }

    return sorted;
}

// ── Pre-save: compute everything from rawPunches ──────────────────────────────
attendanceSchema.pre("save", function (next) {
    const doc = this;
    const specialStatuses = ["holiday", "weekend", "on_leave", "work_from_home"];

    // Don't recalculate special statuses
    if (specialStatuses.includes(doc.status) && !doc.isModified("rawPunches")) {
        return next();
    }

    if (!doc.rawPunches || doc.rawPunches.length === 0) {
        // No punches at all — absent
        if (!specialStatuses.includes(doc.status)) {
            doc.status = "absent";
        }
        doc.inTime = null;
        doc.finalOut = null;
        doc.checkIn = null;
        doc.checkOut = null;
        doc.netWorkingMinutes = 0;
        doc.grossWorkingMinutes = 0;
        doc.effectiveMinutes = 0;
        doc.overtimeMinutes = 0;
        return next();
    }

    // Assign roles to raw punches
    doc.rawPunches = assignPunchRoles(doc.rawPunches);

    // Extract by role
    const get = (role) => doc.rawPunches.find(p => p.role === role);
    const p1 = get("in_time");
    const p2 = get("lunch_out");
    const p3 = get("lunch_in");
    const p4 = get("tea_break_out");
    const p5 = get("tea_break_in");
    const p6 = get("final_out");

    doc.inTime = p1?.punchTime || null;
    doc.lunchOut = p2?.punchTime || null;
    doc.lunchIn = p3?.punchTime || null;
    doc.teaBreakOut = p4?.punchTime || null;
    doc.teaBreakIn = p5?.punchTime || null;
    doc.finalOut = p6?.punchTime || null;

    doc.checkIn = doc.inTime;
    doc.checkOut = doc.finalOut;
    doc.checkInTime = p1?.timeString || null;
    doc.checkOutTime = p6?.timeString || null;

    // ── Break Minutes ────────────────────────────────────────────────────────
    let lunchMins = 0, teaMins = 0;
    if (p2?.punchTime && p3?.punchTime && p3.punchTime > p2.punchTime) {
        lunchMins = Math.round((p3.punchTime - p2.punchTime) / 60000);
    }
    if (p4?.punchTime && p5?.punchTime && p5.punchTime > p4.punchTime) {
        teaMins = Math.round((p5.punchTime - p4.punchTime) / 60000);
    }
    doc.lunchBreakMinutes = lunchMins;
    doc.teaBreakMinutes = teaMins;
    doc.breakMinutes = lunchMins + teaMins;

    // ── Working Minutes ──────────────────────────────────────────────────────
    if (p1?.punchTime && p6?.punchTime && p6.punchTime > p1.punchTime) {
        const gross = Math.round((p6.punchTime - p1.punchTime) / 60000);
        doc.grossWorkingMinutes = gross;
        // Net = gross minus breaks (but don't subtract more than gross)
        doc.netWorkingMinutes = Math.max(0, gross - doc.breakMinutes);
        doc.effectiveMinutes = doc.netWorkingMinutes;
    } else {
        doc.grossWorkingMinutes = 0;
        doc.netWorkingMinutes = 0;
        doc.effectiveMinutes = 0;
    }

    // ── Late Detection ───────────────────────────────────────────────────────
    if (p1?.punchTime) {
        const shiftStartMins = hhmm(doc.shiftStart || "09:00");
        const inMins = timeToMins(p1.punchTime);
        const lateBy = inMins - shiftStartMins;
        doc.isLate = lateBy > (doc.lateThresholdMinutes || 15);
        doc.lateByMinutes = doc.isLate ? lateBy : 0;
    }

    // ── OT with Grace Period ─────────────────────────────────────────────────
    if (p6?.punchTime) {
        const shiftEndMins = hhmm(doc.shiftEnd || "18:30");
        const graceMins = doc.otGracePeriodMins ?? 30;
        const outMins = timeToMins(p6.punchTime);
        const otStart = shiftEndMins + graceMins;
        doc.overtimeMinutes = Math.max(0, outMins - otStart);
        doc.hasOvertime = doc.overtimeMinutes > 0;

        // Early departure
        const earlyBy = shiftEndMins - outMins;
        doc.isEarlyDeparture = earlyBy > 30;
        doc.earlyByMinutes = doc.isEarlyDeparture ? Math.max(0, earlyBy) : 0;
    }

    // ── Status Derivation ────────────────────────────────────────────────────
    if (!specialStatuses.includes(doc.status)) {
        if (!p1) {
            // No in-punch
            doc.status = "absent";
        } else if (!p6) {
            // Has in-punch but NO out-punch → pending checkout
            // Could be mid-day or forgotten to punch out
            doc.status = "pending_checkout";
        } else {
            // Has both in and out
            const halfDayMins = doc.halfDayThresholdMinutes || 270;
            if (doc.netWorkingMinutes < halfDayMins) {
                // Check if this is truly a half-day situation
                // If eTimeOffice already marked it P/2 treat as half day
                // OR if net working < threshold
                doc.status = "half_day";
                doc.isHalfDay = true;
            } else if (doc.isEarlyDeparture) {
                doc.status = "early_departure";
            } else if (doc.isLate) {
                doc.status = "late";
            } else {
                doc.status = "present";
            }
        }
    }

    next();
});

// ── Virtual: punchCount ───────────────────────────────────────────────────────
attendanceSchema.virtual("punchCount").get(function () {
    return this.rawPunches ? this.rawPunches.length : 0;
});

// ── Virtual: musterStatus (abbreviation for muster roll) ─────────────────────
attendanceSchema.virtual("musterStatus").get(function () {
    if (this.status === "weekend") return "WO";
    if (this.status === "holiday") return "PH";
    if (this.status === "on_leave") return "L";
    if (this.status === "absent") return "AB";
    if (this.status === "half_day") return "HD";
    if (this.status === "pending_checkout") return this.isLate ? "P*" : "P";
    if (this.status === "late") return "P*";
    if (this.status === "early_departure") return "P~";
    if (this.status === "present") return "P";
    return "AB";
});

// ── Indexes ───────────────────────────────────────────────────────────────────
attendanceSchema.index({ biometricId: 1, dateString: 1 }, { unique: true });
attendanceSchema.index({ employeeId: 1, dateString: 1 });
attendanceSchema.index({ dateString: 1 });
attendanceSchema.index({ department: 1, dateString: 1 });
attendanceSchema.index({ status: 1, dateString: 1 });
attendanceSchema.index({ "missPunchRequests.hrStatus": 1 });

module.exports = mongoose.model("Attendance", attendanceSchema);