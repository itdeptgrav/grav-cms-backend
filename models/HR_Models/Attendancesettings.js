"use strict";
const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
//  ATTENDANCE SETTINGS — singleton document, HR-configurable
// ─────────────────────────────────────────────────────────────────────────────

const shiftSchema = new mongoose.Schema(
    {
        start: { type: String, default: "09:00" },            // "HH:MM"
        end: { type: String, default: "18:00" },
        lateGraceMins: { type: Number, default: 10 },
        halfDayThresholdMins: { type: Number, default: 240 },
        otGraceMins: { type: Number, default: 15 },
    },
    { _id: false }
);

const attendanceSettingsSchema = new mongoose.Schema(
    {
        _id: { type: String, default: "singleton" },

        // Shift config
        shifts: {
            operator: { type: shiftSchema, default: () => ({}) },
            executive: { type: shiftSchema, default: () => ({ start: "09:30", end: "18:30", lateGraceMins: 15, otGraceMins: 30 }) },
        },

        // Late → half-day policy (cumulative)
        lateHalfDayPolicy: {
            enabled: { type: Boolean, default: true },
            cumulativeLateMinsThreshold: {
                operator: { type: Number, default: 30 },
                executive: { type: Number, default: 40 },
            },
        },

        // Department classification (legacy field kept for compat)
        operatorDepartments: [{ type: String }],

        // Department categories (new canonical field)
        departmentCategories: {
            core: [{ type: String }],     // operator-type departments (production, cutting, etc.)
            general: [{ type: String }],  // executive-type departments (HR, design, etc.)
        },

        // Designation-based classification
        operatorDesignations: [{ type: String }],
        executiveDesignations: [{ type: String }],

        // Single punch handling
        singlePunchHandling: {
            mode: {
                type: String,
                enum: ["midpoint", "assume-in", "assume-out"],
                default: "midpoint",
            },
        },

        // ═══════════════════════════════════════════════════════════════════
        //  NEW (Phase 1): Grace Carry-Forward
        // ═══════════════════════════════════════════════════════════════════
        //  If an employee worked extra past end-of-shift yesterday, they get
        //  bonus lateGrace added to today's grace window.
        //  Formula:
        //    if yesterday.otMins >= triggerMins → today's effective grace =
        //        shift.lateGraceMins + bonusGraceMins
        //  Both numbers configurable from Settings page.
        graceCarryForward: {
            enabled: { type: Boolean, default: true },
            triggerMins: { type: Number, default: 60 },     // extra OT yesterday ≥ this
            bonusGraceMins: { type: Number, default: 15 },  // extra grace for today
            applyTo: {
                type: String,
                enum: ["operator", "executive", "both"],
                default: "both",
            },
        },

        // ═══════════════════════════════════════════════════════════════════
        //  NEW (Phase 1): Display labels — DB stores P*/P~ forever, UI/Excel
        //  translate to friendlier codes. Configurable here so anyone can
        //  localize or change later.
        // ═══════════════════════════════════════════════════════════════════
        displayLabels: {
            P: { type: String, default: "P" },
            "P*": { type: String, default: "L" },  // was "P*" → now Late
            "P~": { type: String, default: "EO" },  // was "P~" → now Early Out
            HD: { type: String, default: "HD" },
            MP: { type: String, default: "MP" },
            AB: { type: String, default: "A" },
            LWP: { type: String, default: "LWP" },
            WO: { type: String, default: "WO" },
            PH: { type: String, default: "PH" },  // generic holiday fallback
            FH: { type: String, default: "FH" },  // festival/company
            NH: { type: String, default: "NH" },  // national
            OH: { type: String, default: "OH" },  // optional
            RH: { type: String, default: "RH" },  // restricted
            "L-CL": { type: String, default: "CL" },
            "L-SL": { type: String, default: "SL" },
            "L-EL": { type: String, default: "EL" },
            WFH: { type: String, default: "WFH" },
            CO: { type: String, default: "CO" },
        },
    },
    { timestamps: true }
);

// Always fetch or create the singleton
attendanceSettingsSchema.statics.getConfig = async function () {
    let cfg = await this.findOne({ _id: "singleton" });
    if (!cfg) cfg = await this.create({ _id: "singleton" });
    return cfg;
};

module.exports = mongoose.model("AttendanceSettings", attendanceSettingsSchema);