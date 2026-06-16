// routes/Customer_Routes/auth.js
// signup OTP verification added (send-signup-otp, verify-signup-otp)
// signup now accepts optional fields: address, gstNumber, businessInfo, bankDetails, alternatePhone

const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const axios = require("axios");
const Customer = require("../../models/Customer_Models/Customer");

const CUSTOMER_COOKIE_NAME = "customerToken";
const OTP_TTL_MS = 10 * 60 * 1000; // 10 min
const MAX_ATTEMPTS = 5;

// ── In-memory store for signup email OTPs ────────────────────────────────
// Keyed by lowercase email. Each entry: { hash, expiresAt, attempts, verified }
// This is cleared after successful signup or expiry.
const signupOtpStore = new Map();

// ── OTP helpers ──────────────────────────────────────────────────────────
const generateOtp = () => {
  const n = crypto.randomInt(0, 10000);
  return String(n).padStart(4, "0");
};

const hashOtp = async (otp) => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(otp, salt);
};

// ── Brevo OTP email sender ───────────────────────────────────────────────
const BREVO_SENDER = {
  name: "Grav Clothing",
  email: process.env.CUSTOMER_SENDER_EMAIL || "biswalpramod3.1415@gmail.com",
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

async function sendOtpEmail(toEmail, toName, otp, subject = "Verify your email — Grav Clothing") {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn(`[auth/signup-otp] No BREVO_API_KEY. OTP for ${toEmail}: ${otp}`);
    return { success: false };
  }
  const html = `<!doctype html><html><body style="font-family:sans-serif;background:#f8fafc;margin:0;padding:0">
<div style="max-width:520px;margin:40px auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
  <div style="background:#0f172a;padding:22px 28px">
    <p style="margin:0;color:#94a3b8;font-size:11px;letter-spacing:2px;text-transform:uppercase">Grav Clothing · Customer Portal</p>
    <h1 style="margin:6px 0 0;color:#fff;font-size:20px;font-weight:600">Email Verification</h1>
  </div>
  <div style="padding:28px">
    <p style="margin:0 0 14px;font-size:14px;color:#475569">Hi ${escapeHtml(toName || "there")},</p>
    <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#475569">Use the code below to verify your email. Valid for <strong>10 minutes</strong>.</p>
    <div style="background:#f1f5f9;border:1px solid #cbd5e1;border-radius:10px;padding:18px;text-align:center;margin:0 0 20px">
      <p style="margin:0 0 6px;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#64748b">Your Code</p>
      <p style="margin:0;font-size:32px;letter-spacing:14px;font-weight:700;color:#0f172a;font-family:'Courier New',monospace">${escapeHtml(otp)}</p>
    </div>
    <p style="margin:0;font-size:12px;color:#94a3b8">Didn't request this? Ignore this email.</p>
  </div>
</div></body></html>`;
  try {
    await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender: BREVO_SENDER,
        to: [{ email: toEmail, name: toName || toEmail.split("@")[0] }],
        subject,
        htmlContent: html,
        textContent: `Hi ${toName || "there"},\n\nYour Grav Clothing verification code is: ${otp}\n\nValid for 10 minutes.`,
      },
      {
        headers: { "api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
        timeout: 10000,
      }
    );
    console.log(`[auth/signup-otp] OTP sent to ${toEmail}`);
    return { success: true };
  } catch (err) {
    console.error(`[auth/signup-otp] Send failed to ${toEmail} (OTP: ${otp}):`, err.response?.data?.message || err.message);
    return { success: false };
  }
}

// ── Cookie helpers ───────────────────────────────────────────────────────
const getCustomerCookieOptions = () => {
  const isProd = process.env.NODE_ENV === "production";
  return { httpOnly: true, secure: isProd, sameSite: isProd ? "none" : "lax", path: "/" };
};

const setCustomerCookie = (res, token) => {
  res.cookie(CUSTOMER_COOKIE_NAME, token, {
    ...getCustomerCookieOptions(),
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
};

const nukeCustomerCookie = (res) => {
  const expired = "Thu, 01 Jan 1970 00:00:00 GMT";
  res.append("Set-Cookie", [
    `${CUSTOMER_COOKIE_NAME}=; Path=/; Expires=${expired}; Max-Age=0; HttpOnly; Secure; SameSite=None`,
    `${CUSTOMER_COOKIE_NAME}=; Path=/; Expires=${expired}; Max-Age=0; HttpOnly; SameSite=Lax`,
    `${CUSTOMER_COOKIE_NAME}=; Path=/; Expires=${expired}; Max-Age=0; SameSite=Lax`,
    `${CUSTOMER_COOKIE_NAME}=; Path=/; Expires=${expired}; Max-Age=0`,
    `${CUSTOMER_COOKIE_NAME}=; Expires=${expired}; Max-Age=0; HttpOnly`,
  ]);
  res.set("Clear-Site-Data", '"cookies", "storage"');
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.set("Pragma", "no-cache");
};

// ═══════════════════════════════════════════════════════════════════════
// POST /send-signup-otp
// Sends a 4-digit OTP to the email for verification before account creation.
// Rejects if the email is already registered.
// ═══════════════════════════════════════════════════════════════════════
router.post("/send-signup-otp", async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: "Enter a valid email address." });
    }
    const key = email.trim().toLowerCase();

    // Check not already registered
    const existing = await Customer.findOne({ email: key });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists. Please sign in instead.",
      });
    }

    const otp = generateOtp();
    const hash = await hashOtp(otp);
    signupOtpStore.set(key, { hash, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0, verified: false });

    const sent = await sendOtpEmail(key, name || "", otp);

    return res.json({
      success: true,
      message: sent.success
        ? `A 4-digit verification code has been sent to ${key}.`
        : "Code generated but email service is unavailable. Contact support.",
      _devOtp: process.env.NODE_ENV !== "production" ? otp : undefined,
    });
  } catch (err) {
    console.error("[auth/send-signup-otp]", err);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// POST /verify-signup-otp
// Verifies the OTP. On success marks the email as verified in the store.
// The actual account is created in /signup.
// ═══════════════════════════════════════════════════════════════════════
router.post("/verify-signup-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ success: false, message: "Email and OTP are required." });
    }
    const key = email.trim().toLowerCase();
    const stored = signupOtpStore.get(key);

    if (!stored) {
      return res.status(400).json({ success: false, message: "No code found for this email. Please request a new one." });
    }
    if (Date.now() > stored.expiresAt) {
      signupOtpStore.delete(key);
      return res.status(400).json({ success: false, message: "Code expired. Please request a new one." });
    }
    if (stored.attempts >= MAX_ATTEMPTS) {
      signupOtpStore.delete(key);
      return res.status(400).json({ success: false, message: "Too many failed attempts. Please request a new code." });
    }

    const ok = await bcrypt.compare(String(otp).trim(), stored.hash);
    if (!ok) {
      stored.attempts++;
      signupOtpStore.set(key, stored);
      const remaining = MAX_ATTEMPTS - stored.attempts;
      return res.status(400).json({
        success: false,
        message: `Invalid code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`,
      });
    }

    // Mark as verified — signup endpoint checks this
    signupOtpStore.set(key, { ...stored, verified: true });

    return res.json({ success: true, message: "Email verified successfully." });
  } catch (err) {
    console.error("[auth/verify-signup-otp]", err);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// POST /signup
// Creates the account. Requires email to have been verified via OTP first.
// Accepts optional step-3 fields: address, gstNumber, businessInfo, bankDetails, alternatePhone.
// ═══════════════════════════════════════════════════════════════════════
router.post("/signup", async (req, res) => {
  try {
    const {
      name, email, phone, password,
      // optional step-3 fields
      alternatePhone, gstNumber,
      address,       // { street, city, state, pincode, landmark }
      businessInfo,  // { businessType, industryType, website, yearEstablished, employeeCount }
      bankDetails,   // { accountHolderName, accountNumber, ifscCode, bankName, branchName, upiId }
    } = req.body;

    if (!name || !email || !phone || !password) {
      return res.status(400).json({ success: false, message: "Name, email, phone and password are required." });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, message: "Password must be at least 8 characters." });
    }

    const key = email.trim().toLowerCase();

    // Verify email OTP was completed
    const stored = signupOtpStore.get(key);
    if (!stored?.verified) {
      return res.status(400).json({
        success: false,
        message: "Email not verified. Please complete the OTP verification step.",
      });
    }

    const formattedPhone = phone.startsWith("+91") ? phone : `+91${phone}`;

    const existing = await Customer.findOne({
      $or: [{ email: key }, { phone: formattedPhone }],
    });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "Account already exists with this email or phone.",
      });
    }

    const customerData = {
      name: name.trim(),
      email: key,
      phone: formattedPhone,
      password,
      isPhoneVerified: true,
      isEmailVerified: true,
      leadSource: "self_signup",
    };

    // Optional fields
    if (gstNumber) customerData.gstNumber = gstNumber.trim().toUpperCase();
    if (alternatePhone) customerData.alternatePhone = alternatePhone.trim();

    if (address) {
      customerData.profile = {
        address: {
          street:   address.street   || null,
          city:     address.city     || null,
          state:    address.state    || null,
          pincode:  address.pincode  || null,
          landmark: address.landmark || null,
          country:  "India",
        },
      };
    }

    if (businessInfo) {
      customerData.businessInfo = {
        businessType:    businessInfo.businessType    || "",
        industryType:    businessInfo.industryType    || "",
        website:         businessInfo.website         || "",
        yearEstablished: businessInfo.yearEstablished || null,
        employeeCount:   businessInfo.employeeCount   || "",
      };
    }

    if (bankDetails) {
      customerData.bankDetails = {
        accountHolderName: bankDetails.accountHolderName || "",
        accountNumber:     bankDetails.accountNumber     || "",
        ifscCode:          (bankDetails.ifscCode || "").toUpperCase(),
        bankName:          bankDetails.bankName          || "",
        branchName:        bankDetails.branchName        || "",
        upiId:             bankDetails.upiId             || "",
      };
    }

    const customer = await Customer.create(customerData);

    // Clear the signup OTP store entry
    signupOtpStore.delete(key);

    const token = customer.generateAuthToken();
    setCustomerCookie(res, token);

    const safe = customer.toObject();
    delete safe.password;

    return res.status(201).json({
      success: true,
      message: "Account created successfully.",
      customer: safe,
    });
  } catch (err) {
    console.error("[auth/signup]", err);
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: "Account already exists." });
    }
    res.status(500).json({ success: false, message: "Server error during signup." });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// POST /login-password
// ═══════════════════════════════════════════════════════════════════════
router.post("/login-password", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required." });
    }
    const customer = await Customer.findOne({ email: email.toLowerCase() }).select("+password");
    if (!customer) {
      return res.status(401).json({ success: false, message: "Invalid email or password." });
    }
    if (!customer.isActive) {
      return res.status(403).json({ success: false, message: "Your account has been deactivated. Please contact support." });
    }
    if (!customer.password) {
      return res.status(401).json({ success: false, message: "This account uses phone-based login. Please use OTP to sign in." });
    }
    const isValid = await customer.comparePassword(password);
    if (!isValid) {
      return res.status(401).json({ success: false, message: "Invalid email or password." });
    }
    const token = customer.generateAuthToken();
    setCustomerCookie(res, token);
    customer.lastLogin = new Date();
    await customer.save({ validateBeforeSave: false });
    const safe = customer.toObject();
    delete safe.password;
    delete safe.__v;
    return res.status(200).json({ success: true, message: "Login successful.", customer: safe, token });
  } catch (err) {
    console.error("[auth/login-password]", err);
    res.status(500).json({ success: false, message: "Server error during login." });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// POST /check-phone
// ═══════════════════════════════════════════════════════════════════════
router.post("/check-phone", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: "Phone number is required." });
    const formattedPhone = phone.startsWith("+91") ? phone : `+91${phone}`;
    const customer = await Customer.findOne({ phone: formattedPhone }).select("name email phone isActive");
    if (!customer) return res.json({ exists: false });
    return res.json({ exists: true, isActive: customer.isActive !== false, name: customer.name, email: customer.email });
  } catch (err) {
    console.error("[auth/check-phone]", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// POST/GET /signout
// ═══════════════════════════════════════════════════════════════════════
function handleSignout(req, res) {
  nukeCustomerCookie(res);
  res.status(200).json({ success: true, message: "Signed out successfully." });
}
router.post("/signout", handleSignout);
router.get("/signout", handleSignout);

// ═══════════════════════════════════════════════════════════════════════
// POST /signin  (legacy phone-based)
// ═══════════════════════════════════════════════════════════════════════
router.post("/signin", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: "Phone number is required." });
    const formattedPhone = phone.startsWith("+91") ? phone : `+91${phone}`;
    const customer = await Customer.findOne({ phone: formattedPhone });
    if (!customer) {
      return res.status(404).json({ success: false, message: "Customer not found. Please sign up first." });
    }
    const token = customer.generateAuthToken();
    setCustomerCookie(res, token);
    customer.lastLogin = new Date();
    await customer.save({ validateBeforeSave: false });
    const safe = customer.toObject();
    delete safe.password;
    delete safe.__v;
    return res.status(200).json({ success: true, message: "Sign in successful.", customer: safe });
  } catch (err) {
    console.error("[auth/signin]", err);
    res.status(500).json({ success: false, message: "Server error during signin." });
  }
});

module.exports = router;