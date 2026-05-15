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
async function notifyEmployeeOnLeaveAction(
  employeeId,
  application,
  action,
  reason,
) {
  try {
    const actionMap = {
      approved: { emoji: "✅", verb: "approved", type: "leave_approved" },
      rejected: { emoji: "❌", verb: "rejected", type: "leave_rejected" },
      withdrawn: { emoji: "↩️", verb: "withdrawn", type: "leave_withdrawn" },
      cancelled: { emoji: "🚫", verb: "cancelled", type: "leave_cancelled" },
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
    if (reason) body += ` Reason: ${reason}`;

    await sendWebPush({
      employeeId,
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

module.exports = {
  notifyManagerOnLeaveApply,
  notifySecondaryOnPrimaryApproval,
  notifyEmployeeOnLeaveAction,
};
