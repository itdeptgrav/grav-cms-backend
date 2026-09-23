// Middlewear/AccountantOrgAuthMiddleware.js
//
// Sub-account / role-aware auth middleware for the accountant module.
//
// ─── LEGACY SESSIONS ARE BOOTSTRAP-ONLY (Chunk 1) ─────────────────────────────
// A legacy CMS JWT (one with no `organizationId`) used to be handed a full set
// of accounting permissions by `orgAuth`, and `requireCompanyAccess` waved it
// past company scoping. Every department login in this CMS issues a token
// without an organizationId, so any logged-in user of any department could
// read, post, approve and change settings in Accounting.
//
// That grant is gone. A legacy token is now only good for ONE thing: proving
// who you are to `/accountant/auth/me` and `/accountant/auth/sync-legacy` so a
// legitimate Accounting-department user can upgrade to a real, organisation-
// aware `accountant_token`.
//
//   • `orgAuth`             — the generic gate. Refuses legacy sessions with
//                             401 ACCOUNTING_SESSION_UPGRADE_REQUIRED. It never
//                             populates req.user from a legacy token.
//   • `legacyBootstrapAuth` — mounted ONLY on the two auth-bootstrap endpoints.
//                             Accepts a legacy token but attaches a session with
//                             every permission false and no organisation.
//
// The split is by explicit mounting, not by inspecting req.originalUrl: a
// generic middleware that string-matches URLs is one route rename away from
// re-opening the hole.
//
// ─── TOKEN-SOURCE FALLBACK ────────────────────────────────────────────────────
// When the `accountant_token` cookie JWT is expired, `tryVerify()` returns null.
// Rather than 401ing immediately we clear that stale cookie and continue through
// the remaining sources (auth_token / token / Bearer). Only when every source is
// exhausted do we return 401. A fallback that lands on a legacy token still only
// buys the bootstrap flow — on `orgAuth` it is an upgrade-required refusal.
//
// JWT shape (new):
//   {
//     id:             "<Acc_User._id>",
//     organizationId: "<Acc_Organization._id>",
//     role:           "owner" | "approver" | "editor" | "viewer",
//     email, name, tokenVersion, iat, exp
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
// ─── CREDENTIAL SELECTION ─────────────────────────────────────────────────────
// A browser that has signed into the CMS sends the legacy `auth_token` cookie on
// EVERY accounting request (lib/api.js uses `credentials: "include"`), alongside
// the organisation-aware accounting token it injects as `Authorization: Bearer`.
// Both are cryptographically valid. Picking whichever is checked first therefore
// hands a legacy answer to a caller holding a perfectly good accounting session
// — which, now that legacy means "no permissions", would refuse every request
// Chrome makes.
//
// So selection is not first-valid-wins. Every candidate is verified, then:
//
//   1. Organisation-aware candidates are tried first, in this order:
//        bearer → accountant_token → auth_token → token
//      The Bearer header is the explicit, deliberately-supplied credential;
//      cookies are ambient and may be stale or left over from another account.
//      The first candidate CONFIRMED against the database wins — a valid-looking
//      Bearer whose Acc_User is gone does not shadow a good cookie.
//   2. Only when no organisation-aware candidate is confirmed does a legacy
//      candidate produce a bootstrap identity.
//
// Stale `accountant_token` cookies are still cleared: on failed verification, on
// failed database confirmation, and when the winning credential turns out to be
// a different identity than the one in the cookie.
//
// MODEL REFERENCES (post-Acc_ rename):
//   • Acc_User          — `acc_users` collection
//   • Acc_Organization  — `acc_organizations` collection
//   Both exported from `models/Accountant_model/Acc_OrgModels.js`.
//
// Exports:
//   - orgAuth                 → load user + org, attach to req
//   - legacyBootstrapAuth     → auth-bootstrap endpoints only (see above)
//   - ACCOUNTING_SESSION_UPGRADE_REQUIRED → the stable refusal code
//   - requireRole(...)        → 403 if user's role isn't allowed
//   - requirePermission(p)    → 403 if user lacks named permission
//   - requireCompanyAccess    → 403 if companyId not owned by the org
//   - signOrgToken            → mint JWTs from the new shape
//   - extractToken            → backwards-compat for older routes

const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET || "grav_clothing_secret_key";
const DEV_BYPASS = process.env.ACCOUNTANT_AUTH_BYPASS === "true";

const ACCOUNTANT_COOKIE = "accountant_token";
const isProduction = process.env.NODE_ENV === "production";

// The stable code the accountant frontend keys off to run the session upgrade
// (POST /api/accountant/auth/sync-legacy) or send the user back to login.
const ACCOUNTING_SESSION_UPGRADE_REQUIRED =
  "ACCOUNTING_SESSION_UPGRADE_REQUIRED";

const UPGRADE_ENDPOINT = "/api/accountant/auth/sync-legacy";

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
// Returns an array of { token, source } objects so the resolver can try each.
function getAllTokenSources(req) {
  const c = getAllCookies(req);
  const sources = [];

  // 1. Dedicated accountant cookie (most specific, highest priority)
  if (c.accountant_token) {
    sources.push({ token: c.accountant_token, source: "accountant_token" });
  }
  // 2. Main CMS cookie (legacy path — only good for the bootstrap endpoints)
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
/* Permissions                                                        */
/* ------------------------------------------------------------------ */

function noPermissions() {
  return {
    canView: false,
    canEdit: false,
    canPostDirectly: false,
    canApprove: false,
    canManageTeam: false,
    canManageSettings: false,
  };
}

function permissionsForRole(role) {
  const perms = { ...noPermissions(), canView: true };
  if (role === "owner") {
    perms.canEdit =
      perms.canPostDirectly =
      perms.canApprove =
      perms.canManageTeam =
      perms.canManageSettings =
        true;
  } else if (role === "approver") {
    perms.canEdit = perms.canPostDirectly = perms.canApprove = true;
  } else if (role === "editor") {
    perms.canEdit = true;
  }
  return perms;
}

/* ------------------------------------------------------------------ */
/* Session resolution — shared by orgAuth and legacyBootstrapAuth      */
/* ------------------------------------------------------------------ */
//
// Returns a tagged result rather than writing to the response, so the two entry
// points below can answer a legacy token differently without either of them
// having to guess at the request URL.
//
//   { kind: "dev" }
//   { kind: "org",    user, organization }
//   { kind: "legacy", decoded }
//   { kind: "error",  status, body }
//
// The only response side-effect it performs is clearing a stale
// `accountant_token` cookie, which is correct for both callers.

// Which accounting credential to believe when more than one is present. The
// Bearer header is what lib/api.js sets deliberately from the token the server
// last issued; the cookies are ambient.
const ORG_SOURCE_PREFERENCE = [
  "bearer",
  "accountant_token",
  "auth_token",
  "token",
];

function orgSourceRank(source) {
  const i = ORG_SOURCE_PREFERENCE.indexOf(source);
  return i === -1 ? ORG_SOURCE_PREFERENCE.length : i;
}

/** Identity a decoded org token claims — used to skip duplicate lookups. */
function orgIdentityKey(decoded) {
  return `${decoded.id}|${decoded.organizationId}|${decoded.tokenVersion || 0}`;
}

/**
 * Confirm one organisation-aware candidate against the database.
 *
 * `fatal: true` means stop the whole chain rather than try the next candidate:
 * a deactivated organisation is a deliberate administrative act, not a stale
 * credential, and falling through to a legacy bootstrap there would put the
 * frontend in a /me → sync-legacy → /me loop it can never exit.
 */
async function confirmOrgCandidate(decoded) {
  const { Acc_User, Acc_Organization } = getModels();
  if (!Acc_User || !Acc_Organization) {
    console.error(
      "[orgAuth] Acc_User or Acc_Organization model not registered. " +
        "Check that models/Accountant_model/Acc_OrgModels.js is loaded.",
    );
    return {
      ok: false,
      fatal: true,
      error: {
        kind: "error",
        status: 500,
        body: { success: false, message: "Auth model registration error" },
      },
    };
  }

  const user = await Acc_User.findById(decoded.id).lean();
  const userOk =
    user &&
    user.isActive &&
    (decoded.tokenVersion || 0) === (user.tokenVersion || 0);
  const orgMatches =
    userOk && String(user.organizationId) === String(decoded.organizationId);

  if (!userOk || !orgMatches) {
    return {
      ok: false,
      error: {
        kind: "error",
        status: 401,
        body: {
          success: false,
          message: !user
            ? "Your session points to an account that no longer exists. Please log in again."
            : "User account inactive or removed",
          code: "STALE_TOKEN",
        },
      },
    };
  }

  const org = await Acc_Organization.findById(user.organizationId).lean();
  if (!org || !org.isActive) {
    return {
      ok: false,
      fatal: true,
      error: {
        kind: "error",
        status: 403,
        body: {
          success: false,
          message: "Organization inactive",
          code: "ORGANIZATION_INACTIVE",
        },
      },
    };
  }

  return { ok: true, user, organization: org };
}

async function resolveSession(req, res) {
  // DEV BYPASS — useful when seeding initial data via curl/Postman
  if (DEV_BYPASS) return { kind: "dev" };

  const tokenSources = getAllTokenSources(req);

  if (tokenSources.length === 0) {
    return {
      kind: "error",
      status: 401,
      body: {
        success: false,
        message: "Authentication required",
        code: "NO_TOKEN",
      },
    };
  }

  // ── Pass 1: verify EVERY candidate ──────────────────────────────────────
  // Nothing is chosen here. A source that fails verification is dropped, and if
  // it was our own cookie it is cleared so the browser stops replaying it —
  // that clearing must not depend on where the request eventually gets its
  // session from.
  let accountantCookieCleared = false;
  const clearOurCookieOnce = () => {
    if (accountantCookieCleared) return;
    clearAccountantCookie(res);
    accountantCookieCleared = true;
  };

  const orgCandidates = [];
  const legacyCandidates = [];

  for (const { token, source } of tokenSources) {
    const decoded = tryVerify(token);
    if (!decoded) {
      if (source === "accountant_token") clearOurCookieOnce();
      continue;
    }
    if (decoded.organizationId) orgCandidates.push({ decoded, source });
    else legacyCandidates.push({ decoded, source });
  }

  if (orgCandidates.length === 0 && legacyCandidates.length === 0) {
    // Every source was expired or malformed — truly no valid session.
    return {
      kind: "error",
      status: 401,
      body: {
        success: false,
        message: "Session expired — please log in again.",
        code: "INVALID_TOKEN",
      },
    };
  }

  // ── Pass 2: the first DATABASE-CONFIRMED accounting credential wins ──────
  orgCandidates.sort((a, b) => orgSourceRank(a.source) - orgSourceRank(b.source));

  let firstOrgFailure = null;
  const tried = new Set();
  let winner = null;

  for (const candidate of orgCandidates) {
    const key = orgIdentityKey(candidate.decoded);
    if (tried.has(key)) continue;
    tried.add(key);

    let outcome;
    try {
      outcome = await confirmOrgCandidate(candidate.decoded);
    } catch (e) {
      console.error("[orgAuth] failed to load user/org:", e);
      return {
        kind: "error",
        status: 500,
        body: { success: false, message: "Authentication system error" },
      };
    }

    if (outcome.ok) {
      winner = { candidate, outcome };
      break;
    }

    // This credential is no good. If it was our cookie, stop sending it.
    if (candidate.source === "accountant_token") clearOurCookieOnce();
    if (!firstOrgFailure) firstOrgFailure = outcome.error;
    if (outcome.fatal) return outcome.error;
  }

  if (winner) {
    // A cookie naming a DIFFERENT identity than the credential we accepted is a
    // leftover — from another account on this browser, or from a session the
    // Bearer has since replaced. Clear it rather than leave it to win a later
    // request in which the Bearer happens to be absent.
    const conflicting = orgCandidates.some(
      (c) =>
        c.source === "accountant_token" &&
        orgIdentityKey(c.decoded) !== orgIdentityKey(winner.candidate.decoded),
    );
    if (conflicting) clearOurCookieOnce();

    return {
      kind: "org",
      user: winner.outcome.user,
      organization: winner.outcome.organization,
    };
  }

  // ── Nothing organisation-aware survived ─────────────────────────────────
  // A legacy CMS token is the last resort, and buys only the bootstrap flow.
  if (legacyCandidates.length > 0) {
    return { kind: "legacy", decoded: legacyCandidates[0].decoded };
  }

  return firstOrgFailure;
}

/* ------------------------------------------------------------------ */
/* Session attachment                                                  */
/* ------------------------------------------------------------------ */

function attachDevSession(req) {
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
}

function attachOrgSession(req, { user, organization }) {
  req.user = {
    id: String(user._id),
    organizationId: String(user.organizationId),
    role: user.role,
    email: user.email,
    name: user.name,
    isOwner: user.role === "owner",
    permissions: permissionsForRole(user.role),
  };
  req.organization = organization;
}

/**
 * Populate req.user from a legacy CMS token, for the bootstrap endpoints ONLY.
 *
 * This session can do exactly two things: say who it is on
 * `/accountant/auth/me`, and attempt the upgrade at
 * `/accountant/auth/sync-legacy`. Every permission is false and there is no
 * organisation, so nothing downstream can mistake it for accounting access.
 *
 * `req.legacyBootstrap.decoded` carries the raw CMS claims, because the upgrade
 * needs two of them that never belong on `req.user`: `iat`, which the
 * logout-all revocation check compares against `sessionsRevokedAt`, and the
 * unnormalised `email`. Handing sync-legacy this object rather than letting it
 * re-extract a token itself is what stops it treating an organisation-aware
 * accountant_token as a department identity.
 */
function attachLegacyBootstrapSession(req, decoded) {
  req.user = {
    id: decoded.id || decoded._id || decoded.userId,
    // An absent role is an absent role — never promoted to "owner".
    role: decoded.role || "legacy",
    email: decoded.email,
    name: decoded.name,
    isLegacy: true,
    isBootstrapOnly: true,
    permissions: noPermissions(),
  };
  req.organization = null;
  req.legacyBootstrap = { decoded };
}

function upgradeRequiredResponse(res) {
  return res.status(401).json({
    success: false,
    code: ACCOUNTING_SESSION_UPGRADE_REQUIRED,
    requiresUpgrade: true,
    upgradeEndpoint: UPGRADE_ENDPOINT,
    message:
      "Your accounting session needs to be upgraded before you can use this. " +
      "Sync your accounting session, or sign in to the accounting module again.",
  });
}

/* ------------------------------------------------------------------ */
/* orgAuth — the generic gate for every accounting route               */
/* ------------------------------------------------------------------ */

async function orgAuth(req, res, next) {
  const result = await resolveSession(req, res);

  if (result.kind === "error") {
    return res.status(result.status).json(result.body);
  }

  if (result.kind === "legacy") {
    // A legacy CMS token authorises NOTHING here — not reads, not writes, not
    // posting, approvals, settings or company access. Only the bootstrap
    // endpoints accept it, and only to upgrade the session.
    console.warn(
      "[accountant-auth] legacy session refused — " +
        `user=${result.decoded.email || result.decoded.id || "unknown"} ` +
        `role=${result.decoded.role || "(none)"} ` +
        `dept=${result.decoded.deptSlug || result.decoded.userType || "(none)"} ` +
        `path=${req.method} ${req.originalUrl}`,
    );
    return upgradeRequiredResponse(res);
  }

  if (result.kind === "dev") {
    attachDevSession(req);
    return next();
  }

  attachOrgSession(req, result);
  next();
}

/* ------------------------------------------------------------------ */
/* legacyBootstrapAuth — auth-bootstrap endpoints ONLY                 */
/* ------------------------------------------------------------------ */
//
// Mounted on `/accountant/auth/me` and `/accountant/auth/sync-legacy`, and
// nowhere else. It is the one door a legacy CMS session may walk through, and
// what it hands that session is a zero-permission identity — enough for the
// frontend to detect `isLegacy` and run the upgrade, and nothing more.
//
// A normal organisation token passes through exactly as it does in `orgAuth`,
// including the credential-selection rules above: a caller holding a valid
// accounting Bearer gets an organisation session here too, never a legacy one,
// so sync-legacy can tell "needs upgrading" from "already upgraded".

async function legacyBootstrapAuth(req, res, next) {
  const result = await resolveSession(req, res);

  if (result.kind === "error") {
    return res.status(result.status).json(result.body);
  }

  if (result.kind === "legacy") {
    attachLegacyBootstrapSession(req, result.decoded);
    return next();
  }

  if (result.kind === "dev") {
    attachDevSession(req);
    return next();
  }

  attachOrgSession(req, result);
  next();
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

/* ------------------------------------------------------------------ */
/* Canonical company scope (Lane A, Chunk 3A)                          */
/* ------------------------------------------------------------------ */
//
// ONE place decides which company a request is allowed to touch.
//
// Before this, 139 accounting endpoints read `companyId` straight out of the
// params, the query or the body and passed it to a Mongo filter. The value was
// never checked against the caller's organisation, so an authenticated user of
// one organisation could read, post to and delete another organisation's books
// by changing a single query parameter. Every endpoint also disagreed slightly
// about what a missing or malformed id meant — some 400'd, some 500'd on a cast
// error, some quietly returned everything.
//
// The rules, in the order they are applied:
//
//   1. Collect the id from params, query AND body — all three, not the first
//      one found. A request that names two different companies is a request
//      nobody can answer correctly, so it is refused rather than resolved by
//      precedence. Precedence is exactly how a guard gets bypassed: check the
//      param, act on the body.
//   2. Missing        → 400 COMPANY_SCOPE_REQUIRED
//   3. Malformed      → 400 COMPANY_SCOPE_INVALID
//   4. Conflicting    → 400 COMPANY_SCOPE_CONFLICT
//   5. Not owned by `req.organization.tallyCompanyIds` → 403 COMPANY_FORBIDDEN
//   6. Otherwise      → `req.companyId` is the validated string.
//
// A company the organisation does not own and a company that does not exist
// are answered identically, and neither response names the company or says
// which of the two it was. Distinguishing them turns the endpoint into a
// directory of which company ids are real.

const COMPANY_SCOPE_CODES = Object.freeze({
  REQUIRED: "COMPANY_SCOPE_REQUIRED",
  INVALID: "COMPANY_SCOPE_INVALID",
  CONFLICT: "COMPANY_SCOPE_CONFLICT",
  FORBIDDEN: "COMPANY_FORBIDDEN",
  NO_ORGANIZATION: "NO_ORGANIZATION_CONTEXT",
});

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

/** Every companyId the request carries, with the source that supplied it. */
function collectCompanyIds(req) {
  const found = [];
  const take = (source, value) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      // `?companyId=a&companyId=b` arrives as an array. Two values is a
      // conflict even when they came through one source.
      for (const v of value) take(source, v);
      return;
    }
    const s = String(value).trim();
    if (s === "") return;
    found.push({ source, value: s });
  };
  take("params", req.params?.companyId);
  take("query", req.query?.companyId);
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
    take("body", req.body.companyId);
  }
  return found;
}

/**
 * Resolve the request's company scope without touching the response.
 *
 * @returns {{ok: true, companyId: string, sources: string[]}}
 *        | {ok: false, status: number, code: string, message: string}}
 */
function resolveCompanyScope(req, { required = true } = {}) {
  const found = collectCompanyIds(req);

  if (found.length === 0) {
    if (!required) return { ok: true, companyId: null, sources: [] };
    return {
      ok: false,
      status: 400,
      code: COMPANY_SCOPE_CODES.REQUIRED,
      message: "companyId is required for this request.",
    };
  }

  const distinct = [...new Set(found.map((f) => f.value))];
  if (distinct.length > 1) {
    return {
      ok: false,
      status: 400,
      code: COMPANY_SCOPE_CODES.CONFLICT,
      // The SOURCES are named, never the values — the point of refusing is
      // that we will not act on either of them.
      message:
        "This request names more than one company (" +
        [...new Set(found.map((f) => f.source))].join(", ") +
        "). Send exactly one companyId.",
    };
  }

  const companyId = distinct[0];
  if (!OBJECT_ID_RE.test(companyId)) {
    return {
      ok: false,
      status: 400,
      code: COMPANY_SCOPE_CODES.INVALID,
      message: "companyId is not a valid id.",
    };
  }

  // Dev sessions have no organisation to check against. They are already a
  // whole-system bypass; this does not widen them.
  if (req.user?.isDev) {
    return { ok: true, companyId, sources: found.map((f) => f.source) };
  }

  if (!req.organization) {
    return {
      ok: false,
      status: 403,
      code: COMPANY_SCOPE_CODES.NO_ORGANIZATION,
      message: "No organization context.",
    };
  }

  const owned = (req.organization.tallyCompanyIds || []).map(String);
  if (!owned.includes(companyId)) {
    // Identical answer for "not yours" and "does not exist". Telling them apart
    // would make this endpoint a way to enumerate real company ids.
    return {
      ok: false,
      status: 403,
      code: COMPANY_SCOPE_CODES.FORBIDDEN,
      message: "This company is not available to your organization.",
    };
  }

  return { ok: true, companyId, sources: found.map((f) => f.source) };
}

function sendScopeRefusal(res, result) {
  return res.status(result.status).json({
    success: false,
    code: result.code,
    message: result.message,
  });
}

/**
 * Demand a valid, owned company. Mount AFTER `orgAuth` (or the
 * `accountantAuth` façade, which resolves through it), so `req.organization` is
 * the database-confirmed one rather than anything the caller supplied.
 */
function requireCompanyScope(req, res, next) {
  const result = resolveCompanyScope(req, { required: true });
  if (!result.ok) return sendScopeRefusal(res, result);
  req.companyId = result.companyId;
  next();
}

/**
 * For endpoints where the company is genuinely optional — a dashboard that
 * aggregates across every company the organisation owns when none is named.
 * Absent is allowed; anything PRESENT is validated and ownership-checked
 * exactly as above, so "optional" never means "unchecked".
 */
function scopeCompanyIfPresent(req, res, next) {
  const result = resolveCompanyScope(req, { required: false });
  if (!result.ok) return sendScopeRefusal(res, result);
  if (result.companyId) req.companyId = result.companyId;
  next();
}

function requireCompanyAccess(req, res, next) {
  // No legacy exemption. A session without an organisation has no company
  // scope to check against, so it cannot be granted one.
  if (req.user?.isDev) return next();

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
  requireCompanyScope,
  scopeCompanyIfPresent,
  resolveCompanyScope,
  COMPANY_SCOPE_CODES,
  legacyBootstrapAuth,
  ACCOUNTING_SESSION_UPGRADE_REQUIRED,
  requireRole,
  requirePermission,
  requireCompanyAccess,
  signOrgToken,
  extractToken,
};
