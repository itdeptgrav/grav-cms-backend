// routes/CMS_Routes/Maintenance/maintenanceAccess.js
//
// WHO MAY USE THE MAINTENANCE APP.
//
// The Finishing portals' answer (finishingAccess.js), for the `maintenance`
// department:
//
//   · a platform administrator — as the DATABASE says, never on a token claim
//     alone (departmentRoles.isDatabaseVerifiedAdmin);
//   · otherwise a live DepartmentRole grant in `maintenance`: viewer to read,
//     editor to issue a tag or record maintenance;
//   · before any grant exists, a session signed into the Maintenance
//     department itself — so the department is usable the day it appears, and
//     is not an open door to every other signed-in employee.
//
// It deliberately does NOT use departmentRoles.requireDepartmentRole on its
// own: that guard fails OPEN for a department with no grants (a migration
// allowance for the legacy departments), which for a brand-new department
// would admit everybody.
"use strict";

const departmentRoles = require("../../../services/departmentRoles");

const SLUG = "maintenance";
const NAME = "Maintenance";

const lower = (v) => String(v ?? "").trim().toLowerCase();
const sessionIsMaintenance = (user) => lower(user?.deptSlug) === SLUG || lower(user?.role) === SLUG;

/** "owner" for an administrator, a live role, "migration", "insufficient", or null. */
async function maintenanceRole(req, required) {
  if (await departmentRoles.isDatabaseVerifiedAdmin(req)) return "owner";
  const grants = await departmentRoles.listRoles(SLUG);
  if (grants.length === 0) {
    if (!sessionIsMaintenance(req.user)) return null;
    /* A pre-grant session reads and records — the department's daily work —
       but never CONFIGURES it: settings need an owner, so an owner must be
       granted first. "migration" therefore stands for editor, no higher. */
    return departmentRoles.roleAtLeast("editor", required) ? "migration" : "insufficient";
  }
  const role = await departmentRoles.getEffectiveRole(SLUG, req);
  if (!role) return null;
  return departmentRoles.roleAtLeast(role, required) ? role : "insufficient";
}

/** May this role write? A pre-grant department session may. */
function canWrite(role) {
  return role === "migration" || departmentRoles.roleAtLeast(role, "editor");
}

/** May this role change Maintenance settings? Owner (or administrator) only. */
function canConfigure(role) {
  return departmentRoles.roleAtLeast(role, "owner");
}

function requireMaintenance(required = "viewer") {
  return async (req, res, next) => {
    try {
      if (!req.user?.id) return res.status(401).json({ success: false, message: "Authentication required" });
      const role = await maintenanceRole(req, required);
      if (!role) {
        return res.status(403).json({ success: false, code: "NO_DEPARTMENT_ROLE",
          message: `This is the ${NAME} department's app.` });
      }
      if (role === "insufficient") {
        return res.status(403).json({ success: false, code: "INSUFFICIENT_DEPARTMENT_ROLE", requires: required,
          message: `This action needs ${required} access in ${NAME}.` });
      }
      req.maintenanceRole = role;
      return next();
    } catch (err) {
      console.error("[maintenance-access] guard failed:", err.message);
      return res.status(500).json({ success: false, message: "Could not check your access." });
    }
  };
}

/** What the screen may offer this person — reads `req.maintenanceRole`. */
function accessOf(req) {
  const role = req.maintenanceRole || null;
  return { role, canWrite: role ? canWrite(role) : false, canConfigure: role ? canConfigure(role) : false };
}

module.exports = { SLUG, requireMaintenance, accessOf, maintenanceRole, canWrite, canConfigure };
