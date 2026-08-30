"use strict";
/**
 * services/access/fulfilmentAccess.js
 *
 * WHO MAY DECIDE HOW A REQUEST GETS FULFILLED.
 *
 * Classification is not an approval. Nobody agrees to anything by saying "the
 * store has this" or "this one has to be bought" — they are answering a
 * question of fact about the company's own operations. So the gate here is
 * narrower than an approver list and wider than a single role: it is the
 * people who run fulfilment, plus finance, who sees every request anyway.
 *
 *   • the `store` department grant  — Store & Purchase, whose job this is
 *   • a platform administrator      — DeptUser.isAdmin, re-read from the DB
 *   • the `ceo` grant               — board level, which sees everything
 *   • a finance approver            — decided by the CALLER from Acc_User,
 *                                     because that is where the books' roles
 *                                     live and this file has no business
 *                                     reading them
 *
 * Modelled on services/access/hrAccess.js, and for the same reason it exists:
 * an equality test against one role only sees the department a person has
 * CURRENTLY selected, so somebody who holds Store as an additional grant would
 * be refused the moment they were looking at another app.
 *
 * It does NOT grant this to every authenticated employee, and it never reads
 * the route the call arrived on.
 */

const Employee = require("../../models/Employee");
const DeptUser = require("../../models/Access/DeptUser");
const { resolveEmployeeDepartments } = require("../../routes/auth/deptAuth");

/** The grant that IS this job. "Store & Purchase" in the launcher. */
const FULFILMENT_DEPT_SLUGS = new Set(["store"]);

/** Board level — sees everything, decides nothing it does not want to. */
const BOARD_DEPT_SLUGS = new Set(["ceo"]);

/**
 * @param {object} employee an Employee document or lean object
 * @returns {Promise<{ allowed: boolean, via: 'admin'|'ceo'|'store'|null }>}
 */
async function resolveFulfilmentAccess(employee) {
  if (!employee) return { allowed: false, via: null };

  /* Platform administrator — authoritative, and re-read every time rather than
     trusted from a token that was minted before the grant was removed. */
  const adminOr = [];
  if (employee.email) adminOr.push({ email: String(employee.email).toLowerCase().trim() });
  if (employee._id) adminOr.push({ employeeRef: employee._id });
  if (employee.biometricId) adminOr.push({ employeeId: employee.biometricId });
  if (adminOr.length) {
    const admin = await DeptUser.findOne({ isAdmin: true, isActive: true, $or: adminOr })
      .select("_id")
      .lean()
      .catch(() => null);
    if (admin) return { allowed: true, via: "admin" };
  }

  /* The same grants login resolves, so an additional Store grant counts even
     when the person is currently in another app. */
  const full = employee.accessDepartmentId || employee.additionalDepartmentIds || employee.department
    ? employee
    : await Employee.findById(employee._id).lean().catch(() => null);
  if (!full) return { allowed: false, via: null };

  const depts = await resolveEmployeeDepartments(full).catch(() => []);
  const slugs = new Set((depts || []).map((d) => d.slug));
  if ([...BOARD_DEPT_SLUGS].some((s) => slugs.has(s))) return { allowed: true, via: "ceo" };
  if ([...FULFILMENT_DEPT_SLUGS].some((s) => slugs.has(s))) return { allowed: true, via: "store" };

  return { allowed: false, via: null };
}

module.exports = { resolveFulfilmentAccess, FULFILMENT_DEPT_SLUGS, BOARD_DEPT_SLUGS };
