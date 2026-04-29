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
    const { title, description, notes, assigneeIds, priority, parentTaskId, groupId, createdByTl, isFolder, isRepeat, repeatConfig, isThirdParty, thirdPartyConfig, isGoal, goalConfig, hasTimer, fixedDeadline } = req.body;
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

    // Auto-priority: count existing open tasks for the first assignee → assign next priority
    let autoPriority = (typeof priority === "number" ? priority : Number(priority)) || null;
    if (!autoPriority && assigneeIds?.length > 0) {
      const { db } = require("../../config/firebaseAdmin");
      const existing = await db.collection("cowork_tasks")
        .where("assigneeIds", "array-contains", assigneeIds[0])
        .where("status", "not-in", ["done", "cancelled"])
        .get();
      autoPriority = Math.min(existing.size + 1, 5);
    }
    if (!autoPriority) autoPriority = 1;

    const task = await svc.createTask({
      title: title.trim(), description, notes,
      assignedBy: req.coworkUser.employeeId,
      assignedByName: req.coworkUser.name,
      assignedByRole: requesterRole,
      assigneeIds: assigneeIds || [],
      dueDate: null,
      priority: autoPriority,
      parentTaskId: parentTaskId || null,
      groupId: groupId || null,
      createdByTl: createdByTl || false,
      status: initialStatus,
      isFolder: folderFlag,
      isRepeat: repeatFlag,
      repeatConfig: (repeatFlag && repeatConfig) ? repeatConfig : null,
      isThirdParty: thirdPartyFlag,
      thirdPartyConfig: (thirdPartyFlag && thirdPartyConfig) ? thirdPartyConfig : null,
      isGoal: goalFlag,
      goalConfig: (goalFlag && goalConfig) ? goalConfig : null,
      hasTimer: hasTimer !== false && hasTimer !== "false",
      fixedDeadline: fixedDeadline || null,
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

// ── REPEAT TASK CONFIRM — employee accepts the repeat task ────────────────────
// Changes status: repeat_pending_confirmation → repeat_active
// Unlocks chat and daily submissions
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

// ── 6. CREATE SUBTASK ─────────────────────────────────────────────────────────
router.post("/task/:taskId/subtask", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { title, description, notes, assigneeIds, priority } = req.body;
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
      dueDate: null,
      priority: (typeof priority === "number" ? priority : Number(priority)) || 5,
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
    const allTasks = await svc.listTasksWithHierarchy(employeeId, role);

    let filtered = allTasks;

    if (role === "ceo") {
      // CEO sees tasks they created OR tasks assigned to them (e.g. TL assigned to CEO)
      filtered = allTasks.filter(t => {
        const assignedToMe = (t.assigneeIds || []).includes(employeeId);
        const createdByMe = t.assignedBy === employeeId || t.createdByCeo === true || t.assignedByRole === "ceo";
        return assignedToMe || createdByMe;
      });
    } else if (role === "tl") {
      // TL: sees tasks they created OR tasks assigned to them — handled in service
    }
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
router.delete("/task/:taskId", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  if (!["ceo", "tl"].includes(req.coworkUser.role)) return res.status(403).json({ error: "Only CEO or TL can delete tasks" });
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

// ── PROPOSE DEADLINE (employee sets deadline before confirming) ───────────────
router.post("/task/:taskId/propose-deadline", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { proposedDate, workedSecs } = req.body;
    if (!proposedDate) return res.status(400).json({ error: "proposedDate required" });
    const result = await svc.proposeDeadline({
      taskId: req.params.taskId,
      employeeId: req.coworkUser.employeeId,
      employeeName: req.coworkUser.name,
      proposedDate,
      workedSecs: Number(workedSecs) || 0,
    });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── APPROVE / REJECT DEADLINE (task creator only) ─────────────────────────────
router.post("/task/:taskId/approve-deadline", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { approved, rejectionReason } = req.body;
    if (typeof approved !== "boolean") return res.status(400).json({ error: "approved (boolean) required" });
    const result = await svc.approveDeadline({
      taskId: req.params.taskId,
      approverId: req.coworkUser.employeeId,
      approverName: req.coworkUser.name,
      approved,
      rejectionReason: rejectionReason || "",
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

    const { db, admin } = require("../../config/firebaseAdmin");
    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Task not found" });
    const task = snap.data();

    if (!task.isThirdParty && !task.isGoal && !task.isRepeat)
      return res.status(400).json({ error: "Only third-party, goal, or repeat tasks support this flow" });

    if (!task.assigneeIds?.includes(req.coworkUser.employeeId))
      return res.status(403).json({ error: "Only assigned employees can request an extension" });

    await taskRef.update({
      deadlineExtRequest: {
        proposedDate,
        reason: reason || "",
        requestedBy: req.coworkUser.employeeId,
        requestedByName: req.coworkUser.name,
        requestedAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "pending",
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

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
    const { role } = req.coworkUser;
    if (!["ceo", "tl"].includes(role)) return res.status(403).json({ error: "Only CEO/TL can review extensions" });

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

    await taskRef.update(update);
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

    // Only assignee can save activities
    const canEdit = task.assigneeIds?.includes(employeeId) || ["ceo", "tl"].includes(role);
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

    // ── Email: notify CEO/TL when Y does Final Submit ──
    if (submitted === true && !task.goalActivitiesSubmitted) {
      try {
        const { sendNotificationEmail } = require("../../services/emailNotifications.service");
        const { db: _db } = require("../../config/firebaseAdmin");
        // Get all head employees (CEO/TL) to notify
        const headIds = [task.assignedBy, ...(task.confirmedBy || [])].filter(Boolean);
        const uniqueHeads = [...new Set(headIds)];
        const submitter = await _db.collection("cowork_employees").doc(employeeId).get();
        const submitterName = submitter.exists ? submitter.data().name : "Employee";
        for (const headId of uniqueHeads) {
          const headDoc = await _db.collection("cowork_employees").doc(headId).get();
          if (!headDoc.exists || !headDoc.data().email) continue;
          const head = headDoc.data();
          await sendNotificationEmail({
            senderId: employeeId, senderName: submitterName,
            receiverId: headId, receiverName: head.name, receiverEmail: head.email,
            type: "goal_final_submit",
            title: `Goal roadmap submitted: ${task.title}`,
            body: `${submitterName} submitted the activity roadmap for "${task.title}"`,
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
    if (!["ceo", "tl"].includes(role)) return res.status(403).json({ error: "Only CEO or TL can request reports" });

    const { db, admin } = require("../../config/firebaseAdmin");
    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) return res.status(404).json({ error: "Task not found" });
    const task = snap.data();
    if (!task.isGoal) return res.status(400).json({ error: "Not a goal task" });

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