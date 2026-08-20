/**
 * REPLACE: routes/taskForward.routes.js
 * 
 * New rules:
 * 1. Task visibility: CEO sees only tasks created BY CEO. TL sees all.
 * 2. list-hierarchy filters accordingly.
 * 3. Employee creates task → if any assignee is TL → status = "pending_tl_approval"
 * 4. TL approve endpoint added.
 * 5. Subtask created by TL → chat notification posted in parent but subtask hidden from CEO tree.
 * 6. TL display name includes department: "Name (Dept TL)"
 */


const express = require("express");
const { getTaskReviewOwner } = require("../../services/taskReviewOwner.service");
const router = express.Router();
const { verifyCoworkToken, verifyCeoToken, verifyEmployeeToken } = require("../../Middlewear/coworkAuth");
const svc = require("../../services/taskForward.service");
const { isTaskHead } = require("./_taskHead");
const { db, admin } = require("../../config/firebaseAdmin");
const {
  capBreach,
  capRefusalBody,
  raisedParentDueAt,
  readParentDeadline,
} = require("../../services/parentDeadlineCap.service");
const { readMs: readInstantMs } = require("../../services/officeDeadline.service");
const { v4: _nuuid } = require("uuid");

const _socket = require("../../config/socketInstance");

// ── Local notify helper (saves to Firestore + FCM push) ──────────────────────
async function _notify({ recipientIds, type, title, body, data, senderId, senderName }) {
  if (!recipientIds?.length) return;
  try {
    const batch = db.batch();
    recipientIds.forEach(id => {
      batch.set(db.collection("cowork_notifications").doc(_nuuid()), {
        recipientEmployeeId: id, type, title, body,
        data: data || {}, read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    await batch.commit();
    _socket.emitToMany(recipientIds, "new_notification", { type, title, body, data });
    setImmediate(() => {
      try {
        const { sendPushToEmployees } = require("../../services/fcmPush.service");
        sendPushToEmployees(recipientIds, title, body, { type, ...(data || {}) }).catch(() => { });
      } catch (_) { }
    });
  } catch (e) { console.error("[_notify]", e.message); }
}

// ── Helper: get employee info (name + email) from Firestore ──────────────────
async function getAssigneeContacts(assigneeIds) {
  const contacts = [];
  for (const id of assigneeIds) {
    try {
      const snap = await db.collection("cowork_employees").doc(id).get();
      if (snap.exists) {
        const { name, email } = snap.data();
        if (email) contacts.push({ name: name || id, email });
      }
    } catch (_) { }
  }
  return contacts;
}

// ── Helper: get employee role/dept from Firestore ─────────────────────────────
async function getEmployeeInfo(employeeId) {
  const snap = await db.collection("cowork_employees").doc(employeeId).get();
  if (!snap.exists) return null;
  return snap.data();
}

// Moved to `services/primaryManager.service.js` — the budget negotiation needs
// the same lookup to route an hours request to the person who manages the
// assignee, and a permission lookup with two copies is a permission lookup with
// two answers. The name is kept so every caller here is untouched.
async function _getPrimaryManagerApprover(employeeId) {
  const {
    resolvePrimaryManagerApprover,
  } = require("../../services/primaryManager.service");
  return resolvePrimaryManagerApprover(employeeId);
}

// The routing rule now lives in `services/taskReviewOwner.service.js`, which
// returns the REASON alongside the id — the question "why did this go to the
// department lead rather than their manager?" had no answer before. The old
// department query also used `.limit(1)` with no ordering, so a department with
// two leads could route the same task two different ways; the shared version
// orders deterministically.
//
// This wrapper keeps the shape every existing caller expects.
async function resolveDepartmentApprover(employeeId) {
  const owner = await getTaskReviewOwner(employeeId, {
    getEmployeeInfo,
    getPrimaryManager: _getPrimaryManagerApprover,
  });
  if (!owner.reviewerId) return null;
  return {
    approverId: owner.reviewerId,
    approverName: owner.reviewerName,
    /* Always the HR primary manager now — the department-lead branch is gone.
       The literal stays because stored `departmentApprovals[].source` values
       from before the change still read `dept_tl`, and rewriting history to
       match a new rule would misrepresent decisions already taken. */
    source: "primary_manager",
    reason: owner.reason,
  };
}

// ── Helper: post system message to task chat ──────────────────────────────────
async function postSystemChatMessage(taskId, text, senderId = "system", senderName = "System") {
  try {
    const messageId = require("crypto").randomUUID();
    const msgsRef = db.collection("cowork_tasks").doc(taskId).collection("chat");
    const taskRef = db.collection("cowork_tasks").doc(taskId);
    await msgsRef.doc(messageId).set({
      messageId,
      taskId,
      senderId,
      senderName,
      text,
      attachments: [],
      messageType: "system",
      mention: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await taskRef.update({
      chatMessageCount: admin.firestore.FieldValue.increment(1),
      lastChatAt: admin.firestore.FieldValue.serverTimestamp(),
      lastChatPreview: text,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error("postSystemChatMessage error:", err.message);
  }
}

// ── 1. CREATE TASK ────────────────────────────────────────────────────────────
router.post("/task/create", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { title, description, notes, requirements, assigneeIds, priority, parentTaskId, groupId, createdByTl, isFolder, isRepeat, repeatConfig, isThirdParty, thirdPartyConfig, isGoal, goalConfig, hasTimer, fixedDeadline, isSelfAssigned, visibleTo, approverId, approverName, senderTimerWindowSecs, isGoldTask, c2Config, etcHours } = req.body;
    const dueDate = null; // Deadline is always set by employee after assignment
    console.log("[task/create] isFolder:", isFolder, typeof isFolder, "| assigneeIds:", assigneeIds);
    if (!title?.trim()) return res.status(400).json({ error: "title required" });
    // isFolder can be boolean true OR string "true" from some clients
    const folderFlag = isFolder === true || isFolder === "true";
    if (!folderFlag && !assigneeIds?.length) return res.status(400).json({ error: "assigneeIds required" });

    const requesterRole = req.coworkUser.role;
    if (!["ceo", "tl", "employee"].includes(requesterRole)) {
      return res.status(403).json({ error: "Not authorized to create tasks." });
    }

    // Check if any assignee is a TL → needs TL approval (only when employee creates)
    let initialStatus = "open";
    if (requesterRole === "employee" && assigneeIds?.length) {
      for (const aid of assigneeIds) {
        const emp = await getEmployeeInfo(aid);
        if (emp?.role === "tl") { initialStatus = "pending_tl_approval"; break; }
      }
    }
    // Repeat tasks always start as pending confirmation — employee must accept before work begins
    const repeatFlag = isRepeat === true || isRepeat === "true";
    if (repeatFlag) initialStatus = "repeat_pending_confirmation";
    const thirdPartyFlag = isThirdParty === true || isThirdParty === "true";
    const goalFlag = isGoal === true || isGoal === "true";

    // ── CROSS-DEPARTMENT APPROVAL GATE ──────────────────────────────────────
    let departmentApprovalGate = null;
    if (requesterRole !== "ceo" && !folderFlag && !repeatFlag && !thirdPartyFlag && !goalFlag
      && !parentTaskId && assigneeIds?.length === 1) {
      const assignerInfo = await getEmployeeInfo(req.coworkUser.employeeId);
      const assignerDept = assignerInfo?.department || "";
      const targetId = assigneeIds[0];
      const targetInfo = await getEmployeeInfo(targetId);
      const targetDept = targetInfo?.department || "";

      if (assignerDept && targetDept && assignerDept !== targetDept) {
        // If the assigner is themselves the assignee's manager on file,
        // there's no one else to approve — the gate exists to loop in a
        // manager for a cross-department assignment, and here the assigner
        // already IS that manager. Skip the gate (and the "no manager on
        // file" hard-block below) entirely in this case.
        const HrEmployee = require("../../models/Employee");
        const targetHrEmp = await HrEmployee.findOne({ biometricId: targetId })
          .select("primaryManager.managerId")
          .populate("primaryManager.managerId", "biometricId")
          .lean();
        const assignerIsTargetsManager =
          targetHrEmp?.primaryManager?.managerId?.biometricId === req.coworkUser.employeeId;

        if (!assignerIsTargetsManager) {
          let [senderApprover, receiverApprover] = await Promise.all([
            resolveDepartmentApprover(req.coworkUser.employeeId),
            resolveDepartmentApprover(targetId),
          ]);

          // No manager on file on either side → fall back to the default
          // CoWork approver (employeeId "E000") instead of blocking the
          // assignment outright. Only hard-blocks if E000 itself doesn't
          // exist in cowork_employees, which shouldn't normally happen.
          if (!senderApprover || !receiverApprover) {
            const fallbackInfo = await getEmployeeInfo("E000");
            if (!fallbackInfo) {
              return res.status(400).json({ error: "Cannot assign — no manager on file to approve this cross-department task, and no default approver (E000) is configured." });
            }
            const fallbackApprover = { approverId: "E000", approverName: fallbackInfo.name, source: "default_fallback" };
            if (!senderApprover) senderApprover = fallbackApprover;
            if (!receiverApprover) receiverApprover = fallbackApprover;
          }

          departmentApprovalGate = {
            pendingAssigneeId: targetId,
            pendingAssigneeName: targetInfo?.name || "",
            approvals: [
              { approverId: senderApprover.approverId, approverName: senderApprover.approverName, side: "sender", source: senderApprover.source, status: "pending", respondedAt: null, rejectionReason: null },
              // Starts "waiting", not "pending" — the receiver's TL isn't shown this as
              // actionable until the sender's TL approves first (see department-approve).
              { approverId: receiverApprover.approverId, approverName: receiverApprover.approverName, side: "receiver", source: receiverApprover.source, status: "waiting", respondedAt: null, rejectionReason: null },
            ],
          };
          initialStatus = "pending_department_approval";
        }
      }
    }

    // ── CEO-ASSIGNMENT APPROVAL GATE ─────────────────────────────────────────
    if (requesterRole === "ceo" && !folderFlag && !repeatFlag && !thirdPartyFlag && !goalFlag
      && !parentTaskId && assigneeIds?.length === 1) {
      const targetId = assigneeIds[0];
      const targetInfo = await getEmployeeInfo(targetId);

      // Same two rules as the cross-department gate above:
      // 1) If the CEO is already this employee's manager on file, there's
      //    no one else to approve — skip the gate entirely.
      const HrEmployeeCeo = require("../../models/Employee");
      const targetHrEmpCeo = await HrEmployeeCeo.findOne({ biometricId: targetId })
        .select("primaryManager.managerId")
        .populate("primaryManager.managerId", "biometricId")
        .lean();
      const ceoIsTargetsManager =
        targetHrEmpCeo?.primaryManager?.managerId?.biometricId === req.coworkUser.employeeId;

      if (!ceoIsTargetsManager) {
        let receiverApprover = await resolveDepartmentApprover(targetId);

        // 2) No manager on file → fall back to the default CoWork approver
        // (employeeId "E000") instead of blocking the assignment outright.
        if (!receiverApprover) {
          const fallbackInfo = await getEmployeeInfo("E000");
          if (!fallbackInfo) {
            return res.status(400).json({ error: `Cannot assign — ${targetInfo?.name || "the assignee"} has no manager on file to approve this assignment, and no default approver (E000) is configured.` });
          }
          receiverApprover = { approverId: "E000", approverName: fallbackInfo.name, source: "default_fallback" };
        }

        departmentApprovalGate = {
          pendingAssigneeId: targetId,
          pendingAssigneeName: targetInfo?.name || "",
          approvals: [
            { approverId: receiverApprover.approverId, approverName: receiverApprover.approverName, side: "receiver", source: receiverApprover.source, status: "pending", respondedAt: null, rejectionReason: null },
          ],
        };
        initialStatus = "pending_department_approval";
      }
    }

    // ── DEADLINE-MODE TASKS: B's own department TL sets real hours ──────────

    const deadlineModeFlag = hasTimer === false || hasTimer === "false";
    let draftTlApprover = null;
    if (deadlineModeFlag && !folderFlag && !repeatFlag && !thirdPartyFlag && !goalFlag
      && !departmentApprovalGate && assigneeIds?.length === 1 && initialStatus === "open") {
      const targetInfo2 = await getEmployeeInfo(assigneeIds[0]);
      const assignerInfo2 = await getEmployeeInfo(req.coworkUser.employeeId);
      const assignerDept2 = assignerInfo2?.department || "";
      const targetDept2 = targetInfo2?.department || "";
      const isCrossDept2 = requesterRole !== "ceo" && assignerDept2 && targetDept2 && assignerDept2 !== targetDept2;
      // Who sets the budget follows the ASSIGNEE'S REPORTING LINE, not the
      // department. The department lookup this replaces picked whichever TL
      // happened to lead the receiving department, which is a different person
      // from the assignee's manager in every case where the two differ.
      if (isCrossDept2 && targetInfo2) {
        const mgr2 = await _getPrimaryManagerApprover(assigneeIds[0]);
        if (mgr2 && mgr2.approverId !== assignedBy) {
          draftTlApprover = { approverId: mgr2.approverId, approverName: mgr2.approverName };
          initialStatus = "pending_tl_hours";
        }
      }
    }

    // Per-person auto-priority

    // Per-person auto-priority: build assigneePriorities map for EVERY assignee
    // Each person gets their own priority = their open task count + 1
    // Highest ACTIVE rank + 1 per assignee — see `nextActiveRankFor`. The count
    // this replaced collided whenever a queue had a gap, which put new work
    // above tasks a manager had already ordered.
    let autoPriority = (typeof priority === "number" ? priority : Number(priority)) || null;
    let assigneePrioritiesMap = {};
    if (assigneeIds?.length > 0) {
      try {
        const { db: _db } = require("../../config/firebaseAdmin");
        assigneePrioritiesMap = await svc.assigneePrioritiesFor(_db, assigneeIds);
        if (!autoPriority) autoPriority = assigneePrioritiesMap[assigneeIds[0]] || 1;
      } catch (e) {
        console.warn("[task/create] auto-priority fallback:", e.message);
        if (!autoPriority) autoPriority = 1;
        assigneeIds.forEach(aid => {
          if (!assigneePrioritiesMap[aid]) assigneePrioritiesMap[aid] = autoPriority;
        });
      }
    }
    if (!autoPriority) autoPriority = 1;

    // Self-assigned tasks: the counterparty is the assignee's PRIMARY MANAGER,
    // recorded as the assigner of record. The creator cannot negotiate a time
    // budget with, set the priority of, or review their OWN work, so their
    // manager stands on the other side of every one of those turns (budget
    // negotiation reads `assignedBy`, `_reviewFlow` notifies `assignedBy`, and
    // priority is the manager's by the reporting-line rule). The manager is
    // resolved from HR — the form shows no approver field. An explicit approverId
    // still wins if a client sends one. Someone with NO manager on file (e.g. the
    // CEO) stays their own approver, matching the priority rule that only binds
    // people who have a manager. This changes ATTRIBUTION only; the approval
    // gates above still evaluate against the real requester.
    let effectiveAssignedBy = req.coworkUser.employeeId;
    let effectiveAssignedByName = req.coworkUser.name;
    let effectiveAssignedByRole = requesterRole;
    let selfApproverId = approverId || null;
    let selfApproverName = approverName || null;
    const isSelfAssignedReq = isSelfAssigned === true || isSelfAssigned === "true";
    if (isSelfAssignedReq) {
      if (!selfApproverId) {
        const selfAssigneeId =
          (Array.isArray(assigneeIds) && assigneeIds[0]) || req.coworkUser.employeeId;
        const mgr = await _getPrimaryManagerApprover(selfAssigneeId);
        if (mgr && mgr.approverId) {
          selfApproverId = mgr.approverId;
          selfApproverName = mgr.approverName;
        }
      }
      if (selfApproverId && selfApproverId !== req.coworkUser.employeeId) {
        const approverInfo = await getEmployeeInfo(selfApproverId);
        if (approverInfo) {
          effectiveAssignedBy = selfApproverId;
          effectiveAssignedByName = selfApproverName || approverInfo.name;
          effectiveAssignedByRole = approverInfo.role || "tl";
        }
      }
    }

    const task = await svc.createTask({
      title: title.trim(), description, notes,
      assignedBy: effectiveAssignedBy,
      assignedByName: effectiveAssignedByName,
      assignedByRole: effectiveAssignedByRole,
      // The REAL creator — the person who clicked create. Differs from
      // `assignedBy` only for a self task, where the assigner of record is the
      // creator's manager but the "Created by" credit stays with the creator.
      createdBy: req.coworkUser.employeeId,
      assigneeIds: departmentApprovalGate ? [] : (assigneeIds || []),
      dueDate: null,
      priority: autoPriority,
      assigneePriorities: assigneePrioritiesMap,
      parentTaskId: parentTaskId || null,
      groupId: groupId || null,
      createdByTl: createdByTl || false,
      status: initialStatus,
      pendingAssigneeId: departmentApprovalGate?.pendingAssigneeId || null,
      pendingAssigneeName: departmentApprovalGate?.pendingAssigneeName || null,
      departmentApprovals: departmentApprovalGate?.approvals || null,
      isFolder: folderFlag,
      isRepeat: repeatFlag,
      repeatConfig: (repeatFlag && repeatConfig) ? repeatConfig : null,
      isThirdParty: thirdPartyFlag,
      thirdPartyConfig: (thirdPartyFlag && thirdPartyConfig) ? thirdPartyConfig : null,
      isGoal: goalFlag,
      goalConfig: (goalFlag && goalConfig) ? goalConfig : null,
      isGoldTask: (isGoldTask === true || isGoldTask === "true") || false,
      c2Config: c2Config || null,
      etcHours: Number(etcHours) || 0,
      requirements: Array.isArray(requirements) ? requirements : [],
      hasTimer: hasTimer !== false && hasTimer !== "false",
      fixedDeadline: fixedDeadline || null,
      isSelfAssigned: isSelfAssigned === true || isSelfAssigned === "true",
      visibleTo: Array.isArray(visibleTo) ? visibleTo : (visibleTo ? [visibleTo] : []),
      // The self-task approver — resolved to the assignee's primary manager above
      // when the client sent none — so the manager owns the approval/review too.
      approverId: selfApproverId,
      approverName: selfApproverName,
      // Mark whether this is a CEO-created root task (for visibility filtering)
      createdByCeo: requesterRole === "ceo" && !parentTaskId,
      createdByTl: requesterRole === "tl",
      senderTimerWindowSecs: Number(senderTimerWindowSecs) || 0,
    });

    // If it's a subtask created by TL, post notification in parent task chat
    if (parentTaskId && requesterRole === "tl") {
      await postSystemChatMessage(
        parentTaskId,
        `📋 Subtask "${title.trim()}" has been created under this task by ${req.coworkUser.name}`,
        req.coworkUser.employeeId,
        req.coworkUser.name
      );
    }

    if (departmentApprovalGate) {
      const uniqueApproverIds = [...new Set(departmentApprovalGate.approvals.map(a => a.approverId))];
      const isCeoAssignment = requesterRole === "ceo";
      await _notify({
        recipientIds: uniqueApproverIds,
        type: "department_approval_request",
        title: isCeoAssignment ? "🔔 Approval Needed" : "🔔 Cross-Department Approval Needed",
        body: isCeoAssignment
          ? `${req.coworkUser.name} (CEO) has assigned a task to ${departmentApprovalGate.pendingAssigneeName}. Please approve or reject this request.`
          : `${req.coworkUser.name} wants to assign a task to ${departmentApprovalGate.pendingAssigneeName} from another department. Please approve or reject this request.`,
        data: { taskId: task.taskId, taskTitle: title.trim() },
        senderId: req.coworkUser.employeeId,
        senderName: req.coworkUser.name,
      });
    }

    if (draftTlApprover) {
      await _notify({
        recipientIds: [draftTlApprover.approverId],
        type: "department_draft_needs_hours",
        title: "📝 Draft Task Needs Your Hours Estimate",
        body: `${req.coworkUser.name} assigned a deadline-based task to your team. Set the real ETC hours before it goes to your team member.`,
        data: { taskId: task.taskId, taskTitle: title.trim() },
        senderId: req.coworkUser.employeeId,
        senderName: req.coworkUser.name,
      });
    }

    // Self-assigned task awaiting approval — notify the approver now, at creation time
    if (isSelfAssignedReq && approverId) {
      await _notify({
        recipientIds: [approverId],
        type: "self_assign_pending",
        title: `👤 Self-Task Needs Your Approval`,
        body: `${req.coworkUser.name} created a self-assigned task "${title.trim()}" and needs your approval before they can start.`,
        data: { taskId: task.taskId, taskTitle: title.trim() },
        senderId: req.coworkUser.employeeId,
        senderName: req.coworkUser.name,
      });
    }

    res.status(201).json({ success: true, task });
    // Email is now handled inside svc.createTask() via _notifyMany → sendNotificationEmail

  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Backward compat alias
router.post("/task/create-parent", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { title, description, notes, assigneeIds, dueDate, priority } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: "title required" });
    if (!assigneeIds?.length) return res.status(400).json({ error: "assigneeIds required" });
    if (!["ceo", "tl"].includes(req.coworkUser.role)) return res.status(403).json({ error: "Only CEO or TL can create parent tasks." });
    let parentPriorities = {};
    try {
      const { db: _db } = require("../../config/firebaseAdmin");
      parentPriorities = await svc.assigneePrioritiesFor(_db, assigneeIds);
    } catch (e) {
      console.warn("[parent-task/create] auto-priority fallback:", e.message);
      assigneeIds.forEach(aid => { parentPriorities[aid] = 1; });
    }
    const task = await svc.createTask({
      title: title.trim(), description, notes,
      assignedBy: req.coworkUser.employeeId,
      assignedByName: req.coworkUser.name,
      assignedByRole: req.coworkUser.role,
      assigneeIds, dueDate: dueDate || null,
      // `priority || "medium"` was here — a STRING on a 1..10 numeric scale.
      // It reached the document as-is, so the task displayed with no priority
      // at all and sorted unpredictably, and no per-assignee rank was written.
      priority: Number(priority) || parentPriorities[assigneeIds[0]] || 1,
      assigneePriorities: parentPriorities,
      parentTaskId: null,
      createdByCeo: req.coworkUser.role === "ceo",
    });
    res.status(201).json({ success: true, task });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 2. CONFIRM ────────────────────────────────────────────────────────────────
router.post("/task/:taskId/confirm", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const result = await svc.confirmTaskReceipt({ taskId: req.params.taskId, employeeId: req.coworkUser.employeeId, employeeName: req.coworkUser.name });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── PRIORITY ORDER — persist one person's queue, atomically ───────────────────
// The gap this closes: priority had NO route at all. Both the old and the new
// frontend write `assigneePriorities.{employeeId}` straight to Firestore from
// the browser, which is why two tabs can leave a queue with duplicate ranks —
// a browser cannot run a query inside a transaction, so it cannot read a queue
// and renumber it atomically. The admin SDK can.
//
// This route deliberately does NOT decide the order. The caller sends the order
// it wants and this persists it 1..N in one transaction. The ordering rule stays
// exactly where it is; what moves here is only the guarantee that a queue is
// never left half-written.
//
// Authority is the same as everywhere else that touches somebody's workload:
// their primary manager, via `_getPrimaryManagerApprover`. Somebody with no
// manager on record orders their own queue — the same exception the rest of the
// product makes, because there is nobody else to ask.
router.post("/employee/:employeeId/priority-order", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { orderedTaskIds } = req.body || {};
    const actor = req.coworkUser.employeeId;

    if (!Array.isArray(orderedTaskIds) || orderedTaskIds.length === 0) {
      return res.status(400).json({ error: "orderedTaskIds is required." });
    }
    if (orderedTaskIds.length > 500) {
      // Firestore caps a transaction at 500 writes. Refused rather than
      // truncated: a half-renumbered queue is worse than one nobody touched.
      return res.status(400).json({ error: "Too many tasks to renumber in one call." });
    }

    if (actor !== employeeId) {
      const manager = await _getPrimaryManagerApprover(employeeId);
      if (!manager) {
        return res.status(400).json({ error: "This employee has no manager recorded, so nobody else can set their priorities." });
      }
      if (manager.approverId !== actor) {
        return res.status(403).json({ error: `Only ${manager.approverName}, who manages this employee, can reorder their work.` });
      }
    }

    const written = await db.runTransaction(async (tx) => {
      const refs = orderedTaskIds.map((id) => db.collection("cowork_tasks").doc(String(id)));
      const snaps = await tx.getAll(...refs);

      // Every task is verified to belong to this person BEFORE anything is
      // written — otherwise a caller could renumber a queue by naming somebody
      // else's task, and the transaction would happily do it.
      snaps.forEach((snap, i) => {
        if (!snap.exists) throw new Error(`Task ${orderedTaskIds[i]} does not exist.`);
        const t = snap.data();
        const holds = (t.assigneeIds || []).includes(employeeId) || t.pendingAssigneeId === employeeId;
        if (!holds) throw new Error(`Task ${orderedTaskIds[i]} is not assigned to this employee.`);
      });

      snaps.forEach((snap, i) => {
        const rank = Math.max(1, Math.min(10, i + 1));
        tx.update(snap.ref, {
          // Dot notation. Writing `assigneePriorities` whole would erase every
          // other assignee's rank on a shared task.
          [`assigneePriorities.${employeeId}`]: rank,
          order: (i + 1) * 1000,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
      return snaps.length;
    });

    // ── Tell the person whose queue this is ──────────────────────────────────
    // Priority had NO notification of any kind before this. A manager could
    // reorder somebody's whole day and the only way that person found out was
    // by looking. The queue decides what they are supposed to work on next, so
    // it is the change most worth telling them about, not the least.
    //
    // Only when somebody ELSE did it: a person dragging their own list already
    // knows, and notifying them would make every drag ring their own bell.
    if (actor !== employeeId) {
      await _notify({
        recipientIds: [employeeId],
        type: "priority_reordered",
        title: "🔀 Your work was reordered",
        body: `${req.coworkUser.name || "Your manager"} changed the order of your tasks. ${written} ${written === 1 ? "task" : "tasks"} renumbered — check what is at the top before you carry on.`,
        data: { employeeId, taskIds: orderedTaskIds, topTaskId: orderedTaskIds[0] || null },
        senderId: actor,
        senderName: req.coworkUser.name,
      });
    }

    res.json({ success: true, renumbered: written });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── DECLINE ASSIGNMENT — the assignee refuses the work outright ───────────────
// The mirror of /confirm above. Until now the only refusal available to an
// assignee was /reject-sender-timer, which sends the proposed TIME back and
// leaves the task with them — there was no way to hand the work back at all.
// Reason is required; the service enforces it and every other guard.
router.post("/task/:taskId/decline-assignment", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const result = await svc.declineAssignment({
      taskId: req.params.taskId,
      employeeId: req.coworkUser.employeeId,
      employeeName: req.coworkUser.name,
      reason: req.body?.reason,
    });
    // postSystemChatMessage is defined in this file, not the service — the same
    // arrangement department-tl-set-hours uses. Posted after the write lands so
    // a failed decline leaves no message claiming it happened.
    await postSystemChatMessage(
      req.params.taskId,
      `\u26d4 ${req.coworkUser.name} declined this task — "${String(req.body?.reason || "").trim()}"`,
      req.coworkUser.employeeId,
      req.coworkUser.name,
    );
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── SET BUDGET ON AN ACTIVE TASK ──────────────────────────────────────────────
// Sibling of /department-tl-set-hours, which deliberately refuses any task that
// is not `pending_tl_hours` because its job is to ACTIVATE work waiting at the
// gate. This one changes the budget of work already running, which is what
// approving a time-budget extension needs. Same authority rule — the assignee's
// primary manager — resolved by the same helper.
router.post("/task/:taskId/set-budget", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    // The same authority check department-tl-set-hours makes, using the same
    // helper — the time budget belongs to whoever MANAGES the assignee, which
    // follows the reporting line rather than a department.
    const snap = await db.collection("cowork_tasks").doc(req.params.taskId).get();
    if (!snap.exists) return res.status(404).json({ error: "Task not found." });
    const t = snap.data();
    const targetId = t.pendingAssigneeId || t.assigneeIds?.[0];
    if (!targetId) return res.status(400).json({ error: "This task has no assignee yet." });
    const manager = await _getPrimaryManagerApprover(targetId);
    if (!manager) {
      return res.status(400).json({ error: "This task's assignee has no manager recorded, so nobody can set its time budget." });
    }
    if (manager.approverId !== req.coworkUser.employeeId) {
      return res.status(403).json({ error: `Only ${manager.approverName}, who manages the assignee, can set hours for this task.` });
    }

    const result = await svc.setActiveTaskBudget({
      taskId: req.params.taskId,
      employeeId: req.coworkUser.employeeId,
      employeeName: req.coworkUser.name,
      hoursValue: req.body?.hoursValue,
      hoursUnit: req.body?.hoursUnit,
    });
    await postSystemChatMessage(
      req.params.taskId,
      `\u23f1 ${req.coworkUser.name} set the time budget to ${(result.deadlineWindowSecs / 3600).toFixed(2)}h.`,
      req.coworkUser.employeeId,
      req.coworkUser.name,
    );
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── REPEAT TASK CONFIRM — employee accepts the repeat task ────────────────────
// Changes status: repeat_pending_confirmation → repeat_active
// Unlocks chat and daily submissions
// ── FORCE REPAIR: hit this once to fix all self-assign tasks ─────────────────
// GET /cowork/task/force-repair-self-assign
router.get("/task/force-repair-self-assign", async (req, res) => {
  try {
    const { db, admin } = require("../../config/firebaseAdmin");
    const snap = await db.collection("cowork_tasks").get();
    const results = [];

    for (const doc of snap.docs) {
      const d = doc.data();
      // A task is self-assigned if approverName is set OR assignedBy === assigneeIds[0]
      const isSelf = d.approverName || (d.assignedBy && d.assigneeIds?.length && d.assignedBy === d.assigneeIds[0]);
      if (!isSelf) continue;

      // Find the approver employeeId by looking up cowork_employees by name
      let approverId = d.approverId;
      if (!approverId && d.approverName) {
        const empSnap = await db.collection("cowork_employees")
          .where("name", "==", d.approverName).get();
        if (!empSnap.empty) {
          approverId = empSnap.docs[0].id;
        }
      }

      const updates = {
        isSelfAssigned: true,
        selfAssignApproved: d.selfAssignApproved ?? false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (approverId) {
        updates.approverId = approverId;
        updates.visibleTo = admin.firestore.FieldValue.arrayUnion(approverId);
      }

      await doc.ref.update(updates);
      results.push({ taskId: d.taskId, title: d.title, approverName: d.approverName, approverId });
    }

    res.json({ fixed: results.length, tasks: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DEBUG: check what self-assign tasks exist and their fields ───────────────
router.get("/task/self-assign-debug/:employeeId", async (req, res) => {
  try {
    const { db } = require("../../config/firebaseAdmin");
    const { employeeId } = req.params;

    // Query 1: approverId match
    const snap1 = await db.collection("cowork_tasks").where("approverId", "==", employeeId).get();
    // Query 2: visibleTo match
    const snap2 = await db.collection("cowork_tasks").where("visibleTo", "array-contains", employeeId).get();
    // Query 3: ALL tasks with isSelfAssigned=true
    const snap3 = await db.collection("cowork_tasks").where("isSelfAssigned", "==", true).get();

    res.json({
      byApproverId: snap1.docs.map(d => ({ taskId: d.data().taskId, title: d.data().title, approverId: d.data().approverId, isSelfAssigned: d.data().isSelfAssigned, visibleTo: d.data().visibleTo, selfAssignApproved: d.data().selfAssignApproved })),
      byVisibleTo: snap2.docs.map(d => ({ taskId: d.data().taskId, title: d.data().title, approverId: d.data().approverId, isSelfAssigned: d.data().isSelfAssigned, visibleTo: d.data().visibleTo })),
      allSelfAssigned: snap3.docs.map(d => ({ taskId: d.data().taskId, title: d.data().title, approverId: d.data().approverId, visibleTo: d.data().visibleTo, selfAssignApproved: d.data().selfAssignApproved })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Self-assign repair: fix old tasks missing approverId/visibleTo ───────────
// Call: POST /cowork/task/self-assign-repair { taskId, approverId, approverName }
router.post("/task/self-assign-repair", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { taskId, approverId, approverName } = req.body;
    const { db, admin } = require("../../config/firebaseAdmin");
    if (!taskId || !approverId) return res.status(400).json({ error: "taskId and approverId required" });
    const ref = db.collection("cowork_tasks").doc(taskId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "Task not found" });
    await ref.update({
      isSelfAssigned: true,
      approverId,
      approverName: approverName || approverId,
      visibleTo: admin.firestore.FieldValue.arrayUnion(approverId),
      selfAssignApproved: snap.data().selfAssignApproved ?? false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ success: true, message: "Task repaired. Approver will now see it." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Self-assign task: approver approves or rejects ────────────────────────────
router.post("/task/:taskId/self-assign-approve", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { approved, rejectionReason, reworkRequirements, reworkNote, reworkAttachments, reworkAttachmentIds } = req.body;
    const { employeeId, name: approverName } = req.coworkUser;
    const { db, admin } = require("../../config/firebaseAdmin");
    const { sendPushToEmployees } = require("../../services/fcmPush.service");

    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Task not found" });

    const task = snap.data();
    if (!task.isSelfAssigned) return res.status(400).json({ error: "Not a self-assigned task" });
    if (task.approverId !== employeeId) return res.status(403).json({ error: "You are not the approver for this task" });
    if (task.selfAssignApproved === true) return res.status(400).json({ error: "Already approved" });

    if (approved) {
      await taskRef.update({
        selfAssignApproved: true,
        selfAssignApprovedAt: admin.firestore.FieldValue.serverTimestamp(),
        selfAssignApprovedBy: employeeId,
        selfAssignApprovedByName: approverName,
        status: "confirmed",
        confirmedBy: admin.firestore.FieldValue.arrayUnion(task.assigneeIds[0]),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Notify the task creator (self-assignee)
      if (task.assigneeIds?.length) {
        await _notify({
          recipientIds: task.assigneeIds,
          type: "self_assign_approved",
          title: `✅ Self-Task Approved · ${task.title}`,
          body: `${approverName} approved your self-assigned task. You can now begin work.`,
          data: { taskId, taskTitle: task.title },
          senderId: employeeId, senderName: approverName,
        });
      }
      return res.json({ success: true, message: "Task approved. Employee can now begin work." });

    } else {
      await taskRef.update({
        selfAssignApproved: false,
        selfAssignRejectedAt: admin.firestore.FieldValue.serverTimestamp(),
        selfAssignRejectedBy: employeeId,
        selfAssignRejectedByName: approverName,
        selfAssignRejectionReason: rejectionReason || "",
        status: "cancelled",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      if (task.assigneeIds?.length) {
        await _notify({
          recipientIds: task.assigneeIds,
          type: "self_assign_rejected",
          title: `❌ Self-Task Rejected · ${task.title}`,
          body: `${approverName} rejected your self-assigned task${rejectionReason ? ": " + rejectionReason : "."}`,
          data: { taskId, taskTitle: task.title },
          senderId: employeeId, senderName: approverName,
        });
      }
      return res.json({ success: true, message: "Task rejected." });
    }

  } catch (e) {
    console.error("[self-assign-approve]", e);
    res.status(500).json({ error: e.message });
  }
});

router.post("/task/:taskId/repeat-confirm", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { employeeId, name: employeeName } = req.coworkUser;
    const { db, admin } = require("../../config/firebaseAdmin");

    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Task not found" });

    const task = snap.data();
    if (!task.isRepeat) return res.status(400).json({ error: "Not a repeat task" });
    if (!task.assigneeIds?.includes(employeeId)) return res.status(403).json({ error: "Not assigned to this task" });
    if (task.status === "repeat_active") return res.json({ success: true, message: "Already active" });
    if (task.status !== "repeat_pending_confirmation") return res.status(400).json({ error: "Task is not pending confirmation" });

    await taskRef.update({
      status: "repeat_active",
      repeatConfirmedBy: employeeId,
      repeatConfirmedByName: employeeName,
      repeatConfirmedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Post system message to chat unlocking it
    const msgId = require("uuid").v4();
    await db.collection("cowork_tasks").doc(taskId).collection("chat").doc(msgId).set({
      messageId: msgId, taskId,
      senderId: employeeId, senderName: employeeName,
      text: `✅ ${employeeName} confirmed this repeat task. Daily submissions are now active.`,
      attachments: [], messageType: "system", mention: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await taskRef.update({
      chatMessageCount: admin.firestore.FieldValue.increment(1),
      lastChatAt: admin.firestore.FieldValue.serverTimestamp(),
      lastChatPreview: `${employeeName} confirmed the repeat task`,
    });

    res.json({ success: true, status: "repeat_active" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── REPEAT TASK SUBMIT — employee submits a daily slot ────────────────────────
// POST /cowork/task/:taskId/repeat-submit
// Body: { date, slotIndex, comment, files: [{ name, url, type, ... }] }
router.post("/task/:taskId/repeat-submit", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { employeeId, name: employeeName } = req.coworkUser;
    const { date, slotIndex, comment, files } = req.body;
    const { db, admin } = require("../../config/firebaseAdmin");

    if (!date || slotIndex === undefined) return res.status(400).json({ error: "date and slotIndex required" });

    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Task not found" });

    const task = snap.data();
    if (!task.isRepeat) return res.status(400).json({ error: "Not a repeat task" });
    if (!task.assigneeIds?.includes(employeeId)) return res.status(403).json({ error: "Not assigned" });

    const slotKey = `slot_${slotIndex}`;

    // Check not already submitted
    if (task.repeatSubmissions?.[date]?.[slotKey]) {
      return res.status(400).json({ error: "Already submitted for this slot today" });
    }

    const submissionData = {
      submittedAt: new Date().toISOString(),
      submittedBy: employeeId,
      submittedByName: employeeName,
      comment: comment || "",
      files: files || [],
      slotIndex,
    };

    // Save submission using dot-notation key
    await taskRef.update({
      [`repeatSubmissions.${date}.${slotKey}`]: submissionData,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Post to task chat
    const { v4: uuidv4 } = require("uuid");
    const msgId = uuidv4();
    const hasFiles = files?.length > 0;
    const chatText = [
      `📋 Slot ${slotIndex + 1} submitted`,
      comment ? `"${comment}"` : null,
      hasFiles ? `${files.length} file${files.length > 1 ? "s" : ""} attached` : null,
    ].filter(Boolean).join(" — ");

    await db.collection("cowork_tasks").doc(taskId).collection("chat").doc(msgId).set({
      messageId: msgId, taskId,
      senderId: employeeId, senderName: employeeName,
      text: chatText,
      attachments: files?.map(f => ({ url: f.url, name: f.name, type: f.type || "file", downloadUrl: f.downloadUrl || f.url })) || [],
      messageType: hasFiles ? "attachment" : "text",
      isRepeatSubmission: true,
      repeatDate: date,
      repeatSlot: slotIndex,
      mention: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await taskRef.update({
      chatMessageCount: admin.firestore.FieldValue.increment(1),
      lastChatAt: admin.firestore.FieldValue.serverTimestamp(),
      lastChatPreview: `${employeeName}: Slot ${slotIndex + 1} submitted`,
    });

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── THIRD-PARTY UPDATE — employee logs a vendor update ───────────────────────
router.post("/task/:taskId/third-party-update", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { employeeId, name: employeeName } = req.coworkUser;
    const { type, message, files, amount, paymentNote } = req.body;
    const { db, admin } = require("../../config/firebaseAdmin");
    const { v4: uuidv4 } = require("uuid");

    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Task not found" });
    const task = snap.data();
    if (!task.isThirdParty) return res.status(400).json({ error: "Not a third-party task" });
    if (!task.assigneeIds?.includes(employeeId)) return res.status(403).json({ error: "Not assigned" });

    const updateId = uuidv4();
    const updateEntry = {
      id: updateId, type, message: message || "",
      files: files || [],
      loggedBy: employeeId, loggedByName: employeeName,
      createdAt: new Date().toISOString(),
      ...(type === "payment_request" ? { amount, paymentNote: paymentNote || "", paymentStatus: null } : {}),
    };

    // Determine thirdPartyStatus from update type
    const statusMap = {
      vendor_contacted: "waiting_vendor", vendor_replied: "vendor_responded",
      follow_up: "in_follow_up", delay_reported: "delayed",
      quote_received: "vendor_responded", order_dispatched: "vendor_responded",
      payment_request: task.thirdPartyStatus || "in_progress",
      resolved: "completed_pending_review",
    };

    const taskFieldUpdate = {
      vendorUpdates: admin.firestore.FieldValue.arrayUnion(updateEntry),
      thirdPartyStatus: statusMap[type] || task.thirdPartyStatus,
      lastUpdateAt: admin.firestore.FieldValue.serverTimestamp(),
      isStale: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Resolved → submit for CEO/TL approval
    if (type === "resolved") {
      taskFieldUpdate.completionStatus = "submitted";
      taskFieldUpdate.submittedBy = employeeId;
      taskFieldUpdate.submittedByName = employeeName;
      taskFieldUpdate.submittedAt = admin.firestore.FieldValue.serverTimestamp();
    }

    await taskRef.update(taskFieldUpdate);

    // Post to task chat
    const msgId = uuidv4();
    const UPDATE_LABELS = { vendor_contacted: "📞 Vendor Contacted", vendor_replied: "💬 Vendor Replied", follow_up: "🔄 Following Up", delay_reported: "⚠️ Delay Reported", quote_received: "📄 Quote Received", payment_request: "💰 Payment Request", order_dispatched: "🚚 Order Dispatched" };
    const chatText = [UPDATE_LABELS[type] || type, message, amount ? `₹${Number(amount).toLocaleString("en-IN")}` : null].filter(Boolean).join(" — ");
    await db.collection("cowork_tasks").doc(taskId).collection("chat").doc(msgId).set({
      messageId: msgId, taskId, senderId: employeeId, senderName: employeeName,
      text: chatText,
      attachments: files?.map(f => ({ url: f.url, name: f.name, type: f.type || "file", downloadUrl: f.downloadUrl || f.url })) || [],
      messageType: files?.length ? "attachment" : "text",
      isThirdPartyUpdate: true, updateType: type, mention: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await taskRef.update({
      chatMessageCount: admin.firestore.FieldValue.increment(1),
      lastChatAt: admin.firestore.FieldValue.serverTimestamp(),
      lastChatPreview: `${employeeName}: ${UPDATE_LABELS[type] || type}`,
    });

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── THIRD-PARTY COMPLETE — CEO/TL marks task as done ─────────────────────────
router.post("/task/:taskId/third-party-complete", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { employeeId, name: approverName, role } = req.coworkUser;
    if (!["ceo", "tl"].includes(role)) return res.status(403).json({ error: "Only CEO/TL can complete third-party tasks" });

    const { db, admin } = require("../../config/firebaseAdmin");
    const { v4: uuidv4 } = require("uuid");

    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Task not found" });
    const task = snap.data();
    if (!task.isThirdParty) return res.status(400).json({ error: "Not a third-party task" });
    if (task.completionStatus !== "submitted") return res.status(400).json({ error: "Task has not been submitted for completion yet" });

    await taskRef.update({
      status: "done",
      completionStatus: "approved",
      thirdPartyStatus: "completed",
      approvedBy: employeeId,
      approvedByName: approverName,
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Post system message to chat
    const msgId = uuidv4();
    await db.collection("cowork_tasks").doc(taskId).collection("chat").doc(msgId).set({
      messageId: msgId, taskId,
      senderId: employeeId, senderName: approverName,
      text: `✅ Task marked as Completed by ${approverName}`,
      attachments: [], messageType: "system",
      isThirdPartyUpdate: true, updateType: "completed", mention: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await taskRef.update({
      chatMessageCount: admin.firestore.FieldValue.increment(1),
      lastChatAt: admin.firestore.FieldValue.serverTimestamp(),
      lastChatPreview: `${approverName}: Task Completed ✅`,
    });

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── THIRD-PARTY PAYMENT ACTION — CEO/TL approves or rejects payment request ──
router.post("/task/:taskId/third-party-payment-action", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { employeeId, name: approverName, role } = req.coworkUser;
    const { updateId, action } = req.body; // action: "approved" | "rejected"
    if (!["approved", "rejected"].includes(action)) return res.status(400).json({ error: "Invalid action" });
    if (!["ceo", "tl"].includes(role)) return res.status(403).json({ error: "Only CEO/TL can approve payments" });

    const { db, admin } = require("../../config/firebaseAdmin");
    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Task not found" });

    const task = snap.data();
    const updates = task.vendorUpdates || [];
    const updatedUpdates = updates.map(u =>
      u.id === updateId ? { ...u, paymentStatus: action, approvedBy: employeeId, approvedByName: approverName, approvedAt: new Date().toISOString() } : u
    );

    await taskRef.update({
      vendorUpdates: updatedUpdates,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Notify in chat
    const { v4: uuidv4 } = require("uuid");
    const msgId = uuidv4();
    await db.collection("cowork_tasks").doc(taskId).collection("chat").doc(msgId).set({
      messageId: msgId, taskId, senderId: employeeId, senderName: approverName,
      text: `💰 Payment request ${action === "approved" ? "✅ Approved" : "❌ Rejected"} by ${approverName}`,
      attachments: [], messageType: "system", isThirdPartyUpdate: true, updateType: "payment_action", mention: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await taskRef.update({ chatMessageCount: admin.firestore.FieldValue.increment(1), lastChatAt: admin.firestore.FieldValue.serverTimestamp() });

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GOAL UPDATE — employee logs additive progress ─────────────────────────────
router.post("/task/:taskId/goal-update", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { employeeId, name: employeeName } = req.coworkUser;
    const { addedValue, currentValue, note } = req.body;
    const { db, admin } = require("../../config/firebaseAdmin");
    const { v4: uuidv4 } = require("uuid");

    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Task not found" });
    const task = snap.data();
    if (!task.isGoal) return res.status(400).json({ error: "Not a goal task" });
    if (!task.assigneeIds?.includes(employeeId)) return res.status(403).json({ error: "Not assigned" });

    const val = parseFloat(addedValue);
    if (isNaN(val) || val < 0) return res.status(400).json({ error: "Invalid value" });

    const updateId = uuidv4();
    const updateEntry = {
      id: updateId,
      addedValue: val,
      currentValue: currentValue !== undefined ? parseFloat(currentValue) : null,
      note: note || "",
      loggedBy: employeeId,
      loggedByName: employeeName,
      createdAt: new Date().toISOString(),
    };

    const newAchieved = (task.goalAchieved || 0) + val;
    const target = task.goalConfig?.targetValue || 0;
    const pct = target > 0 ? Math.round((newAchieved / target) * 100) : 0;

    await taskRef.update({
      goalUpdates: admin.firestore.FieldValue.arrayUnion(updateEntry),
      goalAchieved: newAchieved,
      progressPercent: Math.min(pct, 100),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Post to chat
    const msgId = uuidv4();
    const gc = task.goalConfig || {};
    const unitLabel = gc.unit || (gc.goalType === "amount" ? "₹" : gc.goalType === "percentage" ? "%" : "");
    const chatText = `📈 Progress update: +${unitLabel}${Number(val).toLocaleString("en-IN")} added${note ? ` — "${note}"` : ""}. Total: ${pct}% achieved.`;
    await db.collection("cowork_tasks").doc(taskId).collection("chat").doc(msgId).set({
      messageId: msgId, taskId, senderId: employeeId, senderName: employeeName,
      text: chatText, attachments: [], messageType: "text",
      isGoalUpdate: true, mention: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await taskRef.update({
      chatMessageCount: admin.firestore.FieldValue.increment(1),
      lastChatAt: admin.firestore.FieldValue.serverTimestamp(),
      lastChatPreview: chatText,
    });

    res.json({ success: true, goalAchieved: newAchieved, progressPercent: pct });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 3. START ──────────────────────────────────────────────────────────────────
router.post("/task/:taskId/start", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const result = await svc.markTaskStarted({ taskId: req.params.taskId, employeeId: req.coworkUser.employeeId, employeeName: req.coworkUser.name });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 4. TL APPROVE task (when employee assigned task to TL) ────────────────────
router.post("/task/:taskId/approve", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { employeeId, role: requesterRole, name } = req.coworkUser;
    if (requesterRole !== "tl") return res.status(403).json({ error: "Only TL can approve tasks." });

    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Task not found" });
    const task = snap.data();

    if (!task.assigneeIds?.includes(employeeId)) {
      return res.status(403).json({ error: "You are not assigned to this task." });
    }
    if (task.status !== "pending_tl_approval") {
      return res.status(400).json({ error: "Task is not pending TL approval." });
    }

    await taskRef.update({
      status: "open",
      tlApprovedBy: employeeId,
      tlApprovedByName: name,
      tlApprovedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Post system message in task chat
    await postSystemChatMessage(taskId, `✅ Task approved by ${name} (TL)`, employeeId, name);

    res.json({ success: true, message: "Task approved." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/task/:taskId/department-approve", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { decision, rejectionReason = "" } = req.body;
    const { employeeId, name } = req.coworkUser;
    if (!["approve", "reject"].includes(decision)) {
      return res.status(400).json({ error: "decision must be 'approve' or 'reject'." });
    }
    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(taskRef);
      if (!snap.exists) return { httpStatus: 404, body: { error: "Task not found." } };
      const task = snap.data();
      if (task.status !== "pending_department_approval") {
        return { httpStatus: 400, body: { error: "This task is not waiting on a department approval." } };
      }
      const approvals = task.departmentApprovals || [];
      const idx = approvals.findIndex(a => a.approverId === employeeId && a.status === "pending");
      if (idx === -1) {
        return { httpStatus: 403, body: { error: "You have no pending approval on this task." } };
      }
      const updatedApprovals = approvals.map((a, i) => i === idx ? { ...a } : a);
      if (decision === "reject") {
        updatedApprovals[idx].status = "rejected";
        updatedApprovals[idx].respondedAt = admin.firestore.Timestamp.now();
        updatedApprovals[idx].rejectionReason = rejectionReason || "";
        // This tx.update call was missing entirely — the branch computed the
        // rejection into a local variable and returned "success" without ever
        // writing it to Firestore. The task's status stayed
        // "pending_department_approval" forever, so it never left the
        // Cross-Department Approval Needed list no matter how many times
        // Reject was clicked.
        tx.update(taskRef, { departmentApprovals: updatedApprovals, status: "rejected", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        return { httpStatus: 200, body: { success: true, status: "rejected" }, outcome: "rejected", task };
      }

      updatedApprovals[idx].status = "approved";
      updatedApprovals[idx].respondedAt = admin.firestore.Timestamp.now();
      updatedApprovals[idx].rejectionReason = null;

      // ── Sequential gate ────────────────────────────────────────────────────
      // Once the sender's TL approves, flip the receiver's entry from "waiting"
      // to "pending" — that's the moment it's actually sent to the receiver's
      // TL. Before this runs, the receiver's TL has no "pending" entry to act
      // on at all, so they can't approve out of order.
      if (updatedApprovals[idx].side === "sender") {
        const receiverIdx = updatedApprovals.findIndex(a => a.side === "receiver" && a.status === "waiting");
        if (receiverIdx !== -1) updatedApprovals[receiverIdx].status = "pending";
      }

      const allApproved = updatedApprovals.every(a => a.status === "approved");

      if (!allApproved) {
        tx.update(taskRef, { departmentApprovals: updatedApprovals, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        // If this approval just came from the sender's side, the receiver's
        // entry was flipped "waiting" → "pending" a few lines up — that's the
        // exact moment it becomes their turn. Re-find them here (independent
        // of the block-scoped receiverIdx above) so the notification below
        // knows who to tell.
        const nowPendingApprover = updatedApprovals[idx].side === "sender"
          ? updatedApprovals.find(a => a.side === "receiver" && a.status === "pending")
          : null;
        return { httpStatus: 200, body: { success: true, status: "pending_department_approval", message: "Your approval is recorded. Waiting on the other approver." }, outcome: "waiting", task, nowPendingApprover };
      }
      const finalAssigneeId = task.pendingAssigneeId;
      const finalStatus = (task.hasTimer === false) ? "pending_tl_hours" : "open";
      // ── Visibility gate ──────────────────────────────────────────────────────
      // Only add the assignee to assigneeIds here when going straight to "open"
      // (duration was already set at creation). If it's dropping into
      // "pending_tl_hours" instead, the assignee is added later, inside
      // department-tl-set-hours, at the exact moment the timer is actually set —
      // the task stays invisible to them until then.
      const updatePayload = { departmentApprovals: updatedApprovals, status: finalStatus, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
      if (finalStatus === "open") {
        updatePayload.assigneeIds = admin.firestore.FieldValue.arrayUnion(finalAssigneeId);
      }
      tx.update(taskRef, updatePayload);
      return { httpStatus: 200, body: { success: true, status: finalStatus }, outcome: "completed", task, finalAssigneeId, finalStatus };
    });
    if (result.outcome === "rejected") {
      await postSystemChatMessage(taskId, `❌ Cross-department assignment rejected by ${name}${rejectionReason ? `: "${rejectionReason}"` : ""}`, employeeId, name);
      await _notify({ recipientIds: [result.task.assignedBy].filter(Boolean), type: "department_approval_rejected", title: "❌ Assignment Rejected", body: `${name} rejected your cross-department task "${result.task.title}"${rejectionReason ? `: ${rejectionReason}` : ""}`, data: { taskId }, senderId: employeeId, senderName: name });
    } else if (result.outcome === "waiting" && result.nowPendingApprover) {
      await postSystemChatMessage(taskId, `☑️ ${name} approved — waiting on ${result.nowPendingApprover.approverName || "the other department"} to approve.`, employeeId, name);
      await _notify({ recipientIds: [result.nowPendingApprover.approverId].filter(Boolean), type: "department_approval_your_turn", title: "🔔 Your Approval Needed", body: `${name} approved "${result.task.title}" from their side. It's now waiting on your approval.`, data: { taskId }, senderId: employeeId, senderName: name });
    } else if (result.outcome === "completed" && result.finalStatus === "pending_tl_hours") {
      // The assignee's MANAGER, not their department's TL. This is the
      // notification that actually fires on the cross-department path, so it
      // has to name the same person the endpoint now accepts — otherwise the
      // system tells one person to act and refuses them when they do.
      const draftManager = await _getPrimaryManagerApprover(result.finalAssigneeId);
      await postSystemChatMessage(taskId, draftManager ? `✅ Both HODs approved — waiting on ${draftManager.approverName} to set estimated hours.` : "✅ Both HODs approved — waiting on the assignee's manager to set estimated hours.", employeeId, name);
      if (draftManager) {
        await _notify({ recipientIds: [draftManager.approverId], type: "department_draft_needs_hours", title: "📝 Draft Task Needs Your Hours Estimate", body: `Both HODs approved "${result.task.title}" — set the real ETC hours before it goes to your team member.`, data: { taskId }, senderId: employeeId, senderName: name });
      }
    } else if (result.outcome === "completed") {
      await postSystemChatMessage(taskId, "✅ Cross-department assignment approved by both sides — task is now assigned.", employeeId, name);
      await _notify({ recipientIds: [result.task.assignedBy, result.finalAssigneeId].filter(Boolean), type: "department_approval_completed", title: "✅ Cross-Department Task Approved", body: `Both approvals are in — "${result.task.title}" is now assigned.`, data: { taskId }, senderId: employeeId, senderName: name });
    }
    res.status(result.httpStatus).json(result.body);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/task/:taskId/department-tl-set-hours", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { hoursValue, hoursUnit } = req.body;
    const { employeeId, role, name } = req.coworkUser;
    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Task not found." });
    const task = snap.data();
    if (task.status !== "pending_tl_hours") {
      return res.status(400).json({ error: "This task is not waiting on TL hours — it may already be active." });
    }
    // pendingAssigneeId covers the cross-department-approval path, where the
    // assignee isn't added to assigneeIds until this exact step (see below).
    // Falls back to assigneeIds[0] for the no-gate deadline-mode path, where
    // the assignee was already present from task creation.
    const targetId = task.pendingAssigneeId || task.assigneeIds?.[0];
    if (!targetId) {
      return res.status(400).json({ error: "This task has no assignee yet." });
    }
    // The time budget belongs to whoever MANAGES the person doing the work —
    // not to a department. The two questions are separate: department approval
    // asks "can this cross-department work happen at all", and this asks "how
    // many hours does this employee get for it". Only the second is a
    // management decision about a person, so it follows the reporting line.
    //
    // Was: `role !== "tl" || targetInfo.department !== callerDept`, which handed
    // the decision to the receiving department's TL — someone who may not
    // manage the assignee at all, and who on a same-department task is not
    // involved in the work.
    //
    // `_getPrimaryManagerApprover` is the same reporting lookup the approval
    // chain already uses, so this introduces no new notion of hierarchy.
    const manager = await _getPrimaryManagerApprover(targetId);
    if (!manager) {
      return res.status(400).json({ error: "This task's assignee has no manager recorded, so nobody can set its time budget." });
    }
    if (manager.approverId !== employeeId) {
      return res.status(403).json({ error: `Only ${manager.approverName}, who manages the assignee, can set hours for this task.` });
    }

    const val = Number(hoursValue) || 0;
    if (val <= 0) return res.status(400).json({ error: "Enter a valid number of hours." });
    const unit = hoursUnit || "hours";
    const secs = val * (unit === "minutes" ? 60 : unit === "days" ? 86400 : 3600);

    // Becomes a normal hasTimer:true task with a manager-preset duration —
    // same senderTimerWindowSecs mechanism as any other task. Lands in the
    // EXISTING "Draft" section and negotiates via the EXISTING
    // approve-sender-timer flow — no custom logic needed for that part.
    // arrayUnion here is also what first makes the task visible to the
    // assignee on the cross-department path — it's a no-op if they were
    // already present (the no-gate deadline-mode path).
    // ── The deadline is set HERE, from THIS moment ────────────────────────────
    //
    // Granting the hours is what makes the work real, so the window runs from
    // the grant. It was previously never computed on this path at all: the task
    // kept whatever date the SENDER's create wrote, hours or days earlier,
    // which is time the assignee was never given and could not have used. A
    // manager granting two hours at 14:30 means 16:30, not a date chosen before
    // anyone knew who would do the work.
    //
    // The anchor is also kept as a plain number. The budget negotiation
    // re-derives this deadline from this exact instant if the window is later
    // renegotiated, and a `serverTimestamp()` sentinel cannot be read back
    // inside the write that sets it.
    const { computeWorkingDeadline } = require("../../services/officeDeadline.service");
    const anchorMs = Date.now();
    const dueDate = await computeWorkingDeadline({ startMs: anchorMs, windowSecs: secs });

    await taskRef.update({
      status: "open",
      hasTimer: true,
      senderTimerWindowSecs: secs,
      /* The granted figure in the fields the product reads as AGREED, not
         merely offered — the same three the other approve paths write. */
      deadlineWindowSecs: secs,
      originalWindowSecs: Number(task.originalWindowSecs) || secs,
      etcHours: secs / 3600,
      dueDate,
      /* This task is on a timer now, and a `fixedDeadline` left over from the
         sender's create SHADOWS everything computed above: the read precedence
         is `fixedDeadline ?? deadline ?? dueDate`, so the granted window could
         never move the date anybody actually saw. */
      fixedDeadline: null,
      tlHoursSetBy: employeeId,
      tlHoursSetByName: name,
      tlHoursSetAt: admin.firestore.FieldValue.serverTimestamp(),
      tlHoursSetAtMs: anchorMs,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      assigneeIds: admin.firestore.FieldValue.arrayUnion(targetId),
    });

    await postSystemChatMessage(taskId, `⏱ ${name} (TL) set the estimated hours — task is now active.`, employeeId, name);
    await _notify({ recipientIds: [targetId, task.assignedBy].filter(Boolean), type: "department_draft_activated", title: "✅ Task Now Active", body: `${name} set the hours — "${task.title}" is ready.`, data: { taskId }, senderId: employeeId, senderName: name });
    res.json({ success: true, status: "open" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 5. FORWARD ────────────────────────────────────────────────────────────────
router.post("/task/:taskId/forward", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { assignments } = req.body;
    if (!assignments?.length) return res.status(400).json({ error: "assignments required" });
    const result = await svc.forwardTask({
      parentTaskId: req.params.taskId,
      forwardedBy: req.coworkUser.employeeId,
      forwardedByName: req.coworkUser.name,
      assignments,
    });
    res.status(201).json({ success: true, ...result });
    // Email handled inside svc.forwardTask() via _notifyMany → sendNotificationEmail

  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get("/task/:taskId/forward-budget", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const result = await svc.getForwardBudget({ parentTaskId: req.params.taskId });
    res.json({ success: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get("/task/:taskId/forward-budget", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const result = await svc.getForwardBudget({ parentTaskId: req.params.taskId });
    res.json({ success: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 6. CREATE SUBTASK ─────────────────────────────────────────────────────────
router.post("/task/:taskId/subtask", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    // A subtask follows the SAME lifecycle as a standard task — the timer/budget
    // negotiation, priority and review all apply — so it carries the same fields
    // rather than a truncated set that dropped the budget silently.
    const { title, description, notes, assigneeIds, satisfiesRequirementIds, requirements, priority, hasTimer, senderTimerWindowSecs, fixedDeadline, isSelfAssigned, approverId, approverName } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: "title required" });
    if (!assigneeIds?.length) return res.status(400).json({ error: "assigneeIds required" });

    const parentDoc = await db.collection("cowork_tasks").doc(req.params.taskId).get();
    if (!parentDoc.exists) return res.status(404).json({ error: "Parent task not found" });
    const parent = parentDoc.data();

    const { role: requesterRole, employeeId, name } = req.coworkUser;
    const canCreate = ["ceo", "tl"].includes(requesterRole)
      || parent.assigneeIds?.includes(employeeId)
      || parent.assignedBy === employeeId;
    if (!canCreate) return res.status(403).json({ error: "Not authorized to create subtasks here." });

    // Self-assigned subtask (you break your own work into a piece for yourself):
    // the counterparty is the assignee's PRIMARY MANAGER, exactly like a self
    // task — you cannot negotiate a budget with or review your own subtask. For a
    // subtask delegated to someone ELSE, the creator stays the assigner of record.
    let subAssignedBy = employeeId;
    let subAssignedByName = name;
    let subAssignedByRole = requesterRole;
    let subApproverId = approverId || null;
    let subApproverName = approverName || null;
    const subIsSelf = (isSelfAssigned === true || isSelfAssigned === "true")
      || (assigneeIds.length === 1 && assigneeIds[0] === employeeId);
    if (subIsSelf) {
      if (!subApproverId) {
        const mgr = await _getPrimaryManagerApprover(assigneeIds[0]);
        if (mgr && mgr.approverId) { subApproverId = mgr.approverId; subApproverName = mgr.approverName; }
      }
      if (subApproverId && subApproverId !== employeeId) {
        const approverInfo = await getEmployeeInfo(subApproverId);
        if (approverInfo) {
          subAssignedBy = subApproverId;
          subAssignedByName = subApproverName || approverInfo.name;
          subAssignedByRole = approverInfo.role || "tl";
        }
      }
    }

    // Per-person auto-priority for subtask
    let subtaskAssigneePriorities = {};
    let subtaskPriority = (typeof priority === "number" ? priority : Number(priority)) || null;
    try {
      // Same rule as every other create path — highest active rank + 1, with
      // approved work excluded. See `nextActiveRankFor`.
      subtaskAssigneePriorities = await svc.assigneePrioritiesFor(db, assigneeIds);
      if (!subtaskPriority) subtaskPriority = subtaskAssigneePriorities[assigneeIds[0]] || 1;
    } catch (e) {
      console.warn("[subtask/create] auto-priority fallback:", e.message);
      if (!subtaskPriority) subtaskPriority = 1;
      assigneeIds.forEach(aid => {
        if (!subtaskAssigneePriorities[aid]) subtaskAssigneePriorities[aid] = subtaskPriority;
      });
    }

    const subtask = await svc.createTask({
      title: title.trim(), description, notes,
      assignedBy: subAssignedBy,
      assignedByName: subAssignedByName,
      assignedByRole: subAssignedByRole,
      // Real creator (the person breaking the work out), distinct from the
      // assigner of record when a self subtask is manager-mediated.
      createdBy: req.coworkUser.employeeId,
      assigneeIds,
      dueDate: null,
      priority: subtaskPriority,
      assigneePriorities: subtaskAssigneePriorities,
      parentTaskId: req.params.taskId,
      // The parent requirements this subtask is answerable for. Passed straight
      // through — the ids are the caller's vocabulary, and the engine stores
      // them without deciding what they mean. A caller that names none gets an
      // empty array, which is a subtask that closes no requirement rather than
      // a rejected request.
      satisfiesRequirementIds,
      // The subtask's OWN acceptance criteria — a different thing from the
      // claims above, and dropped on this route until 16 Aug 2026. The create
      // route has always read it; this one did not, so criteria typed into the
      // subtask form were discarded while the same field on an ordinary task
      // saved correctly.
      requirements: Array.isArray(requirements) ? requirements : [],
      // TL subtasks should NOT show in CEO tree
      createdByTl: requesterRole === "tl",
      createdByCeo: requesterRole === "ceo",
      // Standard-flow parity: the timer/budget negotiation applies (assignee
      // proposes within the budget, the assigner of record decides), and a self
      // subtask is approved & reviewed by the assignee's manager.
      hasTimer: hasTimer !== false && hasTimer !== "false",
      fixedDeadline: fixedDeadline || null,
      senderTimerWindowSecs: Number(senderTimerWindowSecs) || 0,
      isSelfAssigned: subIsSelf,
      approverId: subApproverId,
      approverName: subApproverName,
    });

    // Post chat notification in parent task (visible to CEO + TL)
    await postSystemChatMessage(
      req.params.taskId,
      `📋 Subtask "${title.trim()}" has been created by ${name}`,
      employeeId,
      name
    );

    res.status(201).json({ success: true, subtask });
    // Email handled inside svc.createTask() via _notifyMany → sendNotificationEmail

  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 7. DAILY REPORT ───────────────────────────────────────────────────────────
router.post("/task/:taskId/daily-report", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { message, imageUrls, pdfAttachments, progressPercent, reportDate } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: "message required" });
    if (progressPercent == null) return res.status(400).json({ error: "progressPercent required" });
    const result = await svc.submitDailyReport({
      taskId: req.params.taskId,
      employeeId: req.coworkUser.employeeId,
      employeeName: req.coworkUser.name,
      message: message.trim(),
      imageUrls: imageUrls || [],
      pdfAttachments: pdfAttachments || [],
      progressPercent: Number(progressPercent),
      reportDate,
    });
    res.status(201).json({ success: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 8. TASK CHAT — SEND ───────────────────────────────────────────────────────
router.post("/task/:taskId/chat", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { text, attachments, messageType, mention } = req.body;
    if (!text?.trim() && (!attachments || !attachments.length)) return res.status(400).json({ error: "text or attachments required" });
    const msg = await svc.sendTaskChat({
      taskId: req.params.taskId,
      senderId: req.coworkUser.employeeId,
      senderName: req.coworkUser.name,
      text: text || "",
      attachments: attachments || [],
      messageType: messageType || "text",
      mention: mention || null,
    });
    res.status(201).json({ success: true, message: msg });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 9. TASK CHAT — GET ────────────────────────────────────────────────────────
router.get("/task/:taskId/chat", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const messages = await svc.getTaskChat(req.params.taskId, req.query.limit);
    res.json({ messages });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 10. TASK DETAILS ──────────────────────────────────────────────────────────
router.get("/task/:taskId/details", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const task = await svc.getTaskWithDetails(req.params.taskId);
    if (!task) return res.status(404).json({ error: "Task not found" });
    res.json({ task });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 11. LIST TASKS WITH HIERARCHY (visibility rules applied) ──────────────────
router.get("/task/list-hierarchy", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { employeeId, role } = req.coworkUser;
    const { cursor, pageSize } = req.query;
    const { tasks: allTasks, nextCursor, hasMore } = await svc.listTasksWithHierarchy(
      employeeId, role, cursor || null, Number(pageSize) || 100
    );

    let filtered = allTasks;

    if (role === "ceo") {
      // CEO sees: tasks they created OR assigned to them OR self-assign tasks where CEO is approver
      filtered = allTasks.filter(t => {
        const assignedToMe = (t.assigneeIds || []).includes(employeeId);
        const createdByMe = t.assignedBy === employeeId || t.createdByCeo === true || t.assignedByRole === "ceo";
        const isMyApproval = t.approverId === employeeId || (Array.isArray(t.visibleTo) && t.visibleTo.includes(employeeId));
        return assignedToMe || createdByMe || isMyApproval;
      });
    } else if (role === "tl") {
      // TL: sees tasks they created OR assigned to them OR self-assign tasks where TL is approver
      filtered = allTasks.filter(t => {
        const assignedToMe = (t.assigneeIds || []).includes(employeeId);
        const createdByMe = t.assignedBy === employeeId;
        const isMyApproval = t.approverId === employeeId || (Array.isArray(t.visibleTo) && t.visibleTo.includes(employeeId));
        return assignedToMe || createdByMe || isMyApproval;
      });
    }
    // Employee: sees their own assigned tasks only (handled in svc.listTasksWithHierarchy)

    res.json({ tasks: filtered, nextCursor, hasMore });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 12. DAILY REPORTS for a task ──────────────────────────────────────────────
router.get("/task/:taskId/daily-reports", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const reports = await svc.getTaskDailyReports(req.params.taskId);
    res.json({ reports });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 13. EDIT DEADLINE (CEO only) ──────────────────────────────────────────────
router.patch("/task/:taskId/deadline", verifyCoworkToken, verifyCeoToken, async (req, res) => {
  try {
    const { newDueDate, reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ error: "reason required" });
    await svc.editTaskDeadline({ taskId: req.params.taskId, newDueDate: newDueDate || null, reason: reason.trim(), editedBy: req.coworkUser.employeeId, editedByName: req.coworkUser.name });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 14. DELETE TASK (CEO only) ────────────────────────────────────────────────
router.delete("/task/:taskId", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  if (!["ceo", "tl"].includes(req.coworkUser.role)) return res.status(403).json({ error: "Only CEO or TL can delete tasks" });
  try {
    const result = await svc.deleteTask({ taskId: req.params.taskId, deletedBy: req.coworkUser.employeeId });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 14b. MOVE TASK INTO FOLDER (CEO/TL only) ──────────────────────────────────
router.post("/task/:taskId/move-to-folder", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { folderId } = req.body;
    if (!["ceo", "tl"].includes(req.coworkUser.role)) return res.status(403).json({ error: "Only CEO or TL can move tasks into a folder." });
    if (!folderId) return res.status(400).json({ error: "folderId is required." });
    if (folderId === taskId) return res.status(400).json({ error: "A task cannot be moved into itself." });

    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const folderRef = db.collection("cowork_tasks").doc(folderId);
    const [taskSnap, folderSnap] = await Promise.all([taskRef.get(), folderRef.get()]);
    if (!taskSnap.exists) return res.status(404).json({ error: "Task not found." });
    if (!folderSnap.exists) return res.status(404).json({ error: "Folder not found." });
    const task = taskSnap.data();
    const folder = folderSnap.data();
    if (!folder.isFolder) return res.status(400).json({ error: "Target is not a folder." });
    if (task.isFolder) return res.status(400).json({ error: "A folder can't be moved into another folder." });

    // Only parentTaskId + the two folders' subtaskIds change — the task keeps
    // its own status/assigneeIds/timer exactly as they were, same as a
    // subtask created directly under a folder keeps its own properties.
    const oldParentId = task.parentTaskId || null;
    const batch = db.batch();
    batch.update(taskRef, { parentTaskId: folderId, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    batch.update(folderRef, { subtaskIds: admin.firestore.FieldValue.arrayUnion(taskId), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    if (oldParentId && oldParentId !== folderId) {
      batch.update(db.collection("cowork_tasks").doc(oldParentId), { subtaskIds: admin.firestore.FieldValue.arrayRemove(taskId), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
    await batch.commit();

    // The assignees keep the task but find it somewhere else. Without this the
    // work simply disappears from where they last saw it.
    await _notify({
      recipientIds: (task.assigneeIds || []).filter(id => id && id !== req.coworkUser.employeeId),
      type: "task_moved",
      title: "📁 Task moved",
      body: `${req.coworkUser.name} moved "${task.title}" into ${folder.title}. The work is unchanged — only where it sits.`,
      data: { taskId, folderId, folderTitle: folder.title },
      senderId: req.coworkUser.employeeId,
      senderName: req.coworkUser.name,
    });

    res.json({ success: true, taskId, folderId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mirrors isConfirmed/isStarted from tasks/page.js exactly (the same statuses
// that already gate the Edit Task button on the frontend), so "has this task
// passed draft" means the same thing on both sides.
const EDIT_PASSED_DRAFT_STATUSES = ["confirmed", "in_progress", "done", "submitted", "tl_approved", "tl_final_approved", "ceo_approved"];

router.patch("/task/:taskId/edit-details", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { title, description, requirements } = req.body;

    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Task not found." });
    const task = snap.data();

    const hasPassedDraft = EDIT_PASSED_DRAFT_STATUSES.includes(task.status);
    if (!hasPassedDraft) {
      if (!["ceo", "tl"].includes(req.coworkUser.role)) return res.status(403).json({ error: "Only CEO or TL can edit task details." });
    } else if (task.assignedBy !== req.coworkUser.employeeId) {
      return res.status(403).json({ error: "This task has already started — only the sender who assigned it can edit it now." });
    }

    if (title !== undefined && !title.trim()) return res.status(400).json({ error: "Title cannot be empty." });

    const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (title !== undefined) updates.title = title.trim();
    if (description !== undefined) updates.description = description;
    if (requirements !== undefined) updates.requirements = Array.isArray(requirements) ? requirements : [];

    await taskRef.update(updates);

    // ── Tell whoever has to DO it ────────────────────────────────────────────
    // Editing a task that has already started rewrites the brief of work
    // somebody is part-way through, and they had no way of knowing. Naming
    // WHICH parts changed matters more than usual here: "the task changed" sends
    // a person hunting through a description to find a word.
    const changed = [
      title !== undefined && "the title",
      description !== undefined && "the description",
      requirements !== undefined && "the requirements",
    ].filter(Boolean);
    await _notify({
      recipientIds: (task.assigneeIds || []).filter(id => id && id !== req.coworkUser.employeeId),
      type: "task_details_edited",
      title: "✏️ Task details changed",
      body: `${req.coworkUser.name} changed ${changed.join(", ") || "the details"} of "${updates.title || task.title}"${hasPassedDraft ? " — you have already started this one, so read it again before you carry on." : "."}`,
      data: { taskId, changed, hasPassedDraft },
      senderId: req.coworkUser.employeeId,
      senderName: req.coworkUser.name,
    });

    res.json({ success: true, taskId, title: updates.title, description: updates.description, requirements: updates.requirements });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── RESET TASK TO DRAFT (sender only, only meaningful once past draft) ────────
// Separate endpoint on purpose, matching the frontend: editing content and
// resetting workflow state are two distinct confirmations, not one combined
// call — the person can save the edit and decline the reset independently.
router.post("/task/:taskId/reset-to-draft", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Task not found." });
    const task = snap.data();

    if (task.assignedBy !== req.coworkUser.employeeId) {
      return res.status(403).json({ error: "Only the sender who assigned this task can reset it." });
    }
    if (!EDIT_PASSED_DRAFT_STATUSES.includes(task.status)) {
      return res.status(400).json({ error: "This task hasn't started yet — there's nothing to reset." });
    }

    // Only the negotiated deadline/duration and status are reset here — timer
    // history, chat, and activity logs are left untouched. I haven't traced
    // every downstream field those touch and don't want to guess at clearing
    // something that turns out to matter elsewhere.
    await taskRef.update({
      status: "open",
      deadlineWindowSecs: admin.firestore.FieldValue.delete(),
      deadlineApprovedBy: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // The strongest case for a notification in this file: a task somebody had
    // confirmed, negotiated a deadline for and possibly started is pulled back
    // to draft with its agreed window deleted. Silently, until now — they would
    // next open it and find the deadline they argued for simply gone.
    await _notify({
      recipientIds: (task.assigneeIds || []).filter(id => id && id !== req.coworkUser.employeeId),
      type: "task_reset_to_draft",
      title: "↩️ Task sent back to draft",
      body: `${req.coworkUser.name} reset "${task.title}" to draft. The agreed deadline has been cleared and it will need confirming again — do not keep working on it yet.`,
      data: { taskId, previousStatus: task.status },
      senderId: req.coworkUser.employeeId,
      senderName: req.coworkUser.name,
    });

    res.json({ success: true, taskId, status: "open" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 15. SUBMIT COMPLETION ─────────────────────────────────────────────────────
router.post("/task/:taskId/submit-completion", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { message, imageUrls, pdfAttachments } = req.body;
    const result = await svc.submitCompletionRequest({ taskId: req.params.taskId, employeeId: req.coworkUser.employeeId, employeeName: req.coworkUser.name, message: message || "", imageUrls: imageUrls || [], pdfAttachments: pdfAttachments || [] });
    res.status(201).json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── POST /task/:taskId/rework — TL sends task back for rework ────────────────
router.post("/task/:taskId/rework", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { reworkReason, waiveDeduction, reworkRequirements, reworkNote, reworkAttachments, reworkAttachmentIds, reworkPriority } = req.body;
    const { employeeId: reviewerId, name: reviewerName, role } = req.coworkUser;
    // The person who ASSIGNED this task may send it back. Was `role ===
    // "employee"` → refuse, which asked about a role string rather than about
    // this task: a primary manager carries `role: "employee"` here, so the
    // person who created and assigned the work could APPROVE a submission but
    // not send it back — the two halves of one decision, split apart.
    if (!(await isTaskHead(req.params.taskId, reviewerId, role))) {
      return res.status(403).json({ error: "Only this task's assigner, or a TL/CEO, can send it back for rework." });
    }
    const result = await svc.reworkTask({
      taskId: req.params.taskId,
      reviewerId, reviewerName,
      reworkReason: reworkReason || "",
      waiveDeduction: waiveDeduction === true || waiveDeduction === "true",
      reworkRequirements: reworkRequirements || [], reworkNote: reworkNote || "", reworkAttachments: reworkAttachments || [], reworkAttachmentIds: reworkAttachmentIds || [], reworkPriority: reworkPriority ?? null,
    });
    res.json(result);
  } catch (e) {
    console.error("[task/rework]", e.message);
    res.status(400).json({ error: e.message });
  }
});

// ── POST /task/:taskId/extension-waive — TL waives extension deduction ────────
// When TL approves extension and chooses "Waive Deduction",
// the new deadline becomes the official deadline (no extensionsFiled+1).
// When TL chooses "Confirm Deduction", extensionsFiled is incremented.
router.post("/task/:taskId/extension-deduction", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    let { waiveDeduction, newDeadline } = req.body; // ← const → let
    const { role, employeeId } = req.coworkUser;
    // Same rule as rework: this task's assigner, or a TL/CEO. Waiving is part
    // of the same review, so it must not be gated more tightly than the
    // decision it belongs to.
    if (!(await isTaskHead(req.params.taskId, employeeId, role))) {
      return res.status(403).json({ error: "Only this task's assigner, or a TL/CEO, can set the deduction." });
    }

    const { db: _db, admin: _admin } = require("../../config/firebaseAdmin");
    const ref = _db.collection("cowork_tasks").doc(req.params.taskId);

    // ── Auto-determine waive from stored elapsedPercent if TL didn't manually set ─
    if (waiveDeduction === undefined || waiveDeduction === null) {
      const _autoDoc = await ref.get();
      const _autoTask = _autoDoc.data() || {};
      const storedWaive = _autoTask.deadlineExtRequest?.isPenaltyWaived;
      if (typeof storedWaive === "boolean") waiveDeduction = storedWaive;
    }
    // ─────────────────────────────────────────────────────────────────────────────

    if (waiveDeduction) {
      // New deadline is official — no points cut for this extension
      await ref.update({
        "c1.officialDeadline": newDeadline || null,
        updatedAt: _admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      // Confirm deduction — extensionsFiled +1
      // Also set officialDeadline so original deadline no longer used for scoring
      const doc = await ref.get();
      const taskData = doc.data() || {};
      const current = Number(taskData?.c1?.extensionsFiled) || 0;
      await ref.update({
        "c1.extensionsFiled": current + 1,
        "c1.officialDeadline": newDeadline || null,
        updatedAt: _admin.firestore.FieldValue.serverTimestamp(),
      });
      // Write deduction to SOP history immediately
      const primaryEmp = (taskData.assigneeIds || [])[0] || null;
      if (primaryEmp) {
        const c1Svc = require("../../services/c1Service");
        setImmediate(() => c1Svc.writeExtensionDeduction({
          employeeId: primaryEmp,
          taskId: req.params.taskId,
          taskTitle: taskData.title || req.params.taskId,
          reviewerId: req.coworkUser?.employeeId || "",
          reviewerName: req.coworkUser?.name || "TL",
        }).catch(e => console.error("[ext deduction write]", e.message)));
      }
    }
    res.json({ success: true, waiveDeduction });
  } catch (e) {
    console.error("[task/extension-deduction]", e.message);
    res.status(400).json({ error: e.message });
  }
});

/**
 * What sending this back would do to the rest of that person's work.
 *
 * Read-only, and asked again on every change of the priority picker, so it
 * runs the real queue walk in simulation rather than a second copy of the
 * arithmetic — a preview that predicts something the commit does not do is
 * worse than no preview.
 */
router.get("/task/:taskId/rework-preview", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { db } = require("../../config/firebaseAdmin");
    const office = require("../../services/officeDeadline.service");

    const snap = await db.collection("cowork_tasks").doc(req.params.taskId).get();
    if (!snap.exists) return res.status(404).json({ error: "Task not found" });
    const task = snap.data();

    const assigneeId = String(req.query.assigneeId || (task.assigneeIds || [])[0] || "");
    if (!assigneeId) return res.json({ leftoverSecs: null, currentRank: null, rows: [] });

    /* The same number the rejection will actually give the rework. */
    const leftoverSecs = office.reworkLeftoverSecs(task);
    const currentRank = office.rankOf(task, assigneeId);
    const rank = Number(req.query.priority) > 0 ? Number(req.query.priority) : currentRank;

    const rows = await office.rechainQueueFor(assigneeId, {
      dryRun: true,
      reportAll: true,
      simulate: {
        taskId: req.params.taskId,
        rank,
        secs: leftoverSecs ?? 0,
        startMs: Date.now(),
      },
    });

    res.json({ leftoverSecs, currentRank, rank, rows });
  } catch (e) { res.status(400).json({ error: e.message }); }
});


router.post("/task/:taskId/review-completion", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { approved, rejectionReason, reworkRequirements, reworkNote, reworkAttachments, reworkAttachmentIds, reworkPriority } = req.body;
    if (typeof approved !== "boolean") return res.status(400).json({ error: "approved (boolean) required" });
    const result = await svc.reviewCompletion({ taskId: req.params.taskId, reviewerId: req.coworkUser.employeeId, reviewerName: req.coworkUser.name, approved, rejectionReason: rejectionReason || "", reworkRequirements: reworkRequirements || [], reworkNote: reworkNote || "", reworkAttachments: reworkAttachments || [], reworkAttachmentIds: reworkAttachmentIds || [], reworkPriority: reworkPriority ?? null });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 17. CEO REVIEW ────────────────────────────────────────────────────────────
router.post("/task/:taskId/ceo-review", verifyCoworkToken, verifyCeoToken, async (req, res) => {
  try {
    const { approved, rejectionReason, reworkRequirements, reworkNote, reworkAttachments, reworkAttachmentIds } = req.body;
    if (typeof approved !== "boolean") return res.status(400).json({ error: "approved (boolean) required" });
    const result = await svc.ceoReviewCompletion({ taskId: req.params.taskId, reviewerId: req.coworkUser.employeeId, reviewerName: req.coworkUser.name, approved, rejectionReason: rejectionReason || "", reworkRequirements: reworkRequirements || [], reworkNote: reworkNote || "", reworkAttachments: reworkAttachments || [], reworkAttachmentIds: reworkAttachmentIds || [] });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 18. UPDATE PARENT PROGRESS ────────────────────────────────────────────────
router.patch("/task/:taskId/parent-progress", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    await svc.updateParentTaskProgress({ parentTaskId: req.params.taskId, updatedBy: req.coworkUser.employeeId, updatedByName: req.coworkUser.name, note: req.body.note || "" });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Backward compat aliases
router.post("/task/:taskId/thread-message", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: "message required" });
    const msg = await svc.sendTaskChat({ taskId: req.params.taskId, senderId: req.coworkUser.employeeId, senderName: req.coworkUser.name, text: message.trim(), messageType: "text" });
    res.status(201).json({ success: true, message: msg });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get("/task/:taskId/full", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const task = await svc.getTaskWithDetails(req.params.taskId);
    if (!task) return res.status(404).json({ error: "Task not found" });
    res.json({ task });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PROPOSE DEADLINE (employee sets deadline before confirming) ───────────────
function _addWorkingSecsIST(startMs, windowSecs, schedule, breaks) {
  if (!schedule || windowSecs <= 0) {
    console.error("[officeDueDate] RAW FALLBACK — schedule missing or bad window", { hasSchedule: !!schedule, windowSecs });
    return new Date(startMs + windowSecs * 1000 + 6 * 3600000).toISOString(); // BRANDED PROBE: +6h marks this exact fallback
  }
  const DAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const IST = 5.5 * 3600000;
  const dateStrOf = ms => new Date(ms + IST).toISOString().slice(0, 10);
  const dowOf = ms => new Date(Date.parse(dateStrOf(ms) + "T00:00:00Z")).getUTCDay();
  let remaining = windowSecs, cur = startMs, guard = 0;
  while (remaining > 0 && guard++ < 3660) {
    const ds = dateStrOf(cur);
    const day = schedule[DAY_KEYS[dowOf(cur)]];
    const nextMidnight = Date.parse(ds + "T00:00:00+05:30") + 86400000;
    if (!day || day.isOff) { cur = nextMidnight; continue; }
    const dayStart = Date.parse(`${ds}T${day.inTime}:00+05:30`);
    const dayEnd = Date.parse(`${ds}T${day.outTime}:00+05:30`);
    if (cur < dayStart) cur = dayStart;
    if (cur >= dayEnd) { cur = nextMidnight; continue; }
    const todaysBreaks = (breaks || [])
      .map(b => ({ s: Date.parse(`${ds}T${b.start}:00+05:30`), e: Date.parse(`${ds}T${b.end}:00+05:30`) }))
      .filter(b => b.e > b.s).sort((a, b) => a.s - b.s);
    const inBrk = todaysBreaks.find(b => cur >= b.s && cur < b.e);
    if (inBrk) { cur = inBrk.e; continue; }
    const nextBrkStart = (todaysBreaks.find(b => b.s > cur) || {}).s;
    const segEnd = Math.min(dayEnd, nextBrkStart == null ? Infinity : nextBrkStart);
    const segSecs = Math.floor((segEnd - cur) / 1000);
    if (segSecs >= remaining) return new Date(cur + remaining * 1000).toISOString();
    remaining -= segSecs; cur = segEnd;
  }
  return new Date(cur).toISOString();
}

router.post("/task/:taskId/propose-deadline", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { proposedDate, workedSecs, windowSecs, extensionSecs } = req.body;
    if (!proposedDate) return res.status(400).json({ error: "proposedDate required" });
    const result = await svc.proposeDeadline({
      taskId: req.params.taskId,
      employeeId: req.coworkUser.employeeId,
      employeeName: req.coworkUser.name,
      proposedDate,
      workedSecs: Number(workedSecs) || 0,
      windowSecs: Number(windowSecs) || Number(extensionSecs) || 0,
    });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── APPROVE SENDER'S PRESET TIMER (employee accepts without proposing their own) ──
// Called when CEO/TL set a timer duration at creation and employee directly approves it.
// Mirrors the fixed-deadline approve flow: sets deadlineWindowSecs = senderTimerWindowSecs
// and moves task to deadline_approved so employee can Confirm & Start.
router.post("/task/:taskId/approve-sender-timer", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { db, admin } = require("../../config/firebaseAdmin");
    const { sendPushToEmployees } = require("../../services/fcmPush.service");
    const { taskId } = req.params;
    const { employeeId, name: employeeName } = req.coworkUser;

    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Task not found" });
    const task = snap.data();

    if (!task.assigneeIds?.includes(employeeId))
      return res.status(403).json({ error: "Only assigned employees can approve" });
    if (task.status !== "open")
      return res.status(400).json({ error: "Task is not in open state" });
    const approvedSecs = Number(task.senderTimerWindowSecs) || 0;
    if (approvedSecs <= 0)
      return res.status(400).json({ error: "No sender-set timer to approve" });

    // Office-hours-aware dueDate — consumes only WORKING time (skips off
    // days and breaks) instead of raw wall-clock addition, so a 4h task
    // approved at 5:15pm doesn't land due 9:15pm the same night.
    //
    // Anchored by the owner's rule, not at the press: the clock starts when
    // the assignee first came online at/after the task was given (cross-dept:
    // when the hours were granted). Same resolver as the budget-negotiation
    // accept, so both accept surfaces produce one deadline for one task.
    const { resolveAcceptanceAnchor } = require("../../services/officeDeadline.service");
    const anchor = await resolveAcceptanceAnchor(task, Date.now(), taskId);
    let dueDate;
    try {
      const officeSnap = await db.collection("cowork_settings").doc("office").get();
      const _sched = officeSnap.exists ? officeSnap.data().schedule : null;
      const _brks = officeSnap.exists ? (officeSnap.data().breaks || []) : [];
      console.log("[approve-sender-timer] office doc exists:", officeSnap.exists, "| schedule days:", _sched ? Object.keys(_sched).length : 0);
      dueDate = _addWorkingSecsIST(anchor.anchorMs, approvedSecs, _sched, _brks);
    } catch (e) {
      console.error("[approve-sender-timer OFFICE CALC FAILED]", e.message);
      dueDate = new Date(anchor.anchorMs + approvedSecs * 1000 + 6 * 3600000).toISOString(); // BRANDED PROBE: +6h marks this exact fallback
    }

    await taskRef.update({
      status: "deadline_approved",
      deadlineWindowSecs: approvedSecs,
      originalWindowSecs: approvedSecs,
      dueDate,
      clockStartsAtMs: anchor.anchorMs,
      clockStartsAtSource: anchor.source,
      /* Which task it is queued behind, where the priority rule moved the
         start — see resolveAcceptanceAnchor. Null on the ordinary path. */
      queuedAfterTaskId: anchor.queuedAfterTaskId ?? null,
      queuedAfterTitle: anchor.queuedAfterTitle ?? null,
      senderTimerApprovedBy: employeeId,
      senderTimerApprovedByName: employeeName,
      senderTimerApprovedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Post system message to draft chat
    const _fmtSecs = (s) => {
      s = Math.max(0, Math.round(Number(s) || 0));
      if (s < 60) return `${s}s`;
      if (s < 3600) return `${Math.round(s / 60)}m`;
      if (s < 86400) { const h = Math.floor(s / 3600); const m = Math.round((s % 3600) / 60); return m > 0 ? `${h}h ${m}m` : `${h}h`; }
      return `${Math.round(s / 86400)}d`;
    };
    try {
      const msgRef = db.collection("cowork_tasks").doc(taskId).collection("draft_chat");
      const msgId = `sys-${Date.now()}`;
      await msgRef.doc(msgId).set({
        messageId: msgId, taskId,
        senderId: employeeId, senderName: employeeName,
        text: `✅ ${employeeName} approved the time: ${_fmtSecs(approvedSecs)}. You can now Confirm & Start.`,
        messageType: "system",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await taskRef.update({ lastChatAt: admin.firestore.FieldValue.serverTimestamp(), lastChatPreview: `${employeeName} approved the timer` });
    } catch (chatErr) {
      console.warn("[approve-sender-timer] chat post failed:", chatErr.message);
    }

    // ── Notify task creator ──────────────────────────────────────────────────
    // This was `sendPushToEmployees` alone: a phone push and NO durable record,
    // so the answer to "did they accept my estimate?" reached a locked screen
    // and then existed nowhere. Anybody with push off, or reading on a desktop,
    // was never told at all. `_notify` writes the Firestore row the bell reads,
    // emits the socket event, AND sends the same push — so this keeps what it
    // had and gains the record it did not.
    await _notify({
      recipientIds: [task.assignedBy].filter(Boolean),
      type: "sender_timer_approved",
      title: "⏱ Timer approved",
      body: `${employeeName} approved the ${_fmtSecs(approvedSecs)} you set for "${task.title}". It is ready to start.`,
      data: { taskId, approvedSecs },
      senderId: employeeId,
      senderName: employeeName,
    });

    res.json({ success: true, deadlineWindowSecs: approvedSecs });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── REJECT SENDER'S PRESET TIMER — receiver finds the time insufficient ────────
// Employee rejects the sender-set time. Task stays "open" so employee can then
// propose their own duration (which goes through the normal pending_deadline_approval flow).
router.post("/task/:taskId/reject-sender-timer", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { db, admin } = require("../../config/firebaseAdmin");
    const { taskId } = req.params;
    const { reason } = req.body;
    const { employeeId, name: employeeName } = req.coworkUser;

    if (!reason?.trim()) return res.status(400).json({ error: "Rejection reason is required" });

    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Task not found" });
    const task = snap.data();

    if (!task.assigneeIds?.includes(employeeId))
      return res.status(403).json({ error: "Only assigned employees can reject" });
    if (task.status !== "open")
      return res.status(400).json({ error: "Task is not in open state" });
    if (!Number(task.senderTimerWindowSecs))
      return res.status(400).json({ error: "No sender-set timer to reject" });

    const _fmtSecs = (s) => {
      s = Math.max(0, Math.round(Number(s) || 0));
      if (s < 60) return `${s}s`;
      if (s < 3600) return `${Math.round(s / 60)}m`;
      if (s < 86400) { const h = Math.floor(s / 3600); const m = Math.round((s % 3600) / 60); return m > 0 ? `${h}h ${m}m` : `${h}h`; }
      return `${Math.round(s / 86400)}d`;
    };

    await taskRef.update({
      senderTimerRejected: true,
      senderTimerRejectionReason: reason.trim(),
      senderTimerRejectedBy: employeeId,
      senderTimerRejectedByName: employeeName,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Post system message to draft chat
    try {
      const msgRef = db.collection("cowork_tasks").doc(taskId).collection("draft_chat");
      const msgId = `sys-reject-timer-${Date.now()}`;
      await msgRef.doc(msgId).set({
        messageId: msgId, taskId,
        senderId: employeeId, senderName: employeeName,
        text: `❌ ${employeeName} rejected the allocated time (${_fmtSecs(task.senderTimerWindowSecs)}). Reason: ${reason.trim()}`,
        messageType: "system",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await taskRef.update({ lastChatAt: admin.firestore.FieldValue.serverTimestamp() });
    } catch (_) { }

    // Notify task creator (sender). Push-only before — see the note on
    // approve-sender-timer above; a rejection with a REASON is the worst of the
    // two to lose, because the reason is the whole message and a push
    // notification is not somewhere you can go back and re-read it.
    await _notify({
      recipientIds: [task.assignedBy].filter(Boolean),
      type: "sender_timer_rejected",
      title: "⏱ Timer rejected",
      body: `${employeeName} rejected the ${_fmtSecs(task.senderTimerWindowSecs)} you set for "${task.title}". Reason: ${reason.trim()}`,
      data: { taskId, rejectedSecs: Number(task.senderTimerWindowSecs) || 0, reason: reason.trim() },
      senderId: employeeId,
      senderName: employeeName,
    });

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── APPROVE / REJECT DEADLINE (task creator only) ─────────────────────────────
router.post("/task/:taskId/approve-deadline", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { approved, rejectionReason, explicitDueDate, reworkRequirements, reworkNote, reworkAttachments, reworkAttachmentIds } = req.body;
    if (typeof approved !== "boolean") return res.status(400).json({ error: "approved (boolean) required" });
    // On the record-based flow the assignee's PRIMARY MANAGER owns the date (a
    // cross-department extension is decided inside the assignee's management
    // chain, not by the assignor). Resolve them so the service can allow it.
    let assigneeManagerId = null;
    if (explicitDueDate) {
      try {
        const tSnap = await db.collection("cowork_tasks").doc(req.params.taskId).get();
        const t = tSnap.exists ? tSnap.data() : null;
        const assigneeId = t?.pendingAssigneeId || (Array.isArray(t?.assigneeIds) ? t.assigneeIds[0] : null);
        if (assigneeId) {
          const mgr = await _getPrimaryManagerApprover(assigneeId);
          assigneeManagerId = mgr?.approverId ?? null;
        }
      } catch (e) { console.warn("[approve-deadline manager resolve]", e.message); }
    }
    const result = await svc.approveDeadline({
      taskId: req.params.taskId,
      approverId: req.coworkUser.employeeId,
      approverName: req.coworkUser.name,
      approved,
      rejectionReason: rejectionReason || "",
      // Set by the record-based deadline-extension flow, which applies the agreed
      // date directly rather than through the on-task pending_deadline_approval state.
      explicitDueDate: explicitDueDate || null,
      // The assignee's manager (Option A: they own the date, not the assignor).
      assigneeManagerId,
    });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── TL/CEO COUNTER-PROPOSE DEADLINE ───────────────────────────────────────────
router.post("/task/:taskId/tl-counter-deadline", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { counterDate, counterWindowSecs, message } = req.body;
    if (!counterDate) return res.status(400).json({ error: "counterDate required" });
    const result = await svc.tlCounterProposeDeadline({
      taskId: req.params.taskId,
      proposerId: req.coworkUser.employeeId,
      proposerName: req.coworkUser.name,
      counterDate,
      counterWindowSecs,  // typed duration in seconds (for extension-aware accounting)
      message: message || "",
    });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});





// ── EMPLOYEE RESPOND TO TL COUNTER-PROPOSAL ────────────────────────────────────
router.post("/task/:taskId/respond-tl-counter", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { accepted, rejectMessage } = req.body;
    if (typeof accepted !== "boolean") return res.status(400).json({ error: "accepted (boolean) required" });
    const result = await svc.employeeRespondToTlCounter({
      taskId: req.params.taskId,
      employeeId: req.coworkUser.employeeId,
      employeeName: req.coworkUser.name,
      accepted,
      rejectMessage: rejectMessage || "",
    });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});



// ── DEADLINE EXTENSION REQUEST — Third-Party / Goal / Repeat tasks ────────────
router.post("/task/:taskId/request-deadline-extension", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { proposedDate, reason } = req.body;
    if (!proposedDate) return res.status(400).json({ error: "proposedDate required" });

    // ── How much time is being ASKED FOR, in seconds ──────────────────────────
    // The record used to carry only a date. That is enough to move a deadline
    // and useless for answering "how much longer did they ask for?" — the
    // amount can only be recovered by differencing against the window in force,
    // and approving the request overwrites exactly that. So the history read
    // back as 0 + 0 = 0 for every extension ever granted.
    //
    // Stored at REQUEST time and never recomputed: previous + added = total,
    // all three, so a granted extension still says what it added years later.
    // Optional, so an older client that sends only a date still works.
    const _num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };
    const previousWindowSecs = _num(req.body.previousWindowSecs);
    const addedSecs = _num(req.body.addedSecs);
    const proposedWindowSecs = _num(req.body.proposedWindowSecs) || (previousWindowSecs + addedSecs);

    const { db, admin } = require("../../config/firebaseAdmin");
    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Task not found" });
    const task = snap.data();

    // Allow all task types with fixedDeadline OR any standard task to request extension

    if (!task.assigneeIds?.includes(req.coworkUser.employeeId))
      return res.status(403).json({ error: "Only assigned employees can request an extension" });

    // ── Due-date elapsed % — determines penalty zone. Anchored to
    // task.dueDate/fixedDeadline directly, not etcHours or deadlineWindowSecs —
    // either of those could hit 70%+ purely from calendar time passing, even
    // before any work had started. ──
    const extensionFiledAt = new Date().toISOString();
    let elapsedPercent = 0;
    let isPenaltyWaived = true; // default: no penalty

    const _dueMs = task.dueDate ? new Date(task.dueDate).getTime() : (task.fixedDeadline ? new Date(task.fixedDeadline).getTime() : null);
    if (_dueMs && task.createdAtISO) {
      const _createdMs = new Date(task.createdAtISO).getTime();
      // Office-hours-aware: count only WORKING seconds on both sides, so
      // nights / breaks / off days move the % on neither numerator nor
      // denominator. A 3h task created Sunday night is 0% until Monday
      // office open. Wall-clock fallback if the schedule is unreadable.
      let _officeDone = false;
      try {
        const _offSnap = await db.collection("cowork_settings").doc("office").get();
        if (_offSnap.exists && _offSnap.data().schedule) {
          const _sch = _offSnap.data().schedule;
          const _brk = _offSnap.data().breaks || [];
          const _tot = _workingSecsBetweenIST(_createdMs, _dueMs, _sch, _brk);
          const _don = _workingSecsBetweenIST(_createdMs, Date.now(), _sch, _brk);
          if (_tot > 0) { elapsedPercent = Math.min(100, +(((_don / _tot) * 100).toFixed(1))); _officeDone = true; }
        }
      } catch (e) { console.error("[ext elapsed office calc]", e.message); }
      if (!_officeDone) {
        const _totalWindowMs = _dueMs - _createdMs;
        if (_totalWindowMs > 0) {
          elapsedPercent = Math.min(100, +(((Date.now() - _createdMs) / _totalWindowMs) * 100).toFixed(1));
        }
      }
    }
    if (isNaN(elapsedPercent)) elapsedPercent = 0;

    // Zone 1 (0–50%)  : button disabled on frontend — if somehow submitted, no penalty
    // Zone 2 (50–70%) : no penalty
    // Zone 3 (70%+)   : penalty applies (−0.2 C1 deduction)
    isPenaltyWaived = elapsedPercent < 70;
    // ─────────────────────────────────────────────────────────────────────

    await taskRef.update({
      deadlineExtRequest: {
        proposedDate,
        // The three figures, so the amount survives approval overwriting the
        // window it was measured against.
        previousWindowSecs,
        addedSecs,
        proposedWindowSecs,
        reason: reason || "",
        requestedBy: req.coworkUser.employeeId,
        requestedByName: req.coworkUser.name,
        requestedAt: admin.firestore.FieldValue.serverTimestamp(),
        extensionFiledAt,
        elapsedPercent,
        status: "pending",
        isPenaltyWaived,
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Notify CEO/TL who assigned the task
    try {
      const notifyIds = [task.assignedBy].filter(Boolean);
      await _notify({
        recipientIds: notifyIds,
        type: "deadline_extension_requested",
        title: `⏰ Extension Requested · ${task.title}`,
        body: `${req.coworkUser.name} requested a deadline extension.`,
        data: { taskId, taskTitle: task.title },
        senderId: req.coworkUser.employeeId, senderName: req.coworkUser.name,
      });
    } catch (e) { console.error("ext req notif:", e.message); }

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DEADLINE EXTENSION REVIEW — CEO/TL approves/rejects/sets new date ─────────
router.post("/task/:taskId/review-deadline-extension", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { action, newDate } = req.body; // action: "approve" | "reject" | "counter"
    if (!["approve", "reject", "counter"].includes(action))
      return res.status(400).json({ error: "action must be approve, reject, or counter" });
    if (action !== "reject" && !newDate)
      return res.status(400).json({ error: "newDate required for approve/counter" });

    const { db, admin } = require("../../config/firebaseAdmin");
    const { role, employeeId } = req.coworkUser;
    // An extension moves a date the ASSIGNER committed to, so the assigner is
    // exactly who should decide it — not whoever happens to hold a "tl" role
    // string. Same rule as rework and deduction.
    if (!(await isTaskHead(taskId, employeeId, role))) {
      return res.status(403).json({ error: "Only this task's assigner, or a TL/CEO, can review extensions" });
    }

    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Task not found" });
    const task = snap.data();
    if (!task.deadlineExtRequest || task.deadlineExtRequest.status !== "pending")
      return res.status(400).json({ error: "No pending extension request" });

    const update = {
      "deadlineExtRequest.status": action === "approve" ? "approved" : action === "counter" ? "countered" : "rejected",
      "deadlineExtRequest.reviewedBy": req.coworkUser.employeeId,
      "deadlineExtRequest.reviewedByName": req.coworkUser.name,
      "deadlineExtRequest.reviewedAt": admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (action === "approve") {
      update.fixedDeadline = task.deadlineExtRequest.proposedDate;
      update["deadlineExtRequest.approvedDate"] = task.deadlineExtRequest.proposedDate;
    } else if (action === "counter") {
      update.fixedDeadline = newDate;
      update["deadlineExtRequest.counterDate"] = newDate;
    }

    /**
     * **A subtask may not be extended past the project it belongs to.**
     * OWNER DECISION, 16 Aug 2026: refused, UNLESS the project moves too.
     *
     * A flat refusal would be a dead end — the approver believes the time is
     * warranted, and the only remedy would be a second action on a different
     * task they may not think to take. So the refusal carries the remedy, and
     * `raiseParent` takes it in the same press.
     *
     * Both writes go in ONE batch. Moving the child first and failing on the
     * parent would leave exactly the state this rule exists to forbid, with
     * nothing on screen to say it had happened.
     *
     * Rejections skip all of this: refusing an extension cannot breach a cap.
     */
    const granted = action === "approve" || action === "counter";
    const grantedMs = granted ? readInstantMs(update.fixedDeadline) : null;
    const parentInfo = granted ? await readParentDeadline(task) : null;

    const breach = parentInfo
      ? capBreach({ grantedMs, parentDueAtMs: parentInfo.dueAtMs })
      : { breached: false, overshootSecs: 0 };

    if (breach.breached) {
      const { overshootSecs } = breach;
      if (!req.body.raiseParent) {
        return res
          .status(409)
          .json(capRefusalBody({ parent: parentInfo, overshootSecs }));
      }
      /* Granted WITH the project moved by the same amount, so the two still
         agree — the approver was told that is what they were doing. */
      const batch = db.batch();
      batch.update(taskRef, update);
      batch.update(db.collection("cowork_tasks").doc(parentInfo.taskId), {
        [parentInfo.field]: raisedParentDueAt({ parent: parentInfo, overshootSecs }),
        parentDeadlineRaisedBy: overshootSecs,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await batch.commit();
    } else {
      await taskRef.update(update);
    }

    // Notify assignees about extension review result
    try {
      const assigneeIds = task.assigneeIds || [];
      const actionLabel = action === "approve" ? "✅ Approved" : action === "counter" ? "📅 Counter-proposed" : "❌ Rejected";
      await _notify({
        recipientIds: assigneeIds,
        type: "deadline_extension_reviewed",
        title: `${actionLabel} · ${task.title}`,
        body: action === "approve" ? `Your deadline extension was approved by ${req.coworkUser.name}.` : action === "counter" ? `${req.coworkUser.name} suggested a new deadline.` : `Your deadline extension was rejected by ${req.coworkUser.name}.`,
        data: { taskId, taskTitle: task.title, action },
        senderId: req.coworkUser.employeeId, senderName: req.coworkUser.name,
      });
    } catch (e) { console.error("ext review notif:", e.message); }

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DRAFT CHAT (GET) ──────────────────────────────────────────────────────────
router.get("/task/:taskId/draft-chat", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const messages = await svc.getDraftChat(req.params.taskId, req.query.limit || 100);
    res.json({ messages });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DRAFT CHAT (POST) ─────────────────────────────────────────────────────────
router.post("/task/:taskId/draft-chat", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { text, attachments, messageType } = req.body;
    if (!text?.trim() && !attachments?.length) return res.status(400).json({ error: "text or attachments required" });
    const msg = await svc.sendDraftChat({
      taskId: req.params.taskId,
      senderId: req.coworkUser.employeeId,
      senderName: req.coworkUser.name,
      text: text || "",
      attachments: attachments || [],
      messageType: messageType || "text",
    });
    res.status(201).json({ success: true, message: msg });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── UPDATE VENDOR CONFIG — assignee or CEO/TL can edit vendor details ────────
router.patch("/task/:taskId/update-vendor-config", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { employeeId, role } = req.coworkUser;
    const { thirdPartyConfig } = req.body;
    const { db, admin } = require("../../config/firebaseAdmin");

    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Task not found" });
    const task = snap.data();
    if (!task.isThirdParty) return res.status(400).json({ error: "Not a third-party task" });

    const canEdit = ["ceo", "tl"].includes(role) || task.assigneeIds?.includes(employeeId);
    if (!canEdit) return res.status(403).json({ error: "Not allowed" });

    await taskRef.update({
      thirdPartyConfig: { ...(task.thirdPartyConfig || {}), ...thirdPartyConfig },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GOAL ACTIVITIES — save full activities array ──────────────────────────────
router.post("/task/:taskId/goal-activities", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { employeeId, role } = req.coworkUser;
    const { activities, submitted, submittedAt } = req.body;
    const { db, admin } = require("../../config/firebaseAdmin");

    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Task not found" });
    const task = snap.data();
    if (!task.isGoal) return res.status(400).json({ error: "Not a goal task" });

    // Who may save the roadmap: an assignee, the person who ASSIGNED the goal,
    // anyone who confirmed it, or a CEO/TL.
    //
    // `assignedBy` was missing and that was the bug. The roadmap is built by the
    // head of the goal — that is what both this app and the old one offer them —
    // but the only head this gate recognised was the ROLE STRING "tl"/"ceo". A
    // manager whose role is stored as "employee", which is how the reporting
    // line is actually modelled here, was refused on a goal they created and
    // assigned themselves. Widened, not replaced: every case that passed before
    // still passes.
    const canEdit =
        task.assigneeIds?.includes(employeeId) ||
        task.assignedBy === employeeId ||
        task.originalAssignedBy === employeeId ||
        ["ceo", "tl"].includes(role);
    if (!canEdit) return res.status(403).json({ error: "Not allowed" });

    if (!Array.isArray(activities)) return res.status(400).json({ error: "activities must be an array" });

    const updateData = {
      goalActivities: activities,
      goalActivitiesUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (submitted !== undefined) {
      updateData.goalActivitiesSubmitted = submitted;
      if (submitted && submittedAt) updateData.goalActivitiesSubmittedAt = submittedAt;
    }

    await taskRef.update(updateData);

    /**
     * ── Email: the roadmap has been handed over ──
     *
     * **To the ASSIGNEE — the person who now has to do the work.**
     *
     * This notified `assignedBy` and the approvers, and the comment above it
     * read "notify CEO/TL when Y does Final Submit" — written for a flow where
     * the ASSIGNEE submits. But the button has always been shown only to the
     * head (`canEdit = isHead` in the old `GoalTask.jsx`), so in practice the
     * head submitted and the head was emailed about their own action, while the
     * person who had to act on it was never told. The two halves disagreed;
     * this is the half that was wrong — owner decision.
     */
    if (submitted === true && !task.goalActivitiesSubmitted) {
      try {
        const { sendNotificationEmail } = require("../../services/emailNotifications.service");
        const { db: _db } = require("../../config/firebaseAdmin");
        /* Pending first: a goal handed over before its assignment clears is
           still handed to somebody, and `assigneeIds` is empty until then. */
        const recipientIds = [
          ...(task.assigneeIds || []),
          task.pendingAssigneeId,
        ].filter(Boolean);
        const uniqueRecipients = [...new Set(recipientIds)];
        const submitter = await _db.collection("cowork_employees").doc(employeeId).get();
        const submitterName = submitter.exists ? submitter.data().name : "Employee";
        for (const recipientId of uniqueRecipients) {
          /* Never to the person who pressed the button. A head who is also an
             assignee of their own goal does not need telling. */
          if (recipientId === employeeId) continue;
          const personDoc = await _db.collection("cowork_employees").doc(recipientId).get();
          if (!personDoc.exists || !personDoc.data().email) continue;
          const person = personDoc.data();
          await sendNotificationEmail({
            senderId: employeeId, senderName: submitterName,
            receiverId: recipientId, receiverName: person.name, receiverEmail: person.email,
            type: "goal_final_submit",
            title: `Your roadmap is ready: ${task.title}`,
            body: `${submitterName} set out the steps for "${task.title}". Each step has its own deadline, and earns its points when it is approved having been handed in on time.`,
            data: {
              taskTitle: task.title,
              taskId,
              componentCount: (activities || []).length,
              submittedAt: submittedAt || new Date().toISOString(),
            },
          });
        }
      } catch (emailErr) { console.error("[Email] goal_final_submit:", emailErr.message); }
    }

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GOAL ACTIVITIES — get current activities ──────────────────────────────────
router.get("/task/:taskId/goal-activities", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { db } = require("../../config/firebaseAdmin");

    const snap = await db.collection("cowork_tasks").doc(taskId).get();
    if (!snap.exists) return res.status(404).json({ error: "Task not found" });
    const task = snap.data();
    if (!task.isGoal) return res.status(400).json({ error: "Not a goal task" });

    res.json({
      activities: task.goalActivities || [],
      submitted: task.goalActivitiesSubmitted || false,
      submittedAt: task.goalActivitiesSubmittedAt || null,
      updatedAt: task.goalActivitiesUpdatedAt || null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

// ── GOAL ACTIVITY: REQUEST REPORT on a specific component ────────────────────
// X (CEO/TL) calls this to flag a component as needing a report from Y
router.post("/task/:taskId/goal-activity/:activityId/request-report", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { taskId, activityId } = req.params;
    const { role, name: requesterName, employeeId } = req.coworkUser;

    const { db, admin } = require("../../config/firebaseAdmin");
    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Task not found" });
    const task = snap.data();
    if (!task.isGoal) return res.status(400).json({ error: "Not a goal task" });

    // The goal's own head, or a CEO/TL. Moved BELOW the task read on purpose:
    // the role string alone cannot answer "are you this goal's head", and a
    // manager here carries `role: "employee"` — see the same fix on
    // /goal-activities and /sop/goal-credit.
    const canRequest =
      ["ceo", "tl"].includes(role) ||
      task.assignedBy === employeeId ||
      task.originalAssignedBy === employeeId;
    if (!canRequest) return res.status(403).json({ error: "Only this goal's head can request a report" });

    const activities = task.goalActivities || [];
    const idx = activities.findIndex(a => a.id === activityId);
    if (idx === -1) return res.status(404).json({ error: "Component not found" });

    const now = new Date().toISOString();
    activities[idx] = {
      ...activities[idx],
      reportRequested: true,
      reportRequestedAt: now,
      reportRequestedBy: requesterName,
      reportRequestedById: employeeId,
    };

    await taskRef.update({
      goalActivities: activities,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // ── Email: notify CEO/TL when Y submits report + marks done ──
    try {
      const { sendNotificationEmail } = require("../../services/emailNotifications.service");
      const { db: _db } = require("../../config/firebaseAdmin");
      const activity = activities[idx];
      const headIds = [task.assignedBy, ...(task.confirmedBy || [])].filter(Boolean);
      const uniqueHeads = [...new Set(headIds)];
      const doneCount = activities.filter(a => a.status === "done").length;
      for (const headId of uniqueHeads) {
        const headDoc = await _db.collection("cowork_employees").doc(headId).get();
        if (!headDoc.exists || !headDoc.data().email) continue;
        const head = headDoc.data();
        // Email 1: Component done
        await sendNotificationEmail({
          senderId: employeeId, senderName: submitterName,
          receiverId: headId, receiverName: head.name, receiverEmail: head.email,
          type: "goal_component_done",
          title: `Component completed: ${activity.heading} — ${task.title}`,
          body: `${submitterName} completed "${activity.heading}" in "${task.title}"`,
          data: {
            taskTitle: task.title, taskId,
            componentTitle: activity.heading,
            doneAt: now,
            progress: `${doneCount}/${activities.length} components done`,
            reportText: (text || "").slice(0, 200),
          },
        });
        // Email 2: Report submitted
        await sendNotificationEmail({
          senderId: employeeId, senderName: submitterName,
          receiverId: headId, receiverName: head.name, receiverEmail: head.email,
          type: "goal_report_submitted",
          title: `Report submitted: ${activity.heading} — ${task.title}`,
          body: `${submitterName} submitted a completion report for "${activity.heading}"`,
          data: {
            taskTitle: task.title, taskId,
            componentTitle: activity.heading,
            submittedAt: now,
            fileCount: (files || []).length,
            reportText: (text || "").slice(0, 200),
          },
        });
      }
    } catch (emailErr) { console.error("[Email] goal_component_done/report:", emailErr.message); }

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── P1 CONFLICT CHECK — called from frontend when employee starts a P1 task ──
router.post("/task/p1-conflict-check", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { newP1TaskId, employeeId } = req.body;
    if (!newP1TaskId || !employeeId) return res.status(400).json({ error: "Missing newP1TaskId or employeeId" });

    console.log("[P1-ROUTE] received:", { newP1TaskId, employeeId, conflictTaskId: req.body.conflictTaskId });
    const result = await svc.checkAndExtendForP1({
      newP1TaskId,
      employeeId,
      assignedBy: req.body.assignedBy || req.coworkUser?.employeeId,
      newP1Priority: req.body.newP1Priority != null ? Number(req.body.newP1Priority) : null,
      assignedByName: req.body.assignedByName || null,
      reason: req.body.reason || null,
      oldPriorities: req.body.oldPriorities || null,
      newPriorities: req.body.newPriorities || null,
    });
    console.log("[P1-ROUTE] result:", result);
    res.json({ ok: true, extended: result || null });
  } catch (e) {
    console.error("[p1-conflict-check route]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GOAL ACTIVITY: SUBMIT REPORT for a specific component ────────────────────
// Y (assignee) submits text + file references after uploading files to Drive
router.post("/task/:taskId/goal-activity/:activityId/submit-report", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { taskId, activityId } = req.params;
    const { employeeId, name: submitterName } = req.coworkUser;
    const { text, files } = req.body; // files: [{name, driveUrl, mimeType}]

    const { db, admin } = require("../../config/firebaseAdmin");
    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Task not found" });
    const task = snap.data();
    if (!task.isGoal) return res.status(400).json({ error: "Not a goal task" });
    if (!task.assigneeIds?.includes(employeeId)) return res.status(403).json({ error: "Not assigned" });

    const activities = task.goalActivities || [];
    const idx = activities.findIndex(a => a.id === activityId);
    if (idx === -1) return res.status(404).json({ error: "Component not found" });

    const now = new Date().toISOString();
    activities[idx] = {
      ...activities[idx],
      status: "pending_approval",
      report: {
        text: text || "",
        files: files || [],
        submittedAt: now,
        submittedBy: submitterName,
        submittedById: employeeId,
      },
      reportSubmitted: true,
    };

    await taskRef.update({
      goalActivities: activities,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // ── Email: notify CEO/TL when Y submits report + marks done ──
    try {
      const { sendNotificationEmail } = require("../../services/emailNotifications.service");
      const { db: _db } = require("../../config/firebaseAdmin");
      const activity = activities[idx];
      const headIds = [task.assignedBy, ...(task.confirmedBy || [])].filter(Boolean);
      const uniqueHeads = [...new Set(headIds)];
      const doneCount = activities.filter(a => a.status === "done").length;
      for (const headId of uniqueHeads) {
        const headDoc = await _db.collection("cowork_employees").doc(headId).get();
        if (!headDoc.exists || !headDoc.data().email) continue;
        const head = headDoc.data();
        // Email 1: Component done
        await sendNotificationEmail({
          senderId: employeeId, senderName: submitterName,
          receiverId: headId, receiverName: head.name, receiverEmail: head.email,
          type: "goal_component_done",
          title: `Component completed: ${activity.heading} — ${task.title}`,
          body: `${submitterName} completed "${activity.heading}" in "${task.title}"`,
          data: {
            taskTitle: task.title, taskId,
            componentTitle: activity.heading,
            doneAt: now,
            progress: `${doneCount}/${activities.length} components done`,
            reportText: (text || "").slice(0, 200),
          },
        });
        // Email 2: Report submitted
        await sendNotificationEmail({
          senderId: employeeId, senderName: submitterName,
          receiverId: headId, receiverName: head.name, receiverEmail: head.email,
          type: "goal_report_submitted",
          title: `Report submitted: ${activity.heading} — ${task.title}`,
          body: `${submitterName} submitted a completion report for "${activity.heading}"`,
          data: {
            taskTitle: task.title, taskId,
            componentTitle: activity.heading,
            submittedAt: now,
            fileCount: (files || []).length,
            reportText: (text || "").slice(0, 200),
          },
        });
      }
    } catch (emailErr) { console.error("[Email] goal_component_done/report:", emailErr.message); }

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
