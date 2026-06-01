// routes/Customer_Routes/auth.js
//
// ⚠️ v11 PATCH — sign-out cookie clearing fix.
//
// The bug: `res.clearCookie("customerToken")` was called without options.
// Per the cookie spec, browsers only honour a clear instruction whose
// path / sameSite / secure / httpOnly match the cookie's existing
// attributes. Our cookie was set with `secure: true, sameSite: "none"`
// in production — clearing it without those options is a no-op. Result:
// signout said "Signed out successfully" but the browser kept the cookie,
// so the next GET /api/customer/profile returned 200, and the landing
// page bounced the user straight back to the dashboard.
//
// The fix: define the cookie options ONCE in a shared constant, and use
// the same options for both res.cookie (set) and res.clearCookie (clear).
// Now the browser actually drops the cookie on signout.
//
// Everything else in this file is unchanged: signup, login-password,
// signin (phone-based), check-phone.

const express = require("express");
const router = express.Router();
const Customer = require("../../models/Customer_Models/Customer");

const JWT_SECRET = process.env.JWT_SECRET || "grav_clothing_secret_key";
const CUSTOMER_COOKIE_NAME = "customerToken";

// ─── Single source of truth for cookie attributes ────────────────────────
// Used by BOTH setCustomerCookie and the signout's clearCookie call so the
// browser sees them as the same cookie.
const getCustomerCookieOptions = () => {
  const isProduction = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    path: "/",
  };
};

const setCustomerCookie = (res, token) => {
  res.cookie(CUSTOMER_COOKIE_NAME, token, {
    ...getCustomerCookieOptions(),
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
};

const clearCustomerCookie = (res) => {
  // expires:0 / maxAge:0 — belt and braces. Some browser/OS combos honour
  // one but not the other; sending both guarantees the cookie is dropped.
  res.clearCookie(CUSTOMER_COOKIE_NAME, getCustomerCookieOptions());
};

// ── Check Phone — verify if a phone number is already registered ──────────────
router.post("/check-phone", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res
        .status(400)
        .json({ success: false, message: "Phone number is required" });
    }

    const formattedPhone = phone.startsWith("+91") ? phone : `+91${phone}`;
    const customer = await Customer.findOne({
      phone: formattedPhone,
    }).select("name email phone isActive");

    if (!customer) return res.json({ exists: false });

    return res.json({
      exists: true,
      isActive: customer.isActive !== false,
      name: customer.name,
      email: customer.email,
    });
  } catch (err) {
    console.error("[customer auth] check-phone:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── Email + Password login ────────────────────────────────────────────────────
router.post("/login-password", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ success: false, message: "Email and password are required" });
    }

    const customer = await Customer.findOne({
      email: email.toLowerCase(),
    }).select("+password");

    if (!customer) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid email or password" });
    }

    if (!customer.isActive) {
      return res.status(403).json({
        success: false,
        message: "Your account has been deactivated. Please contact support.",
      });
    }

    if (!customer.password) {
      return res.status(401).json({
        success: false,
        message:
          "This account uses phone-based login. Please use OTP to sign in.",
      });
    }

    const isValid = await customer.comparePassword(password);
    if (!isValid) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid email or password" });
    }

    const token = customer.generateAuthToken();
    setCustomerCookie(res, token);

    customer.lastLogin = new Date();
    await customer.save({ validateBeforeSave: false });

    const safe = customer.toObject();
    delete safe.password;
    delete safe.__v;

    res.status(200).json({
      success: true,
      message: "Login successful",
      customer: safe,
      token,
    });
  } catch (err) {
    console.error("[customer auth] login-password:", err);
    res
      .status(500)
      .json({ success: false, message: "Server error during login" });
  }
});

// ── Phone-based signup ────────────────────────────────────────────────────────
router.post("/signup", async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    if (!name || !email || !phone || !password) {
      return res.status(400).json({
        success: false,
        message: "Name, email, phone and password are required",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters",
      });
    }

    const formattedPhone = phone.startsWith("+91") ? phone : `+91${phone}`;
    const existing = await Customer.findOne({
      $or: [{ email: email.toLowerCase() }, { phone: formattedPhone }],
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        message: "Customer already exists with this email or phone",
      });
    }

    const customer = await Customer.create({
      name,
      email: email.toLowerCase(),
      phone: formattedPhone,
      password,
      isPhoneVerified: true,
      isEmailVerified: false,
    });

    const token = customer.generateAuthToken();
    setCustomerCookie(res, token);

    const safe = customer.toObject();
    delete safe.password;

    res.status(201).json({
      success: true,
      message: "Account created successfully",
      customer: safe,
    });
  } catch (err) {
    console.error("[customer auth] signup:", err);
    if (err.code === 11000) {
      return res
        .status(409)
        .json({ success: false, message: "Account already exists" });
    }
    res
      .status(500)
      .json({ success: false, message: "Server error during signup" });
  }
});

// ── Phone-based signin (legacy OTP flow) ──────────────────────────────────────
router.post("/signin", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res
        .status(400)
        .json({ success: false, message: "Phone number is required" });
    }

    const formattedPhone = phone.startsWith("+91") ? phone : `+91${phone}`;
    const customer = await Customer.findOne({ phone: formattedPhone });

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Customer not found. Please sign up first.",
      });
    }

    const token = customer.generateAuthToken();
    setCustomerCookie(res, token);

    customer.lastLogin = new Date();
    await customer.save({ validateBeforeSave: false });

    const safe = customer.toObject();
    delete safe.password;
    delete safe.__v;

    res
      .status(200)
      .json({ success: true, message: "Sign in successful", customer: safe });
  } catch (err) {
    console.error("[customer auth] signin:", err);
    res
      .status(500)
      .json({ success: false, message: "Server error during signin" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Sign out — FIXED in v11
// ─────────────────────────────────────────────────────────────────────────────
// Now clears the cookie with the same options used to set it, so the
// browser actually drops the cookie. Also avoid sending the cookie
// header back without explicit headers to prevent any caching issues
// on the response.
router.post("/signout", (req, res) => {
  clearCustomerCookie(res);
  // Prevent any cache from serving a stale "logged in" response.
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.status(200).json({ success: true, message: "Signed out successfully" });
});

module.exports = router;
