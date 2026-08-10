"use strict";
/**
 * services/access/hrAccess.js — shared, server-side HR-authorisation resolver.
 *
 * Replaces the old `user.role === "hr_manager"` equality, which only saw the
 * department a person had CURRENTLY selected — so a multi-department employee
 * who also holds HR was refused the moment they were viewing Sales or the app
 * switcher. This resolver decides from the person's ACTUAL access records,
 * independent of the selected app and never from the page/route.
 *
 * An account may use the HR AI tools when it is any of:
 *   • a platform administrator            — DeptUser.isAdmin (re-read from DB);
 *   • board-level / Chief Executive       — holds the `ceo` department grant;
 *   • assigned to HR                        — holds the `hr` department grant,
 *     including as an ADDITIONAL department while primarily in another app.
 *
 * It does NOT grant access to every authenticated employee, and it does not
 * look at `routeContext` at all.
 */

const Employee = require("../../models/Employee");
const DeptUser = require("../../models/Access/DeptUser");
const { resolveEmployeeDepartments } = require("../../routes/auth/deptAuth");

// Department slugs that confer HR-tool access.
const HR_DEPT_SLUGS = new Set(["hr"]);
const BOARD_DEPT_SLUGS = new Set(["ceo"]); // Chief Executive / board-level

// Verified JWT roles that confer HR-tool access on their own. The CEO and HR
// Admin log in through their OWN department collections (CEODepartment /
// HRDepartment), so they have NO Employee record and the department-grant path
// below never sees them — but login has already verified who they are, so the
// role in the token is authoritative. Without this, the CEO/HR-Admin get
// "I don't have access" for every HR question.
const HR_ROLES = new Map([
  ["ceo", "ceo"],
  ["hr_manager", "hr"],
  ["hr", "hr"],
  ["admin", "admin"],
  ["super_admin", "admin"],
  ["superadmin", "admin"],
]);

/**
 * @param {object} user  the verified req.user ({ id, email, employeeId, role })
 * @returns {Promise<{ allowed: boolean, via: 'admin'|'ceo'|'hr'|null }>}
 */
async function resolveHrAccess(user) {
  if (!user) return { allowed: false, via: null };

  // 0) Verified role from the token — cheapest and authoritative for accounts
  //    that log in through a dedicated department collection (CEO, HR Admin).
  const role = user.role ? String(user.role).toLowerCase().trim() : "";
  if (HR_ROLES.has(role)) return { allowed: true, via: HR_ROLES.get(role) };

  // 1) Platform administrator — authoritative, re-read from the DB every time.
  const adminOr = [];
  if (user.email) adminOr.push({ email: String(user.email).toLowerCase().trim() });
  if (user.id) adminOr.push({ employeeRef: user.id });
  if (user.employeeId) adminOr.push({ employeeId: user.employeeId });
  if (adminOr.length) {
    const admin = await DeptUser.findOne({ isAdmin: true, isActive: true, $or: adminOr })
      .select("_id")
      .lean();
    if (admin) return { allowed: true, via: "admin" };
  }

  // 2) Department grants — the SAME grants login resolves, so an HR grant counts
  //    even when the person is currently in Sales or the app switcher.
  let employee = null;
  if (user.id) employee = await Employee.findById(user.id).lean().catch(() => null);
  if (!employee && user.employeeId) {
    employee = await Employee.findOne({ biometricId: user.employeeId }).lean().catch(() => null);
  }
  if (employee) {
    const depts = await resolveEmployeeDepartments(employee);
    const slugs = new Set((depts || []).map((d) => d.slug));
    if ([...BOARD_DEPT_SLUGS].some((s) => slugs.has(s))) return { allowed: true, via: "ceo" };
    if ([...HR_DEPT_SLUGS].some((s) => slugs.has(s))) return { allowed: true, via: "hr" };
  }

  return { allowed: false, via: null };
}

module.exports = { resolveHrAccess, HR_DEPT_SLUGS, BOARD_DEPT_SLUGS };
