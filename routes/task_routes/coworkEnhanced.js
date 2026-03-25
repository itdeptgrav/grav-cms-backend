/**
 * GRAV-CMS-BACKEND/routes/coworkEnhanced.routes.js
 * Register in server.js: app.use("/cowork", require("./routes/coworkEnhanced.routes"));
 */

const express = require("express");
const router = express.Router();
const { verifyCoworkToken, verifyCeoToken, verifyEmployeeToken } = require("../../Middlewear/coworkAuth");
const svc = require("../../services/coworkEnhanced.service");

// ── Group message with media ──────────────────────────────
router.post("/message/group-media", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const { groupId, text, attachments, messageType } = req.body;
        if (!groupId) return res.status(400).json({ error: "groupId required" });
        if (!text?.trim() && (!attachments || !attachments.length)) return res.status(400).json({ error: "text or attachments required" });
        const msg = await svc.sendGroupMessageWithMedia({
            groupId, senderId: req.coworkUser.employeeId, senderName: req.coworkUser.name,
            text: text || "", attachments: attachments || [], messageType: messageType || "text",
        });
        res.status(201).json({ success: true, message: msg });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Direct message with media (all employees) ─────────────
router.post("/message/direct-media", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const { toEmployeeId, text, attachments, messageType } = req.body;
        if (!toEmployeeId) return res.status(400).json({ error: "toEmployeeId required" });
        if (!text?.trim() && (!attachments || !attachments.length)) return res.status(400).json({ error: "text or attachments required" });
        const result = await svc.sendDirectMessageWithMedia({
            fromEmployeeId: req.coworkUser.employeeId, toEmployeeId,
            senderName: req.coworkUser.name, text: text || "",
            attachments: attachments || [], messageType: messageType || "text",
        });
        res.status(201).json({ success: true, ...result });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Create subtask (CEO + TL — uses verifyEmployeeToken, role check inside service) ──
router.post("/task/:taskId/subtask", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const { title, description, notes, assigneeIds, dueDate, priority } = req.body;
        if (!title?.trim()) return res.status(400).json({ error: "title required" });
        if (!assigneeIds?.length) return res.status(400).json({ error: "assigneeIds required" });
        const subtask = await svc.createSubtask({
            parentTaskId: req.params.taskId,
            title: title.trim(), description, notes,
            assigneeIds, dueDate: dueDate || null,
            priority: priority || "medium",
            createdBy: req.coworkUser.employeeId,
            createdByName: req.coworkUser.name,
        });
        res.status(201).json({ success: true, subtask });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Task chat message ─────────────────────────────────────
router.post("/task/:taskId/chat", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const { text, attachments, messageType, mention, mentionLabel, isSubtaskUpdate, subtaskId, subtaskTitle } = req.body;
        if (!text?.trim() && (!attachments || !attachments.length)) return res.status(400).json({ error: "text or attachments required" });
        const msg = await svc.sendTaskChatMessage({
            taskId: req.params.taskId,
            senderId: req.coworkUser.employeeId,
            senderName: req.coworkUser.name,
            text: text || "", attachments: attachments || [],
            messageType: messageType || "text",
            mention: mention || null, mentionLabel: mentionLabel || null,
            isSubtaskUpdate: isSubtaskUpdate || false,
            subtaskId: subtaskId || null, subtaskTitle: subtaskTitle || null,
        });
        res.status(201).json({ success: true, message: msg });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Get task chat ─────────────────────────────────────────
router.get("/task/:taskId/chat", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const messages = await svc.getTaskChatMessages(req.params.taskId, req.query.limit);
        res.json({ messages });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Full task (with subtasks + chat) ─────────────────────
router.get("/task/:taskId/full", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const task = await svc.getFullTaskDetails(req.params.taskId);
        if (!task) return res.status(404).json({ error: "Task not found" });
        res.json({ task });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Edit deadline (CEO only) ──────────────────────────────
router.patch("/task/:taskId/deadline", verifyCoworkToken, verifyCeoToken, async (req, res) => {
    try {
        const { newDueDate, reason } = req.body;
        if (!reason?.trim()) return res.status(400).json({ error: "reason is required" });
        const result = await svc.editTaskDeadline({
            taskId: req.params.taskId,
            newDueDate: newDueDate || null,
            reason: reason.trim(),
            editedBy: req.coworkUser.employeeId,
            editedByName: req.coworkUser.name,
        });
        res.json(result);
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Delete task (CEO only) ────────────────────────────────
router.delete("/task/:taskId", verifyCoworkToken, verifyCeoToken, async (req, res) => {
    try {
        const result = await svc.deleteTask({
            taskId: req.params.taskId,
            deletedBy: req.coworkUser.employeeId,
        });
        res.json(result);
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Conversations v2 ──────────────────────────────────────
router.get("/direct-message/conversations-v2", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const conversations = await svc.listConversationsEnhanced(req.coworkUser.employeeId);
        res.json({ conversations });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Submit completion (employee) ──────────────────────────
router.post("/task/:taskId/submit-completion", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const { message, imageUrls, pdfAttachments } = req.body;
        const result = await svc.submitCompletionRequest({
            taskId: req.params.taskId,
            employeeId: req.coworkUser.employeeId,
            employeeName: req.coworkUser.name,
            message: message || "",
            imageUrls: imageUrls || [],
            pdfAttachments: pdfAttachments || [],
        });
        res.status(201).json(result);
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── TL reviews completion ─────────────────────────────────
router.post("/task/:taskId/review-completion", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const { approved, rejectionReason } = req.body;
        if (typeof approved !== "boolean") return res.status(400).json({ error: "approved (boolean) required" });
        const result = await svc.reviewCompletion({
            taskId: req.params.taskId,
            reviewerId: req.coworkUser.employeeId,
            reviewerName: req.coworkUser.name,
            approved,
            rejectionReason: rejectionReason || "",
        });
        res.json(result);
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── CEO final review ──────────────────────────────────────
router.post("/task/:taskId/ceo-review", verifyCoworkToken, verifyCeoToken, async (req, res) => {
    try {
        const { approved, rejectionReason } = req.body;
        if (typeof approved !== "boolean") return res.status(400).json({ error: "approved (boolean) required" });
        const result = await svc.ceoReviewCompletion({
            taskId: req.params.taskId,
            reviewerId: req.coworkUser.employeeId,
            reviewerName: req.coworkUser.name,
            approved,
            rejectionReason: rejectionReason || "",
        });
        res.json(result);
    } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;