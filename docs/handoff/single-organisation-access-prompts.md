# Claude Code prompts — GRAV single-organisation access simplification

Use these prompts **one at a time, in order**. Do not paste the whole file as
one implementation request. Each prompt deliberately ends at a review gate.

## Prompt 0 — GAC-0 inventory and safety net

```text
Implement only GAC-0 from docs/tasks/single-organisation-access-roadmap.md.
Read AGENTS.md, docs/decisions/single-organisation-access-control.md, the full
roadmap, docs/decisions/company-scoped-access.md, and the existing company
access baseline. Inspect both grav-cms-backend and ../grav-cms, including their
current git diffs, before doing anything. Preserve all unrelated work and do not
commit.

This chunk is inventory and characterization only. Do not change production
behaviour and do not write to any database. Produce a reviewable manifest under
docs/audits/ that maps every application to its login identities, launcher
check, frontend guard, backend guard, role authority, platform-admin bypass,
company resolver/picker, and relevant tests. Separately classify companyId and
company-context uses as: access/tenant plumbing, redundant GRAV partition key,
legal/statutory organisation fact, customer/vendor/counterparty data,
demo/test-only, or unresolved. Counts alone are not sufficient; identify the
concrete source files and deletion/migration risk.

Add only narrowly necessary characterization tests that prove current access
decisions and the dangerous legacy interactions. Run focused tests. Update
docs/handoff/latest-implementation.md with exact evidence, ambiguities, and a
precise proposed file list for GAC-1. Stop after GAC-0 and wait for review.
```

## Prompt 1 — GAC-1 canonical resolver

```text
Implement only GAC-1 from docs/tasks/single-organisation-access-roadmap.md,
using the reviewed GAC-0 audit as the boundary. Re-read AGENTS.md and
docs/decisions/single-organisation-access-control.md. Inspect both worktrees and
preserve unrelated changes. Do not commit.

Create one backend read-only app-access resolver for active identity + app slug
+ effective role + derived capabilities. Adapt the existing DepartmentRole and
Accounting authority; do not create a new competing grant collection, change
admin writes, remove old guards, or migrate data in this chunk. A platform
administrator is control-plane only and must not gain an operational role from
isAdmin. Define stable denial/outage codes. Fail closed for inactive,
ambiguous, absent and failed-look-up cases. Keep HR sensitive-field and
maker/checker rules intact.

Before code, report the exact files and interface. Add focused tests for
Employee, DeptUser, accounting-only identity, inactive account, missing/revoked
grant, duplicate-email ambiguity, administrator without app grant and database
failure. Compare representative current guards with the resolver in tests; do
not cut routes over. Update the handoff with results and stop for review.
```

## Prompt 2 — GAC-2 grant administration API

```text
Implement only GAC-2 from docs/tasks/single-organisation-access-roadmap.md.
Use the accepted GAC-1 resolver as the read authority. Inspect both worktrees,
preserve unrelated changes and do not commit.

Simplify the Access Control backend contract to person + application + role +
reason, with Viewer/Editor/Approver/Owner or revoke. Do not accept companyId,
create company membership, or write companyGrants. Keep one authoritative
write source per app; place Accounting behind an adapter rather than duplicating
its role. Add audited before/after state, idempotent retries, concurrency safety,
cache invalidation, last-active-platform-admin protection and last-active-app-
owner protection. Re-read the result through the GAC-1 resolver before replying.

Do not delete legacy company-scoped data or change app guards yet. Add route and
service tests including forged company fields, revoke during an active session,
duplicate retry and concurrent owner changes. Update the handoff and stop.
```

## Prompt 3 — GAC-3 Access Control UI

```text
Implement only GAC-3 from docs/tasks/single-organisation-access-roadmap.md in
grav-cms and any minimum contract adjustment required in grav-cms-backend.
Preserve unrelated changes and do not commit.

Build a professional people-first Access Control screen: select a person, see
their applications, and choose No access, Viewer, Editor, Approver or Owner.
Require a reason for grant/change/revoke and show success, denial and conflict
states clearly. Remove company membership and company/application matrix UI
from this flow. Keep department catalogue management separate. Show legacy
migration warnings only for genuinely unresolved rows; do not expose internal
schema vocabulary to normal admins.

Use the GAC-2 API and GAC-1 effective answer. Add UI contract tests and verify
desktop plus 375px phone layout. Do not change launcher/session or module
company pickers in this chunk. Update the handoff with screenshots or precise
browser evidence and stop.
```

## Prompt 4 — GAC-4 login and launcher

```text
Implement only GAC-4 from docs/tasks/single-organisation-access-roadmap.md.
Inspect both repositories and preserve unrelated changes. Do not commit.

Cut login verification, department/app switching, DepartmentGuard and the app
launcher to the canonical GAC-1 access answer. Tiles must exactly match active
application grants. Remove the platform-admin operational all-apps bypass while
retaining access to the Access Control management surface. Revocation or account
deactivation must affect the next verify/protected request. Do not redesign
passwords, merge identity collections, or remove compatibility identities here.

Test ordinary one-app staff, multi-app staff, app owner, accounting-only user,
platform admin with and without explicit app grants, revoke, deactivate and
lookup outage. Verify sign-in, launcher and direct URL/API behaviour in a real
browser. Do not touch module company selectors yet. Update handoff and stop.
```

## Prompt 5 — GAC-5 PPC, IE and Merchandising

```text
Implement only GAC-5 from docs/tasks/single-organisation-access-roadmap.md.
Start with a dry-run report of active/inactive PPC companyGrants and membership
dependencies. Do not write shared data without explicit approval. Preserve
unrelated work and do not commit.

Remove company selection, membership authorization and company-scoped app
roles from PPC, Industrial Engineering and Merchandising. All three operate as
GRAV Clothing. Use the canonical app-role resolver for entry and actions.
Where an existing document still requires a legal organisation reference,
resolve the canonical GRAV profile on the server; do not accept authority from
a browser companyId. Provide a reviewed migration from approved active scoped
grants to ordinary app roles. Never revive an inactive scoped tombstone through
a legacy fallback.

Preserve cross-app handoffs, approval lifecycles, record ownership and
non-disclosing missing-record behaviour. Run focused backend/frontend tests and
real-browser checks for all three apps. Update handoff and stop.
```

## Prompt 6 — GAC-6 Store, Purchase and Costing

```text
Implement only GAC-6 from docs/tasks/single-organisation-access-roadmap.md,
using the GAC-0 classification. Preserve unrelated changes and do not commit.

Remove Store/Purchase tenant middleware, membership-derived visibility,
company selectors and request-supplied company authority. Cut entry/actions to
the canonical app-role resolver. Treat GRAV Clothing as the single internal
organisation. Migrate redundant company predicates and compound indexes only
with an explicit dry run and rollback. Preserve warehouse/site/location scope,
stock custody, vendor and buyer records, sourcing approvals, costing versions,
maker/checker rules, audit history and legal document identity.

Do not make a global companyId rewrite. Test inventory movements, reservations,
purchase/service orders, goods receipt, valuation and costing source flows.
Update handoff and stop.
```

## Prompt 7 — GAC-7 Sales, Marketing, Board and Files

```text
Implement only GAC-7 from docs/tasks/single-organisation-access-roadmap.md.
Preserve unrelated changes and do not commit.

Remove internal tenant/company scoping from Sales, Marketing, Board policies and
shared file/document routes where the reviewed inventory marks it redundant.
Use canonical app roles and GRAV Clothing organisation context. Do not remove
customer, vendor, buyer or advertising-platform company/account facts. Preserve
marketing consent evidence and suppression, board approval lifecycle,
controlled-document classification, file authorization, handoff idempotency
and non-disclosing record access.

Add focused lifecycle and authorization tests, update handoff and stop.
```

## Prompt 8 — GAC-8 Accounting

```text
Implement only GAC-8 from docs/tasks/single-organisation-access-roadmap.md.
This is a high-risk accounting migration. Inspect all current accounting diffs
first, preserve unrelated changes and do not commit.

Designate exactly one canonical legal profile, GRAV CLOTHING PVT LTD. Remove the
company picker, organisation tenancy guard and browser-supplied company scope
from accounting. Keep the legal profile as issuer/configuration for GST,
invoices, vouchers, payroll, reports and exports; it must not grant access.
Before any data/index change, produce a dry-run with company values, orphan
counts, unique-index collisions, statutory/history dependencies and rollback.
Do not mutate shared data without explicit approval.

Cut accounting access to the canonical resolver while retaining its business
roles and maker/checker rules. Verify vouchers, ledgers, budgets, bank
reconciliation, GST, payroll bridges, reports, exports and immutable historical
rendering. Update handoff and stop.
```

## Prompt 9 — GAC-9 remaining apps

```text
Implement only GAC-9 from docs/tasks/single-organisation-access-roadmap.md.
Preserve unrelated changes and do not commit.

Cut HR, Production, Quality, Packaging, R&D, Project Manager, Budget, CoWork and
every remaining protected mount to the canonical app-access resolver. Remove
token-role-only and isAdmin business bypasses after equivalent tests exist.
Preserve HR self/manager scope and sensitive-field projection, payroll privacy,
quality independence, production approvals, budget department scope and all
maker/checker policies. These are professional controls, not company tenancy.

Produce a final mount/guard coverage table, run focused suites and update the
handoff. Stop before destructive cleanup.
```

## Prompt 10 — GAC-10 cleanup

```text
Implement only GAC-10 from docs/tasks/single-organisation-access-roadmap.md.
Begin by proving every old consumer has cut over. Preserve unrelated changes
and do not commit.

Remove dead company membership models/services/routes, company access panels,
company pickers, companyGrants storage/compatibility reads and obsolete tests.
Remove redundant companyId fields and indexes only by reviewed module, with dry
runs and rollback. Quarantine or delete demo organisations/data only from an
explicit dependency manifest and only after approval. Do not remove canonical
legal-profile fields or customer/vendor/counterparty company data.

Finish with repository searches proving no request-supplied tenant authority,
membership authorization, company-scoped app role or employee company picker
remains. List every remaining company/legal reference and its justified
business purpose. Run the broadest practical backend/frontend suites, update
the durable docs and handoff, then stop for final review.
```
