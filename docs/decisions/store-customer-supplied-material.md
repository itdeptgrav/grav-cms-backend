# Customer-supplied material on a development sample

**Status:** implemented, uncommitted · **Lane A** · 1 Oct 2026

## The decision

A material request line can say that **the customer is supplying the material**.
When such a request is approved, the system opens a **customer-material
expectation** for it, and Store receives against that expectation. No purchase
order is created — not a priced one, and not a zero-value "free" one.

The existing architecture does the work. There is no new intake kind, no second
reservation engine, no parallel receiving path:

| Stage | What already existed | What this feature added |
|---|---|---|
| Request | `MRF` | `items[].supplySource`, header `purpose` + work-context link |
| Expectation | `CustomerMaterialExpectation` | an explicit `origin`, and the development origin |
| Receipt | `CUSTOMER_MATERIAL` goods receipt | nothing |
| Stock | `CustomerMaterialLot` | nothing |
| QC, issue, return | unchanged | nothing |

## Why there is no purchase order

Because the company is not buying anything. A PO is a commitment to pay, and it
is what the commercial reports, the supplier ledger and the three-way match all
read. A zero-value PO would put a purchase that never happened into every one of
them, and the figure that would eventually be questioned — "why did we buy this
for nothing?" — has no answer, because the premise is wrong.

So the expectation is a different document, and it is the only thing a
customer-supplied line produces.

## Ownership is proven, never asserted

`customerId` is **never** read from the request payload. Whoever raises an MRF
cannot name the customer who owns the material, because a request is a statement
about what somebody needs, not about whose property it is.

Ownership is walked, by `services/merchandising/customerIdentity.service.js`:

```
confirmed order   order → ExecutionFile.currentHandoverVersionId
                        → SalesHandoverVersion → CustomerRequest.customerId
development       DevelopmentFile.journeyId → SalesJourney.accountId
                        → CRMAccount.linkedCustomer → Customer
```

Every hop is company-scoped. If any hop is missing, broken, or lands in another
company, the walk returns `UNPROVEN` with a reason and **routing refuses** —
leaving the approval intact and the expectation uncreated, which is the honest
outcome: the request is approved, and whose material it is remains unknown.

## One record type, two origins

`CustomerMaterialExpectation.origin` is `CONFIRMED_ORDER` or
`DEVELOPMENT_SAMPLE`. The first requires `executionFileId`, the second
`developmentFileId`, and a pre-validate hook refuses a document with **neither,
both, or one that does not match its own stated origin**. `sourceMrfId`,
`sourceMrfNumber` and `sourceMrfLineId` carry the demand lineage back to the
request that asked.

A development-sample expectation is created **`ISSUED`**, not `DRAFT`. The
approval already made the decision, and Store cannot receive against a draft —
a draft would mean the material arrives at a door that is shut.

## The trigger

One service — `services/storePurchase/customerSuppliedRouting.service.js` —
called beside `autoReservation` on every approval path, after that path's own
commit and never inside it. Reservation and routing are complementary, not
alternatives: `autoReservation` skips a customer-supplied line with the reason
`CUSTOMER_SUPPLIED`, because there is no company stock to hold.

Cancelling an approved request calls `cancelForRequest`, which withdraws the
expectation through Merchandising's own `cancel()` — honouring its
`expectedRevision` concurrency check rather than writing round it. It **refuses
to cancel** an expectation that has already received material, and refuses when
the received total cannot be read at all: "something may have arrived" is
treated as "something arrived".

## Uniqueness, and the mistake it took to get right

Two partial unique indexes are the idempotency, so a retried approval cannot
open a second claim on one delivery:

| Index | Keys | Holds |
|---|---|---|
| `one_expectation_per_request_line` | `companyId, sourceMrfLineId` | one claim per approved line |
| `one_revision_per_document` | `companyId, documentRef, revisionNo` | a document's revisions, numbered once each |

The revision rule was first written as `(companyId, developmentFileId,
revisionNo)`, by analogy with the pre-existing execution-file rule. **The
analogy does not hold.** An execution file has one expectation revised 1..n, so
keying its revisions on the file is keying them on the document. A development
may have several, because each approved customer-supplied line produces its own
document, each opening at revision 1. Keyed on the development, the second
fabric for one sample collided with the first and routing reported a duplicate
key — a legitimate case refused by an index that had mistaken the work for the
document.

`test/store-purchase/customer-supplied-routing.test.js` tests 26–28 reproduce
each index shape against the real engine, because an index is the one part of
this feature a schema file cannot prove: **mongo does not alter an existing
index to match a changed declaration.**

## What this feature does NOT do

Named explicitly, because each is a plausible next request and none is built:

- **supplier free-of-charge receipts.** A supplier sending material at no
  charge is a commercial arrangement with a supplier, not customer property. It
  has no path here.
- **inter-company or warehouse transfers** as a source of customer material.
- **sample inward** as a document type of its own — a development sample arrives
  on the existing `CUSTOMER_MATERIAL` goods receipt, against an expectation.
- **a Store-raised customer-supplied request.** The chain starts at an approved
  request whose work context proves the customer.

## Verified

Backend: `test/store-purchase/customer-supplied-routing.test.js`. Every guard
was neutralised and proven to fail before being restored.

Frontend: `components/store/receiving/workspace.test.mjs`, and the preview route
`/preview/store/receive` for the rendered structure.

**Not yet verified:** the live authenticated Store journey. See the task record.
