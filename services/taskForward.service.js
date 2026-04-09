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
async function _notifyMany({ recipientIds, type, title, body, data }) {
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
  try {
    const snaps = await Promise.all(recipientIds.map(id => db.collection("cowork_employees").doc(id).get()));
    const tokens = snaps.filter(s => s.exists).flatMap(s => s.data().fcmTokens || []);
    if (tokens.length) {
      await messaging.sendEachForMulticast({
        notification: { title, body },
        data: Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v)])),
        tokens,
      });
    }
  } catch (e) { /* FCM non-critical */ }
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
async function createTask({ title, description, notes, assignedBy, assignedByName, assigneeIds, dueDate, priority = "medium", parentTaskId = null }) {
  const taskId = await _generateTaskId();
  const now = new Date().toISOString();
  const path = await _buildPath(parentTaskId);

  const task = {
    taskId,
    title: title.trim(),
    description: description || "",
    notes: notes || "",
    assignedBy,
    assignedByName: assignedByName || "",
    assigneeIds: assigneeIds || [],
    dueDate: dueDate || null,
    priority,
    deadlineStatus: deadlineStatus(dueDate),
    deadlineColor: deadlineColor(dueDate),
    progressPercent: 0,
    status: "open",
    // Hierarchy
    parentTaskId: parentTaskId || null,
    isRoot: !parentTaskId,          // true only for top-level tasks
    depth: path.length,              // 0 = root, 1 = subtask, 2 = sub-subtask, ...
    path,                            // breadcrumb: [{taskId, title}, ...]
    subtaskIds: [],
    // Workflow
    confirmedBy: [],
    forwardedBy: null,
    forwardedByName: null,
    originalAssignedBy: assignedBy,
    // Reports & thread (in subcollections, not embedded)
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
      data: { taskId, parentTaskId: parentTaskId || "" },
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

  await ref.update({
    confirmedBy: admin.firestore.FieldValue.arrayUnion(employeeId),
    status: "confirmed",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const notifyIds = [task.assignedBy, task.originalAssignedBy].filter(id => id && id !== employeeId);
  await _notifyMany({ recipientIds: [...new Set(notifyIds)], type: "task_confirmed", title: `${employeeName} confirmed: ${task.title}`, body: `${employeeName} acknowledged task "${task.title}"`, data: { taskId } });
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
  await _notifyMany({ recipientIds: [...new Set(notifyIds)], type: "task_started", title: `${employeeName} started: ${task.title}`, body: `Work has begun on "${task.title}"`, data: { taskId } });
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
      assigneeIds: [assignment.employeeId],
      dueDate: assignment.dueDate || parent.dueDate || null,
      priority: assignment.priority || parent.priority || "medium",
      parentTaskId,
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
    data: { taskId },
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
  const allDone = subtasks.every(s => s.status === "done");

  await db.collection("cowork_tasks").doc(parentTaskId).update({
    progressPercent: avg,
    status: allDone ? "done" : avg > 0 ? "in_progress" : parent.status,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

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
        data: { taskId },
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
  // CEO    : sees ONLY tasks they personally created (assignedBy === CEO).
  //          TL-created tasks (even under CEO root tasks) are NOT shown to CEO.
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
    // CEO: ONLY tasks the CEO personally created (assignedBy === CEO)
    // Do NOT pull tasks where CEO is an assignee — CEO does not get assigned tasks by TL
    const snap = await db.collection("cowork_tasks")
      .where("assignedBy", "==", employeeId)
      .get();
    snap.docs.forEach(addDoc);

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
    data: { taskId },
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
  return { success: true, taskId };
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
  if (["tl_approved", "ceo_approved"].includes(task.completionStatus)) throw new Error("Already approved.");

  const submission = { submittedBy: employeeId, submittedByName: employeeName, message, imageUrls, pdfAttachments, submittedAt: new Date().toISOString() };

  await ref.update({ completionStatus: "submitted", completionSubmission: submission, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

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

  const notifyIds = [task.assignedBy, task.originalAssignedBy].filter(id => id && id !== employeeId);
  await _notifyMany({ recipientIds: [...new Set(notifyIds)], type: "completion_submitted", title: `Work submitted: ${task.title}`, body: `${employeeName} submitted for review`, data: { taskId } });
  socket.emitToMany([...new Set(notifyIds)], "task_completion_submitted", { taskId, submission });
  return { success: true, taskId, completionStatus: "submitted" };
}

// ═════════════════════════════════════════════════════════
//  13. TL REVIEWS COMPLETION
// ═════════════════════════════════════════════════════════
async function reviewCompletion({ taskId, reviewerId, reviewerName, approved, rejectionReason }) {
  const ref = db.collection("cowork_tasks").doc(taskId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Task not found.");
  const task = doc.data();
  if (task.completionStatus !== "submitted") throw new Error("No pending submission.");

  if (approved) {
    const tlReview = { reviewedBy: reviewerId, reviewedByName: reviewerName, approved: true, reviewedAt: new Date().toISOString() };
    await ref.update({ completionStatus: "tl_approved", tlReview, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    await sendTaskChat({ taskId, senderId: reviewerId, senderName: reviewerName, text: `✅ TL ${reviewerName} approved. Forwarding to CEO for final review.`, messageType: "system" });

    const ceoSnap = await db.collection("cowork_employees").where("role", "==", "ceo").limit(1).get();
    const ceoIds = ceoSnap.docs.map(d => d.data().employeeId).filter(Boolean);
    if (ceoIds.length) {
      await _notifyMany({ recipientIds: ceoIds, type: "completion_tl_approved", title: `TL approved: ${task.title}`, body: `${reviewerName} approved. Your review needed.`, data: { taskId } });
      socket.emitToMany(ceoIds, "task_completion_tl_approved", { taskId, tlReview });
    }
    const submitterId = task.completionSubmission?.submittedBy;
    if (submitterId && submitterId !== reviewerId) {
      await _notifyMany({ recipientIds: [submitterId], type: "completion_tl_approved", title: `Work approved by TL: ${task.title}`, body: `${reviewerName} approved. CEO review pending.`, data: { taskId } });
    }
  } else {
    if (!rejectionReason?.trim()) throw new Error("Rejection reason required.");
    const tlReview = { reviewedBy: reviewerId, reviewedByName: reviewerName, approved: false, rejectionReason: rejectionReason.trim(), reviewedAt: new Date().toISOString() };
    await ref.update({ completionStatus: "tl_rejected", tlReview, status: "in_progress", updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    await sendTaskChat({ taskId, senderId: reviewerId, senderName: reviewerName, text: `❌ TL ${reviewerName} rejected.\n📝 Reason: ${rejectionReason.trim()}`, messageType: "system" });

    const submitterId = task.completionSubmission?.submittedBy;
    if (submitterId) {
      await _notifyMany({ recipientIds: [submitterId], type: "completion_rejected", title: `Work rejected: ${task.title}`, body: `Reason: ${rejectionReason.trim()}`, data: { taskId } });
      socket.emitToMany([submitterId], "task_completion_rejected", { taskId, tlReview });
    }
  }

  return { success: true, taskId, approved, completionStatus: approved ? "tl_approved" : "tl_rejected" };
}

// ═════════════════════════════════════════════════════════
//  14. CEO FINAL REVIEW
// ═════════════════════════════════════════════════════════
async function ceoReviewCompletion({ taskId, reviewerId, reviewerName, approved, rejectionReason }) {
  const ref = db.collection("cowork_tasks").doc(taskId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Task not found.");
  const task = doc.data();
  if (task.completionStatus !== "tl_approved") throw new Error("Must be TL-approved first.");

  if (approved) {
    await ref.update({
      completionStatus: "ceo_approved", status: "done", progressPercent: 100,
      ceoReview: { reviewedBy: reviewerId, reviewedByName: reviewerName, approved: true, reviewedAt: new Date().toISOString() },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await sendTaskChat({ taskId, senderId: reviewerId, senderName: reviewerName, text: `🎉 CEO approved! Task "${task.title}" is complete.`, messageType: "system" });
    const allIds = [...new Set([...(task.assigneeIds || []), task.assignedBy, task.completionSubmission?.submittedBy].filter(id => id && id !== reviewerId))];
    await _notifyMany({ recipientIds: allIds, type: "completion_ceo_approved", title: `✅ Complete: ${task.title}`, body: "CEO approved. Task is done!", data: { taskId } });
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
    await _notifyMany({ recipientIds: allIds, type: "completion_ceo_rejected", title: `❌ Rejected: ${task.title}`, body: `CEO: ${rejectionReason.trim()}`, data: { taskId } });
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
};