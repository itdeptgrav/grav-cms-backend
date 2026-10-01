# Claude Code prompt - Central Costing, Chunk 1

Use `/Users/risheeray/grav-cms` as the frontend repository and
`/Users/risheeray/grav-cms-backend` as the backend repository.

## Goal

Implement **Chunk 1 only** of the central costing roadmap: establish the
company-scoped, permission-controlled and immutable domain contract on which
the costing engine will be built.

This chunk must end with a real protected API that can create and read an
empty costing draft for a company/style/order context. It must not build the
cost calculator, margin policy UI, supplier-offer history or Sales quotation
workflow yet.

The next chunk must be able to add calculations without replacing the models,
identity rules, visibility rules or API envelope created here.

## Required reading before editing

Read these files completely or in the relevant sections before changing code:

- `/Users/risheeray/grav-cms-backend/AGENTS.md`
- `/Users/risheeray/grav-cms-backend/docs/tasks/current-task.md`
- `/Users/risheeray/grav-cms-backend/docs/tasks/central-costing-roadmap.md`
- `/Users/risheeray/grav-cms-backend/docs/product/connected-lifecycle.md`, Price/costing sections
- `/Users/risheeray/grav-cms-backend/docs/product/crm-master-requirements.md`, Costing and Quotation
- `/Users/risheeray/grav-cms-backend/docs/product/store-purchase-professionalization.md`, sections 4.1, 6, 7 and Chunks 1-2
- `/Users/risheeray/grav-cms-backend/docs/decisions/store-purchase-tenancy-permissions.md`
- `/Users/risheeray/grav-cms-backend/models/CMS_Models/Sales/Enquiry.js`, especially `costingSheets`
- `/Users/risheeray/grav-cms-backend/routes/CMS_Routes/Sales/enquiries.js`, costing routes and access checks
- `/Users/risheeray/grav-cms-backend/services/costingTotals.js`
- `/Users/risheeray/grav-cms-backend/services/crmCostVisibility.js`
- `/Users/risheeray/grav-cms-backend/services/salesAccess.js`
- `/Users/risheeray/grav-cms-backend/services/access/accountingAccess.js`
- `/Users/risheeray/grav-cms-backend/services/storePurchase/tenantContext.service.js`
- `/Users/risheeray/grav-cms-backend/services/storePurchase/capabilities.js`
- `/Users/risheeray/grav-cms-backend/models/CMS_Models/StorePurchase/SpCompanyMembership.js`
- `/Users/risheeray/grav-cms-backend/server.js`

Inspect nearby tests and repository conventions before choosing final filenames.

## Pre-flight

1. Run `git status --short` in both repositories.
2. Preserve every existing uncommitted change. Both repositories are dirty,
   including active Store, landed-cost, valuation and budget-attribution work.
3. Do not revert, rewrite or format unrelated files.
4. Confirm the current route mounts, auth middleware, company models and access
   sources from code. Do not rely only on documentation because the Store
   boundary has moved since parts of the brief were written.
5. State any conflict between the current code and this prompt before editing.

## Decisions that are fixed

1. Central Costing is a shared company domain. Do not place the new canonical
   model under Sales, Store, Accounts or Manufacturing ownership.
2. Existing `Enquiry.costingSheets` remains compatible and untouched in this
   chunk. It is an input/legacy adapter target for Chunk 2, not the new source
   of truth.
3. Cost, margin and supplier prices are restricted information. Frontend hiding
   is never authority; fields must be omitted server-side when not permitted.
4. Company scope is mandatory on every canonical costing document and query.
5. Company identity is derived from authenticated, server-owned records only.
   Never accept `companyId` from a request body/query/header as authority.
6. Store's `SpCompanyMembership` may be reused only if inspection proves it is
   authoritative for the actors who will use central costing. Do not silently
   treat Store membership as universal company membership.
7. Missing or ambiguous company identity fails closed with a stable error. Do
   not guess from the costing context, style, enquiry or first company found.
8. Versions are immutable after creation. Corrections create a later version;
   they never rewrite a historical version.
9. Monetary fields use integer minor units plus currency. No floating-point
   storage or arithmetic for canonical money.
10. Missing values and zero values remain distinct.

## Scope

### A. Inventory and choose the company-context boundary

Before implementing the models, inspect how authenticated CMS users in Sales,
Accounts, Store and Manufacturing are associated with a company today.

Write a short adopted architecture record under `docs/decisions/` that states:

- every company-context mechanism found;
- which one is authoritative for canonical costing now;
- any adapter used and why;
- the fail-closed behavior for absent or ambiguous membership;
- why request payloads and related documents are not identity authority;
- how a future general company-membership model can replace an adapter without
  changing costing documents.

If there is no authoritative context usable by all intended actors, implement
the smallest explicit central membership/context boundary needed for costing.
Do not perform a company-wide identity migration in this chunk. Preserve the
single-company development fallback only if it is already a documented,
server-derived deployment rule and mark it clearly in the resolved context.

### B. Define costing capabilities and visibility

Add stable central-costing capabilities with these meanings:

- `costing.output.read` - read approved commercial output intended for Sales;
- `costing.cost.read` - read internal cost build-up;
- `costing.draft.write` - create and revise draft costing versions;
- `costing.approve` - approve a costing version in a later chunk;
- `costing.margin.read` - read margin and margin-sensitive outputs;
- `costing.policy.manage` - manage company costing policy in a later chunk.

Resolve them from existing authoritative access records. Do not build another
login, token role or browser-owned permission map.

Use conservative defaults:

- platform admins and the existing CEO authority may hold all capabilities;
- a Sales grant may read approved commercial output but must not automatically
  gain internal cost, supplier-price, policy or margin visibility;
- authentication alone grants nothing;
- where an existing role cannot be mapped without a business decision, grant
  nothing and record the open decision.

The capability service must be pure/testable apart from its access lookup.

### C. Create the canonical domain contract

Create canonical models in a neutral central-costing namespace. Final names may
follow repository conventions, but there must be one clear owner for:

#### Costing

- required `companyId`;
- stable context reference type and id, capable of representing at least a
  style, enquiry/style combination or order without embedding that document as
  authority;
- human-readable context snapshot for historical display;
- lifecycle state with only the minimum state needed now (`DRAFT` is enough);
- current-version reference if useful, maintained atomically;
- creator and timestamps;
- archive state rather than hard delete.

#### CostingVersion

- required `companyId` and `costingId`;
- monotonically increasing version number unique within one costing;
- immutable creation provenance;
- calculation schema/version identifier reserved for Chunk 2;
- base currency;
- source references/snapshots using a stable typed shape;
- scenario container shape reserved for Chunk 2 without implementing its
  arithmetic;
- status sufficient to distinguish a draft version from future approved or
  superseded versions;
- no update path that mutates a persisted version's commercial/calculation
  content.

Do not create `CostingScenario` as a separate collection merely because the
roadmap names the concept. Embed it in a version unless the current query and
versioning requirements demonstrate a real need for a separate owner.

Add indexes for company-scoped lookup and version uniqueness. Avoid redundant
schema indexes and do not introduce global uniqueness for tenant data.

### D. Protected API

Add one canonical central-costing router behind the existing employee auth,
company-context resolution and costing capability checks.

Minimum endpoints:

```text
POST /api/costings
GET  /api/costings/:id
GET  /api/costings/:id/versions
```

`POST /api/costings` must:

- require `costing.draft.write`;
- derive company and actor server-side;
- validate the typed context reference without trusting it for company scope;
- create the costing and version 1 atomically or leave neither behind;
- be idempotent for a client retry using the repository's established pattern;
- return a stable response envelope designed for Chunk 2 extension.

Read endpoints must:

- scope by resolved company before id;
- return the same non-disclosing missing response for a foreign-company id;
- require an appropriate costing capability;
- serialize output through one server-side visibility layer;
- omit internal cost, supplier-price and margin fields unless their respective
  capabilities are present, even though version 1 has no calculations yet.

There is no edit-in-place endpoint for a persisted version. If an endpoint is
needed to demonstrate version creation, it must append version 2 and preserve
version 1 byte-for-byte in its protected content.

### E. Minimal integration surface

- Mount the router once under a canonical neutral URL.
- Do not expose a second competing endpoint under Sales.
- Add a small frontend API client only if required to prove the route contract;
  do not build a costing screen in this chunk.
- Leave an explicit adapter boundary for `Enquiry.costingSheets` to be consumed
  by Chunk 2. Do not migrate or dual-write it now.

## Explicitly out of scope

Do not implement:

- costing formulas or totals;
- margin/markup calculations;
- company costing-policy values or settings UI;
- supplier offers, RFQs, quote history or price tiers;
- Store Item Master migration;
- BOM, consumption, SAM, wastage or operation integration;
- economies-of-scale scenarios;
- costing review/approval transitions;
- Sales quotation creation;
- budget checking, commitment or procurement demand;
- PO, receipt, voucher or actual-cost integration;
- changes to current `Enquiry.costingSheets` behavior;
- broad Store/Purchase security cleanup outside endpoints actually consumed by
  this chunk.

## Focused verification only

Keep this fast. Do not run every repository suite.

At minimum prove:

1. an authorised actor can create a costing and version 1;
2. the company and actor come from server-owned context, not the payload;
3. authentication alone grants nothing;
4. a Sales-only output reader cannot read draft/internal costing data;
5. an internal-cost reader still does not receive margin without
   `costing.margin.read`;
6. a foreign-company id is indistinguishable from a missing id;
7. an ambiguous/missing company membership fails closed;
8. a retry does not create a second costing/version;
9. version numbering is unique and a persisted version cannot be overwritten;
10. failed atomic creation leaves neither parent nor version;
11. money/currency and typed-source validation reject malformed input;
12. existing `Enquiry.costingSheets` tests remain unchanged and the focused
    existing costing-total tests still pass.

Run:

- the focused new service/model/route tests;
- existing focused `costingTotals` and costing-route tests that touch the
  preserved legacy path;
- syntax/static checks for changed backend files;
- `git diff --check` in both repositories.

Do not run a broad frontend build when no frontend production file changed.
Do not claim browser verification when this chunk intentionally has no screen.

## Completion report

Report:

- files changed;
- the company-context mechanisms found and the chosen authority;
- capability mapping and deliberately withheld access;
- canonical models, indexes and API envelope;
- proof that versions are immutable and tenant-scoped;
- focused tests run and exact results;
- existing dirty files preserved;
- unresolved business decisions;
- the precise starting point for Chunk 2, without implementing it.

