# Marketing permissions: one model, enforced on every request (2026-09-21)

## What was wrong

- **Roles were never read.** Access Control let an administrator give someone
  Marketing and choose Viewer, Editor, Approver or Owner, but no Marketing route
  read that role. `MarketingAuthMiddlewear` admitted any token whose `role`
  claim said `marketing`, `admin` or `ceo`.
- **Viewers could write.** A Viewer had the same powers as an Editor.
- **Revocation took up to seven days.** Removing the Marketing department or the
  role changed nothing until the person's 7-day token expired.
- **The Access Control wording was false.** It offered "Approver · edit and
  approve" and "Owner · full control", and said the app was "entirely
  read-only, so all four see the same screens". None of that was true.
- **Admin controls never appeared in production.** Three screens decided
  administrator controls from a `user` prop that production never filled, so
  image review, results refresh and advertising-account Verify/Choose/Withdraw
  appeared for nobody.
- **Two live defects on the Google lead-form webhook, found while tracing this:**
  - The guard of the routers mounted before the webhook answered Google with
    401.
  - The global JSON parser consumed the body the webhook reads raw, so the
    request would never have been answered.

  Neither was visible in tests, because each router was tested alone.

## The model

One resolver, `services/marketing/marketingAccess.js`, runs on every request
against the database. It never trusts the token's role or admin claim.

| Caller | Accepted when (all read now) |
|---|---|
| **Administrator** | A department account with `isAdmin` true in the database and a matching token version |
| **CEO** | A session signed in to the Executive Office whose account still holds it (department account, employee or pre-migration CEO login) |
| **Member** | The three identity and Marketing-role conditions below; company access follows the temporary rule in the next section |

A member must be:
1. An **employee** found by the id the token was signed for, and still active.
2. Holding the **Marketing department grant**, the same function sign-in uses.
3. Holding an **active Marketing DepartmentRole** on the address on *their own
   employee record* (not the address the token claims).

### Temporary one-company setup (2026-09-21)

Until company assignment is built for Marketing, every authenticated Marketing
caller—member, administrator and CEO—works in the single company named by the
deployment's `MARKETING_COMPANY_ID`. Individual `SpCompanyMembership` rows do
not grant or block Marketing access and cannot change which company's data is
shown. The configured ID must be a valid ID of an existing company; if missing,
invalid or deleted, Marketing refuses with 503
`MARKETING_COMPANY_NOT_CONFIGURED`. There is no fallback to the first company,
an email match or another membership. Every Marketing data query remains
company-scoped. Role, department and session checks above remain in force.

This is a temporary single-company product constraint, **not** a general
removal of company isolation. Before Marketing serves multiple companies,
replace it with an explicit company-assignment/selection flow and tests for
cross-company isolation. Do not silently broaden this rule.

| Act | Viewer | Editor | Approver | Owner | Administrator | CEO |
|---|---|---|---|---|---|---|
| read | yes | yes | yes | yes | yes | yes |
| write (create, edit, submit, withdraw, cancel, upload, ask or dismiss an explanation) | no | yes | yes | yes | yes | yes |
| decide (approve, return, reject; review an advertising image) | no | no | no | no | yes | yes |
| administer (bindings, create-in-account, reconcile, tracking, recovery run, refresh, usage, handover operations) | no | no | no | no | yes | yes |

- **Every request is classified.** `actFor(method, path)` classifies each
  request. Anything that isn't a GET is a write unless it is listed as a
  decision or a setting. A test enumerates every route on every Marketing
  router and checks that:
  - a Viewer is refused on every write;
  - an Owner is refused on every decision and setting;
  - someone with no role is refused everywhere, before any handler runs.
- **Routes keep their own checks too.** `req.user` is rebuilt from the verified
  identity, so every existing `isAdmin || role === "ceo"` check reads current
  facts. A Viewer's rebuilt role is `marketing_viewer`, so each existing
  `role === "marketing"` author check (and the per-item `viewerActions` it
  drives) says no.
- **Self-approval is unchanged.** It is refused by id, administrators included.

### Approval policy: the durable rule is kept

`docs/decisions/marketing-campaign-plan-and-deployment.md` §2: "Marketing
writes, submits and withdraws. An administrator or the CEO approves, returns
and rejects." That rule is kept and applied to every Marketing decision and
setting.

So **Approver and Owner currently write exactly as Editor does.** The Access
Control labels now say so ("same as Editor (approvals are by an administrator
or the CEO)"), and so do `/access` and the Marketing shell. A Marketing Owner is
**not** a platform administrator. Widening approval to Approver or Owner is a
product decision; it has not been made.

## Grants, role changes and revocation

- **Department without a role:** Marketing refuses the person and says why
  (`MARKETING_NO_MARKETING_ROLE`).
- **Role without the department:** refused (`MARKETING_NO_MARKETING_GRANT`).
- **Role changes** (Viewer ↔ Editor …) apply on the next request.
- **Revoking either the role or the department** refuses the *same, already
  issued* token on its next request.
- **Deactivating the employee** gives 401.
- **Demoting an administrator** refuses them at once.
- **Bumping the token version** gives 401 `MARKETING_SESSION_STALE`.
- **Not verified as an employee:** a shared department account and an old-style
  token that only says `marketing` are both refused (`MARKETING_NOT_AN_EMPLOYEE`).

`GET /api/cms/marketing/access` answers even someone the guard would refuse,
with `allowed: false` and the reason. The Marketing shell reads it once and
again when the window regains focus, shows only permitted actions, and shows a
refused person the server's sentence instead of the app.

## Existing users and records (dev database, read-only audit)

The Marketing department exists and is active. In the dev database:
- no Marketing DepartmentRole rows;
- no employee holding the Marketing grant;
- no shared Marketing department account;
- 1 active platform administrator;
- 4 campaign plans, and no content items, media, advertising images or
  handovers.

**No migration is needed here, and nobody loses access.** Production was not
examined; the same read-only audit (counts only) should be run there before
deploying.

## Narrowed

`POST /handovers/deliver-pending` was labelled an operator seam but had no
check, so any Marketing user could trigger Sales delivery. It is now
administrator/CEO-only.

## Known limits

- Department *activation* is read through sign-in's 30-second cache. Grants,
  roles and employee status are read fresh.
- A CEO employee has CEO powers in Marketing only in a session signed in to the
  Executive Office. In a Marketing session they are an ordinary member.
- All authenticated Marketing callers use the one configured company for now.
  Existing company memberships do not select the Marketing company.

## Contract

```
GET /api/cms/marketing/access
200 { success, access: { allowed:true, kind:"member"|"platform_admin"|"ceo",
        role:"viewer"|"editor"|"approver"|"owner"|null, roleLabel, name,
        can:{read,write,decide,administer}, policy:{decisions,settings,approverAndOwner},
        refusals:{write,decide,administer} } }
200 { success, access: { allowed:false, reason:"MARKETING_NO_MARKETING_ROLE"|…, message } }
401 { success:false, code:"MARKETING_SESSION_STALE"|"MARKETING_SESSION_INVALID"|…, message }
```

Refusals from any guarded route:
- `403 { code:"MARKETING_ACTION_FORBIDDEN", act, role, message }`;
- `403`, `409` or `401` with the `MARKETING_*` reason codes above.
