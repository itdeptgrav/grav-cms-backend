const mongoose = require("mongoose");


const salaryConfigSchema = new mongoose.Schema(
    {
        // ── Earnings breakdown ──────────────────────────────────────────────────
        basicPct: {
            type: Number, default: 50,
            min: [1, "Basic % must be at least 1"],
            max: [100, "Basic % cannot exceed 100"],
            comment: "Basic salary as % of gross. Company default: 50%.",
        },
        hraPct: {
            type: Number, default: 50,
            min: [0], max: [100],
            comment: "HRA as % of gross. Company default: 50%.",
        },

        // ── EPF / PF rates ──────────────────────────────────────────────────────
        eepfPct: {
            type: Number, default: 12,
            min: [0], max: [100],
            comment: "Employee PF % of Basic. Statutory: 12%.",
        },
        epfCapAmount: {
            type: Number, default: 1800,
            min: [0],
            comment: "Monthly rupee cap on EPF. = 12% of ₹15,000 PF wage ceiling. Default: ₹1,800.",
        },
        edliPct: {
            type: Number, default: 0.5,
            min: [0], max: [10],
            comment: "EDLI % of Basic. Statutory: 0.5%. HR can override per employee.",
        },
        edliCapAmount: {
            type: Number, default: 15000,
            min: [0],
            comment: "Monthly cap on EDLI basic wage for calculation. Statutory: ₹15,000.",
        },
        adminChargesPct: {
            type: Number, default: 0.5,
            min: [0], max: [10],
            comment: "EPF admin charges % of Basic. Statutory: 0.5%. HR can override per employee.",
        },

        foodAllowance: {
            type: Number, default: 1600,
            min: [0],
            comment: "Fixed monthly food allowance added to CTC. Default: ₹1,600.",
        },

        // ── ESI rates (calculated on Basic salary) ──────────────────────────────
        esiWageLimit: {
            type: Number, default: 21000,
            min: [0],
            comment: "Gross above this = ESI not applicable. Statutory: ₹21,000.",
        },
        eeEsicPct: {
            type: Number, default: 0.75,
            min: [0], max: [10],
            comment: "Employee ESI % of Basic (not gross). Statutory: 0.75%.",
        },
        erEsicPct: {
            type: Number, default: 3.25,
            min: [0], max: [10],
            comment: "Employer ESI % of Basic. Statutory: 3.25%.",
        },

        // ── Metadata ─────────────────────────────────────────────────────────────
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
        updatedAt: { type: Date, default: Date.now },
    },
    { collection: "salary_config" }
);

// Singleton: always fetch or create the one config doc
salaryConfigSchema.statics.getSingleton = async function () {
    let config = await this.findOne();
    if (!config) config = await this.create({});
    return config;
};

module.exports = mongoose.model("SalaryConfig", salaryConfigSchema);