// routes/task_routes/coworkPasswordReset.js
//
// Self-service "forgot password" for CoWork sign-in (Cowork/app/signin).
//
// ── Why this is not routes/auth/passwordReset.js ────────────────────────────
// That file is the CMS's, and it resolves an email against MONGO — dept_users,
// Employee, the accountant users, the twelve legacy department collections —
// then writes a bcrypt hash onto whichever document it found. None of that is
// where a CoWork password lives. CoWork's identity is Firebase Auth (see
// Cowork/lib/legacy/firebase.ts: "the legacy verifyCoworkToken middleware
// accepts nothing but a Firebase ID token"), and the only way to change one of
// those passwords is admin.auth().updateUser(). Pointing the CMS route at
// CoWork would have reset a Mongo record nobody signs into CoWork with,
// reported success, and left the person locked out under a "password reset
// successfully" message — the worst available failure for this flow.
//
// So: the same SHAPE as the CMS flow, deliberately — same 4-digit code, same
// 10-minute TTL, same 5-attempt cap, same three-step request → check → reset
// sequence, so the two forgot-password flows in this company behave
// identically from a user's perspective — but a different identity source and
// a different write.
//
// ── Where state lives ───────────────────────────────────────────────────────
// Firestore, not Mongo. CLAUDE.md's split is that the entire CoWork module is
// Firestore-backed, and an OTP record governing a Firebase account belongs on
// the Firebase side of that line. It also keeps the record and the account it
// governs in one database, so there is no window where one exists without the
// other.
//
// ── One deliberate divergence from the CMS flow: enumeration ────────────────
// The CMS answers 404 "No account is registered with this email address."
// This does not. Cowork's own SignInForm documents the opposite policy in its
// header — one message for an unknown address, a wrong password and a
// suspended account alike, so that working through a breach list tells an
// attacker nothing about who is registered. A forgot-password form that
// happily confirmed "yes, that address has an account" would hand back exactly
// what sign-in refuses to give, on an endpoint that needs no password at all.
// So request-otp always reports the same thing, and only actually sends mail
// when there is somewhere to send it.

const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const axios = require("axios");

const { db, auth: firebaseAuth } = require("../../config/firebaseAdmin");
const { invalidateEmployeeCache } = require("../../Middlewear/coworkAuth");

// Matched to routes/auth/passwordReset.js so the two flows feel like one
// product. Changing one without the other is how they drift.
const OTP_LENGTH = 4;
const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

// MUST match Cowork/lib/auth/passwordRule.ts's PASSWORD_MIN_LENGTH.
//
// Ten, not the CMS flow's eight: this sets a COWORK password, and Cowork's
// signup and invitation forms already state ten under the field. A server that
// accepted eight would let the reset flow create a password Cowork's own signup
// form would have refused — and the hint somebody read while typing it would
// have been wrong. Firebase itself enforces only 6, so this is the only place
// the rule is real on this path.
//
// The two files cannot import from each other across the repo boundary, so this
// is the one duplicated constant here. Change one, change the other.
const MIN_PASSWORD_LENGTH = 10;

const RESETS = "cowork_password_resets";

/**
 * How often one address may ask for a code.
 *
 * Each request sends a real email, and Brevo bills for it. Without this, one
 * script pointed at request-otp is both an unbounded mail bill and a way to
 * bury somebody's inbox. In-memory and therefore per-process — the same honest
 * limitation `Middlewear/coworkAuth.js`'s employee cache carries, and right for
 * the single node this runs on. A horizontally-scaled deploy needs it moved to
 * Firestore alongside the OTP itself.
 */
const RESEND_COOLDOWN_MS = 60 * 1000;
const lastRequestAt = new Map();

const sweeper = setInterval(() => {
  const cutoff = Date.now() - RESEND_COOLDOWN_MS;
  for (const [key, at] of lastRequestAt) if (at < cutoff) lastRequestAt.delete(key);
}, 5 * 60 * 1000);
// Nothing here should hold the process open at shutdown.
if (typeof sweeper.unref === "function") sweeper.unref();

const generateOtp = (length = OTP_LENGTH) =>
  String(crypto.randomInt(0, Math.pow(10, length))).padStart(length, "0");

const hashOtp = async (otp) => bcrypt.hash(otp, await bcrypt.genSalt(10));

const isValidEmail = (e) =>
  typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

const normalise = (e) => String(e || "").trim().toLowerCase();

/**
 * The CoWork account for this address, or null.
 *
 * `authUid` is required, not optional: it names the Firebase user whose
 * password this flow exists to change. A `cowork_employees` row without one is
 * a half-provisioned account — the same state `deptAuth.js`'s SSO route answers
 * NO_AUTH_UID for — and there is nothing here to reset.
 */
async function findCoworkAccount(email) {
  const snap = await db
    .collection("cowork_employees")
    .where("email", "==", email)
    .limit(1)
    .get();
  if (snap.empty) return null;

  const doc = snap.docs[0];
  const data = doc.data() || {};
  if (!data.authUid) return null;
  if (data.isActive === false || data.status === "inactive") return null;

  return {
    employeeId: doc.id,
    authUid: data.authUid,
    name: data.name || data.fullName || email.split("@")[0],
  };
}

/* ── Mail ─────────────────────────────────────────────────────────────────── */

const BREVO_BASE = "https://api.brevo.com/v3";
const BREVO_SENDER = {
  name: "Cowork",
  email: process.env.CUSTOMER_SENDER_EMAIL || "biswalpramod3.1415@gmail.com",
};

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

const otpEmailHtml = (name, otp) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>Cowork password reset</title></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#0f172a;">
<div style="max-width:560px;margin:40px auto;padding:0 16px;">
<div style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
<div style="background:#0f172a;padding:24px 28px;">
  <p style="margin:0;color:#94a3b8;font-size:11px;letter-spacing:2px;text-transform:uppercase;">Cowork</p>
  <h1 style="margin:6px 0 0;color:#fff;font-size:22px;font-weight:600;">Password reset</h1>
</div>
<div style="padding:28px;">
  <p style="margin:0 0 14px;font-size:14px;color:#475569;">Hi ${escapeHtml(name || "there")},</p>
  <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#475569;">Your 4-digit reset code is valid for <strong>10 minutes</strong>.</p>
  <div style="background:#f1f5f9;border:1px solid #cbd5e1;border-radius:10px;padding:18px;text-align:center;margin:0 0 22px;">
    <p style="margin:0 0 6px;font-size:10.5px;letter-spacing:2px;text-transform:uppercase;color:#64748b;">One-time code</p>
    <p style="margin:0;font-size:32px;letter-spacing:14px;font-weight:700;color:#0f172a;font-family:Courier New,monospace;">${escapeHtml(otp)}</p>
  </div>
  <p style="margin:0 0 8px;font-size:12.5px;color:#64748b;">Setting a new password signs you out everywhere else.</p>
  <p style="margin:0;font-size:12.5px;color:#64748b;">If you didn't request this, you can safely ignore this email — your password has not changed.</p>
</div>
</div></div></body></html>`;

async function sendOtpEmail(toEmail, toName, otp) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn(`[coworkPasswordReset] No BREVO_API_KEY. OTP for ${toEmail}: ${otp}`);
    return { success: false, reason: "no_api_key" };
  }
  try {
    const response = await axios.post(
      `${BREVO_BASE}/smtp/email`,
      {
        sender: BREVO_SENDER,
        to: [{ email: toEmail, name: toName || toEmail.split("@")[0] }],
        subject: "Your Cowork password reset code",
        htmlContent: otpEmailHtml(toName, otp),
        textContent: `Hi ${toName || "there"},\n\nYour Cowork reset code: ${otp}\n\nValid for 10 minutes. Setting a new password signs you out everywhere else.`,
        headers: { "X-Mailin-custom": "cowork_password_reset_otp" },
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
    console.log(`[coworkPasswordReset] OTP sent to ${toEmail}:`, response.data?.messageId);
    return { success: true };
  } catch (err) {
    console.error(
      `[coworkPasswordReset] Brevo failed for ${toEmail}:`,
      err.response?.data?.message || err.message,
    );
    return { success: false, reason: "send_failed" };
  }
}

/* ── Shared guard ─────────────────────────────────────────────────────────── */

/**
 * Load a live reset record, or answer and return null.
 *
 * Expiry and the attempt cap are both terminal: the record is deleted rather
 * than left to be retried, so a code that has run out of attempts cannot be
 * ground down by guessing again against the same record.
 */
async function loadValidReset(email, res) {
  const ref = db.collection(RESETS).doc(email);
  const snap = await ref.get();

  // `.exists` is a PROPERTY on the Admin SDK's DocumentSnapshot, not a method.
  // Calling it returns a truthy function for a document that does not exist —
  // a mistake this codebase has made before and written down.
  if (!snap.exists) {
    res
      .status(400)
      .json({ success: false, message: "No reset in progress. Please request a new code." });
    return null;
  }

  const record = snap.data();

  if (!record.expiresAt || record.expiresAt.toMillis() < Date.now()) {
    await ref.delete();
    res.status(400).json({ success: false, message: "Code expired. Please request a new one." });
    return null;
  }
  if ((record.attempts || 0) >= MAX_ATTEMPTS) {
    await ref.delete();
    res.status(400).json({
      success: false,
      message: "Too many failed attempts. Please request a new code.",
    });
    return null;
  }

  return { ref, record };
}

/** Verify a submitted code, spending one attempt on failure. */
async function verifyOtp(ref, record, otp, res) {
  const ok = await bcrypt.compare(String(otp).trim(), record.otpHash);
  if (ok) return true;

  const attempts = (record.attempts || 0) + 1;
  await ref.update({ attempts });
  const remaining = Math.max(0, MAX_ATTEMPTS - attempts);
  res.status(400).json({
    success: false,
    message: `Invalid code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`,
  });
  return false;
}

/* ═══════════════════════════════════════════════════════════════════════════
   POST /cowork/auth/forgot-password/request-otp
   ═══════════════════════════════════════════════════════════════════════════ */
router.post("/auth/forgot-password/request-otp", async (req, res) => {
  try {
    const email = normalise(req.body?.email);
    if (!isValidEmail(email)) {
      return res
        .status(400)
        .json({ success: false, message: "Please enter a valid email address." });
    }

    // Said the same way whatever happens below — see the enumeration note in
    // this file's header. Built once, here, so no branch can forget it.
    const uniform = {
      success: true,
      message: `If a Cowork account exists for ${email}, a 4-digit code is on its way. It expires in 10 minutes.`,
    };

    const previous = lastRequestAt.get(email);
    if (previous && Date.now() - previous < RESEND_COOLDOWN_MS) {
      // Also uniform: a distinct "wait 60 seconds" would confirm the address
      // has an account, which is the one thing this endpoint must not say.
      return res.json(uniform);
    }
    lastRequestAt.set(email, Date.now());

    const account = await findCoworkAccount(email);
    if (!account) {
      console.warn(`[coworkPasswordReset] Reset requested for unknown address: ${email}`);
      return res.json(uniform);
    }

    const otp = generateOtp();
    await db.collection(RESETS).doc(email).set({
      email,
      otpHash: await hashOtp(otp),
      // A Firestore Timestamp rather than an ISO string, so a TTL policy on
      // this field can be switched on in the console without a migration.
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      attempts: 0,
      authUid: account.authUid,
      employeeId: account.employeeId,
      createdAt: new Date(),
    });

    await sendOtpEmail(email, account.name, otp);

    return res.json({
      ...uniform,
      // Development only, gated on NODE_ENV exactly like the CMS flow — without
      // a mail key configured locally there is otherwise no way to exercise
      // this end to end.
      _devOtp: process.env.NODE_ENV !== "production" ? otp : undefined,
    });
  } catch (err) {
    console.error("[coworkPasswordReset/request-otp]", err);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   POST /cowork/auth/forgot-password/check-otp — verify only

   Exists so the UI can advance from "enter the code" to "choose a password"
   without spending the code. Without it the form would have to hold the code
   and submit it together with the new password, and a rejected password would
   burn an attempt on a code that was correct.
   ═══════════════════════════════════════════════════════════════════════════ */
router.post("/auth/forgot-password/check-otp", async (req, res) => {
  try {
    const email = normalise(req.body?.email);
    const { otp } = req.body || {};
    if (!otp) {
      return res.status(400).json({ success: false, message: "Enter the code from your email." });
    }

    const found = await loadValidReset(email, res);
    if (!found) return;
    if (!(await verifyOtp(found.ref, found.record, otp, res))) return;

    return res.json({ success: true, message: "Code verified. Choose a new password." });
  } catch (err) {
    console.error("[coworkPasswordReset/check-otp]", err);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   POST /cowork/auth/forgot-password/reset-password — verify + set
   ═══════════════════════════════════════════════════════════════════════════ */
router.post("/auth/forgot-password/reset-password", async (req, res) => {
  try {
    const email = normalise(req.body?.email);
    const { otp, newPassword } = req.body || {};
    if (!otp || !newPassword) {
      return res
        .status(400)
        .json({ success: false, message: "The code and a new password are both required." });
    }
    if (String(newPassword).length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `Your new password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      });
    }

    const found = await loadValidReset(email, res);
    if (!found) return;
    if (!(await verifyOtp(found.ref, found.record, otp, res))) return;

    // Re-resolved rather than trusting the snapshot taken when the code was
    // issued: an account disabled in the ten minutes since must not still get
    // a new password.
    const account = await findCoworkAccount(email);
    if (!account || account.authUid !== found.record.authUid) {
      await found.ref.delete();
      return res
        .status(400)
        .json({ success: false, message: "This account is no longer available." });
    }

    await firebaseAuth.updateUser(account.authUid, { password: String(newPassword) });

    /* Every other session ends.
       `updateUser` alone does NOT do this — an already-issued ID token stays
       valid for up to an hour and a refresh token indefinitely, so somebody
       resetting their password *because* a device was stolen would leave that
       device signed in. This is the step that makes the reset mean what the
       email says it means. */
    await firebaseAuth.revokeRefreshTokens(account.authUid);

    // The middleware caches the employee record for five minutes keyed on uid.
    // Nothing in it changed here, but the cache is where a stale view of an
    // account sticks, and a password reset is exactly the moment to stop
    // trusting a five-minute-old one.
    invalidateEmployeeCache(account.authUid);

    await found.ref.delete();

    return res.json({
      success: true,
      message: "Password updated. Sign in with your new password.",
    });
  } catch (err) {
    console.error("[coworkPasswordReset/reset-password]", err);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

module.exports = router;
