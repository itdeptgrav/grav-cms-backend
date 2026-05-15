/**
 * services/leaveNotification.service.js
 * Push notification handlers for leave events.
 * Sends FCM web push (background/foreground) to employees and managers.
 */

const Employee = require("../models/Employee");
const { sendWebPush, sendWebPushToMany } = require("../utils/sendWebPush");

/**
 * Notify manager(s) when an employee applies for leave.
 */
async function notifyManagerOnLeaveApply(employee, application) {
  try {
    const managersNotified = application.managersNotified || [];
    if (!managersNotified.length) return;

    const managerIds = managersNotified.map((m) => m.managerId).filter(Boolean);
    if (!managerIds.length) return;

    const empName = `${employee.firstName} ${employee.lastName || ""}`.trim();
    const fromDate = application.fromDate
      ? new Date(application.fromDate).toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "short",
        })
      : "—";
    const toDate = application.toDate
      ? new Date(application.toDate).toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "short",
        })
      : "—";

    await sendWebPushToMany({
      employeeIds: managerIds,
      title: "🏖️ Leave Application",
      body: `${empName} has applied for ${application.leaveType || "leave"} from ${fromDate} to ${toDate}.`,
      type: "leave_applied",
      url: "/leave",
      extra: {
        leaveId: String(application._id || ""),
        applicantId: String(employee._id || ""),
      },
    });
  } catch (e) {
    console.error("[LEAVE-NOTIF] notifyManagerOnLeaveApply error:", e.message);
  }
}

/**
 * Notify secondary approver when primary approves (multi-level approval).
 */
async function notifySecondaryOnPrimaryApproval(employee, application) {
  try {
    const managersNotified = application.managersNotified || [];
    // Find managers who haven't approved yet
    const pendingManagers = managersNotified
      .filter((m) => m.status === "pending")
      .map((m) => m.managerId)
      .filter(Boolean);

    if (!pendingManagers.length) return;

    const empName = `${employee.firstName} ${employee.lastName || ""}`.trim();
    await sendWebPushToMany({
      employeeIds: pendingManagers,
      title: "🏖️ Leave Pending Your Approval",
      body: `${empName}'s leave application is awaiting your approval.`,
      type: "leave_applied",
      url: "/leave",
    });
  } catch (e) {
    console.error(
      "[LEAVE-NOTIF] notifySecondaryOnPrimaryApproval error:",
      e.message,
    );
  }
}

/**
 * Notify employee when their leave is approved or rejected.
 * action: "approved" | "rejected" | "withdrawn" | "cancelled"
 */
async function notifyEmployeeOnLeaveAction(arg1, arg2, arg3, arg4) {
  try {
    // Support both signatures:
    //   (employeeId, application, action, reason)  ← original
    //   (application, action, managerName)         ← leaveRoutes.js style
    let employeeId, application, action, reason;
    if (typeof arg1 === "string" || (arg1 && arg1._bsontype)) {
      // Called as (employeeId, application, action, reason)
      employeeId = arg1;
      application = arg2;
      action = arg3;
      reason = arg4;
    } else {
      // Called as (application, action, managerName)
      application = arg1;
      action = arg2;
      reason = arg3; // managerName here is treated as reason
      employeeId = application?.employeeId;
    }

    if (!employeeId || !application) return;

    const { sendWebPush } = require("../utils/sendWebPush");

    const actionMap = {
      approved: { emoji: "✅", verb: "approved", type: "leave_approved" },
      rejected: { emoji: "❌", verb: "rejected", type: "leave_rejected" },
      withdrawn: { emoji: "↩️", verb: "withdrawn", type: "leave_withdrawn" },
      cancelled: { emoji: "🚫", verb: "cancelled", type: "leave_cancelled" },
      edited: { emoji: "✏️", verb: "edited", type: "leave_applied" },
    };
    const { emoji, verb, type } = actionMap[action] || {
      emoji: "📋",
      verb: action,
      type: "leave_applied",
    };

    const fromDate = application.fromDate
      ? new Date(application.fromDate).toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "short",
        })
      : "—";

    let body = `Your ${application.leaveType || "leave"} from ${fromDate} has been ${verb}.`;
    if (reason && action === "rejected") body += ` Reason: ${reason}`;
    if (reason && action === "edited") body += ` By: ${reason}`;

    await sendWebPush({
      employeeId: String(employeeId),
      title: `${emoji} Leave ${verb.charAt(0).toUpperCase() + verb.slice(1)}`,
      body,
      type,
      url: "/leave",
      extra: { leaveId: String(application._id || "") },
    });
  } catch (e) {
    console.error(
      "[LEAVE-NOTIF] notifyEmployeeOnLeaveAction error:",
      e.message,
    );
  }
}

// Also export a new function for withdraw-request → managers:
async function notifyManagerOnWithdrawRequest(application) {
  try {
    const { sendWebPushToMany } = require("../utils/sendWebPush");
    const managerIds = (application.managersNotified || [])
      .map((m) => m.managerId)
      .filter(Boolean);
    if (!managerIds.length) return;

    const fromDate = application.fromDate
      ? new Date(application.fromDate).toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "short",
        })
      : "—";
    const toDate = application.toDate
      ? new Date(application.toDate).toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "short",
        })
      : "—";

    await sendWebPushToMany({
      employeeIds: managerIds,
      title: "↩️ Leave Withdrawal Request",
      body: `${application.employeeName || "An employee"} requested withdrawal of ${application.leaveType || "leave"} (${fromDate} → ${toDate}). Please review.`,
      type: "leave_withdrawn",
      url: "/leave",
      extra: { leaveId: String(application._id || "") },
    });
  } catch (e) {
    console.error(
      "[LEAVE-NOTIF] notifyManagerOnWithdrawRequest error:",
      e.message,
    );
  }
}

// Update module.exports to include the new helper:
module.exports = {
  notifyManagerOnLeaveApply,
  notifySecondaryOnPrimaryApproval,
  notifyEmployeeOnLeaveAction,
  notifyManagerOnWithdrawRequest,
};
