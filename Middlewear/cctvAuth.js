// Middlewear/cctvAuth.js
//
// Gate for the CCTV routes. Reuses the CMS session (auth_token) and the existing
// per-department `cctvEnabled` flag — it does NOT introduce a new auth system.
//
// Allowed = a valid CMS session AND (platform admin, OR the user holds a
// department with cctvEnabled). This is the server-side half of the same rule the
// onboarding tile and the /cctv page enforce on the client.

const deptAuth = require("../routes/auth/deptAuth");
const AccessDepartment = require("../models/Access/AccessDepartment");
const Employee = require("../models/Employee");

const COOKIE_NAME = "auth_token";

async function anyHeldDeptHasCctv(decoded) {
  // Employee subject: check every department the employee holds.
  if (decoded.subject === "employee" && decoded.id) {
    try {
      const emp = await Employee.findById(decoded.id)
        .select("accessDepartmentId additionalDepartmentIds department email isActive status");
      if (emp && emp.isActive !== false && emp.status !== "inactive") {
        const depts = await deptAuth.resolveEmployeeDepartments(emp);
        if (depts.some((d) => d.cctvEnabled === true)) return true;
      }
    } catch { /* fall through to slug check */ }
  }
  // Any other subject (department account, accountant, legacy) holds one
  // department, carried as deptSlug on the token.
  if (decoded.deptSlug) {
    const dept = await AccessDepartment.findOne({ slug: decoded.deptSlug, isActive: true })
      .select("cctvEnabled");
    if (dept?.cctvEnabled === true) return true;
  }
  return false;
}

module.exports = async function cctvAuth(req, res, next) {
  try {
    const token =
      req.cookies?.[COOKIE_NAME] ||
      (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ success: false, message: "Not authenticated" });

    let decoded;
    try { decoded = deptAuth.verifyToken(token); }
    catch { return res.status(401).json({ success: false, message: "Invalid or expired session" }); }

    if (decoded.isAdmin === true) { req.cctvUser = decoded; return next(); }

    if (await anyHeldDeptHasCctv(decoded)) { req.cctvUser = decoded; return next(); }

    return res.status(403).json({
      success: false,
      code: "CCTV_NOT_ENABLED",
      message: "CCTV access is not enabled for your department.",
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: "CCTV auth error" });
  }
};
