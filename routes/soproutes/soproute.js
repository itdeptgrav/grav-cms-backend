// routes/soproutes/soproute.js
// All SOP management + bleach routes for CoWork

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Sop = require("../../models/sopmodel/sop_model");
const SopFolder = require("../../models/sopmodel/sop_folder_model");
const Employee = require("../../models/Employee");

const {
    verifyCoworkToken,
    verifyCeoToken,
    verifyCeoOrTL,
    verifyEmployeeToken,
} = require("../../Middlewear/coworkAuth");

// ─────────────────────────────────────────────────────────────────────────────
// FOLDER ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /cowork/sop/folders — list folders
router.get("/folders", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const { role, employeeId } = req.coworkUser;
        let filter = {};
        if (role === "tl") {
            const me = await Employee.findOne({ biometricId: employeeId }, { department: 1 }).lean();
            if (me) filter.department = me.department;
        }
        // employee sees folders of their dept too (for awareness)
        if (role === "employee") {
            const me = await Employee.findOne({ biometricId: employeeId }, { department: 1 }).lean();
            if (me) filter.department = me.department;
        }
        const folders = await SopFolder.find(filter).sort({ createdAt: -1 }).lean();
        res.json({ success: true, folders });
    } catch (e) {
        console.error("[sop/folders/GET]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /cowork/sop/folders — create folder (no approval needed)
router.post("/folders", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
    try {
        const { role, employeeId, name: userName } = req.coworkUser;
        const { name, department } = req.body;

        if (!name || !department) return res.status(400).json({ error: "name and department are required." });

        // TL can only create folder for their own dept
        if (role === "tl") {
            const me = await Employee.findOne({ biometricId: employeeId }, { department: 1 }).lean();
            if (!me || me.department !== department) {
                return res.status(403).json({ error: "TL can only create folders for their own department." });
            }
        }

        const folder = await SopFolder.create({
            name: name.trim(), department: department.trim(),
            createdBy: employeeId, createdByName: userName,
            createdByRole: role === "ceo" ? "ceo" : "tl",
        });

        res.status(201).json({ success: true, folder });
    } catch (e) {
        console.error("[sop/folders/POST]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// DELETE /cowork/sop/folders/:id — delete folder (CEO any, TL own)
router.delete("/folders/:id", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
    try {
        const { role, employeeId } = req.coworkUser;
        const folder = await SopFolder.findById(req.params.id);
        if (!folder) return res.status(404).json({ error: "Folder not found." });

        if (role === "tl" && folder.createdBy !== employeeId) {
            return res.status(403).json({ error: "TL can only delete their own folders." });
        }

        // Move SOPs inside to Uncategorized
        await Sop.updateMany(
            { folderId: folder._id },
            { $set: { folderId: null, folderName: "Uncategorized" } }
        );

        await folder.deleteOne();
        res.json({ success: true, message: "Folder deleted. SOPs moved to Uncategorized." });
    } catch (e) {
        console.error("[sop/folders/DELETE]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// SOP ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /cowork/sop
router.get("/", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const { role, employeeId } = req.coworkUser;
        let filter = {};

        if (role === "tl") {
            const me = await Employee.findOne({ biometricId: employeeId }, { department: 1 }).lean();
            if (!me) return res.status(404).json({ error: "Employee not found." });
            filter.department = me.department;
        } else if (role === "employee") {
            const me = await Employee.findOne({ biometricId: employeeId }, { department: 1 }).lean();
            filter = { department: me?.department, status: "approved" };
        }

        const sops = await Sop.find(filter).sort({ folderName: 1, createdAt: -1 }).lean();
        res.json({ success: true, sops });
    } catch (e) {
        console.error("[sop/GET]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /cowork/sop
router.post("/", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
    try {
        const { role, employeeId, name: userName } = req.coworkUser;
        const { name, points, description, department, folderId } = req.body;

        if (!name || !points || !description || !department) {
            return res.status(400).json({ error: "name, points, description, department are required." });
        }
        if (isNaN(points) || Number(points) < 0.5) {
            return res.status(400).json({ error: "Points must be at least 0.5." });
        }

        if (role === "tl") {
            const me = await Employee.findOne({ biometricId: employeeId }, { department: 1 }).lean();
            if (!me || me.department !== department) {
                return res.status(403).json({ error: "TL can only create SOPs for their own department." });
            }
        }

        // Resolve folder
        let folderName = "Uncategorized";
        let resolvedFolderId = null;
        if (folderId) {
            const folder = await SopFolder.findById(folderId).lean();
            if (folder) { folderName = folder.name; resolvedFolderId = folder._id; }
        }

        const sop = await Sop.create({
            name: name.trim(), points: Number(points),
            description: description.trim(), department: department.trim(),
            folderId: resolvedFolderId, folderName,
            createdBy: employeeId, createdByName: userName,
            createdByRole: role === "ceo" ? "ceo" : "tl",
            status: role === "ceo" ? "approved" : "pending",
            ...(role === "ceo" && { approvedBy: employeeId, approvedByName: userName, approvedAt: new Date() }),
        });

        res.status(201).json({ success: true, sop });
    } catch (e) {
        console.error("[sop/POST]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// PATCH /cowork/sop/:id
router.patch("/:id", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
    try {
        const { role, employeeId } = req.coworkUser;
        const sop = await Sop.findById(req.params.id);
        if (!sop) return res.status(404).json({ error: "SOP not found." });

        if (role === "tl" && sop.createdBy !== employeeId) {
            return res.status(403).json({ error: "TL can only edit their own SOPs." });
        }

        const { name, points, description, department, folderId } = req.body;
        if (name) sop.name = name.trim();
        if (points) sop.points = Number(points);
        if (description) sop.description = description.trim();
        if (department && role === "ceo") sop.department = department.trim();

        // Update folder if changed
        if (folderId !== undefined) {
            if (!folderId) {
                sop.folderId = null; sop.folderName = "Uncategorized";
            } else {
                const folder = await SopFolder.findById(folderId).lean();
                if (folder) { sop.folderId = folder._id; sop.folderName = folder.name; }
            }
        }

        if (role === "tl") {
            sop.status = "pending";
            sop.approvedBy = null; sop.approvedByName = null; sop.approvedAt = null;
        }

        await sop.save();
        res.json({ success: true, sop });
    } catch (e) {
        console.error("[sop/PATCH]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// DELETE /cowork/sop/:id
router.delete("/:id", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
    try {
        const { role, employeeId } = req.coworkUser;
        const sop = await Sop.findById(req.params.id);
        if (!sop) return res.status(404).json({ error: "SOP not found." });

        if (role === "tl" && sop.createdBy !== employeeId) {
            return res.status(403).json({ error: "TL can only delete their own SOPs." });
        }

        await sop.deleteOne();
        res.json({ success: true, message: "SOP deleted." });
    } catch (e) {
        console.error("[sop/DELETE]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// PATCH /cowork/sop/:id/approve
router.patch("/:id/approve", verifyCoworkToken, verifyCeoToken, async (req, res) => {
    try {
        const { employeeId, name } = req.coworkUser;
        const sop = await Sop.findById(req.params.id);
        if (!sop) return res.status(404).json({ error: "SOP not found." });

        sop.status = "approved";
        sop.approvedBy = employeeId; sop.approvedByName = name; sop.approvedAt = new Date();
        await sop.save();

        res.json({ success: true, sop });
    } catch (e) {
        console.error("[sop/approve]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// PATCH /cowork/sop/:id/reject
router.patch("/:id/reject", verifyCoworkToken, verifyCeoToken, async (req, res) => {
    try {
        const sop = await Sop.findById(req.params.id);
        if (!sop) return res.status(404).json({ error: "SOP not found." });

        sop.status = "rejected";
        await sop.save();

        res.json({ success: true, sop });
    } catch (e) {
        console.error("[sop/reject]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /cowork/sop/bleach
router.post("/bleach", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
    try {
        const { role, employeeId: appliedById, name: appliedByName } = req.coworkUser;
        const { targetEmployeeId, sopId, description } = req.body;

        if (!targetEmployeeId || !sopId) {
            return res.status(400).json({ error: "targetEmployeeId and sopId are required." });
        }

        const sop = await Sop.findById(sopId).lean();
        if (!sop) return res.status(404).json({ error: "SOP not found." });
        if (sop.status !== "approved") return res.status(400).json({ error: "Only approved SOPs can be applied." });

        const employee = await Employee.findOne({ biometricId: targetEmployeeId });
        if (!employee) return res.status(404).json({ error: "Employee not found." });

        if (role === "tl") {
            const me = await Employee.findOne({ biometricId: appliedById }, { department: 1 }).lean();
            if (!me || me.department !== employee.department) {
                return res.status(403).json({ error: "TL can only bleach employees in their own department." });
            }
        }

        const today = new Date().toISOString().split("T")[0];
        const year = new Date().getFullYear();

        const bleachEntry = {
            sopId: sop._id, sopName: sop.name,
            folderName: sop.folderName || "Uncategorized",
            points: sop.points,
            description: description?.trim() || sop.description,
            date: today,
            cutBy: appliedById, cutByName: appliedByName,
            cutByRole: role === "ceo" ? "ceo" : "tl",
        };

        const yearIndex = employee.sopPoints.findIndex(sp => sp.year === year);
        if (yearIndex >= 0) {
            employee.sopPoints[yearIndex].bleaches.push(bleachEntry);
            employee.sopPoints[yearIndex].totalDeducted = +(
                employee.sopPoints[yearIndex].totalDeducted + sop.points
            ).toFixed(2);
        } else {
            employee.sopPoints.push({ year, totalDeducted: sop.points, bleaches: [bleachEntry] });
        }

        await employee.save();
        res.status(201).json({ success: true, message: `${sop.points} pts deducted from ${employee.firstName} for "${sop.name}".` });
    } catch (e) {
        console.error("[sop/bleach]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /cowork/sop/bleach/:employeeId
router.get("/bleach/:employeeId", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const { role, employeeId: requesterId } = req.coworkUser;
        const { employeeId } = req.params;

        if (role === "employee" && requesterId !== employeeId) {
            return res.status(403).json({ error: "Employees can only view their own bleach history." });
        }

        const employee = await Employee.findOne(
            { biometricId: employeeId },
            { sopPoints: 1, firstName: 1, lastName: 1, department: 1, biometricId: 1 }
        ).lean();

        if (!employee) return res.status(404).json({ error: "Employee not found." });

        if (role === "tl") {
            const me = await Employee.findOne({ biometricId: requesterId }, { department: 1 }).lean();
            if (!me || me.department !== employee.department) {
                return res.status(403).json({ error: "TL can only view bleach history of their own department." });
            }
        }

        const sopPoints = (employee.sopPoints || []).sort((a, b) => b.year - a.year);
        res.json({
            success: true,
            employeeId: employee.biometricId,
            name: `${employee.firstName} ${employee.lastName}`.trim(),
            department: employee.department,
            sopPoints,
        });
    } catch (e) {
        console.error("[sop/bleach/GET]", e.message);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;