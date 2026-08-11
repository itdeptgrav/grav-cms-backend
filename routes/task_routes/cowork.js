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

// GET /cowork/scheduling/blocked-dates?employeeId=E014&from=2026-07-16&to=2026-07-30
router.get("/scheduling/blocked-dates", verifyCoworkToken, async (req, res) => {
  try {
    const { employeeId, from, to } = req.query;
    if (!employeeId || !from || !to) {
      return res.status(400).json({ error: "employeeId, from, and to (YYYY-MM-DD) are required." });
    }

    const mongoose = require("mongoose");
    const CompanyHoliday = mongoose.model("CompanyHoliday");
    const LeaveApplication = mongoose.model("LeaveApplication");

    const [holidays, leaves] = await Promise.all([
      CompanyHoliday.find({ date: { $gte: from, $lte: to } }).lean(),
      LeaveApplication.find({
        biometricId: employeeId,
        status: { $in: ["hr_approved", "withdraw_pending"] },
        fromDate: { $lte: to },
        toDate: { $gte: from },
      }).lean(),
    ]);

    const blocked = {};
    for (const h of holidays) blocked[h.date] = { type: "holiday", name: h.name };

    for (const lv of leaves) {
      let cur = new Date(lv.fromDate + "T00:00:00Z");
      const end = new Date(lv.toDate + "T00:00:00Z");
      while (cur <= end) {
        const ds = cur.toISOString().slice(0, 10);
        if (ds >= from && ds <= to && !blocked[ds]) {
          blocked[ds] = { type: "leave", leaveType: lv.leaveType };
        }
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    }

    res.json({ success: true, blockedDates: blocked });
  } catch (e) {
    console.error("[blocked-dates]", e.message);
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
    const { name, email, mobile = "", city = "", department, role: empRole, employeeId: chosenId } = req.body;
    if (!name || !email || !department) {
      return res.status(400).json({ error: "Name, email and department are required." });
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

// GET /cowork/admin/hr-employees — HR employees from MongoDB, tagged with hasCoworkAccount.
// CEO-only: provisioning is an administrative act with permanent side effects.
router.get("/admin/hr-employees", verifyCoworkToken, verifyCeoToken, async (req, res) => {
  try {
    const Employee = require("../../models/Employee");

    // Build search/filter
    const filter = {};
    if (req.query.search) {
      const rx = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { firstName: rx }, { lastName: rx }, { email: rx },
        { biometricId: rx }, { designation: rx },
      ];
    }
    if (req.query.department && req.query.department !== "all") {
      filter.department = req.query.department;
    }

    const [hrEmployees, coworkSnap] = await Promise.all([
      Employee.find(filter)
        .select("firstName lastName email department biometricId designation phone")
        .sort({ firstName: 1 })
        .limit(500)
        .lean(),
      db.collection("cowork_employees").get(),
    ]);

    // Cross-reference — a CoWork account exists when the biometricId matches the
    // Firestore doc id, OR the email matches.
    //
    // Maps rather than Sets, because WHICH document matched is the useful part
    // and it was being thrown away: the caller learned that an account exists
    // and not what it is called, so an admin surface could show "Linked" and
    // then had nothing to address that account BY. Anything acting on an
    // existing account — resetting a password, for one — needs its id.
    const coworkById = new Map(coworkSnap.docs.map((d) => [d.id, d.id]));
    const coworkByEmail = new Map(
      coworkSnap.docs
        .map((d) => [(d.data().email || "").toLowerCase(), d.id])
        .filter(([email]) => email),
    );

    const employees = hrEmployees.map((e) => {
      const coworkEmployeeId =
        (e.biometricId && coworkById.get(e.biometricId)) ||
        coworkByEmail.get((e.email || "").toLowerCase()) ||
        null;
      return {
        hrId: String(e._id),
        name: `${e.firstName || ""} ${e.lastName || ""}`.trim() || e.email || "(unnamed)",
        email: e.email || "",
        department: e.department || "",
        designation: e.designation || "",
        biometricId: e.biometricId || "",
        phone: e.phone || "",
        hasCoworkAccount: !!coworkEmployeeId,
        // The `cowork_employees` document id — what every other CoWork route
        // takes as `:id`. Null for somebody who has no account yet.
        coworkEmployeeId,
      };
    });

    // Distinct departments from the FULL set (not filtered), for the filter dropdown.
    const departments = (
      await Employee.distinct("department", { email: { $exists: true, $ne: "" } })
    ).filter(Boolean).sort();

    res.json({
      success: true,
      employees,
      departments,
      total: employees.length,
      withAccount: employees.filter((e) => e.hasCoworkAccount).length,
    });
  } catch (e) {
    console.error("[admin/hr-employees]", e.message);
    res.status(500).json({ error: e.message });
  }
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

    // ── One call, four channels ──────────────────────────────────────────────
    // This sent a push and an email and wrote NO `cowork_notifications` row, so
    // being told your password was reset reached a phone and an inbox and never
    // the app — the same gap direct messages had. `notifyEmployees` is
    // `_notifyMany`: it writes the row, emits the socket event, pushes AND
    // emails, so the hand-rolled push and email that used to be here are gone
    // with it rather than doubling.
    try {
      await svc.notifyEmployees({
        recipientIds: [employeeId],
        type: "password_reset",
        title: "🔐 Password reset",
        body: `${req.coworkUser.employeeName || "An administrator"} reset your Cowork password. Sign in again with the new one.`,
        data: {},
        senderId: req.coworkUser.employeeId,
        senderName: req.coworkUser.employeeName || "Admin",
      });
    } catch (e) { console.error("[password_reset notify]", e.message); }

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
  // ── Durable record, so a message reaches the bell and not only the phone ──
  // This route sent push and email and wrote nothing, so a direct message
  // existed on a lock screen and in an inbox and NOWHERE in the app: the
  // notifications list never showed one, and `unreadDm` — which counts
  // `direct_message` rows — was permanently zero in both apps.
  //
  // Written before the push so the row exists by the time somebody taps the
  // notification and lands on the list.
  try {
    await svc.notifyEmployees({
      recipientIds: [toEmployeeId],
      type: "direct_message",
      title: `💬 DM · ${req.coworkUser.name}`,
      body: (text || "📎 Attachment").slice(0, 80),
      data: { conversationId: [req.coworkUser.employeeId, toEmployeeId].sort().join("_"), senderId: req.coworkUser.employeeId },
      senderId: req.coworkUser.employeeId,
      senderName: req.coworkUser.name,
    });
  } catch (e) { console.error("[dm notify row]", e.message); }
  // The push and the email used to be sent here by hand. `notifyEmployees` is
  // `_notifyMany`, which already does BOTH — plus the socket event — so doing
  // them again here would deliver every direct message twice on the phone and
  // twice by email.
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
    // The MESSAGE is not written here — it is already in Firestore, written by
    // the browser. What was missing is the notification RECORD: this route sent
    // push and email and nothing else, so a group message reached a phone and
    // an inbox and never the bell.
    //
    // `notifyEmployees` is `_notifyMany` — Firestore row, socket, push AND
    // email in one. The hand-rolled push and the email loop that used to live
    // here are gone with it, or every group message would arrive twice.
    await svc.notifyEmployees({
      recipientIds: recipients,
      type: "group_message",
      title: `👥 ${group.name} · ${req.coworkUser.name}`,
      body: (text || "📎 Attachment").slice(0, 80),
      data: { groupId, groupName: group.name, senderId: req.coworkUser.employeeId },
      senderId: req.coworkUser.employeeId,
      senderName: req.coworkUser.name,
    });
    res.json({ success: true });
  } catch (e) {
    console.error("[group notify]", e.message);
    res.json({ success: true }); // never fail — push is best-effort
  }
});

router.post("/group/:groupId/message", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const msg = await svc.sendGroupMessage({ groupId: req.params.groupId, senderId: req.coworkUser.employeeId, senderName: req.coworkUser.name, text: req.body.text, attachments: req.body.attachments || [], replyTo: req.body.replyTo || null, clientMessageId: req.body.clientMessageId || null });
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
    const { title, description, participants, dateTime, googleMeetLink, endsAt, agenda, taskId } = req.body;
    if (!title || !dateTime)
      return res.status(400).json({ error: "Title and dateTime are required." });
    const meet = await svc.scheduleCoworkMeet({ title, description, createdBy: req.coworkUser.employeeId, participants, dateTime, googleMeetLink, endsAt, agenda, taskId });
    res.status(201).json({ meet });
    // Email is handled inside svc.scheduleCoworkMeet() via _notifyMany → sendNotificationEmail

  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get("/schedule-meet/list", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try { res.json({ meets: await svc.listCoworkMeets(req.coworkUser.employeeId, req.coworkUser.role) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/* MUST stay above `/schedule-meet/:meetId` — registered after it, Express would
   match this path with meetId = "for-task" and return a 404 for a real task. */
router.get("/schedule-meet/for-task/:taskId", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try { res.json({ meets: await svc.listCoworkMeetsForTask(req.params.taskId) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/schedule-meet/:meetId", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const meet = await svc.getCoworkMeet(req.params.meetId);
    if (!meet) return res.status(404).json({ error: "Not found" });
    res.json({ meet });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Meeting audit trail ───────────────────────────────────
router.get("/schedule-meet/:meetId/events", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try { res.json({ events: await svc.listCoworkMeetEvents(req.params.meetId) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Lifecycle beyond cancel (organiser only; enforced in the service) ─────
router.patch("/schedule-meet/:meetId/status", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
  try {
    const { employeeId, name } = req.coworkUser;
    const result = await svc.setCoworkMeetStatus({
      meetId: req.params.meetId,
      employeeId,
      employeeName: name,
      status: req.body.status,
    });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* Presence takes verifyEmployeeToken, NOT verifyCeoOrTL: it is a statement
   about yourself, and an ordinary employee in the room has to be able to make
   it. The service checks that the caller is actually a participant. */
router.post("/schedule-meet/:meetId/presence", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { employeeId, name } = req.coworkUser;
    const result = await svc.recordCoworkMeetPresence({
      meetId: req.params.meetId,
      employeeId,
      employeeName: name,
      joined: req.body.joined === true,
    });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
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

// ── MARK ONE NOTIFICATION READ ───────────────────────────────────────────────
// PATCH /cowork/notifications/:notificationId/read
//
// MUST stay above /notifications/read-all? No — the paths cannot collide
// ("read-all" has no second segment). Kept adjacent to it so the pair is read
// together: this clears one row, that clears the inbox.
//
// The recipient check lives in the service, against the stored document, not
// against anything the client sent.
router.patch("/notifications/:notificationId/read", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const { employeeId } = req.coworkUser;
    const result = await svc.markNotificationRead(employeeId, req.params.notificationId);
    res.json(result);
  } catch (e) {
    console.error("Error in /notifications/:notificationId/read endpoint:", e);
    res.status(200).json({ success: false, error: e.message });
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

    // Notify the employee. Push ALONE before — and this is the worst message in
    // the product to deliver only to a lock screen, because it ends with an
    // instruction ("log in again") that somebody who missed it will not follow,
    // on an account whose old id has just stopped working.
    //
    // Addressed to the NEW id: the old document has been deleted by this point,
    // and a notification filed against it would be unreadable by anyone.
    try {
      await svc.notifyEmployees({
        recipientIds: [newEmployeeId],
        type: "id_updated",
        title: "🆔 Your Cowork ID changed",
        body: `${req.coworkUser.name} changed your Cowork ID from ${oldId} to ${newEmployeeId}. Sign out and sign in again — the old ID will not work.`,
        data: { oldId, newEmployeeId },
        senderId: req.coworkUser.employeeId,
        senderName: req.coworkUser.name,
      });
    } catch (e) { console.error("[update-id notify]", e.message); }

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

    // Row, socket, push and email in one — see the password-reset route above
    // for why the separate push and email calls that used to be here are gone.
    try {
      await svc.notifyEmployees({
        recipientIds: [employeeId],
        type: "role_changed",
        title: "👤 Your role changed",
        body: `${req.coworkUser.employeeName || "An administrator"} set your Cowork role to ${role === "tl" ? "Team Lead" : "Employee"}. Sign in again for it to take effect.`,
        data: { newRole: role },
        senderId: req.coworkUser.employeeId,
        senderName: req.coworkUser.employeeName || "Admin",
      });
    } catch (e) { console.error("[role_changed notify]", e.message); }

    // Invalidate auth cache so new role takes effect immediately
    const { invalidateEmployeeCache } = require("../../Middlewear/coworkAuth");
    invalidateEmployeeCache(authUid);
    invalidateEmpListCache(); // ← keep the Admin panel table in sync immediately

    console.log(`[ChangeRole] ${employeeId} → ${role} | session revoked | cache cleared`);
    res.json({ success: true, employeeId, role });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ── CHANGE DEPARTMENT (CEO only) ──────────────────────────────────────────────
router.post("/employee/:employeeId/change-department", verifyCoworkToken, async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { department } = req.body;

    if (!department || !department.trim())
      return res.status(400).json({ error: "Department is required" });
    if (req.coworkUser?.role !== "ceo")
      return res.status(403).json({ error: "Only CEO can change department" });

    const empDoc = await db.collection("cowork_employees").doc(employeeId).get();
    if (!empDoc.exists) return res.status(404).json({ error: "Employee not found" });
    const empData = empDoc.data();
    const authUid = empData.authUid;
    const oldDept = empData.department || "";
    const newDept = department.trim();

    await db.collection("cowork_employees").doc(employeeId).update({
      department: newDept,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // One call for all four channels — see the password-reset route above.
    try {
      await svc.notifyEmployees({
        recipientIds: [employeeId],
        type: "department_changed",
        title: "🏢 Your department changed",
        body: `${req.coworkUser.name || "An administrator"} moved you${oldDept ? ` from ${oldDept}` : ""} to ${newDept}.`,
        data: { oldDepartment: oldDept, newDepartment: newDept },
        senderId: req.coworkUser.employeeId,
        senderName: req.coworkUser.name || "Admin",
      });
    } catch (e) { console.error("[department_changed notify]", e.message); }

    if (authUid) {
      const { invalidateEmployeeCache } = require("../../Middlewear/coworkAuth");
      invalidateEmployeeCache(authUid);
    }
    invalidateEmpListCache(); // ← keep the Admin panel table in sync immediately

    console.log(`[ChangeDepartment] ${employeeId} → ${newDept}`);
    res.json({ success: true, employeeId, department: newDept });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ── NOTIFY REQUEST RESPONSE (FCM push + email to request sender) ──────────────
router.post("/notify-request-response", verifyCoworkToken, async (req, res) => {
  try {
    const { recipientId, title, body, type, subject, responseMessage } = req.body;
    if (!recipientId) return res.status(400).json({ error: "recipientId required" });

    // ── One call, four channels ──────────────────────────────────────────────
    // Push and email only before, so this reached a phone and an inbox and
    // never the app.
    //
    // The email never reached the inbox either: it was guarded by
    // `empDoc.exists()`, called as a FUNCTION. On a firebase-admin
    // `DocumentSnapshot` `exists` is a property, so that line threw a TypeError
    // straight into the surrounding `catch`, every time, and the failure was
    // logged as an email problem rather than a typo. `notifyEmployees` resolves
    // the recipient itself, so the whole block goes.
    try {
      await svc.notifyEmployees({
        recipientIds: [recipientId],
        type,
        title,
        body,
        data: { subject: subject || "", responseMessage: responseMessage || "" },
        senderId: req.coworkUser.employeeId,
        senderName: req.coworkUser.employeeName || "CoWork",
      });
    } catch (e) { console.error("[request response notify]", e.message); }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;