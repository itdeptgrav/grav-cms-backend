/**
 * GRAV-CMS-BACKEND/services/taskReviewOwner.service.js
 *
 * Who approves work for an employee.
 *
 * **The HR primary manager, always.** One relationship, maintained in one
 * place, used for every approval decision.
 *
 * This previously preferred the assignee's DEPARTMENT LEAD and fell back to
 * their manager, which meant approval ownership depended on a Firestore
 * `department` string and a `role` flag that HR does not maintain. Two records
 * had to agree for routing to be right, and when they disagreed the work went
 * to somebody with no reporting relationship to the assignee at all — Pramod
 * Biswal's approvals went to Trinayan Doley, Production's lead, rather than to
 * Rakesh Biswal, his manager on file.
 *
 * The department lead is not gone from the product; it is no longer the
 * APPROVAL authority. Anything wanting a departmental workflow should ask for
 * one explicitly rather than inheriting it here.
 *
 * **Source of truth:** Mongo `Employee.primaryManager.managerId`, joined to
 * Firestore `cowork_employees` by `biometricId` only to resolve a display name
 * and confirm the manager has a Cowork account. The relationship itself is
 * never read from Firestore.
 *
 * **No silent fallback.** An employee with no manager on file returns null with
 * a reason. Choosing a stand-in is a policy decision and stays with the caller,
 * which already has an explicit configured default — it must never quietly
 * become the department lead again.
 */

const { db } = require("../config/firebaseAdmin");

/** The only approval authority. Named so a log or a screen can say so. */
const HR_PRIMARY_MANAGER = "HR_PRIMARY_MANAGER";

/**
 * The HR primary manager for one employee — the single resolver.
 *
 * Every approval, review, escalation and gate calls this. A module that works
 * out a manager for itself is how the product came to have four answers to one
 * question.
 *
 * `getEmployeeInfo` and `getPrimaryManager` are injected because they live in
 * the route file today; passing them keeps this testable and avoids a circular
 * require while that remains true.
 */
async function getPrimaryManagerForEmployee(employeeId, deps) {
  const { getPrimaryManager } = deps;
  const mgr = await getPrimaryManager(employeeId);
  if (!mgr || !mgr.approverId) {
    return {
      managerId: null,
      managerName: null,
      source: null,
      reason:
        "No primary manager is recorded for this employee in the HR system.",
    };
  }
  return {
    managerId: mgr.approverId,
    managerName: mgr.approverName,
    source: HR_PRIMARY_MANAGER,
    reason: "Approvals follow the employee's primary manager as maintained by HR.",
  };
}

/**
 * Who should review work assigned to this person.
 *
 * A thin reading of the resolver above, kept as its own name because callers
 * ask a question about a TASK rather than about an employee record.
 */
async function getTaskReviewOwner(employeeId, deps) {
  const { getEmployeeInfo } = deps;
  const person = await getEmployeeInfo(employeeId);
  if (!person) {
    return {
      reviewerId: null,
      reviewerType: null,
      reason: "No employee record found.",
    };
  }

  const mgr = await getPrimaryManagerForEmployee(employeeId, deps);
  return {
    reviewerId: mgr.managerId,
    reviewerName: mgr.managerName,
    reviewerType: mgr.managerId ? HR_PRIMARY_MANAGER : null,
    reason: mgr.reason,
  };
}

module.exports = {
  getPrimaryManagerForEmployee,
  getTaskReviewOwner,
  HR_PRIMARY_MANAGER,
};
