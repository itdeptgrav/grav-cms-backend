/**
 * models/BandConfig.js
 * MongoDB model for Role Band Configuration
 * Stores band definitions with C1/C2/C3/C4 max points and designations
 * Single document — only one record ever exists
 */
"use strict";
const mongoose = require("mongoose");

const BandSchema = new mongoose.Schema({
    bands: {
        type: Object, // { "execution-led": { c1Max, c2Max, c3Max, c4Max, designations[] } }
        default: {},
    },
    updatedAt: { type: Date, default: Date.now },
    updatedBy: { type: String, default: "" },
});

const BandConfig = mongoose.models.BandConfig || mongoose.model("BandConfig", BandSchema);

// ─────────────────────────────────────────────────────────────────────────────
// getBandMaxForEmployee
// Looks up employee's designation → finds their band → returns band max values
// Returns null if no band found (caller should fall back to global defaults)
// ─────────────────────────────────────────────────────────────────────────────
async function getBandMaxForEmployee(employeeId) {
    try {
        if (!employeeId) return null;
        const Employee = require("./Employee");
        const [emp, config] = await Promise.all([
            Employee.findOne({ biometricId: employeeId }, { designation: 1 }).lean(),
            BandConfig.findOne().lean(),
        ]);

        if (!emp?.designation || !config?.bands) return null;

        const bands = config.bands || {};

        // Find which band this designation belongs to
        for (const [bandName, bandData] of Object.entries(bands)) {
            const desigs = Array.isArray(bandData.designations) ? bandData.designations : [];
            if (desigs.includes(emp.designation)) {
                return {
                    bandName,
                    designation: emp.designation,
                    c1Max: Number(bandData.c1Max) || 0,
                    c2Max: Number(bandData.c2Max) || 0,
                    c3Max: Number(bandData.c3Max) || 0,
                    c4Max: Number(bandData.c4Max) || 0,
                };
            }
        }
        return null; // designation not mapped to any band → use global defaults
    } catch (e) {
        console.error("[getBandMaxForEmployee]", e.message);
        return null;
    }
}

module.exports = { BandConfig, getBandMaxForEmployee };