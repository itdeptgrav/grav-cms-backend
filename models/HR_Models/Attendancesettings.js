/**
 * Attendancesettings.js (v3) — GRAV Clothing
 * ═══════════════════════════════════════════════════════════════════════════════
 * Singleton attendance configuration + Shift collection.
 *
 * v3 Changes:
 *  - executiveLateThresholdMinutes (45 mins grace for core employees)
 *  - latePenalty config (4 lates = 1 half-day deduction)
 *  - Leave entitlement defaults
 *  - Sync schedule config
 *  - Break type config (lunch + tea)
 */

const mongoose = require("mongoose");

// ── Shift ─────────────────────────────────────────────────────────────────────
const shiftSchema = new mongoose.Schema(
    {
        name: { type: String, required: true },
        code: { type: String, required: true, uppercase: true, trim: true, maxlength: 6 },
        startTime: { type: String, default: "09:00" },
        endTime: { type: String, default: "18:30" },
        breakMins: { type: Number, default: 60 },
        lunchMins: { type: Number, default: 45 },
        teaMins: { type: Number, default: 15 },
        workingDays: { type: [Number], default: [1, 2, 3, 4, 5, 6] },  // Mon-Sat
        color: { type: String, default: "#8b5cf6" },
        isDefault: { type: Boolean, default: false },
        otGracePeriodMins: { type: Number, default: 30 },
    },
    { timestamps: true }
);

// ── Holiday ───────────────────────────────────────────────────────────────────
const holidaySchema = new mongoose.Schema(
    {
        name: { type: String, required: true },
        date: { type: String, required: true },             // "YYYY-MM-DD"
        type: {
            type: String,
            enum: ["national", "company", "optional", "restricted"],
            default: "company",
        },
        description: { type: String },
        isRecurring: { type: Boolean, default: false },
    },
    { _id: true }
);

// ── AttendanceSettings (singleton) ───────────────────────────────────────────
const settingsSchema = new mongoose.Schema(
    {
        // ── Default shift times ──────────────────────────────────────────
        shiftStart: { type: String, default: "09:00" },
        shiftEnd: { type: String, default: "18:30" },

        // ── Late thresholds ──────────────────────────────────────────────
        // Operators (production): late if arrival > shiftStart + this
        lateThresholdMinutes: { type: Number, default: 15 },
        // Executives (core/office): late if arrival > shiftStart + this
        executiveLateThresholdMinutes: { type: Number, default: 45 },

        // ── Half-day threshold ───────────────────────────────────────────
        // Net work < this → marked as half day
        halfDayThresholdMinutes: { type: Number, default: 270 },  // 4.5 hrs

        // ── Early departure ──────────────────────────────────────────────
        earlyDepartureThresholdMinutes: { type: Number, default: 30 },

        // ── OT grace ─────────────────────────────────────────────────────
        // Minutes after shiftEnd before OT starts counting
        otGracePeriodMins: { type: Number, default: 30 },

        // ── Working days (0=Sun, 6=Sat) ──────────────────────────────────
        workingDays: { type: [Number], default: [1, 2, 3, 4, 5, 6] },

        // ── Break config ─────────────────────────────────────────────────
        lunchBreakMins: { type: Number, default: 45 },
        teaBreakMins: { type: Number, default: 15 },

        // ── Overtime ─────────────────────────────────────────────────────
        overtimeEnabled: { type: Boolean, default: true },
        overtimeMinimumMinutes: { type: Number, default: 30 },
        overtimeMaxPerDay: { type: Number, default: 240 },       // 4 hrs max
        overtimeRateMultiplier: { type: Number, default: 1.5 },
        // OT only for operators — this is enforced in AttendanceEngine, not here

        // ── Late penalty rule ────────────────────────────────────────────
        // "4 lates in a month = 1 half-day deduction"
        latePenalty: {
            enabled: { type: Boolean, default: true },
            lateCountThreshold: { type: Number, default: 4 },     // every N lates...
            penaltyType: { type: String, enum: ["half_day", "full_day", "lwp"], default: "half_day" },
            // penaltyValue: 0.5 for half_day, 1 for full_day
        },

        // ── Leave defaults ───────────────────────────────────────────────
        leaveEntitlements: {
            CL: { type: Number, default: 12 },   // Casual Leave per year
            SL: { type: Number, default: 12 },   // Sick Leave per year
            EL: { type: Number, default: 15 },   // Earned Leave per year
        },

        // ── Biometric sync ───────────────────────────────────────────────
        biometricSyncIntervalMinutes: { type: Number, default: 30 },
        biometricAutoSync: { type: Boolean, default: true },

        // ── Holidays ─────────────────────────────────────────────────────
        holidays: { type: [holidaySchema], default: [] },

        // ── Audit ────────────────────────────────────────────────────────
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
    },
    { timestamps: true }
);

settingsSchema.statics.getSingleton = async function () {
    let s = await this.findOne();
    if (!s) s = await this.create({});
    return s;
};

const AttendanceSettings = mongoose.model("AttendanceSettings", settingsSchema);
const Shift = mongoose.model("Shift", shiftSchema);

module.exports = { AttendanceSettings, Shift };