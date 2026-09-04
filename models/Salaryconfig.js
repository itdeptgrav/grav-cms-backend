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
            comment: "EDLI wage ceiling. The percentage is charged on min(basic, this). Statutory: 15,000, giving 75/mo at 0.5%.",
        },
        edliMaxAmount: {
            type: Number, default: 75,
            min: [0],
            comment: "Hard monthly rupee maximum for EDLI, applied after the wage ceiling. Default: 75.",
        },
        adminChargesPct: {
            type: Number, default: 0.5,
            min: [0], max: [10],
            comment: "EPF admin charges % of Basic. Statutory: 0.5%. HR can override per employee.",
        },
        adminWageCeiling: {
            type: Number, default: 15000,
            min: [0],
            comment: "Admin-charges wage ceiling. Charged on min(basic, this). Default: 15,000, giving 75/mo at 0.5%.",
        },
        adminMaxAmount: {
            type: Number, default: 75,
            min: [0],
            comment: "Hard monthly rupee maximum for admin charges. Default: 75.",
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
/* Memoised — see services/memo.js. Read by every salary computation and
   every payroll row; written from one settings page via findOneAndUpdate,
   which invalidates. */
const { memo: _memo, invalidateOnWrite: _invalidateOnWrite } = require("../services/memo");
const SALARY_CONFIG_MEMO = "settings:salary";
_invalidateOnWrite(salaryConfigSchema, SALARY_CONFIG_MEMO);

salaryConfigSchema.statics.getSingleton = async function () {
    return _memo(SALARY_CONFIG_MEMO, 15 * 1000, async () => {
        let config = await this.findOne();
        if (!config) config = await this.create({});
        return config;
    });
};

module.exports = mongoose.model("SalaryConfig", salaryConfigSchema);