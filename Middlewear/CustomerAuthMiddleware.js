// Middlewear/CustomerAuthMiddleware.js
// ─────────────────────────────────────────────────────────────────────────
// Shared customer auth.
//
// Exports:
//   - verifyCustomerToken (default)       — required auth, 401 on missing/invalid
//   - optionalCustomerAuth                — sets req.customerId if cookie is
//                                           valid, calls next() either way
//
// optionalCustomerAuth is used by the password-reset OTP routes so they
// work for BOTH the in-portal flow (where the user is logged in and we
// enforce email-match) AND the public /forgot-password flow (where the
// user has no session yet).
//
// ⚠️ JWT_SECRET fallback aligns with the Customer model's
// generateAuthToken() — both use "grav_clothing_secret_key" so dev
// without env vars still works. In prod with JWT_SECRET set, fallback
// is irrelevant.
// ─────────────────────────────────────────────────────────────────────────

const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "grav_clothing_secret_key";
const COOKIE_NAME = "customerToken";

function decodeIfPresent(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ─── REQUIRED auth ──────────────────────────────────────────────────────
function verifyCustomerToken(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Access denied. Please sign in.",
    });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.customerId = decoded.id;
    req.customer = {
      id: decoded.id,
      email: decoded.email,
      name: decoded.name,
      role: decoded.role,
    };
    next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Invalid token. Please sign in again.",
    });
  }
}

// ─── OPTIONAL auth ──────────────────────────────────────────────────────
// Always calls next(). If a valid cookie is present, populates
// req.customerId and req.customer; otherwise leaves them undefined.
function optionalCustomerAuth(req, res, next) {
  const decoded = decodeIfPresent(req);
  if (decoded) {
    req.customerId = decoded.id;
    req.customer = {
      id: decoded.id,
      email: decoded.email,
      name: decoded.name,
      role: decoded.role,
    };
  }
  next();
}

// Default export = required auth (most routes want this)
// Named exports for both versions.
module.exports = verifyCustomerToken;
module.exports.verifyCustomerToken = verifyCustomerToken;
module.exports.optionalCustomerAuth = optionalCustomerAuth;
