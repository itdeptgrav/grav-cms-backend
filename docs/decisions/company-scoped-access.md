# Decision — company-scoped application access

**Decision date:** 22 September 2026

**Status:** Adopted product direction; PPC implementation in the working tree, other apps pending
**Scope:** CMS employee and department applications. Accountant's separate login remains an explicit adapter until its identity contract is reconciled.

## Decision

Access to company data is the intersection of three server-owned facts:

1. an active person/login identity;
2. an active membership in the company being acted in; and
3. an active role for that **company and application**.

The administrator's process is one assignment: choose a person, company, application and role, with optional site restriction when an authoritative site master exists. The server must save and revoke the resulting access coherently, record who made the decision, and show the effective result in Access Control. Department assignment alone may expose an application entry only when that entry can actually be used; it is not authority to read company data.

A role for PPC in Company A does not authorize PPC in Company B, even if the person belongs to B for another purpose. Platform administration grants control-plane access to manage assignments, not an implicit operational role in every company's Sales, Merchandising, PPC or other department records. No company may be inferred from the record being opened, a browser-supplied id, the first company returned by a query, or an administrator flag.

For a person with one authorised company in an application, that company resolves automatically. With more than one, the person must select one of those authorised company/application pairs. An absent membership, absent role, revoked grant and temporary lookup failure are distinct responses. Failed lookup never becomes an empty membership or a single-company fallback.

## Evidence and current limitation

- `models/CMS_Models/StorePurchase/SpCompanyMembership.js` stores company membership, but has Store naming and no Access Control administration route. `services/companyContext/companyMembership.service.js` is already the domain-neutral read seam and is the compatibility entry point.
- `models/Access/DepartmentRole.js` is unique on `(departmentSlug, email)` and has no company id. `services/departmentRoles.js` therefore answers a global role question. Combining that role with an unrelated company membership would give the role in every company the person belongs to.
- `routes/Admin/accessAdmin.js` and the frontend Access Control people screen administer department roles and app assignment, but not company membership as part of the same decision.
- The fallback in `companyMembership.service.js` requires exactly one company **and** no active membership for anyone. Demo companies or the first explicit membership end that fallback globally. It is a migration bridge, not an onboarding process.
- In the configured development database on 22 September, three company masters exist. `GRAV CLOTHING PVT LTD` has zero active membership rows; the other two are IE demo companies. PPC has two demo role holders, each with an IE demo company membership. No shared data was changed during this inspection.

## Migration and compatibility

Keep one effective-access resolver and one authoritative set of grant records. Do not maintain two independent, writable answers that can drift. The existing `SpCompanyMembership` collection may be read through a neutral model/adapter during migration; renaming its collection or bulk-moving records is **not** a prerequisite to the admin workflow. Its active rows must be inventoried, deduplicated and reconciled before any cutover.

Introduce company-scoped application grants behind the shared role service. The configured development Atlas database has reached its 500-collection limit; attempting to create a separate grant collection was refused before any record was written. The PPC implementation therefore stores `companyGrants[]` on the existing `DepartmentRole` row and records each change in the existing `change_logs` collection. A company-master revision write serialises owner decisions so two concurrent transactions cannot both create an owner. This avoids deleting unrelated collections merely to make room. A stable principal reference remains the target for later identity reconciliation; normalised email and employee reference are migration lookup keys, not a license to combine two people by display name. Existing global grants must be mapped to **explicitly approved** companies; never expand one legacy role to every company in a person's memberships.

During rollout, old routes keep their current contracts while each application's guard and launcher are moved to the shared company-scoped answer. Do not silently grant legacy access in a multi-company deployment. The accountant login/organisation model remains distinct until a reviewed adapter can prove the same company identity; do not merge token types or bypass its current tenancy guard to make the UI uniform.

Once every active operator has an explicit, verified assignment and all app guards use it, retire the single-company fallback. Until then its existing narrow condition remains unchanged. Do not delete demo companies or memberships to revive it; demo data belongs in an isolated database, and any cleanup of existing shared records needs a separate impact review.

## Operational contract

- Access Control lists each person's effective company/application/role assignments and why a requested app is unavailable. It can grant, change and revoke with an audit record; a retry of the same administrative command is idempotent.
- The launcher and app-specific company picker are projections of the same effective grants used by API guards. An app tile must not lead to a predictable 403 because one of the required grants is absent.
- The server validates the chosen company against that person's grants on every request. The browser never confers authority by sending `companyId`.
- Revocation takes effect on the next protected request, including open sessions. No stale token claim or frontend cache preserves a revoked company/application grant.
- Cross-company and nonexistent record ids remain non-disclosing. Missing membership/role is actionable to the signed-in person but must not list foreign companies or records.
- Tests cover two companies, two people with identical names, multiple emails for one verified person, a role in only one company, role revocation, membership revocation, multi-company selection, parallel grant attempts, and a failed membership lookup.

## Boundaries

Company membership answers *whose records*; the company/application role answers *what this person may do*. A future site restriction answers *where within that company*, but may not be inferred from a free-text factory or an unverified id. Business approvals, maker/checker rules and document ownership remain in their respective apps. This decision neither merges PPC into Merchandising nor grants a platform administrator operational authority by default.

**Implementation sequence:** `docs/tasks/company-access-rollout.md`.
**Prior decisions retained:** `docs/decisions/central-costing-company-context-and-visibility.md` and `docs/decisions/store-purchase-tenancy-permissions.md`; this decision supersedes their use of global department roles as the long-term answer, not their fail-closed company-resolution rules.
