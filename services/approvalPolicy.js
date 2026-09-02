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
// So: routine corrections commit straight away and are recorded in the change
// history like any other edit. Money, identity and anything payroll or
// attendance is judged against still stops and waits.
//
// ── ON THE EMPLOYEE RECORD, ONLY MONEY WAITS ────────────────────────────────
// The line is drawn at the encrypted fields: pay, and where pay is sent. Those
// are the ones that cost real money to get wrong and that nobody can spot by
// looking at the record. Everything else on the employee form — names, dates,
// contact details, documents, identifiers, department, shift — commits when an
// editor saves it, and the change history is what answers for it afterwards.
//
// That is a deliberate trade. A queue holding every correction is a queue
// nobody reads, and an unread queue approves the dangerous items as readily as
// the harmless ones. Fewer, meaningful approvals beat a wall of them.
//
// ── WHOLE AREAS STILL WAIT ──────────────────────────────────────────────────
// Attendance, leave, payroll, the salary rules and password resets are held on
// the ROUTE, whatever fields they carry — see SENSITIVE_PATHS. A shift SWAP is
// exempt among them: two people agreeing to trade a shift is ordinary work.
//
// ── THE DEFAULT IS TO ASK ───────────────────────────────────────────────────
// A field nobody has classified is still treated as sensitive. A new field that
// should have been routine costs one approval and somebody adds it to the list;
// a new field that should have been guarded and was not is discovered when the
// money is already wrong.

"use strict";

/**
 * Edits an editor may commit without an approver.
 *
 * Personal facts, contact details, addresses, and the family/demographic
 * fields. Wrong values here are visible, harmless and correctable by the same
 * person who typed them.
 */
const ROUTINE_FIELDS = new Set([
  // Name and how they are addressed.
  "title", "firstName", "middleName", "lastName", "nickName", "gender",
  "fatherFirstName", "fatherMiddleName", "fatherLastName", "fatherDOB",
  "motherFirstName", "motherMiddleName", "motherLastName",
  "spouseName", "maritalStatus", "marriageDate",

  // Personal facts.
  "dateOfBirth", "bloodGroup", "nationality", "residentialStatus",
  "placeOfBirth", "countryOfOrigin", "religion",
  "isInternational", "isPhysicallyChallenged",

  // Contact. `personalEmail` is a way to reach somebody; `email` is the LOGIN
  // and is deliberately not here.
  "personalEmail", "phone", "alternatePhone", "workPhone",

  // Where they live. Both addresses and the toggle between them.
  "currentStreet", "currentCity", "currentState", "currentPincode", "currentCountry",
  "permanentStreet", "permanentCity", "permanentState", "permanentPincode",
  "permanentCountry", "sameAsCurrent",

  // Descriptive job fields that decide nothing downstream. `designation` and
  // `department` are NOT here — they pick the manager list and the payroll
  // ledger.
  "jobTitle", "workLocation", "needsToOperate",

  // Identity documents and statutory identifiers. Wrong ones are visible on
  // the record and on any filing they reach, and correcting a typo in a PAN is
  // not a decision anybody needs to approve.
  "passportNumber", "voterIdNumber", "drivingLicenseNumber",
  "aadharNumber", "aadhaarNumber", "panNumber", "uanNumber",
  "pfNumber", "esicNumber", "esiNumber",

  // The login, and who somebody is in the org chart. These were held; they are
  // not money, they are visible on the record, and the history names whoever
  // changed them.
  "email", "biometricId", "identityId",
  "department", "departmentId", "designation", "employmentType",
  "dateOfJoining", "confirmationDate", "probationPeriod",
  "workShiftMode", "workShiftStart", "workShiftEnd", "workShiftPunches",
  "primaryManager", "secondaryManager", "isDirector",

  // The two the form marks optional alongside the rest.
  "middleName", "bloodGroup",

  // Uploaded files and their metadata. A document is evidence attached to a
  // record, not a value anything computes from.
  "documents", "additionalDocs", "profilePhoto", "photo",

  /* Marking a field as one the employee does not have. It is an answer to a
     question, not a change to a value — and holding it for approval would
     make "I have no passport" harder to record than a passport number. */
  "fieldsNotAvailable",
  "aadharFile", "panFile", "resumeFile", "offerLetter", "appointmentLetter",
]);

/**
 * Prefixes that make a path routine regardless of its leaf.
 *
 * Administrator-configured extra fields are routine by construction: they are
 * whatever a company chose to collect, they feed nothing, and requiring an
 * approval for each one would make the form builder unusable.
 */
const ROUTINE_PREFIXES = [
  "personalCustomFields",
  "workCustomFields",
  "documentCustomFields",
  "addressCustomFields",
  "documents.",
  "additionalDocs",
];

/**
 * Prefixes that always need an approver, whatever the leaf is called.
 *
 * `salary.` covers every component at once, which matters because the salary
 * object gains fields — EDLI and admin charges were added to it recently, and
 * a list of leaf names would have let them through.
 */
const SENSITIVE_PREFIXES = ["salary.", "salaryCustomFields", "bankDetails."];

/**
 * Fields that always need an approver.
 *
 * Grouped by what goes wrong, because that is the only durable reason to keep
 * a field on this list.
 */
const SENSITIVE_FIELDS = new Set([
  // PAY. The encrypted fields, and every component of them.
  "gross", "grossSalary", "basic", "hra", "stipend", "internStipendType",
  "internStart", "internEnd", "foodAllowance", "otherDeduction",
  "epf", "edli", "adminCharges", "eeesic", "erEsic",
  "epfOverride", "edliOverride", "adminOverride",
  "employerCost", "netSalary", "totalDeduction",

  /* WHERE PAY IS SENT. Redirecting somebody's salary to another account is the
     one edit on this form that moves money to a place nobody notices — the
     payslip still reads correctly. Held for that reason and no other. */
  "bankName", "accountNumber", "accountType", "ifscCode", "branchName",

  // ACCESS. A password is somebody else's account; a role is what they may do.
  "password", "role", "isAdmin", "permissions",

  /* Whether somebody is still employed. It stops their pay and their access,
     and it is not reversible by retyping a field. */
  "isActive", "status",
]);

/**
 * Paths that always need an approver, whatever fields they carry.
 *
 * Some writes are sensitive because of what they DO rather than what they
 * change: overwriting a day of attendance, adjusting a leave balance, running
 * or editing payroll, and changing the salary rules for the whole company. The
 * field diff on those is either uninformative or empty, so they are matched on
 * the route instead.
 */
/**
 * Exempt from the paths below, matched first.
 *
 * A shift SWAP is two people agreeing to trade a shift — ordinary work that
 * happens between colleagues, not an override of what attendance says. It only
 * appears here because it lives under an attendance route.
 */
const EXEMPT_PATHS = ["/swap", "/shift-swap", "/shift-change-request"];

const SENSITIVE_PATHS = [
  "/salary",
  "/payroll",
  "/attendance",
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
  if (ROUTINE_PREFIXES.some((pre) => p.startsWith(pre))) return true;

  const leaf = leafOf(p);
  if (SENSITIVE_FIELDS.has(leaf)) return false;
  return ROUTINE_FIELDS.has(leaf);
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
    return { hold: false, reason: "shift swaps are ordinary work", sensitive: [] };
  }

  const hitPath = SENSITIVE_PATHS.find((frag) => p.includes(frag));
  if (hitPath) {
    return { hold: true, reason: `${hitPath} is an approved-only area`, sensitive: [] };
  }

  /* A CREATE or a DELETE is the whole record, not a field on it. Both are
     approved: a new employee carries a salary and a login from the moment they
     exist, and a deletion cannot be reviewed after the fact. */
  if (method === "POST" || method === "DELETE") {
    return { hold: true, reason: "creating or removing a record", sensitive: [] };
  }

  /* No diff means the describe step could not read the record — usually a
     route this policy has not been taught. Ask, rather than guess. */
  if (!Array.isArray(changes) || changes.length === 0) {
    return { hold: true, reason: "the change could not be described", sensitive: [] };
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
  ROUTINE_FIELDS,
  SENSITIVE_FIELDS,
  SENSITIVE_PATHS,
};
