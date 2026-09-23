# Company access rollout — person → company → application role

**Status:** PPC implementation in the working tree; other applications still pending. The separate one-off CEO grant is in the configured development database. No migration or general data apply has run.

**Decision:** `docs/decisions/company-scoped-access.md`
**Do not replace:** `docs/tasks/current-task.md`, which belongs to the active Image Studio lane.

## Immediate incident: PPC Order Book on localhost:3001

The `TENANT_MEMBERSHIP_UNPROVEN` screen is an honest refusal, not an empty Order Book. The configured database has three company masters, seven active memberships and none for `GRAV CLOTHING PVT LTD`; therefore the single-company fallback cannot apply. The only two active PPC role rows inspected are demo accounts. Do not bypass the resolver, delete demo companies or infer a grant from an existing order.

**Safe repair:** the user named `ceo@grav.in`, `GRAV CLOTHING PVT LTD` and PPC Owner. That account's active membership and Owner role were created in one transaction and independently re-read through the production resolvers on 22 September. The signed-in browser still needs a reload for visual verification; the normal `localhost:3001` app is not the former isolated PPC preview at `127.0.0.1:3399`, which was no longer running when checked. This one-off authorised repair is not the permanent onboarding process. See `docs/audits/company-access-c0-baseline-2026-09-22.md`.

## Slices (each ends independently verifiable)

### C0 — inventory and migration manifest (first implementation task)

Read-only only. Enumerate company masters, active/disabled memberships, global department roles, app assignments and the login identities they can be proven to belong to. Produce counts and an explicit proposed `(person, company, app, role)` mapping. Name missing people, orphaned companies, ambiguous emails, duplicate identities, and demo records. No automatic cross-product of roles and memberships, no grants, no deletion. Add tests that demonstrate the present global-role leakage risk and the current fallback's behaviour when a second company or first membership appears.

**Exit:** a reviewable, dry-run migration manifest with no secrets; zero data writes; exact owners for every ambiguous assignment. An unresolved person/company mapping remains unresolved, not guessed.

### C1 — administrative company membership (coupled to a scoped app grant)

Add the server-owned grant/revoke/read contract under Access Control, backed initially by the existing membership collection through the neutral resolver. Restrict writes to verified platform access administrators; validate the target company and person; audit actor, time, before/after and reason; make retries idempotent and concurrent duplicate grants safe. Add the person's companies to the existing People panel. Do not add a second writable membership collection. Keep login credentials out of the grant payload. Until C2 is deployed, new membership writes must remain disabled: a membership can activate *every* legacy global DepartmentRole that person already holds in that company, not merely the role the administrator intended to assign.

**PPC implementation:** the new Access Control write combines membership and PPC role in one transaction. It refuses a new membership if that would activate an unrelated legacy global role. The UI offers only PPC because only PPC's API guard has cut over. It does not offer a standalone membership write. The complete cross-app impact preview and neutral person/company administration remain to do.

### C2 — company-scoped app roles and controlled migration

Implement one shared effective-access service and company-scoped role storage with database uniqueness on `(principal, companyId, departmentSlug)`. Decide and test stable-principal linkage for Employee, DeptUser and external accounts before changing role writes. Migrate legacy global `DepartmentRole` rows only via reviewed, explicit company mappings from C0. Keep old reads only as a bounded compatibility path where their company is unambiguous; no blanket global-role fallback in multi-company use. Update Access Control so an administrator makes one person/company/app/role assignment rather than three disconnected ones.

**PPC implementation:** company-scoped grants on existing `DepartmentRole` rows, transactional entries in existing `change_logs`, and a live PPC resolver are present. Atlas refused a new collection because the database is already at its 500-collection cap, so no collection was deleted to make room. The PPC resolver permits an old global PPC role only when that person has exactly one active membership and no scoped entry; a revoked scoped entry is a tombstone, so the old role cannot reappear. The Access Control screen lists one-company legacy PPC roles for explicit migration. `ceo@grav.in` has been migrated to a scoped GRAV PPC Owner entry after an exact precondition check. Other app guards still read global roles and must cut over before the platform-wide exit condition is met.

### C3 — app entry and API cutover

Move the launcher, department switch, app-specific company lists and API guards to the same effective-access result. Migrate PPC first because the incident is visible there, then Merchandising, IE, Sales and the other CMS apps in separate bounded slices. Preserve each app's business capabilities and maker/checker rules. Keep Accountant's independent login and organisation guard until a reviewed adapter exists.

**PPC implementation:** employee and department-login launcher/switch checks now derive PPC entry from the live company grant; the PPC company picker lists only PPC-authorised companies. Focused route and service tests pass. An authenticated browser check and other-app cutovers remain. **Exit per app:** launcher tile only for an effective company/app grant; one-company auto-resolution, explicit multi-company choice, useful distinct missing-membership/missing-role/outage states; forged company selection refused; cross-company id non-disclosing; focused API and browser tests green.

### C4 — data and deployment hygiene

Seed demos only into an isolated local/preview database with unmistakable environment labels. Add an environment guard to seed scripts so a production/shared Atlas URI cannot receive demo companies, users or memberships accidentally. After C0's ownership review, plan any cleanup of existing demo records separately; never delete them merely to reactivate single-company fallback. Retire that fallback only after every active operator has an explicit assignment and every relevant guard has cut over.

**Exit:** repeatable demo setup without shared-data writes; no operator relies on implicit single-company access; fallback retirement has a dry-run report and rollback plan.

## Non-negotiable tests across slices

- One person belongs to two companies but has PPC in only one; the other PPC route, tile and picker entry are absent/refused.
- A person has an app assignment without a company, and another has company membership without an app role; both receive the correct distinct explanation and neither receives data.
- Two people with the same name never share access; one person's old and new verified email do not create a second principal or accidentally inherit another's grant.
- A company id sent in a header, query or body never creates authority; it only selects an existing effective grant.
- A database lookup failure returns an outage, not `no membership` and never the single-company fallback.
- Role/membership revocation invalidates open-session access on the next protected request.
- Admin grant retries and races yield one effective grant and one auditable outcome.
- PPC, Merchandising and IE continue to own their own business actions; access unification does not merge their apps.

## Lane ownership and start gate

Access Control owns C0–C2 and the shared resolver. Each app lane owns only its C3 adapter and tests; PPC must not invent a private company-membership path. The demo/test-data lane owns C4. Do not combine this work with Image Studio or the staged PPC/PPM checkpoints in the mixed working tree.

**Next action:** finish C0's read-only cross-app identity mapping, then migrate reviewed PPC legacy grants through the new Access Control screen and cut over each other app to the company-scoped resolver. The separately authorised `ceo@grav.in` PPC Owner incident repair has already been applied and verified; do not repeat it. Its existing global Sales approver role may also be effective in GRAV, so Sales must be reviewed before adding any second company to that account. Do not treat the PPC implementation as platform-wide completion.
