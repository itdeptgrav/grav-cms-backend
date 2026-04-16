const mongoose = require("mongoose");

// ─── Payroll Settings (singleton) ────────────────────────────────────────────
const payrollSettingsSchema = new mongoose.Schema(
    {
        _id: { type: String, default: "singleton" },

        // ── Payable Days Basis ────────────────────────────────────────────
        // How to convert monthly gross into per-day rate
        //   fixed26      → gross / 26 (standard Indian practice)
        //   calendar     → gross / days-in-month (30 or 31)
        //   working_days → gross / (month_days − Sundays − declared holidays)
        payableDaysBasis: {
            type: String,
            enum: ["fixed26", "calendar", "working_days"],
            default: "fixed26",
        },

        // ── CL Auto-Adjustment ────────────────────────────────────────────
        // Convert up to `maxABForAdjustment` AB days per month to L-CL (paid),
        // limited by the employee's remaining annual CL balance. Any AB days
        // beyond this cap stay as LOP.
        //
        // Historical note: this field was previously a *threshold* ("only if
        // AB ≤ this, adjust all AB"). It is now interpreted as a *monthly cap*
        // ("convert up to this many AB per month to CL"). Default raised from
        // 1 to 2 to match the standard Indian practice of 2 CL per month.
        clAutoAdjust: {
            enabled: { type: Boolean, default: true },
            maxABForAdjustment: { type: Number, default: 2 },   // max CL absorbed per month
            consumeFromBalance: { type: Boolean, default: true }, // actually deduct from LeaveBalance
        },

        // ── Miss-Punch Treatment ──────────────────────────────────────────
        // How to treat an MP day in payroll
        //   present   → paid in full (default)
        //   half_day  → paid as 0.5 day
        //   absent    → unpaid (LOP)
        mpTreatment: {
            type: String,
            enum: ["present", "half_day", "absent"],
            default: "present",
        },

        // ── Food Allowance ────────────────────────────────────────────────
        // Whether food allowance is part of gross (shown on payslip earnings)
        // or treated as a separate perk in CTC only (NOT on payslip earnings).
        foodAllowanceInGross: { type: Boolean, default: false },

        // ── Sunday-Worked Compensation (two independent options) ─────────
        // Sundays where the employee punched-in can be compensated in two ways.
        // These are independent — you can enable neither, one, or both.
        //
        // 1. sundayOffsetsAbsence: Sunday worked cancels out an absent day
        //    (compensatory off). Example: if AB=2 and Sunday-worked=1, then
        //    effective AB=1. Applied BEFORE CL auto-adjust so the remaining
        //    AB can also be rescued by the 1-CL rule.
        sundayOffsetsAbsence: { type: Boolean, default: true },
        //
        // 2. sundayWorkExtraPay: Sunday worked earns an extra day's pay on
        //    top of the monthly gross. This is separate from the offset rule.
        sundayWorkExtraPay: { type: Boolean, default: false },

        // ── Rounding ──────────────────────────────────────────────────────
        roundingMode: { type: String, enum: ["round", "ceil", "floor"], default: "round" },
        roundNetPay: { type: Boolean, default: true },

        // ── Professional Tax (opt-in — default OFF) ───────────────────────
        // PT is state-specific and varies by employee. The payroll engine only
        // applies PT when `ptEnabled` is explicitly set to true. The slabs below
        // are the template HR can customise in settings. Even if slabs have non-
        // zero amounts, nothing is deducted until `ptEnabled = true`.
        ptEnabled: { type: Boolean, default: false },
        ptSlabs: [
            {
                minBasic: { type: Number, default: 0 },
                maxBasic: { type: Number, default: 15000 },
                amount: { type: Number, default: 0 },
            },
        ],

        // ── Lock ──────────────────────────────────────────────────────────
        // When a PayrollItem is marked paid, prevent further edits
        lockAfterPaid: { type: Boolean, default: true },

        // ── Audit ─────────────────────────────────────────────────────────
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
        updatedAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
);

// Default PT slab template — all ₹0 because PT varies by state and we
// never want the engine to silently deduct PT on fresh installs.
// HR can customise amounts per slab in Payroll Settings → PT Slabs and
// then flip `ptEnabled` to true to start applying them.
payrollSettingsSchema.statics.DEFAULT_PT_SLABS = [
    { minBasic: 0, maxBasic: 7500, amount: 0 },
    { minBasic: 7500, maxBasic: 15000, amount: 0 },
    { minBasic: 15000, maxBasic: 999999, amount: 0 },
];

payrollSettingsSchema.statics.getConfig = async function () {
    let cfg = await this.findById("singleton");
    if (!cfg) {
        cfg = await this.create({
            _id: "singleton",
            ptSlabs: this.DEFAULT_PT_SLABS,
        });
    }
    // Safety: ensure PT slabs exist
    if (!cfg.ptSlabs || cfg.ptSlabs.length === 0) {
        cfg.ptSlabs = this.DEFAULT_PT_SLABS;
        await cfg.save();
    }
    return cfg;
};

payrollSettingsSchema.methods.ptForBasic = function (basic) {
    const slab = (this.ptSlabs || []).find(
        (s) => basic > s.minBasic && basic <= s.maxBasic
    );
    return slab ? slab.amount : 0;
};

module.exports = mongoose.model("PayrollSettings", payrollSettingsSchema);