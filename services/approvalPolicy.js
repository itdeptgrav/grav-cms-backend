// services/approvalPolicy.js
//
// Which edits actually need an approver, and which are just work.
//
// ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────
// The approval queue held EVERY write an editor made. Correcting a spelling in
// somebody's name, fixing a date of birth, updating a phone number — each one
// stopped, waited for an owner, and arrived on their queue looking exactly as
// important as a change to somebody's pay. A queue where most items do not
// matter is a queue that stops being read, and then the items that DO matter go
// through on a glance. Holding everything and holding nothing fail the same
// way.
//
// ── THE OWNER'S RULE, 3 SEP 2026: ONLY SALARY ASKS ──────────────────────────
// On the employee record, an editor's change waits for an approver when — and
// only when — it changes what somebody is PAID. Everything else commits when
// the editor saves it and is answered for by the change history: names, dates,
// contact details, documents, identifiers, department, designation, the shift,
// the bank account, whether they are active. That is the line the owner drew,
// and it replaces the earlier, wider one ("the encrypted fields").
//
// Two things are still held that are not pay, and they are named so nobody
// mistakes the omission for an oversight: a PASSWORD is somebody else's login,
// and a ROLE or PERMISSION is what an account may do. An editor who could grant
// themselves approver would make this whole file decorative.
//
// ── WHAT "SALARY" MEANS HERE ────────────────────────────────────────────────
// The INPUTS: gross, basic, HRA, stipend, food allowance, the other deduction,
// the statutory overrides. The DERIVED figures — ESIC, employer cost, net,
// total deduction — are recomputed by the server from the inputs on every save
// (routes/HrRoutes/Employee-Section.js) and the form sends them only for
// reference. A derived figure that differs from what is stored, with no input
// changed, is the formula catching up with a rule change, not a decision an
// approver can take. Holding it produced eleven rows of "EDLI: 52 → 75" beside
// a one-field edit that changed no pay at all.
//
// A salary leaf nobody has classified is still held: EDLI and admin charges
// were ADDED to the salary object recently, and a new input let through by
// omission is money.
//
// ── ATTENDANCE: ONLY AN OVERWRITE ASKS ──────────────────────────────────────
// Same owner, same day. Overwriting what a day of attendance says — a day
// override, a bulk override, a punch correction, removing days from a month —
// waits. Assigning somebody a shift, rotating shifts, changing shift rules,
// holidays, syncing the device: ordinary work, and none of it changes what a
// day already says. A regularisation approved by HR does overwrite a day, and
// stays held for that reason.
//
// ── CREATE AND DELETE ───────────────────────────────────────────────────────
// Creating or deleting an EMPLOYEE is held: a new employee carries a salary
// from the moment they exist, and a deletion cannot be reviewed afterwards.
// Other creates and deletes in the department are ordinary work.

"use strict";

/**
 * The salary INPUTS — the fields an approver is actually deciding on.
 *
 * `epf`, `edli` and `adminCharges` are here because the form lets HR override
 * them (the `*Override` flags); when the override is off they are derived and
 * the server recomputes them anyway, so a matching value is no diff.
 */
const SALARY_INPUTS = new Set([
  "gross", "grossSalary", "basic", "hra",
  "stipend", "internStipendType", "internStart", "internEnd",
  "foodAllowance", "foodAllowanceFull", "otherDeduction",
  "epf", "edli", "adminCharges",
  "epfOverride", "edliOverride", "adminOverride",
]);

/**
 * Figures the server derives from the inputs on every save. Sent by the form
 * for reference; never a decision.
 */
const SALARY_DERIVED = new Set([
  "eeesic", "erEsic", "employerCost", "totalDeduction", "netSalary",
  "allowances", "deductions",
]);

/** Prefixes that always need an approver, whatever the leaf is called. */
const SENSITIVE_PREFIXES = ["salaryCustomFields"];

/**
 * Top-level fields that always need an approver.
 *
 * Pay, under the aliases it appears under outside the `salary.` object, and
 * access. Nothing else — see the header.
 */
const SENSITIVE_FIELDS = new Set([
  ...SALARY_INPUTS,
  // ACCESS. A password is somebody else's account; a role is what they may do.
  "password", "role", "isAdmin", "permissions",
]);

/**
 * Fields the earlier rule listed as routine. Kept as documentation of what the
 * employee form carries — the classifier no longer needs a field to be on
 * this list to let it through.
 */
const ROUTINE_FIELDS = new Set([
  "title", "firstName", "middleName", "lastName", "nickName", "gender",
  "fatherFirstName", "fatherMiddleName", "fatherLastName", "fatherDOB",
  "motherFirstName", "motherMiddleName", "motherLastName",
  "spouseName", "maritalStatus", "marriageDate",
  "dateOfBirth", "bloodGroup", "nationality", "residentialStatus",
  "placeOfBirth", "countryOfOrigin", "religion",
  "isInternational", "isPhysicallyChallenged",
  "personalEmail", "phone", "alternatePhone", "workPhone",
  "currentStreet", "currentCity", "currentState", "currentPincode", "currentCountry",
  "permanentStreet", "permanentCity", "permanentState", "permanentPincode",
  "permanentCountry", "sameAsCurrent",
  "jobTitle", "workLocation", "needsToOperate",
  "passportNumber", "voterIdNumber", "drivingLicenseNumber",
  "aadharNumber", "aadhaarNumber", "panNumber", "uanNumber",
  "pfNumber", "esicNumber", "esiNumber",
  "email", "biometricId", "identityId",
  "department", "departmentId", "designation", "employmentType",
  "dateOfJoining", "confirmationDate", "probationPeriod",
  "shift", "workShift", "workShiftMode", "workShiftStart", "workShiftEnd", "workShiftPunches",
  "primaryManager", "secondaryManager", "isDirector",
  "bankName", "accountNumber", "accountType", "ifscCode", "branchName",
  "isActive", "status",
  "documents", "additionalDocs", "profilePhoto", "photo", "fieldsNotAvailable",
  "aadharFile", "panFile", "resumeFile", "offerLetter", "appointmentLetter",
]);

/**
 * Exempt from SENSITIVE_PATHS, matched first.
 *
 * Shift work: a swap between two people, a change request, an assignment or
 * rotation. None of it overwrites what a day of attendance says.
 */
const EXEMPT_PATHS = ["/swap", "/shift-swap", "/shift-change-request", "/exchange", "/shift"];

/**
 * Paths that always need an approver, whatever fields they carry.
 *
 * Sensitive because of what they DO rather than what they change. The four
 * attendance entries are the OVERWRITES — see the header; the rest of the
 * attendance router is ordinary work.
 */
const SENSITIVE_PATHS = [
  "/salary",
  "/payroll",
  "/day-override",
  "/bulk-day-override",
  "/punch-correction",
  "/remove-from-month",
  "/leave",
  "/password-management",
  "/access",
  "/roles",
  "/config/salary",
  "/regulariz",
  "/overtime",
];

/** The leaf of a dotted path, ignoring array indices: "punches.1.inTime" → "inTime". */
function leafOf(path) {
  return String(path || "")
    .split(".")
    .filter((seg) => seg && !/^\d+$/.test(seg))
    .pop() || "";
}

/** True when this one field may be committed without an approver. */
function isRoutineField(path) {
  const p = String(path || "");
  if (!p) return false;
  if (SENSITIVE_PREFIXES.some((pre) => p.startsWith(pre))) return false;

  const leaf = leafOf(p);

  /* Inside the salary object: a derived figure is routine, an input is not,
     and a leaf nobody has classified is treated as an input. */
  if (p.startsWith("salary.")) return SALARY_DERIVED.has(leaf);

  return !SENSITIVE_FIELDS.has(leaf);
}

/** Is this path the employee record itself (create, or delete of one)? */
function isEmployeeRecord(path) {
  return /\/api\/employees(\/[0-9a-f]{24}|\/(gr|e)\d{3,})?\/?$/i.test(path);
}

/**
 * Does this write need an approver?
 *
 * @param {object} args
 * @param {string} args.path     the request path
 * @param {string} args.method   HTTP verb
 * @param {Array}  args.changes  [{ field, path }] from the describe step
 * @returns {{hold: boolean, reason: string, sensitive: string[]}}
 */
function decideApproval({ path = "", method = "", changes = null } = {}) {
  const p = String(path).toLowerCase().split("?")[0];

  if (EXEMPT_PATHS.some((frag) => p.includes(frag))) {
    return { hold: false, reason: "shift work is ordinary work", sensitive: [] };
  }

  const hitPath = SENSITIVE_PATHS.find((frag) => p.includes(frag));
  if (hitPath) {
    return { hold: true, reason: `${hitPath} is an approved-only area`, sensitive: [] };
  }

  /* Creating or deleting an EMPLOYEE is the whole record: a new employee
     carries a salary from the moment they exist, and a deletion cannot be
     reviewed after the fact. Any other create or delete is ordinary work. */
  if (method === "POST" || method === "DELETE") {
    if (isEmployeeRecord(p)) {
      return { hold: true, reason: "creating or removing an employee", sensitive: [] };
    }
    return { hold: false, reason: "not the employee record", sensitive: [] };
  }

  /* No diff at all means the describe step could not read the request — a
     route it has not been taught. Ask, rather than guess. An EMPTY diff is
     different: the body matched what is stored, and there is nothing to
     approve. */
  if (!Array.isArray(changes)) {
    return { hold: true, reason: "the change could not be described", sensitive: [] };
  }
  if (changes.length === 0) {
    return { hold: false, reason: "nothing changed", sensitive: [] };
  }

  const sensitive = changes
    .filter((c) => !isRoutineField(c?.path || c?.field))
    .map((c) => c?.field || c?.path)
    .filter(Boolean);

  if (sensitive.length) {
    return {
      hold: true,
      reason: `${sensitive.join(", ")} need${sensitive.length === 1 ? "s" : ""} an approver`,
      sensitive,
    };
  }

  return {
    hold: false,
    reason: `${changes.length} routine field${changes.length === 1 ? "" : "s"}`,
    sensitive: [],
  };
}

module.exports = {
  decideApproval,
  EXEMPT_PATHS,
  isRoutineField,
  isEmployeeRecord,
  ROUTINE_FIELDS,
  SALARY_INPUTS,
  SALARY_DERIVED,
  SENSITIVE_FIELDS,
  SENSITIVE_PATHS,
};
