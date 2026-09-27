# GAC-0 — single-organisation access: inventory, classification and safety net

**Observed:** 25 September 2026, from source in `grav-cms-backend` and `../grav-cms` (both worktrees with
uncommitted work, left untouched).
**Writes:** none to any database; the one database read was read-only (§2A). No production code
changed. Added: two characterization test files, this audit and the manifest.
**Revisions:**
- backend `grav-cms-backend` HEAD `8a5a2ffa`, with 27 tracked files modified and many untracked files
  unrelated to GAC-0;
- frontend `grav-cms` HEAD `5bb251a0`, with 142 status entries.

Line numbers refer to those working trees.
**Decision:** `docs/decisions/single-organisation-access-control.md`.
**Roadmap:** `docs/tasks/single-organisation-access-roadmap.md` (this is chunk GAC-0 only).
**Manifest:** `docs/audits/single-organisation-access-gac0-manifest.json`: one entry per concrete item,
plus per-application records. Its totals are cross-checked against §7.1.

### How to read this: evidence labels

Each finding carries one of these labels, either on the finding itself or on the table that holds it.

| Label | Meaning |
|---|---|
| **[V]** directly verified | The cited lines were read line by line during GAC-0. |
| **[T]** characterization test | Pinned by a passing test in `test/access/gac0-*.test.js` (ids in §9.2). |
| **[S]** source-reading inventory | Reported by a read-only sweep of the source with `file:line`, not re-read or executed in GAC-0. Re-read it before a later chunk acts on it. **This is the default for every table row not otherwise labelled** (§3 per-app map, §4 counts, §7 classifications). |
| **[B]** older baseline | 22 September C0 counts (`docs/audits/company-access-c0-baseline-2026-09-22.md`). History only, not current fact. |
| **[D]** fresh database observation | Read-only query of the configured development database on 25 September 2026 (§2A). |
| **[U]** unresolved | Needs a decision or further evidence (§7.6, §12). |

Classification codes: **1** access/tenant plumbing to remove · **2** redundant GRAV partition key ·
**3** legal/statutory organisation fact to retain · **4** counterparty data to retain · **5** demo/test
only · **6** unresolved, needs review.

---

## 1. Headline findings

1. **Several independent access answers exist, and they disagree.** Access is decided by:
   - launcher tiles, from `AccessDepartment` assignment;
   - the JWT `role`/`isAdmin` claims, trusted by `EmployeeAuthMiddlewear` (133 route files),
     `SalesAuthMiddlewear`, every CEO `ceoAuth` and `pmAuth`;
   - `DepartmentRole` through `requireDepartmentRole` / `getEffectiveRole`;
   - PPC `companyGrants[]` through `roleForCompany`;
   - accounting `Acc_User` through `orgAuth`;
   - database-verified `DeptUser.isAdmin` in `requirePlatformAdmin`, HR, Store/Costing and Marketing;
   - route-local "migration" guards that trust the token's `deptSlug`.

   None of these is a projection of another.
2. **Platform administrator is an operational bypass almost everywhere.** [S] 67 operational `isAdmin`
   sites were found; only 21 re-read the database. [T] The token claim bypasses the shared role guard
   (A1, E3). [T] Merchandising, PPC and Board refuse admins while the launcher shows them every tile
   (D1, for PPC).
3. **Company context is a real tenant layer in about 10 modules.** [S] The model inventory lists 204
   model×field rows, 158 of them redundant GRAV partition keys; the manifest's own totals are in §7.1.
   [S] About 15 "exactly one `Acc_Company`" checks and 7 company pickers. [T] The single-company fallback
   switches off for everyone as soon as one membership row exists (C4).
4. **PPC is the only module on company-scoped grants.** [V] Its roles live only in
   `DepartmentRole.companyGrants[]`. [T] A PPC grant creates a `SpCompanyMembership` that every other
   domain reads, and revoking the grant leaves that membership behind (C2, C3). [D] The live
   development data holds 2 PPC tombstones, both on rows whose legacy role is still active, so the
   `getRole("ppc")` / `roleForCompany` divergence (C1) exists in real data today.
5. **Out-of-scope but live security defects** were found while mapping guards (§11). The most severe:
   - [T] a token signed with a hard-coded legacy secret still verifies (A3);
   - [V] `/cowork/setup/seed-ceo` and [V] `/api/google` have no authentication.

   These should not wait for GAC-4.
6. **[D] The configured development database has no `employees` collection.** It holds 7 `dept_users`,
   7 `acc_users` and 65 `DepartmentRole` rows. 35 active role rows match no identity in the collections
   that do exist. Identity-based migration planning cannot rely on this database until the employee
   source is established (§2A, §12).

---

## 2. Identity sources (who can hold a session)

| # | Path | Store | Token / cookie | Re-read on each request? | Notes |
|---|---|---|---|---|---|
| I1 | `POST /api/auth/login`, DeptUser (`routes/auth/deptAuth.js:398-795`) | `dept_users` | JWT (`config/jwt.js` SECRET), `auth_token`, 7d; claims `v,id,role,userType,deptId,deptSlug,employeeId,name,email,isAdmin,tv` | `tv` is checked **only** at `/verify` (`deptAuth.js:1010`), in `requirePlatformAdmin` and in Marketing | [T] The DeptUser branch of `/switch-department` skips `tv` (E4) |
| I2 | same, Employee subject | `employees` | same, `subject:"employee"`, `isAdmin:false`, `tv:0` | active status only at `/verify` / switch | Phone number and `Firstname@MMDDYYYY` are always accepted as passwords (`utils/employeePassword.js:63-84`) |
| I3 | same, accounting-only subject | `Acc_User` | same + `accountant_token` | `tv` at `/verify` (`deptAuth.js:858-876`) | Separate identity; see §3 Accounting |
| I4 | same, legacy department subject | 12 legacy department collections | same, `subject:"legacy_department"` | legacy `isActive` only | A deactivated/reset DeptUser can still sign in through the legacy fallback (`deptAuth.js:445-449 → 731-790`) |
| I5 | Face sign-in `routes/auth/faceSignin.js:57-99` | `employees` by biometricId | employee JWT | — | No `isActive` check when the token is issued |
| I6 | `POST /api/auth/switch-department` (`deptAuth.js:1218-1320`) | as I1/I2 | re-minted JWT | Employee branch re-reads; **[T] DeptUser branch skips `tv`** (E4) | An admin adopts the target department's legacy role (`:1292-1300`) |
| I7 | Accounting `routes/Accountant_Routes/Acc_auth.js` login / `sync-legacy` | `Acc_User` / `Acc_Organization` | `accountant_token`, 24h `{id,organizationId,role,tokenVersion}` | **yes**, `orgAuth` (`AccountantOrgAuthMiddleware.js:298-359`) | `sync-legacy` can auto-create an **owner** `Acc_User` from a legacy `Acc_Department` row (`Acc_auth.js:757-762`) |
| I8 | Mobile app `routes/Employee_Routes/login.js` | `employees` by phone | `employee_token`, 7d/30d | intern check only (`AllEmployeeAppMiddleware.js`) | The phone number works as a password and overwrites the real hash (`:143-151`) |
| I9 | CoWork, Firebase (`Middlewear/coworkAuth.js`) | Firebase + `cowork_employees` | Firebase ID token | 5-minute in-process cache | Roles `ceo`/`tl`/`employee`; separate authority, out of GAC scope except where CMS SSO bridges (`deptAuth.js:1513`) |
| I10 | Customer portal `routes/Customer_Routes/auth.js` | `customers` | JWT, **same secret, no audience claim** | no | `/signin` issues a token from a phone number alone (`:390-409`). Non-employee. |
| I11 | Vendor portal | `vendors` | JWT, same secret | no | Non-employee |
| I12 | Barcode devices `server.js:2681` | — | **none** | — | Unauthenticated (§11) |

`routes/login.js` is dead code; `deptAuth.js` shadows it entirely.

Frontend side (`../grav-cms`):
- `/login` (`app/login/page.js:324-340`) stores `acc_token` and `cms_token` in localStorage and a
  non-HttpOnly `auth_token` cookie (`lib/session.js`).
- Every role the client reads comes from `POST /api/auth/verify` (`deptRole`, `isAdmin`, `deptSlug`,
  `departments`), cached as `grav_dept_role`.
- `/accountant/login` and `/accept-invite` use `components/accountant/AuthProvider.js`.
- CoWork has its own Firebase login.
- There is no customer or vendor login in this frontend.

---

## 2A. Fresh database observations [D]

**How it was read.** A read-only script, kept in the session scratchpad and **not** committed, ran
against the configured development database on 25 September 2026 at 06:45 UTC.
- Connection: `MONGODB_URI` from `.env`, database `test` (409 collections).
- Operations: only `listCollections`, `find` with projections and `aggregate` (no `$out`/`$merge`).
- Output: counts and company ids and names only. No emails, personal names, tokens or connection
  strings were printed or recorded.
- Nothing was written, repaired, migrated or normalised.

The earlier figures in `company-access-c0-baseline-2026-09-22.md` are **[B]**; where they differ,
the figures below supersede them.

| Question | Observation (25 Sep) | vs 22 Sep baseline [B] |
|---|---|---|
| Company / legal-profile rows (`acc_companies`) | **3**: `6a08040a1fecacc9bb7149c2` "GRAV CLOTHING PVT LTD" (`isPrimary`, has GSTIN); `6ab1459d11fca003ca6f6062` "IE Demo Garments"; `6ab1459f11fca003ca6f60ab` "IE Demo Textiles" (both non-primary, no GSTIN, created 21 Sep) | same 3 |
| Accounting organisations | **1** active `acc_organizations` row, owning **all 3** companies (`tallyCompanyIds`), including both demo companies | not recorded |
| `SpCompanyMembership` rows | **12** total: **10** active, **2** inactive. By company: GRAV 3 active; IE Demo Garments 6 active + 1 inactive; IE Demo Textiles 1 active + 1 inactive | 7 active (GRAV 0) |
| Global `DepartmentRole` rows | **65**: **64** active, 1 inactive (hr); 19 slugs; 0 duplicate (slug, email) pairs | 40 active, 9 slugs |
| Active roles by the holder's number of active memberships | none **36**, one **26**, more than one **2** | 34 / 5 / 1 |
| `companyGrants[]` entries | **5** on 2 PPC rows: **3** active (GRAV: approver 1, owner 1; IE Demo Garments: approver 1) and **2** inactive | — |
| PPC tombstones | **2** (IE Demo Garments 1, IE Demo Textiles 1). **Both sit on rows whose legacy global role is active**, so `getRole("ppc")` still answers the legacy role for those people (§5 C8, test C1). | — |
| PPC placeholder rows (`role:viewer`, inactive, with grants) | 0 | — |
| Identity collections | **`employees` collection absent** (0 documents); `dept_users` 7 (7 active, **1 active admin**); `acc_users` 7 (7 active: owner 1, approver 4, editor 1, viewer 1); 16 legacy `…departments` / `accountant_users` collections holding 3 rows with an email | — |
| Active roles with no matching identity | **35 of 64** have no email match in any identity collection that exists. By slug: store 11, sales 9, merchandiser 7, project-manager 3, hr 2, qc 2, board 1. Because `employees` is absent, this **overstates** true orphans; it cannot be resolved from this database. | — |
| Duplicate or ambiguous normalised emails | 0 inside `dept_users`, inside `acc_users` and inside `employees` (empty). Duplicates *across* employees and department logins could not be assessed without `employees`. | — |
| Accounting users in more than one organisation | **0** (only one organisation exists) | — |
| Demo-company dependencies | References to the two demo company ids in **16 collections**: `sp_company_memberships` (9), `department_roles` (2 rows via `companyGrants`), `acc_organizations` (1), `enquiries` (Garments 3, Textiles 1), `salesjourneys` (Garments 3, Textiles 1), `ie_method_studies` 17, `ie_operations` 7, `ie_style_files` 3, and one row each in `ie_allowance_policies`, `ie_bulletin_versions`, `ie_capacity_standards`, `ie_command_ledger`, `ie_demo_manifest`, `ie_line_layouts`, `ie_ramp_profiles`, `ie_releases`. The scan checked `companyId`, `companyIds`, `tallyCompanyIds` and `companyGrants.companyId` in every collection; none timed out or failed. Other field names that might hold a company id were **not** scanned [U]. | — |

> **Two different counts; do not conflate them.** **35** is active `DepartmentRole` rows whose email matches no identity in any identity collection that exists (by slug 11 + 9 + 7 + 3 + 2 + 2 + 1). **36** is active global roles whose holder has **no active company membership** (row above). An earlier revision of this audit and of the handoff wrote 36 for the identity count; corrected in SEC-0 against the manifest's `databaseInventory.departmentRoles.activeRolesWithNoMatchingIdentity.total` (35).


**Consequences for planning:**
- Two companies besides GRAV exist, so every sole-company check (§7.3) is false today.
- Because memberships exist, the single-company fallback is off for everyone.
- The one accounting organisation owns the demo companies, so the accounting company picker lists
  them.
- Deleting the demo companies needs the dependency list above, **including sales enquiries and
  journeys**.

**Unresolved [U]:**
- Why the configured database has no `employees` collection. It may be a different database, a
  renamed collection or an environment mismatch; the server's `employees` model is unchanged.
- Whether the 35 unmatched roles belong to real employees. Establish the employee source before any
  identity-keyed migration.

---

## 3. Per-application access map

Common patterns in the table, spelled out once:
- **Launcher (employee):** `resolveEmployeeDepartments` (`deptAuth.js:85-117`) builds tiles from
  `accessDepartmentId` + `additionalDepartmentIds`, falls back to free-text `Employee.department`, and
  adds a PPC tile when there is a company grant.
- **Launcher (DeptUser):** `deptAuth.js:1074-1082` shows the user's own department (+ PPC), or
  **every active department when `isAdmin`**.
- **Frontend guard:** the cookie-existence check in `middleware.js:30-98`, plus `DepartmentGuard`
  (`components/access/DepartmentGuard.js:149`), which lets `isAdmin` into every slug.
- **Token-only:** `EmployeeAuthMiddlewear` accepts the token without reading the database ([T]
  E2).

| App | Launcher | Frontend guard | Backend / API guard | Role authority | Admin bypass | Company resolver / picker | DB failure | Existing tests |
|---|---|---|---|---|---|---|---|---|
| **Sales** | dept `sales` | cookie + DeptGuard(`sales`); `RoleGate`/`RequireRole` (`components/Sales_DashboardLayout.js:337`) | reads: `SalesAuthMiddlewear` token-role allowlist `sales,admin,ceo,project_manager,merchandiser` (`:39,77`); writes: `departmentWrites("sales")` → `requireDepartmentRole` + `requireApproval` (`server.js:1339`) | `DepartmentRole(sales)`; `services/salesAccess.js:25-55` | token `isAdmin`/role `admin,ceo` (`salesAccess.js:36,55`; `departmentRoles.js:385`) | `salesScope.service` → `resolveCompanyForActor`; header `X-Costing-Company` on dev-requests | role guard 500; SalesAuth has no DB step | `test/sales/*` (e.g. `sales-prepare-authorisation.test.js:237` admin admitted) |
| **Marketing** | dept `marketing`; CEO admitted (`lib/marketing/marketingAccess.js:163-173`) | DeptGuard + `guardAdmits`; `MarketingAccessProvider` | `MarketingAuthMiddlewear` (DB + `tv`) | `services/marketing/marketingAccess.js` (DeptUser, CEO dept, `DepartmentRole(marketing)`) | DB `DeptUser.isAdmin` → `platform_admin` (`:119-127`) | `resolveCompanyForActor` **and** env `MARKETING_COMPANY_ID` (two answers) | fail-closed 503 | `test/marketing/*` |
| **Merchandising** | dept `merchandiser` | DeptGuard(`merchandiser`); `MerchandisingAccessRequired` | `EmployeeAuthMiddlewear` + `merchandisingCompanyMiddleware` + capability table (`services/merchandising/access.service.js:179-262`) | `getEffectiveRole("merchandiser")` (global) | **none**, refused (frontend guard still admits) | `listMembershipCompanies`; `GET /api/cms/merchandising/companies` (`executionRoute.js:84`); header + `?company=` | `sendError`, fail-closed | `test/merchandising/*` (`m7-change-control:1227` admin refused) |
| **PPC** | dept `ppc`, **or** any active company grant (`deptAuth.js:107-115`) | DeptGuard(`ppc`); role from `useDeptRole` ladder (`app/ppc/order-book/page.js:86-92`) | `EmployeeAuthMiddlewear` + `ppcCapability` (`services/ppc/access.service.js:145-201`) | `DepartmentRole.companyGrants[]` via `roleForCompany` (`companyAccess.service.js:31-49`) | **none**; the launcher still shows admins the tile ([T] D1) | `authorizedPpcCompanies`; `GET /api/cms/ppc/companies` (`ieReleasesRoute.js:108`); header | fail-closed 500 (`roleForCompany` propagates, [T] G3) | `test/ppc/ppc-app-entry.test.js`, `test/access/company-access*.test.js`, `test/industrial-engineering/ppc-companies.route.test.js` |
| **Industrial Engineering** | dept `ie` | DeptGuard(`ie`); **not** in `middleware.js` | `EmployeeAuthMiddlewear` + `req.ie` from `X-Costing-Company` (`ieRoutes.js:71-117`) | `getEffectiveRole("ie")` (global) | **token `isAdmin` → owner** (`ieRoutes.js:136`) | `listMembershipCompanies`; `GET /api/cms/ie/companies` (`:215`) | `sendError` | `test/industrial-engineering/ie-read.route.test.js` (`:206` admin by claim; `:269` global role in both companies) |
| **Store & Purchase / Inventory** | dept `store` | DeptGuard(`store`); `useStorePurchaseContext` | `EmployeeAuthMiddlewear` + `requireTenant` (`Middlewear/storePurchaseTenant.js`) + capabilities (`services/storePurchase/capabilities.js:120-174`) | `DepartmentRole(store, ceo)` global rows | DB `DeptUser.isAdmin` → ADMIN_SET (`:131`) | `resolveCompanyForActor`; header `X-Store-Purchase-Company`; `GET /api/cms/store-purchase/context` | tenant: `sendError` (503); capabilities `.catch(()=>null/[])` → **reported as 403** | `test/store-purchase/tenancy-infrastructure.test.js`, `mrf-tenancy.route.test.js` |
| **Store (legacy `/api/cms/store/*`)** | dept `store` | as above | `EmployeeAuthMiddlewear` only; **no role check** (e.g. `storeRoutes.js:368` approve work order) | none | n/a | none | n/a | none |
| **Costing** | no portal tile; `useMyApps.js` switcher adds one | `DepartmentGuard` without a slug (any session); not in `middleware.js` | `EmployeeAuthMiddlewear` + `requireCostingContext` + capabilities (`services/centralCosting/capabilities.js:246-277`) | `DepartmentRole(sales, ceo)`; **CEO viewer → full ADMIN_SET** (`:151-156`) | DB `DeptUser.isAdmin` (`:176`) | `resolveCompanyForActor`; `X-Costing-Company` | context `sendError`; capabilities silent 403 | `test/costing/*` (`costing-hardening:235-290` 503 on lookup failure) |
| **Accounting** | dept `accountant` | cookie + DeptGuard softFail + `AccountantAuthProvider`; page `isViewer`/role literals incl. non-existent `admin`/`accountant` | `orgAuth` (`AccountantOrgAuthMiddleware.js:563-591`) + `makeAuth` capability façade | **`Acc_User.role`** (owner/approver/editor/viewer), org-wide; `getRole("accountant")` reads `Acc_User` ([T] F1) | none in `orgAuth`; dev `ACCOUNTANT_AUTH_BYPASS=true` has no production guard (`:93`) | `companyId` in path/query/body on ~139 endpoints, checked against `Acc_Organization.tallyCompanyIds` (`:736-860`); picker `GET /api/accountant/tally/companies` (`Acc_companies.js:719`); frontend `CompanyProvider` + localStorage `grav.activeCompanyId` | fail-closed 500 (`:430-439`) | `accounting-auth-inventory`, `legacy-auth-bootstrap`, `legacy-route-auth-facade`, `company-isolation`, `company-list-*` |
| **Budget** | no portal tile / switcher | `DepartmentGuard` without a slug; not in `middleware.js` | `routes/Access/budgetProposals.js` (own verifier, accepts the legacy secrets) + accounting routes | `DepartmentRole(budget).budgetDepartments[]` resolved per company | per inventory: DB | `x-company-id` / `?companyId`; `GET /api/budget-proposals/context` (`:314`) | per route | `test/accountant/budget-*` |
| **HR** | dept `hr` | DeptGuard(`hr`); `filterHrNav` | `hrContract()` (DB actor, 30s cache) **then** `hrWrites = departmentWrites("hr")` (token `isAdmin`) (`server.js:1161-1187`) | `services/access/hrAuthorization.js:521-718` (`DepartmentRole(hr)`, AccessDepartment, proven legacy claim) | DB in hrContract (`:563`); **token** in hrWrites | none (HR has no `companyId`) | hrContract 503; identity lookups swallowed, cached 30s | `test/hr-access/*` (~10 files) |
| **Production / Project Manager** | dept `project-manager`, `production-supervisor` | DeptGuard per slug | mostly `EmployeeAuthMiddlewear` only; `pmWrites` on 3 mounts; `pmAuth` token-role `project_manager,ceo,admin` (`productionSettingsRoutes.js:31`) | `DepartmentRole(project-manager)` | token `isAdmin` in style-route `:73`, MO `:62`, WO `:60`, returns `:66`, productionTargetAccess `:76` | `productionStyleRoute.js:27-53` (`req.production`) | role guard 500 | `test/project-manager/*` (`pm-access-boundary:682` admin refused) |
| **Cutting / Embroidery / Production targets** | dept `cutting-master`, `embroidery` | DeptGuard per slug | route-local `cuttingAccess.js:59-87`, `embroideryAccess.js`, `productionTargetAccess.js`; **Embroidery has no authenticator of its own** (relies on the `server.js:1483` `/api/cms` floor) | `getEffectiveRole(slug)`, or **the token's `deptSlug`/`role` when the slug has no rows** | token `isAdmin` | `cuttingCompany`, `embroideryCompany` → membership | 500 | `test/manufacturing/*` |
| **Quality (QC)** | dept `qc` | DeptGuard(`qc`) | **no router auth**; `/api/cms` floor only; `qcTeam` has its own `qcAuth` (legacy secrets) | `getRole("qc")`, cached 60s (`services/qcViewer.js`) | token `isAdmin` sees everyone (`:223`) | none | configured-check catch → restrictive | `test/production/*qc*` |
| **Packaging & Dispatch** | dept `packaging-dispatch` | DeptGuard | `packagingAccess.js` | department grant, or migration-state session slug | token `isAdmin` (`:117,145,183`) | `packagingCompany` → membership | `effectiveRole` → null (deny) | — |
| **R&D (sample styles)** | no slug | `DepartmentGuard` without a slug; not in `middleware.js` | `SalesAuth.withRoles(RND_ROLES)` (`sampleStyles.js:103`) | **token role allowlist** | via salesAccess | salesScope | n/a | — |
| **Board** | dept `board`; tile removed unless `/api/cms/board/policies/access` answers | DeptGuard(`board`) admits admin | `EmployeeAuthMiddlewear` + `requireBoardReady` | **AccessDepartment grant AND `getEffectiveRole("board")`** (`boardAccess.js:146-154`); the only module already shaped as app grant + role | **none** | `requireCompany` (`policies.js:28`); `BoardPolicy` keyed per company | `sendError` | `test/costing/board-*` (`board-role-assignment:433` revocation) |
| **CEO / Executive** | dept `ceo` | DeptGuard(`ceo`); "Access control" nav shown to every CEO user | inline `ceoAuth` per file, **token role only**; allowlists vary (`hr.js:49` admits `hr_manager`) | token role | role `admin` | `ceoAccountingReports.js:70,154` primary-company default (class 3) | catch → 401 | — |
| **Access Control (admin)** | inside CEO (`/ceo/dashboard/access`) | as CEO; server refusal state | `requirePlatformAdmin` (DB + `tv`, `Middlewear/requirePlatformAdmin.js:41-67`) | `DeptUser.isAdmin` | control plane | **company matrix for PPC** (`routes/Admin/companyAccess.js`) | fail-closed 500 | `test/access/access-admin-safeguards.route.test.js`, `company-access-admin.route.test.js` |
| **Department Team / Change Requests** | CEO / approval queue | — | `services/cmsSession.js` (at GAC-0: **token `isAdmin`, legacy secrets accepted**, [T] A3; **SEC-0 changed both**: configured secret only, `isAdmin` re-read from `dept_users`) | `DepartmentRole` | **token `isAdmin` = owner of every department** (`routes/Access/departmentTeam.js:46,59,154`; `changeRequests.js:37,336`) | — | 401 | `test/access/department-role-cache.test.js` |
| **Developer console** | dept `developer` | DeptGuard softFail | `routes/DevOps/developer.js:56-57` | `getRole("developer")` | **token `isAdmin`** | — | 500 | — |
| **Files / Drive** | no slug | DeptGuard session | `routes/Access/files.js` (own verifier, legacy secrets) | per-folder | token `isAdmin` (`:119,1288,1401`) | `companyOf = query/body/req.user.companyId` (`:147-165`) | — | `test/accountant/files*.test.js` |
| **Material Requests / MRF, Requests** | no slug | DeptGuard session | `EmployeeAuthMiddlewear` + `services/access/fulfilmentAccess.js` | DB admin, `ceo` dept slug, `store` | DB | `mrfRoutes.js:1727` sole-company check | `.catch(()=>null)` | `test/store-purchase/mrf-*` |
| **Planner, Image Studio, Help** | no slug | session only (Planner not in `middleware.js`) | `EmployeeAuthMiddlewear`, owner-scoped | identity | — | none | n/a | — |
| **CoWork** | tile → `cowork-sso` | Firebase `useCoworkAuth` | `coworkAuth.js` | Firestore role | CEO claim | none | 401/403 | `test/auth/cowork-sso-apps.route.test.js` |
| **Mobile employee app** | n/a | n/a | `AllEmployeeAppMiddleware` | intern check only | — | none | **fails open** ([T] G5) | — |
| **Customer / Vendor portals** | separate sites | separate repos | `CustomerAuthMiddleware`, `VendorAuthMiddleware` | token role | — | counterparty (class 4) | — | — |
| **Google Workspace `/api/google`** | — | — | **none** (`server.js:2246`) | — | — | — | — | — |
| **Barcode devices** | — | — | **none** (`server.js:2681`) | — | — | — | — | — |

The per-application record in the manifest (`applications[]`) repeats this table with its references.

---

## 4. Role authorities and platform-administrator bypasses

**Authorities that answer "what may this person do":**

| Authority | Storage | Read by | Granularity |
|---|---|---|---|
| `DepartmentRole.role/isActive` | `department_roles`, unique `(departmentSlug,email)` (`models/Access/DepartmentRole.js:110`) | `getRole`, `getEffectiveRole`, `requireDepartmentRole`, `requireApproval`, most module services | global per department, keyed on **email** |
| `DepartmentRole.companyGrants[]` | same row (`:71-80`) | only `companyAccess.service.js` (PPC) and `deptAuth` PPC tile | per company, PPC only (`ENABLED_DEPARTMENTS = {"ppc"}`) |
| `DepartmentRole.budgetDepartments[]` | same row | Budget | per budget department, resolved per company |
| `Acc_User.role` | `acc_users`, unique `(organizationId,email)` | `orgAuth`, `getRole("accountant")` | org-wide (all companies the org owns) |
| `AccessDepartment` assignment | `Employee.accessDepartmentId/additionalDepartmentIds`, `DeptUser.departmentId` | launcher, Board, HR, fulfilment, the legacy role claim | app tile only |
| JWT `role` string | token | SalesAuth, ceoAuth, pmAuth, `accountingAccess.js:27-28`, route-local "migration" guards | whatever the token says for 7 days |
| `DeptUser.isAdmin` (DB) | `dept_users` | `requirePlatformAdmin`, HR, Marketing, Store/Costing, fulfilment, `accountingAccess` | control plane, and operationally in those modules |
| JWT `isAdmin` claim | token | `requireDepartmentRole:385`, `requireApproval:301`, departmentTeam, changeRequests, developer, files, IE, QC, production guards, salesAccess | treated as "owner of everything" |

**Admin-bypass counts** (logical guards, deduplicated):

| Kind | Count |
|---|---|
| Control plane | 20, of which 3 trust the token only |
| Operational, `isAdmin` | 67, of which **21** are DB-verified |
| Operational, `role === "admin"`-style literal | 24; dormant unless a token is forged |
| Display-only | 25 |
| Copy-through | 12 |
| Explicitly "not a grant" / dead | ~20 |
| Dev/env bypass families | 5 |

The full list, with `file:line`, is in the manifest (`authorities[]`, and each application's
`adminBypass`).

**Frontend admin bypasses:**
- `DepartmentGuard.js:149` (every slug);
- `useDeptRole.js:252-255` (`atLeast`, and `can = isAdmin || !role || …`, which lets people with no
  role through);
- `RoleGate.js:29,38` ("open" mode passes people with no role);
- `RequireRole.js:49`.

---

## 5. Conflicting or duplicate access decisions

The Evidence column is [S] unless it says otherwise. The "Pinned by" column is [T]: every `gac0` id in
it refers to a passing test listed in §9.2.

| # | Conflict | Evidence | Pinned by |
|---|---|---|---|
| C1 | Admin launcher shows every tile; Merchandising/PPC/Board APIs refuse admins; other APIs admit admins by token claim; Store/Costing/HR/Marketing admit them by DB | `deptAuth.js:1074`; `merchandising/access.service.js`; `ppc/access.service.js:32-37`; `boardAccess.js` | **gac0 D1** (PPC) |
| C2 | Two admin truths: DB `DeptUser.isAdmin` versus the JWT claim. A de-admined user keeps bypassing for the token's life | `requirePlatformAdmin.js:41-53` vs `departmentRoles.js:385` | **gac0 A1, E3** |
| C3 | Two control planes with different admin proofs: `/api/admin/*` (DB) versus `PUT /api/department-team/:slug` (token claim, legacy secrets) can grant accounting owner, HR owner, developer or board | `departmentTeam.js:133-213`, `cmsSession.js:57` | **gac0 A3** (legacy secret) |
| C4 | Department assignment gives a tile but not the role; a `DepartmentRole` gives API access without a tile | `deptAuth.js:85-117` vs `requireDepartmentRole` | **gac0 D2, D3** |
| C5 | A department with no role rows is writable by any signed-in caller; route-local guards instead trust the token slug (a third behaviour) | `departmentRoles.js:388-389`, `changeRequests.js:304-305`, `cuttingAccess.js` | **gac0 D4** |
| C6 | Global role × N memberships gives the role in all N companies (everywhere except PPC) | `resolveCompanyForActor` + `getEffectiveRole` | **gac0 B1**; `ie-read:269` |
| C7 | A PPC grant creates a membership, which activates other domains' global roles; revoking it leaves the membership | `companyAccess.service.js:135-166`; no membership write on revoke | **gac0 C2, C3** |
| C8 | A PPC tombstone is honoured by `roleForCompany` and ignored by `getRole("ppc")` (used by departmentTeam/changeRequests) | `companyAccess.service.js:37`; `departmentRoles.js:85-98` | **gac0 C1** |
| C9 | The first membership anywhere ends the single-company fallback for everyone | `companyMembership.service.js:189-201` | **gac0 C4** |
| C10 | Launcher tile removal is not revocation: the old token keeps its `role`/`deptSlug` for 7 days in claim-trusting guards | `EmployeeAuthMiddlewear.js:28-57` | **gac0 E2** |
| C11 | An app tile mints a legacy role string (e.g. `role:"ceo"`) that passes CEO/Sales/accounting-assistant allowlists | `deptAuth.js:584-603`; `accountingAccess.js:27-28` | **gac0 A4** (role string) |
| C12 | Accounting tile (AccessDepartment) versus accounting API (`Acc_User` + org); `sync-legacy` can auto-create an owner | `Acc_auth.js:757-762` | existing legacy-auth-bootstrap tests (partial) |
| C13 | HR has two guards on the same write: `hrContract` (DB) then `hrWrites` (token `isAdmin`, exempt fragments) | `server.js:1161-1187` | `test/hr-access/*` (partial) |
| C14 | `departmentWriteGuard` exempt fragments match the full URL **including the query string** and `/status`-shaped paths, so real writes skip role and approval | `departmentWriteGuard.js:101-143, 177, 199` | **not pinned**; [S] only |
| C15 | Three role granularities: accounting org-wide, departments global, PPC per company | §4 | — |
| C16 | Frontend `RoleGate` "open" mode, and `can = isAdmin \|\| !role`, show controls the server refuses | `../grav-cms/components/access/*` | frontend inventory |
| C17 | Marketing has two company answers: env `MARKETING_COMPANY_ID` and membership | `marketingAccess.js:47-51,102-105` | — |

---

## 6. Database lookup failure behaviour

The rows marked `gac0` are [T]. The `requireDepartmentRole`, `resolveCompanyForActor`, `roleForCompany`
and `AllEmployeeAppMiddleware` rows are also [V]. Every other row is [S].

| Guard | Behaviour | Evidence |
|---|---|---|
| `requireDepartmentRole` | fail-closed 500 | `departmentRoles.js:413-416`; **gac0 G1** |
| …with `isAdmin` claim | **passes before any lookup**, so an outage does not stop it | **gac0 G2** |
| `getEffectiveRole` Employee alias lookup | swallowed; answers from the token email only, which can downgrade an approver | `:148-151`; **gac0 G4** |
| `roleForCompany` | propagates, then 500 | **gac0 G3** |
| `resolveCompanyForActor` | fail-closed 503 `COMPANY_CONTEXT_UNAVAILABLE`; cannot manufacture the fallback | `companyMembership.service.js:57-72`; `costing-hardening:235-290` |
| `listMembershipCompanies` | no catch, 500 | `:231-256` |
| Store / Costing capabilities | `.catch(()=>null/[])`, reported as **403 "no permission"** (outage misreported as a denial) | `storePurchase/capabilities.js:133-155`; `centralCosting/capabilities.js:257-273` |
| `requireApproval` | fail-closed 500 | `changeRequests.js:437-446` |
| `orgAuth` | fail-closed 500 | `AccountantOrgAuthMiddleware.js:430-439` |
| `requirePlatformAdmin` | fail-closed 500 | `:64-67` |
| `hrContract` / `resolveHrActor` | 503 / downgrade to self, cached 30s | `hrAuthorization.js:323-582` |
| `resolveAccountingAccess` | swallowed, denied; the token-role path needs no DB | `accountingAccess.js:41-59`; **gac0 A4** |
| `EmployeeAuthMiddlewear` | no DB at all | **gac0 E2** |
| `AllEmployeeAppMiddleware` | **fails open**; a deleted employee is also admitted | `:35-42, :32`; **gac0 G5, G6** |
| `opsControls` write freeze | fails open, by design | `opsControls.js:127-131` |
| Socket handshake | open | `server.js:262-279` |

---

## 7. Company-context classification

### 7.1 Totals

| Scope | 1 | 2 | 3 | 4 | 5 | 6 | Total |
|---|---|---|---|---|---|---|---|
| Model inventory, 190 models (model × field rows) [S] | 17 | 158 | 21 | 6 | 0 | 2 | 204 |
| Manifest `companyContextEntries`, model layer | 18 | 158 | 21 | 6 | 0 | 2 | 205 |
| Manifest `companyContextEntries`, all layers | 305 | 222 | 64 | 27 | 24 | 14 | **656** |

**Cross-check against the manifest.** Its model layer has one more class-1 entry than the model
inventory. That entry is the shared fragment `models/CMS_Models/Sales/companyOwnership.js`, listed on
its own; the rows are otherwise identical. The manifest's totals are computed from its entries, and no
entry was added to reach a headline figure.

**By repository and layer** (manifest):

| Repository | Layer | Entries |
|---|---|---|
| backend (547) | model | 205 |
| | route | 151 |
| | service | 124 |
| | script | 20 |
| | migration | 19 |
| | export | 16 |
| | middleware | 10 |
| | test | 3 |
| frontend (109) | component | 84 |
| | lib | 24 |

- **By verification:** 605 source-inventory [S] · 32 verified-read [V] · 6 characterization-test [T]
  · 13 unresolved [U].
- **Aggregate entries:** 11 entries name a directory or glob rather than one file, e.g. the ~180 test
  fixtures.
- **Class 5 for models is 0:** no schema exists only for demo use. Demo status lives in **data**: the
  demo `Acc_Company` rows and everything keyed to them (§2A).

**Raw grep counts** (`companyId`, `.js`, excluding tests):

| Directory | Files | Lines |
|---|---|---|
| routes | 123 | 2 033 |
| services | 287 | 3 282 |
| Middlewear | 5 | 32 |
| models | 138 | 633 |
| scripts | 47 | 574 |

**Test blast radius:**
- `SpCompanyMembership` is created in about 180 test files.
- `X-Costing-Company` is sent in about 115.
- `tallyCompanyIds` appears in about 53.

### 7.2 Company masters

| Model | Represents | Class |
|---|---|---|
| `Acc_Company` (`models/Accountant_model/Acc_MasterModels.js:125`, `acc_companies`) | **The only company master.** Holds GRAV (`isPrimary`, "GRAV CLOTHING PVT LTD") **plus demo companies**. About 75 models reference it; about 100 more store its id without `ref`. | 3 (the GRAV row), 5 (demo rows) |
| `Acc_Organization` (`Acc_OrgModels.js`) | Accounting tenant; `tallyCompanyIds[]`, unique `acc_org_company_ownership_unique` | 1 |
| `SpCompanyMembership` | Membership table, not a master | 1 |
| `CRMAccount`, `Customer`, `Vendor` | counterparties | 4 |
| `SalesSettings.companyName` | GRAV branding default "Grav Clothing" | 3 |
| dangling refs `ref:"Company"` (`Doc_File`, `Doc_Folder`), `ref:"AccountantOrg"` (`Acc_CashFlowAdjustment`) | refer to models that don't exist | 2 / 6 |

`lib/payslipTemplate.mjs:77` hard-codes the payroll legal name `"Grav Clothing ( OPC ) Pvt Ltd"`,
which is not tied to `Acc_Company`. This is class 3, and a drift risk against the canonical profile.

### 7.3 Class 1: access/tenant plumbing to remove (by module)

| Module | Concrete items | Deletion risk |
|---|---|---|
| Shared resolver | `services/companyContext/companyMembership.service.js` (`resolveCompanyForActor:98`, fallback `:189-201`, `listMembershipCompanies:231`); `companyAccess.service.js`; `salesScope.service.js`, `serviceScope.service.js`, `ownershipStamp.service.js` (resolver parts); `merchandisingScope.service.js` (resolver part) | 9 modules call it. Replace with one server-side GRAV resolver first. `serviceFilter` callers (14 files) throw without a `companyId`, so they must change together. |
| Membership | `models/CMS_Models/StorePurchase/SpCompanyMembership.js` + 7 consumers; `siteIds` feeds `permittedSiteIds` | The only site-permission hook (class 6 for `siteIds`). About 180 test fixtures depend on it. Marketing `contentPlan.service.js:85-150` uses membership rows as its people directory (class 6). |
| PPC grants | `DepartmentRole.companyGrants[]`; `routes/Admin/companyAccess.js`; `deptAuth.js:107-122,962,1051`; `services/ppc/access.service.js` | **PPC access vanishes, or revoked users regain it,** unless active grants become ordinary roles and tombstones become revocations first. `accessAdmin.js:1589` 409-blocks the normal PPC role write. |
| Store/Purchase | `Middlewear/storePurchaseTenant.js`, `services/storePurchase/tenantContext.service.js`, `X-Store-Purchase-Company` header, `GET /api/cms/store-purchase/context` (company part only) | `tenantFilter` hides null-company rows (visible only via `?scope=legacy`). Dropping the filter exposes and makes actionable every unbackfilled row, so run the `backfill-store-company` migrations first. |
| Costing | `Middlewear/centralCostingContext.js`, `services/centralCosting/companyContext.service.js`, `contextResolver.service.js:120` | Idempotency claim hash includes `companyId`; keep the value constant during transition. |
| IE / Merchandising / PPC selectors | `ieRoutes.js:71-117,215`; `executionRoute.js:84`; `ieReleasesRoute.js:108`; `workOrderStyleLink.service.js:40-43,355-365` (reads header, query **and** `body.actingCompanyId`) | `styleOwnershipClause` (`merchandisingScope.service.js:207`) also carries active/non-terminal/spine filters, which must be kept. |
| Production sub-apps | `productionStyleRoute.js:27-53`, `packagingAccess.js:51`, `productionTargetAccess.js:55`, `cuttingAccess.js:46`, `embroideryAccess.js:42`, `salesLineLinkRoutes.js:15,25`, `embroideryRoutes.js:19,59` | tenant middleware on every production sub-app |
| Sales | `quotationRoutes.js:2019-3388` (`actingCompanyId`), `developmentRequests.js:32`, `changeNotices.js:32`; `companyOwnership` subdoc on CRMAccount/Contact/Lead/Enquiry/SalesJourney | `companyOwnership{source,proven}` may be history (class 6 for the subdoc's future). |
| Board | `routes/CMS_Routes/Board/policies.js:26-61` (resolver) | `BoardPolicy` keyed per company; possibly class 3 (§7.6) |
| Files | `routes/Access/files.js:147-165` `companyOf` (query/body/token) | unique `(companyId,parentId,name)` |
| Budget | `Acc_budgets.js:162,528`, `Acc_budgetDepartments.js:41`, `Acc_costCentres.js:38`, `budgetProposals.js:292-395` (`x-company-id`/`?companyId`) | per-company resolution of `budgetDepartments` |
| Accounting | `AccountantOrgAuthMiddleware.js:666-860` (`requireCompanyAccess`, `resolveCompanyScope`), `Acc_Organization`, `Acc_User.organizationId`, `Acc_Invite`, `accountantCompanyOwnership.service.js`, `Acc_companies.js:719` list filter, `scripts/migrations/accounting-company-ownership-index.js`, `accounting-organization-company-repair.js` | ~139 endpoints take `companyId` (frontend contract). GAC-8 only. |
| Pickers (7) | `GET /api/admin/company-access`, `/api/cms/ppc/companies`, `/api/cms/ie/companies`, `/api/cms/merchandising/companies`, `/api/cms/store-purchase/context` (company part), `/api/budget-proposals/context`, `/api/accountant/tally/companies` (filter) | frontend consumers listed in §7.8 |
| Sole-company checks (~15) | `Acc_Company.find({}).limit(2)` in `companyMembership.service.js:192`, `salesScope.service.js:52`, `serviceScope.service.js:74`, `contextResolver.service.js:120`, `storeProducts.js:47`, `spendRequests.js:136`, `intakeRequests.js:2061`, `mrfRoutes.js:1727`, `Acc_vendors.js:50`, `Acc_customers.js:52`, `Acc_importMapping.js:85`, `Acc_books.js:1321`, `Acc_reports.js:51`, `Acc_import.js:3915`, `Acc_chartOfAccounts.js:5948` | **Every one breaks when a second `Acc_Company` exists.** Consolidate on one `isPrimary` resolver. |

### 7.4 Class 2: redundant GRAV partition keys (158 model rows)

These are grouped by module; the manifest lists each model and field with its indexes.

| Module | Rows |
|---|---|
| Merchandising | 31 |
| Marketing | 40 (companyId with no `ref`) |
| Inventory | 18 |
| Sales/CRM | 16 |
| PPC | 13 |
| Store/Purchase | 11 |
| IE | 11 |
| Budget | 5 |
| Costing | 5 |
| Production | 4 |
| Files | 2 |
| Board | 1 |
| Other | 1 |

The same class covers the stamp and filter halves of `salesScope`, `serviceScope`, `ownershipStamp`,
`merchandisingScope`, `tenantFilter` (19 files / 104 lines) and `req.tenant.companyId`
(19 files / 120 lines).

### 7.5 Class 3: legal/statutory facts to retain (21 model rows + exports)

- **Accounting books:** `Acc_Group`, `Ledger`, `CostCentre`, `Unit`, `StockGroup`, `StockItem`,
  `Voucher`, `Godown`, `GSTR2B`, `ProformaInvoice`, `BillTerms`, `PayrollLedgerMap`,
  `PayrollExternalPost`, `FieldMapping`, `ImportSession`, `ForecastCashLedgerConfig`,
  `RecurringItem`, and `companyId` on `LedgerReclassRequest`, `AuditNote`, `CustomReport`
  (`companyIds`), `ApprovalRequest`.
- **Exports and legal output:**
  - e-way bill seller GSTIN (`Acc_ewayBill.js:349-351,491`);
  - proforma place of supply (`Acc_proformaInvoices.js:397`);
  - GSTR-2B GSTIN match (`Acc_gstr2b.js:627-632`);
  - report titles (`accountingExport.service.js:146,160,224`);
  - forecast output (`cashFlowForecastOrchestrator.service.js:415,488`);
  - AI context (`accountingContext.js:16-36`, which already resolves one `isPrimary` company);
  - reporting mart `dim_company` / `company_id NOT NULL` (`migrations/reporting/V001__reporting_mart.sql:26,70-97`, `R__curated_views.sql`, `V003`);
  - payslip legal name (`lib/payslipTemplate.mjs:77`);
  - PO base currency (`purchaseOrders.js:501`).

### 7.6 Class 4 (counterparty) and class 6 (unresolved)

**Class 4:**
- `Vendor` (record);
- `Contact.company`, `Lead.company`;
- `MarketingHandoverReceipt.company`, `MarketingProspectHandover.company`;
- **`Measurement.organizationId`**, which refers to `Customer` and is easy to delete by mistake;
- CRM/customer/vendor PDFs and emails (`sampleApprovalPdf.js:87,131,206`).

Outside `Acc_Company` and `SalesSettings`, `companyName` always means the counterparty, so a blanket
rename would hit class 4 data.

**Class 6:**
1. `Acc_CashFlowAdjustment.organizationId`: its ref points at the non-existent `AccountantOrg`.
2. `LandedCostAllocation.companyId`: bound to vouchers.
3. `services/marketing/contentPlan/contentPlan.service.js`: stores `owner.membershipId`.
4. The accounting request-`companyId` contract. Is more than one real Tally company legitimately
   imported? The live `acc_companies` count must be checked.
5. Whether the multi-organisation accounting model (`Acc_Organization`) is needed at all.
6. The `companyOwnership` subdoc: drop it, or keep it as history.
7. `Acc_Company.companyAccessRevision`: becomes dead.
8. `SpCompanyMembership.siteIds`: the only site-permission hook.
9. `MARKETING_COMPANY_ID` versus membership during the transition.
10. `BoardPolicy`: class 2, or class 3 as a board-approved legal policy?
11. Frontend:
    - Custom Reports "compare with another company";
    - Budget sub-pages that silently take the first company;
    - Store/Costing "choose a company" states that have no chooser.

### 7.7 Indexes, migrations and deletion hazards

**Highest-risk indexes.** Rebuilding these without `companyId` causes duplicate-key errors unless the
demo rows are purged or merged first:

- **Keep (class 3):**
  - `Acc_Voucher uniq_voucher_number_live {companyId,voucherType,voucherNumber}`, created at runtime
    (`Acc_VoucherModels.js:960`);
  - unique `(companyId,name)` on ledger, group, stock and godown masters;
  - `Acc_GSTR2B`, `Acc_ProformaInvoice` numbering.
- **Merge or re-key before dropping `companyId`:**
  - `SpDocumentSequence {companyId,documentType,fiscalYear,siteId}`;
  - `PurchaseOrder {companyId,poNumber}` (includes null-company legacy rows);
  - `GoodsReceipt`, `StockCount`, `MRF` numbers;
  - `RawItem {companyId,sku}`, `Service`, `Unit`, `Warehouse`;
  - `Vendor {companyId,gstNormalised}` / `{companyId,supplierCode}`, whose partial filter is on
    `companyId`, so suppliers must be deduplicated first;
  - one-per-company: `CostingPolicy`, `MarketingTrackingConfig`,
    `MarketingLeadReconciliationLease`, `IeAllowancePolicy`;
  - library codes in IE, Merchandising and PPC;
  - `CustomerAccountClaim`, whose `_id` is `"<company>:<customer>"` and needs re-keying;
  - Marketing `MarketingConsent` (legal consent record), `MarketingIdentity`,
    `MarketingDeliveryState`, `MarketingCampaignRefCounter`.

**Schema hazards:**
- `GravAiUsage` and the Marketing schemas use `strict:"throw"`. `companyId` must be `$unset` on
  stored documents **before** it is removed from the schema.
- Production has `autoIndex` off, so every index change needs an explicit migration script.

**Existing migrations:**
- `backfill-{enquiry,journey,sales,store}-company.js` and `rawitem-company-ownership.js` are class 2
  and useful: they backfill null rows to GRAV before the predicates are dropped.
- `store-purchase-*-indexes.js`, `marketing-outbox-company-scoped-index.js` and
  `marketing-campaign-draft-utm-index.js` create company-compound unique indexes (class 2).

**Demo companies found in scripts:**

| Company | Created by | Notes |
|---|---|---|
| "GRAV Demo Garments" | `scripts/demo/merchandising-demo-server.js:46` | in-memory DB |
| "IE Demo Garments" and "IE Demo Textiles" | `scripts/ie/seed-ie-demo.js:108-109` | documented as local-only; **[D] present in the configured development DB** with references in 16 collections (§2A) |
| "Demo Co (budget preview)" | `scripts/seed-budget-demo.js:130` | **no in-memory guard seen** |
| "Local Closure Co" | `scripts/readiness/local-data-closure.js:83` | |
| "GRAV Clothing" | `scripts/marketing/channels-proof.js:74` | **a look-alike of the real company** |

Cleanup of any demo company requires a dry-run dependency report (decision §Professional safety).

### 7.8 Frontend company context (`../grav-cms`)

The frontend never sends an `x-company-id` header. The company travels in one of four ways:

- **(A) `X-Costing-Company` header plus `?company=` in the page URL (class 1):**
  - IE (`components/IE_*`, `IeStates.js:101`);
  - Merchandising (`lib/merchandising/api.js`; the worktree has uncommitted edits adding two more
    acting-company calls);
  - PPC (`CompanyChoice`, `PpcCompanyRequired`);
  - Sales development-request inline chooser (uncommitted).
- **(B) `companyId` in query or body plus localStorage `grav.activeCompanyId`:** Accounting
  (`components/accountant/CompanyProvider.js`, modified, imports **untracked**
  `companySelection.js`) and Budget. The selector is class 1; the per-request partition key is
  class 2.
- **(C) The `acc_token` organisation token (class 1).**
- **(D) Resolved on the server with nothing sent:** Store, Costing, Marketing. Their "choose a
  company" states have no chooser (class 6).
- **Class 3:** `lib/companyInfo.js`, invoice seller display.
- **Class 4:** measurement "organization".

**Commit hazard:** the frontend's tracked `CompanyProvider.js` imports the untracked
`companySelection.js`. Committing one without the other breaks the build.

---

## 8. Access Control today

- **Frontend:** `/ceo/dashboard/access` (`AccessManager`) has four tabs: Departments;
  People & roles (the registry is `moduleRoles.js` and **omits PPC**); Company & app access (a
  PPC-only company × person × role matrix plus a legacy review list); Department logins.
- **Backend:** `routes/Admin/accessAdmin.js` and `routes/Admin/companyAccess.js`, both behind
  `requirePlatformAdmin`.
- **A second, parallel writer** is `PUT /api/department-team/:slug` (token-claim admin).

---

## 9. Tests

### 9.1 Existing coverage against the required areas

| Area | Already pinned | Gap before GAC-0 |
|---|---|---|
| a. admin operational bypass | `ie-read.route.test.js:206`, `costing-contract.test.js:94`, `sales-prepare-authorisation.test.js:237` (admitted); `ppc-companies.route.test.js:126`, Board, `m7-change-control:1227`, `pm-access-boundary:682` (refused) | token-claim bypass of the shared role guard; legacy-secret acceptance; token-role accounting access |
| b. global role × membership | `company-access.test.js:34` (PPC); `ie-read:269` (implicit) | shared guard / resolver cross-product |
| c. companyGrants | `company-access.test.js:34,48,63,101`; `company-access-admin:27` | `getRole("ppc")` ignoring tombstones; membership surviving revoke; fallback shutdown |
| d. launcher vs API | `ppc-app-entry.test.js:196`; `company-access-launcher.test.js:27,62` | admin tile vs PPC API; ordinary department tile vs role guard; role without tile |
| e. revocation | `ppc-companies:154`, `board-role-assignment:433`, `hr-access/authorisation-cache-invalidation`, `legacy-bridge-revocation`, accountant token-version tests | `switch-department` re-minting a revoked DeptUser session; `EmployeeAuthMiddlewear` ignoring deactivation |
| f. accounting authority | `legacy-auth-bootstrap`, `legacy-route-auth-facade`, `accounting-auth-inventory`, `company-isolation` | `getRole("accountant")` vs a `DepartmentRole` row |
| g. DB failure | company-context 503 (`costing-hardening:235-290`, `enquiry-tenancy`, `costing-supplier-data-gate:452`) | shared role guard, `roleForCompany`, alias lookup, mobile intern check |

### 9.2 New characterization tests (GAC-0)

Both files state in their header that they pin **current** behaviour, including unsafe behaviour,
and must be flipped deliberately by the chunk that changes it.

**`test/access/gac0-access-characterization.test.js`** (18 tests):

| Id | Test |
|---|---|
| A1 | `requireDepartmentRole` admits a JWT `isAdmin` claim with no DeptUser and no role |
| A2 | …the same caller without the claim is refused (`NO_DEPARTMENT_ROLE`) |
| A3 | `cmsSession` accepts a token signed with the hard-coded legacy secret and carries `isAdmin` |
| A4 | a token role `ceo`/`superadmin` opens accounting data to the assistant with no DB record |
| B1 | one global merchandiser role is effective in both member companies |
| B2 | `getRole` ignores `companyGrants` |
| C1 | a PPC tombstone blocks `roleForCompany` but `getRole("ppc")` returns the legacy role |
| C2 | a PPC grant creates a membership that survives revoke and still resolves the person into the company |
| C3 | the 409 legacy-role guard is skipped when a membership already exists, after which a global Sales role becomes company-effective |
| C4 | the first PPC grant ends the single-company fallback for a bystander |
| F1 | `getRole("accountant")` reads `Acc_User`, not `DepartmentRole` |
| F2 | an inactive `Acc_User` gives no role despite an active `DepartmentRole` owner row |
| G1 | the role guard returns 500 on DB failure |
| G2 | the admin claim passes during an outage |
| G3 | `roleForCompany` propagates the error |
| G4 | the alias-lookup failure downgrades approver → viewer |
| G5 | the mobile intern lock-out fails open |
| G6 | the mobile app admits a token for a deleted employee |

**`test/access/gac0-session-launcher.route.test.js`** (8 tests, HTTP):

| Id | Test |
|---|---|
| D1 | an admin gets the PPC tile and can switch in, but the PPC API answers 403 |
| D2 | the Sales tile is shown while the Sales role guard answers 403 |
| D3 | an HR role with no HR tile passes the HR guard |
| D4 | an unconfigured department is open at the role guard |
| E1 | role revocation takes effect on the next request |
| E2 | a deactivated employee gets 401 from `/verify` but still passes `EmployeeAuthMiddlewear` |
| E3 | an `isAdmin` claim keeps bypassing with no admin anywhere in the DB |
| E4 | a revoked DeptUser session gets 401 from `/verify`, while `switch-department` returns 200 and a fresh, valid token |

Commands and results are recorded in `docs/handoff/latest-implementation.md`.

---

## 10. Current migration hazards (ordered by the chunk they block)

| Id | Hazard | Blocks |
|---|---|---|
| H1 | No single resolver. Every guard listed in §3 must be compared against GAC-1's answer before cutover; several disagree today (§5). | GAC-1 / GAC-4 |
| H2 | Grants are keyed on **email**, and `getEffectiveRole` takes the highest role across the token email and the Employee email. Duplicate-email and identity ambiguity is not detected (default-deny requirement). | GAC-1 |
| H3 | [V] `listRoles` counts inactive rows. The PPC placeholder row (`role:"viewer",isActive:false`) and revoked rows make a department "configured"; unconfigured departments are fully open ([T] D4). GAC-1 must not inherit fail-open. | GAC-1 |
| H4 | Accounting's role is org-wide in `Acc_User` (unique `(organizationId,email)`), and `findAccountantUser` is **not** org-filtered. With more than one org, `getRole("accountant")` is ambiguous. [D] There is only 1 org today and 0 users in more than one. | GAC-1 / GAC-8 |
| H5 | Revocation is not immediate: 7-day claim-trusting tokens; `switch-department` re-mints revoked DeptUser sessions; Bearer logout does not revoke. | GAC-4 |
| H6 | Removing the admin bypass will lock admins out of Sales/HR/production writes they reach today by token claim, unless explicit grants are made first (decision: explicit grants, audited). | GAC-4 |
| H7 | PPC roles exist only in `companyGrants[]`, and tombstones must stay denials. [D] 3 active grants (2 GRAV, 1 IE Demo Garments) and 2 tombstones, both on rows with an active legacy role; `accessAdmin.js:1589` blocks ordinary PPC role writes. | GAC-2 / GAC-5 |
| H8 | Membership rows created by PPC grants have activated other domains' roles; removing membership changes effective access in Store/Costing/IE/Merchandising/Marketing/Board. | GAC-5 / GAC-6 / GAC-7 |
| H9 | About 15 sole-company checks, plus the fallback. [D] Two demo `Acc_Company` rows exist now, so these checks are already false in the configured database; deleting demo companies needs a dependency report. | GAC-5+ / GAC-10 |
| H10 | Compound unique indexes (§7.7), `strict:"throw"` schemas and `autoIndex` off in production. | GAC-6 / GAC-7 / GAC-10 |
| H11 | Store null-company legacy rows become visible and actionable when the tenant filter goes. | GAC-6 |
| H12 | Idempotency keys include `companyId` (Store `idempotency.service.js:104`, Costing claim hash). | GAC-6 |
| H13 | Accounting frontend contract: about 139 endpoints take `companyId`; `tallyCompanyIds` guard; the multi-org model is unresolved. | GAC-8 |
| H14 | Test fixtures: about 180 files seed `SpCompanyMembership` and about 115 send `X-Costing-Company`. | GAC-5 → GAC-10 |
| H15 | Frontend uncommitted company-selection work (`CompanyProvider.js` → untracked `companySelection.js`) is in flight and will be removed later. Coordinate before committing either repo. | GAC-5 / GAC-8 |
| H16 | Payroll legal name is hard-coded, separate from `Acc_Company`, and could drift from the canonical profile. | GAC-8 |
| H17 | [D] The configured development database has no `employees` collection, and 35 of 64 active role rows match no identity in it. Identity-keyed migration and parity tests against live data are blocked until the employee source is established. | GAC-1 (parity against live data) / GAC-2 |
| H18 | [D] The single accounting organisation owns both demo companies, and demo ids appear in sales `enquiries` and `salesjourneys` as well as in IE collections. Demo cleanup is not IE-only. | GAC-8 / GAC-10 |

---

## 11. Security findings outside GAC scope

These are recorded, not fixed; GAC-0 changes no production behaviour. **S1–S3 are recommended for a
separate emergency security chunk before GAC-1.**

> **SEC-0 status (25 Sep 2026, after GAC-0).** S1, S2 and S3 were contained by the SEC-0 chunk:
> - **S1:** published secrets are no longer accepted, and the `cmsSession` `isAdmin` claim is re-read
>   from the database.
> - **S2:** the seed-ceo route was removed.
> - **S3:** `/api/google` is administrator-only and returns no token material.
>
> SEC-0 also found one further live exposure: the unauthenticated
> `GET /cowork/employee/dump/:employeeId` (`routes/task_routes/taskTree.routes.js:310`) returns raw
> CoWork employee records, including the stored Gmail `refresh_token`. It is **not** fixed.
>
> Details, tests and remaining exposures are in `docs/handoff/latest-implementation.md`. The rows
> below are the GAC-0 snapshot and are not rewritten.

The manifest lists 22 findings under its own ids (`S-01`…`S-22`), and each one carries an `auditId`.
The mapping for the rows below:

| Audit id | Manifest id |
|---|---|
| S1 | S-01 |
| S2 | S-12 |
| S3 | S-11 |
| S4 | S-09 |
| S5 | S-02 |
| S6 | S-03 |
| S7 | S-04 |
| S8 | S-15 |
| S9 | S-08 |
| S10 | the remainder |

The manifest's hazards are numbered independently (`H-01`…`H-20`). H-18 to H-20 are the [D] hazards,
which appear here as H17, H18 and the H7 note.

| Id | Severity | Finding | Status |
|---|---|---|---|
| S1 | critical | `config/jwt.js:45-48` `LEGACY_SECRETS` (`grav_clothing_secret_key`, `…_2024`) are accepted in every environment by `deptAuth.verifyToken`, `cmsSession`, `departmentWriteGuard`, `hrContract`, `files`, `budgetProposals`, `qcViewer`, `qcTeamRoutes`. A forged `isAdmin` token reaches department-team role grants and change-request approval. `EmployeeAuthMiddlewear` also falls back to the literal when `JWT_SECRET` is unset. | [T] A3 (legacy secret accepted by `cmsSession`); [V] `config/jwt.js:45-48` (not filtered by environment), `services/cmsSession.js:20-48`; downstream reach [S] |
| S2 | critical | `POST /cowork/setup/seed-ceo` (`routes/task_routes/cowork.js:18`) is unauthenticated. It sets a Firebase `ceo` claim on any email and overwrites record `E000`. | [V] `routes/task_routes/cowork.js:16-37` |
| S3 | critical | `/api/google` (`server.js:2246`, 41 routes) is unauthenticated. `/auth/callback` returns the refresh token; `/gmail/my-inbox?email=` reads any mailbox; send/reply/trash act for any employee. | [V] `server.js:2246`, `googleWorkspaceRoutes.js:40-64,240-256` |
| S4 | high | `/api/barcode-devices` has no auth, including firmware upload with a body-controlled path (`barcode-scanner-hardware-routes.js:268`). | [S] |
| S5 | high | Employee phone number and `Firstname@MMDDYYYY` are always accepted as passwords (`utils/employeePassword.js:63-84`); the mobile login overwrites the real hash (`Employee_Routes/login.js:143-151`). | [S] |
| S6 | high | A deactivated or reset DeptUser can still sign in via the legacy collections (`deptAuth.js:445-449 → 731-790`). | [S] |
| S7 | high | One signing secret for every audience and no audience check: customer `/signin` issues a token from a phone number (`Customer_Routes/auth.js:390-409`) that passes employee middlewares. | [S] |
| S8 | high | `departmentWriteGuard` exemption matched against the URL including the query string (`:177,199`). | [S] |
| S9 | high | `_devOtp` is returned when `NODE_ENV !== "production"` (`passwordReset.js:188`, `coworkPasswordReset.js:312`, `Customer_Routes/auth.js:149`, `PasswordResetOTP.js:151`); the CMS reset uses a 4-digit code whose attempt counter resets on re-request. | [S] |
| S10 | medium | Unauthenticated field-tracking reads/deletes; customer edit-request approve/reject; inline production scan routes; anonymous socket room joins; `/api/accountant/auth/debug-token` public; `change-password` without the current password; face sign-in without an `isActive` check. | [S] |

---

## 12. Proposed exact file list for GAC-1 (not started)

The resolver is read-only. It changes no writes, removes no guards and migrates no data.

**New**
1. `services/access/appAccess.service.js`:
   - `resolveAppAccess(actor, appSlug)` returns `{ identity, role, capabilities, source }` or a
     stable denial/outage code.
   - It adapts `DepartmentRole` (global row; for `ppc`, `companyGrants` read-only with tombstone =
     deny) and `Acc_User` for `accountant`.
   - It never consults `isAdmin`, fails closed on ambiguous or duplicate identity, and maps a DB
     error to an outage code.
2. `services/access/appAccessCodes.js`: denial and outage codes, plus the role-to-capability map
   (Viewer/Editor/Approver/Owner, with per-app capability hooks for HR sensitive fields and
   maker/checker).
3. `services/access/appCatalogue.js`: the app slug catalogue (maps `AccessDepartment` slugs and the
   accounting slug to the resolver's app ids; flags per app how its role is stored).
4. `test/access/app-access-resolver.test.js`:
   - Employee, DeptUser and accounting-only identities;
   - inactive account; missing and revoked grant; PPC tombstone;
   - duplicate-email ambiguity; admin without an app grant; DB failure.
5. `test/access/app-access-parity.test.js`: compares resolver decisions with `requireDepartmentRole`,
   `roleForCompany`, `orgAuth` role and the launcher tile set on shared fixtures. It records
   disagreements (§5) as expected differences and changes no routes.

**Read, not modified**

`models/Access/DepartmentRole.js`, `models/Access/DeptUser.js`, `models/Employee.js`,
`models/Accountant_model/Acc_OrgModels.js`, `services/departmentRoles.js`,
`services/accountantAccess.js`, `services/companyContext/companyAccess.service.js`,
`routes/auth/deptAuth.js` (`resolveEmployeeDepartments`).

**Documentation**

`docs/handoff/latest-implementation.md`; optionally a short section in
`docs/decisions/single-organisation-access-control.md` naming the resolver's codes once reviewed.

**Open questions for review before GAC-1:**
1. Should the GAC-1 resolver treat an active PPC `companyGrants` entry for the GRAV company as the
   PPC role, and ignore grants for demo companies?
2. How should Accounting be resolved when `Acc_User` exists in more than one organisation?
3. Is the identity key email (as today) or a person reference? The decision says to use existing
   identities; H2 needs an explicit ambiguity rule.
4. [D] Why the configured development database has no `employees` collection. Which database holds the
   real employee identities?
5. [D] Should the active PPC approver grant for "IE Demo Garments" count at all, and the 2 PPC
   tombstones that sit beside active legacy roles?
