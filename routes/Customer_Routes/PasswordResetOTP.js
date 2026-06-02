// routes/Customer_Routes/PasswordResetOTP.js
// ─────────────────────────────────────────────────────────────────────────
// SELF-SERVICE PASSWORD RESET VIA EMAIL OTP — v23
//
// Now supports BOTH:
//
// 1. IN-PORTAL FLOW (user is logged in via cookie)
//    - /request-otp  → submitted email must match the logged-in customer's
//      email (user-asked behaviour). OTP sent to that email.
//    - /verify-otp   → identifies the customer from the cookie. Body
//      needs only { otp, newPassword }.
//
// 2. PUBLIC /forgot-password FLOW (no cookie)
//    - /request-otp  → look up the customer by submitted email.
//      ⚠️ v23 CHANGE: previously returned a generic "If an account exists,
//      an OTP has been sent" message regardless of whether the email
//      was actually registered. The customer asked for explicit
//      validation on the login page's forgot-password flow — they want
//      to be told "no account found" when the email isn't registered,
//      rather than the form pretending to send an OTP and proceeding
//      to a useless code-entry screen. v23 now returns 404 + "No
//      account is registered with this email address" in that case.
//      Trade-off: this allows email enumeration (any attacker can
//      probe whether an email is registered). Acceptable for this B2B
//      portal where the customer list is closed and known.
//    - /verify-otp   → body must include { email, otp, newPassword }.
//      We look up the customer by email and verify the OTP they received.
//
// Both modes use the same dedicated Brevo email sender — no dependency on
// the salesEmailService "enabled" flag (which silently drops sends when
// off, the actual cause of the "OTP not arriving" bug in v11).
// ─────────────────────────────────────────────────────────────────────────

const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const axios = require("axios");

const Customer = require("../../models/Customer_Models/Customer");
const {
  optionalCustomerAuth,
} = require("../../Middlewear/CustomerAuthMiddleware");

// ─── OTP config ──────────────────────────────────────────────────────────
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

// ─── Dedicated OTP email sender (Brevo, no settings dependency) ──────────
const BREVO_BASE = "https://api.brevo.com/v3";
const BREVO_SENDER = {
  name: "Grav Clothing",
  email: process.env.CUSTOMER_SENDER_EMAIL || "biswalpramod3.1415@gmail.com",
};

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

const otpEmailHtml = (name, otp) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Your Password Reset OTP</title></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
<div style="max-width:560px;margin:40px auto;padding:0 16px;">
  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
    <div style="background:#0f172a;padding:24px 28px;">
      <p style="margin:0;color:#94a3b8;font-size:11px;letter-spacing:2px;text-transform:uppercase;">Grav Clothing · Customer Portal</p>
      <h1 style="margin:6px 0 0;color:#fff;font-size:22px;font-weight:600;">Password Reset</h1>
    </div>
    <div style="padding:28px;">
      <p style="margin:0 0 14px;font-size:14px;color:#475569;">Hi ${escapeHtml(name || "there")},</p>
      <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#475569;">
        You requested a password reset for your Grav Clothing portal account.
        Use the OTP below to complete the reset. This code is valid for <strong>10 minutes</strong>.
      </p>
      <div style="background:#f1f5f9;border:1px solid #cbd5e1;border-radius:10px;padding:18px;text-align:center;margin:0 0 22px;">
        <p style="margin:0 0 6px;font-size:10.5px;letter-spacing:2px;text-transform:uppercase;color:#64748b;">Your One-Time Code</p>
        <p style="margin:0;font-size:32px;letter-spacing:14px;font-weight:700;color:#0f172a;font-family:'Courier New',monospace;">${escapeHtml(otp)}</p>
      </div>
      <p style="margin:0 0 12px;font-size:12.5px;line-height:1.6;color:#64748b;">
        If you didn't request this reset, you can safely ignore this email — your password will not change unless you enter the code above and choose a new one. For security, the code expires in 10 minutes and is limited to ${MAX_ATTEMPTS} attempts.
      </p>
    </div>
    <div style="background:#f8fafc;padding:16px 28px;border-top:1px solid #e2e8f0;">
      <p style="margin:0;font-size:11px;color:#94a3b8;">Sent automatically by the Grav Clothing portal. Please don't reply to this email.</p>
    </div>
  </div>
  <p style="margin:14px 0 0;text-align:center;font-size:11px;color:#94a3b8;">&copy; ${new Date().getFullYear()} Grav Clothing. All rights reserved.</p>
</div>
</body>
</html>`;

const otpEmailText = (name, otp) =>
  `Hi ${name || "there"},\n\n` +
  `Your Grav Clothing portal password reset OTP is: ${otp}\n\n` +
  `This code is valid for 10 minutes and limited to ${MAX_ATTEMPTS} attempts.\n` +
  `If you didn't request this reset, you can safely ignore this email.\n\n` +
  `— Grav Clothing`;

async function sendOtpEmail(toEmail, toName, otp) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn(
      `[PasswordResetOTP] BREVO_API_KEY not set. OTP for ${toEmail} is: ${otp}`,
    );
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
        textContent: otpEmailText(toName, otp),
        headers: { "X-Mailin-custom": "customer_password_reset_otp" },
      },
      {
        headers: {
          "api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 10000,
      },
    );
    console.log(
      `[PasswordResetOTP] OTP email sent to ${toEmail}:`,
      response.data?.messageId,
    );
    return { success: true };
  } catch (err) {
    console.error(
      `[PasswordResetOTP] Brevo send failed to ${toEmail} (OTP was: ${otp}):`,
      err.response?.data?.message || err.message,
    );
    return { success: false, reason: "send_failed" };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────
const isValidEmail = (e) =>
  typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

// ═════════════════════════════════════════════════════════════════════════
// POST /request-otp
// ═════════════════════════════════════════════════════════════════════════
// Branching:
//   - If req.customerId (logged in) → submitted email MUST match the
//     logged-in customer's email. No silent fallback.
//   - If no auth (public /forgot-password flow) → look up by email.
//     v23: respond with explicit 404 + "no account registered" message
//     when the email isn't found, so the login-page forgot-password
//     flow stops at the email step instead of pretending to send an
//     OTP and advancing to a useless code-entry screen.
router.post("/request-otp", optionalCustomerAuth, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid email address.",
      });
    }

    const submitted = email.trim().toLowerCase();
    let customer;

    if (req.customerId) {
      // ── IN-PORTAL FLOW ────────────────────────────────────────────
      // Submitted email must match the logged-in customer's email.
      customer = await Customer.findById(req.customerId);
      if (!customer) {
        return res
          .status(404)
          .json({ success: false, message: "Account not found" });
      }
      const registered = String(customer.email || "")
        .trim()
        .toLowerCase();
      if (!registered) {
        return res.status(400).json({
          success: false,
          message:
            "Your account doesn't have an email on file. Please contact support.",
        });
      }
      if (submitted !== registered) {
        return res.status(400).json({
          success: false,
          message:
            "This email doesn't match your registered account email. Please use the email associated with your account.",
        });
      }
    } else {
      // ── PUBLIC /forgot-password FLOW ──────────────────────────────
      customer = await Customer.findOne({ email: submitted });

      // ⚠️ v23 — explicit "no account found" rejection.
      //
      // The previous behaviour returned a generic success message even
      // when the email was unregistered (so callers couldn't probe the
      // user list via this endpoint). The customer specifically asked
      // for the login-page forgot-password form to STOP at the email
      // step instead of advancing to the OTP entry screen, and to be
      // told plainly that no account exists. We oblige here.
      if (!customer) {
        return res.status(404).json({
          success: false,
          message:
            "No account is registered with this email address. Please check the spelling, or sign up first.",
        });
      }
    }

    // ── Generate, hash, store OTP ────────────────────────────────────
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
        ? `A 4-digit OTP has been sent to ${customer.email}. It expires in 10 minutes.`
        : "OTP was generated but the email service is unavailable right now. Please contact support or try again.",
      _devOtp: process.env.NODE_ENV !== "production" ? otp : undefined,
    });
  } catch (err) {
    console.error("[PasswordResetOTP/request-otp]", err);
    res
      .status(500)
      .json({ success: false, message: "Server error. Please try again." });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /verify-otp
// ═════════════════════════════════════════════════════════════════════════
// Branching:
//   - If req.customerId → use it (in-portal flow). Body needs { otp, newPassword }.
//   - If no auth → body must include { email, otp, newPassword }. We look up
//     the customer by email and verify against their stored OTP hash.
router.post("/verify-otp", optionalCustomerAuth, async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body || {};

    if (!otp || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "OTP and new password are required.",
      });
    }
    if (typeof newPassword !== "string" || newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 6 characters.",
      });
    }

    // ── Identify the customer ───────────────────────────────────────
    let customer;
    if (req.customerId) {
      customer = await Customer.findById(req.customerId).select(
        "+passwordResetOTP.hash",
      );
    } else {
      if (!isValidEmail(email)) {
        return res.status(400).json({
          success: false,
          message: "Please enter a valid email address.",
        });
      }
      customer = await Customer.findOne({
        email: email.trim().toLowerCase(),
      }).select("+passwordResetOTP.hash");
    }

    if (!customer || !customer.passwordResetOTP?.hash) {
      return res.status(400).json({
        success: false,
        message: "No password reset in progress. Please request a new OTP.",
      });
    }

    // Expiry check
    if (
      customer.passwordResetOTP.expiresAt &&
      new Date() > new Date(customer.passwordResetOTP.expiresAt)
    ) {
      customer.passwordResetOTP = { hash: null, expiresAt: null, attempts: 0 };
      await customer.save({ validateBeforeSave: false });
      return res.status(400).json({
        success: false,
        message: "OTP has expired. Please request a new one.",
      });
    }

    // Attempts check
    if ((customer.passwordResetOTP.attempts || 0) >= MAX_ATTEMPTS) {
      customer.passwordResetOTP = { hash: null, expiresAt: null, attempts: 0 };
      await customer.save({ validateBeforeSave: false });
      return res.status(400).json({
        success: false,
        message: "Too many failed attempts. Please request a new OTP.",
      });
    }

    const ok = await bcrypt.compare(
      String(otp).trim(),
      customer.passwordResetOTP.hash,
    );
    if (!ok) {
      customer.passwordResetOTP.attempts =
        (customer.passwordResetOTP.attempts || 0) + 1;
      await customer.save({ validateBeforeSave: false });
      const remaining = Math.max(
        0,
        MAX_ATTEMPTS - customer.passwordResetOTP.attempts,
      );
      return res.status(400).json({
        success: false,
        message: `Invalid OTP. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`,
      });
    }

    // OTP valid — update password (pre-save hook hashes it), clear OTP.
    customer.password = newPassword;
    customer.passwordResetOTP = { hash: null, expiresAt: null, attempts: 0 };
    await customer.save();

    // If the user was authenticated (in-portal flow), force re-login.
    if (req.customerId) {
      const isProduction = process.env.NODE_ENV === "production";
      res.clearCookie("customerToken", {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? "none" : "lax",
        path: "/",
      });
    }
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");

    return res.json({
      success: true,
      message:
        "Password reset successfully. Please sign in with your new password.",
    });
  } catch (err) {
    console.error("[PasswordResetOTP/verify-otp]", err);
    res
      .status(500)
      .json({ success: false, message: "Server error. Please try again." });
  }
});

module.exports = router;
