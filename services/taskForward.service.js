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

// ─── Notify helper ────────────────────────────────────────
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

  // FCM push — always fires immediately, no cooldown
  try {
    const { sendPushToEmployees } = require("./fcmPush.service");
    await sendPushToEmployees(recipientIds, title, body, { type, ...(data || {}) });
  } catch (e) { console.error("[FCM taskForward]", e.message); }

  // Email — 20-min cooldown per sender→receiver pair
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
async function createTask({ title, description, notes, assignedBy, assignedByName, assignedByRole, assigneeIds, dueDate, priority = 5, parentTaskId = null, groupId = null, createdByTl = false, createdByCeo = false, rootCreatedByRole = null, isFolder = false }) {
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
    assignedBy,
    assignedByName: assignedByName || "",
    assignedByRole: assignedByRole || null,
    rootCreatedByRole: resolvedRootRole,
    assigneeIds: assigneeIds || [],
    dueDate: dueDate || null,
    priority,
    deadlineStatus: deadlineStatus(dueDate),
    deadlineColor: deadlineColor(dueDate),
    progressPercent: 0,
    status: "open",
    groupId: groupId || null,
    isFolder: isFolder || false,
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
    // Reports & thread
    dailyReportCount: 0,
    chatMessageCount: 0,
    // Completion
    completionStatus: null,
    completionSubmission: null,
    tlReview: null,
    ceoReview: null,
    deadlineHistory: [],
    // Meta
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAtISO: now,
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
      title: parentTaskId ? `New subtask: ${title}` : `New task: ${title}`,
      body: notes?.slice(0, 80) || description?.slice(0, 80) || "You have been assigned a task.",
      data: { taskId, taskTitle: title, priority, dueDate, description, parentTaskId: parentTaskId || "" },
      senderId: assignedBy,
      senderName: assignedByName || assignedBy,
    });
    socket.emitToMany(assigneeIds, "new_task", {
      taskId, task: { ...task, createdAt: now }, title, assignedBy, parentTaskId,
    });
  }

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

  // If no dueDate exists yet (new flow), require deadline approval first
  if (!task.dueDate && task.status !== "deadline_approved") {
    if (task.status === "pending_deadline_approval") {
      throw new Error("Your deadline proposal is pending approval. Please wait.");
    }
    throw new Error("Please propose a deadline and get it approved before confirming.");
  }

  await ref.update({
    confirmedBy: admin.firestore.FieldValue.arrayUnion(employeeId),
    status: "confirmed",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const notifyIds = [task.assignedBy, task.originalAssignedBy].filter(id => id && id !== employeeId);
  await _notifyMany({ recipientIds: [...new Set(notifyIds)], type: "task_confirmed", title: `${employeeName} confirmed: ${task.title}`, body: `${employeeName} acknowledged task "${task.title}"`, data: { taskId, taskTitle: task.title }, senderId: employeeId, senderName: employeeName });
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
  await _notifyMany({ recipientIds: [...new Set(notifyIds)], type: "task_started", title: `${employeeName} started: ${task.title}`, body: `Work has begun on "${task.title}"`, data: { taskId, taskTitle: task.title }, senderId: employeeId, senderName: employeeName });
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
    const newTask = await createTask({
      title: assignment.title || parent.title,
      description: assignment.description || parent.description || "",
      notes: assignment.notes,
      assignedBy: forwardedBy,
      assignedByName: forwardedByName,
      assignedByRole: forwarderRole,
      assigneeIds: [assignment.employeeId],
      dueDate: assignment.dueDate || parent.dueDate || null,
      priority: assignment.priority || parent.priority || "medium",
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
    title: `Daily report: ${task.title}`,
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

  const allParticipants = [...new Set([
    ...(task.assigneeIds || []),
    task.assignedBy,
    task.originalAssignedBy,
    ...(task.confirmedBy || []),
  ])].filter(Boolean);

  const msgForSocket = { ...msg, createdAt: isoTime };
  // Socket room is TASK-SPECIFIC: "task_chat_T001", "task_chat_T002", etc.
  socket.emitToMany(allParticipants, "task_chat_message", { taskId, message: msgForSocket });

  if (messageType !== "system") {
    const notifyIds = allParticipants.filter(id => id !== senderId);
    if (notifyIds.length) {
      await _notifyMany({
        recipientIds: notifyIds,
        type: "task_chat",
        title: `${senderName} in ${task.title} (${taskId})`,
        body: (text || "📎 attachment").slice(0, 80),
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
async function listTasksWithHierarchy(employeeId, role) {
  // ── VISIBILITY RULES ──────────────────────────────────────────────────────
  // CEO    : sees tasks they created (assignedBy === CEO) + tasks assigned TO them by TL/others.
  //          TL-created subtasks under CEO's tasks are visible when CEO is an assignee.
  // TL     : sees tasks they created (assignedBy === TL) + tasks assigned to them.
  // Employee: sees ONLY tasks directly assigned to them (assigneeIds contains them).
  //           No walkUp — employees must not see parent tasks they weren't assigned to.
  // ─────────────────────────────────────────────────────────────────────────

  const seen = new Set();
  const tasks = [];

  const addDoc = (d) => {
    if (!seen.has(d.id)) {
      seen.add(d.id);
      tasks.push({ id: d.id, ...d.data() });
    }
  };

  if (role === "ceo") {
    // CEO: tasks they created (assignedBy === CEO) + tasks assigned TO them by TL/others
    const [snap1, snap2] = await Promise.all([
      db.collection("cowork_tasks").where("assignedBy", "==", employeeId).get(),
      db.collection("cowork_tasks").where("assigneeIds", "array-contains", employeeId).get(),
    ]);
    [...snap1.docs, ...snap2.docs].forEach(addDoc);

  } else if (role === "tl") {
    // TL: tasks they created + tasks assigned to them
    const [snap1, snap2] = await Promise.all([
      db.collection("cowork_tasks").where("assignedBy", "==", employeeId).get(),
      db.collection("cowork_tasks").where("assigneeIds", "array-contains", employeeId).get(),
    ]);
    [...snap1.docs, ...snap2.docs].forEach(addDoc);

  } else {
    // Employee: ONLY tasks directly assigned to them
    const snap = await db.collection("cowork_tasks")
      .where("assigneeIds", "array-contains", employeeId)
      .get();
    snap.docs.forEach(addDoc);
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
  // For CEO: only include subtasks the CEO personally created (createdByCeo true OR assignedBy === CEO).
  //          This prevents TL-created subtasks from leaking into CEO view.
  // For TL / Employee: include all subtasks they are connected to (already fetched above via assigneeIds).
  const walkDownForCeo = async (taskData) => {
    const ids = taskData.subtaskIds || [];
    if (!ids.length) return;
    const unseen = ids.filter(id => !seen.has(id));
    if (!unseen.length) return;
    const docs = await Promise.all(unseen.map(id => db.collection("cowork_tasks").doc(id).get()));
    for (const doc of docs) {
      if (!doc.exists) continue;
      const d = doc.data();
      // Only include subtask if CEO created it — block TL-created subtasks
      const isCeoCreated = d.createdByCeo === true
        || d.assignedBy === employeeId
        || d.assignedByRole === "ceo";
      if (isCeoCreated) {
        addDoc(doc);
        await walkDownForCeo(d);
      }
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
    // CEO: walkDown with CEO-only filter, NO walkUp
    await Promise.all(initialTasks.map(t => walkDownForCeo(t)));
  } else if (role === "tl") {
    // TL: full walkUp + full walkDown
    await Promise.all([
      ...initialTasks.map(t => walkUp(t.parentTaskId)),
      ...initialTasks.map(t => walkDownForAll(t)),
    ]);
  }
  // Employee: no walks — they only see exactly what was assigned to them

  return tasks.map(t => ({
    ...t,
    taskId: t.taskId || t.id,
    deadlineStatus: deadlineStatus(t.dueDate),
    deadlineColor: deadlineColor(t.dueDate),
    createdAt: t.createdAt?.toDate?.()?.toISOString() || t.createdAt,
    updatedAt: t.updatedAt?.toDate?.()?.toISOString() || t.updatedAt,
  })).sort((a, b) => {
    const order = { overdue: 0, near: 1, safe: 2, none: 3 };
    return (order[a.deadlineStatus] ?? 3) - (order[b.deadlineStatus] ?? 3);
  });
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
    title: `Deadline updated: ${task.title}`,
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
      title: `Task deleted: ${task.title}`,
      body: `The task "${task.title}" has been deleted.`,
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
    title: `Work submitted: ${task.title}`,
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
        await _notifyMany({ recipientIds: ceoIds, type: "completion_tl_approved", title: `TL approved: ${task.title}`, body: `${reviewerName} approved. Your review needed.`, data: { taskId, taskTitle: task.title }, senderId: reviewerId, senderName: reviewerName });
        socket.emitToMany(ceoIds, "task_completion_tl_approved", { taskId, tlReview });
      }
      if (submitterId && submitterId !== reviewerId) {
        await _notifyMany({ recipientIds: [submitterId], type: "completion_tl_approved", title: `Work approved by TL: ${task.title}`, body: `${reviewerName} approved. CEO review pending.`, data: { taskId, taskTitle: task.title }, senderId: reviewerId, senderName: reviewerName });
      }
    }

  } else {
    // ── Rejected (all flows) — back to in_progress ────────────────────────
    if (!rejectionReason?.trim()) throw new Error("Rejection reason required.");
    const tlReview = { reviewedBy: reviewerId, reviewedByName: reviewerName, approved: false, rejectionReason: rejectionReason.trim(), reviewedAt: new Date().toISOString() };
    await ref.update({ completionStatus: "tl_rejected", tlReview, status: "in_progress", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    await sendTaskChat({ taskId, senderId: reviewerId, senderName: reviewerName, text: `❌ ${reviewerName} rejected.\n📝 Reason: ${rejectionReason.trim()}`, messageType: "system" });

    if (submitterId) {
      await _notifyMany({ recipientIds: [submitterId], type: "completion_rejected", title: `Work rejected: ${task.title}`, body: `Reason: ${rejectionReason.trim()}`, data: { taskId, taskTitle: task.title, reason: rejectionReason.trim() }, senderId: reviewerId, senderName: reviewerName });
      socket.emitToMany([submitterId], "task_completion_rejected", { taskId, tlReview });
    }
  }

  const finalStatus = approved
    ? (flow === "tl_final" ? "tl_final_approved" : flow === "ceo_direct" ? "ceo_approved" : "tl_approved")
    : "tl_rejected";
  return { success: true, taskId, approved, completionStatus: finalStatus, reviewFlow: flow };
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

  // How many seconds THIS proposal adds (from now to new deadline)
  const extensionSecs = Math.max(0, Math.floor((new Date(proposedDate).getTime() - Date.now()) / 1000));

  // ACCUMULATE correctly:
  // First proposal: deadlineWindowSecs = time from now to deadline
  // Extension: base = max(existingWindowSecs, workedSecs) + new extension
  //   - workedSecs passed from frontend so we know actual work done
  //   - this handles old tasks where existingWindowSecs = 0
  const isExtension = ["in_progress", "confirmed"].includes(task.status);
  const existingWindowSecs = task.deadlineWindowSecs || 0;
  const workedSecsFromFrontend = workedSecs || 0;
  const deadlineWindowSecs = isExtension
    ? Math.max(existingWindowSecs, workedSecsFromFrontend) + extensionSecs
    : extensionSecs;

  await ref.update({
    proposedDeadline: proposedDate,
    proposedDeadlineBy: employeeId,
    proposedDeadlineByName: employeeName,
    proposedDeadlineAt: admin.firestore.FieldValue.serverTimestamp(),
    deadlineWindowSecs,  // how many seconds employee is asking for (e.g. 3h = 10800)
    prevStatusBeforeDeadlineProposal: task.status,
    status: "pending_deadline_approval",
    deadlineProposalRejected: false,
    deadlineRejectionReason: null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // If task was in_progress, notify the employee their timer should stop
  // (frontend blocks the timer when status = pending_deadline_approval)
  if (task.status === "in_progress") {
    socket.emitToMany(task.assigneeIds || [], "timer_blocked", {
      taskId,
      taskTitle: task.title,
      reason: "Deadline extension pending approval — timer paused until approved",
    });
  }

  // Post system message in draft chat
  await sendDraftChat({
    taskId,
    senderId: employeeId,
    senderName: employeeName,
    text: `📅 ${employeeName} proposed deadline: ${new Date(proposedDate).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}`,
    messageType: "system",
  });

  // Notify the task creator
  const notifyIds = [task.assignedBy, task.originalAssignedBy].filter(id => id && id !== employeeId);
  await _notifyMany({
    recipientIds: [...new Set(notifyIds)],
    type: "deadline_proposed",
    title: `Deadline proposed for: ${task.title}`,
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

    // Recalculate deadlineWindowSecs AT APPROVAL TIME (not proposal time).
    // "Asked for" = how long from NOW (approval moment) until deadline.
    // e.g. TL approves at 10:44 AM, deadline 11:14 AM → 30 min (correct)
    // vs old: proposed at 5:12 AM, deadline 11:14 AM → 6h 02m (wrong)
    const approvedWindowSecs = Math.max(0, Math.floor(
      (new Date(newDueDate).getTime() - Date.now()) / 1000
    ));

    await ref.update({
      status: prevStatus,
      dueDate: newDueDate,
      deadlineWindowSecs: approvedWindowSecs,  // ← fixed: recalculated at approval time
      deadlineApprovedBy: approverId,
      deadlineApprovedByName: approverName,
      deadlineApprovedAt: admin.firestore.FieldValue.serverTimestamp(),
      deadlineProposalRejected: false,
      deadlineRejectionReason: null,
      deadlineStatus: deadlineStatus(newDueDate),
      deadlineColor: deadlineColor(newDueDate),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await sendDraftChat({
      taskId,
      senderId: approverId,
      senderName: approverName,
      text: `✅ ${approverName} approved the deadline: ${new Date(newDueDate).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}. You can now confirm the task.`,
      messageType: "system",
    });

    // Notify assignees
    await _notifyMany({
      recipientIds: task.assigneeIds || [],
      type: "deadline_approved",
      title: `Deadline approved for: ${task.title}`,
      body: `Your proposed deadline was approved. Please confirm the task.`,
      data: { taskId, taskTitle: task.title },
      senderId: approverId,
      senderName: approverName,
    });
    socket.emitToMany(task.assigneeIds || [], "deadline_approved", { taskId, dueDate: newDueDate });
  } else {
    if (!rejectionReason?.trim()) throw new Error("Rejection reason is required.");
    await ref.update({
      status: "open",
      deadlineProposalRejected: true,
      deadlineRejectionReason: rejectionReason.trim(),
      proposedDeadline: null,
      proposedDeadlineBy: null,
      proposedDeadlineAt: null,
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
      title: `Deadline rejected for: ${task.title}`,
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
async function tlCounterProposeDeadline({ taskId, proposerId, proposerName, counterDate, message }) {
  const ref = db.collection("cowork_tasks").doc(taskId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Task not found.");
  const task = doc.data();

  if (task.assignedBy !== proposerId) throw new Error("Only the task creator can counter-propose a deadline.");
  if (task.status !== "pending_deadline_approval") throw new Error("No pending deadline proposal to counter.");
  if (!counterDate) throw new Error("Counter-propose date is required.");

  await ref.update({
    status: "pending_employee_deadline_confirmation",
    tlCounterDeadline: counterDate,
    tlCounterDeadlineMessage: message?.trim() || "",
    tlCounterDeadlineBy: proposerId,
    tlCounterDeadlineByName: proposerName,
    tlCounterDeadlineAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await sendDraftChat({
    taskId, senderId: proposerId, senderName: proposerName,
    text: `📅 ${proposerName} suggested a new deadline: ${new Date(counterDate).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}${message ? ` — "${message.trim()}"` : ""}`,
    messageType: "system",
  });

  await _notifyMany({
    recipientIds: task.assigneeIds || [],
    type: "deadline_counter_proposed",
    title: `New deadline suggested for: ${task.title}`,
    body: `${proposerName} suggested ${new Date(counterDate).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`,
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
    const approvedWindowSecs = Math.max(0, Math.floor(
      (new Date(newDueDate).getTime() - Date.now()) / 1000
    ));

    await ref.update({
      status: "deadline_approved",
      dueDate: newDueDate,
      deadlineWindowSecs: approvedWindowSecs,
      deadlineApprovedBy: task.tlCounterDeadlineBy,
      deadlineApprovedByName: task.tlCounterDeadlineByName,
      deadlineApprovedAt: admin.firestore.FieldValue.serverTimestamp(),
      tlCounterDeadline: null,
      tlCounterDeadlineMessage: null,
      deadlineStatus: deadlineStatus(newDueDate),
      deadlineColor: deadlineColor(newDueDate),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await sendDraftChat({
      taskId, senderId: employeeId, senderName: employeeName,
      text: `✅ ${employeeName} accepted the deadline: ${new Date(newDueDate).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}`,
      messageType: "system",
    });

    socket.emitToMany([task.assignedBy], "deadline_accepted", { taskId, dueDate: newDueDate });
    await _notifyMany({
      recipientIds: [task.assignedBy],
      type: "deadline_accepted",
      title: `Deadline accepted: ${task.title}`,
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
      title: `Deadline rejected: ${task.title}`,
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

module.exports = {
  createTask,
  createParentTask: createTask, // backward compat alias
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
};