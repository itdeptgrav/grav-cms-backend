/**
 * routes/soproutes/bandConfig.routes.js
 * Band Configuration API
 * Mount in server.js: app.use("/cowork", require("./routes/soproutes/bandConfig.routes"));
 *
 * Endpoints:
 *   GET  /cowork/band-config   → read band config (all roles)
 *   POST /cowork/band-config   → save band config (CEO only)
 */
"use strict";
const express = require("express");
const router = express.Router();
const { verifyCoworkToken, verifyCeoToken, verifyEmployeeToken } = require("../../Middlewear/coworkAuth");
const { BandConfig } = require("../../models/BandConfig");

// GET /cowork/band-config
router.get("/band-config", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const config = await BandConfig.findOne().lean();
        res.json({
            success: true,
            bands: config?.bands || {},
            updatedAt: config?.updatedAt || null,
        });
    } catch (e) {
        console.error("[band-config GET]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /cowork/band-config — CEO only
router.post("/band-config", verifyCoworkToken, verifyCeoToken, async (req, res) => {
    try {
        const { bands } = req.body;
        if (!bands || typeof bands !== "object") {
            return res.status(400).json({ error: "bands object required" });
        }
        await BandConfig.findOneAndUpdate(
            {},
            { bands, updatedAt: new Date(), updatedBy: req.coworkUser?.employeeId || "" },
            { upsert: true, new: true }
        );
        res.json({ success: true, message: "Band config saved." });
    } catch (e) {
        console.error("[band-config POST]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /cowork/band-config/designations — all unique designations from MongoDB
router.get("/band-config/designations", verifyCoworkToken, verifyCeoToken, async (req, res) => {
    try {
        const Employee = require("../../models/Employee");
        const designations = await Employee.distinct("designation", {
            designation: { $exists: true, $ne: "" }
        });
        res.json({
            success: true,
            designations: designations.filter(Boolean).sort(),
        });
    } catch (e) {
        console.error("[band-config/designations]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /cowork/band-config/employee-bands
// Returns map of biometricId → { designation, bandName }
router.get("/band-config/employee-bands", verifyCoworkToken, verifyCeoToken, async (req, res) => {
    try {
        const Employee = require("../../models/Employee");
        const [employees, config] = await Promise.all([
            Employee.find({}, { biometricId: 1, designation: 1 }).lean(),
            BandConfig.findOne().lean(),
        ]);
        const bands = config?.bands || {};
        const desigToBand = {};
        for (const [bandName, bandData] of Object.entries(bands)) {
            for (const d of (bandData.designations || [])) {
                desigToBand[d] = bandName;
            }
        }
        const map = {};
        for (const emp of employees) {
            if (!emp.biometricId) continue;
            map[emp.biometricId] = {
                designation: emp.designation || null,
                bandName: emp.designation ? (desigToBand[emp.designation] || null) : null,
            };
        }
        res.json({ success: true, map });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;