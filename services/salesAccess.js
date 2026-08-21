// services/salesAccess.js
//
// "Is this caller a Sales MANAGER" — one answer, reused everywhere the Draft
// Lead chunk needs it (draft visibility, activation authorization). There is
// no existing server-side equivalent: departmentWriteGuard resolves this for
// WRITES via requireDepartmentRole, but explicitly skips every GET/HEAD/OPTIONS
// ("reads are never touched" — see its own header), so a plain list/detail
// read has never needed to know the caller's department role until now.
//
// Three ways a caller counts as a manager, cheapest first:
//   1. Org-level role (admin/ceo, from SalesAuthMiddlewear's req.user.role) —
//      always a manager, no DB lookup.
//   2. req.user.departmentRole, if some earlier middleware already resolved it
//      (departmentWriteGuard's requireDepartmentRole sets this on a WRITE
//      request) — reuse it rather than looking it up twice in one request.
//   3. A live lookup: services/departmentRoles.getRole("sales", email), which
//      is the SAME store departmentWriteGuard itself reads from — one
//      vocabulary, not a second opinion. Requires req.user.email, which
//      SalesAuthMiddlewear now attaches (see that file's own comment).
"use strict";

const { getRole } = require("./departmentRoles");
const { roleAtLeast } = require("../models/Access/DepartmentRole");

const ORG_LEVEL_MANAGER_ROLES = new Set(["admin", "ceo"]);

/** @param {{role?:string, isAdmin?:boolean, departmentRole?:string, email?:string}} user */
async function isSalesManager(user) {
  if (!user) return false;
  // Checked before `role`, not folded into ORG_LEVEL_MANAGER_ROLES: an
  // org-level admin browsing INTO Sales carries `role` overwritten to Sales'
  // own legacy literal (e.g. "sales"), not "admin"/"ceo" — see
  // deptAuth.js's buildTokenPayload (`adoptDeptRole`). `role` alone cannot
  // answer "is this an admin" once inside a department; `isAdmin` can,
  // because it is signed into the token unconditionally.
  if (user.isAdmin) return true;
  if (ORG_LEVEL_MANAGER_ROLES.has(user.role)) return true;
  if (user.departmentRole) return roleAtLeast(user.departmentRole, "approver");
  if (!user.email) return false;
  const role = await getRole("sales", user.email);
  return Boolean(role) && roleAtLeast(role, "approver");
}

/**
 * Sales/CEO/admin bypass the "anyone can fill anything, staged for approval"
 * gate (costing, Style & Sample materials) — their own writes apply
 * immediately, and only they can decide on someone else's staged submission.
 * Synchronous, unlike isSalesManager: no department-role lookup, just the
 * JWT's own role/isAdmin. Shared so the costing and materials approval paths
 * (and the aggregated approvals queue) agree on exactly who that is
 * (19 Aug 2026).
 * @param {{role?:string, isAdmin?:boolean}} user
 */
function bypassesApproval(user) {
  return ["sales", "ceo"].includes(user?.role) || Boolean(user?.isAdmin);
}

module.exports = { isSalesManager, bypassesApproval };
