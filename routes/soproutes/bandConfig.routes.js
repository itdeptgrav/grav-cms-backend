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
        for (const [bandName, b] of Object.entries(bands)) {
            const total = (Number(b.c1Max) || 0) + (Number(b.c2Max) || 0);
            if (total > 100) {
                return res.status(400).json({
                    error: `${bandName}: C1 (${b.c1Max}) + C2 (${b.c2Max}) = ${total} — cannot exceed 100 pts.`
                });
            }
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
        const seenBiometricIds = {};
        for (const emp of employees) {
            if (!emp.biometricId) continue;
            // ── Duplicate biometricId guard ─────────────────────────────────────
            // If two HR Employee documents share a biometricId, the later one
            // silently overwrote the earlier one below, which is exactly how a
            // wrong designation can show up against the right name in Cowork.
            // This logs the collision so it can be traced to the two Mongo _ids.
            if (seenBiometricIds[emp.biometricId]) {
                console.warn(
                    `[band-config/employee-bands] DUPLICATE biometricId "${emp.biometricId}": Mongo _id ${seenBiometricIds[emp.biometricId]} (designation "${map[emp.biometricId]?.designation}") vs _id ${emp._id} (designation "${emp.designation}"). The second one is winning.`
                );
            }
            seenBiometricIds[emp.biometricId] = emp._id;
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