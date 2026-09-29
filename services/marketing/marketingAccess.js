// services/marketing/marketingAccess.js
//
// WHO MAY DO WHAT IN MARKETING — ONE ANSWER, READ FROM THE DATABASE EVERY TIME.
//
// ── WHAT WAS WRONG ─────────────────────────────────────────────────────────
// Access Control let an administrator give somebody Marketing and pick Viewer,
// Editor, Approver or Owner for them. Nothing read that role. Entry was decided
// by the `role: "marketing"` literal baked into a seven-day token at sign-in,
// so a Viewer could write, and revoking the grant or the role changed nothing
// until the token expired.
//
// ── THE MODEL ──────────────────────────────────────────────────────────────
// Three kinds of caller, decided here and nowhere else:
//
//   platform_admin  a department account whose `isAdmin` is true IN THE
//                   DATABASE now, with a matching token version.
//   ceo             a session signed in to the Executive Office whose account
//                   still holds it now.
//   member          an EMPLOYEE, found by the id the token was signed for, who
//                   still holds (1) the Marketing department grant and (2) an
//                   active Marketing role on their own employee record's
//                   address. Both are checked every request.
//
// Nothing is granted on an email match alone. The employee is found by id;
// the role is read on the address held on that employee's own record, not the
// address the token claims. Temporarily, every caller uses the one configured
// Marketing company; roles and company-scoped data selectors remain intact.
//
// ── WHAT EACH ROLE MAY DO ──────────────────────────────────────────────────
// The product decision already recorded for campaign plans
// (docs/decisions/marketing-campaign-plan-and-deployment.md §2) is that
// "Marketing writes, submits and withdraws. An administrator or the CEO
// approves, returns and rejects." That rule is kept, and extended to every
// Marketing decision and setting. So:
//
//   read        Viewer, Editor, Approver, Owner, administrator, CEO
//   write       Editor, Approver, Owner, administrator, CEO
//   decide      administrator, CEO
//   administer  administrator, CEO
//
// Approver and Owner therefore write exactly as Editor does today. That is a
// deliberate, stated result of the durable rule — not an oversight — and the
// access screen says so rather than promising approval. A Marketing Owner is
// not a platform administrator and gains no administrator power here.
"use strict";

const mongoose = require("mongoose");

const MARKETING_SLUG = "marketing";

const ROLE_KEYS = Object.freeze(["viewer", "editor", "approver", "owner"]);

const ACTS = Object.freeze({
  read: { roles: ROLE_KEYS, platform: true },
  write: { roles: ["editor", "approver", "owner"], platform: true },
  decide: { roles: [], platform: true },
  administer: { roles: [], platform: true },
});

const ROLE_WORDS = Object.freeze({
  viewer: "Viewer",
  editor: "Editor",
  approver: "Approver",
  owner: "Owner",
});

/* ── REFUSALS, IN WORDS A PERSON CAN ACT ON ─────────────────────────────── */
const REFUSALS = Object.freeze({
  NOT_SIGNED_IN: { status: 401, message: "Sign in to use Marketing." },
  SESSION_INVALID: { status: 401, message: "Your session is no longer valid. Please sign in again." },
  SESSION_STALE: { status: 401, message: "Your access changed. Please sign in again." },
  NOT_AN_EMPLOYEE: {
    status: 403,
    message: "Marketing is given to employees. This account is not an employee record, so it cannot hold a Marketing role. Ask an administrator.",
  },
  NO_MARKETING_GRANT: {
    status: 403,
    message: "Marketing is not one of your departments. Ask an administrator to give you Marketing in Access Control.",
  },
  NO_MARKETING_ROLE: {
    status: 403,
    message: "You have Marketing, but no Marketing role yet. Ask an administrator to set Viewer, Editor, Approver or Owner for you in Access Control.",
  },
  COMPANY_NOT_CONFIGURED: {
    status: 503,
    message: "Marketing's company is not configured or is no longer available. Ask an administrator to check the Marketing setup.",
  },
  UNAVAILABLE: { status: 503, message: "Marketing could not check your access just now. Try again." },
});

const ACT_REFUSALS = Object.freeze({
  write: "You have view-only access to Marketing. Creating and changing things needs the Editor role or higher.",
  decide: "Decisions in Marketing — approving, returning and rejecting — are made by an administrator or the CEO. Your Marketing role does not include them.",
  administer: "This is a Marketing setting or operation that only an administrator or the CEO can change.",
});

const str = (v) => String(v ?? "").trim();
const lower = (v) => str(v).toLowerCase();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

async function configuredCompanyId() {
  const id = str(process.env.MARKETING_COMPANY_ID);
  if (!/^[a-f\d]{24}$/i.test(id)) return null;
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  const exists = await Acc_Company.exists({ _id: id });
  return exists ? new mongoose.Types.ObjectId(id) : null;
}

function refusal(code) {
  const spec = REFUSALS[code];
  return { ok: false, code: `MARKETING_${code}`, status: spec.status, message: spec.message };
}

/* ── THE KINDS OF CALLER ──────────────────────────────────────────────────── */

async function asDepartmentAccount(decoded) {
  const DeptUser = require("../../models/Access/DeptUser");
  const AccessDepartment = require("../../models/Access/AccessDepartment");
  const user = await DeptUser.findById(decoded.id)
    .select("isAdmin isActive tokenVersion name email departmentId legacyRole employeeId").lean();
  if (!user || user.isActive === false) return refusal("SESSION_INVALID");
  /* A password reset, a deactivation or an admin change bumps the version,
     which ends every outstanding session at once. */
  if ((user.tokenVersion || 0) !== (decoded.tv || 0)) return refusal("SESSION_STALE");

  const base = { userId: String(user._id), name: str(user.name), email: lower(user.email), employeeId: str(user.employeeId) };
  if (user.isAdmin === true) return { ok: true, kind: "platform_admin", role: null, ...base };

  const own = user.departmentId ? await AccessDepartment.findById(user.departmentId).select("slug isActive legacyRole").lean() : null;
  if (own && own.isActive !== false && (own.slug === "ceo" || own.legacyRole === "ceo" || user.legacyRole === "ceo")) {
    return { ok: true, kind: "ceo", role: null, ...base };
  }
  /* A shared department login is not a person HR knows, and a Marketing role
     is held by a person. */
  return refusal("NOT_AN_EMPLOYEE");
}

async function asEmployee(decoded) {
  const Employee = require("../../models/Employee");
  const { resolveEmployeeDepartments } = require("../../routes/auth/deptAuth");
  const DepartmentRole = require("../../models/Access/DepartmentRole");

  if (!isId(decoded.id)) return refusal("SESSION_INVALID");
  const employee = await Employee.findById(decoded.id)
    .select("email isActive status accessDepartmentId additionalDepartmentIds department firstName lastName biometricId").lean();
  if (!employee || employee.isActive === false || employee.status === "inactive") return refusal("SESSION_INVALID");

  const base = {
    userId: String(employee._id),
    name: `${str(employee.firstName)} ${str(employee.lastName)}`.trim(),
    email: lower(employee.email),
    employeeId: str(employee.biometricId),
  };

  /* The same grant decision sign-in makes — one function, not a copy. */
  const departments = await resolveEmployeeDepartments(employee);
  const holds = (slug) => departments.find((d) => d.slug === slug && d.isActive !== false);

  /* Signed in to the Executive Office and still holding it. */
  const ceo = holds("ceo");
  if (ceo && (decoded.deptSlug === "ceo" || decoded.role === "ceo") && str(decoded.deptId) === String(ceo._id)) {
    return { ok: true, kind: "ceo", role: null, ...base };
  }

  if (!holds(MARKETING_SLUG)) return refusal("NO_MARKETING_GRANT");

  /* The address on the employee's OWN record, never the token's claim. */
  if (!base.email) return refusal("NO_MARKETING_ROLE");
  const roleRow = await DepartmentRole.findOne({ departmentSlug: MARKETING_SLUG, email: base.email, isActive: true })
    .select("role").lean();
  if (!roleRow || !ROLE_KEYS.includes(roleRow.role)) return refusal("NO_MARKETING_ROLE");

  return { ok: true, kind: "member", role: roleRow.role, ...base };
}

async function asLegacyDepartment(decoded) {
  /* Pre-migration tokens, still valid for their lifetime. Only the Executive
     Office ever reached Marketing this way, and only its own collection can
     say whether that account is still active. */
  if (decoded.userType !== "ceo") return refusal("NOT_AN_EMPLOYEE");
  const { legacyModel } = require("../../routes/auth/deptAuth");
  const AccessDepartment = require("../../models/Access/AccessDepartment");
  const Model = legacyModel("ceo");
  if (!Model || !isId(decoded.id)) return refusal("SESSION_INVALID");
  const [user, department] = await Promise.all([
    Model.findById(decoded.id).select("isActive name email employeeId role").lean(),
    AccessDepartment.findOne({ legacyUserType: "ceo" }).select("isActive").lean(),
  ]);
  if (!user || user.isActive === false || user.role !== "ceo" || department?.isActive === false) return refusal("SESSION_INVALID");
  if (decoded.email && lower(user.email) !== lower(decoded.email)) return refusal("SESSION_INVALID");
  return {
    ok: true, kind: "ceo", role: null,
    userId: String(user._id), name: str(user.name), email: lower(user.email), employeeId: str(user.employeeId),
  };
}

/**
 * Resolve a verified token into Marketing access, or a refusal.
 *
 * @param {object} decoded  a token already verified by `deptAuth.verifyToken`
 * @returns {Promise<{ok:true, kind, role, userId, name, email, employeeId, companyId?}
 *                   |{ok:false, code, status, message}>}
 */
async function resolve(decoded) {
  if (!decoded || typeof decoded !== "object") return refusal("NOT_SIGNED_IN");
  try {
    let identity;
    if (decoded.v === 2 && decoded.subject === "employee") identity = await asEmployee(decoded);
    if (decoded.v === 2 && decoded.subject === "accountant") return refusal("NOT_AN_EMPLOYEE");
    if (!identity && decoded.v === 2 && decoded.subject === "legacy_department") identity = await asLegacyDepartment(decoded);
    if (!identity && decoded.v === 2 && !decoded.subject && decoded.userType === "ceo") {
      if (!isId(decoded.id)) return refusal("SESSION_INVALID");
      // Old legacy-login sessions and current DeptUser sessions both lacked
      // a subject. Prefer the DeptUser record; an inactive one must not gain
      // access by falling back to a different collection.
      const DeptUser = require("../../models/Access/DeptUser");
      const departmentAccount = await DeptUser.exists({ _id: decoded.id });
      identity = departmentAccount ? await asDepartmentAccount(decoded) : await asLegacyDepartment(decoded);
    }
    if (!identity) identity = decoded.v === 2 ? await asDepartmentAccount(decoded) : await asLegacyDepartment(decoded);
    if (!identity.ok) return identity;
    const companyId = await configuredCompanyId();
    if (!companyId) return refusal("COMPANY_NOT_CONFIGURED");
    return { ...identity, companyId };
  } catch (err) {
    console.error(`[marketing-access] could not resolve access: ${str(err?.message).slice(0, 200)}`);
    return refusal("UNAVAILABLE");
  }
}

/* ── WHAT A RESOLVED CALLER MAY DO ──────────────────────────────────────── */

function can(access, act) {
  if (!access?.ok) return false;
  const rule = ACTS[act];
  if (!rule) return false;
  if (access.kind === "platform_admin" || access.kind === "ceo") return rule.platform === true;
  return rule.roles.includes(access.role);
}

function capabilities(access) {
  return Object.fromEntries(Object.keys(ACTS).map((act) => [act, can(access, act)]));
}

/* ── WHICH ACT EACH ROUTE IS ────────────────────────────────────────────────
   One table for every authenticated Marketing route, so a new route is
   classified here or falls into `write` (for anything that is not a GET) —
   never into "allowed because nobody thought about it". Paths are relative to
   /api/cms/marketing. The routes' own checks stay in place as well. */
const DECIDE = [
  ["POST", /^\/campaign-drafts\/[^/]+\/decision$/],
  ["POST", /^\/advertising-assets\/[^/]+\/review$/],
];
const ADMINISTER = [
  ["POST", /^\/advertising-accounts\/[^/]+$/],
  ["POST", /^\/advertising-accounts\/[^/]+\/(verify|revoke)$/],
  ["POST", /^\/campaign-drafts\/[^/]+\/deployment\/[^/]+\/(create-paused|reconcile)$/],
  ["PUT", /^\/integrations\/tracking$/],
  ["POST", /^\/lead-forms\/recovery\/run$/],
  ["POST", /^\/lead-sources\/indiamart\/check$/],
  ["POST", /^\/campaign-drafts\/[^/]+\/performance\/refresh$/],
  ["GET", /^\/intelligence\/usage$/],
  ["POST", /^\/handovers\/acquisition-holds\/retry$/],
  ["POST", /^\/handovers\/deliver-pending$/],
];
/* POSTs that only read: they compute an answer and store nothing. */
const READ_POSTS = [
  ["POST", /^\/handovers\/preview$/],
];

function actFor(method, path) {
  const m = str(method).toUpperCase();
  const p = str(path).replace(/\/+$/, "") || "/";
  const hit = (list) => list.some(([verb, re]) => verb === m && re.test(p));
  if (hit(DECIDE)) return "decide";
  if (hit(ADMINISTER)) return "administer";
  if (m === "GET" || m === "HEAD" || m === "OPTIONS" || hit(READ_POSTS)) return "read";
  return "write";
}

/* ── WHAT A SCREEN IS TOLD ──────────────────────────────────────────────── */
function view(access) {
  if (!access?.ok) {
    return { allowed: false, reason: access?.code || "MARKETING_NOT_SIGNED_IN", message: access?.message || REFUSALS.NOT_SIGNED_IN.message };
  }
  const who = access.kind === "platform_admin" ? "Administrator" : access.kind === "ceo" ? "CEO" : ROLE_WORDS[access.role];
  return {
    allowed: true,
    kind: access.kind,
    role: access.role,
    roleLabel: who,
    /* The caller's own name, so a screen can recognise their own uploads. */
    name: access.name || "",
    can: capabilities(access),
    /* Said plainly, so an Approver or Owner is not left wondering why no
       Approve button appears. */
    policy: {
      decisions: "Approving, returning and rejecting in Marketing are done by an administrator or the CEO.",
      settings: "Marketing settings and operations are changed by an administrator or the CEO.",
      approverAndOwner: "In Marketing, Approver and Owner can do everything an Editor can. They do not add approval or settings rights.",
    },
    refusals: ACT_REFUSALS,
  };
}

module.exports = {
  MARKETING_SLUG,
  ROLE_KEYS,
  ACTS,
  ACT_REFUSALS,
  REFUSALS,
  resolve,
  can,
  capabilities,
  actFor,
  view,
};
