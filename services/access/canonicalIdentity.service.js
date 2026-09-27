// services/access/canonicalIdentity.service.js
//
// ONE PERSON, ONE LOGIN IDENTITY (GAC-AR2, 25 Sep 2026).
//
// The same human can exist as a DeptUser, an Employee, an Acc_User and a row
// in one of the twelve legacy per-department collections. Login used to try
// them one after another and issue a session for whichever accepted the
// password first — so the same person could get a full administrator session
// on one attempt and an accounting-only or legacy one-app session on the next,
// and `/resolve` could name a different subject from `/login`.
//
// This service is the single answer to "which identity does this email sign
// in as, and does this password open it?". /login and /resolve both call
// `authenticateLogin`; they cannot disagree.
//
// ── THE CANONICAL RULE ───────────────────────────────────────────────────────
//   1. A DeptUser with this email is the canonical identity. Always. Nothing
//      falls through past it — an inactive or wrong-password DeptUser is a
//      refusal, never a quieter session from another collection. That is what
//      makes an administrator impossible to downgrade.
//        Credentials accepted for it: its own passwordHash, or — compatibility
//        only — the legacy row that is PROVABLY the same migrated identity
//        (same _id AND same email). The session is always the DeptUser's.
//   2. Otherwise exactly one active Employee → an employee session.
//   3. Otherwise exactly one active Acc_User → an accounting-only session.
//      An accounting role opens Accounting; it never makes anybody an
//      administrator.
//   4. A legacy row with none of the above is not an identity any more: after
//      a correct password it is refused as LEGACY_ACCOUNT_NOT_MIGRATED.
//   More than one active candidate of the same kind (two Employees, Acc_Users
//   in two organisations) is AMBIGUOUS_IDENTITY — fail closed.
//
// ── NOTHING IS DISCLOSED BEFORE THE PASSWORD ─────────────────────────────────
// Every outcome that would reveal whether an address exists (unknown, wrong
// password, inactive before verification) is the same INVALID_CREDENTIALS.
// Specific codes are returned only once a supplied password has matched a
// credential of that identity.
//
// Administrator status is NOT decided here. It is `DeptUser.isAdmin` on the
// canonical row, re-read by services/access/appAccess.service.js.
"use strict";

const bcrypt = require("bcryptjs");

const CODES = Object.freeze({
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  LOCKED: "ACCOUNT_LOCKED",
  IDENTITY_INACTIVE: "IDENTITY_INACTIVE",
  HOME_APPLICATION_INACTIVE: "HOME_APPLICATION_INACTIVE",
  AMBIGUOUS_IDENTITY: "AMBIGUOUS_IDENTITY",
  LEGACY_ACCOUNT_NOT_MIGRATED: "LEGACY_ACCOUNT_NOT_MIGRATED",
  LOOKUP_FAILED: "IDENTITY_LOOKUP_FAILED",
});

const SUBJECT = Object.freeze({
  DEPT_USER: "dept_user",
  EMPLOYEE: "employee",
  ACCOUNTANT: "accountant",
});

const lower = (v) => String(v || "").toLowerCase().trim();
const refuse = (code, extra = {}) => ({ ok: false, code, ...extra });

const models = () => ({
  DeptUser: require("../../models/Access/DeptUser"),
  AccessDepartment: require("../../models/Access/AccessDepartment"),
  Employee: require("../../models/Employee"),
  Acc_User: require("../../models/Accountant_model/Acc_OrgModels").Acc_User,
});

const employeeActive = (e) => e && e.isActive !== false && e.status !== "inactive";

/**
 * Every record this address names, by kind. No password is read or compared.
 * Throws on a lookup failure (callers map it to LOOKUP_FAILED).
 */
async function findCandidates(email) {
  const mail = lower(email);
  const { DeptUser, Employee, Acc_User } = models();
  const [deptUser, employees, accUsers] = await Promise.all([
    DeptUser.findOne({ email: mail }),
    // NO projection — a `+password` inside an inclusive projection drops it;
    // see the long note in routes/auth/deptAuth.js /login.
    Employee.find({ email: mail }),
    Acc_User.find({ email: mail }),
  ]);
  /* GAC-2 correction: an Acc_User with loginMode "none" is Accounting ROLE
     STORAGE for a person whose identity is elsewhere — never a candidate
     identity, never counted towards ambiguity, never password-checked. */
  const accRoleRows = accUsers.filter((a) => a.loginMode === "none");
  return { email: mail, deptUser, employees, accUsers: accUsers.filter((a) => a.loginMode !== "none"), accRoleRows };
}

/** The legacy row that is provably the same migrated identity, or null. */
async function sameIdentityLegacyRow(deptUser) {
  const { findLegacyUser } = require("../../routes/auth/deptAuth");
  const { user: legacy } = await findLegacyUser(lower(deptUser.email));
  if (!legacy) return null;
  if (String(legacy._id) !== String(deptUser._id)) return null;
  if (lower(legacy.email) !== lower(deptUser.email)) return null;
  if (legacy.isActive === false) return null;
  return legacy;
}

/**
 * Classify an address without any password — for reports, the migration dry
 * run and tests. Never exposed over HTTP.
 *
 * @returns {{ kind: "dept_user"|"employee"|"accountant"|"legacy"|"none"|"ambiguous",
 *             counts: object, isAdmin: boolean }}
 */
async function classify(email) {
  const c = await findCandidates(email);
  const activeEmployees = c.employees.filter(employeeActive);
  const activeAcc = c.accUsers.filter((a) => a.isActive);
  const counts = {
    deptUser: c.deptUser ? 1 : 0,
    employees: c.employees.length,
    activeEmployees: activeEmployees.length,
    accUsers: c.accUsers.length,
    activeAccUsers: activeAcc.length,
  };
  if (c.deptUser) return { kind: SUBJECT.DEPT_USER, counts, isAdmin: Boolean(c.deptUser.isAdmin) };
  if (activeEmployees.length > 1) return { kind: "ambiguous", counts, isAdmin: false };
  if (activeEmployees.length === 1) return { kind: SUBJECT.EMPLOYEE, counts, isAdmin: false };
  if (activeAcc.length > 1) return { kind: "ambiguous", counts, isAdmin: false };
  if (activeAcc.length === 1) return { kind: SUBJECT.ACCOUNTANT, counts, isAdmin: false };
  const { findLegacyUser } = require("../../routes/auth/deptAuth");
  const { user: legacy } = await findLegacyUser(c.email);
  return { kind: legacy ? "legacy" : "none", counts, isAdmin: false };
}

/**
 * Authenticate a login attempt against the ONE canonical identity.
 *
 * @returns {Promise<
 *   { ok: true, subject: "dept_user", record: DeptUser, department: AccessDepartment, via: "dept_user"|"legacy_same_identity" }
 * | { ok: true, subject: "employee", record: Employee, via: string, needsUpgrade: boolean }
 * | { ok: true, subject: "accountant", record: Acc_User }
 * | { ok: false, code: string, status?: number, record?: object }>}
 */
async function authenticateLogin(email, password) {
  const plain = String(password || "");
  let c;
  try {
    c = await findCandidates(email);
  } catch (err) {
    console.error("[canonicalIdentity] lookup failed:", err?.message || err);
    return refuse(CODES.LOOKUP_FAILED, { status: 503 });
  }

  /* 1. DeptUser — canonical whenever it exists. Never falls through. */
  if (c.deptUser) {
    const user = c.deptUser;
    if (typeof user.isLocked === "function" && user.isLocked()) return refuse(CODES.LOCKED, { status: 429 });

    let via = null;
    if (await user.verifyPassword(plain)) via = "dept_user";
    else {
      // Compatibility read only: the legacy row that IS this identity.
      const legacy = await sameIdentityLegacyRow(user).catch(() => null);
      if (legacy && legacy.password && await bcrypt.compare(plain, legacy.password)) via = "legacy_same_identity";
    }
    if (!via) return refuse(CODES.INVALID_CREDENTIALS, { status: 401, record: user, countFailure: true });

    // The password proved who they are; now say what is wrong, specifically.
    if (!user.isActive) return refuse(CODES.IDENTITY_INACTIVE, { status: 403 });
    const { AccessDepartment } = models();
    const department = await AccessDepartment.findById(user.departmentId);
    if (!department || !department.isActive) return refuse(CODES.HOME_APPLICATION_INACTIVE, { status: 403 });
    return { ok: true, subject: SUBJECT.DEPT_USER, record: user, department, via };
  }

  /* 2. Employee — exactly one active record. */
  const activeEmployees = c.employees.filter(employeeActive);
  if (activeEmployees.length) {
    const { matchesEmployeePassword } = require("../../utils/employeePassword");
    const matches = [];
    for (const e of activeEmployees) {
      const m = await matchesEmployeePassword(e, plain);
      if (m.ok) matches.push({ e, m });
    }
    if (!matches.length) return refuse(CODES.INVALID_CREDENTIALS, { status: 401 });
    if (activeEmployees.length > 1) return refuse(CODES.AMBIGUOUS_IDENTITY, { status: 409 });
    return { ok: true, subject: SUBJECT.EMPLOYEE, record: matches[0].e, via: matches[0].m.via, needsUpgrade: Boolean(matches[0].m.needsUpgrade) };
  }
  if (c.employees.length) {
    // Only inactive employee records. Say so only if the password matches one.
    const { matchesEmployeePassword } = require("../../utils/employeePassword");
    for (const e of c.employees) {
      if ((await matchesEmployeePassword(e, plain)).ok) return refuse(CODES.IDENTITY_INACTIVE, { status: 403 });
    }
    return refuse(CODES.INVALID_CREDENTIALS, { status: 401 });
  }

  /* 3. Accounting-only — exactly one active Acc_User. */
  const activeAcc = c.accUsers.filter((a) => a.isActive);
  if (c.accUsers.length) {
    const matching = [];
    for (const a of c.accUsers) if (await a.checkPassword(plain)) matching.push(a);
    if (!matching.length) return refuse(CODES.INVALID_CREDENTIALS, { status: 401 });
    if (activeAcc.length > 1) return refuse(CODES.AMBIGUOUS_IDENTITY, { status: 409 });
    const acc = matching.find((a) => a.isActive);
    if (!acc) return refuse(CODES.IDENTITY_INACTIVE, { status: 403 });
    return { ok: true, subject: SUBJECT.ACCOUNTANT, record: acc };
  }

  /* 4. Legacy-only — credential exists, identity does not. */
  try {
    const { findLegacyUser } = require("../../routes/auth/deptAuth");
    const { user: legacy } = await findLegacyUser(c.email);
    if (legacy && legacy.isActive !== false && legacy.password && await bcrypt.compare(plain, legacy.password)) {
      return refuse(CODES.LEGACY_ACCOUNT_NOT_MIGRATED, { status: 403 });
    }
  } catch (err) {
    console.error("[canonicalIdentity] legacy lookup failed:", err?.message || err);
  }
  return refuse(CODES.INVALID_CREDENTIALS, { status: 401 });
}

/** Human wording for a refusal. INVALID_CREDENTIALS stays deliberately vague. */
const REFUSAL_MESSAGES = Object.freeze({
  [CODES.INVALID_CREDENTIALS]: "Invalid email or password",
  [CODES.LOCKED]: "Too many failed attempts. Try again in a few minutes.",
  [CODES.IDENTITY_INACTIVE]: "This account has been deactivated. Ask an administrator.",
  [CODES.HOME_APPLICATION_INACTIVE]: "Your home application is not currently active. Ask an administrator.",
  [CODES.AMBIGUOUS_IDENTITY]: "This email belongs to more than one account. Ask an administrator to merge them before signing in.",
  [CODES.LEGACY_ACCOUNT_NOT_MIGRATED]: "This sign-in has not been moved to the current system yet. Ask an administrator.",
  [CODES.LOOKUP_FAILED]: "Sign-in is unavailable just now. Try again in a moment.",
});

module.exports = { authenticateLogin, classify, findCandidates, CODES, SUBJECT, REFUSAL_MESSAGES };
