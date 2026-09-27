# Decision — single-organisation access control for GRAV Clothing

**Decision date:** 25 September 2026  
**Status:** Adopted product direction; implementation not started  
**Supersedes:** `docs/decisions/company-scoped-access.md` for product direction

## Decision

GRAV CMS is an internal system for one organisation: **GRAV Clothing**. It is
not a multi-tenant product. Employees must not choose a company, receive a
company membership, or hold a different application role per company.

Access is the intersection of only three server-owned facts:

1. the person has an active login;
2. the person has an active grant for the application; and
3. the grant's role permits the requested action.

The shared application-role vocabulary remains:

| Role | Meaning |
|---|---|
| Viewer | Read the application's ordinary operational data. |
| Editor | Create and change ordinary records. |
| Approver | Editor rights plus the application's approval actions. |
| Owner | Approver rights plus application settings and access ownership. |

An application may map those four roles to a small set of server-side
capabilities when sensitive data or separation of duties requires it. HR
compensation, statutory identifiers, accounting approvals and maker/checker
rules are examples. Those controls are not tenant scoping and must not be
removed. Administrators assign a role, not a long checklist of permissions.

**Platform administrator (clarified 25 September 2026, GAC-AR1; replaces the
earlier control-plane-only rule).** A person whose *current* `DeptUser` record is
active, has `isAdmin: true` and whose session carries the record's current
`tokenVersion` is a **full-system administrator**: they may open every active
internal application with the effective role **Owner**, and they manage people,
applications and grants. This authority is read from the database on every
decision; a token's `isAdmin` claim is never sufficient on its own, and
revocation or deactivation takes effect on the next request.

Full-system administration is application entry and Owner role — it does not
switch off an application's own business controls. Approvals, maker/checker,
payroll privacy, sensitive-field projection, quality independence and
record-level ownership continue to apply exactly as they do to any Owner.

Ordinary employees receive only the applications they are explicitly granted,
with the role granted for each.

**One person, one login (GAC-AR2, 25 September 2026).** Each person has exactly
one canonical login identity, chosen by `services/access/canonicalIdentity.service.js`
and used by login, resolve, verify, switch and logout alike:

1. a `DeptUser` with the email is canonical whenever it exists, and nothing
   falls through past it — an inactive or wrong-password department login is a
   refusal, never a weaker employee, accounting-only or legacy session;
2. otherwise exactly one active `Employee`;
3. otherwise exactly one active `Acc_User` (accounting-only);
4. a legacy per-department row is credential compatibility only: it may
   verify the password of the `DeptUser` that is provably the same migrated
   identity (same `_id` and email), and it never issues a session of its own.

Two active candidates of the same kind are refused as an ambiguous identity.
Nothing reveals whether an address exists before a password has matched. Every
session names its subject and current token version. An Accounting role opens
Accounting only; it never makes anyone an administrator. The CMS session's
authority is the HttpOnly cookie; the browser's `cms_token`/`acc_token` copies
are a compatibility bridge (deletion condition: API served first-party under the
frontend's registrable domain with `COOKIE_DOMAIN` set).

`ray@grav.in` is designated the canonical full-system administrator login;
`ceo@grav.in` becomes a transitional duplicate that may be deactivated only
after the canonical login has signed in and at least one other active
administrator remains (`scripts/migrations/gac-ar2-canonical-admin.js`).

## One organisation, one legal profile

The system keeps one canonical legal/organisation profile for **GRAV CLOTHING
PVT LTD**. It supplies statutory name, address, GST details, invoice identity,
payroll identity, branding and accounting configuration. It is not a tenant,
does not appear in a company picker, and does not grant access.

During migration, existing `companyId` fields fall into three categories:

1. **Access/tenant plumbing** — membership, company grants, company selectors,
   browser headers/query parameters and tenant guards. Remove it.
2. **Redundant partition keys** — fields used only to add the same GRAV company
   predicate to every query or unique index. Migrate indexes/data, then remove
   them in a reviewed module slice.
3. **Legal business facts** — issuer/legal-entity references required for GST,
   invoices, books, payroll, historical exports or an external integration.
   Keep or replace these with the canonical organisation profile. They never
   participate in authorization.

No bulk field deletion is allowed until the inventory classifies the field and
proves its indexes, references, exports and historical meaning.

## Authoritative access answer

The backend owns one resolver with an interface equivalent to:

```text
resolveAppAccess(actor, appSlug)
  -> active identity + app role + derived capabilities
```

Every launcher tile, route guard, API guard and frontend read-only affordance
must be a projection of this answer. The browser may name the application it is
opening; it may not confer a role. Revocation takes effect on the next protected
request. Database failure is an outage, never an allow decision.

Access Control presents people first. Opening a person shows applications and
one role per application. Grant, role change and revoke require a reason and
produce an audit record. Duplicate retries are idempotent. The screen contains
no company membership or company/application matrix.

## Compatibility and migration

The repositories currently have multiple identity and authorization paths:
Employee, `DeptUser`, legacy department collections, accounting-only users,
`DepartmentRole`, per-module guards, administrator bypasses and frontend role
checks. The migration must converge them behind the shared resolver without a
flag day.

Use existing identities and role storage first; do not create another competing
permission system. Compatibility adapters may remain temporarily, but each
must have a named consumer and deletion condition. Do not alter live grants,
memberships or business records without a dry-run report and explicit approval.

The previous company-scoped PPC implementation is migration input, not the
target. Its active scoped grants must be converted deliberately to ordinary app
roles before `companyGrants[]`, membership checks and company choice are
removed. An inactive scoped tombstone must not accidentally revive a legacy
global grant.

## Professional safety properties

- Default deny for missing, inactive or ambiguous identities and grants.
- Server-side enforcement on every protected API; UI hiding is never security.
- Immediate deactivation and role-revocation effect.
- Last-active-administrator and last-application-owner protections.
- Non-disclosing 404/403 behaviour for records outside a person's application
  authority.
- Explicit audit history for grants, changes, revocations and administrator
  changes.
- No token-claim administrator bypass: administrator authority is the
  database-verified rule above, applied through the shared resolver.
- Sensitive field projection and maker/checker rules remain intact.
- Demo organisations and their data are quarantined only after a dry-run
  dependency report; they are not silently relabelled as GRAV Clothing.

## Non-goals

- Supporting subsidiaries, customers or suppliers as login tenants.
- Removing customer, vendor or buyer “company” data; those are business
  counterparties, not application tenants.
- Rewriting every identity model in the first slice.
- Removing document approvals, sensitive-data controls or audit records in the
  name of simplicity.

**Implementation sequence:**
`docs/tasks/single-organisation-access-roadmap.md`.
