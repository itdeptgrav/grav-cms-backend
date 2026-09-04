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
async function createCoworkEmployee({ name, email, mobile, city, department, role = "employee", employeeId: chosenId = null }) {
  const { auth, db, admin } = require("../config/firebaseAdmin");

  // Validate role
  const resolvedRole = role === "tl" ? "tl" : "employee";

  // Use chosen biometricId from HR MongoDB if provided, else fall back to E001 auto-gen
  let empId;
  if (chosenId) {
    empId = chosenId;
  } else {
    // Legacy fallback — auto-generate E001 style
    const counterRef = db.collection("cowork_meta").doc("counters");
    empId = await db.runTransaction(async (tx) => {
      const snap = await tx.get(counterRef);
      const seq = (snap.data()?.employeeSeq || 0) + 1;
      tx.update(counterRef, { employeeSeq: seq });
      return `E${String(seq).padStart(3, "0")}`;
    });
  }

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


// ── VERIFY A PASSWORD THE CALLER CLAIMS IS THEIRS ───────────────────────────
//
// The Admin SDK can SET a password but cannot CHECK one — password hashes never
// leave Google. The only way to test a password is to try signing in with it,
// which is what the Identity Toolkit endpoint below does. It is the same call
// the browser SDK makes for a normal sign-in.
//
// The key is the Firebase **Web API key** — the public one already embedded in
// the frontend bundle, not a secret. Set FIREBASE_WEB_API_KEY (or reuse
// FIREBASE_API_KEY) to switch this on.
//
// Returns one of:
//   { ok: true }                       — the password is correct
//   { ok: false, reason: "wrong" }     — it is not
//   { ok: false, reason: "throttled" } — Google is rate-limiting this account
//   { ok: false, reason: "unavailable" } — no key configured, or Google is down
//
// "unavailable" is deliberately distinct from "wrong". A caller must not treat
// "we could not check" as "the password was correct", and equally must not tell
// somebody their own password is wrong because a key is missing from a server.
async function verifyEmployeePassword({ email, password }) {
  const key = process.env.FIREBASE_WEB_API_KEY || process.env.FIREBASE_API_KEY;
  if (!key) return { ok: false, reason: "unavailable", detail: "No FIREBASE_WEB_API_KEY configured." };
  if (!email || !password) return { ok: false, reason: "wrong" };

  const axios = require("axios");
  try {
    await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(key)}`,
      { email, password, returnSecureToken: false },
      { timeout: 10000 },
    );
    return { ok: true };
  } catch (e) {
    const code = e.response?.data?.error?.message || "";
    if (code.startsWith("TOO_MANY_ATTEMPTS")) return { ok: false, reason: "throttled" };
    // INVALID_PASSWORD, EMAIL_NOT_FOUND, INVALID_LOGIN_CREDENTIALS — newer
    // Firebase collapses the first two into the third on purpose, so that a
    // failed check cannot be used to discover which addresses have accounts.
    if (e.response?.status === 400) return { ok: false, reason: "wrong" };
    console.error("[verifyEmployeePassword]", code || e.message);
    return { ok: false, reason: "unavailable", detail: code || e.message };
  }
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

let _empListCache = null;
let _empListCacheExp = 0;
const EMP_LIST_TTL = 5 * 60 * 1000; // 5 minutes

function invalidateEmpListCache() {
  _empListCache = null;
  _empListCacheExp = 0;
}

async function listCoworkEmployees() {
  if (_empListCache && Date.now() < _empListCacheExp) return _empListCache;
  const snap = await db.collection("cowork_employees").orderBy("createdAt", "desc").get();
  const result = snap.docs.map(d => {
    const data = { id: d.id, ...d.data() };
    delete data.tempPassword;
    return data;
  });
  _empListCache = result;
  _empListCacheExp = Date.now() + EMP_LIST_TTL;
  return result;
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
  // Save to BOTH locations so fcmPush.service.js finds tokens regardless of save path
  await Promise.all([
    // Location 1: cowork_employees.fcmTokens (legacy backend path)
    db.collection("cowork_employees").doc(employeeId).update({
      fcmTokens: admin.firestore.FieldValue.arrayUnion(token),
    }),
    // Location 2: cowork_fcm_tokens.tokens (frontend useFCMToken.ts path)
    db.collection("cowork_fcm_tokens").doc(employeeId).set({
      employeeId,
      tokens: admin.firestore.FieldValue.arrayUnion(token),
      latestToken: token,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      platform: "web",
    }, { merge: true }),
  ]);
  // Also keep RTDB in sync
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
    data: { groupId, groupName: name },
    senderId: createdBy,
    senderName: "CoWork",
  });

  return data;
}

async function deleteCoworkGroup(groupId, requestingEmployeeId) {
  const docRef = db.collection("cowork_groups").doc(groupId);
  const docSnap = await docRef.get();
  if (!docSnap.exists) throw new Error("Group not found.");

  // CEO (E000) can delete ANY group. Creators can delete their own groups.
  const isCeo = requestingEmployeeId === "E000";
  if (!isCeo) {
    // Also check Firestore role in case CEO has a different ID
    const empSnap = await db.collection("cowork_employees").doc(requestingEmployeeId).get();
    const empRole = empSnap.exists ? empSnap.data().role : null;
    if (empRole !== "ceo" && docSnap.data().createdBy !== requestingEmployeeId) {
      throw new Error("Only the group creator or CEO can delete this group.");
    }
  }

  const memberIds = docSnap.data().memberIds || [];
  const groupName = docSnap.data().name || "Unknown Group";

  await docRef.update({ deleted: true, deletedAt: admin.firestore.FieldValue.serverTimestamp() });
  await rtdb.ref(`cowork/groups/${groupId}`).update({ deleted: true, deletedAt: new Date().toISOString() });

  // Notify all members that the group was deleted
  const othersToNotify = memberIds.filter(id => id !== requestingEmployeeId);
  if (othersToNotify.length) {
    await _notifyMany({
      recipientIds: othersToNotify,
      type: "group_deleted",
      title: `🗑️ Group Deleted · ${groupName}`,
      body: `The group "${groupName}" has been deleted.`,
      data: { groupId, groupName },
      senderId: requestingEmployeeId,
      senderName: "CoWork",
    });
  }
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

  // A renamed group is a group people cannot find. Every other membership
  // event here notifies — added, removed, deleted — and this one did not, so
  // the group somebody was told they joined as "Dispatch" became "Ops" with no
  // trace of the two being the same thing.
  //
  // Only when the NAME changed: a description edit is not something to ring a
  // bell for, and treating the two the same is how a group with an active
  // creator becomes a source of noise.
  if (updates.name && updates.name !== snap.data().name) {
    await _notifyMany({
      recipientIds: (snap.data().memberIds || []).filter(id => id && id !== requestingEmployeeId),
      type: "group_renamed",
      title: `✏️ Group renamed · ${updates.name}`,
      body: `"${snap.data().name}" is now called "${updates.name}".`,
      data: { groupId, groupName: updates.name, previousName: snap.data().name },
      senderId: requestingEmployeeId,
      senderName: "CoWork",
    });
  }

  return { ...snap.data(), ...updates };
}

// ── ADD MEMBER ─────────────────────────────────────────────
async function addGroupMember(groupId, requestingEmployeeId, requestingRole, employeeIdToAdd) {
  const snap = await db.collection("cowork_groups").doc(groupId).get();
  if (!snap.exists) throw new Error("Group not found.");
  const isAllowed = requestingRole === "ceo" || snap.data().createdBy === requestingEmployeeId;
  if (!isAllowed) throw new Error("Only the group creator or admin can add members.");
  const memberIds = snap.data().memberIds || [];
  if (memberIds.includes(employeeIdToAdd)) throw new Error("Employee is already a member.");
  const updated = [...memberIds, employeeIdToAdd];
  await db.collection("cowork_groups").doc(groupId).update({ memberIds: updated, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  await _notifyMany({ recipientIds: [employeeIdToAdd], type: "group_added", title: `➕ Added to Group · ${snap.data().name}`, body: `You were added to group "${snap.data().name}"`, data: { groupId, groupName: snap.data().name }, senderId: requestingEmployeeId, senderName: "CoWork" });
  return { memberIds: updated };
}

// ── REMOVE MEMBER ─────────────────────────────────────────
async function removeGroupMember(groupId, requestingEmployeeId, requestingRole, employeeIdToRemove) {
  const snap = await db.collection("cowork_groups").doc(groupId).get();
  if (!snap.exists) throw new Error("Group not found.");
  const isAllowed = requestingRole === "ceo" || snap.data().createdBy === requestingEmployeeId;
  if (!isAllowed) throw new Error("Only the group creator or admin can remove members.");
  if (employeeIdToRemove === requestingEmployeeId) throw new Error("Creator cannot be removed.");
  const memberIds = (snap.data().memberIds || []).filter(id => id !== employeeIdToRemove);
  await db.collection("cowork_groups").doc(groupId).update({ memberIds, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

  await _notifyMany({
    recipientIds: [employeeIdToRemove],
    type: "group_removed",
    title: `🚫 Removed from Group · ${snap.data().name}`,
    body: `You have been removed from "${snap.data().name}"`,
    data: { groupId, groupName: snap.data().name },
    senderId: requestingEmployeeId,
    senderName: "CoWork",
  });

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
async function sendGroupMessage({ groupId, senderId, senderName, text, attachments = [], messageType = "text", replyTo = null, clientMessageId = null }) {
  const groupDoc = await db.collection("cowork_groups").doc(groupId).get();
  if (!groupDoc.exists) throw new Error("Group not found.");
  const group = groupDoc.data();
  if (!group.memberIds.includes(senderId) && group.createdBy !== senderId) throw new Error("Not a member.");

  // Accept the client-chosen id only if it is a well-formed UUID; otherwise generate.
  const messageId = (typeof clientMessageId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientMessageId)) ? clientMessageId : uuidv4();
  const timestamp = admin.firestore.FieldValue.serverTimestamp();
  const isoTime = new Date().toISOString();

  const resolvedType = messageType !== "text" ? messageType
    : attachments.length > 0 ? (attachments[0].type || "image") : "text";

  const msg = {
    messageId, threadType: "group", threadId: groupId, senderId, senderName,
    text: text || "", attachments, messageType: resolvedType,
    type: resolvedType, readBy: [senderId],
    ...(replyTo && replyTo.messageId ? { replyTo: { messageId: String(replyTo.messageId), senderName: String(replyTo.senderName || "Unknown"), text: String(replyTo.text || "").slice(0, 120) } } : {}),
    createdAt: timestamp,
  };


  // Save to Firestore
  await db.collection("cowork_groups").doc(groupId).collection("messages").doc(messageId).create(msg);

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

  const _gmBody = text ? text.slice(0, 80) : (attachments[0]?.type === "image" ? "📷 Photo" : attachments[0]?.type === "voice" ? "🎤 Voice message" : attachments[0]?.type === "pdf" ? "📄 Document" : attachments.length ? "📎 Attachment" : "");
  await _notifyMany({ recipientIds: recipients, type: "group_message", title: `👥 ${group.name} · ${senderName}`, body: _gmBody, data: { groupId, messageId, groupName: group.name }, senderId, senderName });
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
  // Strip undefined fields from each attachment — Firestore rejects undefined values
  const cleanAttachments = (attachments || []).map(a => {
    const clean = {};
    Object.entries(a).forEach(([k, v]) => { if (v !== undefined) clean[k] = v; });
    return clean;
  });

  const msg = {
    messageId, threadType: "direct", threadId: conversationId, senderId: fromEmployeeId,
    senderName, text: text || "", attachments: cleanAttachments, messageType: resolvedType,
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

  const _dmBody = text ? text.slice(0, 80) : (cleanAttachments[0]?.type === "image" ? "📷 Photo" : cleanAttachments[0]?.type === "voice" ? "🎤 Voice message" : cleanAttachments[0]?.type === "pdf" ? "📄 Document" : cleanAttachments.length ? "📎 Attachment" : "");
  await _notifyMany({ recipientIds: [toEmployeeId], type: "direct_message", title: `💬 DM · ${senderName}`, body: _dmBody, data: { conversationId, messageId }, senderId: fromEmployeeId, senderName });
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
async function scheduleCoworkMeet({ title, description, createdBy, participants, dateTime, googleMeetLink, endsAt, agenda, taskId }) {
  const meetId = await generateCoworkId("meet");

  /* THE ORGANISER IS A PARTICIPANT.
   *
   * Legacy kept them only in `createdBy`, so the person who called the meeting
   * was absent from its own attendee list. That is not just cosmetic: an
   * ordinary employee's `listCoworkMeets` reads
   * `where participants array-contains employeeId`, so a meeting whose
   * organiser was not in the array was invisible to them on their own
   * meetings page. Deduped, and their position is first. */
  const withOrganiser = [createdBy, ...(Array.isArray(participants) ? participants : [])];
  const allParticipants = [...new Set(withOrganiser.filter(Boolean))];

  const data = {
    meetId, title, description: description || "", createdBy, participants: allParticipants,
    dateTime, googleMeetLink, isCancelled: false,
    /* Additive fields for the new meetings page. All default to the shape the
       legacy app already tolerates — it ignores what it does not read, and a
       null `taskId` is what every meeting scheduled before this had. */
    status: "scheduled",
    endsAt: endsAt || null,
    agenda: Array.isArray(agenda) ? agenda.filter(a => typeof a === "string" && a.trim()) : [],
    taskId: taskId || null,
    presence: {},
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await db.collection("cowork_scheduled_meets").doc(meetId).set(data);

  await syncToRTDB('meets', meetId, {
    ...data,
    createdAt: new Date().toISOString()
  });

  await _appendMeetEvent({ meetId, type: "created", actorId: createdBy, actorName: createdBy, detail: `Scheduled "${title}"` });

  /* Reads from the deduped list, not the raw parameter: it can be undefined,
     and the organiser must not be notified of their own meeting. */
  const recipients = allParticipants.filter(id => id !== createdBy);
  socket.emitToMany(recipients, "new_meet", { meetId, title, dateTime, googleMeetLink });
  await _notifyMany({ recipientIds: recipients, type: "meet_scheduled", title: `📅 Meeting Scheduled · ${title}`, body: new Date(dateTime).toLocaleString("en-IN"), data: { meetId, meetTitle: title, dateTime }, senderId: createdBy, senderName: createdBy });
  return data;
}

async function listCoworkMeets(employeeId, role) {
  // NOTE: We now return cancelled meetings too — participants need to see the
  // "Cancelled" blurred state on their meetings page. The frontend handles display.
  if (role === "ceo") {
    // CEO sees all meetings (active + cancelled)
    const snap = await db.collection("cowork_scheduled_meets").get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  if (role === "tl") {
    // TL sees meetings they CREATED + meetings they are a PARTICIPANT in (active + cancelled)
    const [createdSnap, participantSnap] = await Promise.all([
      db.collection("cowork_scheduled_meets").where("createdBy", "==", employeeId).get(),
      db.collection("cowork_scheduled_meets").where("participants", "array-contains", employeeId).get(),
    ]);
    const map = new Map();
    [...createdSnap.docs, ...participantSnap.docs].forEach(d => map.set(d.id, { id: d.id, ...d.data() }));
    return Array.from(map.values());
  }

  // Employee — only meetings they are a participant in (active + cancelled so they see the blur)
  const snap = await db.collection("cowork_scheduled_meets").where("participants", "array-contains", employeeId).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getCoworkMeet(meetId) {
  const doc = await db.collection("cowork_scheduled_meets").doc(meetId).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

// ── CANCEL MEETING ────────────────────────────────────────
async function cancelCoworkMeet({ meetId, cancelledBy, cancelledByName }) {
  const ref = db.collection("cowork_scheduled_meets").doc(meetId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Meeting not found.");

  const meet = snap.data();
  if (meet.isCancelled) throw new Error("Meeting is already cancelled.");

  // Only the creator (or CEO) can cancel
  if (meet.createdBy !== cancelledBy) throw new Error("Only the meeting organiser can cancel it.");

  await ref.update({
    isCancelled: true,
    cancelledBy,
    cancelledByName,
    cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Notify all participants (excluding the canceller)
  const recipients = (meet.participants || []).filter(id => id !== cancelledBy);

  // Real-time socket push
  socket.emitToMany(recipients, "meet_cancelled", { meetId, title: meet.title, cancelledByName });

  // Persistent in-app notification
  await _notifyMany({
    recipientIds: recipients,
    type: "meet_cancelled",
    title: `❌ Meeting Cancelled · ${meet.title}`,
    body: `Cancelled by ${cancelledByName}`,
    data: { meetId, meetTitle: meet.title },
    senderId: cancelledBy,
    senderName: cancelledByName,
  });

  return { success: true, meetId };
}

// ── UPDATE / EDIT MEETING ─────────────────────────────────
async function updateCoworkMeet({ meetId, updatedBy, title, description, dateTime, googleMeetLink, participants }) {
  const ref = db.collection("cowork_scheduled_meets").doc(meetId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Meeting not found.");

  const meet = snap.data();
  if (meet.isCancelled) throw new Error("Cannot edit a cancelled meeting.");
  // Only the creator (or CEO) can edit
  if (meet.createdBy !== updatedBy) throw new Error("Only the meeting organiser can edit it.");

  const updates = {};
  if (title !== undefined && title !== null) updates.title = title.trim();
  if (description !== undefined) updates.description = description || "";
  if (dateTime !== undefined && dateTime !== null) updates.dateTime = dateTime;
  if (googleMeetLink !== undefined) updates.googleMeetLink = googleMeetLink || null;
  if (participants !== undefined && Array.isArray(participants)) updates.participants = participants;
  updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  updates.updatedBy = updatedBy;

  await ref.update(updates);

  // Notify all participants (old + new) except the editor
  const allParticipants = [...new Set([...(meet.participants || []), ...(participants || meet.participants || [])])];
  const recipients = allParticipants.filter(id => id !== updatedBy);

  socket.emitToMany(recipients, "meet_updated", {
    meetId,
    title: updates.title || meet.title,
    dateTime: updates.dateTime || meet.dateTime,
  });

  await _notifyMany({
    recipientIds: recipients,
    type: "meet_updated",
    title: `📅 Meeting Updated · ${updates.title || meet.title}`,
    body: `New time: ${new Date(updates.dateTime || meet.dateTime).toLocaleString("en-IN")}`,
    data: { meetId, meetTitle: updates.title || meet.title, dateTime: updates.dateTime || meet.dateTime },
    senderId: updatedBy,
    senderName: updatedBy,
  });

  return { success: true, meetId };
}

// ── MEET LIFECYCLE, PRESENCE AND AUDIT ────────────────────
//
// Added for the new Cowork meetings page, which needs three things this
// collection never recorded: a lifecycle beyond "cancelled or not", who was
// actually in the room, and an audit trail.
//
// COMPATIBILITY. `cowork_scheduled_meets` is read by the LIVE legacy app, which
// knows only `isCancelled`. So `status` is written ALONGSIDE it and the two are
// kept in step — never instead of it. A meeting cancelled through the new page
// has to disappear from the old one too, and legacy will never learn to read a
// status string.

const MEET_STATUSES = ["scheduled", "waiting", "live", "completed", "cancelled", "archived"];

/**
 * Append to the meeting's audit trail.
 *
 * A SUBCOLLECTION rather than an array on the document: an append-only log that
 * grows on every join and leave would otherwise rewrite the whole meeting
 * document each time, and two people joining at once would lose one of the
 * entries to a last-write-wins overwrite.
 */
async function _appendMeetEvent({ meetId, type, actorId, actorName, detail }) {
  await db.collection("cowork_scheduled_meets").doc(meetId).collection("events").add({
    type,
    actorId: actorId || "",
    actorName: actorName || actorId || "",
    detail: detail || "",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Close every way into a meeting: the LiveKit room, the join code, the link.
 *
 * Best-effort by design — see the caller. Each step is independent so one
 * failure does not skip the others.
 */
async function _tearDownMeetingRoom(meet, meetId) {
  /* The join code is a 6-digit space and therefore guessable; leaving one
     active after the meeting is the cheapest way in. */
  if (meet.joinCode) {
    await db
      .collection("cowork_join_codes")
      .doc(String(meet.joinCode))
      .update({ active: false })
      .catch((e) =>
        console.error(`[meet ${meetId}] join code deactivate:`, e.message),
      );
  }

  if (!meet.livekitRoomName) return;
  const url = (process.env.LIVEKIT_URL || "")
    .replace("wss://", "https://")
    .replace("ws://", "http://");
  if (!url || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
    return;
  }
  const { RoomServiceClient } = require("livekit-server-sdk");
  const svc = new RoomServiceClient(
    url,
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
  );
  /* Disconnects everybody still in it. A token already minted stays
     cryptographically valid until it expires, so deleting the room is what
     actually removes the ability to be in it. */
  await svc.deleteRoom(meet.livekitRoomName);
}

async function setCoworkMeetStatus({ meetId, employeeId, employeeName, status }) {
  if (!MEET_STATUSES.includes(status)) {
    throw new Error(`Unknown meeting status. Expected one of: ${MEET_STATUSES.join(", ")}.`);
  }
  const ref = db.collection("cowork_scheduled_meets").doc(meetId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Meeting not found.");
  const meet = snap.data();

  // Same authority as cancel and edit: the organiser drives the lifecycle.
  if (meet.createdBy !== employeeId) {
    throw new Error("Only the meeting organiser can change its status.");
  }
  const current = meet.isCancelled === true ? "cancelled" : (meet.status || "scheduled");
  if (current === "cancelled" && status !== "cancelled") {
    throw new Error("This meeting was cancelled. Schedule a new one rather than reopening it.");
  }
  if (current === status) return { success: true, meetId, status };

  const updates = {
    status,
    // Kept in step for the legacy app — see the note above.
    isCancelled: status === "cancelled",
    updatedBy: employeeId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  // Stamped once each, so a meeting booked for an hour that ran twenty records
  // twenty. Re-entering `live` does not restart the clock.
  if (status === "live" && !meet.startedAt) updates.startedAt = new Date().toISOString();
  if ((status === "completed" || status === "archived") && !meet.endedAt) {
    updates.endedAt = new Date().toISOString();
  }
  if (status === "cancelled") {
    updates.cancelledBy = employeeId;
    updates.cancelledByName = employeeName || "";
    updates.cancelledAt = admin.firestore.FieldValue.serverTimestamp();
  }

  /**
   * Ending a meeting must actually END it.
   *
   * **The gap this closes.** Status was the only thing this wrote, so "End for
   * everyone" relabelled the document and left every way IN still open: the
   * LiveKit room stayed up, the 6-digit join code stayed `active`, and the
   * public guest link stayed live. `POST /cowork/livekit/end` did all three —
   * and had no caller anywhere in the product, so it never ran.
   *
   * Doing it here rather than asking the client to make a second call means
   * every caller of this service gets the teardown: the UI, the legacy app, and
   * anything added later. A meeting is over exactly when its status says so.
   */
  if (status === "completed" || status === "archived" || status === "cancelled") {
    updates.publicShareEnabled = false;
    try {
      await _tearDownMeetingRoom(meet, meetId);
    } catch (e) {
      /* The document must still close even if LiveKit is unreachable — a
         meeting that cannot be ended because a third party is down is worse
         than a room that lingers until its own empty-timeout. */
      console.error(`[meet ${meetId}] room teardown failed:`, e.message);
    }
  }

  await ref.update(updates);

  await _appendMeetEvent({
    meetId,
    type: status === "live" ? "started" : status === "cancelled" ? "cancelled" : status === "completed" ? "ended" : status,
    actorId: employeeId,
    actorName: employeeName,
    detail: `Status set to ${status}`,
  });

  const recipients = (meet.participants || []).filter(id => id !== employeeId);
  socket.emitToMany(recipients, "meet_status", { meetId, status, title: meet.title });

  // ── A durable record, not only a socket event ────────────────────────────
  // The emit above reaches whoever has the app open at that instant and nobody
  // else. "The meeting you are invited to has started" reaching only the people
  // already looking at Cowork is the wrong half of the room.
  //
  // `live` and `cancelled` only, and that IS the whole list on purpose:
  // `completed` and `archived` tell people something they either watched happen
  // or no longer need, and a bell that rings for those is one people stop
  // reading. The socket event still fires for every status.
  if (status === "live" || status === "cancelled") {
    await _notifyMany({
      recipientIds: recipients,
      type: status === "live" ? "meet_started" : "meet_cancelled",
      title: status === "live" ? "🔴 Meeting started" : "🚫 Meeting cancelled",
      body: status === "live"
        ? `${employeeName || "The organiser"} started "${meet.title}". Join now.`
        : `${employeeName || "The organiser"} cancelled "${meet.title}".`,
      data: { meetId, status, title: meet.title },
      senderId: employeeId,
      senderName: employeeName,
    });
  }

  return { success: true, meetId, status };
}

/**
 * Record somebody arriving in or leaving the room.
 *
 * Open to any PARTICIPANT, unlike the lifecycle above — presence is a statement
 * about yourself, and requiring the organiser to record it would make it
 * unrecordable.
 *
 * Written with dot notation so two people joining at once each update their own
 * key instead of overwriting the whole map.
 */
async function recordCoworkMeetPresence({ meetId, employeeId, employeeName, joined }) {
  const ref = db.collection("cowork_scheduled_meets").doc(meetId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Meeting not found.");
  const meet = snap.data();

  const isParticipant = (meet.participants || []).includes(employeeId) || meet.createdBy === employeeId;
  if (!isParticipant) throw new Error("You are not in this meeting.");

  const now = new Date().toISOString();
  const updates = joined
    ? { [`presence.${employeeId}.joinedAt`]: now, [`presence.${employeeId}.leftAt`]: null }
    : { [`presence.${employeeId}.leftAt`]: now };
  await ref.update(updates);

  await _appendMeetEvent({
    meetId,
    type: joined ? "joined" : "left",
    actorId: employeeId,
    actorName: employeeName,
    detail: joined ? "Joined the room" : "Left the room",
  });

  const recipients = (meet.participants || []).filter(id => id !== employeeId);
  socket.emitToMany(recipients, "meet_presence", { meetId, employeeId, joined });
  return { success: true, meetId, employeeId, joined, at: now };
}

async function listCoworkMeetEvents(meetId) {
  const snap = await db.collection("cowork_scheduled_meets").doc(meetId)
    .collection("events").orderBy("createdAt", "asc").limit(500).get();
  return snap.docs.map(d => {
    const data = d.data();
    return {
      id: d.id,
      ...data,
      // Serialised here rather than left as a Timestamp: this crosses HTTP, and
      // a Firestore Timestamp arrives at the browser as {_seconds,_nanoseconds}.
      createdAt: data.createdAt?.toDate?.().toISOString() || null,
    };
  });
}

/**
 * Meetings about one task.
 *
 * `taskId` is written by `scheduleCoworkMeet` when the meeting is created from a
 * task. Meetings scheduled before this field existed simply do not match, which
 * is correct — they were never linked to anything.
 */
async function listCoworkMeetsForTask(taskId) {
  const snap = await db.collection("cowork_scheduled_meets").where("taskId", "==", taskId).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
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
    title: `📋 Task Assigned · ${title}`,
    body: description?.slice(0, 80) || "New task assigned.",
    data: { taskId, taskTitle: title, description },
    senderId: assignedBy,
    senderName: assignedBy,
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
    title: `📊 Task Update · ${task.title}`,
    body: `${employeeId} → ${progressPercent}%`,
    data: { taskId, taskTitle: task.title, progressPercent },
    senderId: employeeId,
    senderName: employeeId,
  });

  return { taskId, progressPercent, status };
}

async function listTasks(employeeId, role) {
  // ── FALLBACK task list (used when list-hierarchy fails) ──────────────────
  // Must apply the SAME visibility rules as listTasksWithHierarchy:
  //   CEO    : only tasks they personally created
  //   TL     : tasks they created + tasks assigned to them
  //   Employee: only tasks directly assigned to them
  let tasks = [];

  if (role === "ceo") {
    // CEO sees tasks they created OR tasks assigned to them (by TL etc.)
    const ceoSnap1 = await db.collection("cowork_tasks").where("assignedBy", "==", employeeId).orderBy("updatedAt", "desc").limit(100).get();
    const ceoSnap2 = await db.collection("cowork_tasks").where("assigneeIds", "array-contains", employeeId).orderBy("updatedAt", "desc").limit(100).get();
    const ceoSeen = new Set();
    [...ceoSnap1.docs, ...ceoSnap2.docs].forEach(d => {
      if (!ceoSeen.has(d.id)) { ceoSeen.add(d.id); tasks.push({ id: d.id, ...d.data() }); }
    });
  } else if (role === "tl") {
    // TL: tasks they created
    const snap1 = await db.collection("cowork_tasks")
      .where("assignedBy", "==", employeeId).orderBy("updatedAt", "desc").limit(100).get();
    const snap2 = await db.collection("cowork_tasks")
      .where("assigneeIds", "array-contains", employeeId).orderBy("updatedAt", "desc").limit(100).get();
    const seen = new Set();
    [...snap1.docs, ...snap2.docs].forEach(d => {
      if (!seen.has(d.id)) { seen.add(d.id); tasks.push({ id: d.id, ...d.data() }); }
    });

  } else {
    // Employee: ONLY tasks directly assigned to them
    const directSnap = await db.collection("cowork_tasks")
      .where("assigneeIds", "array-contains", employeeId).orderBy("updatedAt", "desc").limit(100).get();
    tasks = directSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Group tasks: tasks scoped to a group the employee is a member of
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

/**
 * Mark ONE notification read.
 *
 * `markNotificationsRead` above clears the whole inbox, which is the only thing
 * the engine could do until now — so a person with one meeting reminder they
 * wanted to keep had to clear forty task updates to dismiss it, or clear
 * nothing.
 *
 * The recipient check is the point of doing this server-side. `notificationId`
 * arrives from the browser and is a document id in a collection every employee
 * shares; without the check anyone could mark anyone else's inbox read. The
 * refusal deliberately does not distinguish "not yours" from "does not exist" —
 * a 404 on somebody else's id would confirm the id is real.
 */
async function markNotificationRead(employeeId, notificationId) {
  try {
    if (!employeeId || !notificationId) {
      return { success: false, error: "employeeId and notificationId are required." };
    }

    const ref = db.collection("cowork_notifications").doc(String(notificationId));
    const snap = await ref.get();
    if (!snap.exists || snap.data().recipientEmployeeId !== employeeId) {
      return { success: false, error: "Notification not found." };
    }

    // Already read is success, not an error: two clicks on one row is a normal
    // thing for a person to do, and the second must not report a failure.
    if (snap.data().read !== true) await ref.update({ read: true });
    return { success: true };
  } catch (error) {
    console.error("Error in markNotificationRead:", error);
    return { success: false, error: error.message };
  }
}

// ── INTERNAL ──────────────────────────────────────────────
// Clear event type label for push notification title
function _buildTitle(type, title) {
  const labels = {
    direct_message: "💬 Direct Message",
    group_message: "👥 Group Message",
    group_added: "➕ Added to Group",
    group_deleted: "🗑️ Group Deleted",
    meet_scheduled: "📅 Meeting Scheduled",
    meet_cancelled: "❌ Meeting Cancelled",
    meet_updated: "📅 Meeting Updated",
    meet_reminder: "⏰ Meeting Starting",
    request: "📨 New Request",
    request_approved: "✅ Request Approved",
    request_rejected: "❌ Request Rejected",
  };
  const label = labels[type];
  if (!label) return title;
  const parts = title.split(/[·:]/);
  const context = parts.length > 1 ? parts.slice(1).join("·").trim() : "";
  return context ? `${label} · ${context}` : label;
}

// Build a rich multiline body for push notifications based on type + data
function _buildRichBody(type, body, data = {}) {
  const lines = [body || ""];
  if (type === "task_assigned" || type === "task_forwarded") {
    if (data.priority) lines.push(`Priority: ${data.priority}`);
    if (data.dueDate) lines.push(`Due: ${data.dueDate}`);
    if (data.description) lines.push(data.description.slice(0, 60));
  } else if (type === "direct_message") {
    // body already has the message — no extra lines needed
  } else if (type === "group_message") {
    // body already has message text
  } else if (type === "task_chat") {
    if (data.taskTitle) lines.push(`In: ${data.taskTitle}`);
  } else if (type === "meet_scheduled") {
    if (data.dateTime) lines.push(`Time: ${new Date(data.dateTime).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}`);
    if (data.meetTitle) lines.push(`Meeting: ${data.meetTitle}`);
  } else if (type === "goal_final_submit") {
    if (data.componentCount) lines.push(`Components: ${data.componentCount}`);
    if (data.submittedAt) lines.push(`Submitted: ${data.submittedAt}`);
  } else if (type === "goal_component_done") {
    if (data.componentTitle) lines.push(`Component: ${data.componentTitle}`);
    if (data.progress) lines.push(`Progress: ${data.progress}`);
    if (data.reportText) lines.push(data.reportText.slice(0, 60));
  } else if (type === "goal_report_submitted") {
    if (data.componentTitle) lines.push(`Component: ${data.componentTitle}`);
    if (data.fileCount) lines.push(`Attachments: ${data.fileCount} file${data.fileCount !== 1 ? "s" : ""}`);
    if (data.reportText) lines.push(data.reportText.slice(0, 80));
  } else if (type === "completion_rejected" || type === "completion_ceo_rejected") {
    if (data.reason) lines.push(`Reason: ${data.reason}`);
  } else if (type === "deadline_changed") {
    // body already has old→new deadline
  } else if (type === "request") {
    if (data.priority) lines.push(`Priority: ${data.priority}`);
    if (data.dueDate) lines.push(`Due: ${data.dueDate}`);
    if (data.message) lines.push(data.message.slice(0, 60));
  }
  // Filter empty lines and join
  return lines.filter(Boolean).join("\n");
}

async function _notifyMany({ recipientIds, type, title, body, data, senderId, senderName }) {
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

  // FCM push — fire immediately, do NOT await (prevents blocking the caller)
  setImmediate(() => {
    try {
      const { sendPushToEmployees } = require("./fcmPush.service");
      const richTitle = _buildTitle(type, title);
      const richBody = _buildRichBody(type, body, data || {});
      sendPushToEmployees(recipientIds, richTitle, richBody, { type, ...(data || {}) })
        .catch(e => console.error("[FCM push]", e.message));
    } catch (e) { console.error("[FCM push init]", e.message); }
  });

  // Email — fire async, do NOT await (slow API call, should not block push)
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
    } catch (e) { console.error("[Email notify]", e.message); }
  });
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
  verifyEmployeePassword,
  listCoworkEmployees,
  invalidateEmpListCache,
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
  updateCoworkMeet,
  listCoworkMeets,
  cancelCoworkMeet,
  getCoworkMeet,
  setCoworkMeetStatus,
  recordCoworkMeetPresence,
  listCoworkMeetEvents,
  listCoworkMeetsForTask,



  addGroupMember,
  removeGroupMember,
  updateCoworkGroup,

  assignCoworkTask,
  updateTaskProgress,
  listTasks,

  getNotifications,
  markNotificationsRead,
  markNotificationRead,
  /* The fan-out, exported so a ROUTE that has no service function of its own
     can still send one durable notification instead of a bare push. Named
     without the underscore because from outside this file it is not private —
     `_notifyMany` stays the internal name every function here already uses. */
  notifyEmployees: _notifyMany,
};