# Decision record — Central Costing: company context, capabilities, visibility and immutability (Chunk 1)

> **Status:** Adopted and implemented for Chunk 1 (4 Sep 2026).
>
> **Scope of this record:** the company-identity authority, the capability
> vocabulary, the server-side visibility rules and the immutability contract on
> which the costing engine (Chunk 2 onward) is built. It records **no**
> calculation, margin policy, supplier-offer or approval decision — those are
> later chunks and are deliberately absent.
>
> **Active brief:** `docs/tasks/central-costing-roadmap.md`.
> **Implementation prompt:** `docs/handoff/central-costing-chunk-01-prompt.md`.
> **Sibling record:** `docs/decisions/store-purchase-tenancy-permissions.md` —
> the Store boundary this one deliberately does not inherit wholesale.

---

## 1. Every company-context mechanism found

Read from code, not from documentation, on 4 Sep 2026:

| # | Mechanism | Where | What it can answer | Why it is not sufficient alone |
|---|---|---|---|---|
| 1 | `SpCompanyMembership` | `models/CMS_Models/StorePurchase/SpCompanyMembership.js` | `{email \| employeeRef} → companyId`, with `siteIds[]` and `isActive` | Store-named and Store-populated; nobody outside Store has been granted a row yet |
| 2 | Single-company deployment rule | `services/storePurchase/tenantContext.service.js`, and the same rule in `routes/CMS_Routes/Inventory/Operations/mrfRoutes.js` at the fulfilment decision | "There is exactly one company, and nobody has an explicit membership" | A deployment fact with a defined expiry — it stops applying the moment a second company or any membership row exists |
| 3 | Accountant tenancy: `Acc_User.organizationId` + `Acc_Organization.tallyCompanyIds` | `models/Accountant_model/Acc_OrgModels.js`, `Middlewear/AccountantOrgAuthMiddleware.js` (`requireCompanyAccess`) | Which companies an accountant-module ORGANISATION may reach | A different login (`accountant_token`), a different user collection, and it validates a **client-supplied** `companyId` against an allowlist rather than deriving one. It cannot resolve a CMS employee JWT at all |
| 4 | Nothing | `models/Employee.js`, `models/Access/DeptUser.js`, `models/Access/DepartmentRole.js`, the CMS JWT (`Middlewear/EmployeeAuthMiddlewear.js`) | — | **No company anywhere.** Sales, Manufacturing, Merchandising, R&D and Project Management users have no company association of any kind |

Two non-mechanisms were considered and rejected outright:

- **The document being costed** (style, enquiry, order). Reading company off
  it answers "may I see this?" with "you are seeing it".
- **A `companyId` in a body, query or header.** A payload is the caller's
  claim, not the server's record.

## 2. The authority chosen

**`SpCompanyMembership`, through one shared, domain-neutral resolver:**
`services/companyContext/companyMembership.service.js`.

The resolution — previously inline in Store's tenant context — was moved there
unchanged and **both** domains now call it:

- `services/storePurchase/tenantContext.service.js` (Store & Purchase)
- `services/centralCosting/companyContext.service.js` (Central Costing)

Order, fail-closed:

1. **An active membership record decides.** Every active row is read, not
   `findOne`: one distinct company is unambiguous; several require the caller
   to name which of **their own** memberships they are acting under.
2. **Single-company deployment.** Only when *no* membership row exists for
   anybody **and** exactly one `Acc_Company` exists. It reads neither the body,
   the query nor the document being accessed, and it is **surfaced** on every
   response as `visibility.membershipSource: "SINGLE_COMPANY_DEPLOYMENT"` with
   `membershipProven: false` on the context — a weaker statement than a
   membership record, and said so rather than hidden.
3. **Fail closed.** Anything else is `403 TENANT_MEMBERSHIP_UNPROVEN`. Never a
   guess, never "the first company found", never "all companies".

**Why one shared resolver and not a costing-specific copy:** a second
implementation of "which company is this person in" is a second answer waiting
to disagree with the first, and the disagreement would show up as one domain
scoping a read another domain would have refused.

**Why not a new central membership collection:** it would need to be populated
before anyone could use costing, and populating it means the same
administrative act that populates `SpCompanyMembership` — with two rows to keep
in step and a period in which they differ. The adapter is named, its
consequence is stated in §4, and §7 records how it is replaced.

**Why not the accountant tenancy (mechanism 3):** it is reached through a
different login and a different user collection, so it cannot resolve the CMS
employee JWT that every costing actor will arrive with. Adopting it would mean
building a second authentication door for costing, which the chunk forbids.

### Multi-company selection

`X-Costing-Company` (or `?actingCompanyId=`) **selects among memberships the
actor already holds**. It is validated against them; it is never authority on
its own; a single-membership actor's value is ignored entirely; and naming a
company they do not hold receives the same non-disclosing refusal as one that
does not exist. It is read from a header/query precisely so it can never be
confused with a `companyId` in a record's body — which is refused outright
(`400 TENANT_MISMATCH`, `assertNoForeignCompany`), not silently substituted.

### Query scoping

`companyFilter(ctx)` returns `{ companyId }` and is applied **before** the
document id, in one query, on every read. There is no "find by id, then check
the company" anywhere in the router. Cross-company, never-existed and malformed
ids all receive the identical `404` body — a `403` would confirm the id exists.

There is **no legacy/unowned mode**: both collections are new, so every
document has an owner from its first write and no read path has to cope with an
unowned one.

## 3. Capabilities

Six names, in `services/centralCosting/capabilities.js`. Each is one decision,
and holding one grants nothing about the others.

| Capability | Means |
|---|---|
| `costing.output.read` | the approved commercial number Sales may quote |
| `costing.cost.read` | the internal build-up: source snapshots, supplier prices, rates |
| `costing.draft.write` | create and revise draft costing versions |
| `costing.approve` | approve a version (behaviour lands in Chunk 6) |
| `costing.margin.read` | margin and margin-sensitive output |
| `costing.policy.manage` | company costing policy (Chunk 2/6) |

Resolved from the **existing** authoritative access records — `DeptUser.isAdmin`
(re-read from the database every request, never from the token) and
`DepartmentRole` grants — with no new login, token role or browser-owned
permission map. The mapping half (`capabilitiesFromGrants`) is pure and tested
without a database or a request.

### The mapping

| Grant | Capabilities |
|---|---|
| Platform admin (`DeptUser.isAdmin`) | all six |
| `ceo`, any rank | all six |
| `sales`, any rank | `costing.output.read` **only** |
| **Every other department** | **none** |
| Authentication alone | **none** |

**Sales gets output and nothing else.** This is not a new restriction; it is
today's rule made explicit. `services/crmCostVisibility.js` rule 1 already
states "Sales does not see cost", and grants the cost tier to exactly `admin`
and `ceo`. A Sales grant therefore never carries cost, supplier prices, margin,
draft access or policy.

### Deliberately withheld — open business decisions

Store, Inventory, Merchandising, R&D, Project Management and the accountant
module each have a plausible claim on some part of costing, and each claim is a
decision somebody has to make. Per the chunk's instruction they are granted
**nothing** and listed here (§8) as unresolved. In practice, until those
decisions are made, only platform admins and the CEO authority can create a
costing.

## 4. The consequence of the adapter, stated

Because company identity comes from `SpCompanyMembership`, and because that
collection has been populated only for Store so far:

- a Sales, Merchandising or Manufacturing user **with a costing grant** but
  **no membership row**, in a deployment with more than one company, is
  **refused** `403 TENANT_MEMBERSHIP_UNPROVEN`;
- the fix is administrative — grant them a membership — not a code change;
- in a single-company deployment with no membership rows at all, they resolve
  through the deployment rule and every response says so.

That is the intended failure. Guessing a company for them would be worse than a
refusal, and inferring one from the style or enquiry they are costing is the
circularity §1 rejects.

## 5. Canonical models

Neutral namespace: `models/CMS_Models/Costing/`. **Not** under Sales, Store,
Accounts or Manufacturing — owned by any one of them it would inherit that
module's access rules, which is exactly how a Sales screen ends up able to read
a supplier's price.

### `Costing` (`costings`) — the stable handle

`companyId` (required) · typed `context` (`STYLE` / `ENQUIRY_STYLE` / `ORDER` /
`SAMPLE_STYLE` / `ADHOC`, with `primaryId`, `secondaryId`, `externalKey`) ·
`contextSnapshot` (frozen display copy) · `status` (`DRAFT` only — the later
lifecycle values are Chunk 6's, and declaring them now would let a future
writer set `APPROVED` without the controls that must precede it) ·
`currentVersionId` / `currentVersionNumber` · creator and timestamps ·
`isArchived` / `archivedAt` / `archiveReason` — **archive, never delete**,
because it parents frozen records a quotation or an audit may still reference.

It holds no cost, price, margin or supplier. That is what makes "a correction
creates a new version" enforceable rather than aspirational: there is nothing
commercial on this document to correct in place.

The context reference is **typed and inert**: not a mongoose `ref`, never
populated, and never consulted for company scope, permission or price.

### `CostingVersion` (`costing_versions`) — the frozen record

`companyId` + `costingId` (both required; the duplication is deliberate, so a
version read is scoped without first joining to its parent) · `versionNumber`
(monotonic, unique within a costing) · `status` (`DRAFT` / `APPROVED` /
`SUPERSEDED`; only `DRAFT` is reachable in this chunk) · `baseCurrency`
(frozen with the version) · `calculationSchemaVersion` (**0** — no calculator
ran, which is the truth, rather than a lie about schema 1) · immutable
`provenance` (origin, actor, time, requestId, idempotencyKey,
`supersedesVersionNumber`, note) · typed `sourceReferences[]` with per-source
`confidence` and a bounded `snapshot[]` · embedded `scenarios[]` — **container
only**, reserved for Chunk 2, with no computed field at all.

`CostingScenario` is **not** a separate collection: a scenario has no life
outside its version, is never queried across versions, and freezes and
supersedes with its parent. A second collection would buy a join and a way for
the two to disagree.

### Indexes

| Collection | Index | Why |
|---|---|---|
| `costings` | `{companyId, createdAt}` | the tenant-scoped list |
| `costings` | `{companyId, isArchived, status, updatedAt}` | the live list |
| `costings` | `{companyId, context.type, context.primaryId}` | "costings for this style" |
| `costing_versions` | `{companyId, costingId, versionNumber}` **unique** | version numbering; scoped, never global — version 1 exists in every costing |
| `costing_versions` | `{companyId, costingId, createdAt}` | the history read |

No global uniqueness on tenant data. Company leads every index, because a
compound index whose leading field is not the tenant scope is one the scoped
query cannot use.

### Money

Integer minor units plus a currency (`services/centralCosting/money.js`), never
a float — the roadmap invariant, and the drift the legacy
`+(a + b).toFixed(2)` in `services/costingTotals.js` cannot avoid. Currency is
validated against a supported allowlist (INR, USD, EUR, GBP, AED), not merely a
three-letter pattern. **Missing ≠ zero:** absent input returns `undefined`;
`null`, `""`, floats, numeric strings, `NaN` and `Infinity` are refused rather
than coerced to 0. Negative amounts are allowed — a credit is real. A source
amount in a currency other than the version's base is refused, because
converting it would need an FX policy that does not exist yet.

## 6. The API and its visibility layer

```
POST /api/costings              → costing.draft.write, Idempotency-Key required
GET  /api/costings              → any costing capability
GET  /api/costings/:id          → any costing capability
GET  /api/costings/:id/versions → any costing capability
```

Mounted **once**, at a neutral top-level URL. No competing endpoint under
Sales. The existing Enquiry costing routes are untouched.

`POST` derives company and actor server-side, validates the typed context for
shape without trusting it for scope, and creates the costing and version 1
**atomically or not at all** — a transaction where the deployment supports one,
otherwise version-first with a compensating delete, so the only half a crash
can leave behind is the **unreachable** one (no read path can reach a version
whose parent does not exist). The mode is reported as
`atomicity: {mode, degraded}` rather than an atomicity claim the deployment
does not provide.

Idempotency reuses `SpIdempotencyRecord` and
`services/storePurchase/idempotency.service.js` — domain-neutral by
construction (`{companyId, actorId, operation, key}` plus a canonical body
hash). The effect marker is written **with** the create, so a lost response
cannot become a second costing; a recovered claim is answered with a
reconciliation conflict naming the costing, never by creating another.

**One serializer.** Every payload on every endpoint comes from
`services/centralCosting/visibility.js`. A route chooses *which* object to
serialize; it may not choose what a version looks like on the wire. Confidential
content is grouped into blocks, each keyed to exactly one capability:

| Block | Capability | Contains |
|---|---|---|
| `cost` | `costing.cost.read` | source references and their snapshots — supplier prices, rates |
| `margin` | `costing.margin.read` | margin (reserved for Chunk 2) |
| `output` | `costing.output.read` | the approved commercial number |

A withheld block is **omitted**, never nulled — a null would say "this costing
has no cost", which is a different and untrue statement (the reasoning
`crmCostVisibility.reduceCostLedger` already gives for deleting rather than
zeroing). `visibility.withheld` names the withheld **blocks** so a client can
render "you do not have access" instead of "not costed yet"; it never leaks a
value or a count. A block that is permitted but uncalculated is present with
`calculated: false` and no totals.

**A draft is invisible to an output-only reader.** `costing.output.read` is
permission to read approved output; a draft has none, and serving the envelope
anyway would tell Sales that somebody is costing the Acme blazer and how often
they have revised it. So a draft, to that caller, returns the identical `404` a
missing costing returns — in the detail read, the version list and the list
endpoint alike.

## 7. Immutability

- No `PUT`, `PATCH` or `DELETE` exists on a version or on a costing's
  commercial content.
- The **model** refuses it too, so the promise holds for a route that has not
  been written yet, a migration script and a REPL session: `pre("save")` and
  the `updateOne` / `findOneAndUpdate` / `updateMany` hooks reject any change
  outside `status`. `status` is the single exception, because a version
  legitimately becomes approved and later superseded **without its content
  changing** — and Chunk 6, not this chunk, is what may move it.
- A correction is version *N+1* carrying `supersedesVersionNumber`.

## 8. Unresolved business decisions

1. **Which departments hold which costing capabilities.** Store, Inventory,
   Merchandising, R&D, Project Management and the accountant module are all
   currently granted nothing. Until this is decided, only platform admins and
   the CEO authority can create a costing.
2. **Whether `costing.draft.write` should imply `costing.cost.read`.** Today it
   does not: each block is keyed to exactly one capability, so a drafter
   without `cost.read` cannot read back the source snapshots they recorded.
   That is harmless while versions are empty and is a real question once the
   Chunk 2 calculator exists.
3. **Who populates `SpCompanyMembership` for non-Store staff**, and whether it
   should be renamed to a neutral `CompanyMembership` at that point (§9).
4. **Whether accountant-module users need costing access**, and if so through
   which door — they arrive with a different token and a different user record.
5. **Whether a costing needs a company-scoped human-readable number** (a
   document sequence, as Store's PO has). Not added: nothing in Chunk 1 needs
   one, and inventing a numbering scheme before the approval workflow exists
   would fix a format the business has not chosen.

## 9. Replacing the adapter without touching costing documents

Nothing in a `Costing` or `CostingVersion` refers to Store. `companyId` is an
`Acc_Company` reference, which is the company master both domains already use.
When a general company-membership model arrives:

1. it replaces the body of
   `services/companyContext/companyMembership.service.js` — the one place that
   reads the membership collection;
2. both callers keep their current signatures and behaviour;
3. no costing document changes, no index changes, no API-envelope change.

Two further couplings are recorded rather than left to be discovered, both
mechanical renames for a later chunk:
`services/storePurchase/errors.js` (the refusal envelope) and
`services/storePurchase/idempotency.service.js` + `SpIdempotencyRecord` (retry
semantics) are domain-neutral infrastructure living under a domain folder.
Costing reuses them instead of creating a second refusal shape and a second set
of retry semantics.

## 10. What Chunk 1 deliberately did not do

No calculator, no totals, no margin or markup, no company costing policy, no
supplier offers or price tiers, no BOM/SAM/wastage/operation integration, no
economies of scale, no approval workflow, no Sales quotation, no budget/PO/
voucher integration, no Store security cleanup outside what this chunk uses,
and **no change to `Enquiry.costingSheets`** — its data, routes and behaviour
are untouched. `services/centralCosting/legacyEnquiryCostingAdapter.js` is the
seam Chunk 2 imports through: pure mappings, tested, wired to nothing, and
dual-writing nothing.

No frontend production file changed. There is no costing screen in this chunk,
so no browser verification is claimed.
