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
const router = express.Router();
const { verifyCoworkToken, verifyCeoToken, verifyEmployeeToken } = require("../../Middlewear/coworkAuth");
const svc = require("../../services/taskForward.service");
const { db, admin } = require("../../config/firebaseAdmin");

// ── Helper: get employee role/dept from Firestore ─────────────────────────────
async function getEmployeeInfo(employeeId) {
  const snap = await db.collection("cowork_employees").doc(employeeId).get();
  if (!snap.exists) return null;
  return snap.data();
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
    const { title, description, notes, assigneeIds, dueDate, priority, parentTaskId } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: "title required" });
    if (!assigneeIds?.length) return res.status(400).json({ error: "assigneeIds required" });

    const requesterRole = req.coworkUser.role;
    if (!["ceo", "tl", "employee"].includes(requesterRole)) {
      return res.status(403).json({ error: "Not authorized to create tasks." });
    }

    // Check if any assignee is a TL → needs TL approval (only when employee creates)
    let initialStatus = "open";
    if (requesterRole === "employee") {
      for (const aid of assigneeIds) {
        const emp = await getEmployeeInfo(aid);
        if (emp?.role === "tl") { initialStatus = "pending_tl_approval"; break; }
      }
    }

    const task = await svc.createTask({
      title: title.trim(), description, notes,
      assignedBy: req.coworkUser.employeeId,
      assignedByName: req.coworkUser.name,
      assignedByRole: requesterRole,
      assigneeIds,
      dueDate: dueDate || null,
      priority: priority || "medium",
      parentTaskId: parentTaskId || null,
      status: initialStatus,
      // Mark whether this is a CEO-created root task (for visibility filtering)
      createdByCeo: requesterRole === "ceo" && !parentTaskId,
      createdByTl: requesterRole === "tl",
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

    res.status(201).json({ success: true, task });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Backward compat alias
router.post("/task/create-parent", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { title, description, notes, assigneeIds, dueDate, priority } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: "title required" });
    if (!assigneeIds?.length) return res.status(400).json({ error: "assigneeIds required" });
    if (!["ceo", "tl"].includes(req.coworkUser.role)) return res.status(403).json({ error: "Only CEO or TL can create parent tasks." });
    const task = await svc.createTask({
      title: title.trim(), description, notes,
      assignedBy: req.coworkUser.employeeId,
      assignedByName: req.coworkUser.name,
      assignedByRole: req.coworkUser.role,
      assigneeIds, dueDate: dueDate || null,
      priority: priority || "medium",
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
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 6. CREATE SUBTASK ─────────────────────────────────────────────────────────
router.post("/task/:taskId/subtask", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { title, description, notes, assigneeIds, dueDate, priority } = req.body;
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

    const subtask = await svc.createTask({
      title: title.trim(), description, notes,
      assignedBy: employeeId,
      assignedByName: name,
      assignedByRole: requesterRole,
      assigneeIds,
      dueDate: dueDate || null,
      priority: priority || "medium",
      parentTaskId: req.params.taskId,
      // TL subtasks should NOT show in CEO tree
      createdByTl: requesterRole === "tl",
      createdByCeo: requesterRole === "ceo",
    });

    // Post chat notification in parent task (visible to CEO + TL)
    await postSystemChatMessage(
      req.params.taskId,
      `📋 Subtask "${title.trim()}" has been created by ${name}`,
      employeeId,
      name
    );

    res.status(201).json({ success: true, subtask });
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
    const allTasks = await svc.listTasksWithHierarchy(employeeId, role);

    let filtered = allTasks;

    if (role === "ceo") {
      // CEO sees ONLY root tasks created by CEO.
      // Subtasks created by TL are hidden from CEO's tree.
      // But CEO still sees subtasks they personally created.
      filtered = allTasks.filter(t => {
        if (!t.parentTaskId) {
          // Root task: show only if created by CEO
          return t.assignedBy === employeeId || t.createdByCeo === true;
        }
        // Subtask: show only if created by CEO (not by TL)
        return t.createdByCeo === true || (t.assignedBy === employeeId && !t.createdByTl);
      });
    }
    // TL: sees everything (no filter)
    // Employee: sees their own assigned tasks only (handled in svc.listTasksWithHierarchy)

    res.json({ tasks: filtered });
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
router.delete("/task/:taskId", verifyCoworkToken, verifyCeoToken, async (req, res) => {
  try {
    const result = await svc.deleteTask({ taskId: req.params.taskId, deletedBy: req.coworkUser.employeeId });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 15. SUBMIT COMPLETION ─────────────────────────────────────────────────────
router.post("/task/:taskId/submit-completion", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { message, imageUrls, pdfAttachments } = req.body;
    const result = await svc.submitCompletionRequest({ taskId: req.params.taskId, employeeId: req.coworkUser.employeeId, employeeName: req.coworkUser.name, message: message || "", imageUrls: imageUrls || [], pdfAttachments: pdfAttachments || [] });
    res.status(201).json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 16. TL REVIEW ─────────────────────────────────────────────────────────────
router.post("/task/:taskId/review-completion", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { approved, rejectionReason } = req.body;
    if (typeof approved !== "boolean") return res.status(400).json({ error: "approved (boolean) required" });
    const result = await svc.reviewCompletion({ taskId: req.params.taskId, reviewerId: req.coworkUser.employeeId, reviewerName: req.coworkUser.name, approved, rejectionReason: rejectionReason || "" });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 17. CEO REVIEW ────────────────────────────────────────────────────────────
router.post("/task/:taskId/ceo-review", verifyCoworkToken, verifyCeoToken, async (req, res) => {
  try {
    const { approved, rejectionReason } = req.body;
    if (typeof approved !== "boolean") return res.status(400).json({ error: "approved (boolean) required" });
    const result = await svc.ceoReviewCompletion({ taskId: req.params.taskId, reviewerId: req.coworkUser.employeeId, reviewerName: req.coworkUser.name, approved, rejectionReason: rejectionReason || "" });
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

module.exports = router;