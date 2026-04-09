"use strict";
/**
 * LeaveManagement.js — v2 (GRAV Clothing)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Models:
 *  1. LeaveConfig       — HR-configurable dynamic parameters (single document)
 *  2. LeaveBalance      — yearly leave entitlements & consumed per employee
 *  3. LeaveApplication  — individual leave requests (Employee → Manager → HR flow)
 *  4. CompanyHoliday    — holidays defined by HR, shown on both calendars
 *
 * Business Rules:
 *  - initialWaitingDays: employee cannot apply ANY leave before this many working days pass
 *  - CL & SL: available after waiting period; reset to quota on Jan 1 each year (no carry forward)
 *  - PL: available only after daysRequiredForPL working days; full quota granted immediately
 *        resets to 0 on Jan 1, but eligible employees get fresh quota on Jan 1
 *  - SL: if totalDays > slDocumentThreshold → frontend shows document warning
 *  - Manager routing: primary + secondary (both if both exist)
 *  - All numeric parameters are HR-configurable at runtime
 */

const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
//  1. LEAVE CONFIG  (single document — HR admin panel changes these)
// ─────────────────────────────────────────────────────────────────────────────
const leaveConfigSchema = new mongoose.Schema(
    {
        // Singleton key so only one config document ever exists
        singleton: { type: String, default: "global", unique: true },

        initialWaitingDays: { type: Number, default: 24 },      // working days after joining before any leave
        clPerYear: { type: Number, default: 5 },       // Casual Leave quota per year
        slPerYear: { type: Number, default: 5 },       // Sick Leave quota per year
        plPerYear: { type: Number, default: 18 },      // Privilege Leave quota per year
        daysRequiredForPL: { type: Number, default: 240 },     // working days from joining to earn PL
        slDocumentThreshold: { type: Number, default: 2 },       // SL days in one request before doc warning

        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
    },
    { timestamps: true }
);

// Static helper — always get (or create) the single config doc
leaveConfigSchema.statics.getConfig = async function () {
    let cfg = await this.findOne({ singleton: "global" });
    if (!cfg) cfg = await this.create({ singleton: "global" });
    return cfg;
};

const LeaveConfig = mongoose.model("LeaveConfig", leaveConfigSchema);


// ─────────────────────────────────────────────────────────────────────────────
//  2. LEAVE BALANCE  (per employee per year)
// ─────────────────────────────────────────────────────────────────────────────
const leaveBalanceSchema = new mongoose.Schema(
    {
        employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true, index: true },
        biometricId: { type: String, index: true },
        year: { type: Number, required: true },

        // Entitlements (how many days were granted this year)
        entitlement: {
            CL: { type: Number, default: 0 },
            SL: { type: Number, default: 0 },
            PL: { type: Number, default: 0 },
        },

        // Consumed (approved leaves deducted here)
        consumed: {
            CL: { type: Number, default: 0 },
            SL: { type: Number, default: 0 },
            PL: { type: Number, default: 0 },
        },

        // Flags
        plEligible: { type: Boolean, default: false },  // true once daysRequiredForPL is complete
        plGrantedDate: { type: Date },                     // date PL was first granted

        lastUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
    },
    { timestamps: true }
);

// Virtual: available days per type
leaveBalanceSchema.virtual("available").get(function () {
    return {
        CL: Math.max(0, (this.entitlement.CL || 0) - (this.consumed.CL || 0)),
        SL: Math.max(0, (this.entitlement.SL || 0) - (this.consumed.SL || 0)),
        PL: Math.max(0, (this.entitlement.PL || 0) - (this.consumed.PL || 0)),
    };
});

leaveBalanceSchema.set("toJSON", { virtuals: true });
leaveBalanceSchema.set("toObject", { virtuals: true });

leaveBalanceSchema.index({ employeeId: 1, year: 1 }, { unique: true });

// Static: get or create balance record for employee+year
leaveBalanceSchema.statics.getOrCreate = async function (employeeId, year, biometricId) {
    let bal = await this.findOne({ employeeId, year });
    if (!bal) {
        bal = await this.create({ employeeId, year, biometricId });
    }
    return bal;
};

const LeaveBalance = mongoose.model("LeaveBalance", leaveBalanceSchema);


// ─────────────────────────────────────────────────────────────────────────────
//  3. LEAVE APPLICATION
// ─────────────────────────────────────────────────────────────────────────────
const leaveApplicationSchema = new mongoose.Schema(
    {
        // Applicant info (denormalised for quick display)
        employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true, index: true },
        biometricId: { type: String, index: true },
        employeeName: { type: String },
        designation: { type: String },
        department: { type: String },

        // Leave details
        leaveType: {
            type: String,
            enum: ["CL", "SL", "PL"],
            required: true,
        },
        applicationDate: { type: String, required: true },  // "YYYY-MM-DD"  — date employee filled the form
        fromDate: { type: String, required: true },  // "YYYY-MM-DD"
        toDate: { type: String, required: true },  // "YYYY-MM-DD"
        totalDays: { type: Number, required: true },
        reason: { type: String, required: true },
        isHalfDay: { type: Boolean, default: false },
        halfDaySlot: { type: String, enum: ["first_half", "second_half", null], default: null },
        requiresDocument: { type: Boolean, default: false }, // true when SL > slDocumentThreshold
        documentSubmitted: { type: Boolean, default: false }, // true once employee uploads doc
        documentUrl: { type: String, default: null }, // Google Drive view URL
        documentFileId: { type: String, default: null }, // Google Drive file ID
        documentFileName: { type: String, default: null }, // original file name
        documentUploadedAt: { type: Date, default: null },

        // ── Approval workflow ──────────────────────────────────────────
        // Step 1: Managers (primary + secondary if exists)
        // Step 2: HR (final)
        status: {
            type: String,
            enum: [
                "pending",          // just submitted, waiting for manager
                "manager_approved", // at least one manager approved
                "manager_rejected", // manager rejected
                "hr_approved",      // HR gave final approval ✓
                "hr_rejected",      // HR rejected ✗
                "cancelled",        // employee cancelled
            ],
            default: "pending",
            index: true,
        },

        // Managers notified
        managersNotified: [
            {
                managerId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
                managerName: { type: String },
                type: { type: String, enum: ["primary", "secondary"] },
            },
        ],

        // Manager decision(s)
        managerDecisions: [
            {
                managerId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
                managerName: { type: String },
                type: { type: String, enum: ["primary", "secondary"] },
                decision: { type: String, enum: ["approved", "rejected"] },
                remarks: { type: String },
                decidedAt: { type: Date },
            },
        ],

        // HR decision (final)
        hrApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
        hrApprovedAt: { type: Date },
        hrRemarks: { type: String },
        rejectedBy: { type: mongoose.Schema.Types.ObjectId },
        rejectedAt: { type: Date },
        rejectionReason: { type: String },

        // Cancellation
        cancelledBy: { type: mongoose.Schema.Types.ObjectId },
        cancelledAt: { type: Date },
        cancelReason: { type: String },

        // After HR approval → attendance records updated
        appliedToAttendance: { type: Boolean, default: false },
        appliedAt: { type: Date },
    },
    { timestamps: true }
);

leaveApplicationSchema.index({ employeeId: 1, status: 1 });
leaveApplicationSchema.index({ status: 1, department: 1 });
leaveApplicationSchema.index({ fromDate: 1, toDate: 1 });

const LeaveApplication = mongoose.model("LeaveApplication", leaveApplicationSchema);


// ─────────────────────────────────────────────────────────────────────────────
//  4. COMPANY HOLIDAY  (defined by HR, shown on all calendars)
// ─────────────────────────────────────────────────────────────────────────────
const companyHolidaySchema = new mongoose.Schema(
    {
        date: { type: String, required: true, unique: true }, // "YYYY-MM-DD"
        name: { type: String, required: true },
        description: { type: String },
        type: { type: String, enum: ["national", "optional", "company", "restricted", "working_sunday"], default: "company" },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
    },
    { timestamps: true }
);

const CompanyHoliday = mongoose.model("CompanyHoliday", companyHolidaySchema);


module.exports = { LeaveConfig, LeaveBalance, LeaveApplication, CompanyHoliday };