// Middlewear/AccountantAuthMiddleware.js
//
// Accountant auth middleware. Handles JWT extraction from cookies (with or
// without cookie-parser middleware) and Bearer headers. Has a DEV BYPASS
// flag for local debugging when login isn't yet wired up.
//
// Exports:
//   - accountantAuth         → require role: accountant or admin (default for all routes)
//   - accountantReadOnlyAuth → also accept "accountant_viewer"
//   - adminOnlyAuth          → require role: admin
//   - withCompanyScope       → injects req.companyId
//   - verifyToken            → raw JWT verifier (throws on failure)
//   - makeAuth               → factory for custom role lists
//
// DEV BYPASS — set ACCOUNTANT_AUTH_BYPASS=true in .env to skip auth checks
// during local development. This injects a fake admin user. NEVER use in
// production.

const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const DEV_BYPASS = process.env.ACCOUNTANT_AUTH_BYPASS === "true";

if (DEV_BYPASS) {
  console.warn("⚠️  [accountant-auth] DEV BYPASS ENABLED — every request will be authenticated as fake admin");
}

/* ------------------------------------------------------------------ */
/* Cookie parsing — works even when cookie-parser isn't installed     */
/* ------------------------------------------------------------------ */

function parseCookieHeader(cookieHeader) {
  if (!cookieHeader || typeof cookieHeader !== "string") return {};
  const out = {};
  cookieHeader.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx < 0) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function extractToken(req) {
  // 1. Try cookie-parser-populated req.cookies
  if (req.cookies?.auth_token) return req.cookies.auth_token;
  if (req.cookies?.token)      return req.cookies.token;
  if (req.cookies?.jwt)        return req.cookies.jwt;

  // 2. Fallback: parse the raw cookie header ourselves
  const raw = parseCookieHeader(req.headers?.cookie || "");
  if (raw.auth_token) return raw.auth_token;
  if (raw.token)      return raw.token;
  if (raw.jwt)        return raw.jwt;

  // 3. Authorization: Bearer …
  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* JWT verifier                                                        */
/* ------------------------------------------------------------------ */

function verifyToken(req) {
  const token = extractToken(req);

  if (!token) {
    const err = new Error("Authentication required — no token in cookies or Authorization header");
    err.status = 401;
    err.code = "NO_TOKEN";
    throw err;
  }

  try {
    return jwt.verify(token, process.env.JWT_SECRET || "grav_clothing_secret_key");
  } catch (e) {
    const err = new Error(
      e.name === "TokenExpiredError"
        ? "Session expired — please log in again."
        : "Invalid authentication token"
    );
    err.status = 401;
    err.code = e.name;
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Role-checking factory                                              */
/* ------------------------------------------------------------------ */

function makeAuth(allowedRoles = []) {
  return (req, res, next) => {
    // DEV BYPASS — inject fake admin
    if (DEV_BYPASS) {
      req.user = {
        id: "000000000000000000000001",
        role: "admin",
        employeeId: "DEV-ADMIN",
        name: "Dev Admin",
        email: "dev@local",
      };
      return next();
    }

    try {
      const decoded = verifyToken(req);

      if (allowedRoles.length > 0 && !allowedRoles.includes(decoded.role)) {
        return res.status(403).json({
          success: false,
          message: `Access denied. Required role: ${allowedRoles.join(" or ")}. You are: ${decoded.role}.`,
        });
      }

      req.user = {
        id: decoded.id || decoded._id || decoded.userId,
        role: decoded.role,
        employeeId: decoded.employeeId,
        name: decoded.name,
        email: decoded.email,
      };

      next();
    } catch (err) {
      return res.status(err.status || 401).json({
        success: false,
        message: err.message || "Authentication failed",
        code: err.code,
      });
    }
  };
}

/* ------------------------------------------------------------------ */
/* Pre-configured middleware                                          */
/* ------------------------------------------------------------------ */

const accountantAuth         = makeAuth(["accountant", "admin"]);
const accountantReadOnlyAuth = makeAuth(["accountant", "accountant_viewer", "admin"]);
const adminOnlyAuth          = makeAuth(["admin"]);

/* ------------------------------------------------------------------ */
/* Company-scope middleware                                           */
/* ------------------------------------------------------------------ */

function withCompanyScope(req, res, next) {
  const companyId = req.params?.companyId || req.query?.companyId || req.body?.companyId;

  if (!companyId) {
    return res.status(400).json({ success: false, message: "companyId is required for this route" });
  }
  if (!mongoose.Types.ObjectId.isValid(companyId)) {
    return res.status(400).json({ success: false, message: "Invalid companyId format" });
  }
  req.companyId = companyId;
  next();
}

/* ------------------------------------------------------------------ */
/* Activity log helper (no-op if model missing)                       */
/* ------------------------------------------------------------------ */

function logAccountantActivity(action) {
  return async (req, res, next) => {
    try {
      const ActivityLog = mongoose.models.ActivityLog;
      if (ActivityLog && req.user) {
        ActivityLog.create({
          userId: req.user.id,
          userName: req.user.name,
          action,
          method: req.method,
          path: req.originalUrl,
          ip: req.ip,
          timestamp: new Date(),
        }).catch(() => {});
      }
    } catch { /* swallow */ }
    next();
  };
}

/* ------------------------------------------------------------------ */
/* Exports                                                            */
/* ------------------------------------------------------------------ */

module.exports = makeAuth;

module.exports.accountantAuth         = accountantAuth;
module.exports.accountantReadOnlyAuth = accountantReadOnlyAuth;
module.exports.adminOnlyAuth          = adminOnlyAuth;
module.exports.withCompanyScope       = withCompanyScope;
module.exports.logAccountantActivity  = logAccountantActivity;
module.exports.makeAuth               = makeAuth;
module.exports.verifyToken            = verifyToken;
module.exports.extractToken           = extractToken;
