// services/cmsSession.js
//
// Read the CMS session on a router that sits outside any one department's
// middleware.
//
// Most routers are mounted behind the guard for the audience they serve —
// EmployeeAuthMiddlewear, SalesAuthMiddlewear, and so on. A few are not, because
// what they serve SPANS departments: the approval queue lists any department the
// caller has a role in, and the team screen manages the roles themselves. Those
// routers cannot borrow a department's guard without inheriting its idea of who
// belongs, so they read the token themselves.
//
// Extracted from routes/Access/changeRequests.js when the team router needed the
// same thing. Two copies of a session reader is two places for the accepted
// audience to drift apart, and the one that drifts is the one nobody is looking
// at.

"use strict";

const { verifyCmsToken, readToken } = require("../config/jwt");

/**
 * Populate `req.user` from the CMS token, or answer 401.
 *
 * SEC-0 (25 Sep 2026): the token is verified against the configured secret
 * only, and its `isAdmin` claim is NOT trusted. Every router behind this reader
 * uses `req.user.isAdmin` to make the caller an owner of a department team,
 * of the change-request queue or of the developer console — role-management
 * and administrative decisions. So a claimed administrator is re-read from
 * `dept_users` on every request: active, still an administrator, and holding a
 * token whose version is current. Anything less is an ordinary session
 * (`isAdmin: false`), not an error, because the same person may still hold
 * ordinary department roles here.
 *
 * A failed lookup is an outage, never an elevation: 503.
 */
async function authenticateCmsSession(req, res, next) {
  const token = readToken(req);
  if (!token) {
    return res.status(401).json({ success: false, message: "Not authenticated" });
  }

  let decoded;
  try {
    decoded = verifyCmsToken(token);
  } catch {
    return res.status(401).json({ success: false, message: "Invalid or expired session" });
  }

  let isAdmin = false;
  if (decoded.isAdmin) {
    try {
      isAdmin = await isActivePlatformAdmin(decoded);
    } catch (err) {
      console.error("[cmsSession] administrator re-read failed:", err?.message || err);
      return res.status(503).json({
        success: false,
        code: "ADMIN_CHECK_UNAVAILABLE",
        message: "Your access could not be checked just now. Try again in a moment.",
      });
    }
  }

  req.user = {
    id: decoded.id,
    email: String(decoded.email || "").toLowerCase(),
    name: decoded.name || "",
    isAdmin,
    deptSlug: decoded.deptSlug || "",
    // GAC-2: identifiers the canonical resolver needs to re-read this session
    // (which identity kind, which token version). They grant nothing.
    subject: decoded.subject || "",
    tv: decoded.tv || 0,
  };
  next();
}

/**
 * Is the account this token names an active platform administrator right now?
 * Same proof `requirePlatformAdmin` demands: the DeptUser row, active, admin,
 * and a token version that has not been revoked.
 */
async function isActivePlatformAdmin(decoded) {
  const mongoose = require("mongoose");
  if (!decoded?.id || !mongoose.Types.ObjectId.isValid(String(decoded.id))) return false;
  const DeptUser = require("../models/Access/DeptUser");
  const user = await DeptUser.findById(decoded.id).select("isAdmin isActive tokenVersion").lean();
  if (!user || !user.isActive || !user.isAdmin) return false;
  return (user.tokenVersion || 0) === (decoded.tv || 0);
}

module.exports = { authenticateCmsSession, isActivePlatformAdmin };
