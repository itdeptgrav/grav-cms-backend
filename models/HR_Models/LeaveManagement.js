/**
 * LeaveManagement.js — v1 (GRAV Clothing)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Two models:
 *  1. LeaveBalance  — yearly leave entitlements and consumed count per employee
 *  2. LeaveApplication — individual leave requests with PM→HR approval flow
 *
 * Leave Types at GRAV:
 *  CL (Casual Leave)  — 12 per year, cannot carry forward
 *  SL (Sick Leave)     — 12 per year, can accumulate up to 30
 *  EL (Earned Leave)   — 15 per year, can carry forward, encashable
 *  CO (Compensatory Off) — earned by working on holidays/Sundays
 *  LWP (Leave Without Pay) — unlimited, but affects salary
 */

"use strict";
const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
//  LEAVE BALANCE (per employee per year)
// ─────────────────────────────────────────────────────────────────────────────
const leaveBalanceSchema = new mongoose.Schema({
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true, index: true },
    biometricId: { type: String, index: true },
    year: { type: Number, required: true },

    // Entitlements (how many days allocated this year)
    entitlement: {
        CL: { type: Number, default: 12 },
        SL: { type: Number, default: 12 },
        EL: { type: Number, default: 15 },
        CO: { type: Number, default: 0 },  // earned dynamically
    },

    // Consumed (how many days taken/approved)
    consumed: {
        CL: { type: Number, default: 0 },
        SL: { type: Number, default: 0 },
        EL: { type: Number, default: 0 },
        CO: { type: Number, default: 0 },
        LWP: { type: Number, default: 0 },
    },

    // Carried forward from previous year
    carriedForward: {
        SL: { type: Number, default: 0 },
        EL: { type: Number, default: 0 },
    },

    // Metadata
    lastUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
}, { timestamps: true });

// Virtual: available balance for each type
leaveBalanceSchema.virtual("available").get(function () {
    return {
        CL: (this.entitlement?.CL || 0) - (this.consumed?.CL || 0),
        SL: (this.entitlement?.SL || 0) + (this.carriedForward?.SL || 0) - (this.consumed?.SL || 0),
        EL: (this.entitlement?.EL || 0) + (this.carriedForward?.EL || 0) - (this.consumed?.EL || 0),
        CO: (this.entitlement?.CO || 0) - (this.consumed?.CO || 0),
    };
});

leaveBalanceSchema.index({ employeeId: 1, year: 1 }, { unique: true });

// Static: get or create balance for an employee+year
leaveBalanceSchema.statics.getOrCreate = async function (employeeId, year, biometricId) {
    let bal = await this.findOne({ employeeId, year });
    if (!bal) {
        bal = await this.create({ employeeId, year, biometricId });
    }
    return bal;
};


// ─────────────────────────────────────────────────────────────────────────────
//  LEAVE APPLICATION
// ─────────────────────────────────────────────────────────────────────────────
const leaveApplicationSchema = new mongoose.Schema({
    // Who is applying
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true, index: true },
    biometricId: { type: String, index: true },
    employeeName: { type: String },
    department: { type: String },

    // Leave details
    leaveType: {
        type: String,
        enum: ["CL", "SL", "EL", "CO", "LWP", "WFH"],
        required: true,
    },
    fromDate: { type: String, required: true },        // "YYYY-MM-DD"
    toDate: { type: String, required: true },           // "YYYY-MM-DD"
    totalDays: { type: Number, required: true },        // can be 0.5 for half-day
    isHalfDay: { type: Boolean, default: false },
    halfDaySlot: { type: String, enum: ["first_half", "second_half", null], default: null },
    reason: { type: String, required: true },
    attachments: [{ type: String }],                    // file URLs for medical certificates etc.

    // Approval workflow: Employee → PM → HR
    status: {
        type: String,
        enum: ["pending", "pm_approved", "hr_approved", "pm_rejected", "hr_rejected", "cancelled"],
        default: "pending",
    },

    // PM (Project Manager / Reporting Manager) approval
    pmApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    pmApprovedAt: { type: Date },
    pmRemarks: { type: String },

    // HR approval (final)
    hrApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
    hrApprovedAt: { type: Date },
    hrRemarks: { type: String },

    // Rejection details
    rejectedBy: { type: mongoose.Schema.Types.ObjectId },
    rejectedAt: { type: Date },
    rejectionReason: { type: String },

    // Cancellation
    cancelledBy: { type: mongoose.Schema.Types.ObjectId },
    cancelledAt: { type: Date },
    cancelReason: { type: String },

    // Once fully approved, the attendance records are updated
    appliedToAttendance: { type: Boolean, default: false },
    appliedAt: { type: Date },

}, { timestamps: true });

leaveApplicationSchema.index({ employeeId: 1, status: 1 });
leaveApplicationSchema.index({ status: 1, department: 1 });
leaveApplicationSchema.index({ fromDate: 1, toDate: 1 });


const LeaveBalance = mongoose.model("LeaveBalance", leaveBalanceSchema);
const LeaveApplication = mongoose.model("LeaveApplication", leaveApplicationSchema);

module.exports = { LeaveBalance, LeaveApplication };