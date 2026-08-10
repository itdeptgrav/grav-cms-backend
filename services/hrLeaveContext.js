"use strict";
/**
 * services/hrLeaveContext.js — leave & regularisation context for the assistant.
 *
 * Answers "what leave requests are pending", "who is off next week", "how many
 * leaves does <person> have left" for an AUTHORISED HR caller. Read-only and
 * minimised: aggregate counts always, plus a small bounded, low-PII list.
 */

const { LeaveApplication, LeaveBalance, RegularizationRequest } = require("../models/HR_Models/LeaveManagement");
const { resolveEmployeeByQuery, fullName, leaveHistoryFor, leaveSummaryText, istDateStr, istYear } = require("./hrEmployeeContext");

// Statuses still awaiting a decision (what "pending" means to HR).
const PENDING_STATUSES = ["pending", "manager_approved", "withdraw_pending"];
const MAX_ROWS = 40;

const leaveRow = (a) => ({
  employee: a.employeeName || a.biometricId || null,
  department: a.department || null,
  type: a.leaveType || null,
  from: a.fromDate || null,
  to: a.toDate || null,
  days: a.totalDays ?? null,
  status: a.status || null,
  reason: a.reason ? String(a.reason).slice(0, 60) : null,
});

const regRow = (r) => ({
  employee: r.employeeName || r.biometricId || null,
  department: r.department || null,
  date: r.dateStr || null,
  type: r.type || null,
  status: r.status || null,
});

async function balanceForQuery(employeeQuery) {
  const emp = await resolveEmployeeByQuery(employeeQuery);
  if (!emp) return { requested: true, found: false, query: String(employeeQuery || "").slice(0, 80) };
  const year = istYear();
  const [bal, history] = await Promise.all([
    LeaveBalance.findOne({ $or: [{ employeeId: emp._id }, { biometricId: emp.biometricId }], year })
      .lean()
      .catch(() => null),
    emp.biometricId ? leaveHistoryFor(emp.biometricId) : Promise.resolve([]),
  ]);
  // LeaveBalance stores `entitlement` and `consumed` (NOT allocated/used).
  const rem = (k) => Math.max(0, (bal?.entitlement?.[k] || 0) - (bal?.consumed?.[k] || 0));
  return {
    requested: true,
    found: true,
    employee: { name: fullName(emp), employeeId: emp.biometricId || null, department: emp.department || null },
    year,
    balance: bal
      ? {
          CL: { entitled: bal.entitlement?.CL || 0, used: bal.consumed?.CL || 0, remaining: rem("CL") },
          SL: { entitled: bal.entitlement?.SL || 0, used: bal.consumed?.SL || 0, remaining: rem("SL") },
          PL: { entitled: bal.entitlement?.PL || 0, used: bal.consumed?.PL || 0, remaining: rem("PL") },
        }
      : null,
    // This person's actual leave dates + a plain sentence (never guess dates).
    leaveHistory: history,
    leaveSummary: leaveSummaryText(fullName(emp), history),
  };
}

/**
 * @param {object} args
 * @param {string} [args.department]     optional department filter
 * @param {string} [args.employeeQuery]  if the user named a person, their balance
 * @returns {Promise<object>}
 */
async function buildLeaveContext({ department, employeeQuery } = {}) {
  const today = istDateStr();

  // Person-specific question ("when did X take leave / X's balance"): return ONLY
  // that person's data. Mixing in the global pending/upcoming lists made the
  // model attribute someone else's leave date to this person.
  if (employeeQuery) {
    return { today, employeeLeaveBalance: await balanceForQuery(employeeQuery) };
  }

  const deptFilter =
    department && department !== "all" ? { department: new RegExp(department, "i") } : {};

  const [pendingLeaves, pendingRegs, upcoming] = await Promise.all([
    LeaveApplication.find({ status: { $in: PENDING_STATUSES }, ...deptFilter })
      .sort({ fromDate: 1 })
      .limit(MAX_ROWS + 1)
      .lean()
      .catch(() => []),
    RegularizationRequest.find({ status: { $in: PENDING_STATUSES }, ...deptFilter })
      .sort({ dateStr: -1 })
      .limit(MAX_ROWS + 1)
      .lean()
      .catch(() => []),
    LeaveApplication.find({ status: "hr_approved", toDate: { $gte: today }, ...deptFilter })
      .sort({ fromDate: 1 })
      .limit(MAX_ROWS + 1)
      .lean()
      .catch(() => []),
  ]);

  const ctx = {
    today,
    department: department || "all",
    pendingLeaveRequests: {
      count: pendingLeaves.length > MAX_ROWS ? `${MAX_ROWS}+` : pendingLeaves.length,
      items: pendingLeaves.slice(0, MAX_ROWS).map(leaveRow),
    },
    pendingRegularizations: {
      count: pendingRegs.length > MAX_ROWS ? `${MAX_ROWS}+` : pendingRegs.length,
      items: pendingRegs.slice(0, MAX_ROWS).map(regRow),
    },
    upcomingApprovedLeaves: {
      count: upcoming.length > MAX_ROWS ? `${MAX_ROWS}+` : upcoming.length,
      items: upcoming.slice(0, MAX_ROWS).map(leaveRow),
    },
  };
  return ctx;
}

module.exports = { buildLeaveContext };
