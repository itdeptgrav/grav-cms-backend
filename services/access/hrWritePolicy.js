"use strict";
/**
 * services/access/hrWritePolicy.js — what a request body is allowed to CHANGE.
 *
 * THE PROBLEM A ROUTE-LEVEL CAPABILITY CANNOT SOLVE
 * -------------------------------------------------
 * `PUT /api/employees/:id` is one route and about eight different operations.
 * The same URL carries a corrected spelling of somebody's middle name, a
 * transfer to another department, and a salary revision. Authorising it by
 * route means picking one capability for all three, and whichever is picked is
 * wrong for the other two: `people.write` hands every HR editor the payroll,
 * `compensation.write` stops them fixing a typo.
 *
 * So the capability is decided by the FIELDS the request actually carries. The
 * rules live here, in one table, rather than as role comparisons scattered
 * through handlers — the same reason the route contract exists.
 *
 * THREE ANSWERS, NOT TWO
 * ----------------------
 *   forbidden  no HR role may write this through an employee route, ever
 *   capability this field needs a capability beyond people.write
 *   ordinary   people.write covers it
 *
 * "Forbidden" is the important one. An access-department grant is what decides
 * which GRAV applications an account may open; it is Access Control's to give
 * (`CEO -> Access Control`, `DeptUser`/`DepartmentRole`), and an HR employee
 * form is not an authorisation console. An HR owner who could write
 * `accessDepartmentId` through `PUT /api/employees/:id` could grant themselves
 * — or anybody — any application in the platform, which is a privilege
 * escalation with an HR-shaped audit entry in front of it.
 *
 * NOTHING IS PARTIALLY APPLIED
 * ----------------------------
 * The classification runs at the mount, before the handler, so a payload that
 * mixes an allowed change with a refused one is refused whole. There is no
 * point at which half of it has been written.
 */

const { CAPABILITIES } = require("./hrCapabilities");

/* ── Never writable through an HR employee route ─────────────────────────────
 *
 * Two groups, and they are forbidden for different reasons.
 *
 * AUTHORISATION: these decide what an account may DO. They belong to Access
 * Control and to the login system, and routing them through an HR form would
 * make the HR application a way to grant platform access.
 *
 * SYSTEM/IDENTITY: credentials, audit stamps and the primary key. A credential
 * is set by the two paths that own it (admin reset and self-service change);
 * an audit stamp that the caller can choose is not an audit stamp.
 */
const FORBIDDEN_FIELDS = Object.freeze([
  /* authorisation — Access Control's, not HR's */
  "accessDepartmentId",
  "additionalDepartmentIds",
  "isAdmin",
  "capabilityOverrides",
  "role",
  "userType",
  "legacyRole",
  "tokenVersion",

  /* credentials */
  "password",
  "temporaryPassword",
  "passwordHash",
  "mustChangePassword",

  /* system and audit */
  "_id",
  "id",
  "__v",
  "createdAt",
  "createdBy",
  "createdByName",
  "updatedBy",
  "updatedByName",
]);

/* ── Fields that need a capability beyond people.write ───────────────────────*/

/** Compensation, banking and anything that resolves to money. */
const COMPENSATION_FIELDS = Object.freeze([
  "salary",
  "salaryCustomFields",
  "bankDetails",
]);

/**
 * Employment STATE — who somebody is to the company, as opposed to who they
 * are as a person. A transfer, a promotion, a manager change, a shift change,
 * a confirmation or a termination all land here, and all of them change how
 * attendance, leave and payroll interpret this employee from that day on.
 */
const EMPLOYMENT_FIELDS = Object.freeze([
  "status",
  "isActive",
  "employmentType",
  "internship",
  "dateOfJoining",
  "confirmationDate",
  "probationPeriod",
  "lastFinalizedDate",
  "department",
  "departmentId",
  "designation",
  "jobTitle",
  "jobPosition",
  "primaryManager",
  "secondaryManager",
  "workShift",
  "shift",
  "workLocation",
  "isDirector",
  "needsToOperate",
  "biometricId",
  "identityId",
  "coworkEmployeeId",
]);

/** Government / statutory identifiers and uploaded identity evidence. */
const IDENTIFIER_FIELDS = Object.freeze(["documents"]);

/** Medical / disability declarations. */
const MEDICAL_FIELDS = Object.freeze(["bloodGroup", "isPhysicallyChallenged"]);

const FIELD_CAPABILITY = new Map();
for (const f of COMPENSATION_FIELDS) FIELD_CAPABILITY.set(f, CAPABILITIES.COMPENSATION_WRITE);
for (const f of EMPLOYMENT_FIELDS) FIELD_CAPABILITY.set(f, CAPABILITIES.EMPLOYMENT_CHANGE);
for (const f of IDENTIFIER_FIELDS) FIELD_CAPABILITY.set(f, CAPABILITIES.PEOPLE_READ_IDENTIFIERS);
for (const f of MEDICAL_FIELDS) FIELD_CAPABILITY.set(f, CAPABILITIES.PEOPLE_READ_MEDICAL);

const FORBIDDEN_SET = new Set(FORBIDDEN_FIELDS);

/**
 * The top-level field name a request key refers to.
 *
 * Bulk update flattens its payload to dot paths (`salary.gross`,
 * `primaryManager.managerId`) before it reaches the model, and a classifier
 * that only looked at whole keys would see `salary.gross` as an unknown
 * ordinary field and wave the pay rise through on `people.write`.
 */
function topLevelOf(key) {
  return String(key).split(/[.[]/)[0];
}

/**
 * What does this payload need?
 *
 * @param {object} payload  the fields being written
 * @returns {{ capabilities: string[], forbidden: string[], byCapability: object,
 *            ordinary: string[] }}
 */
function classifyEmployeeWrite(payload) {
  const forbidden = [];
  const ordinary = [];
  const byCapability = {};

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { capabilities: [], forbidden, byCapability, ordinary };
  }

  for (const key of Object.keys(payload)) {
    /* A `$`-prefixed key is a Mongo operator smuggled into a document body.
       It is not a field, and no HR route accepts one. */
    if (key.startsWith("$")) {
      forbidden.push(key);
      continue;
    }
    const top = topLevelOf(key);
    if (FORBIDDEN_SET.has(top)) {
      forbidden.push(key);
      continue;
    }
    const capability = FIELD_CAPABILITY.get(top);
    if (capability) {
      (byCapability[capability] ||= []).push(key);
      continue;
    }
    ordinary.push(key);
  }

  const capabilities = Object.keys(byCapability);
  /* Ordinary personal/workforce fields still need people.write; so does a
     create, which carries the whole record. */
  if (ordinary.length || capabilities.length) capabilities.push(CAPABILITIES.PEOPLE_WRITE);

  return { capabilities: [...new Set(capabilities)], forbidden, byCapability, ordinary };
}

/* ══════════════════════════════════════════════════════════════════════════
 *  EMPLOYEE SELF-SERVICE — an allowlist, because a denylist was the bug
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `PUT /api/employee/profile` applied `req.body` after deleting fourteen named
 * fields from it. Everything the list did not name was written: salary,
 * bankDetails, status, employmentType, designation, jobTitle, workShift,
 * documents (Aadhaar, PAN, UAN) — and `accessDepartmentId`, with which any
 * employee holding the mobile app could have granted themselves HR, Accounting
 * or the CEO dashboard.
 *
 * A denylist protects the fields somebody remembered. This list is what an
 * employee may change about themselves, and everything else is not applied.
 */
const SELF_EDITABLE_FIELDS = Object.freeze([
  /* Who they are */
  "title",
  "firstName",
  "middleName",
  "lastName",
  "nickName",
  "dateOfBirth",
  "placeOfBirth",
  "gender",
  "maritalStatus",
  "marriageDate",
  "nationality",
  "religion",
  "countryOfOrigin",
  "residentialStatus",
  "isPhysicallyChallenged",
  "bloodGroup",

  /* Family */
  "spouseName",
  "spouseDOB",
  "fatherFirstName",
  "fatherMiddleName",
  "fatherLastName",
  "fatherDateOfBirth",
  "motherFirstName",
  "motherMiddleName",
  "motherLastName",

  /* Their own contact details and where they live */
  "alternatePhone",
  "personalEmail",
  "extension",
  "address",

  "profilePhoto",
]);

const SELF_EDITABLE_SET = new Set(SELF_EDITABLE_FIELDS);

/**
 * Keys the profile READ adds that are not model fields — a full name, a
 * pre-formatted date, a duplicate of the phone number. A client that GETs the
 * profile and PUTs it back sends all of them, and refusing the save over
 * `fullName` would be a security error message for a rendering convenience.
 * Ignored, not rejected.
 */
const SELF_IGNORED_FIELDS = Object.freeze([
  "fullName",
  "phoneNumber",
  "formattedDateOfBirth",
  "formattedDateOfJoining",
  "employeeId",
  "age",
  "yearsOfService",
  /* Contact fields that were already silently dropped before this change, and
     stay dropped: `email` is what a DepartmentRole grant is keyed on, so an
     employee editing it would move their own access records. `phone` is the
     default-password source. Both are HR's to change. */
  "email",
  "phone",
  /* Administrator-configured extra fields. They are validated against the
     form definitions by `services/formConfig`, which the self-service route
     does not run, so an employee does not get to invent one. */
  "personalCustomFields",
  "workCustomFields",
  "salaryCustomFields",
  "documentCustomFields",
  "addressCustomFields",
  "fieldsNotAvailable",
]);

const SELF_IGNORED_SET = new Set(SELF_IGNORED_FIELDS);

/**
 * Split a self-service profile body into what may be applied and what must be
 * refused.
 *
 * Never mutates the input. The old code deleted keys from `req.body` in place,
 * which meant anything downstream — the audit trail, a retry, the approval
 * queue's stored copy — saw a body that was not the one the client sent.
 *
 * @returns {{ update: object, rejected: string[], ignored: string[] }}
 */
function filterSelfProfileUpdate(body) {
  const update = {};
  const rejected = [];
  const ignored = [];

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { update, rejected, ignored };
  }

  for (const [key, value] of Object.entries(body)) {
    if (key.startsWith("$")) {
      rejected.push(key);
      continue;
    }
    const top = topLevelOf(key);
    if (SELF_EDITABLE_SET.has(top) && key === top) {
      update[key] = value;
      continue;
    }
    if (SELF_IGNORED_SET.has(top)) {
      ignored.push(key);
      continue;
    }
    /* Anything left is either protected or unknown. Both are refused: an
       unknown key on a self-service write is either a client sending something
       it should not, or a field added to Employee that nobody has classified —
       and the safe answer to both is the same. */
    rejected.push(key);
  }

  return { update, rejected, ignored };
}

module.exports = {
  FORBIDDEN_FIELDS,
  COMPENSATION_FIELDS,
  EMPLOYMENT_FIELDS,
  IDENTIFIER_FIELDS,
  MEDICAL_FIELDS,
  SELF_EDITABLE_FIELDS,
  SELF_IGNORED_FIELDS,
  classifyEmployeeWrite,
  filterSelfProfileUpdate,
  topLevelOf,
};
