// routes/CMS_Routes/Production/productionDepartmentAccess.js
//
// The Production department guard shared by Production's own command routers
// (execution bases, machine assignment). The same grant/migration rule
// Packaging's doors use (`roleIn`): once any grant exists in the department it
// is required at the stated level; before that, only a session that IS the
// department passes. A database-verified admin session passes.
"use strict";

const SLUG = "production-supervisor";
const LEGACY_ROLES = Object.freeze(["production_supervisor", "production-supervisor"]);

function productionDepartment(required, label = "Production") {
  const departmentRoles = require("../../../services/departmentRoles");
  const str = (v) => String(v ?? "").trim().toLowerCase();
  const sessionIs = (user) => str(user?.deptSlug) === SLUG || LEGACY_ROLES.includes(str(user?.role));
  return async (req, res, next) => {
    try {
      if (!req.user?.id) return res.status(401).json({ success: false, message: "Authentication required" });
      if (req.user.isAdmin) return next();
      const grants = await departmentRoles.listRoles(SLUG);
      let role;
      if (!grants.length) role = sessionIs(req.user) ? "migration" : null;
      else {
        const effective = await departmentRoles.getEffectiveRole(SLUG, req).catch(() => null);
        role = !effective ? null : departmentRoles.roleAtLeast(effective, required) ? effective : "insufficient";
      }
      if (!role) {
        return res.status(403).json({ success: false, code: "NO_DEPARTMENT_ROLE",
          message: `${label} is for the Production department.` });
      }
      if (role === "insufficient") {
        return res.status(403).json({ success: false, code: "INSUFFICIENT_DEPARTMENT_ROLE", requires: required,
          message: `This action needs ${required} access in Production.` });
      }
      req.departmentRole = role;
      return next();
    } catch (err) {
      console.error("[production-department] guard failed:", err.message);
      return res.status(500).json({ success: false, message: "Could not check your access." });
    }
  };
}

module.exports = { productionDepartment, SLUG, LEGACY_ROLES };
