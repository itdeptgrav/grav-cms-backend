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

const jwt = require("jsonwebtoken");
const { SECRET, LEGACY_SECRETS, readToken } = require("../config/jwt");

/**
 * Populate `req.user` from the CMS token, or answer 401.
 *
 * LEGACY_SECRETS is tried after the current one so a token minted before the
 * last secret rotation still works until it expires — signing everybody out at
 * the moment of a deploy is a worse failure than a slightly longer key window.
 */
function authenticateCmsSession(req, res, next) {
  const token = readToken(req);
  if (!token) {
    return res.status(401).json({ success: false, message: "Not authenticated" });
  }

  const verify = () => {
    try {
      return jwt.verify(token, SECRET);
    } catch (err) {
      for (const legacy of LEGACY_SECRETS) {
        try {
          return jwt.verify(token, legacy);
        } catch {
          /* try the next */
        }
      }
      throw err;
    }
  };

  try {
    const decoded = verify();
    req.user = {
      id: decoded.id,
      email: String(decoded.email || "").toLowerCase(),
      name: decoded.name || "",
      isAdmin: Boolean(decoded.isAdmin),
      deptSlug: decoded.deptSlug || "",
    };
    next();
  } catch {
    res.status(401).json({ success: false, message: "Invalid or expired session" });
  }
}

module.exports = { authenticateCmsSession };
