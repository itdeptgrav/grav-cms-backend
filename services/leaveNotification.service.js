/**
 * services/leaveNotification.service.js
 *
 * DEPRECATED COMPATIBILITY SHIM.
 *
 * This file used to send web-only pushes via utils/sendWebPush.js, which is why
 * leave notifications never reached the mobile app. All four helpers now
 * delegate to utils/notifyEmployee.js, which fans out to BOTH the Expo native
 * token and the FCM web token in a single call.
 *
 * New code should require utils/notifyEmployee directly:
 *
 *   const { notifyLeaveApproved } = require("../utils/notifyEmployee");
 *
 * These wrappers exist only so that any caller still on the old names keeps
 * working — and, critically, stops double-notifying web users. Do NOT add
 * sendWebPush back here.
 *
 * Two historical bugs are fixed by the delegation:
 *   • notifySecondaryOnPrimaryApproval was declared (employee, application) but
 *     called with one argument, so `application` was always undefined. It now
 *     accepts the application as its first argument (and still tolerates the
 *     old two-argument order).
 *   • It also filtered managersNotified on `m.status === "pending"`, a field
 *     that does not exist on the schema, so it always matched zero managers.
 *     The secondary is now resolved by `m.type === "secondary"`.
 */

"use strict";

const {
  notifyLeaveApplied,
  notifyLeaveSecondaryPending,
  notifyLeaveApproved,
  notifyLeaveRejected,
  notifyLeaveWithdrawn,
  notifyLeaveEdited,
  notifyLeaveWithdrawRequested,
} = require("../utils/notifyEmployee");

/** Employee applied → primary manager. */
async function notifyManagerOnLeaveApply(employee, application) {
  notifyLeaveApplied(application, employee);
}

/**
 * Primary approved and a secondary exists → secondary manager.
 * Accepts (application, primaryManagerName) or the legacy (employee, application).
 */
async function notifySecondaryOnPrimaryApproval(arg1, arg2) {
  const isApplication = arg1 && (arg1.managersNotified || arg1.leaveType);
  const application = isApplication ? arg1 : arg2;
  const primaryName = isApplication && typeof arg2 === "string" ? arg2 : "";
  notifyLeaveSecondaryPending(application, primaryName);
}

/**
 * Decision → employee.
 * Supports both historical signatures:
 *   (employeeId, application, action, reason)
 *   (application, action, reason)
 * action: "approved" | "rejected" | "withdrawn" | "cancelled" | "edited"
 */
async function notifyEmployeeOnLeaveAction(arg1, arg2, arg3, arg4) {
  let application, action, reason;
  if (typeof arg1 === "string" || (arg1 && arg1._bsontype)) {
    application = arg2;
    action = arg3;
    reason = arg4;
  } else {
    application = arg1;
    action = arg2;
    reason = arg3;
  }
  if (!application) return;

  switch (action) {
    case "approved":
      return notifyLeaveApproved(application);
    case "rejected":
      return notifyLeaveRejected(application, reason);
    case "withdrawn":
    case "cancelled":
      return notifyLeaveWithdrawn(application);
    case "edited":
      return notifyLeaveEdited(application, reason);
    default:
      return notifyLeaveApproved(application);
  }
}

/** Employee requested withdrawal of an approved leave → both managers. */
async function notifyManagerOnWithdrawRequest(application) {
  notifyLeaveWithdrawRequested(application);
}

module.exports = {
  notifyManagerOnLeaveApply,
  notifySecondaryOnPrimaryApproval,
  notifyEmployeeOnLeaveAction,
  notifyManagerOnWithdrawRequest,
};
