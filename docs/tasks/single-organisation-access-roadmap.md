# Single-organisation access simplification roadmap

**Status:** Planned; no application code or data changed  
**Decision:** `docs/decisions/single-organisation-access-control.md`  
**Prompt pack:** `docs/handoff/single-organisation-access-prompts.md`

## Current repository finding

This is a migration, not a small UI correction. Company terms occur across more
than one thousand backend files and hundreds of frontend files, but many are
legitimate customer/vendor/legal-company facts. The access problem is narrower
and still substantial:

- login and session behaviour spans Employee, `DeptUser`, legacy department
  accounts and accounting-only accounts;
- app access spans department assignment, extra departments,
  `DepartmentRole`, accountant roles, PPC `companyGrants[]`, module-specific
  services and platform-admin shortcuts;
- company context spans `SpCompanyMembership`, company resolvers, request
  headers/query parameters and frontend pickers in PPC, IE, Merchandising,
  Store/Purchase, Costing and Accounting;
- the working trees already contain extensive unrelated changes, including
  active accounting and merchandising work. Every slice must preserve them.

## Target user experience

An administrator opens **Access Control → People**, selects a person, and sees
the applications they can use. For each application there is one control:
No access, Viewer, Editor, Approver or Owner. Saving requires a reason. There is
no company step. After sign-in, the launcher shows exactly those applications.
Opening an application never asks the employee to choose a company; all work is
GRAV Clothing work.

## Sequential chunks

### GAC-0 — inventory, classification and safety net

Read-only repository/database inventory. Produce a machine-readable manifest of
all access authorities and every use of company context. Classify each
`companyId`/company-context occurrence as tenant plumbing, redundant partition
key, legal business fact, counterparty data, demo/test fixture or ambiguous.
Map every app's launcher check, route guard, API guard, role source and admin
bypass. Add characterization tests only where needed to pin current behaviour.

**Exit:** reviewed manifest, baseline tests and explicit migration hazards; no
production behaviour or data changes.

### GAC-1 — canonical app-access resolver

Implement one backend read path for active identity + application grant + role.
Initially adapt existing sources (`DepartmentRole` and the accounting role
source) without changing writes. Define stable denial codes and role-to-
capability mapping. Remove no old guard yet. Compare shared-resolver decisions
with current guards in tests.

**Exit:** shared resolver is tested for Employee, `DeptUser`, accounting-only
identity, deactivation, revoke, lookup failure and duplicate-email ambiguity.

### GAC-2 — simple grant administration API

Make the shared Access Control write contract person + application + role +
reason. Keep one authoritative write per application; adapt Accounting behind
the service until its storage can converge. Add audit, idempotency, race safety,
last-admin and last-owner protections. Stop creating company memberships or
company-scoped grants. Do not remove old data yet.

**Exit:** grant/change/revoke round trips re-read correctly through GAC-1 and
invalidate active authorization caches.

### GAC-3 — simple Access Control screen

Replace company matrices, membership controls and scattered role controls with
the people-first application-role screen. Show effective source and migration
warning only for unresolved legacy rows. Keep department catalogue management
separate from person access. Verify desktop and phone layouts.

**Exit:** an administrator can perform the complete grant/change/revoke flow
without seeing or choosing a company.

### GAC-4 — login, launcher and session cutover

Make login/verify/switch and the launcher use GAC-1. Remove the administrator
“all applications” operational bypass. Keep the admin management link based on
the control-plane grant. Ensure a revoked app disappears and its API rejects on
the next request. Do not redesign credentials or merge identities in this
chunk.

**Exit:** tile, navigation and API answers agree for ordinary staff, multi-app
staff, application owners, accounting-only users and platform administrators.

### GAC-5 — remove company choice from PPC, IE and Merchandising

These modules contain the clearest employee-facing company-context UI. Remove
company discovery/pickers and membership/`companyGrants[]` authorization.
Resolve the canonical GRAV legal profile internally only where a retained model
still needs it. Convert approved active scoped grants to ordinary app roles via
a dry-run/apply migration; inactive tombstones remain denied unless explicitly
reviewed.

**Exit:** all three apps open directly as GRAV Clothing; cross-app handoffs and
existing approval rules still work.

### GAC-6 — remove company scoping from Store, Purchase and Costing

Retire store/purchase tenant middleware, membership-derived visibility and
company selectors. Migrate redundant compound indexes carefully. Preserve
warehouse/site/location boundaries, vendor ownership, costing version history
and business approvals; those are operational controls, not tenant scoping.

**Exit:** focused inventory, sourcing, receipt, valuation and costing tests pass
without a browser-supplied company context.

### GAC-7 — remove company scoping from Sales, Marketing, Board and shared files

Remove tenant predicates and company context from internal records and APIs
where the GAC-0 manifest marks them redundant. Preserve customer/vendor company
records, consent purpose/evidence, advertising account bindings, controlled
document classification and non-disclosing access rules.

**Exit:** lead-to-order, campaign-to-lead, board policy and file flows work as
one GRAV organisation.

### GAC-8 — Accounting single-organisation cutover

Accounting is a dedicated slice because company references participate in
statutory reports, vouchers, indexes, exports and an independent session. Remove
the company picker and organisation tenancy guard, designate exactly one legal
profile as GRAV Clothing, and migrate redundant scope keys/indexes only after a
dry run. Preserve issuer identity and immutable historical document output.

**Exit:** every accounting page and export uses the canonical legal profile
without user selection; no cross-company endpoint or selector remains.

### GAC-9 — remaining apps and authorization consistency

Cut HR, Production, Quality, Packaging, R&D, Project Manager, Budget, CoWork and
remaining shared routes to GAC-1. Preserve HR field-level privacy, manager/self
scope, payroll controls, quality independence and maker/checker policies. Remove
copy-pasted role literals only after equivalent tests exist.

**Exit:** every protected mount has a declared app and role/capability contract;
no business route relies on `isAdmin` or a token role alone.

### GAC-10 — destructive cleanup and data hygiene

Only after all consumers have cut over: remove company membership models,
company-access admin routes, scoped-grant fields, company-choice components,
compatibility adapters and dead tests. Quarantine or delete demo organisations
only from an approved dry-run manifest with dependency counts and rollback.
Remove redundant `companyId` fields and indexes module by module, never through
an unreviewed global rewrite.

**Exit:** repository search finds no tenant membership, company grant, company
picker or request-supplied tenant authorization path. Remaining company/legal
references are listed and justified as business facts.

## Rules for every chunk

- Work on exactly one chunk and stop for review.
- Inspect both repositories and current diffs before editing; preserve unrelated
  changes and do not commit unless asked.
- State a precise file-level plan before code.
- No production/shared database write without a dry run and explicit approval.
- Add focused backend and frontend tests, then report exact commands/results.
- Update `docs/handoff/latest-implementation.md` with actual changes, evidence,
  known risks and the next unopened chunk.
- Do not weaken authentication, sensitive-field filtering, approvals, audit or
  segregation of duties to remove company scoping.
