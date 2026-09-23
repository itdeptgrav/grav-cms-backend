# G02 — PO → exact order: the link contract (for Lane B)

**Status:** backend implemented, uncommitted, 22 September 2026, in two
slices: G02, then the safety follow-up in §5–§8. No frontend file was changed.
The `GET` and `POST /order-link` contract below has not changed since G02.

## 1 · What changed in G02

- `services/orderBookLink.js` no longer links a PO to the **newest**
  CustomerRequest of the account's portal customer. It also no longer reads the
  enquiry or account without a company.
- An order is **linked** only on proof:
  - `sales_origin`: the request was raised from this enquiry through Cost &
    Invoicing (`salesOrigin.enquiryId`). The head of the supersession chain
    wins.
  - `manual`: an authorised salesperson chose it from this company's
    candidates.
- The PO is always recorded. When the order cannot be proved, the response says
  **"Order not linked"** and nothing is written.
- `PATCH /enquiries/:id/link-request` (the quotation screen) no longer writes the
  id the browser sends. It resolves exactly as the PO path does.
- The new `Enquiry.orderLink` field records how the link was proved:
  `{customerRequestId, method, confirmedAt, confirmedBy{id,name}, reason, replacedCustomerRequestId}`.

## 2 · The `orderLink` object (unchanged)

Returned by:

- `PATCH /sales-journeys/:journeyId/po`
- `GET` and `POST /sales-journeys/:journeyId/order-link`
- `PATCH /enquiries/:id/link-request`
- since the follow-up, also `GET /enquiries/:id/{production,shipment,commercial-ladder}` and the early-dispatch refusal

```js
{
  status: "linked" | "not_linked" | "unverified" | "ambiguous" | "conflict" | "unavailable",
  method: "sales_origin" | "manual" | null,   // only when linked
  customerRequestId: string | null,            // CustomerRequest _id, only if proved to be this company's
  requestId: string | null,                    // human REQ-… reference
  message: string,                             // show as-is
  needsChoice: boolean,                        // offer the chooser
  candidateCount: number | null,
  confirmedAt: string | null,                  // ISO
  confirmedBy: string | null,                  // name, manual only
}
```

| status | meaning | Order Book should |
|---|---|---|
| `linked` | proved exact order | trust `customerRequestId` |
| `not_linked` | no link, none provable | show "Order not linked"; offer the chooser if `candidateCount > 0` |
| `unverified` | a pre-G02 or automatic link, a stale one (cancelled or superseded), or one that fails company proof | do **not** trust it; offer confirm or choose. When proof fails, `customerRequestId` is null |
| `ambiguous` | several current orders raised from this enquiry | chooser |
| `conflict` | the stored link disagrees with the order raised from this enquiry | chooser, which offers only the origin order |
| `unavailable` | no enquiry, or the check failed | show `message`; retry later |

Only `linked` means the Order Book may be trusted for this deal.

## 3 · The chooser (unchanged)

**`GET /api/cms/crm/sales-journeys/:journeyId/order-link`**

Access: owner or Sales manager (other users get 403). The call is read-only.

Returns `{ success, orderLink, candidates: [...] }`. `candidates` is empty unless `needsChoice` is true.

```js
{ customerRequestId, requestId, source: "sales" | "portal" | "measurement", status, createdAt,
  measurementName, itemCount, totalQuantity, itemNames: string[] /* ≤4 */,
  raisedFromThisEnquiry, isCurrentLink }
```

Candidates never include money. They are sorted newest first, which is display order only; nothing is ever pre-selected.

**`POST /api/cms/crm/sales-journeys/:journeyId/order-link`**

Access: owner or Sales manager. The body:

```js
{ customerRequestId, expectedCustomerRequestId /* the link shown, or null — REQUIRED */, reason /* required when replacing, ≥5 chars */ }
```

| result | when |
|---|---|
| `200 {changed, orderLink}` | success. Sending the same choice again returns `changed:false` and writes nothing |
| `400 expected_required` | `expectedCustomerRequestId` was not sent |
| `400 reason_required` | an existing link is being replaced without a reason |
| `409 link_changed` | the stored link is no longer the one the caller saw. Reload |
| `422 not_a_candidate` | one refusal for every order that was not offered. **Since the follow-up this also covers losing a race to another enquiry for the same order** |
| `404` | the journey or enquiry is not this company's |

## 4 · Candidate rules

- When orders were raised from this enquiry, only their current head(s) are
  offered.
- Otherwise the candidates are the orders of the portal customer that **only
  this company's** account is linked to. These exclude:
  - cancelled orders;
  - sampling and testing orders;
  - orders raised from another enquiry;
  - superseded orders;
  - orders another enquiry holds, meaning either:
    - a live claim (§6), or
    - a legacy link on another active enquiry **of this company**.
- When another company's account (or an unowned legacy account) links the same
  customer, no candidate is offered.

## 5 · Follow-up: every reader and writer of `Enquiry.customerRequestId`

| Path | Before | Now |
|---|---|---|
| `resolveRequestId` (enquiries.js), behind `GET /:id/production`, `GET /:id/shipment`, `POST /:id/early-dispatch`, `GET /:id/commercial-ladder` | Stored link, else portal customer by **name**, then that customer's **newest** order, **written** onto the enquiry. Also had the `req` shadowing bug | **Deleted.** All four read `provedOrderFor`. Production and shipment return `{linked:false, reason: orderLink.message, orderLink}`. Early dispatch returns **409 `order_not_linked`** and records no ask (it used to record one with no order). The ladder has no order rung and adds `orderLink`. Reads never write a link |
| `PATCH /:id/link-request` | (G02) resolver with write | unchanged; the stage lift now also goes through `recordOriginLink` |
| `GET /:id/closing-report` and the close gate (`closingVerdict`) | ownership only: any order of the right customer passed | **ownership + exactness** (§7). New refusal `unverified_link`: "not been confirmed as this deal's order" |
| `advanceStatus` (salesJourneys.js): payment gate on journey detail and the stage POST | read the enquiry **unscoped** and counted the linked order's `totalPaidAmount` as the advance received | scoped; only the **proved** order's payments count. With none proved, nothing counts as received, which keeps the gate shut |
| `proformaRequest.recordProforma` | wrote the link only if empty or on supersession, so a guess survived a real proforma | calls `recordOriginLink` (§8) |
| Order Book reverse lookups in customerRequests.js (`enquiryForRequest`, `upstreamOf`) | any enquiry holding the id, so a guessed enquiry's early-dispatch asks and estimate showed on this order. `upstreamOf` was **unscoped**, and threw on an undefined `req`, so provenance never showed | `provedEnquiryForOrder`: exactly one of this company's active enquiries holds the link, **and** that link passes the full proof |
| buyer brief (`orderBrief.service.js`, other lane) | `closingVerdict.proveOrderLink` (ownership only) | **same call, now exact.** No edit to that file |
| `services/orderBookLink.js` (PO, chooser, quotation) | G02 | every write goes through one `writeLink`: claim, then a conditional update, then release of the replaced claim |

Not a link to the enquiry: `WorkOrder.customerRequestId`,
`SampleStyle.production.customerRequestId`, and the IE, PPC, packaging, QC and
CEO readers. These key off work orders, not the Sales link, and were not
changed.

## 6 · One order, one enquiry: `order_link_claims`

New model `models/CMS_Models/Sales/OrderLinkClaim.js`. Its `_id` **is** the
order's id:

```js
{ _id: <CustomerRequest _id>, enquiryId, companyId, method, claimedAt }
```

**Why not a unique index on `Enquiry.customerRequestId` or `orderLink.customerRequestId`:**

- Production runs with `autoIndex: false` (`server.js`), so a new schema index
  does not exist in production until someone builds it by hand. Until then it
  enforces nothing.
- A unique build fails outright on any existing duplicate. Legacy guessed links
  were never checked for duplicates.
- A plain unique index also counts inactive enquiries and unverified legacy
  links, which would block corrections for reasons nobody can see.

MongoDB enforces `_id` uniqueness on every collection from creation. No index
build, deploy step or migration is needed.

**How a claim is used:**

1. Claim first, then the conditional enquiry update, then release the claim on
   any order the link moved away from.
2. If the conditional update fails, the claim it just made is released.
3. A claim younger than 60 s is a write in flight and always blocks another
   enquiry.
4. After that, a claim whose enquiry no longer links the order (a crash between
   claim and link) is **stale**. It is taken over conditionally on `claimedAt`,
   so two takers cannot both win.

**Rollout facts** (live Atlas, read-only harness, 22 Sep 2026):

| | count |
|---|---|
| enquiries | 9 |
| enquiries with `customerRequestId` | 0 |
| enquiries with `orderLink` | 0 |
| duplicate holders | 0 |
| origin-stamped requests | 0 |

- **Nothing needs backfilling.**
- `order_link_claims` already exists in that database with **0 documents**. A
  local `nodemon` dev server of this backend is running with `autoIndex` on, and
  it created the collection when the new model loaded. That was not a write by
  this lane.
- If links ever exist without claims, the rules are:
  - an origin link gets its claim on the next proforma replay;
  - a manual one gets its claim when it is reconfirmed;
  - until then, the chooser's own-company legacy check still refuses the order
    to other enquiries.

## 7 · Exactness: one rule, `services/orderLinkProof.js`

`proveOrderOwnership` is the G03 logic, moved here unchanged. It checks origin,
or else the customer chain with the no-other-company rule.

`classifyStoredLink` then requires the link to be **exact**:

| Kind of link | Exact when |
|---|---|
| Origin-raised order | still the head of its chain: not cancelled, not superseded. When several heads exist, only if a person confirmed this one |
| Customer-chain order | `orderLink.method === "manual"` for **this** id, with `confirmedBy` set, **and** no order has since been raised from the enquiry. If one has, the result is `conflict` |

Everything else is `stale`, `ambiguous`, `conflict` or `unconfirmed`.

`closingVerdict.proveOrderLink` now uses both steps, as does the resolver. So
the close gate, the closing screen, the buyer brief, the Sales screens and the
chooser cannot disagree.

## 8 · Proforma supersession: `recordOriginLink`

The request is re-read, and must be **this enquiry's current head**. Then:

| What the enquiry holds | What happens |
|---|---|
| No link, or a link to this order | linked with proof and claimed |
| An unproved link (guess, superseded predecessor, cancelled order) | **replaced**; the old id is kept in `orderLink.replacedCustomerRequestId`, and the old claim is released |
| A link a salesperson confirmed to another order | **kept**; the resolver reports `conflict` for a person to settle |
| Several current heads | nothing written (`ambiguous`) |
| An order from another enquiry, or a late replay of a superseded predecessor | never written |
| A replay of what is already linked | idempotent: same `confirmedAt`, one claim |

## 9 · Tests

Two new suites:

- `test/crm/order-link.route.test.js` (G02): 23 tests.
- `test/crm/order-link-safety.route.test.js` (follow-up): 31 tests:
  - each old writer;
  - unverified legacy links, including the advance gate and the Order Book
    reverse lookup;
  - wrong-company orders;
  - supersession through the real `recordProforma`;
  - concurrent claims, including one with the candidate pre-check blinded so
    only the database claim stops the second enquiry;
  - stale-claim takeover, release on replace, release on a failed write;
  - retries.

Updated suites:

- `test/crm/sales-journey-close.route.test.js`: the fixture's default link is
  now salesperson-confirmed, with four new exactness refusals. 37 tests.
- `services/orderBookLink.test.js` (`node --test`): source guards. There is one
  writer, it claims first, and there is no name guess in the enquiry routes.

Mutation-checked. Each regression below was re-introduced and the tests failed
(files restored byte-for-byte):

- `resolveRequestId` restored;
- ownership-only closing;
- the old `recordProforma`;
- claim always granted;
- the old `advanceStatus`;
- reverse lookup trusting any link;
- claim release as a no-op;
- no stale takeover.

**Relevant backend set** (16 suites):

- Before this follow-up: 30 failed of 415.
- After: the same 30 failed. Nothing new failed, and 35 tests were added.
- One run showed 7 extra failures. They were in-memory-Mongo start timeouts and
  a 60 s timeout under parallel load from other lanes, and each passes when its
  suite is re-run alone.

The inherited failures:

| Suite | Failing tests | Cause |
|---|---|---|
| `crm/enquiry.route` | 24 | pre-existing |
| `crm/sales-journey.route` | 3 | pre-existing |
| `costing/sales-tenancy-guard` | 1 | other lanes' unscoped queries. G02's one flagged line is gone |
| `costing/proforma-request` | 1 | another lane's `assembleOrderBrief.test.js` |
| `sales/order-brief` | 1 in the baseline | passed in the after-run |

## 10 · Order Book ownership (`routes/CMS_Routes/Sales/customerRequests.js`)

Every route in that file used to read or change a CustomerRequest by `_id`
alone. The list, export and dashboard also covered every company's orders.
Each route now proves the order is the caller's company's first, through
`services/sales/orderOwnership.service.js`.

### The rule

It reuses existing rules. They are tried in this order, and the first that
applies decides:

| # | Evidence | Existing rule it reuses | Decisive? |
|---|---|---|---|
| 0 | Sole-company deployment: the company master holds one company and it is the actor's | `salesScope.allowUnowned` | yes |
| 1 | `salesOrigin.enquiryId` is an enquiry visible to the caller's company | the G02 origin chain | **yes**: another company's origin refuses |
| 2 | Each line's `sampleStyleId` proves the company through its journey or enquiry | `styleOwnershipProof`, as used by the handover and the buyer brief | **yes**: every named style must exist and prove; one foreign style refuses |
| 3 | The portal customer is linked (`Account.linkedCustomer`) by this company **and by no other** | the G02/G03 customer chain | a contested customer refuses |

Never used as evidence: the customer's name, the newest order, an enquiry that
merely points at the order, the measurement's organisation (a portal
customer), or who created the order.

**Refusal:** 404 "Order not found." — identical for foreign, contested,
unattributable and missing orders. The scope's own 401/403/409/503 pass
through.

**Where it is enforced:** `proveOrderOwned` handles single orders.
`ownedOrdersFilter` / `withOwnedOrders` express the same rule as a Mongo
filter. It is memoised per request, and a test checks that a row is listed if
and only if its own page opens.

### Routes protected (all 20)

| Kind | Routes |
|---|---|
| Reads | `GET /:id/persons`, `/requests/:id`, `/requests/:id/notes`, `/:id/edit-requests`, `/requests/:id/production`, `/requests/:id/shipment`, `/requests/:id/closing-report` |
| Lists | `GET /requests` (including the unfiltered `stats`), `/requests/export`, `/dashboard`, `/dashboard/recent-requests`, `/dashboard/top-customers` |
| Writes | `PATCH /requests/:id/{status,assign,priority}`, `POST /requests/:id/notes`, `POST /:id/edit-request`, `POST /:id/approve-edit`, `POST /:id/reject-edit` |

Writes prove ownership **before** the document is changed. A refused
`edit-request` sends no customer email.

In multi-company deployments the dashboard's `totalCustomers` now counts the
customers of this company's orders; sole-company deployments are unchanged.

### Bugs fixed on the way

- `GET /:id/persons` called `personsOnOrder` without importing it, so it
  answered 500 for every order. This was already broken in `HEAD`.

### Tests

`test/sales/order-book-ownership.route.test.js`: 144 tests, driving the real
router as two companies. Fixtures:

- A's own orders: portal, measurement, origin, style.
- B's orders: portal; origin-from-B with an A customer; mixed A/B styles.
- Orders nobody can attribute: a contested customer, an unknown portal order,
  an unknown measurement order, an order with a guessed enquiry link and a
  matching buyer name.

What they check:

- Every read and every write, both ways.
- A missing id and a foreign id get the same refusal.
- Every denied write leaves the stored document **byte-identical**.
- List, export, dashboard, recent and top-customers only show this company's
  orders.
- A search cannot widen the list past the company.
- A legacy order becomes readable when its customer is linked to this company
  alone, and stops being readable when a second company links the customer.
- The sole-company case.

Mutation-checked. Each regression below was re-introduced and the tests failed
(files restored):

- no proof;
- no list filter;
- contested customer accepted;
- origin not decisive;
- any one style sufficing;
- the status route left unguarded.

Neighbouring suites: order-brief, order-link, order-link-safety, closing and
the tenancy guard all pass, except the guard's pre-existing offender list, which
this adds nothing to.

### Legacy orders that cannot be attributed yet

Live Atlas, read-only harness, 22 Sep 2026:

- The company master holds **3 active companies**. Two were created on 21 Sep,
  probably the smoke fixture. So the sole-company allowance is **off**.
- **All 25 orders** have no ownership evidence:
  - 17 portal (`customer_request`) and 8 measurement (`measurement_conversion`)
    orders;
  - 10 distinct portal customers;
  - 0 with a Sales origin, 0 naming a sample style;
  - **0 whose customer is linked by any CRM account**.

**Once this is deployed, the live Order Book is empty for every company.** The
same is already true of every other unowned Sales record in a multi-company
deployment.

To restore them without guessing:

- **Recommended:** a person links each real customer's CRM account to its portal
  customer (`Account.linkedCustomer`, an existing field). That company alone
  then sees all of that customer's orders, past and future.
- **Alternative:** remove the fixture companies, which re-enables the
  sole-company allowance.

Nothing was written to live data.

## 11 · Still open

1. **Frontend reads the raw link.** `usePiWorkbench.js` opens
   `enquiry.customerRequestId` as the PI when one is stored, even if it is
   unverified. The enquiry DTO still carries the raw id. **Lane B:** gate that
   on `orderLink.status === "linked"`.
2. **`/api/cms/sales/requests/:id/*` (Order Book by order).** These routes still
   read work orders, challans and money for any request id with no company
   proof. They are portal orders with no journey, so this needs a CustomerRequest
   tenancy slice (G01/G18).
3. **No `companyId` on CustomerRequest, WorkOrder, DispatchChallan or
   Acc_Invoice.** Ownership stays transitive.
4. **Legacy links are left in place.** Unverified links are reported and never
   rewritten, except by an order raised from the enquiry (§8). No bulk
   clean-up has been done. Live Atlas holds none today.
5. **Claims on other paths.** A person's manual link can hold an order only
   through a claim. An enquiry deactivated while holding a claim keeps it until
   another enquiry needs the order. The claim is then dead (the holder is
   inactive) and is taken over after the grace period.
6. **`closingVerdict` still cannot close.** `paid` and `cost` stay `unavailable`
   until G17. That is unchanged.
7. **`routes/CMS_Routes/Sales/quotationRoutes.js` has no ownership proof on any
   of its 26 routes that take a CustomerRequest id.** These include:
   - `DELETE /requests/:requestId`;
   - `record-payment`, `approve-on-behalf`, `sales-approve`, the quotation and
     revision writes;
   - the people and employee edits;
   - `work-orders`, `raw-item-requirement` and `po-breakdown`.

   It is mounted at the same `/api/cms/sales` prefix, so the Order Book is only
   half closed. The smallest complete fix is one `router.param("requestId", …)`
   in that router calling `proveOrderOwned`. It was left for a decision because
   the CEO dashboard and the raw-item requirement slider call these routes too,
   and would be refused for any user without a Sales company membership.
8. **CEO dashboard Sales page.** It lists and changes orders through these
   routes, so a CEO with no Sales company membership now gets the scope's
   refusal. That is the same behaviour as every other Sales route.
9. **`PATCH /requests/:id/assign`** accepts any `salesPersonId`. The order is
   proved, but the person is not checked to be in the same company.
10. **The customer portal's own routes** (`routes/Customer_Routes/*`) are keyed
    by the signed-in customer and were not touched.

