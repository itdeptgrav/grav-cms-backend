"use strict";
/**
 * test/hr-access/helpers.js — access records and sessions for the HR
 * authorisation tests.
 *
 * Everything here builds REAL records in the in-memory database from
 * test/setup.js: AccessDepartment grants, DepartmentRole rows, DeptUser
 * administrators and Employee assignments. That is deliberate — the contract's
 * whole claim is that it derives authority from records rather than from the
 * token, and a mocked resolver would test the opposite.
 */

/* Must be set BEFORE config/jwt is required: it resolves the secret once, at
   module load, and refuses to start without one. */
process.env.JWT_SECRET = process.env.JWT_SECRET || "hr-contract-test-secret";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const jwt = require("jsonwebtoken");

const AccessDepartment = require("../../models/Access/AccessDepartment");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const DeptUser = require("../../models/Access/DeptUser");
const Employee = require("../../models/Employee");

const {
  invalidateHrActor,
  resetHrRolesConfiguredCache,
} = require("../../services/access/hrAuthorization");

/** The resolver caches for 30 s; every test starts from a clean slate. */
function resetAccessCaches() {
  invalidateHrActor();
  resetHrRolesConfiguredCache();
}

async function makeDepartment(slug, name = slug, dashboardPath = `/${slug}`) {
  return AccessDepartment.create({ key: slug, slug, name, dashboardPath, isActive: true });
}

/**
 * `gender` is declared `default: ""` against an enum that does not contain "",
 * so an Employee saved without one fails validation. Set here so every fixture
 * in this directory does not have to remember.
 */
async function makeEmployee(fields = {}) {
  return Employee.create({ gender: "Other", ...fields });
}

async function grantHrRole(email, role, name = "HR person") {
  return DepartmentRole.create({
    departmentSlug: "hr",
    email: String(email).toLowerCase(),
    name,
    role,
    isActive: true,
  });
}

/**
 * A legacy HR or CEO department account — the identity the compatibility bridge
 * exists for. These sign in against their own collections and have no Employee
 * row, so no grant record can exist for them; the bridge re-proves the row on
 * every request instead of trusting the claim.
 */
async function makeLegacyAccount(kind, email, { isActive = true } = {}) {
  const Model =
    kind === "ceo"
      ? require("../../models/CEODepartment")
      : require("../../models/HRDepartment");
  return Model.create({
    email: String(email).toLowerCase(),
    password: "hashed-by-the-model",
    name: kind === "ceo" ? "Chief Executive" : "HR Administrator",
    employeeId: kind === "ceo" ? "CEO001" : "HR001",
    phone: "9990000000",
    isActive,
  });
}

async function makePlatformAdmin(email, departmentId) {
  return DeptUser.create({
    email: String(email).toLowerCase(),
    passwordHash: "x",
    name: "Administrator",
    departmentId,
    isAdmin: true,
    isActive: true,
  });
}

/**
 * The token a legacy HR or CEO account actually receives at sign-in.
 *
 * Both builders write the same three things this matters for: `id` is the legacy
 * document's own `_id` (v1) or the DeptUser `_id` reused verbatim from it (v2),
 * `role` is the frozen legacy literal, and `userType` names the collection that
 * authenticated the request — "hr" for HRDepartment, "ceo" for CEODepartment.
 * The bridge checks all three, so a fixture that omits one is not a real token.
 */
function legacyToken(kind, row, overrides = {}) {
  return cmsToken({
    id: String(row._id),
    email: row.email,
    role: kind === "ceo" ? "ceo" : "hr_manager",
    userType: kind,
    name: row.name,
    employeeId: row.employeeId,
    ...overrides,
  });
}

/** A CMS session cookie/header value, signed exactly as routes/login.js signs. */
function cmsToken(claims) {
  return jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: "7d" });
}

/** The employee app's session: no `role` claim at all, which is the asymmetry
 *  the contract reads to tell the two audiences apart. */
function appToken({ id, email }) {
  return jwt.sign({ id, email, type: "employee" }, process.env.JWT_SECRET, { expiresIn: "7d" });
}

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

module.exports = {
  resetAccessCaches,
  makeDepartment,
  makeEmployee,
  grantHrRole,
  makePlatformAdmin,
  makeLegacyAccount,
  legacyToken,
  cmsToken,
  appToken,
  bearer,
};
