// Middlewear/MarketingAuthMiddlewear.js
//
// The guard every authenticated /api/cms/marketing route passes through.
//
// ── IT NO LONGER TRUSTS THE TOKEN'S ROLE ───────────────────────────────────
// It used to admit any token whose `role` claim said "marketing", "admin" or
// "ceo". That claim is written once at sign-in and lives for seven days, so a
// revoked Marketing grant or role changed nothing until the token expired, and
// the Viewer / Editor / Approver / Owner role chosen in Access Control was
// never read at all.
//
// Now the token only proves WHO is asking. What they may do is decided by
// `services/marketing/marketingAccess.js` from the database, on every request:
// the account or employee record, the Marketing grant, the Marketing role and
// the configured Marketing company. A grant or role revoked a moment ago is refused on
// the very next request, whatever the token says.
//
// ── EVERY ROUTE IS CLASSIFIED ──────────────────────────────────────────────
// `actFor(method, path)` names each request read, write, decide or administer,
// and the caller must hold that act. Routes keep their own checks as well —
// this is the floor, not the only wall.
//
// ── ONCE PER REQUEST ───────────────────────────────────────────────────────
// Every Marketing router mounts this guard and they share one prefix, so a
// single request can pass through it many times. The database is read once and
// the answer reused for the rest of that request.
//
// `ALLOWED_ROLES` and `withRoles` remain exported for compatibility. Neither
// widens anything any more: access is the database's answer, not a list.
"use strict";

const mongoose = require("mongoose");

const { COOKIE_NAME } = require("../config/jwt");
const access = require("../services/marketing/marketingAccess");

const ALLOWED_ROLES = Object.freeze(["marketing", "admin", "ceo"]);

function tokenOf(req) {
  let token = req.cookies?.[COOKIE_NAME] || req.cookies?.auth_token;
  const header = String(req.headers?.authorization || "");
  if (!token && /^Bearer\s+/i.test(header)) token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token && req.headers?.cookie) {
    const match = String(req.headers.cookie).match(new RegExp(`(?:^|;\\s*)(?:${COOKIE_NAME}|auth_token)=([^;]+)`));
    if (match) token = decodeURIComponent(match[1]);
  }
  return token || null;
}

/** The caller's Marketing access, resolved once per request. */
function accessFor(req) {
  if (!req.__marketingAccess) {
    req.__marketingAccess = (async () => {
      const token = tokenOf(req);
      if (!token) return access.resolve(null);
      let decoded;
      try {
        decoded = require("../routes/auth/deptAuth").verifyToken(token);
      } catch (err) {
        return {
          ok: false,
          status: 401,
          code: err?.name === "TokenExpiredError" ? "MARKETING_SESSION_EXPIRED" : "MARKETING_SESSION_INVALID",
          message: err?.name === "TokenExpiredError"
            ? "Your session has expired. Please sign in again."
            : "Your session is no longer valid. Please sign in again.",
        };
      }
      const resolved = await access.resolve(decoded);
      return resolved.ok ? { ...resolved, decoded } : resolved;
    })();
  }
  return req.__marketingAccess;
}

/* The identity downstream code reads, rebuilt from what the database said —
   so every existing `isAdmin || role === "ceo"` check in a route or service
   reads current facts, not a week-old claim. */
function userFrom(resolved) {
  const kind = resolved.kind;
  return {
    id: resolved.userId,
    /* A Viewer is not an author. Every existing `role === "marketing"` check
       in a route or service — "may this person create, edit, submit,
       withdraw?" — must answer no for them, and the per-item `viewerActions`
       they compute must say so too, or a screen would offer a Viewer buttons
       the guard then refuses. */
    role: kind === "ceo" ? "ceo"
      : kind === "platform_admin" ? "admin"
        : resolved.role === "viewer" ? "marketing_viewer" : "marketing",
    employeeId: resolved.employeeId || "",
    userType: resolved.decoded?.userType || "",
    name: resolved.name || "",
    email: resolved.email || "",
    isAdmin: kind === "platform_admin",
    marketingRole: resolved.role || null,
    marketingAccess: kind,
  };
}

async function MarketingAuthMiddlewear(req, res, next) {
  try {
    const resolved = await accessFor(req);
    if (!resolved.ok) {
      return res.status(resolved.status).json({ success: false, code: resolved.code, message: resolved.message });
    }

    const act = access.actFor(req.method, req.path);
    if (!access.can(resolved, act)) {
      return res.status(403).json({
        success: false,
        code: "MARKETING_ACTION_FORBIDDEN",
        act,
        role: resolved.role,
        message: access.ACT_REFUSALS[act],
      });
    }

    req.user = userFrom(resolved);
    req.marketingAccess = access.view(resolved);
    /* All authenticated Marketing callers use one verified configured company.
       Never fall back to an address membership or an arbitrary first company. */
    req.__marketingCompanyId = new mongoose.Types.ObjectId(String(resolved.companyId));
    return next();
  } catch (error) {
    console.error("[MarketingAuthMiddlewear]", error?.message);
    return res.status(503).json({ success: false, code: "MARKETING_UNAVAILABLE", message: access.REFUSALS.UNAVAILABLE.message });
  }
}

MarketingAuthMiddlewear.ALLOWED_ROLES = ALLOWED_ROLES;
MarketingAuthMiddlewear.withRoles = () => MarketingAuthMiddlewear;
MarketingAuthMiddlewear.accessFor = accessFor;
MarketingAuthMiddlewear.tokenOf = tokenOf;

module.exports = MarketingAuthMiddlewear;
