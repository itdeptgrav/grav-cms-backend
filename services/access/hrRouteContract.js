"use strict";
/**
 * services/access/hrRouteContract.js — the authorisation declaration for every
 * mounted HR endpoint.
 *
 * WHY A REGISTRY AND NOT A GUARD PER ROUTE
 * ----------------------------------------
 * HR is ~300 handlers across 36 routers, several of them thousands of lines
 * long. Annotating each handler means the annotation is missing from whichever
 * handler somebody adds next, and a permission system with a hole in it is
 * worse than none because everybody believes it is covered — the same argument
 * Middlewear/departmentWriteGuard.js makes for being mount-level.
 *
 * So the declaration lives here, beside every other declaration, and
 * Middlewear/hrContract.js enforces it at the mount. Two consequences follow,
 * and both are the point:
 *
 *   • An endpoint with no declaration is REFUSED at runtime (fail closed), and
 *   • test/hr-access/route-coverage.test.js walks the real routers and fails
 *     when a route exists with no declaration, or a declaration exists for a
 *     route that does not. A new HR route cannot ship unauthorised.
 *
 * WHAT EACH FIELD MEANS
 * ---------------------
 *   method        HTTP verb, or "*" for every verb on the path
 *   path          FULL mounted path, express style (":id", "*")
 *   capabilities  EVERY capability the operation needs — all of them, not one
 *   scope         "hr"     act inside the HR application (see the note on
 *                          record scope below)
 *                 "self"   the employee's own record; naming another is denied
 *                 "manager"the caller's proven reporting scope; the record-level
 *                          proof stays in the handler, which reads the stored
 *                          managersNotified / primaryManager rows
 *                 "public" deliberately unauthenticated
 *   selfParams    which params/body keys name an employee, for "self"
 *   protectedData true when the response can carry private, compensation,
 *                 statutory-identifier, medical or case data
 *   persona       who this is for, in words, for the endpoint matrix
 *   note          why, when the answer is not obvious
 *
 * RECORD SCOPE IN THIS CHUNK
 * --------------------------
 * "hr" is a GLOBAL scope today and says so. No HR schema carries a company,
 * legal entity or establishment (docs/audits/hrms-existing-codebase-audit.md,
 * finding P0), so there is no tenant boundary to enforce and this contract does
 * not pretend otherwise — the condition is named LEGACY_GLOBAL_HR_SCOPE in
 * services/access/hrAuthorization.js. What IS enforced is that a request
 * explicitly ASKING for a company/factory scope is refused rather than silently
 * answered across all of them. Chunk 2 replaces this.
 */

const { CAPABILITIES: C, isCapability } = require("./hrCapabilities");

/* Terse on purpose: 300 declarations that each span six lines are 1800 lines
   nobody reads, and an unread registry is the hole this file exists to close. */
const D = (method, path, capabilities, opts = {}) => ({
  method: String(method).toUpperCase(),
  path,
  capabilities: capabilities || [],
  scope: "hr",
  selfParams: [],
  protectedData: false,
  managerScope: null,
  ...opts,
});

/* Shorthands for the two commonest option sets. */
const P = { protectedData: true };                                   // carries protected data
const SELF = (params) => ({ scope: "self", selfParams: params || [] });
/* A manager route's authority is a RELATIONSHIP, and the descriptor says how to
   prove it: `queue` (no target — the handler's query names the caller),
   `record` + `param` (load the leave/regularization/overtime row named in the
   path), or `employeeFrom` (the employee named in the body). See
   services/access/hrManagerScope.js. */
const MGR = (managerScope) => ({ scope: "manager", managerScope });
/* A queue carries no target, so the descriptor names WHICH persona rule proves
   it: `current` (somebody active reports to you today) or `history` (that, or
   your name on a stored decision chain — a reorganisation must not take a
   former manager's own history away). See services/access/hrManagerScope.js. */
const MGR_QUEUE = MGR({ queue: "current" });
const MGR_HISTORY = MGR({ queue: "history" });
const PUB = { scope: "public" };

const DECLARATIONS = [
  /* ══════════════════════════════════════════════════════════════════════════
   *  PEOPLE — employee list, detail, create, update, import, history
   *  Mounted at /api/employees (HrRoutes/Employee-Section, employeeImportExport)
   * ══════════════════════════════════════════════════════════════════════════ */
  D("GET", "/api/employees/all", [C.HR_ACCESS, C.PEOPLE_READ_DIRECTORY], {
    persona: "any HR user",
    note: "The roster every HR screen opens with. Directory class only — the projection strips compensation, banking, statutory identifiers and medical fields even though the underlying query has historically selected the whole document.",
  }),
  D("GET", "/api/employees/history", [C.HR_ACCESS, C.AUDIT_READ], {
    persona: "HR operations",
    ...P,
  }),
  D("GET", "/api/employees/team-structure", [C.HR_ACCESS, C.PEOPLE_READ_DIRECTORY], { persona: "any HR user" }),
  D("GET", "/api/employees/department/employees", [C.HR_ACCESS, C.PEOPLE_READ_DIRECTORY], { persona: "any HR user" }),
  D("GET", "/api/employees/config/form-visibility", [C.HR_ACCESS, C.PEOPLE_READ_DIRECTORY], { persona: "HR operations" }),
  D("GET", "/api/employees/config/salary", [C.HR_ACCESS, C.COMPENSATION_READ], {
    persona: "payroll preparer / approver",
    note: "The salary RULES, not one person's pay — but the rules disclose the company's pay structure, so they ride the compensation capability.",
    ...P,
  }),
  D("PUT", "/api/employees/config/salary", [C.HR_ACCESS, C.COMPENSATION_WRITE], { persona: "HR owner", ...P }),
  D("POST", "/api/employees/config/salary/preview", [C.HR_ACCESS, C.COMPENSATION_READ], { persona: "payroll preparer", ...P }),
  D("GET", "/api/employees/:id/details", [C.HR_ACCESS, C.PEOPLE_READ_PRIVATE], { persona: "HR operations", ...P }),
  D("GET", "/api/employees/:id", [C.HR_ACCESS, C.PEOPLE_READ_PRIVATE], {
    persona: "HR operations",
    note: "The full employee record. Compensation, banking, statutory identifiers and medical fields are added back one at a time by the field projection, each behind its own capability.",
    ...P,
  }),
  /* ── The three field-sensitive employee writes ───────────────────────────
   *
   * One route, several operations: the same PUT carries a corrected middle
   * name, a transfer, and a salary revision. Declaring one capability for all
   * of them is wrong for two of them, so these three declare the FLOOR
   * (`people.write`) and `writePolicy: "employee"` adds whatever the payload
   * actually touches — see services/access/hrWritePolicy.js. */
  D("POST", "/api/employees", [C.HR_ACCESS, C.PEOPLE_WRITE], {
    persona: "HR editor",
    writePolicy: "employee",
    ...P,
  }),
  D("PUT", "/api/employees/:id", [C.HR_ACCESS, C.PEOPLE_WRITE], {
    persona: "HR editor",
    writePolicy: "employee",
    ...P,
  }),
  D("PATCH", "/api/employees/bulk-update", [C.HR_ACCESS, C.PEOPLE_WRITE], {
    persona: "HR editor",
    writePolicy: "employee",
    /* Bulk update nests the fields under `updates`; `employeeIds` beside it is
       the population, not a field being written. */
    writeFieldsFrom: "updates",
    ...P,
  }),
  D("PATCH", "/api/employees/:id/documents", [C.HR_ACCESS, C.PEOPLE_WRITE, C.PEOPLE_READ_IDENTIFIERS], {
    persona: "HR editor",
    note: "Writes the `documents` sub-document, which holds the government identifiers as well as the uploaded files — so it needs the identifier capability, not only people.write.",
    ...P,
  }),
  D("PATCH", "/api/employees/:id/profile-photo", [C.HR_ACCESS, C.PEOPLE_WRITE], {
    persona: "HR editor",
    note: "HR changing SOMEBODY ELSE'S photo. Deliberately not a self-service write — see the exemption note in server.js.",
  }),
  D("DELETE", "/api/employees/:id", [C.HR_ACCESS, C.PEOPLE_WRITE, C.EMPLOYMENT_CHANGE], { persona: "HR editor", ...P }),

  D("GET", "/api/employees/import-export/template", [C.HR_ACCESS, C.PEOPLE_WRITE], { persona: "HR editor" }),
  D("GET", "/api/employees/import-export/export", [C.HR_ACCESS, C.PEOPLE_READ_PRIVATE, C.PEOPLE_READ_IDENTIFIERS, C.COMPENSATION_READ], {
    persona: "HR approver / owner",
    note: "A full workforce export carries pay and statutory identifiers in a file that leaves the building. It needs every capability the fields inside it need, not just people.read.",
    ...P,
  }),
  D("POST", "/api/employees/import-export/import/preview", [C.HR_ACCESS, C.PEOPLE_WRITE], { persona: "HR editor", ...P }),
  D("POST", "/api/employees/import-export/import/confirm", [C.HR_ACCESS, C.PEOPLE_WRITE, C.EMPLOYMENT_CHANGE, C.COMPENSATION_WRITE], {
    persona: "HR owner",
    note: "The importer writes salary columns, so it needs compensation.write as well as people.write. Exempt from the approval queue because a spreadsheet exceeds what a held request can store — which is precisely why the capability bar is higher.",
    ...P,
  }),

  /* ══════════════════════════════════════════════════════════════════════════
   *  HR SELF-SERVICE PROFILE — /api/hr/profile, /api/hr/change-password
   *  The caller's OWN account, resolved from the token. Not HR administration:
   *  an ordinary employee reaching this sees themselves and nobody else.
   * ══════════════════════════════════════════════════════════════════════════ */
  D("GET", "/api/hr/profile", [], { ...SELF([]), persona: "any signed-in account" }),
  D("PUT", "/api/hr/profile", [], { ...SELF([]), persona: "any signed-in account" }),
  D("PUT", "/api/hr/change-password", [], {
    ...SELF([]),
    persona: "any signed-in account",
    note: "Changing YOUR OWN password. No HR capability, no approval queue — required behaviour, and the reason server.js exempts this exact path from the write guard.",
  }),

  /* ══════════════════════════════════════════════════════════════════════════
   *  ORGANISATION — HR departments and team structure
   * ══════════════════════════════════════════════════════════════════════════ */
  D("GET", "/api/hr/departments/with-designations", [C.HR_ACCESS, C.PEOPLE_READ_DIRECTORY], { persona: "any HR user" }),
  D("GET", "/api/hr/departments/suggestions", [C.HR_ACCESS, C.PEOPLE_READ_DIRECTORY], { persona: "any HR user" }),
  D("GET", "/api/hr/departments/:id/with-employees", [C.HR_ACCESS, C.PEOPLE_READ_DIRECTORY], { persona: "any HR user" }),
  D("GET", "/api/hr/departments/:id/manager-candidates", [C.HR_ACCESS, C.PEOPLE_READ_DIRECTORY], { persona: "HR operations" }),
  D("GET", "/api/hr/departments/:id/designations-list", [C.HR_ACCESS, C.PEOPLE_READ_DIRECTORY], { persona: "any HR user" }),
  D("GET", "/api/hr/departments/:id", [C.HR_ACCESS, C.PEOPLE_READ_DIRECTORY], { persona: "any HR user" }),
  D("GET", "/api/hr/departments", [C.HR_ACCESS, C.PEOPLE_READ_DIRECTORY], { persona: "any HR user" }),
  D("POST", "/api/hr/departments", [C.HR_ACCESS, C.HR_CONFIGURATION_MANAGE], {
    persona: "HR owner",
    note: "An HR ORGANISATION department. Creating one grants nobody any application access — that is AccessDepartment, managed from CEO -> Access Control, and the two are separate on purpose.",
  }),
  D("PUT", "/api/hr/departments/:id/managers", [C.HR_ACCESS, C.EMPLOYMENT_CHANGE], { persona: "HR editor" }),
  D("PUT", "/api/hr/departments/:id", [C.HR_ACCESS, C.HR_CONFIGURATION_MANAGE], { persona: "HR owner" }),
  D("DELETE", "/api/hr/departments/:id", [C.HR_ACCESS, C.HR_CONFIGURATION_MANAGE], { persona: "HR owner" }),

  /* ══════════════════════════════════════════════════════════════════════════
   *  OVERVIEW / DASHBOARD — aggregate workforce figures
   * ══════════════════════════════════════════════════════════════════════════ */
  D("GET", "/api/hr/overview/dashboard", [C.HR_ACCESS, C.ANALYTICS_WORKFORCE], {
    persona: "HR user, and the CEO command centre",
    note: "Read by /ceo/dashboard command centre as well as HR. analytics.workforce is in the CEO projection template, which is what keeps that page working.",
  }),
  D("GET", "/api/hr/overview/attendance-summary", [C.HR_ACCESS, C.ANALYTICS_WORKFORCE], { persona: "HR user / management" }),
  D("GET", "/api/hr/overview/leave-summary", [C.HR_ACCESS, C.ANALYTICS_WORKFORCE], { persona: "HR user / management" }),
  D("GET", "/api/hr/overview/quick-stats", [C.HR_ACCESS, C.ANALYTICS_WORKFORCE], { persona: "HR user / management" }),
  D("GET", "/api/hr/overview/department-breakdown", [C.HR_ACCESS, C.ANALYTICS_WORKFORCE], { persona: "HR user / management" }),
  D("GET", "/api/hr/overview/recent-activities", [C.HR_ACCESS, C.ANALYTICS_WORKFORCE, C.AUDIT_READ], { persona: "HR user" }),

  /* ══════════════════════════════════════════════════════════════════════════
   *  ATTENDANCE — /hr/attendance  (mounted OUTSIDE /api, which is exactly the
   *  kind of prefix the audit warned the global write guard covers unevenly)
   * ══════════════════════════════════════════════════════════════════════════ */
  D("GET", "/hr/attendance/settings", [C.HR_ACCESS, C.ATTENDANCE_READ], { persona: "time office" }),
  D("PUT", "/hr/attendance/settings", [C.HR_ACCESS, C.HR_CONFIGURATION_MANAGE], { persona: "HR owner" }),
  D("GET", "/hr/attendance/notification-settings", [C.HR_ACCESS, C.ATTENDANCE_READ], { persona: "time office" }),
  D("PUT", "/hr/attendance/notification-settings", [C.HR_ACCESS, C.HR_CONFIGURATION_MANAGE], { persona: "HR owner" }),
  D("POST", "/hr/attendance/notification-subscribe", [C.HR_ACCESS, C.ATTENDANCE_READ], { persona: "time office" }),
  D("POST", "/hr/attendance/notification-test", [C.HR_ACCESS, C.HR_CONFIGURATION_MANAGE], { persona: "HR owner" }),

  D("GET", "/hr/attendance/daily", [C.HR_ACCESS, C.ATTENDANCE_READ], { persona: "time office" }),
  D("GET", "/hr/attendance/day-range", [C.HR_ACCESS, C.ATTENDANCE_READ], { persona: "time office" }),
  D("GET", "/hr/attendance/departments", [C.HR_ACCESS, C.ATTENDANCE_READ], { persona: "time office" }),
  D("GET", "/hr/attendance/departments-with-designations", [C.HR_ACCESS, C.ATTENDANCE_READ], { persona: "time office" }),
  D("GET", "/hr/attendance/employees-list", [C.HR_ACCESS, C.ATTENDANCE_READ], { persona: "time office" }),
  D("GET", "/hr/attendance/employee/:empId", [C.HR_ACCESS, C.ATTENDANCE_READ], { persona: "time office" }),
  D("GET", "/hr/attendance/employee-detail", [C.HR_ACCESS, C.ATTENDANCE_READ], { persona: "time office" }),
  D("GET", "/hr/attendance/summary", [C.HR_ACCESS, C.ATTENDANCE_READ], { persona: "time office" }),
  D("GET", "/hr/attendance/muster-roll", [C.HR_ACCESS, C.ATTENDANCE_READ], { persona: "time office" }),
  D("GET", "/hr/attendance/timecard", [C.HR_ACCESS, C.ATTENDANCE_READ], { persona: "time office" }),
  D("GET", "/hr/attendance/calendar", [C.HR_ACCESS, C.ATTENDANCE_READ], { persona: "time office" }),
  D("GET", "/hr/attendance/missed-punches", [C.HR_ACCESS, C.ATTENDANCE_READ], { persona: "time office" }),
  D("GET", "/hr/attendance/leave-balance-check", [C.HR_ACCESS, C.ATTENDANCE_READ, C.LEAVE_READ], { persona: "time office" }),
  D("GET", "/hr/attendance/test-connection", [C.HR_ACCESS, C.HR_CONFIGURATION_MANAGE], {
    persona: "HR owner",
    note: "Probes the biometric device credentials. A diagnostic that proves reachability of an integration is configuration, not attendance.",
  }),
  D("GET", "/hr/attendance/export-daily", [C.HR_ACCESS, C.ATTENDANCE_READ, C.ANALYTICS_WORKFORCE], { persona: "time office" }),
  D("GET", "/hr/attendance/export-muster-roll", [C.HR_ACCESS, C.ATTENDANCE_READ, C.ANALYTICS_WORKFORCE], { persona: "time office" }),

  D("PUT", "/hr/attendance/day-override", [C.HR_ACCESS, C.ATTENDANCE_CORRECT], { persona: "time office" }),
  D("PUT", "/hr/attendance/bulk-day-override", [C.HR_ACCESS, C.ATTENDANCE_CORRECT], { persona: "time office" }),
  D("POST", "/hr/attendance/punch-correction", [C.HR_ACCESS, C.ATTENDANCE_CORRECT], { persona: "time office" }),
  D("DELETE", "/hr/attendance/remove-from-month", [C.HR_ACCESS, C.ATTENDANCE_CLOSE], {
    persona: "attendance approver",
    note: "Removes a person from a whole month of attendance. Period-shaped, so it takes the CLOSE capability rather than the correction one — the separation tests pin this.",
  }),
  D("POST", "/hr/attendance/sync-period", [C.HR_ACCESS, C.ATTENDANCE_CLOSE], {
    persona: "attendance approver",
    note: "Re-derives a whole period from the biometric source. Exempt from the approval queue as a machine operation (server.js), which is exactly why it needs the higher capability here.",
  }),
  D("GET", "/hr/attendance/sync-period/:jobId", [C.HR_ACCESS, C.ATTENDANCE_READ], { persona: "time office" }),
  D("POST", "/hr/attendance/backfill-hr-leaves", [C.HR_ACCESS, C.ATTENDANCE_CLOSE, C.LEAVE_CONFIGURE], { persona: "attendance approver" }),

  D("GET", "/hr/attendance/regularizations/:id", [C.HR_ACCESS, C.ATTENDANCE_READ], { persona: "time office" }),
  D("GET", "/hr/attendance/regularizations", [C.HR_ACCESS, C.ATTENDANCE_READ], { persona: "time office" }),
  D("POST", "/hr/attendance/regularizations", [C.HR_ACCESS, C.ATTENDANCE_CORRECT], { persona: "time office" }),
  D("PATCH", "/hr/attendance/regularizations/:id/hr-approve", [C.HR_ACCESS, C.ATTENDANCE_CORRECT], { persona: "time office" }),
  D("PATCH", "/hr/attendance/regularizations/:id/hr-reject", [C.HR_ACCESS, C.ATTENDANCE_CORRECT], { persona: "time office" }),
  D("PATCH", "/hr/attendance/regularizations/:id/cancel", [C.HR_ACCESS, C.ATTENDANCE_CORRECT], { persona: "time office" }),

  D("GET", "/hr/attendance/holidays", [C.HR_ACCESS, C.ATTENDANCE_READ], { persona: "any HR user" }),
  D("POST", "/hr/attendance/holidays", [C.HR_ACCESS, C.LEAVE_CONFIGURE], { persona: "HR approver" }),
  D("DELETE", "/hr/attendance/holidays/:id", [C.HR_ACCESS, C.LEAVE_CONFIGURE], { persona: "HR approver" }),

  /* Shift swaps — an attendance correction expressed as an exchange. */
  D("GET", "/hr/shift-swaps/employees", [C.HR_ACCESS, C.ATTENDANCE_READ], { persona: "time office" }),
  D("GET", "/hr/shift-swaps/recent", [C.HR_ACCESS, C.ATTENDANCE_READ], { persona: "time office" }),
  D("POST", "/hr/shift-swaps/exchange", [C.HR_ACCESS, C.ATTENDANCE_CORRECT], { persona: "time office" }),

  /* Face registration — the punch-in machine's enrolment status. */
  D("GET", "/hr/face-registration/health", [], { ...PUB, persona: "punch-in machine", note: "Liveness of the face engine. No data, no identity; deliberately open so the device can be monitored without a session." }),
  D("GET", "/hr/face-registration/status", [C.HR_ACCESS, C.PEOPLE_READ_DIRECTORY], { persona: "HR operations" }),
  D("GET", "/hr/face-registration/status/:employeeId", [C.HR_ACCESS, C.PEOPLE_READ_DIRECTORY], { persona: "HR operations" }),
  D("POST", "/hr/face-registration/upload/:employeeId", [C.HR_ACCESS, C.PEOPLE_WRITE], { persona: "HR editor", ...P }),
  D("POST", "/hr/face-registration/photo/:employeeId", [C.HR_ACCESS, C.PEOPLE_WRITE], { persona: "HR editor", ...P }),
  D("POST", "/hr/face-registration/archive/:employeeId", [C.HR_ACCESS, C.PEOPLE_WRITE], { persona: "HR editor", ...P }),
  D("POST", "/hr/face-registration/recheck", [C.HR_ACCESS, C.PEOPLE_READ_DIRECTORY], { persona: "HR operations" }),

  /* ══════════════════════════════════════════════════════════════════════════
   *  LEAVE — configuration, balances and HR decisions
   * ══════════════════════════════════════════════════════════════════════════ */
  D("GET", "/api/hr/leaves/config", [C.HR_ACCESS, C.LEAVE_READ], { persona: "any HR user" }),
  D("PUT", "/api/hr/leaves/config", [C.HR_ACCESS, C.LEAVE_CONFIGURE], { persona: "HR approver" }),
  D("GET", "/api/hr/leaves/all-balances", [C.HR_ACCESS, C.LEAVE_READ], { persona: "HR operations" }),
  D("GET", "/api/hr/leaves/stats", [C.HR_ACCESS, C.LEAVE_READ, C.ANALYTICS_WORKFORCE], { persona: "HR operations" }),
  D("GET", "/api/hr/leaves/calendar", [C.HR_ACCESS, C.LEAVE_READ], { persona: "HR operations" }),
  D("GET", "/api/hr/leaves/employee-balance/:employeeId", [C.HR_ACCESS, C.LEAVE_READ], { persona: "HR operations" }),
  D("GET", "/api/hr/leaves/balance/:employeeId", [C.HR_ACCESS, C.LEAVE_READ], { persona: "HR operations" }),
  D("GET", "/api/hr/leaves/debug-attendance/:id", [C.HR_ACCESS, C.ATTENDANCE_READ, C.LEAVE_READ], { persona: "HR operations" }),
  D("GET", "/api/hr/leaves/holidays", [C.HR_ACCESS, C.LEAVE_READ], { persona: "any HR user" }),
  D("POST", "/api/hr/leaves/holidays", [C.HR_ACCESS, C.LEAVE_CONFIGURE], { persona: "HR approver" }),
  D("PATCH", "/api/hr/leaves/holidays/sunday-override", [C.HR_ACCESS, C.LEAVE_CONFIGURE], { persona: "HR approver" }),
  D("DELETE", "/api/hr/leaves/holidays/:id", [C.HR_ACCESS, C.LEAVE_CONFIGURE], { persona: "HR approver" }),
  D("GET", "/api/hr/leaves/:id", [C.HR_ACCESS, C.LEAVE_READ], { persona: "HR operations", ...P }),
  D("GET", "/api/hr/leaves", [C.HR_ACCESS, C.LEAVE_READ], { persona: "HR operations" }),
  D("PATCH", "/api/hr/leaves/bulk-approve", [C.HR_ACCESS, C.LEAVE_DECIDE_HR], { persona: "HR editor" }),
  D("PATCH", "/api/hr/leaves/:id/approve", [C.HR_ACCESS, C.LEAVE_DECIDE_HR], { persona: "HR editor" }),
  D("PATCH", "/api/hr/leaves/:id/reject", [C.HR_ACCESS, C.LEAVE_DECIDE_HR], { persona: "HR editor" }),
  D("PATCH", "/api/hr/leaves/:id/cancel", [C.HR_ACCESS, C.LEAVE_DECIDE_HR], { persona: "HR editor" }),
  D("POST", "/api/hr/leaves/add-on-behalf", [C.HR_ACCESS, C.LEAVE_DECIDE_HR], { persona: "HR editor" }),
  D("POST", "/api/hr/leaves/:id/upload-document", [C.HR_ACCESS, C.LEAVE_DECIDE_HR], { persona: "HR editor", ...P }),
  D("PATCH", "/api/hr/leaves/balance/:employeeId/adjust", [C.HR_ACCESS, C.LEAVE_CONFIGURE], {
    persona: "HR approver",
    note: "Adjusting a balance is not deciding a request. Kept on leave.configure so an editor who may approve leave still cannot silently mint entitlement.",
  }),
  D("POST", "/api/hr/leaves/balance/init-year", [C.HR_ACCESS, C.LEAVE_CONFIGURE], { persona: "HR approver" }),
  D("POST", "/api/hr/leaves/balance/grant-pl", [C.HR_ACCESS, C.LEAVE_CONFIGURE], { persona: "HR approver" }),
  D("POST", "/api/hr/leaves/sync-pl-eligibility", [C.HR_ACCESS, C.LEAVE_CONFIGURE], { persona: "HR approver" }),
  D("POST", "/api/hr/leaves/backfill-attendance", [C.HR_ACCESS, C.ATTENDANCE_CLOSE, C.LEAVE_CONFIGURE], { persona: "HR approver" }),

  /* ══════════════════════════════════════════════════════════════════════════
   *  PAYROLL — prepare / approve / reopen are three different authorities
   * ══════════════════════════════════════════════════════════════════════════ */
  D("GET", "/api/hr/payroll/settings", [C.HR_ACCESS, C.PAYROLL_READ], { persona: "payroll preparer" }),
  D("PUT", "/api/hr/payroll/settings", [C.HR_ACCESS, C.HR_CONFIGURATION_MANAGE], { persona: "HR owner" }),
  D("GET", "/api/hr/payroll/preview", [C.HR_ACCESS, C.PAYROLL_READ, C.COMPENSATION_READ], { persona: "payroll preparer", ...P }),
  D("GET", "/api/hr/payroll/runs", [C.HR_ACCESS, C.PAYROLL_READ], { persona: "payroll preparer" }),
  D("GET", "/api/hr/payroll/items", [C.HR_ACCESS, C.PAYROLL_READ, C.COMPENSATION_READ], { persona: "payroll preparer", ...P }),
  D("GET", "/api/hr/payroll/item/:id", [C.HR_ACCESS, C.PAYROLL_READ, C.COMPENSATION_READ], { persona: "payroll preparer", ...P }),
  D("GET", "/api/hr/payroll/export", [C.HR_ACCESS, C.PAYROLL_READ, C.COMPENSATION_READ, C.ANALYTICS_WORKFORCE], { persona: "payroll approver", ...P }),
  D("POST", "/api/hr/payroll/run", [C.HR_ACCESS, C.PAYROLL_PREPARE], { persona: "payroll preparer", ...P }),
  D("POST", "/api/hr/payroll/run/save-draft", [C.HR_ACCESS, C.PAYROLL_PREPARE], { persona: "payroll preparer", ...P }),
  D("PUT", "/api/hr/payroll/item/:id", [C.HR_ACCESS, C.PAYROLL_PREPARE], { persona: "payroll preparer", ...P }),
  D("PATCH", "/api/hr/payroll/item/:id/override", [C.HR_ACCESS, C.PAYROLL_PREPARE], { persona: "payroll preparer", ...P }),
  D("PATCH", "/api/hr/payroll/item/:id/recalculate", [C.HR_ACCESS, C.PAYROLL_PREPARE], { persona: "payroll preparer", ...P }),
  D("PATCH", "/api/hr/payroll/items/bulk-override", [C.HR_ACCESS, C.PAYROLL_PREPARE], { persona: "payroll preparer", ...P }),
  D("DELETE", "/api/hr/payroll/item/:id", [C.HR_ACCESS, C.PAYROLL_PREPARE], { persona: "payroll preparer", ...P }),
  D("PATCH", "/api/hr/payroll/mark-paid", [C.HR_ACCESS, C.PAYROLL_APPROVE], {
    persona: "payroll approver",
    note: "The one payroll write an approver makes that a preparer must not. Distinct capability, pinned by test.",
    ...P,
  }),
  D("PATCH", "/api/hr/payroll/run/revert-to-draft", [C.HR_ACCESS, C.PAYROLL_REOPEN], {
    persona: "HR owner",
    note: "Reopening a run. Separate from approve, and separate again from prepare.",
    ...P,
  }),
  D("DELETE", "/api/hr/payroll/run", [C.HR_ACCESS, C.PAYROLL_REOPEN], { persona: "HR owner", ...P }),

  /* Payslips — one person's pay. Compensation, always. */
  D("GET", "/api/hr/payslip/employees", [C.HR_ACCESS, C.PAYROLL_READ], { persona: "payroll preparer" }),
  D("GET", "/api/hr/payslip/:employeeId/history", [C.HR_ACCESS, C.COMPENSATION_READ], { persona: "payroll preparer", ...P }),
  D("GET", "/api/hr/payslip/:employeeId/pdf", [C.HR_ACCESS, C.COMPENSATION_READ], { persona: "payroll preparer", ...P }),
  D("GET", "/api/hr/payslip/:employeeId", [C.HR_ACCESS, C.COMPENSATION_READ], { persona: "payroll preparer", ...P }),

  /* ══════════════════════════════════════════════════════════════════════════
   *  RECRUITMENT — jobs, candidates, interview tasks
   * ══════════════════════════════════════════════════════════════════════════ */
  D("GET", "/api/hr/job-postings/dashboard/jobs", [C.HR_ACCESS, C.RECRUITMENT_READ], { persona: "recruiter" }),
  D("GET", "/api/hr/job-postings/dashboard/stats", [C.HR_ACCESS, C.RECRUITMENT_READ], { persona: "recruiter" }),
  D("GET", "/api/hr/job-postings/:id", [C.HR_ACCESS, C.RECRUITMENT_READ], { persona: "recruiter" }),
  D("POST", "/api/hr/job-postings", [C.HR_ACCESS, C.RECRUITMENT_MANAGE], { persona: "recruiter" }),
  D("PUT", "/api/hr/job-postings/:id", [C.HR_ACCESS, C.RECRUITMENT_MANAGE], { persona: "recruiter" }),
  D("PATCH", "/api/hr/job-postings/:id/status", [C.HR_ACCESS, C.RECRUITMENT_MANAGE], { persona: "recruiter" }),
  D("DELETE", "/api/hr/job-postings/:id", [C.HR_ACCESS, C.RECRUITMENT_MANAGE], { persona: "recruiter" }),

  D("GET", "/api/hr/candidates/:jobId/candidates/:candidateId/interviews", [C.HR_ACCESS, C.RECRUITMENT_READ], { persona: "recruiter", ...P }),
  D("GET", "/api/hr/candidates/:jobId/candidates/:candidateId/details", [C.HR_ACCESS, C.RECRUITMENT_READ], { persona: "recruiter", ...P }),
  D("GET", "/api/hr/candidates/:jobId/candidates/:candidateId", [C.HR_ACCESS, C.RECRUITMENT_READ], { persona: "recruiter", ...P }),
  D("GET", "/api/hr/candidates/:jobId", [C.HR_ACCESS, C.RECRUITMENT_READ], { persona: "recruiter", ...P }),
  D("POST", "/api/hr/candidates/:jobId/candidates", [C.HR_ACCESS, C.RECRUITMENT_MANAGE], { persona: "recruiter", ...P }),
  D("PUT", "/api/hr/candidates/:jobId/candidates/:candidateId", [C.HR_ACCESS, C.RECRUITMENT_MANAGE], { persona: "recruiter", ...P }),
  D("PATCH", "/api/hr/candidates/:jobId/candidates/:candidateId/stage", [C.HR_ACCESS, C.RECRUITMENT_MANAGE], { persona: "recruiter" }),
  D("PATCH", "/api/hr/candidates/:jobId/candidates/:candidateId/questions", [C.HR_ACCESS, C.RECRUITMENT_MANAGE], { persona: "recruiter" }),
  D("PATCH", "/api/hr/candidates/:jobId/candidates/:candidateId/archive", [C.HR_ACCESS, C.RECRUITMENT_MANAGE], { persona: "recruiter" }),
  D("DELETE", "/api/hr/candidates/:jobId/candidates/:candidateId", [C.HR_ACCESS, C.RECRUITMENT_MANAGE], { persona: "recruiter", ...P }),

  D("GET", "/api/hr/tasks/candidate/:candidateId", [C.HR_ACCESS, C.RECRUITMENT_READ], { persona: "recruiter" }),
  D("GET", "/api/hr/tasks/manager/:managerId", [C.HR_ACCESS, C.RECRUITMENT_READ], { persona: "recruiter / hiring manager" }),
  D("GET", "/api/hr/tasks/upcoming/tasks", [C.HR_ACCESS, C.RECRUITMENT_READ], { persona: "recruiter" }),
  D("POST", "/api/hr/tasks", [C.HR_ACCESS, C.RECRUITMENT_MANAGE], { persona: "recruiter" }),
  D("PUT", "/api/hr/tasks/:taskId", [C.HR_ACCESS, C.RECRUITMENT_MANAGE], { persona: "recruiter" }),
  D("PATCH", "/api/hr/tasks/:taskId/status", [C.HR_ACCESS, C.RECRUITMENT_MANAGE], { persona: "recruiter" }),
  D("PATCH", "/api/hr/tasks/:taskId/complete", [C.HR_ACCESS, C.RECRUITMENT_MANAGE], { persona: "recruiter" }),
  D("DELETE", "/api/hr/tasks/:taskId", [C.HR_ACCESS, C.RECRUITMENT_MANAGE], { persona: "recruiter" }),

  /* ══════════════════════════════════════════════════════════════════════════
   *  DOCUMENTS — issue and release are two authorities, not one
   * ══════════════════════════════════════════════════════════════════════════ */
  D("GET", "/api/hr/documents/types", [C.HR_ACCESS, C.DOCUMENTS_READ], { persona: "HR operations" }),
  D("GET", "/api/hr/documents/requests", [C.HR_ACCESS, C.DOCUMENTS_READ], { persona: "HR operations" }),
  D("GET", "/api/hr/documents/prefill/:employeeId", [C.HR_ACCESS, C.DOCUMENTS_ISSUE, C.PEOPLE_READ_PRIVATE], { persona: "HR editor", ...P }),
  D("GET", "/api/hr/documents/:id/download", [C.HR_ACCESS, C.DOCUMENTS_READ], { persona: "HR operations", ...P }),
  D("GET", "/api/hr/documents/:id/link", [C.HR_ACCESS, C.DOCUMENTS_READ], { persona: "HR operations", ...P }),
  D("GET", "/api/hr/documents/:id", [C.HR_ACCESS, C.DOCUMENTS_READ], { persona: "HR operations", ...P }),
  D("GET", "/api/hr/documents", [C.HR_ACCESS, C.DOCUMENTS_READ], { persona: "HR operations" }),
  D("POST", "/api/hr/documents/:id/file", [C.HR_ACCESS, C.DOCUMENTS_ISSUE], { persona: "HR editor", ...P }),
  D("POST", "/api/hr/documents", [C.HR_ACCESS, C.DOCUMENTS_ISSUE], { persona: "HR editor", ...P }),
  D("PATCH", "/api/hr/documents/:id/release", [C.HR_ACCESS, C.DOCUMENTS_RELEASE], {
    persona: "HR approver",
    note: "RELEASE is what makes a document visible to the employee. Separate from issue, pinned by test — generating a warning letter and publishing it are different decisions.",
  }),
  D("PATCH", "/api/hr/documents/:id/revoke", [C.HR_ACCESS, C.DOCUMENTS_RELEASE], { persona: "HR approver" }),
  D("PATCH", "/api/hr/documents/:id/decline", [C.HR_ACCESS, C.DOCUMENTS_ISSUE], { persona: "HR editor" }),
  D("DELETE", "/api/hr/documents/:id", [C.HR_ACCESS, C.DOCUMENTS_ISSUE], { persona: "HR editor" }),

  /* ══════════════════════════════════════════════════════════════════════════
   *  POLICIES, SOPs AND COMPLIANCE
   * ══════════════════════════════════════════════════════════════════════════ */
  D("*", "/api/hr/policy/c4-presence-cron", [], {
    ...PUB,
    persona: "an external scheduler, not a person",
    note: "Declared `public` because it carries no session: an external scheduler cannot sign in, so the handler authenticates the CALLER with the C4_CRON_KEY shared secret and refuses outright when that variable is unset. Session-shaped authorisation is the wrong tool here; the declaration records that the route has its own and is deliberately outside the capability model.",
  }),
  D("GET", "/api/hr/policy/suggestions", [C.HR_ACCESS, C.COMPLIANCE_READ], { persona: "HR operations" }),
  D("GET", "/api/hr/policy/departments", [C.HR_ACCESS, C.COMPLIANCE_READ], { persona: "HR operations" }),
  D("GET", "/api/hr/policy/employees", [C.HR_ACCESS, C.COMPLIANCE_READ], { persona: "HR operations" }),
  D("GET", "/api/hr/policy/points-summary", [C.HR_ACCESS, C.COMPLIANCE_READ], { persona: "HR operations" }),
  D("GET", "/api/hr/policy/c4-config", [C.HR_ACCESS, C.COMPLIANCE_READ], { persona: "HR operations" }),
  D("PUT", "/api/hr/policy/c4-config", [C.HR_ACCESS, C.COMPLIANCE_MANAGE], { persona: "HR approver" }),
  D("POST", "/api/hr/policy/c4-presence-run", [C.HR_ACCESS, C.COMPLIANCE_MANAGE], { persona: "HR approver" }),
  D("GET", "/api/hr/policy/employee-history/:biometricId", [C.HR_ACCESS, C.COMPLIANCE_READ], { persona: "HR operations", ...P }),
  D("GET", "/api/hr/policy/external-rules", [C.HR_ACCESS, C.COMPLIANCE_READ], { persona: "HR operations" }),
  D("GET", "/api/hr/policy", [C.HR_ACCESS, C.COMPLIANCE_READ], { persona: "any HR user" }),
  D("POST", "/api/hr/policy/apply", [C.HR_ACCESS, C.COMPLIANCE_MANAGE], { persona: "HR approver" }),
  D("POST", "/api/hr/policy", [C.HR_ACCESS, C.COMPLIANCE_MANAGE], { persona: "HR approver" }),
  D("PATCH", "/api/hr/policy/:id", [C.HR_ACCESS, C.COMPLIANCE_MANAGE], { persona: "HR approver" }),
  D("DELETE", "/api/hr/policy/:id", [C.HR_ACCESS, C.COMPLIANCE_MANAGE], { persona: "HR approver" }),

  D("GET", "/api/hr/sop/folders", [C.HR_ACCESS, C.COMPLIANCE_READ], { persona: "any HR user" }),
  D("GET", "/api/hr/sop/employees", [C.HR_ACCESS, C.COMPLIANCE_READ], { persona: "HR operations" }),
  D("GET", "/api/hr/sop/bleach/:employeeId", [C.HR_ACCESS, C.COMPLIANCE_READ, C.SKILLS_READ], { persona: "HR operations", ...P }),
  D("GET", "/api/hr/sop", [C.HR_ACCESS, C.COMPLIANCE_READ], { persona: "any HR user" }),
  D("POST", "/api/hr/sop/bleach", [C.HR_ACCESS, C.COMPLIANCE_MANAGE], { persona: "HR approver", ...P }),
  D("POST", "/api/hr/sop/folders", [C.HR_ACCESS, C.COMPLIANCE_MANAGE], { persona: "HR approver" }),
  D("POST", "/api/hr/sop", [C.HR_ACCESS, C.COMPLIANCE_MANAGE], { persona: "HR approver" }),
  D("PATCH", "/api/hr/sop/:id", [C.HR_ACCESS, C.COMPLIANCE_MANAGE], { persona: "HR approver" }),
  D("DELETE", "/api/hr/sop/folders/:id", [C.HR_ACCESS, C.COMPLIANCE_MANAGE], { persona: "HR approver" }),
  D("DELETE", "/api/hr/sop/:id", [C.HR_ACCESS, C.COMPLIANCE_MANAGE], { persona: "HR approver" }),

  /* ══════════════════════════════════════════════════════════════════════════
   *  PERFORMANCE
   * ══════════════════════════════════════════════════════════════════════════ */
  D("GET", "/hr/performance/overview", [C.HR_ACCESS, C.SKILLS_READ, C.ANALYTICS_WORKFORCE], { persona: "HR operations" }),
  D("GET", "/hr/performance/:employeeId", [C.HR_ACCESS, C.SKILLS_READ], {
    persona: "HR operations",
    note: "Takes an ARBITRARY employee id and is therefore HR-only. The employee's own copy is /api/employee/performance, which is scoped to the token.",
    ...P,
  }),

  /* ══════════════════════════════════════════════════════════════════════════
   *  REPORTS
   * ══════════════════════════════════════════════════════════════════════════ */
  D("GET", "/hr/reports/types", [C.HR_ACCESS, C.ANALYTICS_WORKFORCE], { persona: "HR operations" }),
  D("GET", "/hr/reports/filters", [C.HR_ACCESS, C.ANALYTICS_WORKFORCE], { persona: "HR operations" }),
  D("POST", "/hr/reports/generate/:reportKey", [C.HR_ACCESS, C.ANALYTICS_WORKFORCE], {
    persona: "HR operations",
    note: "POST because the filter set does not fit in a query string; read-shaped, and the write guard treats it as such. A report that includes pay is additionally gated by the field projection.",
    ...P,
  }),
  D("POST", "/hr/reports/month-performance", [C.HR_ACCESS, C.ANALYTICS_WORKFORCE, C.SKILLS_READ], { persona: "HR operations", ...P }),

  /* ══════════════════════════════════════════════════════════════════════════
   *  CHANGE HISTORY / AUDIT
   * ══════════════════════════════════════════════════════════════════════════ */
  D("GET", "/api/hr/change-history/sections", [C.HR_ACCESS, C.AUDIT_READ], { persona: "HR operations" }),
  D("GET", "/api/hr/change-history/actors", [C.HR_ACCESS, C.AUDIT_READ], { persona: "HR operations" }),
  D("GET", "/api/hr/change-history/stamps", [C.HR_ACCESS, C.AUDIT_READ], { persona: "HR operations" }),
  D("GET", "/api/hr/change-history/summary", [C.HR_ACCESS, C.AUDIT_READ], { persona: "HR operations" }),
  D("GET", "/api/hr/change-history/record/:entity/:entityId", [C.HR_ACCESS, C.AUDIT_READ], { persona: "HR operations", ...P }),
  D("GET", "/api/hr/change-history/export", [C.HR_ACCESS, C.AUDIT_EXPORT], {
    persona: "HR approver",
    note: "Exporting the audit trail is its own authority — the file leaves the building and carries before/after values.",
    ...P,
  }),
  D("GET", "/api/hr/change-history", [C.HR_ACCESS, C.AUDIT_READ], { persona: "HR operations", ...P }),

  /* ══════════════════════════════════════════════════════════════════════════
   *  CREDENTIAL ADMINISTRATION — the most sensitive write in the department
   * ══════════════════════════════════════════════════════════════════════════ */
  D("GET", "/api/hr/password-management/users", [C.HR_ACCESS, C.SECURITY_CREDENTIALS_MANAGE], { persona: "HR owner", ...P }),
  D("GET", "/api/hr/password-management/user/:userType/:id", [C.HR_ACCESS, C.SECURITY_CREDENTIALS_MANAGE], { persona: "HR owner", ...P }),
  D("GET", "/api/hr/password-management/sync-dept-logins", [C.HR_ACCESS, C.SECURITY_CREDENTIALS_MANAGE], { persona: "HR owner", ...P }),
  D("POST", "/api/hr/password-management/sync-dept-logins", [C.HR_ACCESS, C.SECURITY_CREDENTIALS_MANAGE], { persona: "HR owner", ...P }),
  D("PATCH", "/api/hr/password-management/change-password/:userType/:id", [C.HR_ACCESS, C.SECURITY_CREDENTIALS_MANAGE], {
    persona: "HR owner",
    note: "HR resetting SOMEBODY ELSE'S password — the opposite of the self-service case at /api/hr/change-password, and held by the approval queue as well.",
    ...P,
  }),
  D("POST", "/api/hr/password-management/reset-password/:userType/:id", [C.HR_ACCESS, C.SECURITY_CREDENTIALS_MANAGE], {
    persona: "HR owner",
    /* The ONE operation whose whole purpose is to generate a one-time
       credential and hand it to the administrator who asked for it. Opted in
       by name, not by capability: every other route in this family holds
       `security.credentials.manage` too, and a list, a lookup or a sync has no
       business returning a password. */
    credentialDelivery: true,
    note: "Generates a one-time password and returns it once. The only declaration in the contract with credentialDelivery.",
    ...P,
  }),
  D("POST", "/api/hr/password-management/bulk-reset", [C.HR_ACCESS, C.SECURITY_CREDENTIALS_MANAGE], {
    persona: "HR owner",
    note: "Deliberately NOT credentialDelivery. It reset every selected account to the same derived default and returned the plaintext for each one — a bulk credential dump. It returns identifiers and per-row status only; the passwords are set, not shown.",
    ...P,
  }),

  /* ══════════════════════════════════════════════════════════════════════════
   *  MOBILE APP DISTRIBUTION — mounted under /api/hr, owned by nobody in HR
   * ══════════════════════════════════════════════════════════════════════════ */
  D("GET", "/api/hr/app/latest", [], { ...PUB, persona: "the employee mobile app", note: "The app's own update check, called before anybody signs in." }),
  D("GET", "/api/hr/app/download/:id", [], { ...PUB, persona: "the employee mobile app" }),
  D("GET", "/api/hr/app/versions", [C.HR_ACCESS, C.HR_CONFIGURATION_MANAGE], { persona: "HR owner" }),
  D("POST", "/api/hr/app/upload", [C.HR_ACCESS, C.HR_CONFIGURATION_MANAGE], { persona: "HR owner" }),
  D("PATCH", "/api/hr/app/versions/:id/set-latest", [C.HR_ACCESS, C.HR_CONFIGURATION_MANAGE], { persona: "HR owner" }),
  D("DELETE", "/api/hr/app/versions/:id", [C.HR_ACCESS, C.HR_CONFIGURATION_MANAGE], { persona: "HR owner" }),

  /* ══════════════════════════════════════════════════════════════════════════
   *  VENDORS UNDER /api/hr — NOT HR's to own
   *
   *  COMPATIBILITY. `server.js` mounts the Supply Chain vendor router at
   *  /api/hr/vendors, and the audit's disposition is "remove from HR" (§5).
   *  Moving it is a navigation change and out of scope here, so it is declared
   *  with HR application access and NO people/compensation capability — it
   *  reads no workforce data — and listed as an exception.
   * ══════════════════════════════════════════════════════════════════════════ */
  D("GET", "/api/hr/vendors/dashboard/stats", [C.HR_ACCESS], { persona: "supply chain (mounted under HR)" }),
  D("GET", "/api/hr/vendors/:id", [C.HR_ACCESS], { persona: "supply chain (mounted under HR)" }),
  D("GET", "/api/hr/vendors", [C.HR_ACCESS], { persona: "supply chain (mounted under HR)" }),
  D("POST", "/api/hr/vendors/quick-add", [C.HR_ACCESS, C.HR_CONFIGURATION_MANAGE], { persona: "supply chain (mounted under HR)" }),
  D("POST", "/api/hr/vendors", [C.HR_ACCESS, C.HR_CONFIGURATION_MANAGE], { persona: "supply chain (mounted under HR)" }),
  D("PUT", "/api/hr/vendors/:id", [C.HR_ACCESS, C.HR_CONFIGURATION_MANAGE], { persona: "supply chain (mounted under HR)" }),
  D("DELETE", "/api/hr/vendors/:id", [C.HR_ACCESS, C.HR_CONFIGURATION_MANAGE], { persona: "supply chain (mounted under HR)" }),

  /* ══════════════════════════════════════════════════════════════════════════
   *  CEO / MANAGEMENT HR PROJECTION — read-only, field-restricted
   * ══════════════════════════════════════════════════════════════════════════ */
  D("GET", "/api/ceo/hr/employees/:id/sop-points", [C.HR_ACCESS, C.SKILLS_READ], { persona: "management", ...P }),
  D("GET", "/api/ceo/hr/employees/:id", [C.HR_ACCESS, C.PEOPLE_READ_DIRECTORY], { persona: "management" }),
  D("GET", "/api/ceo/hr/employees", [C.HR_ACCESS, C.PEOPLE_READ_DIRECTORY], { persona: "management" }),
  D("GET", "/api/ceo/hr/departments", [C.HR_ACCESS, C.PEOPLE_READ_DIRECTORY], { persona: "management" }),
  D("GET", "/api/ceo/hr/attendance/departments", [C.HR_ACCESS, C.ATTENDANCE_READ], { persona: "management" }),
  D("GET", "/api/ceo/hr/attendance/daily", [C.HR_ACCESS, C.ATTENDANCE_READ], { persona: "management" }),
  D("GET", "/api/ceo/hr/attendance/muster-roll", [C.HR_ACCESS, C.ATTENDANCE_READ], { persona: "management" }),
  D("GET", "/api/ceo/hr/attendance/summary", [C.HR_ACCESS, C.ATTENDANCE_READ], { persona: "management" }),
  D("GET", "/api/ceo/hr/attendance/export", [C.HR_ACCESS, C.ATTENDANCE_READ, C.ANALYTICS_WORKFORCE], { persona: "management" }),
  D("POST", "/api/ceo/hr/attendance/sync", [C.HR_ACCESS, C.ATTENDANCE_CLOSE], {
    persona: "attendance approver — NOT management",
    note: "The only non-GET under /api/ceo/hr. It is declared with the attendance CLOSE capability, which the CEO projection template does not hold, so the projection stays read-only. Nothing breaks: the handler proxies to `/hr/attendance/sync`, a path that does not exist (the real one is /sync-period), so it has been answering the proxy's 404 since it shipped.",
  }),

  /* ══════════════════════════════════════════════════════════════════════════
   *  EMPLOYEE SELF-SERVICE — /api/employee/**
   *
   *  A different token (employee_token, AllEmployeeAppMiddleware) and a
   *  different kind of authority: these are authorised by the RECORD, not by an
   *  HR grant, so none of them carry `hr.access`. `scope: "self"` refuses any
   *  request that names another employee; `scope: "manager"` additionally
   *  relies on the handler's stored reporting proof.
   * ══════════════════════════════════════════════════════════════════════════ */
  D("GET", "/api/employee/profile/edit", [], { ...SELF([]), persona: "employee" }),
  D("GET", "/api/employee/profile", [], { ...SELF([]), persona: "employee" }),
  D("PUT", "/api/employee/profile", [], { ...SELF([]), persona: "employee" }),
  D("PUT", "/api/employee/change-password", [], { ...SELF([]), persona: "employee", note: "Own credentials. Never HR's approval queue." }),
  D("GET", "/api/employee/dashboard", [], { ...SELF([]), persona: "employee" }),
  D("GET", "/api/employee/salary", [], { ...SELF([]), persona: "employee", note: "The employee's OWN pay. Self-scope is the whole authority; no compensation capability is involved because it is their own figure.", ...P }),
  D("GET", "/api/employee/basic-info", [], { ...SELF([]), persona: "employee" }),

  D("GET", "/api/employee/attendance/today", [], { ...SELF([]), persona: "employee" }),
  D("GET", "/api/employee/attendance/monthly", [], { ...SELF([]), persona: "employee" }),
  D("POST", "/api/employee/attendance/sync-today", [], { ...SELF([]), persona: "employee" }),

  D("GET", "/api/employee/performance", [], { ...SELF([]), persona: "employee" }),
  D("GET", "/api/employee/leaderboard", [], { ...SELF([]), persona: "employee", note: "Ranks on positive signal only; never a colleague's absence or SOP record." }),
  D("GET", "/api/employee/absence-calendar/day", [], { ...SELF([]), persona: "employee" }),
  D("GET", "/api/employee/absence-calendar", [], { ...SELF([]), persona: "employee" }),

  D("GET", "/api/employee/payslip/employees", [], { ...SELF([]), persona: "employee" }),
  D("GET", "/api/employee/payslip/:employeeId/history", [], { ...SELF(["employeeId"]), persona: "employee", ...P }),
  D("GET", "/api/employee/payslip/:employeeId/pdf", [], { ...SELF(["employeeId"]), persona: "employee", ...P }),
  D("GET", "/api/employee/payslip/:employeeId", [], { ...SELF(["employeeId"]), persona: "employee", ...P }),

  D("GET", "/api/employee/documents/types", [], { ...SELF([]), persona: "employee" }),
  D("GET", "/api/employee/documents/:id/download", [], { ...PUB, persona: "employee, via a short-lived signed link", note: "COMPATIBILITY: the download carries its own signed token instead of a session, so the browser can follow the link. The router verifies it and never projects an unreleased row." }),
  D("GET", "/api/employee/documents/:id/file", [], { ...SELF([]), persona: "employee", ...P }),
  D("GET", "/api/employee/documents/:id", [], { ...SELF([]), persona: "employee", ...P }),
  D("GET", "/api/employee/documents", [], { ...SELF([]), persona: "employee" }),
  D("POST", "/api/employee/documents/requests", [], { ...SELF([]), persona: "employee" }),
  D("PATCH", "/api/employee/documents/:id/cancel", [], { ...SELF([]), persona: "employee" }),

  D("GET", "/api/employee/leave-applications/config", [], { ...SELF([]), persona: "employee" }),
  D("GET", "/api/employee/leave-applications/holidays", [], { ...SELF([]), persona: "employee" }),
  D("GET", "/api/employee/leave-applications/balance", [], { ...SELF([]), persona: "employee" }),
  D("GET", "/api/employee/leave-applications/calendar", [], { ...SELF([]), persona: "employee" }),
  D("GET", "/api/employee/leave-applications/manager/my-team", [], { ...MGR_QUEUE, persona: "manager" }),
  D("GET", "/api/employee/leave-applications/manager/pending", [], { ...MGR_QUEUE, persona: "manager" }),
  D("GET", "/api/employee/leave-applications/manager/withdraw-pending", [], { ...MGR_QUEUE, persona: "manager" }),
  D("GET", "/api/employee/leave-applications/manager/history", [], { ...MGR_HISTORY, persona: "manager" }),
  D("PUT", "/api/employee/leave-applications/manager/:id/edit", [], { ...MGR({ record: "leave", param: "id" }), persona: "manager" }),
  D("PATCH", "/api/employee/leave-applications/manager/:id/approve", [], { ...MGR({ record: "leave", param: "id" }), persona: "manager" }),
  D("PATCH", "/api/employee/leave-applications/manager/:id/reject", [], { ...MGR({ record: "leave", param: "id" }), persona: "manager" }),
  D("PATCH", "/api/employee/leave-applications/manager/:id/approve-withdraw", [], { ...MGR({ record: "leave", param: "id" }), persona: "manager" }),
  D("PATCH", "/api/employee/leave-applications/manager/:id/reject-withdraw", [], { ...MGR({ record: "leave", param: "id" }), persona: "manager" }),
  D("POST", "/api/employee/leave-applications/manager/add-on-behalf", [], {
    ...MGR({ employeeFrom: "body.employeeId" }),
    persona: "manager",
    note: "Takes an employeeId in the body and proves the reporting relationship against the stored primaryManager/secondaryManager before writing. That proof is the authority — the id in the body is not.",
  }),
  D("POST", "/api/employee/leave-applications/quick-apply", [], { ...SELF([]), persona: "employee" }),
  D("PATCH", "/api/employee/leave-applications/quick-apply/:id/resolve", [], { ...MGR({ record: "leave", param: "id" }), persona: "manager" }),
  D("GET", "/api/employee/leave-applications/:id", [], { ...SELF([]), persona: "employee", ...P }),
  D("GET", "/api/employee/leave-applications", [], { ...SELF([]), persona: "employee" }),
  D("POST", "/api/employee/leave-applications", [], { ...SELF([]), persona: "employee" }),
  D("PUT", "/api/employee/leave-applications/:id", [], { ...SELF([]), persona: "employee" }),
  D("DELETE", "/api/employee/leave-applications/:id", [], { ...SELF([]), persona: "employee" }),
  D("PATCH", "/api/employee/leave-applications/:id/cancel", [], { ...SELF([]), persona: "employee" }),
  D("PATCH", "/api/employee/leave-applications/:id/cancel-withdraw", [], { ...SELF([]), persona: "employee" }),
  D("POST", "/api/employee/leave-applications/:id/upload-document", [], { ...SELF([]), persona: "employee", ...P }),

  D("GET", "/api/employee/regularizations/manager/pending", [], { ...MGR_QUEUE, persona: "manager" }),
  D("GET", "/api/employee/regularizations/manager/history", [], { ...MGR_HISTORY, persona: "manager" }),
  D("PATCH", "/api/employee/regularizations/manager/:id/approve", [], { ...MGR({ record: "regularization", param: "id" }), persona: "manager" }),
  D("PATCH", "/api/employee/regularizations/manager/:id/reject", [], { ...MGR({ record: "regularization", param: "id" }), persona: "manager" }),
  D("GET", "/api/employee/regularizations", [], { ...SELF([]), persona: "employee" }),
  D("POST", "/api/employee/regularizations", [], { ...SELF([]), persona: "employee" }),
  D("PATCH", "/api/employee/regularizations/:id/cancel", [], { ...SELF([]), persona: "employee" }),

  D("GET", "/api/employee/overtime/manager/pending", [], { ...MGR_QUEUE, persona: "manager" }),
  D("PATCH", "/api/employee/overtime/manager/:id/approve", [], { ...MGR({ record: "overtime", param: "id" }), persona: "manager" }),
  D("PATCH", "/api/employee/overtime/manager/:id/reject", [], { ...MGR({ record: "overtime", param: "id" }), persona: "manager" }),
  D("GET", "/api/employee/overtime/check", [], { ...SELF([]), persona: "employee" }),
  D("GET", "/api/employee/overtime/my", [], { ...SELF([]), persona: "employee" }),
  D("POST", "/api/employee/overtime/submit", [], { ...SELF([]), persona: "employee" }),

  /* Employee app plumbing under /api/employee that carries no HR data. Declared
     so the coverage test has an answer for every mounted route, not because
     they are HR endpoints. */
  D("POST", "/api/employee/push-token", [], { ...SELF([]), persona: "employee app" }),
  D("DELETE", "/api/employee/push-token", [], { ...SELF([]), persona: "employee app" }),
  D("GET", "/api/employee/push-token/debug", [], { ...SELF([]), persona: "employee app" }),
  D("POST", "/api/employee/test-web-push", [], { ...SELF([]), persona: "employee app" }),
  D("GET", "/api/employee/notification-settings", [], { ...SELF([]), persona: "employee app" }),
  D("POST", "/api/employee/notification-settings/register", [], { ...SELF([]), persona: "employee app" }),
  D("PUT", "/api/employee/notification-settings/:deviceId", [], { ...SELF([]), persona: "employee app", note: "The handler deletes/updates by an owner filter built from the token, so a device id belonging to somebody else answers 404 rather than being edited." }),
  D("DELETE", "/api/employee/notification-settings/:deviceId", [], { ...SELF([]), persona: "employee app" }),
  D("GET", "/api/employee/tasks/my-tasks", [], { ...SELF([]), persona: "employee app" }),
  D("GET", "/api/employee/tasks/task/:taskId", [], { ...SELF([]), persona: "employee app" }),
  D("PATCH", "/api/employee/tasks/task/:taskId/status", [], { ...SELF([]), persona: "employee app" }),
  D("POST", "/api/employee/tasks/:taskId/feedback", [], { ...SELF([]), persona: "employee app" }),
  D("GET", "/api/employee/tasks/debug/user-info", [], { ...SELF([]), persona: "employee app" }),
  D("GET", "/api/employee/tasks/debug/all-tasks", [], { ...SELF([]), persona: "employee app" }),

  /* The employee app's own sign-in. Unauthenticated by definition. */
  D("POST", "/api/employee/auth/login", [], { ...PUB, persona: "employee app" }),
  D("POST", "/api/employee/auth/logout", [], { ...PUB, persona: "employee app" }),
  D("GET", "/api/employee/auth/verify", [], { ...PUB, persona: "employee app", note: "Verifies the app's own token and answers about the caller only." }),
  D("GET", "/api/employee/auth/profile", [], { ...PUB, persona: "employee app", note: "Router-authenticated: it reads the app token itself and returns the caller's own record." }),
  D("POST", "/api/employee/auth/change-password", [], { ...PUB, persona: "employee app", note: "Router-authenticated; the employee's own credentials." }),

  /* The public identity page — a QR/ID-card lookup by opaque identityId. */
  D("GET", "/employee/public/:identityId", [], {
    ...PUB,
    persona: "anyone holding the ID card",
    note: "Deliberately unauthenticated and deliberately directory-class only. Listed here so the matrix is complete and the field test has something to assert against.",
  }),
];

/* ── Matching ────────────────────────────────────────────────────────────────
 *
 * Declarations are compiled to regexes once and sorted MOST SPECIFIC FIRST, so
 * `/api/hr/documents/:id/release` wins over `/api/hr/documents/:id`. Specificity
 * is "more segments, then more literal segments" — the two things that make one
 * pattern narrower than another.
 */
function compile(path) {
  const source = path
    .split("/")
    .map((seg) => {
      if (seg === "") return "";
      if (seg === "*") return "[^/]*";
      if (seg.startsWith(":")) return "[^/]+";
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return new RegExp(`^${source}/?$`, "i");
}

/**
 * The values a declaration's `:params` take for a concrete path.
 *
 * NEEDED BECAUSE THE GUARD IS MOUNT-LEVEL. `app.use(prefix, guard)` runs before
 * any route matches, so `req.params` is empty — a self-scope check reading it
 * would find nothing, conclude the request names nobody, and let
 * `/api/employee/payslip/<somebody-else>` straight through. The declaration
 * knows where the id sits in the path, so it is read from there instead.
 */
function extractParams(declaration, fullPath) {
  const out = {};
  if (!declaration) return out;
  const want = declaration.path.split("/");
  const got = String(fullPath || "").split("?")[0].replace(/\/+$/, "").split("/");
  for (let i = 0; i < want.length; i += 1) {
    const seg = want[i];
    if (!seg.startsWith(":")) continue;
    const value = got[i];
    if (value !== undefined) out[seg.slice(1)] = decodeURIComponent(value);
  }
  return out;
}

function specificity(path) {
  const segs = path.split("/").filter(Boolean);
  const literals = segs.filter((s) => !s.startsWith(":") && s !== "*").length;
  return segs.length * 100 + literals;
}

const COMPILED = DECLARATIONS.map((d) => ({
  ...d,
  regex: compile(d.path),
  _spec: specificity(d.path),
})).sort((a, b) => b._spec - a._spec || a.path.localeCompare(b.path));

/**
 * The declaration for one request, or null when the route is undeclared.
 *
 * `null` is a REFUSAL, not a pass: Middlewear/hrContract.js turns it into a 403
 * and the coverage test turns it into a failing build.
 */
function findDeclaration(method, fullPath) {
  const verb = String(method || "").toUpperCase();
  const path = String(fullPath || "").split("?")[0];
  for (const d of COMPILED) {
    if (d.method !== "*" && d.method !== verb) continue;
    if (d.regex.test(path)) return d;
  }
  return null;
}

/** Every prefix this contract claims. Used by the mount wiring and the tests. */
const GUARDED_PREFIXES = Object.freeze([
  "/api/hr",
  "/hr",
  "/api/employees",
  "/api/ceo/hr",
  "/api/employee",
  "/employee/public",
]);

/** Self-test: no declaration may name a capability the catalogue does not have. */
function validateDeclarations() {
  const problems = [];
  const seen = new Set();
  for (const d of DECLARATIONS) {
    const key = `${d.method} ${d.path}`;
    if (seen.has(key)) problems.push(`duplicate declaration: ${key}`);
    seen.add(key);
    for (const cap of d.capabilities) {
      if (!isCapability(cap)) problems.push(`${key} names an unknown capability: ${cap}`);
    }
    if (!["hr", "self", "manager", "public"].includes(d.scope)) {
      problems.push(`${key} has an unknown scope: ${d.scope}`);
    }
    if (d.scope !== "public" && d.scope !== "self" && d.scope !== "manager" && !d.capabilities.length) {
      problems.push(`${key} is an HR-scope declaration with no capability`);
    }
    /* A manager declaration with no descriptor would be authorised by nothing
       but a valid session — which is the hole this replaced. */
    if (d.scope === "manager" && !d.managerScope) {
      problems.push(`${key} is a manager-scope declaration with no managerScope descriptor`);
    }
    /* `queue: true` was the shortcut that let every authenticated employee
       through. A queue descriptor has to say WHICH persona rule proves it. */
    if (d.managerScope?.queue !== undefined && !["current", "history"].includes(d.managerScope.queue)) {
      problems.push(`${key} has an unknown manager queue mode: ${d.managerScope.queue}`);
    }
  }
  return problems;
}

module.exports = {
  DECLARATIONS,
  COMPILED,
  GUARDED_PREFIXES,
  findDeclaration,
  extractParams,
  validateDeclarations,
  compile,
};
