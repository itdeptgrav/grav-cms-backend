// Middlewear/requirePlatformAdmin.js
//
// Gate for the department/access administration API.
//
// Deliberately does NOT use a role string. The literal "admin" appears in
// fifteen-plus allow-lists across this codebase — the sales middleware, seven
// separate copy-pasted CEO guards, the accountant middleware, the voucher
// routes — as a role that no model actually issues. Minting a user with
// role: "admin" would hand them every CEO dashboard and accountant write path
// in one stroke, as a side effect of being able to rename a department.
//
// So administration is a boolean on the user, checked against the DATABASE on
// every request. The token's `isAdmin` claim is treated as a hint, never as
// proof: a token stays valid for seven days, and revoking someone's admin
// rights has to take effect now, not next week.

"use strict";

const { COOKIE_NAME } = require("../config/jwt");
const { verifyToken } = require("../routes/auth/deptAuth");
const DeptUser = require("../models/Access/DeptUser");

module.exports = async function requirePlatformAdmin(req, res, next) {
  try {
    const token =
      req.cookies?.[COOKIE_NAME] ||
      (req.headers.authorization || "").replace(/^Bearer\s+/i, "");

    if (!token) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }

    let decoded;
    try {
      decoded = verifyToken(token);
    } catch {
      return res.status(401).json({ success: false, message: "Invalid or expired session" });
    }

    // Re-read from the database. This is the whole point of the middleware.
    const user = await DeptUser.findById(decoded.id).select(
      "isAdmin isActive tokenVersion name email departmentId",
    );

    if (!user || !user.isActive || !user.isAdmin) {
      // Same response for "not an admin" and "no such user" — an admin-only
      // endpoint should not confirm which accounts exist.
      return res.status(403).json({ success: false, message: "Administrator access required" });
    }

    if ((user.tokenVersion || 0) !== (decoded.tv || 0)) {
      return res.status(401).json({ success: false, message: "Session expired" });
    }

    req.admin = user;
    req.user = {
      id: String(user._id),
      name: user.name,
      email: user.email,
      isAdmin: true,
    };

    next();
  } catch (error) {
    console.error("[requirePlatformAdmin]", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};
