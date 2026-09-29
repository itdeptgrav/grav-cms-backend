"use strict";
/**
 * services/access/hrCapabilities.js — the HR capability catalogue and the
 * default role templates that hand capabilities out.
 *
 * WHY A CATALOGUE AND NOT ROLE STRINGS
 * ------------------------------------
 * Before this file the question "may you do this in HR?" was answered in three
 * incompatible ways depending on which router you happened to reach:
 *
 *   • `EmployeeAuthMiddlewear` alone            — proves a session, nothing else
 *   • `role === "hr_manager"` string equality   — Passwordmanagement.js, payroll
 *   • `departmentWrites("hr")` at the mount     — writes only, reads untouched
 *
 * None of them can express "may read the directory but not compensation", which
 * is the distinction HR data actually needs. A capability is that distinction:
 * one stable machine name per OPERATION, granted by template, checked by the
 * central resolver in services/access/hrAuthorization.js.
 *
 * The catalogue is deliberately WIDER than the routes that exist today. Chunks
 * 5-16 of docs/tasks/hrms-roadmap.md bring skills, training, compliance and
 * cases; naming their capabilities now means those modules inherit the contract
 * instead of inventing a second one. `WIRED` below records which subset is
 * actually enforced by a mounted route right now, so "extensible" never becomes
 * "unaudited".
 */

/* ── The catalogue ───────────────────────────────────────────────────────────
 * Grouped for reading only; the values are flat strings and that is what every
 * check compares. Never renamed once shipped — a capability name is stored in
 * grants and printed in denial codes.
 */
const CAPABILITIES = Object.freeze({
  /* Opening the HR application at all. Every other HR capability implies it,
     but it is checked separately so "you are not an HR user" and "you are an HR
     viewer who may not do this" are different answers. */
  HR_ACCESS: "hr.access",

  /* People */
  PEOPLE_READ_DIRECTORY: "people.read.directory",
  PEOPLE_READ_PRIVATE: "people.read.private",
  /* Two narrower reads carved out of the private class because the plan puts
     them in the HIGHLY RESTRICTED bucket alongside pay, not in the ordinary
     private one: government/statutory identifiers, and medical or disability
     information. Both are held by HR operations (editor and above) because HR
     genuinely files statutory returns and records fitness — and by neither the
     CEO/Management projection nor any viewer. Naming them separately is what
     makes "do not broaden management access to government IDs or medical
     information" an enforced rule rather than a sentence in a document. */
  PEOPLE_READ_IDENTIFIERS: "people.read.identifiers",
  PEOPLE_READ_MEDICAL: "people.read.medical",
  PEOPLE_WRITE: "people.write",
  EMPLOYMENT_CHANGE: "employment.change",

  /* Compensation — never implied by any people capability */
  COMPENSATION_READ: "compensation.read",
  COMPENSATION_WRITE: "compensation.write",

  /* Time */
  ATTENDANCE_READ: "attendance.read",
  ATTENDANCE_CORRECT: "attendance.correct",
  ATTENDANCE_CLOSE: "attendance.close",

  /* Leave */
  LEAVE_READ: "leave.read",
  LEAVE_CONFIGURE: "leave.configure",
  LEAVE_DECIDE_MANAGER: "leave.decide.manager",
  LEAVE_DECIDE_HR: "leave.decide.hr",

  /* Payroll */
  PAYROLL_READ: "payroll.read",
  PAYROLL_PREPARE: "payroll.prepare",
  PAYROLL_APPROVE: "payroll.approve",
  PAYROLL_REOPEN: "payroll.reopen",

  /* Recruitment */
  RECRUITMENT_READ: "recruitment.read",
  RECRUITMENT_MANAGE: "recruitment.manage",
  OFFER_APPROVE: "offer.approve",
  HIRE_CONVERT: "hire.convert",

  /* Documents */
  DOCUMENTS_READ: "documents.read",
  DOCUMENTS_ISSUE: "documents.issue",
  DOCUMENTS_RELEASE: "documents.release",

  /* Skills */
  SKILLS_READ: "skills.read",
  SKILLS_ASSESS: "skills.assess",
  TRAINING_MANAGE: "training.manage",

  /* Compliance and cases */
  COMPLIANCE_READ: "compliance.read",
  COMPLIANCE_MANAGE: "compliance.manage",
  CASES_MANAGE: "cases.manage",

  /* Analytics and audit */
  ANALYTICS_WORKFORCE: "analytics.workforce",
  AUDIT_READ: "audit.read",
  AUDIT_EXPORT: "audit.export",

  /* Administration */
  SECURITY_CREDENTIALS_MANAGE: "security.credentials.manage",
  HR_CONFIGURATION_MANAGE: "hr.configuration.manage",
});

const ALL_CAPABILITIES = Object.freeze(Object.values(CAPABILITIES));
const CAPABILITY_SET = new Set(ALL_CAPABILITIES);

/** Is this a name the catalogue knows? Used by the registry's own self-test. */
function isCapability(name) {
  return CAPABILITY_SET.has(String(name || ""));
}

/* ── Role templates ──────────────────────────────────────────────────────────
 *
 * A template is a DEFAULT capability set, not a stored object. The stored thing
 * is still the DepartmentRole row an administrator manages in Access Control
 * (viewer / editor / approver / owner); this file says what each of those means
 * inside HR. Keeping the mapping here rather than in the role row means an
 * upgrade to the meaning of "editor" is one reviewable diff, not a migration.
 */
const C = CAPABILITIES;

/* Everything a viewer may READ. Deliberately excludes compensation, private
   identity, audit export and confidential cases: those are separate grants. */
const VIEWER = [
  C.HR_ACCESS,
  C.PEOPLE_READ_DIRECTORY,
  C.ATTENDANCE_READ,
  C.LEAVE_READ,
  C.RECRUITMENT_READ,
  C.DOCUMENTS_READ,
  C.SKILLS_READ,
  C.COMPLIANCE_READ,
  C.ANALYTICS_WORKFORCE,
  C.AUDIT_READ,
];

/* An editor does the day-to-day work of HR operations. Writes still pass
   through the existing approval queue (Middlewear/departmentWriteGuard) — this
   says WHICH operations they may attempt, not that they commit unreviewed. */
const EDITOR = [
  ...VIEWER,
  C.PEOPLE_READ_PRIVATE,
  C.PEOPLE_READ_IDENTIFIERS,
  C.PEOPLE_READ_MEDICAL,
  C.PEOPLE_WRITE,
  C.EMPLOYMENT_CHANGE,
  C.ATTENDANCE_CORRECT,
  C.LEAVE_DECIDE_HR,
  C.RECRUITMENT_MANAGE,
  C.HIRE_CONVERT,
  C.DOCUMENTS_ISSUE,
  C.SKILLS_ASSESS,
  C.TRAINING_MANAGE,
  C.PAYROLL_READ,
];

/* An approver signs things off. The separations that matter are here and are
   the point of the whole exercise: preparing payroll is not approving it,
   correcting a day is not closing a period, issuing a document is not
   releasing it to the employee. */
const APPROVER = [
  ...EDITOR,
  C.COMPENSATION_READ,
  C.ATTENDANCE_CLOSE,
  C.LEAVE_CONFIGURE,
  C.PAYROLL_PREPARE,
  C.PAYROLL_APPROVE,
  C.OFFER_APPROVE,
  C.DOCUMENTS_RELEASE,
  C.COMPLIANCE_MANAGE,
  C.AUDIT_EXPORT,
];

/* The owner of the HR application. Holds the three capabilities nobody else
   does: reopening a closed payroll, administering other people's credentials,
   and changing HR configuration. Confidential cases are owner-level because
   grievance and disciplinary material must be narrower than general HR access
   (hrms-professionalisation-plan.md §5.11). */
const OWNER = [
  ...APPROVER,
  C.COMPENSATION_WRITE,
  C.PAYROLL_REOPEN,
  C.CASES_MANAGE,
  C.SECURITY_CREDENTIALS_MANAGE,
  C.HR_CONFIGURATION_MANAGE,
];

/* ── CEO / Management read-only projection ───────────────────────────────────
 *
 * NOT owner-with-a-different-name. Management gets aggregate workforce signal
 * and the directory; it does not get compensation, government identifiers,
 * medical information or confidential cases merely for being powerful
 * (hrms-professionalisation-plan.md §4, §14.7 — the open product question).
 *
 * Read-only is enforced structurally: nothing in this list is a write
 * capability, so every mutating HR declaration refuses a CEO session.
 */
const CEO_PROJECTION = [
  C.HR_ACCESS,
  C.PEOPLE_READ_DIRECTORY,
  C.ATTENDANCE_READ,
  C.LEAVE_READ,
  C.ANALYTICS_WORKFORCE,
  /* The CEO employee page reads SOP points per person, and has since before
     this contract existed. It is a performance record rather than private
     identity, so it rides `skills.read` — a READ capability, which keeps the
     projection read-only. */
  C.SKILLS_READ,
];

/* ── Platform administrator ──────────────────────────────────────────────────
 *
 * COMPATIBILITY EXCEPTION, recorded rather than blessed. A platform
 * administrator (DeptUser.isAdmin) is today waved through every department
 * guard in the codebase — services/departmentRoles.js:requireDepartmentRole and
 * services/changeRequests.js:requireApproval both do it explicitly. Narrowing
 * that here would change behaviour far outside HR, so the template mirrors
 * today's reality and the exception is documented in
 * docs/decisions/hr-authorisation-contract.md instead of being made invisible.
 *
 * It is written as an explicit list, not "everything", so the day someone
 * decides an administrator should not read compensation the change is one line
 * here and a test, not an archaeology exercise.
 */
const PLATFORM_ADMIN = [...OWNER];

/* ── Self-service ────────────────────────────────────────────────────────────
 *
 * These two are NOT HR application access and deliberately do not include
 * `hr.access`. They exist so the same resolver can answer for the employee app
 * and the manager inbox, where authority comes from the RECORD (it is mine / I
 * am the proven manager) and never from an HR grant.
 */
const EMPLOYEE_SELF = [
  C.PEOPLE_READ_DIRECTORY,
  C.ATTENDANCE_READ,
  C.LEAVE_READ,
  C.DOCUMENTS_READ,
];

const MANAGER_SELF = [
  ...EMPLOYEE_SELF,
  C.LEAVE_DECIDE_MANAGER,
];

const ROLE_TEMPLATES = Object.freeze({
  hr_viewer: Object.freeze([...new Set(VIEWER)]),
  hr_editor: Object.freeze([...new Set(EDITOR)]),
  hr_approver: Object.freeze([...new Set(APPROVER)]),
  hr_owner: Object.freeze([...new Set(OWNER)]),
  platform_admin: Object.freeze([...new Set(PLATFORM_ADMIN)]),
  ceo_projection: Object.freeze([...new Set(CEO_PROJECTION)]),
  employee_self: Object.freeze([...new Set(EMPLOYEE_SELF)]),
  manager_self: Object.freeze([...new Set(MANAGER_SELF)]),
});

const TEMPLATE_NAMES = Object.freeze(Object.keys(ROLE_TEMPLATES));

/**
 * The DepartmentRole vocabulary (viewer/editor/approver/owner) → HR template.
 *
 * One place, so a route never compares a role string again.
 */
const DEPARTMENT_ROLE_TEMPLATE = Object.freeze({
  viewer: "hr_viewer",
  editor: "hr_editor",
  approver: "hr_approver",
  owner: "hr_owner",
});

/* ── Legacy token roles ──────────────────────────────────────────────────────
 *
 * TEMPORARY, CENTRAL, TESTABLE — the three properties the roadmap asks of this
 * mapping (Chunk 1: "temporary compatibility mapping for legacy `hr_manager`
 * tokens").
 *
 * These strings are the `role` claim minted by routes/login.js and
 * routes/auth/deptAuth.js from AccessDepartment.legacyRole. They are SIGNED
 * server-side, which is why they may be read at all — but they are still only
 * an assertion about which department collection somebody authenticated
 * against, so they map to APPLICATION ACCESS and nothing more. The capability
 * set that follows is then resolved from real grant records exactly as it is
 * for anybody else; see hrAuthorization.js.
 *
 * Anything not in this map grants nothing, however plausible it looks. A token
 * carrying `role: "hr_superuser"` is an unknown string, not a capability.
 */
const LEGACY_HR_ROLES = Object.freeze({
  hr_manager: "hr",
  hr: "hr",
});

const LEGACY_BOARD_ROLES = Object.freeze({
  ceo: "ceo",
});

const LEGACY_ADMIN_ROLES = Object.freeze({
  admin: "admin",
  super_admin: "admin",
  superadmin: "admin",
});

/**
 * Capabilities actually enforced by a mounted route in this chunk.
 *
 * Computed from the route contract rather than hand-maintained, so it cannot
 * drift. Required lazily: the registry requires this module.
 */
function wiredCapabilities() {
  const { DECLARATIONS } = require("./hrRouteContract");
  const used = new Set();
  for (const d of DECLARATIONS) {
    for (const cap of d.capabilities || []) used.add(cap);
  }
  return [...used].sort();
}

/** Does this capability list satisfy every capability the route needs? */
function hasAll(held, required) {
  if (!required || required.length === 0) return true;
  const set = held instanceof Set ? held : new Set(held || []);
  return required.every((cap) => set.has(cap));
}

/** The first capability in `required` that `held` is missing, or null. */
function firstMissing(held, required) {
  const set = held instanceof Set ? held : new Set(held || []);
  return (required || []).find((cap) => !set.has(cap)) || null;
}

module.exports = {
  CAPABILITIES,
  ALL_CAPABILITIES,
  ROLE_TEMPLATES,
  TEMPLATE_NAMES,
  DEPARTMENT_ROLE_TEMPLATE,
  LEGACY_HR_ROLES,
  LEGACY_BOARD_ROLES,
  LEGACY_ADMIN_ROLES,
  isCapability,
  hasAll,
  firstMissing,
  wiredCapabilities,
};
