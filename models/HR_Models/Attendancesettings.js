/**
 * Attendancesettings.js (v2)
 * Singleton attendance config + Shift collection.
 * Added:
 *  - otGracePeriodMins (grace after shiftEnd before OT counts)
 *  - Holiday categories: "national" | "company" | "optional"
 *  - Full break type config (lunch + tea)
 */

const mongoose = require("mongoose");

// ── Shift ─────────────────────────────────────────────────────────────────────
const shiftSchema = new mongoose.Schema(
    {
        name: { type: String, required: true },
        code: { type: String, required: true, uppercase: true, trim: true, maxlength: 6 },
        startTime: { type: String, default: "09:00" },
        endTime: { type: String, default: "18:30" },
        breakMins: { type: Number, default: 60 },           // total standard break
        lunchMins: { type: Number, default: 45 },           // lunch portion
        teaMins: { type: Number, default: 15 },             // tea portion
        workingDays: { type: [Number], default: [1, 2, 3, 4, 5, 6] },
        color: { type: String, default: "#8b5cf6" },
        isDefault: { type: Boolean, default: false },
        otGracePeriodMins: { type: Number, default: 30 },   // grace before OT
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
        isRecurring: { type: Boolean, default: false },     // repeat every year
    },
    { _id: true }
);

// ── AttendanceSettings (singleton) ───────────────────────────────────────────
const settingsSchema = new mongoose.Schema(
    {
        // Default shift times (when employee has no shift assigned)
        shiftStart: { type: String, default: "09:00" },
        shiftEnd: { type: String, default: "18:30" },

        // Thresholds
        lateThresholdMinutes: { type: Number, default: 15 },
        halfDayThresholdMinutes: { type: Number, default: 270 },  // 4.5 hrs net work = full day
        earlyDepartureThresholdMinutes: { type: Number, default: 30 },
        otGracePeriodMins: { type: Number, default: 30 },         // minutes after shiftEnd before OT starts

        // Working days (0=Sun, 6=Sat)
        workingDays: { type: [Number], default: [1, 2, 3, 4, 5, 6] },

        // Break config
        lunchBreakMins: { type: Number, default: 45 },
        teaBreakMins: { type: Number, default: 15 },

        // Overtime
        overtimeEnabled: { type: Boolean, default: true },
        overtimeMinimumMinutes: { type: Number, default: 30 },
        overtimeMaxPerDay: { type: Number, default: 240 },
        overtimeRateMultiplier: { type: Number, default: 1.5 },

        // Biometric
        biometricSyncIntervalMinutes: { type: Number, default: 30 },
        biometricAutoSync: { type: Boolean, default: false },      // no cron — on-demand only

        // Holidays
        holidays: { type: [holidaySchema], default: [] },

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