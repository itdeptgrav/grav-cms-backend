# HRMS Chunk 2 — organisational scope

> **Status:** 2A complete (contract + read-only audit). **2B not started and not
> approved.**
>
> **Contract:** `docs/decisions/hr-organisation-scope.md`
> **Evidence:** `docs/audits/hr-organisation-scope-readiness.md`
> **Roadmap position:** `docs/tasks/hrms-roadmap.md` Chunk 2
>
> This file is Chunk 2's own task record. It does not replace
> `docs/tasks/current-task.md`, which other lanes are using.

## Chunk 2A — done

- Audited every organisation representation in the platform (readiness doc §2).
- Decided the canonical hierarchy, ownership and failure modes (contract doc).
- Added `services/access/hrScopeClassifier.js` — pure, read-only, no mutation.
- Added `scripts/audits/hrOrganisationScope.js` — read-only, no `--apply`.
- Tests, including four reverted negative controls.

**Nothing was migrated, indexed or changed.**

## Chunk 2B — the plan, in executable order

Each step states what must be true before it starts, what evidence a dry run
must produce, how to undo it, what old readers see while it is half done, what
to watch, and what makes it stop.

---

### Step 1 — Establishment master, or an adapter

**Do:** create the `Establishment` collection (or adopt an existing site master),
each row belonging to one legal entity.
**Preconditions:** §12.1 of the contract answered — who owns the master, given
`Warehouse.siteId` and `SpCompanyMembership.siteIds` anticipate one. **Do not
create a second site master.**
**Dry run:** the list of establishments GRAV actually operates, named by a human,
with their statutory registrations. Not derived from `workLocation`.
**Rollback:** drop the empty collection; nothing references it yet.
**Compatibility:** none needed — nothing reads it.
**Observability:** row count; every row has a legal entity.
**Stop if:** the answer would be "one establishment called GRAV Clothing because
that is what `workLocation` says". That is the guess this chunk exists to avoid.

### Step 2 — Nullable scope references, no read changes

**Do:** add `companyId`, `legalEntityId`, `establishmentId` (nullable, no index,
no default) to Employee, Attendance, DailyAttendance, Payroll, PayrollItem,
LeaveApplication, Department.
**Preconditions:** step 1.
**Dry run:** schema diff; a boot with the new fields showing zero behaviour
change; `npm run verify` green.
**Rollback:** remove the fields — nothing reads or writes them.
**Compatibility:** total. Every existing query is unchanged.
**Observability:** `null` count per model equals total count.
**Stop if:** any field is added `required`, with a `default`, or with an index.

### Step 3 — Populate from deterministic evidence only

**Do:** a backfill that writes scope ONLY where the classifier says `SCOPED` or
`DERIVABLE_UNAMBIGUOUS`, stamping `scopeProvenance` alongside.
**Preconditions:** steps 1–2; a fresh audit run; §12.2 answered (one legal entity
or several).
**Dry run:** the audit's counts, per model, plus a written-out sample of what
each derivation rule would decide and why. **Counts first, writes second.**
**Rollback:** unset the fields written by this run, identified by
`scopeProvenance`.
**Compatibility:** reads still ignore scope.
**Observability:** populated vs quarantined per model; every write carries
provenance.
**Stop if:** the run would populate anything the classifier did not mark
populatable, or if a "single company exists so use it" rule appears. That is a
deployment fact, not record evidence — the contract forbids it for writes.

### Step 4 — Quarantine the rest

**Do:** record `AMBIGUOUS`, `CONFLICT`, `DANGLING_REFERENCE` and
`UNSUPPORTED_LEGACY_SHAPE` records in a data-quality queue with their evidence.
**Preconditions:** step 3.
**Dry run:** the queue, grouped by cause, with counts. Today that is **98
employees** whose only site evidence is a `workLocation` string.
**Rollback:** drop the queue; it is derived.
**Compatibility:** none needed.
**Observability:** queue depth by cause; it should only fall.
**Stop if:** anybody proposes clearing the queue by choosing a default.

### Step 5 — Dual read

**Do:** teach HR reads to filter by scope **when it is present and the caller has
a proven company**, and to behave exactly as today otherwise.
**Preconditions:** steps 3–4; HR consuming
`companyMembership.service.js` (contract §7) with the single-company fallback
refused for writes.
**Dry run:** for a sample of endpoints, the scoped and unscoped result sets, and
their difference.
**Rollback:** one flag returns every read to unscoped.
**Compatibility:** an unscoped record stays visible.
**Observability:** per endpoint — scoped hits, unscoped hits, rows suppressed.
**Stop if:** any read starts returning fewer rows to a user who should see them.

### Step 6 — Reconcile

**Do:** run old and new query paths side by side and diff them.
**Preconditions:** step 5.
**Dry run:** the diff, per endpoint, over a real window. Zero unexplained
differences is the bar.
**Rollback:** nothing to roll back; this step only reads.
**Compatibility:** unchanged.
**Observability:** difference count and cause.
**Stop if:** a difference cannot be explained.

### Step 7 — Scoped indexes, **after** duplicate cleanup

**Do:** drop the global unique indexes and create the scoped ones (contract §9).
**Preconditions — two, and the second is bigger than expected:**
1. step 6 clean;
2. **duplicates reconciled.** The live `employees` collection carries
   `biometricId_1`, `identityId_1` and `email_1` as **non-unique** indexes while
   the schema declares them unique, so duplicates exist today: 1 `biometricId`
   group and 2 `identityId` groups at the time of the audit. A unique index
   cannot be built over them. Reconciling these is a **data decision with a human
   owner**, not a migration step.
**Dry run:** build each index in the background on a copy; it must succeed.
**Rollback:** drop the new index, recreate the old one — only possible while
duplicates remain reconciled.
**Compatibility:** none; this is the irreversible-ish step.
**Observability:** build progress, rejection count, write-error rate after.
**Stop if:** any duplicate remains, or the index build fails once.

### Step 8 — Scope mandatory for new writes

**Do:** require scope on create, and lift `HR_SCOPE_NOT_PROVABLE` for the request
keys the contract now supports.
**Preconditions:** step 7; every writer updated (step 9 is partly concurrent).
**Dry run:** every HR create path exercised with and without scope.
**Rollback:** make it optional again; existing records are unaffected.
**Compatibility:** old records stay readable.
**Observability:** refusals by endpoint; a spike means a missed writer.
**Stop if:** lifting the refusal would let a request name a company the actor
cannot prove. That is the Chunk 1 rule and it does not move.

### Step 9 — Migrate the writers

**Do:** update every HR create/update path to carry scope from request context.
**Preconditions:** step 8 in staging.
**Dry run:** the route inventory with each writer's status.
**Rollback:** per writer.
**Compatibility:** a writer not yet migrated fails closed at step 8, visibly.
**Observability:** writers migrated vs total; refusal rate to zero.
**Stop if:** a writer cannot obtain scope without guessing.

### Step 10 — Retire legacy inference

**Do:** remove the unscoped read paths, the dual-read flag and
`Employee.workLocation` as a site stand-in.
**Preconditions:** steps 1–9; a parity window with zero unscoped reads observed.
**Dry run:** evidence that nothing has read the legacy path for the window.
**Rollback:** the flag, until it is deleted.
**Compatibility:** ends here, deliberately.
**Observability:** legacy-path hit count at zero.
**Stop if:** it is not zero.

---

## Not in Chunk 2

Person/Worker/Employment/WorkerAssignment records (Chunk 3), effective-dated
assignment history, attendance-model consolidation, leave ledger, payroll
calculation changes, and any change to the Chunk 1 authorisation contract.
