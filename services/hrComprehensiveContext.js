"use strict";

/**
 * Complete read adapters for HR domains that are not represented by the small
 * dashboard-oriented assistant contexts.
 *
 * Qwen never receives collection names or a database query. It chooses one of
 * the typed operations registered in services/ai/tools/hrTools.js; this module
 * resolves that request through fixed server-owned filters and projections.
 */

const Employee = require("../models/Employee");
const DailyAttendance = require("../models/HR_Models/Dailyattendance");
const AttendanceExclusion = require("../models/HR_Models/AttendanceExclusion");
const JobPosting = require("../models/HR_Models/JobPosting");
const Candidate = require("../models/HR_Models/Candidates");
const EmployeeTask = require("../models/HR_Models/EmployeeTask");
const EmployeeDocument = require("../models/HR_Models/EmployeeDocument");
const ChangeLog = require("../models/Access/ChangeLog");
const { LeaveBalance, LeaveApplication, RegularizationRequest } = require("../models/HR_Models/LeaveManagement");
const { Payroll, PayrollItem } = require("../models/HR_Models/Payroll");
const { resolveEmployeeByQuery, fullName, istDateStr, istNow } = require("./hrEmployeeContext");
const { excludeSelect, projectEmployee, redactSecrets } = require("./access/hrFieldPolicy");
const { decryptEmployeeDoc } = require("../utils/salaryEncryption");
const { tallyEntry, blankStats, monthsBetween } = require("../utils/performanceStats");
const { CAPABILITIES } = require("./access/hrCapabilities");

const MAX_ROWS = 50;
const heldBy = (user) => (user && user.hrActor && user.hrActor.capabilities) || new Set();
const has = (user, capability) => heldBy(user).has(capability);
const esc = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rx = (value) => (value ? new RegExp(esc(String(value).trim()), "i") : null);
const bounded = (value, fallback = 20) => Math.min(MAX_ROWS, Math.max(1, Number(value) || fallback));
const iso = (value) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);

function plain(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Date) return value.toISOString();
  if (typeof value.toJSON === "function") return plain(value.toJSON());
  if (typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "__v" || key === "password" || key === "temporaryPassword") continue;
    out[key] = plain(child);
  }
  return out;
}

// Fields that are valid in the HR UI but must never be copied into a language
// model prompt. The assistant can report that a file/bank setup exists without
// receiving a bearer URL, storage id or bank credential.
function stripAssistantSecrets(value, depth = 0) {
  if (depth > 12 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => stripAssistantSecrets(v, depth + 1));
  if (typeof value !== "object") return value;
  const out = {};
  const blocked = new Set([
    "password", "temporaryPassword", "token", "pushToken", "fcmToken",
    "url", "publicId", "driveFileId", "documentUrl", "documentFileId",
    "accountNumber", "ifscCode",
  ]);
  for (const [key, child] of Object.entries(value)) {
    if (blocked.has(key)) continue;
    out[key] = stripAssistantSecrets(child, depth + 1);
  }
  return out;
}

async function resolveFullEmployee(query, capabilities) {
  const match = await resolveEmployeeByQuery(query);
  if (!match || !match._id) return null;
  return Employee.findById(match._id).select(excludeSelect(capabilities)).lean().catch(() => null);
}

async function buildFullEmployeeContext({ query, user } = {}) {
  const capabilities = heldBy(user);
  const raw = await resolveFullEmployee(query, capabilities);
  if (!raw) return { found: false, note: "No employee matching that name or ID was found." };
  // Decrypt only after capability-aware projection has established that salary
  // may leave storage. The projection is applied again after decryption.
  const projected = projectEmployee(raw, capabilities);
  if (!projected) return { found: false, note: "The employee record is not available to this account." };
  const safe = has(user, CAPABILITIES.COMPENSATION_READ)
    ? projectEmployee(decryptEmployeeDoc(projected), capabilities)
    : projected;
  return {
    found: true,
    employee: fullName(raw),
    record: stripAssistantSecrets(redactSecrets(plain(safe))),
    note: "This is the complete field-policy projection for this caller; fields outside their HR permissions are omitted.",
  };
}

function dateFilter(field, from, to) {
  const start = iso(from);
  const end = iso(to);
  if (!start && !end) return {};
  const range = {};
  if (start) range.$gte = start;
  if (end) range.$lte = end;
  return { [field]: range };
}

async function buildAttendanceRecordsContext({ employeeName, department, from, to, limit } = {}) {
  const filter = { ...dateFilter("dateStr", from, to) };
  if (department) filter["employees.department"] = rx(department);
  let employee = null;
  if (employeeName) {
    employee = await resolveEmployeeByQuery(employeeName);
    if (!employee) return { found: false, note: "No matching employee was found." };
    filter["employees.biometricId"] = String(employee.biometricId || "").toUpperCase();
  }
  const docs = await DailyAttendance.find(filter).sort({ dateStr: -1 }).limit(bounded(limit)).lean().catch(() => []);
  const rows = [];
  for (const doc of docs) {
    for (const entry of doc.employees || []) {
      if (employee && String(entry.biometricId || "").toUpperCase() !== String(employee.biometricId || "").toUpperCase()) continue;
      if (department && !rx(department).test(String(entry.department || ""))) continue;
      rows.push({
        date: doc.dateStr,
        dayOfWeek: doc.dayOfWeek,
        holiday: plain(doc.holiday || null),
        dayFinalised: Boolean(doc.hrFinalised),
        employee: entry.employeeName,
        employeeId: entry.biometricId,
        identityId: entry.identityId,
        department: entry.department,
        designation: entry.designation,
        employeeType: entry.employeeType,
        status: entry.hrFinalStatus || entry.systemPrediction,
        systemPrediction: entry.systemPrediction,
        hrFinalStatus: entry.hrFinalStatus,
        inTime: entry.inTime,
        lunchOut: entry.lunchOut,
        lunchIn: entry.lunchIn,
        teaOut: entry.teaOut,
        teaIn: entry.teaIn,
        finalOut: entry.finalOut,
        punchCount: entry.punchCount,
        totalSpanMins: entry.totalSpanMins,
        lunchBreakMins: entry.lunchBreakMins,
        teaBreakMins: entry.teaBreakMins,
        totalBreakMins: entry.totalBreakMins,
        netWorkMins: entry.netWorkMins,
        overtimeMins: entry.otMins,
        hasOvertime: entry.hasOT,
        punchedOnHoliday: entry.punchedOnHoliday,
        late: entry.isLate,
        lateMins: entry.lateMins,
        lateDisplay: entry.lateDisplay,
        earlyDeparture: entry.isEarlyDeparture,
        earlyDepartureMins: entry.earlyDepartureMins,
        missedPunch: entry.hasMissPunch,
        missingPunchType: entry.missingPunchType,
        appliedExtraGraceMins: entry.appliedExtraGraceMins,
        attendanceValue: entry.attendanceValue,
        shiftStart: entry.shiftStart,
        shiftEnd: entry.shiftEnd,
        matchMethod: entry.matchMethod,
        hrRemarks: entry.hrRemarks,
        reviewedAt: entry.hrReviewedAt,
        reviewedBy: entry.hrReviewedBy,
        rawPunches: (entry.rawPunches || []).map((punch) => ({
          sequence: punch.seq,
          time: punch.time,
          punchType: punch.punchType,
          source: punch.source,
          addedBy: punch.addedBy,
          addedAt: punch.addedAt,
        })),
      });
      if (rows.length >= MAX_ROWS) break;
    }
    if (rows.length >= MAX_ROWS) break;
  }
  return { found: true, filters: { employeeName: employee ? fullName(employee) : null, department: department || null, from: iso(from), to: iso(to) }, count: rows.length, rows, truncated: rows.length >= MAX_ROWS };
}

async function buildAttendanceExclusionsContext({ employeeName, yearMonth, limit } = {}) {
  const filter = {};
  if (yearMonth && /^\d{4}-\d{2}$/.test(String(yearMonth))) filter.yearMonth = String(yearMonth);
  if (employeeName) {
    const employee = await resolveEmployeeByQuery(employeeName);
    if (!employee) return { found: false, note: "No matching employee was found." };
    filter.biometricId = String(employee.biometricId || "").toUpperCase();
  }
  const rows = await AttendanceExclusion.find(filter).sort({ yearMonth: -1, removedAt: -1 }).limit(bounded(limit)).lean().catch(() => []);
  return {
    found: true,
    count: rows.length,
    rows: plain(rows).map((row) => ({
      employee: row.employeeName,
      employeeId: row.biometricId,
      yearMonth: row.yearMonth,
      removedAt: row.removedAt,
      removedBy: row.removedByName,
      reason: row.reason,
      daysRemovedAtTime: row.daysRemovedAtTime,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
    truncated: rows.length >= bounded(limit),
  };
}

async function buildLeaveRecordsContext({ recordType = "leave", employeeName, department, status, from, to, year, limit } = {}) {
  let employee = null;
  if (employeeName) {
    employee = await resolveEmployeeByQuery(employeeName);
    if (!employee) return { found: false, note: "No matching employee was found." };
  }
  const base = {};
  if (employee) base.$or = [{ employeeId: employee._id }, { biometricId: employee.biometricId }];
  if (department) base.department = rx(department);
  if (status) base.status = status;
  let Model = LeaveApplication;
  let dateField = "fromDate";
  if (recordType === "regularization") {
    Model = RegularizationRequest;
    dateField = "dateStr";
  } else if (recordType === "balance") {
    Model = LeaveBalance;
    if (year) base.year = Number(year);
  }
  Object.assign(base, recordType === "balance" ? {} : dateFilter(dateField, from, to));
  const rows = await Model.find(base).sort(recordType === "balance" ? { year: -1 } : { [dateField]: -1 }).limit(bounded(limit)).lean().catch(() => []);
  return { found: true, recordType, count: rows.length, rows: stripAssistantSecrets(redactSecrets(plain(rows))), truncated: rows.length >= bounded(limit) };
}

async function buildRecruitmentContext({ recordType = "jobs", query, status, stage, department, from, to, limit } = {}) {
  const filter = {};
  let Model = JobPosting;
  let sort = { createdAt: -1 };
  if (recordType === "candidates") {
    Model = Candidate;
    if (stage) filter.stage = stage;
    if (status) filter.status = status;
    if (department) filter["managerInCharge.departmentName"] = rx(department);
    if (query) filter.$or = [{ name: rx(query) }, { email: rx(query) }, { jobTitle: rx(query) }];
    Object.assign(filter, dateFilter("appliedDate", from, to));
  } else if (recordType === "tasks") {
    Model = EmployeeTask;
    if (status) filter.status = status;
    if (department) filter.departmentName = rx(department);
    if (query) filter.$or = [{ title: rx(query) }, { description: rx(query) }, { "participants.name": rx(query) }];
    Object.assign(filter, dateFilter("scheduledDate", from, to));
    sort = { scheduledDate: -1 };
  } else {
    if (status) filter.status = status;
    if (department) filter["hiringManager.departmentName"] = rx(department);
    if (query) filter.$or = [{ jobTitle: rx(query) }, { description: rx(query) }, { requiredSkills: rx(query) }];
    Object.assign(filter, dateFilter("createdAt", from, to));
  }
  const rows = await Model.find(filter).sort(sort).limit(bounded(limit)).lean().catch(() => []);
  const safe = plain(rows).map((row) => {
    // Storage links are not useful evidence for a language answer and may be
    // bearer-style URLs. Preserve that documents exist, not their secret path.
    if (row.resumeUrl) row.resume = { available: Boolean(row.resumeUrl.url) };
    delete row.resumeUrl;
    delete row.profilePic;
    if (Array.isArray(row.additionalDocuments)) row.additionalDocuments = row.additionalDocuments.map((d) => ({ title: d.title, uploadedAt: d.uploadedAt }));
    return row;
  });
  return { found: true, recordType, count: safe.length, rows: stripAssistantSecrets(redactSecrets(safe)), truncated: safe.length >= bounded(limit) };
}

async function buildDocumentRecordsContext({ employeeName, type, state, department, limit, user } = {}) {
  const filter = {};
  if (employeeName) {
    const employee = await resolveEmployeeByQuery(employeeName);
    if (!employee) return { found: false, note: "No matching employee was found." };
    filter.employeeId = employee._id;
  }
  if (type) filter.type = type;
  if (department) filter.department = rx(department);
  if (state === "released") filter.released = true;
  if (state === "revoked") Object.assign(filter, { released: false, revokedAt: { $ne: null } });
  if (state === "awaiting_generation") Object.assign(filter, { generated: false, requestStatus: "requested" });
  if (state === "generated_unreleased") Object.assign(filter, { generated: true, released: false, revokedAt: null });
  const rows = await EmployeeDocument.find(filter).sort({ createdAt: -1 }).limit(bounded(limit)).lean().catch(() => []);
  const allowComp = has(user, CAPABILITIES.COMPENSATION_READ);
  const safe = plain(rows).map((row) => {
    if (row.file) row.file = { fileName: row.file.fileName, mimeType: row.file.mimeType, bytes: row.file.bytes, available: Boolean(row.generated) };
    if (row.letterMeta && !allowComp) delete row.letterMeta.annualCTC;
    return row;
  });
  return { found: true, count: safe.length, rows: stripAssistantSecrets(redactSecrets(safe)), truncated: safe.length >= bounded(limit) };
}

async function buildPayrollRecordsContext({ recordType = "items", employeeName, department, status, month, year, includeDayBreakdown = false, limit } = {}) {
  if (includeDayBreakdown && (recordType !== "items" || !employeeName || !month || !year)) {
    return {
      found: false,
      note: "Day-level payroll evidence requires one named employee, month and year; no broad payroll read was performed.",
    };
  }
  const filter = {};
  if (status) filter.status = status;
  if (month) filter.month = Number(month);
  if (year) filter.year = Number(year);
  if (department) filter.department = rx(department);
  if (employeeName && recordType === "items") {
    const employee = await resolveEmployeeByQuery(employeeName);
    if (!employee) return { found: false, note: "No matching employee was found." };
    filter.biometricId = employee.biometricId;
  }
  const Model = recordType === "runs" ? Payroll : PayrollItem;
  const rows = await Model.find(filter).sort({ year: -1, month: -1 }).limit(bounded(limit)).lean().catch(() => []);
  const safe = plain(rows).map((row) => {
    delete row.bankDetails;
    // The per-day audit trail can be large, so expose it only for a tightly
    // scoped employee/pay-period request. It is legitimate HR evidence, unlike
    // bank credentials, and therefore remains available through this switch.
    const scopedDayBreakdown = recordType === "items" && employeeName && month && year && includeDayBreakdown;
    if (!scopedDayBreakdown) delete row.dayBreakdown;
    return row;
  });
  return { found: true, recordType, count: safe.length, rows: stripAssistantSecrets(redactSecrets(safe)), truncated: safe.length >= bounded(limit) };
}

async function buildPerformanceContext({ employeeName, department, year, limit } = {}) {
  const yr = Number(year) || istNow().getUTCFullYear();
  const empFilter = { isActive: { $ne: false } };
  if (department) empFilter.department = rx(department);
  if (employeeName) {
    const employee = await resolveEmployeeByQuery(employeeName);
    if (!employee) return { found: false, note: "No matching employee was found." };
    empFilter._id = employee._id;
  }
  const employees = await Employee.find(empFilter).select("firstName middleName lastName biometricId department designation dateOfJoining sopPoints").limit(bounded(limit)).lean().catch(() => []);
  const bids = employees.map((e) => String(e.biometricId || "").toUpperCase()).filter(Boolean);
  const ids = employees.map((e) => e._id);
  const [attendance, balances] = await Promise.all([
    DailyAttendance.find({ dateStr: { $gte: `${yr}-01-01`, $lte: `${yr}-12-31` }, "employees.biometricId": { $in: bids } }).select("dateStr employees").lean().catch(() => []),
    LeaveBalance.find({ employeeId: { $in: ids }, year: yr }).lean().catch(() => []),
  ]);
  const stats = new Map(bids.map((id) => [id, blankStats()]));
  for (const doc of attendance) for (const entry of doc.employees || []) {
    const target = stats.get(String(entry.biometricId || "").toUpperCase());
    if (target) tallyEntry(target, entry);
  }
  const bal = new Map(balances.map((b) => [String(b.employeeId), b]));
  const rows = employees.map((e) => {
    const s = stats.get(String(e.biometricId || "").toUpperCase()) || blankStats();
    const decided = s.presentDays + s.absentDays + s.leaveDaysTotal;
    const ledger = (e.sopPoints || []).find((p) => Number(p.year) === yr);
    return {
      employee: fullName(e), employeeId: e.biometricId, department: e.department, designation: e.designation,
      tenureMonths: monthsBetween(e.dateOfJoining, new Date()), attendance: s,
      attendanceRate: decided ? Math.round((s.presentDays / decided) * 1000) / 10 : null,
      leaveBalance: plain(bal.get(String(e._id)) || null),
      sop: ledger ? { totalDeducted: ledger.totalDeducted, entries: ledger.bleaches || [] } : null,
    };
  });
  return { found: true, year: yr, count: rows.length, rows: stripAssistantSecrets(redactSecrets(rows)), truncated: rows.length >= bounded(limit) };
}

async function buildHrAuditContext({ employeeName, section, action, critical, from, to, limit } = {}) {
  const filter = { departmentSlug: "hr" };
  if (section) filter.section = rx(section);
  if (action) filter.action = action;
  if (typeof critical === "boolean") filter.critical = critical;
  if (employeeName) filter.entityLabel = rx(employeeName);
  const createdAt = {};
  if (iso(from)) createdAt.$gte = new Date(`${from}T00:00:00.000Z`);
  if (iso(to)) createdAt.$lte = new Date(`${to}T23:59:59.999Z`);
  if (Object.keys(createdAt).length) filter.createdAt = createdAt;
  const rows = await ChangeLog.find(filter).sort({ createdAt: -1 }).limit(bounded(limit)).lean().catch(() => []);
  return { found: true, count: rows.length, rows: stripAssistantSecrets(redactSecrets(plain(rows))), truncated: rows.length >= bounded(limit) };
}

module.exports = {
  buildFullEmployeeContext,
  buildAttendanceRecordsContext,
  buildAttendanceExclusionsContext,
  buildLeaveRecordsContext,
  buildRecruitmentContext,
  buildDocumentRecordsContext,
  buildPayrollRecordsContext,
  buildPerformanceContext,
  buildHrAuditContext,
  _stripAssistantSecrets: stripAssistantSecrets,
};
