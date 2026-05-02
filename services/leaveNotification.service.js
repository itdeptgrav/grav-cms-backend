// services/leaveNotification.service.js
const { Expo } = require("expo-server-sdk");
const Employee = require("../models/Employee");

const expo = new Expo();

const LEAVE_TYPE_LABELS = {
    CL: "Casual Leave", SL: "Sick Leave",
    PL: "Privilege Leave", EL: "Earned Leave",
};

// ══════════════════════════════════════════════════════════════════════════
// 1. Employee applies → Notify their PRIMARY manager
// ══════════════════════════════════════════════════════════════════════════
async function notifyManagerOnLeaveApply(employee, leaveApp) {
    try {
        const managerId = employee.primaryManager?.managerId;
        if (!managerId) {
            console.log("[LEAVE-PUSH] No primary manager for", employee.firstName);
            return { sent: false, reason: "no_manager" };
        }

        const manager = await Employee.findById(managerId)
            .select("firstName lastName pushToken").lean();
        if (!manager?.pushToken || !Expo.isExpoPushToken(manager.pushToken)) {
            console.log(`[LEAVE-PUSH] Manager ${manager?.firstName || managerId} has no valid push token`);
            return { sent: false, reason: "no_token" };
        }

        const empName = [employee.firstName, employee.lastName].filter(Boolean).join(" ");
        const leaveLabel = LEAVE_TYPE_LABELS[leaveApp.leaveType] || leaveApp.leaveType;
        const days = leaveApp.totalDays || 1;

        const receipts = await expo.sendPushNotificationsAsync([{
            to: manager.pushToken,
            sound: "default",
            title: "Leave Request",
            body: `${empName} has applied for ${leaveLabel} (${days} day${days > 1 ? "s" : ""}) from ${leaveApp.fromDate} to ${leaveApp.toDate || leaveApp.fromDate}.`,
            data: {
                type: "leave_request",
                leaveId: String(leaveApp._id),
                employeeId: String(employee._id),
                employeeName: empName,
                leaveType: leaveApp.leaveType,
                fromDate: leaveApp.fromDate,
                toDate: leaveApp.toDate,
                totalDays: days,
                screen: "Leave",
            },
            categoryId: "leave_action",
            channelId: "general",
            priority: "high",
            badge: 1,
        }]);

        const ok = receipts[0]?.status === "ok";
        console.log(`[LEAVE-PUSH] Manager ${manager.firstName}: ${ok ? "sent" : "failed"}`);
        if (!ok && receipts[0]?.details?.error === "DeviceNotRegistered") {
            await Employee.findByIdAndUpdate(managerId, { pushToken: null }).catch(() => { });
        }
        return { sent: ok };
    } catch (err) {
        console.error("[LEAVE-PUSH] notifyManager error:", err.message);
        return { sent: false, error: err.message };
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 2. Primary approved → Notify SECONDARY manager (needs their approval)
// ══════════════════════════════════════════════════════════════════════════
async function notifySecondaryOnPrimaryApproval(leaveApp) {
    try {
        const secEntry = (leaveApp.managersNotified || []).find(m => m.type === "secondary");
        if (!secEntry?.managerId) return { sent: false, reason: "no_secondary" };

        const secMgr = await Employee.findById(secEntry.managerId)
            .select("firstName lastName pushToken").lean();
        if (!secMgr?.pushToken || !Expo.isExpoPushToken(secMgr.pushToken)) {
            console.log(`[LEAVE-PUSH] Secondary ${secMgr?.firstName || secEntry.managerId} has no valid token`);
            return { sent: false, reason: "no_token" };
        }

        const receipts = await expo.sendPushNotificationsAsync([{
            to: secMgr.pushToken,
            sound: "default",
            title: "Leave Pending Your Approval",
            body: `${leaveApp.employeeName}'s ${LEAVE_TYPE_LABELS[leaveApp.leaveType] || leaveApp.leaveType} (${leaveApp.fromDate} to ${leaveApp.toDate}) needs your approval.`,
            data: {
                type: "leave_request",
                leaveId: String(leaveApp._id),
                employeeName: leaveApp.employeeName,
                leaveType: leaveApp.leaveType,
                fromDate: leaveApp.fromDate,
                toDate: leaveApp.toDate,
                totalDays: leaveApp.totalDays,
                screen: "Leave",
            },
            categoryId: "leave_action",
            channelId: "general",
            priority: "high",
            badge: 1,
        }]);

        const ok = receipts[0]?.status === "ok";
        console.log(`[LEAVE-PUSH] Secondary ${secMgr.firstName}: ${ok ? "sent" : "failed"}`);
        if (!ok && receipts[0]?.details?.error === "DeviceNotRegistered") {
            await Employee.findByIdAndUpdate(secEntry.managerId, { pushToken: null }).catch(() => { });
        }
        return { sent: ok };
    } catch (err) {
        console.error("[LEAVE-PUSH] notifySecondary error:", err.message);
        return { sent: false, error: err.message };
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 3. Manager approves/rejects → Notify the employee
// ══════════════════════════════════════════════════════════════════════════
async function notifyEmployeeOnLeaveAction(leaveApp, action, managerName) {
    try {
        const empId = leaveApp.employeeId?._id || leaveApp.employeeId;
        if (!empId) return { sent: false, reason: "no_employee_id" };

        const employee = await Employee.findById(empId)
            .select("firstName lastName pushToken").lean();
        if (!employee?.pushToken || !Expo.isExpoPushToken(employee.pushToken)) {
            console.log(`[LEAVE-PUSH] Employee ${employee?.firstName || empId} has no valid token`);
            return { sent: false, reason: "no_token" };
        }

        const leaveLabel = LEAVE_TYPE_LABELS[leaveApp.leaveType] || leaveApp.leaveType;
        const isApproved = ["approve", "approved", "manager_approved", "hr_approved"].includes(action);

        const title = isApproved ? "Leave Approved" : "Leave Rejected";
        const body = isApproved
            ? `Your ${leaveLabel} (${leaveApp.fromDate} to ${leaveApp.toDate}) has been approved${managerName ? ` by ${managerName}` : ""}. Tap to view.`
            : `Your ${leaveLabel} (${leaveApp.fromDate} to ${leaveApp.toDate}) has been rejected${managerName ? ` by ${managerName}` : ""}. Tap to view.`;

        const receipts = await expo.sendPushNotificationsAsync([{
            to: employee.pushToken,
            sound: "default",
            title,
            body,
            data: {
                type: "leave_action",
                leaveId: String(leaveApp._id),
                action: isApproved ? "approved" : "rejected",
                screen: "Leave",
            },
            categoryId: "general",
            channelId: "general",
            priority: "high",
            badge: 1,
        }]);

        const ok = receipts[0]?.status === "ok";
        console.log(`[LEAVE-PUSH] Employee ${employee.firstName}: ${title} — ${ok ? "sent" : "failed"}`);
        if (!ok && receipts[0]?.details?.error === "DeviceNotRegistered") {
            await Employee.findByIdAndUpdate(empId, { pushToken: null }).catch(() => { });
        }
        return { sent: ok };
    } catch (err) {
        console.error("[LEAVE-PUSH] notifyEmployee error:", err.message);
        return { sent: false, error: err.message };
    }
}

module.exports = {
    notifyManagerOnLeaveApply,
    notifySecondaryOnPrimaryApproval,
    notifyEmployeeOnLeaveAction,
};