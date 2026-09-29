# HR legacy role compatibility

> **Status:** Temporary bridge, shipped with HRMS Chunk 1.
>
> **Date:** 7 September 2026
>
> **Contract:** `docs/decisions/hr-authorisation-contract.md`
>
> **Code:** `services/access/hrCapabilities.js` (`LEGACY_HR_ROLES`,
> `LEGACY_BOARD_ROLES`, `LEGACY_ADMIN_ROLES`) and
> `services/access/hrAuthorization.js` (branch (d)).

## Why a bridge is needed at all

GRAV has two ways of proving who somebody is, and they disagree about what a
person *has*.

1. **Grant records.** An `Employee` row with `accessDepartmentId` /
   `additionalDepartmentIds`, and a `DepartmentRole` row saying what they may do
   inside that department. This is the model the contract is built on, and the
   one Access Control manages.
2. **A signed role claim.** `routes/login.js` and `routes/auth/deptAuth.js` mint
   a JWT whose `role` is `AccessDepartment.legacyRole` — `hr_manager`, `ceo`,
   `sales`, and nine more. Roughly 270 authorisation checks across the codebase
   still compare against those strings.

Accounts that sign in against a legacy department collection — the CEO, the HR
administrator — have **no `Employee` row at all**. No grant record can exist for
them, so a contract that read only grant records would lock them out of HR the
moment it shipped. `services/access/hrAccess.js` already carried a role map for
exactly this reason; this documents and narrows it rather than removing it.

## What the bridge does, precisely

```text
role claim + no Employee identity + an ACTIVE legacy account
                                     → HR APPLICATION ACCESS (layer 2)
role claim alone                     ✗ nothing
role claim → capabilities            ✗ never
```

## What the claim costs

The bridge used to accept the claim from any session that carried it. That made
it a way to survive revocation, because the claim is minted at login and lives
in the token for seven days: take an ordinary employee holding `hr_manager`,
remove their HR `DepartmentRole` **and** their HR access-department grant, and
the token already in their browser kept opening the workforce directory until it
expired. Nothing an administrator could do in Access Control reached it.

Two proofs are now required from the database on every request:

1. **No Employee identity for this session.** An employee's authority comes from
   their own records. The bridge exists for accounts that *cannot* hold any — it
   is not a fallback for an account whose records were removed. Where both exist
   (a legacy row and an Employee row sharing an address), the Employee records
   win and the claim contributes nothing.
2. **The token was issued FOR that account collection.** `userType` is the
   claim that says which collection authenticated the request, and
   `hrContract::seedIdentity` used to drop it — so the bridge picked the
   collection from `role` instead, and a session authenticated against Sales
   carrying `role: "hr_manager"` was checked against `HRDepartment`, a
   collection it had never signed in to. The HR bridge now requires
   `userType === "hr"` and the CEO bridge `userType === "ceo"`, matched exactly.

   Those two literals are not invented. `routes/login.js` sets its `userModel`
   to `"hr"` when it matched `HRDepartment` and `"ceo"` when it matched
   `CEODepartment`; `routes/auth/deptAuth.js` writes `dept.legacyUserType` on
   both of its paths, and `AccessDepartment.legacyUserType` is set from a slug
   the schema already forces to lowercase. The comparison is exact rather than
   case-folded for that reason: `role` is folded because it is matched against
   historical literals and `HR_MANAGER` is the same grant shouted, but
   `userType` is a subject type the SERVER writes, so anything that is not the
   literal did not come from a token builder. A missing, empty, mismatched or
   unrecognised type fails closed.

   An employee-app token can never enter either bridge: it carries
   `type: "employee"`, which is refused before anything else is read.

3. **The legacy account is found and active, BY SUBJECT ID.** `HRDepartment` for
   `hr_manager` / `hr`, `CEODepartment` for `ceo`, an active `DeptUser` for
   `admin`. The row is looked up by the token's own `id` and nothing else —
   matching on email as well proved only that "a similarly identified row exists
   somewhere", which is a different claim: two collections can hold the same
   address for two different accounts, and an address is not a subject. `_id`
   is: v1 signs the legacy document's own `_id`, and v2 signs the `DeptUser`
   `_id`, which is reused verbatim from the legacy row it was seeded from (see
   `models/Access/DeptUser.js`). So the same account keeps working after an
   address change, and somebody else's address stops being a way in.

   An explicit `isActive: false` refuses; a missing row refuses. `isActive`
   *absent* is treated as active, because the oldest `HRDepartment` rows predate
   the field and never having set a flag is not the same as switching an account
   off.

The resolved-actor cache key carries `userType` and `type` alongside the id,
email and role, so two sessions differing only in account source cannot share an
answer.

If any proof fails, the actor carries `LEGACY_CLAIM_NOT_PROVEN` and receives
no HR application access. A deactivated or soft-deleted Employee
(`isActive: false` or `status: "inactive"`) loses every proof an employee record
can offer — role grant, application grant and claim alike.

| Claim | Effect | Template |
|---|---|---|
| `hr_manager`, `hr` | HR application access | `hr_viewer`, always |
| `ceo` | HR application access | `ceo_projection` (read-only) |
| `admin`, `super_admin`, `superadmin` | HR application access | `ceo_projection` (read-only) |
| anything else | nothing | — |

Three properties matter and each is covered by a test in
`test/hr-access/hr-authorisation.test.js`:

- **Central.** One map, in one file. No route compares a role string.
- **Narrow.** It proves only that HR may be OPENED. What may be done inside it
  comes from a template, and a legacy `hr_manager` with no `DepartmentRole` row
  gets the VIEWER set — which is exactly what happens today, where reads are
  ungated and `requireDepartmentRole` answers `NO_DEPARTMENT_ROLE` to the write.

  This used to have an exception, and the exception was the whole problem: in a
  department with no `DepartmentRole` rows the claim resolved to the OWNER
  template, so `hr_manager` bought payroll reopen, HR configuration,
  confidential cases and credential administration. It no longer does, in either
  state. Bootstrapping the first owner is a platform-administrator action; see
  `docs/decisions/hr-authorisation-contract.md` §6.
- **Closed.** An unrecognised string grants nothing. `hr_superuser`,
  `payroll_admin` and `hr-manager` are refused; the map is case-normalised,
  because the claim is minted from `legacyRole` and `HR_MANAGER` is the same
  grant shouted, not a different one.
- **Revocable.** A recognised string grants nothing either, unless the account
  behind it is re-proven from the database on that request. Deactivating the
  legacy row, deleting it, deactivating the employee, or removing both HR
  records from an employee all take effect on the very next request rather than
  when the token expires. `test/hr-access/legacy-bridge-revocation.route.test.js`
  drives each of those through the real guard with the same token before and
  after.

An `admin` role CLAIM is deliberately **not** platform-administrator access.
That is `DeptUser.isAdmin`, re-read from the database on every request. A token
asserting `isAdmin: true` for an address with no administrator record gets
nothing from the assertion.

## The divergence from login, on purpose

`routes/auth/deptAuth.js:resolveEmployeeDepartments` has a fallback: when an
employee has no `accessDepartmentId` and no `additionalDepartmentIds`, it
matches their org-chart department NAME against the active access departments
and, if exactly one matches, treats that as their grant.

The contract does not inherit that fallback. It is the precise shape the plan's
design rule #2 forbids — an HR staff member renaming an org-chart department
would become an authorisation change — and the roadmap's stop conditions list
"infer access from organisation assignment" as a reason to halt.

**Consequence, and the thing to watch at rollout.** An account that today
reaches HR *only* through that name fallback — no access grant, no HR role, no
`hr_manager` claim — will be refused by the contract with
`HR_NO_APPLICATION_ACCESS` while still being able to sign in. Three independent
paths cover the real population (an explicit HR `DepartmentRole` grant, an HR
access-department grant, or the legacy `hr_manager` claim), and HR writes
already require a `DepartmentRole` row today, so every current HR *editor* has
one. The fix for anyone caught by this is one grant in CEO → Access Control, and
the denial log line names the account.

## Retirement

Remove this bridge when all three hold:

1. every HR account has an `Employee` row with an `hr` access-department grant,
   or a `DepartmentRole` row for `hr` — including the CEO and the HR
   administrator, which means the legacy department collections have been
   migrated to `DeptUser`;
2. `routes/auth/deptAuth.js`'s legacy twelve-collection fallback has been
   dropped (rollout step 8 in that file's own header);
3. the org-chart-name fallback in `resolveEmployeeDepartments` has been removed
   or made explicit, so login and this contract agree on what a grant is.

Deleting `LEGACY_HR_ROLES`, `LEGACY_BOARD_ROLES` and `LEGACY_ADMIN_ROLES`, plus
branches (d) and the claim half of (e) in `resolveHrActor`, is then the whole
change. `test/hr-access/hr-authorisation.test.js` will tell you immediately
whether anybody still depended on them.
