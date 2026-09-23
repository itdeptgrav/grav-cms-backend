# HRMS Chunk 2A — Lane A handoff

> **Date:** 8 September 2026 · Backend only (`grav-cms-backend`)
>
> **Scope:** audit, contract, pure classifier, read-only reconciliation.
> **Not** the migration, not indexes, no behaviour change.
>
> Separate from `docs/handoff/latest-implementation.md`, which concurrent lanes
> are writing to.

## What shipped

| File | What it is |
|---|---|
| `services/access/hrScopeClassifier.js` | pure classifier — no I/O, no mutation, no route |
| `scripts/audits/hrOrganisationScope.js` | read-only audit — no `--apply`, no write verb |
| `docs/decisions/hr-organisation-scope.md` | the canonical scope contract |
| `docs/audits/hr-organisation-scope-readiness.md` | what the database actually contains |
| `docs/tasks/hrms-chunk-02.md` | the ten-step Chunk 2B plan |
| `test/hr-access/hr-organisation-scope.test.js` | 27 tests — classifier |
| `test/hr-access/hr-organisation-scope-audit.test.js` | 39 tests — audit contract |

Nothing else was touched. The frozen Chunk 1 files —
`Middlewear/hrContract.js`, `services/access/hrAuthorization.js`,
`hrCapabilities.js`, `hrManagerScope.js`, the route declarations — are unchanged.

## The three findings that shape Chunk 2B

1. **HR carries no scope at all.** No file under `models/HR_Models/`, nor
   `Employee.js`, nor `models/Access/`, contains a company, legal entity,
   establishment, factory or site field. 105 employees, 14 HR departments and
   192 daily-attendance records classify as `MISSING` or
   `UNSUPPORTED_LEGACY_SHAPE`; none as `SCOPED`.

2. **The declared global uniqueness is not enforced on the live database.**
   `employees` carries `biometricId_1`, `identityId_1` and `email_1` as
   **non-unique** indexes while the schema declares `{ unique: true }`. Mongoose
   never alters an existing index's options. Duplicates exist as a result — 1
   `biometricId` group, 2 `identityId` groups. **A scoped unique index cannot be
   built until those are reconciled**, and that is a data decision with a human
   owner, not a migration step. Pre-existing; not fixed here, because fixing it
   changes live records.

3. **A payroll run is globally unique on `{month, year}`.** One run per calendar
   month for the entire platform — a second legal entity could not run October at
   all. Finance already disagrees: `Acc_PayrollBridge` is unique on
   `{companyId, payrollRunId}`.

## Decisions worth a reviewer's attention

- **Company and legal entity are one record today** (`Acc_Company` carries GSTIN,
  PAN, CIN). Keep one record; introduce `legalEntityId` as a separate reference
  that initially equals it.
- **"Factory", "establishment" and "site" are one concept**, canonically
  **Establishment** — the word the statutory registers use. None of the three is
  backed by a collection today.
- **HR reuses `services/companyContext/companyMembership.service.js`** rather
  than writing a second company resolver — with its `SINGLE_COMPANY_DEPLOYMENT`
  fallback refused for HR **writes**, because a deployment fact is not evidence
  about a record.
- **`Employee.workLocation` is not evidence.** A free-text label defaulting to
  `"GRAV Clothing"` is not a site reference.

## Needs a product answer before 2B starts

1. Who owns the Establishment master, given `Warehouse.siteId` and
   `SpCompanyMembership.siteIds` already anticipate one?
2. One legal entity today, or several from the start?
3. Promote `SpCompanyMembership` out of Store, or read it across a boundary?
4. Which establishment do the 98 `workLocation`-only employees belong to? Nothing
   in this chunk will guess.

## Authorisation

No conflict found; nothing in Chunk 1 was changed. Two interactions recorded for
2B rather than acted on: `HR_SCOPE_NOT_PROVABLE` must be lifted deliberately at
step 8, and the single-company fallback must not stamp a scope on a write.
