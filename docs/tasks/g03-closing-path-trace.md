# G03 — Closing-path trace (Gate A)

**Status:** Read-only trace, completed before any G03 edit. 21 September 2026.
Traced against the dirty `MAIN_SUB_BRANCH` working tree of both repos, including
the uncommitted tenancy change that scopes the verdict's Enquiry read. No
application code, Atlas data or live order was touched to produce this.

## 1 · The close command

`POST /api/cms/crm/sales-journeys/:journeyId/stage` with `{ action: "close" }`
(`routes/CMS_Routes/Sales/salesJourneys.js`, the `/:journeyId/stage` handler).

1. The journey is loaded with `scoped(req, …)`; the caller must own it or be a
   Sales manager.
2. For `close` only, the route calls
   `closingVerdictForJourney(journey._id, ctx)`, with `ctx` built from
   `salesScopeFor(req)` (`legacyAware: true`).
3. `if (closing) context = { closing }` — **a `null` verdict is dropped**, so
   the planner receives no context at all.
4. `planStageTransition` (`services/salesJourneyProgress.js`, `case "close"`)
   refuses only `verdict && verdict.canClose === false`. **No verdict → close
   proceeds.**
5. The write is `stageStates.retention = "complete"` and `closedAt = now`.
   `outcome: "closed"` is read in several places but written nowhere; the
   effective closed state is the final stage being `complete`.

**Side door.** `SETTABLE_STATES` includes `"complete"` and the `setState`
case has no final-stage guard. `setState { toState: "complete" }` on Retention
writes the same closed state as `close` — without `closedAt` and without any
verdict.

## 2 · The verdict — `services/closingVerdict.js`

- Enquiry read **is** company-scoped (`serviceFilter(ctx, { journeyId })`).
- CustomerRequest link: the **stored** `enquiry.customerRequestId` only. No
  fuzzy match, no write.
- Returns `null` for: no active enquiry; no stored link; no WorkOrder; a report
  with no boolean `canClose`; **any thrown error**. The header states the null is
  treated as "no financial objection known" — deliberately fail-open.
- `WorkOrder.find({ customerRequestId })`,
  `DispatchChallan.find({ manufacturingOrderId })` and
  `CustomerRequest.findById()` are read by id with **no ownership proof**.

## 3 · The report — `services/closingReport.js`

Three checks, and `canClose = every(done)`:

| Check | Certifies from | Problem |
|---|---|---|
| `delivered` | `WorkOrder.quantity` vs `min(packed, dispatchedQuantity)`; requires `ordered > 0` | Honest for G03 — the existing dispatch source. |
| `paid` | `quotations[0].grandTotal \|\| request.grandTotal` vs `paymentSchedule` | **A quotation or request total is not an issued invoice.** |
| `cost` | every `rawMaterials[].quantityIssued > 0` | **An issued quantity is not a complete actual cost.** |

## 4 · The display route and screen

- `GET /api/cms/crm/enquiries/:id/closing-report` resolves the request with
  `resolveRequestId()` — stored link first, else a **case-insensitive name
  match that writes the result back onto the enquiry**. It then reads
  WorkOrders, challans and the request with no ownership proof: a forged or
  mis-matched link **discloses another customer's closing facts**.
- `RetentionStage.js` disables "Close the order" on `!canClose` — not a control.
  It labels the quotation total **"Invoiced"** and **"Revenue invoiced"**, and a
  **"Paid" tile reads "settled in full"** on the quotation-derived `settled`.

## 5 · How the enquiry reaches the CustomerRequest

`enquiry.customerRequestId` is written by:

- `ensureOrderLink` (`services/orderBookLink.js`) at PO record:
  `journey.accountId` → `CRMAccount.linkedCustomer` → **newest**
  `CustomerRequest` for that `customerId`;
- the quotation screen and the production route's back-fill;
- the display route's name-match fallback above.

## 6 · How company ownership can be proved

| Record | Company field |
|---|---|
| SalesJourney | yes — loaded through `scoped(req)` |
| Enquiry | yes |
| CRMAccount | yes (`sealCompanyOwnership`) |
| CustomerRequest | **none** |
| WorkOrder | **none** |
| DispatchChallan | **none** |
| Acc_Invoice | **none** — and no writer sets its `customerRequestId` |

The only server-verifiable chain is:

```
SalesJourney (scoped) ── accountId ──▶ CRMAccount (scoped to the same company)
                                            │ linkedCustomer
                                            ▼
Enquiry (scoped) ── customerRequestId ──▶ CustomerRequest.customerId  must equal  linkedCustomer
                                            │ _id
                                            ▼
                         WorkOrder.customerRequestId / DispatchChallan.manufacturingOrderId
```

WorkOrders and challans have no company of their own; they are proved only
**transitively**, by hanging off a CustomerRequest that has itself been proved.

## 7 · Distinct cases

| Case | Today | After G03 |
|---|---|---|
| No active enquiry | `null` → **closes** | refused: named blocker |
| Enquiry with no stored request link | `null` → **closes** | refused: named blocker |
| Link to a request whose customer is not this company's account customer | reads it, **closes or leaks** | refused; no closing facts disclosed |
| Journey has no account, or account has no linked customer | reads it | refused: link cannot be proved |
| No WorkOrder on the request | `null` → **closes** | refused: named blocker |
| Any thrown dependency | `null` → **closes** | refused: named blocker |
| Short dispatch | refused | refused |
| Quotation total, schedule "paid" | **passes `paid`** | `paid` unavailable → refused |
| Every material has an issued quantity | **passes `cost`** | `cost` unavailable → refused |
| `setState complete` on Retention | **closes, ungated** | refused: use Close |
| Already-closed journey | readable | readable, unchanged |

## 8 · Consequence to decide

With `paid` and `cost` honestly unavailable, **no open order can be closed
through the API until G17 connects an authoritative invoice/receipt source and
an actual-cost source**. That is the fail-closed state the roadmap asks for. It
is recorded here, not worked around: no legacy bypass is added.

### Cohort the stricter gate now blocks

Deterministically, from the code rather than a live query: **every journey whose
final stage is not yet `complete`**. Before G03 some of these could close (any
with a null verdict, or a fully-scheduled quotation plus issued materials); after
it, none can. Already-closed journeys (`stageStates.retention = "complete"`) are
unaffected and stay readable.

To size it without writing anything, a read-only query (not run against Atlas by
this task):

```js
db.salesjourneys.aggregate([
  { $match: { isActive: true, currentStage: "retention",
              "stageStates.retention": { $ne: "complete" } } },
  { $group: { _id: "$stageStates.retention", journeys: { $sum: 1 } } },
])
```

### Exception design — for a separate decision, NOT enabled

No generic legacy bypass. If the business must close orders before G17 lands,
the defensible shape is a narrow **commercial-close exception**, not a flag:

- **Cohort, server-verified:** final stage in progress; order link proved (§6);
  `delivered` **met**; the only blockers are `paid` and/or `cost` with status
  `unavailable`. Anything `unmet`, or an unproved link, is never eligible.
- **Authority:** two people — the Sales manager and a Finance approver. Neither
  alone.
- **Durable audit:** a record naming the journey, both actors, timestamp, a
  required reason, the verdict snapshot (which checks were unavailable and
  why), and an open "reconcile when G17 sources exist" item that later review
  must close.
- **Scope:** it records "closed by exception", never "paid" or "cost complete".

This matches the plan's §6 ("payment outstanding may be a permitted
commercial-close variation only under explicit Finance/Sales policy").

## 9 · Findings outside G03, reported not fixed

1. **`resolveRequestId` shadowing bug (other lane's uncommitted tenancy
   change).** In `routes/CMS_Routes/Sales/enquiries.js`, the name-match
   fallback does `const req = await CustomerRequest.findOne(...)` and then
   `scoped(req, …)` — `req` is now the CustomerRequest, not the HTTP request.
   Four routes still use this fallback: `GET /:id/production`,
   `GET /:id/shipment`, `POST /:id/early-dispatch` and
   `GET /:id/commercial-ladder`. The committed version had no `scoped()` here.
   The closing report was the fifth caller; G03 moved it to the stored link, so
   it is unaffected.
2. **Order Book closing route reads a request by id with no company proof.**
   `GET /api/cms/sales/requests/:requestId/closing-report` in
   `customerRequests.js`. CustomerRequest has no company field and portal
   orders have no journey or Account to prove through, so the §6 chain does not
   apply. It inherits G03's honest `paid`/`cost` statuses automatically, but the
   disclosure question needs its own tenancy slice.
3. **No company field on CustomerRequest, WorkOrder, DispatchChallan or
   Acc_Invoice.** G03 proves ownership transitively (§6). Direct ownership is
   G01/G18 territory.
4. **Two companies' Accounts linked to one portal customer** would make a
   request provably belong to both. Not observed; noted as a limit of the §6
   proof.
