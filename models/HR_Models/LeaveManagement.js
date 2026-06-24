"use strict";
const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
//  1. LEAVE CONFIG
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
    maxCLPerMonth: { type: Number, default: 3 },
    maxLeaveDaysPerMonth: { type: Number, default: 10 },
    maxLeaveDaysPerMonthOdisha: { type: Number, default: 7 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
  },
  { timestamps: true },
);
leaveConfigSchema.statics.getConfig = async function () {
  let cfg = await this.findOne({ singleton: "global" });
  if (!cfg) cfg = await this.create({ singleton: "global" });
  return cfg;
};
const LeaveConfig = mongoose.model("LeaveConfig", leaveConfigSchema);

// ─────────────────────────────────────────────────────────────────────────────
//  2. LEAVE BALANCE
// ─────────────────────────────────────────────────────────────────────────────
const leaveBalanceSchema = new mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
      index: true,
    },
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
    lastUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HRDepartment",
    },
  },
  { timestamps: true },
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
leaveBalanceSchema.statics.getOrCreate = async function (
  employeeId,
  year,
  biometricId,
) {
  let bal = await this.findOne({ employeeId, year });
  if (!bal) bal = await this.create({ employeeId, year, biometricId });
  return bal;
};
const LeaveBalance = mongoose.model("LeaveBalance", leaveBalanceSchema);

// ─────────────────────────────────────────────────────────────────────────────
//  3. LEAVE APPLICATION — with paidDays + lwpDays + QUICK-APPLY support
//
//  QUICK-APPLY FLOW (new):
//    Employee uses a shortcut button → leaveType: "QUICK", isQuickApply: true
//    Secondary manager calls /quick-apply/:id/resolve → picks CL/SL/LOP,
//      writes the chosen type back into leaveType + paidDays/lwpDays,
//      records itself in managerDecisions, sets status to manager_approved
//    Primary manager calls /manager/:id/approve → moves to hr_approved with
//      normal balance deduction + attendance sync + HR email.
//
//    NOTE the reverse order vs the regular flow (regular = primary first,
//    then secondary). The /manager/:id/approve handler checks isQuickApply
//    and routes accordingly.
// ─────────────────────────────────────────────────────────────────────────────
const leaveApplicationSchema = new mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
      index: true,
    },
    biometricId: { type: String, index: true },
    employeeName: { type: String },
    designation: { type: String },
    department: { type: String },

    leaveType: {
      type: String,
      // "QUICK" = pending secondary-manager classification (quick-apply)
      enum: ["CL", "SL", "PL", "LOP", "QUICK"],
      required: true,
    },
    applicationDate: { type: String, required: true },
    fromDate: { type: String, required: true },
    toDate: { type: String, required: true },
    totalDays: { type: Number, required: true },
    paidDays: { type: Number, default: null },
    lwpDays: { type: Number, default: 0 },
    reason: { type: String, required: true },
    isHalfDay: { type: Boolean, default: false },
    halfDaySlot: {
      type: String,
      enum: ["first_half", "second_half", null],
      default: null,
    },
    requiresDocument: { type: Boolean, default: false },
    documentSubmitted: { type: Boolean, default: false },
    documentUrl: { type: String, default: null },
    documentFileId: { type: String, default: null },
    documentFileName: { type: String, default: null },
    documentUploadedAt: { type: Date, default: null },

    addedByHR: { type: Boolean, default: false },
    addedByHRId: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },

    // ── QUICK-APPLY tracking ───────────────────────────────────────────
    isQuickApply: { type: Boolean, default: false, index: true },
    quickApply: {
      resolvedType: {
        type: String,
        enum: ["CL", "SL", "LOP", null],
        default: null,
      },
      resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
      resolvedByName: { type: String, default: null },
      resolvedAt: { type: Date, default: null },
      // Set when secondary manager forces LOP despite available CL/SL balance
      forcedLOPReason: { type: String, default: null },
    },

    status: {
      type: String,
      enum: [
        "pending",
        "manager_approved",
        "manager_rejected",
        "hr_approved",
        "hr_rejected",
        "cancelled",
        "withdraw_pending",
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
  { timestamps: true },
);
leaveApplicationSchema.index({ employeeId: 1, status: 1 });
leaveApplicationSchema.index({ status: 1, department: 1 });
leaveApplicationSchema.index({ fromDate: 1, toDate: 1 });
const LeaveApplication = mongoose.model(
  "LeaveApplication",
  leaveApplicationSchema,
);

// ─────────────────────────────────────────────────────────────────────────────
//  4. COMPANY HOLIDAY
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
  { timestamps: true },
);
const CompanyHoliday = mongoose.model("CompanyHoliday", companyHolidaySchema);

// ─────────────────────────────────────────────────────────────────────────────
//  5. REGULARIZATION REQUEST
// ─────────────────────────────────────────────────────────────────────────────
const regularizationRequestSchema = new mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
      index: true,
    },
    biometricId: { type: String, index: true },
    employeeName: { type: String },
    designation: { type: String },
    department: { type: String },

    dateStr: { type: String, required: true },
    type: {
      type: String,
      enum: [
        "miss_punch",
        "wrong_status",
        "forgot_punch",
        "client_visit",
        "other",
      ],
      required: true,
    },
    reason: { type: String, required: true },
    requestedStatus: { type: String },

    proposedPunchType: {
      type: String,
      enum: ["in", "out", null],
      default: null,
    },
    proposedPunchTime: { type: Date, default: null },
    proposedPunchAction: {
      type: String,
      enum: ["add", "replace", "remove", null],
      default: null,
    },
    proposedPunches: [
      {
        punchType: { type: String, enum: ["in", "out"] },
        punchTime: { type: Date },
        action: { type: String, enum: ["add", "replace", "remove"] },
        note: { type: String },
      },
    ],

    documentUrl: { type: String, default: null },
    documentFileId: { type: String, default: null },
    documentFileName: { type: String, default: null },
    documentUploadedAt: { type: Date, default: null },

    originalSnapshot: {
      inTime: { type: Date, default: null },
      finalOut: { type: Date, default: null },
      systemPrediction: { type: String, default: null },
      hrFinalStatus: { type: String, default: null },
      netWorkMins: { type: Number, default: 0 },
      lateMins: { type: Number, default: 0 },
      otMins: { type: Number, default: 0 },
      punchCount: { type: Number, default: 0 },
      rawPunches: { type: Array, default: [] },
    },

    status: {
      type: String,
      enum: [
        "pending",
        "manager_approved",
        "manager_rejected",
        "hr_approved",
        "hr_rejected",
        "cancelled",
        "withdraw_pending",
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
  { timestamps: true },
);
regularizationRequestSchema.index({ employeeId: 1, status: 1 });
regularizationRequestSchema.index({ status: 1, department: 1 });
regularizationRequestSchema.index({ dateStr: 1 });
const RegularizationRequest = mongoose.model(
  "RegularizationRequest",
  regularizationRequestSchema,
);

module.exports = {
  LeaveConfig,
  LeaveBalance,
  LeaveApplication,
  CompanyHoliday,
  RegularizationRequest,
};
