/**
 * GRAV-CMS-BACKEND/services/taskForward.service.js
 *
 * FULL REWRITE — all previous features + NEW:
 *  - CEO AND TL can create tasks (createTask — replaces CEO-only createParentTask)
 *  - Unlimited nested subtasks (subtask under subtask under subtask...)
 *  - Each task has its OWN independent chat subcollection (no overlap)
 *  - Each task has its OWN daily reports (no overlap)
 *  - Any assigned person (CEO/TL/employee) can forward a task
 *  - Breadcrumb path stored on each task for navigation
 *  - getTaskTree — loads full hierarchy recursively
 *  - sendTaskChat / getTaskChat — isolated per task
 */

const { admin, db, messaging } = require("../config/firebaseAdmin");
const c1Svc = require("./c1Service");
const socket = require("../config/socketInstance");
const { v4: uuidv4 } = require("uuid");

// ─── Deadline helpers ─────────────────────────────────────
function deadlineStatus(dueDate) {
  if (!dueDate) return "none";
  const diff = new Date(dueDate).getTime() - Date.now();
  if (diff < 0) return "overdue";
  if (diff < 2 * 24 * 3600 * 1000) return "near";
  return "safe";
}
function deadlineColor(dueDate) {
  const s = deadlineStatus(dueDate);
  return s === "overdue" ? "#d93025" : s === "near" ? "#f9ab00" : s === "safe" ? "#1e8e3e" : "#80868b";
}

// ─── Duration formatter for draft-chat system messages ────────────────────────
// Formats "duration from now" as a human string like "2h", "45m", "1h 30m", "3 days".
// Used in deadline proposal/counter chat messages to AVOID a stale wall-clock timestamp
// (which misleads under the live-deadline model where the clock only starts when the
// employee presses Play).
// Format a raw second count as a short human string: "45m", "2h", "1h 30m", "3 days".
function _fmtSecs(s) {
  s = Math.max(0, Math.round(Number(s) || 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const days = Math.round(s / 86400);
  return days === 1 ? "1 day" : `${days} days`;
}

function _fmtDurationChat(targetDate) {
  if (!targetDate) return "?";
  const ms = new Date(targetDate).getTime() - Date.now();
  if (ms <= 0) return "0m";
  return _fmtSecs(Math.round(ms / 1000));
}

// ─── Notify helper ────────────────────────────────────────
// Build rich multiline body for push notification based on event type
function _buildRichBody(type, body, data = {}) {
  const lines = [body || ""];
  if (type === "task_assigned" || type === "task_forwarded") {
    if (data.priority) lines.push(`Priority: ${data.priority}`);
    if (data.dueDate) lines.push(`Due: ${data.dueDate}`);
    if (data.description) lines.push(String(data.description).slice(0, 60));
  } else if (type === "task_chat") {
    if (data.taskTitle) lines.push(`Task: ${data.taskTitle}`);
  } else if (type === "daily_report") {
    if (data.taskTitle) lines.push(`Task: ${data.taskTitle}`);
  } else if (type === "completion_rejected" || type === "completion_ceo_rejected") {
    if (data.reason) lines.push(`Reason: ${data.reason}`);
  } else if (type === "deadline_changed") {
    if (data.taskTitle) lines.push(`Task: ${data.taskTitle}`);
  } else if (type === "goal_final_submit") {
    if (data.componentCount) lines.push(`Components: ${data.componentCount}`);
    if (data.submittedAt) lines.push(`Submitted: ${data.submittedAt}`);
  } else if (type === "goal_component_done") {
    if (data.componentTitle) lines.push(`Component: ${data.componentTitle}`);
    if (data.progress) lines.push(`Progress: ${data.progress}`);
    if (data.reportText) lines.push(String(data.reportText).slice(0, 60));
  } else if (type === "goal_report_submitted") {
    if (data.componentTitle) lines.push(`Component: ${data.componentTitle}`);
    if (data.fileCount) lines.push(`Attachments: ${data.fileCount} file${data.fileCount !== 1 ? "s" : ""}`);
    if (data.reportText) lines.push(String(data.reportText).slice(0, 80));
  }
  return lines.filter(Boolean).join("\n");
}

// Clear event type label for push title
function _buildTitle(type, title) {
  const labels = {
    task_assigned: "📋 Task Assigned",
    task_confirmed: "✅ Task Confirmed",
    task_started: "▶️ Work Started",
    task_forwarded: "↪️ Task Forwarded",
    task_deleted: "🗑️ Task Deleted",
    task_chat: "💬 Task Chat",
    daily_report: "📊 Progress Report",
    deadline_changed: "⏰ Deadline Changed",
    completion_submitted: "📤 Work Submitted",
    completion_tl_approved: "✅ TL Approved",
    completion_ceo_approved: "🏆 Task Complete",
    completion_rejected: "❌ Work Rejected",
    completion_ceo_rejected: "❌ CEO Rejected",
    goal_final_submit: "🚀 Goal Submitted",
    goal_component_done: "✅ Component Done",
    goal_report_submitted: "📋 Report Submitted",
  };
  const label = labels[type];
  if (!label) return title;
  // Extract the task/context name from title (after · or :)
  const parts = title.split(/[·:]/);
  const context = parts.length > 1 ? parts.slice(1).join("·").trim() : "";
  return context ? `${label} · ${context}` : `${label}`;
}

async function _notifyMany({ recipientIds, type, title, body, data, senderId, senderName }) {
  if (!recipientIds?.length) return;
  const batch = db.batch();
  recipientIds.forEach(id => {
    batch.set(db.collection("cowork_notifications").doc(uuidv4()), {
      recipientEmployeeId: id, type, title, body,
      data: data || {}, read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  await batch.commit();
  socket.emitToMany(recipientIds, "new_notification", { type, title, body, data });

  // FCM push — fire immediately without awaiting (realtime delivery)
  setImmediate(() => {
    try {
      const { sendPushToEmployees } = require("./fcmPush.service");
      const richTitle = _buildTitle(type, title);
      const richBody = _buildRichBody(type, body, data || {});
      sendPushToEmployees(recipientIds, richTitle, richBody, { type, ...(data || {}) })
        .catch(e => console.error("[FCM taskForward]", e.message));
    } catch (e) { console.error("[FCM taskForward init]", e.message); }
  });

  // Email — fire async without awaiting (slow, must not delay push)
  setImmediate(async () => {
    try {
      const { sendNotificationEmail } = require("./emailNotifications.service");
      const empDocs = await Promise.all(
        recipientIds.map(id => db.collection("cowork_employees").doc(id).get())
      );
      for (const empDoc of empDocs) {
        if (!empDoc.exists) continue;
        const emp = empDoc.data();
        if (!emp.email) continue;
        await sendNotificationEmail({
          senderId: senderId || "system",
          senderName: senderName || "CoWork",
          receiverId: emp.employeeId || empDoc.id,
          receiverName: emp.name || empDoc.id,
          receiverEmail: emp.email,
          type, title, body, data: data || {},
        });
      }
    } catch (e) { console.error("[Email taskForward]", e.message); }
  });
}

// ─── ID generator ─────────────────────────────────────────
async function _generateTaskId() {
  const ref = db.collection("cowork_meta").doc("counters");
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const next = (snap.exists ? snap.data().taskSeq || 0 : 0) + 1;
    tx.set(ref, { taskSeq: next }, { merge: true });
    return `T${String(next).padStart(3, "0")}`;
  });
}

// ─── Build breadcrumb path ────────────────────────────────
async function _buildPath(parentTaskId) {
  if (!parentTaskId) return [];
  const path = [];
  let currentId = parentTaskId;
  let depth = 0;
  while (currentId && depth < 20) {
    const doc = await db.collection("cowork_tasks").doc(currentId).get();
    if (!doc.exists) break;
    const t = doc.data();
    path.unshift({ taskId: t.taskId, title: t.title });
    currentId = t.parentTaskId || null;
    depth++;
  }
  return path;
}

// ═════════════════════════════════════════════════════════
//  1. CREATE TASK (CEO or TL — replaces CEO-only)
// ═════════════════════════════════════════════════════════
async function createTask({ title, description, notes, requirements = [], assignedBy, assignedByName, assignedByRole, assigneeIds, dueDate, priority = 5, parentTaskId = null, groupId = null, createdByTl = false, createdByCeo = false, rootCreatedByRole = null, isFolder = false, isRepeat = false, repeatConfig = null, isThirdParty = false, thirdPartyConfig = null, isGoal = false, goalConfig = null, hasTimer = true, fixedDeadline = null, status = "open", isSelfAssigned = false, visibleTo = [], approverId = null, approverName = null, senderTimerWindowSecs = 0,
  isGoldTask = false,
  c2Config = null,
  etcHours = 0,
  assigneePriorities = {} }) {

  const taskId = await _generateTaskId();
  const now = new Date().toISOString();
  const path = await _buildPath(parentTaskId);

  // rootCreatedByRole = who is the root creator for the completion review flow.
  // RULE: use what's explicitly passed (forwardTask passes parent's root role),
  //       OR the immediate creator's own role. NEVER inherit from parent automatically —
  //       a TL directly creating a subtask is TL's own task (tl_final), not CEO's (tl_then_ceo).
  const resolvedRootRole = rootCreatedByRole || assignedByRole || null;

  const task = {
    taskId,
    title: title.trim(),
    description: description || "",
    notes: notes || "",
    requirements: Array.isArray(requirements) ? requirements : [],
    assignedBy,
    assignedByName: assignedByName || "",
    assignedByRole: assignedByRole || null,
    rootCreatedByRole: resolvedRootRole,
    assigneeIds: assigneeIds || [],
    dueDate: dueDate || null,
    priority,
    assigneePriorities: assigneePriorities || {},
    deadlineStatus: deadlineStatus(dueDate),
    deadlineColor: deadlineColor(dueDate),
    progressPercent: 0,
    status: status || "open",
    groupId: groupId || null,
    isFolder: isFolder || false,
    isRepeat: isRepeat || false,
    repeatConfig: isRepeat && repeatConfig ? repeatConfig : null,
    isThirdParty: isThirdParty || false,
    thirdPartyConfig: isThirdParty && thirdPartyConfig ? thirdPartyConfig : null,
    vendorUpdates: [],
    thirdPartyStatus: isThirdParty ? "pending_confirmation" : null,
    lastUpdateAt: null,
    isGoal: isGoal || false,
    goalConfig: isGoal && goalConfig ? goalConfig : null,
    isGoldTask: isGoldTask || false,
    c2Config: (isGoldTask && c2Config) ? c2Config : null,
    etcHours: Number(etcHours) || 0,
    c1: {
      deadlinesMissed: 0,
      extensionsFiled: 0,
      reworksReceived: 0,
      taskScore: null,
      c1Status: "open",
      isExcluded: false,
      isRejected: false,
      officialDeadline: null,
      scoreCalculatedAt: null,
    },
    goalAchieved: isGoal ? 0 : null,
    goalUpdates: [],
    hasTimer: isRepeat || isThirdParty || isGoal ? null : (hasTimer !== false),
    fixedDeadline: (!isRepeat && !isThirdParty && !isGoal && !hasTimer) ? fixedDeadline || null : null,
    // ── Sender-preset timer: CEO/TL can set a suggested duration at task creation
    // When > 0, receiver sees "Time set: X hrs — Approve or suggest different" instead of
    // being asked to propose their own time from scratch.
    senderTimerWindowSecs: (!isRepeat && !isThirdParty && !isGoal && hasTimer !== false)
      ? (Number(senderTimerWindowSecs) || 0) : 0,
    // Self-assigned tasks: creator === assignee, so the sender/receiver
    // negotiate-and-approve step is meaningless. The requested duration
    // becomes the real, binding window immediately. Regular tasks unaffected.
    deadlineWindowSecs: (isSelfAssigned && !isRepeat && !isThirdParty && !isGoal && hasTimer !== false)
      ? (Number(senderTimerWindowSecs) || 0) : null,
    // Hierarchy
    parentTaskId: parentTaskId || null,
    isRoot: !parentTaskId,
    depth: path.length,
    path,
    subtaskIds: [],
    // Workflow flags
    confirmedBy: [],
    forwardedBy: null,
    forwardedByName: null,
    originalAssignedBy: assignedBy,
    createdByTl: createdByTl || assignedByRole === "tl",
    createdByCeo: createdByCeo || assignedByRole === "ceo",
    // Self-assign fields
    isSelfAssigned: isSelfAssigned || false,
    visibleTo: visibleTo || [],
    approverId: approverId || null,
    approverName: approverName || null,
    selfAssignApproved: isSelfAssigned ? false : null,
    // Reports & thread
    dailyReportCount: 0,
    chatMessageCount: 0,
    // Completion
    completionStatus: null,
    completionSubmission: null,
    tlReview: null,
    ceoReview: null,
    deadlineHistory: [],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAtISO: now,
    // ── PMP quarter tracking ──────────────────────────────────────────────────
    quarter: Math.ceil((new Date().getMonth() + 1) / 3), // 1 | 2 | 3 | 4
    year: new Date().getFullYear(),                        // e.g. 2026
    // ─────────────────────────────────────────────────────────────────────────
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.collection("cowork_tasks").doc(taskId).set(task);

  // Register as subtask on parent
  if (parentTaskId) {
    await db.collection("cowork_tasks").doc(parentTaskId).update({
      subtaskIds: admin.firestore.FieldValue.arrayUnion(taskId),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  if (assigneeIds?.length) {
    await _notifyMany({
      recipientIds: assigneeIds,
      type: "task_assigned",
      title: parentTaskId ? `📌 New Subtask · ${title}` : `📋 Task Assigned · ${title}`,
      body: notes?.slice(0, 80) || description?.slice(0, 80) || "You have been assigned a task.",
      data: { taskId, taskTitle: title, priority, dueDate, description, parentTaskId: parentTaskId || "" },
      senderId: assignedBy,
      senderName: assignedByName || assignedBy,
    });
    socket.emitToMany(assigneeIds, "new_task", {
      taskId, task: { ...task, createdAt: now }, title, assignedBy, parentTaskId,
    });
  }

  // ── P1 CONFLICT CHECK — same function used by play-button and drag triggers ──
  const _p1HasTimeBudget = fixedDeadline || Number(senderTimerWindowSecs) > 0 || Number(etcHours) > 0;
  if (Number(priority) === 1 && _p1HasTimeBudget && assigneeIds?.length) {
    setImmediate(() => {
      for (const empId of assigneeIds) {
        checkAndExtendForP1({
          newP1TaskId: taskId,
          employeeId: empId,
          assignedBy,
          newP1Priority: Number(priority),
        }).catch(e => console.error("[P1 Conflict Detection — createTask]", e.message));
      }
    });
  }
  // ──────────────────────────────────────────────────────────────────────────

  return { ...task, createdAt: now };
}

// ═════════════════════════════════════════════════════════
//  2. CONFIRM TASK RECEIPT
// ═════════════════════════════════════════════════════════
async function confirmTaskReceipt({ taskId, employeeId, employeeName }) {
  const ref = db.collection("cowork_tasks").doc(taskId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Task not found.");
  const task = doc.data();
  if (!task.assigneeIds.includes(employeeId)) throw new Error("Not assigned to this task.");
  if (task.confirmedBy?.includes(employeeId)) throw new Error("Already confirmed.");

  // Repeat, third-party, goal, and TIMER tasks skip deadline requirement — they confirm directly
  // hasTimer === true  → timer task, no deadline needed, confirm directly
  // hasTimer === false → deadline set by CEO at creation, confirm directly
  // hasTimer === undefined → old task, still needs deadline flow
  const needsDeadlineCheck = !task.isRepeat && !task.isThirdParty && !task.isGoal
    && task.hasTimer !== true   // timer tasks skip — no deadline needed
    && task.hasTimer !== false; // deadline tasks skip — CEO already set dueDate
  if (needsDeadlineCheck) {
    if (!task.dueDate && task.status !== "deadline_approved") {
      if (task.status === "pending_deadline_approval") {
        throw new Error("Your deadline proposal is pending approval. Please wait.");
      }
      throw new Error("Please propose a deadline and get it approved before confirming.");
    }
  }

  await ref.update({
    confirmedBy: admin.firestore.FieldValue.arrayUnion(employeeId),
    status: "confirmed",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const notifyIds = [task.assignedBy, task.originalAssignedBy].filter(id => id && id !== employeeId);
  await _notifyMany({ recipientIds: [...new Set(notifyIds)], type: "task_confirmed", title: `✅ Confirmed · ${task.title}`, body: `${employeeName} acknowledged task "${task.title}"`, data: { taskId, taskTitle: task.title }, senderId: employeeId, senderName: employeeName });
  socket.emitToMany([...new Set(notifyIds)], "task_confirmed", { taskId, employeeId, employeeName });
  return { success: true };
}

// ═════════════════════════════════════════════════════════
//  3. MARK TASK STARTED
// ═════════════════════════════════════════════════════════
async function markTaskStarted({ taskId, employeeId, employeeName }) {
  const ref = db.collection("cowork_tasks").doc(taskId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Task not found.");
  const task = doc.data();
  if (!task.assigneeIds.includes(employeeId)) throw new Error("Not assigned.");
  if (!task.confirmedBy?.includes(employeeId)) throw new Error("Must confirm before starting.");

  await ref.update({
    status: "in_progress",
    startedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const notifyIds = [task.assignedBy, task.originalAssignedBy].filter(id => id && id !== employeeId);
  await _notifyMany({ recipientIds: [...new Set(notifyIds)], type: "task_started", title: `▶️ Work Started · ${task.title}`, body: `Work has begun on "${task.title}"`, data: { taskId, taskTitle: task.title }, senderId: employeeId, senderName: employeeName });
  socket.emitToMany([...new Set(notifyIds)], "task_started", { taskId, employeeId, employeeName });
  return { success: true };
}

// ═════════════════════════════════════════════════════════
//  4. FORWARD TASK (any assigned person, any time)
//     Creates new tasks as children of the forwarded task
// ═════════════════════════════════════════════════════════
async function forwardTask({ parentTaskId, forwardedBy, forwardedByName, assignments }) {
  const parentRef = db.collection("cowork_tasks").doc(parentTaskId);
  const parentDoc = await parentRef.get();
  if (!parentDoc.exists) throw new Error("Task not found.");
  const parent = parentDoc.data();

  // CEO, TL, or any assignee can forward
  const forwarderDoc = await db.collection("cowork_employees").doc(forwardedBy).get();
  const forwarderRole = forwarderDoc.exists ? forwarderDoc.data().role : "employee";
  const canForward = forwarderRole === "ceo" || forwarderRole === "tl" ||
    parent.assigneeIds.includes(forwardedBy) || parent.assignedBy === forwardedBy;
  if (!canForward) throw new Error("Not authorized to forward this task.");

  const newTaskIds = [];

  for (const assignment of assignments) {
    if (!assignment.employeeId || !assignment.notes) continue;
    // Per-person auto-priority: count existing open tasks for this assignee
    let fwdPriority = Number(assignment.priority) || null;
    const fwdAssigneePriorities = {};
    try {
      const existing = await db.collection("cowork_tasks")
        .where("assigneeIds", "array-contains", assignment.employeeId)
        .where("status", "not-in", ["done", "cancelled"])
        .get();
      fwdAssigneePriorities[assignment.employeeId] = existing.size + 1;
      if (!fwdPriority) fwdPriority = existing.size + 1;
    } catch (e) {
      console.warn("[forwardTask] auto-priority fallback:", e.message);
      if (!fwdPriority) fwdPriority = 1;
      fwdAssigneePriorities[assignment.employeeId] = fwdPriority;
    }
    const newTask = await createTask({
      title: assignment.title || parent.title,
      description: assignment.description || parent.description || "",
      notes: assignment.notes,
      assignedBy: forwardedBy,
      assignedByName: forwardedByName,
      assignedByRole: forwarderRole,
      assigneeIds: [assignment.employeeId],
      dueDate: assignment.dueDate || parent.dueDate || null,
      priority: fwdPriority,
      assigneePriorities: fwdAssigneePriorities,
      parentTaskId,
      // Inherit root creator role so _reviewFlow stays correct down the chain
      rootCreatedByRole: parent.rootCreatedByRole || parent.assignedByRole || null,
    });
    newTaskIds.push(newTask.taskId);
  }

  // Post system message to parent chat
  await sendTaskChat({
    taskId: parentTaskId,
    senderId: forwardedBy,
    senderName: forwardedByName,
    text: `↗ ${forwardedByName} forwarded this task to ${newTaskIds.length} person(s). Subtasks: ${newTaskIds.join(", ")}`,
    messageType: "system",
  });

  // Update parent status
  await parentRef.update({
    status: "in_progress",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { newTaskIds };
}

// ═════════════════════════════════════════════════════════
//  5. SUBMIT DAILY REPORT (stored in task's own subcollection)
// ═════════════════════════════════════════════════════════
async function submitDailyReport({ taskId, employeeId, employeeName, message, imageUrls = [], pdfAttachments = [], progressPercent, reportDate }) {
  const ref = db.collection("cowork_tasks").doc(taskId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Task not found.");
  const task = doc.data();
  if (!task.assigneeIds.includes(employeeId)) throw new Error("Not assigned to this task.");

  const report = {
    id: uuidv4(),
    employeeId,
    employeeName,
    message,
    imageUrls,
    pdfAttachments,
    progressPercent: Number(progressPercent),
    reportDate: reportDate || new Date().toDateString(),
    timestamp: new Date().toISOString(),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  // Store in SUBCOLLECTION — independent per task
  await db.collection("cowork_tasks").doc(taskId).collection("dailyReports").doc(report.id).set(report);

  const newStatus = progressPercent >= 100 ? "done" : progressPercent > 0 ? "in_progress" : task.status;

  await ref.update({
    progressPercent: Number(progressPercent),
    status: newStatus,
    deadlineStatus: deadlineStatus(task.dueDate),
    dailyReportCount: admin.firestore.FieldValue.increment(1),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Notify only task creator / parent chain — NOT broadcast to everyone
  const notifyIds = [task.assignedBy, task.originalAssignedBy].filter(id => id && id !== employeeId);
  await _notifyMany({
    recipientIds: [...new Set(notifyIds)],
    type: "daily_report",
    title: `📊 Progress Report · ${task.title}`,
    body: `${employeeName}: ${message.slice(0, 60)} · ${progressPercent}%`,
    data: { taskId, taskTitle: task.title },
    senderId: employeeId,
    senderName: employeeName,
  });
  socket.emitToMany([...new Set(notifyIds)], "task_report", { taskId, report, progressPercent, status: newStatus });

  // Sync parent progress if this is a subtask
  if (task.parentTaskId) await _syncParentProgress(task.parentTaskId);

  return { report, status: newStatus };
}


// ─── Sync parent progress from children ──────────────────
async function _syncParentProgress(parentTaskId) {
  const parentDoc = await db.collection("cowork_tasks").doc(parentTaskId).get();
  if (!parentDoc.exists) return;
  const parent = parentDoc.data();
  if (!parent.subtaskIds?.length) return;

  const subtaskDocs = await Promise.all(parent.subtaskIds.map(id => db.collection("cowork_tasks").doc(id).get()));
  const subtasks = subtaskDocs.filter(d => d.exists).map(d => d.data());
  if (!subtasks.length) return;

  const avg = Math.round(subtasks.reduce((sum, s) => sum + (s.progressPercent || 0), 0) / subtasks.length);

  // NEVER auto-complete the parent task based on subtask completion.
  // The parent has its own review flow (TL submits → CEO approves, etc.)
  // Only update progressPercent and move to in_progress if work has started.
  // Status "done" can only be set through the proper completion review flow.
  const alreadyDone = ["done", "ceo_approved", "tl_final_approved"].includes(parent.status)
    || ["ceo_approved", "tl_final_approved"].includes(parent.completionStatus);

  if (!alreadyDone) {
    await db.collection("cowork_tasks").doc(parentTaskId).update({
      progressPercent: avg,
      status: avg > 0 ? "in_progress" : parent.status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // Recurse up if grandparent exists
  if (parent.parentTaskId) await _syncParentProgress(parent.parentTaskId);
}

// ═════════════════════════════════════════════════════════
//  6. TASK CHAT — completely isolated per task
// ═════════════════════════════════════════════════════════
async function sendTaskChat({ taskId, senderId, senderName, text, attachments = [], messageType = "text", mention = null }) {
  const taskDoc = await db.collection("cowork_tasks").doc(taskId).get();
  if (!taskDoc.exists) throw new Error("Task not found.");
  const task = taskDoc.data();

  if (messageType === "text" && attachments.length > 0) messageType = attachments[0].type || "text";

  const messageId = uuidv4();
  const isoTime = new Date().toISOString();

  const msg = {
    messageId, taskId, senderId, senderName,
    text: text || "", attachments, messageType,
    mention: mention || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  // Store in task's own chat subcollection — NEVER mixed with other tasks
  await db.collection("cowork_tasks").doc(taskId).collection("chat").doc(messageId).set(msg);
  await db.collection("cowork_tasks").doc(taskId).update({
    chatMessageCount: admin.firestore.FieldValue.increment(1),
    lastChatAt: admin.firestore.FieldValue.serverTimestamp(),
    lastChatPreview: text?.slice(0, 60) || (messageType === "image" ? "📷 Image" : messageType === "pdf" ? "📄 PDF" : "🎤 Voice"),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Socket: emit to all task participants including creator (for live updates)
  const allParticipants = [...new Set([
    ...(task.assigneeIds || []),
    task.assignedBy,
    task.originalAssignedBy,
    ...(task.confirmedBy || []),
  ])].filter(Boolean);

  const msgForSocket = { ...msg, createdAt: isoTime };
  socket.emitToMany(allParticipants, "task_chat_message", { taskId, message: msgForSocket });

  if (messageType !== "system") {
    // Notifications: only assignees, NOT the CEO/creator (task.assignedBy)
    // CEO created the task so they're always in assignedBy — they don't need
    // a notification for every message sent in their own assigned tasks
    const notifyIds = (task.assigneeIds || []).filter(id => id !== senderId);
    if (notifyIds.length) {
      await _notifyMany({
        recipientIds: notifyIds,
        type: "task_chat",
        title: `💬 Task Chat · ${task.title}`,
        body: `${senderName}: ${(text || "📎 attachment").slice(0, 60)}`,
        data: { taskId, taskTitle: task.title },
        senderId,
        senderName,
      });
    }
  }

  return msgForSocket;
}

async function getTaskChat(taskId, limit = 100) {
  const snap = await db.collection("cowork_tasks").doc(taskId).collection("chat")
    .orderBy("createdAt", "asc").limitToLast(Number(limit)).get();
  return snap.docs.map(d => {
    const data = d.data();
    return { ...data, createdAt: data.createdAt?.toDate?.()?.toISOString() || data.createdAt };
  });
}

// ═════════════════════════════════════════════════════════
//  7. GET TASK WITH CHILDREN (one level deep, chat + reports)
// ═════════════════════════════════════════════════════════
async function getTaskWithDetails(taskId) {
  const doc = await db.collection("cowork_tasks").doc(taskId).get();
  if (!doc.exists) return null;
  const task = { id: doc.id, ...doc.data() };
  // Default isFolder — older tasks saved before this field existed will be false
  if (task.isFolder === undefined) task.isFolder = false;
  if (task.isRepeat === undefined) task.isRepeat = false;
  if (task.isThirdParty === undefined) task.isThirdParty = false;
  if (task.isGoal === undefined) task.isGoal = false;

  // Timestamps
  if (task.createdAt?.toDate) task.createdAt = task.createdAt.toDate().toISOString();
  if (task.updatedAt?.toDate) task.updatedAt = task.updatedAt.toDate().toISOString();

  task.deadlineStatus = deadlineStatus(task.dueDate);
  task.deadlineColor = deadlineColor(task.dueDate);

  // Load immediate subtasks (children only — not recursively, UI does that)
  if (task.subtaskIds?.length) {
    const subDocs = await Promise.all(task.subtaskIds.map(sid => db.collection("cowork_tasks").doc(sid).get()));
    task.subtasks = subDocs.filter(d => d.exists).map(d => {
      const s = { id: d.id, ...d.data() };
      if (s.createdAt?.toDate) s.createdAt = s.createdAt.toDate().toISOString();
      s.deadlineStatus = deadlineStatus(s.dueDate);
      s.deadlineColor = deadlineColor(s.dueDate);
      return s;
    });
  } else {
    task.subtasks = [];
  }

  // Assignee details
  if (task.assigneeIds?.length) {
    const empDocs = await Promise.all(task.assigneeIds.map(id => db.collection("cowork_employees").doc(id).get()));
    task.assigneeDetails = empDocs.filter(d => d.exists).map(d => ({
      employeeId: d.id, name: d.data().name, profilePicUrl: d.data().profilePicUrl, department: d.data().department,
    }));
  }

  // Chat messages (THIS TASK'S OWN chat — isolated)
  task.chatMessages = await getTaskChat(taskId, 100);

  // Draft chat messages (pre-confirmation discussion)
  task.draftChatMessages = await getDraftChat(taskId, 100);

  return task;
}

// ═════════════════════════════════════════════════════════
//  8. GET DAILY REPORTS for a task (from subcollection)
// ═════════════════════════════════════════════════════════
async function getTaskDailyReports(taskId) {
  const snap = await db.collection("cowork_tasks").doc(taskId).collection("dailyReports")
    .orderBy("createdAt", "desc").limit(50).get();
  return snap.docs.map(d => {
    const data = d.data();
    return { ...data, createdAt: data.createdAt?.toDate?.()?.toISOString() || data.createdAt };
  });
}

// ═════════════════════════════════════════════════════════
//  9. LIST TASKS WITH HIERARCHY (for task list page)
// ═════════════════════════════════════════════════════════
async function listTasksWithHierarchy(employeeId, role, cursorMs = null, pageSize = 100) {
  // ── VISIBILITY RULES ──────────────────────────────────────────────────────
  // CEO    : sees tasks they created (assignedBy === CEO) + tasks assigned TO them by TL/others.
  //          TL-created subtasks under CEO's tasks are visible when CEO is an assignee.
  // TL     : sees tasks they created (assignedBy === TL) + tasks assigned to them.
  // Employee: sees ONLY tasks directly assigned to them (assigneeIds contains them).
  //           No walkUp — employees must not see parent tasks they weren't assigned to.
  // ─────────────────────────────────────────────────────────────────────────
  // NOTE: CEO and TL branches were identical (same two queries) — merged below.

  const seen = new Set();
  let tasks = [];

  const addDoc = (d) => {
    if (!seen.has(d.id)) {
      seen.add(d.id);
      tasks.push({ id: d.id, ...d.data() });
    }
  };

  // Bounded, cursor-aware — this is the query that scales with an employee's
  // TOTAL historical task count if left unbounded. Each source is capped at
  // pageSize, merged, re-sorted by updatedAt desc, then truncated to one page.
  const cursorDate = cursorMs ? new Date(Number(cursorMs)) : null;
  const roleQuery = (field, op, value) => {
    let q = db.collection("cowork_tasks").where(field, op, value)
      .orderBy("updatedAt", "desc").limit(pageSize);
    if (cursorDate) q = q.startAfter(cursorDate);
    return q;
  };

  if (role === "ceo" || role === "tl") {
    const [snap1, snap2] = await Promise.all([
      roleQuery("assignedBy", "==", employeeId).get(),
      roleQuery("assigneeIds", "array-contains", employeeId).get(),
    ]);
    [...snap1.docs, ...snap2.docs].forEach(addDoc);
  } else {
    // Employee: ONLY tasks directly assigned to them
    const snap = await roleQuery("assigneeIds", "array-contains", employeeId).get();
    snap.docs.forEach(addDoc);
  }

  const updatedMs = (t) => t.updatedAt?.toMillis ? t.updatedAt.toMillis() : new Date(t.updatedAt || 0).getTime();
  tasks.sort((a, b) => updatedMs(b) - updatedMs(a));
  const hasMore = tasks.length > pageSize;
  tasks = tasks.slice(0, pageSize);
  const nextCursor = tasks.length ? updatedMs(tasks[tasks.length - 1]) : null;

  // ── Self-assigned tasks: approver visibility ──────────────────────────────
  // NO try/catch — let errors surface so we can see what's failing
  const selfAssignSnap = await db.collection("cowork_tasks")
    .where("approverId", "==", employeeId)
    .get();
  console.log(`[listTasks] approverId query for ${employeeId}: ${selfAssignSnap.size} results`);
  for (const d of selfAssignSnap.docs) {
    const data = d.data();
    console.log(`  → found: ${data.taskId} "${data.title}" approverId=${data.approverId}`);
    addDoc(d);
    const subtaskIds = data.subtaskIds || [];
    if (subtaskIds.length) {
      const subDocs = await Promise.all(subtaskIds.map(id => db.collection("cowork_tasks").doc(id).get()));
      subDocs.filter(s => s.exists).forEach(addDoc);
    }
  }

  const visibleSnap = await db.collection("cowork_tasks")
    .where("visibleTo", "array-contains", employeeId)
    .get();
  console.log(`[listTasks] visibleTo query for ${employeeId}: ${visibleSnap.size} results`);
  for (const d of visibleSnap.docs) {
    addDoc(d);
    const subtaskIds = d.data().subtaskIds || [];
    if (subtaskIds.length) {
      const subDocs = await Promise.all(subtaskIds.map(id => db.collection("cowork_tasks").doc(id).get()));
      subDocs.filter(s => s.exists).forEach(addDoc);
    }
  }

  // ── Walk UP (for TL only) ─────────────────────────────────────────────────
  // TL needs parent context to show hierarchy correctly.
  // CEO does not need walkUp — they see their own root tasks directly.
  // Employees must NOT walkUp — they should not see parent tasks they weren't assigned.
  const walkUp = async (parentId) => {
    if (!parentId || seen.has(parentId)) return;
    const doc = await db.collection("cowork_tasks").doc(parentId).get();
    if (!doc.exists) return;
    addDoc(doc);
    const parentData = doc.data();
    if (parentData.parentTaskId) await walkUp(parentData.parentTaskId);
  };

  // ── Walk DOWN ─────────────────────────────────────────────────────────────
  // CEO sees ALL subtasks under their root tasks — including self-assigned ones by employees.
  const walkDownForCeo = async (taskData) => {
    const ids = taskData.subtaskIds || [];
    if (!ids.length) return;
    const unseen = ids.filter(id => !seen.has(id));
    if (!unseen.length) return;
    const docs = await Promise.all(unseen.map(id => db.collection("cowork_tasks").doc(id).get()));
    for (const doc of docs) {
      if (!doc.exists) continue;
      addDoc(doc);
      await walkDownForCeo(doc.data());
    }
  };

  const walkDownForAll = async (taskData) => {
    const ids = taskData.subtaskIds || [];
    if (!ids.length) return;
    const unseen = ids.filter(id => !seen.has(id));
    if (!unseen.length) return;
    const docs = await Promise.all(unseen.map(id => db.collection("cowork_tasks").doc(id).get()));
    for (const doc of docs) {
      if (!doc.exists) continue;
      addDoc(doc);
      await walkDownForAll(doc.data());
    }
  };

  // Snapshot of initial tasks before walks (walks will grow the array)
  const initialTasks = [...tasks];

  if (role === "ceo") {
    // CEO: full walkDown on all their tasks — see all subtasks including self-assigned ones
    await Promise.all(initialTasks.map(t => walkDownForAll(t)));
  } else if (role === "tl") {
    // TL: full walkUp + full walkDown
    await Promise.all([
      ...initialTasks.map(t => walkUp(t.parentTaskId)),
      ...initialTasks.map(t => walkDownForAll(t)),
    ]);
  }
  // Employee: no walks — they only see exactly what was assigned to them

  const mappedTasks = tasks.map(t => ({
    ...t,
    taskId: t.taskId || t.id,
    isFolder: t.isFolder || false,
    isRepeat: t.isRepeat || false,
    isThirdParty: t.isThirdParty || false,
    isGoal: t.isGoal || false,
    hasTimer: t.hasTimer !== false,
    fixedDeadline: t.fixedDeadline || null,
    deadlineStatus: deadlineStatus(t.dueDate),
    deadlineColor: deadlineColor(t.dueDate),
    createdAt: t.createdAt?.toDate?.()?.toISOString() || t.createdAt,
    updatedAt: t.updatedAt?.toDate?.()?.toISOString() || t.updatedAt,
  })).sort((a, b) => {
    const order = { overdue: 0, near: 1, safe: 2, none: 3 };
    return (order[a.deadlineStatus] ?? 3) - (order[b.deadlineStatus] ?? 3);
  });

  return { tasks: mappedTasks, nextCursor, hasMore };
}

// ═════════════════════════════════════════════════════════
//  10. EDIT DEADLINE (CEO only, reason required)
// ═════════════════════════════════════════════════════════
async function editTaskDeadline({ taskId, newDueDate, reason, editedBy, editedByName }) {
  if (!reason?.trim()) throw new Error("Reason is required when changing deadline.");
  const ref = db.collection("cowork_tasks").doc(taskId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Task not found.");
  const task = doc.data();

  await ref.update({
    dueDate: newDueDate || null,
    deadlineStatus: deadlineStatus(newDueDate),
    deadlineColor: deadlineColor(newDueDate),
    deadlineHistory: admin.firestore.FieldValue.arrayUnion({
      oldDueDate: task.dueDate, newDueDate: newDueDate || null,
      reason: reason.trim(), editedBy, editedByName,
      editedAt: new Date().toISOString(),
    }),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Post system chat message
  await sendTaskChat({
    taskId, senderId: editedBy, senderName: editedByName,
    text: `📅 Deadline changed to ${newDueDate ? new Date(newDueDate).toLocaleDateString("en-IN") : "None"}\n📝 Reason: ${reason.trim()}`,
    messageType: "system",
  });

  await _notifyMany({
    recipientIds: (task.assigneeIds || []).filter(id => id !== editedBy),
    type: "deadline_changed",
    title: `⏰ Deadline Changed · ${task.title}`,
    body: `${reason.trim()}`,
    data: { taskId, taskTitle: task.title },
    senderId: editedBy,
    senderName: editedByName,
  });

  return { success: true };
}

// ═════════════════════════════════════════════════════════
//  11. DELETE TASK (CEO only — recursively deletes children)
// ═════════════════════════════════════════════════════════
async function deleteTask({ taskId, deletedBy }) {
  const doc = await db.collection("cowork_tasks").doc(taskId).get();
  if (!doc.exists) throw new Error("Task not found.");
  const task = doc.data();

  // Recursively delete all subtasks first
  async function deleteRecursive(id) {
    const d = await db.collection("cowork_tasks").doc(id).get();
    if (!d.exists) return;
    const t = d.data();
    if (t.subtaskIds?.length) {
      for (const sid of t.subtaskIds) await deleteRecursive(sid);
    }
    // Delete chat subcollection
    const chatSnap = await db.collection("cowork_tasks").doc(id).collection("chat").get();
    if (!chatSnap.empty) {
      const batch = db.batch();
      chatSnap.docs.forEach(cd => batch.delete(cd.ref));
      await batch.commit();
    }
    // Delete daily reports subcollection
    const reportsSnap = await db.collection("cowork_tasks").doc(id).collection("dailyReports").get();
    if (!reportsSnap.empty) {
      const batch = db.batch();
      reportsSnap.docs.forEach(rd => batch.delete(rd.ref));
      await batch.commit();
    }
    await db.collection("cowork_tasks").doc(id).delete();
  }

  await deleteRecursive(taskId);

  // Remove from parent's subtaskIds
  if (task.parentTaskId) {
    await db.collection("cowork_tasks").doc(task.parentTaskId).update({
      subtaskIds: admin.firestore.FieldValue.arrayRemove(taskId),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  socket.emitToMany(task.assigneeIds || [], "task_deleted", { taskId, title: task.title });

  // Notify all assignees that the task was deleted
  if (task.assigneeIds?.length) {
    await _notifyMany({
      recipientIds: task.assigneeIds,
      type: "task_deleted",
      title: `🗑️ Task Deleted · ${task.title}`,
      body: `The task "${task.title}" has been permanently deleted by the admin.`,
      data: { taskId, taskTitle: task.title },
      senderId: deletedBy,
      senderName: deletedBy,
    });
  }

  return { success: true, taskId };
}

// ═════════════════════════════════════════════════════════
//  HELPER: determine review flow for a task
//  Returns: "tl_then_ceo" | "ceo_direct" | "tl_final"
// ═════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════
//  _reviewFlow — async, queries Firestore if needed for old tasks
//  Returns: "tl_then_ceo" | "ceo_direct" | "tl_final"
// ═════════════════════════════════════════════════════════
async function _reviewFlow(task) {
  // ── Fast path: use stored fields (new tasks have all these) ──────────────
  const rootRole = task.rootCreatedByRole || task.assignedByRole;

  if (rootRole === "tl") return "tl_final";

  if (rootRole === "ceo") {
    if (!task.parentTaskId && !task.forwardedBy) return "ceo_direct";
    return "tl_then_ceo";
  }

  // Legacy flags (old tasks may have these)
  if (task.createdByTl === true) return "tl_final";
  if (task.createdByCeo === true && !task.forwardedBy) return "ceo_direct";
  if (task.createdByCeo === true && task.forwardedBy) return "tl_then_ceo";

  // ── Fallback: query Firestore for old tasks without stored flow fields ────
  // For old tasks, just check the IMMEDIATE assignedBy's role.
  // forwardTask already passes rootCreatedByRole explicitly, so those tasks
  // never reach this fallback. Only directly-created tasks land here.
  if (task.assignedBy) {
    try {
      const empDoc = await db.collection("cowork_employees").doc(task.assignedBy).get();
      if (empDoc.exists) {
        const assignerRole = empDoc.data().role;

        // Self-heal: write back so next call is instant (no DB hit)
        const updateId = task.taskId || task.id;
        if (updateId) {
          await db.collection("cowork_tasks").doc(updateId).update({
            rootCreatedByRole: assignerRole,
            assignedByRole: assignerRole,
            createdByTl: assignerRole === "tl",
            createdByCeo: assignerRole === "ceo",
          }).catch(() => { });
        }

        if (assignerRole === "tl") return "tl_final";
        if (assignerRole === "ceo") {
          return task.parentTaskId ? "tl_then_ceo" : "ceo_direct";
        }
      }
    } catch (e) {
      console.warn("[_reviewFlow] Fallback query failed:", e.message);
    }
  }

  return "tl_then_ceo"; // safe default
}

// ═════════════════════════════════════════════════════════
//  12. SUBMIT COMPLETION REQUEST (employee)
// ═════════════════════════════════════════════════════════
async function submitCompletionRequest({ taskId, employeeId, employeeName, message, imageUrls = [], pdfAttachments = [] }) {
  const ref = db.collection("cowork_tasks").doc(taskId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Task not found.");
  const task = doc.data();
  if (!task.assigneeIds?.includes(employeeId)) throw new Error("Not assigned to this task.");
  if (["tl_approved", "ceo_approved", "tl_final_approved"].includes(task.completionStatus)) throw new Error("Already approved.");

  const flow = await _reviewFlow(task);
  const submission = { submittedBy: employeeId, submittedByName: employeeName, message, imageUrls, pdfAttachments, submittedAt: new Date().toISOString() };

  await ref.update({ completionStatus: "submitted", completionSubmission: submission, reviewFlow: flow, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

  const attachments = [
    ...imageUrls.map(url => ({ type: "image", url, name: "Proof" })),
    ...pdfAttachments.map(p => ({ type: "pdf", url: p.url || p, name: p.name || "Document", embedUrl: p.embedUrl, downloadUrl: p.downloadUrl })),
  ];

  await sendTaskChat({
    taskId, senderId: employeeId, senderName: employeeName,
    text: `✅ ${employeeName} submitted work for completion review.\n${message}`,
    attachments,
    messageType: imageUrls.length > 0 ? "image" : pdfAttachments.length > 0 ? "pdf" : "text",
  });

  // Notify the right reviewer(s) based on flow
  let notifyIds = [];
  if (flow === "tl_final" || flow === "tl_then_ceo") {
    // Notify TL (assignedBy or originalAssignedBy who is TL)
    notifyIds = [task.assignedBy, task.originalAssignedBy].filter(id => id && id !== employeeId);
  } else if (flow === "ceo_direct") {
    // Notify CEO directly
    const ceoSnap = await db.collection("cowork_employees").where("role", "==", "ceo").limit(1).get();
    notifyIds = ceoSnap.docs.map(d => d.data().employeeId).filter(Boolean);
  }

  await _notifyMany({
    recipientIds: [...new Set(notifyIds)],
    type: "completion_submitted",
    title: `📤 Work Submitted · ${task.title}`,
    body: `${employeeName} submitted for review`,
    data: { taskId, taskTitle: task.title },
    senderId: employeeId,
    senderName: employeeName,
  });
  socket.emitToMany([...new Set(notifyIds)], "task_completion_submitted", { taskId, submission });
  return { success: true, taskId, completionStatus: "submitted", reviewFlow: flow };
}

// ═════════════════════════════════════════════════════════
//  13. TL / INTERMEDIATE REVIEW
//  Handles: tl_then_ceo (TL approves → awaits CEO)
//           tl_final    (TL approves → task complete)
//           ceo_direct  (CEO is reviewing directly → task complete)
// ═════════════════════════════════════════════════════════
async function reviewCompletion({ taskId, reviewerId, reviewerName, approved, rejectionReason }) {
  const ref = db.collection("cowork_tasks").doc(taskId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Task not found.");
  const task = doc.data();
  if (task.completionStatus !== "submitted") throw new Error("No pending submission.");

  const flow = task.reviewFlow || await _reviewFlow(task);
  const submitterId = task.completionSubmission?.submittedBy;

  if (approved) {
    const tlReview = { reviewedBy: reviewerId, reviewedByName: reviewerName, approved: true, reviewedAt: new Date().toISOString() };

    if (flow === "tl_final") {
      // ── TL is the final approver — task complete ──────────────────────────
      await ref.update({
        completionStatus: "tl_final_approved", status: "done", progressPercent: 100,
        tlReview, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await sendTaskChat({ taskId, senderId: reviewerId, senderName: reviewerName, text: `🎉 ${reviewerName} approved! Task "${task.title}" is complete.`, messageType: "system" });

      const allIds = [...new Set([...(task.assigneeIds || []), task.assignedBy, submitterId].filter(id => id && id !== reviewerId))];
      await _notifyMany({ recipientIds: allIds, type: "completion_ceo_approved", title: `✅ Complete: ${task.title}`, body: `${reviewerName} approved. Task is done!`, data: { taskId, taskTitle: task.title }, senderId: reviewerId, senderName: reviewerName });
      socket.emitToMany(allIds, "task_completed", { taskId });
      if (task.parentTaskId) await _syncParentProgress(task.parentTaskId);

    } else if (flow === "ceo_direct") {
      // ── CEO reviewing directly (no TL in chain) — task complete ──────────
      await ref.update({
        completionStatus: "ceo_approved", status: "done", progressPercent: 100,
        ceoReview: { reviewedBy: reviewerId, reviewedByName: reviewerName, approved: true, reviewedAt: new Date().toISOString() },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await sendTaskChat({ taskId, senderId: reviewerId, senderName: reviewerName, text: `🎉 CEO approved! Task "${task.title}" is complete.`, messageType: "system" });

      const allIds = [...new Set([...(task.assigneeIds || []), submitterId].filter(id => id && id !== reviewerId))];
      await _notifyMany({ recipientIds: allIds, type: "completion_ceo_approved", title: `✅ Complete: ${task.title}`, body: "CEO approved. Task is done!", data: { taskId, taskTitle: task.title }, senderId: reviewerId, senderName: reviewerName });
      socket.emitToMany(allIds, "task_completed", { taskId });
      if (task.parentTaskId) await _syncParentProgress(task.parentTaskId);

    } else {
      // ── tl_then_ceo: TL approves → forward to CEO ────────────────────────
      await ref.update({ completionStatus: "tl_approved", tlReview, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      await sendTaskChat({ taskId, senderId: reviewerId, senderName: reviewerName, text: `✅ TL ${reviewerName} approved. Forwarding to CEO for final review.`, messageType: "system" });

      const ceoSnap = await db.collection("cowork_employees").where("role", "==", "ceo").limit(1).get();
      const ceoIds = ceoSnap.docs.map(d => d.data().employeeId).filter(Boolean);
      if (ceoIds.length) {
        await _notifyMany({ recipientIds: ceoIds, type: "completion_tl_approved", title: `✅ TL Approved · ${task.title}`, body: `${reviewerName} approved. Your review needed.`, data: { taskId, taskTitle: task.title }, senderId: reviewerId, senderName: reviewerName });
        socket.emitToMany(ceoIds, "task_completion_tl_approved", { taskId, tlReview });
      }
      if (submitterId && submitterId !== reviewerId) {
        await _notifyMany({ recipientIds: [submitterId], type: "completion_tl_approved", title: `✅ TL Approved · ${task.title}`, body: `${reviewerName} approved. CEO review pending.`, data: { taskId, taskTitle: task.title }, senderId: reviewerId, senderName: reviewerName });
      }
    }

  } else {
    // ── Rejected (all flows) — back to in_progress ────────────────────────
    if (!rejectionReason?.trim()) throw new Error("Rejection reason required.");
    const tlReview = { reviewedBy: reviewerId, reviewedByName: reviewerName, approved: false, rejectionReason: rejectionReason.trim(), reviewedAt: new Date().toISOString() };
    await ref.update({ completionStatus: "tl_rejected", tlReview, status: "in_progress", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    await sendTaskChat({ taskId, senderId: reviewerId, senderName: reviewerName, text: `❌ ${reviewerName} rejected.\n📝 Reason: ${rejectionReason.trim()}`, messageType: "system" });

    if (submitterId) {
      await _notifyMany({ recipientIds: [submitterId], type: "completion_rejected", title: `❌ Work Rejected · ${task.title}`, body: `Reason: ${rejectionReason.trim()}`, data: { taskId, taskTitle: task.title, reason: rejectionReason.trim() }, senderId: reviewerId, senderName: reviewerName });
      socket.emitToMany([submitterId], "task_completion_rejected", { taskId, tlReview });
    }
  }

  // ── C1 Score calculation ──────────────────────────────────────────────────
  const c1FinalStatus = approved
    ? (flow === "tl_final" ? "tl_final_approved" : flow === "ceo_direct" ? "ceo_approved" : "tl_approved")
    : "tl_rejected";
  const isFullyApproved = ["tl_final_approved", "ceo_approved"].includes(c1FinalStatus);
  const isRejected = c1FinalStatus === "tl_rejected";

  // ── C1 score — fires on full approval OR rejection ────────────────────
  if (isFullyApproved || isRejected) {
    const submittedAt = task.completionSubmission?.submittedAt || null;
    const primaryEmployee = (task.assigneeIds || [])[0] || null;
    setImmediate(() => {
      c1Svc.computeAndStoreTaskScore({
        taskId,
        taskData: task,
        employeeId: primaryEmployee,
        isRejected,
        submittedAt,
      }).catch(e => console.error("[C1 score on review]", e.message));
    });
  }
  // ─────────────────────────────────────────────────────────────────────

  // ── C2 score write — fires when gold task fully approved ─────────────
  if (isFullyApproved && task.isGoldTask) {
    const primaryEmployee = (task.assigneeIds || [])[0] || null;
    setImmediate(async () => {
      try {
        const pmpSvc = require("./pmpService");
        await pmpSvc.writeC2ScoreOnComplete({
          taskId,
          task,
          employeeId: primaryEmployee,
        });
      } catch (e) {
        console.error("[C2 score on complete]", e.message);
      }
    });
  }
  // ─────────────────────────────────────────────────────────────────────

  const finalStatus = approved
    ? (flow === "tl_final" ? "tl_final_approved" : flow === "ceo_direct" ? "ceo_approved" : "tl_approved")
    : "tl_rejected";
  return { success: true, taskId, approved, completionStatus: finalStatus, reviewFlow: flow };
}


// ═════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════
//  C1 REWORK — TL sends task back for rework (-0.2 per occurrence)
// ═════════════════════════════════════════════════════════
async function reworkTask({ taskId, reviewerId, reviewerName, reworkReason, waiveDeduction = false }) {
  const ref = db.collection("cowork_tasks").doc(taskId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Task not found.");
  const task = doc.data();
  if (task.completionStatus !== "submitted") throw new Error("Task has not been submitted yet.");

  const currentReworks = Number(task.c1?.reworksReceived) || 0;

  await ref.update({
    completionStatus: null,
    status: "in_progress",
    "c1.reworksReceived": currentReworks + 1,
    reworkHistory: admin.firestore.FieldValue.arrayUnion({
      reworkNumber: currentReworks + 1,
      reason: reworkReason || "",
      sentBackBy: reviewerId,
      sentBackByName: reviewerName,
      sentBackAt: new Date().toISOString(),
    }),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await sendTaskChat({
    taskId, senderId: reviewerId, senderName: reviewerName,
    text: `🔄 ${reviewerName} sent this task back for rework (rework #${currentReworks + 1}).\n📝 Reason: ${reworkReason || "No reason given"}`,
    messageType: "system",
  });

  const submitterId = task.completionSubmission?.submittedBy;
  if (submitterId) {
    await _notifyMany({
      recipientIds: [submitterId],
      type: "task_rework",
      title: `🔄 Rework Required · ${task.title}`,
      body: `Reason: ${reworkReason || "Check task for details"}`,
      data: { taskId, taskTitle: task.title, reason: reworkReason },
      senderId: reviewerId, senderName: reviewerName,
    });
  }

  // ── Write -0.2 deduction to SOP history (only if not waived) ────────────
  const primaryEmployee = (task.assigneeIds || [])[0] || null;
  if (primaryEmployee && !waiveDeduction) {
    setImmediate(() => {
      c1Svc.writeReworkDeduction({
        employeeId: primaryEmployee,
        taskId,
        taskTitle: task.title || taskId,
        reviewerId,
        reviewerName,
        reworkNumber: currentReworks + 1,
      }).catch(e => console.error("[rework bleach]", e.message));
    });
  }

  return { success: true, taskId, reworkNumber: currentReworks + 1 };
}

// ═════════════════════════════════════════════════════════
//  14. CEO FINAL REVIEW (only for tl_then_ceo flow)
//  Called after TL has already approved (completionStatus === "tl_approved")
// ═════════════════════════════════════════════════════════
async function ceoReviewCompletion({ taskId, reviewerId, reviewerName, approved, rejectionReason }) {
  const ref = db.collection("cowork_tasks").doc(taskId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Task not found.");
  const task = doc.data();

  const flow = task.reviewFlow || await _reviewFlow(task);

  // Only valid for tl_then_ceo flow
  if (flow === "tl_final") throw new Error("This task only requires TL approval — CEO review not needed.");
  if (flow === "ceo_direct") throw new Error("This task is handled via reviewCompletion — use that endpoint.");
  if (task.completionStatus !== "tl_approved") throw new Error("Must be TL-approved first.");

  if (approved) {
    await ref.update({
      completionStatus: "ceo_approved", status: "done", progressPercent: 100,
      ceoReview: { reviewedBy: reviewerId, reviewedByName: reviewerName, approved: true, reviewedAt: new Date().toISOString() },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await sendTaskChat({ taskId, senderId: reviewerId, senderName: reviewerName, text: `🎉 CEO approved! Task "${task.title}" is complete.`, messageType: "system" });
    const allIds = [...new Set([...(task.assigneeIds || []), task.assignedBy, task.completionSubmission?.submittedBy].filter(id => id && id !== reviewerId))];
    await _notifyMany({ recipientIds: allIds, type: "completion_ceo_approved", title: `✅ Complete: ${task.title}`, body: "CEO approved. Task is done!", data: { taskId, taskTitle: task.title }, senderId: reviewerId, senderName: reviewerName });
    socket.emitToMany(allIds, "task_completed", { taskId });
    if (task.parentTaskId) await _syncParentProgress(task.parentTaskId);
  } else {
    if (!rejectionReason?.trim()) throw new Error("Rejection reason required.");
    await ref.update({
      completionStatus: "ceo_rejected", status: "in_progress",
      ceoReview: { reviewedBy: reviewerId, reviewedByName: reviewerName, approved: false, rejectionReason: rejectionReason.trim(), reviewedAt: new Date().toISOString() },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await sendTaskChat({ taskId, senderId: reviewerId, senderName: reviewerName, text: `❌ CEO rejected.\n📝 Reason: ${rejectionReason.trim()}\nTask is back to pending.`, messageType: "system" });
    const allIds = [...new Set([...(task.assigneeIds || []), task.completionSubmission?.submittedBy].filter(id => id && id !== reviewerId))];
    await _notifyMany({ recipientIds: allIds, type: "completion_ceo_rejected", title: `❌ Rejected: ${task.title}`, body: `CEO: ${rejectionReason.trim()}`, data: { taskId, taskTitle: task.title, reason: rejectionReason.trim() }, senderId: reviewerId, senderName: reviewerName });
    socket.emitToMany(allIds, "task_completion_rejected", { taskId });
  }
  // ── C1 score on CEO final review ─────────────────────────────────────
  if (approved) {
    const primaryEmployee = (task.assigneeIds || [])[0] || null;
    setImmediate(() => {
      c1Svc.computeAndStoreTaskScore({
        taskId,
        taskData: task,
        employeeId: primaryEmployee,
        isRejected: false,
        submittedAt: task.completionSubmission?.submittedAt || null,
      }).catch(e => console.error("[C1 score on CEO review]", e.message));
    });
  }
  // ─────────────────────────────────────────────────────────────────────
  return { success: true, taskId, approved, completionStatus: approved ? "ceo_approved" : "ceo_rejected" };
}

// ═════════════════════════════════════════════════════════
//  15. UPDATE PARENT TASK PROGRESS (TL pushes to CEO)
// ═════════════════════════════════════════════════════════
async function updateParentTaskProgress({ parentTaskId, updatedBy, updatedByName, note }) {
  await _syncParentProgress(parentTaskId);
  if (note) {
    await sendTaskChat({ taskId: parentTaskId, senderId: updatedBy, senderName: updatedByName, text: `📊 Progress update from TL: ${note}`, messageType: "system" });
  }
  return { success: true };
}

// ═════════════════════════════════════════════════════════
//  DEADLINE PROPOSAL — employee proposes, creator approves
// ═════════════════════════════════════════════════════════
async function proposeDeadline({ taskId, employeeId, employeeName, proposedDate, workedSecs = 0 }) {
  const ref = db.collection("cowork_tasks").doc(taskId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Task not found.");
  const task = doc.data();
  if (!task.assigneeIds?.includes(employeeId)) throw new Error("Not assigned to this task.");
  if (!["open", "deadline_rejected", "in_progress", "confirmed", "deadline_approved"].includes(task.status))
    throw new Error("Cannot propose a deadline change in current status.");
  if (!proposedDate) throw new Error("Proposed date is required.");

  // ──────────────────────────────────────────────────────────────────────────
  // Extension vs first-time proposal:
  //
  //   • FIRST proposal (from "open" / "deadline_rejected" — no approved deadline
  //     exists yet): the typed duration IS the whole window.
  //        deadlineWindowSecs = extensionSecs
  //
  //   • EXTENSION (task already running or confirmed — already has an approved
  //     window): the typed duration is ADDITIONAL work time on top of what the
  //     employee already has. Keeps a clean audit trail of every bump so
  //     everyone (employee + CEO/TL) sees the same breakdown:
  //          30m (original) + 20m (ext 1) + 10m (ext 2) = 60m total
  //
  //     Math is ADDITIVE — no `max(existing, worked)` black magic, no wall-
  //     clock subtraction at approval time that silently overwrites everything.
  // ──────────────────────────────────────────────────────────────────────────
  const isExtension = ["in_progress", "confirmed"].includes(task.status);

  // How many seconds the employee is asking for (extension magnitude for
  // extensions; total window for first-time proposals). Derived from "now"
  // because the frontend computes proposedDate as `now + typedDuration`.
  const extensionSecs = Math.max(0, Math.floor((new Date(proposedDate).getTime() - Date.now()) / 1000));

  const existingWindowSecs = task.deadlineWindowSecs || 0;
  const deadlineWindowSecs = isExtension
    ? existingWindowSecs + extensionSecs
    : extensionSecs;

  const updates = {
    proposedDeadline: proposedDate,
    proposedDeadlineBy: employeeId,
    proposedDeadlineByName: employeeName,
    proposedDeadlineAt: admin.firestore.FieldValue.serverTimestamp(),
    deadlineWindowSecs,           // asked-for TOTAL after this request
    // ── Snapshot the CURRENT approved window so the rejection path can
    // roll it back. Without this, a rejected extension leaves deadlineWindowSecs
    // permanently inflated (e.g. rejected +1h 60m shows "2h 5m asked" forever).
    deadlineWindowSecsBeforeProposal: existingWindowSecs,
    prevStatusBeforeDeadlineProposal: task.status,
    status: "pending_deadline_approval",
    deadlineProposalRejected: false,
    deadlineRejectionReason: null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  // Extension-specific bookkeeping — let approval path know this is an extension
  // and what to record in the audit trail once approved.
  if (isExtension) {
    const prevWindowSecs = Number(task.deadlineWindowSecs) || 0;
    const newWindowSecs = prevWindowSecs + extensionSecs;
    updates.pendingExtensionSecs = extensionSecs;          // just the delta
    updates.pendingExtensionPrevWindowSecs = existingWindowSecs; // window before this bump
  } else {
    // First proposal: clear any stale extension markers from rejected past rounds.
    updates.pendingExtensionSecs = null;
    updates.pendingExtensionPrevWindowSecs = null;
  }

  await ref.update(updates);

  // If task was in_progress, notify the employee their timer should stop
  // (frontend blocks the timer when status = pending_deadline_approval)
  if (task.status === "in_progress") {
    socket.emitToMany(task.assigneeIds || [], "timer_blocked", {
      taskId,
      taskTitle: task.title,
      reason: "Deadline extension pending approval — timer paused until approved",
    });
  }

  // Post system message in draft chat.
  // For EXTENSIONS we show "+Xm extension — new total Ym" so CEO/TL and employee
  // see the same audit breakdown. First-time proposals still say "Xm to complete".
  const chatText = isExtension
    ? `📅 ${employeeName} requested +${_fmtSecs(extensionSecs)} extension — new total ${_fmtSecs(deadlineWindowSecs)} (was ${_fmtSecs(existingWindowSecs)})`
    : `📅 ${employeeName} proposed deadline: ${_fmtSecs(extensionSecs)} to complete`;
  await sendDraftChat({
    taskId,
    senderId: employeeId,
    senderName: employeeName,
    text: chatText,
    messageType: "system",
  });

  // Notify the task creator
  const notifyIds = [task.assignedBy, task.originalAssignedBy].filter(id => id && id !== employeeId);
  await _notifyMany({
    recipientIds: [...new Set(notifyIds)],
    type: "deadline_proposed",
    title: `📅 Deadline Proposed · ${task.title}`,
    body: `${employeeName} proposed a deadline for "${task.title}"`,
    data: { taskId, taskTitle: task.title, proposedDate },
    senderId: employeeId,
    senderName: employeeName,
  });
  socket.emitToMany([...new Set(notifyIds)], "deadline_proposed", { taskId, employeeId, proposedDate });
  return { success: true };
}

async function approveDeadline({ taskId, approverId, approverName, approved, rejectionReason }) {
  const ref = db.collection("cowork_tasks").doc(taskId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Task not found.");
  const task = doc.data();

  // Only the creator can approve/reject
  if (task.assignedBy !== approverId) throw new Error("Only the task creator can approve or reject the deadline.");
  if (task.status !== "pending_deadline_approval") throw new Error("No pending deadline proposal.");

  // Determine what status to restore after approval
  // Only restore to in_progress or confirmed — everything else (open, etc.) → deadline_approved
  const prev = task.prevStatusBeforeDeadlineProposal;
  const prevStatus = ["in_progress", "confirmed"].includes(prev) ? prev : "deadline_approved";

  if (approved) {
    const newDueDate = task.proposedDeadline;

    // ── Trust the window that was stored at proposal time ──────────────────
    // Do NOT recompute from wall-clock (newDueDate − now) — that throws away
    // the accumulated extension math and creates the "time mismatch" where
    // the employee sees one number and the CEO/TL sees another.
    //
    // proposeDeadline already stored the correct TOTAL window on the task
    // (first-time: typed duration; extension: existing + delta). We just
    // carry it forward.
    //
    // For extensions, also append an audit entry to `extensions[]` so the
    // UI can render the breakdown "30 + 20 + 10 = 60".
    const wasExtension = typeof task.pendingExtensionSecs === "number" && task.pendingExtensionSecs > 0;
    const approvedWindowSecs = Number(task.deadlineWindowSecs) || 0;

    const update = {
      status: prevStatus,
      dueDate: newDueDate,
      deadlineWindowSecs: approvedWindowSecs,
      deadlineApprovedBy: approverId,
      deadlineApprovedByName: approverName,
      deadlineApprovedAt: admin.firestore.FieldValue.serverTimestamp(),
      deadlineProposalRejected: false,
      deadlineRejectionReason: null,
      deadlineStatus: deadlineStatus(newDueDate),
      deadlineColor: deadlineColor(newDueDate),
      // Clear pending extension markers now that the proposal is resolved.
      pendingExtensionSecs: null,
      pendingExtensionPrevWindowSecs: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // First-time approval: record the original window so the UI can render
    // the breakdown as "30 + 20 + 10" even after many extensions.
    if (!wasExtension && !task.originalWindowSecs) {
      update.originalWindowSecs = approvedWindowSecs;
    }

    // Extension approval: append to audit trail.
    if (wasExtension) {
      update.extensions = admin.firestore.FieldValue.arrayUnion({
        addedSecs: Number(task.pendingExtensionSecs) || 0,
        prevWindowSecs: Number(task.pendingExtensionPrevWindowSecs) || 0,
        newWindowSecs: approvedWindowSecs,
        approvedBy: approverId,
        approvedByName: approverName,
        approvedAt: new Date().toISOString(),  // arrayUnion can't accept serverTimestamp
      });

      // ── Wait for employee to press Start Timer ────────────────────────
      // The new deadline is NOT computed from approval time. It's
      // (startTime + extensionSecs), set by the frontend on the employee's
      // first Start click. Until then:
      //   - awaitingExtensionStart=true tells the UI to show a green
      //     "Press Start Timer" card instead of the stale overdue pill.
      //   - lastExtensionSecs tells the frontend how much budget to grant.
      //   - dueDate is intentionally left stale (points to old deadline);
      //     frontend overwrites it on Start.
      update.awaitingExtensionStart = true;
      update.lastExtensionSecs = Number(task.pendingExtensionSecs) || 0;
    }

    await ref.update(update);

    // Approval chat message — show the right phrasing for extensions.
    // For extensions we add a nudge about the new Start-Timer flow so the
    // employee knows the +N min starts when they press Start, not now.
    const approveChatText = wasExtension
      ? `✅ ${approverName} approved +${_fmtSecs(task.pendingExtensionSecs)} extension. Press ▶ Start when ready — your +${_fmtSecs(task.pendingExtensionSecs)} begins then.`
      : `✅ ${approverName} approved the deadline: ${_fmtSecs(approvedWindowSecs)} to complete. You can now confirm the task.`;
    await sendDraftChat({
      taskId,
      senderId: approverId,
      senderName: approverName,
      text: approveChatText,
      messageType: "system",
    });

    // Notify assignees
    await _notifyMany({
      recipientIds: task.assigneeIds || [],
      type: "deadline_approved",
      title: `✅ Deadline Approved · ${task.title}`,
      body: `Your proposed deadline was approved. Please confirm the task.`,
      data: { taskId, taskTitle: task.title },
      senderId: approverId,
      senderName: approverName,
    });
    socket.emitToMany(task.assigneeIds || [], "deadline_approved", { taskId, dueDate: newDueDate });
  } else {
    if (!rejectionReason?.trim()) throw new Error("Rejection reason is required.");
    // ── Roll deadlineWindowSecs back to what it was before this proposal ──
    // proposeDeadline wrote the new proposed total into deadlineWindowSecs so
    // TL/CEO could see "X asked". On rejection that value must be reverted —
    // otherwise a rejected +1h extension permanently shows "2h 5m asked" and
    // the DeadlineBreakdown math breaks (original + approved extensions ≠ total).
    const rolledBackWindowSecs = Number(task.deadlineWindowSecsBeforeProposal) > 0
      ? Number(task.deadlineWindowSecsBeforeProposal)
      : (Number(task.originalWindowSecs) || 0) +
      ((task.extensions || []).reduce((s, e) => s + (Number(e.addedSecs) || 0), 0));
    await ref.update({
      status: "open",
      deadlineWindowSecs: rolledBackWindowSecs,
      deadlineWindowSecsBeforeProposal: null,   // clear the snapshot
      deadlineProposalRejected: true,
      deadlineRejectionReason: rejectionReason.trim(),
      proposedDeadline: null,
      proposedDeadlineBy: null,
      proposedDeadlineAt: null,
      // Clear pending extension markers too — they're stale now
      pendingExtensionSecs: null,
      pendingExtensionPrevWindowSecs: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });


    await sendDraftChat({
      taskId,
      senderId: approverId,
      senderName: approverName,
      text: `❌ ${approverName} rejected the deadline. Reason: "${rejectionReason.trim()}". Please propose a new deadline.`,
      messageType: "system",
    });

    await _notifyMany({
      recipientIds: task.assigneeIds || [],
      type: "deadline_rejected",
      title: `❌ Deadline Rejected · ${task.title}`,
      body: `Reason: ${rejectionReason.trim()}`,
      data: { taskId, taskTitle: task.title },
      senderId: approverId,
      senderName: approverName,
    });
    socket.emitToMany(task.assigneeIds || [], "deadline_rejected", { taskId, reason: rejectionReason.trim() });
  }
  return { success: true };
}

// ── TL/CEO counter-proposes a deadline to employee ────────────────────────────
// Called when TL doesn't accept employee's date but wants to suggest their own
async function tlCounterProposeDeadline({ taskId, proposerId, proposerName, counterDate, counterWindowSecs, message }) {
  const ref = db.collection("cowork_tasks").doc(taskId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Task not found.");
  const task = doc.data();

  if (task.assignedBy !== proposerId) throw new Error("Only the task creator can counter-propose a deadline.");
  if (task.status !== "pending_deadline_approval") throw new Error("No pending deadline proposal to counter.");
  if (!counterDate) throw new Error("Counter-propose date is required.");

  // If frontend passed the typed duration, use it — otherwise derive from date.
  // This mirrors proposeDeadline: for extensions we want the raw typed duration
  // preserved so we can add it to the existing window at accept time.
  const typedSecs = Number(counterWindowSecs) > 0
    ? Number(counterWindowSecs)
    : Math.max(0, Math.floor((new Date(counterDate).getTime() - Date.now()) / 1000));

  // Extension context: was the original proposal being countered an extension?
  // (i.e. employee was running/confirmed when they made the proposal the TL is
  // now countering). If so, the counter's typed duration ADDS to the existing
  // window — same accumulator rules as proposeDeadline.
  const wasExtensionContext = ["in_progress", "confirmed"].includes(task.prevStatusBeforeDeadlineProposal);
  const existingWindowForCounter = wasExtensionContext
    ? (Number(task.pendingExtensionPrevWindowSecs) || 0)  // window BEFORE the employee's proposal
    : 0;

  await ref.update({
    status: "pending_employee_deadline_confirmation",
    tlCounterDeadline: counterDate,
    tlCounterDeadlineMessage: message?.trim() || "",
    tlCounterDeadlineBy: proposerId,
    tlCounterDeadlineByName: proposerName,
    tlCounterDeadlineAt: admin.firestore.FieldValue.serverTimestamp(),
    // Store the TL's typed duration + extension context so the accept path
    // can reconstruct the right total without re-deriving from wall-clock.
    tlCounterTypedSecs: typedSecs,
    tlCounterIsExtension: wasExtensionContext,
    tlCounterPrevWindowSecs: existingWindowForCounter,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Counter chat + notification wording: show the typed duration with "+X min
  // extension" shape when applicable so everyone sees the same audit info.
  const counterMsg = wasExtensionContext
    ? `📅 ${proposerName} suggested +${_fmtSecs(typedSecs)} extension instead — new total ${_fmtSecs(existingWindowForCounter + typedSecs)}${message ? ` — "${message.trim()}"` : ""}`
    : `📅 ${proposerName} suggested a new deadline: ${_fmtSecs(typedSecs)} to complete${message ? ` — "${message.trim()}"` : ""}`;
  await sendDraftChat({
    taskId, senderId: proposerId, senderName: proposerName,
    text: counterMsg,
    messageType: "system",
  });

  await _notifyMany({
    recipientIds: task.assigneeIds || [],
    type: "deadline_counter_proposed",
    title: `📅 New Deadline Suggested · ${task.title}`,
    body: wasExtensionContext
      ? `${proposerName} suggested +${_fmtSecs(typedSecs)} extension`
      : `${proposerName} suggested ${_fmtSecs(typedSecs)} to complete`,
    data: { taskId, taskTitle: task.title, counterDate },
    senderId: proposerId, senderName: proposerName,
  });
  socket.emitToMany(task.assigneeIds || [], "deadline_counter_proposed", { taskId, counterDate, message: message?.trim() || "" });
  return { success: true };
}

// ── Employee responds to TL's counter-proposal ────────────────────────────────
async function employeeRespondToTlCounter({ taskId, employeeId, employeeName, accepted, rejectMessage }) {
  const ref = db.collection("cowork_tasks").doc(taskId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Task not found.");
  const task = doc.data();

  if (!task.assigneeIds?.includes(employeeId)) throw new Error("Not assigned to this task.");
  if (task.status !== "pending_employee_deadline_confirmation") throw new Error("No TL counter-proposal pending.");

  if (accepted) {
    const newDueDate = task.tlCounterDeadline;

    // Build the approved window from STORED values — not wall-clock.
    // If this was an extension context: new total = prev window + TL's typed secs.
    // If it was a first-time proposal: new total = TL's typed secs.
    const typedSecs = Number(task.tlCounterTypedSecs) || 0;
    const isExt = !!task.tlCounterIsExtension;
    const prevWin = Number(task.tlCounterPrevWindowSecs) || 0;
    const approvedWindowSecs = isExt ? (prevWin + typedSecs) : typedSecs;

    const update = {
      status: "deadline_approved",
      dueDate: newDueDate,
      deadlineWindowSecs: approvedWindowSecs,
      deadlineApprovedBy: task.tlCounterDeadlineBy,
      deadlineApprovedByName: task.tlCounterDeadlineByName,
      deadlineApprovedAt: admin.firestore.FieldValue.serverTimestamp(),
      tlCounterDeadline: null,
      tlCounterDeadlineMessage: null,
      tlCounterTypedSecs: null,
      tlCounterIsExtension: null,
      tlCounterPrevWindowSecs: null,
      // Clear pending employee-side extension markers too (they're moot now).
      pendingExtensionSecs: null,
      pendingExtensionPrevWindowSecs: null,
      deadlineStatus: deadlineStatus(newDueDate),
      deadlineColor: deadlineColor(newDueDate),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      deadlineWindowSecsBeforeProposal: null,
    };

    // First-time: record original window. Extension: append audit entry.
    if (!isExt && !task.originalWindowSecs) {
      update.originalWindowSecs = approvedWindowSecs;
    }
    if (isExt) {
      update.extensions = admin.firestore.FieldValue.arrayUnion({
        addedSecs: typedSecs,
        prevWindowSecs: prevWin,
        newWindowSecs: approvedWindowSecs,
        approvedBy: task.tlCounterDeadlineBy,
        approvedByName: task.tlCounterDeadlineByName,
        approvedAt: new Date().toISOString(),
        viaCounter: true,
      });

      // ── Same Start-Timer wait as direct approval path ─────────────────
      // See approveDeadline above for the full rationale. The dueDate is
      // left stale; the frontend computes (startTime + extensionSecs) when
      // the employee presses Start.
      update.awaitingExtensionStart = true;
      update.lastExtensionSecs = typedSecs;
    }

    await ref.update(update);

    const acceptChat = isExt
      ? `✅ ${employeeName} accepted +${_fmtSecs(typedSecs)} extension. Press ▶ Start when ready — your +${_fmtSecs(typedSecs)} begins then.`
      : `✅ ${employeeName} accepted the deadline: ${_fmtSecs(approvedWindowSecs)} to complete`;
    await sendDraftChat({
      taskId, senderId: employeeId, senderName: employeeName,
      text: acceptChat,
      messageType: "system",
    });

    socket.emitToMany([task.assignedBy], "deadline_accepted", { taskId, dueDate: newDueDate });
    await _notifyMany({
      recipientIds: [task.assignedBy],
      type: "deadline_accepted",
      title: `✅ Deadline Accepted · ${task.title}`,
      body: `${employeeName} accepted your suggested deadline.`,
      data: { taskId, taskTitle: task.title },
      senderId: employeeId, senderName: employeeName,
    });
  } else {
    // Employee rejects TL counter → go back to open so employee can re-propose
    await ref.update({
      status: "open",
      tlCounterDeadline: null,
      tlCounterDeadlineMessage: null,
      deadlineProposalRejected: false,
      proposedDeadline: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await sendDraftChat({
      taskId, senderId: employeeId, senderName: employeeName,
      text: `❌ ${employeeName} rejected the suggested deadline${rejectMessage ? `: "${rejectMessage.trim()}"` : ""}. Please propose a new deadline.`,
      messageType: "system",
    });

    socket.emitToMany([task.assignedBy], "deadline_counter_rejected", { taskId, reason: rejectMessage?.trim() || "" });
    await _notifyMany({
      recipientIds: [task.assignedBy],
      type: "deadline_counter_rejected",
      title: `❌ Deadline Counter Rejected · ${task.title}`,
      body: `${employeeName} rejected your suggested deadline${rejectMessage ? `: ${rejectMessage.trim()}` : ""}.`,
      data: { taskId, taskTitle: task.title },
      senderId: employeeId, senderName: employeeName,
    });
  }
  return { success: true };
}


async function sendDraftChat({ taskId, senderId, senderName, text, attachments = [], messageType = "text" }) {
  const { v4: _uuidv4 } = require("uuid");
  const messageId = _uuidv4();
  const isoTime = new Date().toISOString();
  const msg = {
    messageId, taskId, senderId, senderName,
    text: text || "", attachments, messageType,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await db.collection("cowork_tasks").doc(taskId).collection("draft_chat").doc(messageId).set(msg);
  await db.collection("cowork_tasks").doc(taskId).update({
    draftChatMessageCount: admin.firestore.FieldValue.increment(1),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  // Get all participants for socket
  const taskDoc = await db.collection("cowork_tasks").doc(taskId).get();
  if (taskDoc.exists) {
    const t = taskDoc.data();
    const all = [...new Set([...(t.assigneeIds || []), t.assignedBy].filter(Boolean))];
    socket.emitToMany(all, "task_draft_chat_message", { taskId, message: { ...msg, createdAt: isoTime } });
  }
  return { ...msg, createdAt: isoTime };
}

async function getDraftChat(taskId, limit = 100) {
  const snap = await db.collection("cowork_tasks").doc(taskId).collection("draft_chat")
    .orderBy("createdAt", "asc").limitToLast(Number(limit)).get();
  return snap.docs.map(d => {
    const data = d.data();
    return { ...data, createdAt: data.createdAt?.toDate?.()?.toISOString() || data.createdAt };
  });
}

// ── P1 CONFLICT CHECK — called from frontend timer start ──────────────────────
async function checkAndExtendForP1({ newP1TaskId, employeeId, assignedBy, assignedByName, newP1Priority, reason, oldPriorities, newPriorities }) {
  try {
    const p1Snap = await db.collection("cowork_tasks").doc(newP1TaskId).get();
    if (!p1Snap.exists) return null;
    const p1Task = p1Snap.data();

    const newPriority = (newP1Priority != null) ? Number(newP1Priority) : (Number(p1Task.priority) || 99);
    console.log("[P1-SVC] p1Task:", { priority: p1Task.priority, fixedDeadline: p1Task.fixedDeadline, dueDate: p1Task.dueDate, title: p1Task.title });

    const p1DeadlineStr = p1Task.fixedDeadline || p1Task.dueDate || null;
    let p1RemainingMs;
    if (p1DeadlineStr) {
      p1RemainingMs = Math.max(0, new Date(p1DeadlineStr).getTime() - Date.now());
    } else if (p1Task.hasTimer !== false) {
      // Use whichever time budget exists — approved window, sender preset, or ETC estimate
      const p1WindowSecs = Number(p1Task.deadlineWindowSecs)
        || Number(p1Task.senderTimerWindowSecs)
        || (Number(p1Task.etcHours) * 3600)
        || 0;
      if (p1WindowSecs > 0) {
        try {
          const p1TimerSnap = await db.collection("cowork_task_timers")
            .doc(employeeId).collection("sessions").doc(newP1TaskId).get();
          let p1WorkedSecs = 0;
          if (p1TimerSnap.exists) {
            const td = p1TimerSnap.data();
            const base = Number(td.totalSeconds) || 0;
            const elapsed = (td.isActive && td.lastStartTime)
              ? Math.floor((Date.now() - Number(td.lastStartTime)) / 1000) : 0;
            p1WorkedSecs = base + elapsed;
          }
          p1RemainingMs = Math.max(0, (p1WindowSecs - p1WorkedSecs) * 1000);
          console.log(`[P1-SVC] p1 timer task window=${p1WindowSecs}s worked=${p1WorkedSecs}s remaining=${p1RemainingMs}ms`);
        } catch (e) {
          console.warn("[P1-SVC] could not read p1 timer session:", e.message);
          p1RemainingMs = p1WindowSecs * 1000;
        }
      } else {
        console.log("[P1-SVC] no deadline or timer window on p1 task → return null"); return null;
      }
    } else {
      console.log("[P1-SVC] no deadline or timer window on p1 task → return null"); return null;
    }
    if (p1RemainingMs <= 0) { console.log("[P1-SVC] p1 already expired → return null"); return null; }

    const p1RemainingHrs = p1RemainingMs / 3600000;
    const fmtHrs = h => h >= 1 ? `${Math.round(h * 10) / 10}h` : `${Math.round(h * 60)}m`;
    const now = new Date().toISOString();

    // ── DELTA CORRECTION: store the estimated P1 finish time at cascade-fire moment ──
    // When P1 first-play fires later, it compares actual dueDate vs this estimate.
    // The difference (delta) is then added to all lower-priority tasks' deadlines.
    const _cascadeEstimatedDueDateMs = Date.now() + p1RemainingMs;
    const _cascadeEstimatedDueDateISO = new Date(_cascadeEstimatedDueDateMs).toISOString();
    try {
      await db.collection("cowork_tasks").doc(newP1TaskId).update({
        cascadeEstimatedDueDate: _cascadeEstimatedDueDateISO,
        cascadeEstimatedAtMs: _cascadeEstimatedDueDateMs,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.warn("[P1-SVC] could not write cascadeEstimatedDueDate:", e.message);
    }

    const empTasksSnap = await db.collection("cowork_tasks")
      .where("assigneeIds", "array-contains", employeeId)
      .get();
    console.log("[P1-SVC] employee tasks scanned:", empTasksSnap.size);

    const extendedResults = [];

    // ── PHASE 1: collect + filter qualifying tasks ────────────────────────
    const qualifyingTasks = [];
    for (const doc of empTasksSnap.docs) {
      if (doc.id === newP1TaskId) continue;
      const conflictTask = doc.data();

      const TERMINAL_STATUSES = ["done", "cancelled", "tl_final_approved", "ceo_approved"];
      if (TERMINAL_STATUSES.includes(conflictTask.status)) {
        console.log(`[P1-SVC] skip ${doc.id} (${conflictTask.title}) — terminal status: ${conflictTask.status}`);
        continue;
      }

      // Use frontend-supplied new priority when available — avoids Firestore race condition
      // (priority swap write from executeDrop may not have committed when this fires at 500ms)
      const conflictPriority = (newPriorities && newPriorities[doc.id] != null)
        ? Number(newPriorities[doc.id])
        : (Number(conflictTask.priority) || 99);
      if (newPriority >= conflictPriority) {
        console.log(`[P1-SVC] skip ${doc.id} (${conflictTask.title}) — not lower priority: new=${newPriority} conflict=${conflictPriority}`);
        continue;
      }

      const conflictDeadlineStr = conflictTask.fixedDeadline || conflictTask.dueDate || null;
      const conflictWindowSecs = Number(conflictTask.deadlineWindowSecs)
        || Number(conflictTask.senderTimerWindowSecs)
        || (Number(conflictTask.etcHours) * 3600)
        || 0;
      const isTimerConflict = !conflictDeadlineStr
        && conflictTask.hasTimer !== false
        && conflictWindowSecs > 0;

      if (!conflictDeadlineStr && !isTimerConflict) {
        console.log(`[P1-SVC] skip ${doc.id} (${conflictTask.title}) — no deadline or timer window`);
        continue;
      }

      const _history = conflictTask.deadlineAutoExtendedHistory || [];
      const _alreadyFired = _history.find(h =>
        h.shiftedByTaskId === newP1TaskId &&
        (Date.now() - new Date(h.at).getTime()) < 2 * 60 * 1000
      );
      if (_alreadyFired) {
        console.log(`[P1-SVC] skip ${doc.id} (${conflictTask.title}) — dedup, already extended in last 2min`);
        continue;
      }

      // Read actual worked time from Firestore timer session
      let workedSecs = 0;
      try {
        const timerSnap = await db.collection("cowork_task_timers")
          .doc(employeeId).collection("sessions").doc(doc.id).get();
        if (timerSnap.exists) {
          const td = timerSnap.data();
          const base = Number(td.totalSeconds) || 0;
          const elapsed = (td.isActive && td.lastStartTime)
            ? Math.floor((Date.now() - Number(td.lastStartTime)) / 1000) : 0;
          workedSecs = base + elapsed;
          console.log(`[P1-SVC] timer for ${doc.id}: base=${base}s elapsed=${elapsed}s total=${workedSecs}s`);
        }
      } catch (e) {
        console.warn(`[P1-SVC] could not read timer for ${doc.id}:`, e.message);
      }

      const taskOldPriority = (oldPriorities && oldPriorities[doc.id] != null) ? Number(oldPriorities[doc.id]) : conflictPriority;

      qualifyingTasks.push({
        doc, conflictTask, conflictPriority, conflictDeadlineStr,
        conflictWindowSecs, isTimerConflict, workedSecs, taskOldPriority,
      });
    }


    qualifyingTasks.sort((a, b) => a.conflictPriority - b.conflictPriority);
    let cumulativeWaitMs = p1RemainingMs;
    for (const qt of qualifyingTasks) {
      const { doc, conflictTask, conflictPriority, conflictDeadlineStr,
        conflictWindowSecs, isTimerConflict, workedSecs, taskOldPriority } = qt;

      const cumulativeWaitSecs = Math.round(cumulativeWaitMs / 1000);
      const cumulativeWaitHrs = cumulativeWaitMs / 3600000;
      let oldDeadline, newDeadline, updatePayload;

      if (isTimerConflict) {
        const oldWindowSecs = conflictWindowSecs;
        const newWindowSecs = Math.max(oldWindowSecs, oldWindowSecs + cumulativeWaitSecs - workedSecs);
        oldDeadline = `${(oldWindowSecs / 3600).toFixed(2)}h budget`;
        newDeadline = `${(newWindowSecs / 3600).toFixed(2)}h budget`;
        console.log(`[P1-SVC] EXTENDING timer task ${doc.id} (${conflictTask.title}): cumulative=${cumulativeWaitSecs}s → ${oldWindowSecs}s → ${newWindowSecs}s`);
        updatePayload = {
          deadlineWindowSecs: newWindowSecs,
          autoExtendedDueToP1: true,
          cascadeAssumedP1FinishMs: _cascadeEstimatedDueDateMs,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          deadlineAutoExtendedHistory: admin.firestore.FieldValue.arrayUnion({
            extendedByHrs: cumulativeWaitHrs,
            workedHrsAtExtension: +(workedSecs / 3600).toFixed(2),
            netExtendedHrs: +((cumulativeWaitSecs - workedSecs) / 3600).toFixed(2),
            oldWindowSecs,
            newWindowSecs,
            shiftedByTaskId: newP1TaskId,
            shiftedByTaskTitle: p1Task.title,
            oldDeadline,
            newDeadline,
            at: now,
            trigger: "p1_conflict_check",
            reason: reason || null,
            changedByName: assignedByName || null,
            acknowledgedByEmployee: false,
            oldPriority: taskOldPriority,
            newPriority: conflictPriority,
          }),
        };
        cumulativeWaitMs += Math.max(0, (oldWindowSecs - workedSecs) * 1000);
      } else {
        oldDeadline = conflictDeadlineStr;
        // P2 new due = moment P1 finishes + P2's remaining unworked time
        // cumulativeWaitMs = time until P1 (and all tasks above P2) finish
        // workedSecs = work P2 already did — subtract so employee gets credit
        const _p1FinishMs = Date.now() + cumulativeWaitMs;
        const _p2RemainingMs = Math.max(0, (conflictWindowSecs - workedSecs) * 1000);
        const _computedMs = _p1FinishMs + _p2RemainingMs;
        // Never push deadline BEFORE the old one (safety floor)
        const finalMs = Math.max(_computedMs, new Date(oldDeadline).getTime());
        newDeadline = new Date(finalMs).toISOString();
        const deadlineField = conflictTask.fixedDeadline ? "fixedDeadline" : "dueDate";
        console.log(`[P1-SVC] EXTENDING deadline task ${doc.id} (${conflictTask.title}): cumulative=${cumulativeWaitMs}ms → ${oldDeadline} → ${newDeadline}`);
        updatePayload = {
          [deadlineField]: newDeadline,
          autoExtendedDueToP1: true,
          cascadeAssumedP1FinishMs: _cascadeEstimatedDueDateMs,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          deadlineAutoExtendedHistory: admin.firestore.FieldValue.arrayUnion({
            extendedByHrs: cumulativeWaitHrs,
            shiftedByTaskId: newP1TaskId,
            shiftedByTaskTitle: p1Task.title,
            oldDeadline,
            newDeadline,
            at: now,
            trigger: "p1_conflict_check",
            reason: reason || null,
            changedByName: assignedByName || null,
            acknowledgedByEmployee: false,
            oldPriority: taskOldPriority,
            newPriority: conflictPriority,
          }),
        };
        // Accumulator for next task = P2's remaining unworked time
        // (already computed above as _p2RemainingMs)
        cumulativeWaitMs += _p2RemainingMs;
      }

      await doc.ref.update(updatePayload);

      extendedResults.push({
        conflictTaskId: doc.id,
        conflictTaskTitle: conflictTask.title,
        oldDeadline,
        newDeadline,
        extendedByHrs: cumulativeWaitHrs,
        oldPriority: taskOldPriority,
        newPriority: conflictPriority,
      });
    }

    if (!extendedResults.length) { console.log("[P1-conflict] no tasks needed extension"); return null; }

    const empSnap = await db.collection("cowork_employees").doc(employeeId).get();
    const empName = empSnap.exists ? (empSnap.data().name || employeeId) : employeeId;

    const titleList = extendedResults.map(r => r.conflictTaskTitle).join(", ");
    await _notifyMany({
      recipientIds: [assignedBy || p1Task.assignedBy].filter(Boolean),
      type: "deadline_auto_extended",
      title: `Deadline Auto-Extended - ${extendedResults.length} task${extendedResults.length > 1 ? "s" : ""}`,
      body: `${titleList} shifted +${fmtHrs(p1RemainingHrs)} because ${empName} started higher-priority task "${p1Task.title}".`,
      data: { extendedTaskIds: extendedResults.map(r => r.conflictTaskId), shiftedByTaskId: newP1TaskId, employeeId, employeeName: empName },
      senderId: "system",
      senderName: "CoWork",
    });

    console.log(`[P1-conflict] ${extendedResults.length} task(s) extended +${fmtHrs(p1RemainingHrs)} for ${empName}: ${titleList}`);
    return { extendedTasks: extendedResults, count: extendedResults.length };
  } catch (e) {
    console.error("[checkAndExtendForP1]", e.message);
    return null;
  }
}

module.exports = {
  createTask,
  createParentTask: createTask,
  confirmTaskReceipt,
  markTaskStarted,
  forwardTask,
  submitDailyReport,
  sendTaskChat,
  getTaskChat,
  getTaskWithDetails,
  getTaskDailyReports,
  listTasksWithHierarchy,
  editTaskDeadline,
  deleteTask,
  submitCompletionRequest,
  reviewCompletion,
  reworkTask,
  ceoReviewCompletion,
  updateParentTaskProgress,
  deadlineStatus,
  deadlineColor,
  proposeDeadline,
  approveDeadline,
  tlCounterProposeDeadline,
  employeeRespondToTlCounter,
  sendDraftChat,
  getDraftChat,
  checkAndExtendForP1,
};

