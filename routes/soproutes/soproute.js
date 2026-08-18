// routes/soproutes/soproute.js
// All SOP management + bleach routes for CoWork

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Sop = require("../../models/sopmodel/sop_model");
const SopFolder = require("../../models/sopmodel/sop_folder_model");
const Employee = require("../../models/Employee");
const Policy = require("../../models/HR_Models/Policy");
const C4Config = require("../../models/HR_Models/C4Config");
const c1Svc = require("../../services/c1Service");
const { db } = require("../../config/firebaseAdmin");


const {
    verifyCoworkToken,
    verifyCeoToken,
    verifyCeoOrTL,
    verifyEmployeeToken,
} = require("../../Middlewear/coworkAuth");

const admin = require("firebase-admin");
const { v4: _nuuid } = require("uuid");
const _socket = require("../../config/socketInstance");

/**
 * Notify — the same three steps `_notify` takes in `taskForward.js`.
 *
 * ## Nothing in this file told anybody anything, and this is the file that
 * ## moves people's scores
 *
 * A bleach takes points off somebody's SOP score. Until now it was applied
 * silently: the person found out by opening `/score` and noticing a number had
 * changed, if they noticed at all. A deduction nobody is told about cannot be
 * disputed, which makes the recheck flow below unreachable in practice for
 * anyone who is not already checking their score daily.
 *
 * Failures are logged and swallowed. A notification that cannot be written must
 * never roll back a deduction that has already been saved to Mongo — the
 * employee record is the source of truth and it is committed by this point.
 */
async function _notify({ recipientIds, type, title, body, data, senderId, senderName }) {
    const ids = (recipientIds || []).filter(Boolean);
    if (!ids.length) return;
    try {
        const batch = db.batch();
        ids.forEach(id => {
            batch.set(db.collection("cowork_notifications").doc(_nuuid()), {
                recipientEmployeeId: id, type, title, body,
                data: data || {}, read: false,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        });
        await batch.commit();
        _socket.emitToMany(ids, "new_notification", { type, title, body, data });
        setImmediate(() => {
            try {
                const { sendPushToEmployees } = require("../../services/fcmPush.service");
                sendPushToEmployees(ids, title, body, { type, ...(data || {}) }).catch(() => { });
            } catch (_) { }
        });
    } catch (e) { console.error("[sop _notify]", e.message); }
}

/**
 * The primary manager's biometricId, for routing a dispute upward.
 *
 * **`primaryManager` is a SUB-DOCUMENT, not an id.** The schema is
 * `{ managerId, managerName }` (`models/Employee.js`), and every other route in
 * this codebase reads `primaryManager.managerId` — `employeeAuth.js:396`,
 * `leaveRoutes.js:411`. These C3 helpers read the object itself, which made
 * `findById` look up nothing and `countDocuments` match nothing.
 *
 * That one mistake broke all four C3 acts: nobody could write a rule (the
 * manager test was always false), a written rule had no named approver, nobody
 * could approve or apply one, and the disputes queue was always empty.
 */
async function _managerIdOf(employee) {
    try {
        const managerId = employee?.primaryManager?.managerId;
        if (!managerId) return null;
        const mgr = await Employee.findById(managerId, { biometricId: 1 }).lean();
        return mgr?.biometricId || null;
    } catch (_) { return null; }
}

/** The same lookup, from a biometricId rather than a loaded document. */
async function _managerIdFor(biometricId) {
    if (!biometricId) return null;
    const emp = await Employee.findOne({ biometricId }, { primaryManager: 1 }).lean();
    return emp ? _managerIdOf(emp) : null;
}

/**
 * May this caller decide things for that person?
 *
 * **The reporting line, not a role.** A conduct rule is written by a manager
 * and approved by THEIR manager; a breach is applied by the employee's OWN
 * manager. Both questions are the same question — "am I the person one step
 * above them" — and it is asked of the line rather than of a job title, so a
 * team lead cannot rule on somebody who does not report to them and a manager
 * two departments away cannot either.
 *
 * The CEO passes because the CEO is above everybody by construction, and an
 * administrator passes because the line cannot always answer: somebody at the
 * top has nobody above them, and a named approver can leave. Without that,
 * rules written by the most senior manager could never be approved by anyone.
 */
async function _mayDecideFor(caller, subjectBiometricId) {
    if (!caller) return false;
    if (caller.role === "ceo" || caller.role === "admin") return true;
    if (!subjectBiometricId) return false;
    if (caller.employeeId === subjectBiometricId) return false; /* Never yourself. */
    return (await _managerIdFor(subjectBiometricId)) === caller.employeeId;
}

/**
 * Does anybody report to this person?
 *
 * **A rule is written by a manager, and a manager is somebody with reports** —
 * not somebody with a particular job title. The old gate was role-based, which
 * both excluded managers who are not team leads and let a team lead write rules
 * for a department they have nothing to do with.
 */
async function _isManager(biometricId) {
    if (!biometricId) return false;
    const me = await Employee.findOne({ biometricId }, { _id: 1 }).lean();
    if (!me) return false;
    /* `primaryManager.managerId`, not `primaryManager` — see `_managerIdOf`.
       Matching the sub-document against an ObjectId found nobody, so this
       answered false for every manager in the company and only the CEO and
       administrators could write a conduct rule. */
    return (
        (await Employee.countDocuments({ "primaryManager.managerId": me._id })) > 0
    );
}

/** What a breach costs, preferring the percentage over the legacy point count. */
function _costOf(sop) {
    const pct = Number(sop?.percent);
    if (Number.isFinite(pct) && pct > 0) return pct;
    return Number(sop?.points) || 0;
}

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

// POST /cowork/sop/folders — create folder
router.post("/folders", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
    try {
        const { role, employeeId, name: userName } = req.coworkUser;
        const { name, department } = req.body;

        if (!name || !department) return res.status(400).json({ error: "name and department are required." });

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

// DELETE /cowork/sop/folders/:id
router.delete("/folders/:id", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
    try {
        const { role, employeeId } = req.coworkUser;
        const folder = await SopFolder.findById(req.params.id);
        if (!folder) return res.status(404).json({ error: "Folder not found." });

        if (role === "tl" && folder.createdBy !== employeeId) {
            return res.status(403).json({ error: "TL can only delete their own folders." });
        }

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
// SEVERITY → DEDUCTION POINTS (PDF §3.4 — C3 Conduct table)
// Server is the source of truth: when a severity tag is sent, its points
// value overrides anything the client sent, so the mapping can't drift.
// ─────────────────────────────────────────────────────────────────────────────
const VALID_SEVERITIES = ["minor", "moderate", "serious", "falsification", "idle_pool"];


// ─────────────────────────────────────────────────────────────────────────────
// SOP ROUTES
// ────────────────────────────────────────────────────────────────────────────
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

// GET /cowork/sop/all-categories — every SOP/rule across C1-C4, for the
// "All SOPs" browse view. Combines: custom Sop catalog entries (always C3
// when applied), HR attendance Policy entries (always C4), and the
// system-level rules that aren't stored as a Sop/Policy document at all
// (C1's deadline/extension/rework deductions, the Idle Pool deduction, and
// C4's late/absence/early-departure base rates) — pulled live from their
// actual config sources so the numbers shown here can't drift from what's
// really applied.
router.get("/all-categories", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const [sops, policies, c1Cfg, sopSettingsSnap, c4Cfg] = await Promise.all([
            Sop.find({ status: "approved" }).sort({ department: 1, name: 1 }).lean(),
            Policy.find({ isActive: true }).sort({ name: 1 }).lean(),
            c1Svc.getC1Config(),
            db.collection("cowork_sop_settings").doc("task_events").get(),
            C4Config.getSingleton(),
        ]);

        const timerCfg = sopSettingsSnap.exists ? sopSettingsSnap.data() : {};
        const timerMinPct = Number(timerCfg.timerMinDailyPct) || 0;
        const timerTargetDesc = timerMinPct > 0
            ? `${timerMinPct}% of that day's available hours (your online-to-close window, minus breaks)`
            : `${Number(timerCfg.timerMinDailyHrs) || 0}h`;

        const c1 = [
            { name: "Missed Deadline", points: c1Cfg.c1DeadlineDeduction, description: "Task submitted after its deadline — score decays per business hour late.", source: "system" },
            { name: "Extension Filed", points: c1Cfg.c1ExtensionDeduction, description: "Deadline extension requested after 70% of allocated time had elapsed.", source: "system" },
            { name: "Rework / Incomplete Submission", points: c1Cfg.c1ReworkDeduction, description: "Submission returned as incomplete — deducted per return.", source: "system" },
        ];

        // No C2-category deduction/reward rule exists yet — goal scoring is
        // purely points-earned vs points-assigned, nothing else feeds it.
        const c2 = [];

        const c3 = [
            ...sops.map(s => ({
                name: s.name, points: s.points, severity: s.severity || null,
                description: s.description, department: s.department,
                folder: s.folderName || "Uncategorized", source: "custom",
            })),
            {
                name: "Idle Pool Deduction",
                points: Number(timerCfg.timerDeficitPoints) || 0,
                description: `Fires once accumulated work-hour shortfall reaches ${Number(timerCfg.timerDeficitThresholdHrs) || 0}h (daily target: ${timerTargetDesc}).`,
                source: "system",
            },
        ];

        const c4 = [
            ...policies.map(p => ({
                name: p.name, points: p.points, bleachType: p.bleachType,
                triggerKey: p.triggerKey, thresholdMins: p.thresholdMins,
                description: p.description, scope: p.scope,
                department: p.departmentName || null, source: "policy",
            })),
            { name: "Late Arrival", points: Number(c4Cfg.lateArrivalPoints) || 0, description: `Auto-detected from attendance — more than ${Number(c4Cfg.lateThresholdMins) || 0} min late.`, source: "system" },
            { name: "Absence", points: Number(c4Cfg.absencePoints) || 0, description: "Auto-detected from attendance — marked absent for the day.", source: "system" },
            { name: "Early Departure", points: Number(c4Cfg.earlyDeparturePoints) || 0, description: `Auto-detected from attendance — left more than ${Number(c4Cfg.earlyThresholdMins) || 0} min early.`, source: "system" },
        ];

        res.json({ success: true, c1, c2, c3, c4 });
    } catch (e) {
        console.error("[sop/all-categories/GET]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /cowork/sop
router.post("/", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const { role, employeeId, name: userName } = req.coworkUser;
        const { name, description, department, folderId, severity } = req.body;
        /**
         * **A percentage, not a point count.** C1, C2 and C4 are percentages
         * and C3 is subtracted from their average, so a rule's cost is "five
         * percent off", and `percent` is what a caller should send. `points`
         * is still accepted so an older client keeps working, and both are
         * written so that every reader — including quarters already scored —
         * finds what it expects.
         */
        const cost = Number(req.body.percent ?? req.body.points);

        /* Written by a manager — somebody with reports — rather than by a job
           title. The CEO and an administrator may write one too. */
        if (
            role !== "ceo" &&
            role !== "admin" &&
            !(await _isManager(employeeId))
        ) {
            return res.status(403).json({
                error: "Only a manager can write a conduct rule — it is approved by your own manager before it applies to anybody.",
            });
        }

        if (severity && !VALID_SEVERITIES.includes(severity)) {
            return res.status(400).json({ error: "Invalid severity tag." });
        }

        if (!name || !cost || !description || !department) {
            return res.status(400).json({ error: "name, percent, description, department are required." });
        }
        if (isNaN(cost) || cost <= 0) {
            return res.status(400).json({ error: "The cut must be a percentage above zero." });
        }
        if (cost > 100) {
            return res.status(400).json({ error: "A single rule cannot cut more than 100%." });
        }

        if (role === "tl") {
            const me = await Employee.findOne({ biometricId: employeeId }, { department: 1 }).lean();
            if (!me || me.department !== department) {
                return res.status(403).json({ error: "TL can only create SOPs for their own department." });
            }
        }

        let folderName = "Uncategorized";
        let resolvedFolderId = null;
        if (folderId) {
            const folder = await SopFolder.findById(folderId).lean();
            if (folder) { folderName = folder.name; resolvedFolderId = folder._id; }
        }

        /**
         * **The approver is the writer's own primary manager, named now.**
         *
         * Stamped at creation rather than looked up when somebody opens the
         * queue, so the decision belongs to one person who can be told about
         * it — and so a reorganisation months later cannot quietly move a
         * pending rule to somebody who was never asked.
         *
         * Nobody above them means nobody in the line can approve it, and it
         * waits for an administrator instead of being approved by default. A
         * rule that takes points off people is not something to nod through
         * because its author happens to sit at the top.
         */
        const approverId = await _managerIdFor(employeeId);
        let approverName = null;
        if (approverId) {
            const mgr = await Employee.findOne({ biometricId: approverId }, { firstName: 1, lastName: 1 }).lean();
            approverName = mgr ? `${mgr.firstName || ""} ${mgr.lastName || ""}`.trim() : null;
        }

        const sop = await Sop.create({
            name: name.trim(),
            percent: cost, points: cost,
            severity: severity || null,
            description: description.trim(), department: department.trim(), folderId: resolvedFolderId, folderName,
            createdBy: employeeId, createdByName: userName,
            createdByRole: role === "ceo" ? "ceo" : "tl",
            /* Always pending — including for the CEO. The rule that a conduct
               policy is reviewed by somebody other than its author is the whole
               point of having an approval step, and self-approval was how that
               became a formality. An administrator clears the CEO's. */
            status: "pending",
            approverId, approverName,
        });

        /* A queue nobody is told about is a queue that sits. */
        if (approverId) {
            await _notify({
                recipientIds: [approverId],
                type: "sop_approval_requested",
                title: `📋 Conduct rule to approve · ${cost}%`,
                body: `${userName} wrote "${sop.name}" for ${sop.department} — a ${cost}% cut when it is breached. It does not apply to anybody until you approve it.`,
                data: { sopId: String(sop._id), percent: cost },
                senderId: employeeId,
                senderName: userName,
            });
        }

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

        const { name, points, description, department, folderId, severity } = req.body;
        if (name) sop.name = name.trim();
        if (severity !== undefined) {
            if (severity && !VALID_SEVERITIES.includes(severity)) {
                return res.status(400).json({ error: "Invalid severity tag." });
            }
            sop.severity = severity || null;
        }
        if (points) sop.points = Number(points); if (description) sop.description = description.trim();
        if (department && role === "ceo") sop.department = department.trim();

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
/**
 * **Decided by the writer's own primary manager — not by role.**
 *
 * This was CEO-only, which made every conduct rule in the company wait on one
 * person and told a manager nothing about the rules their own team lead was
 * writing. The line already answers "who is accountable for this person's
 * judgement": it is the manager one step above them.
 *
 * An administrator may also decide, because the line runs out at the top and a
 * named approver can leave — see `_mayDecideFor`. Nobody approves their own,
 * whatever their role.
 */
async function _decideSop(req, res, decision) {
    const { employeeId, name, role } = req.coworkUser;
    const sop = await Sop.findById(req.params.id);
    if (!sop) return res.status(404).json({ error: "SOP not found." });
    if (sop.status !== "pending") {
        return res.status(400).json({ error: `This rule was already ${sop.status}.` });
    }
    if (sop.createdBy === employeeId) {
        return res.status(403).json({ error: "You cannot approve a rule you wrote yourself." });
    }

    const named = sop.approverId && sop.approverId === employeeId;
    const allowed = named || (await _mayDecideFor(req.coworkUser, sop.createdBy));
    if (!allowed) {
        return res.status(403).json({
            error: "Only the author's own manager, or an administrator, can decide this rule.",
        });
    }

    sop.status = decision === "approve" ? "approved" : "rejected";
    if (decision === "approve") {
        sop.approvedBy = employeeId;
        sop.approvedByName = name;
        sop.approvedAt = new Date();
    } else {
        sop.rejectedReason = String(req.body?.reason || "").trim();
    }
    await sop.save();

    /* The author hears either way. A rule that was quietly rejected is one
       somebody keeps expecting to be able to apply. */
    await _notify({
        recipientIds: [sop.createdBy].filter((id) => id && id !== employeeId),
        type: decision === "approve" ? "sop_approved" : "sop_rejected",
        title: decision === "approve" ? `✅ Rule approved · ${sop.name}` : `❌ Rule rejected · ${sop.name}`,
        body:
            decision === "approve"
                ? `${name} approved "${sop.name}". It can now be applied, and cuts ${_costOf(sop)}% when it is.`
                : `${name} rejected "${sop.name}".${sop.rejectedReason ? ` They said: ${sop.rejectedReason}` : ""}`,
        data: { sopId: String(sop._id) },
        senderId: employeeId,
        senderName: name,
    });

    res.json({ success: true, sop });
    void role;
}

router.patch("/:id/approve", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        await _decideSop(req, res, "approve");
    } catch (e) {
        console.error("[sop/approve]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// PATCH /cowork/sop/:id/reject
router.patch("/:id/reject", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        await _decideSop(req, res, "reject");
    } catch (e) {
        console.error("[sop/reject]", e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * GET /cowork/sop/pending-approvals — the rules waiting on THIS person.
 *
 * Addressed rather than filtered on the client: a list every senior person can
 * see is a list nobody owns, and the decision here belongs to exactly one
 * manager. An administrator sees the ones the line cannot answer — the rules
 * whose author has nobody above them — plus their own.
 */
router.get("/pending-approvals", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const { employeeId, role } = req.coworkUser;
        const mine = await Sop.find({ status: "pending", approverId: employeeId })
            .sort({ createdAt: -1 })
            .lean();
        const orphaned =
            role === "ceo" || role === "admin"
                ? await Sop.find({ status: "pending", $or: [{ approverId: null }, { approverId: "" }] })
                      .sort({ createdAt: -1 })
                      .lean()
                : [];
        res.json({ success: true, sops: [...mine, ...orphaned] });
    } catch (e) {
        console.error("[sop/pending-approvals]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /cowork/sop/bleach
router.post("/bleach", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
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

        const finalPoints = sop ? _costOf(sop) : Number(manualPoints);
        const finalSopName = sop ? sop.name : (manualSopName || "Manual Deduction");
        const finalFolderName = sop ? (sop.folderName || "Uncategorized") : "Task Event";

        const employee = await Employee.findOne({ biometricId: targetEmployeeId });
        if (!employee) return res.status(404).json({ error: "Employee not found." });

        /**
         * **Their own manager, or an administrator.**
         *
         * It was any team lead in the same department, which let somebody who
         * has never worked with a person take points off their record. Conduct
         * is a judgement about how somebody works, and the person accountable
         * for that judgement is the one they report to.
         *
         * `taskId` marks an entry the ENGINE raised from a task event rather
         * than a person deciding — that path has no manager to check and is
         * left to the existing role gate.
         */
        if (!req.body.taskId) {
            const may = await _mayDecideFor(req.coworkUser, targetEmployeeId);
            if (!may) {
                return res.status(403).json({
                    error: "Only their own primary manager, or an administrator, can apply a conduct rule to this person.",
                });
            }
        }
        void role;

        const today = new Date().toISOString().split("T")[0];
        const year = new Date().getFullYear();

        const bleachEntry = {
            sopId: sop?._id || null,
            sopName: finalSopName,
            folderName: finalFolderName,
            points: finalPoints,
            description: description?.trim() || sop?.description || "",
            date: today,
            cutBy: appliedById,
            cutByName: appliedByName,
            cutByRole: role === "ceo" ? "ceo" : "tl",
            type: "C3",
            bleachType: "credit", // SOP violation — adds to penalty score
            isCredit: false,
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

        // ── Tell the person whose score just moved ──────────────────────────
        // The single most important notification in the product: points have
        // been taken off somebody's record by somebody else. It names the rule,
        // the amount, who applied it and their reason, and it says how to
        // dispute it — because a deduction you are not told about is one you
        // cannot contest, and the recheck flow below exists precisely so you
        // can.
        await _notify({
            recipientIds: [targetEmployeeId],
            type: "sop_bleach_applied",
            title: `⚠️ ${finalPoints} pts deducted · ${finalSopName}`,
            body: `${appliedByName} applied "${finalSopName}" (${finalFolderName}) to your record for ${finalPoints} pts.${bleachEntry.description ? ` Reason: ${bleachEntry.description}` : ""} If you think this is wrong, ask for a recheck from your score.`,
            data: {
                employeeId: targetEmployeeId,
                sopName: finalSopName,
                folderName: finalFolderName,
                points: finalPoints,
                taskId: req.body.taskId || null,
            },
            senderId: appliedById,
            senderName: appliedByName,
        });

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

/**
 * Whose disputes does this person settle?
 *
 * **The people who report to them, and nobody else.** The two recheck queues
 * below used to be addressed by role — CEO or team lead, a lead seeing their
 * whole department — while the decision itself is gated by `_mayDecideFor`,
 * which asks the reporting line. The two disagreed in both directions: a
 * manager who is not a lead could decide a dispute they could never see, and a
 * lead saw disputes belonging to people who do not report to them and would be
 * refused on submitting. A queue you cannot act on is worse than no queue.
 *
 * Returns `null` for "everybody" — administrators and the CEO, who stand in
 * where the line runs out.
 */
async function _subjectFilterFor(caller) {
    if (caller.role === "ceo" || caller.role === "admin") return null;
    const me = await Employee.findOne({ biometricId: caller.employeeId }, { _id: 1 }).lean();
    if (!me) return { biometricId: { $in: [] } };
    /* The sub-document's id — see `_managerIdOf`. Matching `primaryManager`
       itself found nobody, so a manager's disputes queue was always empty. */
    return { "primaryManager.managerId": me._id };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /cowork/sop/recheck/pending-list
router.get("/recheck/pending-list", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const filter = (await _subjectFilterFor(req.coworkUser)) || {};
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
router.get("/recheck/pending-count", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        /* Same audience as the list above — the badge and the queue it opens
           must never disagree about how many there are. */
        const filter = (await _subjectFilterFor(req.coworkUser)) || {};
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

// POST /cowork/sop/bleach/:employeeId/:bleachId/recheck
router.post("/bleach/:employeeId/:bleachId/recheck", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const { employeeId: requesterId, role } = req.coworkUser;
        const { employeeId, bleachId } = req.params;
        const { requestNote } = req.body;

        if (role === "employee" && requesterId !== employeeId) {
            return res.status(403).json({ error: "You can only recheck your own bleaches." });
        }

        const employee = await Employee.findOne({ biometricId: employeeId });
        if (!employee) return res.status(404).json({ error: "Employee not found." });

        let found = false;
        // Captured for the notification below — the entry is reached only
        // inside this loop, and the notification has to name what is being
        // disputed rather than "a deduction".
        let bleachCutBy = null;
        let bleachSopName = "";
        let bleachPointsForNote = 0;
        for (const yearRecord of employee.sopPoints) {
            const bleach = yearRecord.bleaches.id(bleachId);
            if (bleach) {
                if (bleach.recheck?.status === "confirmed") {
                    return res.status(400).json({ error: "This bleach was already confirmed — deduction has been removed." });
                }
                bleachCutBy = bleach.cutBy || null;
                bleachSopName = bleach.sopName || "a deduction";
                bleachPointsForNote = bleach.points || 0;
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

        // A dispute waiting in a list nobody is told about is a dispute that
        // sits there. Routed to the person who APPLIED the deduction and to the
        // employee's primary manager — the two people entitled to decide it —
        // rather than broadcast to every TL.
        const managerId = await _managerIdOf(employee);
        await _notify({
            recipientIds: [...new Set([bleachCutBy, managerId].filter(id => id && id !== requesterId))],
            type: "sop_recheck_requested",
            title: "🔍 Recheck requested",
            body: `${employee.firstName || employeeId} asked for a recheck of the ${bleachPointsForNote} pt deduction "${bleachSopName}".${requestNote?.trim() ? ` They said: ${requestNote.trim()}` : ""}`,
            data: { employeeId, bleachId, sopName: bleachSopName, points: bleachPointsForNote },
            senderId: requesterId,
            senderName: employee.firstName || employeeId,
        });

        res.json({ success: true, message: "Recheck request submitted. Awaiting TL/CEO review." });
    } catch (e) {
        console.error("[sop/recheck/POST]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// PATCH /cowork/sop/bleach/:employeeId/:bleachId/recheck
/* `verifyEmployeeToken` rather than `verifyCeoOrTL`: `_mayDecideFor` below is
   the real gate, and the role middleware in front of it turned away the exact
   people it names — a primary manager who holds no lead title. */
router.patch("/bleach/:employeeId/:bleachId/recheck", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const { employeeId: reviewerId, name: reviewerName, role } = req.coworkUser;
        const { employeeId, bleachId } = req.params;
        const { action, reviewNote } = req.body;

        if (!["confirm", "reject"].includes(action)) {
            return res.status(400).json({ error: "action must be 'confirm' or 'reject'." });
        }

        const employee = await Employee.findOne({ biometricId: employeeId });
        if (!employee) return res.status(404).json({ error: "Employee not found." });

        /* The same line that applies a rule decides a dispute about it — their
           own primary manager, or an administrator. A department-wide gate let
           somebody uninvolved settle an argument about a colleague's record. */
        if (!(await _mayDecideFor(req.coworkUser, employeeId))) {
            return res.status(403).json({
                error: "Only their own primary manager, or an administrator, can decide this recheck.",
            });
        }
        void role;
        void reviewerId;

        let found = false;
        let bleachPoints = 0;
        let bleachSopName = "";

        for (let i = 0; i < employee.sopPoints.length; i++) {
            const bleach = employee.sopPoints[i].bleaches.id(bleachId);
            if (bleach) {
                if (bleach.recheck?.status !== "pending") {
                    return res.status(400).json({ error: "No pending recheck for this bleach." });
                }

                bleachPoints = bleach.points;
                bleachSopName = bleach.sopName || "a deduction";

                bleach.recheck.status = action === "confirm" ? "confirmed" : "rejected";
                bleach.recheck.reviewedBy = reviewerId;
                bleach.recheck.reviewedByName = reviewerName;
                bleach.recheck.reviewedAt = new Date();
                bleach.recheck.reviewNote = reviewNote?.trim() || "";

                if (action === "confirm") {
                    employee.sopPoints[i].totalDeducted = +(
                        employee.sopPoints[i].totalDeducted - bleachPoints
                    ).toFixed(2);
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

        // The person who raised the dispute is the one waiting on the answer,
        // and it was the one thing this route never sent. Both outcomes are
        // told, and a rejection carries the reviewer's note: "your dispute was
        // refused" without a reason is the worst version of this message.
        await _notify({
            recipientIds: [employeeId],
            type: action === "confirm" ? "sop_recheck_confirmed" : "sop_recheck_rejected",
            title: action === "confirm" ? "✅ Deduction reversed" : "❌ Recheck rejected",
            body: action === "confirm"
                ? `${reviewerName} agreed with your recheck of "${bleachSopName}". The ${bleachPoints} pts have been put back on your score.${reviewNote?.trim() ? ` They said: ${reviewNote.trim()}` : ""}`
                : `${reviewerName} reviewed your recheck of "${bleachSopName}" and the ${bleachPoints} pt deduction stands.${reviewNote?.trim() ? ` Reason: ${reviewNote.trim()}` : ""}`,
            data: { employeeId, bleachId, sopName: bleachSopName, points: bleachPoints, action },
            senderId: reviewerId,
            senderName: reviewerName,
        });

        res.json({ success: true, message: msg });
    } catch (e) {
        console.error("[sop/recheck/PATCH]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /cowork/sop/task-suggestions/dismiss
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
router.get("/task-suggestions", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
    try {
        const { role, employeeId } = req.coworkUser;
        const { admin, db } = require("../../config/firebaseAdmin");

        const configSnap = await db.collection("cowork_sop_settings").doc("task_events").get();
        if (!configSnap.exists) return res.json({ success: true, suggestions: [] });

        const config = configSnap.data().events || {};
        const now = new Date();

        let myDept = null;
        if (role === "tl") {
            const me = await Employee.findOne({ biometricId: employeeId }, { department: 1 }).lean();
            myDept = me?.department || null;
        }

        let tasksSnap;
        if (role === "ceo") {
            tasksSnap = await db.collection("cowork_tasks").get();
        } else {
            const [s1, s2] = await Promise.all([
                db.collection("cowork_tasks").where("assignedBy", "==", employeeId).get(),
                db.collection("cowork_tasks").where("department", "==", myDept).get(),
            ]);
            const taskMap = {};
            s1.forEach(d => { taskMap[d.id] = { id: d.id, ...d.data() }; });
            s2.forEach(d => { taskMap[d.id] = { id: d.id, ...d.data() }; });
            tasksSnap = { docs: Object.values(taskMap).map(t => ({ id: t.id, data: () => t })) };
        }

        const appliedSnap = await db.collection("cowork_sop_applied").get();
        const appliedSet = new Set();
        appliedSnap.forEach(d => {
            const data = d.data();
            appliedSet.add(`${data.taskId}_${data.eventKey}`);
        });

        const suggestions = [];

        tasksSnap.docs.forEach(docSnap => {
            const task = { id: docSnap.id, ...docSnap.data() };
            if (task.isFolder) return;

            const assigneeId = (task.assigneeIds || [])[0];
            const assigneeName = task.assigneeNameMap?.[assigneeId] || assigneeId || "Unknown";
            const taskDept = task.department || myDept || "";

            const push = (eventKey, reason) => {
                const ev = config[eventKey];
                if (!ev?.enabled || !ev.points) return;
                if (appliedSet.has(`${task.id}_${eventKey}`)) return;

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

            if (config.task_overdue?.enabled) {
                const due = task.dueDate || task.fixedDeadline;
                if (due && new Date(due) < now && !["done", "tl_approved", "ceo_approved"].includes(task.status) && !task.isRepeat && !task.isGoal && !task.isThirdParty) {
                    push("task_overdue", "Task Overdue");
                }
            }

            if (config.task_rejected_tl?.enabled && task.completionStatus === "tl_rejected") {
                push("task_rejected_tl", "Rejected by Team Lead");
            }

            if (config.task_rejected_ceo?.enabled && task.completionStatus === "ceo_rejected") {
                push("task_rejected_ceo", "Rejected by CEO");
            }

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

            if (config.repeat_late?.enabled && task.isRepeat) {
                const subs = task.repeatSubmissions || {};
                Object.entries(subs).forEach(([key, sub]) => {
                    if (sub.isLate) push("repeat_late", `Repeat Submitted Late (${key})`);
                });
            }

            if (config.third_party_overdue?.enabled && task.isThirdParty) {
                const due = task.fixedDeadline || task.dueDate;
                if (due && new Date(due) < now && task.status !== "done") {
                    push("third_party_overdue", "Third Party Task Overdue");
                }
            }

            if (config.third_party_rejected?.enabled && task.isThirdParty && task.completionStatus === "tl_rejected") {
                push("third_party_rejected", "Third Party Task Rejected");
            }

            if (config.goal_overdue?.enabled && task.isGoal) {
                const due = task.goalDeadline || task.dueDate;
                if (due && new Date(due) < now && task.status !== "done") {
                    push("goal_overdue", "Goal Task Overdue");
                }
            }

            if (config.self_assigned_overdue?.enabled && task.isSelfAssigned) {
                const due = task.dueDate || task.fixedDeadline;
                if (due && new Date(due) < now && task.status !== "done") {
                    push("self_assigned_overdue", "Self-Assigned Task Overdue");
                }
            }

            if (config.extension_rejected?.enabled && task.deadlineExtension?.status === "rejected") {
                push("extension_rejected", "Deadline Extension Rejected");
            }

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
//
// Deducts points from employee's sopPoints.totalDeducted when a goal node is
// approved on-time (submitted BEFORE its deadline). Since lower totalDeducted
// = better performance, subtracting points here is a REWARD.
//
// Flow:
//   1. Sender (TL/CEO) clicks Approve on the submitted report
//   2. Frontend calls /goal-credit with { submittedAt, deadline, points, ... }
//   3. Backend checks: submittedAt <= deadline
//      → YES  → deduct points from totalDeducted (reward employee)
//      → NO   → return skipped:true, no change to employee record
//
// The credit entry is stored in bleaches with isCredit:true for history display.
// ─────────────────────────────────────────────────────────────────────────────
// Was `verifyCeoOrTL`, which refused anyone whose stored role is not literally
// "ceo" or "tl". The person who approves a goal step is the head OF THAT GOAL —
// the one who assigned it — and a manager here is a reporting relationship, not
// a role string: `role: "employee"` is what an ordinary primary manager carries.
// So a manager was refused on a step of a goal they had assigned themselves.
//
// The middleware is shared by many other SOP routes and is deliberately NOT
// changed. The check moves into the handler instead, where the task is in hand
// and the real question — "are you this goal's head?" — can actually be asked.
router.post("/goal-credit", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const { role, employeeId: awardedById, name: awardedByName } = req.coworkUser;
        const {
            targetEmployeeId,
            points,
            componentName,
            taskTitle,
            taskId,
            componentId,
            submittedAt,   // ISO string — when receiver submitted the report
            deadline,      // ISO string — the node's deadline
        } = req.body;

        if (!targetEmployeeId) {
            return res.status(400).json({ error: "targetEmployeeId is required." });
        }

        // ── Who may credit this step ──────────────────────────────────────────
        // The goal's own head, or a CEO/TL. Read from the task rather than from
        // the caller's role, so the answer is about THIS goal.
        if (!["ceo", "tl"].includes(role)) {
            if (!taskId) {
                return res.status(403).json({ error: "Only this goal's head can approve its steps." });
            }
            const { db: _db } = require("../../config/firebaseAdmin");
            const taskSnap = await _db.collection("cowork_tasks").doc(String(taskId)).get();
            if (!taskSnap.exists) {
                return res.status(404).json({ error: "Task not found" });
            }
            const t = taskSnap.data();
            /* `assignedBy` only. NOT `confirmedBy` — that is written as
               `arrayUnion(assigneeIds[0])`, so it holds the ASSIGNEE, and
               counting it here would let somebody approve and credit their own
               goal steps. See routes/task_routes/_taskHead.js. */
            const isHead =
                t.assignedBy === awardedById ||
                t.originalAssignedBy === awardedById;
            if (!isHead) {
                return res.status(403).json({ error: "Only this goal's head can approve its steps." });
            }
        }
        if (!points || Number(points) <= 0) {
            return res.status(400).json({ error: "points must be > 0." });
        }

        // ── On-time check ──────────────────────────────────────────────────────
        // Only apply credit if submission was before (or exactly at) the deadline.
        // If deadline is not set, credit unconditionally.
        let isOnTime = true;
        if (deadline && submittedAt) {
            const deadlineDate = new Date(deadline);
            const submittedDate = new Date(submittedAt);
            isOnTime = submittedDate <= deadlineDate;
        }

        if (!isOnTime) {
            // Submission was late — no credit applied, just return info
            return res.json({
                success: false,
                skipped: true,
                message: `Submitted after deadline — no point credit for "${componentName}". Approval still recorded.`,
            });
        }
        // ──────────────────────────────────────────────────────────────────────

        const employee = await Employee.findOne({ biometricId: targetEmployeeId });
        if (!employee) return res.status(404).json({ error: "Employee not found." });

        const year = new Date().getFullYear();
        const today = new Date().toISOString().split("T")[0];
        const absPoints = Math.abs(Number(points));

        // ── Duplicate guard — prevent double-credit for same component ─────────
        // If this taskId + componentId was already credited this year, skip.
        const yearData = (employee.sopPoints || []).find(sp => sp.year === year);
        if (yearData) {
            const alreadyCredited = (yearData.bleaches || []).some(
                b => b.taskId === taskId && b.componentId === componentId && b.bleachType === "debit"
            );
            if (alreadyCredited) {
                console.warn(`[goal-credit] DUPLICATE blocked: ${targetEmployeeId} task=${taskId} comp=${componentId}`);
                return res.json({
                    success: false,
                    skipped: true,
                    message: `Component "${componentName}" already credited. Duplicate blocked.`,
                });
            }
        }
        // ─────────────────────────────────────────────────────────────────────

        // Build the credit entry — bleachType:"debit" = reward (reduces penalty score)
        const creditEntry = {
            type: "C2",
            sopId: null,
            sopName: componentName || "Goal Component",
            folderName: taskTitle || "Goal Task",
            points: absPoints,
            description: `On-time goal node approved: ${componentName || ""}`,
            date: today,
            cutBy: awardedById,
            cutByName: awardedByName,
            cutByRole: role === "ceo" ? "ceo" : "tl",
            bleachType: "debit",  // REWARD — subtracts from penalty score, shown GREEN
            isCredit: true,     // legacy boolean kept for compat
            taskId,
            componentId,
            recheck: {
                status: "none", requestedAt: null, requestNote: "",
                reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewNote: "",
            },
        };

        const yearIndex = employee.sopPoints.findIndex(sp => sp.year === year);
        if (yearIndex >= 0) {
            employee.sopPoints[yearIndex].bleaches.push(creditEntry);
            // Subtract points — lower totalDeducted = better performance
            employee.sopPoints[yearIndex].totalDeducted = +(
                employee.sopPoints[yearIndex].totalDeducted - absPoints
            ).toFixed(2);
            // Allow negative (net positive means excellent — no floor at 0)
        } else {
            // First record for this year — start at negative (net reward)
            employee.sopPoints.push({
                year,
                totalDeducted: -absPoints,
                bleaches: [creditEntry],
            });
        }


        await employee.save();

        // Points going the other way, and just as unannounced as a deduction.
        // Worth sending for the same reason: somebody decided your work earned
        // this, and a reward nobody mentions is one that never lands.
        await _notify({
            recipientIds: [targetEmployeeId],
            type: "sop_goal_credit",
            title: `⭐ ${absPoints} pts earned · ${componentName || "Goal component"}`,
            body: `${awardedByName} approved "${componentName || "your goal component"}"${taskTitle ? ` on ${taskTitle}` : ""} on time. ${absPoints} pts have been credited to your score.`,
            data: { employeeId: targetEmployeeId, taskId: taskId || null, componentId: componentId || null, points: absPoints },
            senderId: awardedById,
            senderName: awardedByName,
        });

        // ── Update cowork_c2_scores cache if this is a Gold Task component ───
        const { isC2Band, c2TaskMaxPoints } = req.body;
        if (isC2Band && absPoints > 0) {
            try {
                const { db, admin } = require("../../config/firebaseAdmin");
                const scoreRef = db.collection("cowork_c2_scores").doc(targetEmployeeId);
                const scoreSnap = await scoreRef.get();
                const existing = scoreSnap.exists
                    ? scoreSnap.data()
                    : { employeeId: targetEmployeeId, totalEarned: 0, taskBreakdown: {} };
                const breakdown = existing.taskBreakdown || {};

                // Accumulate per-task earned pts
                if (!breakdown[taskId]) {
                    breakdown[taskId] = {
                        taskId,
                        taskTitle: taskTitle || "",
                        taskMaxPoints: Number(c2TaskMaxPoints) || 0,
                        earnedPoints: 0,
                        weightagePercent: Number(req.body.c2WeightagePercent) || 0,
                        completedAt: null,
                    };
                }
                breakdown[taskId].earnedPoints = +(
                    (breakdown[taskId].earnedPoints || 0) + absPoints
                ).toFixed(2);

                const totalEarned = +Object.values(breakdown)
                    .reduce((s, t) => s + (t.earnedPoints || 0), 0)
                    .toFixed(2);

                await scoreRef.set({
                    employeeId: targetEmployeeId,
                    totalEarned,
                    taskBreakdown: breakdown,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                }, { merge: true });

                console.log(`[C2 cache] +${absPoints}pts for ${targetEmployeeId} comp=${componentName}. Total: ${totalEarned}`);
            } catch (c2Err) {
                console.error("[C2 cache update]", c2Err.message);
            }
        }
        // ─────────────────────────────────────────────────────────────────────

        res.json({
            success: true,
            credited: true,
            message: `−${absPoints} pts applied to ${employee.firstName}'s record for on-time completion of "${componentName}".`,
        });
    } catch (e) {
        console.error("[goal-credit]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /cowork/sop/settings/sync — sync Firestore SOP settings to MongoDB
router.post("/settings/sync", verifyCoworkToken, verifyCeoToken, async (req, res) => {
    try {
        const {
            c1MaxPoints, c1MaxPointsDesc,
            c1BaseScore, c1BaseScoreDesc,
            c1DeadlineDeduction, c1DeadlineDesc,
            c1ExtensionDeduction, c1ExtensionDesc,
            c1ReworkDeduction, c1ReworkDesc,
            c1RejectScore, c1RejectDesc,
            c2GlobalMaxPoints, c2GlobalMaxPointsDesc,
        } = req.body;
        const { employeeId } = req.coworkUser;
        const { BandConfig } = require("../../models/BandConfig");

        await BandConfig.findOneAndUpdate(
            {},
            {
                $set: {
                    "globalSettings.c1.maxPoints.award": Number(c1MaxPoints) || 35,
                    "globalSettings.c1.maxPoints.desc": c1MaxPointsDesc || "",
                    "globalSettings.c1.baseScore.award": Number(c1BaseScore) ?? 1.0,
                    "globalSettings.c1.baseScore.desc": c1BaseScoreDesc || "",
                    "globalSettings.c1.deadline.deduction": Number(c1DeadlineDeduction) ?? 0.2,
                    "globalSettings.c1.deadline.desc": c1DeadlineDesc || "",
                    "globalSettings.c1.extension.deduction": Number(c1ExtensionDeduction) ?? 0.1,
                    "globalSettings.c1.extension.desc": c1ExtensionDesc || "",
                    "globalSettings.c1.rework.deduction": Number(c1ReworkDeduction) ?? 0.2,
                    "globalSettings.c1.rework.desc": c1ReworkDesc || "",
                    "globalSettings.c1.reject.deduction": Number(c1RejectScore) ?? 0.3,
                    "globalSettings.c1.reject.desc": c1RejectDesc || "",
                    "globalSettings.c2.globalMaxPoints.award": Number(c2GlobalMaxPoints) || 30,
                    "globalSettings.c2.globalMaxPoints.desc": c2GlobalMaxPointsDesc || "",
                    updatedAt: new Date(),
                    updatedBy: employeeId,
                },

            },
            { upsert: true, new: true }
        );

        res.json({ success: true, message: "Settings synced to MongoDB." });
    } catch (e) {
        console.error("[settings/sync]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /cowork/sop/performance-summary — CEO only
router.get("/performance-summary", verifyCoworkToken, verifyCeoToken, async (req, res) => {
    try {
        const { db } = require("../../config/firebaseAdmin");

        const [coworkSnap, employees] = await Promise.all([
            db.collection("cowork_employees").get(),
            Employee.find(
                { biometricId: { $exists: true, $ne: "" } },
                { biometricId: 1, sopPoints: 1 }
            ).lean(),
        ]);

        const coworkMap = {};
        coworkSnap.docs.forEach(d => {
            const data = d.data();
            if (data.employeeId) coworkMap[data.employeeId] = {
                name: data.name || "",
                department: data.department || "",
            };
        });

        const results = employees
            .filter(emp => emp.biometricId && coworkMap[emp.biometricId])
            .map(emp => {
                const sopPoints = emp.sopPoints || [];
                let rewards = 0, deductions = 0;
                sopPoints.forEach(yp => {
                    (yp.bleaches || []).forEach(b => {
                        if (b.recheck?.status === "confirmed") return;
                        const pts = Number(b.points) || 0;
                        if (b.bleachType === "debit") rewards += pts;
                        else deductions += pts;
                    });
                });
                const netScore = +(rewards - deductions).toFixed(2);
                const cowork = coworkMap[emp.biometricId];
                return {
                    employeeId: emp.biometricId,
                    name: cowork.name,
                    department: cowork.department,
                    netScore,
                    rewards: +rewards.toFixed(2),
                    deductions: +deductions.toFixed(2),
                };
            })
            .sort((a, b) => b.netScore - a.netScore);

        res.json({ success: true, employees: results });
    } catch (e) {
        console.error("[sop/performance-summary]", e.message);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;