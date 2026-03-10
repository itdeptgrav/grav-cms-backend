const mongoose = require("mongoose");

// ─── SALARY CONFIG SCHEMA ─────────────────────────────────────────────────────
// Stores all configurable payroll formula rates.
// There is only ever ONE document in this collection (singleton pattern).
// Access via GET /api/employees/salary-config
// Update via PUT /api/employees/salary-config

const salaryConfigSchema = new mongoose.Schema(
    {
        // ── Earnings breakdown ──────────────────────────────────────────────────
        basicPct: {
            type: Number, default: 50,
            min: [1, "Basic % must be at least 1"],
            max: [100, "Basic % cannot exceed 100"],
            comment: "Basic salary as % of gross",
        },
        hraPct: {
            type: Number, default: 20,
            min: [0, "HRA % cannot be negative"],
            max: [100, "HRA % cannot exceed 100"],
            comment: "HRA as % of gross",
        },

        // ── EPF / PF rates ──────────────────────────────────────────────────────
        eepfPct: {
            type: Number, default: 12,
            min: [0], max: [100],
            comment: "Employee PF contribution % of Basic (statutory: 12%)",
        },
        epsPct: {
            type: Number, default: 8.33,
            min: [0], max: [100],
            comment: "Employer pension share % of Basic (statutory: 8.33%)",
        },
        epsCapAmount: {
            type: Number, default: 1250,
            min: [0],
            comment: "Monthly cap on EPS in ₹ (statutory: ₹1,250)",
        },
        edliPct: {
            type: Number, default: 0.5,
            min: [0], max: [10],
            comment: "EDLI % of Basic (statutory: 0.5%)",
        },
        edliCapAmount: {
            type: Number, default: 75,
            min: [0],
            comment: "Monthly cap on EDLI in ₹ (statutory: ₹75)",
        },
        adminChargesPct: {
            type: Number, default: 0.5,
            min: [0], max: [10],
            comment: "EPF admin charges % of Basic (statutory: 0.5%)",
        },

        // ── ESI rates ───────────────────────────────────────────────────────────
        esiWageLimit: {
            type: Number, default: 21000,
            min: [0],
            comment: "Gross salary limit above which ESI is not applicable (statutory: ₹21,000)",
        },
        eeEsicPct: {
            type: Number, default: 0.75,
            min: [0], max: [10],
            comment: "Employee ESI contribution % of gross (statutory: 0.75%)",
        },
        erEsicPct: {
            type: Number, default: 3.25,
            min: [0], max: [10],
            comment: "Employer ESI contribution % of gross (statutory: 3.25%)",
        },

        // ── Metadata ─────────────────────────────────────────────────────────────
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
        updatedAt: { type: Date, default: Date.now },
    },
    { collection: "salary_config" }
);

// ── Singleton helper: always fetch or create the one config doc ───────────────
salaryConfigSchema.statics.getSingleton = async function () {
    let config = await this.findOne();
    if (!config) config = await this.create({});
    return config;
};

module.exports = mongoose.model("SalaryConfig", salaryConfigSchema);