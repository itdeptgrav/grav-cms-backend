// services/auditSections.js
//
// The vocabulary the change log speaks: which SCREEN a change belongs to, and
// what that screen calls each field.
//
// WHY SECTIONS ARE A FIXED LIST RATHER THAN A FREE STRING
// ------------------------------------------------------
// Every HR page shows its own history, and a page has to be able to ask for
// "my" entries without knowing how the route that wrote them was spelled. If
// each route invented its own key, two routes that write the same page's data
// (attendance is written by four) would file their entries under two different
// histories and each page would show half its story. So the keys live here,
// once, and a route names one — a typo is then a missing section in the list
// rather than a silently split history.
//
// It also makes the section PICKER possible: the history page lists sections
// from this file, not from a distinct() over a collection that would only ever
// show sections somebody has already changed something in.
//
// WHY LABELS ARE RESOLVED AT WRITE TIME
// -------------------------------------
// The label is stored on the log row, not looked up when it is read. A field
// renamed next year must not silently rewrite what last year's history says
// happened — the entry is a record of an event, and the words are part of it.

"use strict";

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

/**
 * key      — stored on every log row; "<department>:<page>"
 * label    — what the history header calls it
 * group    — how the section picker groups them, mirroring the HR nav
 * href     — the page it belongs to, so history can link back to the source
 * entities — the entity names routes in this section write, used by the
 *            section picker to explain what it covers
 */
const SECTIONS = [
  // People
  { key: "hr:employees", label: "Employees", group: "People", href: "/hr/dashboard/employees", entities: ["employee"] },
  { key: "hr:employee-import", label: "Employee import & export", group: "People", href: "/hr/dashboard/employees/import", entities: ["employee-import"] },
  { key: "hr:departments", label: "Departments", group: "People", href: "/hr/dashboard/departments", entities: ["department"] },
  { key: "hr:teams", label: "Team structure", group: "People", href: "/hr/dashboard/teams", entities: ["team"] },
  { key: "hr:recruitment", label: "Recruitment", group: "People", href: "/hr/dashboard/recruitment", entities: ["job-posting", "candidate"] },
  { key: "hr:tasks", label: "Employee tasks", group: "People", href: "/hr/dashboard/employees", entities: ["employee-task"] },
  { key: "hr:profile", label: "HR profile", group: "People", href: "/hr/dashboard/profile", entities: ["hr-profile"] },

  // Time
  { key: "hr:attendance", label: "Attendance overview", group: "Time", href: "/hr/dashboard/attendance", entities: ["attendance"] },
  { key: "hr:attendance-daily", label: "Daily attendance", group: "Time", href: "/hr/dashboard/attendance/daily", entities: ["attendance-day", "attendance-punch"] },
  { key: "hr:attendance-muster", label: "Muster roll", group: "Time", href: "/hr/dashboard/attendance/muster-roll", entities: ["attendance-day"] },
  { key: "hr:attendance-timecard", label: "Timecard", group: "Time", href: "/hr/dashboard/attendance/timecard", entities: ["attendance-day"] },
  { key: "hr:attendance-reports", label: "Attendance reports", group: "Time", href: "/hr/dashboard/attendance/reports", entities: ["attendance-report"] },
  { key: "hr:attendance-shifts", label: "Shifts", group: "Time", href: "/hr/dashboard/attendance/shifts", entities: ["shift", "shift-assignment"] },
  { key: "hr:attendance-settings", label: "Attendance settings", group: "Time", href: "/hr/dashboard/attendance/settings", entities: ["attendance-setting", "holiday"] },
  { key: "hr:attendance-regularizations", label: "Regularisations", group: "Time", href: "/hr/dashboard/attendance/regularizations", entities: ["regularization"] },
  { key: "hr:shift-swaps", label: "Shift swaps", group: "Time", href: "/hr/dashboard/attendance/shifts", entities: ["shift-swap"] },
  // Overtime is raised in the app and decided by a manager, so nobody in HR
  // ever touches it — which is precisely why it needed a history. Filed under
  // Time with attendance and regularisations, because the three of them are the
  // same question about the same day.
  { key: "hr:overtime", label: "Overtime", group: "Time", href: "/hr/dashboard/attendance", entities: ["overtime"] },
  { key: "hr:leaves", label: "Leaves", group: "Time", href: "/hr/dashboard/leaves", entities: ["leave", "leave-policy", "leave-balance"] },

  // Pay & policy
  { key: "hr:payroll", label: "Payroll", group: "Pay & policy", href: "/hr/dashboard/payroll", entities: ["payroll-run", "payroll-record"] },
  { key: "hr:payroll-payslip", label: "Payslips", group: "Pay & policy", href: "/hr/dashboard/payroll/payslip", entities: ["payslip"] },
  { key: "hr:payroll-settings", label: "Payroll settings", group: "Pay & policy", href: "/hr/dashboard/payroll/settings", entities: ["payroll-setting", "salary-component"] },
  { key: "hr:salary-config", label: "Salary configuration", group: "Pay & policy", href: "/hr/dashboard/settings/salary-config", entities: ["salary-config"] },
  { key: "hr:sop", label: "SOP point deductions", group: "Pay & policy", href: "/hr/dashboard/sop", entities: ["sop-deduction", "sop-run"] },
  { key: "hr:policies", label: "Policies", group: "Pay & policy", href: "/hr/dashboard/sop/policies", entities: ["policy", "policy-rule"] },

  // Records
  { key: "hr:documents", label: "Employee documents", group: "Records", href: "/hr/dashboard/documents", entities: ["employee-document", "document-request"] },
  { key: "hr:performance", label: "Performance", group: "Records", href: "/hr/dashboard/performance", entities: ["performance-review"] },
  { key: "hr:vendors", label: "Vendors", group: "Records", href: "/hr/dashboard/vendors", entities: ["vendor"] },

  // Admin
  { key: "hr:security", label: "Password management", group: "Admin", href: "/hr/dashboard/Passwordmanagement", entities: ["credential"] },
  { key: "hr:app-version", label: "App version", group: "Admin", href: "/hr/dashboard", entities: ["app-version"] },
  { key: "hr:access", label: "Roles & access", group: "Admin", href: "/hr/dashboard/history", entities: ["department-role"] },
];

const BY_KEY = new Map(SECTIONS.map((s) => [s.key, s]));

/** The label for a section key, or the key itself if it is not a known one. */
function sectionLabel(key) {
  return BY_KEY.get(key)?.label || String(key || "");
}

/** Every section in one department, in nav order. */
function sectionsFor(departmentSlug) {
  const prefix = `${String(departmentSlug || "").toLowerCase()}:`;
  return SECTIONS.filter((s) => s.key.startsWith(prefix));
}

/* ------------------------------------------------------------------ */
/* Path → section                                                      */
/* ------------------------------------------------------------------ */

/**
 * Which page an API path belongs to.
 *
 * Routes name their own section when they log, and that is always better —
 * a route knows things a path cannot. This exists for the two places that have
 * only a URL to go on: the mount-level write guard (which holds an editor's
 * change before any route has run) and the approval queue (which shows a
 * request that has not been applied and so has no log entry yet). Without it a
 * held change is filed under no section at all and vanishes from the very page
 * whose history is supposed to show it was submitted.
 *
 * ORDER MATTERS: first match wins, and the specific patterns are listed before
 * the general ones. `/hr/attendance/shifts` is the shifts page; `/hr/attendance`
 * on its own is the overview.
 */
const PATH_SECTIONS = [
  [/^\/api\/employees\/(import|export|bulk)/i, "hr:employee-import", "employee-import"],
  [/^\/api\/employees\/[^/]+\/documents/i, "hr:documents", "employee-document"],
  [/^\/api\/employees/i, "hr:employees", "employee"],
  [/^\/api\/hr\/departments/i, "hr:departments", "department"],
  [/^\/api\/hr\/(job-postings|candidates)/i, "hr:recruitment", "candidate"],
  [/^\/api\/hr\/tasks/i, "hr:tasks", "employee-task"],
  [/^\/api\/hr\/payroll\/(settings|components|structure)/i, "hr:payroll-settings", "payroll-setting"],
  [/^\/api\/hr\/payroll/i, "hr:payroll", "payroll-run"],
  [/^\/api\/hr\/payslip/i, "hr:payroll-payslip", "payslip"],
  [/^\/api\/hr\/leaves/i, "hr:leaves", "leave"],
  [/^\/api\/hr\/policy/i, "hr:policies", "policy"],
  [/^\/api\/hr\/sop/i, "hr:sop", "sop-deduction"],
  [/^\/api\/hr\/documents/i, "hr:documents", "employee-document"],
  [/^\/api\/hr\/password-management/i, "hr:security", "credential"],
  [/^\/api\/hr\/app/i, "hr:app-version", "app-version"],
  [/^\/api\/hr\/vendors/i, "hr:vendors", "vendor"],
  [/^\/api\/hr\/overview/i, "hr:employees", "employee"],
  [/^\/hr\/attendance\/(shifts?|shift-)/i, "hr:attendance-shifts", "shift"],
  [/^\/hr\/attendance\/(settings|holidays?|config)/i, "hr:attendance-settings", "attendance-setting"],
  [/^\/hr\/attendance\/regulari/i, "hr:attendance-regularizations", "regularization"],
  [/^\/hr\/attendance\/(daily|day-override|bulk-day-override|punch)/i, "hr:attendance-daily", "attendance-day"],
  [/^\/hr\/attendance\/muster/i, "hr:attendance-muster", "attendance-day"],
  [/^\/hr\/attendance\/(timecard|time-card)/i, "hr:attendance-timecard", "attendance-day"],
  [/^\/hr\/attendance/i, "hr:attendance", "attendance"],
  [/^\/hr\/shift-swaps/i, "hr:shift-swaps", "shift-swap"],
  [/^\/hr\/reports/i, "hr:attendance-reports", "attendance-report"],
  [/^\/hr\/performance/i, "hr:performance", "performance-review"],
  [/^\/api\/hr\/profile/i, "hr:profile", "hr-profile"],
  [/^\/api\/admin\/department-roles/i, "hr:access", "department-role"],

  // Raised from the mobile app rather than from HR, but they are HR facts: an
  // overtime grace and a regularisation both change what a day's attendance
  // says, and the person asking "why is this day marked present" is in HR.
  [/^\/api\/employee\/overtime/i, "hr:overtime", "overtime"],
  [/^\/api\/employee\/regularizations/i, "hr:attendance-regularizations", "regularization"],
];

/**
 * @returns {{ section: string, entity: string }|null}
 */
function sectionForPath(path) {
  const p = String(path || "").split("?")[0];
  for (const [rx, section, entity] of PATH_SECTIONS) {
    if (rx.test(p)) return { section, entity };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Field labels                                                        */
/* ------------------------------------------------------------------ */

/**
 * What a field is called on screen.
 *
 * COMMON holds names that mean the same thing everywhere. A section may
 * override any of them in BY_SECTION when its screen uses a different word —
 * `status` is "Employment status" on the employee form and "Approval status" in
 * the leave queue, and a history that calls both "Status" is a history that
 * makes the reader open the record to find out what it meant.
 */
const COMMON = {
  name: "Name",
  fullName: "Full name",
  firstName: "First name",
  lastName: "Last name",
  email: "Email",
  phone: "Phone",
  mobile: "Mobile",
  address: "Address",
  city: "City",
  state: "State",
  pincode: "PIN code",
  country: "Country",
  status: "Status",
  isActive: "Active",
  active: "Active",
  notes: "Notes",
  remarks: "Remarks",
  description: "Description",
  title: "Title",
  code: "Code",
  type: "Type",
  category: "Category",
  date: "Date",
  startDate: "Start date",
  endDate: "End date",
  fromDate: "From date",
  toDate: "To date",
  reason: "Reason",
  department: "Department",
  departmentId: "Department",
  designation: "Designation",
  jobTitle: "Job title",
  employeeId: "Employee",
  employeeCode: "Employee code",
  createdAt: "Created",
  updatedAt: "Updated",
  attachments: "Attachments",
  documentUrl: "Document",
  approvedBy: "Approved by",
  approvedAt: "Approved on",
  rejectedBy: "Rejected by",
  order: "Display order",
  sortOrder: "Display order",
};

const BY_SECTION = {
  "hr:employees": {
    status: "Employment status",
    grossPay: "Gross salary",
    ctc: "CTC",
    basicSalary: "Basic salary",
    primaryManager: "Primary manager",
    secondaryManager: "Secondary manager",
    biometricId: "Biometric ID",
    dateOfJoining: "Date of joining",
    dateOfBirth: "Date of birth",
    dateOfLeaving: "Date of leaving",
    employeeType: "Employee type",
    workLocation: "Work location",
    shift: "Shift",
    bloodGroup: "Blood group",
    emergencyContact: "Emergency contact",
    probationEndDate: "Probation ends",
    confirmationDate: "Confirmation date",
    reportingTo: "Reports to",
    uanNumber: "UAN number",
    esicNumber: "ESIC number",
    pfNumber: "PF number",
    role: "System role",
    accessDepartmentId: "Access department",
    additionalDepartmentIds: "Additional departments",

    // The pay figures a person actually types. Keyed by the full path AND by
    // the leaf, because `gross` on its own is ambiguous elsewhere but means
    // exactly one thing under `salary`.
    "salary.gross": "Gross salary",
    "salary.basic": "Basic",
    "salary.hra": "HRA",
    "salary.specialAllowance": "Special allowance",
    "salary.stipend": "Stipend",

    // Now that the whole record is diffed rather than nine fields, these are
    // reachable and need names people recognise from the form.
    nickName: "Nick name",
    alternatePhone: "Alternate phone",
    workPhone: "Work phone",
    personalEmail: "Personal email",
    maritalStatus: "Marital status",
    marriageDate: "Marriage date",
    spouseName: "Spouse name",
    fatherFirstName: "Father's first name",
    fatherLastName: "Father's last name",
    motherFirstName: "Mother's first name",
    motherLastName: "Mother's last name",
    nationality: "Nationality",
    identityId: "Identity ID",
    jobPosition: "Job position",
    probationPeriod: "Probation period",
    workShift: "Work shift",
    isDirector: "Director",
    isInternational: "International employee",
    isPhysicallyChallenged: "Physically challenged",
    needsToOperate: "Needs machine access",
    "bankDetails.accountHolderName": "Account holder name",
    "bankDetails.bankName": "Bank name",
    "bankDetails.branchName": "Bank branch",
    "address.line1": "Address line 1",
    "address.line2": "Address line 2",
    "documents.aadharFile": "Aadhaar document",
    "documents.panFile": "PAN document",
    "documents.resumeFile": "Résumé",
    "internship.startDate": "Internship start",
    "internship.endDate": "Internship end",
    "internship.stipendType": "Stipend type",
  },
  "hr:departments": {
    name: "Department name",
    head: "Department head",
    headId: "Department head",
    parentId: "Parent department",
    budget: "Budget",
  },
  "hr:recruitment": {
    status: "Pipeline stage",
    stage: "Pipeline stage",
    position: "Position",
    openings: "Openings",
    experience: "Experience",
    expectedSalary: "Expected salary",
    resumeUrl: "Résumé",
    interviewDate: "Interview date",
    source: "Source",
  },
  "hr:attendance-daily": {
    status: "Attendance status",
    effectiveStatus: "Attendance status",
    inTime: "In time",
    outTime: "Out time",
    finalOut: "Out time",
    rawPunches: "Punches",
    punches: "Punches",
    overtimeMinutes: "Overtime",
    lateMinutes: "Late by",
    workedMinutes: "Hours worked",
    hrReviewedBy: "Reviewed by",
    hrRemarks: "HR remarks",
    isHoliday: "Holiday",
    shiftId: "Shift",
  },
  "hr:attendance-settings": {
    graceMinutes: "Grace period",
    halfDayMinutes: "Half-day threshold",
    fullDayMinutes: "Full-day threshold",
    weekOff: "Weekly off",
    autoSync: "Automatic sync",
    lockAfterDays: "Lock after",
  },
  "hr:attendance-regularizations": {
    status: "Request status",
    requestedIn: "Requested in time",
    requestedOut: "Requested out time",
    hrRemarks: "HR remarks",
  },
  "hr:attendance-shifts": {
    startTime: "Shift start",
    endTime: "Shift end",
    breakMinutes: "Break",
    graceMinutes: "Grace period",
  },
  "hr:overtime": {
    dateStr: "Worked late on",
    nextDateStr: "Grace applies to",
    scheduledOutTime: "Scheduled out",
    actualOutTime: "Actually left at",
    stayOverMins: "Extra minutes worked",
    graceMinutes: "Grace granted",
    adjustedReportTime: "May report by",
    description: "What they did",
    status: "Request status",
    approvalRemarks: "Approver's remarks",
    rejectionReason: "Reason for rejection",
    graceApplied: "Grace applied to attendance",
    approvedByName: "Approved by",
    documentUrl: "Proof",
  },
  "hr:shift-swaps": {
    status: "Request status",
    fromEmployee: "Requested by",
    toEmployee: "Swapping with",
    swapDate: "Swap date",
  },
  "hr:leaves": {
    status: "Approval status",
    leaveType: "Leave type",
    days: "Days",
    halfDay: "Half day",
    managerStatus: "Manager decision",
    hrStatus: "HR decision",
    hrApprovedByName: "Approved by",
    balance: "Balance",
    opening: "Opening balance",
    accrued: "Accrued",
    used: "Used",
    carryForward: "Carry forward",
  },
  "hr:payroll": {
    status: "Run status",
    month: "Payroll month",
    year: "Payroll year",
    grossPay: "Gross pay",
    netPay: "Net pay",
    deductions: "Deductions",
    earnings: "Earnings",
    lopDays: "Loss-of-pay days",
    paidDays: "Paid days",
    pf: "Provident fund",
    esi: "ESI",
    tds: "TDS",
    professionalTax: "Professional tax",
    advance: "Advance",
    bonus: "Bonus",
  },
  "hr:payroll-settings": {
    componentType: "Component type",
    formula: "Formula",
    taxable: "Taxable",
    percentage: "Percentage",
    fixedAmount: "Fixed amount",
  },
  "hr:sop": {
    points: "Points",
    deduction: "Deduction",
    ruleCode: "Rule",
    appliedOn: "Applied on",
  },
  "hr:policies": {
    version: "Version",
    effectiveFrom: "Effective from",
    body: "Policy text",
    content: "Policy text",
    acknowledgementRequired: "Acknowledgement required",
  },
  "hr:documents": {
    documentType: "Document type",
    issuedOn: "Issued on",
    validTill: "Valid till",
    fileUrl: "File",
  },
  "hr:performance": {
    rating: "Rating",
    score: "Score",
    period: "Review period",
    reviewer: "Reviewer",
    goals: "Goals",
  },
  "hr:security": {
    password: "Password",
    role: "Role",
    lastResetAt: "Last reset",
  },
};

/**
 * Turn a dotted path into something readable.
 *
 * Tries the exact path first ("summary.presentCount"), then the leaf
 * ("presentCount"), so a labelled leaf keeps its label wherever it is nested.
 * Falls back to de-camel-casing, which is right often enough to be better than
 * printing the raw key and never claims more than it knows.
 */
function fieldLabel(section, path) {
  const p = String(path || "");
  const table = { ...COMMON, ...(BY_SECTION[section] || {}) };
  if (table[p]) return table[p];

  const leaf = p.split(".").filter((seg) => !/^\d+$/.test(seg)).pop() || p;
  if (table[leaf]) return table[leaf];

  const words = leaf
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  if (!words) return p;

  // Array indices carry real meaning ("Punches #2"), so they survive.
  const idx = p.match(/\.(\d+)(?:\.|$)/);
  const human = words.charAt(0).toUpperCase() + words.slice(1);
  return idx ? `${human} #${Number(idx[1]) + 1}` : human;
}

module.exports = {
  SECTIONS,
  sectionsFor,
  sectionLabel,
  fieldLabel,
  sectionForPath,
  PATH_SECTIONS,
  COMMON,
  BY_SECTION,
};
