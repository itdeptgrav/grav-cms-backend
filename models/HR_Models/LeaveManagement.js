"use strict";
/**
 * LeaveManagement.js — v3 (GRAV Clothing)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Models:
 *  1. LeaveConfig             — HR-configurable dynamic parameters (single document)
 *  2. LeaveBalance            — yearly leave entitlements & consumed per employee
 *  3. LeaveApplication        — individual leave requests (Employee → Manager → HR flow)
 *  4. CompanyHoliday          — holidays defined by HR, shown on both calendars
 *  5. RegularizationRequest   — miss-punch / attendance correction requests
 *                                (Employee → Manager → HR → applied to attendance)
 */

const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
//  1. LEAVE CONFIG  (single document — HR admin panel changes these)
// ─────────────────────────────────────────────────────────────────────────────
const leaveConfigSchema = new mongoose.Schema(
    {
        singleton: { type: String, default: "global", unique: true },

        initialWaitingDays: { type: Number, default: 24 },
        clPerYear: { type: Number, default: 5 },
        slPerYear: { type: Number, default: 5 },
        plPerYear: { type: Number, default: 18 },
        daysRequiredForPL: { type: Number, default: 240 },
        slDocumentThreshold: { type: Number, default: 2 },

        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
    },
    { timestamps: true }
);

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

        entitlement: {
            CL: { type: Number, default: 0 },
            SL: { type: Number, default: 0 },
            PL: { type: Number, default: 0 },
        },

        consumed: {
            CL: { type: Number, default: 0 },
            SL: { type: Number, default: 0 },
            PL: { type: Number, default: 0 },
        },

        plEligible: { type: Boolean, default: false },
        plGrantedDate: { type: Date },

        lastUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
    },
    { timestamps: true }
);

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

leaveBalanceSchema.statics.getOrCreate = async function (employeeId, year, biometricId) {
    let bal = await this.findOne({ employeeId, year });
    if (!bal) bal = await this.create({ employeeId, year, biometricId });
    return bal;
};

const LeaveBalance = mongoose.model("LeaveBalance", leaveBalanceSchema);

// ─────────────────────────────────────────────────────────────────────────────
//  3. LEAVE APPLICATION
// ─────────────────────────────────────────────────────────────────────────────
const leaveApplicationSchema = new mongoose.Schema(
    {
        employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true, index: true },
        biometricId: { type: String, index: true },
        employeeName: { type: String },
        designation: { type: String },
        department: { type: String },

        leaveType: { type: String, enum: ["CL", "SL", "PL"], required: true },
        applicationDate: { type: String, required: true },
        fromDate: { type: String, required: true },
        toDate: { type: String, required: true },
        totalDays: { type: Number, required: true },
        reason: { type: String, required: true },
        isHalfDay: { type: Boolean, default: false },
        halfDaySlot: { type: String, enum: ["first_half", "second_half", null], default: null },
        requiresDocument: { type: Boolean, default: false },
        documentSubmitted: { type: Boolean, default: false },
        documentUrl: { type: String, default: null },
        documentFileId: { type: String, default: null },
        documentFileName: { type: String, default: null },
        documentUploadedAt: { type: Date, default: null },

        status: {
            type: String,
            enum: [
                "pending",
                "manager_approved",
                "manager_rejected",
                "hr_approved",
                "hr_rejected",
                "cancelled",
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

        hrApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
        hrApprovedAt: { type: Date },
        hrRemarks: { type: String },
        rejectedBy: { type: mongoose.Schema.Types.ObjectId },
        rejectedAt: { type: Date },
        rejectionReason: { type: String },

        cancelledBy: { type: mongoose.Schema.Types.ObjectId },
        cancelledAt: { type: Date },
        cancelReason: { type: String },

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
        date: { type: String, required: true, unique: true },
        name: { type: String, required: true },
        description: { type: String },
        type: {
            type: String,
            enum: ["national", "optional", "company", "restricted", "working_sunday"],
            default: "company",
        },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
    },
    { timestamps: true }
);

const CompanyHoliday = mongoose.model("CompanyHoliday", companyHolidaySchema);


// ─────────────────────────────────────────────────────────────────────────────
//  5. REGULARIZATION REQUEST  (miss-punch & attendance corrections)
// ─────────────────────────────────────────────────────────────────────────────
//  Employee on mobile app → files a request saying "on date X, my actual in-time
//  was 9:12am but device didn't record it". Flow:
//    1. Employee submits → status = pending
//    2. Manager(s) review → status = manager_approved | manager_rejected
//    3. HR finalises → status = hr_approved | hr_rejected
//    4. On hr_approved, we write the corrected times into DailyAttendance and
//       recompute metrics (late / HD / OT / status) for that day.
//
//  Request types:
//    miss_punch      — full rewrite of in/out for the day
//    late_arrival    — employee admits to being late, optionally with reason
//    early_departure — employee admits early out (reason)
//    wrong_status    — dispute the system-predicted status (AB when really WO etc.)
// ─────────────────────────────────────────────────────────────────────────────

const regularizationRequestSchema = new mongoose.Schema(
    {
        // Applicant
        employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true, index: true },
        biometricId: { type: String, index: true },
        employeeName: { type: String },
        designation: { type: String },
        department: { type: String },

        // Request basics
        requestType: {
            type: String,
            enum: ["miss_punch", "late_arrival", "early_departure", "wrong_status", "other"],
            default: "miss_punch",
            required: true,
        },
        dateStr: { type: String, required: true, index: true },  // "YYYY-MM-DD" — day this request is for
        reason: { type: String, required: true },

        // Proposed corrections (filled by employee on mobile)
        proposedInTime: { type: String, default: null },   // "HH:MM" (24-hr)
        proposedOutTime: { type: String, default: null },
        proposedStatus: {
            type: String,
            enum: ["P", "P*", "P~", "HD", "AB", "WO", "PH", "L-CL", "L-SL", "L-EL", "LWP", "MP", "WFH", "CO", null, ""],
            default: null,
        },
        proposedRemarks: { type: String, default: null },

        // Supporting document (optional — e.g. client-visit proof)
        documentUrl: { type: String, default: null },
        documentFileId: { type: String, default: null },
        documentFileName: { type: String, default: null },
        documentUploadedAt: { type: Date, default: null },

        // Snapshot of the original day record at time of filing (so HR can compare)
        originalSnapshot: {
            inTime: { type: Date, default: null },
            finalOut: { type: Date, default: null },
            systemPrediction: { type: String, default: null },
            hrFinalStatus: { type: String, default: null },
            netWorkMins: { type: Number, default: 0 },
            lateMins: { type: Number, default: 0 },
            otMins: { type: Number, default: 0 },
            punchCount: { type: Number, default: 0 },
        },

        // ── Approval workflow (mirrors leaves) ──────────────────────
        status: {
            type: String,
            enum: [
                "pending",
                "manager_approved",
                "manager_rejected",
                "hr_approved",
                "hr_rejected",
                "cancelled",
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

        hrApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
        hrApprovedAt: { type: Date },
        hrRemarks: { type: String },
        rejectedBy: { type: mongoose.Schema.Types.ObjectId },
        rejectedAt: { type: Date },
        rejectionReason: { type: String },

        cancelledBy: { type: mongoose.Schema.Types.ObjectId },
        cancelledAt: { type: Date },
        cancelReason: { type: String },

        // After HR approval → the DailyAttendance doc was updated
        appliedToAttendance: { type: Boolean, default: false },
        appliedAt: { type: Date },
    },
    { timestamps: true }
);

regularizationRequestSchema.index({ employeeId: 1, status: 1 });
regularizationRequestSchema.index({ status: 1, department: 1 });
regularizationRequestSchema.index({ dateStr: 1 });

const RegularizationRequest = mongoose.model("RegularizationRequest", regularizationRequestSchema);


module.exports = { LeaveConfig, LeaveBalance, LeaveApplication, CompanyHoliday, RegularizationRequest };