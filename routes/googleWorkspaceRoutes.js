// GRAV-CMS-BACKEND/routes/googleWorkspaceRoutes.js
const express = require("express");
const router = express.Router();

const { getAuthUrl, getTokensFromCode } = require("./services/googleAuthService");
const {
  getTaskLists, getAllTasks, getAllTasksFlat, getTasksInList,
  createGoogleTask, createSubtask, updateGoogleTask,
} = require("./services/googleTasksService");
const { getInboxMessages, getEmailBody, getUnreadCount, searchEmails, getEmailsForUser, getAllInbox } = require("./services/googleGmailService");
const { getCalendars, getUpcomingEvents, getTodayEvents, createEvent } = require("./services/googleCalendarService");
const { getRecentFiles, searchFiles } = require("./services/googleDriveService");
const {
  getEmployeeAuthUrl,
  saveEmployeeGmailToken,
  getEmployeeGmailToken,
  disconnectEmployeeGmail,
  getEmployeeInbox,
} = require("./services/googleEmployeeGmailService");

// Chat service - load safely in case not set up yet
let chatService = null;
try {
  chatService = require("./services/googleAuthService");
} catch (e) {
  console.log("ℹ️ Google Chat service not available:", e.message);
}

// ── AUTH ─────────────────────────────────────────────────────────────────────
router.get("/auth/url", (req, res) => {
  try {
    res.json({ success: true, url: getAuthUrl() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/auth/callback", async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).json({ success: false, message: "No code provided" });
    const tokens = await getTokensFromCode(code);
    res.json({
      success: true,
      message: "✅ Copy refresh_token into your .env as GOOGLE_REFRESH_TOKEN",
      refresh_token: tokens.refresh_token,
      tokens,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
router.get("/dashboard", async (req, res) => {
  try {
    const promises = [getAllTasksFlat(), getUnreadCount(), getTodayEvents()];
    if (chatService) promises.push(chatService.getSpaces());

    const results = await Promise.allSettled(promises);
    const tasksResult = results[0];
    const gmailResult = results[1];
    const calResult = results[2];
    const spacesResult = results[3];

    res.json({
      success: true,
      data: {
        tasks: tasksResult.status === "fulfilled" ? tasksResult.value.tasks || [] : [],
        taskStats: tasksResult.status === "fulfilled" ? tasksResult.value.stats || {} : {},
        tasksByList: tasksResult.status === "fulfilled" ? tasksResult.value.byList || {} : {},
        gmail: gmailResult.status === "fulfilled" ? gmailResult.value : { unread: 0, total: 0 },
        todayEvents: calResult.status === "fulfilled" ? calResult.value : [],
        spaces: spacesResult?.status === "fulfilled" ? spacesResult.value : [],
        fetchedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GOOGLE TASKS ──────────────────────────────────────────────────────────────
router.get("/tasks/lists", async (req, res) => {
  try {
    res.json({ success: true, data: await getTaskLists() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/tasks/flat", async (req, res) => {
  try {
    const result = await getAllTasksFlat();
    res.json({ success: true, data: result.tasks, stats: result.stats, byList: result.byList });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/tasks", async (req, res) => {
  try {
    res.json({ success: true, data: await getAllTasks() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/tasks/list/:listId", async (req, res) => {
  try {
    res.json({ success: true, data: await getTasksInList(req.params.listId, "") });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/tasks", async (req, res) => {
  try {
    const { tasklistId, title, notes, due } = req.body;
    if (!tasklistId || !title) {
      return res.status(400).json({ success: false, message: "tasklistId and title required" });
    }
    res.status(201).json({ success: true, data: await createGoogleTask(tasklistId, { title, notes, due }) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/tasks/subtask", async (req, res) => {
  try {
    const { tasklistId, parentTaskId, title, notes } = req.body;
    if (!tasklistId || !parentTaskId || !title) {
      return res.status(400).json({ success: false, message: "tasklistId, parentTaskId, title required" });
    }
    res.status(201).json({ success: true, data: await createSubtask(tasklistId, parentTaskId, { title, notes }) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch("/tasks/:listId/:taskId", async (req, res) => {
  try {
    res.json({ success: true, data: await updateGoogleTask(req.params.listId, req.params.taskId, req.body) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GMAIL ─────────────────────────────────────────────────────────────────────
router.get("/gmail/inbox", async (req, res) => {
  try {
    res.json({ success: true, data: await getInboxMessages(parseInt(req.query.max) || 20) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/gmail/message/:id", async (req, res) => {
  try {
    res.json({ success: true, data: await getEmailBody(req.params.id) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/gmail/unread", async (req, res) => {
  try {
    res.json({ success: true, data: await getUnreadCount() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/gmail/search", async (req, res) => {
  try {
    if (!req.query.q) return res.status(400).json({ success: false, message: "q required" });
    res.json({ success: true, data: await searchEmails(req.query.q, 15) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── CALENDAR ──────────────────────────────────────────────────────────────────
router.get("/calendar/calendars", async (req, res) => {
  try {
    res.json({ success: true, data: await getCalendars() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/calendar/events", async (req, res) => {
  try {
    res.json({ success: true, data: await getUpcomingEvents(parseInt(req.query.days) || 30) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/calendar/today", async (req, res) => {
  try {
    res.json({ success: true, data: await getTodayEvents() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/calendar/events", async (req, res) => {
  try {
    res.status(201).json({ success: true, data: await createEvent(req.body) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DRIVE ─────────────────────────────────────────────────────────────────────
router.get("/drive/files", async (req, res) => {
  try {
    res.json({ success: true, data: await getRecentFiles(parseInt(req.query.max) || 20) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/drive/search", async (req, res) => {
  try {
    if (!req.query.q) return res.status(400).json({ success: false, message: "q required" });
    res.json({ success: true, data: await searchFiles(req.query.q) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// ── GMAIL: per-user scoped to their registered email ─────────────────────────────────
// GET /api/google/gmail/my-inbox?email=xxx&max=30
router.get("/gmail/my-inbox", async (req, res) => {
  try {
    const { email, max } = req.query;
    if (!email) return res.status(400).json({ success: false, message: "email query param required" });
    const maxResults = parseInt(max) || 30;
    const data = await getEmailsForUser(email, maxResults);
    res.json({ success: true, data, email });
  } catch (err) {
    console.error("[gmail/my-inbox]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/google/gmail/all-inbox?max=30
router.get("/gmail/all-inbox", async (req, res) => {
  try {
    const maxResults = parseInt(req.query.max) || 30;
    const data = await getAllInbox(maxResults);
    res.json({ success: true, data });
  } catch (err) {
    console.error("[gmail/all-inbox]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});


// ── PER-EMPLOYEE GMAIL ────────────────────────────────────────────────────────

// GET /api/google/employee-gmail/auth-url?employeeId=E001
// Returns OAuth URL for this employee to connect their personal Gmail
router.get("/employee-gmail/auth-url", (req, res) => {
  try {
    const { employeeId } = req.query;
    if (!employeeId) return res.status(400).json({ success: false, message: "employeeId required" });
    const url = getEmployeeAuthUrl(employeeId);
    res.json({ success: true, url });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/google/employee-gmail/callback?code=xxx&state=E001
// Called by Google after employee authorizes — saves token to Firestore
router.get("/employee-gmail/callback", async (req, res) => {
  try {
    const { code, state: employeeId } = req.query;
    if (!code || !employeeId) return res.status(400).json({ success: false, message: "Missing code or employeeId" });
    const { connectedEmail } = await saveEmployeeGmailToken(employeeId, code);
    // Redirect back to CoWork settings with success param
    const frontendUrl = process.env.COWORK_FRONTEND_URL || "http://localhost:3000";
    res.redirect(`${frontendUrl}/coworking/settings?gmail=connected&email=${encodeURIComponent(connectedEmail)}`);
  } catch (err) {
    console.error("[employee-gmail/callback]", err.message);
    const frontendUrl = process.env.COWORK_FRONTEND_URL || "http://localhost:3000";
    res.redirect(`${frontendUrl}/coworking/settings?gmail=error&message=${encodeURIComponent(err.message)}`);
  }
});

// GET /api/google/employee-gmail/inbox?employeeId=E001&max=30
// Returns this employee's own Gmail inbox
router.get("/employee-gmail/inbox", async (req, res) => {
  try {
    const { employeeId, max } = req.query;
    if (!employeeId) return res.status(400).json({ success: false, message: "employeeId required" });
    const result = await getEmployeeInbox(employeeId, parseInt(max) || 30);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("[employee-gmail/inbox]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/google/employee-gmail/status?employeeId=E001
// Check if this employee has Gmail connected
router.get("/employee-gmail/status", async (req, res) => {
  try {
    const { employeeId } = req.query;
    if (!employeeId) return res.status(400).json({ success: false, message: "employeeId required" });
    const token = await getEmployeeGmailToken(employeeId);
    res.json({
      success: true,
      connected: !!token,
      connectedEmail: token?.connectedEmail || null,
      connectedAt: token?.connectedAt || null,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/google/employee-gmail/disconnect?employeeId=E001
router.delete("/employee-gmail/disconnect", async (req, res) => {
  try {
    const { employeeId } = req.query;
    if (!employeeId) return res.status(400).json({ success: false, message: "employeeId required" });
    await disconnectEmployeeGmail(employeeId);
    res.json({ success: true, message: "Gmail disconnected" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GOOGLE CHAT SPACES ────────────────────────────────────────────────────────

// GET /api/google/chat/spaces — all spaces (IT, HR, Designing etc)
router.get("/chat/spaces", async (req, res) => {
  if (!chatService) return res.status(503).json({ success: false, message: "Chat service not available" });
  try {
    res.json({ success: true, data: await chatService.getSpaces() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/google/chat/spaces/all — all spaces WITH their latest messages
router.get("/chat/spaces/all", async (req, res) => {
  if (!chatService) return res.status(503).json({ success: false, message: "Chat service not available" });
  try {
    const limit = parseInt(req.query.limit) || 30;
    res.json({ success: true, data: await chatService.getAllSpacesWithMessages(limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/google/chat/spaces/:spaceId/messages — messages for one space
router.get("/chat/spaces/:spaceId/messages", async (req, res) => {
  if (!chatService) return res.status(503).json({ success: false, message: "Chat service not available" });
  try {
    const spaceName = `spaces/${req.params.spaceId}`;
    const limit = parseInt(req.query.limit) || 50;
    res.json({ success: true, data: await chatService.getSpaceMessages(spaceName, limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/google/chat/spaces/:spaceId/members — members of a space
router.get("/chat/spaces/:spaceId/members", async (req, res) => {
  if (!chatService) return res.status(503).json({ success: false, message: "Chat service not available" });
  try {
    const spaceName = `spaces/${req.params.spaceId}`;
    res.json({ success: true, data: await chatService.getSpaceMembers(spaceName) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;