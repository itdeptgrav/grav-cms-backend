// Middlewear/AccountantAuthMiddleware.js
//
// Accountant auth middleware. Handles JWT extraction from cookies (with or
// without cookie-parser middleware) and Bearer headers. Has a DEV BYPASS
// flag for local debugging when login isn't yet wired up.
//
// HISTORY:
//   This file is the LEGACY entry-point. The new sub-account system
//   (organization + roles: owner/approver/editor/viewer) lives in
//   AccountantOrgAuthMiddleware.js. Both must coexist for two reasons:
//
//     1. Existing accountant routes import { accountantAuth } from here
//        and we don't want to rewrite every route.
//     2. The main GRAV CMS login also issues JWTs that we need to keep
//        accepting (for backwards-compat).
//
//   So this file was rewritten to accept BOTH token formats:
//     - new tokens (with organizationId + role in {owner, approver,
//       editor, viewer}) → read from `accountant_token` cookie, with
//       priority over the legacy cookie names
//     - legacy tokens (role in {accountant, admin, accountant_viewer})
//       → read from auth_token / token / jwt cookies
//
//   When a new-system token is used, req.user is populated with the
//   new user's id/role/email PLUS a `permissions` object so old routes
//   can opt-in to fine-grained gating if they want.
//
// Exports (unchanged from before):
//   - accountantAuth         → require role: accountant or admin OR any
//                              new-system role (so editors/viewers can
//                              also access legacy routes; routes that
//                              need to restrict by permission should
//                              check req.user.permissions themselves)
//   - accountantReadOnlyAuth → as above plus accountant_viewer
//   - adminOnlyAuth          → require role: admin or owner
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
  console.warn(
    "⚠️  [accountant-auth] DEV BYPASS ENABLED — every request will be authenticated as fake admin",
  );
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
  // PRIORITY ORDER:
  //   1. accountant_token   — new sub-account system (most specific)
  //   2. auth_token         — legacy CMS cookie
  //   3. token / jwt        — older variants
  //   4. Authorization: Bearer

  // 1. Try cookie-parser-populated req.cookies
  if (req.cookies?.accountant_token) return req.cookies.accountant_token;
  if (req.cookies?.auth_token) return req.cookies.auth_token;
  if (req.cookies?.token) return req.cookies.token;
  if (req.cookies?.jwt) return req.cookies.jwt;

  // 2. Fallback: parse the raw cookie header ourselves
  const raw = parseCookieHeader(req.headers?.cookie || "");
  if (raw.accountant_token) return raw.accountant_token;
  if (raw.auth_token) return raw.auth_token;
  if (raw.token) return raw.token;
  if (raw.jwt) return raw.jwt;

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
    const err = new Error(
      "Authentication required — no token in cookies or Authorization header",
    );
    err.status = 401;
    err.code = "NO_TOKEN";
    throw err;
  }

  try {
    return jwt.verify(
      token,
      process.env.JWT_SECRET || "grav_clothing_secret_key",
    );
  } catch (e) {
    const err = new Error(
      e.name === "TokenExpiredError"
        ? "Session expired — please log in again."
        : "Invalid authentication token",
    );
    err.status = 401;
    err.code = e.name;
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Role compatibility map                                              */
/* ------------------------------------------------------------------ */
// New roles → are they accepted by routes that ask for legacy roles?
// The answer: yes for ALL of them. Old routes don't care about edit vs
// view; routes that want to block viewers should check
// req.user.permissions.canEdit themselves.

const NEW_ROLES = ["owner", "approver", "editor", "viewer"];

function isNewRole(role) {
  return NEW_ROLES.includes(role);
}

// Compute the permissions object for a new-system role.
function newRolePermissions(role) {
  const p = {
    canView: true,
    canEdit: false,
    canPostDirectly: false,
    canApprove: false,
    canManageTeam: false,
    canManageSettings: false,
  };
  if (role === "owner") {
    p.canEdit =
      p.canPostDirectly =
      p.canApprove =
      p.canManageTeam =
      p.canManageSettings =
        true;
  } else if (role === "approver") {
    p.canEdit = p.canPostDirectly = p.canApprove = true;
  } else if (role === "editor") {
    p.canEdit = true;
  }
  return p;
}

// Compute permissions for legacy roles. Legacy `accountant` had full
// rights; `accountant_viewer` was read-only; `admin` had everything.
function legacyRolePermissions(role) {
  const p = {
    canView: true,
    canEdit: false,
    canPostDirectly: false,
    canApprove: false,
    canManageTeam: false,
    canManageSettings: false,
  };
  if (role === "admin" || role === "accountant") {
    p.canEdit =
      p.canPostDirectly =
      p.canApprove =
      p.canManageTeam =
      p.canManageSettings =
        true;
  }
  return p;
}

/* ------------------------------------------------------------------ */
/* Role-checking factory                                              */
/* ------------------------------------------------------------------ */
//
// `allowedRoles` is the original list of legacy roles a route asks for.
// We extend it so that ANY new-system role is also implicitly accepted
// — letting editors/viewers reach old read-paths. Routes that want to
// gate writes should inspect req.user.permissions.canEdit themselves.

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
        permissions: legacyRolePermissions("admin"),
        isDev: true,
      };
      return next();
    }

    try {
      const decoded = verifyToken(req);
      const role = decoded.role;

      // Decide acceptance:
      //   - if role is a new-system role → accept (we'll set permissions
      //     so routes can self-gate)
      //   - if role is in the legacy allow-list → accept
      //   - else → 403
      const isNew = isNewRole(role);
      const allowedExplicit =
        allowedRoles.length === 0 || allowedRoles.includes(role);

      if (!isNew && !allowedExplicit) {
        return res.status(403).json({
          success: false,
          message: `Access denied. Required role: ${allowedRoles.join(" or ")}. You are: ${role}.`,
        });
      }

      req.user = {
        id: decoded.id || decoded._id || decoded.userId,
        organizationId: decoded.organizationId || null,
        role,
        employeeId: decoded.employeeId,
        name: decoded.name,
        email: decoded.email,
        permissions: isNew
          ? newRolePermissions(role)
          : legacyRolePermissions(role),
        isNewSystem: isNew,
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

const accountantAuth = makeAuth(["accountant", "admin"]);
const accountantReadOnlyAuth = makeAuth([
  "accountant",
  "accountant_viewer",
  "admin",
]);
const adminOnlyAuth = makeAuth(["admin"]);

/* ------------------------------------------------------------------ */
/* Company-scope middleware                                           */
/* ------------------------------------------------------------------ */

function withCompanyScope(req, res, next) {
  const companyId =
    req.params?.companyId || req.query?.companyId || req.body?.companyId;

  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: "companyId is required for this route",
    });
  }
  if (!mongoose.Types.ObjectId.isValid(companyId)) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid companyId format" });
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
    } catch {
      /* swallow */
    }
    next();
  };
}

/* ------------------------------------------------------------------ */
/* Exports                                                            */
/* ------------------------------------------------------------------ */

module.exports = makeAuth;

module.exports.accountantAuth = accountantAuth;
module.exports.accountantReadOnlyAuth = accountantReadOnlyAuth;
module.exports.adminOnlyAuth = adminOnlyAuth;
module.exports.withCompanyScope = withCompanyScope;
module.exports.logAccountantActivity = logAccountantActivity;
module.exports.makeAuth = makeAuth;
module.exports.verifyToken = verifyToken;
module.exports.extractToken = extractToken;
module.exports.newRolePermissions = newRolePermissions;
module.exports.legacyRolePermissions = legacyRolePermissions;
