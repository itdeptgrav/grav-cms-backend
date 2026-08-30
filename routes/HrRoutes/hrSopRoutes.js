// routes/HrRoutes/hrSopRoutes.js
const express = require("express");
const router = express.Router();
const Sop = require("../../models/sopmodel/sop_model");
const SopFolder = require("../../models/sopmodel/sop_folder_model");
const Employee = require("../../models/Employee");
const verifyHRToken = require("../../Middlewear/EmployeeAuthMiddlewear");

const HR_DEPT = "hr";

// SOP history. A point deduction costs somebody real money at year end, so
// every one of them is recorded with who applied it and what it was for.
const { recordChange } = require("../../services/changeLog");
const auditSop = (req, entry) =>
    recordChange(req, { departmentSlug: "hr", section: "hr:sop", ...entry });

// GET /api/hr/sop/folders
router.get("/folders", verifyHRToken, async (req, res) => {
    try {
        const folders = await SopFolder.find({ department: HR_DEPT }).sort({ createdAt: -1 }).lean();
        res.json({ success: true, folders });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/hr/sop/folders
router.post("/folders", verifyHRToken, async (req, res) => {
    try {
        const { name, createdByName, createdByRole } = req.body;
        if (!name?.trim()) return res.status(400).json({ error: "Folder name is required." });
        const folder = await SopFolder.create({
            name: name.trim(), department: HR_DEPT,
            createdBy: "", createdByName: createdByName || "HR Manager", createdByRole: createdByRole || "hr_manager",
        });
        await auditSop(req, {
            entity: "sop-folder",
            entityId: String(folder._id),
            entityLabel: folder.name,
            action: "create",
            summary: `Created SOP folder "${folder.name}".`,
            after: { name: folder.name },
        });
        res.status(201).json({ success: true, folder });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/hr/sop/folders/:id
router.delete("/folders/:id", verifyHRToken, async (req, res) => {
    try {
        const folder = await SopFolder.findById(req.params.id);
        if (!folder || folder.department !== HR_DEPT) return res.status(404).json({ error: "Folder not found." });
        const orphaned = await Sop.countDocuments({ folderId: folder._id });
        await Sop.updateMany({ folderId: folder._id }, { $set: { folderId: null, folderName: "Uncategorized" } });
        await folder.deleteOne();

        await auditSop(req, {
            entity: "sop-folder",
            entityId: String(req.params.id),
            entityLabel: folder.name,
            action: "delete",
            summary:
                `Deleted SOP folder "${folder.name}". Its ${orphaned} SOP(s) were kept and moved ` +
                `to Uncategorized rather than deleted with it.`,
            before: { name: folder.name, sopCount: orphaned },
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/hr/sop
router.get("/", verifyHRToken, async (req, res) => {
    try {
        const sops = await Sop.find({ department: HR_DEPT }).sort({ createdAt: -1 }).lean();
        res.json({ success: true, sops });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/hr/sop
router.post("/", verifyHRToken, async (req, res) => {
    try {
        const { name, points, description, folderId, createdByName, createdByRole } = req.body;
        if (!name?.trim() || !points || !description?.trim())
            return res.status(400).json({ error: "name, points, and description are required." });

        let folderName = "Uncategorized", resolvedFolderId = null;
        if (folderId) {
            const folder = await SopFolder.findById(folderId).lean();
            if (folder && folder.department === HR_DEPT) { folderName = folder.name; resolvedFolderId = folder._id; }
        }

        const sop = await Sop.create({
            name: name.trim(), points: Number(points), description: description.trim(),
            department: HR_DEPT, createdBy: "",
            createdByName: createdByName || "HR Manager",
            createdByRole: createdByRole || "hr_manager",
            folderId: resolvedFolderId, folderName, status: "pending",
        });
        await auditSop(req, {
            entity: "sop-deduction",
            entityId: String(sop._id),
            entityLabel: sop.name,
            action: "create",
            summary:
                `Created SOP "${sop.name}" worth ${sop.points} point(s), filed under ${folderName}. ` +
                `It is pending approval and cannot be applied to anybody until it is approved.`,
            after: {
                name: sop.name,
                points: sop.points,
                description: sop.description,
                folderName,
                status: "pending",
            },
        });
        res.status(201).json({ success: true, sop });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/hr/sop/:id
router.patch("/:id", verifyHRToken, async (req, res) => {
    try {
        const sop = await Sop.findById(req.params.id);
        if (!sop || sop.department !== HR_DEPT) return res.status(404).json({ error: "SOP not found." });
        if (sop.status === "approved") return res.status(400).json({ error: "Cannot edit an approved SOP." });

        const before = {
            name: sop.name,
            points: sop.points,
            description: sop.description,
            folderName: sop.folderName,
            status: sop.status,
        };

        const { name, points, description, folderId } = req.body;
        if (name) sop.name = name.trim();
        if (points) sop.points = Number(points);
        if (description) sop.description = description.trim();
        if (folderId !== undefined) {
            if (!folderId) { sop.folderId = null; sop.folderName = "Uncategorized"; }
            else {
                const folder = await SopFolder.findById(folderId).lean();
                if (folder && folder.department === HR_DEPT) { sop.folderId = folder._id; sop.folderName = folder.name; }
            }
        }
        sop.status = "pending";
        await sop.save();

        await auditSop(req, {
            entity: "sop-deduction",
            entityId: String(sop._id),
            entityLabel: sop.name,
            action: "update",
            before,
            after: {
                name: sop.name,
                points: sop.points,
                description: sop.description,
                folderName: sop.folderName,
                status: "pending",
            },
        });
        res.json({ success: true, sop });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/hr/sop/:id
router.delete("/:id", verifyHRToken, async (req, res) => {
    try {
        const sop = await Sop.findById(req.params.id);
        if (!sop || sop.department !== HR_DEPT) return res.status(404).json({ error: "SOP not found." });
        if (sop.status === "approved") return res.status(400).json({ error: "Cannot delete an approved SOP." });
        const removed = { name: sop.name, points: sop.points, folderName: sop.folderName, status: sop.status };
        await sop.deleteOne();

        await auditSop(req, {
            entity: "sop-deduction",
            entityId: String(req.params.id),
            entityLabel: removed.name,
            action: "delete",
            summary:
                `Deleted the ${removed.status} SOP "${removed.name}" (${removed.points} point(s)). ` +
                `Deductions already applied to employees under it are unaffected.`,
            before: removed,
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// EMPLOYEE LIST (for bleach panel)
// GET /api/hr/sop/employees
// ─────────────────────────────────────────────────────────────────────────────
router.get("/employees", verifyHRToken, async (req, res) => {
    try {
        const employees = await Employee.find({ isActive: true })
            .select("firstName lastName biometricId department sopPoints")
            .sort({ firstName: 1 })
            .lean();
        const list = employees.map(e => ({
            _id: e._id,
            employeeId: e.biometricId,
            name: `${e.firstName || ""} ${e.lastName || ""}`.trim(),
            department: e.department || "",
            sopPoints: e.sopPoints || [],
        }));
        res.json({ success: true, employees: list });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// BLEACH HISTORY
// GET /api/hr/sop/bleach/:employeeId
// ─────────────────────────────────────────────────────────────────────────────
router.get("/bleach/:employeeId", verifyHRToken, async (req, res) => {
    try {
        const employee = await Employee.findOne({ biometricId: req.params.employeeId })
            .select("firstName lastName biometricId department sopPoints")
            .lean();
        if (!employee) return res.status(404).json({ error: "Employee not found." });
        res.json({ success: true, sopPoints: employee.sopPoints || [] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// APPLY BLEACH
// POST /api/hr/sop/bleach
// ─────────────────────────────────────────────────────────────────────────────
router.post("/bleach", verifyHRToken, async (req, res) => {
    try {
        const { targetEmployeeId, sopId, manualPoints, manualSopName, description, cutByName, cutByRole } = req.body;
        if (!targetEmployeeId) return res.status(400).json({ error: "targetEmployeeId is required." });
        if (!sopId && !manualPoints) return res.status(400).json({ error: "Either sopId or manualPoints is required." });

        const employee = await Employee.findOne({ biometricId: targetEmployeeId });
        if (!employee) return res.status(404).json({ error: "Employee not found." });

        let finalPoints, finalSopName, finalFolderName;
        if (sopId) {
            const sop = await Sop.findById(sopId).lean();
            if (!sop) return res.status(404).json({ error: "SOP not found." });
            if (sop.status !== "approved") return res.status(400).json({ error: "Only approved SOPs can be applied." });
            finalPoints = sop.points;
            finalSopName = sop.name;
            finalFolderName = sop.folderName || "Uncategorized";
        } else {
            finalPoints = Number(manualPoints);
            finalSopName = manualSopName || "Manual Deduction";
            finalFolderName = "HR";
        }

        const year = new Date().getFullYear();
        const today = new Date().toISOString().split("T")[0];

        const bleachEntry = {
            sopId: sopId || null,
            sopName: finalSopName,
            folderName: finalFolderName,
            points: finalPoints,
            description: description?.trim() || "",
            date: today,
            isCredit: false,
            type: "",
            cutBy: req.user?.employeeId || "",
            cutByName: cutByName || "HR Manager",
            cutByRole: cutByRole || "hr_manager",
            recheck: { status: "none", requestedAt: null, requestNote: "", reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewNote: "" },
        };

        const yearIndex = employee.sopPoints.findIndex(sp => sp.year === year);
        if (yearIndex >= 0) {
            employee.sopPoints[yearIndex].bleaches.push(bleachEntry);
            employee.sopPoints[yearIndex].totalDeducted = +((employee.sopPoints[yearIndex].totalDeducted || 0) + finalPoints).toFixed(2);
        } else {
            employee.sopPoints.push({ year, totalDeducted: finalPoints, bleaches: [bleachEntry] });
        }

        await employee.save();

        // The one entry on this page that costs somebody money. It names the
        // rule, the points, the employee's new running total, and whether the
        // deduction came from an approved SOP or was typed in by hand - the
        // last of those being the part most worth being able to look up.
        const yearTotal = employee.sopPoints.find((sp) => sp.year === year)?.totalDeducted;
        await auditSop(req, {
            entity: "sop-deduction",
            entityId: `${targetEmployeeId}:${today}`,
            entityLabel: `${employee.firstName} ${employee.lastName || ""} (${targetEmployeeId})`.trim(),
            action: "create",
            summary:
                `Deducted ${finalPoints} SOP point(s) from ${employee.firstName} ${employee.lastName || ""} ` +
                `(${targetEmployeeId}) for "${finalSopName}"` +
                `${sopId ? " under an approved SOP" : " as a MANUAL deduction, not tied to any approved SOP"}. ` +
                `Their total deducted for ${year} is now ${yearTotal}.` +
                `${description ? ` Note: ${description.trim()}` : ""}`,
            fields: [
                { path: "points", label: "Points deducted", to: finalPoints, kind: "added" },
                { path: "sopName", label: "Rule", to: finalSopName, kind: "added" },
                { path: "totalDeducted", label: `Total deducted ${year}`, to: yearTotal, kind: "changed" },
            ],
        });

        res.status(201).json({ success: true, message: `${finalPoints} pts deducted from ${employee.firstName} for "${finalSopName}".` });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;