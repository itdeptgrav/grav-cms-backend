// routes/Customer_Routes/auth.js
//
// ⚠️ v16 PATCH — Sign-out cookie clearing is now NUCLEAR.
//
// The earlier "match-the-set-options" approach (v11) was correct in theory
// but missed real-world edge cases:
//   - Cookies set in older sessions (before v11) had different attributes
//   - The Clear-Site-Data header is more reliable than clearCookie in
//     some browser/proxy combinations
//
// New approach: blast multiple Set-Cookie clear variants in one response
// to cover every common option set the cookie might've been written with.
// Browsers honor the one that matches and ignore the others. Plus we send
// the Clear-Site-Data header for browsers that support it, which forces
// the browser to drop cookies + storage for our origin.
//
// Everything else (signup, login-password, signin, check-phone) is
// unchanged.

const express = require("express");
const router = express.Router();
const Customer = require("../../models/Customer_Models/Customer");

const JWT_SECRET = process.env.JWT_SECRET || "grav_clothing_secret_key";
const CUSTOMER_COOKIE_NAME = "customerToken";

// ─── Cookie options (used for SET) ───────────────────────────────────────
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

// ── NUCLEAR cookie clear ───────────────────────────────────────────────────
// Sends multiple Set-Cookie headers, each with different attribute
// combinations. Browsers will honor the one matching the actual stored
// cookie and ignore the others. Covers:
//   - production cookies (secure + sameSite=None)
//   - dev cookies (sameSite=Lax, no secure)
//   - legacy cookies that may have been set without httpOnly
//   - cookies with or without explicit path
const nukeCustomerCookie = (res) => {
  const isProduction = process.env.NODE_ENV === "production";
  const expired = "Thu, 01 Jan 1970 00:00:00 GMT";

  // Build a list of clear instructions covering every plausible
  // combination of attributes the cookie might've been set with.
  // Order matters for some browser quirks but not for correctness:
  // any matching one drops the cookie.
  const clearHeaders = [
    // Match current production
    `${CUSTOMER_COOKIE_NAME}=; Path=/; Expires=${expired}; Max-Age=0; HttpOnly; Secure; SameSite=None`,
    // Match current dev / localhost
    `${CUSTOMER_COOKIE_NAME}=; Path=/; Expires=${expired}; Max-Age=0; HttpOnly; SameSite=Lax`,
    // Legacy: maybe no httpOnly
    `${CUSTOMER_COOKIE_NAME}=; Path=/; Expires=${expired}; Max-Age=0; SameSite=Lax`,
    // Bare minimum
    `${CUSTOMER_COOKIE_NAME}=; Path=/; Expires=${expired}; Max-Age=0`,
    // Without explicit path — in case set without one (rare)
    `${CUSTOMER_COOKIE_NAME}=; Expires=${expired}; Max-Age=0; HttpOnly`,
  ];

  // res.append("Set-Cookie", [...]) adds each item as its own Set-Cookie
  // header rather than collapsing them.
  res.append("Set-Cookie", clearHeaders);

  // Clear-Site-Data is honored by Chrome/Edge/Firefox on HTTPS (and
  // localhost in Chrome). It forces the browser to drop cookies and
  // storage for this origin. Belt-and-braces — works alongside Set-Cookie.
  res.set("Clear-Site-Data", '"cookies", "storage"');

  // Prevent any cache/proxy from serving a stale "logged in" response.
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.set("Pragma", "no-cache");
};

// ── Check Phone ──────────────────────────────────────────────────────────────
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

// ── Legacy phone-based signin ─────────────────────────────────────────────────
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

// ═════════════════════════════════════════════════════════════════════════════
// SIGN OUT — v16 NUCLEAR EDITION
// ═════════════════════════════════════════════════════════════════════════════
// Supports BOTH:
//   POST /api/customer/signout  (XHR from dashboard layout)
//   GET  /api/customer/signout  (navigation, in case the user pastes the URL
//                                 or the POST is blocked by some middleware)
// Both call nukeCustomerCookie which sends multiple Set-Cookie clears +
// Clear-Site-Data so the cookie is dropped regardless of how it was set.
function handleSignout(req, res) {
  nukeCustomerCookie(res);
  res.status(200).json({ success: true, message: "Signed out successfully" });
}
router.post("/signout", handleSignout);
router.get("/signout", handleSignout);

module.exports = router;
