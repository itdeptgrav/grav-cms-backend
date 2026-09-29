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

---

# Amendment 1 — Chunk 1 hardening pass (4 Sep 2026)

A review of the implementation above found six defects. They are corrected in
code and the affected statements in §§2, 5, 6 and 7 are superseded here rather
than edited in place, so what was originally decided stays readable.

## A1.1 — Duplicate creation survived a partial failure (§6 superseded)

**Was:** "The effect marker is written *with* the create, so a lost response
cannot become a second costing." That was wrong. The marker is a **second
write**, and a second write can fail:

```
costing + version commit → marker write fails → 500
→ the claim is released → the retry creates a SECOND costing
```

**Now:** the costing itself carries `creationClaimId` — a SHA-256 of
`{companyId, actorId, operation, idempotency key}`, derived on the server,
written **in the same insert as the costing** — under a company-scoped unique
**partial** index (partial, not sparse: a compound sparse index still indexes
documents that have any of its keys, and `companyId` always does). A second
costing for one user action is impossible at the database, not merely
unlikely.

`POST /api/costings` now looks the claim up **before** creating, on every
attempt — not only when the bookkeeping says the effect landed — and returns
the existing costing and its versions with `200`, `recovered: true` and
`Idempotency-Recovered: true`, then settles the record so the next retry is a
plain replay. A lost race on the index is caught and recovered the same way.

The costing also stores `creationRequestHash`. The idempotency record is
retained for thirty days; the costing is retained forever, so this is what
keeps "same key, different payload" a `409 IDEMPOTENCY_KEY_REUSED` after the
record has aged out.

The recovery **replaces** the previous `CONFLICT / RECONCILIATION_REQUIRED`
answer for an `EFFECT_APPLIED` retry. Refusing was safe but unhelpful: the
caller's action *had* succeeded, and telling them to go and find it was worse
than handing it back. The effect marker is still written, immediately, as a
second line of defence — it is simply no longer the guarantee.

Transactional creation is unchanged and still atomic. In compensated
(standalone) mode the parent is still inserted second, so a claim collision —
like any other parent failure — triggers the compensating delete and version 1
is never left behind.

## A1.2 — A broken lookup could be mistaken for an answer (§2 extended)

Three queries in `services/companyContext/companyMembership.service.js` ended
in `.catch(() => [])` / `.catch(() => null)`. That collapsed two different
facts — "the query returned nothing" and "the query failed" — into one, and it
had two consequences. The mild one: a user with a perfectly good membership
was told their account is not linked to a company. The serious one: the
single-company fallback's premise is *"no membership row exists for anybody"*,
and a failed existence check counted as satisfying it — so **breaking the
database was a way to manufacture the fallback**. A fail-closed rule that can
be opened by causing an error is not fail-closed.

**Now:** every identity query runs through `unavailableOnFailure(...)`, which
takes a **thunk** (a mongoose call can throw synchronously, and passing an
already-built query would let that escape the handler written to catch it) and
converts any failure into a stable `503 COMPANY_CONTEXT_UNAVAILABLE` — a code
no caller can confuse with `TENANT_MEMBERSHIP_UNPROVEN` or `FORBIDDEN`. The
cause is logged for an operator, never described to the client. **The fallback
is only considered after both identity queries have succeeded.**

The same rule is applied to the company lookup inside the new context
resolver. Store & Purchase's resolution is unchanged in every succeeding case.

*Not changed, and noted:* the capability lookups in
`services/{centralCosting,storePurchase}/capabilities.js` still swallow their
errors. That direction fails **closed** (a database failure denies rather than
grants), so it is not the same hole; it is misleading rather than unsafe, and
narrowing it touches Store's shared path. Recorded as future work.

## A1.3 — Clients could certify their own sources

`confidence: "VERIFIED"` was accepted from a request body. `VERIFIED` means
the server checked something against a master — a supplier quotation with a
validity, an approved rate table. Nothing typed into a request has been checked
by anybody, and Chunk 5's economies-of-scale rules and Chunk 8's variance
analysis both read this field: a self-certified row poisons them silently,
years later.

**Now:** a client-supplied `VERIFIED` is **refused** with
`CONFIDENCE_NOT_CLIENT_SETTABLE` rather than downgraded in silence — a caller
who asked for it must learn it did not happen — and an API source is
`PROVISIONAL` whether or not it says so. `VERIFIED` requires **both**:

1. `parseCreateRequest(body, { trusted: true })`, an internal option the router
   never passes and never derives from a request value; and
2. a service context (`companyContext.forService({companyId, reason})`), which
   no request can construct — asserted a second time inside the creation
   service, on the far side of the parser.

## A1.4 — Context types narrowed to what the server can prove (§5 superseded)

Enabled at the API: **`ADHOC`** and **`ENQUIRY_STYLE`**.
Refused: `STYLE`, `ORDER`, `SAMPLE_STYLE`, with a stable
`CONTEXT_NOT_SUPPORTED_YET` — distinct from `VALIDATION`, because the caller
has made no mistake. The stored enum keeps all five, so a later chunk enables
one without a data migration.

`ENQUIRY_STYLE` is resolved by
`services/centralCosting/contextResolver.service.js`, **after** the company:
the actor's company comes from their own membership, the enquiry is looked up
within it, its existence is proved, the product key is checked against
`products[].product`, and the display snapshot is built from the document.
A client-supplied `label`/`contextSnapshot` for this type is refused
(`CONTEXT_SNAPSHOT_SERVER_GENERATED`) rather than silently discarded. Missing
and foreign-company enquiries return the identical `404`.

**The conflict this exposed, stated rather than papered over:** `Enquiry` has
no `companyId`, and neither does `CRMAccount` or `SalesJourney`. An enquiry
therefore *cannot* be proved to belong to the actor's company today. Looking it
up unscoped and calling that validated would be exactly the unsafe adapter this
chunk refuses to build — in a multi-company deployment it would let one company
raise costings against another's enquiries and snapshot their buyer into them.

So an unowned Sales record is treated as every other unowned record is: usable
only where ownership cannot be ambiguous. If the document carries a
`companyId`, it must match. If it does not, the reference is accepted **only**
when the company master holds exactly one company (`scopeProof:
"SINGLE_COMPANY_DEPLOYMENT"`, frozen into the snapshot so a later reader knows
what the check was worth); otherwise it is refused with
`CONTEXT_SOURCE_NOT_COMPANY_SCOPED`. When Sales gains company scope, the first
branch becomes the only branch and nothing else in costing changes. **In no
case does the enquiry contribute to which company the actor belongs to.**

## A1.5 — Versions are now frozen completely (§7 superseded)

**Was:** "`status` is the single exception, because a version legitimately
becomes approved and later superseded without its content changing."

True, and beside the point: that transition is a **controlled act** needing an
approver identity, a decision, a time, a reason and a margin-policy check — all
Chunk 6's. Leaving the field writable meant the only thing between a draft and
an "approved" costing was that nobody had written the line of code yet.

**Now:** every persisted version is immutable including `status`, guarded on
`save`, `updateOne`, `updateMany`, `findOneAndUpdate`, `replaceOne` and
`findOneAndReplace`. No bypass was added for Chunk 6 to build on quietly; it
will introduce an explicit transition service. (`replaceOne`/`findOneAndReplace`
with `upsert` that *inserts* is a creation, not a rewrite, and is allowed.)

**Two limits, stated plainly:** these are mongoose middlewares. They cannot
stop an authorised administrator with a shell on the database — that is what
database roles, backups and audit are for — and nothing here should be read as
claiming otherwise. They also do not cover `Model.bulkWrite`,
`Model.collection.*` or a raw driver handle, which bypass mongoose middleware
by design. Rather than build elaborate protection for paths nothing uses, the
boundary is enforced by convention and written down: **no production costing
code may write a version through a bulk or raw-collection path.** The only
writer today is `services/centralCosting/costingCreation.service.js`, using
`Model.create`.

## A1.6 — Money rules moved into the model as well as the parser

The request parser was the only thing enforcing them, and Chunk 2's legacy
import, Chunk 3's supplier-offer snapshotting and any background job write
these documents **without** passing through it.

Asserted now at the schema, so every writer passes them: `amountMinor` must be
a finite **safe** integer (beyond 2^53 addition silently stops being exact, and
a costing that cannot be summed is not a costing); currency stays allowlisted;
a numeric fact must be finite (`NaN` from a bad division looks like a
measurement); and each source fact must carry **exactly one** of `text`, `num`
or `money` — two makes "which is the real value" a question every reader
answers differently, none is a labelled blank pretending to be a snapshot.
Zero remains valid and distinct from missing.

## A1.7 — What this pass did not do

No calculation engine, no scenario arithmetic, no margin, no costing policy, no
supplier offers, no approval transition, and no change to
`Enquiry.costingSheets`. Chunk 2 has not been started. No frontend file
changed.

---

# Amendment 2 — Chunk 1 hardening, second pass (4 Sep 2026)

Two defects in Amendment 1's own corrections. Both are closed; A1.4 and A1.5
are superseded to the extent stated here.

## A2.1 — `ENQUIRY_STYLE` was an existence oracle (supersedes part of A1.4)

**Was:** the resolver fetched the enquiry first and decided whether it was
allowed to afterwards. In a multi-company deployment the refusal therefore
varied with what the fetch found:

```
an enquiry id that exists      → 400 CONTEXT_NOT_SUPPORTED_YET
an enquiry id that does not     → 404 NOT_FOUND
```

Contents were never disclosed, but existence was — and existence is enough.
Anyone who could reach `POST /api/costings` could enumerate other companies'
enquiry ids one guess at a time. **A refusal that varies with the secret is not
a refusal.**

**Now:** the scoping question is settled *before any enquiry is read*, and from
two things that are not the enquiry — the **model's schema** and the **company
master**:

1. `enquiryIsCompanyScoped()` asks whether `Enquiry.schema.path("companyId")`
   exists. This is deliberately a property of the MODEL, never of a fetched
   document: it is the only form of the question that can be answered without
   fetching one. It also behaves correctly mid-migration — once the path
   exists the scoped query is used, and a document not yet backfilled simply
   does not match, which is fail-closed.
2. If the model is scoped → **one query** combining `_id`, `companyId` (from
   the resolved context) and `isActive`. No "find it, then check it": foreign,
   missing and inactive are one answer, and no foreign document is ever held in
   memory.
3. If the model is not scoped → the company master is asked whether this is a
   sole-company deployment. If it is not, `CONTEXT_SOURCE_NOT_COMPANY_SCOPED`
   is returned **with no enquiry query at all**, so every caller gets the
   identical body whatever id they guessed.
4. Only after step 3 proves a sole-company deployment is an unscoped lookup
   performed — and only then, because there is no other company the enquiry
   could have belonged to.

The enquiry still contributes nothing to company selection, and there is now
no path on which it could: the company is fixed before the first read.

## A2.2 — Replacement had a check-then-write race; deletion had no guard (supersedes part of A1.5)

**Was:** `refuseReplace` called `Model.exists(filter)` and allowed the write
when nothing was found, so that an upsert which *inserts* could pass. That is a
check-then-write race with a real losing case — the check says "absent", a
document is inserted in the interval, and the replacement overwrites it. The
window is small; the consequence is the total loss of a frozen audit record.
There was also **no deletion guard at all**, so `deleteOne` and its siblings
could erase a version outright.

**Now:**

- `replaceOne` and `findOneAndReplace` are refused **unconditionally**,
  upserts included — no query, so no race. The upsert-insert case was not worth
  protecting anyway: a version created through a replacement API would have had
  no number allocated, no provenance stamped and no parent pointer maintained.
  New versions come from the creation service (and, from Chunk 2, the version
  service beside it).
- `deleteOne` (both the query-level and the separately-registered
  document-level middleware), `deleteMany` and `findOneAndDelete` are refused;
  `findByIdAndDelete` is covered because mongoose routes it through
  `findOneAndDelete`. A persisted version is audit history — a quotation may
  have been priced from it. "Remove the wrong one" is the instinct that
  produces an edited invoice; the answer is to supersede, not to erase.
- The compensated-create cleanup survives through **one** narrow function,
  `CostingVersion.deleteOrphanVersion({_id, companyId})`. It is **not a bypass
  flag**: a `{force:true}` option would be one careless `...req.body` away from
  being reachable from a request, and a mutable "allow the next delete" switch
  would additionally be wrong under concurrency. There is no flag. The
  narrowing is a fact the function verifies for itself immediately before
  acting — the version must exist in the named company, and **its parent
  costing must not exist**. A version whose parent exists is refused, whoever
  asks. Neither check reads anything a client sent.

### The boundary, honestly

These are mongoose middlewares. They cover every path this codebase uses. They
do **not** stop an authorised administrator with a shell on the database — that
is what database roles, backups and audit are for — and they do not cover
`Model.bulkWrite`, `Model.collection.*`, aggregation `$merge`/`$out` or a raw
driver handle, which bypass mongoose middleware by design.

Rather than build elaborate protection for paths nothing uses, the boundary is
stated and enforced by convention. There are exactly **two** writers of a
costing version in this repository, both named in `CostingVersion.js`:

1. `services/centralCosting/costingCreation.service.js`, via `Model.create`;
2. `deleteOrphanVersion`, the single deliberate raw-driver write in the domain,
   confined by its own checks to a version no read path can reach.

Anything added later must go through a model method so these guards apply.

---

# Amendment 3 — Chunk 2 correction pass (4 Sep 2026)

The Chunk 2 calculator was correct; six guarantees *around* it were not. Each
is fixed at its source rather than hidden behind a screen.

## A3.1 — An absent policy was rendered as a 0% margin decision

**Was:** `getPolicy` returns defaults (0/0/0) with `configured: false` so a READ
has something to show. The calculator consumed those defaults, so a company
that had never opened the policy screen could freeze an immutable, quotable
version whose recommended selling price equalled its cost. Nobody decided that;
it was the *absence* of a decision, published as one.

**Now:** `policyService.assertConfigured()` refuses with
`409 COSTING_POLICY_REQUIRED` — "Set the company costing policy before
calculating a selling price." It is enforced in `createNextVersion` (so no
route can bypass it) and again at the top of `POST /:id/versions` before the
body is parsed, so the caller gets the true answer rather than a validation
error about a cost line. The legacy import obeys the same rule. Nothing is
written, the parent pointer does not move, and the refusal releases the
idempotency claim, so the same key works once policy exists.

**A policy explicitly saved with 0% margins remains valid.** "Nobody has
decided" and "we have decided to quote at cost" are different states;
`configured` is what distinguishes them, and only the first is refused.

## A3.2 — An idempotency key was bound to the payload, not the costing

**Was:** the fingerprint covered the body alone. The same cost lines posted to
costing A and costing B are byte-identical bodies. Worse, the durable
creation-claim lookup was scoped to the costing in the URL while the unique
index over the claim is company-wide — so a key reused against a second costing
found nothing, went on to create, lost the index, and surfaced as a **500**.

**Now:** `withIdempotency` takes a server-derived `target` resolver;
`POST /:id/versions` and `POST /:id/versions/legacy-import` pass
`costing:${req.params.id}` — from the URL, never the body. The target is in the
temporary record's fingerprint **and** stored on the version as
`provenance.creationClaimTarget`.

The claim id deliberately still excludes the target. Folding it in would make
the same key aimed at costing B a *different* claim, so once the 30-day
bookkeeping row expired the reuse would quietly succeed. Left out, the claim
collides, `findByCreationClaim` (now company-scoped, agreeing with the index)
finds it, and the handler compares the target and answers a stable
`409 IDEMPOTENCY_KEY_REUSED` — before and after the row's expiry. Store &
Purchase fingerprints are unchanged.

## A3.3 — A recovered version could stay disconnected from its parent

**Was:** without a transaction the version is inserted first and the pointer
moved second — the safe order. But "stale until the next successful write" was
too weak: a recovered retry returned the version while `GET /api/costings/:id`
still reported the previous one as current, so one costing read two different
ways.

**Now:** `versionCreation.repairPointer()` runs before recovery answers, in
both the manual and legacy-import paths. It reuses the same `$lt` version-number
guard as an ordinary write, so it is forward-only and a repair for version 4
arriving after version 5 landed changes nothing.

## A3.4 — Calculated money had no schema-level contract

**Was:** the request parser refused malformed money; the engine's own output,
the legacy import and any future job wrote plain `Number` paths that accepted
412.5 paise, `Infinity`, and integers past 2^53 where addition stops being
exact.

**Now:** one helper, `minorUnits({ required, allowNegative })` in
`costingCalculation.js`, applied to **every** persisted `*Minor` field:
category totals and per-unit totals, line rates, basis amounts, tax, line
totals and per-unit amounts, scenario total/unit/fixed/variable/tax/rounding,
selling prices, and comparison deltas. It **validates and never repairs** — no
setter, because a setter that rounded 412.5 to 413 would turn a caller's bug
into a wrong number nobody could find. Absent stays absent (no defaults on
uncalculated fields), so missing and zero remain different.

Negativity is decided per field by domain meaning, not by a blanket rule.
`priceMinor` and `sellingPriceIncrementMinor` reject negatives — there is no
such thing as a selling price below nothing. Everything else permits them,
because `money.js` already allows a negative rate (a credit, a rebate, a
correction), and a credit line legitimately makes its line total, its category
total and the scenario totals negative; deltas and rounding adjustments are
negative in the ordinary case.

## A3.5 — `TOTAL_COST` was an option that could never be chosen

**Was:** the basis listed every category, so it always included the category of
the line selecting it. Every percentage line using it was refused as circular —
not a narrow failure mode, an option that could never once work.

**Now:** removed from the engine, the API and the UI. Nothing can have been
stored under it, because every attempt was rejected, so it is deleted rather
than deprecated. In its place:

| Basis | Contains | For |
|---|---|---|
| `SUBTOTAL_BEFORE_OVERHEAD` | every cost except **overhead and financing** | what overhead is charged on |
| `SUBTOTAL_BEFORE_FINANCING` | every cost except **financing** — so it **includes overhead** | what financing is charged on, after overhead |

Overhead using `SUBTOTAL_BEFORE_FINANCING` is still refused: that subtotal
includes overhead, and a percentage of a total that includes itself is a
simultaneous equation this engine deliberately does not solve. Direct and
indirect cycles are both still refused by the dependency walk.

## A3.6 — Concurrent policy edits silently overwrote one another

**Was:** the API sends the whole policy back because the screen edits it whole,
and the write was last-writer-wins. Two people at revision 4 — one raising the
overhead rate, one lowering the minimum margin — and the second save writes its
stale copy of the first's field back over it. Nothing errors.

**Now:** optimistic concurrency. `GET` returns `revision`; `PUT` must carry the
revision it was composed against (a write without one is refused rather than
assumed current); the update **condition** is `{companyId, revision}`, so a
stale writer matches nothing and the newer policy is never touched. A mismatch
is `409 POLICY_REVISION_CONFLICT` carrying the current revision. The first
write is an insert, and two simultaneous first writes are settled by the
company-unique index — the loser gets the same conflict rather than
overwriting. A successful change increments `revision` exactly once. The
frontend explains that the policy changed elsewhere and offers a reload; it
never silently re-sends the stale object, which is the overwrite the check
exists to prevent.

## A3.7 — Four defects the correction pass itself left behind (4 Sep 2026)

Found on review of the corrected code. Amendment 3's six items stand; these are
gaps in how two of them were wired, plus one the engine never covered.

### A3.7.1 — The legacy import's idempotency was not durable

**Was:** `POST /:id/versions/legacy-import` bound its *temporary*
`SpIdempotencyRecord` to the costing (A3.2) but wrote no *durable* claim onto
the version it produced. The protection therefore lasted exactly as long as
that row: after its 30-day expiry — or a manual delete — the same key could be
spent again, on the same costing or on another one, with nothing left to
notice.

**Now:** the route passes `{claimId, requestHash, target}` into
`importLegacySheets`, and the service checks the durable claim **before** it
writes: a claim already spent on this costing with this payload recovers the
original version (repairing the parent pointer on the way), and one spent on a
different costing is `409 IDEMPOTENCY_KEY_REUSED`. A concurrent collision on
the claim index is caught by name and resolved the same way, so it is never a
500. Content deduplication through `legacyImportKey` is untouched and still
answers its own, different question: the claim asks "has this *action* already
happened?", the content key asks "has this *sheet, in this state*, already been
frozen?" — which is why an edited sheet still becomes a new version.

#### A3.7.1a — …and it lapsed for every key that did not create the version

**Was:** A3.7.1 bound the legacy import's *creating* key durably. It did not
cover the import's other way of succeeding. A DIFFERENT key importing an
UNCHANGED sheet is answered from content deduplication: the sheet's hash
already matches a frozen version, so that version is returned rather than
duplicated. That second key never touched `provenance` — it cannot, the version
is immutable and belongs to the first key — so its only trace was the temporary
`SpIdempotencyRecord`. Once that expired or was deleted the key had no history
at all and could be spent again against another costing. The permanent binding
held for the first key and quietly lapsed for every alias.

**Now:** a claim **receipt** — `models/CMS_Models/Costing/CostingClaim.js`,
collection `costing_claims`, unique on `{companyId, claimId}` — records that a
key resolved to a version, with the costing, target, request hash and resolved
version id.

*Why a collection and not a field:* the relationship is many-to-one. Any number
of keys may legitimately resolve to one version, and recording them ON the
version would mean appending to a frozen document on every alias — mutating
immutable content to store something that is not part of the costing. A receipt
is bookkeeping ABOUT a key, not content OF a costing.

*Why both records are kept, and which protects what:*

- an **embedded claim** protects the key that CREATED a version. It is written
  in the same insert as the version, so no created version can lack it, and it
  is what makes a retry safe after a crash.
- a **durable receipt** protects a key that RESOLVED THROUGH CONTENT
  DEDUPLICATION. Such a key creates nothing and can never be recorded on the
  version it resolves to — that version is frozen and belongs to another key.
  The receipt is its only binding.

`resolveClaim()` consults the receipt first and falls back to the embedded
claim.

*A receipt is a pointer, never an authority.* It names a version; it never
authorises one. The version is loaded under the caller's own company scope like
any other read, and a receipt whose version has since gone is treated as no
receipt rather than a dangling promise.

Two concurrent imports under different keys produce one version and two
receipts. Request-hash matching is unchanged: a corrected payload under the same
key is still `409 IDEMPOTENCY_KEY_REUSED` and still needs a fresh key.

#### A3.7.1b — …and the receipt was written on a best-effort basis

**Was:** `recordClaimReceipt()` caught a non-duplicate write failure, logged it
and returned `{recorded: false, reason: "WRITE_FAILED"}`. The legacy import
ignored that result and returned success anyway, so the temporary
`SpIdempotencyRecord` was completed. Thirty days later that row expired and the
aliasing key had no durable record at all — free to be spent against another
costing. A3.7.1a described this as safely "degrading to the previous
behaviour"; it does not. It reinstates precisely the hole A3.7.1a was written
to close, while reporting success. **A durable guarantee cannot rest on a
best-effort write.**

**Now:** an alias operation cannot report success until its receipt is durable.

- `recordClaimReceipt(..., { mandatory })` distinguishes the two callers. For a
  key that created the version the receipt is a convenience — the embedded
  claim is the binding — and a failure is logged and tolerated. For an alias it
  is the guarantee, and a failure THROWS.
- The failure surfaces as `503 COSTING_CLAIM_PERSISTENCE_FAILED`: retryable,
  and an infrastructure fault rather than the caller's mistake. Because it is a
  4xx/5xx, the route's error path abandons the idempotency row instead of
  completing it, so the refusal never becomes a replayable success.
- **The retry does not repeat the work.** The version already exists; the retry
  finds it by content hash, writes the receipt that failed, and returns the
  same version with `recovered: true`. No second version is ever created.

**Duplicate keys are verified, not assumed.** `11000` means only "that claim id
is taken" — it says nothing about what it was taken FOR. The existing row is
now loaded (company-scoped) and compared on company, costing, version, target,
request hash and operation. All agree → an idempotent success. Anything differs
→ `409 IDEMPOTENCY_KEY_REUSED` with a stable reason. A row that lost the index
and then vanished proves nothing either way, and a mandatory caller is refused
rather than told it succeeded.

The tenant rules are unchanged: receipts are read and written company-scoped, a
receipt is a pointer and never an authorisation, and the version it names is
loaded under the caller's own company context.

**One thing this deliberately does not do.** The same raw key spent on a
*different operation* is a different claim, and stays one. `operation` has been
part of the claim identity since Chunk 1 and is part of the shared
`SpIdempotencyRecord` unique index that Store & Purchase depends on; changing
it here would silently alter their semantics. It is not a way around the
binding — a key suppresses duplicates, it does not authorise anything, and a
caller who may calculate could equally use a brand-new key. A test asserts this
explicitly so the next reader does not mistake it for a gap.

### A3.7.2 — `provenance.creationClaimTarget` was declared and never written

**Was:** A3.2 added the field and the reasoning for it; the edit that was
meant to populate it silently matched nothing, so both call sites passed only
`{claimId, requestHash}`. The field was always empty and the cross-costing
check leaned entirely on `costingId`. The behaviour A3.2 claimed was correct —
the field backing it was dead.

**Now:** both the manual and legacy paths pass `target: req.idempotent.claimTarget`,
derived from the URL by `versionTarget` and never from the body. One shared
`claimMismatch(existing, costing, claim)` in `versionCreation.service.js`
compares `costingId`, then the stored target, then the request hash.

**Old versions carry no target, and that is handled rather than punished.** An
empty stored target falls back to the company-scoped `costingId` comparison,
which is exactly as strict about the thing that matters: such a claim can still
only recover its own costing and can never authorise another.

### A3.7.3 — Credits could invert a scenario's cost

**Was:** negative line rates are allowed on purpose — a rebate, a
buyer-supplied trim credited back, a correction — and nothing stopped the
credits exceeding the costs. A negative unit cost then went straight into
`price = cost / (1 - margin)`, producing negative "selling prices" in a band
ordered backwards: a recommendation to pay the buyer, presented with exactly
the same confidence as a real one.

**Now:** the engine refuses a negative scenario total, **after** the total and
**before** any price, with `NEGATIVE_NET_COST` and the scenario key, quantity
and calculated total in `details`. It surfaces through the route as a
controlled `400 VALIDATION` (the route already maps `CostingEngineError` that
way), writes no version, moves no pointer, and releases the idempotency claim —
so the same request may be sent again and is refused freshly rather than
replayed. Individual negative lines remain valid; a rebate leaving the total
positive still calculates; a total of exactly zero is still valid and still
distinct from missing.

*One deliberate narrowing of the brief:* "release the claim so the corrected
request can reuse the same key" is honoured as far as the key contract allows.
The claim IS released (the record is marked `FAILED`, never `COMPLETED`), so
the same request runs again rather than replaying a refusal. A *corrected*
payload is a different request, and a key re-aimed at a different payload has
been `409 IDEMPOTENCY_KEY_REUSED` since Chunk 1. Weakening that to satisfy the
phrase would undo the protection the key exists for, so a corrected request
takes a fresh key.

### A3.7.4 — The policy screen still described the removed behaviour

**Was:** "Nothing has been set yet. Until it is, margins are zero — so a
selling price equals its cost." Accurate before A3.1 and false after it: the
server now refuses to calculate without a policy, so the sentence promised a
result nobody would get, and framed quoting at cost as a harmless default
rather than the commercial decision it is.

**Now:** "Nothing has been set yet. Costings cannot calculate a selling price
until this policy is saved. Setting a 0% margin here is a valid choice — but it
has to be a choice."

---

# Amendment 4 — Chunk 3A: the supplier-data security gate (4 Sep 2026)

A prerequisite chunk. Chunk 3 attaches confidential supplier quotations and
item prices to costings; this establishes, first, that the facts it reads
belong to the company reading them. **No supplier-offer model was built.**

## A4.1 — Enquiry ownership (supersedes A2.1's "Sales records carry no company")

A2.1 recorded that `Enquiry`, `CRMAccount` and `SalesJourney` carried no
company, and that costing therefore accepted an enquiry only in a sole-company
deployment. `Enquiry.companyId` now exists.

**Where it comes from:** the creating actor's server-owned membership, or the
documented single-company deployment rule — through
`services/companyContext/ownershipStamp.service.js`. Never from the request.
`companyOwnership.{source,proven}` records which, so a company PROVED by a
membership is distinguishable from one inferred because there was no other
candidate.

**Why it may be null.** Sales is live and most of its users have no membership
row. A resolver that threw would stop them opening an enquiry, and refusing to
create business records to improve a boundary costing enforces on its own read
path is the worse trade. So an enquiry may be created UNOWNED with the reason
recorded — which is not "owned by everybody". Costing treats it exactly as the
tenant rules treat any unowned record.

**The rule costing applies**, in one query containing `_id`, `isActive` and the
resolved company: an unowned enquiry is usable only where ownership cannot be
ambiguous — a sole-company deployment, checked against the COMPANY MASTER
before any enquiry is read, so the answer cannot vary with the id supplied.
Once a second company exists an unowned enquiry fails closed as **NOT FOUND**,
indistinguishable from one that never existed. That is stronger than the
`CONTEXT_SOURCE_NOT_COMPANY_SCOPED` refusal it replaces, which said why.

`scripts/migrations/backfill-enquiry-company.js` settles legacy enquiries for
single-company deployments only. It defaults to a dry run, refuses a
multi-company database outright — nothing in the data says which company an old
enquiry belonged to, and picking one would be inventing ownership for
confidential records — and **has not been run**.

*Not done, deliberately:* the Sales-side Enquiry list/detail/update routes are
NOT company-scoped. Scoping them strictly before the backfill runs would hide
every existing enquiry from Sales; scoping them loosely would be a boundary in
name only. Costing does not depend on them — it does its own scoped resolution
— so the gate does not rest on it. It is recorded as remaining Store/Sales risk.

## A4.2 — One door between costing and Store

`services/centralCosting/storeFacts.service.js` is the only way costing reads
Store facts. Every function takes an explicit `{companyId, reason}` service
context, puts the company in the SAME query as the id, and returns plain
objects rather than models a caller could re-query from. There is no overload
that omits the company.

It exposes supplier identity, item and variant identity, purchase UoM,
conversion facts and the legacy alias price — and nothing else. A conversion
whose target unit belongs to another company is DROPPED, not returned: a
cross-company factor is not a fact this company may use, and including it would
put another company's arithmetic into a costing. Conversion arithmetic is not
reimplemented here; only the declared facts are returned.

The alias price (`variant.vendorNicknames[].price`) is returned as
`confidence: "PROVISIONAL"`, `evidence: "LEGACY_ALIAS_FIELD"`, always, with no
way to ask for it otherwise. It is a mutable number somebody typed, with no
quotation reference, validity or MOQ — which is precisely why Chunk 3 exists.

**A gap this surfaced rather than papered over:** `RawItem` has no HSN code and
no GST rate at all. Chunk 3's roadmap entry requires an offer to record HSN/GST
and the tax-inclusive basis, so `tax.available: false` is reported instead of
empty strings that would read as "this item is zero-rated". Modelling them is
part of Chunk 3.

## A4.3 — `costing.draft.write` implies `costing.cost.read`

Chunk 1 kept the two strictly separate and listed the question as open decision
2. It is closed: a person cannot professionally edit a costing while unable to
read the inputs they are editing — they would type a fabric rate into a form
that then refuses to show them the fabric rate, and re-costing would mean
retyping every line from memory.

Resolved centrally in `services/centralCosting/capabilities.js`, not in a
screen: a frontend that grants itself a capability is a frontend that has
stopped agreeing with the server, and the server would strip the block anyway.

**It implies nothing else** — not margin, not approval, not policy. Building a
costing is not the same authority as knowing what the company adds on top,
deciding a costing is approved, or setting the floor others are measured
against. A Store grant of any rank still resolves to NO costing capability, and
Sales still receives `costing.output.read` only.

Open decision 1 (the operational owner of costing) stays open for Chunk 6.

## A4.4 — Chunk 3A's first implementation failed open (corrections, 4 Sep 2026)

Four defects, all of the same shape: a boundary that was described accurately
and enforced somewhere other than where the data was read.

### A4.4.1 — Ownership resolution returned `null` and let creation continue

**Was:** `ownershipStamp.service.js` never threw. Unresolved ownership returned
`companyId: null` and the enquiry was created anyway, on the reasoning that
refusing would stop Sales working and costing enforced the boundary on its own
read path. That is failing open. An unowned enquiry is a confidential
commercial record belonging to nobody, and "costing checks its own reads" is a
guarantee about one consumer offered as though it were a guarantee about the
record — the first other consumer to write `Enquiry.findOne({_id})` inherits it.
It also collapsed every resolver failure into `NO_MEMBERSHIP`, turning a
database outage into "ask an administrator for access": unfixable advice for a
problem that fixes itself.

**Now:** ownership is PROVEN or the record is not created, and the resolver's
own refusals are preserved — `409 COMPANY_SELECTION_REQUIRED` when the actor
holds several companies, `403 TENANT_MEMBERSHIP_UNPROVEN` when none can be
proved, `503 COMPANY_CONTEXT_UNAVAILABLE` when the lookup itself failed, `401`
with no actor. A `companyId` in a body, query or route parameter is never read.

Every `catch` in the enquiry router previously turned these into a generic
`500`; `answeredTenantRefusal()` now lets a structured refusal keep its own
status, because 409/403/503 are actionable answers and 500 is not.

### A4.4.2 — The source journey was claimable

**Was:** `/by-journey/:journeyRef` loaded the journey with no company scope and
then stamped the actor's company onto the enquiry created from it. Opening
another company's journey adopted their opportunity, and the adoption looked
like ordinary use.

**Now:** `SalesJourney` carries `companyId`, and the journey query itself
carries the resolved company, so a foreign journey is simply not found —
identically to one that never existed.

*Journey creation is deliberately not strict*, unlike Enquiry creation, and the
asymmetry is reasoned rather than convenient: an unowned journey is reachable
ONLY where exactly one company exists, and there is no other company to claim
it from there. With two companies an unowned journey is already unreachable, so
no enquiry can be created from it. Being strict would buy no boundary and would
stop Sales working on a deployment whose company master is not yet set up.
`bestEffortOwnershipFieldsFor` records what was decided, including that nothing
could be; the READ rule keeps it safe.

### A4.4.3 — Authenticated Enquiry operations were not scoped at all

**Was:** thirty-five bare `Enquiry.findOne({_id: req.params.id})` lookups.
Ownership was stamped and then never consulted.

**Now:** `services/companyContext/salesScope.service.js` builds the clause once
per request (memoised — the same request must not resolve two companies) and
every lookup in the router folds it in. `$and`, so a route's own `$or` cannot
displace the tenant clause. Also scoped: the Sales-wide pending-changes inbox,
which listed every company's pending costing changes; `lastUsedCostingTeam`,
which suggested another company's staff as a default; the background
stock-item unlink helper; and `/:id/change-log`, which read audit history by
entity id without ever loading the enquiry.

**The public costing-approval token route is deliberately NOT scoped**, and was
reviewed rather than converted. It runs for a customer with no CMS session, so
there is no actor to scope by, and taking a company from the record being
requested is the circularity the tenant rules refuse. What authorises it is the
token: a SHA-256 of an unguessable secret, single-use, time-bounded, with one
`null` answer for unknown, expired and redeemed alike — not an enumeration
path.

### A4.4.4 — Store facts returned unverified supplier references

**Was:** `itemFacts()` proved the RawItem's company and then returned
`primaryVendor`, `alternateVendors` and every `vendorNicknames[].vendor`
straight out of the document, with the alias price attached. A reference is a
fact about a SUPPLIER, not about the item, and a company-scoped item can carry
one to another company's supplier — through a migration, a copied record, or an
id typed in before the boundary existed. Chunk 3 will turn exactly these
references into quotations.

**Now:** every referenced supplier is resolved in one company-scoped query, and
anything that does not come back is **omitted** — not nulled and not annotated,
because saying "there is a supplier here you may not see" is still saying it
exists. An alias whose supplier is not ours leaves with it. Proving the
supplier is ours does not upgrade the number: it stays
`confidence: "PROVISIONAL"`, `evidence: "LEGACY_ALIAS_FIELD"`.

## A4.5 — Chunk 3A, third pass: the rest of the Sales chain (4 Sep 2026)

A4.4 scoped the Enquiry router and left the rest of the chain unscoped. An
ownership field is not a boundary until every read and write uses it.

**Strict SalesJourney ownership.** `bestEffortOwnershipFieldsFor` is **deleted**,
not merely unused: a general helper that makes ownerless writes easy is one the
next writer reaches for. Journey creation now uses the same contract as
Enquiry — 409 / 403 / 503 / 401, never `companyId: null`, never a company from
request input. The earlier argument for it (an unowned journey is only
reachable in a sole-company deployment, so it cannot be claimed) was true and
beside the point: an ownerless record becomes inaccessible the day a second
company appears, is a candidate for an incorrect backfill, and is precisely
what Chunk 3 will hang supplier quotations off.

**Every SalesJourney operation is scoped** — list, detail, update, stage
transitions, post-save reloads and the compensating delete. The owner
aggregation carries the company in its **initial `$match`**: filtering after a
global `$match` has already read every company's rows, and that pipeline groups
owner names, so it was listing other companies' staff.

**Internal services take an explicit context.** `services/companyContext/serviceScope.service.js`
requires `{companyId, reason}` and the caller must have obtained the company
from an already-authorised parent operation, never from the record being
fetched. Applied to `closingVerdict` (which read an enquiry by journey id with
no company at all, so a stage transition in company A could inspect company B's
order-closing state), `sampleStyleEmail` and `customerRequests`.

**A context outage is not "optional data unavailable."** Enrichment helpers
still swallow a genuinely absent record — a missing extra must not break a page
— but a `COMPANY_CONTEXT_UNAVAILABLE` is re-thrown. Returning `null` there says
"this enquiry has no images" when the truth is that nothing could be checked.

**Authorisation is not `style.enquiryId`.** The sample-style paths took the
enquiry id off the style and opened it. A style carrying a foreign enquiry id
therefore pulled that company's product images into an email. The lookup is now
scoped, and the public BOM-approval flow — which has no CMS actor — is given no
company and so is offered no enquiry-derived images at all. A smaller email
beats one company's photographs in another's.

**Reviewed public-token exception.** `resolveCostingApprovalToken` remains
unscoped, deliberately: a SHA-256 of an unguessable, single-use, time-bounded
secret, with one `null` answer for unknown, expired and redeemed alike. There
is no CMS actor to scope by and taking a company from the requested record is
the circularity the tenant rules refuse. It is on the guard allowlist with that
reason, and tested.

**A static guard.** `test/costing/sales-tenancy-guard.test.js` scans
`routes/`, `services/` and `Middlewear/` and fails on any direct `Enquiry.*` or
`SalesJourney.*` query outside the scope helpers. It found eleven the manual
sweep had missed. The allowlist is capped at eight entries and every entry must
carry a written reason.

### What is still NOT owned, and why the gate stays shut

`Account`, `Lead`, `Contact` and `SampleStyle` have **no `companyId` at all**.
Journey creation still loads its source account with a global
`Account.findById` (`salesJourneys.js`), so an actor can create a
company-owned journey from another company's account. Item 3 of this
correction — proving the journey's source record — **cannot be completed**
without adding ownership, stamping and a backfill to those models, and scoping
their own routers (`accounts.js`, `leads.js`, `contacts.js`, `sampleStyles.js`
— roughly 5,600 lines).

Adding the field without scoping those routers would produce exactly the defect
this pass exists to correct: an ownership field that is not a boundary. It is
therefore recorded as the blocking dependency rather than half-built.

## A4.6 — Chunk 3B1: ownership at the Sales customer source (4 Sep 2026)

### The hierarchy

    Company → Account / Lead → Contact → SalesJourney → Enquiry

`Account`, `Lead` and `Contact` now carry `companyId` and `companyOwnership`
(`source`, `resolvedAt`, `proven`) through the shared fragment in
`models/CMS_Models/Sales/companyOwnership.js`, with company-prefixed indexes —
company leads every one, because an index whose leading field is not the tenant
scope is an index the scoped query cannot use.

**Every level carries the company directly rather than inheriting it through a
join.** A Contact's company must be enforceable without loading its Account,
because enforcement has to happen in the same query as the selector and a join
cannot be. The direct field is the enforcement; agreement with the parent
Account is checked separately at write time. The two must never disagree, and
`SalesJourney` creation checks both.

### The claim path this closes

`assertUsableAccount` was `Account.findById(id)` with no company. A Journey was
then created, correctly stamped with the ACTOR's company, from a customer
belonging to somebody else — and the journey's own ownership being right is
what made it hard to see. The same was true of the source Lead, the primary
Contact and every commercial-party Account.

Journey creation now resolves **one** company decision at the top of the
handler and uses it for all of them: account, lead, contact (and its account
agreement), commercial parties, the auto-created Contact, and the Journey
itself. Ownership is no longer resolved twice in one operation — two
resolutions are two chances to disagree halfway through a write.

A foreign source is reported exactly as a missing one, and creates no Journey,
Contact or Activity.

### The legacy allowance is now a proof, not an option

`serviceScope.service.js` took `{ allowUnowned: true }` from the caller. That
is a boolean somebody typed — one careless `...req.body` from being reachable
from a request, and it unlocks precisely the records belonging to nobody.

`createServiceContext({companyId, reason, legacyAware})` now establishes the
allowance from the company master and marks it with a **symbol** on a frozen
object. A symbol cannot be JSON, cannot arrive in a request body, and cannot be
spread in from an options object. A lookup failure propagates as
`COMPANY_CONTEXT_UNAVAILABLE` rather than quietly becoming "no allowance",
which is a different fact.

### Backfill order

`scripts/migrations/backfill-sales-company.js` (Account, Lead, Contact) runs
**before** `backfill-enquiry-company.js`. The other order leaves a scoped
Journey pointing at an unowned Account, which reads as a missing customer
rather than as an unfinished migration. Dry run by default, refuses a
multi-company database, idempotent, **not executed**.

### What this chunk did NOT do

The complete Account, Lead and Contact route surfaces are **not** scoped — 114
direct queries across sixteen files. Scoping them is a chunk of its own.

Rather than allowlist sixteen files (which would switch the guard off for
exactly the code that most needs it) or claim a clean sheet, the guard is now a
**ratchet**: the known count is recorded per file and may only go down. A new
unscoped query, in a guarded file or a new one, fails the build. The file-level
exemption for `enquiries.js` is gone — its one public-token query carries a
line-level `tenancy-guard:reviewed-public-token` marker that excuses that query
and nothing else, and the rest of the file is scanned normally.

## A4.7 — Chunk 3B1 correction: the inventory reaches zero (4 Sep 2026)

A4.6 added ownership and closed Journey creation's foreign-source paths, but
left 114 direct Account, Lead and Contact queries unscoped behind a recorded
ratchet. **A ratchet records a problem; it does not enforce tenancy.** The
inventory is now zero.

### One company decision per request

`salesJourneys.js` resolved twice — `scopeFor(req)` for the source lookups and
`ownershipFieldsFor(req.user)` for the stamp. Two resolutions in one request
are two chances to disagree: a membership row changes between them and the
record is created owned by a company whose sources were never checked. It is a
small window and the failure is silent, which is the worst combination.

`ownershipFieldsFromScope(scope)` derives the stamp from the scope already
resolved and queries nothing; `scopeAndOwnership(req)` returns both from one
call. The account, lead, contact, commercial parties, generated Contact and the
Journey itself all use that single decision.

To make "once" assertable rather than merely intended, `salesScope` and
`ownershipStamp` require `companyMembership.service` as a **namespace** instead
of destructuring it — a destructured binding is fixed at require time and
cannot be observed. A test forces a second resolution to return a different
company and proves the resolver is called exactly once and the first answer is
what is stored.

### 114 → 0

Every list, search, dashboard count, aggregate, detail read, duplicate check,
hierarchy lookup, update, archive, restore, delete, conversion, contact lookup,
relationship lookup, enrichment, purge, PDF, email and WhatsApp helper now
carries the company in the same query as the selector. Aggregations carry it in
the **initial `$match`** — filtering after a global `$match` has already read
every company's rows, and the account-owner and lead-funnel pipelines were
grouping other companies' staff and counting their leads.

Updates use company-scoped `findOneAndUpdate`. A scoped read followed by an
unscoped update is not sufficient: the update is what changes the record, so
the company belongs in ITS filter.

Services without `req` take an explicit `{companyId, reason}` from the trusted
factory, obtained from an already-authorised parent operation and never from
the record being requested. Duplicate detection is `legacyAware` — it must see
records that predate ownership — and the factory grants that only where the
company master proves exactly one company, never on the caller's say-so.

### The guard is now zero-debt

`KNOWN_DEBT` is gone; the expected offender list is empty. Three scanner
defects were fixed at the same time:

- **comments are stripped before matching**, so prose mentioning `sourceScope`
  can no longer make an unscoped query look scoped;
- **a reviewed marker exempts the query it immediately precedes** — the scan
  walks back over the contiguous comment block and stops at the first line of
  real code, so a second query cannot inherit the exemption. A test proves it;
- **a scope passed as a parameter counts as scoped** (`$and: [scope, …]`),
  which is how a helper that receives an already-resolved clause is written.

**Remaining marker exemptions: exactly one** —
`resolveCostingApprovalToken` in `enquiries.js`, a lookup by SHA-256 of an
unguessable, single-use, time-bounded secret on a public route with no CMS
actor to scope by. `enquiries.js` itself is NOT allowlisted; the rest of the
file is scanned normally.

### Migration refusal semantics

`--apply` against zero or multiple companies now sets a nonzero exit code and
returns before any write. A dry run may still report that it cannot proceed and
exit zero. An `--apply` that printed a refusal and exited zero told a deploy
script the migration had succeeded, and the next step ran against half-migrated
data.

## A4.8 — Write integrity at the Sales source (5 Sep 2026)

A4.7 made every Account, Lead and Contact READ carry the company. Two write
holes survived it, and both start from a legitimate read.

**Ownership was reassignable.** A PATCH body carrying `companyId` passed the
scope check — the record *is* mine when it is read — and the write handed it to
another company. `{"companyOwnership.proven": true}` was the same move against
the audit trail, laundering a single-company inference into a membership
somebody supposedly proved. Two layers now: `stripCompanyOwnershipInput()` on
every create and update payload (plain, dotted and operator-wrapped forms), and
`sealCompanyOwnership()` on the three schemas, which refuses ownership in
`save`, `updateOne`, `updateMany`, `findOneAndUpdate`, `update`, `replaceOne`
and `findOneAndReplace`. The route layer alone is a convention, and A4.7 is the
proof that conventions do not hold; the model layer alone gives a 500 where a
quiet 400 belongs.

The seal compares a value snapshot taken at `post("init")`, not
`modifiedPaths()` — Mongoose marks a path modified when it applies a default to
a document loaded without it, so `isModified` would refuse to save every legacy
record. The backfill is the one deliberate exception, through
`withOwnershipMigration(fn)`: it takes a callback held in AsyncLocalStorage, so
there is no flag, header or environment variable that opens the same door, and
the permission cannot leak into a concurrent request.

**Relationships crossed companies.** A Contact or Lead could name another
company's Account, and an Account could take one as its parent — mine by
ownership, theirs by association, with `.populate()` on the detail page the
first thing to read the foreign row. `contacts.js` and `leads.js` now resolve
the Account through the request's own scope before the write, with foreign and
missing sharing one answer and nothing else saved when it fails. The link stays
optional and clearable.

**The hierarchy walk no longer takes a model.** `assertNoAccountCycle` took
`Account` and called `Model.findById`, reading across every company to prove a
cycle. It now takes a scoped loader and rejects a model with a `TypeError`
rather than falling back to a global walk. The proposed parent must load inside
the actor's company; an ancestor that does not load ends the walk instead of
being traversed. The company is never inferred from the proposed parent.
`assertNoCycle` stays model-based for the Site tree, which has no company yet.

**Supplier-offer path.** `Company → Account/Lead/Contact → SalesJourney →
Enquiry → Costing` is now scoped on read, sealed on ownership and closed on
relationships at every hop. Chunk 3 supplier offers may begin. SampleStyle
(3B2) and StockItem (Chunk 4) remain deferred and are not on this path.

## A4.9 — Chunk 3 correction: four contracts (5 Sep 2026)

**Tax is server authoritative.** The GST rate on a quotation-backed line now
comes from the offer; whatever the request carries is discarded. A submitted
rate is a number nobody quoted, and on a `NON_RECOVERABLE` line it changes the
frozen cost directly — 40% declared against a 12% quotation inflated the
garment cost and was frozen as evidence.

Recoverability is a separate fact and stays explicit. `NON_TAXABLE` forces
`NONE` at a recorded zero; a taxable quotation must state `RECOVERABLE` or
`NON_RECOVERABLE`, and `NONE` is refused — it is not a third opinion about
recoverability, it is the absence of one, and defaulting either way is a silent
assumption (recoverable under-costs every non-recoverable purchase;
non-recoverable over-costs the rest). A taxable quotation with no recorded rate
cannot state a position at all and is refused. The engine already excluded
recoverable GST from cost and added non-recoverable; only the input needed
closing.

**One quantity rule.** MOQ, order multiple and tier coverage now live in
`storePurchase/offerApplicability.checkQuantity`, which the Store listing, the
costing picker and the save all call. They disagreed before: the listing
excluded a below-minimum quotation while the resolver attached a warning and
priced the line anyway. MOQ and order-multiple failures are **refusals** now,
not notes — the engine costs the quantity the run requires, and below a minimum
the company must buy more than that. Pricing it anyway reports a cost nobody can
achieve. Purchased surplus and future stock benefit belong to a later chunk.

**Offers are immutable.** `SupplierOffer` refuses commercial writes through
`save`, the update queries, the replace queries and every delete path. Three
named transitions (`ACTIVATE`, `WITHDRAW`, `SUPERSEDE`) open a symbol-keyed,
one-save, per-document door that names exactly the fields it may write, so a
withdrawal cannot smuggle a price change in with the reason. Corrections create
a revision, which is what the chain is for. Same shape as `CostingVersion`'s
lifecycle door, and the same stated limits: mongoose middleware does not cover a
database shell, `bulkWrite` or `Model.collection.*`.

**The provenance is complete.** Inside `costing.cost.read`: quotation date,
HSN/SAC, GST treatment, rate, amount, gross and net, rounding mode, tier floor
and ceiling, document reference, supplier/item/variant snapshots, conversion and
per-scenario quantities. Output-only readers get none of it — proved by
asserting the supplier name, reference and quoted figure are absent from the
serialised payload, not merely from its declared shape.

**Known gap.** `INACTIVE_ITEM` never fires: `RawItem.status` is derived from
quantity against minimum stock, not a lifecycle. The resolver passes
`itemActive: null` ("not checked") and keeps the reason for when the item master
gains a real flag. Supplier status IS checked — `Vendor.status` is a genuine
`active/inactive/pending` enum.

## A4.10 — The supplier behind the quotation (5 Sep 2026)

A4.9 left one asymmetry. Store's `/applicable` listing checked supplier status;
the costing picker and the version write did not — they went through
`currentOfferById` / `currentOffersForItem`, which answer "is this quotation
live?" from its lifecycle and its dates alone.

The offer record cannot know. A supplier can be deactivated long after quoting,
and the quotation goes on looking perfectly current. So the Store register could
show a supplier as unavailable while the costing picker offered them and the
save accepted — freezing a price from a company nobody buys from into an
immutable version as evidence.

`resolveLineRate` now re-reads the supplier through `storeFacts.supplierIdentity`
— the same company-scoped boundary Store uses, so "not ours" and "not there"
stay one answer — and refuses anything that is not `active` with
`COSTING_OFFER_INACTIVE_SUPPLIER` (422). Both the picker and version creation
call `resolveLineRate`, so they cannot disagree by construction rather than by
two checks kept in step.

The lookup is deliberately NOT caught. `supplierIdentity` returns null for
absent-or-foreign and throws for an outage, and those are different facts:
catching would turn a database blip into "this supplier is inactive" — a refusal
that reads as a settled commercial decision and sends somebody to re-negotiate a
relationship that is perfectly fine.

The refusal is about creating something NEW. Existing versions stay readable
with their frozen supplier provenance, the offer is untouched and nothing is
withdrawn automatically, and reactivating the supplier makes the still-current
quotation usable again — the check reads the master each time rather than
caching a verdict. The RawItem lifecycle gap is unchanged and stays
acknowledged.

## A5.1 — A rate per scenario, and what may be called a saving (5 Sep 2026)

### The contract that was blocking the comparison

The engine carried ONE rate per line, so `offerPricing` refused outright when
two scenarios reached two quoted tiers — `COSTING_OFFER_TIER_VARIES_BY_SCENARIO`.
That refusal made the central economies-of-scale comparison impossible to
calculate: the one thing a buyer wants to see is that 3,000 is cheaper per piece
than 500, and the only factual reason available was the one the code rejected.

A `PER_UNIT` line may now carry `unitRateByScenario`, keyed by scenario. The
server builds it by re-reading the quotation for each scenario's OWN supplier
quantity — the browser still submits only the offer reference, the item and
variant identity, the consumption and the conversion. `unitRate` remains as the
fallback and as what every version written before this chunk means, so nothing
already stored changes and old versions still calculate.

Keyed, not ordered: an index would silently mis-assign the moment scenarios were
reordered.

### Inputs stay separate from results

The frozen input line records what the LINE is — one quotation, one conversion,
one tax position. A new `offerProvenance[].scenarios[]` records what each
QUANTITY reached: its supplier quantity and unit, the band it fell in with both
ends, the quoted amount, the net and effective rates, the GST split, the
conversion factor and the tax treatment. Frozen rather than re-derivable,
because "why was 3,000 cheaper" must be answerable a year later without the
quotation still being active — which is precisely what a frozen version may not
depend on.

Every rule is applied per scenario independently: company, supplier status,
quotation state and dates, item and variant, currency, UoM conversion, MOQ,
order multiple, and tier floor/ceiling/gap. Nothing is interpolated and no tier
is borrowed from a neighbour — a rate that applies at 3,000 is not evidence
about 500. One unsupported scenario refuses the whole version and names which
scenario, its output quantity, its derived purchase quantity and the reason; a
costing whose 3,000 case was quietly dropped would present a comparison with a
missing arm and read as complete.

### What qualifies as a factual saving

Four causes, each a fact the engine can point at:

- **SUPPLIER_TIER** — a supplier quoted a different rate at that quantity, on a
  dated quotation the server read.
- **FIXED_COST_DILUTION** — the same fixed total divided by more pieces. Both
  totals are reported, identical, so a reader can see nothing was negotiated.
- **UNCHANGED_VARIABLE_COST** — reported so "this did not move" is
  distinguishable from "nobody looked at it".
- **OVERHEAD_CONSEQUENCE** — a percentage following the basis it is charged on.
  Named as a consequence, because calling it a saving would credit the company
  with a negotiation that never happened.

Deliberately absent: generic bulk discounts, operation efficiency, reduced
wastage, freight consolidation and forecast volume. Each needs a policy or a
record that does not exist yet, and presenting one as a saving would put a
number in front of a customer nobody can stand behind. An unexplained residue is
returned as `unattributedMinor` rather than absorbed — that is where a claim
nobody can support would otherwise hide.

The whole decomposition sits inside the `costing.cost.read` block, with the
per-scenario provenance: an explanation naming a quoted rate hands an
output-only reader the supplier's price by another route.

### Server-derived, and refused from a client

`unitRateByScenario`, `effectiveRate`, `tierPrice`, `supplierPurchaseQuantity`,
`eosSaving`, `comparedToPrimary` and `causes` are refused by name from a request
body — not dropped. Silently ignoring teaches a client the field works, and the
next version of it stops checking.

### Deferred to Chunk 5B

These remain user-entered QUANTITY scenarios. They are not confirmed combined
demand, forecast demand or probability-weighted demand, and a scenario's optional
label never decides how anything is calculated. Those names have to be earned
from Sales records, which this chunk has not read.
