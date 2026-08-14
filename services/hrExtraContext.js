"use strict";
/**
 * services/hrExtraContext.js — the rest of HR, exposed to the central assistant.
 *
 * Everything HR that wasn't already covered by the overview / daily-attendance /
 * leave / employee builders: the employee DIRECTORY, DEPARTMENTS, OVERTIME,
 * company HOLIDAYS, HR POLICIES & settings, and AGGREGATE PAYROLL runs. All
 * read-only and authorised-HR only. Individual salaries (PayrollItem) are
 * deliberately excluded — only company-level payroll totals are surfaced.
 */

const Employee = require("../models/Employee");
const Department = require("../models/HR_Models/Departments");
const OvertimeReport = require("../models/HR_Models/OvertimeReport");
const Policy = require("../models/HR_Models/Policy");
const AttendanceSettings = require("../models/HR_Models/Attendancesettings");
const PayrollSettings = require("../models/HR_Models/Payrollsettings");
const { Payroll, PayrollItem } = require("../models/HR_Models/Payroll");
const { CompanyHoliday, LeaveConfig } = require("../models/HR_Models/LeaveManagement");
const { fullName, resolveEmployeeByQuery, resolveSelfEmployee, istDateStr, istNow } = require("./hrEmployeeContext");

const MAX_ROWS = 50;

// Indian-style amount words ("47411" -> "47.41 thousand", "2630726" -> "26.31
// lakh"), and a "raw (words)" form so the model can quote lakh/crore directly.
function lc(n) {
  const v = Math.round(Number(n) || 0);
  const a = Math.abs(v);
  const trim = (x) => String(x).replace(/\.?0+$/, "");
  if (a >= 1e7) return `${trim((v / 1e7).toFixed(2))} crore`;
  if (a >= 1e5) return `${trim((v / 1e5).toFixed(2))} lakh`;
  if (a >= 1e3) return `${trim((v / 1e3).toFixed(2))} thousand`;
  return String(v);
}
const amt = (n) => `${Math.round(Number(n) || 0)} (${lc(n)})`;

// ── Directory: who works here, counts by department, a department's members ────
async function buildDirectoryContext({ department } = {}) {
  const activeFilter = { isActive: { $ne: false } };
  const [total, active, byDept] = await Promise.all([
    Employee.countDocuments({}),
    Employee.countDocuments(activeFilter),
    Employee.aggregate([
      { $match: activeFilter },
      { $group: { _id: "$department", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).catch(() => []),
  ]);

  const ctx = {
    totalEmployees: total,
    activeEmployees: active,
    headcountByDepartment: byDept.map((d) => ({ department: d._id || "Unassigned", count: d.count })),
  };

  if (department && department !== "all") {
    // Newest joiners first, so "who recently joined X" and full-list both work.
    const members = await Employee.find({ ...activeFilter, department: new RegExp(department, "i") })
      .select("firstName middleName lastName biometricId designation dateOfJoining")
      .sort({ dateOfJoining: -1 })
      .limit(MAX_ROWS + 1)
      .lean()
      .catch(() => []);
    ctx.department = department;
    ctx.departmentMembers = {
      count: members.length > MAX_ROWS ? `${MAX_ROWS}+` : members.length,
      items: members.slice(0, MAX_ROWS).map((e) => ({
        name: fullName(e),
        employeeId: e.biometricId || null,
        designation: e.designation || null,
        dateOfJoining: e.dateOfJoining ? istDateStr(new Date(e.dateOfJoining)) : null,
      })),
    };
  }
  return ctx;
}

// ── Departments: the org's departments + designations + live headcounts ────────
async function buildDepartmentsContext() {
  const [depts, counts] = await Promise.all([
    Department.find({}).select("name status designations").lean().catch(() => []),
    Employee.aggregate([
      { $match: { isActive: { $ne: false } } },
      { $group: { _id: "$department", count: { $sum: 1 } } },
    ]).catch(() => []),
  ]);
  const countByName = new Map(counts.map((c) => [String(c._id || "").toLowerCase(), c.count]));
  return {
    count: depts.length,
    departments: depts.map((d) => ({
      name: d.name,
      status: d.status || "active",
      headcount: countByName.get(String(d.name || "").toLowerCase()) || 0,
      designations: (d.designations || []).filter((x) => x.isActive !== false).map((x) => x.name),
    })),
  };
}

// ── Overtime: recent OT, totals, and pending approvals ─────────────────────────
const OT_PENDING = ["pending", "manager_approved", "withdraw_pending"];
async function buildOvertimeContext({ department } = {}) {
  const deptFilter = department && department !== "all" ? { department: new RegExp(department, "i") } : {};
  const hrs = (mins) => (mins != null ? Math.round((mins / 60) * 10) / 10 : null);
  const [recent, pendingCount, perEmployee] = await Promise.all([
    OvertimeReport.find(deptFilter).sort({ dateStr: -1 }).limit(MAX_ROWS).lean().catch(() => []),
    OvertimeReport.countDocuments({ status: { $in: OT_PENDING }, ...deptFilter }),
    // Total OT per employee, ranked highest first — so "who did the most
    // overtime" is answered over ALL records, not just the recent few.
    OvertimeReport.aggregate([
      { $match: deptFilter },
      { $group: { _id: "$biometricId", employee: { $first: "$employeeName" }, department: { $first: "$department" }, totalMins: { $sum: "$stayOverMins" }, entries: { $sum: 1 } } },
      { $sort: { totalMins: -1 } },
      { $limit: 15 },
    ]).catch(() => []),
  ]);

  const topByHours = perEmployee.map((e) => ({
    employee: e.employee || e._id,
    department: e.department,
    totalHours: hrs(e.totalMins),
    totalMinutes: e.totalMins,
    entries: e.entries,
  }));
  const readable = topByHours.length
    ? "Overtime by employee (highest first): " +
      topByHours.slice(0, 8).map((e) => `${e.employee} — ${e.totalHours}h across ${e.entries}`).join("; ") +
      `. ${pendingCount} overtime approvals pending.`
    : "No overtime records found.";
  return {
    department: department || "all",
    pendingApprovals: pendingCount,
    topByHours,
    recent: recent.map((o) => ({
      employee: o.employeeName || o.biometricId,
      department: o.department,
      date: o.dateStr,
      hours: hrs(o.stayOverMins),
      status: o.status,
    })),
    readable,
  };
}

// ── Holidays: upcoming and this-year company holidays ──────────────────────────
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

async function buildHolidaysContext() {
  const today = istDateStr(); // "2026-08-09"
  const now = istNow();
  const year = now.getUTCFullYear();
  const ym = `${year}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`; // "2026-08"
  const monthLabel = `${MONTH_NAMES[now.getUTCMonth()]} ${year}`;
  const all = await CompanyHoliday.find({ date: { $regex: `^${year}` } })
    .sort({ date: 1 })
    .lean()
    .catch(() => []);
  const fmt = (h) => ({ date: h.date, name: h.name, type: h.type || "company" });
  const upcoming = all.filter((h) => h.date >= today).map(fmt);
  const past = all.filter((h) => h.date < today).map(fmt);
  const thisMonth = all.filter((h) => String(h.date).startsWith(ym)).map(fmt);

  // Plain-English summary — the small model mis-reads raw JSON arrays (it read
  // this calendar as "no holidays this month" even though Independence Day was in
  // it). Spell out THIS MONTH explicitly, and treat national holidays as days off
  // too (they are — don't let the model split "company" vs "national" and deny
  // that 15 August is a holiday).
  const listReadable = (arr) =>
    arr.length ? arr.map((h) => `${h.date} ${h.name} (${h.type})`).join("; ") : "none";
  const readable =
    `Today is ${today}. Company holiday calendar for ${year} — ${all.length} holidays. ` +
    `National holidays are company days off too. ` +
    `Holidays THIS MONTH (${monthLabel}): ${listReadable(thisMonth)}. ` +
    `Upcoming holidays (today onward): ${listReadable(upcoming)}. ` +
    `Earlier this year: ${listReadable(past)}.`;

  return {
    year,
    today,
    month: monthLabel,
    thisMonth,
    upcoming,
    past,
    total: all.length,
    readable,
  };
}

// ── Policies & settings: attendance rules, leave entitlements, SOP policies ─────
async function buildPoliciesContext() {
  const [att, leaveCfg, paySettings, policies] = await Promise.all([
    AttendanceSettings.findOne({}).lean().catch(() => null),
    LeaveConfig.findOne({}).lean().catch(() => null),
    PayrollSettings.findOne({}).lean().catch(() => null),
    Policy.find({ isActive: true }).select("name description category scope thresholdMins points").limit(MAX_ROWS).lean().catch(() => []),
  ]);
  return {
    attendance: att
      ? {
          shiftStart: att.shiftStart,
          shiftEnd: att.shiftEnd,
          lateThresholdMinutes: att.lateThresholdMinutes,
          halfDayThresholdMinutes: att.halfDayThresholdMinutes,
          earlyDepartureThresholdMinutes: att.earlyDepartureThresholdMinutes,
          workingDays: att.workingDays,
          overtimeEnabled: att.overtimeEnabled,
          overtimeRateMultiplier: att.overtimeRateMultiplier,
        }
      : null,
    leaveEntitlement: leaveCfg
      ? { CL_per_year: leaveCfg.clPerYear, SL_per_year: leaveCfg.slPerYear, PL_per_year: leaveCfg.plPerYear, daysRequiredForPL: leaveCfg.daysRequiredForPL, maxLeaveDaysPerMonth: leaveCfg.maxLeaveDaysPerMonth }
      : null,
    payrollSettings: paySettings
      ? { payableDaysBasis: paySettings.payableDaysBasis, roundingMode: paySettings.roundingMode, ptEnabled: paySettings.ptEnabled }
      : null,
    hrPolicies: policies.map((p) => ({ name: p.name, category: p.category, scope: p.scope, thresholdMins: p.thresholdMins, description: p.description ? String(p.description).slice(0, 120) : null })),
  };
}

// ── Payroll: company-level run totals only (NO individual salaries) ─────────────
async function buildPayrollContext() {
  const runs = await Payroll.find({}).sort({ year: -1, month: -1 }).limit(12).lean().catch(() => []);
  const list = runs.map((r) => ({
    period: `${String(r.month).padStart(2, "0")}/${r.year}`,
    totalEmployees: r.totalEmployees,
    totalGross: Math.round(r.totalGross || 0),
    totalDeductions: Math.round(r.totalDeductions || 0),
    totalNetPay: Math.round(r.totalNetPay || 0),
    totalPF: Math.round(r.totalPF || 0),
    totalESIC: Math.round(r.totalESIC || 0),
    status: r.status,
  }));
  return {
    note: "Company-level payroll run totals only. Individual salaries are not available here.",
    runs: list,
    readable: list.length
      ? "Payroll runs (INR): " +
        list.slice(0, 6).map((r) => `${r.period} — gross ${amt(r.totalGross)}, net ${amt(r.totalNetPay)} for ${r.totalEmployees} employees (${r.status})`).join("; ") +
        "."
      : "No payroll runs found.",
  };
}

// ── Individual salary / payslip (SENSITIVE — authorised HR/CEO only) ───────────
// Returns one employee's monthly payroll figures. Bank account details are
// deliberately excluded. Plain (comma-free) numbers appear in `readable` so the
// grounding guard can verify every amount the model states.
async function buildSalaryContext({ query, month, year, user, self, annual } = {}) {
  // Self-queries ("how much did I earn") resolve to the LOGGED-IN user's own
  // record via their identity — never a guess from the sentence. If the signed-in
  // account has no employee record (e.g. the CEO login), say so plainly instead of
  // surfacing someone else's payslip.
  let emp = null;
  if (self && user) {
    emp = await resolveSelfEmployee(user);
    if (!emp) {
      return {
        found: false,
        note:
          "Your signed-in account is not linked to an employee payroll record, so there is no personal salary to report for you.",
        self: true,
      };
    }
  }
  if (!emp) emp = await resolveEmployeeByQuery(query);
  if (!emp) return { found: false, note: "No employee matching that name or ID was found in HR records." };

  const m = Number(month);
  const y = Number(year);

  // ANNUAL view: a whole-year total ("how much did I earn this year") — sum every
  // payslip in the year, not just the latest month (the old behaviour, which
  // reported a single month for a yearly question).
  if (annual || (y >= 2000 && !(m >= 1 && m <= 12))) {
    const yr = y >= 2000 ? y : istNow().getUTCFullYear();
    const slips = await PayrollItem.find({ biometricId: emp.biometricId, year: yr })
      .sort({ month: 1 })
      .lean()
      .catch(() => []);
    if (!slips.length) {
      return {
        found: false,
        employee: { name: fullName(emp), employeeId: emp.biometricId },
        note: `No payroll runs found for ${yr}.`,
        self: Boolean(self),
      };
    }
    const netOf = (p) => Math.round(p.roundedNetPay || p.netPay || 0);
    const grossOf = (p) => Math.round((p.earnings && p.earnings.grossEarnings) || 0);
    const totalNet = slips.reduce((s, p) => s + netOf(p), 0);
    const totalGross = slips.reduce((s, p) => s + grossOf(p), 0);
    const name = slips[0].employeeName || fullName(emp);
    const months = slips.map((p) => ({ period: `${String(p.month).padStart(2, "0")}/${p.year}`, netPay: netOf(p) }));
    return {
      found: true,
      annual: true,
      year: yr,
      employee: { name, employeeId: emp.biometricId },
      monthsPaid: slips.length,
      totalNetPay: totalNet,
      totalGross,
      months,
      readable:
        `${name}'s total earnings for ${yr}: NET PAY ${amt(totalNet)} across ${slips.length} months ` +
        `(${months.map((mm) => `${mm.period} ${amt(mm.netPay)}`).join(", ")}); total gross ${amt(totalGross)}. (All amounts in INR.)`,
    };
  }

  const filter = { biometricId: emp.biometricId };
  if (m >= 1 && m <= 12) filter.month = m;
  if (y >= 2000) filter.year = y;

  const item = await PayrollItem.findOne(filter).sort({ year: -1, month: -1 }).lean().catch(() => null);
  if (!item) {
    const periods = await PayrollItem.find({ biometricId: emp.biometricId })
      .select("month year")
      .sort({ year: -1, month: -1 })
      .limit(12)
      .lean()
      .catch(() => []);
    return {
      found: false,
      employee: { name: fullName(emp), employeeId: emp.biometricId },
      note: "No payroll run found for that employee for the requested month.",
      availablePeriods: periods.map((p) => `${String(p.month).padStart(2, "0")}/${p.year}`),
    };
  }

  const e = item.earnings || {};
  const d = item.deductions || {};
  const net = Math.round(item.roundedNetPay || item.netPay || 0);
  const gross = Math.round(e.grossEarnings || 0);
  const totalDed = Math.round(d.totalDeductions || 0);
  const period = `${String(item.month).padStart(2, "0")}/${item.year}`;
  const name = item.employeeName || fullName(emp);
  const r = (n) => Math.round(n || 0); // plain integers so the guard can verify

  return {
    found: true,
    employee: { name, employeeId: item.biometricId, department: item.department, designation: item.designation || item.jobTitle },
    period,
    payableDays: item.payableDays,
    status: item.status,
    earnings: {
      basic: r(e.basicSalary),
      houseRentAllowance: r(e.houseRentAllowance),
      allowances: r((e.travelAllowance || 0) + (e.medicalAllowance || 0) + (e.specialAllowance || 0)),
      overtime: r(e.overtime),
      bonus: r(e.bonus),
      gross,
    },
    deductions: {
      providentFund: r(d.providentFund),
      esic: r(d.esic),
      professionalTax: r(d.professionalTax),
      incomeTax: r(d.incomeTax),
      lossOfPay: r(d.lopDeduction),
      total: totalDed,
    },
    netPay: net,
    // Comma-free amounts so the grounding guard matches them against this data.
    readable: `${name}'s payroll for ${period}: gross earnings ${amt(gross)} (basic ${amt(e.basicSalary)}), total deductions ${amt(totalDed)} (PF ${amt(d.providentFund)}, ESIC ${amt(d.esic)}, tax ${amt(d.incomeTax)}), NET PAY ${amt(net)}, for ${item.payableDays} payable days. Status: ${item.status}. (All amounts in INR.)`,
  };
}

module.exports = {
  buildDirectoryContext,
  buildDepartmentsContext,
  buildOvertimeContext,
  buildHolidaysContext,
  buildPoliciesContext,
  buildPayrollContext,
  buildSalaryContext,
};
