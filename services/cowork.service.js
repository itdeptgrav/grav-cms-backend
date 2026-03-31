const { admin, db, auth, messaging, rtdb } = require("../config/firebaseAdmin");
const socket = require("../config/socketInstance");
const { v4: uuidv4 } = require("uuid");

// ── ID Generator ─────────────────────────────────────────
async function generateCoworkId(type) {
  const map = { employee: ["E", "employeeSeq"], group: ["G", "groupSeq"], task: ["T", "taskSeq"], meet: ["M", "meetSeq"] };
  const [prefix, field] = map[type];
  const ref = db.collection("cowork_meta").doc("counters");
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const next = (snap.exists ? snap.data()[field] || 0 : 0) + 1;
    tx.set(ref, { [field]: next }, { merge: true });
    return `${prefix}${String(next).padStart(3, "0")}`;
  });
}

// ── Sync to Realtime Database ───────────────────────────
async function syncToRTDB(collection, docId, data) {
  try {
    await rtdb.ref(`cowork/${collection}/${docId}`).set({
      ...data,
      _syncedAt: admin.database.ServerValue.TIMESTAMP
    });
  } catch (error) {
    console.error(`RTDB sync error for ${collection}/${docId}:`, error);
  }
}

async function syncToRTDBWithExpiry(collection, docId, data, ttlHours = 24) {
  try {
    const expiryTime = Date.now() + (ttlHours * 60 * 60 * 1000);
    await rtdb.ref(`cowork/${collection}/${docId}`).set({
      ...data,
      _syncedAt: admin.database.ServerValue.TIMESTAMP,
      _expiresAt: expiryTime
    });
  } catch (error) {
    console.error(`RTDB sync error for ${collection}/${docId}:`, error);
  }
}

// ── EMPLOYEE ─────────────────────────────────────────────
// ── REPLACE this function in services/cowork.service.js ──────────────────────
async function createCoworkEmployee({ name, email, mobile, city, department, role = "employee" }) {
  const { auth, db, admin } = require("../config/firebaseAdmin");

  // Validate role
  const resolvedRole = role === "tl" ? "tl" : "employee";

  // Generate employee ID
  const counterRef = db.collection("cowork_meta").doc("counters");
  const empId = await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const seq = (snap.data()?.employeeSeq || 0) + 1;
    tx.update(counterRef, { employeeSeq: seq });
    return `E${String(seq).padStart(3, "0")}`;
  });

  // Generate temp password
  const tempPassword = Math.random().toString(36).slice(-8) + Math.random().toString(36).slice(-4).toUpperCase();

  // Create Firebase Auth user
  let ur;
  try {
    ur = await auth.createUser({ email, password: tempPassword, displayName: name });
  } catch (e) {
    if (e.code === "auth/email-already-exists") {
      ur = await auth.getUserByEmail(email);
    } else {
      throw e;
    }
  }

  // Set custom claim with role (employee or tl)
  await auth.setCustomUserClaims(ur.uid, { role: resolvedRole });

  // Store in Firestore
  await db.collection("cowork_employees").doc(empId).set({
    employeeId: empId,
    authUid: ur.uid,
    name,
    email,
    mobile,
    city,
    department,
    role: resolvedRole,        // "employee" | "tl"
    profilePicUrl: null,
    fcmTokens: [],
    passwordChanged: false,
    tempPassword,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { employeeId: empId, tempPassword, role: resolvedRole };
}


// ── CHANGE EMPLOYEE PASSWORD ────────────────────────────
async function changeEmployeePassword({ employeeId, authUid, newPassword }) {
  if (newPassword.length < 6) throw new Error("Password must be at least 6 characters.");

  // Update Firebase Auth password
  await auth.updateUser(authUid, { password: newPassword });

  // Update Firestore — clear tempPassword, mark changed
  await db.collection("cowork_employees").doc(employeeId).update({
    tempPassword: null,
    passwordChanged: true,
    passwordUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Update Realtime Database
  await rtdb.ref(`cowork/employees/${employeeId}`).update({
    passwordChanged: true,
    tempPassword: null,
    passwordUpdatedAt: new Date().toISOString()
  });

  return { success: true };
}

async function listCoworkEmployees() {
  const snap = await db.collection("cowork_employees").orderBy("createdAt", "desc").get();
  return snap.docs.map(d => {
    const data = { id: d.id, ...d.data() };
    // Never send the stored password to list endpoint
    delete data.tempPassword;
    return data;
  });
}

async function getCoworkEmployee(employeeId) {
  try {
    const doc = await db.collection("cowork_employees").doc(employeeId).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
  } catch (error) {
    console.error("Error getting employee:", error);
    return null;
  }
}

async function saveFCMToken(employeeId, token) {
  await db.collection("cowork_employees").doc(employeeId).update({
    fcmTokens: admin.firestore.FieldValue.arrayUnion(token)
  });
  await rtdb.ref(`cowork/employees/${employeeId}/fcmTokens`).push(token);
}


// ── GROUP ─────────────────────────────────────────────────
// Make sure this is exactly how it appears in your file
async function createCoworkGroup({ name, description, memberIds, createdBy, createdByAuthUid }) {
  const groupId = await generateCoworkId("group");
  const data = {
    groupId,
    name,
    description: description || "",
    createdBy,
    createdByAuthUid,
    memberIds,
    deleted: false,
    lastMessage: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  // Save to Firestore
  await db.collection("cowork_groups").doc(groupId).set(data);

  // Sync to Realtime Database
  await syncToRTDB('groups', groupId, {
    ...data,
    createdAt: new Date().toISOString()
  });

  const recipients = memberIds.filter(id => id !== createdBy);
  await _notifyMany({
    recipientIds: recipients,
    type: "group_added",
    title: `Added to: ${name}`,
    body: `You were added to "${name}"`,
    data: { groupId }
  });

  return data;
}

async function deleteCoworkGroup(groupId, requestingEmployeeId) {
  const doc = await db.collection("cowork_groups").doc(groupId).get();
  if (!doc.exists) throw new Error("Group not found.");
  if (doc.data().createdBy !== requestingEmployeeId) throw new Error("Only creator can delete.");

  await db.collection("cowork_groups").doc(groupId).update({ deleted: true });
  await rtdb.ref(`cowork/groups/${groupId}`).update({ deleted: true, deletedAt: new Date().toISOString() });
}

// ── UPDATE GROUP (name / description) ─────────────────────
async function updateCoworkGroup(groupId, requestingEmployeeId, { name, description }) {
  const snap = await db.collection("cowork_groups").doc(groupId).get();
  if (!snap.exists) throw new Error("Group not found.");
  if (snap.data().createdBy !== requestingEmployeeId) throw new Error("Only the creator can edit this group.");
  const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  if (name?.trim()) updates.name = name.trim();
  if (description !== undefined) updates.description = description || "";
  await db.collection("cowork_groups").doc(groupId).update(updates);
  return { ...snap.data(), ...updates };
}

// ── ADD MEMBER ─────────────────────────────────────────────
async function addGroupMember(groupId, requestingEmployeeId, employeeIdToAdd) {
  const snap = await db.collection("cowork_groups").doc(groupId).get();
  if (!snap.exists) throw new Error("Group not found.");
  if (snap.data().createdBy !== requestingEmployeeId) throw new Error("Only the creator can add members.");
  const memberIds = snap.data().memberIds || [];
  if (memberIds.includes(employeeIdToAdd)) throw new Error("Employee is already a member.");
  const updated = [...memberIds, employeeIdToAdd];
  await db.collection("cowork_groups").doc(groupId).update({ memberIds: updated, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  await _notifyMany({ recipientIds: [employeeIdToAdd], type: "group_added", title: `Added to: ${snap.data().name}`, body: `You were added to group "${snap.data().name}"`, data: { groupId } });
  return { memberIds: updated };
}

// ── REMOVE MEMBER ─────────────────────────────────────────
async function removeGroupMember(groupId, requestingEmployeeId, employeeIdToRemove) {
  const snap = await db.collection("cowork_groups").doc(groupId).get();
  if (!snap.exists) throw new Error("Group not found.");
  if (snap.data().createdBy !== requestingEmployeeId) throw new Error("Only the creator can remove members.");
  if (employeeIdToRemove === requestingEmployeeId) throw new Error("Creator cannot be removed.");
  const memberIds = (snap.data().memberIds || []).filter(id => id !== employeeIdToRemove);
  await db.collection("cowork_groups").doc(groupId).update({ memberIds, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  return { memberIds };
}



async function listCoworkGroups(employeeId, role) {
  try {
    console.log(`Listing groups for employee: ${employeeId}, role: ${role}`);

    let query = db.collection("cowork_groups").where("deleted", "==", false);

    // If employee (not CEO), filter groups where they are a member
    if (role !== "ceo") {
      query = query.where("memberIds", "array-contains", employeeId);
    }

    const snap = await query.get();
    console.log(`Found ${snap.size} groups`);

    const groups = await Promise.all(snap.docs.map(async doc => {
      const group = { id: doc.id, ...doc.data() };
      group.memberCount = group.memberIds?.length || 0;

      // Get last message if exists
      const lastMsgSnap = await doc.ref.collection("messages")
        .orderBy("createdAt", "desc")
        .limit(1)
        .get();

      if (!lastMsgSnap.empty) {
        group.lastMessage = lastMsgSnap.docs[0].data();
      }

      return group;
    }));

    return groups;
  } catch (error) {
    console.error("Error listing groups:", error);
    return [];
  }
}

async function getCoworkGroup(groupId) {
  try {
    const doc = await db.collection("cowork_groups").doc(groupId).get();
    if (!doc.exists) return null;

    const group = { id: doc.id, ...doc.data() };

    // Get member details
    if (group.memberIds && group.memberIds.length > 0) {
      const memberPromises = group.memberIds.map(id =>
        db.collection("cowork_employees").doc(id).get()
      );
      const memberDocs = await Promise.all(memberPromises);
      group.members = memberDocs
        .filter(doc => doc.exists)
        .map(doc => ({ id: doc.id, ...doc.data() }));
    }

    return group;
  } catch (error) {
    console.error("Error getting group:", error);
    return null;
  }
}

// ── GROUP MESSAGES ────────────────────────────────────────
async function sendGroupMessage({ groupId, senderId, senderName, text, attachments = [], messageType = "text" }) {
  const groupDoc = await db.collection("cowork_groups").doc(groupId).get();
  if (!groupDoc.exists) throw new Error("Group not found.");
  const group = groupDoc.data();
  if (!group.memberIds.includes(senderId) && group.createdBy !== senderId) throw new Error("Not a member.");

  const messageId = uuidv4();
  const timestamp = admin.firestore.FieldValue.serverTimestamp();
  const isoTime = new Date().toISOString();

  const resolvedType = messageType !== "text" ? messageType
    : attachments.length > 0 ? (attachments[0].type || "image") : "text";

  const msg = {
    messageId, threadType: "group", threadId: groupId, senderId, senderName,
    text: text || "", attachments, messageType: resolvedType,
    type: resolvedType, readBy: [senderId],
    createdAt: timestamp,
  };


  // Save to Firestore
  await db.collection("cowork_groups").doc(groupId).collection("messages").doc(messageId).set(msg);

  // Save to Realtime Database with expiry (24 hours)
  await syncToRTDBWithExpiry('messages', messageId, {
    ...msg,
    createdAt: isoTime,
    groupId,
    senderId,
    senderName,
    text
  }, 24);

  await db.collection("cowork_groups").doc(groupId).update({
    lastMessage: { text, senderId, senderName, sentAt: timestamp }
  });

  const recipients = group.memberIds.filter(id => id !== senderId);

  // Emit to all group members including sender (for immediate display)
  const messageForSocket = { ...msg, createdAt: isoTime };

  // Emit to all group members (including sender to show immediately)
  socket.emitToMany([...recipients, senderId], "new_group_message", {
    groupId,
    message: messageForSocket,
    temp: false
  });

  await _notifyMany({ recipientIds: recipients, type: "group_message", title: `${senderName} in ${group.name}`, body: text.slice(0, 80), data: { groupId, messageId } });
  return msg;
}

async function getGroupMessages(groupId, limit = 60) {
  const snap = await db.collection("cowork_groups").doc(groupId).collection("messages")
    .orderBy("createdAt", "asc").limitToLast(Number(limit)).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ── DIRECT MESSAGES ───────────────────────────────────────
async function sendDirectMessage({ fromEmployeeId, toEmployeeId, senderName, text, attachments = [], messageType = "text" }) {
  const sorted = [fromEmployeeId, toEmployeeId].sort();
  const conversationId = `${sorted[0]}_${sorted[1]}`;
  const convRef = db.collection("cowork_direct_messages").doc(conversationId);

  if (!(await convRef.get()).exists) {
    await convRef.set({
      conversationId,
      participantIds: [fromEmployeeId, toEmployeeId],
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }

  const messageId = uuidv4();
  const timestamp = admin.firestore.FieldValue.serverTimestamp();
  const isoTime = new Date().toISOString();

  // Determine message type from attachments if not provided
  const resolvedType = messageType !== "text" ? messageType
    : attachments.length > 0 ? (attachments[0].type || "image") : "text";

  const msg = {
    messageId, threadType: "direct", threadId: conversationId, senderId: fromEmployeeId,
    senderName, text: text || "", attachments, messageType: resolvedType,
    type: resolvedType, readBy: [fromEmployeeId],
    createdAt: timestamp,
  };

  // Save to Firestore
  await convRef.collection("messages").doc(messageId).set(msg);

  // Save to Realtime Database with expiry
  await syncToRTDBWithExpiry('direct_messages', messageId, {
    ...msg,
    createdAt: isoTime,
    conversationId,
    senderId: fromEmployeeId,
    senderName,
    text
  }, 24);

  await convRef.update({
    lastMessage: { text, senderId: fromEmployeeId, senderName, sentAt: timestamp }
  });

  // Emit to both participants (including sender for immediate display)
  socket.emitToMany([fromEmployeeId, toEmployeeId], "new_direct_message", {
    conversationId,
    message: { ...msg, createdAt: isoTime },
    temp: false
  });

  await _notifyMany({ recipientIds: [toEmployeeId], type: "direct_message", title: `${senderName}`, body: text.slice(0, 80), data: { conversationId, messageId } });
  return { messageData: msg, conversationId };
}

async function getDirectMessages(conversationId, limit = 60) {
  const snap = await db.collection("cowork_direct_messages").doc(conversationId).collection("messages")
    .orderBy("createdAt", "asc").limitToLast(Number(limit)).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function listConversations(employeeId) {
  const snap = await db.collection("cowork_direct_messages").where("participantIds", "array-contains", employeeId).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ── MEETINGS ──────────────────────────────────────────────
async function scheduleCoworkMeet({ title, description, createdBy, participants, dateTime, googleMeetLink }) {
  const meetId = await generateCoworkId("meet");
  const data = {
    meetId, title, description: description || "", createdBy, participants,
    dateTime, googleMeetLink: googleMeetLink || "", isCancelled: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await db.collection("cowork_scheduled_meets").doc(meetId).set(data);

  await syncToRTDB('meets', meetId, {
    ...data,
    createdAt: new Date().toISOString()
  });

  const recipients = participants.filter(id => id !== createdBy);
  socket.emitToMany(recipients, "new_meet", { meetId, title, dateTime, googleMeetLink });
  await _notifyMany({ recipientIds: recipients, type: "meet_scheduled", title: `Meeting: ${title}`, body: new Date(dateTime).toLocaleString("en-IN"), data: { meetId } });
  return data;
}

async function listCoworkMeets(employeeId, role) {
  const snap = role === "ceo"
    ? await db.collection("cowork_scheduled_meets").where("isCancelled", "==", false).get()
    : await db.collection("cowork_scheduled_meets").where("participants", "array-contains", employeeId).where("isCancelled", "==", false).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getCoworkMeet(meetId) {
  const doc = await db.collection("cowork_scheduled_meets").doc(meetId).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

// ── TASKS ─────────────────────────────────────────────────
async function assignCoworkTask({ title, description, assignedBy, assigneeIds, assigneeNames, scopeType, scopeId, dueDate }) {
  const taskId = await generateCoworkId("task");

  // Build assigneeId → name map for storage
  const assigneeNameMap = {};
  if (assigneeNames && typeof assigneeNames === "object") {
    Object.assign(assigneeNameMap, assigneeNames);
  } else if (Array.isArray(assigneeNames)) {
    assigneeIds.forEach((id, i) => { assigneeNameMap[id] = assigneeNames[i] || id; });
  }

  const data = {
    taskId, title, description: description || "", assignedBy, assigneeIds,
    assigneeNameMap, // <-- store names alongside IDs
    scopeType: scopeType || "individual", scopeId: scopeId || assigneeIds[0],
    progressPercent: 0, status: "open", dueDate: dueDate || null, updates: [],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.collection("cowork_tasks").doc(taskId).set(data);

  await syncToRTDB('tasks', taskId, {
    ...data,
    createdAt: new Date().toISOString()
  });

  socket.emitToMany(assigneeIds, "new_task", {
    taskId,
    task: { ...data, createdAt: new Date().toISOString() },
    title,
    assignedBy
  });

  await _notifyMany({
    recipientIds: assigneeIds,
    type: "task_assigned",
    title: `New task: ${title}`,
    body: description?.slice(0, 80) || "New task assigned.",
    data: { taskId }
  });
  return data;
}

async function updateTaskProgress({ taskId, employeeId, progressPercent, note }) {
  const ref = db.collection("cowork_tasks").doc(taskId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Task not found.");
  const task = doc.data();

  let isAuthorized = task.assigneeIds.includes(employeeId);

  if (!isAuthorized && task.scopeType === 'group') {
    const groupDoc = await db.collection("cowork_groups").doc(task.scopeId).get();
    if (groupDoc.exists && groupDoc.data().memberIds.includes(employeeId)) {
      isAuthorized = true;
    }
  }

  if (!isAuthorized) throw new Error("Not authorized to update this task.");

  const status = progressPercent >= 100 ? "done" : progressPercent > 0 ? "in_progress" : "open";
  await ref.update({
    progressPercent, status,
    updates: admin.firestore.FieldValue.arrayUnion({
      updatedBy: employeeId,
      note: note || "",
      progressPercent,
      updatedAt: new Date().toISOString()
    }),
  });

  await rtdb.ref(`cowork/tasks/${taskId}`).update({
    progressPercent,
    status,
    lastUpdated: new Date().toISOString()
  });

  let recipients = [task.assignedBy];

  if (task.scopeType === 'group') {
    const groupDoc = await db.collection("cowork_groups").doc(task.scopeId).get();
    if (groupDoc.exists) {
      recipients = [...recipients, ...groupDoc.data().memberIds];
    }
  } else {
    recipients = [...recipients, ...task.assigneeIds];
  }

  recipients = [...new Set(recipients.filter(id => id !== employeeId))];

  socket.emitToMany(recipients, "task_updated", {
    taskId,
    task: { ...task, progressPercent, status },
    title: task.title,
    employeeId,
    progressPercent,
    status
  });

  await _notifyMany({
    recipientIds: recipients,
    type: "task_update",
    title: `Task: ${task.title}`,
    body: `${employeeId} → ${progressPercent}%`,
    data: { taskId }
  });

  return { taskId, progressPercent, status };
}

async function listTasks(employeeId, role) {
  let tasks = [];

  if (role === "ceo") {
    const snap = await db.collection("cowork_tasks").where("assignedBy", "==", employeeId).get();
    tasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } else {
    const directSnap = await db.collection("cowork_tasks")
      .where("assigneeIds", "array-contains", employeeId).get();
    tasks = directSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const groupsSnap = await db.collection("cowork_groups")
      .where("memberIds", "array-contains", employeeId).get();

    const groupIds = groupsSnap.docs.map(d => d.data().groupId);

    if (groupIds.length > 0) {
      const groupTasksSnap = await db.collection("cowork_tasks")
        .where("scopeType", "==", "group")
        .where("scopeId", "in", groupIds).get();

      const groupTasks = groupTasksSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      tasks = [...tasks, ...groupTasks];
    }
  }

  const uniqueTasks = tasks.filter((task, index, self) =>
    index === self.findIndex(t => t.taskId === task.taskId)
  );

  return uniqueTasks;
}

// ── NOTIFICATIONS ─────────────────────────────────────────
async function getNotifications(employeeId, unreadOnly = false) {
  try {
    if (!employeeId) {
      console.error('getNotifications called without employeeId');
      return [];
    }

    console.log(`Fetching notifications for employee: ${employeeId}, unreadOnly: ${unreadOnly}`);

    let query = db.collection("cowork_notifications")
      .where("recipientEmployeeId", "==", employeeId)
      .orderBy("createdAt", "desc")
      .limit(50);

    if (unreadOnly) {
      query = query.where("read", "==", false);
    }

    const snap = await query.get();

    const notifications = snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        // Convert Firestore timestamp to ISO string if needed
        createdAt: data.createdAt ?
          (typeof data.createdAt.toDate === 'function' ?
            data.createdAt.toDate().toISOString() :
            data.createdAt) :
          new Date().toISOString()
      };
    });

    console.log(`Found ${notifications.length} notifications`);
    return notifications;

  } catch (error) {
    console.error('Error in getNotifications:', error);
    // Return empty array instead of throwing to prevent 500 errors
    return [];
  }
}

async function markNotificationsRead(employeeId) {
  try {
    if (!employeeId) return;

    const snap = await db.collection("cowork_notifications")
      .where("recipientEmployeeId", "==", employeeId)
      .where("read", "==", false)
      .get();

    if (!snap.empty) {
      const batch = db.batch();
      snap.docs.forEach(d => batch.update(d.ref, { read: true }));
      await batch.commit();
      console.log(`Marked ${snap.size} notifications as read for ${employeeId}`);
    }

    return { success: true };
  } catch (error) {
    console.error('Error in markNotificationsRead:', error);
    return { success: false, error: error.message };
  }
}

// ── INTERNAL ──────────────────────────────────────────────
async function _notifyMany({ recipientIds, type, title, body, data }) {
  if (!recipientIds?.length) return;
  const batch = db.batch();
  recipientIds.forEach(id => {
    batch.set(db.collection("cowork_notifications").doc(uuidv4()), {
      recipientEmployeeId: id, type, title, body, data: data || {}, read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  await batch.commit();

  socket.emitToMany(recipientIds, "new_notification", { type, title, body });

  try {
    const snaps = await Promise.all(recipientIds.map(id => db.collection("cowork_employees").doc(id).get()));
    const tokens = snaps.filter(s => s.exists).flatMap(s => s.data().fcmTokens || []);
    if (tokens.length) await messaging.sendEachForMulticast({ notification: { title, body }, data: Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v)])), tokens });
  } catch (e) { console.error("FCM:", e.message); }
}

// ── GET WITH FALLBACK ────────────────────────────────────
async function getWithFallback(firestoreQuery, rtdbPath, timeoutMs = 2000) {
  return new Promise(async (resolve, reject) => {
    let firestoreCompleted = false;
    let rtdbCompleted = false;
    let result = null;

    const timer = setTimeout(async () => {
      if (!firestoreCompleted && !rtdbCompleted) {
        console.log(`⏱️ Firestore timeout (${timeoutMs}ms), falling back to RTDB: ${rtdbPath}`);
        try {
          const rtdbSnapshot = await rtdb.ref(rtdbPath).once('value');
          const rtdbData = rtdbSnapshot.val();
          if (rtdbData) {
            result = rtdbData;
            resolve(rtdbData);
          }
        } catch (rtdbError) {
          console.error('RTDB fallback error:', rtdbError);
        }
      }
    }, timeoutMs);

    try {
      const firestoreData = await firestoreQuery;
      firestoreCompleted = true;
      clearTimeout(timer);

      if (firestoreData) {
        syncToRTDB(rtdbPath.split('/')[0], rtdbPath.split('/')[1], firestoreData).catch(console.error);
      }

      resolve(firestoreData);
    } catch (error) {
      if (!rtdbCompleted) {
        console.error('Firestore error, trying RTDB:', error);
        try {
          const rtdbSnapshot = await rtdb.ref(rtdbPath).once('value');
          const rtdbData = rtdbSnapshot.val();
          if (rtdbData) {
            resolve(rtdbData);
          } else {
            reject(error);
          }
        } catch (rtdbError) {
          reject(error);
        }
      }
    }
  });
}

async function getGroupMessagesWithFallback(groupId, limit = 60) {
  return getWithFallback(
    db.collection("cowork_groups").doc(groupId).collection("messages")
      .orderBy("createdAt", "asc").limitToLast(Number(limit)).get()
      .then(snap => snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    `cowork/messages?orderBy="groupId"&equalTo="${groupId}"`,
    2000
  );
}

async function getDirectMessagesWithFallback(conversationId, limit = 60) {
  return getWithFallback(
    db.collection("cowork_direct_messages").doc(conversationId).collection("messages")
      .orderBy("createdAt", "asc").limitToLast(Number(limit)).get()
      .then(snap => snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    `cowork/direct_messages?orderBy="conversationId"&equalTo="${conversationId}"`,
    2000
  );
}

// Export all functions
module.exports = {
  createCoworkEmployee,
  changeEmployeePassword,
  listCoworkEmployees,
  getCoworkEmployee,
  saveFCMToken,

  createCoworkGroup,
  deleteCoworkGroup,
  listCoworkGroups,
  getCoworkGroup,

  sendGroupMessage,
  getGroupMessages: getGroupMessagesWithFallback,

  sendDirectMessage,
  getDirectMessages: getDirectMessagesWithFallback,
  listConversations,

  scheduleCoworkMeet,
  listCoworkMeets,
  getCoworkMeet,



  addGroupMember,
  removeGroupMember,
  updateCoworkGroup,

  assignCoworkTask,
  updateTaskProgress,
  listTasks,

  getNotifications,
  markNotificationsRead,
};