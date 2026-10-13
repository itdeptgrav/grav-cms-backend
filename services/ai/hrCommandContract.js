"use strict";
/**
 * services/ai/hrCommandContract.js — what HR's Cmd/Ctrl K can name, in the
 * words HR uses, and what it may show.
 *
 * ── EVERY FAMILY CARRIES THE CAPABILITY ITS OWN SCREEN NEEDS ─────────────
 * HR is guarded capability by capability (services/access/hrCapabilities.js),
 * and the palette asks for exactly what the matching endpoint declares in
 * services/access/hrRouteContract.js: the employee directory needs
 * `people.read.directory`, leave needs `leave.read`, and so on. A family the
 * person's role does not hold is never read — not filtered after reading.
 *
 * ── WHAT IT NEVER SHOWS ───────────────────────────────────────────────────
 * Only DIRECTORY fields of a person (services/access/hrFieldPolicy.js) —
 * never pay, bank details, statutory ids (Aadhaar, PAN, UAN…), personal phone
 * or email, address, date of birth, family, medical, photos or credentials,
 * whatever the role. The projections below are allow-lists, so a field not
 * named here is not even read. Pay is not in Cmd/Ctrl K at all: a payroll run
 * is shown by period and status, never by amount; payslips and salaries stay
 * on their own screens. The owner can widen this; the palette will not
 * decide it.
 */

const { CAPABILITIES: CAP } = require("../access/hrCapabilities");
const { FORMAT } = require("./commandSearch/cards");

const { text, date, number, words } = FORMAT;

/* ── FAMILIES ──────────────────────────────────────────────────────────── */
const FAMILIES = Object.freeze([
  { id: "employee", label: "employee", capability: CAP.PEOPLE_READ_DIRECTORY,
    names: ["employee", "employees", "staff", "staff member", "people", "person", "worker", "workers", "team member", "headcount", "intern", "trainee", "joiner", "joinee", "new joiner", "new joinee"] },
  { id: "department", label: "department", capability: CAP.PEOPLE_READ_DIRECTORY, names: ["department", "dept"] },
  { id: "designation", label: "designation", capability: CAP.PEOPLE_READ_DIRECTORY, names: ["designation", "job role"] },
  { id: "job", label: "job opening", capability: CAP.RECRUITMENT_READ,
    names: ["job", "job opening", "job posting", "opening", "vacancy", "vacancies", "position", "requirement"] },
  { id: "candidate", label: "candidate", capability: CAP.RECRUITMENT_READ, names: ["candidate", "applicant", "application for job"] },
  { id: "interview", label: "interview", capability: CAP.RECRUITMENT_READ, names: ["interview"] },
  { id: "leave", label: "leave request", capability: CAP.LEAVE_READ,
    names: ["leave", "leave request", "leave application", "time off", "vacation", "day off", "days off"] },
  { id: "leave_balance", label: "leave balance", capability: CAP.LEAVE_READ, names: ["leave balance", "leaves left", "leave left", "balance leave", "leaves remaining"] },
  { id: "holiday", label: "holiday", capability: CAP.LEAVE_READ, names: ["holiday", "company holiday"] },
  { id: "attendance", label: "attendance", capability: CAP.ATTENDANCE_READ, names: ["attendance", "timecard", "time card", "punch", "punches"] },
  { id: "correction", label: "attendance correction", capability: CAP.ATTENDANCE_READ,
    names: ["attendance correction", "correction", "regularization", "regularisation", "regularization request", "regularisation request", "miss punch request", "missed punch request"] },
  { id: "overtime", label: "overtime report", capability: CAP.ATTENDANCE_READ, names: ["overtime", "overtime report", "ot"] },
  { id: "document", label: "letter", capability: CAP.DOCUMENTS_READ,
    names: ["letter", "document", "hr document", "document request", "letter request"] },
  { id: "payroll", label: "payroll run", capability: CAP.PAYROLL_READ, names: ["payroll", "payroll run", "salary run"] },
  { id: "policy", label: "policy", capability: CAP.COMPLIANCE_READ, names: ["policy", "policies", "c4 policy", "conduct policy"] },
]);
const familyById = (id) => FAMILIES.find((f) => f.id === id) || null;

/* ── ATTENDANCE — the same buckets the daily attendance page uses ──────────
   (services/dailyAttendanceContext.js STATUS_FILTERS). A day's status is
   HR's final status where HR has set one, the system's prediction where not. */
const ATTENDANCE_BUCKETS = Object.freeze([
  { id: "present", label: "present", codes: ["P", "P*", "P~"], names: ["present", "came", "in office", "attended"] },
  { id: "late", label: "late", codes: ["P*"], names: ["late", "came late", "late comer", "latecomer"] },
  { id: "absent", label: "absent", codes: ["AB", "LAB", "EAB"], names: ["absent", "absentee", "did not come", "didn't come", "not come", "no show", "missing", "not present", "not in office"] },
  { id: "half_day", label: "on a half day", codes: ["HD", "LHD"], names: ["half day", "half-day", "halfday"] },
  { id: "on_leave", label: "on leave", codes: ["L-CL", "L-SL", "L-EL", "LWP", "CO"], names: ["on leave", "off on leave"] },
  { id: "wfh", label: "working from home", codes: ["WFH"], names: ["work from home", "working from home", "wfh"] },
  { id: "miss_punch", label: "missing a punch", codes: ["MP"], names: ["missed punch", "miss punch", "missing punch", "missed a punch"] },
  { id: "off", label: "off (weekly off or holiday)", codes: ["WO", "FH", "NH", "OH", "RH", "PH"], names: ["weekly off", "week off", "weekoff", "on holiday"] },
]);
const STATUS_WORD = {
  P: "present", "P*": "present, arrived late", "P~": "present", MP: "present, missed a punch",
  AB: "absent", LAB: "absent (late count)", EAB: "absent (early-out count)",
  HD: "half day", LHD: "half day (late count)",
  WO: "weekly off", FH: "holiday", NH: "holiday", OH: "holiday", RH: "holiday", PH: "holiday",
  "L-CL": "on casual leave", "L-SL": "on sick leave", "L-EL": "on earned leave", LWP: "on unpaid leave",
  CO: "on comp-off", WFH: "working from home",
  "P/CL": "present half, casual leave half", "P/SL": "present half, sick leave half", "P/PL": "present half, privilege leave half", "P/LWP": "present half, unpaid half",
};
const dayStatus = (row) => (row ? (row.hrFinalStatus || row.systemPrediction || null) : null);

/* ── STATUSES PER FAMILY — recorded values, in the words people say ────────
   "pending" is everything still awaiting a decision (the manager's or HR's)
   — the leave page's own queue (Leave_section: pending + manager_approved). */
const DECISION_STATUSES = Object.freeze([
  { status: ["pending", "manager_approved", "withdraw_pending"], label: "pending", names: ["pending", "open", "awaiting", "awaiting approval", "to approve", "not approved yet"] },
  { status: ["pending"], label: "awaiting the manager", names: ["awaiting manager", "pending with manager", "with manager"] },
  { status: ["manager_approved"], label: "approved by the manager, awaiting HR", names: ["manager approved", "awaiting hr", "pending with hr", "with hr"] },
  { status: ["hr_approved"], label: "approved", names: ["approved", "hr approved", "granted", "sanctioned"] },
  { status: ["manager_rejected", "hr_rejected"], label: "rejected", names: ["rejected", "declined", "refused", "denied"] },
  { status: ["cancelled"], label: "cancelled", names: ["cancelled", "canceled", "withdrawn"] },
]);
const OVERTIME_STATUSES = Object.freeze([
  { status: ["pending", "manager_approved"], label: "pending", names: ["pending", "awaiting", "awaiting approval", "to approve"] },
  { status: ["hr_approved"], label: "approved", names: ["approved", "hr approved"] },
  { status: ["manager_rejected", "hr_rejected"], label: "rejected", names: ["rejected", "declined"] },
  { status: ["expired"], label: "expired", names: ["expired", "lapsed"] },
]);
const LEAVE_TYPES = Object.freeze([
  { type: "CL", label: "casual leave", names: ["casual", "casual leave", "cl"] },
  { type: "SL", label: "sick leave", names: ["sick", "sick leave", "sl", "medical leave"] },
  { type: "PL", label: "privilege leave", names: ["privilege", "privilege leave", "pl", "earned leave", "el", "paid leave"] },
  { type: "LOP", label: "loss-of-pay leave", names: ["lop", "loss of pay", "unpaid leave", "lwp", "leave without pay"] },
  { type: "QUICK", label: "quick leave", names: ["quick leave", "quick"] },
]);
const CORRECTION_TYPES = Object.freeze([
  { type: "miss_punch", label: "missed punch", names: ["miss punch", "missed punch"] },
  { type: "wrong_status", label: "wrong status", names: ["wrong status"] },
  { type: "forgot_punch", label: "forgot to punch", names: ["forgot punch", "forgot to punch", "forgot"] },
  { type: "client_visit", label: "client visit", names: ["client visit", "field visit"] },
]);
const EMPLOYEE_STATUSES = Object.freeze([
  { status: "active", label: "active", names: ["active", "current", "working", "serving"] },
  { status: "inactive", label: "inactive", names: ["inactive", "former", "left", "exited", "ex", "resigned", "relieved", "terminated"] },
]);
const EMPLOYMENT_TYPES = Object.freeze([
  { type: "intern", label: "intern", names: ["intern", "interns", "trainee", "internship"] },
  { type: "contract", label: "contract", names: ["contract", "contractual", "on contract"] },
  { type: "part_time", label: "part-time", names: ["part time", "part-time", "parttime"] },
  { type: "full_time", label: "full-time", names: ["full time", "full-time", "fulltime", "permanent"] },
]);
const JOB_STATUSES = Object.freeze([
  { status: ["published"], label: "published", names: ["published", "live", "open", "active", "accepting"] },
  { status: ["draft"], label: "draft", names: ["draft", "unpublished"] },
  { status: ["closed"], label: "closed", names: ["closed", "filled"] },
  { status: ["archived"], label: "archived", names: ["archived"] },
]);
const CANDIDATE_STAGES = Object.freeze([
  { stage: "screening", label: "in screening", names: ["screening", "screened", "new"] },
  { stage: "technical_interview", label: "in the technical interview", names: ["technical interview", "technical round", "technical"] },
  { stage: "hr_interview", label: "in the HR interview", names: ["hr interview", "hr round"] },
  { stage: "training", label: "in training", names: ["training", "in training"] },
  { stage: "hired", label: "hired", names: ["hired", "selected", "joined"] },
  { stage: "rejected", label: "rejected", names: ["rejected", "not selected"] },
]);
const INTERVIEW_STATUSES = Object.freeze([
  { status: ["scheduled", "rescheduled"], label: "scheduled", names: ["scheduled", "upcoming", "rescheduled"] },
  { status: ["completed"], label: "completed", names: ["completed", "done", "finished"] },
  { status: ["cancelled"], label: "cancelled", names: ["cancelled", "canceled"] },
]);
const DOCUMENT_TYPES = Object.freeze([
  { type: "appointment", label: "appointment letter", names: ["appointment", "appointment letter"] },
  { type: "offer", label: "offer letter", names: ["offer", "offer letter"] },
  { type: "warning", label: "warning letter", names: ["warning", "warning letter"] },
  { type: "experience", label: "experience letter", names: ["experience", "experience letter", "experience certificate"] },
  { type: "relieving", label: "relieving letter", names: ["relieving", "relieving letter"] },
  { type: "salary_certificate", label: "salary certificate", names: ["salary certificate", "salary letter"] },
]);
const DOCUMENT_STATUSES = Object.freeze([
  { filter: { requestStatus: "requested" }, label: "requested, not yet issued", names: ["requested", "pending", "awaiting", "to issue"] },
  { filter: { released: true, revokedAt: null }, label: "released", names: ["released", "issued", "available"] },
  { filter: { requestStatus: "declined" }, label: "declined", names: ["declined", "rejected"] },
  { filter: { revokedAt: { $ne: null } }, label: "withdrawn", names: ["withdrawn", "revoked"] },
]);
const PAYROLL_STATUSES = Object.freeze([
  { status: ["draft", "processing", "processed"], label: "not yet approved", names: ["pending", "draft", "in progress", "processing", "processed", "not approved"] },
  { status: ["approved"], label: "approved", names: ["approved"] },
  { status: ["paid"], label: "paid", names: ["paid", "disbursed"] },
  { status: ["cancelled"], label: "cancelled", names: ["cancelled"] },
]);

/* ── WHERE A RECORD OPENS ──────────────────────────────────────────────────
   Every HR record page takes the record's Mongo `_id`. Records with no page
   of their own open the list that holds them. */
const HR_RECORD_ROUTES = Object.freeze({
  employee: (id) => `/hr/dashboard/employees/${id}`,
  department: (id) => `/hr/dashboard/departments/${id}`,
  job: (id) => `/hr/dashboard/recruitment/${id}`,
});
const HR_LIST_ROUTES = Object.freeze({
  leave: "/hr/dashboard/leaves",
  holiday: "/hr/dashboard/leaves",
  attendance: "/hr/dashboard/attendance/daily",
  correction: "/hr/dashboard/attendance/regularizations",
  overtime: "/hr/dashboard/history",
  document: "/hr/dashboard/documents",
  document_request: "/hr/dashboard/documents/requests",
  payroll: "/hr/dashboard/payroll",
  policy: "/hr/dashboard/sop/policies",
  recruitment: "/hr/dashboard/recruitment",
  employees: "/hr/dashboard/employees",
  departments: "/hr/dashboard/departments",
});

/* ── WHAT IS READ — allow-lists, so an unlisted field is never fetched ──── */
const PROJECTIONS = Object.freeze({
  employee: "_id firstName middleName lastName nickName biometricId identityId email workPhone department departmentId designation jobTitle employmentType dateOfJoining status isActive primaryManager.managerId primaryManager.managerName workLocation",
  department: "_id name status description designations.name designations.isActive primaryManager.managerName primaryManager.designation",
  job: "_id jobTitle jobLocation jobType jobMode status lastDate publishedAt closedAt hiringManager.departmentId",
  candidate: "_id name jobTitle jobPostingId stage status appliedDate",
  interview: "_id title type status scheduledDate scheduledTime interviewStage interviewType candidateId jobPostingId departmentName",
  leave: "_id employeeId biometricId employeeName leaveType fromDate toDate totalDays status applicationDate",
  leave_balance: "_id employeeId biometricId year entitlement consumed",
  holiday: "_id name date type",
  correction: "_id employeeId biometricId employeeName dateStr type requestedStatus status",
  overtime: "_id employeeId biometricId employeeName department dateStr actualOutTime stayOverMins status",
  document: "_id employeeId biometricId employeeName type otherTypeLabel title requestStatus requestedAt generated generatedAt released releasedAt revokedAt letterMeta.referenceNo createdAt",
  payroll: "_id month year payPeriod status totalEmployees approvedAt processedAt",
  policy: "_id name category points bleachType scope departmentName departmentNames triggerKey isActive",
});

/* Never read, never shown — the reason each is held back. Pinned by test. */
const NEVER_SHOWN = Object.freeze({
  "Employee.salary / bankDetails": "pay — compensation stays on its own screens",
  "Employee.documents.* numbers": "statutory identifiers (Aadhaar, PAN, UAN, passport…)",
  "Employee.phone / alternatePhone / personalEmail / address / dateOfBirth / family": "private contact and personal details",
  "Employee.bloodGroup / isPhysicallyChallenged": "medical",
  "Employee.password / temporaryPassword / pushToken / fcmToken": "credentials",
  "PayrollItem.*": "per-person pay",
  "Payroll.total*": "the company pay bill",
  "Candidate.email / phone / expectedSalary / resumeUrl": "an applicant's private details",
  "JobPosting.salaryRange": "pay",
  "LeaveApplication.reason / documentUrl": "may be medical",
  "EmployeeDocument.letterMeta.annualCTC / hrNotes / file": "pay and HR's private notes",
});

const fullName = (e) => [e?.firstName, e?.middleName, e?.lastName].filter(Boolean).join(" ").trim() || text(e?.nickName) || null;
const docLabel = (d) => text(d?.title) || (d?.type === "other" ? text(d?.otherTypeLabel) : null)
  || DOCUMENT_TYPES.find((t) => t.type === d?.type)?.label?.replace(/^./, (c) => c.toUpperCase()) || "Letter";
const docState = (d) => {
  if (d?.revokedAt) return "Withdrawn";
  if (d?.released) return "Released";
  if (d?.requestStatus === "requested") return "Requested";
  if (d?.requestStatus === "declined") return "Declined";
  if (d?.requestStatus === "cancelled") return "Cancelled";
  if (d?.generated) return "Generated, not released";
  return "Draft";
};

/* ── CARDS — the facts that matter about one record ─────────────────────── */
const CARDS = Object.freeze({
  employee: {
    title: (r) => fullName(r),
    status: (r) => (r.isActive === false || r.status === "inactive" ? "Inactive" : "Active"),
    facts: (r) => [
      ["Employee ID", text(r.biometricId)],
      ["Department", text(r.department)],
      ["Designation", text(r.designation || r.jobTitle)],
      ["Reports to", text(r.primaryManager?.managerName)],
      ["Joined", date(r.dateOfJoining)],
      ["Type", words(r.employmentType)],
      ["Work email", text(r.email)],
      ["Work phone", text(r.workPhone)],
    ],
  },
  department: {
    title: (r) => r.name,
    status: (r) => words(r.status),
    facts: (r, extra) => [
      ["Employees", number(extra.employees)],
      ["Head", text([r.primaryManager?.managerName, r.primaryManager?.designation].filter(Boolean).join(", "))],
      ["Designations", Array.isArray(r.designations) ? String(r.designations.filter((d) => d.isActive !== false).length) : null],
      ["About", text(r.description)],
    ],
  },
  job: {
    title: (r) => r.jobTitle,
    status: (r) => words(r.status),
    facts: (r, extra) => [
      ["Candidates", number(extra.candidates)],
      ["Location", text(r.jobLocation)],
      ["Type", words(r.jobType)],
      ["Mode", words(r.jobMode)],
      ["Apply by", date(r.lastDate)],
      ["Published", date(r.publishedAt)],
    ],
  },
  candidate: {
    title: (r) => r.name,
    status: (r) => words(r.stage),
    facts: (r) => [
      ["For", text(r.jobTitle)],
      ["Stage", words(r.stage)],
      ["Applied", date(r.appliedDate)],
      ["Status", words(r.status)],
    ],
  },
});

module.exports = {
  FAMILIES, familyById,
  ATTENDANCE_BUCKETS, STATUS_WORD, dayStatus,
  DECISION_STATUSES, OVERTIME_STATUSES, LEAVE_TYPES, CORRECTION_TYPES,
  EMPLOYEE_STATUSES, EMPLOYMENT_TYPES, JOB_STATUSES, CANDIDATE_STAGES, INTERVIEW_STATUSES,
  DOCUMENT_TYPES, DOCUMENT_STATUSES, PAYROLL_STATUSES,
  HR_RECORD_ROUTES, HR_LIST_ROUTES, PROJECTIONS, NEVER_SHOWN, CARDS,
  fullName, docLabel, docState,
};
