# Self-service Accounting reporting with Metabase — architecture plan

**Status:** proposal. **D2 decided and implemented** (ownership slice); D1, D3–D5 open — see §9. **Scope:** investigation and architecture only; no code written.
**Date:** 2026-09-24.

Goal: an accountant opens **Custom Reports** in the Accounting sidebar, gets Metabase's
visual query builder against approved Accounting data, and can filter, group, summarise,
chart, save, reopen and download XLSX — all produced by Metabase, not by us.

---

## 1. Current-state findings

### 1.1 Accounting authentication

`Middlewear/AccountantOrgAuthMiddleware.js` (875 lines) is the single authority.

| Fact | Evidence |
|---|---|
| Session token claims | `signOrgToken`, `AccountantOrgAuthMiddleware.js:186-199` — `{ id, organizationId, role, email, name, tokenVersion }`, HS256 on `JWT_SECRET`, 24h |
| Roles | `owner` / `approver` / `editor` / `viewer` — `Acc_OrgModels.js:100` (`ROLES` enum) |
| Permissions derived from the **stored** role, never the token | `permissionsForRole`, `:237-252`; attached in `attachOrgSession`, `:504-515` |
| Permission set | `canView`, `canEdit`, `canPostDirectly`, `canApprove`, `canManageTeam`, `canManageSettings` |
| Every request re-confirms the user in Mongo | `confirmOrgCandidate`, `:298-360` — exists, `isActive`, `tokenVersion` match, organisation matches, org `isActive` |
| Credential selection | `resolveSession`, `:361-483` — Bearer preferred over cookies, first DB-confirmed candidate wins |
| Legacy CMS tokens | bootstrap-only; `orgAuth` refuses with `ACCOUNTING_SESSION_UPGRADE_REQUIRED` |
| Company access | `requireCompanyScope`, `:817-829`; ownership via `req.organization.tallyCompanyIds`, `resolveCompanyScope:736-803` |
| Company refusal codes | `COMPANY_SCOPE_REQUIRED` / `_INVALID` / `_CONFLICT` / `COMPANY_FORBIDDEN` / `NO_ORGANIZATION_CONTEXT`, `:697-704` |

**Frontend session** — `grav-cms/lib/api.js`:
- `acc_token` in `localStorage` (`:32`, `:37`), replayed as `Authorization: Bearer` (`:70-75`);
- `credentials: "include"` (`:83`) so the httpOnly `accountant_token` cookie also travels;
- Bearer wins, which is the cross-origin path Chrome needs.

**Sidebar** — `grav-cms/components/accountant/Sidebar.js` already has per-item
`gate: { permission }` / `gate: { roles }` (`:243`, `:263-267`) and per-user `hiddenNavItems`
(`:323`). A "Custom Reports" entry slots in with no new mechanism.

### 1.2 Accounting data

44 Mongoose models across 22 files in `models/Accountant_model/`.

| Model | Collection | `companyId` | `organizationId` | Nested arrays |
|---|---|:--:|:--:|---|
| `Acc_Voucher` | `acc_vouchers` | Y | **no** | `ledgerEntries[]`, `inventoryEntries[]`, `attachments[]`, `signatures[]` |
| `Acc_Ledger`, `Acc_Group`, `Acc_Company`, `Acc_CostCentre`, `Acc_StockItem` … | `acc_ledgers`, `acc_groups`, `acc_companies` … | Y | **no** | `documents[]`, `aliases[]`, `additionalGstins[]` |
| `Acc_Invoice`, `Acc_Expense`, `Acc_BankTransaction`, `Acc_Budget`, `Acc_JournalEntry`, `Acc_TaxFiling`, `Acc_CreditDebitNote` | `acc_invoices`, `acc_expenses`, `acc_bank_transactions`, `acc_budgets`, … | Y | **no** | `lines[]`, `payments[]`, `phasing[]`, `monthlyPhasing[]`, `budgetRequests[]`, `adjustments[]`, `transfers[]` |
| `Acc_Organization`, `Acc_User` | `acc_organizations`, `acc_users` | — | Y | `tallyCompanyIds[]`, `fcmTokens[]` |

**The decisive structural fact: financial records carry `companyId` but no `organizationId`.**
Only 7 of 22 model files mention `organizationId`, and `Acc_Company` is not one of them.
Organisation ownership exists *only* as `Acc_Organization.tallyCompanyIds[]`
(`Acc_OrgModels.js:62-64`) — an access-control list, reverse-looked-up per request.

Consequences:
- `organization_id` is **not** present on any fact row and must be materialised by the sync.
- Nothing enforces that a company appears in exactly one organisation's array. `sync-legacy`
  assigns *every* company to an org that has none (`Acc_auth.js:669-674`), and `/bootstrap`
  refuses once one organisation exists (`Acc_auth.js:437-441`) — so the system is
  **effectively single-organisation today** and `organization_id` is currently a constant.
  That is a deployment accident, not an invariant. See decision **D2**.

**Nested arrays Metabase cannot query well.** `Acc_Voucher.ledgerEntries[]` is the centre of
the ledger and is two levels deep: each entry carries `billAllocations[]` and
`costCentreAllocations[]` (`Acc_VoucherModels.js:20-57`). A GL query is "explode vouchers to
lines, then optionally to bill allocations" — precisely what Metabase's query builder cannot
express against a document store.

Helpful: each line already stores `signedAmount` (+Dr / −Cr, `:30`), so the mart inherits a
balancing column rather than deriving one.

**Voucher lifecycle** — `status: draft | pending_approval | posted | cancelled | void`
(`:399-404`), updated **in place**; `isLive` is recomputed on save (`:680`). There are also
**hard deletes**: `Acc_Voucher.deleteMany` / `deleteOne`, `Acc_Ledger.deleteMany`,
`Acc_Group.deleteMany`, `Acc_StockItem.deleteMany` in `Acc_import.js`, `Acc_merge.js`,
`Acc_chartOfAccounts.js`. `acc_vouchers` has `timestamps: true` (`:645`), so `updatedAt` is
available for watermarking — but a watermark alone cannot see a deletion.

**Sensitive fields.**

| Classification | Fields |
|---|---|
| **Excluded entirely** | `Acc_User.passwordHash`, `.fcmTokens`, `.sessionsRevokedAt`; `Acc_Invite.token`; `Acc_Department.password`; `Acc_BackupConfig.googleRefreshToken`; `Acc_SetuConsent.*` (AA consent artefacts + `bankAccount`); every `attachments[]` URL/Drive id |
| **Restricted** (privileged group only) | `Acc_Ledger.bankDetails.accountNumber` + IFSC (`Acc_MasterModels.js:717-720`); `Acc_Settings.bankAccounts[].accountNumber` (`Acc_OperationalModels.js:227`, `:1551`); party `pan`; salary-derived payroll postings |
| **Safe** | company/ledger/group names and codes, voucher header + line amounts, dates, statuses, GST rates and tax amounts, party names, budget heads and allocations, bank transaction narration/amount/date |

GSTIN is **restricted-but-needed**: GST reporting is a core use case, so it belongs in the
mart, gated to the privileged group rather than dropped.

### 1.3 Does any of this already exist?

**No.** Verified by search across both repositories (excluding `node_modules`, lockfiles):

- No `metabase`, `@metabase/embedding-sdk-react`, `InteractiveQuestion` reference anywhere.
- No PostgreSQL, ClickHouse, Snowflake, BigQuery, Redshift, Knex, Sequelize or `pg` driver.
- No data warehouse, reporting mart, analytics database or reporting sync.
- No `Dockerfile`, `docker-compose`, `render.yaml`, `fly.toml` or Procfile in **either** repo —
  deployment is configured outside version control (Render / Vercel dashboards).
- No MongoDB **change streams** (`.watch()`) in use.
- No CSP / security headers configured in `grav-cms/next.config.mjs`.

Existing reporting is hand-built: `routes/Accountant_Routes/Acc_reports.js` (798 lines,
8 routes), plus `services/accountingExport.service.js` and per-screen ExcelJS exporters.
Lane B's `services/accountingReportGuard.js` is the current reporting security model —
canonical params resolved *before* the company check, and fail-closed when no company is
named. **The Metabase work must not regress that property**, and must not replace Lane B's
report routes; it sits beside them.

**Versions:** `next@16.0.10`, `react@19.2.0`, `react-dom@19.2.0` (installed, verified),
TypeScript 5. Backend: `express@^5.2.1`, `mongoose@^8.19.3`, `jsonwebtoken@^9.0.3`.

---

## 2. Recommended architecture and security boundary

Adopt the proposed stack, with one boundary stated sharply:

```
Next.js (grav-cms)                    GRAV backend                     Metabase
  /accountant/custom-reports            POST /api/accountant/            (Pro/EE)
  <MetabaseProvider authConfig>   ──▶     reporting/metabase-sso    ──▶   JWT SSO
  <InteractiveQuestion isSaveEnabled>   (orgAuth + permission gate)      query builder
  <CollectionBrowser>                     signs short-lived RS256/HS256   ▼
        │                                  JWT with tenant attributes   Postgres
        └──── XLSX download ◀──────────────────────────────────────────  reporting mart
                                                                         (read-only user)
```

**Do not connect Metabase to production MongoDB.** This is not a preference; it fails the
brief's own test. Metabase's row- and column-level security (sandboxing) is implemented as a
SQL rewrite and is **not available for MongoDB**. Isolation would therefore have to come from
the application layer — but the application layer is exactly what is being bypassed. Concretely:

- Financial documents carry no `organization_id` at all (§1.2), so there is nothing for a
  tenant filter to match on.
- `docs/audits/accounting-company-scope-inventory.md` records **159 endpoints still deferred
  to Chunk 3B**, "organisation-authenticated but not company-isolated". Direct collection
  access would be strictly weaker than the API that is still being hardened.
- Nested `ledgerEntries[]` would force native MongoDB queries for anything useful, and native
  query access is precisely what ordinary Accounting users must not have.

The SQL mart is what makes row-level security *possible*. That is its primary justification;
query ergonomics for the visual builder are the second.

**Security boundary, in order:**

1. Metabase connects to Postgres as a **read-only** role (`GRANT SELECT` on the reporting
   schema only; no `CREATE`, no access to any other schema or database).
2. Every mart table carries immutable `organization_id` and `company_id`.
3. Metabase **sandboxing** filters every table on `organization_id = {{gsi_organization_id}}`
   from the signed JWT attribute. Users cannot edit their own attributes.
4. Ordinary Accounting users get **query-builder access only**; native SQL is denied at the
   database-permission level, not merely hidden in the UI.
5. Restricted columns are withheld by column-level permission from the standard group.
6. The mart contains no credentials, tokens, consents or attachment locations.

Even if sandboxing were misconfigured, the mart holds no secrets — that is deliberate defence
in depth, not a reason to relax step 3.

---

## 3. Proposed reporting-mart schema

PostgreSQL, schema `reporting`. Every table: `organization_id uuid/text NOT NULL`,
`company_id text NOT NULL`, `source_id text NOT NULL` (the Mongo `_id`),
`source_updated_at timestamptz`, `synced_at timestamptz`, and
`UNIQUE (source_id)` as the idempotency key.

**Dimensions**

| Table | Grain | Key columns |
|---|---|---|
| `dim_company` | one company | `company_id`, `company_name`, `gstin`*, `state_code`, `books_from_date`, `is_active` |
| `dim_ledger` | one ledger | `ledger_id`, `ledger_name`, `group_id`, `group_name`, `nature`, `is_active`, `bank_account_number`** |
| `dim_group` | one COA group | `group_id`, `group_name`, `parent_group_id`, `nature`, `is_primary` |
| `dim_party` | customer/supplier ledger | `party_id`, `party_name`, `party_type`, `gstin`*, `state`, `credit_days` |
| `dim_cost_centre` | one cost centre | `cost_centre_id`, `cost_centre_name` |
| `dim_date` | one day | `date_key`, `d`, `fy_label`, `quarter`, `month`, `month_name` |

**Facts**

| Table | Grain | Why it exists |
|---|---|---|
| `fact_voucher` | one voucher header | status, type, number, date, party, `grand_total`, `is_live`, cancellation/approval metadata |
| `fact_voucher_line` | **one `ledgerEntries[]` element** | the flattening that makes the GL queryable: `voucher_id`, `line_no`, `ledger_id`, `dr_cr`, `amount`, `signed_amount`, `gst_rate`, `taxable_value`, `tax_amount` |
| `fact_bill_allocation` | one `billAllocations[]` element | bill-wise ageing without a second explode |
| `fact_cost_centre_allocation` | one `costCentreAllocations[]` element | cost-centre analysis |
| `fact_invoice` | one invoice | header + status; `fact_invoice_line` for `lines[]` |
| `fact_receipt_payment` | one receipt/payment voucher | AR/AP settlement view derived from voucher types |
| `fact_expense` | one expense | head, ledger, amount, mode, GST |
| `fact_bank_transaction` | one bank line | date, narration, amount, direction, reconciliation state |
| `fact_budget_allocation` | one budget head allocation | budget vs actual |
| `fact_tax` | one tax line | GST rate, taxable value, CGST/SGST/IGST/cess, direction |

\* GSTIN restricted-group only. \*\* Bank account number restricted-group only; consider
storing last-4 in the standard view instead.

`fact_voucher_line` is the table that earns the whole project. Everything the accountant
actually wants — trial balance, GL, party ledger, P&L, ageing — is a group-by over it.

### Sync design

**Initial load:** batched full read per collection, ordered by `_id`, written to the mart in
a transaction per batch; then a full reconciliation pass (below) before the mart is exposed.

**Incremental:** watermark on `updatedAt` per collection (`acc_vouchers` has `timestamps: true`,
`Acc_VoucherModels.js:645`), overlapping the previous high-water mark by a safety margin,
upserting on `source_id`. Because voucher lines are embedded, a changed voucher means
**delete-then-reinsert that voucher's lines inside one transaction** — never a partial
line-level merge, which cannot represent a removed line.

**Updates, reversals, cancellations:** these are status transitions on the same document
(`draft → posted → cancelled|void`), so the watermark catches them and the upsert overwrites
`status` and `is_live`. Reporting must filter on `status = 'posted'` (or `is_live`) rather
than assume presence means posted; the mart keeps cancelled rows so corrections are auditable.

**Deletions:** the watermark cannot see them, and hard deletes demonstrably exist (§1.2). Two
layers: (a) a periodic id-set reconciliation per company — compare `source_id` sets and
tombstone the difference; (b) preferably, MongoDB **change streams** for near-real-time
deletes. Change streams require a replica set — confirm the Atlas tier (**D4**).

**Freshness:** 15 minutes is the right default for accounting analytics, with an explicit
"data as of" timestamp surfaced in the Metabase collection description. Same-second freshness
is not a requirement for reporting and buying it would complicate the sync considerably.

**Reconciliation to the General Ledger.** Non-negotiable, and cheap because `signedAmount`
already exists:

1. Per company and period, `SUM(signed_amount)` over posted `fact_voucher_line` **must be 0**.
2. Per company, mart trial balance per ledger must equal the API's
   `/api/accountant/reports` trial balance to the paisa.
3. Row counts per collection per company must match Mongo.
4. Any mismatch fails the sync job loudly and marks the mart stale rather than serving
   silently wrong numbers.

---

## 4. Proposed JWT claims and group mappings

Signed by the GRAV backend for Metabase SSO. **Short-lived (≤ 2 minutes)**, single-use in
effect, never stored by the browser.

```jsonc
{
  "email": "user@grav.in",                 // from req.user.email — the Metabase identity
  "first_name": "…", "last_name": "…",
  "groups": ["Accounting Standard"],       // or ["Accounting Privileged"]
  "gsi_organization_id": "<organizationId>",  // trusted tenant attribute — sandbox key
  "gsi_company_ids": "id1,id2",            // for future per-company sandboxing
  "gsi_acc_role": "editor",
  "exp": 1760000120
}
```

`gsi_organization_id` comes from `req.user.organizationId`, which `orgAuth` confirmed against
the database on this request (`confirmOrgCandidate`, `:298-360`). It is never read from the
request body or query.

| Accounting role | Metabase group | Metabase permissions |
|---|---|---|
| `viewer` | Accounting Standard | query-builder only; sandboxed; restricted columns hidden; **no** save |
| `editor` | Accounting Standard | as above **+** save into the org's collection |
| `approver` | Accounting Standard | as editor |
| `owner` | Accounting Privileged | as editor **+** restricted columns (GSTIN, bank numbers); still **no** native SQL |
| — | Accounting Admin | native SQL, data-model editing. GRAV staff only, provisioned manually, never mapped from a GRAV role |

No GRAV role maps to native SQL. One Metabase identity per Accounting user, keyed on email;
never a shared account.

---

## 5. Proposed frontend route and component structure

```
grav-cms/
  app/accountant/custom-reports/page.js          new  — route shell
  app/accountant/custom-reports/[id]/page.js     new  — reopen a saved question
  components/accountant/reporting/
    MetabaseReportsProvider.js                   new  — <MetabaseProvider> + authConfig
    CustomReportsWorkspace.js                    new  — CollectionBrowser + InteractiveQuestion
    useMetabaseSso.js                            new  — fetches/refreshes the SSO JWT
  components/accountant/Sidebar.js               edit — one nav entry, gate: { permission: "canView" }
  lib/metabase.js                                new  — instance URL, collection id resolution
```

`InteractiveQuestion` is mounted as a **new question** with `isSaveEnabled` and downloads on;
`CollectionBrowser` (or `InteractiveDashboard`) lists saved Accounting reports. The SDK is a
React component tree making XHR to Metabase — not an iframe — so `frame-ancestors` is not the
relevant control; **CORS and authorised SDK origins are**.

The sidebar entry is gated `canView`, so every Accounting role sees it; what differs is the
Metabase group behind it.

---

## 6. Proposed backend SSO endpoint contract

```
POST /api/accountant/reporting/metabase-sso
  middleware: orgAuth  →  requirePermission("canView")
  body: {}                       // nothing is read from the caller
  200: { jwt: "<jwt>", metabaseUrl: "https://…", collectionId: 42, expiresIn: 120 }
  401: ACCOUNTING_SESSION_UPGRADE_REQUIRED | NO_TOKEN | STALE_TOKEN
  403: INSUFFICIENT_ROLE
  503: METABASE_NOT_CONFIGURED
```

The response field is **`jwt`**, not `token`. The SDK's `fetchRequestToken` contract
expects `jwt`, and `token` is also the name this codebase already uses for the Accounting
session in `/auth/login` and `/auth/sync-legacy` — two different credentials under one name
in adjacent endpoints is how the wrong one ends up in the wrong header.

Rules:
- `orgAuth` first, always — the organisation id must be the DB-confirmed one.
- The endpoint takes **no input**. Nothing about tenancy may be caller-supplied.
- Signing secret is Metabase's JWT key, **separate from `JWT_SECRET`**. Reusing the session
  secret would let a Metabase token be replayed as a GRAV session.
- Rate-limited; every issuance logged with user id, organisation id and group.
- A second endpoint, `GET /api/accountant/reporting/health`, reports mart freshness and last
  reconciliation result so the UI can show "data as of …" and refuse to look authoritative
  when the sync is stale.

New files: `routes/Accountant_Routes/Acc_reportingSso.js`,
`services/metabaseSso.service.js`, one mount line in `server.js`.

---

## 7. Metabase deployment and configuration requirements

**Licensing:** local evaluation of the SDK may be possible without a paid plan — enough to
confirm the component API and the React/Next compatibility question in **B1** before any
money is spent. What **production** needs is not evaluable that way: **JWT SSO and row-level
security (sandboxing) require Pro or Enterprise**, and those two are the entire security
argument of this design. Plan the spike against a local instance; plan the rollout against a
licence.

The Modular Embedding SDK and sandboxing (RLS) are **paid** features for production use.
Metabase **Pro** (cloud) is the pragmatic choice; Enterprise only if self-hosting is required.
Open-source Metabase cannot do this securely — it has neither the SDK entitlement nor
sandboxing, and without sandboxing the entire isolation argument collapses. **This is a
purchase decision that gates the project (D1).**

**Infrastructure (all new — nothing in either repo provisions it):**
- Metabase Pro instance (or container + its own app database if self-hosted).
- PostgreSQL for the reporting mart.
- A sync worker — a scheduled job in the backend, or a separate process.

**Metabase configuration:** JWT SSO enabled with shared key; `embedding-app-origins-sdk` set
to the CMS origins; user provisioning on first SSO; three groups (§4); a per-organisation
collection for saved reports; database connection using the read-only role;
sandboxing policy per mart table on `gsi_organization_id`; native query permission denied for
both Accounting groups.

**Environment variables (backend):** `METABASE_SITE_URL`, `METABASE_JWT_SHARED_SECRET`,
`METABASE_ACCOUNTING_COLLECTION_ID`, `REPORTING_DATABASE_URL`, `REPORTING_SYNC_INTERVAL_MS`.
**(Frontend):** `NEXT_PUBLIC_METABASE_SITE_URL`.
None of these exist today; `.env` is untracked, so they must be added in both deploy dashboards.

**CORS / CSP / cookies:**
- Metabase must allow the CMS origins (`https://cms.grav.in`, localhost:3000/3001) as SDK
  origins; the SDK sends credentialed XHR.
- The backend's `allowedOrigins` (`server.js:28-60`) already covers the CMS; the Metabase host
  is a *destination*, not an origin calling us, so no change is needed there.
- `grav-cms/next.config.mjs` has no CSP today. If one is added, it needs `connect-src` for the
  Metabase host.
- Metabase's own session cookie must be `SameSite=None; Secure` for cross-origin SDK use —
  which requires HTTPS in every environment including local development (**D5**).

---

## 8. Sequential implementation slices

Each is independently testable and independently revertable.

| # | Slice | Done when |
|---|---|---|
| 0 | **Decisions** — §9 answered, licence procured | D1–D5 recorded |
| 1 | **Postgres mart, schema only** — tables, constraints, read-only role | **DONE (24 Sep 2026).** `migrations/reporting/V001` + `R__curated_views` + `roles/R__roles`; `npm run reporting:verify-roles` proves the reader cannot write, 24/24 |
| 2 | **Dimension sync** — companies, groups, ledgers, parties, cost centres, dates | **PARTLY DONE.** `dim_company`, `dim_group`, `dim_ledger` sync and reconcile; `organization_id` is on every row. `dim_party`, `dim_cost_centre` and `dim_date` are not built |
| 3 | **Voucher + line sync** — `fact_voucher`, `fact_voucher_line`, allocations | **PARTLY DONE.** `fact_voucher` and `fact_voucher_line` sync; `SUM(signed_amount)` is exactly 0 per company/period and the per-ledger trial balance matches `Acc_books.js` to the paisa. `fact_bill_allocation` and `fact_cost_centre_allocation` are not built |
| 4 | **Remaining facts** — invoices, receipts/payments, expenses, bank, budgets, tax | each reconciles against its existing report route |
| 5 | **Incremental sync + deletion handling** — watermark, tombstones, reconciliation job | an update, a cancellation and a hard delete each propagate within one interval; reconciliation failure marks the mart stale |
| 6 | **Metabase provisioning** — groups, collections, sandboxing, read-only connection | a user in org A **cannot** see org B's rows, proven with two seeded orgs and a native-SQL attempt that is refused |
| 7 | **Backend SSO endpoint** | returns a token only for a DB-confirmed session; legacy/anonymous refused; secret separate from `JWT_SECRET` |
| 8 | **Frontend Custom Reports route** | question builds, saves, reopens, downloads real XLSX; sidebar gate correct |
| 9 | **Hardening** — rate limits, audit logging, freshness banner, runbook | staleness is visible in the UI; issuance is logged |

Slices 1–5 deliver value on their own (a trustworthy mart) even if the Metabase purchase is
delayed; slices 6–8 are the only ones that depend on the licence.

---

## 9. Risks, blockers, decisions

**Implemented since this document was written** — see
`docs/handoff/latest-implementation.md`, "Accounting reporting mart — real data
in the Metabase pilot (24 Sep 2026)":

- The mart exists and holds real data for all three companies; the synthetic
  pilot dataset has been dropped from the active database.
- Full refresh only, gated by a six-check reconciliation that runs inside the
  transaction and rolls back on any mismatch.
- **Two findings worth carrying forward.** (a) `voucherDate` is stored at UTC
  midnight in some documents and IST midnight in others — 530 of 1,868 in the
  live company — so every mart date is resolved in the business timezone and
  every reconciliation aggregate uses the same one. (b) `Acc_books.js`'s trial
  balance does not exclude `isOptional` vouchers while the Lane B party reports
  do; the mart matches the former and raises a warning if a posted optional
  voucher ever appears, because it cannot match both. **D6, open: which of the
  two is correct?**

**Blockers**

- **D1 — Metabase Pro/Enterprise licence.** Without it there is no SDK and no sandboxing, and
  the security argument does not hold. Open-source Metabase is not a fallback for this design.
- **B1 — React 19.2 / Next 16.0.10 vs the Metabase Embedding SDK.** The installed versions are
  very recent and the SDK has historically tracked React 17/18 with React 19 support arriving
  later. **I could not verify the SDK's current peer range from the repositories** — nothing
  Metabase-related is installed. This must be checked against the SDK release notes for the
  exact Metabase version before slice 8, and it can invalidate the frontend approach outright.
  If the SDK does not support React 19, the options are static/interactive iframe embedding
  (weaker UX, different security posture) or pinning a compatible React in an isolated route —
  neither is attractive. **Verify early.**

  The same applies to the component API itself: the names and props used in §5
  (`MetabaseProvider`, `InteractiveQuestion`, `isSaveEnabled`, `CollectionBrowser`) are
  written from the SDK as documented at the time of the audit and **have changed between
  Metabase major versions**. Treat every prop in this document as provisional and check it
  against the release notes for the Metabase major actually selected before writing the
  frontend — this is a spike, not a copy-paste.

**Decisions needed**

- **D2 — Is a company owned by exactly one organisation? — DECIDED: yes.**
  An Accounting company belongs to **exactly one `Acc_Organization` at a time**.
  `Acc_Organization.tallyCompanyIds[]` remains the canonical and only ownership record; no
  `organizationId` is copied onto financial documents.

  Implemented (ownership slice):
  - a unique multikey index `acc_org_company_ownership_unique` on
    `acc_organizations.tallyCompanyIds`, partial on `{ tallyCompanyIds: { $type: "objectId" } }`
    so that any number of organisations may still own nothing;
  - `services/accountantCompanyOwnership.service.js` as the single write path, all-or-nothing
    per call and idempotent for the current owner, translating a duplicate-key race into
    `ACCOUNTING_COMPANY_ALREADY_OWNED`;
  - `scripts/migrations/accounting-company-ownership-index.js`, dry-run by default, which
    reports conflicting company/organisation pairs and refuses to build the index while any
    conflict stands.

  `organization_id` on a mart row is therefore a well-defined function of `company_id`, and
  the sandbox key in §4 is sound.
- **D3 — Does Metabase run in GRAV infrastructure or Metabase Cloud?** No infra-as-code exists
  in either repo, so either way this is new ground.
- **D4 — Is the MongoDB deployment a replica set?** Determines whether change streams are
  available for deletion detection, or whether periodic id-set reconciliation is the only option.
- **D5 — Local development authentication.** Cross-origin SDK use needs `SameSite=None; Secure`,
  i.e. HTTPS locally. Decide between a local TLS proxy, a shared dev Metabase, or accepting
  that Custom Reports is not exercisable on plain `localhost`.

**Risks**

- **Two sources of truth for financial numbers.** The mart will be quoted in meetings. The
  reconciliation gate in slice 3/5 is what keeps it honest; it must fail loudly, not warn.
- **Self-service means users will build wrong reports** — mixing cancelled vouchers into totals,
  double-counting via bill allocations. Mitigate with curated, well-named models and a default
  `status = 'posted'` filter baked into the exposed views, not with training.
- **Sandbox misconfiguration is invisible.** It must be tested adversarially with two seeded
  organisations as an automated check, not verified by inspection once.
- **The sync is new infrastructure that can silently stop.** Freshness must be visible in the
  UI (slice 9), or stale numbers will be read as current ones.
- **Scope pressure toward native SQL.** Someone will ask for it within a month. The answer is
  a new mart view or a member of Accounting Admin — not loosening the standard groups.
- **Lane interaction.** This adds no new company-scope surface to the API, so it neither helps
  nor harms Chunk 3B. It must not be presented as closing that gap.

---

## 10. Files likely to be created or changed

**Backend (`grav-cms-backend`)**

| Path | Change |
|---|---|
| `routes/Accountant_Routes/Acc_reportingSso.js` | new — SSO + health endpoints |
| `services/metabaseSso.service.js` | new — JWT minting, group mapping |
| `services/reporting/martSync.service.js` | new — initial + incremental sync |
| `services/reporting/martReconcile.service.js` | new — GL reconciliation gate |
| `services/reporting/pgClient.js` | new — Postgres pool (read/write for sync only) |
| `migrations/reporting/*.sql` | new — mart schema, indexes, read-only role |
| `server.js` | edit — one mount line; possibly one scheduled sync interval |
| `package.json` | edit — add `pg` (no Postgres driver today) |
| `test/accountant/metabase-sso.route.test.js` | new — org identity, legacy refusal, secret separation |
| `test/reporting/mart-sync.test.js` | new — flattening, idempotency, deletions, reconciliation |
| `docs/decisions/accounting-metabase-self-service-reporting.md` | this document |

**Frontend (`grav-cms`)**

| Path | Change |
|---|---|
| `app/accountant/custom-reports/page.js` | new |
| `app/accountant/custom-reports/[id]/page.js` | new |
| `components/accountant/reporting/MetabaseReportsProvider.js` | new |
| `components/accountant/reporting/CustomReportsWorkspace.js` | new |
| `components/accountant/reporting/useMetabaseSso.js` | new |
| `lib/metabase.js` | new |
| `components/accountant/Sidebar.js` | edit — one gated nav entry |
| `package.json` | edit — add the Metabase SDK (subject to **B1**) |
| `next.config.mjs` | edit — only if a CSP is introduced |

**Not touched:** `Acc_reports.js`, `accountingExport.service.js`, `accountingReportGuard.js`
and the Lane B customer/supplier report routes. Metabase sits beside the curated reports; it
does not replace them.
