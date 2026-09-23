"use strict";
/**
 * services/access/hrAuthorization.js — the one question, one answer.
 *
 *     Can this verified actor perform capability X on scope Y,
 *     and which fields may they receive?
 *
 * Everything about HR authority is decided here. A route never compares a role
 * string, never reads `req.user.role` to make a decision, and never trusts a
 * company, factory, department, manager or capability value that arrived in the
 * request body. Authority is re-derived from access RECORDS on every call:
 * DeptUser.isAdmin, the HR DepartmentRole grant, and the employee's
 * accessDepartmentId / additionalDepartmentIds.
 *
 * ── THE FOUR LAYERS, IN ORDER ───────────────────────────────────────────────
 *   1. authentication      is there a verified session at all
 *   2. application access  may this account open HR
 *   3. capability          may it perform this specific operation
 *   4. record scope        may it affect THIS record / company / person
 * and then, on the way out, the protected-field projection.
 *
 * A valid login satisfies (1) and nothing else. That is the whole point of the
 * chunk: `EmployeeAuthMiddlewear` proves who somebody is and says nothing about
 * what they may see.
 *
 * ── WHAT IS DELIBERATELY NOT USED ───────────────────────────────────────────
 * `Employee.department` / `Employee.departmentId` — the HR ORGANISATION
 * assignment — never appear below. Somebody filed under "HR" on the org chart
 * has an operational placement, not an application grant. The two are separate
 * columns on Employee for exactly this reason and the plan's design rule #2
 * says so in one line: organisation assignment is not system access.
 *
 * Note that `routes/auth/deptAuth.js:resolveEmployeeDepartments` DOES fall back
 * to matching the org-chart department NAME against an access department when
 * an employee has no access grant at all. That fallback is login's, and this
 * resolver deliberately does not inherit it — see
 * docs/decisions/hr-legacy-role-compatibility.md.
 */

const mongoose = require("mongoose");

const {
  CAPABILITIES,
  ROLE_TEMPLATES,
  DEPARTMENT_ROLE_TEMPLATE,
  LEGACY_HR_ROLES,
  LEGACY_BOARD_ROLES,
  LEGACY_ADMIN_ROLES,
  hasAll,
  firstMissing,
} = require("./hrCapabilities");

const { projectEmployee, projectEmployees, excludeSelect, readClassFor } =
  require("./hrFieldPolicy");

/* ── Stable, machine-readable outcomes ───────────────────────────────────────
 *
 * These strings are a contract with the frontend and with the tests. A client
 * distinguishes "sign in again" from "ask an administrator for HR" from "you
 * are HR but not allowed to do this" by CODE, not by parsing a sentence.
 *
 * None of the denials say anything about the record that was asked for. A 403
 * for an employee who does not exist and a 403 for an employee the caller may
 * not see are byte-identical, so the endpoint cannot be used to enumerate
 * people. That is why the scope check never loads the target.
 */
const DECISIONS = Object.freeze({
  PERMITTED: "HR_PERMITTED",
  PERMITTED_RESTRICTED: "HR_PERMITTED_RESTRICTED",
  UNAUTHENTICATED: "HR_UNAUTHENTICATED",
  NO_APPLICATION_ACCESS: "HR_NO_APPLICATION_ACCESS",
  MISSING_CAPABILITY: "HR_MISSING_CAPABILITY",
  OUT_OF_SCOPE: "HR_OUT_OF_SCOPE",
  SCOPE_NOT_PROVABLE: "HR_SCOPE_NOT_PROVABLE",
});

const STATUS_FOR = Object.freeze({
  [DECISIONS.PERMITTED]: 200,
  [DECISIONS.PERMITTED_RESTRICTED]: 200,
  [DECISIONS.UNAUTHENTICATED]: 401,
  [DECISIONS.NO_APPLICATION_ACCESS]: 403,
  [DECISIONS.MISSING_CAPABILITY]: 403,
  [DECISIONS.OUT_OF_SCOPE]: 403,
  [DECISIONS.SCOPE_NOT_PROVABLE]: 403,
});

/* One sentence per code. Uniform on purpose: an attacker learns the same thing
   from all of them, which is nothing. */
const MESSAGE_FOR = Object.freeze({
  [DECISIONS.UNAUTHENTICATED]: "Authentication required.",
  [DECISIONS.NO_APPLICATION_ACCESS]: "You do not have access to the HR application.",
  [DECISIONS.MISSING_CAPABILITY]: "You do not have permission to perform this action.",
  [DECISIONS.OUT_OF_SCOPE]: "You do not have permission to perform this action.",
  [DECISIONS.SCOPE_NOT_PROVABLE]: "You do not have permission to perform this action.",
});

/* Named compatibility conditions. Each one is a place where this contract
   knowingly preserves today's behaviour instead of tightening it; every one is
   listed in docs/decisions/hr-authorisation-contract.md with an exit
   condition. Attaching them to the resolved actor is what makes them visible in
   tests and in the denial payload rather than folklore. */
const COMPATIBILITY = Object.freeze({
  /* HR has no DepartmentRole rows at all, so `requireDepartmentRole` fails open
     for writes. INFORMATIONAL ONLY: it is attached so the state is visible in a
     denial payload and in the logs, and it changes no capability. It used to
     promote every HR grant to the owner template, which meant the contract
     reported capability enforcement while handing out payroll reopen, HR
     configuration and credential administration to anybody with an HR grant —
     a fail-open dressed as a compatibility note. Bootstrapping the first owner
     is a platform-administrator action, not a request-time promotion; see
     docs/decisions/hr-authorisation-contract.md §6. */
  HR_ROLES_UNCONFIGURED: "HR_ROLES_UNCONFIGURED",
  /* Application access proved only by the signed legacy `role` claim
     (`hr_manager`), because the account authenticates against a legacy
     department collection and has no Employee row to carry a grant. */
  LEGACY_ROLE_TOKEN: "LEGACY_ROLE_TOKEN",
  /* A platform administrator is waved through every department guard in the
     codebase today; HR does not get to be the one place that disagrees. */
  PLATFORM_ADMIN_FULL_HR: "PLATFORM_ADMIN_FULL_HR",
  /* No HR record carries a company, legal entity or factory yet (Chunk 2). HR
     grants are therefore global and this contract says so out loud rather than
     implying a tenant boundary it cannot enforce. */
  LEGACY_GLOBAL_HR_SCOPE: "LEGACY_GLOBAL_HR_SCOPE",
  /* The session presented a legacy HR/CEO/admin role claim and the bridge
     refused it — because an Employee identity exists (whose own records are the
     answer), because that employee is deactivated, or because no active legacy
     account could be found. Attached so a support question about "my token used
     to work" has an answer in the log. */
  LEGACY_CLAIM_NOT_PROVEN: "LEGACY_CLAIM_NOT_PROVEN",
});

/* ── Resolved-actor cache ────────────────────────────────────────────────────
 *
 * Resolving an actor costs up to four indexed reads. HR pages fire a dozen
 * requests each, so without this the contract would be measurable on every
 * dashboard. Same shape and TTL as Middlewear/coworkAuth.js, and the same rule:
 * a grant change must call invalidateHrActor() or wait out the window.
 */
const ACTOR_TTL_MS = 30 * 1000;
const actorCache = new Map();

/**
 * A cache key must preserve every distinction the ANSWER depends on.
 *
 * THE COLLISION THIS FIXES. `proveActiveLegacyAccount` compares `userType`
 * EXACTLY against "hr" / "ceo" — a subject type the server writes, so anything
 * else did not come from a token builder — while this key lowercased it. The
 * two disagreed, and the disagreement made authorisation depend on request
 * order:
 *
 *   1. a token with `userType: "hr"` resolves, is allowed, and is cached;
 *   2. an otherwise identical token with `userType: "HR"` builds the SAME key;
 *   3. it is answered from the cache and never reaches the exact comparison
 *      that would have refused it.
 *
 * So the rule is: normalise a component here only where the resolver normalises
 * it too.
 *
 *   id, employeeId   compared as-is downstream        → raw
 *   email            `lower()`ed everywhere it is used → lowercased
 *   role             `lower()`ed by resolveHrActor     → lowercased
 *   userType         compared EXACTLY                  → raw
 *   type             `lower()`ed by isEmployeeAppToken → lowercased
 *
 * `safeStr` because a claim is whatever was in a signed token: a Symbol makes
 * `Array.prototype.join` throw, and an object with a hostile `toString` throws
 * too. A key that cannot be built must not take the guard down — an
 * unrepresentable claim gets a key that collides with nothing.
 */
let unrepresentable = 0;

function safeStr(value) {
  if (value === null || value === undefined) return "";
  try {
    return String(value);
  } catch {
    /* Unique per occurrence, so an unstringifiable claim is never cached under
       the same key as anything else — including another unstringifiable one. */
    unrepresentable += 1;
    return `\u0000unrepresentable:${unrepresentable}`;
  }
}

const safeLower = (value) => safeStr(value).toLowerCase();

function cacheKey(user) {
  /* JSON, NOT `join("|")`.
   *
   * A delimiter-joined key is only injective if the delimiter cannot appear in
   * a component, and these are claims out of a signed token — any of them can
   * contain anything. Two different tuples then serialise to one string:
   *
   *     role "hr_manager"     + userType "hr"   →  …|hr_manager|hr|…
   *     role "hr_manager|hr"  + userType ""     →  …|hr_manager|hr|…
   *
   * and those two resolve to OPPOSITE answers — the first is the legacy HR
   * bridge, the second an unrecognised role string that grants nothing. Which
   * one a session got depended on which had been resolved first.
   *
   * `JSON.stringify` of an array of strings escapes the separators it needs to,
   * so the encoding is unambiguous and the tuple is recoverable in principle —
   * which is the property a cache key has to have. */
  const components = [
    safeStr(user.id),
    safeStr(user.employeeId),
    safeLower(user.email),
    safeLower(user.role),
    /* RAW. The legacy bridge accepts only the exact literal, so "HR", "Hr",
       "hr " and " hr" are four different answers from "hr" and must be four
       different entries. */
    safeStr(user.userType),
    safeLower(user.type),
  ];

  try {
    return JSON.stringify(components);
  } catch {
    /* Every component is already a string by this point, so this is unreachable
       in practice — but a key that cannot be built must fail CLOSED rather than
       collide with something. A unique value caches nothing and matches
       nothing. */
    unrepresentable += 1;
    return `\u0000unkeyable:${unrepresentable}`;
  }
}

function invalidateHrActor(user) {
  if (!user) return actorCache.clear();
  /* The SAME `cacheKey` resolveHrActor stores under — shared rather than
     re-derived, so the two cannot drift into disagreeing about which entry a
     session owns. */
  actorCache.delete(typeof user === "string" ? user : cacheKey(user));
}

/**
 * An authorisation record changed: forget everything.
 *
 * CALLED FROM EVERY MUTATION THAT CHANGES WHAT SOMEBODY MAY DO — a role grant,
 * change or revocation, the incumbent-owner demotion that rides along with a
 * new owner, an access-department assignment or removal (single or bulk), a
 * platform-administrator grant or revocation, an account deactivation, a
 * department deactivation, and an email change that moves the grants keyed on
 * it.
 *
 * IT CLEARS THE WHOLE MAP, DELIBERATELY. The cache key is composite, so
 * targeted removal would need every session claim of every affected person —
 * which the mutation does not have, and getting it wrong means somebody keeps a
 * revoked capability for up to thirty seconds with nothing to show why. The map
 * holds one entry per active HR session per thirty-second window; rebuilding it
 * costs a handful of indexed reads and happens only when an administrator
 * changes access, which is rare and deliberate.
 *
 * Also drops the "does HR have any roles at all" answer, because granting the
 * first HR role is exactly the moment that flips.
 *
 * Never throws: an invalidation that fails must not fail the grant that
 * succeeded — that is the shape of bug `test/access/department-role-cache.test.js`
 * exists to pin, where the write landed and the response said otherwise.
 */
function invalidateHrAuthorization(reason) {
  try {
    actorCache.clear();
    rolesConfigured = { value: null, at: 0 };
    if (reason && process.env.HR_AUTH_LOG === "1") {
      console.log(`[hr-auth] authorisation cache cleared: ${reason}`);
    }
  } catch (err) {
    console.warn("[hr-auth] cache invalidation failed:", err.message);
  }
}

/* Warned once per process, not per request — an unconfigured department would
   otherwise print a line for every HR page load. */
let warnedUnconfigured = false;

function warnUnconfigured() {
  if (warnedUnconfigured) return;
  warnedUnconfigured = true;
  console.warn(
    "[hr-auth] no HR DepartmentRole rows exist. HR application grants resolve to READ-ONLY " +
      "(hr_viewer) until an administrator assigns roles in CEO -> Access Control. " +
      "A platform administrator (DeptUser.isAdmin) can grant the first HR owner.",
  );
}

/* ── Identity gathering ──────────────────────────────────────────────────────*/

function isObjectId(v) {
  return v && mongoose.Types.ObjectId.isValid(String(v));
}

function lower(v) {
  return String(v || "").toLowerCase().trim();
}

/**
 * Every address this human is known by, from RECORDS rather than the token.
 *
 * A grant is made against whatever address an administrator typed, and people
 * have more than one — the same problem `services/departmentRoles.js`
 * documents at length. Reusing that reasoning here keeps one answer to "is this
 * the same person" across the whole access layer.
 */
async function gatherIdentity(user) {
  const Employee = require("../../models/Employee");
  const DeptUser = require("../../models/Access/DeptUser");

  const emails = new Set();
  if (user.email) emails.add(lower(user.email));

  let employee = null;
  let deptUser = null;

  try {
    const or = [];
    if (isObjectId(user.id)) or.push({ _id: user.id });
    if (user.employeeId) or.push({ biometricId: String(user.employeeId) });
    if (or.length) {
      employee = await Employee.findOne({ $or: or })
        .select("_id email biometricId firstName lastName accessDepartmentId additionalDepartmentIds isActive status")
        .lean();
    }
  } catch {
    /* An identity lookup that fails must not take the guard down; the token's
       own address is still tried. Failing CLOSED is handled by the caller —
       a missing employee simply means fewer proofs, never more. */
  }
  if (employee?.email) emails.add(lower(employee.email));

  try {
    const or = [];
    if (isObjectId(user.id)) or.push({ _id: user.id });
    if (emails.size) or.push({ email: { $in: [...emails] } });
    if (employee?._id) or.push({ employeeRef: employee._id });
    if (user.employeeId) or.push({ employeeId: String(user.employeeId) });
    if (or.length) {
      deptUser = await DeptUser.findOne({ $or: or, isActive: true })
        .select("_id email name isAdmin departmentId employeeRef employeeId isActive")
        .lean();
    }
  } catch {
    /* as above */
  }
  if (deptUser?.email) emails.add(lower(deptUser.email));

  return { emails: [...emails].filter(Boolean), employee, deptUser };
}

/** Access-department slugs this account holds, from grants only. */
async function grantedAccessSlugs({ employee, deptUser }) {
  const AccessDepartment = require("../../models/Access/AccessDepartment");
  const ids = [];

  if (employee) {
    if (employee.accessDepartmentId) ids.push(employee.accessDepartmentId);
    for (const id of employee.additionalDepartmentIds || []) ids.push(id);
  }
  if (deptUser?.departmentId) ids.push(deptUser.departmentId);

  if (!ids.length) return new Set();

  try {
    const rows = await AccessDepartment.find({ _id: { $in: ids }, isActive: true })
      .select("slug key")
      .lean();
    return new Set(rows.flatMap((r) => [lower(r.slug), lower(r.key)]).filter(Boolean));
  } catch {
    return new Set();
  }
}

/* ── The legacy compatibility bridge, and what it costs to use it ────────────
 *
 * The CEO and the HR administrator authenticate against their OWN collections
 * (`CEODepartment`, `HRDepartment`) and have no Employee row, so no grant record
 * can exist for them and the signed `role` claim is the only thing there is.
 *
 * That was the reasoning; the implementation was too generous. It accepted the
 * claim from ANY session carrying it, which made the bridge a way to survive
 * revocation: take an ordinary employee holding `hr_manager`, remove their HR
 * DepartmentRole and their HR access-department grant, and the token they were
 * already holding kept opening the workforce directory until it expired. Access
 * revocation that waits seven days for a cookie is not access revocation.
 *
 * The bridge now costs two proofs, both from the database, on every request:
 *
 *   1. NO Employee identity for this session. An employee's authority comes
 *      from their own records — grants and roles — and if those say nothing
 *      then nothing is the answer. The bridge is for accounts that cannot have
 *      such records, not a fallback for accounts whose records were removed.
 *   2. The legacy account itself is found and ACTIVE. Deactivating an
 *      `HRDepartment` or `CEODepartment` row takes effect on the next request.
 *
 * Unprovable means refused. A claim on its own has never been evidence and is
 * not evidence here.
 */
const LEGACY_ACCOUNT_SOURCES = Object.freeze({
  /* `userType` is the literal both token builders write for that collection:
     routes/login.js sets `userModel` to "hr" when it matched HRDepartment and
     "ceo" when it matched CEODepartment, and routes/auth/deptAuth.js writes
     `dept.legacyUserType` — the same strings — on both its paths. Nothing else
     is accepted, and there is no client-supplied fallback. */
  hr: { userType: "hr", model: "../../models/HRDepartment" },
  ceo: { userType: "ceo", model: "../../models/CEODepartment" },
});

/** The employee app's own token. It carries `type`, never `userType`. */
function isEmployeeAppToken(user) {
  return lower(user?.type) === "employee";
}

/**
 * Prove the legacy account THIS TOKEN WAS ISSUED FOR is present and active.
 *
 * THREE THINGS, AND ALL THREE ARE THE POINT.
 *
 *   1. The token's account type must be the collection being consulted. The
 *      bridge used to pick the collection from `role` alone, so a session
 *      authenticated against Sales that happened to carry `role: "hr_manager"`
 *      was checked against HRDepartment — a collection it had never
 *      authenticated to.
 *
 *   2. The subject is the token's `id`, and nothing else. Matching on email as
 *      well meant "a similarly identified row exists somewhere", which is not
 *      the same claim: two collections can hold the same address for two
 *      different accounts, and an address is not a subject. `_id` is: the v1
 *      token signs the legacy document's own `_id`, and the v2 token signs the
 *      DeptUser `_id`, which is reused verbatim from the legacy row it was
 *      seeded from (see models/Access/DeptUser.js).
 *
 *   3. The row must be there and must not be switched off.
 *
 * Anything missing, mismatched or unrecognised fails closed, and an employee-app
 * token can never reach a CMS legacy collection at all.
 */
async function proveActiveLegacyAccount(kind, { user }) {
  const source = LEGACY_ACCOUNT_SOURCES[kind];
  if (!source) return null;

  if (isEmployeeAppToken(user)) return null;
  /* EXACT, not normalised. `role` is case-folded because it is compared against
     a map of historical literals and "HR_MANAGER" is the same grant shouted;
     this is different. `userType` is a subject type the SERVER writes — v1 from
     its own `userModel` literal, v2 from `AccessDepartment.legacyUserType`,
     which is a slug the schema already forces to lowercase — so anything that
     is not the literal did not come from a token builder. */
  if (user?.userType !== source.userType) return null;
  if (!isObjectId(user?.id)) return null;

  let Model;
  try {
    Model = require(source.model);
  } catch {
    /* The collection is gone. Nothing to prove against, so nothing is proven. */
    return null;
  }

  try {
    const row = await Model.findById(user.id).select("_id email isActive").lean();
    if (!row) return null;
    /* `isActive` is absent on the oldest rows in HRDepartment; absent means the
       flag was never set, not that the account was switched off. An explicit
       `false` is the revocation. */
    if (row.isActive === false) return null;
    return row;
  } catch {
    return null;
  }
}

/**
 * Is this employee record still someone the company employs?
 *
 * A deactivated or soft-deleted employee keeps every field they had — including
 * `accessDepartmentId` — because the record is retained for payroll and audit
 * history. Reading the grant without reading the state would let a leaver walk
 * back in with the token in their browser. `DELETE /api/employees/:id` sets both
 * of these (see routes/HrRoutes/Employee-Section.js), which is why both are
 * checked.
 */
function employeeIsActive(employee) {
  if (!employee) return false;
  if (employee.isActive === false) return false;
  if (String(employee.status || "").toLowerCase() === "inactive") return false;
  return true;
}

/** Is HR configured with roles at all? Cached with the actor TTL. */
let rolesConfigured = { value: null, at: 0 };
async function hrRolesConfigured() {
  if (rolesConfigured.value !== null && Date.now() - rolesConfigured.at < ACTOR_TTL_MS) {
    return rolesConfigured.value;
  }
  try {
    const { listRoles } = require("../departmentRoles");
    const rows = await listRoles("hr");
    rolesConfigured = { value: rows.length > 0, at: Date.now() };
  } catch {
    /* Unreadable is treated as CONFIGURED, i.e. the strict side. A database
       blip must not silently promote every HR user to owner. */
    rolesConfigured = { value: true, at: Date.now() };
  }
  return rolesConfigured.value;
}

function resetHrRolesConfiguredCache() {
  rolesConfigured = { value: null, at: 0 };
}

/* ── The resolver ────────────────────────────────────────────────────────────*/

/**
 * Turn a verified session into an HR actor: template, capabilities, the
 * employee record it is scoped to, and any compatibility conditions in force.
 *
 * @param {object} user  req.user as set by EmployeeAuthMiddlewear / the app
 *                       middleware. Only `id`, `employeeId`, `email` and the
 *                       signed `role` claim are read, and `role` only ever
 *                       proves APPLICATION ACCESS, never a capability.
 */
async function resolveHrActor(user) {
  if (!user || (!user.id && !user.email && !user.employeeId)) {
    return {
      authenticated: false,
      template: null,
      via: null,
      capabilities: new Set(),
      hasHrApplicationAccess: false,
      employee: null,
      employeeRef: null,
      compatibility: [],
    };
  }

  const key = cacheKey(user);
  const hit = actorCache.get(key);
  if (hit && Date.now() - hit.at < ACTOR_TTL_MS) return hit.actor;

  const { emails, employee, deptUser } = await gatherIdentity(user);
  const compatibility = [];
  const role = lower(user.role);

  let template = null;
  let via = null;
  let hasHrApplicationAccess = false;

  /* A deactivated or soft-deleted employee keeps every field they had, grants
     and role included, because the record is retained for payroll and audit
     history. Reading those without reading the STATE would let a leaver back in
     with the token already in their browser, so nothing an employee record
     carries is consulted once it is inactive. Computed here, above every
     branch, so no proof path can miss it.

     A DeptUser identity is exempt: that account is looked up with
     `isActive: true` already, and an administrator is not made inactive by an
     employee row that happens to share their address. */
  const employeeRevoked = Boolean(employee) && !employeeIsActive(employee);

  /* (a) Platform administrator — re-read from the database every time, never
         from the token's `isAdmin` claim, and only while the account is active:
         `gatherIdentity` filters DeptUser on `isActive: true`, so deactivating
         an administrator takes effect on their next request. */
  if (deptUser?.isAdmin) {
    template = "platform_admin";
    via = "platform-admin";
    hasHrApplicationAccess = true;
    compatibility.push(COMPATIBILITY.PLATFORM_ADMIN_FULL_HR);
  }

  /* (b) An explicit HR role grant is the strongest ordinary proof: it says both
         that HR may be opened AND what may be done inside it. */
  let hrRole = null;
  if (!template && !employeeRevoked) {
    try {
      const { getRole } = require("../departmentRoles");
      for (const mail of emails) {
        const found = await getRole("hr", mail);
        if (found && (!hrRole || ROLE_RANK[found] > ROLE_RANK[hrRole])) hrRole = found;
      }
    } catch {
      /* Unreadable grants mean fewer proofs, never more. */
    }
    if (hrRole) {
      template = DEPARTMENT_ROLE_TEMPLATE[hrRole] || "hr_viewer";
      via = "hr-department-role";
      hasHrApplicationAccess = true;
    }
  }

  const slugs = employeeRevoked ? new Set() : await grantedAccessSlugs({ employee, deptUser });

  /* Whether the legacy claim may be used at all. It is for accounts that CANNOT
     hold grant records — the CEO and the HR administrator, who sign in against
     their own collections. An Employee-backed session has records of its own,
     and if those say nothing then nothing is the answer: that is what makes
     removing a role and a grant take effect on the very next request instead of
     when the cookie expires. */
  /* The bridge is a CMS-token path. An employee-app session carries no `role`
     at all, but the guard is explicit rather than relying on that: a forged app
     token that added one must not become a route into a CMS collection. */
  const claimIsBridgeable = Boolean(role) && !employee && !isEmployeeAppToken(user);
  if (employeeRevoked) compatibility.push(COMPATIBILITY.LEGACY_CLAIM_NOT_PROVEN);

  /* (c) An HR APPLICATION grant with no role row yet. Application access is
         proven; the capability set is not, so it is read-only — which is
         exactly what happens today, where reads are ungated and
         `requireDepartmentRole` refuses the write with NO_DEPARTMENT_ROLE. */
  if (!template && slugs.has("hr")) {
    hasHrApplicationAccess = true;
    via = "hr-access-department";
    /* READ-ONLY, ALWAYS. An application grant says which app may be opened; it
       says nothing about what may be done inside it, so it resolves to the
       viewer template and never to owner. That is also what happens today on
       the write path: `requireDepartmentRole` answers NO_DEPARTMENT_ROLE to
       anybody with no role row. */
    template = "hr_viewer";
    if (!(await hrRolesConfigured())) {
      compatibility.push(COMPATIBILITY.HR_ROLES_UNCONFIGURED);
      warnUnconfigured();
    }
  }

  /* (d) Legacy signed role claim. The CEO and the HR administrator sign in
         against their own department collections and have no Employee row, so
         no grant record can exist for them; the claim is all there is. It
         proves APPLICATION ACCESS only — the capability set still comes from a
         template, and an unknown role string proves nothing at all. */
  if (!template && LEGACY_HR_ROLES[role]) {
    const legacy = claimIsBridgeable ? await proveActiveLegacyAccount("hr", { user }) : null;
    if (legacy) {
      hasHrApplicationAccess = true;
      via = "legacy-role";
      compatibility.push(COMPATIBILITY.LEGACY_ROLE_TOKEN);
      template = "hr_viewer";
      if (!(await hrRolesConfigured())) {
        compatibility.push(COMPATIBILITY.HR_ROLES_UNCONFIGURED);
        warnUnconfigured();
      }
    } else {
      compatibility.push(COMPATIBILITY.LEGACY_CLAIM_NOT_PROVEN);
    }
  }

  if (!template && LEGACY_ADMIN_ROLES[role]) {
    /* An `admin` role claim is NOT a platform administrator: that is
       DeptUser.isAdmin, re-read above. Treated as a board-level read-only
       projection so an existing admin dashboard keeps working without being
       handed HR write authority it never proved.
     *
     * And only while the account behind it is still there. `gatherIdentity`
     * looks DeptUser up with `isActive: true`, so a deactivated administrator
     * resolves `deptUser` to null and the claim buys nothing — which is the
     * point: revoking an administrator must not leave the token they are
     * holding able to read the workforce for another week. */
    /* Authority from the active DeptUser record and from nothing else — the
       claim only says which shape of answer to give. */
    if (claimIsBridgeable && deptUser) {
      hasHrApplicationAccess = true;
      via = "legacy-role";
      template = "ceo_projection";
      compatibility.push(COMPATIBILITY.LEGACY_ROLE_TOKEN);
    } else {
      compatibility.push(COMPATIBILITY.LEGACY_CLAIM_NOT_PROVEN);
    }
  }

  /* (e) Board / Chief Executive — a read-only projection, from a grant record
         where one exists and from the signed claim where it cannot. */
  if (!template && slugs.has("ceo")) {
    hasHrApplicationAccess = true;
    via = "ceo-access-department";
    template = "ceo_projection";
  }

  if (!template && LEGACY_BOARD_ROLES[role]) {
    /* The Chief Executive signs in against CEODepartment and has no Employee
       row, so the claim is all there is — but the row still has to be there and
       still has to be active. */
    const legacy = claimIsBridgeable ? await proveActiveLegacyAccount("ceo", { user }) : null;
    if (legacy) {
      hasHrApplicationAccess = true;
      via = "legacy-role";
      template = "ceo_projection";
      compatibility.push(COMPATIBILITY.LEGACY_ROLE_TOKEN);
    } else {
      compatibility.push(COMPATIBILITY.LEGACY_CLAIM_NOT_PROVEN);
    }
  }

  /* (f) Everybody else: an authenticated person with no HR application access.
         They still get a self-service template, because their own record and
         their own team are theirs — but `hr.access` is not in it, so every HR
         administration declaration refuses them. */
  if (!template) {
    template = "employee_self";
    via = "self";
    hasHrApplicationAccess = false;
  }

  if (hasHrApplicationAccess) compatibility.push(COMPATIBILITY.LEGACY_GLOBAL_HR_SCOPE);

  const actor = {
    authenticated: true,
    template,
    via,
    departmentRole: hrRole,
    capabilities: new Set(ROLE_TEMPLATES[template] || []),
    hasHrApplicationAccess,
    employee: employee || null,
    employeeRef: employee?._id ? String(employee._id) : isObjectId(user.id) ? String(user.id) : null,
    biometricId: employee?.biometricId || (user.employeeId ? String(user.employeeId) : null),
    emails,
    isPlatformAdmin: Boolean(deptUser?.isAdmin),
    compatibility,
  };

  actorCache.set(key, { actor, at: Date.now() });
  return actor;
}

/* Ranking for "strongest grant wins" when a person holds two. Mirrors
   DepartmentRole.ROLES so the two cannot disagree. */
const ROLE_RANK = { viewer: 10, editor: 20, approver: 30, owner: 40 };

/* ── Scope ───────────────────────────────────────────────────────────────────
 *
 * Chunk 1 enforces every scope that can be PROVEN from records that exist
 * today, and refuses every scope that cannot. It does not invent a default
 * company and does not backfill anything — that is Chunk 2.
 */

/** Request keys that name a tenant boundary no HR record carries yet. */
const UNPROVABLE_SCOPE_KEYS = Object.freeze([
  "companyId",
  "company_id",
  "legalEntityId",
  "legal_entity_id",
  "establishmentId",
  "establishment_id",
  "factoryId",
  "factory_id",
  "plantId",
  "unitId",
]);

/**
 * Did the caller ASK for a company/legal-entity/factory scope?
 *
 * An explicit request for a scope the server cannot prove is denied rather than
 * silently ignored. Ignoring it is how a UI filter becomes mistaken for a
 * security boundary: the client believes it asked for one factory, the server
 * returns all of them, and everybody reads the result as scoped.
 */
function requestedUnprovableScope(req) {
  const sources = [req?.query, req?.body, req?.params];
  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    for (const key of UNPROVABLE_SCOPE_KEYS) {
      const v = src[key];
      if (v !== undefined && v !== null && String(v).trim() !== "") return key;
    }
  }
  return null;
}

/**
 * The self-scope check: does the employee id in this request name the caller?
 *
 * Compares against BOTH identifiers an HR request may use — the Employee `_id`
 * and the biometric id — because different routers take different ones and a
 * check that only knew one of them would refuse legitimate self-service.
 *
 * Returns true when the request names nobody, which is the common case: those
 * handlers derive the employee from the token themselves.
 */
function namesSelf(req, actor, paramNames) {
  const names = paramNames && paramNames.length ? paramNames : ["employeeId", "id"];
  const mine = new Set([actor.employeeRef, actor.biometricId].filter(Boolean).map(String));
  if (!mine.size) return false;

  for (const name of names) {
    /* `hrParams` first: the guard is mount-level, so `req.params` is still
       empty when this runs and the id lives in the path. See
       hrRouteContract.extractParams. */
    const raw =
      req?.hrParams?.[name] ??
      req?.params?.[name] ??
      req?.query?.[name] ??
      (req?.body && typeof req.body === "object" ? req.body[name] : undefined);
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    if (!mine.has(String(raw).trim())) return false;
  }
  return true;
}

/* ── The answer ──────────────────────────────────────────────────────────────*/

/**
 * @param {object}  input
 * @param {object}  input.user          verified req.user
 * @param {string[]} input.capabilities  every capability the operation needs
 * @param {string}  [input.scope]        "public" | "hr" | "self" | "manager"
 * @param {object}  [input.req]          the request, for scope proofs only
 * @param {string[]} [input.selfParams]  which params name an employee
 * @param {object}  [input.managerScope]  how to PROVE the reporting relationship
 * @param {object}  [input.actor]        a pre-resolved actor, to avoid a re-read
 *
 * @returns {Promise<{allowed:boolean, decision:string, status:number,
 *                    message:string, capability:string|null, actor:object,
 *                    fields:{class:string|null, exclude:string}}>}
 */
async function authorizeHr({
  user,
  capabilities = [],
  scope = "hr",
  req = null,
  selfParams = [],
  managerScope = null,
  actor = null,
}) {
  const resolved = actor || (await resolveHrActor(user));

  const deny = (decision, extra = {}) => ({
    allowed: false,
    decision,
    status: STATUS_FOR[decision],
    message: MESSAGE_FOR[decision],
    capability: null,
    actor: resolved,
    fields: { class: null, exclude: "" },
    ...extra,
  });

  if (scope === "public") {
    return {
      allowed: true,
      decision: DECISIONS.PERMITTED,
      status: 200,
      message: "",
      capability: null,
      actor: resolved,
      fields: { class: null, exclude: "" },
    };
  }

  /* 1 — authentication */
  if (!resolved.authenticated) return deny(DECISIONS.UNAUTHENTICATED);

  /* 2 — application access. Skipped for the two self-service scopes, whose
         authority comes from the record and not from an HR grant. */
  const selfService = scope === "self" || scope === "manager";
  if (!selfService && !resolved.hasHrApplicationAccess) {
    return deny(DECISIONS.NO_APPLICATION_ACCESS);
  }

  /* 3 — capability */
  const held = resolved.capabilities;
  if (!hasAll(held, capabilities)) {
    return deny(DECISIONS.MISSING_CAPABILITY, { capability: firstMissing(held, capabilities) });
  }

  /* 4 — record scope */
  if (req) {
    const unprovable = requestedUnprovableScope(req);
    if (unprovable) return deny(DECISIONS.SCOPE_NOT_PROVABLE, { scopeKey: unprovable });
  }

  if (scope === "self" && req && !namesSelf(req, resolved, selfParams)) {
    /* An HR actor holding the matching read capability may still act on
       somebody else's record through the HR routes; this scope is the
       SELF-SERVICE surface, where naming another person is always a refusal. */
    return deny(DECISIONS.OUT_OF_SCOPE);
  }

  if (scope === "manager") {
    /* A manager route used to be authorised by nothing but a valid session:
       this branch did not exist, so `scope: "manager"` fell through to
       "permitted" and the whole proof lived inside each handler. It is proved
       here now, from stored reporting records — and every failure, whatever
       its cause, is the same refusal, so the route cannot be used to find out
       which leave applications exist. */
    const { proveManagerScope } = require("./hrManagerScope");
    let proven = false;
    try {
      proven = await proveManagerScope({ actor: resolved, descriptor: managerScope, req });
    } catch (err) {
      /* Fail closed: an unprovable relationship is not a proven one. */
      console.error("[hr-auth] manager scope proof failed:", err.message);
      proven = false;
    }
    if (!proven) return deny(DECISIONS.OUT_OF_SCOPE);
  }

  const cls = readClassFor(held);
  return {
    allowed: true,
    decision: cls === "private" || !cls ? DECISIONS.PERMITTED : DECISIONS.PERMITTED_RESTRICTED,
    status: 200,
    message: "",
    capability: null,
    actor: resolved,
    fields: { class: cls, exclude: excludeSelect(held) },
  };
}

module.exports = {
  DECISIONS,
  STATUS_FOR,
  MESSAGE_FOR,
  COMPATIBILITY,
  UNPROVABLE_SCOPE_KEYS,
  resolveHrActor,
  authorizeHr,
  namesSelf,
  employeeIsActive,
  requestedUnprovableScope,
  invalidateHrActor,
  invalidateHrAuthorization,
  resetHrRolesConfiguredCache,
  projectEmployee,
  projectEmployees,
};
