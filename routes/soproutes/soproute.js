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
        const { targetEmployeeId, sopId, description, manualPoints, manualSopName } = req.body;

        if (!targetEmployeeId) {
            return res.status(400).json({ error: "targetEmployeeId is required." });
        }
        if (!sopId && !manualPoints) {
            return res.status(400).json({ error: "Either sopId or manualPoints is required." });
        }

        const sop = sopId ? await Sop.findById(sopId).lean() : null;
        if (sopId && !sop) return res.status(404).json({ error: "SOP not found." });
        if (sopId && sop.status !== "approved") return res.status(400).json({ error: "Only approved SOPs can be applied." });

        // Support manual bleach (task suggestion without SOP)
        const finalPoints = sop ? sop.points : Number(manualPoints);
        const finalSopName = sop ? sop.name : (manualSopName || "Manual Deduction");
        const finalFolderName = sop ? (sop.folderName || "Uncategorized") : "Task Event";

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
            sopId: sop?._id || null,
            sopName: finalSopName,
            folderName: finalFolderName,
            points: finalPoints,
            description: description?.trim() || sop?.description || "",
            date: today,
            cutBy: appliedById, cutByName: appliedByName,
            cutByRole: role === "ceo" ? "ceo" : "tl",
            recheck: { status: "none", requestedAt: null, requestNote: "", reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewNote: "" },
        };

        const yearIndex = employee.sopPoints.findIndex(sp => sp.year === year);
        if (yearIndex >= 0) {
            employee.sopPoints[yearIndex].bleaches.push(bleachEntry);
            employee.sopPoints[yearIndex].totalDeducted = +(
                employee.sopPoints[yearIndex].totalDeducted + finalPoints
            ).toFixed(2);
        } else {
            employee.sopPoints.push({ year, totalDeducted: finalPoints, bleaches: [bleachEntry] });
        }

        await employee.save();

        // Mark this task+event as applied in Firestore to prevent re-showing
        if (req.body.taskId && req.body.eventKey) {
            try {
                const { db } = require("../../config/firebaseAdmin");
                await db.collection("cowork_sop_applied").add({
                    taskId: req.body.taskId,
                    eventKey: req.body.eventKey,
                    employeeId: targetEmployeeId,
                    appliedBy: appliedById,
                    appliedAt: new Date().toISOString(),
                });
            } catch (e) { console.error("[sop_applied]", e.message); }
        }

        res.status(201).json({ success: true, message: `${finalPoints} pts deducted from ${employee.firstName} for "${finalSopName}".` });
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

        const sopPoints = (employee.sopPoints || []).sort((a, b) => b.year - a.year).map(yp => ({
            ...yp,
            bleaches: (yp.bleaches || []).map(b => {
                // Normalize old entries: negative points = credit (old format before isCredit flag)
                if (Number(b.points) < 0) {
                    return { ...b, points: Math.abs(b.points), isCredit: true };
                }
                return b;
            }),
        }));
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /cowork/sop/recheck/pending-list
// Returns employees with pending recheck requests
router.get("/recheck/pending-list", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
    try {
        const { role, employeeId } = req.coworkUser;
        let filter = {};
        if (role === "tl") {
            const me = await Employee.findOne({ biometricId: employeeId }, { department: 1 }).lean();
            if (me) filter.department = me.department;
        }
        const employees = await Employee.find(filter, { biometricId: 1, firstName: 1, lastName: 1, department: 1, sopPoints: 1 }).lean();
        const result = [];
        employees.forEach(emp => {
            const pending = [];
            (emp.sopPoints || []).forEach(yp => {
                (yp.bleaches || []).forEach(b => {
                    if (b.recheck?.status === "pending") {
                        pending.push({ bleachId: b._id, sopName: b.sopName, points: b.points, date: b.date, requestNote: b.recheck.requestNote });
                    }
                });
            });
            if (pending.length > 0) {
                result.push({
                    employeeId: emp.biometricId,
                    name: `${emp.firstName} ${emp.lastName}`.trim(),
                    department: emp.department,
                    pendingCount: pending.length,
                    bleaches: pending,
                });
            }
        });
        res.json({ success: true, list: result });
    } catch (e) {
        console.error("[recheck/pending-list]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /cowork/sop/recheck/pending-count
// Returns count of pending recheck requests for TL (own dept) or CEO (all)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/recheck/pending-count", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
    try {
        const { role, employeeId } = req.coworkUser;
        let filter = {};

        if (role === "tl") {
            const me = await Employee.findOne({ biometricId: employeeId }, { department: 1 }).lean();
            if (me) filter.department = me.department;
        }

        const employees = await Employee.find(filter, { sopPoints: 1 }).lean();
        let count = 0;
        employees.forEach(emp => {
            (emp.sopPoints || []).forEach(yp => {
                (yp.bleaches || []).forEach(b => {
                    if (b.recheck?.status === "pending") count++;
                });
            });
        });

        res.json({ success: true, count });
    } catch (e) {
        console.error("[recheck/pending-count]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /cowork/sop/bleach/:employeeId/:bleachId/recheck
// Employee requests a recheck on a bleach entry
// ─────────────────────────────────────────────────────────────────────────────
router.post("/bleach/:employeeId/:bleachId/recheck", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const { employeeId: requesterId, role } = req.coworkUser;
        const { employeeId, bleachId } = req.params;
        const { requestNote } = req.body;

        // Only the employee themselves can request a recheck
        if (role === "employee" && requesterId !== employeeId) {
            return res.status(403).json({ error: "You can only recheck your own bleaches." });
        }

        const employee = await Employee.findOne({ biometricId: employeeId });
        if (!employee) return res.status(404).json({ error: "Employee not found." });

        // Find the bleach entry across all year records
        let found = false;
        for (const yearRecord of employee.sopPoints) {
            const bleach = yearRecord.bleaches.id(bleachId);
            if (bleach) {
                // Can't recheck if already confirmed (deduction removed)
                if (bleach.recheck?.status === "confirmed") {
                    return res.status(400).json({ error: "This bleach was already confirmed — deduction has been removed." });
                }
                bleach.recheck = {
                    status: "pending",
                    requestedAt: new Date(),
                    requestNote: requestNote?.trim() || "",
                    reviewedBy: null,
                    reviewedByName: null,
                    reviewedAt: null,
                    reviewNote: "",
                };
                found = true;
                break;
            }
        }

        if (!found) return res.status(404).json({ error: "Bleach entry not found." });

        await employee.save();
        res.json({ success: true, message: "Recheck request submitted. Awaiting TL/CEO review." });
    } catch (e) {
        console.error("[sop/recheck/POST]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /cowork/sop/bleach/:employeeId/:bleachId/recheck
// TL/CEO reviews the recheck — confirm (points reversed) or reject (points stay)
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/bleach/:employeeId/:bleachId/recheck", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
    try {
        const { employeeId: reviewerId, name: reviewerName, role } = req.coworkUser;
        const { employeeId, bleachId } = req.params;
        const { action, reviewNote } = req.body; // action: "confirm" | "reject"

        if (!["confirm", "reject"].includes(action)) {
            return res.status(400).json({ error: "action must be 'confirm' or 'reject'." });
        }

        const employee = await Employee.findOne({ biometricId: employeeId });
        if (!employee) return res.status(404).json({ error: "Employee not found." });

        // TL scope check
        if (role === "tl") {
            const me = await Employee.findOne({ biometricId: reviewerId }, { department: 1 }).lean();
            if (!me || me.department !== employee.department) {
                return res.status(403).json({ error: "TL can only review rechecks of their own department." });
            }
        }

        let found = false;
        let bleachPoints = 0;
        let yearIndex = -1;

        for (let i = 0; i < employee.sopPoints.length; i++) {
            const bleach = employee.sopPoints[i].bleaches.id(bleachId);
            if (bleach) {
                if (bleach.recheck?.status !== "pending") {
                    return res.status(400).json({ error: "No pending recheck for this bleach." });
                }

                bleachPoints = bleach.points;
                yearIndex = i;

                bleach.recheck.status = action === "confirm" ? "confirmed" : "rejected";
                bleach.recheck.reviewedBy = reviewerId;
                bleach.recheck.reviewedByName = reviewerName;
                bleach.recheck.reviewedAt = new Date();
                bleach.recheck.reviewNote = reviewNote?.trim() || "";

                // confirm = employee was right = reverse the deduction
                if (action === "confirm") {
                    employee.sopPoints[i].totalDeducted = +(
                        employee.sopPoints[i].totalDeducted - bleachPoints
                    ).toFixed(2);
                    // floor at 0
                    if (employee.sopPoints[i].totalDeducted < 0) employee.sopPoints[i].totalDeducted = 0;
                }

                found = true;
                break;
            }
        }

        if (!found) return res.status(404).json({ error: "Bleach entry not found." });

        await employee.save();

        const msg = action === "confirm"
            ? `Recheck confirmed — ${bleachPoints} pts reversed back to employee.`
            : `Recheck rejected — deduction of ${bleachPoints} pts stands.`;

        res.json({ success: true, message: msg });
    } catch (e) {
        console.error("[sop/recheck/PATCH]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /cowork/sop/task-suggestions/dismiss
// Called when TL/CEO rejects a suggestion — saves to applied collection so it won't reappear
router.post("/task-suggestions/dismiss", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
    try {
        const { employeeId: appliedById } = req.coworkUser;
        const { taskId, eventKey, assigneeId } = req.body;
        if (!taskId || !eventKey) return res.status(400).json({ error: "taskId and eventKey required." });

        const { db } = require("../../config/firebaseAdmin");
        await db.collection("cowork_sop_applied").add({
            taskId, eventKey,
            employeeId: assigneeId || "",
            appliedBy: appliedById,
            action: "rejected",
            appliedAt: new Date().toISOString(),
        });

        res.json({ success: true });
    } catch (e) {
        console.error("[task-suggestions/dismiss]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /cowork/sop/task-suggestions
// Fetches tasks from Firestore that match enabled SOP events
// Returns list of tasks with suggested bleach info for TL/CEO to review
// ─────────────────────────────────────────────────────────────────────────────
router.get("/task-suggestions", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
    try {
        const { role, employeeId } = req.coworkUser;
        const { admin, db } = require("../../config/firebaseAdmin");

        // 1. Load SOP event config from Firestore
        const configSnap = await db.collection("cowork_sop_settings").doc("task_events").get();
        if (!configSnap.exists) return res.json({ success: true, suggestions: [] });

        const config = configSnap.data().events || {};
        const now = new Date();

        // 2. Get TL's department for scoping
        let myDept = null;
        if (role === "tl") {
            const me = await Employee.findOne({ biometricId: employeeId }, { department: 1 }).lean();
            myDept = me?.department || null;
        }

        // 3. Fetch all relevant tasks from Firestore
        let tasksSnap;
        if (role === "ceo") {
            tasksSnap = await db.collection("cowork_tasks").get();
        } else {
            // TL: tasks they assigned OR tasks assigned to their dept employees
            const [s1, s2] = await Promise.all([
                db.collection("cowork_tasks").where("assignedBy", "==", employeeId).get(),
                db.collection("cowork_tasks").where("department", "==", myDept).get(),
            ]);
            const taskMap = {};
            s1.forEach(d => { taskMap[d.id] = { id: d.id, ...d.data() }; });
            s2.forEach(d => { taskMap[d.id] = { id: d.id, ...d.data() }; });
            tasksSnap = { docs: Object.values(taskMap).map(t => ({ id: t.id, data: () => t })) };
        }

        // Load already-applied task+event pairs to exclude them
        const appliedSnap = await db.collection("cowork_sop_applied").get();
        const appliedSet = new Set();
        appliedSnap.forEach(d => {
            const data = d.data();
            appliedSet.add(`${data.taskId}_${data.eventKey}`);
        });

        const suggestions = [];

        tasksSnap.docs.forEach(docSnap => {
            const task = { id: docSnap.id, ...docSnap.data() };
            if (task.isFolder) return; // skip folders

            const assigneeId = (task.assigneeIds || [])[0];
            const assigneeName = task.assigneeNameMap?.[assigneeId] || assigneeId || "Unknown";
            const taskDept = task.department || myDept || "";

            // Helper to push suggestion
            const push = (eventKey, reason) => {
                const ev = config[eventKey];
                if (!ev?.enabled || !ev.points) return;
                if (appliedSet.has(`${task.id}_${eventKey}`)) return; // already applied

                // Role-aware points: CEO applying uses ceo-specific event if available
                // task_rejected_tl → if ceo is applying, use task_rejected_ceo points instead
                let finalPoints = ev.points;
                if (role === "ceo" && eventKey === "task_rejected_tl" && config.task_rejected_ceo?.enabled) {
                    finalPoints = config.task_rejected_ceo.points;
                }
                if (role === "tl" && eventKey === "task_rejected_ceo" && config.task_rejected_tl?.enabled) {
                    finalPoints = config.task_rejected_tl.points;
                }

                suggestions.push({
                    taskId: task.id,
                    taskTitle: task.title || "Untitled Task",
                    taskType: task.isRepeat ? "repeat" : task.isGoal ? "goal" : task.isThirdParty ? "third_party" : task.isSelfAssigned ? "self_assigned" : "regular",
                    eventKey,
                    eventLabel: reason,
                    assigneeId,
                    assigneeName,
                    department: taskDept,
                    suggestedPoints: finalPoints,
                    description: ev.description || reason,
                    assignedBy: task.assignedBy,
                    dueDate: task.dueDate || task.fixedDeadline || task.goalDeadline || null,
                });
            };

            // ── Check each event ──────────────────────────────────────────────────

            // 1. Task overdue (regular, has timer or fixedDeadline)
            if (config.task_overdue?.enabled) {
                const due = task.dueDate || task.fixedDeadline;
                if (due && new Date(due) < now && !["done", "tl_approved", "ceo_approved"].includes(task.status) && !task.isRepeat && !task.isGoal && !task.isThirdParty) {
                    push("task_overdue", "Task Overdue");
                }
            }

            // 2. Task rejected by TL
            if (config.task_rejected_tl?.enabled && task.completionStatus === "tl_rejected") {
                push("task_rejected_tl", "Rejected by Team Lead");
            }

            // 3. Task rejected by CEO
            if (config.task_rejected_ceo?.enabled && task.completionStatus === "ceo_rejected") {
                push("task_rejected_ceo", "Rejected by CEO");
            }

            // 4. Repeat task missed
            if (config.repeat_missed?.enabled && task.isRepeat) {
                const deadlines = task.repeatConfig?.deadlineTimes || (task.deadlineTime ? [task.deadlineTime] : []);
                const today = now.toISOString().split("T")[0];
                const currentHHMM = now.getHours().toString().padStart(2, "0") + ":" + now.getMinutes().toString().padStart(2, "0");
                const submissions = task.repeatSubmissions || {};
                deadlines.forEach(dl => {
                    if (currentHHMM > dl && !submissions[`${today}_${dl}`]) {
                        push("repeat_missed", `Repeat Task Missed (${dl})`);
                    }
                });
            }

            // 5. Repeat task submitted late
            if (config.repeat_late?.enabled && task.isRepeat) {
                const subs = task.repeatSubmissions || {};
                Object.entries(subs).forEach(([key, sub]) => {
                    if (sub.isLate) push("repeat_late", `Repeat Submitted Late (${key})`);
                });
            }

            // 6. Third party overdue
            if (config.third_party_overdue?.enabled && task.isThirdParty) {
                const due = task.fixedDeadline || task.dueDate;
                if (due && new Date(due) < now && task.status !== "done") {
                    push("third_party_overdue", "Third Party Task Overdue");
                }
            }

            // 7. Third party rejected
            if (config.third_party_rejected?.enabled && task.isThirdParty && task.completionStatus === "tl_rejected") {
                push("third_party_rejected", "Third Party Task Rejected");
            }

            // 8. Goal overdue
            if (config.goal_overdue?.enabled && task.isGoal) {
                const due = task.goalDeadline || task.dueDate;
                if (due && new Date(due) < now && task.status !== "done") {
                    push("goal_overdue", "Goal Task Overdue");
                }
            }

            // 9. Self assigned overdue
            if (config.self_assigned_overdue?.enabled && task.isSelfAssigned) {
                const due = task.dueDate || task.fixedDeadline;
                if (due && new Date(due) < now && task.status !== "done") {
                    push("self_assigned_overdue", "Self-Assigned Task Overdue");
                }
            }

            // 10. Extension rejected
            if (config.extension_rejected?.enabled && task.deadlineExtension?.status === "rejected") {
                push("extension_rejected", "Deadline Extension Rejected");
            }

            // 11. Task not started (open too long)
            if (config.task_not_started?.enabled) {
                const days = config.task_not_started.daysThreshold || 2;
                const created = task.createdAt?._seconds ? new Date(task.createdAt._seconds * 1000) : task.createdAt ? new Date(task.createdAt) : null;
                if (created && task.status === "open") {
                    const diffDays = (now - created) / (1000 * 60 * 60 * 24);
                    if (diffDays >= days) push("task_not_started", `Task Not Started (${Math.floor(diffDays)} days)`);
                }
            }
        });

        res.json({ success: true, suggestions });
    } catch (e) {
        console.error("[task-suggestions]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /cowork/sop/goal-credit
// Awards positive points to employee when goal component is completed
// Acts as reverse of bleach — adds credit to sopPoints
// ─────────────────────────────────────────────────────────────────────────────
router.post("/goal-credit", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
    try {
        const { role, employeeId: awardedById, name: awardedByName } = req.coworkUser;
        const { targetEmployeeId, points, componentName, taskTitle, taskId, componentId } = req.body;

        if (!targetEmployeeId) return res.status(400).json({ error: "targetEmployeeId is required." });
        if (!points || points <= 0) return res.status(400).json({ error: "points must be > 0." });

        const employee = await Employee.findOne({ biometricId: targetEmployeeId });
        if (!employee) return res.status(404).json({ error: "Employee not found." });

        const year = new Date().getFullYear();
        const today = new Date().toISOString().split("T")[0];

        const creditEntry = {
            sopId: null,
            sopName: componentName || "Goal Component",
            folderName: taskTitle || "Goal Task",
            points: Math.abs(points), // store as positive
            description: `Goal component completed: ${componentName || ""}`,
            date: today,
            cutBy: awardedById,
            cutByName: awardedByName,
            cutByRole: role === "ceo" ? "ceo" : "tl",
            isCredit: true,
            taskId,
            componentId,
            recheck: { status: "none", requestedAt: null, requestNote: "", reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewNote: "" },
        };

        const yearIndex = employee.sopPoints.findIndex(sp => sp.year === year);
        if (yearIndex >= 0) {
            employee.sopPoints[yearIndex].bleaches.push(creditEntry);
            // Credit reduces totalDeducted (floor at 0 or allow negative for net positive)
            employee.sopPoints[yearIndex].totalDeducted = +(
                employee.sopPoints[yearIndex].totalDeducted - Math.abs(points)
            ).toFixed(2);
        } else {
            employee.sopPoints.push({ year, totalDeducted: -Math.abs(points), bleaches: [creditEntry] });
        }

        await employee.save();
        res.json({ success: true, message: `+${points} pts credited to ${employee.firstName} for "${componentName}".` });
    } catch (e) {
        console.error("[goal-credit]", e.message);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;