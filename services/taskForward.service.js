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
const {
  computeWorkingDeadline,
  readMs: readInstantMs,
  rechainQueueFor,
  resolveAcceptanceAnchor,
} = require("./officeDeadline.service");
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

async function _snapToNextWorkingMoment(date) {
  const schedSnap = await db.collection("cowork_settings").doc("office").get();
  const schedule = schedSnap.exists ? schedSnap.data().schedule : null;
  if (!schedule) return date;

  const DAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const parseMins = t => { if (!t) return 0; const [h, m] = t.split(":").map(Number); return h * 60 + (m || 0); };

  let cursor = new Date(date);
  for (let i = 0; i < 8; i++) {
    const day = schedule[DAY_KEYS[cursor.getDay()]];
    if (day && !day.isOff) {
      const inMins = parseMins(day.inTime);
      const outMins = parseMins(day.outTime);
      const dayStart = new Date(cursor); dayStart.setHours(Math.floor(inMins / 60), inMins % 60, 0, 0);
      const dayEnd = new Date(cursor); dayEnd.setHours(Math.floor(outMins / 60), outMins % 60, 0, 0);

      if (cursor < dayStart) return dayStart;
      if (cursor <= dayEnd) return cursor;
    }
    cursor = new Date(cursor);
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(0, 0, 0, 0);
  }
  return date;
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
  /* One id for this event, carried into the push. The service worker tags a
     notification with it: without one, every notification of a type shared a
     tag and the browser REPLACED the previous one, so a second task assignment
     silently overwrote the first before it was read. */
  const eventId = uuidv4();
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
      sendPushToEmployees(recipientIds, richTitle, richBody, { type, ...(data || {}), notificationId: eventId })
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

/**
 * The rank a new task should carry so it lands at the BOTTOM of one person's
 * active queue.
 *
 * Two faults this replaces, both of which put new work in the middle of
 * somebody's list:
 *
 *  1. It counted open tasks and added one. A count collides the moment a queue
 *     has gaps — three active tasks ranked 5, 6, 7 count as 3, so the new task
 *     was stored at 4 and sorted ABOVE all of them. Gaps are normal: closing a
 *     task leaves one.
 *  2. The "open" test was `status not-in [done, cancelled]`, and legacy leaves
 *     `status` at "open" for an entire review cycle while `completionStatus`
 *     moves. Approved work was therefore counted as active.
 *
 * So: highest ACTIVE stored rank + 1, clamped to the 1..10 scale the rest of
 * the product uses. Nothing else is renumbered — a new task is one write, and
 * reshuffling a queue because somebody was given more work would move tasks a
 * manager had deliberately ordered.
 */
const _CLOSED_STATUS = new Set(["done", "cancelled"]);
const _CLOSED_REVIEW = new Set(["completed", "approved", "tl_approved", "ceo_approved"]);

async function nextActiveRankFor(db, employeeId) {
  // TWO reads, because Firestore cannot OR across fields — the same pairing
  // the frontend's #activeQueueOf uses. A cross-department task still at the
  // gate holds its person in `pendingAssigneeId` with EMPTY `assigneeIds`, so
  // the array-contains query alone cannot see it. That blindness is how two
  // tasks created minutes apart both stored rank 3: the second count ran while
  // the first task was still gated, saw the same queue, and picked the same
  // number. The comment below already states the rule — a gated task OCCUPIES
  // its slot — this makes the query able to see what the rule counts.
  const [mine, held] = await Promise.all([
    db.collection("cowork_tasks")
      .where("assigneeIds", "array-contains", employeeId)
      .get(),
    db.collection("cowork_tasks")
      .where("pendingAssigneeId", "==", employeeId)
      .get()
      .catch(() => null),
  ]);
  const docs = new Map();
  for (const d of [...mine.docs, ...(held ? held.docs : [])]) docs.set(d.id, d);

  let highest = 0;
  docs.forEach((doc) => {
    const t = doc.data() || {};
    if (t.isDeleted) return;
    if (_CLOSED_STATUS.has(t.status)) return;
    if (_CLOSED_REVIEW.has(t.completionStatus)) return;
    // A task whose budget is still being agreed STILL OCCUPIES ITS RANK.
    //
    // This used to skip them, on the reasoning that unsettled work is not in the
    // queue and so must not push the next rank up and leave a gap. The gap it
    // avoided is harmless — the client derives gap-free display positions from
    // the queue, so a hole in the stored numbers is never seen. What it caused
    // is not: assign two tasks to somebody before they accept the first, which
    // is an entirely ordinary morning, and the second one skips the first
    // entirely, so both are stored at rank 1. Two tasks at the same rank have no
    // defined order, and the deadline chain is laid out in rank order — so the
    // collision decides somebody's due dates by whatever order Firestore
    // happened to return.
    //
    // A rank is a slot in a person's work, not a certificate that the hours are
    // agreed. Handing somebody a second task takes the next slot whether or not
    // they have accepted the first.
    const stored = (t.assigneePriorities || {})[employeeId];
    const rank = Number(typeof stored === "number" ? stored : t.priority);
    if (Number.isFinite(rank) && rank > highest) highest = rank;
  });

  return highest === 0 ? 1 : Math.min(10, highest + 1);
}

/** Per-assignee ranks for a new task. Each queue is computed independently. */
async function assigneePrioritiesFor(db, assigneeIds) {
  const map = {};
  for (const id of assigneeIds || []) {
    map[id] = await nextActiveRankFor(db, id);
  }
  return map;
}

async function createTask({ title, description, notes, requirements = [], satisfiesRequirementIds = [], assignedBy, assignedByName, assignedByRole, createdBy = null, assigneeIds, dueDate, priority = 5, parentTaskId = null, groupId = null, createdByTl = false, createdByCeo = false, rootCreatedByRole = null, isFolder = false, isImportant = false, isGoalBased = false, goalBased = null, isRepeat = false, repeatConfig = null, isThirdParty = false, thirdPartyConfig = null, isGoal = false, goalConfig = null, hasTimer = true, fixedDeadline = null, status = "open", isSelfAssigned = false, visibleTo = [], approverId = null, approverName = null, senderTimerWindowSecs = 0,
  pendingAssigneeId = null, pendingAssigneeName = null, departmentApprovals = null,
  isGoldTask = false,
  c2Config = null,
  etcHours = 0,
  assigneePriorities = {},
  isForwardedTask = false }) {

  const taskId = await _generateTaskId();
  const now = new Date().toISOString();
  const path = await _buildPath(parentTaskId);

  // ── "On behalf of" delegation for self-assigned subtasks ──────────────────
  // If the real requester (assignedBy, from the verified auth token) is
  // assigning THIS subtask to THEMSELVES, and they are an assignee of the
  // parent task (not its creator), treat this subtask as authored by the
  // PARENT's original creator instead. Verified against real Firestore data
  // (parent.assigneeIds / parent.assignedBy), never trusted from client
  // input — so this can only continue a delegation chain that's already
  // provably real, not spoof an arbitrary name.
  let actualCreatedBy = null;
  let actualCreatedByName = null;
  const _requesterSelfAssigning = (assigneeIds || []).includes(assignedBy);
  if (parentTaskId && _requesterSelfAssigning) {
    try {
      const parentSnap = await db.collection("cowork_tasks").doc(parentTaskId).get();
      if (parentSnap.exists) {
        const parent = parentSnap.data();
        const requesterIsParentAssignee = (parent.assigneeIds || []).includes(assignedBy);
        const requesterIsParentCreator = parent.assignedBy === assignedBy;
        if (requesterIsParentAssignee && !requesterIsParentCreator && parent.assignedBy) {
          actualCreatedBy = assignedBy;
          actualCreatedByName = assignedByName || assignedBy;
          assignedBy = parent.assignedBy;
          assignedByName = parent.assignedByName || parent.assignedBy;
          assignedByRole = parent.assignedByRole || assignedByRole;
        }
      }
    } catch (e) {
      console.warn("[createTask] on-behalf-of check failed, using real requester:", e.message);
    }
  }

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
    // The person who actually CREATED the task, distinct from the assigner of
    // record. For a self task these differ: the creator is the assignee, the
    // assigner of record is their manager. The "Created by" display reads this.
    createdBy: createdBy || assignedBy || null,
    actualCreatedBy,
    actualCreatedByName,
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
    // A label only — nothing in the engine reads it. Stored so the client can
    // show a tag; it affects no ordering, deadline, score or permission.
    isImportant: isImportant === true,
    // "Taskgoal" — a project (folder) marked as oriented around a measurable
    // objective. A label only, exactly like isImportant above: nothing in the
    // engine reads it. DELIBERATELY NOT the C2 goal task (isGoal/goalConfig
    // below) — different fields, no scoring, no roadmap. Stored only when a
    // real config came with it, so an ordinary task keeps no marker.
    isGoalBased: isGoalBased === true && !!goalBased,
    goalBased: (isGoalBased === true && goalBased) ? goalBased : null,
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
    hoursCompleted: 0,
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
    // Cross-department approval tracking — pendingAssigneeId is who actually
    // gets added to assigneeIds once every entry in departmentApprovals is
    // approved (see /task/create and /task/:taskId/department-approve).
    pendingAssigneeId: pendingAssigneeId || null,
    pendingAssigneeName: pendingAssigneeName || null,
    departmentApprovals: departmentApprovals || null,    // ── Sender-preset timer: CEO/TL can set a suggested duration at task creation
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
    // Which of the PARENT's `requirements` this subtask closes, by the caller's
    // own identifiers. Stored verbatim and never read here: the engine has no
    // opinion on what a requirement id means, so there is one interpretation of
    // it and it lives in the client that minted it. Empty on a root task and on
    // any subtask broken out without naming a requirement.
    satisfiesRequirementIds: parentTaskId && Array.isArray(satisfiesRequirementIds)
      ? satisfiesRequirementIds.filter(id => typeof id === "string" && id.trim() !== "")
      : [],
    // Workflow flags
    confirmedBy: [],
    forwardedBy: null,
    forwardedByName: null,
    // Separate from forwardedBy/forwardedByName above (those feed _reviewFlow's
    // approval routing — left untouched). This only marks the doc as
    // forward-created, so the employee task list can hide its parent chain.
    isForwardedTask: isForwardedTask || false,
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

  // ── PENDING ASSIGNEE — cross-department / CEO gate ──────────────────────────
  // A gated task is created with assigneeIds EMPTY and the target parked in
  // pendingAssigneeId, so the fan-out above skips entirely and the one person
  // the work is addressed to was told nothing at all. They found out only when
  // both approvals landed.
  //
  // Deliberately NOT "task_assigned": the task is not theirs yet and may still
  // be rejected. A separate type keeps the client from offering start/submit
  // actions on work that has not cleared the gate, and keeps this out of any
  // "assigned to me" count.
  //
  // No socket "new_task" emit either — that event carries the task into the
  // assignee's live list, which is exactly what must not happen before approval.
  if (!assigneeIds?.length && pendingAssigneeId) {
    await _notifyMany({
      recipientIds: [pendingAssigneeId],
      type: "task_pending_department_approval",
      title: `⏳ Pending Approval · ${title}`,
      body: `${assignedByName || assignedBy} wants to assign you a task. It is waiting for department approval.`,
      data: { taskId, taskTitle: title, parentTaskId: parentTaskId || "" },
      senderId: assignedBy,
      senderName: assignedByName || assignedBy,
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

  // ── A granted task's clock waits for the assignee to come online ───────────
  //
  // A cross-department grant stamps the deadline at the GRANT, while the
  // assignee may have been offline. A normal task gets `first_online` at the
  // moment it is accepted — and acceptance happens while online — so its clock
  // naturally starts when the person arrived. A granted task has no such step:
  // this is it. Confirming is the assignee's first deliberate act on the task
  // and it happens while they are online, so it is where the anchor is
  // re-resolved to `max(grant, when-they-came-online)`.
  //
  // ADDITIVE and one-directional. It runs only for a task whose stored anchor
  // is the grant (`hours_granted`), and `resolveAcceptanceAnchor` returns a
  // LATER anchor only when the online session began after the grant — online
  // since before it, or offline now, leaves everything exactly as it was. No
  // other task, and no earlier deadline, is ever touched.
  try {
    const grantedMs = readInstantMs(task.tlHoursSetAtMs) ?? readInstantMs(task.tlHoursSetAt);
    if (
      Number.isFinite(grantedMs) &&
      grantedMs > 0 &&
      task.clockStartsAtSource === "hours_granted"
    ) {
      const windowSecs =
        Number(task.deadlineWindowSecs) ||
        Number(task.senderTimerWindowSecs) ||
        0;
      const stored = readInstantMs(task.clockStartsAtMs) ?? grantedMs;
      const resolved = await resolveAcceptanceAnchor(task, Date.now(), taskId);
      if (
        windowSecs > 0 &&
        Number.isFinite(resolved?.anchorMs) &&
        resolved.anchorMs > stored
      ) {
        const dueDate = await computeWorkingDeadline({
          startMs: resolved.anchorMs,
          windowSecs,
        });
        await ref.update({
          clockStartsAtMs: resolved.anchorMs,
          clockStartsAtSource: resolved.source || "hours_granted",
          dueDate,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }
  } catch (e) {
    /* Never let a re-anchor cost the confirmation itself — the receipt is
       recorded, and a stale deadline is the smaller wrong. */
    console.warn("[confirm] granted re-anchor skipped:", e.message);
  }

  // ── Their FIRST task: the clock starts when they take it on ───────────────
  //
  // OWNER DECISION. A normal task anchors at `first_online` — the moment the
  // person was online at or after it was created — precisely so that sitting on
  // an acceptance buys no extra deadline. That is right while they already have
  // work. It is wrong when they had NOTHING open: there was no work to sit on,
  // so the gap between the task being created and them taking it on was never
  // work time, and charging it makes their first task short by exactly that gap.
  //
  // Runs ONLY when `hasOpenUnsubmittedWork` finds nothing else open and
  // unsubmitted for them — an overdue task counts as open, so somebody behind on
  // work gets nothing here.
  //
  // ENTIRELY SEPARATE from the granted block above and mutually exclusive with
  // it: a cross-department task carries `tlHoursSetAt*` and
  // `clockStartsAtSource === "hours_granted"`, and both are refused here. That
  // path keeps its own behaviour untouched.
  //
  // One-directional, like every other rule here: it writes only when the new
  // anchor is LATER than the stored one, so no deadline ever becomes harder to
  // meet than it already was.
  try {
    const isGranted =
      task.clockStartsAtSource === "hours_granted" ||
      Number.isFinite(readInstantMs(task.tlHoursSetAtMs)) ||
      Number.isFinite(readInstantMs(task.tlHoursSetAt));

    // A deadline somebody typed outranks anything computed from a window
    // (`fixedDeadline ?? deadline ?? dueDate`), so recomputing one from hours
    // would move a date that was deliberately set. Left alone.
    const hasFixedDate = Boolean(task.fixedDeadline);

    // ── A SELF task is already anchored, at its approval ─────────────────────
    //
    // On a self-assigned task the person raises the work AND does it, so this
    // confirmation is their second press on their own task: the first was
    // creating it. The moment that actually released the work was their
    // MANAGER approving the budget, and `acceptBudgetProposal` stamps the
    // anchor there.
    //
    // Re-anchoring here would throw that away and charge them for the gap
    // between the approval and their own click — reported: raised 1:00,
    // approved 1:30, confirmed 2:00, and the clock started at 2:00 instead of
    // 1:30. The approval is the honest start and it is already recorded.
    //
    // Assigned tasks are untouched: there the acceptance IS the moment the
    // work became theirs, which is the whole point of the rule.
    const isSelfTask =
      task.isSelfAssigned === true || task.isSelfAssigned === "true";

    if (!isGranted && !hasFixedDate && !isSelfTask) {
      const windowSecs =
        Number(task.deadlineWindowSecs) ||
        Number(task.senderTimerWindowSecs) ||
        0;
      const createdMs =
        readInstantMs(task.createdAtISO) ?? readInstantMs(task.createdAt);
      const stored = readInstantMs(task.clockStartsAtMs) ?? createdMs;
      const resolved = await resolveAcceptanceAnchor(task, Date.now(), taskId, {
        considerFirstTask: true,
      });
      if (
        windowSecs > 0 &&
        resolved?.source === "first_task" &&
        Number.isFinite(resolved.anchorMs) &&
        (!Number.isFinite(stored) || resolved.anchorMs > stored)
      ) {
        const dueDate = await computeWorkingDeadline({
          startMs: resolved.anchorMs,
          windowSecs,
        });
        await ref.update({
          clockStartsAtMs: resolved.anchorMs,
          clockStartsAtSource: resolved.source,
          dueDate,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }
  } catch (e) {
    /* Same rule as above: a failed re-anchor never costs the confirmation. */
    console.warn("[confirm] first-task re-anchor skipped:", e.message);
  }

  const notifyIds = [task.assignedBy, task.originalAssignedBy].filter(id => id && id !== employeeId);
  await _notifyMany({ recipientIds: [...new Set(notifyIds)], type: "task_confirmed", title: `✅ Confirmed · ${task.title}`, body: `${employeeName} acknowledged task "${task.title}"`, data: { taskId, taskTitle: task.title }, senderId: employeeId, senderName: employeeName });
  socket.emitToMany([...new Set(notifyIds)], "task_confirmed", { taskId, employeeId, employeeName });
  return { success: true };
}

// ═════════════════════════════════════════════════════════
//  2b. DECLINE ASSIGNMENT — assignee refuses the work outright
// ═════════════════════════════════════════════════════════
// The mirror of confirmTaskReceipt. Until now an assignee could refuse the
// TERMS (reject-sender-timer, which reopens the budget negotiation and leaves
// the task with them) but had no way to hand the work back at all — status
// "rejected" was only ever reached by a cross-department approver refusing a
// gate, never by the person the work was for.
//
// Same guards as confirmTaskReceipt, in the same order:
//   · must be an assignee            (assigneeIds includes employeeId)
//   · must not have confirmed already (a declined task you accepted is a
//     cancellation, which is a different act with a different owner)
// Plus a required reason: refusing work silently leaves the assignor with a
// stalled task and no way to find out why.
//
// Writes status "rejected", which is the status the department-gate refusal
// already uses — so every existing reader (the old task page's tab grouping,
// the new UI's mapper) treats it correctly with no change.
async function declineAssignment({ taskId, employeeId, employeeName, reason }) {
  const ref = db.collection("cowork_tasks").doc(taskId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Task not found.");
  const task = doc.data();

  if (!task.assigneeIds?.includes(employeeId) && task.pendingAssigneeId !== employeeId) {
    throw new Error("Not assigned to this task.");
  }
  if (task.confirmedBy?.includes(employeeId)) {
    throw new Error("You have already accepted this task. Ask for it to be cancelled instead.");
  }
  if (task.status === "rejected") throw new Error("This task has already been declined.");
  if (["done", "completed", "cancelled"].includes(task.status)) {
    throw new Error("This task is closed.");
  }
  if (!reason?.trim()) throw new Error("A reason is required to decline a task.");

  await ref.update({
    status: "rejected",
    assignmentDeclinedBy: employeeId,
    assignmentDeclinedByName: employeeName || "",
    assignmentDeclinedReason: reason.trim(),
    assignmentDeclinedAt: new Date().toISOString(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // The system chat line is posted by the ROUTE — postSystemChatMessage is
  // defined there, as it is for department-tl-set-hours. Keeping the service
  // free of it also keeps this function callable from a job or a script.

  const notifyIds = [task.assignedBy, task.originalAssignedBy].filter(
    (id) => id && id !== employeeId,
  );
  await _notifyMany({
    recipientIds: [...new Set(notifyIds)],
    type: "task_declined",
    title: `\u26d4 Declined · ${task.title}`,
    body: `${employeeName} declined "${task.title}" — ${reason.trim()}`,
    data: { taskId, taskTitle: task.title },
    senderId: employeeId,
    senderName: employeeName,
  });
  socket.emitToMany([...new Set(notifyIds)], "task_declined", {
    taskId,
    employeeId,
    employeeName,
    reason: reason.trim(),
  });

  return { success: true, status: "rejected" };
}

// ═════════════════════════════════════════════════════════
//  2c. SET BUDGET ON AN ACTIVE TASK
// ═════════════════════════════════════════════════════════
// department-tl-set-hours opens with `if (task.status !== "pending_tl_hours")
// return 400`, because it exists to activate a task waiting at the gate. That
// is correct for what it does, and it is NOT a route for changing the budget of
// work already running — which is what approving a time-budget extension needs.
//
// Rather than loosening that guard (which would change a route the old frontend
// relies on), this is its sibling for the active case. Same authority rule:
// the budget belongs to whoever MANAGES the assignee, resolved through the same
// _getPrimaryManagerApprover the approval chain uses, so no new notion of
// hierarchy is introduced.
async function setActiveTaskBudget({ taskId, employeeId, employeeName, hoursValue, hoursUnit }) {
  // Caller MUST have verified that employeeId manages the assignee. See the route.
  const ref = db.collection("cowork_tasks").doc(taskId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Task not found.");
  const task = doc.data();

  if (["done", "completed", "cancelled", "rejected"].includes(task.status)) {
    throw new Error("This task is closed, so its budget cannot be changed.");
  }

  const targetId = task.pendingAssigneeId || task.assigneeIds?.[0];
  if (!targetId) throw new Error("This task has no assignee yet.");

  // The MANAGER check is done by the caller, not here — `_getPrimaryManagerApprover`
  // is defined in the route file, which is also where department-tl-set-hours
  // performs the identical check. Keeping the lookup there means one definition
  // of "who manages the assignee" rather than a second copy in this layer.
  const val = Number(hoursValue) || 0;
  if (val <= 0) throw new Error("Enter a valid number of hours.");
  const unit = hoursUnit || "hours";
  const secs = val * (unit === "minutes" ? 60 : unit === "days" ? 86400 : 3600);

  const previousSecs = Number(task.deadlineWindowSecs) || Number(task.senderTimerWindowSecs) || 0;

  // deadlineWindowSecs is the AGREED window — the field resolveTimeBudget reads
  // first and the one the queue plans against. senderTimerWindowSecs is left
  // alone: it records what was originally proposed, and overwriting it would
  // erase the fact that the budget ever changed.
  /**
   * **The deadline follows the budget.** Reported 17 Aug 2026.
   *
   * This wrote the window and nothing else, so a granted extension raised the
   * budget and left the date alone: T062 went to a 2-hour budget from a 13:23
   * start and kept a 15:00 deadline, when its own arithmetic says 15:23. The
   * two figures sit beside each other on the task panel — "00:00:00 of
   * 01:50:00" above "17 Aug · 15:00 IST" — and disagreed.
   *
   * Counted from the STORED anchor, never a fresh one. `clockStartsAtMs` was
   * stamped once when the clock started and is deliberately never recomputed:
   * re-resolving it here would move the start every time somebody adjusted the
   * hours, and a deadline whose origin drifts cannot be checked by the person
   * measured against it.
   *
   * Left alone in two cases: a task carrying a fixed calendar date has no
   * budget-derived deadline to move, and a task with no stamped anchor has
   * nothing honest to count from — better the date it has than one invented
   * from `now`.
   */
  const anchorMs = readInstantMs(task.clockStartsAtMs);
  const currentDueMs = readInstantMs(task.dueDate);
  const deltaSecs = secs - previousSecs;
  let dueDate = null;
  if (!task.fixedDeadline && Number.isFinite(anchorMs)) {
    try {
      /**
       * **The granted time is ADDED to the deadline you already have.**
       * OWNER DECISION, 17 Aug 2026.
       *
       * This recomputed `anchor + budget` outright, which quietly took back
       * time a task was already carrying: T062 stood at 16:30 on a 3:00
       * budget anchored at 13:23, though 13:23 + 3:00 is 16:23 — seven
       * minutes of slack from an older formula. Granting ten more minutes
       * then produced 16:33 rather than 16:40, so a +10 grant read as +3.
       *
       * Ten minutes granted means ten minutes later. The delta is walked
       * through office hours, so a grant near closing still lands on the next
       * working morning rather than at night.
       */
      if (!Number.isFinite(currentDueMs)) {
        /* No date yet: the anchor is the only honest place to count from. */
        dueDate = await computeWorkingDeadline({ startMs: anchorMs, windowSecs: secs });
      } else if (deltaSecs > 0) {
        dueDate = await computeWorkingDeadline({
          startMs: currentDueMs,
          windowSecs: deltaSecs,
        });
      }
      /* Unchanged or REDUCED leaves `dueDate` null and writes nothing. A
         background recompute must never shorten a commitment somebody is
         already working to: a smaller budget is a decision about hours, and
         taking the date away with it is a second decision nobody made here. */

      /* A subtask may not outlive its project — OWNER DECISION 16 Aug 2026.
         Clamped rather than refused: the budget change is the manager's and
         stands; the project's date is the ceiling the child is measured by. */
      if (dueDate !== null) {
        const { readParentDeadline } = require("./parentDeadlineCap.service");
        const parent = await readParentDeadline(task);
        if (parent && Date.parse(dueDate) > parent.dueAtMs) {
          dueDate = new Date(parent.dueAtMs).toISOString();
        }
      }
    } catch (e) {
      /* An unreadable calendar costs the recalculation, never the budget. */
      console.warn("[setActiveTaskBudget] deadline recompute failed:", e.message);
      dueDate = null;
    }
  }

  await ref.update({
    deadlineWindowSecs: secs,
    etcHours: secs / 3600,
    ...(dueDate ? { dueDate } : {}),
    budgetSetBy: employeeId,
    budgetSetByName: employeeName || "",
    budgetSetAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Posted by the route, as above.

  /**
   * **The tasks below it follow.** Reported 17 Aug 2026.
   *
   * T062 (P1) and T063 (P2) were chained correctly when T063 was created —
   * T062 was due 15:00, so T063 anchored there. T062's budget then grew and
   * its deadline moved to 16:30 while T063 kept its 15:00 anchor: thirty
   * minutes of real room for two hours of work.
   *
   * Distinct from the "decided once" rule, which is about NEW work arriving
   * above somebody and still stands. Here the chain was already agreed and the
   * link above it moved; leaving it stale protects nobody. `rechainQueueFor`
   * only ever pushes LATER, so nothing becomes harder to meet.
   *
   * Detached, like the other cascades: a queue walk must not make the manager
   * wait on their own press, and a failure in it must not fail the budget that
   * has already been written.
   */
  setImmediate(() => {
    rechainQueueFor(targetId)
      .then((moved) => {
        if (moved.length) {
          console.log(
            `[rechain] ${moved.length} task(s) moved behind ${taskId}:`,
            moved.map((m) => `${m.taskId} -> ${m.to}`).join(", "),
          );
        }
      })
      .catch((e) => console.error("[rechain]", e.message));
  });

  await _notifyMany({
    recipientIds: [targetId].filter((id) => id && id !== employeeId),
    type: "task_budget_changed",
    title: `\u23f1 Time budget updated · ${task.title}`,
    body: `${employeeName} set the budget to ${(secs / 3600).toFixed(2)}h.`,
    data: { taskId, taskTitle: task.title },
    senderId: employeeId,
    senderName: employeeName,
  });

  return { success: true, previousSecs, deadlineWindowSecs: secs };
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
// Read-only preview of remaining forward-duration budget on a parent task.
// Deliberately a separate calculation from forwardTask()'s own validation —
// kept duplicated on purpose so a bug in this preview endpoint can never
// silently change what forwardTask() actually enforces at submit time.
async function getForwardBudget({ parentTaskId }) {
  const parentDoc = await db.collection("cowork_tasks").doc(parentTaskId).get();
  if (!parentDoc.exists) throw new Error("Task not found.");
  const parent = parentDoc.data();
  const totalSecs = Number(parent.deadlineWindowSecs) || Number(parent.senderTimerWindowSecs) || 0;
  let alreadyForwardedSecs = 0;
  const existingSubtaskIds = parent.subtaskIds || [];
  if (existingSubtaskIds.length) {
    const childDocs = await Promise.all(
      existingSubtaskIds.map(id => db.collection("cowork_tasks").doc(id).get())
    );
    childDocs.forEach(doc => {
      if (!doc.exists) return;
      const c = doc.data();
      if (c.isForwardedTask) {
        alreadyForwardedSecs += Number(c.deadlineWindowSecs) || Number(c.senderTimerWindowSecs) || 0;
      }
    });
  }
  // hasBudget=false means the parent has no timer concept (hasTimer:false,
  // fixed-deadline, folder, etc.) — nothing to preview or enforce for it.
  const hasBudget = totalSecs > 0;
  const remainingSecs = hasBudget ? Math.max(0, totalSecs - alreadyForwardedSecs) : null;
  return { hasBudget, totalSecs, alreadyForwardedSecs, remainingSecs };
}

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

  // ── Duration is mandatory for every forwarded assignment ────────────────
  const validAssignments = assignments.filter(a => a.employeeId && a.notes);
  if (validAssignments.some(a => !(Number(a.senderTimerWindowSecs) > 0))) {
    throw new Error("Duration is required for every assignment.");
  }

  // ── Forwarded-duration budget check ──────────────────────────────────────
  // Only applies when the parent itself has a timer window to budget against.
  // A parent with no timer concept (hasTimer: false, fixed-deadline, folder,
  // etc.) has nothing to check against, so this is skipped for it — this rule
  // is specifically about forwarded tasks, not normal parent tasks.
  const parentTotalSecs = Number(parent.deadlineWindowSecs) || Number(parent.senderTimerWindowSecs) || 0;
  if (parentTotalSecs > 0) {
    let alreadyForwardedSecs = 0;
    const existingSubtaskIds = parent.subtaskIds || [];
    if (existingSubtaskIds.length) {
      const childDocs = await Promise.all(
        existingSubtaskIds.map(id => db.collection("cowork_tasks").doc(id).get())
      );
      childDocs.forEach(doc => {
        if (!doc.exists) return;
        const c = doc.data();
        if (c.isForwardedTask) {
          alreadyForwardedSecs += Number(c.deadlineWindowSecs) || Number(c.senderTimerWindowSecs) || 0;
        }
      });
    }
    const thisBatchSecs = validAssignments.reduce((sum, a) => sum + (Number(a.senderTimerWindowSecs) || 0), 0);
    const remainingSecs = parentTotalSecs - alreadyForwardedSecs;
    if (thisBatchSecs > remainingSecs) {
      throw new Error(
        remainingSecs > 0
          ? `Only ${_fmtSecs(remainingSecs)} remaining in the parent task. Please enter a duration less than or equal to the remaining time.`
          : `No time remaining in the parent task — it has already been fully forwarded.`
      );
    }
  }

  const newTaskIds = [];

  for (const assignment of assignments) {
    if (!assignment.employeeId || !assignment.notes) continue;
    // Per-person auto-priority: count existing open tasks for this assignee
    let fwdPriority = Number(assignment.priority) || null;
    const fwdAssigneePriorities = {};
    try {
      // Highest active rank + 1, not the open COUNT + 1: a count collides
      // whenever the queue has a gap, and the old filter counted approved work
      // as open. Same rule as every other create path.
      const next = await nextActiveRankFor(db, assignment.employeeId);
      fwdAssigneePriorities[assignment.employeeId] = next;
      if (!fwdPriority) fwdPriority = next;
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
      dueDate: null,
      hasTimer: true,
      senderTimerWindowSecs: Number(assignment.senderTimerWindowSecs) || 0,
      priority: fwdPriority,
      assigneePriorities: fwdAssigneePriorities,
      parentTaskId,
      // Inherit root creator role so _reviewFlow stays correct down the chain
      rootCreatedByRole: parent.rootCreatedByRole || parent.assignedByRole || null,
      isForwardedTask: true,
      requirements: assignment.requirements || [],
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
async function sendTaskChat({ taskId, senderId, senderName, text, attachments = [], messageType = "text", mention = null, replyTo = null }) {
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
    // Denormalised quote, so a reply renders without a second read. Written
    // only when present, so nothing already stored gains an empty field.
    ...(replyTo ? { replyTo } : {}),
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
    /**
     * **Everyone the task is between, not the assignees alone.**
     * Reported 17 Aug 2026: "no web push notifications" on task chat.
     *
     * This read `assigneeIds` only. On the ordinary task — one assignee — the
     * assignee IS the whole list, so when THEY sent a message the filter
     * removed the only recipient and `notifyIds` came out empty: nobody was
     * told, and the manager waiting for that reply never heard it. Messages
     * only ever notified in one direction, and the direction that mattered
     * least.
     *
     * The people a task is between are the ones its own chat is for: whoever
     * it was given to, whoever assigned it, whoever it was forwarded from, and
     * anybody still holding it pending. Deduplicated, and the sender is always
     * removed — you do not get a push for your own message.
     */
    const notifyIds = [
      ...new Set(
        [
          ...(task.assigneeIds || []),
          ...(task.pendingAssigneeId ? [task.pendingAssigneeId] : []),
          task.assignedBy,
          task.originalAssignedBy,
          task.forwardedBy,
        ].filter((id) => id && id !== senderId),
      ),
    ];
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
  } else {
    // Employee: walkUp ONLY for regular subtasks — parent chain for context.
    // Tasks that are themselves forward-created skip walkUp entirely: once work
    // is forwarded, the employee sees only the forwarded task, never the original.
    const walkUpForEmployee = async (startParentId) => {
      let parentId = startParentId;
      while (parentId && !seen.has(parentId)) {
        const doc = await db.collection("cowork_tasks").doc(parentId).get();
        if (!doc.exists) return;
        addDoc(doc);
        const data = doc.data();
        if (data.isForwardedTask) return; // don't climb past a forwarded task's own origin
        parentId = data.parentTaskId;
      }
    };
    await Promise.all(
      initialTasks.filter(t => !t.isForwardedTask).map(t => walkUpForEmployee(t.parentTaskId))
    );
  }

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
/**
 * Close the gap a departed task leaves in somebody's ranks.
 *
 * **A rank is a POSITION, and positions do not have holes.** Ranks are handed
 * out as "your open task count + 1" (`taskForward.js`, the create path), so
 * they are contiguous the moment they are written — and then a task is deleted
 * and the numbers around it are left alone. Reported: a queue of two reading
 * P1 and P3, because the task that had been 2 was gone. Nothing on screen could
 * explain the missing number, because nothing was missing — 2 had simply left.
 *
 * The ACTIVE queue hides this: `assignPriorityRanks` renumbers what it shows,
 * 1..N with no gaps. Work awaiting acceptance shows the STORED rank instead
 * (owner decision, 17 Aug), so for that work the hole is visible and permanent.
 * Rather than teach the display to paper over it, the hole is not left.
 *
 * **Order is preserved; only the numbering compacts.** Tasks keep their
 * sequence — sorted by the rank they had, then by which was raised first — so
 * this never reorders anybody's work. It is the same operation
 * `/priority-order` performs, applied to what a deletion left behind.
 */
async function _closeRankGaps(employeeId) {
  if (!employeeId) return 0;
  const [mine, held] = await Promise.all([
    db.collection("cowork_tasks").where("assigneeIds", "array-contains", String(employeeId)).get(),
    db.collection("cowork_tasks").where("pendingAssigneeId", "==", String(employeeId)).get().catch(() => null),
  ]);

  const TERMINAL = ["done", "cancelled", "tl_final_approved", "ceo_approved", "approved", "completed"];
  const seen = new Map();
  for (const d of [...mine.docs, ...((held && held.docs) || [])]) {
    if (seen.has(d.id)) continue;
    const t = d.data();
    if (t.isDeleted || TERMINAL.includes(t.status)) continue;
    /* A broken-down task is a project, not a queue slot — the same exclusion
       the queue itself makes. */
    if ((t.subtaskIds || []).length > 0) continue;
    seen.set(d.id, {
      ref: d.ref,
      rank: Number((t.assigneePriorities || {})[employeeId] ?? t.priority) || 99,
      createdMs: t.createdAt?.toMillis?.() || Date.parse(t.createdAtISO || "") || 0,
      current: (t.assigneePriorities || {})[employeeId],
    });
  }

  const ordered = [...seen.values()].sort(
    (a, b) => a.rank - b.rank || a.createdMs - b.createdMs,
  );

  let changed = 0;
  await Promise.all(
    ordered.map((t, i) => {
      const position = i + 1;
      if (Number(t.current) === position) return null;
      changed++;
      return t.ref
        .update({
          [`assigneePriorities.${employeeId}`]: position,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        })
        .catch((e) => console.warn("[rank-gap] write failed:", e.message));
    }).filter(Boolean),
  );
  if (changed) console.log(`[rank-gap] closed ${changed} gap(s) for ${employeeId}`);
  return changed;
}

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

  /* The numbers left behind are now a position short. See `_closeRankGaps`. */
  for (const holder of [...new Set([...(task.assigneeIds || []), task.pendingAssigneeId].filter(Boolean))]) {
    await _closeRankGaps(holder).catch((e) =>
      console.warn(`[rank-gap] could not renumber ${holder}:`, e.message),
    );
  }

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
  /**
   * **One step: the assigner of record reviews, and their approval is FINAL.**
   * OWNER DECISION, 16 Aug 2026.
   *
   * This used to escalate by ROLE STRING: an assigner whose
   * `cowork_employees.role` read "employee" got the two-stage "safe default"
   * (their approval, then the CEO's), so their approval credited nothing —
   * while a "tl" assigner's identical approval completed the task. The rest of
   * the product routes every decision by the primary-manager relationship and
   * stopped consulting role strings months ago; this was the last place they
   * still decided anything, and it made the same press mean two different
   * things depending on a label.
   *
   * `ceo_direct` survives only because the CEO who created a task directly IS
   * its assigner — same rule, and the review record lands in `ceoReview` where
   * the rest of the engine expects a CEO's decision.
   *
   * `tl_then_ceo` is never DERIVED any more. It still exists as a stored value
   * on submissions made before this date; `reviewCompletion` maps those to
   * final at decision time, so the rule change reaches work already in flight.
   */
  const rootRole = task.rootCreatedByRole || task.assignedByRole;

  if (rootRole === "tl") return "tl_final";
  if (rootRole === "ceo") {
    if (!task.parentTaskId && !task.forwardedBy) return "ceo_direct";
    return "tl_final";
  }

  // Legacy flags (old tasks may have these)
  if (task.createdByTl === true) return "tl_final";
  if (task.createdByCeo === true && !task.forwardedBy) return "ceo_direct";
  if (task.createdByCeo === true && task.forwardedBy) return "tl_final";

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
          return task.parentTaskId ? "tl_final" : "ceo_direct";
        }
      }
    } catch (e) {
      console.warn("[_reviewFlow] Fallback query failed:", e.message);
    }
  }

  // The assigner reviews and their approval is final — see the note above.
  // The old "safe default" here was the two-stage escalation.
  return "tl_final";
}


/** A time as the reader would say it — "17:59", or "tomorrow 09:45". */
function _istShort(iso, nowMs = Date.now()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const opts = { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false };
  const time = d.toLocaleTimeString("en-GB", opts);
  const day = (x) => new Date(x).toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata" });
  if (day(d) === day(nowMs)) return time;
  const tomorrow = day(nowMs + 86400000);
  if (day(d) === tomorrow) return `tomorrow ${time}`;
  return `${d.toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" })} ${time}`;
}

/**
 * Tell people whose deadline moved because somebody else's work did.
 *
 * OWNER DECISION, 18 Aug 2026. The queue re-chains silently, which is fine
 * when a date moves out and not fine when it comes in: somebody who planned
 * around 18:19 and is now due 17:59 has lost twenty minutes and would find out
 * by missing it.
 *
 * **Two channels, deliberately different volumes.** Every move writes a system
 * message on the task itself — that is the permanent record of why a date
 * changed, and it interrupts nobody. Only a move that takes time AWAY also
 * sends a notification. One submission can re-chain four tasks, and four
 * pushes for four dates that all got easier is how people learn to ignore
 * notifications.
 *
 * **It names the cause.** "Deadline moved" on its own reads like a system
 * fault; "task 123 above this was handed in early" is something the reader can
 * check and, if it looks wrong, argue with.
 *
 * Never allowed to cost the thing it reports: the deadlines are already
 * written by the time this runs.
 */
async function _announceQueueShifts({ moved, employeeId, causeTaskId, causeTitle, causeReason, actorId, actorName }) {
  for (const row of moved || []) {
    /* Nothing to announce for a task that had no deadline before, or for the
       task whose own event caused all this. */
    if (!row.from || row.from === row.to) continue;
    if (causeTaskId && row.taskId === causeTaskId) continue;

    const earlier = Date.parse(row.to) < Date.parse(row.from);
    const because = causeTitle ? ` — “${causeTitle}” above this ${causeReason}` : "";
    const when = `${_istShort(row.to)} (was ${_istShort(row.from)})`;

    try {
      await sendTaskChat({
        taskId: row.taskId,
        senderId: actorId,
        senderName: actorName,
        text: `⏱ Deadline moved to ${when}${because}.`,
        messageType: "system",
      });
    } catch (e) {
      console.warn("[queueShift] chat failed for", row.taskId, e.message);
    }

    if (!earlier || !employeeId) continue;
    try {
      await _notifyMany({
        recipientIds: [employeeId],
        type: "deadline_moved_earlier",
        title: `⏱ Less time · ${row.title}`,
        body: `Now due ${when}${because}.`,
        data: { taskId: row.taskId, taskTitle: row.title, from: row.from, to: row.to, causeTaskId },
        senderId: actorId,
        senderName: actorName,
      });
    } catch (e) {
      console.warn("[queueShift] notify failed for", row.taskId, e.message);
    }
  }
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

  /**
   * **Handing work in frees the queue behind it, now rather than eventually.**
   * OWNER DECISION, 18 Aug 2026.
   *
   * This is the moment the person stops working on the task — they are waiting
   * on a reviewer — so everything queued below it can start earlier. The walk
   * already knew how to work that out; nothing was calling it here, so the
   * correction only arrived if some later event happened to re-chain the
   * queue.
   *
   * Reported with real data: T071 (P1, due 17:58) was handed in at 17:38, and
   * T072 (P2, 21 min) sat at 18:19 — T071's DEADLINE plus 21 minutes — when
   * its honest finish was 17:59.
   *
   * Never allowed to cost the submission: the work is already recorded by this
   * point, and a queue that re-chains late is recoverable where a submission
   * that failed to save is not.
   */
  try {
    const { rechainQueueFor } = require("./officeDeadline.service");
    for (const id of task.assigneeIds || []) {
      const moved = await rechainQueueFor(id);
      await _announceQueueShifts({
        moved,
        employeeId: id,
        causeTaskId: taskId,
        causeTitle: task.title,
        causeReason: "was handed in",
        actorId: employeeId,
        actorName: employeeName,
      });
    }
  } catch (e) {
    console.warn("[submitCompletionRequest] queue re-chain failed:", e.message);
  }

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

/**
 * Rework must name what is wrong with it.
 *
 * A reviewer could previously send work back with a free-text reason alone, so
 * the assignee was told "fix it" and left to infer which of the acceptance
 * criteria had failed. The criteria already exist on the task — `requirements`,
 * written at creation — so this asks the reviewer to point at them rather than
 * describe them again.
 *
 * Validated HERE and not only in the browser: the endpoint is reachable
 * directly, and a rule enforced in one client is not a rule.
 *
 * Returns the selected criteria as TEXT. Indices would be smaller but they are
 * positional, and a later edit to the requirements array would silently
 * re-point a historical rework at a different criterion — a record of what was
 * asked for must not change meaning afterwards.
 */
/**
 * The PARENT requirement texts this subtask is answerable for.
 *
 * Resolved from the parent document by the ids the subtask stores, never from
 * anything the caller sent — that is what keeps `validateReworkRequirements` a
 * whitelist rather than a free-text field.
 *
 * The ids are POSITIONAL — `<parentId>#req-<n>`, where n indexes the parent's
 * `requirements` array — which is the scheme the frontend mapper synthesises.
 * An id that does not parse, or points past the end, contributes nothing rather
 * than an empty string: a blank entry in the whitelist would let a caller send
 * "" and have it accepted.
 *
 * Empty for an ordinary task, an unreadable parent, or a parent with no
 * requirements. All three mean "nothing extra is selectable", which leaves the
 * original behaviour exactly as it was.
 */
async function claimedParentRequirementTexts(task) {
  const parentId = task && task.parentTaskId ? String(task.parentTaskId) : "";
  const ids = Array.isArray(task && task.satisfiesRequirementIds)
    ? task.satisfiesRequirementIds
    : [];
  if (!parentId || ids.length === 0) return [];
  try {
    const snap = await db.collection("cowork_tasks").doc(parentId).get();
    if (!snap.exists) return [];
    const reqs = Array.isArray(snap.data().requirements)
      ? snap.data().requirements
      : [];
    return ids
      .map((id) => {
        const m = /#req-(\d+)$/.exec(String(id));
        if (!m) return null;
        const text = reqs[Number(m[1])];
        return typeof text === "string" && text.trim() ? text.trim() : null;
      })
      .filter(Boolean);
  } catch (e) {
    console.error("[rework] parent requirements unreadable:", e.message);
    return [];
  }
}

function validateReworkRequirements(task, selected, alsoAvailable = []) {
  const own = Array.isArray(task.requirements)
    ? task.requirements.filter((r) => typeof r === "string" && r.trim() !== "")
    : [];

  /**
   * **The PARENT requirements this subtask claims count too.**
   * OWNER DECISION, 16 Aug 2026.
   *
   * A subtask exists to answer its parent's requirements, so "you have not
   * satisfied 44" is exactly the feedback a reviewer needs to give — and it was
   * the one thing they could not say. The whitelist held only the task's own
   * criteria, so a reviewer who ticked a project requirement had it silently
   * dropped, and ticking ONLY project requirements produced "Select at least
   * one completion requirement that needs changes" over a screen where they had
   * plainly selected two.
   *
   * Still a whitelist, and that matters: the texts are resolved from the PARENT
   * document by the ids this subtask actually claims, never taken from the
   * request. The property the original comment protects — that a caller cannot
   * write arbitrary text into a task's history under the reviewer's name — is
   * unchanged.
   */
  const available = [
    ...own,
    ...alsoAvailable.filter((r) => typeof r === "string" && r.trim() !== ""),
  ];

  // A task with no acceptance criteria cannot have one selected. Refusing the
  // rework would strand the reviewer with no way to return the work at all,
  // so the requirement applies only where there is something to require.
  if (available.length === 0) return [];

  const chosen = (Array.isArray(selected) ? selected : [])
    .map((r) => (typeof r === "string" ? r.trim() : ""))
    .filter((r) => r !== "");

  // Only criteria that actually belong to this task. A caller could otherwise
  // write arbitrary text into the task's history under the reviewer's name.
  const valid = chosen.filter((r) => available.includes(r));

  if (valid.length === 0) {
    throw new Error(
      "Select at least one completion requirement that needs changes before sending for rework.",
    );
  }
  return [...new Set(valid)];
}

/**
 * Attachment metadata, in the shape task chat already uses.
 *
 * The engine never receives a FILE — task chat has always taken
 * `{ url, name, type, downloadUrl }` for something already uploaded, and this
 * reuses that exactly rather than introducing a second document system. Only
 * those four fields survive: anything else a caller sends is dropped, so a
 * client cannot smuggle arbitrary structure into a task's permanent history.
 */
function readReworkAttachmentIds(ids) {
  // IDs of records already created by the attachment routes, which have
  // already checked permission and validated the bytes. Stored as references
  // so this write cannot become a second upload path.
  return (Array.isArray(ids) ? ids : [])
    .filter((x) => typeof x === "string" && x.trim() !== "")
    .slice(0, 10)
    .map((x) => x.trim());
}

function readReworkAttachments(files) {
  return (Array.isArray(files) ? files : [])
    .filter((f) => f && typeof f.url === "string" && f.url.trim() !== "")
    .slice(0, 10)
    .map((f) => ({
      url: String(f.url),
      name: typeof f.name === "string" && f.name.trim() ? f.name.trim() : "attachment",
      type: typeof f.type === "string" ? f.type : "file",
      downloadUrl: typeof f.downloadUrl === "string" ? f.downloadUrl : String(f.url),
    }));
}

/**
 * One rework, appended rather than overwritten, so the history survives.
 *
 * `reason` is the review note the engine already required; `note` is the
 * reviewer's optional extra context. Kept apart because they answer different
 * questions — why the work came back, and what to do about it — and merging
 * them would make the required one optional in practice.
 */
function reworkHistoryEntry(
  task,
  reviewerId,
  reviewerName,
  requirements,
  reason,
  note,
  attachments,
  attachmentIds,
) {
  return [
    ...(Array.isArray(task.reworkHistory) ? task.reworkHistory : []),
    {
      attempt: (Array.isArray(task.reworkHistory) ? task.reworkHistory.length : 0) + 1,
      reviewerId,
      reviewerName,
      requirements,
      reason: (reason || "").trim(),
      note: typeof note === "string" ? note.trim() : "",
      attachments: readReworkAttachments(attachments),
      attachmentIds: readReworkAttachmentIds(attachmentIds),
      requestedAt: new Date().toISOString(),
    },
  ];
}

async function reviewCompletion({ taskId, reviewerId, reviewerName, approved, rejectionReason, reworkRequirements, reworkNote, reworkAttachments, reworkAttachmentIds, reworkPriority = null }) {
  const ref = db.collection("cowork_tasks").doc(taskId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Task not found.");
  const task = doc.data();
  if (task.completionStatus !== "submitted") throw new Error("No pending submission.");

  /* A submission made BEFORE 16 Aug 2026 carries "tl_then_ceo" stamped at
     submit time. The rule changed under it: the assigner's approval is final
     for everyone now, so the stored two-stage value is read as final rather
     than sending one more task into a stage nobody completes. */
  const storedFlow = task.reviewFlow === "tl_then_ceo" ? "tl_final" : task.reviewFlow;
  const flow = storedFlow || await _reviewFlow(task);
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
    // What exactly failed. Enforced server-side — see `validateReworkRequirements`.
    const _reworkReqs = validateReworkRequirements(task, reworkRequirements, await claimedParentRequirementTexts(task));
    const _reworkHistory = reworkHistoryEntry(task, reviewerId, reviewerName, _reworkReqs, rejectionReason, reworkNote, reworkAttachments, reworkAttachmentIds);
    const tlReview = { reviewedBy: reviewerId, reviewedByName: reviewerName, approved: false, rejectionReason: rejectionReason.trim(), reviewedAt: new Date().toISOString() };

    const isDeadlineMode = task.hasTimer === false;
    const deadlineField = isDeadlineMode ? "fixedDeadline" : "dueDate";
    const currentDeadline = task[deadlineField] || null;

    let newDeadline = currentDeadline;
    const submittedAtISO = task.completionSubmission?.submittedAt || null;
    if (currentDeadline && submittedAtISO) {
      const leftoverMs = new Date(currentDeadline).getTime() - new Date(submittedAtISO).getTime();
      const snappedNow = await _snapToNextWorkingMoment(new Date());
      newDeadline = new Date(snappedNow.getTime() + leftoverMs).toISOString();
    }

    /**
     * **Where the rework sits in the person's queue — the reviewer's call.**
     * OWNER DECISION, 18 Aug 2026.
     *
     * A rejection puts work back on somebody who has already moved on to the
     * next thing, and only the reviewer knows whether this rework matters more
     * than what they are doing now. Until this, the rework silently kept its
     * old rank and nothing behind it moved at all.
     *
     * Optional on purpose. A reviewer who does not care, or a client that
     * never sends it, leaves the rank exactly as it was — losing a rejection
     * because a priority picker failed would be far worse than a queue in a
     * slightly wrong order.
     */
    const reworkUpdate = {};
    const wantedRank = Number(reworkPriority);
    if (Number.isFinite(wantedRank) && wantedRank > 0) {
      const perAssignee = { ...(task.assigneePriorities || {}) };
      for (const id of task.assigneeIds || []) perAssignee[id] = wantedRank;
      reworkUpdate.assigneePriorities = perAssignee;
      reworkUpdate.priority = wantedRank;
    }

    await ref.update({ completionRequirementsFailed: _reworkReqs, reworkHistory: _reworkHistory,
      completionStatus: "tl_rejected", tlReview, status: "in_progress", [deadlineField]: newDeadline, ...reworkUpdate, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
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
  /**
   * **Either outcome changes the queue, so both re-chain.**
   *
   * An approval takes the task out of the queue altogether, so the work below
   * it can start earlier. A rejection puts it back in, at whatever priority
   * the reviewer chose, so the work below it moves out. One call after the
   * decision is written covers both, rather than a copy in each branch that
   * could drift apart.
   *
   * Never allowed to cost the review: that is already saved by this point, and
   * a queue that re-chains late is recoverable where a review that failed to
   * save is not.
   */
  try {
    const { rechainQueueFor } = require("./officeDeadline.service");
    for (const id of task.assigneeIds || []) {
      const moved = await rechainQueueFor(id);
      await _announceQueueShifts({
        moved,
        employeeId: id,
        causeTaskId: taskId,
        causeTitle: task.title,
        causeReason: "was reviewed",
        actorId: reviewerId,
        actorName: reviewerName,
      });
    }
  } catch (e) {
    console.warn("[reviewCompletion] queue re-chain failed:", e.message);
  }

  return { success: true, taskId, approved, completionStatus: finalStatus, reviewFlow: flow };
}


// ═════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════
//  C1 REWORK — TL sends task back for rework (-0.2 per occurrence)
// ═════════════════════════════════════════════════════════
async function reworkTask({ taskId, reviewerId, reviewerName, reworkReason, waiveDeduction = false, reworkRequirements, reworkNote, reworkAttachments, reworkAttachmentIds, reworkPriority = null }) {
  const ref = db.collection("cowork_tasks").doc(taskId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Task not found.");
  const task = doc.data();
  if (task.completionStatus !== "submitted") throw new Error("Task has not been submitted yet.");

  const currentReworks = Number(task.c1?.reworksReceived) || 0;

  const isDeadlineMode = task.hasTimer === false;
  const deadlineField = isDeadlineMode ? "fixedDeadline" : "dueDate";
  const currentDeadline = task[deadlineField] || null;

  /**
   * **Rework hands back the time that was left at submission.** OWNER
   * DECISION, 16 Aug 2026 — settled after two rewrites the same day.
   *
   * The window is `deadline − submittedAt`, run from this moment. Finish an
   * hour early and you get an hour to correct it; finish with a minute to spare
   * and you get a minute. The time you saved is yours to spend on the fix.
   *
   * It was briefly rewritten to a flat hour, then to the task's whole budget.
   * The brief said "a fresh hour INSTEAD of the remaining time" but its example
   * — deadline 18:00, submitted 17:00, sent back 17:45, due 18:45 — has a
   * leftover of exactly one hour, so it could not tell the two apart. A second
   * case with four minutes left settled it at 12:23, which is only the leftover.
   *
   * Two things are KEPT from those rewrites and were not in the original:
   *
   * 1. **The gate.** Only when the submission actually beat its deadline. A
   *    late one makes the subtraction NEGATIVE, so the original produced a
   *    deadline BEFORE the rework — instantly overdue, timer blocked, on work
   *    nobody had started. A late submission now keeps its date and needs an
   *    extension, which is the cost of having been late.
   * 2. **Office time.** `computeWorkingDeadline` walks the working calendar,
   *    the same walk every other deadline in the engine uses, so four minutes
   *    left at 5:58 against a 6:00 close finishes tomorrow morning rather than
   *    at 6:02 with nobody at a desk. The original added raw milliseconds to a
   *    snapped start.
   *
   * The test is on the SUBMISSION, never on the review. A reviewer who takes
   * three hours to look at an on-time submission must not thereby cost the
   * worker time they had earned; the only thing they controlled was when they
   * handed it in.
   */
  const submittedAtMs = readInstantMs(task.completionSubmission?.submittedAt);
  const currentDeadlineMs = readInstantMs(currentDeadline);
  const onTime =
    currentDeadlineMs !== null &&
    submittedAtMs !== null &&
    submittedAtMs <= currentDeadlineMs;

  let newDeadline = currentDeadline;
  /* Recorded on the history row so the task page can say WHY a deadline did
     not move. "It stayed the same" and "you were late, so it stayed the same"
     are the same pixels and very different facts. */
  let deadlineHeldReason = null;
  if (onTime) {
    /**
     * **The time they had left when they handed it in.**
     *
     * Non-negative by construction — `onTime` is the same statement as this
     * subtraction being positive, which is what makes the gate load-bearing
     * rather than decorative. Floored to whole seconds: rounding up would hand
     * back a fraction nobody had.
     */
    const leftoverSecs = Math.floor(
      (currentDeadlineMs - submittedAtMs) / 1000,
    );
    newDeadline = await computeWorkingDeadline({
      startMs: Date.now(),
      windowSecs: leftoverSecs,
    });
  } else if (currentDeadlineMs === null) {
    deadlineHeldReason = "no_deadline";
  } else if (submittedAtMs === null) {
    deadlineHeldReason = "no_submission";
  } else {
    deadlineHeldReason = "submitted_late";
  }

  // What exactly failed — enforced here, not only in the browser.
  const _reworkReqs = validateReworkRequirements(task, reworkRequirements, await claimedParentRequirementTexts(task));
  const _reworkHistory = reworkHistoryEntry(task, reviewerId, reviewerName, _reworkReqs, reworkReason, reworkNote, reworkAttachments, reworkAttachmentIds);

  /**
   * **Where the returned work sits in the person's queue — the reviewer's
   * call.** OWNER DECISION, 18 Aug 2026.
   *
   * Sending work back puts it on somebody who has already moved on to the next
   * thing, and only the reviewer knows whether this rework outranks what they
   * are doing now. Until this, it silently kept its old rank and nothing
   * behind it moved at all.
   *
   * Optional on purpose. A reviewer who does not care, or a client that never
   * sends it, leaves the rank exactly as it was — losing a rework because a
   * priority picker failed would be far worse than a queue in a slightly wrong
   * order.
   */
  const _wantedRank = Number(reworkPriority);
  const _rankUpdate = {};
  if (Number.isFinite(_wantedRank) && _wantedRank > 0) {
    const perAssignee = { ...(task.assigneePriorities || {}) };
    for (const id of task.assigneeIds || []) perAssignee[id] = _wantedRank;
    _rankUpdate.assigneePriorities = perAssignee;
    _rankUpdate.priority = _wantedRank;
  }

  await ref.update({
    completionRequirementsFailed: _reworkReqs, reworkHistory: _reworkHistory,
      completionStatus: null,
    status: "in_progress",
    ..._rankUpdate,
    [deadlineField]: newDeadline,
    "c1.reworksReceived": currentReworks + 1,
    reworkHistory: admin.firestore.FieldValue.arrayUnion({
      reworkNumber: currentReworks + 1,
      reason: reworkReason || "",
      sentBackBy: reviewerId,
      sentBackByName: reviewerName,
      sentBackAt: new Date().toISOString(),
      previousDeadline: currentDeadline,
      newDeadline,
      /* Null when the clock was reset. See `deadlineHeldReason` above. */
      deadlineHeldReason,
      /* Whether THIS rework's score deduction was waived — recorded so a reader
         can be told the outcome, not just that a rework happened. The deduction
         itself is written (or not) below, from the same flag. */
      deductionWaived: waiveDeduction === true,
    }),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  /**
   * The rest of that person's queue now chains behind wherever this landed.
   * Each assignee is walked separately because a queue belongs to a person,
   * not to a task.
   *
   * Never allowed to cost the rework: it is already written by this point, and
   * a queue that re-chains late is recoverable where a rework that failed to
   * save is not.
   */
  try {
    const { rechainQueueFor } = require("./officeDeadline.service");
    for (const id of task.assigneeIds || []) {
      const moved = await rechainQueueFor(id);
      await _announceQueueShifts({
        moved,
        employeeId: id,
        causeTaskId: taskId,
        causeTitle: task.title,
        causeReason: "was sent back for rework",
        actorId: reviewerId,
        actorName: reviewerName,
      });
    }
  } catch (e) {
    console.warn("[reworkTask] queue re-chain failed:", e.message);
  }

  /* The real deduction, from the admin-set C1 config in Firestore
     (`cowork_sop_settings/task_events.c1ReworkDeduction`) — the SAME value
     `writeReworkDeduction` charges below, never a hardcoded number, so the line
     the reader sees is the amount that was actually taken. */
  const { c1ReworkDeduction } = await c1Svc.getC1Config();
  const reworkPts = +Number(c1ReworkDeduction).toFixed(2);

  await sendTaskChat({
    taskId, senderId: reviewerId, senderName: reviewerName,
    /* The deduction outcome rides on the message itself, on its own line after
       the reason, so the chat card can state it without re-deriving it: waived
       means no points were cut; otherwise the configured amount was. */
    text: `🔄 ${reviewerName} sent this task back for rework (rework #${currentReworks + 1}).\n📝 Reason: ${reworkReason || "No reason given"}\n${waiveDeduction ? "✅ Deduction waived — no points cut for this rework." : `⚠️ Deduction applied — ${reworkPts} points cut for this rework.`}`,
    messageType: "system",
  });

  const submitterId = task.completionSubmission?.submittedBy;
  if (submitterId) {
    await _notifyMany({
      recipientIds: [submitterId],
      type: "task_rework",
      title: `🔄 Rework Required · ${task.title}`,
      /**
       * **How long they have, in the notification itself.**
       * OWNER DECISION, 18 Aug 2026.
       *
       * "Rework required" alone makes somebody open the task to find out
       * whether they have twenty minutes or none — and the answer is not
       * obvious even then, because the time given is what was UNUSED at
       * submission, not what is left against the old deadline.
       *
       * The late case is the one that most needs saying: a submission that
       * missed its deadline earns no reset, so the task comes back already
       * overdue and its timer will not start until somebody grants an
       * extension. Discovering that by pressing an inert Play button is the
       * worst way to learn it.
       */
      body:
        deadlineHeldReason === "submitted_late"
          ? `Reason: ${reworkReason || "Check task for details"} — the deadline has NOT been reset, because this was handed in late. You will need more time granted before you can start.`
          : newDeadline
            ? `Reason: ${reworkReason || "Check task for details"} — you have until ${_istShort(newDeadline)}, the time that was left when you handed it in.`
            : `Reason: ${reworkReason || "Check task for details"}`,
      data: {
        taskId,
        taskTitle: task.title,
        reason: reworkReason,
        newDeadline,
        deadlineHeldReason,
      },
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
async function ceoReviewCompletion({ taskId, reviewerId, reviewerName, approved, rejectionReason, reworkRequirements, reworkNote, reworkAttachments, reworkAttachmentIds}) {
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
    // What exactly failed. Enforced server-side — see `validateReworkRequirements`.
    const _reworkReqs = validateReworkRequirements(task, reworkRequirements, await claimedParentRequirementTexts(task));
    const _reworkHistory = reworkHistoryEntry(task, reviewerId, reviewerName, _reworkReqs, rejectionReason, reworkNote, reworkAttachments, reworkAttachmentIds);
    await ref.update({
      completionRequirementsFailed: _reworkReqs, reworkHistory: _reworkHistory,
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
//  OUTPUTS — what a task hands over, delivered one at a time
// ═════════════════════════════════════════════════════════
/**
 * An OUTPUT is a thing this task hands to somebody else — "Google Doc —
 * Gopalpur". A REQUIREMENT is what must be true for this task to be finished.
 * They are different questions and a task may carry both; overloading
 * `requirements` for handovers would have made every task's definition of done
 * get rewritten to suit its consumers.
 *
 * Why this exists: a content task covering ten properties is handed over one
 * property at a time. The designer starts Gopalpur as soon as Gopalpur is
 * approved, while the writer is still on Puri. A task-level dependency can only
 * mean "wait for all of it", which is not how the work runs.
 *
 * ## Shape, and why it is on the task document
 *
 *   outputs: [ { id, label, order, needsOutputIds: [] } ]
 *   outputSubmissions: { [outputId]: { …completionSubmission, review } }
 *
 * `outputs` sits beside `requirements`, which is already an array on the doc.
 * `outputSubmissions` is `completionSubmission` keyed by output — the SAME
 * object shape, so every existing reader can be taught it in one place. Ten
 * outputs is roughly 20KB against Firestore's 1MB limit, so a subcollection
 * would buy nothing but extra reads and a new security rule.
 *
 * ## One review step, because that is this engine's rule
 *
 * `_reviewFlow` resolves to the assigner of record, whose approval is FINAL
 * (owner decision, 16 Aug 2026). There is no chain here and therefore no
 * mid-stage state: an approval IS the release.
 */

/** Every output id approved anywhere — what an input is checked against. */
async function _approvedOutputIds() {
  const snap = await db.collection("cowork_tasks").where("hasOutputs", "==", true).get();
  const ids = new Set();
  snap.forEach((d) => {
    const t = d.data();
    const subs = t.outputSubmissions || {};
    for (const o of t.outputs || []) {
      if (subs[o.id]?.review?.approved === true) ids.add(o.id);
    }
  });
  return ids;
}

/**
 * Every output in the workspace, with its label and whether it is approved.
 *
 * **An input is another task's output**, so no single task document can answer
 * whether its inputs have landed or what they are called. Without this the
 * screen can only say "an output you cannot see" about a link somebody
 * deliberately made, and would treat it as never satisfied.
 *
 * One query, filtered on `hasOutputs`, rather than a read per link: a task
 * waiting on three inputs would otherwise cost three round trips to render one
 * panel.
 */
async function listOutputIndex() {
  const snap = await db.collection("cowork_tasks").where("hasOutputs", "==", true).get();
  const items = [];
  snap.forEach((d) => {
    const t = d.data();
    const subs = t.outputSubmissions || {};
    for (const o of t.outputs || []) {
      items.push({
        outputId: o.id,
        label: o.label,
        taskId: d.id,
        taskTitle: t.title || "",
        approved: subs[o.id]?.review?.approved === true,
      });
    }
  });
  return { items };
}

/** Can this output be started — is everything it needs approved? */
function _outputWorkable(output, approvedIds) {
  return (output.needsOutputIds || []).every((id) => approvedIds.has(id));
}

/**
 * Declare what a task hands over.
 *
 * The same two people who may edit the task: whoever raised it and whoever
 * carries it. An output that has already been submitted may be RENAMED but not
 * removed — its submission and review name it, and deleting it would orphan a
 * record the score is computed from.
 */
async function setTaskOutputs({ taskId, employeeId, outputs = [] }) {
  const ref = db.collection("cowork_tasks").doc(taskId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Task not found.");
  const task = doc.data();

  const mayEdit =
    task.assignedBy === employeeId ||
    task.createdBy === employeeId ||
    (task.assigneeIds || []).includes(employeeId);
  if (!mayEdit) throw new Error("Only the person who raised this task or the person carrying it can set its outputs.");

  const subs = task.outputSubmissions || {};
  const keeping = new Set(outputs.map((o) => o.id).filter(Boolean));
  const removedWithHistory = (task.outputs || []).filter(
    (o) => !keeping.has(o.id) && subs[o.id]
  );
  if (removedWithHistory.length) {
    throw new Error(`"${removedWithHistory[0].label}" has already been submitted and cannot be removed.`);
  }

  const next = outputs.map((o, i) => {
    const label = String(o.label || "").trim();
    if (!label) throw new Error("Give the output a name.");
    const id = o.id || `out_${taskId}_${i}_${Date.now().toString(36)}`;
    return {
      id,
      label,
      order: i,
      /* Never itself: an output waiting on its own approval could never be
         worked on, and nothing would ever clear it. */
      needsOutputIds: [...new Set(o.needsOutputIds || [])].filter((x) => x !== id),
    };
  });

  await ref.update({
    outputs: next,
    /* A flag rather than a length check, so `_approvedOutputIds` can query for
       the tasks that matter instead of reading the whole collection. */
    hasOutputs: next.length > 0,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { success: true, taskId, outputs: next };
}

/**
 * Hand over ONE output for review.
 *
 * The task does not move. Its assignee is still writing the rest, still holds
 * their queue position, and their clock should keep running — flipping
 * `completionStatus` to "submitted" on one output would stop all of it.
 */
async function submitOutput({ taskId, outputId, employeeId, employeeName, message, imageUrls = [], pdfAttachments = [] }) {
  const ref = db.collection("cowork_tasks").doc(taskId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Task not found.");
  const task = doc.data();
  if (!(task.assigneeIds || []).includes(employeeId)) throw new Error("Not assigned to this task.");

  const output = (task.outputs || []).find((o) => o.id === outputId);
  if (!output) throw new Error("That output does not belong to this task.");

  const approved = await _approvedOutputIds();
  if (!_outputWorkable(output, approved)) {
    throw new Error(`"${output.label}" cannot be submitted yet — it is waiting on work that has not been approved.`);
  }

  const prior = (task.outputSubmissions || {})[outputId];
  if (prior?.review?.approved === true) throw new Error("That output is already approved.");

  const submission = {
    submittedBy: employeeId,
    submittedByName: employeeName,
    message: message || "",
    imageUrls,
    pdfAttachments,
    submittedAt: new Date().toISOString(),
    /* Per (task, output). A second try at Gopalpur is attempt 2 OF GOPALPUR —
       it does not share a counter with Puri, which is what made a single
       per-task `completionSubmission` unable to express this at all. */
    attempt: (prior?.attempt || 0) + 1,
    review: null,
  };

  await ref.update({
    [`outputSubmissions.${outputId}`]: submission,
    /* `reviewFlow` is resolved once and stored, exactly as the task-level path
       does, so a later change to the routing rule cannot silently re-point work
       already in flight. */
    reviewFlow: task.reviewFlow || (await _reviewFlow(task)),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await sendTaskChat({
    taskId, senderId: employeeId, senderName: employeeName,
    text: `📤 ${employeeName} submitted "${output.label}" for review.`,
    messageType: "system",
  });

  /**
   * Tell the reviewer, because nothing else will.
   *
   * A task-level submission sets `completionStatus: "submitted"`, which is what
   * every "waiting on you" list keys off. An output submission deliberately
   * does NOT — the task is still in progress while one piece of it is read — so
   * without this the work reached the reviewer's queue by no route at all and
   * simply sat there.
   *
   * The recipient is the assigner of record: this engine resolves one reviewer
   * whose approval is final (owner decision, 16 Aug 2026).
   */
  const reviewerId = task.assignedBy || task.createdBy || null;
  if (reviewerId && reviewerId !== employeeId) {
    await _notifyMany({
      recipientIds: [reviewerId],
      type: "review_requested",
      title: `📤 Review: ${output.label}`,
      body: `${employeeName} submitted "${output.label}" from "${task.title}".`,
      data: { taskId, taskTitle: task.title, outputId, outputLabel: output.label },
      senderId: employeeId,
      senderName: employeeName,
    }).catch(() => {});
    socket.emitToMany([reviewerId], "task_updated", { taskId });
  }

  return { success: true, taskId, outputId, attempt: submission.attempt };
}

/**
 * Approve or return ONE output.
 *
 * Approving releases everything waiting on it, and — when it was the last one —
 * finishes the task through the SAME write `reviewCompletion` performs. There
 * is deliberately no second, task-level review afterwards: it would ask this
 * reviewer to approve work they have already approved a piece at a time, and a
 * review that can only ever approve measures nothing.
 */
async function reviewOutput({ taskId, outputId, reviewerId, reviewerName, approved, note = "" }) {
  const ref = db.collection("cowork_tasks").doc(taskId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Task not found.");
  const task = doc.data();

  const output = (task.outputs || []).find((o) => o.id === outputId);
  if (!output) throw new Error("That output does not belong to this task.");
  const submission = (task.outputSubmissions || {})[outputId];
  if (!submission) throw new Error("That output has not been submitted.");
  if (submission.review) throw new Error("That output has already been decided.");
  if (submission.submittedBy === reviewerId) throw new Error("You cannot review your own submission.");

  const review = {
    reviewedBy: reviewerId,
    reviewedByName: reviewerName,
    approved: !!approved,
    note: note || "",
    reviewedAt: new Date().toISOString(),
  };

  const updates = {
    [`outputSubmissions.${outputId}.review`]: review,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  /**
   * Rework counts FRACTIONALLY.
   *
   * C1 is `1.0 − 0.2 × reworksReceived` against a base of one per task, so
   * counting each returned output as a whole rework would let five returns on a
   * ten-output task zero a score that a one-output task could only reach by
   * being wrong five times over. The task keeps the value it already has and
   * its outputs divide it: one of ten returned costs a tenth.
   *
   * `etcHours` still carries the weight between tasks, untouched — so nobody
   * can inflate their share by splitting an assignment more finely.
   */
  if (!approved) {
    const total = (task.outputs || []).length || 1;
    updates.outputReworkUnits = admin.firestore.FieldValue.increment(1 / total);
  }

  const allApproved =
    approved &&
    (task.outputs || []).every((o) =>
      o.id === outputId ? true : (task.outputSubmissions || {})[o.id]?.review?.approved === true
    );

  if (allApproved) {
    /* The same write the task-level approval performs — see `reviewCompletion`
       under `tl_final`. Reusing it keeps one definition of "this task is done"
       rather than a second that could drift from it. */
    updates.completionStatus = "tl_final_approved";
    updates.status = "done";
    updates.progressPercent = 100;
    updates.tlReview = { reviewedBy: reviewerId, reviewedByName: reviewerName, approved: true, reviewedAt: review.reviewedAt };
  }

  await ref.update(updates);

  await sendTaskChat({
    taskId, senderId: reviewerId, senderName: reviewerName,
    text: approved
      ? `✅ ${reviewerName} approved "${output.label}".`
      : `↩️ ${reviewerName} returned "${output.label}"${note ? `: ${note}` : "."}`,
    messageType: "system",
  });

  if (approved) await _releaseOutputDependents(outputId, output.label, reviewerId, reviewerName);

  /**
   * **C1 is credited here too, or a task finished through its outputs earns
   * nothing.**
   *
   * `reviewCompletion` scores a task when its COMPLETION SUBMISSION is
   * approved. A task with outputs never makes one: it is finished a piece at a
   * time through this route, and the branch above marks it `done` /
   * `tl_final_approved` without ever passing through that path.
   *
   * So the two halves disagreed on screen. The task read Completed with every
   * output Approved, the flow showed Created → Assigned → Work → Approved, and
   * the score panel still said "1.0 of 1.0 points PROJECTED" — projected being
   * the honest word, because nothing had ever been written. The person had
   * finished the work and been paid nothing for it.
   *
   * The same call, the same arguments and the same `setImmediate` as the
   * completion path, so the two credit identically. `submittedAt` comes from
   * the LAST output handed over rather than from `completionSubmission`, which
   * does not exist here — that instant is what lateness is measured against.
   *
   * Guarded on `allApproved`, so approving the first of three outputs credits
   * nothing: the task is not done until every one of them is.
   */
  if (allApproved) {
    const primaryEmployee = (task.assigneeIds || [])[0] || null;
    const submissions = Object.values(task.outputSubmissions || {});
    const lastHandover = submissions
      .map((s) => s && s.submittedAt)
      .filter(Boolean)
      .sort()
      .pop();
    const submittedAt =
      lastHandover || review.submittedAt || task.completionSubmission?.submittedAt || null;
    setImmediate(() => {
      c1Svc
        .computeAndStoreTaskScore({
          taskId,
          taskData: { ...task, ...updates },
          employeeId: primaryEmployee,
          isRejected: false,
          submittedAt,
        })
        .catch((e) => console.error("[C1 score on output approval]", e.message));
    });
  }

  if (allApproved) {
    const allIds = [...new Set([...(task.assigneeIds || []), task.assignedBy].filter((id) => id && id !== reviewerId))];
    await _notifyMany({
      recipientIds: allIds, type: "completion_ceo_approved",
      title: `✅ Complete: ${task.title}`,
      body: `All ${(task.outputs || []).length} outputs approved. Task is done!`,
      data: { taskId, taskTitle: task.title }, senderId: reviewerId, senderName: reviewerName,
    });
    socket.emitToMany(allIds, "task_completed", { taskId });
    if (task.parentTaskId) await _syncParentProgress(task.parentTaskId);
  }

  return { success: true, taskId, outputId, approved: !!approved, taskCompleted: !!allApproved };
}

/**
 * Tell whoever was waiting on an output that they can start.
 *
 * Nothing is written to the waiting task: being blocked is DERIVED from whether
 * its inputs are approved, so approving the input IS the release. This only
 * makes the consequence visible to the people it affects.
 */
/**
 * Tell somebody their P1 changed.
 *
 * **Deduped on the task id, not on a clock.** The queue is derived on every
 * page load, so the honest trigger — "what is first has changed" — would
 * otherwise fire continuously for a queue that has not changed at all. The last
 * id we announced is remembered against the employee, so this sends when the
 * TOP genuinely moves and stays silent otherwise, however often it is asked.
 *
 * That is also what makes it safe to call from three different places: a block
 * demoting a task, an approval handing the slot back, and a manual reorder all
 * ask the same question, and only one of them can be the first to answer it.
 *
 * `senderId: "system"` because nobody did this TO them — a blocked P1 is a
 * consequence of somebody else's work not being ready, not an instruction.
 */
async function _notifyP1Changed({ employeeId, p1TaskId, cause }) {
  if (!employeeId || !p1TaskId) return false;
  const empRef = db.collection("cowork_employees").doc(String(employeeId));
  const empSnap = await empRef.get();
  if (!empSnap.exists) return false;
  /* Already announced. The overwhelmingly common case on a queue that is being
     re-derived rather than re-ordered. */
  if (empSnap.data().p1NotifiedTaskId === p1TaskId) return false;

  const taskSnap = await db.collection("cowork_tasks").doc(String(p1TaskId)).get();
  if (!taskSnap.exists) return false;
  const title = taskSnap.data().title || p1TaskId;

  await empRef.update({
    p1NotifiedTaskId: p1TaskId,
    p1NotifiedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await _notifyMany({
    recipientIds: [String(employeeId)],
    type: "p1_changed",
    title: "🔺 Your P1 changed",
    body: cause
      ? `"${title}" is now first — ${cause}`
      : `"${title}" is now first. Check the top of your list before you carry on.`,
    data: { taskId: String(p1TaskId), taskTitle: title, employeeId: String(employeeId) },
    senderId: "system",
    senderName: "CoWork",
  }).catch(() => {});
  console.log(`[P1-SVC] announced new P1 for ${employeeId}: ${p1TaskId} (${title})`);
  return true;
}

/**
 * Keep this person's deadlines in step with the order actually shown.
 *
 * **The dependency feature does one thing: it swaps priority.** Everything
 * about deadlines is the engine's own — anchors from `resolveAcceptanceAnchor`,
 * dates from `addWorkingSecsIST`, chaining from `rechainQueueFor`. There is no
 * separate deadline rule for blocked work and there must not be one: a blocked
 * task drops to P2, and the ordinary chain then anchors it after the task that
 * overtook it. That IS the clock stopping while the input is unavailable, paid
 * for by the swap rather than by a second mechanism arguing with the first.
 *
 * (An earlier version pushed a blocked task's deadline out directly and gave it
 * back on approval. It computed the same answer twice, from two anchors, and
 * the two disagreed the moment either side moved.)
 *
 * `rechainQueueFor` writes only where a date actually changes, so a queue
 * already correct costs one read and no writes.
 */
async function restoreUnblockedDeadlines({ employeeId, effectiveP1TaskId = null }) {
  if (!employeeId) return { rechained: 0 };

  /* The caller derived the queue, so it knows what is actually first — this
     side never re-derives it, which is what keeps one answer to that question.
     Deduped, so a queue merely being re-read announces nothing. */
  let announced = false;
  if (effectiveP1TaskId) {
    announced = await _notifyP1Changed({
      employeeId,
      p1TaskId: effectiveP1TaskId,
      cause: null,
    }).catch(() => false);
  }

  let rechained = [];
  try {
    const { rechainQueueFor } = require("./officeDeadline.service");
    rechained = await rechainQueueFor(employeeId);
    if (rechained.length)
      console.log(`[P1-SVC] re-chained ${rechained.length} deadline(s) for ${employeeId}`);
  } catch (e) {
    /* A queue that could not be re-chained is a wrong date to fix next load,
       never a reason to fail the read that asked. */
    console.warn(`[P1-SVC] re-chain failed for ${employeeId}:`, e.message);
  }

  return { rechained: rechained.length, announcedP1: announced };
}

/**
 * Everyone whose queue this approval just changed.
 *
 * **An approval reorders somebody ELSE's day.** That is the whole point of a
 * dependency: Umung approves an output and Rakesh's blocked task becomes
 * workable, so it climbs back and his dates move with it. Until now this
 * function told him and stopped there — his order and deadlines stayed frozen
 * in the blocked arrangement until he happened to open a task list and the
 * throttled sync fired.
 *
 * Reported exactly that way: Dev stored P1 and workable again, still sitting at
 * effective P2 with the early slot given to Cowork, hours after its input
 * landed.
 *
 * The re-chain is the engine's own `rechainQueueFor` — no deadline is computed
 * here. That distinction is what makes this safe where the earlier
 * push-and-give-back pair was not: this asks the one chain to re-walk, rather
 * than being a second opinion about dates.
 */
async function _rechainAffected(employeeIds) {
  const unique = [...new Set(employeeIds.filter(Boolean))];
  if (!unique.length) return;
  const { rechainQueueFor } = require("./officeDeadline.service");
  for (const id of unique) {
    try {
      const moved = await rechainQueueFor(id);
      if (moved.length)
        console.log(`[outputs] approval re-chained ${moved.length} deadline(s) for ${id}`);
    } catch (e) {
      /* A queue that could not be re-walked is a wrong date to fix on the next
         load, never a reason to fail the approval that has already been saved. */
      console.warn(`[outputs] re-chain failed for ${id}:`, e.message);
    }
  }
}

async function _releaseOutputDependents(outputId, label, actorId, actorName) {
  const snap = await db.collection("cowork_tasks").where("hasOutputs", "==", true).get();
  const approved = await _approvedOutputIds();
  /* Collected across the loop and re-walked once each — a person holding two
     freed tasks must not have their queue walked twice. */
  const affected = [];
  for (const d of snap.docs) {
    const t = d.data();
    if (t.status === "done" || t.completionStatus === "tl_final_approved") continue;
    const freed = (t.outputs || []).filter(
      (o) => (o.needsOutputIds || []).includes(outputId) && _outputWorkable(o, approved)
    );
    if (!freed.length) continue;
    /* Their ORDER changed whether or not there is anybody to notify — a
       self-assigned task frees nobody but still climbs the queue. */
    affected.push(...(t.assigneeIds || []));

    const recipients = [...new Set((t.assigneeIds || []).filter((id) => id && id !== actorId))];
    if (!recipients.length) continue;
    await _notifyMany({
      recipientIds: recipients, type: "task_unblocked",
      title: `▶️ Ready to start: ${freed[0].label}`,
      body: `"${label}" was approved, so you can begin.`,
      data: { taskId: d.id, taskTitle: t.title, outputId: freed[0].id },
      senderId: actorId, senderName: actorName,
    }).catch(() => {});
  }

  /* After the loop, so one person holding several freed tasks is walked once. */
  await _rechainAffected(affected);
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
async function proposeDeadline({ taskId, employeeId, employeeName, proposedDate, workedSecs = 0, windowSecs = 0 }) {
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
  // Prefer the EXPLICIT typed duration sent by the frontend. The old
  // now-subtraction assumed proposedDate = now + rawDuration; once the
  // frontend computes proposedDate office-hours-aware (skipping nights,
  // breaks, off days), that subtraction wildly inflates the window
  // (3h typed on Sunday evening -> ~19h derived). Fallback kept for
  // old clients that don't send windowSecs.
  const extensionSecs = Number(windowSecs) > 0
    ? Math.floor(Number(windowSecs))
    : Math.max(0, Math.floor((new Date(proposedDate).getTime() - Date.now()) / 1000));

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

// IST office-hours walker — same logic as taskForward.js route helper.
// Server-side net for approveDeadline; schedule+breaks only (no holiday set).
function _addWorkingSecsIST_svc(startMs, windowSecs, schedule, breaks) {
  if (!schedule || windowSecs <= 0) return new Date(startMs + windowSecs * 1000).toISOString();
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

// Count WORKING seconds between two instants (inverse of _addWorkingSecsIST).
// Nights, off days, and breaks contribute 0 — used for the office-hours-aware
// extension "elapsed %" so calendar time alone can never push a task into the
// 70%+ penalty zone before the employee could even work.
function _workingSecsBetweenIST(startMs, endMs, schedule, breaks) {
  if (!schedule || !startMs || !endMs || endMs <= startMs) return 0;
  const DAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const IST = 5.5 * 3600000;
  const dateStrOf = ms => new Date(ms + IST).toISOString().slice(0, 10);
  const dowOf = ms => new Date(Date.parse(dateStrOf(ms) + "T00:00:00Z")).getUTCDay();
  let total = 0, cur = startMs, guard = 0;
  while (cur < endMs && guard++ < 3660) {
    const ds = dateStrOf(cur);
    const day = schedule[DAY_KEYS[dowOf(cur)]];
    const nextMidnight = Date.parse(ds + "T00:00:00+05:30") + 86400000;
    if (!day || day.isOff) { cur = nextMidnight; continue; }
    const dayStart = Date.parse(`${ds}T${day.inTime}:00+05:30`);
    const dayEnd = Date.parse(`${ds}T${day.outTime}:00+05:30`);
    if (cur < dayStart) cur = dayStart;
    if (cur >= dayEnd) { cur = nextMidnight; continue; }
    if (cur >= endMs) break;
    const todaysBreaks = (breaks || [])
      .map(b => ({ s: Date.parse(`${ds}T${b.start}:00+05:30`), e: Date.parse(`${ds}T${b.end}:00+05:30`) }))
      .filter(b => b.e > b.s).sort((a, b) => a.s - b.s);
    const inBrk = todaysBreaks.find(b => cur >= b.s && cur < b.e);
    if (inBrk) { cur = inBrk.e; continue; }
    const nextBrkStart = (todaysBreaks.find(b => b.s > cur) || {}).s;
    const segEnd = Math.min(dayEnd, nextBrkStart == null ? Infinity : nextBrkStart, endMs);
    if (segEnd <= cur) { cur = nextMidnight; continue; }
    total += Math.floor((segEnd - cur) / 1000);
    cur = segEnd;
  }
  return total;
}

async function approveDeadline({ taskId, approverId, approverName, approved, rejectionReason, explicitDueDate, assigneeManagerId, reworkRequirements, reworkNote, reworkAttachments, reworkAttachmentIds}) {
  const ref = db.collection("cowork_tasks").doc(taskId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Task not found.");
  const task = doc.data();

  // ── Record-based deadline-extension approve ────────────────────────────────
  // The current deadline-extension flow keeps its pending state in the
  // `cowork_task_deadline_extensions` collection, NOT on the task — so the task
  // is never moved into `pending_deadline_approval`, and the status gate below
  // would (wrongly) throw "No pending deadline proposal." for every one of these.
  // When the request is approved the agreed date is passed in explicitly and
  // applied here directly. This is a DATE-only decision: the window (hours) is a
  // separate record and is left untouched.
  //
  // WHO may move it: the assignee's PRIMARY MANAGER owns the date, not only the
  // assignor — a cross-department extension is decided entirely inside the
  // assignee's management chain. `assigneeManagerId` is resolved from HR by the
  // route; either they or the assignor (assignedBy) may apply the date.
  if (explicitDueDate) {
    const mayMove =
      approverId === task.assignedBy ||
      (assigneeManagerId && approverId === assigneeManagerId);
    if (!mayMove) throw new Error("Only the assignee's manager or the task creator can move this deadline.");
    if (!approved) {
      // A refusal on this flow changes nothing on the task; the extension record
      // carries the refusal. Nothing to write here.
      return { success: true, taskId, dueDate: task.dueDate ?? null, approved: false };
    }
    await ref.update({
      dueDate: explicitDueDate,
      deadlineApprovedBy: approverId,
      deadlineApprovedByName: approverName,
      deadlineApprovedAt: admin.firestore.FieldValue.serverTimestamp(),
      deadlineProposalRejected: false,
      deadlineRejectionReason: null,
      deadlineStatus: deadlineStatus(explicitDueDate),
      deadlineColor: deadlineColor(explicitDueDate),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    try {
      await sendDraftChat({
        taskId, senderId: approverId, senderName: approverName,
        text: `✅ ${approverName} approved the revised deadline.`,
        messageType: "system",
      });
      await _notifyMany({
        recipientIds: task.assigneeIds || [],
        type: "deadline_approved",
        title: `✅ Deadline Approved · ${task.title}`,
        body: `Your revised deadline was approved.`,
        data: { taskId, taskTitle: task.title },
      });
    } catch (e) { console.error("[approveDeadline explicit notify]", e.message); }
    return { success: true, taskId, dueDate: explicitDueDate, approved: true };
  }

  // The legacy on-task flow (proposeDeadline → pending_deadline_approval): only
  // the creator decides here.
  if (task.assignedBy !== approverId) throw new Error("Only the task creator can approve or reject the deadline.");

  if (task.status !== "pending_deadline_approval") throw new Error("No pending deadline proposal.");

  // Determine what status to restore after approval
  // Only restore to in_progress or confirmed — everything else (open, etc.) → deadline_approved
  const prev = task.prevStatusBeforeDeadlineProposal;
  const prevStatus = ["in_progress", "confirmed"].includes(prev) ? prev : "deadline_approved";

  if (approved) {
    let newDueDate = task.proposedDeadline;

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

    // ── Office-hours safety net (first-time proposals only) ──────────────
    // Walk approvedWindowSecs through office time from NOW and take the
    // LATER of stored-vs-server date. A raw wall-clock date is always ≤ the
    // office walk → gets corrected; a correct chain-anchored date is always
    // ≥ the plain now-walk → preserved untouched. Also fixes late approvals
    // (proposed Sunday night, approved Monday). Extensions skipped — their
    // dueDate is intentionally stale until Start (awaitingExtensionStart).
    if (!wasExtension && approvedWindowSecs > 0) {
      try {
        const officeSnap = await db.collection("cowork_settings").doc("office").get();
        if (officeSnap.exists) {
          const serverDue = _addWorkingSecsIST_svc(Date.now(), approvedWindowSecs, officeSnap.data().schedule || null, officeSnap.data().breaks || []);
          if (serverDue && (!newDueDate || new Date(serverDue).getTime() > new Date(newDueDate).getTime())) {
            newDueDate = serverDue;
          }
        }
      } catch (e) { console.error("[approveDeadline office net]", e.message); }
    }

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
    const _reworkReqs = validateReworkRequirements(task, reworkRequirements, await claimedParentRequirementTexts(task));
    const _reworkHistory = reworkHistoryEntry(task, reviewerId, reviewerName, _reworkReqs, rejectionReason, reworkNote, reworkAttachments, reworkAttachmentIds);
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
      completionRequirementsFailed: _reworkReqs, reworkHistory: _reworkHistory,
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
    // Bell + FCM + email so offline recipients see draft-chat messages.
    // System messages are skipped — the flows that post them (propose /
    // approve / reject / counter) already send their own _notifyMany;
    // notifying here too would double-ping every action.
    // Unlike sendTaskChat, the CREATOR (assignedBy) IS notified here —
    // draft chat is a two-way negotiation and the creator's reply is
    // required for the flow to advance.
    if (messageType !== "system") {
      const notifyIds = all.filter(id => id !== senderId);
      if (notifyIds.length) {
        await _notifyMany({
          recipientIds: notifyIds,
          type: "draft_chat",
          title: `📝 Draft Chat · ${t.title || taskId}`,
          body: `${senderName}: ${(text || "📎 attachment").slice(0, 60)}`,
          data: { taskId, taskTitle: t.title || "" },
          senderId,
          senderName,
        });
      }
    }
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
//
// `trigger` names WHY the cascade is running, and there are two answers.
//
//  · "p1_conflict_check" — the original. Somebody started or dragged a P1, so
//    everything below it waits for that P1 and its deadlines move out once.
//    A drag fires this repeatedly, which is what the 2-minute dedup is for.
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

    /* The dependency feature's ONLY effect here: whatever now leads this
       person's queue is announced to them. No deadline rule of its own — the
       swap does that through the ordinary chain. */
    await _notifyP1Changed({ employeeId, p1TaskId: newP1TaskId, cause: null }).catch(() => {});

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
  _closeRankGaps,
  _notifyP1Changed,
  restoreUnblockedDeadlines,
  listOutputIndex,
  setTaskOutputs,
  submitOutput,
  reviewOutput,
  declineAssignment,
  setActiveTaskBudget,
  validateReworkRequirements,
  readReworkAttachments,
  readReworkAttachmentIds,
  nextActiveRankFor,
  assigneePrioritiesFor,
  createTask,
  createParentTask: createTask,
  confirmTaskReceipt,
  markTaskStarted,
  forwardTask,
  getForwardBudget,
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

