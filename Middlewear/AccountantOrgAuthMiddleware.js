// Middlewear/AccountantOrgAuthMiddleware.js
//
// Sub-account / role-aware auth middleware for the accountant module.
//
// This middleware is the new entry point for routes that need:
//   - the authenticated AccountantUser loaded
//   - the organization scope attached to the request
//   - role-based permission checks
//
// The legacy AccountantAuthMiddleware.accountantAuth still works and is
// used by older routes that haven't been migrated yet. Both share the
// same JWT verification — the new middleware just enriches req.user
// with database-backed user/org details.
//
// JWT shape (new):
//   {
//     id:             "<AccountantUser._id>",
//     organizationId: "<AccountantOrganization._id>",
//     role:           "owner" | "approver" | "editor" | "viewer",
//     email, name, iat, exp
//   }
//
// Exports:
//   - orgAuth              → load user + org, attach to req
//   - requireRole(...roles)→ 403 if user's role isn't in the list
//   - requirePermission(p) → 403 if user's permissions[p] is falsy
//   - requireCompanyAccess → 403 if req.companyId isn't owned by the org
//   - signOrgToken         → factory for issuing JWTs from the new shape

const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const SECRET = process.env.JWT_SECRET || "grav_clothing_secret_key";
const DEV_BYPASS = process.env.ACCOUNTANT_AUTH_BYPASS === "true";

// Cached references — lazily required so model registration order doesn't matter
let _models = null;
function getModels() {
  if (_models) return _models;
  _models = require("../models/Accountant_model/AccountantOrgModels");
  return _models;
}

/* ------------------------------------------------------------------ */
/* Token extraction (same logic as legacy middleware)                 */
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
  if (req.cookies?.accountant_token) return req.cookies.accountant_token;
  if (req.cookies?.auth_token) return req.cookies.auth_token;
  if (req.cookies?.token) return req.cookies.token;

  const raw = parseCookieHeader(req.headers?.cookie || "");
  if (raw.accountant_token) return raw.accountant_token;
  if (raw.auth_token) return raw.auth_token;
  if (raw.token) return raw.token;

  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith("Bearer "))
    return authHeader.slice(7);

  return null;
}

/* ------------------------------------------------------------------ */
/* signOrgToken — used by the login route to mint JWTs                */
/* ------------------------------------------------------------------ */

function signOrgToken(user, expiresIn = "12h") {
  return jwt.sign(
    {
      id: String(user._id),
      organizationId: String(user.organizationId),
      role: user.role,
      email: user.email,
      name: user.name,
    },
    SECRET,
    { expiresIn },
  );
}

/* ------------------------------------------------------------------ */
/* orgAuth — the main middleware                                      */
/* ------------------------------------------------------------------ */
// Verifies JWT, loads the AccountantUser + AccountantOrganization, and
// attaches them to req.user / req.organization. Subsequent middleware
// can rely on these without re-querying.

async function orgAuth(req, res, next) {
  // DEV BYPASS — useful when seeding initial data via curl/Postman
  if (DEV_BYPASS) {
    req.user = {
      id: "000000000000000000000001",
      organizationId: null,
      role: "owner",
      email: "dev@local",
      name: "Dev Owner",
      isDev: true,
      permissions: {
        canView: true,
        canEdit: true,
        canPostDirectly: true,
        canApprove: true,
        canManageTeam: true,
        canManageSettings: true,
      },
    };
    req.organization = null;
    return next();
  }

  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Authentication required",
      code: "NO_TOKEN",
    });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, SECRET);
  } catch (e) {
    return res.status(401).json({
      success: false,
      message:
        e.name === "TokenExpiredError"
          ? "Session expired — please log in again."
          : "Invalid token",
      code: e.name,
    });
  }

  // Legacy token compatibility: if the token doesn't have organizationId,
  // it was issued by the old login system. Fall through into legacy mode
  // — set req.user from the decoded JWT directly, no org enrichment. This
  // lets a single accountant who logs in via the old system continue
  // to work; only sub-account features will be unavailable.
  if (!decoded.organizationId) {
    req.user = {
      id: decoded.id || decoded._id || decoded.userId,
      role: decoded.role || "owner",
      email: decoded.email,
      name: decoded.name,
      isLegacy: true,
      permissions: {
        canView: true,
        canEdit: true,
        canPostDirectly: true,
        canApprove: true,
        canManageTeam: false,
        canManageSettings: true,
      },
    };
    req.organization = null;
    return next();
  }

  // New-shape token — enrich from DB
  try {
    const { AccountantUser, AccountantOrganization } = getModels();
    const user = await AccountantUser.findById(decoded.id).lean();
    if (!user || !user.isActive) {
      return res
        .status(401)
        .json({ success: false, message: "User account inactive or removed" });
    }
    if (String(user.organizationId) !== String(decoded.organizationId)) {
      // Token org doesn't match DB org — refuse, possibly tampered
      return res.status(401).json({
        success: false,
        message: "Organization mismatch — please log in again",
      });
    }
    const org = await AccountantOrganization.findById(
      user.organizationId,
    ).lean();
    if (!org || !org.isActive) {
      return res
        .status(403)
        .json({ success: false, message: "Organization inactive" });
    }

    // Compute permissions inline (same logic as the schema method)
    const perms = {
      canView: true,
      canEdit: false,
      canPostDirectly: false,
      canApprove: false,
      canManageTeam: false,
      canManageSettings: false,
    };
    if (user.role === "owner") {
      perms.canEdit =
        perms.canPostDirectly =
        perms.canApprove =
        perms.canManageTeam =
        perms.canManageSettings =
          true;
    } else if (user.role === "approver") {
      perms.canEdit = perms.canPostDirectly = perms.canApprove = true;
    } else if (user.role === "editor") {
      perms.canEdit = true;
    }

    req.user = {
      id: String(user._id),
      organizationId: String(user.organizationId),
      role: user.role,
      email: user.email,
      name: user.name,
      isOwner: user.role === "owner",
      permissions: perms,
    };
    req.organization = org;
    next();
  } catch (e) {
    console.error("[orgAuth] failed to load user/org:", e);
    return res
      .status(500)
      .json({ success: false, message: "Authentication system error" });
  }
}

/* ------------------------------------------------------------------ */
/* requireRole — gate a route by role                                 */
/* ------------------------------------------------------------------ */

function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.user) {
      return res
        .status(401)
        .json({ success: false, message: "Not authenticated" });
    }
    if (!allowed.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `This action requires role: ${allowed.join(" or ")}. You are: ${req.user.role}.`,
      });
    }
    next();
  };
}

/* ------------------------------------------------------------------ */
/* requirePermission — gate by named permission                       */
/* ------------------------------------------------------------------ */

function requirePermission(perm) {
  return (req, res, next) => {
    if (!req.user)
      return res
        .status(401)
        .json({ success: false, message: "Not authenticated" });
    if (!req.user.permissions?.[perm]) {
      return res.status(403).json({
        success: false,
        message: `You don't have permission: ${perm}`,
      });
    }
    next();
  };
}

/* ------------------------------------------------------------------ */
/* requireCompanyAccess — verify org owns the requested companyId     */
/* ------------------------------------------------------------------ */

function requireCompanyAccess(req, res, next) {
  if (req.user?.isDev || req.user?.isLegacy) return next(); // legacy/dev: skip

  const companyId =
    req.params?.companyId || req.query?.companyId || req.body?.companyId;
  if (!companyId) return next(); // routes that don't need a company scope just pass through

  if (!req.organization) {
    return res
      .status(403)
      .json({ success: false, message: "No organization context" });
  }

  const owned = (req.organization.tallyCompanyIds || []).map(String);
  if (!owned.includes(String(companyId))) {
    return res.status(403).json({
      success: false,
      message: "Your organization does not have access to this company",
    });
  }
  next();
}

/* ------------------------------------------------------------------ */
/* Exports                                                            */
/* ------------------------------------------------------------------ */

module.exports = {
  orgAuth,
  requireRole,
  requirePermission,
  requireCompanyAccess,
  signOrgToken,
  extractToken,
};
