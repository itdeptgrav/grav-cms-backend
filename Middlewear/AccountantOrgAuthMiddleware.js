// Middlewear/AccountantOrgAuthMiddleware.js
//
// Sub-account / role-aware auth middleware for the accountant module.
//
// ─── FIX (v2) ─────────────────────────────────────────────────────────────────
// PROBLEM: When `accountant_token` cookie JWT is EXPIRED (after 24 h / or old
//   12 h tokens), `tryVerify()` returns null and the old code immediately 401'd
//   WITHOUT trying the `auth_token` cookie that the main CMS login issued.
//
// FIX: `orgAuth` now iterates through ALL present token sources in priority
//   order.  If a source fails verification (expired or invalid), we clear the
//   cookie if it's one we own (`accountant_token`) and continue to the next
//   source.  Only when every source has been exhausted do we return 401.
// ──────────────────────────────────────────────────────────────────────────────
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
// TOKEN PRIORITY:
//   1. accountant_token  — issued by accountant module's own login / sync-legacy
//   2. auth_token        — issued by main CMS login
//   3. token             — older variant
//   4. Bearer header     — cross-origin / mobile fallback (localStorage → api.js)
//
// If any source fails verification we try the next rather than bailing.
// Stale accountant_token cookies are proactively cleared on the response.
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
//   - extractToken         → backwards-compat for older routes

const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET || "grav_clothing_secret_key";
const DEV_BYPASS = process.env.ACCOUNTANT_AUTH_BYPASS === "true";

const ACCOUNTANT_COOKIE = "accountant_token";
const isProduction = process.env.NODE_ENV === "production";

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

// ─── Get all token sources in priority order ─────────────────────────────────
// Returns an array of { token, source } objects so orgAuth can try each one.
function getAllTokenSources(req) {
  const c = getAllCookies(req);
  const sources = [];

  // 1. Dedicated accountant cookie (most specific, highest priority)
  if (c.accountant_token) {
    sources.push({ token: c.accountant_token, source: "accountant_token" });
  }
  // 2. Main CMS cookie (legacy path — triggers sync-legacy on /me)
  if (c.auth_token) {
    sources.push({ token: c.auth_token, source: "auth_token" });
  }
  // 3. Older cookie name
  if (c.token) {
    sources.push({ token: c.token, source: "token" });
  }
  // 4. Bearer header — injected by lib/api.js from localStorage (Chrome fix)
  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    sources.push({ token: authHeader.slice(7), source: "bearer" });
  }

  return sources;
}

// Backwards-compat: many routes import extractToken directly.
// Returns just the first present token string (doesn't validate).
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

/* ------------------------------------------------------------------ */
/* signOrgToken — used by the login route to mint JWTs                */
/* ------------------------------------------------------------------ */

// NOTE: expiresIn is now "24h" (was "12h") to match the cookie maxAge.
// Having the JWT expire before the cookie causes the browser to keep
// sending a cookie whose JWT is already dead → 401 on every request.
function signOrgToken(user, expiresIn = "24h") {
  return jwt.sign(
    {
      id: String(user._id),
      organizationId: String(user.organizationId),
      role: user.role,
      email: user.email,
      name: user.name,
      tokenVersion: user.tokenVersion || 0,
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
/* clearAccountantCookie — helper to remove our cookie from response  */
/* ------------------------------------------------------------------ */
function clearAccountantCookie(res) {
  res.clearCookie(ACCOUNTANT_COOKIE, {
    httpOnly: true,
    sameSite: isProduction ? "none" : "lax",
    secure: isProduction,
    path: "/",
  });
}

/* ------------------------------------------------------------------ */
/* setLegacyUser — populate req.user from a legacy CMS token          */
/* ------------------------------------------------------------------ */
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
/* orgAuth — the main middleware                                       */
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

  // ── Gather all available token sources ──────────────────────────────────
  const tokenSources = getAllTokenSources(req);

  if (tokenSources.length === 0) {
    return res.status(401).json({
      success: false,
      message: "Authentication required",
      code: "NO_TOKEN",
    });
  }

  // ── Try each source in priority order ───────────────────────────────────
  // Key fix: when accountant_token is expired/invalid we DON'T bail — we
  // clear that stale cookie and fall through to the next source (auth_token).
  let decoded = null;
  let usedSource = null;

  for (const { token, source } of tokenSources) {
    const d = tryVerify(token);
    if (!d) {
      // This token is expired or malformed.
      // If it's our accountant_token cookie, clear it so the browser stops
      // sending it and the user isn't stuck in a redirect loop.
      if (source === "accountant_token") {
        clearAccountantCookie(res);
      }
      // Try the next source.
      continue;
    }
    decoded = d;
    usedSource = source;
    break;
  }

  if (!decoded) {
    // Every source failed — truly no valid session.
    return res.status(401).json({
      success: false,
      message: "Session expired — please log in again.",
      code: "INVALID_TOKEN",
    });
  }

  // ── Legacy-token path ────────────────────────────────────────────────────
  // No organizationId in the token → it's a CMS-issued legacy JWT.
  // Set req.user.isLegacy = true; the /me endpoint returns isLegacy:true and
  // the frontend calls /sync-legacy to upgrade the session transparently.
  if (!decoded.organizationId) {
    setLegacyUser(req, decoded);
    return next();
  }

  // ── New-shape token path ─────────────────────────────────────────────────
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
    const userOk =
      user &&
      user.isActive &&
      (decoded.tokenVersion || 0) === (user.tokenVersion || 0);
    const orgMatches =
      userOk && String(user.organizationId) === String(decoded.organizationId);

    if (!userOk || !orgMatches) {
      // ── STALE-USER FALLBACK ────────────────────────────────────────────
      // The JWT is cryptographically valid but points to an Acc_User that
      // no longer exists or is inactive (e.g. after a DB reset). Clear the
      // stale accountant_token and try the next cookie (auth_token).
      if (usedSource === "accountant_token") {
        clearAccountantCookie(res);
      }

      // Try auth_token as legacy fallback
      const cookies = getAllCookies(req);
      const legacyToken = cookies.auth_token || cookies.token || null;
      const legacyDecoded = tryVerify(legacyToken);
      if (legacyDecoded && !legacyDecoded.organizationId) {
        setLegacyUser(req, legacyDecoded);
        return next();
      }

      // Also accept a Bearer token that looks like a legacy CMS token
      const authHeader = req.headers?.authorization;
      if (authHeader && authHeader.startsWith("Bearer ")) {
        const bearerDecoded = tryVerify(authHeader.slice(7));
        if (bearerDecoded && !bearerDecoded.organizationId) {
          setLegacyUser(req, bearerDecoded);
          return next();
        }
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
/* Role / permission gates                                             */
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
