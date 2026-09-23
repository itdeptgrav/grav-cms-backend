# HR authorisation contract

> **Status:** Implemented — HRMS Chunk 1 (`docs/tasks/hrms-roadmap.md`).
>
> **Date:** 7 September 2026
>
> **Product plan:** `docs/product/hrms-professionalisation-plan.md`
>
> **Source audit:** `docs/audits/hrms-existing-codebase-audit.md` (finding P0,
> "authentication and authorisation are not consistently equivalent")
>
> **Generated matrix:** `docs/audits/hr-endpoint-capability-matrix.md`

## 1. The decision

Every HR endpoint answers to one contract, enforced server-side in four layers
and a projection:

```text
1  authentication      is there a verified session at all
2  application access  may this account open the HR application
3  capability          may it perform THIS operation
4  record scope        may it affect THIS record / person / company
   ↓
   protected-field projection on the way out
```

A valid login satisfies (1) and nothing else. Before this change,
`EmployeeAuthMiddlewear` — which only calls `jwt.verify` — was the whole of the
guard on most HR reads, so any authenticated CMS account could read the employee
directory, attendance, leave, payroll items, payslips and the change history of
the entire workforce.

## 2. The pieces

| File | Answers |
|---|---|
| `services/access/hrCapabilities.js` | what operations exist, and which role template grants them |
| `services/access/hrFieldPolicy.js` | which fields may leave the server, per capability — the allowlist AND the response scrub |
| `services/access/hrAuthorization.js` | the one question, from access records |
| `services/access/hrWritePolicy.js` | what a request BODY may change, and which capability each field needs |
| `services/access/hrManagerScope.js` | proving a reporting relationship from stored records |
| `services/access/hrRouteContract.js` | the declaration for every mounted endpoint |
| `services/access/hrMountRegistry.js` | which routers the contract covers |
| `Middlewear/hrContract.js` | enforcement, at the mount |
| `scripts/hrRouteInventory.js` | the matrix, and the coverage test's input |

The guard is mount-level and the declaration is per endpoint. That split is
deliberate and is the same argument `Middlewear/departmentWriteGuard.js` makes:
HR is ~320 handlers across 36 routers, several of them thousands of lines long,
and a guard that must be remembered per handler is a guard with a hole in it.

## 3. Rules this encodes

**Organisation assignment is never application access.** The resolver reads
`Employee.accessDepartmentId` and `additionalDepartmentIds` — the ACCESS grant —
and never `Employee.department`, `departmentId`, `designation`, `jobTitle` or a
reporting manager. Being filed under HR on the org chart grants nothing.
`routes/auth/deptAuth.js:resolveEmployeeDepartments` does fall back to matching
the org-chart department NAME when an employee has no access grant at all; that
fallback belongs to login and is deliberately not inherited here — see
`docs/decisions/hr-legacy-role-compatibility.md`.

**Nothing from the browser decides authority.** Role, company, factory,
department, manager and capability values in a request body are data. Authority
is re-derived per request from `DeptUser.isAdmin`, the HR `DepartmentRole` grant
and the employee's access-department grants.

**A signed role claim proves application access and nothing more — and only
for an account that cannot hold grant records.** The CEO and the HR
administrator authenticate against their own department collections and have no
`Employee` row, so no grant record can exist for them. Their `role` claim is
therefore read — but only to answer "may you open HR"; the capability set still
comes from a template, and an unrecognised role string grants nothing.

Using the claim costs two proofs from the database, on every request:

1. **No Employee identity for this session.** An employee's authority is their
   own records, and if those say nothing then nothing is the answer. The bridge
   is for accounts that *cannot* hold such records, not a fallback for accounts
   whose records were removed.
2. **The legacy account is found and active.** `HRDepartment` / `CEODepartment`
   is re-read and an explicit `isActive: false` refuses; for an `admin` claim
   the proof is an active `DeptUser`, which `gatherIdentity` already filters on.

Without that, revocation waited for the cookie: an ordinary employee whose HR
`DepartmentRole` **and** HR access-department grant had both been removed kept
opening the workforce directory for the remaining seven days of their token, and
nothing an administrator could do in Access Control reached it. Unprovable now
means refused, and the actor carries `LEGACY_CLAIM_NOT_PROVEN` so the log
answers "my token used to work".

**A deactivated employee is not an employee.** A leaver keeps every field they
had — `accessDepartmentId` included — because the record is retained for payroll
and audit history. Reading the grant without reading the state would let them
back in with the token already in their browser, so `isActive: false` or
`status: "inactive"` (both of which `DELETE /api/employees/:id` sets) removes
every proof an employee record can offer: the role grant, the application grant
and the claim.

**Denials disclose nothing.** Every 403 carries the same sentence. The scope
check never loads the target, so a refusal for a record that does not exist and
one for a record the caller may not see are byte-identical, and the endpoints
cannot be used to enumerate people. Refusals are logged with the declaration's
path TEMPLATE rather than the request URL, so an id the server declined to
disclose does not appear in a log line instead.

**A protected value is not serialized to somebody without the capability.**
Two mechanisms, and the second exists because of what the first cannot reach.
`req.hrAuth.project` is the ALLOWLIST — the right tool for a handler returning
an employee, and the one that also produces `req.hrAuth.exclude` so a restricted
value is never even loaded from the database. Underneath it,
`hrFieldPolicy.scrubResponse` is a FLOOR: the guard wraps `res.json` and removes
the protected leaves this caller has no capability for, so a handler that has
not been taught the projection cannot serialize a salary, a bank account, a
government identifier, a blood group or a password hash to somebody who may not
have it.

The scrub is deliberately a small, exact denylist of leaf names, not a pattern.
A broader rule — anything matching `/token|secret/`, say — would strip the
short-lived link `/api/hr/documents/:id/link` exists to return, and a shape bug
in a permission layer is a permission bug. It normalises through `toJSON()`
first, which is what `res.json` is about to do anyway: without that, an
`ObjectId` is rebuilt as `{}` and every id in the response is corrupted, and a
mongoose Document's protected fields — which live behind accessors — would be
skipped entirely.

Two exceptions, both narrow:
- **Self-service** (`scope: "self"`) skips the capability rules. The record IS
  the caller's, so an employee reads their own pay at `/api/employee/salary`
  without holding `compensation.read`. Credential material is still removed.
- **Credential delivery** is opted into by ONE declaration, by name:
  `POST /api/hr/password-management/reset-password/:userType/:id`
  (`credentialDelivery: true`). It is the only operation whose output is a
  one-time credential.

  It used to be enabled for anything holding `security.credentials.manage` —
  which is the entire password-management family, lists and lookups and syncs
  included. `POST /bulk-reset` was the worst of it: it reset every selected
  account to the default derived from that person's mobile number and returned
  the plaintext for each one, so twelve selected employees meant twelve working
  credentials in a single response. That handler now returns identifiers and
  per-row status only, and the scrub removes credential material by every name
  it travels under (`hrFieldPolicy.CREDENTIAL_KEYS`: `newPassword`,
  `passwordHash`, `defaultPassword`, `generatedPassword` and the rest) rather
  than only by Employee field name. The stored `password` hash is never
  returned anywhere, including on the delivering route.

  This one exception is deliberate, so that "HR resetting another person's
  credentials remains a privileged, audited action" stays true — flagged here
  rather than resolved silently.

**A route is not always one operation.** `PUT /api/employees/:id` carries a
corrected middle name, a transfer and a salary revision. Declaring one
capability for the route is wrong for two of them, so the three employee writes
(create, update, bulk update) declare the floor — `people.write` — and
`writePolicy: "employee"` adds whatever the payload actually touches:
`compensation.write` for salary or banking, `employment.change` for state,
`people.read.identifiers` for the `documents` sub-document. The classification
runs at the mount, before the handler, so a payload mixing an allowed change
with a refused one is refused whole and nothing is partially written.

**Application grants are not HR's to give.** `accessDepartmentId`,
`additionalDepartmentIds`, `isAdmin`, `capabilityOverrides`, `tokenVersion`,
credentials and audit stamps are refused on every HR employee route at every HR
role, with `HR_FIELD_NOT_WRITABLE`. An HR owner who could write
`accessDepartmentId` through an employee form could grant themselves — or
anybody — any application on the platform, with an HR-shaped audit entry in
front of it. Those fields belong to Access Control.

**Self-service is an allowlist.** `PUT /api/employee/profile` applied `req.body`
after deleting fourteen named fields from it. Everything the list did not name
was written: salary, banking, employment state, designation, statutory
identifiers — and `accessDepartmentId`, so any employee holding the mobile app
could grant themselves HR. The list of what somebody may change about
themselves now lives in `hrWritePolicy.SELF_EDITABLE_FIELDS`, protected fields
are refused with `SELF_FIELD_NOT_EDITABLE`, and the read-only extras the profile
GET adds (`fullName`, `phoneNumber`, the pre-formatted dates) are ignored rather
than refused so a round-trip does not fail over a rendering convenience.
`req.body` is never mutated.

**A manager route is authorised by a relationship, proved server-side.**
`scope: "manager"` had no branch in `authorizeHr` at all, so eighteen
declarations fell through to "permitted" and the whole proof lived inside the
handlers. Each manager declaration now carries a descriptor, and
`services/access/hrManagerScope.js` proves it from stored records only —
`managerId`, `isManager`, `role`, `approverId` and anything else in a request
body or query string prove nothing. The handlers keep their own checks as
defence in depth; they are simply no longer the first line.

| Descriptor | Used by | Proof |
|---|---|---|
| `record` + `param` | leave / regularisation / overtime decisions, `manager/:id/edit`, `quick-apply/:id/resolve` | load the row named in the path; the actor is in its `managersNotified` chain, **or** is the target employee's stored primary or secondary manager |
| `employeeFrom` | `manager/add-on-behalf` | the employee named in the body is a stored report of the actor |
| `queue: "current"` | `manager/pending`, `manager/my-team`, `manager/withdraw-pending` | at least one **active** employee names the actor as primary or secondary manager |
| `queue: "history"` | `manager/history` | the `current` rule, **or** the actor is named on a stored `managersNotified` chain on any leave, regularisation or overtime record |

**Before any of those, the actor must themselves be an active Employee.** Every
rule in the table works by finding the actor's id in a stored record, and stored
records are retained: `managersNotified` chains and `primaryManager.managerId`
outlive the person they name, and `resolveHrActor` falls back to the token's own
`id` as `employeeRef` when no Employee row was found. So an id that merely
*appeared* in a reporting field was enough — which made managers of a
hard-deleted employee, a deactivated one, and a legacy HR or CEO department
account whose `_id` happened to sit in a manager field. The proof now starts
from `actor.employee`, the row the resolver actually fetched, and requires
`isActive !== false` and `status !== "inactive"`. Retained history keeps an
**active** former manager's own record of their decisions; it does not keep
application access for somebody who has left.

**The two queue rules, and why there are two.** A queue carries no target, so
there is nothing to prove a relationship *against*; what can be proven is the
PERSONA. `queue: true` used to return true unconditionally, which meant every
authenticated employee passed the central contract for every manager queue and
the persona was enforced nowhere but inside the handlers' own `WHERE` clauses.

- **Current** is the live org chart. A manager whose team has raised nothing
  still passes — the persona comes from the reporting rows, not from having work
  waiting — and receives an empty queue. A departed report does not count: a
  leaver's record names their old manager for ever, and counting it would make
  somebody permanently a manager of nobody, so the check requires
  `isActive !== false` and `status !== "inactive"` on the report.
- **History** additionally accepts a stored decision chain. A reorganisation
  moves people, and the decisions a former manager made are still theirs; their
  own history should not disappear because the org chart changed underneath
  them. It is a read of their own past decisions and nothing wider, because the
  handler's query filters on their id either way.

**Undeclared is refused.** An HR path with no declaration answers 403
`HR_ROUTE_NOT_DECLARED`, and `test/hr-access/route-coverage.test.js` fails the
build for the same condition.

## 4. Denial codes

| Code | Status | Means |
|---|---|---|
| `HR_UNAUTHENTICATED` | 401 | no verified session |
| `HR_NO_APPLICATION_ACCESS` | 403 | signed in, but not an HR account |
| `HR_MISSING_CAPABILITY` | 403 | an HR account without this capability |
| `HR_OUT_OF_SCOPE` | 403 | self-service naming another person's record |
| `HR_SCOPE_NOT_PROVABLE` | 403 | a company/factory scope no record carries yet |
| `HR_FIELD_NOT_WRITABLE` | 403 | a field no HR role may write through this route |
| `HR_OUT_OF_SCOPE` (manager) | 403 | not a manager, or not a manager of this record |
| `SELF_FIELD_NOT_EDITABLE` | 403 | a self-service write naming a field HR owns |
| `HR_ROUTE_NOT_DECLARED` | 403 | an HR route with no declaration |
| `HR_AUTHORISATION_UNAVAILABLE` | 503 | the resolver could not read the access records |

The last one is the fail-closed case. A resolver that cannot reach the access
records cannot prove anybody may read HR, and answering "yes" while the database
is unreachable turns an outage into a disclosure.

## 5. Role templates

| Template | Granted to | Notable |
|---|---|---|
| `hr_viewer` | HR `DepartmentRole` viewer | directory, attendance, leave, recruitment, documents, analytics, audit READS only |
| `hr_editor` | HR editor | + private identity, statutory identifiers, medical, people/employment writes, attendance correction, HR leave decisions, document issue |
| `hr_approver` | HR approver | + compensation READ, attendance close, leave configure, payroll prepare/approve, offer approve, document release, audit export |
| `hr_owner` | HR owner | + compensation write, payroll reopen, confidential cases, credential administration, HR configuration |
| `platform_admin` | `DeptUser.isAdmin` | the whole owner set — a compatibility exception, §6 |
| `ceo_projection` | `ceo` grant, or the `ceo` / `admin` role claim | directory, attendance, leave, workforce analytics, SOP points. **No** compensation, private identity, government IDs, medical or cases, and structurally read-only |
| `employee_self` | any authenticated employee | own record; carries no `hr.access` |
| `manager_self` | a proven reporting relationship | + `leave.decide.manager` |

Two capabilities were added beyond the catalogue the brief names, because the
plan puts government identifiers and medical/disability data in the HIGHLY
RESTRICTED bucket alongside pay, not in the ordinary private one:
`people.read.identifiers` and `people.read.medical`. HR operations hold both;
the CEO/Management projection holds neither. Without them, "do not broaden
management access to government IDs or medical information" would be a sentence
in a document rather than an enforced rule.

## 6. Compatibility exceptions

Each one preserves behaviour that exists today rather than making it permanent.
Each has a named condition attached to the resolved actor, so it is visible in
tests and in logs instead of being folklore.

### `PLATFORM_ADMIN_FULL_HR`
A platform administrator (`DeptUser.isAdmin`) receives the full HR owner set,
including compensation. This mirrors what every department guard in the codebase
already does — `requireDepartmentRole` and `requireApproval` both wave
administrators through explicitly — and HR does not get to be the one place that
disagrees. It is written as an explicit capability list rather than "everything",
so narrowing it later is one line and a test.
**Exit:** answer product question §14.7 of the plan — who may view compensation,
government IDs, medical information and confidential cases, administrators
included — then remove the capabilities that answer says they should not have.

### `LEGACY_ROLE_TOKEN`
Application access proved by the signed `hr_manager` / `hr` / `ceo` / `admin`
role claim, for accounts that authenticate against a legacy department
collection and have no `Employee` row to carry a grant.
**Exit:** `docs/decisions/hr-legacy-role-compatibility.md`.

### `HR_ROLES_UNCONFIGURED` — informational only
If the HR department has NO `DepartmentRole` rows at all, the condition is
attached to the resolved actor and a warning is logged once per process. **It
grants nothing.**

It used to promote every HR grant, and every legacy `hr_manager` claim, to the
OWNER template — payroll reopen, HR configuration, confidential cases and
credential administration, handed to anybody with an application grant, while
the contract reported that capability enforcement was active. That was a
fail-open wearing a compatibility note, and it is gone. An application grant
with no role row resolves to `hr_viewer`, which is also what the write path
already did (`requireDepartmentRole` answers `NO_DEPARTMENT_ROLE`).

**Bootstrapping the first owner** is a platform-administrator action, not a
request-time promotion: a `DeptUser` with `isAdmin` holds the full HR set
(`PLATFORM_ADMIN_FULL_HR`) and grants the first HR owner from
CEO → Access Control → HR. On a deployment with no platform administrator yet,
seed one `DeptUser` with `isAdmin: true` before enabling HR.

### `LEGACY_GLOBAL_HR_SCOPE`
An HR grant is global. No HR schema carries a company, legal entity or
establishment (audit finding P0), so there is no tenant boundary to enforce and
this contract does not claim one. What IS enforced: a request that explicitly
names `companyId`, `legalEntityId`, `establishmentId` or `factoryId` is REFUSED
with `HR_SCOPE_NOT_PROVABLE` rather than silently answered across all of them —
because silently ignoring it is exactly how a UI filter comes to be mistaken for
a security boundary.
**Exit:** Chunk 2.

### Endpoints left on compatibility behaviour

| Endpoint | Why |
|---|---|
| `ALL /api/hr/policy/c4-presence-cron` | Declared `public`: it carries no session because an external scheduler cannot sign in, and authenticates its CALLER with the `C4_CRON_KEY` shared secret (refusing outright when that variable is unset). Deliberately outside the capability model. |
| `GET /api/hr/app/latest`, `GET /api/hr/app/download/:id` | The employee app's own update check, called before anybody signs in. |
| `GET /hr/face-registration/health` | Liveness of the punch-in machine's face engine. No data, no identity. |
| `GET /api/employee/documents/:id/download` | Carries its own short-lived signed token so the browser can follow the link; the router verifies it and never projects an unreleased row. |
| `GET /employee/public/:identityId` | The public ID-card lookup. Declared for the matrix; not mounted behind the guard. |
| `POST /api/employee/auth/*`, `GET /api/employee/auth/verify|profile` | The employee app's own sign-in surface, which authenticates itself. |
| `/api/hr/vendors/**` | The Supply Chain vendor router, mounted under `/api/hr` by `server.js`. The audit's disposition is "remove from HR"; moving it is a navigation change and out of scope here. Declared with HR application access and no people/compensation capability — it reads no workforce data. |
| `POST /api/ceo/hr/attendance/sync` | Declared with `attendance.close`, which the CEO projection does not hold, so management stays read-only. Nothing breaks: the handler proxies to `/hr/attendance/sync`, a path that does not exist (the real one is `/sync-period`), so it has been answering the proxy's 404 since it shipped. |

## 7. What this chunk did NOT do

No company/legal-entity/factory model, no Person/Worker/Employment/
WorkerAssignment records, no attendance-model consolidation, no leave-ledger
redesign, no payroll calculation change, no recruitment redesign, no new screens,
and no data migration of any kind. The HR routers' own handlers are unchanged;
the contract sits above them.

## 8. Known limitations

- **Record scope inside HR is global.** An HR editor can act on any employee.
  Department/team/factory scoping needs the organisational records Chunk 2
  introduces; enforcing a scope that cannot be proven would be theatre.
- **Four employee-read routes now use the projection; the rest still select
  their own fields.** `GET /api/employees/all`, `GET /api/employees/:id`,
  `GET /api/ceo/hr/employees` and `GET /api/ceo/hr/employees/:id` pass
  `selectFor(req, …)` to the query — so a restricted value is never loaded and
  never decrypted — and `projectFor(req, …)` to the response, which is an
  ALLOWLIST: a column added to Employee tomorrow is withheld by default instead
  of published by default. Both fail closed to the directory class when the
  contract did not run.

  `GET /api/employees/:id/details` gets `selectFor` but not `projectFor`: it
  returns a reshaped view (`basicInfo`, `workInfo`, dates pre-formatted for
  display), not an Employee document, so an allowlist of Employee field names
  has nothing to match. Its protection is the query exclusion, the guard's
  response scrub, and the `people.read.private` on its declaration. Every other
  HR route still relies on the scrub, which is a denylist — extending
  `projectFor` to the payslip, attendance and report responses is the next
  step.
- **Manager scope is proved by the contract for all eighteen declared routes** —
  eleven against the record named in the request, seven against the persona (see
  the descriptor table in §3). The relationship is CURRENT, not dated: a manager
  can still act on a record from a period when somebody else managed that
  employee, and the `history` queue rule is deliberately generous in the other
  direction. Dated reporting relationships are Chunk 3.
- **An HR editor no longer sees or writes pay.** Under the role templates,
  compensation reads and writes start at approver and owner respectively. Today
  any authenticated account can read it, so this is the intended tightening —
  but it is a visible change on the employee detail page's salary tab, and on
  the salary fields of the employee form, for anybody holding only an editor
  grant. The answer is an approver or owner grant, not a code change.
- **An HR application grant alone is now read-only.** Previously, in a
  department with no roles assigned, it resolved to owner. Any deployment
  relying on that must assign HR roles in CEO → Access Control; a platform
  administrator can do so and holds the full HR set meanwhile.
- **The actor cache is 30 seconds, and every authorisation mutation clears it.**
  Role grants, changes, revocations and the incumbent-owner demotion; access
  department assignment, removal and bulk assignment; platform-administrator
  grant and revocation; account and department deactivation; department-login
  removal; email migration; and — through the HR routes themselves —
  `PUT /api/employees/:id`, `PATCH /api/employees/bulk-update` and
  `DELETE /api/employees/:id` whenever the write touched `status`, `isActive`,
  `employmentType` or an access-department field. That last group is a separate
  decision from `invalidateAppAccess`, which drops the five-minute cache
  deciding whether the mobile app will let somebody in; both are kept and both
  are called. Eviction happens only AFTER a write succeeds — a refused mutation
  throws away nobody's cached decision. It clears the whole map rather than one entry,
  because the key is composite (`id|employeeId|email|role`) and a mutation does
  not hold the affected person's session claims. A decision that is not
  invalidated by one of those paths can stand for up to thirty seconds.
