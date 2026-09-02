# Decision record — Store & Purchase tenant boundary, permissions, audit, idempotency and sequences (Chunk 1)

> **Status:** Adopted for implementation. **Chunk 1A is implemented (the
> foundation and the operational-PO pilot); Chunk 1 is not complete** — the
> MRF, requisition, stock issuance/adjustment, returns, barcode, delivery,
> raw-item and worksheet-PO routers are still unconverted, so cross-company
> access remains possible today. This record describes mechanisms the code
> implements, and §12 states exactly where they are and are not applied.
>
> Where a *business* decision is still open (approval thresholds, who may
> approve what), the conservative default is recorded here and the decision is
> listed as unresolved in §11.
>
> Evidence for every "today" claim: `docs/audits/store-purchase-baseline.md`.
> Scope: `docs/tasks/current-task.md`.

---

## 1. Existing infrastructure inventory (what is reused, not rebuilt)

Chunk 1 adds **no parallel identity system**. Everything below already exists
and is reused as-is:

| Concern | Existing mechanism | Reused how |
|---|---|---|
| Authentication (`/api/**`) | `Middlewear/EmployeeAuthMiddlewear.js` — verifies the JWT signed by `routes/login.js`, sets `req.user = {id, role, employeeId, name, email, deptId, deptSlug, isAdmin}` | Unchanged. Tenant context runs **after** it and never replaces it |
| Department grants | `models/Access/DepartmentRole.js` — `{departmentSlug, email, role}` where role ∈ `viewer < editor < approver < owner` (ranked), collection `department_roles` | The sole source of Store/Purchase capability |
| Platform admin | `models/Access/DeptUser.js` `isAdmin`, re-read from the database | Same treatment as `services/access/fulfilmentAccess.js`: authoritative, never trusted from a token |
| Department resolution | `routes/auth/deptAuth.js` `resolveEmployeeDepartments()` | Used to find a person's grants |
| Domain access resolvers | `services/access/{fulfilmentAccess,hrAccess,accountingAccess}.js` | `services/storePurchase/capabilities.js` follows the same shape |
| Company master | `Acc_Company` (`acc_companies`), committed | The company universe |
| Frontend transport | `lib/api.js` (`credentials:"include"` + `Authorization: Bearer`) | Extended, not replaced |
| Frontend gating | `components/access/RoleGate.js` | Kept for usability; **never** the authority |

**The gap this chunk had to close:** none of `Employee`, `DeptUser`,
`DepartmentRole` or the JWT carries a `companyId` or `siteId`. There is no
existing way to prove which company a CMS user belongs to.

## 2. Tenant-context resolution

One mechanism: `services/storePurchase/tenantContext.service.js`, exposed as
middleware in `Middlewear/storePurchaseTenant.js`. It resolves, from
**server-owned identity only**:

```
{ actorId, actorType, actorName, companyId, permittedSiteIds, siteId,
  capabilities, membershipSource, legacyMode }
```

### Membership resolution order (fail-closed)

1. **`SpCompanyMembership`** — the new authoritative record
   (`{employeeRef|email, companyId, siteIds[], isActive}`). If a row exists
   for this actor, it decides. `membershipSource: "MEMBERSHIP_RECORD"`.
2. **Single-company deployment fallback** — if *no* membership row exists for
   anyone **and** exactly one `Acc_Company` exists, that company is the
   context, flagged `membershipSource: "SINGLE_COMPANY_DEPLOYMENT"`.
   This is a **deployment fact, not an inference from the request**: it reads
   neither the body, the query nor the document being accessed. It is the
   same rule `routes/CMS_Routes/Inventory/Operations/mrfRoutes.js` already
   applies at the fulfilment decision, and it is what keeps the live
   single-company system usable while membership is populated.
3. **Fail closed.** More than one company and no membership row → `403
   TENANT_MEMBERSHIP_UNPROVEN`. Never a guess, never "all companies".

Membership is **never** taken from a request body, query string, header or
from the document being read. A `companyId` in a payload is ignored on write
and rejected when it disagrees with context (`400 TENANT_MISMATCH`).

### Sites — refused, not validated

There is **no authoritative company-owned site model** anywhere in this
system, so a site cannot be validated. An earlier version accepted whatever
ObjectId the browser sent whenever the membership listed no sites and stamped
it onto the record — trusting the client with a scope field and then calling
it checked.

Until a real site master exists: no site named → `null`; a site named with
membership sites → validated against them; a site named with **no** membership
sites → `SITE_NOT_CONFIGURED`; a malformed id → a structured validation
error, never a cast failure surfacing as a 500.

### Multi-company selection

One active membership decides. Several require the caller to name the company
in `X-Store-Purchase-Company`, and that name **selects among their
memberships** — it is never authority on its own, and one they do not hold
gets the same non-disclosing refusal as one that does not exist. Two rows
naming the same company (matched by email and by employeeRef) are one
membership found twice, not a choice.

### Query scoping

`tenantFilter(ctx)` returns `{ companyId }` and is applied to every list,
read, update, transition and delete on a scoped collection. Cross-company
lookups return the project's existing non-disclosing **404**, identical to a
genuinely missing document — a 403 would confirm the id exists.

Background/service entry points must call
`tenantContext.forService({companyId, reason})` explicitly; there is no
ambient global context.

## 3. Legacy scope

Records with no `companyId` are **legacy-global**. Absence never means
"visible to everybody".

- Legacy records remain readable.
- They are **excluded** from normal company-scoped lists (`{companyId: X}`
  simply does not match a document without the field).
- Reading them requires **both** the `sp.legacy.read` capability **and** an
  explicit `?scope=legacy` mode. Neither alone suffices.
- A legacy record can never participate in a company-scoped write: the write
  path resolves the document under `tenantFilter` and gets a 404.
- **Claiming/adopting** a legacy record is *not* in this chunk. No backfill,
  no assignment, no silent adoption.
- The frontend renders legacy results in an explicitly labelled read-only
  view that does not resemble an ordinary owned record.

## 4. Capabilities

Stable keys, in `services/storePurchase/capabilities.js`. Roles map to
capability sets **conservatively, from behaviour that exists today** — the
audit found every inventory router to be authentication-only, so the mapping
preserves who can act now while making it nameable and testable.

| Capability | Meaning |
|---|---|
| `sp.read` | See Store/Purchase records |
| `sp.requisition.review` | Review/approve a requisition |
| `sp.sourcing.manage` | Manage sourcing (vendor pricing/quotes) |
| `sp.po.create` | Create a purchase order |
| `sp.po.approve` | Approve a purchase order |
| `sp.po.issue` | Issue an approved PO to a supplier |
| `sp.po.cancel` | Cancel a PO |
| `sp.receipt.record` | Record a goods receipt |
| `sp.quality.accept` | Quality acceptance (no route performs this today — reserved, granted to nobody) |
| `sp.stock.issue` | Issue stock |
| `sp.stock.return` | Record a return |
| `sp.stock.adjust` | Adjust stock |
| `sp.master.maintain` | Maintain masters (items, vendors, units, warehouses) |
| `sp.config.manage` | Store/Purchase configuration |
| `sp.legacy.read` | Read legacy-global records |
| `sp.history.read` | Read action history |
| `sp.policy.admin` | Administer numbering and approval policy |

### Role → capability mapping (conservative)

| Grant | Capabilities |
|---|---|
| platform admin (`DeptUser.isAdmin`) | all |
| `store` / `owner` | all except `sp.quality.accept` |
| `store` / `approver` | read, requisition.review, sourcing, po.create/approve/issue/cancel, receipt, stock.issue/return/adjust, master.maintain, history.read, legacy.read |
| `store` / `editor` | read, sourcing, po.create, receipt, stock.issue/return, master.maintain, history.read |
| `store` / `viewer` | read, history.read |
| `ceo` (any role) | read, history.read, legacy.read |
| any other authenticated user | **none** |

Authentication alone grants nothing. Server authorisation is authoritative;
frontend hiding is usability only.

## 5. Approval policy

`SpApprovalPolicy` is company-scoped and supports document type, optional
site, amount bands, required capability, ordered levels, effective dates and
an emergency flag. Resolution is deterministic (`resolvePolicy`) and refuses
overlapping/ambiguous active rules rather than picking one.

**No new procurement workflow is invented.** The only integration point is
the existing PO `DRAFT → ISSUED` transition, which today stamps `approvedBy`
from the caller with no check. That transition now requires `sp.po.issue`,
and where a policy matches, the actor must also hold the policy's required
capability.

**No match FAILS CLOSED.** An earlier version of this record said the
capability check alone would suffice when no policy matched. That was wrong:
it made an unconfigured company behave exactly like a fully-approved one, and
it passed a capability check off as approval-policy enforcement. Capability
and approval policy are **two separate gates and both must pass** — holding
`sp.po.issue` is authority to operate the endpoint, not the company's
authority to commit that sum. An unconfigured company therefore cannot issue
at all (`POLICY_NOT_CONFIGURED`), an emergency order needs an explicit
emergency rule, and a policy naming no approver authorises nobody.

## 6. Document numbering

`SpDocumentSequence`: unique compound index on
`{companyId, documentType, fiscalYear, siteId}`, allocated with a single
atomic `findOneAndUpdate({$inc:{next:1}}, {upsert:true, returnDocument:"after"})`.

- No `Date.now()`, no random suffix, no count-then-insert.
- Numbers are **never reused** after failure, cancellation or deletion — the
  counter only moves forward.
- Format is **server-owned**: `<PREFIX>/<FY>/<NNNN>` (e.g. `PO/2026-27/0001`),
  zero-padded to 4 and growing beyond it naturally.
- A number supplied by the browser is ignored, never trusted.
- Fiscal year is the Indian April–March year (`fiscalYearOf(date)` →
  `"2026-27"`), matching `Acc_Budget.financialYear`.
- **Existing numbers are never rewritten.** Legacy `PO26080001`-style numbers
  stay exactly as they are; the allocator applies to *new* documents only.
- The database unique index on the document's own number field remains the
  final guard.

## 7. Idempotency

Header `Idempotency-Key`. Record key is
`{companyId, actorId, operation, key}` (unique index), storing a canonical
SHA-256 hash of the request body.

| Situation | Result |
|---|---|
| Same key, same payload, completed | Replay the stored response, `Idempotency-Replayed: true` |
| Same key, different payload | `409 IDEMPOTENCY_KEY_REUSED` |
| Same key, still in progress | `409 IDEMPOTENCY_IN_PROGRESS` (retry later) |
| Same key, previous attempt failed **before any effect** | The record is released; the retry executes |
| Same key, previous attempt failed **after the effect landed** | `EFFECT_APPLIED`; the retry RECOVERS — it never re-runs the mutation |
| Same key, stale `IN_PROGRESS` (crashed process, >2 min, no effect) | Reclaimed, so a crash cannot lock the action for the record's 30-day life |
| Validation failure | **No** success record is written — a failed request never becomes a replayable success |

Records retain for **30 days** (TTL index). Only the body hash, status code
and response body are stored; no headers, no tokens, no credentials.

The frontend generates **one key per user action** and reuses it across
retries of that action.

## 8. Action history

`SpActionHistory` is append-only and company-scoped. Captured: company, site,
entity type and id, document-number snapshot, action, actor id/type/name
snapshot, timestamp, previous and resulting state, reason, request id,
idempotency key, and a safe changed-field summary.

- **No update or delete path exists** — the model blocks `findOneAndUpdate`,
  `updateOne`, `updateMany`, `deleteOne`, `deleteMany` and `save()` on an
  existing document at the schema level, and no route exposes mutation.
- Written only by `services/storePurchase/actionHistory.service.js`.
- Never stores tokens, uploaded file contents, bank details or full payloads.
- **Atomicity:** where the deployment supports transactions the state change
  and its history entry share a session. `mongodb-memory-server` in tests is
  a standalone (no transactions), and the live deployment's support is not
  something this chunk can assert — so the helper attempts a transaction and,
  when unavailable, falls back to *history-after-state* with the failure
  recorded and surfaced by a reconciliation query, rather than claiming
  atomicity it does not have.
- Read through `GET /api/cms/store-purchase/history` (tenant-scoped,
  `sp.history.read`).

## 9. Archive, cancel, delete

| Rule | Applied as |
|---|---|
| Untouched drafts may be deleted only with no downstream reference | `lifecycle.assertDeletable()` |
| Used masters are archived, not deleted | Archive fields are **Chunk 2**; Chunk 1 adds the *guard* only and documents the deferral |
| Issued/approved commercial documents are cancelled, never deleted | PO delete refuses once out of `DRAFT` |
| Received/issued/returned/paid/posted records cannot be hard-deleted | Reference scan before delete |
| Cancellation requires a reason and writes history | `sp.po.cancel` + `reason` mandatory |
| Cross-company references never count as ownership | Reference scan is tenant-scoped |
| Blocked deletion returns a structured conflict listing the blockers | `409 LIFECYCLE_BLOCKED` with `blockingReferences[]` |
| No cascading deletion of stock or commercial evidence | Never implemented |

## 10. Frontend contract

- Capabilities come from `GET /api/cms/store-purchase/context` (authoritative
  session data), consumed by `lib/storePurchase.js` + `useStorePurchaseContext`.
- Unavailable actions are hidden/disabled, **and** 403s are still handled.
- Designed states: forbidden, wrong-company, legacy read-only, lifecycle
  conflict, idempotency conflict.
- Form data is retained after a failed or forbidden submission.
- Double submission is prevented while in flight; the **same** idempotency
  key is reused on retry.
- Document numbers shown are the server's.
- An action-history drawer is available where history exists.
- Uses the shared transport; no new scattered `fetch`.
- No raw enum names or capability keys in user-facing copy.

## 11. Unresolved business decisions

1. **Company membership data.** Nobody has told the system which employees
   belong to which company. Until `SpCompanyMembership` rows exist, a
   multi-company deployment fails closed. Who populates this, and from what
   source of truth, is an owner decision.
2. **Approval thresholds** — amount bands and who may approve at each level
   (product plan §12.2). Conservative default: capability alone.
3. **Site structure** — whether Store/Purchase needs sites at all, and their
   relationship to warehouses (product plan §12.3).
4. **Quality acceptance** — no route performs it; `sp.quality.accept` is
   reserved and granted to nobody until the business defines the step.
5. **Legacy adoption** — whether, when and by whom legacy-global records are
   claimed into a company. Deliberately not built.

## 12. Where this is applied, and where it is not

| Router | Tenant | Capability | Idempotency | History |
|---|---|---|---|---|
| operational PO (`/api/cms/inventory/operations/purchase-orders`) | ✓ | ✓ | ✓ | ✓ |
| `/api/cms/units` | ✓ | ✓ (read / master-maintain) | n/a | — |
| `/api/cms/store-purchase/{context,history}` | ✓ | ✓ | n/a | read-only |
| MRF / cowork MRF | ✗ | ✗ | ✗ | ✗ |
| Requisitions | ✗ | ✗ | ✗ | ✗ |
| Stock issuance / adjustments | ✗ | ✗ | ✗ | ✗ |
| Vendor returns | ✗ | ✗ | ✗ | ✗ |
| Barcodes | ✗ | ✗ | ✗ | ✗ |
| Deliveries | ✗ | ✗ | ✗ | ✗ |
| Raw items (incl. hard delete) | ✗ | ✗ | ✗ | ✗ |
| Worksheet PO / worker WO | ✗ | ✗ | ✗ | ✗ |

Every ✗ can read and mutate another company's records. **The boundary does
not hold until they are converted.**

## 13. Legacy master references (compatibility boundary)

A tenant-scoped purchase order references `RawItem` and `Vendor`, and
**neither carries a company**. `assertSameTenant()` therefore cannot protect
those references — it refuses a document owned by another company, and these
are owned by none. Saying it protects them would be false.

The rule while Chunk 2 is pending:

- `RawItem` and `Vendor` are **legacy global masters**. Every company sees
  the same catalogue and the same suppliers.
- A scoped document may reference them under this explicit compatibility
  rule, and the identity needed to read the document later is **snapshotted
  onto the line** (`itemName`, `sku`, `unit`, `vendorName`) — which the PO
  schema already does, and which is what keeps a historical order readable
  after the master changes.
- Company ownership is **never inferred** for the master from the documents
  that reference it.
- What *is* enforced: a **transaction** record (another purchase order, a
  receipt, a movement) belonging to another company can never be referenced —
  those carry a company and go through `assertSameTenant()`.

Chunk 2 gives the item and supplier masters their own identity and scope;
until then this is a stated compatibility boundary, not a protection.
