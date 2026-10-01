# Company access C0 — read-only baseline

**Observed:** 22 September 2026, against the configured development MongoDB.

**Writes:** none. No account, grant, company or order record was modified.
**Purpose:** bound the migration problem before any access grant or backfill.

## Current data shape

| Company master | Active `SpCompanyMembership` rows |
|---|---:|
| GRAV CLOTHING PVT LTD | 0 |
| IE Demo Garments | 6 |
| IE Demo Textiles | 1 |

There are seven active membership rows in total. All seven carry both email and employee reference, so the email-matched counts below do not omit an employee-reference-only row. There are 40 active global `DepartmentRole` rows, keyed by department and email without company. Of those, 34 have no active membership with the same normalised email, five have one and one has two. This is **not** a proposed grant list: none of the 34 can safely be assigned to GRAV CLOTHING merely from their role, name or the existence of that company's records.

| Department | Active global roles | No email-matched company membership | One | Multiple |
|---|---:|---:|---:|---:|
| Sales | 9 | 9 | 0 | 0 |
| Store | 10 | 10 | 0 | 0 |
| Project Manager | 3 | 3 | 0 | 0 |
| HR | 3 | 3 | 0 | 0 |
| Merchandiser | 7 | 7 | 0 | 0 |
| Board | 1 | 1 | 0 | 0 |
| Industrial Engineering | 4 | 0 | 3 | 1 |
| PPC | 2 | 0 | 2 | 0 |
| Marketing | 1 | 1 | 0 | 0 |

The two active PPC roles are demo accounts, each with an IE Demo Garments membership. The normal app at `localhost:3001` points its frontend API at `localhost:5050`; it is not the former isolated PPC preview. The preview at `127.0.0.1:3399` was not running when checked. The screenshot's refusal text is produced by `resolveCompanyForActor` when the signed-in person has no active company membership and the fallback premise is false. The current browser session's identity was **not** read, so this audit does not claim which specific user received the refusal.

## Immediate consequence

Creating two demo companies and their memberships in the configured database ended the single-company fallback for *every* legacy operator. The fallback's rule explicitly requires exactly one company and no active membership rows anywhere. A retry, query parameter or PPC UI change cannot repair this. Deleting the demo companies merely to restore fallback would be unsafe: their memberships and possible dependent records have not been impact-reviewed.

## Still required for a complete migration manifest

1. Resolve the 34 role holders without email-matched membership to verified login identities and intended companies; do not infer from department or display name.
2. Review the one IE role holder with two memberships: the current global role spans both companies, whether or not that was intended.
3. Inventory app-launcher assignments and the accountant organisation/login mapping; those are separate authorities and were not joined in this baseline.
4. Identify ownership and dependencies of the IE demo companies before any cleanup proposal.
5. Obtain the affected signed-in email, target company and PPC role before any incident grant. Any grant changes shared access and requires explicit authorisation.

**Decision and rollout:** `docs/decisions/company-scoped-access.md` and `docs/tasks/company-access-rollout.md`.

## Post-baseline incident repair (separate from the read-only inventory)

After the baseline, the user identified `ceo@grav.in` and explicitly selected PPC **Owner** for `GRAV CLOTHING PVT LTD`. A single MongoDB transaction created that account's active company membership and active PPC Owner role in the configured development database. No other account, company, role, or document was changed. A subsequent read through `resolveCompanyForActor` and `getEffectiveRole` returned `MEMBERSHIP_RECORD` and `owner`. The account already held a global Sales approver row; the new company membership may make that existing role effective for GRAV too, without changing the Sales row. This consequence must be reviewed in C0 and is why C1 membership administration cannot go live before C2 company-scoped app grants. This is a named, one-off access repair, **not** the permanent Access Control workflow and not a migration of the other 34 role rows.

## PPC company-scoped migration

The first attempt to store scoped grants in a new collection was refused by Atlas because this database already uses its full 500-collection allowance. That transaction did not create the new collection or a grant. The implementation was changed to use `companyGrants[]` in the existing `department_roles` collection and audit entries in existing `change_logs`; no collection was deleted. After confirming exact company, active administrator, membership and legacy PPC Owner, `ceo@grav.in` received a scoped GRAV PPC Owner entry. The production role resolver independently returned `owner` from that scoped entry. No other person's role was migrated. The backend is supervised by nodemon and its serving process started after these code edits, but no authenticated browser walkthrough was performed in this task.
