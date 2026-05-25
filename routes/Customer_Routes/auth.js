// routes/Customer_Routes/auth.js  — UPDATED
// Adds email+password login while keeping the existing phone/OTP flow intact.
//
// NEW endpoints added:
//   POST /api/customer/auth/login-password   — email + password login (for sales-created accounts)
//
// Existing endpoints preserved unchanged:
//   POST /api/customer/auth/signup
//   POST /api/customer/auth/signin           — phone-based (OTP flow)
//   POST /api/customer/auth/signout

const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const Customer = require("../../models/Customer_Models/Customer");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "grav_clothing_secret_key";

// ── Helper: set customerToken cookie ─────────────────────────────────────────
const setCustomerCookie = (res, token) => {
  const isProduction = process.env.NODE_ENV === "production";
  res.cookie("customerToken", token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
};

// ── NEW: Email + Password login ───────────────────────────────────────────────
// Used by sales-created customer accounts. Portal login page should use this.
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

// ── EXISTING: Phone-based signup ──────────────────────────────────────────────
router.post("/signup", async (req, res) => {
  try {
    const { name, email, phone } = req.body;

    if (!name || !email || !phone) {
      return res.status(400).json({
        success: false,
        message: "Name, email and phone are required",
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

// ── EXISTING: Phone-based signin ──────────────────────────────────────────────
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

// ── EXISTING: Sign out ────────────────────────────────────────────────────────
router.post("/signout", (req, res) => {
  res.clearCookie("customerToken");
  res.status(200).json({ success: true, message: "Signed out successfully" });
});

module.exports = router;
