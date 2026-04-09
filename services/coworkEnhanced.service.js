/**
 * GRAV-CMS-BACKEND/services/coworkEnhanced.service.js
 * Handles: DMs, task chat, subtasks, task completion verification, deadline edit, delete task
 */

const { admin, db } = require("../config/firebaseAdmin");
const { v4: uuidv4 } = require("uuid");

const serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp();
const arrayUnion = (...args) => admin.firestore.FieldValue.arrayUnion(...args);

// ═══════════════════════════════════════════════════════════════════
// DIRECT MESSAGES
// ═══════════════════════════════════════════════════════════════════

/**
 * Get or create a DM conversation between two users
 */
const getOrCreateConversation = async (userId, targetUserId) => {
    const ids = [userId, targetUserId].sort();
    const convId = `conv_${ids[0]}_${ids[1]}`;

    const convRef = db.collection("cowork_conversations").doc(convId);
    const convSnap = await convRef.get();

    if (!convSnap.exists) {
        const targetUser = await db.collection("cowork_employees").doc(targetUserId).get();
        const currentUser = await db.collection("cowork_employees").doc(userId).get();

        await convRef.set({
            id: convId,
            participants: ids,
            participantDetails: {
                [userId]: currentUser.exists ? { name: currentUser.data().name, role: currentUser.data().role, avatar: currentUser.data().photoUrl || null } : {},
                [targetUserId]: targetUser.exists ? { name: targetUser.data().name, role: targetUser.data().role, avatar: targetUser.data().photoUrl || null } : {},
            },
            lastMessage: null,
            lastMessageAt: null,
            createdAt: serverTimestamp(),
        });
    }

    return convId;
};

/**
 * List all conversations for a user
 */
const listConversations = async (userId) => {
    const snap = await db
        .collection("cowork_conversations")
        .where("participants", "array-contains", userId)
        .orderBy("lastMessageAt", "desc")
        .get();

    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
};

/**
 * Send a DM message (text / image / pdf / voice)
 */
const sendDirectMessage = async (conversationId, senderId, messageData) => {
    const convRef = db.collection("cowork_conversations").doc(conversationId);
    const convSnap = await convRef.get();
    if (!convSnap.exists) throw new Error("Conversation not found");

    const conv = convSnap.data();
    if (!conv.participants.includes(senderId)) throw new Error("Not a participant");

    const msgId = uuidv4();
    const msgRef = db
        .collection("cowork_conversations")
        .doc(conversationId)
        .collection("messages")
        .doc(msgId);

    const sender = await db.collection("cowork_employees").doc(senderId).get();

    const message = {
        id: msgId,
        senderId,
        senderName: sender.exists ? sender.data().name : "Unknown",
        senderRole: sender.exists ? sender.data().role : "",
        type: messageData.type || "text", // text | image | pdf | voice
        text: messageData.text || "",
        mediaUrl: messageData.mediaUrl || null,       // Cloudinary URL for image/voice
        pdfUrl: messageData.pdfUrl || null,           // Google Drive URL for PDF
        pdfFileId: messageData.pdfFileId || null,
        pdfFileName: messageData.pdfFileName || null,
        voiceDuration: messageData.voiceDuration || null,
        status: "sent",
        createdAt: serverTimestamp(),
    };

    await msgRef.set(message);

    // Update conversation last message
    await convRef.update({
        lastMessage: messageData.type === "text" ? messageData.text : `[${messageData.type}]`,
        lastMessageAt: serverTimestamp(),
    });

    return { success: true, messageId: msgId };
};

/**
 * Get messages for a conversation (paginated)
 */
const getConversationMessages = async (conversationId, userId, limit = 50) => {
    const convRef = db.collection("cowork_conversations").doc(conversationId);
    const convSnap = await convRef.get();
    if (!convSnap.exists) throw new Error("Conversation not found");
    if (!convSnap.data().participants.includes(userId)) throw new Error("Not a participant");

    const snap = await convRef
        .collection("messages")
        .orderBy("createdAt", "asc")
        .limitToLast(limit)
        .get();

    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
};

/**
 * List all employees (for CEO to start new DMs, and for employees too)
 */
const listAllEmployees = async (currentUserId) => {
    const snap = await db.collection("cowork_employees").get();
    return snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((e) => e.id !== currentUserId);
};

// ═══════════════════════════════════════════════════════════════════
// GROUP CHAT MESSAGES
// ═══════════════════════════════════════════════════════════════════

const sendGroupMessage = async (groupId, senderId, messageData) => {
    const groupRef = db.collection("cowork_groups").doc(groupId);
    const groupSnap = await groupRef.get();
    if (!groupSnap.exists) throw new Error("Group not found");

    const sender = await db.collection("cowork_employees").doc(senderId).get();
    const msgId = uuidv4();

    const message = {
        id: msgId,
        senderId,
        senderName: sender.exists ? sender.data().name : "Unknown",
        senderRole: sender.exists ? sender.data().role : "",
        type: messageData.type || "text",
        text: messageData.text || "",
        mediaUrl: messageData.mediaUrl || null,
        pdfUrl: messageData.pdfUrl || null,
        pdfFileId: messageData.pdfFileId || null,
        pdfFileName: messageData.pdfFileName || null,
        voiceDuration: messageData.voiceDuration || null,
        createdAt: serverTimestamp(),
    };

    await groupRef.collection("messages").doc(msgId).set(message);
    await groupRef.update({
        lastMessage: messageData.type === "text" ? messageData.text : `[${messageData.type}]`,
        lastMessageAt: serverTimestamp(),
    });

    return { success: true, messageId: msgId };
};

const getGroupMessages = async (groupId, limit = 50) => {
    const snap = await db
        .collection("cowork_groups")
        .doc(groupId)
        .collection("messages")
        .orderBy("createdAt", "asc")
        .limitToLast(limit)
        .get();

    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
};

// ═══════════════════════════════════════════════════════════════════
// TASK CHAT (inside a task — with @mention support)
// ═══════════════════════════════════════════════════════════════════

const sendTaskChatMessage = async (taskId, senderId, messageData) => {
    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const taskSnap = await taskRef.get();
    if (!taskSnap.exists) throw new Error("Task not found");

    const sender = await db.collection("cowork_employees").doc(senderId).get();
    const msgId = uuidv4();

    const message = {
        id: msgId,
        senderId,
        senderName: sender.exists ? sender.data().name : "Unknown",
        senderRole: sender.exists ? sender.data().role : "",
        type: messageData.type || "text", // text | image | pdf | voice
        text: messageData.text || "",
        mediaUrl: messageData.mediaUrl || null,
        pdfUrl: messageData.pdfUrl || null,
        pdfFileId: messageData.pdfFileId || null,
        pdfFileName: messageData.pdfFileName || null,
        voiceDuration: messageData.voiceDuration || null,
        // @mention fields
        mentionType: messageData.mentionType || null,   // "task" | "subtask"
        mentionId: messageData.mentionId || null,        // taskId or subtaskId
        mentionLabel: messageData.mentionLabel || null,  // display name
        createdAt: serverTimestamp(),
    };

    await taskRef.collection("chat").doc(msgId).set(message);
    await taskRef.update({ lastChatAt: serverTimestamp() });

    return { success: true, messageId: msgId };
};

const getTaskChatMessages = async (taskId, limit = 100) => {
    const snap = await db
        .collection("cowork_tasks")
        .doc(taskId)
        .collection("chat")
        .orderBy("createdAt", "asc")
        .limitToLast(limit)
        .get();

    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
};

// ═══════════════════════════════════════════════════════════════════
// SUBTASKS
// ═══════════════════════════════════════════════════════════════════

const createSubtask = async (parentTaskId, ceoId, subtaskData) => {
    const parentRef = db.collection("cowork_tasks").doc(parentTaskId);
    const parentSnap = await parentRef.get();
    if (!parentSnap.exists) throw new Error("Parent task not found");

    const subtaskId = `SUBTASK-${uuidv4().substring(0, 6).toUpperCase()}`;
    const subtaskRef = db.collection("cowork_tasks").doc(subtaskId);

    const subtask = {
        id: subtaskId,
        type: "subtask",
        parentTaskId,
        title: subtaskData.title,
        description: subtaskData.description || "",
        assignedTo: subtaskData.assignedTo, // TL uid
        assignedToName: subtaskData.assignedToName || "",
        priority: subtaskData.priority || "medium",
        deadline: subtaskData.deadline || null,
        createdBy: ceoId,
        status: "assigned",
        completionStatus: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
    };

    await subtaskRef.set(subtask);

    // Add subtask reference to parent
    await parentRef.update({
        subtaskIds: arrayUnion(subtaskId),
        updatedAt: serverTimestamp(),
    });

    return { success: true, subtaskId };
};

const getSubtasksForTask = async (parentTaskId) => {
    const snap = await db
        .collection("cowork_tasks")
        .where("parentTaskId", "==", parentTaskId)
        .where("type", "==", "subtask")
        .get();

    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
};

// ═══════════════════════════════════════════════════════════════════
// TASK DEADLINE EDIT + DELETE
// ═══════════════════════════════════════════════════════════════════

const editTaskDeadline = async (taskId, ceoId, newDeadline, reason) => {
    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const taskSnap = await taskRef.get();
    if (!taskSnap.exists) throw new Error("Task not found");

    const oldDeadline = taskSnap.data().deadline;

    await taskRef.update({
        deadline: newDeadline,
        updatedAt: serverTimestamp(),
        deadlineHistory: arrayUnion({
            oldDeadline,
            newDeadline,
            reason,
            changedBy: ceoId,
            changedAt: new Date().toISOString(),
        }),
    });

    // Post system message in task chat
    const msgId = uuidv4();
    await taskRef.collection("chat").doc(msgId).set({
        id: msgId,
        senderId: ceoId,
        senderName: "CEO",
        senderRole: "ceo",
        type: "system",
        text: `📅 Deadline changed to ${newDeadline}. Reason: ${reason}`,
        mentionType: "task",
        mentionId: taskId,
        createdAt: serverTimestamp(),
    });

    return { success: true };
};

const deleteTask = async (taskId, ceoId) => {
    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const taskSnap = await taskRef.get();
    if (!taskSnap.exists) throw new Error("Task not found");

    const task = taskSnap.data();

    // Delete all subtasks
    if (task.subtaskIds && task.subtaskIds.length > 0) {
        const batch = db.batch();
        for (const subtaskId of task.subtaskIds) {
            batch.delete(db.collection("cowork_tasks").doc(subtaskId));
        }
        await batch.commit();
    }

    // Delete task chat messages
    const chatSnap = await taskRef.collection("chat").get();
    const chatBatch = db.batch();
    chatSnap.docs.forEach((d) => chatBatch.delete(d.ref));
    await chatBatch.commit();

    await taskRef.delete();
    return { success: true };
};

// ═══════════════════════════════════════════════════════════════════
// TASK LIST — only main tasks (no subtasks in list)
// ═══════════════════════════════════════════════════════════════════

const listMainTasks = async (userId, userRole) => {
    let query = db.collection("cowork_tasks").where("type", "!=", "subtask");

    const snap = await query.get();
    let tasks = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((t) => t.type !== "subtask"); // extra safety

    // Filter by role
    if (userRole === "ceo") {
        // CEO sees all
    } else if (userRole === "tl") {
        tasks = tasks.filter((t) => t.assignedTo === userId || t.createdBy === userId);
    } else {
        tasks = tasks.filter(
            (t) =>
                t.assignedTo === userId ||
                (t.forwardedTo && t.forwardedTo.some && t.forwardedTo.some((f) => f.employeeId === userId))
        );
    }

    return tasks;
};

const getTaskWithSubtasks = async (taskId) => {
    const taskSnap = await db.collection("cowork_tasks").doc(taskId).get();
    if (!taskSnap.exists) throw new Error("Task not found");

    const task = { id: taskSnap.id, ...taskSnap.data() };

    // Fetch subtasks
    const subtasks = await getSubtasksForTask(taskId);
    task.subtasks = subtasks;

    return task;
};

// ═══════════════════════════════════════════════════════════════════
// TASK COMPLETION VERIFICATION FLOW
// ═══════════════════════════════════════════════════════════════════

/**
 * Step 1: Employee submits completion proof
 */
const submitCompletionProof = async (taskId, employeeId, proofData) => {
    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const taskSnap = await taskRef.get();
    if (!taskSnap.exists) throw new Error("Task not found");

    const employee = await db.collection("cowork_employees").doc(employeeId).get();

    await taskRef.update({
        completionStatus: "pending_tl_review",
        completionProof: {
            submittedBy: employeeId,
            submittedByName: employee.exists ? employee.data().name : "Unknown",
            submittedAt: new Date().toISOString(),
            images: proofData.images || [],
            pdfs: proofData.pdfs || [],
            notes: proofData.notes || "",
        },
        updatedAt: serverTimestamp(),
    });

    // Post in task chat
    const msgId = uuidv4();
    await taskRef.collection("chat").doc(msgId).set({
        id: msgId,
        senderId: employeeId,
        senderName: employee.exists ? employee.data().name : "Unknown",
        senderRole: "employee",
        type: "system",
        text: `✅ ${employee.exists ? employee.data().name : "Employee"} submitted work for completion review.`,
        createdAt: serverTimestamp(),
    });

    return { success: true };
};

/**
 * Step 2: TL approves or rejects
 */
const tlReviewCompletion = async (taskId, tlId, decision, rejectionReason) => {
    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const taskSnap = await taskRef.get();
    if (!taskSnap.exists) throw new Error("Task not found");

    const tl = await db.collection("cowork_employees").doc(tlId).get();
    const tlName = tl.exists ? tl.data().name : "TL";

    if (decision === "approve") {
        await taskRef.update({
            completionStatus: "pending_ceo_review",
            tlApproval: {
                approvedBy: tlId,
                approvedByName: tlName,
                approvedAt: new Date().toISOString(),
            },
            updatedAt: serverTimestamp(),
        });

        const msgId = uuidv4();
        await taskRef.collection("chat").doc(msgId).set({
            id: msgId,
            senderId: tlId,
            senderName: tlName,
            senderRole: "tl",
            type: "system",
            text: `✅ TL approved. Sent to CEO for final review.`,
            createdAt: serverTimestamp(),
        });
    } else {
        await taskRef.update({
            completionStatus: "rejected_by_tl",
            status: "in_progress",
            tlRejection: {
                rejectedBy: tlId,
                rejectedByName: tlName,
                rejectedAt: new Date().toISOString(),
                reason: rejectionReason || "Not meeting requirements",
            },
            updatedAt: serverTimestamp(),
        });

        const msgId = uuidv4();
        await taskRef.collection("chat").doc(msgId).set({
            id: msgId,
            senderId: tlId,
            senderName: tlName,
            senderRole: "tl",
            type: "system",
            text: `❌ TL rejected completion. Reason: ${rejectionReason || "Not meeting requirements"}. Task set back to In Progress.`,
            createdAt: serverTimestamp(),
        });
    }

    return { success: true };
};

/**
 * Step 3: CEO final approval
 */
const ceoReviewCompletion = async (taskId, ceoId, decision, rejectionReason) => {
    const taskRef = db.collection("cowork_tasks").doc(taskId);
    const taskSnap = await taskRef.get();
    if (!taskSnap.exists) throw new Error("Task not found");

    if (decision === "approve") {
        await taskRef.update({
            completionStatus: "completed",
            status: "completed",
            ceoApproval: {
                approvedBy: ceoId,
                approvedAt: new Date().toISOString(),
            },
            updatedAt: serverTimestamp(),
        });

        const msgId = uuidv4();
        await taskRef.collection("chat").doc(msgId).set({
            id: msgId,
            senderId: ceoId,
            senderName: "CEO",
            senderRole: "ceo",
            type: "system",
            text: `🎉 CEO approved. Task marked as COMPLETED!`,
            createdAt: serverTimestamp(),
        });
    } else {
        await taskRef.update({
            completionStatus: "rejected_by_ceo",
            status: "in_progress",
            ceoRejection: {
                rejectedBy: ceoId,
                rejectedAt: new Date().toISOString(),
                reason: rejectionReason || "Does not meet CEO standards",
            },
            updatedAt: serverTimestamp(),
        });

        const msgId = uuidv4();
        await taskRef.collection("chat").doc(msgId).set({
            id: msgId,
            senderId: ceoId,
            senderName: "CEO",
            senderRole: "ceo",
            type: "system",
            text: `❌ CEO rejected. Reason: ${rejectionReason}. Task set back to In Progress.`,
            createdAt: serverTimestamp(),
        });
    }

    return { success: true };
};

module.exports = {
    getOrCreateConversation,
    listConversations,
    sendDirectMessage,
    getConversationMessages,
    listAllEmployees,
    sendGroupMessage,
    getGroupMessages,
    sendTaskChatMessage,
    getTaskChatMessages,
    createSubtask,
    getSubtasksForTask,
    editTaskDeadline,
    deleteTask,
    listMainTasks,
    getTaskWithSubtasks,
    submitCompletionProof,
    tlReviewCompletion,
    ceoReviewCompletion,
};