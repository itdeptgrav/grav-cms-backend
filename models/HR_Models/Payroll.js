const mongoose = require("mongoose");

// ─── Payroll Item (per employee per month) ───────────────────────────────────
const payrollItemSchema = new mongoose.Schema(
    {
        // ── Reference ──────────────────────────────────────────────────
        employeeId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Employee",
            required: true,
        },
        employeeName: { type: String, required: true },
        biometricId: { type: String },
        department: { type: String },
        designation: { type: String },
        jobTitle: { type: String },
        employmentType: { type: String },

        // ── Pay Period ─────────────────────────────────────────────────
        payrollId: {
            // Parent payroll run reference
            type: mongoose.Schema.Types.ObjectId,
            ref: "Payroll",
            required: true,
        },
        month: { type: Number, required: true, min: 1, max: 12 },
        year: { type: Number, required: true },
        payPeriod: { type: String }, // e.g. "March 2025"

        // ── Working Days ───────────────────────────────────────────────
        workingDays: { type: Number, default: 26 },
        presentDays: { type: Number, default: 26 },
        absentDays: { type: Number, default: 0 },
        lopDays: { type: Number, default: 0 }, // Loss of Pay days
        paidLeaveDays: { type: Number, default: 0 },

        // ── Earnings ───────────────────────────────────────────────────
        earnings: {
            basicSalary: { type: Number, default: 0 },
            houseRentAllowance: { type: Number, default: 0 },
            travelAllowance: { type: Number, default: 0 },
            medicalAllowance: { type: Number, default: 0 },
            specialAllowance: { type: Number, default: 0 },
            overtime: { type: Number, default: 0 },
            bonus: { type: Number, default: 0 },
            incentives: { type: Number, default: 0 },
            otherEarnings: { type: Number, default: 0 },
            grossEarnings: { type: Number, default: 0 }, // auto-calculated
        },

        // ── Deductions ─────────────────────────────────────────────────
        deductions: {
            providentFund: { type: Number, default: 0 }, // 12% of basic
            employerPF: { type: Number, default: 0 }, // 12% employer contribution
            esic: { type: Number, default: 0 }, // 0.75% of gross (if gross <= 21000)
            employerESIC: { type: Number, default: 0 }, // 3.25% employer
            professionalTax: { type: Number, default: 0 }, // state-specific
            incomeTax: { type: Number, default: 0 }, // TDS
            loanDeduction: { type: Number, default: 0 },
            advanceDeduction: { type: Number, default: 0 },
            lateDeduction: { type: Number, default: 0 },
            lopDeduction: { type: Number, default: 0 }, // Loss of Pay
            otherDeductions: { type: Number, default: 0 },
            totalDeductions: { type: Number, default: 0 }, // auto-calculated
        },

        // ── Net Pay ────────────────────────────────────────────────────
        netPay: { type: Number, default: 0 },
        roundedNetPay: { type: Number, default: 0 },

        // ── Bank Details (snapshot at time of payment) ─────────────────
        bankDetails: {
            bankName: { type: String },
            accountNumber: { type: String },
            ifscCode: { type: String },
        },

        // ── Status ─────────────────────────────────────────────────────
        status: {
            type: String,
            enum: ["pending", "processed", "paid", "failed", "on_hold"],
            default: "pending",
        },
        paymentDate: { type: Date },
        paymentMode: { type: String, enum: ["bank_transfer", "cash", "cheque"], default: "bank_transfer" },
        transactionId: { type: String },

        // ── Remarks ────────────────────────────────────────────────────
        remarks: { type: String },
        processedBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
        processedAt: { type: Date },
    },
    { timestamps: true }
);

// Auto-calculate gross & net before save
payrollItemSchema.pre("save", function (next) {
    const e = this.earnings;
    e.grossEarnings =
        (e.basicSalary || 0) +
        (e.houseRentAllowance || 0) +
        (e.travelAllowance || 0) +
        (e.medicalAllowance || 0) +
        (e.specialAllowance || 0) +
        (e.overtime || 0) +
        (e.bonus || 0) +
        (e.incentives || 0) +
        (e.otherEarnings || 0);

    const d = this.deductions;
    d.totalDeductions =
        (d.providentFund || 0) +
        (d.esic || 0) +
        (d.professionalTax || 0) +
        (d.incomeTax || 0) +
        (d.loanDeduction || 0) +
        (d.advanceDeduction || 0) +
        (d.lateDeduction || 0) +
        (d.lopDeduction || 0) +
        (d.otherDeductions || 0);

    this.netPay = e.grossEarnings - d.totalDeductions;
    this.roundedNetPay = Math.round(this.netPay);

    next();
});

payrollItemSchema.index({ employeeId: 1, month: 1, year: 1 }, { unique: true });
payrollItemSchema.index({ payrollId: 1 });
payrollItemSchema.index({ status: 1 });
payrollItemSchema.index({ department: 1 });

// ─── Payroll Run (batch for a month) ─────────────────────────────────────────
const payrollSchema = new mongoose.Schema(
    {
        // Pay Period
        month: { type: Number, required: true, min: 1, max: 12 },
        year: { type: Number, required: true },
        payPeriod: { type: String, required: true }, // "March 2025"

        // Summary
        totalEmployees: { type: Number, default: 0 },
        totalGross: { type: Number, default: 0 },
        totalDeductions: { type: Number, default: 0 },
        totalNetPay: { type: Number, default: 0 },
        totalPF: { type: Number, default: 0 },
        totalESIC: { type: Number, default: 0 },
        totalBonus: { type: Number, default: 0 },

        // Status
        status: {
            type: String,
            enum: ["draft", "processing", "processed", "approved", "paid", "cancelled"],
            default: "draft",
        },
        approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
        approvedAt: { type: Date },
        remarks: { type: String },

        // Audit
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment", required: true },
        processedAt: { type: Date },
    },
    { timestamps: true }
);

payrollSchema.index({ month: 1, year: 1 }, { unique: true });

const Payroll = mongoose.model("Payroll", payrollSchema);
const PayrollItem = mongoose.model("PayrollItem", payrollItemSchema);

module.exports = { Payroll, PayrollItem };