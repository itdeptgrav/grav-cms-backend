// Middlewear/AccountantOrgAuthMiddleware.js
//
// Sub-account / role-aware auth middleware for the accountant module.
//
// Entry point for routes that need:
//   • the authenticated Acc_User loaded
//   • the organization scope attached to the request
//   • role-based permission checks
//
// JWT shape (new):
//   {
//     id:             "<Acc_User._id>",
//     organizationId: "<Acc_Organization._id>",
//     role:           "owner" | "approver" | "editor" | "viewer",
//     email, name, iat, exp
//   }
//
// JWT shape (legacy CMS token):
//   {
//     id:        "<Acc_Department._id>",
//     role:      "accountant" | "admin" | …
//     employeeId, userType, name, iat, exp
//     // NO organizationId, NO email
//   }
//
// COOKIE PRIORITY:
//   1. accountant_token  — issued by accountant module's own login / sync-legacy
//   2. auth_token        — issued by main CMS login
//   3. token / Bearer    — older variants
//
// FALLBACK BEHAVIOR (important):
//   If the accountant_token JWT references an Acc_User that no longer
//   exists or is inactive (typical after a DB reset), we DON'T just
//   reject — we transparently clear that stale cookie and fall through
//   to the auth_token (legacy CMS token), which usually IS still valid
//   because the CMS user record in acc_departments is the seeded one.
//
// MODEL REFERENCES (post-Acc_ rename):
//   • Acc_User          — `acc_users` collection
//   • Acc_Organization  — `acc_organizations` collection
//   Both exported from `models/Accountant_model/Acc_OrgModels.js`.
//
// Exports:
//   - orgAuth              → load user + org, attach to req
//   - requireRole(...)     → 403 if user's role isn't allowed
//   - requirePermission(p) → 403 if user lacks named permission
//   - requireCompanyAccess → 403 if companyId not owned by the org
//   - signOrgToken         → mint JWTs from the new shape

const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const SECRET = process.env.JWT_SECRET || "grav_clothing_secret_key";
const DEV_BYPASS = process.env.ACCOUNTANT_AUTH_BYPASS === "true";

// The cookie name minted by the accountant module's own login flow.
// When we detect a stale token in this cookie, we must clear it so
// the browser doesn't keep re-sending it on every request.
const ACCOUNTANT_COOKIE = "accountant_token";

// Cached references — lazily required so model registration order
// doesn't matter.
let _models = null;
function getModels() {
  if (_models) return _models;
  _models = require("../models/Accountant_model/Acc_OrgModels");
  return _models;
}

/* ------------------------------------------------------------------ */
/* Cookie helpers — work even when cookie-parser isn't installed       */
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

function getAllCookies(req) {
  const merged = { ...parseCookieHeader(req.headers?.cookie || "") };
  if (req.cookies) Object.assign(merged, req.cookies);
  return merged;
}

// Backwards-compat: many routes import extractToken directly. Keep
// returning JUST the token string for them.
function extractToken(req) {
  const c = getAllCookies(req);
  if (c.accountant_token) return c.accountant_token;
  if (c.auth_token) return c.auth_token;
  if (c.token) return c.token;

  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith("Bearer "))
    return authHeader.slice(7);

  return null;
}

// Internal version used by orgAuth — also tells us WHICH cookie/header
// the token came from. Helps decide whether to clear it on failure.
function extractTokenWithSource(req) {
  const c = getAllCookies(req);
  if (c.accountant_token)
    return { token: c.accountant_token, source: "accountant_token" };
  if (c.auth_token) return { token: c.auth_token, source: "auth_token" };
  if (c.token) return { token: c.token, source: "token" };

  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith("Bearer "))
    return { token: authHeader.slice(7), source: "bearer" };

  return { token: null, source: null };
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

function tryVerify(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* setLegacyUser — populate req.user from a legacy CMS token          */
/* ------------------------------------------------------------------ */
// Used by both the direct legacy path and the fallback-from-stale path.

function setLegacyUser(req, decoded) {
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
}

/* ------------------------------------------------------------------ */
/* orgAuth — the main middleware                                      */
/* ------------------------------------------------------------------ */

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

  const { token, source } = extractTokenWithSource(req);
  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Authentication required",
      code: "NO_TOKEN",
    });
  }

  const decoded = tryVerify(token);
  if (!decoded) {
    return res.status(401).json({
      success: false,
      message: "Session expired — please log in again.",
      code: "INVALID_TOKEN",
    });
  }

  // ── Legacy-token path ────────────────────────────────────────────
  // No organizationId in the token → it's a CMS-issued legacy JWT.
  // Set req.user.isLegacy = true and let the route handle the rest
  // (typically /me returns isLegacy:true and the frontend then calls
  // /sync-legacy to upgrade the session).
  if (!decoded.organizationId) {
    setLegacyUser(req, decoded);
    return next();
  }

  // ── New-shape token path ─────────────────────────────────────────
  try {
    const { Acc_User, Acc_Organization } = getModels();
    if (!Acc_User || !Acc_Organization) {
      console.error(
        "[orgAuth] Acc_User or Acc_Organization model not registered. " +
          "Check that models/Accountant_model/Acc_OrgModels.js is loaded.",
      );
      return res.status(500).json({
        success: false,
        message: "Auth model registration error",
      });
    }

    const user = await Acc_User.findById(decoded.id).lean();
    const userOk = user && user.isActive;
    const orgMatches =
      userOk && String(user.organizationId) === String(decoded.organizationId);

    if (!userOk || !orgMatches) {
      // ── STALE-COOKIE FALLBACK ──────────────────────────────────
      // The accountant_token cookie points to an Acc_User that no
      // longer exists (or is inactive, or the org doesn't match).
      // This happens commonly after a DB reset — the cookie outlives
      // the data it referenced. Clear the stale cookie and look for
      // a legacy CMS token in OTHER cookies. If one exists, fall
      // through into legacy mode so the user keeps working.
      if (source === "accountant_token") {
        res.clearCookie(ACCOUNTANT_COOKIE, {
          httpOnly: true,
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production",
          path: "/",
        });
      }

      const cookies = getAllCookies(req);
      const legacyToken = cookies.auth_token || cookies.token || null;
      const legacyDecoded = tryVerify(legacyToken);
      if (legacyDecoded && !legacyDecoded.organizationId) {
        setLegacyUser(req, legacyDecoded);
        return next();
      }

      return res.status(401).json({
        success: false,
        message: !user
          ? "Your session points to an account that no longer exists. Please log in again."
          : "User account inactive or removed",
        code: "STALE_TOKEN",
      });
    }

    const org = await Acc_Organization.findById(user.organizationId).lean();
    if (!org || !org.isActive) {
      return res
        .status(403)
        .json({ success: false, message: "Organization inactive" });
    }

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
/* Role / permission gates                                            */
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

function requireCompanyAccess(req, res, next) {
  if (req.user?.isDev || req.user?.isLegacy) return next();

  const companyId =
    req.params?.companyId || req.query?.companyId || req.body?.companyId;
  if (!companyId) return next();

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

module.exports = {
  orgAuth,
  requireRole,
  requirePermission,
  requireCompanyAccess,
  signOrgToken,
  extractToken,
};
