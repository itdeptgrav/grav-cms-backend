# HR organisation scope — the canonical contract

> **Status:** Decided for HRMS Chunk 2A. No schema, index or record was changed
> by this document or by the work that produced it.
>
> **Date:** 8 September 2026
>
> **Readiness evidence:** `docs/audits/hr-organisation-scope-readiness.md`
>
> **Migration plan:** `docs/tasks/hrms-chunk-02.md`
>
> **Durable sources:** `docs/product/hrms-professionalisation-plan.md` §6.1,
> `docs/tasks/hrms-roadmap.md` Chunk 2. Neither is contradicted by this
> document; both are made specific by it.

## 1. The hierarchy

```text
Company
  └─ Legal Entity
       └─ Establishment / Factory / Site
            └─ Department
                 └─ Line / Team
```

| Level | Stable identity | Owner | Mandatory for |
|---|---|---|---|
| Company | `Acc_Company._id` | **Accounts & Finance** | every HR record that is a business fact |
| Legal Entity | *not yet distinct* — see §2 | Accounts & Finance | employment, payroll |
| Establishment / Factory / Site | **does not exist yet** — see §3 | HR (operations) with Finance agreement | attendance, roster, statutory registers |
| Department | `Department._id` (`models/HR_Models/Departments`) | HR | employment assignment |
| Line / Team | **does not exist yet** | HR / Production | nothing yet |

## 2. Company and legal entity are one record today, and that is a decision

`Acc_Company` carries `gstin`, `pan`, `cin`, `tan`, `booksFromDate` and
`financialYearStart`. Those are the attributes of a **legal entity**, and it is
also the only thing in the platform called a company. So today company and legal
entity are the same record.

**Decision.** Keep one record for now, and treat `Acc_Company._id` as the
company identity. Introduce `legalEntityId` as a *separate reference that
initially equals the company* rather than as a second collection. HR records
carry both from the start, so the day a company acquires a second employing
entity nothing has to be re-keyed — only re-pointed.

**Rejected:** inventing an HR-side company master. HR would then hold a second
answer to "which company", and the first time somebody edited one they would
disagree. Finance owns the company; HR references it.

## 3. "Factory", "establishment" and "site" — one concept, three words

The audit found the three words used interchangeably and **none of them backed
by a collection**:

- `Employee.workLocation` — a free-text string defaulting to `"GRAV Clothing"`;
- `Warehouse.siteId` — a bare `ObjectId`, `default: null`, **no `ref:`**;
- `SpCompanyMembership.siteIds` — an array of bare `ObjectId`s, no `ref:`.

**Decision.** They are ONE concept. The canonical name is **Establishment**,
because that is the word the statutory registers, the Factories Act registration
and the payroll returns use, and because "factory" excludes a head office that
still has to file. `factory` and `site` become display aliases; neither becomes a
field name.

An Establishment belongs to exactly one Legal Entity. It is the boundary for:
attendance and the holiday calendar, shift and roster definitions, statutory
registers and inspections, and the biometric device registry.

**Unresolved and deliberately not decided here:** who owns the Establishment
master. It is an HR/statutory concept, but `Warehouse.siteId` and
`SpCompanyMembership.siteIds` already anticipate a site master that Store would
also read. Chunk 2B must not create two. Flagged in §9.

## 4. Which levels are mandatory for which HR records

| Record | Company | Legal entity | Establishment | Department |
|---|---|---|---|---|
| Employee / Worker | required | required | required | required |
| Employment / assignment history | required | required | required | required |
| Attendance day, punch, roster | required | — | **required** | derived |
| Leave application and balance | required | required | — | derived |
| Payroll run | required | **required** | — | — |
| Payroll item | required | required | — | — |
| HR department | required | — | optional | — |
| Document, policy, SOP | required | optional | optional | — |
| Recruitment job, candidate | required | optional | optional | — |

"Derived" means the record does not store it; it is read through the employee's
assignment as at the record's own date (§6).

## 5. HR references Finance cost centres; it does not own them

A cost centre is an accounting dimension. HR needs it to hand payroll to Finance
and for labour-cost reporting, and must never become a second place it is
defined.

**Decision.** The Establishment and the HR Department each carry an OPTIONAL
`financeCostCentreRef`. It is a reference, never a copy of the name or the code.
An HR screen that shows a cost centre reads it through that reference at display
time. HR never creates, renames or deactivates one, and a missing reference is a
data-quality exception — not a reason to invent one.

## 6. Historical records keep the scope that applied when they were made

A transfer must not rewrite the past. An attendance day from March belongs to the
establishment the person worked at in March, whatever their record says today.

**Decision.** Two different mechanisms, on purpose:

- **Transactional records** (attendance day, punch, leave application, payroll
  item, document) **stamp** their scope at creation and never recompute it. The
  stamp is the fact.
- **Current-state records** (Employee, assignment) carry today's scope, and the
  as-at answer comes from the effective-dated assignment history that Chunk 3
  introduces.

Until Chunk 3 exists there is no as-at answer, and Chunk 2B must not pretend
otherwise: a backfilled stamp on a historical record records *today's* belief
about where that person worked, and must be recorded as such
(`scopeProvenance: "backfilled-from-current-assignment"`) so a later correction
can find it.

## 7. How scope enters a request

**Reuse `services/companyContext/companyMembership.service.js`.** It already
resolves a company for an actor for Accounting, Costing and Store: an explicit
`SpCompanyMembership` decides; more than one membership requires the caller to
CHOOSE among their own and validates the choice; a requested company is never
authority by itself; and it fails closed with `TENANT_MEMBERSHIP_UNPROVEN`.

**Decision.** HR consumes that resolver. It does not write a second one.

Two conditions on doing so, both non-negotiable:

1. **The single-company fallback does not apply to HR writes.** That resolver
   returns `SINGLE_COMPANY_DEPLOYMENT` when no membership row exists anywhere
   and exactly one company does. It is correct for reads on a single-company
   deployment; it is a *guess* for a write that stamps a scope permanently. HR
   writes require `MEMBERSHIP_RECORD`.
2. **The membership model is Store's.** `SpCompanyMembership` lives under
   `models/CMS_Models/StorePurchase/`. Chunk 2B must either promote it to a
   shared location or have HR read it through a service boundary; it must not
   copy it.

The existing HR authorisation contract is untouched by any of this. Scope answers
*which records*; `services/access/hrAuthorization.js` answers *which operations*
and *which fields*. They compose; neither replaces the other.

## 8. Organisation assignment is never application access

**Permanent rule, restated because this document is where somebody would be
tempted to break it.**

`Employee.departmentId` (HR org chart) and `Employee.accessDepartmentId`
(application grant) are different columns for this reason, and
`services/access/hrAuthorization.js` reads only the second. Adding company and
establishment adds two more *organisation* facts and no authorisation facts:

- being assigned to an establishment grants nothing;
- a company membership decides which records are in view, never which operations
  are permitted;
- `services/access/hrScopeClassifier.js` has no concept of a capability, grant or
  role, and a test asserts it never gains one.

## 9. Scoped uniqueness

| Identifier | Today | Proposed |
|---|---|---|
| `Employee.biometricId` | `unique + sparse` — **global** | `{ companyId, establishmentId, biometricId }` |
| `Employee.identityId` | `unique + sparse` — **global** | `{ companyId, biometricId }`-style, company-scoped |
| `Employee.email` | `unique + sparse` — global | company-scoped |
| Payroll run | `{ month, year }` unique — **global** | `{ companyId, legalEntityId, month, year }` |
| Attendance | `{ biometricId, dateString }` unique | `{ companyId, establishmentId, biometricId, dateString }` |
| HR department name | `unique` — global | `{ companyId, name }` |

Two findings from the audit change the shape of this work and are recorded here
because they are decisions, not observations:

1. **The declared global uniqueness is not enforced on the live database.** The
   `employees` collection carries `biometricId_1`, `identityId_1` and `email_1`
   as **non-unique** indexes. Mongoose creates a missing index but never alters
   an existing one's options, so the schema has claimed a constraint the database
   has never had. Duplicates exist today as a result.
2. **Therefore duplicate reconciliation precedes indexing, twice over.** Chunk 2B
   step 7 must clean up duplicates that are invalid under *global* uniqueness
   before it can even reach the question of scoped uniqueness.

## 10. Legacy records during migration

- A record with no scope stays readable. Every scope reference is introduced as
  **nullable**, and no read filters on it until step 5 of the migration plan.
- Scope is populated only from `SCOPED` or `DERIVABLE_UNAMBIGUOUS` evidence.
- `AMBIGUOUS`, `CONFLICT`, `DANGLING_REFERENCE` and `UNSUPPORTED_LEGACY_SHAPE`
  are quarantined for a human, never resolved by preference.
- `Employee.workLocation` is **not** evidence. It is a free-text label that
  defaults to a company name; reading it as an establishment is guessing.

## 11. What fails closed

| Situation | Answer |
|---|---|
| Scope cannot be proved for a WRITE | refuse — no default company, no first-match |
| Scope cannot be proved for a READ, pre-migration | serve unscoped, as today, and count it |
| Scope cannot be proved for a READ, post-migration | refuse |
| A request names a company the actor cannot prove | `TENANT_MEMBERSHIP_UNPROVEN`, worded identically to naming one that does not exist |
| Two evidence paths disagree | `CONFLICT` — quarantine, never prefer one |
| The scope resolver cannot reach its records | 503, never "allowed" |

The existing HR contract already refuses `companyId`, `legalEntityId`,
`establishmentId` and `factoryId` in a request with `HR_SCOPE_NOT_PROVABLE`
(`services/access/hrAuthorization.js`). **That refusal stays until Chunk 2B step
8**, and lifting it is a step in that plan with its own preconditions — not a
side effect of adding a column.

## 12. Unresolved — needs a product decision before Chunk 2B

1. Who owns the Establishment master, given `Warehouse.siteId` and
   `SpCompanyMembership.siteIds` already anticipate one? (§3)
2. Is GRAV one legal entity today, or does the first migration have to support
   several? (`hrms-professionalisation-plan.md` §14.1, still open.)
3. Should `SpCompanyMembership` be promoted out of Store, or read across a
   service boundary? (§7)
4. Which establishment do the 98 employees whose only site evidence is
   `workLocation: "GRAV Clothing"` belong to? The audit will not guess, and
   neither will the migration.
