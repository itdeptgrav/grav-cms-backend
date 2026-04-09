/**
 * GRAV-CMS-BACKEND/routes/taskTree.routes.js
 */

const express = require("express");
const router = express.Router();
const { verifyCoworkToken } = require("../../Middlewear/coworkAuth");
const svc = require("../../services/taskTree.service");
const multer = require("multer");
const { uploadMediaToCloudinary, uploadPDFToGoogleDrive } = require("../../services/mediaUpload.service");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ─── Task CRUD ────────────────────────────────────────────────────────────────

// Create task (root or nested)
router.post("/task/create", verifyCoworkToken, async (req, res) => {
    try {
        const result = await svc.createTask(req.user.uid, req.body);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// List root tasks
router.get("/tasks/roots", verifyCoworkToken, async (req, res) => {
    try {
        const tasks = await svc.listRootTasks(req.user.uid, req.user.role);
        res.json({ tasks });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get single task (no subtree)
router.get("/task/:taskId", verifyCoworkToken, async (req, res) => {
    try {
        const task = await svc.getTask(req.params.taskId);
        res.json({ task });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get full task tree (task + all descendants)
router.get("/task/:taskId/tree", verifyCoworkToken, async (req, res) => {
    try {
        const tree = await svc.getTaskTree(req.params.taskId);
        res.json({ tree });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get breadcrumb path
router.get("/task/:taskId/breadcrumb", verifyCoworkToken, async (req, res) => {
    try {
        const crumbs = await svc.getBreadcrumb(req.params.taskId);
        res.json({ breadcrumb: crumbs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update task
router.put("/task/:taskId/update", verifyCoworkToken, async (req, res) => {
    try {
        const result = await svc.updateTask(req.params.taskId, req.body);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Edit deadline
router.put("/task/:taskId/deadline", verifyCoworkToken, async (req, res) => {
    try {
        const { newDeadline, reason } = req.body;
        if (!reason) return res.status(400).json({ error: "Reason is required" });
        const result = await svc.editDeadline(req.params.taskId, newDeadline, reason, req.user.uid);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete task (cascades to all children)
router.delete("/task/:taskId/delete", verifyCoworkToken, async (req, res) => {
    try {
        await svc.deleteTaskCascade(req.params.taskId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Forward task
router.post("/task/:taskId/forward", verifyCoworkToken, async (req, res) => {
    try {
        const { toUserId, notes } = req.body;
        const result = await svc.forwardTask(req.params.taskId, req.user.uid, toUserId, notes);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Status transitions ───────────────────────────────────────────────────────

router.post("/task/:taskId/confirm", verifyCoworkToken, async (req, res) => {
    try {
        const result = await svc.confirmTask(req.params.taskId, req.user.uid);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post("/task/:taskId/start", verifyCoworkToken, async (req, res) => {
    try {
        const result = await svc.startTask(req.params.taskId, req.user.uid);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Task Chat ────────────────────────────────────────────────────────────────

router.post("/task/:taskId/chat/send", verifyCoworkToken, async (req, res) => {
    try {
        const result = await svc.sendChatMessage(req.params.taskId, req.user.uid, req.body);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get("/task/:taskId/chat/messages", verifyCoworkToken, async (req, res) => {
    try {
        const messages = await svc.getChatMessages(req.params.taskId, parseInt(req.query.limit) || 100);
        res.json({ messages });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Upload image for chat ────────────────────────────────────────────────────
router.post("/task/:taskId/chat/upload-image", verifyCoworkToken, upload.single("file"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file" });
        const result = await uploadMediaToCloudinary(req.file.buffer, { folder: "cowork-task-chat", resource_type: "image" });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Upload voice for chat ────────────────────────────────────────────────────
router.post("/task/:taskId/chat/upload-voice", verifyCoworkToken, upload.single("file"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file" });
        const result = await uploadMediaToCloudinary(req.file.buffer, { folder: "cowork-voice", resource_type: "video" });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Upload PDF for chat ──────────────────────────────────────────────────────
router.post("/task/:taskId/chat/upload-pdf", verifyCoworkToken, upload.single("file"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file" });
        const result = await uploadPDFToGoogleDrive(req.file.buffer, req.file.originalname, req.file.mimetype);
        if (!result.success) return res.status(500).json({ error: result.error || "PDF upload failed" });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Daily Reports ────────────────────────────────────────────────────────────

router.post("/task/:taskId/report/submit", verifyCoworkToken, async (req, res) => {
    try {
        const result = await svc.submitDailyReport(req.params.taskId, req.user.uid, req.body);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get("/task/:taskId/reports", verifyCoworkToken, async (req, res) => {
    try {
        const reports = await svc.getDailyReports(req.params.taskId, req.user.uid, req.user.role);
        res.json({ reports });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Completion verification ──────────────────────────────────────────────────

router.post("/task/:taskId/complete/submit", verifyCoworkToken, async (req, res) => {
    try {
        const result = await svc.submitCompletionProof(req.params.taskId, req.user.uid, req.body);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post("/task/:taskId/complete/tl-review", verifyCoworkToken, async (req, res) => {
    try {
        const { decision, rejectionReason } = req.body;
        const result = await svc.tlReviewCompletion(req.params.taskId, req.user.uid, decision, rejectionReason);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post("/task/:taskId/complete/ceo-review", verifyCoworkToken, async (req, res) => {
    try {
        const { decision, rejectionReason } = req.body;
        const result = await svc.ceoReviewCompletion(req.params.taskId, req.user.uid, decision, rejectionReason);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;