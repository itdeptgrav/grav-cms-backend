/**
 * GRAV-CMS-BACKEND/routes/taskForward.routes.js
 * Register in server.js: app.use("/cowork", require("./routes/taskForward.routes"));
 */

const express = require("express");
const router = express.Router();
const { verifyCoworkToken, verifyCeoToken, verifyEmployeeToken } = require("../../Middlewear/coworkAuth");
const svc = require("../../services/taskForward.service");

// ── 1. CREATE TASK (CEO or TL — not CEO-only anymore) ────
router.post("/task/create", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { title, description, notes, assigneeIds, dueDate, priority, parentTaskId } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: "title required" });
    if (!assigneeIds?.length) return res.status(400).json({ error: "assigneeIds required" });

    // Check role: CEO or TL can create tasks
    if (!["ceo", "tl"].includes(req.coworkUser.role)) {
      return res.status(403).json({ error: "Only CEO or TL can create tasks." });
    }

    const task = await svc.createTask({
      title: title.trim(), description, notes,
      assignedBy: req.coworkUser.employeeId,
      assignedByName: req.coworkUser.name,
      assigneeIds, dueDate: dueDate || null,
      priority: priority || "medium",
      parentTaskId: parentTaskId || null,
    });
    res.status(201).json({ success: true, task });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Keep backward compat — CEO route via old endpoint
router.post("/task/create-parent", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { title, description, notes, assigneeIds, dueDate, priority } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: "title required" });
    if (!assigneeIds?.length) return res.status(400).json({ error: "assigneeIds required" });
    if (!["ceo", "tl"].includes(req.coworkUser.role)) return res.status(403).json({ error: "Only CEO or TL can create tasks." });
    const task = await svc.createTask({ title: title.trim(), description, notes, assignedBy: req.coworkUser.employeeId, assignedByName: req.coworkUser.name, assigneeIds, dueDate: dueDate || null, priority: priority || "medium", parentTaskId: null });
    res.status(201).json({ success: true, task });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 2. CONFIRM ────────────────────────────────────────────
router.post("/task/:taskId/confirm", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const result = await svc.confirmTaskReceipt({ taskId: req.params.taskId, employeeId: req.coworkUser.employeeId, employeeName: req.coworkUser.name });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 3. START ──────────────────────────────────────────────
router.post("/task/:taskId/start", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const result = await svc.markTaskStarted({ taskId: req.params.taskId, employeeId: req.coworkUser.employeeId, employeeName: req.coworkUser.name });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 4. FORWARD (any assigned person, CEO, TL) ────────────
router.post("/task/:taskId/forward", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { assignments } = req.body;
    if (!assignments?.length) return res.status(400).json({ error: "assignments required" });
    const result = await svc.forwardTask({ parentTaskId: req.params.taskId, forwardedBy: req.coworkUser.employeeId, forwardedByName: req.coworkUser.name, assignments });
    res.status(201).json({ success: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 5. CREATE SUBTASK (nested — CEO or TL) ───────────────
router.post("/task/:taskId/subtask", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { title, description, notes, assigneeIds, dueDate, priority } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: "title required" });
    if (!assigneeIds?.length) return res.status(400).json({ error: "assigneeIds required" });

    // CEO, TL, or any assignee of the parent can create subtasks
    const parentDoc = await require("../../config/firebaseAdmin").db.collection("cowork_tasks").doc(req.params.taskId).get();
    if (!parentDoc.exists) return res.status(404).json({ error: "Parent task not found" });
    const parent = parentDoc.data();
    const canCreate = ["ceo", "tl"].includes(req.coworkUser.role) || parent.assigneeIds?.includes(req.coworkUser.employeeId) || parent.assignedBy === req.coworkUser.employeeId;
    if (!canCreate) return res.status(403).json({ error: "Not authorized to create subtasks here." });

    const subtask = await svc.createTask({
      title: title.trim(), description, notes,
      assignedBy: req.coworkUser.employeeId,
      assignedByName: req.coworkUser.name,
      assigneeIds, dueDate: dueDate || null,
      priority: priority || "medium",
      parentTaskId: req.params.taskId,
    });
    res.status(201).json({ success: true, subtask });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 6. DAILY REPORT ───────────────────────────────────────
router.post("/task/:taskId/daily-report", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { message, imageUrls, pdfAttachments, progressPercent, reportDate } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: "message required" });
    if (progressPercent == null) return res.status(400).json({ error: "progressPercent required" });
    const result = await svc.submitDailyReport({ taskId: req.params.taskId, employeeId: req.coworkUser.employeeId, employeeName: req.coworkUser.name, message: message.trim(), imageUrls: imageUrls || [], pdfAttachments: pdfAttachments || [], progressPercent: Number(progressPercent), reportDate });
    res.status(201).json({ success: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 7. TASK CHAT — SEND (task-specific, no overlap) ──────
router.post("/task/:taskId/chat", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { text, attachments, messageType, mention } = req.body;
    if (!text?.trim() && (!attachments || !attachments.length)) return res.status(400).json({ error: "text or attachments required" });
    const msg = await svc.sendTaskChat({ taskId: req.params.taskId, senderId: req.coworkUser.employeeId, senderName: req.coworkUser.name, text: text || "", attachments: attachments || [], messageType: messageType || "text", mention: mention || null });
    res.status(201).json({ success: true, message: msg });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 8. TASK CHAT — GET ────────────────────────────────────
router.get("/task/:taskId/chat", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const messages = await svc.getTaskChat(req.params.taskId, req.query.limit);
    res.json({ messages });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 9. TASK DETAILS (with subtasks + chat + assignees) ────
router.get("/task/:taskId/details", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const task = await svc.getTaskWithDetails(req.params.taskId);
    if (!task) return res.status(404).json({ error: "Task not found" });
    res.json({ task });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 10. DAILY REPORTS for a task ─────────────────────────
router.get("/task/:taskId/daily-reports", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const reports = await svc.getTaskDailyReports(req.params.taskId);
    res.json({ reports });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 11. LIST TASKS ────────────────────────────────────────
router.get("/task/list-hierarchy", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const tasks = await svc.listTasksWithHierarchy(req.coworkUser.employeeId, req.coworkUser.role);
    res.json({ tasks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 12. EDIT DEADLINE (CEO only) ──────────────────────────
router.patch("/task/:taskId/deadline", verifyCoworkToken, verifyCeoToken, async (req, res) => {
  try {
    const { newDueDate, reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ error: "reason required" });
    await svc.editTaskDeadline({ taskId: req.params.taskId, newDueDate: newDueDate || null, reason: reason.trim(), editedBy: req.coworkUser.employeeId, editedByName: req.coworkUser.name });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 13. DELETE TASK (CEO only) ────────────────────────────
router.delete("/task/:taskId", verifyCoworkToken, verifyCeoToken, async (req, res) => {
  try {
    const result = await svc.deleteTask({ taskId: req.params.taskId, deletedBy: req.coworkUser.employeeId });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 14. SUBMIT COMPLETION ─────────────────────────────────
router.post("/task/:taskId/submit-completion", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { message, imageUrls, pdfAttachments } = req.body;
    const result = await svc.submitCompletionRequest({ taskId: req.params.taskId, employeeId: req.coworkUser.employeeId, employeeName: req.coworkUser.name, message: message || "", imageUrls: imageUrls || [], pdfAttachments: pdfAttachments || [] });
    res.status(201).json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 15. TL REVIEW ─────────────────────────────────────────
router.post("/task/:taskId/review-completion", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { approved, rejectionReason } = req.body;
    if (typeof approved !== "boolean") return res.status(400).json({ error: "approved (boolean) required" });
    const result = await svc.reviewCompletion({ taskId: req.params.taskId, reviewerId: req.coworkUser.employeeId, reviewerName: req.coworkUser.name, approved, rejectionReason: rejectionReason || "" });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 16. CEO REVIEW ────────────────────────────────────────
router.post("/task/:taskId/ceo-review", verifyCoworkToken, verifyCeoToken, async (req, res) => {
  try {
    const { approved, rejectionReason } = req.body;
    if (typeof approved !== "boolean") return res.status(400).json({ error: "approved (boolean) required" });
    const result = await svc.ceoReviewCompletion({ taskId: req.params.taskId, reviewerId: req.coworkUser.employeeId, reviewerName: req.coworkUser.name, approved, rejectionReason: rejectionReason || "" });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 17. UPDATE PARENT PROGRESS ────────────────────────────
router.patch("/task/:taskId/parent-progress", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    await svc.updateParentTaskProgress({ parentTaskId: req.params.taskId, updatedBy: req.coworkUser.employeeId, updatedByName: req.coworkUser.name, note: req.body.note || "" });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Old thread-message endpoint (backward compat)
router.post("/task/:taskId/thread-message", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: "message required" });
    const msg = await svc.sendTaskChat({ taskId: req.params.taskId, senderId: req.coworkUser.employeeId, senderName: req.coworkUser.name, text: message.trim(), messageType: "text" });
    res.status(201).json({ success: true, message: msg });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Old /task/:id/full endpoint (backward compat)
router.get("/task/:taskId/full", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const task = await svc.getTaskWithDetails(req.params.taskId);
    if (!task) return res.status(404).json({ error: "Task not found" });
    res.json({ task });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;