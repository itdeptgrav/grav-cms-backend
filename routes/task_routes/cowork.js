/**
 * REPLACE: routes/cowork.js  (only the employee/create route changed — rest is identical)
 * Change: /employee/create now accepts `role` ("employee"|"tl") in body
 *         and passes it to svc.createCoworkEmployee
 */

const express = require("express");
const router = express.Router();
const { verifyCoworkToken, verifyCeoToken, verifyEmployeeToken, verifyCeoOrTL } = require("../../Middlewear/coworkAuth");

const svc = require("../../services/cowork.service");
const { invalidateEmpListCache } = require("../../services/cowork.service");
const { auth, db, admin } = require("../../config/firebaseAdmin");
const { sendWelcomeEmail } = require("../../services/emailNotifications.service");

// ── Seed CEO ──────────────────────────────────────────────
router.post("/setup/seed-ceo", async (req, res) => {
  try {
    const { email, password, name, mobile = "", city = "" } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: "email, password, name required" });
    let ur;
    try { ur = await auth.createUser({ email, password, displayName: name }); }
    catch (e) { if (e.code === "auth/email-already-exists") ur = await auth.getUserByEmail(email); else throw e; }
    await auth.setCustomUserClaims(ur.uid, { role: "ceo" });
    await db.collection("cowork_employees").doc("E000").set({
      employeeId: "E000", authUid: ur.uid, name, email, mobile, city,
      department: "Management", role: "ceo", profilePicUrl: null, fcmTokens: [],
      passwordChanged: true, tempPassword: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    await db.collection("cowork_meta").doc("counters").set(
      { employeeSeq: 0, groupSeq: 0, taskSeq: 0, meetSeq: 0 }, { merge: true }
    );
    res.json({ success: true, uid: ur.uid, employeeId: "E000", message: "CEO seeded. Login now." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Me ────────────────────────────────────────────────────
router.get("/me", verifyCoworkToken, verifyEmployeeToken, (req, res) => {
  const { authUid, employeeId, role, name, employeeData } = req.coworkUser;
  console.log(`yugyu`, req.coworkUser);
  res.json({
    authUid, employeeId, role, name,
    tempPassword: employeeData?.passwordChanged === false ? employeeData?.tempPassword : null,
    passwordChanged: employeeData?.passwordChanged ?? true,
  });
});

router.get("/employee/list-members", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const employees = await svc.listCoworkEmployees();
    const safe = employees.map(({ tempPassword, authUid, fcmTokens, ...emp }) => emp);
    res.json({ employees: safe });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Change Password ──────────────────────────────
router.post("/change-password", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
    await svc.changeEmployeePassword({ employeeId: req.coworkUser.employeeId, authUid: req.coworkUser.authUid, newPassword });
    res.json({ success: true, message: "Password changed successfully." });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── CEO: change own email (and optionally password) ───────────────────────────
router.post("/change-email", verifyCoworkToken, verifyCeoToken, async (req, res) => {
  try {
    const { newEmail, newPassword } = req.body;
    if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail))
      return res.status(400).json({ error: "Valid email required." });

    const employeeId = req.coworkUser.employeeId;
    const authUid = req.coworkUser.authUid;
    if (!authUid) return res.status(400).json({ error: "No auth account linked." });

    // Check new email not already taken by another employee
    const existing = await db.collection("cowork_employees")
      .where("email", "==", newEmail.toLowerCase().trim()).limit(1).get();
    if (!existing.empty && existing.docs[0].id !== employeeId)
      return res.status(400).json({ error: "This email is already in use by another account." });

    // Update Firebase Auth
    const authUpdates = { email: newEmail.toLowerCase().trim() };
    if (newPassword) {
      if (newPassword.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
      authUpdates.password = newPassword;
    }
    await auth.updateUser(authUid, authUpdates);

    // Update Firestore employee doc
    const firestoreUpdates = {
      email: newEmail.toLowerCase().trim(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (newPassword) {
      firestoreUpdates.passwordChanged = true;
      firestoreUpdates.tempPassword = null;
    }
    await db.collection("cowork_employees").doc(employeeId).update(firestoreUpdates);

    console.log(`[ChangeEmail] ${employeeId} changed email to ${newEmail}`);
    res.json({ success: true, message: "Email updated successfully." + (newPassword ? " Password also changed." : "") });
  } catch (e) {
    console.error("[change-email]", e);
    res.status(500).json({ error: e.message });
  }
});

// ── Biometric IDs from MongoDB — shows used/unused for ID picker ──────────────
// GET /cowork/employee/biometric-ids
router.get("/employee/biometric-ids", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
  try {
    const Employee = require("../../models/Employee");

    // 1. All biometricIds from MongoDB HR employees
    const hrEmployees = await Employee.find(
      { biometricId: { $exists: true, $ne: null, $ne: "" } },
      { biometricId: 1, firstName: 1, middleName: 1, lastName: 1, status: 1 }
    ).lean();

    // 2. Which IDs are already assigned to a CoWork employee (employeeId in Firestore)
    const coworkSnap = await db.collection("cowork_employees").get();
    const usedIds = new Set();
    const coworkByBiometric = {};
    coworkSnap.forEach(doc => {
      const d = doc.data();
      if (d.employeeId) {
        usedIds.add(d.employeeId);
        coworkByBiometric[d.employeeId] = d.name;
      }
    });

    // 3. Split into available vs used
    const available = [];
    const used = [];
    hrEmployees.forEach(emp => {
      const id = emp.biometricId;
      const hrName = [emp.firstName, emp.middleName, emp.lastName].filter(Boolean).join(" ").trim();
      if (usedIds.has(id)) {
        used.push({ biometricId: id, hrName, coworkName: coworkByBiometric[id] || hrName });
      } else {
        available.push({ biometricId: id, hrName });
      }
    });

    available.sort((a, b) => a.biometricId.localeCompare(b.biometricId));
    used.sort((a, b) => a.biometricId.localeCompare(b.biometricId));

    res.json({ success: true, available, used });
  } catch (e) {
    console.error("[biometric-ids]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── MY MANAGERS — fetch from HR MongoDB using existing Employee schema ────────
// GET /cowork/employee/my-managers/:employeeId
// Finds employee by biometricId, then uses the same populate logic as /:id/details
router.get("/employee/my-managers/:employeeId", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const Employee = require("../../models/Employee");
    const { employeeId } = req.params;

    // Find employee by biometricId (same as CoWork employeeId)
    const employee = await Employee.findOne({ biometricId: employeeId })
      .populate("primaryManager.managerId", "firstName middleName lastName biometricId department designation jobTitle phone email profilePhoto")
      .populate("secondaryManager.managerId", "firstName middleName lastName biometricId department designation jobTitle phone email profilePhoto")
      .lean();

    if (!employee) {
      return res.json({ success: true, primaryManager: null, secondaryManager: null, message: "Employee not found in HR system" });
    }

    // Build primary manager — same pattern as Employee-Section.js /:id/details
    const primaryManager = employee.primaryManager?.managerId
      ? {
        name: [
          employee.primaryManager.managerId.firstName,
          employee.primaryManager.managerId.middleName,
          employee.primaryManager.managerId.lastName,
        ].filter(Boolean).join(" ").trim()
          || employee.primaryManager.managerName || "",
        biometricId: employee.primaryManager.managerId.biometricId || "",
        department: employee.primaryManager.managerId.department || "",
        designation: employee.primaryManager.managerId.designation || employee.primaryManager.managerId.jobTitle || "",
        phone: employee.primaryManager.managerId.phone || "",
        email: employee.primaryManager.managerId.email || "",
        profilePhotoUrl: employee.primaryManager.managerId.profilePhoto?.url || null,
      }
      : employee.primaryManager?.managerName
        ? { name: employee.primaryManager.managerName, biometricId: "", department: "", designation: "", phone: "", email: "", profilePhotoUrl: null }
        : null;

    // Build secondary manager
    const secondaryManager = employee.secondaryManager?.managerId
      ? {
        name: [
          employee.secondaryManager.managerId.firstName,
          employee.secondaryManager.managerId.middleName,
          employee.secondaryManager.managerId.lastName,
        ].filter(Boolean).join(" ").trim()
          || employee.secondaryManager.managerName || "",
        biometricId: employee.secondaryManager.managerId.biometricId || "",
        department: employee.secondaryManager.managerId.department || "",
        designation: employee.secondaryManager.managerId.designation || employee.secondaryManager.managerId.jobTitle || "",
        phone: employee.secondaryManager.managerId.phone || "",
        email: employee.secondaryManager.managerId.email || "",
        profilePhotoUrl: employee.secondaryManager.managerId.profilePhoto?.url || null,
      }
      : employee.secondaryManager?.managerName
        ? { name: employee.secondaryManager.managerName, biometricId: "", department: "", designation: "", phone: "", email: "", profilePhotoUrl: null }
        : null;

    res.json({ success: true, primaryManager, secondaryManager });
  } catch (e) {
    console.error("[my-managers]", e.message);
    res.status(500).json({ error: e.message });
  }
});


router.post("/employee/create", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
  try {
    const { name, email, mobile, city, department, role: empRole, employeeId: chosenId } = req.body;
    if (!name || !email || !mobile || !city || !department) {
      return res.status(400).json({ error: "All fields required." });
    }

    // ── VALIDATE chosen biometricId is not already taken in CoWork ────────────
    if (chosenId) {
      const existing = await db.collection("cowork_employees").doc(chosenId).get();
      if (existing.exists) {
        return res.status(400).json({ error: `ID ${chosenId} is already assigned to another CoWork employee.` });
      }
    }

    // ── CHECK: email must not already exist in Firebase Auth ────────────────
    try {
      await auth.getUserByEmail(email.trim().toLowerCase());
      return res.status(400).json({
        error: "This email address is already in use. Please use a different email.",
      });
    } catch (authErr) {
      if (authErr.code !== "auth/user-not-found") throw authErr;
    }

    const resolvedRole = empRole === "tl" ? "tl" : "employee";
    const result = await svc.createCoworkEmployee({ name, email, mobile, city, department, role: resolvedRole, employeeId: chosenId || null });

    // Send welcome email (non-blocking)
    sendWelcomeEmail(
      { name, email, employeeId: result.employeeId, role: resolvedRole, department },
      result.tempPassword
    ).catch(err => console.error("[cowork/create-employee] Email error:", err.message));

    invalidateEmpListCache();
    res.status(201).json({
      success: true,
      employeeId: result.employeeId,
      tempPassword: result.tempPassword,
      role: resolvedRole,
    });
  } catch (e) {
    // Firebase also throws this if race condition hits after our check
    if (e.code === "auth/email-already-exists") {
      return res.status(400).json({
        error: "This email address is already in use. Please use a different email.",
      });
    }
    res.status(400).json({ error: e.message });
  }
});

router.get("/employee/list", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
  try { res.json({ employees: await svc.listCoworkEmployees() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/employee/:id", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const emp = await svc.getCoworkEmployee(req.params.id);
    if (!emp) return res.status(404).json({ error: "Not found" });
    res.json({ employee: emp });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/employee/fcm-token", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try { await svc.saveFCMToken(req.coworkUser.employeeId, req.body.token); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Group ─────────────────────────────────────────────────
router.post("/group/create", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
  try {
    const { name, description, memberIds } = req.body;
    if (!name || !memberIds?.length) return res.status(400).json({ error: "name and memberIds required" });
    const group = await svc.createCoworkGroup({
      name,
      description,
      memberIds,
      createdBy: req.coworkUser.employeeId,
      createdByAuthUid: req.coworkUser.authUid
    });
    res.status(201).json({ group });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete("/group/:groupId", verifyCoworkToken, verifyCeoToken, async (req, res) => {
  try { await svc.deleteCoworkGroup(req.params.groupId, req.coworkUser.employeeId); res.json({ success: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get("/group/list", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const groups = await svc.listCoworkGroups(req.coworkUser.employeeId, req.coworkUser.role);
    res.json({ groups });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/group/:groupId", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const group = await svc.getCoworkGroup(req.params.groupId);
    if (!group) return res.status(404).json({ error: "Group not found" });
    res.json({ group });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CEO resets any employee's password ───────────────────
router.post("/employee/:id/reset-password", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
  try {
    const { newPassword } = req.body;
    const { id: employeeId } = req.params;

    if (!newPassword || newPassword.length < 6)
      return res.status(400).json({ error: "Password must be at least 6 characters." });

    const empDoc = await db.collection("cowork_employees").doc(employeeId).get();
    if (!empDoc.exists) return res.status(404).json({ error: "Employee not found." });

    const empData = empDoc.data();
    const authUid = empData.authUid;
    if (!authUid) return res.status(400).json({ error: "Employee has no linked auth account." });

    // Update password in Firebase Auth
    await auth.updateUser(authUid, { password: newPassword });

    // Update Firestore
    await db.collection("cowork_employees").doc(employeeId).update({
      passwordChanged: false,
      tempPassword: newPassword,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // ← Force logout — revoke all their tokens instantly
    await auth.revokeRefreshTokens(authUid);

    // Notify employee via email
    try {
      const { sendNotificationEmail } = require("../../services/emailNotifications.service");
      await sendNotificationEmail({
        senderId: req.coworkUser.employeeId,
        senderName: req.coworkUser.employeeName || "Admin",
        receiverId: employeeId,
        receiverName: empData.name || employeeId,
        receiverEmail: empData.email,
        type: "password_reset",
        title: "Your CoWork password was reset",
        body: "Your password has been reset. Please log in with your new password.",
        data: {},
      });
    } catch (e) { console.error("[password_reset email]", e.message); }

    // Push notification for password reset
    try {
      const { sendPushToEmployees } = require("../../services/fcmPush.service");
      await sendPushToEmployees(
        [employeeId],
        "🔐 Password Reset",
        "Your CoWork password was reset. Please log in with your new password.",
        { type: "password_reset" }
      );
    } catch (e) { console.error("[password_reset push]", e.message); }

    console.log(`[ResetPassword] ${employeeId} session revoked by ${req.coworkUser.employeeId}`);
    return res.json({
      success: true,
      message: `Password reset for ${empData.name || employeeId}. They have been logged out automatically.`,
    });
  } catch (e) {
    console.error("[reset-password]", e);
    return res.status(500).json({ error: e.message });
  }
});


// ── UPDATE GROUP (name / description) ─────────────────────
router.patch("/group/:groupId", verifyCoworkToken, verifyCeoToken, async (req, res) => {
  try {
    const { name, description } = req.body;
    const updated = await svc.updateCoworkGroup(req.params.groupId, req.coworkUser.employeeId, { name, description });
    res.json({ success: true, group: updated });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// ── ADD MEMBER ─────────────────────────────────────────────
router.post("/group/:groupId/members", verifyCoworkToken, verifyCeoToken, async (req, res) => {
  try {
    const { employeeId } = req.body;
    if (!employeeId) return res.status(400).json({ error: "employeeId required" });
    const result = await svc.addGroupMember(req.params.groupId, req.coworkUser.employeeId, req.coworkUser.role, employeeId);
    res.json({ success: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// ── REMOVE MEMBER ─────────────────────────────────────────
router.delete("/group/:groupId/members/:employeeId", verifyCoworkToken, verifyCeoToken, async (req, res) => {
  try {
    const result = await svc.removeGroupMember(req.params.groupId, req.coworkUser.employeeId, req.coworkUser.role, req.params.employeeId);
    res.json({ success: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});



router.get("/group/:groupId/members", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { groupId } = req.params;
    const groupDoc = await db.collection("cowork_groups").doc(groupId).get();
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });
    const groupData = groupDoc.data();
    const memberIds = groupData.memberIds || [];
    const members = [];
    for (const id of memberIds) {
      const memberDoc = await db.collection("cowork_employees").doc(id).get();
      if (memberDoc.exists) members.push({ employeeId: id, ...memberDoc.data() });
    }
    res.json({ members });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Notify-only endpoints (frontend already wrote to Firestore, just need push+email) ──
router.post("/direct-message/notify", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  // Always respond 200 immediately — push/email are fire-and-forget
  const { toEmployeeId, text, messageType } = req.body;
  if (!toEmployeeId) return res.status(400).json({ error: "toEmployeeId required" });
  res.json({ success: true }); // respond immediately, don't block on FCM
  // Fire FCM push async
  try {
    const { sendPushToEmployees } = require("../../services/fcmPush.service");
    await sendPushToEmployees([toEmployeeId], `💬 DM · ${req.coworkUser.name}`, (text || "📎 Attachment").slice(0, 80), { type: "direct_message" });
  } catch (e) { console.error("[dm notify FCM]", e.message); }
  // Fire email async
  try {
    const { sendNotificationEmail } = require("../../services/emailNotifications.service");
    const empDoc = await db.collection("cowork_employees").doc(toEmployeeId).get();
    if (empDoc.exists && empDoc.data().email) {
      const emp = empDoc.data();
      await sendNotificationEmail({ senderId: req.coworkUser.employeeId, senderName: req.coworkUser.name, receiverId: toEmployeeId, receiverName: emp.name, receiverEmail: emp.email, type: "direct_message", title: req.coworkUser.name, body: (text || "📎 Attachment").slice(0, 80), data: {} });
    }
  } catch (e) { console.error("[dm notify email]", e.message); }
});

router.post("/group/:groupId/notify", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { text, messageType } = req.body;
    const groupDoc = await db.collection("cowork_groups").doc(groupId).get();
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });
    const group = groupDoc.data();
    const recipients = (group.memberIds || []).filter(id => id !== req.coworkUser.employeeId);
    if (!recipients.length) return res.json({ success: true });
    // Only send push notification + email — do NOT write to Firestore again
    const { sendPushToEmployees } = require("../../services/fcmPush.service");
    await sendPushToEmployees(recipients, `👥 ${group.name} · ${req.coworkUser.name}`, (text || "📎 Attachment").slice(0, 80), { type: "group_message", groupId });
    try {
      const { sendNotificationEmail } = require("../../services/emailNotifications.service");
      const empDocs = await Promise.all(recipients.map(id => db.collection("cowork_employees").doc(id).get()));
      for (const empDoc of empDocs) {
        if (!empDoc.exists) continue;
        const emp = empDoc.data();
        if (!emp.email) continue;
        await sendNotificationEmail({ senderId: req.coworkUser.employeeId, senderName: req.coworkUser.name, receiverId: emp.employeeId || empDoc.id, receiverName: emp.name, receiverEmail: emp.email, type: "group_message", title: `${req.coworkUser.name} in ${group.name}`, body: (text || "📎 Attachment").slice(0, 80), data: { groupId, groupName: group.name } });
      }
    } catch (e) { console.error("[group notify email]", e.message); }
    res.json({ success: true });
  } catch (e) {
    console.error("[group notify]", e.message);
    res.json({ success: true }); // never fail — push is best-effort
  }
});

router.post("/group/:groupId/message", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const msg = await svc.sendGroupMessage({ groupId: req.params.groupId, senderId: req.coworkUser.employeeId, senderName: req.coworkUser.name, text: req.body.text, attachments: req.body.attachments || [] });
    res.status(201).json({ message: msg });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get("/group/:groupId/messages", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try { res.json({ messages: await svc.getGroupMessages(req.params.groupId, req.query.limit) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Direct Messages ───────────────────────────────────────
router.post("/direct-message/send", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { toEmployeeId, text, attachments, messageType } = req.body;
    // text is optional if there are attachments
    if (!toEmployeeId) return res.status(400).json({ error: "toEmployeeId required" });
    if (!text?.trim() && (!attachments || !attachments.length)) return res.status(400).json({ error: "text or attachments required" });
    const result = await svc.sendDirectMessage({
      fromEmployeeId: req.coworkUser.employeeId,
      toEmployeeId,
      senderName: req.coworkUser.name,
      text: text || "",
      attachments: attachments || [],
      messageType: messageType || "text",
    });
    res.status(201).json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get("/direct-message/conversations", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try { res.json({ conversations: await svc.listConversations(req.coworkUser.employeeId) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});


router.get("/direct-message/:convId/messages", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    res.
      json({ messages: await svc.getDirectMessages(req.params.convId, req.query.limit) });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Meets ─────────────────────────────────────────────────
router.post("/schedule-meet/create", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
  try {
    const { title, description, participants, dateTime, googleMeetLink } = req.body;
    if (!title || !dateTime)
      return res.status(400).json({ error: "Title and dateTime are required." });
    const meet = await svc.scheduleCoworkMeet({ title, description, createdBy: req.coworkUser.employeeId, participants, dateTime, googleMeetLink });
    res.status(201).json({ meet });
    // Email is handled inside svc.scheduleCoworkMeet() via _notifyMany → sendNotificationEmail

  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get("/schedule-meet/list", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try { res.json({ meets: await svc.listCoworkMeets(req.coworkUser.employeeId, req.coworkUser.role) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/schedule-meet/:meetId", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const meet = await svc.getCoworkMeet(req.params.meetId);
    if (!meet) return res.status(404).json({ error: "Not found" });
    res.json({ meet });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Edit / Update Meeting (CEO or TL who created it) ─────────
router.patch("/schedule-meet/:meetId/edit", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
  try {
    const { meetId } = req.params;
    const { employeeId } = req.coworkUser;
    const { title, description, dateTime, googleMeetLink, participants } = req.body;
    const result = await svc.updateCoworkMeet({
      meetId,
      updatedBy: employeeId,
      title, description, dateTime, googleMeetLink, participants,
    });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Cancel Meeting (CEO or TL who created it) ─────────────
router.patch("/schedule-meet/:meetId/cancel", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
  try {
    const { meetId } = req.params;
    const { employeeId, name } = req.coworkUser;
    const result = await svc.cancelCoworkMeet({ meetId, cancelledBy: employeeId, cancelledByName: name });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Tasks ─────────────────────────────────────────────────
router.post("/task/assign", verifyCoworkToken, verifyCeoToken, async (req, res) => {
  try { res.status(201).json({ task: await svc.assignCoworkTask({ ...req.body, assignedBy: req.coworkUser.employeeId }) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch("/task/:taskId/progress", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try { res.json({ result: await svc.updateTaskProgress({ taskId: req.params.taskId, employeeId: req.coworkUser.employeeId, progressPercent: req.body.progressPercent, note: req.body.note }) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get("/task/list", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try { res.json({ tasks: await svc.listTasks(req.coworkUser.employeeId, req.coworkUser.role) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── NEW: TL approves a task assigned to them by an employee ───────────────────
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

    res.json({ success: true, message: "Task approved and is now open." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Notifications ─────────────────────────────────────────
router.get("/notifications", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { employeeId } = req.coworkUser;
    const unreadOnly = req.query.unreadOnly === "true";
    console.log(`GET /notifications - employee: ${employeeId}, unreadOnly: ${unreadOnly}`);
    const notifications = await svc.getNotifications(employeeId, unreadOnly);
    res.json({ notifications: notifications || [] });
  } catch (e) {
    console.error('Error in /notifications endpoint:', e);
    res.status(200).json({ notifications: [], error: e.message });
  }
});

router.patch("/notifications/read-all", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { employeeId } = req.coworkUser;
    console.log(`PATCH /notifications/read-all - employee: ${employeeId}`);
    const result = await svc.markNotificationsRead(employeeId);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('Error in /notifications/read-all endpoint:', e);
    res.status(200).json({ success: false, error: e.message });
  }
});

// ── UPDATE EMPLOYEE ID (CEO only) ─────────────────────────────────────────────
// PATCH /cowork/employee/:id/update-id
// Changes employeeId value (biometricId from HR MongoDB) for an existing CoWork employee.
// Steps: create new Firestore doc with new ID → copy all data → delete old doc
// Field name "employeeId" stays the same — only the value changes (e.g. E022 → GR022)
router.patch("/employee/:id/update-id", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
  try {
    const { id: oldId } = req.params;
    const { newEmployeeId } = req.body;

    if (!newEmployeeId) return res.status(400).json({ error: "newEmployeeId is required." });
    if (oldId === newEmployeeId) return res.status(400).json({ error: "New ID is same as current ID." });

    // Cannot change CEO's ID
    if (oldId === "E000") return res.status(400).json({ error: "Cannot change CEO's ID." });

    // Check new ID not already taken in Firestore
    const newDoc = await db.collection("cowork_employees").doc(newEmployeeId).get();
    if (newDoc.exists) {
      return res.status(400).json({ error: `ID ${newEmployeeId} is already assigned to ${newDoc.data().name}.` });
    }

    // Fetch existing employee
    const oldDoc = await db.collection("cowork_employees").doc(oldId).get();
    if (!oldDoc.exists) return res.status(404).json({ error: "Employee not found." });

    const empData = oldDoc.data();

    // Create new doc with new ID, copy all data, update employeeId field value
    await db.collection("cowork_employees").doc(newEmployeeId).set({
      ...empData,
      employeeId: newEmployeeId,   // field name unchanged, value updated
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Delete old doc
    await db.collection("cowork_employees").doc(oldId).delete();

    console.log(`[UpdateEmployeeId] ${oldId} → ${newEmployeeId} by ${req.coworkUser.employeeId}`);

    // Notify employee via push
    try {
      const { sendPushToEmployees } = require("../../services/fcmPush.service");
      await sendPushToEmployees([newEmployeeId], "🆔 Employee ID Updated", `Your CoWork ID is now ${newEmployeeId}. Please log in again.`, { type: "id_updated" });
    } catch (e) { console.error("[update-id push]", e.message); }

    res.json({ success: true, oldId, newEmployeeId, message: `Employee ID updated from ${oldId} to ${newEmployeeId}.` });
  } catch (e) {
    console.error("[update-id]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE EMPLOYEE (CEO only) ────────────────────────────────────────────────
router.delete("/employee/:id", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
  try {
    const { id: employeeId } = req.params;

    if (employeeId === "E000" || employeeId === req.coworkUser.employeeId) {
      return res.status(400).json({ error: "You cannot delete your own account." });
    }

    const empDoc = await db.collection("cowork_employees").doc(employeeId).get();
    if (!empDoc.exists) return res.status(404).json({ error: "Employee not found." });

    const empData = empDoc.data();
    const authUid = empData.authUid;

    // Delete from Firebase Auth
    if (authUid) {
      try {
        await auth.deleteUser(authUid);
        console.log(`[DeleteEmployee] Auth deleted: ${authUid} (${empData.email})`);
      } catch (authErr) {
        if (authErr.code !== "auth/user-not-found") throw authErr;
      }
    }

    // Delete from Firestore
    await db.collection("cowork_employees").doc(employeeId).delete();
    console.log(`[DeleteEmployee] Firestore deleted: ${employeeId} (${empData.email})`);

    invalidateEmpListCache();
    return res.json({
      success: true,
      message: `${empData.name} has been deleted. Email ${empData.email} can now be re-used.`,
    });
  } catch (e) {
    console.error("[DeleteEmployee]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── TEST EMAIL (CEO only) — hit this to verify Brevo is working ──────────────
// GET /cowork/test-email?to=your@email.com
router.get("/test-email", verifyCoworkToken, verifyCeoToken, async (req, res) => {
  const { sendWelcomeEmail } = require("../../services/emailNotifications.service");
  const toEmail = req.query.to || req.coworkUser.employeeData?.email;
  if (!toEmail) return res.status(400).json({ error: "Pass ?to=email in query" });
  try {
    await sendWelcomeEmail(
      { name: "Test User", email: toEmail, employeeId: "E_TEST", role: "employee", department: "Testing" },
      "TestPass123"
    );
    res.json({ success: true, message: `Test email sent to ${toEmail}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ── CHANGE ROLE (CEO only) ────────────────────────────────────────────────────
router.post("/employee/:employeeId/change-role", verifyCoworkToken, async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { role } = req.body;

    if (!["employee", "tl"].includes(role))
      return res.status(400).json({ error: "Invalid role. Must be 'employee' or 'tl'" });
    if (req.coworkUser?.role !== "ceo")
      return res.status(403).json({ error: "Only CEO can change roles" });

    const empDoc = await db.collection("cowork_employees").doc(employeeId).get();
    if (!empDoc.exists) return res.status(404).json({ error: "Employee not found" });
    const authUid = empDoc.data().authUid;
    if (!authUid) return res.status(400).json({ error: "Employee has no linked auth account" });

    // Update custom claims
    await auth.setCustomUserClaims(authUid, { role });

    // Update Firestore
    await db.collection("cowork_employees").doc(employeeId).update({
      role,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // ← Force logout — revoke all their tokens instantly
    await auth.revokeRefreshTokens(authUid);

    // Notify employee via push + email
    try {
      const { sendPushToEmployees } = require("../../services/fcmPush.service");
      await sendPushToEmployees([employeeId], `👤 Role Changed`, `Your CoWork role is now ${role === "tl" ? "Team Lead" : "Employee"}. Please log in again.`, { type: "role_changed" });
    } catch (e) { console.error("[role_changed push]", e.message); }
    try {
      const { sendNotificationEmail } = require("../../services/emailNotifications.service");
      const empData = empDoc.data();
      await sendNotificationEmail({
        senderId: req.coworkUser.employeeId,
        senderName: req.coworkUser.employeeName || "Admin CEO",
        receiverId: employeeId,
        receiverName: empData.name || employeeId,
        receiverEmail: empData.email,
        type: "role_changed",
        title: "Your CoWork role has been updated",
        body: `Your role is now ${role === "tl" ? "Team Lead" : "Employee"}`,
        data: { newRole: role },
      });
    } catch (e) { console.error("[role_changed email]", e.message); }

    // Invalidate auth cache so new role takes effect immediately
    const { invalidateEmployeeCache } = require("../../Middlewear/coworkAuth");
    invalidateEmployeeCache(authUid);

    console.log(`[ChangeRole] ${employeeId} → ${role} | session revoked | cache cleared`);
    res.json({ success: true, employeeId, role });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ── NOTIFY REQUEST RESPONSE (FCM push + email to request sender) ──────────────
router.post("/notify-request-response", verifyCoworkToken, async (req, res) => {
  try {
    const { recipientId, title, body, type, subject, responseMessage } = req.body;
    if (!recipientId) return res.status(400).json({ error: "recipientId required" });

    // FCM push — works on closed iPhone
    try {
      const { sendPushToEmployees } = require("../../services/fcmPush.service");
      await sendPushToEmployees([recipientId], title, body, { type });
    } catch (e) { console.error("[request response push]", e.message); }

    // Email with cooldown
    try {
      const { sendNotificationEmail } = require("../../services/emailNotifications.service");
      const empDoc = await db.collection("cowork_employees").doc(recipientId).get();
      if (empDoc.exists() && empDoc.data().email) {
        const emp = empDoc.data();
        await sendNotificationEmail({
          senderId: req.coworkUser.employeeId,
          senderName: req.coworkUser.employeeName || "CoWork",
          receiverId: recipientId,
          receiverName: emp.name || recipientId,
          receiverEmail: emp.email,
          type,
          title,
          body,
          data: { subject: subject || "", responseMessage: responseMessage || "" },
        });
      }
    } catch (e) { console.error("[request response email]", e.message); }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;