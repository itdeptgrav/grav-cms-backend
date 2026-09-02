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

        // Whether this row was paid as an intern, decided when the run was
        // computed and frozen here. Not re-derived from employmentType on
        // read: someone promoted from intern to staff in April must not make
        // their March payslip re-render with a basic and a PF deduction.
        // It is also what the Interns tab filters on.
        isIntern: { type: Boolean, default: false },
        internshipType: {
            type: String,
            enum: ["paid", "unpaid", "self_paid", null],
            default: null,
        },

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

        // ── Rate snapshot (employee's configured monthly salary at time of run) ─
        // Persisted so the Salary Register tab can show "Rate of wages payable"
        // directly without having to re-query the Employee model.
        rateBasic: { type: Number, default: 0 },
        rateHra: { type: Number, default: 0 },
        rateGross: { type: Number, default: 0 },

        // ── Working Days ───────────────────────────────────────────────
        workingDays: { type: Number, default: 26 },        // divisor (26 / 30 / 31 / weekdays)
        daysInMonth: { type: Number, default: 30 },        // calendar days (28-31)
        presentDays: { type: Number, default: 26 },
        absentDays: { type: Number, default: 0 },
        halfDays: { type: Number, default: 0 },
        missPunchDays: { type: Number, default: 0 },
        lopDays: { type: Number, default: 0 },             // Loss of Pay days
        paidLeaveDays: { type: Number, default: 0 },
        weekOffDays: { type: Number, default: 0 },
        holidayDays: { type: Number, default: 0 },
        holidayWorkedDays: { type: Number, default: 0 },
        sundayWorkedDays: { type: Number, default: 0 },
        lwpDays: { type: Number, default: 0 },
        clUsedDays: { type: Number, default: 0 },
        slUsedDays: { type: Number, default: 0 },
        plUsedDays: { type: Number, default: 0 },

        // ── Payable Days ───────────────────────────────────────────────
        payableDays: { type: Number, default: 0 },         // divisor − LOP (display)
        effectivePayableDays: { type: Number, default: 0 },// actually paid days (with bonus)
        perDayRate: { type: Number, default: 0 },          // gross ÷ divisor
        divisorBasis: { type: String },                     // fixed26 / calendar / working_days

        // ── Engine Adjustments (audit trail) ───────────────────────────
        sundayOffsetApplied: { type: Number, default: 0 },  // AB days rescued by Sunday work
        autoAdjustedCL: { type: Number, default: 0 },       // AB days auto-converted to CL
        sundayExtraPayDays: { type: Number, default: 0 },   // bonus Sunday pay days
        unsyncedDays: { type: Number, default: 0 },         // days with no attendance record

        // ── Earnings ───────────────────────────────────────────────────
        earnings: {
            // An intern's whole pay, prorated. Mutually exclusive with
            // basicSalary + houseRentAllowance: a stipend has no components,
            // so it is carried as one figure rather than split into a basic
            // and an HRA that describe an arrangement they do not have.
            stipend: { type: Number, default: 0 },
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
            esic: { type: Number, default: 0 }, // 0.75% of basic (if gross <= 21000)
            employerESIC: { type: Number, default: 0 }, // 3.25% employer
            /* EMPLOYER-SIDE PF COSTS. Recorded here, beside employerPF and
               employerESIC, because they are the same kind of figure: money the
               company pays on top of the salary rather than anything withheld
               from the employee. They were missing entirely, so every report
               that added up what a month of payroll cost was short by them. */
            edli: { type: Number, default: 0 },
            adminCharges: { type: Number, default: 0 },
            professionalTax: { type: Number, default: 0 }, // state-specific
            incomeTax: { type: Number, default: 0 }, // TDS
            loanDeduction: { type: Number, default: 0 },
            advanceDeduction: { type: Number, default: 0 },
            lateDeduction: { type: Number, default: 0 },
                lopDeduction: { type: Number, default: 0 }, // Loss of Pay
            // Auto-computed from the employee's standing monthly deduction,
            // prorated by approved leave — see computeEmployeePayroll. HR can
            // still override it on the item; a recalculate puts it back.
            otherDeductions: { type: Number, default: 0 },
            totalDeductions: { type: Number, default: 0 }, // auto-calculated
        },

        // ── Net Pay ────────────────────────────────────────────────────
        netPay: { type: Number, default: 0 },
        roundedNetPay: { type: Number, default: 0 },

        // ── Day Breakdown (per-day audit trail) ────────────────────────
        // Array of { dateStr, dayOfWeek, category, paid, lopWeight, note, ... }
        // Kept as Mixed so engine can evolve fields without migrations.
        dayBreakdown: { type: [mongoose.Schema.Types.Mixed], default: undefined },

        // ── Other-deduction working ────────────────────────────────────
        // Stored so the payroll drawer can show WHY otherDeductions is what
        // it is — a bare figure invites "where did that come from".
        otherDeductionFull: { type: Number, default: 0 },
        // The prorated amount actually charged. Stored separately from
        // deductions.otherDeductions because that field also holds whatever
        // one-off figure HR typed for the month — without this, a second
        // recalculate would add the recurring part on top of itself.
        otherDeductionRecurring: { type: Number, default: 0 },
        // What could not be taken because there was no pay to take it from.
        // Recorded rather than dropped: an amount that quietly vanishes is one
        // nobody can explain when the canteen account does not tie out.
        otherDeductionUncollected: { type: Number, default: 0 },
        otherDeductionChargeableDays: { type: Number, default: 0 },

        // ── Manual Override ────────────────────────────────────────────
        isManuallyOverridden: { type: Boolean, default: false },
        overriddenPayableDays: { type: Number },
        lastEditedBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
        lastEditedAt: { type: Date },

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
        (e.stipend || 0) +
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
        // The run's employer-side PF costs, for the same reason as above.
        totalEDLI: { type: Number, default: 0 },
        totalAdminCharges: { type: Number, default: 0 },
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