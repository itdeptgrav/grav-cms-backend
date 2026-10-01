# Lane A — Purchase workspace A1: audit, parity matrix and stage mapping

> **Status:** Implementation record, 28 September 2026. Read composition and
> presentation only.
> Durable direction: `docs/product/store-purchase-simplification-plan.md`.
> Coordination boundary: `docs/tasks/store-purchase-two-lane-plan.md`.

## 1. Audit — every Purchase surface that exists today

### Authoritative stored statuses

Nothing below is derived from a label or a date, with one documented exception.

| Source | Model / service | Stored status values |
|---|---|---|
| Material order | `PurchaseOrder` | `DRAFT`, `ISSUED`, `PARTIALLY_RECEIVED`, `COMPLETED`, `CANCELLED` |
| Material order line | `PurchaseOrder.items[].status` | `PENDING`, `PARTIALLY_RECEIVED`, `COMPLETED`, `CANCELLED` |
| Service order | `ServiceOrder` | `DRAFT`, `ISSUED`, `IN_PROGRESS`, `COMPLETION_REPORTED`, `ACCEPTED`, `REWORK_REQUIRED`, `CANCELLED` |
| Material offer | `SupplierOffer` | `DRAFT`, `ACTIVE`, `SUPERSEDED`, `WITHDRAWN` |
| Service offer | `ServiceSupplierOffer` | same four |
| Freight offer | `FreightOffer` | same four |
| Sourcing decision | `sourcingDecision.openQueue` | open decisions on `Costing` in `DRAFT`/`IN_REVIEW` |
| Purchase exception | `poExceptionsRegister` | derived groups over PO + reconciliation + vouchers |

**The one derived value, and why.** Offer *expiry* is not stored. `SupplierOffer`
says so itself: *"expired is derived from `validUntil` against the clock, and the
stored status stays a record of what somebody DID."* So A1 reports `exactStatus`
as the stored value and carries expiry as a separate `expired` fact. An expired
offer is never relabelled `WITHDRAWN`, and a withdrawn one is never called
expired.

### Endpoints that exist

| Surface | Endpoint |
|---|---|
| Material order register | `GET /api/cms/purchase-orders` — **unbounded**, 5 populates, no pagination |
| Material order detail / reconciliation / receipts / payments | `GET /:id`, `/:id/reconciliation`, `/:id/goods-receipts`, `/:id/payments` |
| Material order create / update / issue / cancel | `POST /`, `PUT /:id`, `PATCH /:id`, `POST /:id/…` |
| Purchase exceptions | `GET /api/cms/purchase-orders/reports/exceptions` |
| Service orders | `GET /api/cms/service-orders`, `GET /:id`, `PATCH /:id/{issue,start,report-completion,cancel,accept,request-correction}` |
| Material offers | `GET /api/cms/store/supplier-offers`, `/applicable`, `/:id`, `POST /`, `/:id/{activate,revise,withdraw}` |
| Service offers | `GET /api/cms/store/service-offers` + same shape |
| Freight offers | `GET /api/cms/store/freight-offers`, `/applicable`, `/options`, `/:id`, + same writes |
| Sourcing decisions | `GET /api/cms/store/sourcing-decisions`, `/costing/:costingId`, `POST /costing/:costingId`, `DELETE /costing/:costingId` |

## 2. Parity matrix

Classification per the two-lane gate: **(1)** presented directly in the Purchase
workspace, **(2)** preserved through a contextual link, **(3)** preserved
unchanged at its existing route.

| Current feature | Route | Capability | Class | A1 destination |
|---|---|---|---|---|
| Material order register + search + status counts | `/operations/purchase-order` | `sp.read` | 1 | Workspace rows, four stage tabs, type filter, search |
| Material order create | `/operations/purchase-order/new-edit-purchase-order` | `sp.po.create` | 3 | Unchanged; reached from the workspace header |
| Material order edit | `…/new-edit-purchase-order/[id]` | `sp.po.create` | 2 | Draft-order row next action → existing editor |
| Material order issue | `PATCH /:id` | `sp.po.issue` | 2 | Draft-order row → detail, where issuing lives |
| Material order approval | `PATCH /:id` | `sp.po.approve` | 3 | Unchanged on detail |
| Material order detail / print / history | `/operations/purchase-order/[id]` | `sp.read` | 2 | Every row opens it |
| Material order cancel | `PATCH /:id` | `sp.po.cancel` | 3 | Unchanged on detail |
| Legacy PO configuration register | `/configurations/purchase-orders/**` | manager | 3 | Unchanged, out of ordinary navigation (Phase 1) |
| Service order register | `/operations/service-orders` | `sp.read` | 1 | Workspace rows under Outside services |
| Service order detail / history | `/operations/service-orders/[id]` | `sp.read` | 2 | Row opens it |
| Service issue / start / report completion / cancel | `PATCH /:id/…` | `sp.sourcing.manage` | 3 | Unchanged on detail |
| Service acceptance / rework request | `PATCH /:id/{accept,request-correction}` | requester | 3 | Unchanged on detail |
| Service supplier-billing handoff | Service order detail billing block | Accounting-owned | 3 | Unchanged |
| Material supplier offers register / detail / create | `/supplier-offers/**` | `sp.read` / `sp.sourcing.manage` | 1 + 3 | Offer rows in **To source**; the register stays |
| Outside-service offers | `/supplier-offers/services/**` | same | 1 + 3 | Offer rows; register stays |
| Freight offers | `/api/cms/store/freight-offers` | same | 1 + 3 | Offer rows under the Freight type; API stays |
| Offer revision / withdraw / activate | `POST /:id/…` | `sp.sourcing.manage` | 3 | Unchanged on offer detail |
| Offer expiry | derived from `validUntil` | — | 1 | Carried as a separate `expired` fact beside the stored status |
| Quotation comparison | `/supplier-offers` (by item) | `sp.read` | 2 | To-source row next action → **Compare offers** |
| Sourcing decisions + evidence | `/supplier-offers/sourcing-decisions` | `sp.sourcing.manage` | 1 + 3 | Decision rows in **To source**; register stays |
| Purchase exceptions register | `/operations/purchase-exceptions` | `sp.read` | 2 | Indicator on the affected order + link; register stays whole |
| Order reconciliation | `GET /:id/reconciliation` | `sp.read` | 3 | Unchanged on detail |
| Expected delivery + partial receipt visibility | PO stored line state | `sp.read` | 1 | `expectedDate` and the stored line status; **never recomputed** |
| Supplier return / replacement visibility | PO `returnRequests` | `sp.read` | 3 | Unchanged on detail (Lane B owns the workflow) |
| Pagination / search / empty / error | register | `sp.read` | 1 | URL-backed, with honest coverage |
| Idempotency, company scope, action history | middleware + services | — | 3 | Untouched; A1 writes nothing |

No row is "not shown", and every existing URL stays live.

## 3. Exact stage mapping

Stage comes from the stored status of each source. Nothing is inferred from a
date or a label.

| Stage | Material order | Service order | Offer | Decision |
|---|---|---|---|---|
| **To source** | — | — | `ACTIVE` (and not expired) | every open decision |
| **Draft orders** | `DRAFT` | `DRAFT` | `DRAFT` | — |
| **On order** | `ISSUED`, `PARTIALLY_RECEIVED` | `ISSUED`, `IN_PROGRESS`, `COMPLETION_REPORTED`, `REWORK_REQUIRED` | — | — |
| **Completed** | `COMPLETED` | `ACCEPTED` | — | — |
| **Closed (explicit filter)** | `CANCELLED` | `CANCELLED` | `SUPERSEDED`, `WITHDRAWN`, expired `ACTIVE` | — |

### The decision about cancelled, rejected, expired and superseded

These are **not** placed in Completed. A cancelled order was not completed, and
calling it so would misreport it in the one view a buyer trusts. They are
reachable through an explicit `status=closed` filter, keep their exact stored
status on the row, and an expired offer is marked expired while its stored
status stays whatever somebody actually did to it.

`REWORK_REQUIRED` sits in **On order**: the commercial relationship is live and
work remains. `COMPLETION_REPORTED` likewise — the supplier says they are done,
but the requesting department has not accepted, so it is not complete.

## 4. Safety

A1 adds one `GET` and mutates nothing: no purchase, receipt, stock, payment or
Accounting semantics change. It does not recompute pending receipt quantities —
the purchase order's own stored line state is read as it stands — and it never
derives receipt-control state, which is Lane B's.

## 5. Frontend parity matrix

The register at `/store/dashboard/operations/purchase-order` becomes the
workspace **at the same URL**. Every feature it had is classified below. Nothing
is listed as "planned" — that would not be parity.

### (1) Presented in the consolidated workspace

| Register feature | How it appears now |
|---|---|
| Material purchase orders | Rows, in the stage their stored status maps to |
| Exact PO status | A chip on every row, beside the tab — `CANCELLED` still reads Cancelled |
| Line-counted receipt progress | The register's own `receiptProgress`, unchanged, on material rows |
| Mixed-unit warning | `quantityTotalClaim`'s own reason line, unchanged |
| Ordered value | Per row, with its currency; per stage, **one figure per currency** |
| Payment state | A row field, still saying so when it is not known |
| Order and expected-delivery dates | Row fields; a service order shows no delivery date, because it has none |
| Three scope-labelled statistic groups | Unchanged, from the same endpoint, shown for Materials and All |
| Search | One box, debounced, still `escapeRegex`-escaped at the boundary |
| Exact-status filter | Unchanged, all six options, still on the `status=` URL key |
| Supplier filter | Unchanged, including its own failure notice and retry |
| Active-filter chips and Clear all | Unchanged |
| "New purchase order" | Unchanged, still behind `CAP.PO_CREATE` |
| Refresh | Unchanged; refreshes both reads |
| Cancel, with a required reason and one idempotency key | Unchanged dialog, on material-order rows |
| Stale-answer guard | Unchanged (`seq` + `questionKey` + `answersQuestion`) |
| **New:** service orders, supplier/service/freight quotations, sourcing decisions | Rows in the same list, each naming its own record type |
| **New:** purchase exceptions | An indicator on the row, with a link to the register that owns the rules |

### (2) Preserved through a contextual link

| Feature | Reached from |
|---|---|
| Create / edit a purchase order | The header action and each draft row's "Edit draft" |
| Issue an order, record a receipt | The row's next action and "Record receipt" |
| Offer comparison, revision, expiry detail | A quotation row's next action → the offers pages |
| Sourcing-decision evidence | A decision row's next action → the decision workspace |
| Reconciliation, three-way match, supplier returns | The purchase-order detail page, unchanged |
| Purchase exceptions register | The exception indicator on the row |

### (3) Preserved unchanged on its existing route

Purchase-order detail, create/edit, receive, service-order pages, supplier /
service / freight offer pages, the sourcing-decision workspace, the purchase
exceptions register, PO reconciliation, supplier bills and the Accounting
handoff. A1 edited none of them.

### The two deliberate changes

1. **Reveal-in-batches became real pagination.** The register fetched every
   match and revealed 50 at a time; the workspace endpoint pages server-side.
   Same capability — reach any record — over a set that is now composed from
   four sources and would otherwise be unbounded.

2. **The lifecycle filter took a new URL key, `show`.** `status` already meant
   the exact purchase-order status and `?status=ISSUED` links are in
   circulation. Reusing that key for open/closed/all would have silently
   reinterpreted them, so the new axis is `show` and the old key is untouched.

### What the page does not derive

Stage, expiry, exception rules, pending receipt quantities, receipt-control
state, and any cross-currency total. The first four are the server's; the last
does not exist.

## 6. Correction pass

### 6.1 "To source" now begins at the approved need

**Authoritative source: `SpendRequest` at `status: "approved"`**
(`models/CMS_Models/Requests/SpendRequest.js`). The status chain is
`draft → submitted → pending_tl → pending_finance → … → approved → ordered`,
and the `ordered` transition (`routes/CMS_Routes/Requests/spendRequests.js`)
stores the PO or work-order number. So `approved` is exactly "signed off, not
yet bought". It is company-scoped (`companyId`) and read **read-only** here.

Excluded on purpose:
- `budget_exception` — alive, but finance sent it back over the figure. Showing
  it as approved demand would put a buyer on a supplier call for money nobody
  has agreed.
- `Requisition` (`models/.../Operations/Requisition.js`) — a print-a-form model
  with statuses `DRAFT/SUBMITTED/CONVERTED/CANCELLED`, **no approval state and
  no `companyId`**. It cannot be surfaced safely in a company-scoped workspace
  and it is not an approval authority.

**Type labelling** uses the request's own `requestType`: `PRODUCT` → Material,
`SERVICE` → Outside service, and the legacy `SOFTWARE` → Outside service,
matching the model's own on-screen label rather than silently becoming a
material.

**Freight has no approved-demand source — evidence.** A spend request can only
be raised as `PRODUCT` or `SERVICE` (`CURRENT_REQUEST_TYPES`). `FreightOffer`
references an origin warehouse and a destination address — a lane rate card —
and carries **no demand reference at all**. There is therefore no record
anywhere saying "this shipment needs a transporter and somebody approved it".
Freight's existing direct-entry path is preserved unchanged, and no freight
"need" is invented from a material request, which would be a guess presented as
a fact. Closing this gap means creating a freight-demand record, which is new
scope, not a read.

### 6.2 One list request

The workspace DTO now carries `paymentStatus`, `totalReceived` and per-line
`{ itemName, unit, quantity, receivedQuantity, status }`, so the page's Edit,
Receive, Cancel, payment state, receipt progress and mixed-unit warning all run
off the row. The second unbounded `GET /purchase-orders` is gone; only the
bounded supplier-options list remains.

The register's three company-wide statistic groups went with it — they were
counts over every order that has ever existed, from that same unbounded read.
They are replaced by the adapter's own bounded summary, which describes the
composed, capped set on screen and **says so**, including `valuedRecordCount`
so the money is never read as covering every row.

### 6.3 Closed is one orthogonal view

`status=all` is gone and resolves forward to `open`. A cancelled order has no
stage, so an "all" view could only include closed records by repeating each one
under all four tabs — which it did.

| View | What it contains |
|---|---|
| `show=open` (default) | Only records whose stage **is** the selected tab |
| `show=closed` | `CANCELLED`, `SUPERSEDED`, `WITHDRAWN`, and expired `ACTIVE` offers — across every stage, each exactly once. The stage constraint is disabled and `stageApplies: false` tells the page to say so. |

An expired offer is reached by an **expiry-date predicate**
(`status: "ACTIVE", validUntil: { $ne: null, $lt: asOf }`), because a
status-only query can never find one — which is why the closed view previously
did not contain it. Its stored status stays `ACTIVE` with `expired: true`
beside it.

### 6.4 Destinations and wording

| Row | Destination | Label |
|---|---|---|
| Material / service quotation | `/store/dashboard/supplier-offers[/services]/{id}` | **Review quotation** |
| Freight quotation | `/store/dashboard/supplier-offers?subject=freight` | **Open freight quotations** |
| Sourcing decision | `/store/dashboard/supplier-offers/sourcing-decisions` | Record / Review sourcing decision |
| Approved need | `/store/dashboard/order-requests/{id}` | Raise order from approved request |

Freight has **no `[id]` route**; the previous link pointed at a page that does
not exist. `COMPARE_OFFERS` is removed from the vocabulary entirely — it
labelled a link that opened one quotation's detail page.

### 6.5 A tenancy defect found and fixed

`tenantFilter` returns an `$or` whenever legacy read-through is on, which is the
default. Each source read then assigned its own `filter.$or` for the search
terms, **replacing** the company clause — so searching the workspace returned
other companies' orders. Proven with two failing tests, then fixed by folding
every clause into `$and` through the new `scoped()` helper.

## 7. Final correction pass

### 7.1 Approved needs open the page that can actually open them

`/store/dashboard/order-requests/{id}` reads `/api/cms/store/order-requests/{id}`
— a store requirement and its work orders, a different record entirely. A spend
request id handed to it gets the wrong screen or nothing.

The destination is now `/store/dashboard/order-requests/quote/{spendRequestId}`,
which loads the request through `spendApi('/{id}')` → `GET /api/requests/spend/{id}`
and carries the order-creation action: **Create purchase order** for an approved
`PRODUCT`, and the service-order flow for an approved `SERVICE`.

Proven by a route contract test that stands up the real spend router and asserts
the returned `requestNumber`, `title` and `status` — not merely that the href
contains the id, which would have passed for the wrong route too.

### 7.2 Legacy exact-status links open where their orders are

Keeping the word `?status=ISSUED` while opening the default tab is not
compatibility: "To source" holds no issued orders, so the link that used to list
them listed nothing and read as though the orders were gone.

With **no explicit stage**, the status decides the view:

| `?status=` | Opens |
|---|---|
| `DRAFT` | Draft orders |
| `ISSUED` | On order |
| `PARTIALLY_RECEIVED` | On order |
| `COMPLETED` | Completed |
| `CANCELLED` | Cancelled & closed |

An **explicit stage always wins**, and the status then only narrows it — so
`?stage=completed&status=ISSUED` stays on Completed and returns nothing, rather
than moving the view or ignoring one of the two.

Normalisation: `status=all` and any unrecognised value become **no filter**, not
a filter nothing can match — an empty list there would read as "there are none".
The response carries `poStatusApplied`, so the page shows no chip and no
selection for a filter the backend ignored, and `stageInferred`, so the page
says which stage a legacy link chose and why.

`buildQuery` writes the stage out explicitly whenever a status is present;
otherwise changing the tab would snap back to the inferred one on the next read.

### 7.3 The legacy register's tenant-search leak

`GET /purchase-orders` started from `tenantFilter()` — which returns an `$or`
under legacy read-through, the default — and then assigned the search `$or` over
it. The query kept the search and dropped the company. Both conditions are now
folded under `$and`, and the term is escaped before it becomes a pattern:
unescaped, `A.C` also matched "ABC", `.*` matched everything, and an
unterminated `(` threw, turning a typo into a 500.

The endpoint is **kept**, because callers outside the workspace still use it.

**The same defect existed a second time in the same file**, at
`GET /reports/exceptions` (escaped correctly, but still assigning over the
tenancy). Fixed and tested alongside.

**Not fixed, reported:** `services/storePurchase/receiveWorkspace.service.js:257`
and `:356` have the identical pattern — `{ ...tenantContext.tenantFilter(tenant) }`
followed by `filter.$or = [...]`. That is Lane B's Receive file and outside this
lane's boundary. `supplierOfferRead.service.js:202` was checked and is safe: it
scopes with a strict `companyId`, so it has no tenancy `$or` to overwrite.

---

# Lane A — Purchase A2: mandatory Source MRF

> **Documentation conflict, reported not resolved.** `docs/tasks/current-task.md`
> belongs to the *CMS-wide Assistant Semantic Catalogue* workstream (27 Sep
> 2026) and is modified in the working tree. It has **not** been overwritten.
> Lane A continues to be documented here.

## A2.1 Audit (completed before any application code was edited)

### 1. The MRF model

`models/CMS_Models/Inventory/Operations/MRF.js`

- **Ownership**: `companyId` (required), `siteId`.
- **Identity**: `mrfNumber`.
- **Origin**: `requestedFor` (Employee), `requestedForName`, `requestedForDept`,
  `requestedForId`, `createdByRef`/`createdByName`.
- **Status**: `PENDING · APPROVED · PARTIALLY_ISSUED · ISSUED ·
  PARTIALLY_RETURNED · COMPLETED · REJECTED · UNFULFILLED · CANCELLED`.
- **Lines** (`items[]`): `rawItem`, `rawItemName`, `rawItemSku`, `variantId`,
  `requestedQty`, `unit`, `baseUnit`, `issuedQty`, `returnedQty`,
  `consumedQty`, `itemStatus`, `availability`, `availableQty`.
- **The shortfall is `items[].buyQty`** — deliberately per line and explicitly
  *not* `requestedQty − issuedQty`: "a line can be short without anybody having
  decided to buy the difference, and that difference is exactly what this
  records." `remainingQty` is a separate virtual and is **not** the purchase
  shortfall.
- **Fulfilment decision**: `fulfilmentDecision ∈ { issue_from_stock,
  partial_buy_balance, buy_or_service }`.
- **The forward link already exists**: `spendRequestId`, `spendRequestNumber`.

### 2. MRF shortfall → SpendRequest

`routes/CMS_Routes/Inventory/Operations/mrfRoutes.js` (~1725–2200). On a
`buy_or_service` / `partial_buy_balance` decision it creates the SpendRequest,
prices it, and stamps `sourceMrfId` + `sourceMrfNumber` (2141–2142); the MRF's
own `spendRequestId` is written at 2193 inside the transactional callback.

**Material finding:** `requestsSettings.mrfBudgetEnabled` gates this. When it is
off (`budgetInvolvementEnabled === false`) the request is created **already
`approved`**, with no Finance step — "Budget & finance review is currently
paused for MRF." A2 must therefore treat *the existing workflow's* authorised
state as the authority and must **not** require a commitment that the current
configuration never creates.

### 3. SpendRequest provenance

`models/CMS_Models/Requests/SpendRequest.js`

- `sourceMrfId` (indexed) + `sourceMrfNumber` — 699–700.
- `requestType ∈ { PRODUCT, SERVICE, SOFTWARE }`; `SOFTWARE` is labelled
  "Service" by the model itself.
- Status chain: `draft → submitted → pending_tl → pending_finance →
  awaiting_requester_confirmation → requester_revision_requested →
  requester_confirmed → approved → ordered`, plus `budget_exception`,
  `rejected`, `cancelled`.
- Lines `items[]`: `_id` (**this is `spendLineId`**), `name`, `rawItem`,
  `rawItemSku`, `quantity`, `unit`, `baseUnit`, `rate`, `amount`, `gstPercent`,
  `taxAmount`, `vendorId`, `vendorName`, `quoteRef`.
- **Finance decision**: `budgetApprovalKind ∈ { within_budget, over_budget,
  unbudgeted }` — the model states plainly that *"Finance may always approve;
  what changes is what the approval is on the record as."* All three are
  authorised decisions. `commitmentId` + `commitmentStatus` hold the promise.
- **Order link**: `purchaseOrderId` + `purchaseOrderNumber`, "set once… an
  approval that has one cannot be ordered again."

### 4. The approved-request → PO conversion (THE existing creation authority)

`POST /api/requests/spend/:id/purchase-order` — `spendRequests.js:1420`. It
already performs: fulfil-capability check; `status === approved` gate (returning
the existing order rather than a 409 when already ordered); PRODUCT-only refusal
(`SERVICE_ORDER_NOT_SUPPORTED`); company gate (`REQUEST_HAS_NO_COMPANY`);
existing-link and **orphan-repair** recovery; one-supplier gate by `vendorId`
identity then normalised name (`MULTIPLE_SUPPLIERS`); company-scoped vendor
resolution; line mapping that carries **`spendLineId`**, `rawItem`, quantity,
rate and tax straight off the approved lines; header totals re-derived from
those lines with `taxMode` SINGLE_RATE/MIXED_RATE; `documentSequence.allocate`
for the number; creation as **DRAFT**; duplicate-key (11000) race handling; and
`linkOrder`'s single conditional atomic write.

**Conclusion: A2 reuses this. It is not reimplemented.**

### 5. The generic PO endpoints (the ungoverned path)

`routes/CMS_Routes/Inventory/Operations/purchaseOrders.js`

- `POST /` (806) — `requireCapability(PO_CREATE)`, `refuseLegacyWrite`,
  `withIdempotency("PO_CREATE")`, `assertNoForeignCompany`, recovery via
  `req.idempotent.recovering.entityId`, `sequences.allocate`, forced
  `status: "DRAFT"`. **Takes vendor, items, quantity, unitPrice, gstRate,
  charges and totals straight from the body. No MRF. No SpendRequest.**
- `PUT /:id` (1085) — update.
- `PATCH /:id/status` (1471) — issue/cancel, `withIdempotency("PO_STATUS")`,
  constrained by `lifecycle.PO_REQUESTABLE`.

### 6. The PO model

`spendRequestId` (251) + `spendRequestNumber` (259); `items[].spendLineId` (15);
`{ companyId, poNumber }` unique (452); and a **partial unique index on
`spendRequestId`** where it is an ObjectId (470–475) — the database guarantee
that one approved request yields at most one order.

### 7. Frontend entry points for a material PO

- `app/store/dashboard/operations/purchase-order/new-edit-purchase-order/`
  → `NewEditPurchaseOrderClient.js` (2872 lines), POSTs the register endpoint at
  line 1247; already reads `useSearchParams`.
- The A1 workspace's **New purchase order** header action and empty-state link.
- The approved request's **Create purchase order** action on
  `/store/dashboard/order-requests/quote/[id]` → `POST /api/requests/spend/:id/purchase-order`.
- Raw-item, overview and vendor screens link to the same form route.

### 8. Cross-cutting mechanisms

`withIdempotency` (fingerprinted, with `succeed()` replay and a `recovering`
entity), `documentSequence.allocate` (atomic `$inc`), `unitOfWork.recover`,
`actionHistory`, `approvalPolicy`, `lifecycle`, and `storePurchase/errors.js`
`CODES` — **an unregistered code silently becomes 400 VALIDATION**, so every new
A2 code must be registered.

### 9. Multiple suppliers and partial orders — the present limitation

The current contract is strictly **one approved SpendRequest → one PO**, enforced
by the partial unique index *and* by `purchaseOrderId` being set once. Partial
ordering is **not modelled**: conversion orders every line and moves the whole
request to `ordered`.

A request naming two suppliers is refused with `MULTIPLE_SUPPLIERS` — and its
message currently tells the user to *"raise it in the purchase-order module"*,
which is precisely the unlinked-direct-PO bypass A2 must close.

### 10. Legacy identification

`refuseLegacyWrite` keys on `req.tenant.legacyMode` — records with **no
`companyId`**. That is a tenancy notion, **not** provenance: there is today no
marker distinguishing "a PO raised before the MRF rule" from "a PO raised
without one". A2 must add a deterministic, server-owned one.

## A2.2 The creation invariant

> A **new material purchase order** may exist only when the server has proved,
> from records it reloaded itself, that: an approved `PRODUCT` spend request of
> **this company** exists; it proves an operational need — a **material request
> with a real `buyQty` shortfall**, or a recorded **intake requirement**; it is
> at status `approved`; it names **one** supplier; and the lines ordered do not
> exceed what remains approved after every other live order. Nothing the browser
> sends can alter company, supplier, material, quantity, rate, tax or totals.

## A2.3 One authority, two doors, two proven origins

`services/storePurchase/governedPurchaseOrder.service.js`

- `resolveApproved()` — the shared core: approval gate, supplier rule, line
  derivation with `spendLineId`, already-ordered arithmetic, totals, provenance.
- `resolveChain()` — **the New purchase order form.** Requires a material
  request, always. No exception.
- `resolveForRequest()` — **the contextual Create purchase order action.**
  Requires a *proven operational need*: the material request it names, or the
  intake requirement it was raised from. Neither → `MRF_REQUIRED`.

### The one deviation, and why

Applying the MRF rule verbatim to the contextual action broke
`test/requests/intake.route.test.js` (161/161 at HEAD → 159/161), because
**intake is a third legitimate origin the brief does not mention**: a requester
asks, Store classifies the requirement as a purchase, Finance approves, and the
order is raised — with no MRF anywhere. Refusing it would have taken a live,
approved, budgeted journey offline.

`SpendRequest.intakeRequestId` is a first-class indexed field, so this is a
recorded origin, not a gap. The contextual action therefore accepts it, and
records **no invented MRF** — `sourceMrfId` stays null rather than guessed. The
form's rule is untouched, and an approval with neither origin is refused, so the
unlinked order this chunk exists to prevent is still impossible.

Per the brief's instruction to stop and report rather than guess on a larger
product decision: **making intake-originated requests require an MRF is a
product decision that has not been taken.**

## A2.4 Provenance, budget, editing, issue, legacy

**Provenance** — PO → `spendRequestId`/`spendRequestNumber`; PO →
`sourceMrfId`/`sourceMrfNumber`/`sourceMrfDepartment`; PO line →
`items[].spendLineId`. Ids are identity; numbers are stored beside them for
historical readability. All written by the server from reloaded records.

**Budget** — the approved request's existing commitment is reused. Creation
makes no second commitment, reserves nothing again, consumes no actual, posts
nothing to Accounting and releases nothing. A failed validation allocates no PO
number and writes no document.

**Editing** — `GOVERNED_FIELDS` (material, quantity, supplier, rate, tax,
budget, and the two source documents) belong to the approval; changing one means
revising and reapproving the purchase request. `OPERATIONAL_FIELDS` (delivery
date and instructions, terms, payment terms, notes, attachments, charges) stay
the buyer's — none alters the commercial decision.

**Issue** — `assertIssuable()` re-proves company, MRF and request availability,
the request→MRF link, the MRF number, request type, approval status, line
identity, quantity against what remains, and rate against the approved rate. It
runs **before** the approval policy, the status write, the timestamps, the
history entry and the supplier notification, so a refusal leaves everything
untouched.

**Legacy** — `provenancePolicy: "MRF_REQUIRED_V1"` is stamped on every governed
order and has **no schema default**, so historical documents stay unstamped.
`isLegacyOrder()` requires *no policy* **and** `createdAt < PROVENANCE_CUTOVER`
(2026-09-28T00:00:00Z, a constant, not configuration). An order created after
the cutover with no provenance is **not** legacy — it is broken, and is refused
at issue. `createdAt` is `immutable` on the model, so ordinary application code
cannot move an order across the cutover.

## A2.5 Multiple suppliers — the governed outcome

The contract remains **one approved request → one order** (partial unique index
on `spendRequestId`, plus `purchaseOrderId` set once). A request naming two
suppliers is refused with `SUPPLIER_SPLIT_REQUIRED`, and the correction now
sends the buyer **upstream** to split the request — the old message told them to
*"raise it in the purchase-order module"*, i.e. the unlinked direct order this
chunk exists to close. The form's multi-vendor mode can no longer POST one
ungoverned order per vendor: `submitState()` refuses `vendorCount > 1`.

**Still open, and a product decision:** true partial ordering (ordering part of
an approved quantity now and the rest later) is not modelled — conversion marks
the whole request `ordered`. Supporting it needs a per-line ordered-quantity
field on `SpendRequest.items[]`, a relaxation of the partial unique index, and a
decision about whether the commitment is discharged proportionally. Not
attempted here.

## A2.6 The tenant-search leak, found in three more places

`{ ...tenantContext.tenantFilter(...) }` followed by `filter.$or = [...]`
replaces the company clause. Fixed in `purchaseOrders.js` `GET /` (also
unescaped regex) and `GET /reports/exceptions`. **Still open, Lane B's file:**
`services/storePurchase/receiveWorkspace.service.js:257` and `:356`. Checked and
safe: `supplierOfferRead.service.js:202` (strict `companyId`).

## A2.7 Correction pass

### The invariant, now without exception

> A new material purchase order requires a real, same-company **`sourceMrfId`**
> and the complete validated chain **MRF → approved PRODUCT SpendRequest → PO**,
> at **every** entry point. Every line and its **full approved quantity** come
> from the stored request. All commercial values — supplier, rate, tax,
> discount, shipping, custom charges, line totals and grand total — are the
> approval's.

### Entry-point matrix

| Entry point | Authority | MRF | Quantities | Charges | Result without MRF |
|---|---|---|---|---|---|
| New purchase order form | `resolveChain` | required | full, server-derived | refused | `MRF_REQUIRED` (400), nothing written |
| Contextual Create PO | `resolveForRequest` → same core | required | full, server-derived | refused | `MRF_REQUIRED` (400), no draft, request untouched |
| Intake-origin request | `resolveForRequest` | **required** | — | — | `MRF_REQUIRED`, names the intake and links to it |
| Direct / API `POST /purchase-orders` | `resolveChain` | required | full | refused | `MRF_REQUIRED` (400) |
| Service order | *not governed by this rule* | n/a | n/a | n/a | unchanged |

**The intake bypass is gone.** It was a second door into the same invariant, and
a dead end besides: such an order was created with `sourceMrfId: null` and could
never be issued, because `assertIssuable` requires a material request. An intake
requirement must now be linked to, or converted into, a material request first.
That conversion is deliberately **not** automated here. The two intake
conversion tests were updated to the new rule; their identity assertions — what
they are really about — are unchanged.

### Stored budget-mode design

`SpendRequest.budgetApprovalMode ∈ { COMMITMENT_REQUIRED, BUDGET_PAUSED }`, with
`budgetApprovalModeAt` and `budgetApprovalModeSource`. Written by the server at
MRF approval from `RequestsSettings.mrfBudgetEnabled` **as it stands then**, so
flipping the setting later cannot rewrite history. **No schema default** — its
absence marks a request raised before the field existed.

At creation and at issue, `budgetAuthority()`:
- `COMMITMENT_REQUIRED` → a commitment must exist, belong to this company, be
  *this* request's, and be `committed`/`unbudgeted`/`partially_released`.
  `released` no longer holds the money.
- `BUDGET_PAUSED` → absence is allowed **only** because the marker proves it.
- **absent** → falls back to `COMMITMENT_REQUIRED`, the stricter reading.

A missing commitment is never read as policy. All three `budgetApprovalKind`
values remain valid approvals.

### Legacy classification

Date-based detection **failed open**: an order with a missing or unreadable
`createdAt` was treated as historical. Replaced by a marker written only by
`scripts/migrations/stamp-legacy-purchase-orders.js`:

| State | Meaning | May act |
|---|---|---|
| `LEGACY_PRE_MRF_V1` | migrated historical order | yes, old rules |
| `MRF_REQUIRED_V1` | governed, full chain | yes |
| unstamped | **unproven** | no — refused at issue |

The migration stamps only unstamped orders with a readable `createdAt` before
the cutover; undated ones are **listed for a person**, never swept up. It
invents no MRF, request, department, budget head or approval. `PROVENANCE_CUTOVER`
now only selects what to migrate — it is not consulted when deciding whether an
order may act. Unstamped orders remain fully **readable**; they are refused only
from acting.

### Issue-time revalidation

`assertIssuable()` re-proves: company; MRF existence, linkage and number; that
the MRF still has something to buy and still wants each material; request
source, PRODUCT type and status; **budget mode and commitment validity** through
the same `budgetAuthority`; supplier identity; line identity; quantity against
what remains; rate; **tax rate**; **charges and discount**; line arithmetic; and
that the header reconciles to the lines. Creation and issue share one authority.

**A real bug this found:** the contextual conversion moves the request to
`ordered` as it creates the PO, so a first version of the status check refused
to issue **every order that door produced**. An order may now be issued while
its request is `approved`, or `ordered` **as this very order**.

### Note on the reported duplicate key

No same-depth duplicate `expectedDeliveryDate` exists in
`governedPurchaseOrder.service.js`, `purchaseOrders.js` or `spendRequests.js`.
Verified with a brace-depth scan over comment-stripped source, which reports
duplicates per object literal rather than per file. Nothing was changed.

## A2.8 Integrity pass

### Line-provenance design

Identity is carried by **id**, never by name or array position — a name is
shared by two catalogue items and a position moves when an array is reordered.

```
MRF.items[]._id
  └─► SpendRequest.items[].sourceMrfLineId   (written at MRF approval)
        └─► PurchaseOrder.items[].sourceMrfLineId
                       + .spendLineId  → SpendRequest.items[]._id
```

`storeFulfilment.planFor()` now carries `rawItem`, `rawItemSku`, `variantId` and
`baseUnit` on each plan line, and `mrfRoutes` writes them with
`sourceMrfLineId` onto the request line.

At **creation and issue** the mapping must be a bijection into the MRF's buy
lines: every approved line names one, no line unknown, none claimed twice, none
missing, none extra. Material (`rawItem`), variant and unit must agree, and the
quantity must not exceed that MRF line's own `buyQty`. A line with no
`sourceMrfLineId` **fails closed** (`LINE_PROVENANCE_MISSING`) — "we cannot
tell" never reads as "it is fine".

*An MRF whose shortfall is material A can no longer authorise a request for
material B.*

### Complete line set at issue

`assertIssuable` checks the **set**, not the survivors. A2 orders an approved
request in full, so the PO must contain every approved line exactly once, none
cancelled, none reduced. The previous version looped only over lines still on
the order, which let a draft delete one approved line and issue the rest —
marking the request ordered in full while part of it was never bought.

### Exact commercial reconciliation

Equality within **half a paisa** (`TOLERANCE = 0.005`), both directions, for
quantity, rate, GST rate, GST amount, per-line charges, line total, subtotal,
tax total, shipping, discount, custom charges and grand total. An understated
document is refused as firmly as an inflated one: ₹100,000 of lines under a zero
header makes the order, the budget and the invoice disagree.

A lower supplier price is a **commercial change**, not a saving to be absorbed
silently — it belongs on the purchase request and is reapproved there.

### Commercial-adjustment approval path

Charges are preserved as a feature and given an approved home:

```
SpendRequest.approvedShippingCharges
SpendRequest.approvedDiscount
SpendRequest.approvedCustomCharges[] { label, amount }
        ↓ derived, read-only
PurchaseOrder.shippingCharges / discount / customCharges
```

Finance sees the grand total these make. A value sent to the order is **compared
with** the approved one — never ignored, never forced to zero. Negative and
malformed values are refused too: they are not "no charge", they are a figure
nobody can act on. To change one, revise and reapprove the request.

### Budget amount check

For `COMMITMENT_REQUIRED`: the commitment must exist, carry a `companyId` that
matches, belong to this request, be `committed`/`unbudgeted`/`partially_released`,
**and still hold enough** — `amount − releasedAmount` must cover the whole order
total. *A live commitment for ₹1 is not authority to issue a ₹100,000 order.*

Where `allocations` exist (their absence is the model's own legacy signal), every
approved line must have a **live** allocation covering it. Released allocations
contribute nothing. A line is compared against `amount + adjustment`, because an
allocation's amount is net of the header discount/freight share it absorbed —
comparing the bare amount would refuse legitimately discounted lines.

### Provenance policy whitelist

`SUPPORTED_POLICIES = [MRF_REQUIRED_V1, LEGACY_PRE_MRF_V1]`. Any other value —
misspelled, future, or trailing-whitespace — is refused with
`PROVENANCE_UNSUPPORTED`. A policy names the rules a record was made under; rules
this code cannot name, it cannot check.

### Migration rollout procedure

The cutover is a **deployment fact**, supplied by the operator, never a constant:

1. Deploy the enforcing code. From that instant every new order is stamped
   `MRF_REQUIRED_V1` as it is created, so the unstamped set stops growing.
2. Note that instant.
3. Dry run — writes nothing, lists every id it would stamp:
   ```bash
   node scripts/migrations/stamp-legacy-purchase-orders.js --cutover=2026-09-28T14:05:00Z
   ```
4. Resolve the undated ones deliberately (they are named in the report):
   ```bash
   node scripts/migrations/stamp-legacy-purchase-orders.js --ids=PO/2026-27/0007 --apply
   ```
5. Apply:
   ```bash
   node scripts/migrations/stamp-legacy-purchase-orders.js --cutover=2026-09-28T14:05:00Z --apply
   ```

It refuses without a cutover, refuses a future one, **refuses to apply** while
unstamped orders exist after the cutover (which would mean enforcement was not
live when believed), excludes undated records, and is idempotent — the filter
only ever matches orders carrying no policy at all. `SP_PROVENANCE_CUTOVER` is
accepted so a pipeline supplies it once.

### Supplier identity

An approved `vendorId` that is missing or belongs to another company is
**refused** (`SUPPLIER_UNAVAILABLE`). The old code fell through to a name lookup
and attached whichever supplier shared the name. Name matching survives only
where the approval genuinely names no id.

## A2.9 Final integrity correction

### The allocation arithmetic was wrong — corrected

`lineAllocation.allocateLines()` returns, per line:

| field | meaning |
|---|---|
| `lineAmount` | the line's own figure, **before** the header adjustment |
| `adjustment` | its apportioned share of freight / discount / rounding |
| `amount` | `lineAmount + adjustment` — the **final committed figure** |

The previous check used `amount + adjustment`, applying the header **twice**:
it overstated authority with freight, and — because a discount's adjustment is
negative — understated it and refused valid orders.

Worked example, from the allocator itself:

| case | `lineAmount` | `adjustment` | `amount` (final) | released | remaining |
|---|---|---|---|---|---|
| freight +600 | 12,600 | +600 | **13,200** | 0 | 13,200 |
| discount −600 | 12,600 | −600 | **12,000** | 0 | 12,000 |
| freight +500, discount −100 | 12,600 | +400 | **13,000** | 0 | 13,000 |
| 3 × 100, total 300.01 | 100 / 100 / 100 | 0 / 0 / +0.01 | 100 / 100 / **100.01** | 0 | — |
| partly released | 12,600 | 0 | 12,600 | 600 | **12,000** |

The old check would have demanded 13,800 in row 1 and 11,400 in row 2.

The validation now **re-runs `allocateLines()`** over the approved request and
compares each stored allocation with what it produces — no second formula, and
the paise-level rounding and last-line remainder rule are Finance's, not this
service's. It requires a one-to-one mapping (no duplicate, unknown, missing or
released allocation) and uses `remainingAmount`, or `amount − releasedAmount`,
for what is still held. The top-level check that the whole remaining commitment
covers the PO grand total is unchanged.

Fixtures were corrected to the real contract, **not** to make the code green: a
row storing `amount: 12000, adjustment: 600` and expecting 12,600 of authority
encoded the wrong contract — the stored `amount` is 12,600.

### Custom charges are compared exactly

Count and total alone treated `Handling ₹200 + Insurance ₹50` as equal to
`Freight ₹100 + Other ₹150`. Finance approved the **meaning** of each charge as
well as its amount.

**Canonical rule, used at creation and issue:** a multiset of
`normalised label | amount`, sorted, duplicates preserved.

**Order is not business-significant** — a charge list is a set of agreed costs,
not a sequence, and refusing a reordered form would be a refusal about nothing.
Labels are trimmed, lower-cased and inner whitespace collapsed; amounts compare
within the existing money tolerance. Two ₹50 "Handling" rows remain two rows.

### Supplier identity survives by id

Where the approved request names a `vendorId`, the PO's `vendor` must be
present and exactly equal. The previous check compared ids only when the order
still had one, so **removing the order's vendor id while leaving its name
intact passed**. A matching name cannot rescue an id mismatch; the supplier
must still belong to this company; and the stored name must agree with the
supplier it points at. Only a genuinely name-only approval keeps normalised
name comparison.

### Explicit migration targets are tenant-safe

A PO number is unique only **within a company**, so `poNumber: { $in: [...] }`
could stamp one document per tenant from a command meant for one order.
`--ids` is now **refused outright** rather than silently reinterpreted, and
`--object-ids=` takes immutable `_id` values. Invalid ids fail before any write,
missing records fail clearly, already-stamped records are reported separately,
the dry run prints `_id` + company + PO number, the apply uses those same ids,
governed records are never stamped, and re-running writes nothing.

## A2.10 The commercial-adjustment feature, restored as a workflow

The previous pass added `approvedShippingCharges`, `approvedDiscount` and
`approvedCustomCharges` and gave nothing the ability to write them. In the real
workflow they stayed zero and every PO charge was refused — the feature was
removed, not moved.

### Where Store enters each adjustment

| Moment | Route | What |
|---|---|---|
| First pricing of an MRF shortfall | `PATCH /api/cms/mrf/:id/fulfil` | shipping, discount, labelled charges, alongside the rates |
| Any time before Finance approval | `PATCH /api/requests/spend/:id/adjustments` | the same three, set or cleared |
| Requoting after a revision request | `PATCH /api/requests/spend/:id/requote` | carried with the new rates; omitted means unchanged, so a requote about one line does not drop last week's freight |

All three compute through **one** authority, `services/spendAdjustments.service.js`:

```
grandTotal = line subtotal + tax + shipping + charges − discount
```

### Where the requester and Finance see it

`publicRequest` now exposes `taxAmount`, `grandTotal`, the `quoted*` set and the
`approved*` set, **with each charge's own label and amount** — approving
"₹400 of charges" is not approving anything in particular. It previously exposed
only `totalAmount`, the line subtotal, so both the requester and Finance were
agreeing to a figure smaller than the bill.

### When it becomes immutable

At Finance's approval. `spendFinanceDecision` snapshots `quoted*` → `approved*`
and stamps `adjustmentsApprovedAt`. `PATCH /:id/adjustments` refuses an
`approved` or `ordered` request with `ADJUSTMENTS_SETTLED`.

**Two field sets, not one.** Sharing them would make "what Store last typed" and
"what Finance agreed" the same value, so an edit after approval would rewrite
the record of the decision — the order would carry figures nobody approved and
the approval would claim they had.

### How a revision is reapproved

Requote → back to the requester for confirmation → back to Finance → the
snapshot is retaken and the commitment rewritten. There is no edit-in-place
door, and no administrator endpoint.

### One worked calculation

100 m of cotton at ₹120, 5% GST, ₹500 freight, ₹250 handling, ₹100 discount:

| Step | Figure |
|---|---|
| line subtotal | 12,000 |
| tax | 600 |
| + shipping | 500 |
| + handling | 250 |
| − discount | 100 |
| **grandTotal** | **13,250** |
| requester confirms | 13,250 |
| Finance approves, commitment written for | **13,250** |
| `allocateLines` splits | lineAmount 12,600, adjustment +650, amount **13,250** |
| purchase order carries | shipping 500, discount 100, Handling 250, total **13,250** |

### `grandTotal` is checked, not trusted

`spendAdjustments.reconciles()` runs at PO creation **and** issue: stored
`grandTotal` must equal subtotal + tax + approved adjustments within the money
tolerance, or `GRAND_TOTAL_STALE` refuses. A stale derived figure is what the
commitment was made for and what the allocator splits — trusting it silently
means ordering against a number nobody can reproduce.

### The issue-time projection

`assertIssuable` reloads the request and rebuilds the allocation from
`grandTotal`, which **was not in the projection**. The allocator fell back to
the sum of the lines, lost the header adjustment, and refused a correctly
committed order with freight on it. Added, with the acceptance test that fails
when it is removed again.

### The migration is now testable code

`planExplicit`, `planByCutover` and `applyStamp` are exported; `main()` runs
only under `require.main === module`, so requiring the script connects to
nothing. The tests drive **the real functions** — the previous suite tested its
own copy, where a defect in the script would have passed.

### Note on the reported duplicate sentence

The two "still holds only …" messages are distinct checks — one for the whole
commitment, one for a per-line allocation — with deliberately parallel wording.
A scan for a phrase repeated inside any single message found none, and a diff
against the pre-splice backup shows every difference is an intended addition.
Nothing was changed.
