# CENTRAL COSTING LANE A — THE COMMERCIAL INPUTS MOVED TO SALES (8 Sep 2026)

## The product rule this implements

> Sales owns the commercial question: which approved style is being quoted,
> what quantities the customer wants priced, the commercial unit, the proposed
> selling price, the commercial note, and when the estimate is needed.
>
> Central Costing consumes the Sales brief and all departmental and Board
> sources invisibly. No user opens Costing to enter a commercial fact.

## What moved, and from where

| Input | Was | Is |
|---|---|---|
| Which of several SampleStyles | `?styleId=` on the preview, `technicalStyleId` on the calculation, a picker in `CostingWorkspace` | `Enquiry.costingBriefs[].sampleStyleId` |
| Run sizes, and which is primary | `scenarios[]` on the calculation, a repeatable editor | `costingBriefs[].quantities[]` |
| The quantity unit | `scenarios[].quantityUom` — **per scenario** | `costingBriefs[].quantityUom` — **once for the brief** |
| Proposed selling price excl. tax | `scenarios[].proposedSellingPriceExclTax` | `quantities[].proposedSellingPriceExclTax` + `currency` |
| The costing note | `note` on the create/calculation payload | `costingBriefs[].note` |
| When the estimate is needed | nowhere at all | `costingBriefs[].requiredBy` |

The unit being per scenario allowed one costing to quote 500 pieces beside 500
metres. It is stated once now, and stamped onto every quantity server-side.

## Where the brief is stored, and why there

**`Enquiry.costingBriefs[]` — top-level, keyed by `SampleStyle._id`.**

* Not on `products[]`: `sanitizeProducts()` rebuilds that array on every
  requirement save and reassigns each row a fresh `_id`. Anything stored on a
  product row is lost the next time somebody edits a quantity — which is why
  `costLedger` and `costingSheets` are top-level and keyed by product NAME.
* Not keyed by product name either. That was the fallback those two had to
  take, and it breaks on a rename and on two spellings of one garment.
* `SampleStyle._id` is stable for ever. `productName` is kept as a **display
  snapshot** and is never joined on.

## Style eligibility

A brief may be confirmed only against a style whose **approved technical
revision** exists — `technicalRecord.approvedRevisionOf(techSheet)`, the frozen
revision Sales approved, not `techSheet.status`. Reading the status field would
let a style be briefed that the costing engine then refuses.

Ineligible styles are **listed with their reason**, never hidden: an absent
option reads as a style that does not exist, and somebody waiting on an
approval needs to see which one.

The chooser publishes identity and approval state only — style code, reference,
variant, and the three gate statuses. No consumption, operation, standard time,
material, quotation or cost: what is IN a style is R&D's and Production's
record, and Sales choosing between styles does not make them a reader of it.

## Supersession

A confirmed brief is what a frozen costing version cites, so it is never
edited and never retargeted. Confirming a brief for a different style of the
same product **closes the earlier one explicitly** — `state: SUPERSEDED`,
`supersededByBriefId`, `supersededBy`, `supersededAt` and a reason. The old
brief goes on naming the style it was actually for.

Two confirmed briefs for one product are **reported, never ranked**: preferring
the newest would silently choose which garment the company quoted.

## Scenarios are quotation quantities, not production orders

A quantity on a brief is a **quotation break point** — "what does this cost at
500, and at 2,000". Several are normal and they are hypothetical. The committed
figure is the work order's, arrives much later, and through a different record.
Reusing an order-quantity structure for these would make a quote look like a
commitment; `approvedOutput` already publishes them to Sales as
`quantityBreaks`, which is what they are.

## Idempotent costing orchestration

Unchanged, and now proved end to end:

* **Costing + version 1** — `POST /api/costings`, guarded by the creation claim
  and its unique index (not the idempotency marker, which is a second write and
  can fail).
* **Each later version** — `POST /:id/versions` under
  `withIdempotency("COSTING_VERSION_CREATE")`, the key bound to the costing in
  the URL. One key, one version: a retry after a lost response returns the same
  version rather than making a second.
* **Two deliberate calculations under two keys** are two versions, which is the
  existing contract and is unchanged.
* An **approved** version is immutable — a later brief revision does not reach
  back into it. A version records what was approved, not a live view of the
  request.

## The refusal contract

```
POST /:id/versions  { scenarios | note | technicalStyleId | quantityUom }
→ 400 COSTING_BRIEF_MOVED
  details: { fields, owner: {department:"Sales", recordedIn:"Enquiry · Costing brief"}, briefAt }

POST /:id/versions  (no confirmed brief, or a DRAFT one)
→ 409 COSTING_BRIEF_REQUIRED
  details: { reason:"NO_CONFIRMED_BRIEF", owner, enquiryRef, product }
```

Refused, never stripped: calculating from the brief while silently discarding
what somebody just typed produces a version that is right and unexplainable,
and a proposed price they believe they recorded would be absent with nothing
saying why.

**Several styles and no brief is `COSTING_BRIEF_REQUIRED` too** — and the
candidates are deliberately **not** published with it. A list of styles
attached to a refusal is an invitation to pick one.

## What is now read-only or absent in Costing

Absent: the scenario editor, the quantity-unit field, the proposed-price field,
the style picker, `?styleId=` on the preview, `toWireScenario`, `seedFrom`'s
scenario seeding, `priceFromPrevious`. `sourceBackedPayload()` takes **no
arguments** and returns `{ lines: [] }`.

Read-only: a `SalesBrief` panel showing the style, each quantity with its unit
and proposed price, the note, the required-by date, and who confirmed it when.
Where there is no brief it names Sales and their screen rather than offering a
blank editor.

## Every interactive action left inside Costing

1. Calculate a new version.
2. Submit for review.
3. Approve, or reject with a reason.
4. Import a historical Sales costing sheet — a migration route with its own
   capability, which states its own run sizes because it predates briefs
   entirely and demanding one would make historical enquiries permanently
   un-importable.

No figure, rate, quantity, unit, price, style, supplier or applicability
decision.

## Next Lane A task

**A Production-owned manufacturing-method decision**, if fully outsourced
garment manufacture is a business case the company actually has. It is the one
cost family whose "no escape" answer rests on the repository recording nothing
rather than on the fact being inherently required, and it needs a product
decision before any code.
