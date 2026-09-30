// services/access/appAccess.service.js
//
// THE ONE ANSWER TO "MAY THIS PERSON OPEN THIS APPLICATION, AND AS WHAT?"
//
//   resolveAppAccess(actor, appSlug)
//     -> { allowed, role, capabilities, source, denialCode, appSlug }
//
// GAC-AR1 (25 Sep 2026). GRAV is one organisation, so the answer has exactly
// three inputs and never a company:
//
//   1. an active identity (DeptUser / Employee / accounting-only Acc_User),
//      re-read from the database — never taken from token claims;
//   2. an active grant for the application;
//   3. the grant's role.
//
// A PLATFORM ADMINISTRATOR is a full-system administrator
// (docs/decisions/single-organisation-access-control.md): the DeptUser row the
// session names must be active, `isAdmin`, and on the session's tokenVersion.
// Then every active internal application is open as `owner`. The token's
// `isAdmin` claim is never consulted.
//
// Company membership (SpCompanyMembership) and PPC `companyGrants[]` are NOT
// inputs. Role storage is the existing one: DepartmentRole for every
// application, Acc_User (via services/departmentRoles.getRole) for Accounting.
//
// ── COMPATIBILITY BRIDGE, DELIBERATE AND NAMED ─────────────────────────────
// A department that has never had a single role row (printing, washing,
// trimming, ironing today) has no role source to grant from. A person
// ASSIGNED to such a department keeps the entry they have always had, as
// `editor`, with source `legacy_department_assignment`. This mirrors
// requireDepartmentRole's existing unconfigured-department rule so the
// launcher and the API agree. Deletion condition: every active department has
// role rows (then this branch never fires) — remove it in GAC-9.
//
// Failure is never access: every lookup error is `ACCESS_CHECK_UNAVAILABLE`.
"use strict";

const mongoose = require("mongoose");

const DENIAL = Object.freeze({
  UNAUTHENTICATED: "UNAUTHENTICATED",
  IDENTITY_NOT_FOUND: "IDENTITY_NOT_FOUND",
  IDENTITY_INACTIVE: "IDENTITY_INACTIVE",
  SESSION_REVOKED: "SESSION_REVOKED",
  AMBIGUOUS_IDENTITY: "AMBIGUOUS_IDENTITY",
  APP_NOT_FOUND: "APP_NOT_FOUND",
  APP_INACTIVE: "APP_INACTIVE",
  NO_APP_GRANT: "NO_APP_GRANT",
  ACCESS_CHECK_UNAVAILABLE: "ACCESS_CHECK_UNAVAILABLE",
});

const SOURCE = Object.freeze({
  PLATFORM_ADMIN: "platform_admin",
  APP_ROLE: "app_role",
  ACCOUNTING_ROLE: "accounting_role",
  LEGACY_DEPARTMENT_ASSIGNMENT: "legacy_department_assignment",
});

/** Slugs that are not openable applications (the admin console lives in CEO). */
const NON_APPLICATION_SLUGS = new Set(["platform-admin"]);

const ACCOUNTING = "accountant";

const CAPABILITIES = Object.freeze({
  viewer: Object.freeze({ read: true, write: false, approve: false, administer: false }),
  editor: Object.freeze({ read: true, write: true, approve: false, administer: false }),
  approver: Object.freeze({ read: true, write: true, approve: true, administer: false }),
  owner: Object.freeze({ read: true, write: true, approve: true, administer: true }),
});

const deny = (appSlug, denialCode) => ({
  allowed: false, role: null, capabilities: null, source: null, denialCode, appSlug,
});
const allow = (appSlug, role, source) => ({
  allowed: true, role, capabilities: CAPABILITIES[role] || CAPABILITIES.viewer, source, denialCode: null, appSlug,
});

const models = () => ({
  DeptUser: require("../../models/Access/DeptUser"),
  AccessDepartment: require("../../models/Access/AccessDepartment"),
  Employee: require("../../models/Employee"),
  DepartmentRole: require("../../models/Access/DepartmentRole"),
});

const isOid = (v) => Boolean(v) && mongoose.Types.ObjectId.isValid(String(v));
const lower = (v) => String(v || "").toLowerCase().trim();

/**
 * Normalise whatever the caller holds — a decoded token, `req.user`, or
 * `{ id, email, subject, tv }` — into the actor shape this service reads.
 * Only identifiers are taken from it; authority is always re-read.
 */
function actorFrom(source) {
  const s = source || {};
  return {
    id: s.id ? String(s.id) : (s._id ? String(s._id) : ""),
    email: lower(s.email),
    subject: s.subject || (s.deptId || s.deptSlug ? "dept_user" : ""),
    tv: Number(s.tv || 0),
  };
}

/** An Employee-subject identity (or an unlabelled token that names one). */
async function employeeIdentity(actor) {
  const { Employee } = models();
  if (!isOid(actor.id)) return { ok: false, code: DENIAL.IDENTITY_NOT_FOUND };
  const emp = await Employee.findById(actor.id)
    .select("email isActive status accessDepartmentId additionalDepartmentIds department").lean();
  if (!emp) return { ok: false, code: DENIAL.IDENTITY_NOT_FOUND };
  if (emp.isActive === false || emp.status === "inactive") return { ok: false, code: DENIAL.IDENTITY_INACTIVE };
  const email = lower(emp.email);
  if (email) {
    const twins = await Employee.countDocuments({
      email, isActive: { $ne: false }, status: { $ne: "inactive" },
    });
    if (twins > 1) return { ok: false, code: DENIAL.AMBIGUOUS_IDENTITY };
  }
  let assigned = [emp.accessDepartmentId, ...(emp.additionalDepartmentIds || [])]
    .filter(Boolean).map(String);
  // The launcher's historical fallback: no explicit assignment, but a
  // free-text department that names exactly one active department.
  if (!assigned.length && emp.department) {
    const { AccessDepartment } = models();
    const label = String(emp.department).trim().toLowerCase();
    const matches = (await AccessDepartment.find({ isActive: true }).select("_id name").lean())
      .filter((d) => String(d.name || "").trim().toLowerCase() === label);
    if (matches.length === 1) assigned = [String(matches[0]._id)];
  }
  return { ok: true, kind: "employee", record: emp, emails: email ? [email] : [], isPlatformAdmin: false, assignedDeptIds: assigned };
}

/**
 * Resolve the verified identity behind an actor. Throws on a lookup failure
 * (the caller turns that into ACCESS_CHECK_UNAVAILABLE).
 *
 * @returns {{ ok: true, kind, record, emails: string[], isPlatformAdmin, assignedDeptIds: string[] }
 *          | { ok: false, code }}
 */
async function verifiedIdentity(actor) {
  const { DeptUser, Employee } = models();
  if (!actor.id && !actor.email) return { ok: false, code: DENIAL.UNAUTHENTICATED };

  if (actor.subject === "employee") return employeeIdentity(actor);

  if (actor.subject === "accountant") {
    const { findAccountantUser } = require("../accountantAccess");
    const acc = actor.email ? await findAccountantUser(actor.email) : null;
    // A role-only row (loginMode "none") is not an identity: an
    // accounting-subject session can never stand on one.
    if (!acc || acc.loginMode === "none") return { ok: false, code: DENIAL.IDENTITY_NOT_FOUND };
    if (!acc.isActive) return { ok: false, code: DENIAL.IDENTITY_INACTIVE };
    if ((acc.tokenVersion || 0) !== actor.tv) return { ok: false, code: DENIAL.SESSION_REVOKED };
    return { ok: true, kind: "accountant", record: acc, emails: [lower(acc.email)], isPlatformAdmin: false, assignedDeptIds: [] };
  }

  if (actor.subject === "legacy_department") {
    // Legacy per-department sessions are read-only migration history; they do
    // not carry a verifiable application grant in this resolver.
    return { ok: false, code: DENIAL.IDENTITY_NOT_FOUND };
  }

  // Department login (DeptUser) — the only identity that can be an administrator.
  if (!isOid(actor.id)) return { ok: false, code: DENIAL.IDENTITY_NOT_FOUND };
  const user = await DeptUser.findById(actor.id)
    .select("email isActive isAdmin tokenVersion departmentId employeeRef").lean();
  // An unlabelled token (older formats carry no `subject`) names whichever
  // record its id belongs to: a department login first, else an employee.
  if (!user && actor.subject !== "dept_user") return employeeIdentity(actor);
  if (!user) return { ok: false, code: DENIAL.IDENTITY_NOT_FOUND };
  if (!user.isActive) return { ok: false, code: DENIAL.IDENTITY_INACTIVE };
  if ((user.tokenVersion || 0) !== actor.tv) return { ok: false, code: DENIAL.SESSION_REVOKED };

  const emails = [lower(user.email)];
  if (user.employeeRef) {
    try {
      const emp = await Employee.findById(user.employeeRef).select("email").lean();
      if (emp?.email && !emails.includes(lower(emp.email))) emails.push(lower(emp.email));
    } catch { /* the DeptUser's own address still stands */ }
  }
  return {
    ok: true, kind: "dept_user", record: user, emails: emails.filter(Boolean),
    isPlatformAdmin: Boolean(user.isAdmin), assignedDeptIds: user.departmentId ? [String(user.departmentId)] : [],
  };
}

const RANK = { viewer: 10, editor: 20, approver: 30, owner: 40 };

/** The strongest active role across the identity's addresses. */
async function roleFor(appSlug, emails) {
  const { getRole } = require("../departmentRoles");
  let best = null;
  for (const email of emails) {
    const role = await getRole(appSlug, email); // Acc_User for `accountant`, DepartmentRole otherwise
    if (role && (!best || RANK[role] > RANK[best])) best = role;
  }
  return best;
}

async function resolveWithIdentity(identity, appSlug, dept, { requireCatalogueEntry = true, allowLegacyAssignment = true } = {}) {
  if (!dept && requireCatalogueEntry) return deny(appSlug, DENIAL.APP_NOT_FOUND);
  if (dept && !dept.isActive) return deny(appSlug, DENIAL.APP_INACTIVE);

  if (identity.isPlatformAdmin) return allow(appSlug, "owner", SOURCE.PLATFORM_ADMIN);

  const role = await roleFor(appSlug, identity.emails);
  if (role) return allow(appSlug, role, appSlug === ACCOUNTING ? SOURCE.ACCOUNTING_ROLE : SOURCE.APP_ROLE);

  // Compatibility bridge — see header. Only for an ASSIGNED department with no
  // role rows at all; never for Accounting, whose role store is Acc_User.
  if (allowLegacyAssignment && dept && appSlug !== ACCOUNTING && identity.assignedDeptIds.includes(String(dept._id))) {
    const { DepartmentRole } = models();
    const configured = await DepartmentRole.exists({ departmentSlug: appSlug });
    if (!configured) return allow(appSlug, "editor", SOURCE.LEGACY_DEPARTMENT_ASSIGNMENT);
  }
  return deny(appSlug, DENIAL.NO_APP_GRANT);
}

/**
 * @param {object} actorLike  decoded token / req.user / { id, email, subject, tv }
 * @param {string} appSlug    AccessDepartment slug
 * @param {object} [opts]
 * @param {boolean} [opts.requireCatalogueEntry=true]  the launcher and session
 *   paths require the application to exist in the catalogue. A module's own
 *   guard (its slug is fixed in code) passes `false`: an ABSENT catalogue row
 *   is not a deactivation — an explicitly inactive one still denies.
 * @param {boolean} [opts.allowLegacyAssignment=true]  a module that has
 *   never admitted people by department assignment alone (PPC) passes
 *   `false`, so the compatibility bridge cannot loosen it.
 */
async function resolveAppAccess(actorLike, appSlug, { requireCatalogueEntry = true, allowLegacyAssignment = true } = {}) {
  const slug = lower(appSlug);
  const actor = actorFrom(actorLike);
  try {
    const identity = await verifiedIdentity(actor);
    if (!identity.ok) return deny(slug, identity.code);
    if (NON_APPLICATION_SLUGS.has(slug)) return deny(slug, DENIAL.APP_NOT_FOUND);
    const { AccessDepartment } = models();
    const dept = await AccessDepartment.findOne({ slug }).lean();
    return await resolveWithIdentity(identity, slug, dept, { requireCatalogueEntry, allowLegacyAssignment });
  } catch (err) {
    console.error("[appAccess] access check failed:", err?.message || err);
    return deny(slug, DENIAL.ACCESS_CHECK_UNAVAILABLE);
  }
}

/**
 * Every active application this actor may open, with the decision for each —
 * the launcher's list. One identity read, one catalogue read.
 *
 * @returns {{ ok: boolean, denialCode?: string, isPlatformAdmin?: boolean, apps: Array }}
 *   `apps` holds `{ department, access }` for the ALLOWED applications, in
 *   catalogue order.
 */
async function listAccessibleApps(actorLike) {
  const actor = actorFrom(actorLike);
  try {
    const identity = await verifiedIdentity(actor);
    if (!identity.ok) return { ok: false, denialCode: identity.code, apps: [] };
    const { AccessDepartment } = models();
    const depts = await AccessDepartment.find({ isActive: true, slug: { $nin: [...NON_APPLICATION_SLUGS] } })
      .sort({ sortOrder: 1, name: 1 });
    const apps = [];
    for (const dept of depts) {
      const access = await resolveWithIdentity(identity, dept.slug, dept);
      if (access.allowed) apps.push({ department: dept, access });
    }
    return { ok: true, isPlatformAdmin: identity.isPlatformAdmin, apps };
  } catch (err) {
    console.error("[appAccess] launcher resolution failed:", err?.message || err);
    return { ok: false, denialCode: DENIAL.ACCESS_CHECK_UNAVAILABLE, apps: [] };
  }
}

/** Is the actor an active, database-verified platform administrator right now? */
async function isVerifiedPlatformAdmin(actorLike) {
  const identity = await verifiedIdentity(actorFrom(actorLike));
  return Boolean(identity.ok && identity.isPlatformAdmin);
}

module.exports = {
  resolveAppAccess,
  listAccessibleApps,
  isVerifiedPlatformAdmin,
  actorFrom,
  // The same database re-read, for a module that decides more than "may they
  // open it" (CCTV: which cameras) — services/cctv/cctvAccess.service.js.
  verifiedIdentity,
  DENIAL,
  SOURCE,
  CAPABILITIES,
  NON_APPLICATION_SLUGS,
};
