// routes/Customer_Routes/PasswordResetOTP.js
// Added: POST /check-otp — verifies OTP is correct WITHOUT setting the password.
// The frontend uses this so the UI can advance to the "set new password" step
// only after confirming the OTP is valid, giving a true 2-step forgot-password UX.

const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const axios = require("axios");

const Customer = require("../../models/Customer_Models/Customer");
const { optionalCustomerAuth } = require("../../Middlewear/CustomerAuthMiddleware");

const OTP_LENGTH = 4;
const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const generateOtp = (length = OTP_LENGTH) => {
  const max = Math.pow(10, length);
  const n = crypto.randomInt(0, max);
  return String(n).padStart(length, "0");
};

const hashOtp = async (otp) => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(otp, salt);
};

const BREVO_BASE = "https://api.brevo.com/v3";
const BREVO_SENDER = {
  name: "Grav Clothing",
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
  <p style="margin:0;color:#94a3b8;font-size:11px;letter-spacing:2px;text-transform:uppercase;">Grav Clothing · Customer Portal</p>
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
    console.warn(`[PasswordResetOTP] No BREVO_API_KEY. OTP for ${toEmail}: ${otp}`);
    return { success: false, reason: "no_api_key" };
  }
  try {
    const response = await axios.post(
      `${BREVO_BASE}/smtp/email`,
      {
        sender: BREVO_SENDER,
        to: [{ email: toEmail, name: toName || toEmail.split("@")[0] }],
        subject: "Your Grav Clothing portal password reset OTP",
        htmlContent: otpEmailHtml(toName, otp),
        textContent: `Hi ${toName || "there"},\n\nYour reset code: ${otp}\n\nValid for 10 minutes.`,
        headers: { "X-Mailin-custom": "customer_password_reset_otp" },
      },
      {
        headers: { "api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
        timeout: 10000,
      }
    );
    console.log(`[PasswordResetOTP] OTP sent to ${toEmail}:`, response.data?.messageId);
    return { success: true };
  } catch (err) {
    console.error(`[PasswordResetOTP] Brevo failed to ${toEmail} (OTP: ${otp}):`, err.response?.data?.message || err.message);
    return { success: false, reason: "send_failed" };
  }
}

const isValidEmail = (e) => typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

// ─── Shared: identify customer (in-portal or public) ────────────────────
async function resolveCustomer(req, email, selectOtp = false) {
  const sel = selectOtp ? "+passwordResetOTP.hash" : "";
  if (req.customerId) {
    return Customer.findById(req.customerId).select(sel);
  }
  if (!isValidEmail(email)) return null;
  return Customer.findOne({ email: email.trim().toLowerCase() }).select(sel);
}

// ═══════════════════════════════════════════════════════════════════════
// POST /request-otp
// ═══════════════════════════════════════════════════════════════════════
router.post("/request-otp", optionalCustomerAuth, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: "Please enter a valid email address." });
    }
    const submitted = email.trim().toLowerCase();
    let customer;

    if (req.customerId) {
      customer = await Customer.findById(req.customerId);
      if (!customer) return res.status(404).json({ success: false, message: "Account not found." });
      const registered = String(customer.email || "").trim().toLowerCase();
      if (!registered) {
        return res.status(400).json({ success: false, message: "Your account has no email on file. Please contact support." });
      }
      if (submitted !== registered) {
        return res.status(400).json({ success: false, message: "This email doesn't match your registered account email." });
      }
    } else {
      customer = await Customer.findOne({ email: submitted });
      if (!customer) {
        return res.status(404).json({
          success: false,
          message: "No account is registered with this email address.",
        });
      }
    }

    const otp = generateOtp();
    customer.passwordResetOTP = {
      hash: await hashOtp(otp),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      attempts: 0,
    };
    await customer.save({ validateBeforeSave: false });

    const result = await sendOtpEmail(customer.email, customer.name, otp);

    return res.json({
      success: true,
      message: result.success
        ? `A 4-digit code has been sent to ${customer.email}. It expires in 10 minutes.`
        : "Code generated but the email service is unavailable. Please contact support.",
      _devOtp: process.env.NODE_ENV !== "production" ? otp : undefined,
    });
  } catch (err) {
    console.error("[PasswordResetOTP/request-otp]", err);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// POST /check-otp  ← NEW
// Verifies the OTP is correct WITHOUT setting the password.
// The frontend advances to the "set new password" step only if this succeeds.
// ═══════════════════════════════════════════════════════════════════════
router.post("/check-otp", optionalCustomerAuth, async (req, res) => {
  try {
    const { email, otp } = req.body || {};
    if (!otp) return res.status(400).json({ success: false, message: "OTP is required." });

    const customer = await resolveCustomer(req, email, true);
    if (!customer || !customer.passwordResetOTP?.hash) {
      return res.status(400).json({ success: false, message: "No reset in progress. Please request a new code." });
    }

    if (customer.passwordResetOTP.expiresAt && new Date() > new Date(customer.passwordResetOTP.expiresAt)) {
      customer.passwordResetOTP = { hash: null, expiresAt: null, attempts: 0 };
      await customer.save({ validateBeforeSave: false });
      return res.status(400).json({ success: false, message: "Code expired. Please request a new one." });
    }

    if ((customer.passwordResetOTP.attempts || 0) >= MAX_ATTEMPTS) {
      customer.passwordResetOTP = { hash: null, expiresAt: null, attempts: 0 };
      await customer.save({ validateBeforeSave: false });
      return res.status(400).json({ success: false, message: "Too many failed attempts. Please request a new code." });
    }

    const ok = await bcrypt.compare(String(otp).trim(), customer.passwordResetOTP.hash);
    if (!ok) {
      customer.passwordResetOTP.attempts = (customer.passwordResetOTP.attempts || 0) + 1;
      await customer.save({ validateBeforeSave: false });
      const remaining = Math.max(0, MAX_ATTEMPTS - customer.passwordResetOTP.attempts);
      return res.status(400).json({
        success: false,
        message: `Invalid code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`,
      });
    }

    // Valid — do NOT clear the OTP so /verify-otp can still use it to set the password
    return res.json({ success: true, message: "Code verified. Please set your new password." });
  } catch (err) {
    console.error("[PasswordResetOTP/check-otp]", err);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// POST /verify-otp  — verifies OTP AND sets the new password
// ═══════════════════════════════════════════════════════════════════════
router.post("/verify-otp", optionalCustomerAuth, async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body || {};
    if (!otp || !newPassword) {
      return res.status(400).json({ success: false, message: "OTP and new password are required." });
    }
    if (typeof newPassword !== "string" || newPassword.length < 6) {
      return res.status(400).json({ success: false, message: "New password must be at least 6 characters." });
    }

    const customer = await resolveCustomer(req, email, true);
    if (!customer || !customer.passwordResetOTP?.hash) {
      return res.status(400).json({ success: false, message: "No reset in progress. Please request a new code." });
    }

    if (customer.passwordResetOTP.expiresAt && new Date() > new Date(customer.passwordResetOTP.expiresAt)) {
      customer.passwordResetOTP = { hash: null, expiresAt: null, attempts: 0 };
      await customer.save({ validateBeforeSave: false });
      return res.status(400).json({ success: false, message: "Code expired. Please request a new one." });
    }

    if ((customer.passwordResetOTP.attempts || 0) >= MAX_ATTEMPTS) {
      customer.passwordResetOTP = { hash: null, expiresAt: null, attempts: 0 };
      await customer.save({ validateBeforeSave: false });
      return res.status(400).json({ success: false, message: "Too many failed attempts. Please request a new code." });
    }

    const ok = await bcrypt.compare(String(otp).trim(), customer.passwordResetOTP.hash);
    if (!ok) {
      customer.passwordResetOTP.attempts = (customer.passwordResetOTP.attempts || 0) + 1;
      await customer.save({ validateBeforeSave: false });
      const remaining = Math.max(0, MAX_ATTEMPTS - customer.passwordResetOTP.attempts);
      return res.status(400).json({
        success: false,
        message: `Invalid code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`,
      });
    }

    customer.password = newPassword;
    customer.passwordResetOTP = { hash: null, expiresAt: null, attempts: 0 };
    await customer.save();

    if (req.customerId) {
      const isProd = process.env.NODE_ENV === "production";
      res.clearCookie("customerToken", { httpOnly: true, secure: isProd, sameSite: isProd ? "none" : "lax", path: "/" });
    }
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");

    return res.json({ success: true, message: "Password reset successfully. Please sign in with your new password." });
  } catch (err) {
    console.error("[PasswordResetOTP/verify-otp]", err);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

module.exports = router;