// routes/auth/passwordReset.js
//
// Self-service "forgot password" for the main CMS login (Sign in to GRAV —
// app/login/page.js). Mounted at /api/auth alongside deptAuth.js, whose
// /login this mirrors: an email here can belong to a department account
// (dept_users), an employee's own HR credentials, an accounting-only user, or
// (until the migration finishes) one of the twelve legacy department
// collections — the SAME four identity kinds /login tries, in the SAME order,
// via the SAME resolvers deptAuth.js already exports. Whichever kind an email
// resolves to at request time is remembered on the OTP record itself, so
// reset-password changes the exact account the code was issued for.
//
// Flow: request-otp (email → 4-digit code, emailed) → check-otp (verify only,
// used by the UI to advance a step without spending an attempt on the actual
// reset) → reset-password (verify + set the new password). Mirrors
// routes/Customer_Routes/PasswordResetOTP.js's shape and constants exactly —
// same OTP length, TTL and attempt cap — so the two forgot-password flows in
// this codebase behave identically from a user's perspective.

const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const axios = require("axios");

const DeptUser = require("../../models/Access/DeptUser");
const Employee = require("../../models/Employee");
const PasswordResetOTP = require("../../models/Auth/PasswordResetOTP");
const { findAccountantUser } = require("../../services/accountantAccess");
const { upgradeEmployeePassword } = require("../../utils/employeePassword");
const { findLegacyUser, legacyModel } = require("./deptAuth");

const OTP_LENGTH = 4;
const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MIN_PASSWORD_LENGTH = 8; // matches deptAuth.js's own change-password rule

const generateOtp = (length = OTP_LENGTH) => {
  const max = Math.pow(10, length);
  const n = crypto.randomInt(0, max);
  return String(n).padStart(length, "0");
};

const hashOtp = async (otp) => bcrypt.hash(otp, await bcrypt.genSalt(10));

const isValidEmail = (e) => typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

/**
 * Which account (if any) this email signs in as — the same priority /login
 * itself tries: department account, then employee, then accounting-only user,
 * then the legacy fallback. Each candidate is tried in turn and only skipped
 * if it isn't actually usable (inactive) — mirroring /login's own "one email
 * can name two different accounts" handling (deptAuth.js), so an inactive
 * department login sharing an address with a valid employee record does not
 * hide the employee identity that could otherwise reset its password fine.
 */
async function resolveIdentity(email) {
  const deptUser = await DeptUser.findOne({ email });
  if (deptUser && deptUser.isActive) {
    return { kind: "dept", doc: deptUser, name: deptUser.name };
  }

  const employee = await Employee.findOne({ email });
  if (employee && employee.isActive !== false && employee.status !== "inactive") {
    return {
      kind: "employee",
      doc: employee,
      name: `${employee.firstName || ""} ${employee.lastName || ""}`.trim() || employee.email,
    };
  }

  const accOnly = await findAccountantUser(email).catch(() => null);
  if (accOnly && accOnly.isActive) {
    return { kind: "accountant", doc: accOnly, name: accOnly.name || accOnly.email };
  }

  const { user: legacyUser, userType } = await findLegacyUser(email);
  if (legacyUser && legacyUser.isActive !== false) {
    return { kind: "legacy", doc: legacyUser, userType, name: legacyUser.name || legacyUser.email };
  }

  return null;
}

const BREVO_BASE = "https://api.brevo.com/v3";
const BREVO_SENDER = {
  name: "GRAV Manufacturing Suite",
  email: process.env.CUSTOMER_SENDER_EMAIL || "biswalpramod3.1415@gmail.com",
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

const otpEmailHtml = (name, otp) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>Password Reset OTP</title></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,sans-serif;color:#0f172a;">
<div style="max-width:560px;margin:40px auto;padding:0 16px;">
<div style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
<div style="background:#0f172a;padding:24px 28px;">
  <p style="margin:0;color:#94a3b8;font-size:11px;letter-spacing:2px;text-transform:uppercase;">GRAV · Manufacturing Suite</p>
  <h1 style="margin:6px 0 0;color:#fff;font-size:22px;font-weight:600;">Password Reset</h1>
</div>
<div style="padding:28px;">
  <p style="margin:0 0 14px;font-size:14px;color:#475569;">Hi ${escapeHtml(name || "there")},</p>
  <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#475569;">Your 4-digit reset code is valid for <strong>10 minutes</strong>.</p>
  <div style="background:#f1f5f9;border:1px solid #cbd5e1;border-radius:10px;padding:18px;text-align:center;margin:0 0 22px;">
    <p style="margin:0 0 6px;font-size:10.5px;letter-spacing:2px;text-transform:uppercase;color:#64748b;">One-Time Code</p>
    <p style="margin:0;font-size:32px;letter-spacing:14px;font-weight:700;color:#0f172a;font-family:'Courier New',monospace;">${escapeHtml(otp)}</p>
  </div>
  <p style="margin:0;font-size:12.5px;color:#64748b;">If you didn't request this, you can safely ignore this email.</p>
</div>
</div></div></body></html>`;

async function sendOtpEmail(toEmail, toName, otp) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn(`[passwordReset] No BREVO_API_KEY. OTP for ${toEmail}: ${otp}`);
    return { success: false, reason: "no_api_key" };
  }
  try {
    const response = await axios.post(
      `${BREVO_BASE}/smtp/email`,
      {
        sender: BREVO_SENDER,
        to: [{ email: toEmail, name: toName || toEmail.split("@")[0] }],
        subject: "Your GRAV Manufacturing Suite password reset code",
        htmlContent: otpEmailHtml(toName, otp),
        textContent: `Hi ${toName || "there"},\n\nYour reset code: ${otp}\n\nValid for 10 minutes.`,
        headers: { "X-Mailin-custom": "cms_password_reset_otp" },
      },
      {
        headers: { "api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
        timeout: 10000,
      }
    );
    console.log(`[passwordReset] OTP sent to ${toEmail}:`, response.data?.messageId);
    return { success: true };
  } catch (err) {
    console.error(`[passwordReset] Brevo failed to ${toEmail} (OTP: ${otp}):`, err.response?.data?.message || err.message);
    return { success: false, reason: "send_failed" };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// POST /api/auth/forgot-password/request-otp
// ═══════════════════════════════════════════════════════════════════════
router.post("/forgot-password/request-otp", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: "Please enter a valid email address." });
    }
    const normalised = email.trim().toLowerCase();

    const identity = await resolveIdentity(normalised);
    if (!identity) {
      return res.status(404).json({
        success: false,
        message: "No account is registered with this email address.",
      });
    }

    const otp = generateOtp();
    await PasswordResetOTP.findOneAndUpdate(
      { email: normalised },
      {
        email: normalised,
        otpHash: await hashOtp(otp),
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
        attempts: 0,
        identityKind: identity.kind,
        identityId: identity.doc._id,
        legacyUserType: identity.userType || undefined,
      },
      { upsert: true, new: true },
    );

    const result = await sendOtpEmail(normalised, identity.name, otp);

    return res.json({
      success: true,
      message: result.success
        ? `A 4-digit code has been sent to ${normalised}. It expires in 10 minutes.`
        : "Code generated but the email service is unavailable. Please contact an administrator.",
      _devOtp: process.env.NODE_ENV !== "production" ? otp : undefined,
    });
  } catch (err) {
    console.error("[passwordReset/request-otp]", err);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

/** Shared expiry/attempts guard for check-otp and reset-password. */
async function loadValidOtpRecord(email, res) {
  const normalised = String(email || "").trim().toLowerCase();
  const record = await PasswordResetOTP.findOne({ email: normalised });
  if (!record) {
    res.status(400).json({ success: false, message: "No reset in progress. Please request a new code." });
    return null;
  }
  if (record.expiresAt < new Date()) {
    await PasswordResetOTP.deleteOne({ _id: record._id });
    res.status(400).json({ success: false, message: "Code expired. Please request a new one." });
    return null;
  }
  if ((record.attempts || 0) >= MAX_ATTEMPTS) {
    await PasswordResetOTP.deleteOne({ _id: record._id });
    res.status(400).json({ success: false, message: "Too many failed attempts. Please request a new code." });
    return null;
  }
  return record;
}

// ═══════════════════════════════════════════════════════════════════════
// POST /api/auth/forgot-password/check-otp — verify only, no password set
// ═══════════════════════════════════════════════════════════════════════
router.post("/forgot-password/check-otp", async (req, res) => {
  try {
    const { email, otp } = req.body || {};
    if (!otp) return res.status(400).json({ success: false, message: "OTP is required." });

    const record = await loadValidOtpRecord(email, res);
    if (!record) return; // response already sent

    const ok = await bcrypt.compare(String(otp).trim(), record.otpHash);
    if (!ok) {
      record.attempts = (record.attempts || 0) + 1;
      await record.save();
      const remaining = Math.max(0, MAX_ATTEMPTS - record.attempts);
      return res.status(400).json({
        success: false,
        message: `Invalid code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`,
      });
    }

    return res.json({ success: true, message: "Code verified. Please set your new password." });
  } catch (err) {
    console.error("[passwordReset/check-otp]", err);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// POST /api/auth/forgot-password/reset-password — verify + set password
// ═══════════════════════════════════════════════════════════════════════
router.post("/forgot-password/reset-password", async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body || {};
    if (!otp || !newPassword) {
      return res.status(400).json({ success: false, message: "OTP and new password are required." });
    }
    if (String(newPassword).length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      });
    }

    const record = await loadValidOtpRecord(email, res);
    if (!record) return; // response already sent

    const ok = await bcrypt.compare(String(otp).trim(), record.otpHash);
    if (!ok) {
      record.attempts = (record.attempts || 0) + 1;
      await record.save();
      const remaining = Math.max(0, MAX_ATTEMPTS - record.attempts);
      return res.status(400).json({
        success: false,
        message: `Invalid code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`,
      });
    }

    // Re-resolve rather than trust the snapshot on the OTP record alone — an
    // account deactivated in the minutes between request and reset must not
    // still get a new password.
    switch (record.identityKind) {
      case "dept": {
        const user = await DeptUser.findById(record.identityId);
        if (!user || !user.isActive) {
          return res.status(400).json({ success: false, message: "This account is no longer available." });
        }
        await user.setPassword(String(newPassword)); // bumps tokenVersion — every open session ends
        await user.save();
        break;
      }
      case "employee": {
        const employee = await Employee.findById(record.identityId);
        if (!employee || employee.isActive === false || employee.status === "inactive") {
          return res.status(400).json({ success: false, message: "This account is no longer available." });
        }
        const written = await upgradeEmployeePassword(Employee, employee._id, String(newPassword));
        if (!written) {
          return res.status(500).json({ success: false, message: "The password could not be saved. Please try again." });
        }
        break;
      }
      case "accountant": {
        const accUser = await findAccountantUser(record.email);
        if (!accUser || !accUser.isActive) {
          return res.status(400).json({ success: false, message: "This account is no longer available." });
        }
        await accUser.setPassword(String(newPassword));
        accUser.tokenVersion = (accUser.tokenVersion || 0) + 1; // ends every open session
        await accUser.save();
        break;
      }
      case "legacy": {
        const Model = legacyModel(record.legacyUserType);
        const legacyUser = Model && (await Model.findById(record.identityId));
        if (!Model || !legacyUser || legacyUser.isActive === false) {
          return res.status(400).json({ success: false, message: "This account is no longer available." });
        }
        const hashed = await bcrypt.hash(String(newPassword), 10);
        await Model.findByIdAndUpdate(legacyUser._id, { password: hashed });
        break;
      }
      default:
        return res.status(400).json({ success: false, message: "No reset in progress. Please request a new code." });
    }

    await PasswordResetOTP.deleteOne({ _id: record._id });

    return res.json({ success: true, message: "Password reset successfully. Please sign in with your new password." });
  } catch (err) {
    console.error("[passwordReset/reset-password]", err);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

module.exports = router;
