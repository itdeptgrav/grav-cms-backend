/**
 * GRAV-CMS-BACKEND/services/taskTree.service.js
 *
 * Unlimited nested tasks — each task/subtask has its own chat + daily reports.
 * Firestore structure:
 *   cowork_tasks/{taskId}          ← task doc
 *   cowork_tasks/{taskId}/chat     ← subcollection: messages for THIS task only
 *   cowork_tasks/{taskId}/reports  ← subcollection: daily reports for THIS task only
 *
 * Parent-child via: task.parentId (null = root task)
 */

const { admin, db } = require("../config/firebaseAdmin");
const { v4: uuidv4 } = require("uuid");

const ts = () => admin.firestore.FieldValue.serverTimestamp();
const arrUnion = (...a) => admin.firestore.FieldValue.arrayUnion(...a);
const arrRemove = (...a) => admin.firestore.FieldValue.arrayRemove(...a);

// ─── ID helpers ───────────────────────────────────────────────────────────────
const makeTaskId = () => `TASK-${uuidv4().substring(0, 8).toUpperCase()}`;

// ─── Get depth / breadcrumb ───────────────────────────────────────────────────
const getBreadcrumb = async (taskId) => {
    const crumbs = [];
    let currentId = taskId;
    let safety = 0;
    while (currentId && safety < 15) {
        const snap = await db.collection("cowork_tasks").doc(currentId).get();
        if (!snap.exists) break;
        const d = snap.data();
        crumbs.unshift({ id: currentId, title: d.title });
        currentId = d.parentId || null;
        safety++;
    }
    return crumbs;
};

// ═══════════════════════════════════════════════════════════════════════════════
// TASK CRUD
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a task (parentId = null → root task, otherwise nested subtask)
 */
const createTask = async (creatorId, data) => {
    const taskId = makeTaskId();
    const creator = await db.collection("cowork_employees").doc(creatorId).get();
    const creatorName = creator.exists ? creator.data().name : "Unknown";

    const task = {
        id: taskId,
        title: data.title,
        description: data.description || "",
        priority: data.priority || "medium",
        status: "assigned",
        completionStatus: null,
        deadline: data.deadline || null,
        deadlineHistory: [],
        parentId: data.parentId || null,          // null = root task
        depth: data.depth || 0,                   // 0 = root, 1 = subtask, 2 = sub-subtask …
        childIds: [],                             // direct children
        assignedTo: data.assignedTo || null,
        assignedToName: data.assignedToName || "",
        createdBy: creatorId,
        createdByName: creatorName,
        createdAt: ts(),
        updatedAt: ts(),
    };

    await db.collection("cowork_tasks").doc(taskId).set(task);

    // Register as child of parent
    if (data.parentId) {
        await db.collection("cowork_tasks").doc(data.parentId).update({
            childIds: arrUnion(taskId),
            updatedAt: ts(),
        });
    }

    return { success: true, taskId };
};

/**
 * Get a single task doc (no subtree)
 */
const getTask = async (taskId) => {
    const snap = await db.collection("cowork_tasks").doc(taskId).get();
    if (!snap.exists) throw new Error("Task not found");
    return { id: snap.id, ...snap.data() };
};

/**
 * Get task + full descendant tree (recursive)
 */
const getTaskTree = async (taskId) => {
    const snap = await db.collection("cowork_tasks").doc(taskId).get();
    if (!snap.exists) throw new Error("Task not found");
    const task = { id: snap.id, ...snap.data(), children: [] };

    if (task.childIds && task.childIds.length > 0) {
        task.children = await Promise.all(task.childIds.map(getTaskTree));
    }
    return task;
};

/**
 * List all root tasks visible to a user
 */
const listRootTasks = async (userId, userRole) => {
    let snap;
    if (userRole === "ceo") {
        snap = await db.collection("cowork_tasks").where("parentId", "==", null).get();
    } else {
        // TL / employee: only tasks assigned to them OR where they created
        snap = await db.collection("cowork_tasks").where("parentId", "==", null).get();
    }

    let tasks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    if (userRole !== "ceo") {
        // Filter to tasks user can see
        const allVisible = await getVisibleTaskIds(userId);
        tasks = tasks.filter(
            (t) => allVisible.has(t.id) || t.assignedTo === userId || t.createdBy === userId
        );
    }

    return tasks;
};

/**
 * Collect all task IDs visible to a non-CEO user (assigned or created)
 */
const getVisibleTaskIds = async (userId) => {
    const [assigned, created] = await Promise.all([
        db.collection("cowork_tasks").where("assignedTo", "==", userId).get(),
        db.collection("cowork_tasks").where("createdBy", "==", userId).get(),
    ]);
    const ids = new Set();
    [...assigned.docs, ...created.docs].forEach((d) => ids.add(d.id));
    return ids;
};

/**
 * Update task fields (title, description, priority, status, assignedTo)
 */
const updateTask = async (taskId, updates) => {
    const allowed = ["title", "description", "priority", "status", "assignedTo", "assignedToName"];
    const clean = {};
    allowed.forEach((k) => { if (updates[k] !== undefined) clean[k] = updates[k]; });
    clean.updatedAt = ts();
    await db.collection("cowork_tasks").doc(taskId).update(clean);
    return { success: true };
};

/**
 * Edit deadline with mandatory reason
 */
const editDeadline = async (taskId, newDeadline, reason, editorId) => {
    const snap = await db.collection("cowork_tasks").doc(taskId).get();
    if (!snap.exists) throw new Error("Task not found");
    const old = snap.data().deadline;

    await db.collection("cowork_tasks").doc(taskId).update({
        deadline: newDeadline,
        deadlineHistory: arrUnion({ oldDeadline: old, newDeadline, reason, changedBy: editorId, changedAt: new Date().toISOString() }),
        updatedAt: ts(),
    });

    // System message in this task's chat
    await _postSystemMsg(taskId, editorId, `📅 Deadline changed to ${newDeadline}. Reason: ${reason}`);
    return { success: true };
};

/**
 * Delete task + all descendants + their chats + reports (recursive)
 */
const deleteTaskCascade = async (taskId) => {
    const snap = await db.collection("cowork_tasks").doc(taskId).get();
    if (!snap.exists) return;
    const task = snap.data();

    // Delete children first
    if (task.childIds && task.childIds.length > 0) {
        await Promise.all(task.childIds.map(deleteTaskCascade));
    }

    // Delete chat subcollection
    await _deleteSubcollection(`cowork_tasks/${taskId}/chat`);
    // Delete reports subcollection
    await _deleteSubcollection(`cowork_tasks/${taskId}/reports`);

    // Remove from parent's childIds
    if (task.parentId) {
        await db.collection("cowork_tasks").doc(task.parentId).update({
            childIds: arrRemove(taskId),
        }).catch(() => { });
    }

    await db.collection("cowork_tasks").doc(taskId).delete();
};

const _deleteSubcollection = async (path) => {
    const snap = await db.collection(path).limit(100).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    if (snap.docs.length === 100) await _deleteSubcollection(path); // recurse if more
};

// ═══════════════════════════════════════════════════════════════════════════════
// TASK-SPECIFIC CHAT (each task has its own subcollection)
// ═══════════════════════════════════════════════════════════════════════════════

const sendChatMessage = async (taskId, senderId, msgData) => {
    const sender = await db.collection("cowork_employees").doc(senderId).get();
    const msgId = uuidv4();

    const msg = {
        id: msgId,
        senderId,
        senderName: sender.exists ? sender.data().name : "Unknown",
        senderRole: sender.exists ? sender.data().role : "",
        senderAvatar: sender.exists ? sender.data().photoUrl || null : null,
        type: msgData.type || "text",       // text | image | pdf | voice
        text: msgData.text || "",
        mediaUrl: msgData.mediaUrl || null, // Cloudinary URL (image/voice)
        pdfUrl: msgData.pdfUrl || null,     // Google Drive URL
        pdfFileName: msgData.pdfFileName || null,
        voiceDuration: msgData.voiceDuration || null,
        createdAt: ts(),
    };

    await db.collection("cowork_tasks").doc(taskId).collection("chat").doc(msgId).set(msg);
    await db.collection("cowork_tasks").doc(taskId).update({ lastChatAt: ts() });
    return { success: true, messageId: msgId };
};

const getChatMessages = async (taskId, limit = 100) => {
    const snap = await db
        .collection("cowork_tasks").doc(taskId)
        .collection("chat")
        .orderBy("createdAt", "asc")
        .limitToLast(limit)
        .get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
};

const _postSystemMsg = async (taskId, senderId, text) => {
    const msgId = uuidv4();
    await db.collection("cowork_tasks").doc(taskId).collection("chat").doc(msgId).set({
        id: msgId,
        senderId,
        senderName: "System",
        senderRole: "system",
        type: "system",
        text,
        createdAt: ts(),
    });
};

// ═══════════════════════════════════════════════════════════════════════════════
// DAILY REPORTS (each task has its own reports subcollection)
// ═══════════════════════════════════════════════════════════════════════════════

const submitDailyReport = async (taskId, submitterId, reportData) => {
    const submitter = await db.collection("cowork_employees").doc(submitterId).get();
    const reportId = uuidv4();

    const report = {
        id: reportId,
        taskId,
        submitterId,
        submitterName: submitter.exists ? submitter.data().name : "Unknown",
        submitterRole: submitter.exists ? submitter.data().role : "",
        date: reportData.date || new Date().toISOString().split("T")[0],
        progress: reportData.progress || 0,          // 0-100
        workDone: reportData.workDone || "",
        blockers: reportData.blockers || "",
        images: reportData.images || [],              // [{url, name}]
        pdfs: reportData.pdfs || [],                  // [{url, name, fileId}]
        createdAt: ts(),
    };

    await db.collection("cowork_tasks").doc(taskId).collection("reports").doc(reportId).set(report);

    // Update task status to in_progress if still assigned
    const taskSnap = await db.collection("cowork_tasks").doc(taskId).get();
    if (taskSnap.exists && taskSnap.data().status === "confirmed") {
        await db.collection("cowork_tasks").doc(taskId).update({ status: "in_progress", updatedAt: ts() });
    }

    // System message
    await _postSystemMsg(taskId, submitterId, `📊 ${submitter.exists ? submitter.data().name : "Someone"} submitted a daily report (${reportData.progress || 0}% progress)`);

    return { success: true, reportId };
};

const getDailyReports = async (taskId, requesterId, requesterRole) => {
    const snap = await db
        .collection("cowork_tasks").doc(taskId)
        .collection("reports")
        .orderBy("createdAt", "desc")
        .get();

    let reports = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // Employee: only their own reports
    if (requesterRole === "employee") {
        reports = reports.filter((r) => r.submitterId === requesterId);
    }

    return reports;
};

// ═══════════════════════════════════════════════════════════════════════════════
// TASK STATUS TRANSITIONS
// ═══════════════════════════════════════════════════════════════════════════════

const confirmTask = async (taskId, userId) => {
    await db.collection("cowork_tasks").doc(taskId).update({ status: "confirmed", updatedAt: ts() });
    await _postSystemMsg(taskId, userId, "✅ Task confirmed by assignee");
    return { success: true };
};

const startTask = async (taskId, userId) => {
    await db.collection("cowork_tasks").doc(taskId).update({ status: "in_progress", updatedAt: ts() });
    await _postSystemMsg(taskId, userId, "▶️ Task started");
    return { success: true };
};

// ═══════════════════════════════════════════════════════════════════════════════
// COMPLETION VERIFICATION (3-step: employee → TL → CEO)
// ═══════════════════════════════════════════════════════════════════════════════

const submitCompletionProof = async (taskId, employeeId, proofData) => {
    const emp = await db.collection("cowork_employees").doc(employeeId).get();
    const empName = emp.exists ? emp.data().name : "Unknown";

    await db.collection("cowork_tasks").doc(taskId).update({
        completionStatus: "pending_tl_review",
        completionProof: {
            submittedBy: employeeId,
            submittedByName: empName,
            submittedAt: new Date().toISOString(),
            images: proofData.images || [],
            pdfs: proofData.pdfs || [],
            notes: proofData.notes || "",
        },
        updatedAt: ts(),
    });
    await _postSystemMsg(taskId, employeeId, `✅ ${empName} submitted work for completion review`);
    return { success: true };
};

const tlReviewCompletion = async (taskId, tlId, decision, rejectionReason) => {
    const tl = await db.collection("cowork_employees").doc(tlId).get();
    const tlName = tl.exists ? tl.data().name : "TL";

    if (decision === "approve") {
        await db.collection("cowork_tasks").doc(taskId).update({
            completionStatus: "pending_ceo_review",
            tlApproval: { approvedBy: tlId, approvedByName: tlName, approvedAt: new Date().toISOString() },
            updatedAt: ts(),
        });
        await _postSystemMsg(taskId, tlId, "✅ TL approved. Sent to CEO for final review.");
    } else {
        await db.collection("cowork_tasks").doc(taskId).update({
            completionStatus: "rejected_by_tl",
            status: "in_progress",
            tlRejection: { rejectedBy: tlId, rejectedByName: tlName, reason: rejectionReason || "Not meeting requirements", rejectedAt: new Date().toISOString() },
            updatedAt: ts(),
        });
        await _postSystemMsg(taskId, tlId, `❌ TL rejected. Reason: ${rejectionReason}. Task back to In Progress.`);
    }
    return { success: true };
};

const ceoReviewCompletion = async (taskId, ceoId, decision, rejectionReason) => {
    if (decision === "approve") {
        await db.collection("cowork_tasks").doc(taskId).update({
            completionStatus: "completed",
            status: "completed",
            ceoApproval: { approvedBy: ceoId, approvedAt: new Date().toISOString() },
            updatedAt: ts(),
        });
        await _postSystemMsg(taskId, ceoId, "🎉 CEO approved! Task marked as COMPLETED.");
    } else {
        await db.collection("cowork_tasks").doc(taskId).update({
            completionStatus: "rejected_by_ceo",
            status: "in_progress",
            ceoRejection: { rejectedBy: ceoId, reason: rejectionReason, rejectedAt: new Date().toISOString() },
            updatedAt: ts(),
        });
        await _postSystemMsg(taskId, ceoId, `❌ CEO rejected. Reason: ${rejectionReason}. Task back to In Progress.`);
    }
    return { success: true };
};

// ═══════════════════════════════════════════════════════════════════════════════
// FORWARD / ASSIGN
// ═══════════════════════════════════════════════════════════════════════════════

const forwardTask = async (taskId, fromId, toId, notes) => {
    const toUser = await db.collection("cowork_employees").doc(toId).get();
    const toName = toUser.exists ? toUser.data().name : "Unknown";

    await db.collection("cowork_tasks").doc(taskId).update({
        assignedTo: toId,
        assignedToName: toName,
        status: "assigned",
        updatedAt: ts(),
    });
    await _postSystemMsg(taskId, fromId, `↗️ Task forwarded to ${toName}${notes ? `. Note: ${notes}` : ""}`);
    return { success: true };
};

module.exports = {
    createTask,
    getTask,
    getTaskTree,
    listRootTasks,
    updateTask,
    editDeadline,
    deleteTaskCascade,
    getBreadcrumb,
    sendChatMessage,
    getChatMessages,
    submitDailyReport,
    getDailyReports,
    confirmTask,
    startTask,
    submitCompletionProof,
    tlReviewCompletion,
    ceoReviewCompletion,
    forwardTask,
};