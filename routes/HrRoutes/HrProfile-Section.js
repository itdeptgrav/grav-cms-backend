const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const HRDepartment = require("../../models/HRDepartment");

const Employee = require("../../models/Employee");

/*
 * WHOSE account is this?
 *
 * These routes used to read HRDepartment and nothing else. That collection is
 * now EMPTY — the boot-time seeding of default department accounts was removed,
 * and HR is staffed by employees holding an `hr` DepartmentRole instead. So
 * every one of these routes answered 404 for every user, and the profile page
 * showed "Failed to load profile data" to everybody, always.
 *
 * HRDepartment is tried first so a legacy account still behaves exactly as it
 * did; Employee is the fallback and, today, the only one that matches anybody.
 * Both models hash `password` in a pre-save hook, so the change-password path
 * below is identical either way.
 */
async function resolveAccount(userId) {
  if (!userId) return null;
  const hr = await HRDepartment.findById(userId);
  if (hr) return { doc: hr, kind: "hr" };
  const emp = await Employee.findById(userId);
  if (emp) return { doc: emp, kind: "employee" };
  return null;
}

/*
 * One shape for the page, whichever collection it came from.
 *
 * HRDepartment carries `name`; Employee carries firstName/lastName. Returning
 * the raw document would make the page render a blank name for an employee and
 * be right for nobody.
 */
function shapeAccount(acct) {
  const d = acct.doc;
  return {
    _id: d._id,
    name:
      d.name ||
      [d.firstName, d.lastName].filter(Boolean).join(" ").trim() ||
      "",
    email: d.email || "",
    phone: d.phone || "",
    employeeId: d.employeeId || "",
    department: d.department || "",
    role: d.role || "",
    createdAt: d.createdAt,
  };
}

/** Write a display name back to whichever shape the collection uses. */
function applyName(acct, name) {
  const clean = String(name || "").trim();
  if (acct.kind === "hr") {
    acct.doc.name = clean;
    return;
  }
  // An employee record has no `name`. Everything before the last space is the
  // first name, so "Mary Anne Smith" keeps "Mary Anne" rather than losing it.
  const bits = clean.split(/\s+/).filter(Boolean);
  acct.doc.lastName = bits.length > 1 ? bits.pop() : "";
  acct.doc.firstName = bits.join(" ");
}

// An HR user editing their OWN account. Logged like any other change: "who
// changed this email" has to be answerable even - especially - when the answer
// is the account holder themselves.
const { recordChange } = require("../../services/changeLog");

// ✅ GET HR Profile
router.get("/profile", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const acct = await resolveAccount(req.user.id);

    if (!acct) {
      return res.status(404).json({
        success: false,
        message: "No account found for this session. Sign in again.",
      });
    }

    res.status(200).json({
      success: true,
      data: shapeAccount(acct),
    });
  } catch (error) {
    console.error("Get HR profile error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// ✅ UPDATE HR Profile
router.put("/profile", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { name, phone, email } = req.body;

    // Validate input
    if (!name || !phone || !email) {
      return res.status(400).json({
        success: false,
        message: "Name, phone and email are required",
      });
    }

    const acct = await resolveAccount(req.user.id);
    if (!acct) {
      return res.status(404).json({
        success: false,
        message: "No account found for this session. Sign in again.",
      });
    }

    // Taken by somebody else in EITHER collection. Checking only one would let
    // an employee take an address a legacy HR account already answers to, and
    // then two accounts would sign in as the same person.
    const mail = email.toLowerCase();
    const [clashHr, clashEmp] = await Promise.all([
      HRDepartment.findOne({ email: mail, _id: { $ne: req.user.id } }).select("_id").lean(),
      Employee.findOne({ email: mail, _id: { $ne: req.user.id } }).select("_id").lean(),
    ]);
    if (clashHr || clashEmp) {
      return res.status(400).json({
        success: false,
        message: "Email already in use",
      });
    }

    const previousHR = shapeAccount(acct);

    applyName(acct, name);
    acct.doc.phone = phone;
    acct.doc.email = mail;
    await acct.doc.save();

    const updatedHR = shapeAccount(acct);

    /* An employee's roles are keyed on their email address, so a change here
       orphans every one of them — the same lockout services/departmentRoles.js
       documents. Move them with it. Best effort: a profile edit that worked
       must not fail because the person happened to hold a role. */
    if (previousHR.email && previousHR.email !== mail) {
      try {
        const { followEmailChange } = require("../../services/departmentRoles");
        await followEmailChange(previousHR.email, mail);
      } catch (err) {
        console.warn("[hr-profile] roles did not follow the email:", err.message);
      }
    }

    recordChange(req, {
      departmentSlug: "hr",
      section: "hr:profile",
      entity: "hr-profile",
      entityId: String(req.user.id),
      entityLabel: updatedHR?.name || previousHR?.name || String(req.user.id),
      action: "update",
      before: { name: previousHR?.name, phone: previousHR?.phone, email: previousHR?.email },
      after: { name: updatedHR?.name, phone: updatedHR?.phone, email: updatedHR?.email },
    });

    res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      data: updatedHR,
    });
  } catch (error) {
    console.error("Update HR profile error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// ✅ CHANGE PASSWORD
router.put("/change-password", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    // Validate input
    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "All password fields are required",
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "New passwords do not match",
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters long",
      });
    }

    const acct = await resolveAccount(req.user.id);
    if (!acct) {
      return res.status(404).json({
        success: false,
        message: "No account found for this session. Sign in again.",
      });
    }
    const hr = acct.doc;

    /* An account with no password set at all — bcrypt.compare against null
       throws, which surfaced as a 500 and read as "the server is broken"
       rather than "you have never had a password here". */
    if (!hr.password) {
      return res.status(400).json({
        success: false,
        message:
          "This account has no password set. Ask an administrator to set one " +
          "before changing it.",
      });
    }

    // Verify current password
    const isPasswordValid = await bcrypt.compare(currentPassword, hr.password);

    if (!isPasswordValid) {
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect",
      });
    }

    // Update password (auto-hashed by pre-save hook)
    hr.password = newPassword;
    await hr.save();

    // The password itself is never written to the log - only the fact of it.
    recordChange(req, {
      departmentSlug: "hr",
      section: "hr:profile",
      entity: "hr-profile",
      entityId: String(req.user.id),
      entityLabel: shapeAccount(acct).name || String(req.user.id),
      action: "update",
      summary:
        "Changed their own password. The current password was verified first, so this was " +
        "the account holder and not an administrative reset.",
      fields: [{ path: "password", label: "Password", to: "[changed]", kind: "changed" }],
    });

    res.status(200).json({
      success: true,
      message: "Password changed successfully",
    });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

module.exports = router;
