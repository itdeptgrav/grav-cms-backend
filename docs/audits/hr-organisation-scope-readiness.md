# HR organisation scope — readiness audit

> **Status:** Read-only audit for HRMS Chunk 2A. No record, schema or index was
> changed.
>
> **Date:** 8 September 2026
>
> **Runner:** `scripts/audits/hrOrganisationScope.js` (no `--apply`, no write
> path; `test/hr-access/hr-organisation-scope-audit.test.js` asserts that
> against the source)
>
> **Classifier:** `services/access/hrScopeClassifier.js` (pure)
>
> **Contract:** `docs/decisions/hr-organisation-scope.md`

## 1. What the HR domain carries today

**Nothing.** No file under `models/HR_Models/`, nor `models/Employee.js`, nor
`models/Access/`, contains `companyId`, `legalEntityId`, `establishment`,
`factoryId`, `plantId` or `siteId`. This is the audit's headline and it confirms
finding P0 of `docs/audits/hrms-existing-codebase-audit.md`.

## 2. The representations that do exist

| Concept | Where | Type | Required | Index / uniqueness | Nature |
|---|---|---|---|---|---|
| Company | `Acc_Company` (`models/Accountant_model/Acc_MasterModels.js`) | collection | — | `companyCode` unique+sparse; `gstin`, `isPrimary` non-unique | **authoritative**, owned by Finance |
| Legal entity | *same record* — `gstin`, `pan`, `cin`, `tan` live on `Acc_Company` | — | — | — | **conflated** with company |
| Establishment / factory / site | **no collection** | — | — | — | **absent** |
| Site (anticipated) | `Warehouse.siteId`, `SpCompanyMembership.siteIds` | `ObjectId`, **no `ref:`**, default `null` | optional | none | **placeholder**, unpopulated |
| Site (HR's stand-in) | `Employee.workLocation` | `String`, default `"GRAV Clothing"` | optional | none | **legacy free text**, not a reference |
| Department (HR org) | `Department` (`models/HR_Models/Departments.js`) | collection | — | `name` **unique — global** | authoritative for assignment |
| Department (application) | `AccessDepartment` (`models/Access/AccessDepartment.js`) | collection | — | `key`, `slug` unique | authoritative for **access**, not org |
| Department role | `DepartmentRole` | collection | — | `{departmentSlug, email}` unique | **authorisation**, not organisation |
| Employee ↔ application | `Employee.accessDepartmentId`, `additionalDepartmentIds` | `ObjectId` ref | optional | `accessDepartmentId` indexed | **application access** |
| Employee ↔ org | `Employee.departmentId`, `Employee.department` | ref + free string | optional | none | **assignment**; the string is duplicated and drifts |
| Production line | none in HR | — | — | — | absent |
| Cost centre | none anywhere under that name | — | — | — | absent |
| Attendance location | none on `Attendance` or `DailyAttendance` | — | — | — | absent |
| Payroll company | none on `Payroll` | — | `{month, year}` **unique — global** | — | absent |
| Payroll company (Finance side) | `Acc_PayrollBridge.payrollExternalPost.companyId` | `ObjectId` | required | `{companyId, payrollRunId}` unique | **authoritative** — Finance already scopes |
| Request company context | `services/companyContext/companyMembership.service.js` + `SpCompanyMembership` | service + collection | — | `{companyId,email}`, `{companyId,employeeRef}` unique | **authoritative**, used by Accounting/Costing/Store, **not** by HR |

Two similarly named fields that are **not** the same thing, recorded because
conflating them is the failure mode this audit exists to prevent:

- `Employee.departmentId` is an org-chart assignment. `Employee.accessDepartmentId`
  is an application grant. HR staff rename the first freely; renaming the second
  would be an authorisation change.
- `Department.name` (HR org, globally unique) and `AccessDepartment.slug`
  (application, globally unique) are different namespaces that happen to hold
  similar words.

## 3. Live classification counts

Run 8 September 2026 against the configured **development** database
(`test @ cluster0.nffihha.mongodb.net`), read-only, exit code 0.

| Model | Level | Records | Result |
|---|---|---|---|
| Employee | company | 105 | **98 `UNSUPPORTED_LEGACY_SHAPE`**, 7 `MISSING` |
| HR Department | company | 14 | 14 `MISSING` |
| Attendance | establishment | 0 | — |
| DailyAttendance | establishment | 192 | 192 `MISSING` |

`Acc_Company` count: **1**.

`SCOPED` = 0, `DERIVABLE_UNAMBIGUOUS` = 0, `AMBIGUOUS` = 0, `CONFLICT` = 0,
`DANGLING_REFERENCE` = 0 across every model.

Read those zeros carefully. There are no conflicts *because there is no direct
evidence to conflict with*, and nothing is derivable *because no HR record
references anything scope-bearing*. The 98 `UNSUPPORTED_LEGACY_SHAPE` employees
are the ones carrying a `workLocation` string; the classifier reports the shape
rather than reading it, because a free-text label that defaults to a company name
is not a site reference.

**One company exists. That is a deployment fact, not evidence on a record.** It
would make a single-company backfill *safe*, and the audit still refuses to call
it `DERIVABLE_UNAMBIGUOUS` — a derivation has to come from the record.

## 4. Uniqueness risk

| Identifier | Constraint today | Duplicate groups found | Legal once scoped | Still invalid |
|---|---|---|---|---|
| `Employee.biometricId` | schema says `unique + sparse` — **global** | 1 | 0 | **1** |
| `Employee.identityId` | schema says `unique + sparse` — **global** | 2 | 0 | **2** |
| Payroll run `{month, year}` | `unique` — **global**, 5 runs | 0 | 0 | 0 |

### 4.1 The declared uniqueness is not enforced on the live database

Duplicates exist under a constraint that says they cannot. Reading the live
indexes on `employees` explains why:

```
biometricId_1   { biometricId: 1 }   unique: false   sparse: true
identityId_1    { identityId: 1 }    unique: false   sparse: true
email_1         { email: 1 }         unique: false   sparse: true
```

The schema declares `{ unique: true, sparse: true }` for all three. Mongoose
creates an index that is missing but never alters the options of one that already
exists, so these were built non-unique at some point and have stayed that way.
**The application has believed for some time that it had a uniqueness guarantee
it does not have.**

Consequences for Chunk 2B:

- duplicate reconciliation is required *before* any index work, and it is bigger
  than "prepare for scope": there are records that are invalid under today's
  intended global rule;
- creating the scoped unique index will **fail** on a collection with duplicates,
  so step 7 has a hard precondition;
- this is a pre-existing defect, not something this chunk introduced. It is
  recorded here and **not fixed**, because fixing it changes live data.

### 4.2 Payroll is the sharpest structural finding

`payrollSchema.index({ month: 1, year: 1 }, { unique: true })` means **one
payroll run per calendar month for the entire platform**. A second legal entity
could not run October at all — not "would collide", but could not exist.

Finance already assumes otherwise: `Acc_PayrollBridge.payrollExternalPost` is
unique on `{ companyId, payrollRunId }`. So the handoff HR gives Finance is
company-scoped while the run HR produces is not.

## 5. Authorisation conflicts found

**None.** The Chunk 1 authorisation contract is frozen and nothing here required
changing it. Two interactions are recorded for Chunk 2B rather than acted on:

1. `services/access/hrAuthorization.js` refuses any request that explicitly names
   `companyId` / `legalEntityId` / `establishmentId` / `factoryId`, with
   `HR_SCOPE_NOT_PROVABLE`. That refusal is correct today and must be lifted
   deliberately at step 8 of the migration, not as a side effect of adding a
   column.
2. `companyMembership.service.js`'s `SINGLE_COMPANY_DEPLOYMENT` fallback is a
   read-side convenience. Using it to stamp a scope on a write would be guessing;
   the contract forbids it (`hr-organisation-scope.md` §7).

## 6. What was not measured

- **Production.** The audit refuses `NODE_ENV=production` without an explicit
  read-only acknowledgement, and was not run there.
- **Establishment-level classification of anything.** There is no establishment
  master to classify against, so those counts are `MISSING` by construction
  rather than by measurement.
- **Attendance had 0 rows** in this database, so its `MISSING` count is not
  evidence about a populated deployment.
- **Line, team and cost centre.** Nothing represents them; there was nothing to
  count.
