# Industrial Engineering — Order Readiness Data Audit (Chunk 1C / Lane A / Chunk 1D)

**Audit date:** 8 September 2026  
**Run at:** 2026-09-08T08:59:12.106Z → 2026-09-08T08:59:13.109Z  
**Environment:** `NODE_ENV=development`, database `test`  
**Script:** `scripts/audits/ie-order-readiness-audit.js` — strictly read-only  
**Decision logic:** `services/industrialEngineering/orderStyleLink.js`, the same
module the Orders endpoint calls  
**Ownership rule:** `styleOwnerFrom` with `activeOnly: false` — the Lane A
status-independent mode, shared with the endpoint  
**Status:** **ACCEPTED 8 September 2026.** Chunk 1C (this audit) and Lane A are
both accepted. Acceptance approves **no historical backfill** — see "What must
be decided next".

> **Supersedes the earlier runs of this audit (same date).** Every figure below
> is from the Lane A run and no superseded number is retained.

## Ownership policy — Lane A

**Company ownership is permanent record provenance. Lifecycle status controls
queue participation, not ownership.**

- A completed, cancelled or archived style still proves which company a work
  order belongs to, and its order is retained in IE order history.
- Active Merchandising work queues continue to exclude those same styles. Their
  behaviour is unchanged.
- A cancelled or archived style behind an open order produces an explicit typed
  warning; it never silently removes the order.
- A completed style produces **no** warning. Development that finished is what
  production is supposed to be built on.

What Lane A did **not** relax is parentage. A named journey is still
authoritative; an enquiry still answers only for a style with no journey; a
missing, dangling or company-less journey is still unprovable; and customer,
creator, product name and free text still establish nothing.

## Verdict

> ## `NOT_READY_FOR_ORDER_WISE_FRONTEND`

Lane A recovered **five** work orders — attributable orders went from 1 to 6 —
and nine styles that lifecycle status had been erasing. But **nought of the 95
operational work orders can still be displayed.** The orders it recovered are all `completed`.

The verdict is derived, not assumed: operational coverage is
0.00%, 95 operational
orders lack one-company attribution, so full readiness is unavailable; and with
0 visible operational orders there is no partial coverage to
disclose either.

## What was scanned

| Population | Count |
|---|---|
| WorkOrders scanned | 147 |
| SampleStyles scanned | 39 |
| SampleStyles with **provable company ownership** (IE, lifecycle-independent) | **34** |
| SampleStyles eligible for an **active Merchandising queue** | 25 |
| CustomerRequests inspected as joins | 19 |
| Distinct CustomerRequests named by work orders | 19 |
| SalesJourneys read (for `companyId` only) | 15 |
| Enquiries read (for `companyId` only) | 14 |
| Distinct companies observed | 1 |

The gap between 34 and 25
is Lane A in one number: **9 styles
prove ownership but do not belong in an active work queue.** Before Lane A the
IE boundary used the second figure for both questions, and those styles' orders
vanished.

Nothing confidential was read or printed. The Sales parents were projected to
`_id` and `companyId` alone; the customer requests to their line structure
alone. No customer, buyer, email, phone, enquiry reference, journey reference,
quotation, price, cost, margin, payment, invoice, salary or wage was selected,
and no connection string or credential appears in the output. Company identities
are reduced to opaque labels.

## Population by status

Statuses come from `WorkOrder`'s own enum. A value the enum does not declare is
`UNRECOGNISED` rather than folded into "open", so it cannot inflate the
denominator the verdict rests on.

**Denominator: 147 work orders (all of them).**

| Class | Stored statuses | Count | % of 147 |
|---|---|---|---|
| Operational / open | `scheduled` 88, `pending` 5, `planned` 2 | **95** | 64.63% |
| Completed / historical | `completed` 51 | 51 | 34.69% |
| Cancelled | `cancelled` 1 | 1 | 0.68% |
| Missing / unrecognised | — | 0 | 0.00% |

## Company attribution

Status-independent ownership; both stored references resolved together, so an
order whose references reach different companies is attributed to neither.

**Denominator: 147 work orders.**

| Attribution | Count | % of 147 |
|---|---|---|
| `ONE_COMPANY` — displayable | **6** | 4.08% |
| `MULTIPLE_COMPANIES` | 0 | 0.00% |
| `NO_COMPANY_PROOF` | 141 | 95.92% |

All 6 attributable work orders are `completed`. **None is
operational.**

## Style-link status

**Denominator: 147 work orders.**

| Status | Count | % of 147 |
|---|---|---|
| `DIRECT_WORK_ORDER_REFERENCE` | 0 | 0.00% |
| `UNIQUE_ORDER_LINE_REFERENCE` | 0 | 0.00% |
| `BOTH_REFERENCES_AGREE` | 7 | 4.76% |
| `REFERENCES_CONFLICT` | 0 | 0.00% |
| `AMBIGUOUS_ORDER_LINES` | 0 | 0.00% |
| `UNRESOLVED_ORDER_LINE` | **140** | 95.24% |
| `NO_STYLE_REFERENCE` | 0 | 0.00% |

No conflicts and no ambiguities anywhere in the population. Seven orders have
agreeing direct and order-line references. **Before Lane A one of them was
attributable; after Lane A six are — five orders recovered.** The seventh is
still refused, and for a different reason: its style has no provable company
parentage, which Lane A deliberately did not relax. So of the six that had been
hidden, five were lost to a closed style and one to unprovable parentage.


## Chunk 1D — canonical order-to-style linkage

**Denominator: 147 work orders.**

Chunk 1D added `WorkOrder.sampleStyleId`, written at creation by every live
work-order writer. **No backfill is authorised**, so every record below predates
the field and the canonical counts are expected to be nought until new orders
are released.

| Linkage | Count |
|---|---|
| Canonical link only | 0 |
| Canonical agreeing with a legacy reference | 0 |
| Legacy direct reference only | 0 |
| Legacy request-line reference only | 0 |
| Legacy direct + request-line agreeing | 7 |
| Conflicting references | 0 |
| No reference of any kind | **140** |
| Canonical present but naming no ownable style | 0 |

**Operational orders — denominator 95.**

| Measure | Count |
|---|---|
| Visible through a canonical link | **0** |
| Still unresolved | **95** |

This is the honest result and it is what was expected: the write path is in
place, no historical record was touched, and the existing register therefore
reads exactly as it did before. The figures move when new orders are released,
not before. Re-run this audit after the first release to measure it.

## Operational orders — the number the frontend decision rests on

**Denominator: 95 operational work orders.**

| Measure | Count |
|---|---|
| Attributable to exactly one company | **0** |
| Attributable to several companies | 0 |
| No company proof | **95** |
| Direct + line references conflict | 0 |
| Ambiguous shared-product lines | 0 |
| Order line unresolved | 95 |
| **Displayable on the IE Orders page** | **0** |
| **Percentage displayable** | **0.00%** |
| Would be silently absent | **95** |

Lane A did not move this figure, and was not expected to: the operational
population's problem is a missing LINK, not a closed style. All 95 open orders
resolve to `UNRESOLVED_ORDER_LINE`.

## Style ownership — the two questions, apart

**Denominator: 39 sample styles scanned.**

| Finding | Count |
|---|---|
| **Company ownership provable (IE)** | **34** |
| Eligible for an active Merchandising queue | 25 |
| Retained for IE despite terminal status | **9** |
| Retained for IE despite being archived | 0 |
| Unprovable parentage — the only real ownership fault | **5** |
| Styles naming at least one work order | 13 |
| Duplicate work-order ids within one style | 0 |
| Direct references pointing at a work order that does not exist | **7** |

Unprovable reasons in full: `NO_PARENT` 5.

Terminal and inactive are no longer reported as exclusions. They are RETAINED
for ownership and excluded only from the Merchandising queue figure.

## Engineering behind the styles that ARE linked

**Denominator: 5 styles reachable from an attributable order.**

| Measure | Count |
|---|---|
| No route in either source | 1 |
| SAM incomplete | **4** |
| SAM complete | 1 |
| Duplicate operation-code ambiguity | 0 |

Route comparison: `MATCHED` 1,
`ONLY_PRODUCT_ROUTE` 3,
`NO_ROUTE` 1; every other state 0.

## Data quality

**Denominator: 147 work orders.**

| Finding | Count | Reading |
|---|---|---|
| `MISSING_WORK_ORDER_NUMBER` | **144** | the field is absent. Only 3 orders carry the internal reference an Orders page is read by |
| `REQUEST_LINE_MISSING_STYLE_ID` | **147** | the request line matching the order's product carries no `sampleStyleId`. Exactly one CustomerRequest has an item-level style id at all |
| `STYLE_OWNERSHIP_UNPROVABLE` | 1 | an order reaching a style with no provable parent |
| `MISSING_STOCK_ITEM_RECORD` | 1 | the order names a product that no longer exists |
| `DIRECT_AND_LINE_REFERENCES_CONFLICT` | 0 | no order has two references naming different styles |
| `MISSING_CUSTOMER_REQUEST` | 0 | every order names a request, and every named request exists |
| `NO_REQUEST_LINE_MATCHING_PRODUCT` | 0 | every order's product is on a line of its request |
| `REFERENCED_STYLE_MISSING` | 0 | no order references a SampleStyle that is absent |
| `SHARED_PRODUCT_REQUEST_LINES` | 0 | no request has two lines naming one product |

## Why every operational order is still invisible

Lane A removed one of the four causes. Three remain, and each is sufficient:

1. **No order record carries a company.** `WorkOrder`, `CustomerRequest`,
   `Customer` and `StockItem` all lack `companyId`. Company can only be proved
   through a linked style's Sales parents.
2. **The order-line style reference is effectively unpopulated.** Exactly one
   CustomerRequest carries an item-level `sampleStyleId`; seven carry a
   request-level one. All 95 operational orders resolve to
   `UNRESOLVED_ORDER_LINE`.
3. **The direct reference is sparse and partly dangling.** Thirteen styles name
   a work order; 7 of those references
   point at orders that no longer exist.

~~4. Most linked styles are not eligible.~~ **Closed by Lane A.** Terminal and
inactive styles now prove ownership, which recovered **five** orders (1 → 6) and
nine styles. It did not close cause 5 below.

5. **One agreeing-reference order has a style with no provable parentage.** The
   seventh of the seven agreeing orders is refused for that reason, not for its
   lifecycle, and Lane A was right not to touch it.

## What must be decided next

Decisions for review. **No production data was corrected, no field added and no
migration written — and accepting this audit approves no historical backfill.**
Decision 1 below shipped as **Chunk 1D**, accepted 8 September 2026; it is a
write path for NEW orders. Decisions 3–6 concern existing records and remain
unapproved.

1. ~~**Chunk 1D — populate an order-specific style link at creation.**~~
   **ACCEPTED 8 September 2026.** `WorkOrder.sampleStyleId` is now written at
   creation by every live writer, from the exact request line or the exact
   source work order, and creation refuses with a typed error where neither
   proves a style. The historical records below are untouched. The generator in
   `routes/CMS_Routes/Sales/quotationRoutes.js` loops over `request.items` and
   already holds the line it is building from — it could carry that line's
   `sampleStyleId` onto the work order, or append the new work order to
   `SampleStyle.production.workOrderIds[]`. The single change that would move
   operational coverage off zero, and a **write-path** decision, not a backfill.
2. **Decide whether a stored order-line identifier is wanted.**
   `requestItemSchema` is declared with `_id: false`, so a work order cannot
   name the line it came from.
3. **Decide the fate of the 141 unattributable existing
   orders** — reviewed backfill, a company stamp on the production order, or
   accepting that historical orders stay outside IE.
4. **Fix the 7 dangling direct
   references** and the 1 order naming a
   missing product — integrity faults independent of IE.
5. **Fix the 5 styles with no provable parent.**
   `scripts/migrations/backfill-journey-company.js` exists and needs approval.
6. **The 144 missing work-order numbers.**
   `scripts/migrations/work-order-number-backfill.js` exists and needs approval.

## Frontend recommendation

**Do not build the IE Orders frontend against this data yet.** A landing page
rendering an empty list while the factory has 95 open orders reads as
broken, not as an honest boundary, and no disclosure text fixes a screen with
nothing on it.

The boundary is sound: no conflicts, no ambiguity, no cross-company attribution,
refusals correct, and — since Lane A — no order lost to a closed development
record. What is missing is the stored link. Once **Chunk 1D** lands, re-run this
audit; if operational coverage becomes material the verdict moves to
`READY_WITH_EXPLICIT_PARTIAL_COVERAGE`, and the page must then disclose the
exact visible percentage and state that unlinked orders are omitted.

> **SUPERSEDED, 8 September 2026.** The paragraphs above are the recommendation
> as it stood on the audit date, kept because the measurements below are still
> the measurements of this run. They are no longer the current position:
>
> * **Chunk 1D landed.** `WorkOrder.sampleStyleId` now exists and every live
>   writer sets it in the order's original save, so orders created from here on
>   carry the link this audit found missing.
> * **Chunk 1E is built,** not blocked — `/industrial-engineering` ships the
>   Orders and Operations screens. It was unblocked by the disclosure rule this
>   audit asked for, not by the data changing: the screens name their coverage
>   and say plainly that unlinked orders are omitted, rather than showing a
>   short list as if it were the whole factory.
> * **The figures in this document still stand.** Chunk 1D deliberately ran no
>   backfill and touched no historical record, so the orders counted here as
>   unlinked are still unlinked. Re-running the audit is what will move the
>   verdict; nothing in Chunk 1D or 1E has moved it.

## Reproducing this audit

```bash
node scripts/audits/ie-order-readiness-audit.js
```

Read-only, no flags, no `--apply` — there is nothing to apply. `--json` prints
the same report for machine consumption.
