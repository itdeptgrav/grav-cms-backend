# Live central-costing end-to-end verification — 10 September 2026

## Purpose

Verify against the live GRAV test database that independently owned departmental
inputs flow through central costing without manual input in the Costing app, become
one management-markup floor price, reach Sales without confidential cost data, and
remain traceable into an approved quotation and procurement demand.

No application code was changed for this run. No commit, branch, reset, or revert
was performed.

## Environment and actors

- Company: `6a08040a1fecacc9bb7149c2`
- Board and commercial actor: Chief Executive Officer (`ceo@grav.in`)
- Merchandising release actor: SANJUKTA PRUSTY (existing Merchandising owner)
- Test subject: `LIVE E2E Costing Shirt 2026-09-10`
- Journey / enquiry / style: `SJ-SB-1` / `ENQ-SB-1` / `SC-SB-1`
- Order: `REQ-LIVE-E2E-20260910`
- Quantity: 500 pieces
- Sales proposed price: Rs 650.00 excluding tax

Access setup retained from the preparation phase:

- `ceo@grav.in` has the Board owner role required to make the test decisions.
- `ray@grav.in` still has the Executive Office and Board Owner grants that were
  added during the earlier identity diagnosis. They were not removed because that
  was not authorised as part of this test.

## Execution log

### 1. Board decisions

All eight policies passed the real Board-policy draft and approval lifecycle and
became effective on 10 September 2026.

| Policy | Test decision | Result |
| --- | --- | --- |
| Pricing | `MARKUP_FLOOR_V2`, 20% markup | Approved and effective |
| Financing | 10% annually, 365-day basis, advance reduces financing | Approved and effective |
| Overhead | 12% of `DIRECT_PLUS_FIXED` | Approved and effective |
| Labour | 9,000 productive minutes/month, 18% employer burden, machines in overhead | Approved and effective |
| Input GST | Recoverable | Approved and effective |
| Customs duty | Empty table for domestic sourcing | Approved and effective |
| Contingency | No standard contingency, with recorded rationale | Approved and effective |
| Development catalogue | Empty standing catalogue; this test buys setup externally | Approved and effective |

### 2. Department-owned source records

The test created a real approved technical style and source records for every
applicable family:

- R&D: material consumption, approved technical revision, packaging requirement,
  outside-process requirement, and external development/setup requirement.
- Production: assembly standard time.
- Store / Purchase: live supplier quotations for fabric, packaging, garment wash,
  and screen making; material sourcing recorded as domestic.
- Sales: ex-works/customer-collects freight arrangement, 30% advance plus 45-day
  terms, and a confirmed costing brief for 500 pieces at a proposed Rs 650.00.
- Board: the eight decisions above.

### 3. Central costing preparation

Preparation outcome: `PREPARED`.

- Costing: `6aa233823e19ebd1922abe57`
- Frozen version: `6aa233873e19ebd1922abeb3`, version 2
- Scenario: `q500`
- Source fingerprint: `44b9bb3f4e02963c7d6b715f9f392a445d5132d4`
- Fingerprint contains 24 named parts owned by Sales, R&D, Production,
  Store / Purchase, and Board.

Cost build-up for 500 pieces:

| Family | Per garment | Run total | Source result |
| --- | ---: | ---: | --- |
| Fabric material | Rs 407.81 | Rs 203,905.00 | Supplier quotation + R&D consumption |
| Operations / labour | Rs 3.54 | Rs 1,770.00 | Production SAM + Board labour method |
| Packaging | Rs 2.50 | Rs 1,250.00 | Requirement + supplier quotation |
| Outside service | Rs 8.00 | Rs 4,000.00 | Requirement + service quotation |
| Development / setup | Rs 20.00 | Rs 10,000.00 | Fixed external charge amortised over 500 |
| Outbound freight | Rs 0.00 | Rs 0.00 | Recorded ex-works/customer-collects decision |
| Company overhead | Rs 53.02 | Rs 26,511.00 | Board 12% policy |
| Financing | Rs 4.27 | Rs 2,135.41 | Board 10% policy + Sales payment terms |

Exact run cost was Rs 249,571.41. The frozen unit cost was Rs 499.14 after the
configured minor-unit rounding.

### 4. One management floor

- Exact 20% markup calculation: Rs 499.14 + Rs 99.86 = Rs 599.00 after the
  configured Rs 1 selling-price increment.
- Frozen `floorPriceMinor`: `59900`.
- Pricing contract: `MARKUP_FLOOR_V2`.
- No minimum, target, or preferred price exists on the new scenario or Sales result.

### 5. Commercial review

- Initial state: `NOT_SUBMITTED`.
- Standing: `AT_OR_ABOVE_FLOOR` (Rs 650 proposed against Rs 599 floor).
- Required path: ordinary `COMMERCIAL_APPROVAL`; no executive exception.
- Submission result: `SUBMITTED`.
- Approval result: `APPROVED` by Chief Executive Officer.
- Exact approval note and approval time were frozen on version 2.
- Replaying the same action key returned `REPLAYED` and created no second decision.

### 6. Sales visibility and quotation

The output-reader projection contained:

- pricing contract;
- Rs 599 floor;
- Rs 650 proposed price;
- at-or-above-floor standing.

It did not contain true unit cost, markup percentage or amount, suppliers, overhead,
financing details, category subtotals, salaries, or retired tier names.

The real Sales quotation endpoint was called with only a style id and `tier: floor`.
The server wrote:

- quotation `QT-REQ-LIVE-E2E-20260910-001`;
- unit and base price Rs 599.00;
- the exact costing, version 2, style, scenario `q500`, quantity 500, currency INR,
  approval time, and floor tier;
- provenance fingerprint `97c0ecf3983f1c42cdc49a23c930caed`.

Independent recomputation produced the same fingerprint.

### 7. Handover and procurement demand

- Sales handover correlation: `cc59fd64-0b30-4114-a31f-bf07676637bb`.
- Merchandising Execution File: `6aa2350e7f91a4a19756f11f`.
- Pre-release state: eligible, unblocked, and permitted for the existing
  Merchandising owner.
- Demand release: `6aa235117f91a4a19756f18e`, state `RELEASED`.
- Draft Spend Requests:
  - `SPR-2609-0001`, materials, estimated Rs 205,155.00.
  - `SPR-2609-0002`, outside services, estimated Rs 14,000.00.
- An exact release replay returned `ALREADY_RELEASED`; release count remained one
  and request count remained two.

The demand deliberately includes purchased requirements only. Labour, overhead,
financing, and margin did not become purchase requests.

## Result

**PASS.** Independent source inputs produced one frozen central cost, one management
floor, a confidentiality-safe Sales result, a server-stamped quotation, and an
idempotent procurement-demand release. No manual Costing-app figure was used.

## Findings to follow up

1. Material, operation, packaging, outside-service, and development lines are
   labelled `PROVISIONAL` even though they are backed by approved/sample-measured
   records and the version can be approved. This may be deliberate confidence
   semantics, but it should be reviewed before calling the workflow production
   final.
2. The first quotation probe used `/api/sales/...` and correctly returned 404. The
   live server mounts the route at `/api/cms/sales/...`; the corrected request passed.
   This was a test-harness path error, not a product failure.
3. Model loading emits duplicate-index warnings for `biometricId`, `identityId`, and
   `email`. They did not affect this run but should be cleaned separately.

---

## Addendum — Sales costing relocated to Cost & Invoicing (10 September 2026)

The costing workflow was moved off Enquiry/RFQ, and a Sales-owned commercial
quantity was introduced. Verified live against the same journey, `SJ-SB-1`,
with the same company and actor. Nothing was committed.

### Why it moved

Enquiry/RFQ is where a buyer's requirement is written down. The quantity being
priced was therefore the opening ask rather than the number Sales had settled
on quoting — and a salesperson had to operate a "Costing Brief", an
orchestration record they should never have had to know exists.

### The commercial line

Enquiry-level, Sales-owned, keyed by the product line's permanent
`productLineRef` and the approved `sampleStyleId` — never by product name,
which the Enquiry model itself warns "breaks on a rename and on two spellings
of one garment". It carries the confirmed quantity, its revision and every
quantity it has ever held. It needs no portal customer and stores no selling
price.

Confirming writes the line, then drives the existing `costingBrief.service`
authority on Sales' behalf. No second quantity record exists and no costing
version is patched.

### Live evidence

| Step | Result |
| --- | --- |
| Baseline | line absent; brief CONFIRMED at 500; version 2 APPROVED, 500 pieces, floor Rs 599.00 |
| Confirm 500 | line revision 1, `inSync: true`, costing requested for 500 |
| Revise to 750 | line revision 2, history `[[1, 500], [2, 750]]`, reason recorded |
| Hidden brief | two briefs SUPERSEDED at 500, one CONFIRMED at **750** |
| Readiness after revision | `INPUTS_CHANGED`, published scenario still 500 — the frozen version had not moved |
| Prepare | outcome `REVISED`, `ESTIMATE_READY` |
| New version | version 3, DRAFT, **750 pieces**, unit cost Rs 491.61, floor Rs 590.00 |
| Earlier costing | version 2 unchanged: APPROVED, 500 pieces, unit cost Rs 499.14, floor Rs 599.00 |

The floor moved from Rs 599.00 to Rs 590.00 because the quantity did. The
cause is **fixed-cost amortisation only**, and the line-by-line comparison
proves it:

| Line | Per unit at 500 | Per unit at 750 |
| --- | --- | --- |
| Material (Fabric 1) | 40781 | 40781 |
| Operation (OP-SB-1) | 354 | 354 |
| Packaging (Poly Bag 1) | 250 | 250 |
| Service (Garment Wash) | 800 | 800 |
| Development setup | **2000** | **1333** |
| Overhead | 5302 | 5222 |
| Financing | 427 | 421 |

Every unit RATE is identical. The Rs 10,000 setup charge spreads over 750
garments instead of 500, and overhead and financing follow it down because
both are percentages of a basis that includes it.

### Correction: no supplier tier switched

An earlier version of this addendum said the supplier tiers applicable at 750
differ. **That was wrong and is withdrawn.** Every supplier offer on this
company carries an empty `tiers` array, and the quoted rate for each of the
four sourced lines is byte-for-byte the same in version 2 and version 3.

Supplier quantity-tier selection is implemented and is exercised by
`costing-packaging-services.test.js`, but this journey's fixture has no tiered
offer, so this run proves nothing about it either way. Only the amortisation
claim is supported by recorded evidence, and only that claim is made.

### A defect the live test found, and the fix

After the quantity was revised to 750, the costing REQUEST correctly named 750
while the approved VERSION was still the 500-piece one. `inSync` compared the
line against the request, so the card would have shown the Rs 599.00 floor
beside a 750-piece order — a price for an order nobody placed.

The floor is now gated on the scenario it comes from being calculated for the
confirmed quantity. A mismatch takes the same route as an out-of-sync costing:
no price, "Costing update pending", and a retry of the same quantity. Proved by
test, and by the live readiness read above showing `INPUTS_CHANGED` with a
500-piece scenario while the line stood at 750.

### The selling-price gate

A selling price cannot be entered or saved until the confirmed quantity is in
sync and a floor exists for it. The pricing sheet locks the cell with
"Confirm quantity and complete costing before setting the selling price", and
`PATCH /:id/products/:productName/cost-ledger` refuses with
`SELLING_PRICE_NOT_READY`, naming which of the three conditions is missing.
Clearing a price is always allowed: withdrawing a number is not quoting one.
The floor is never copied into the selling price.

### Result

| Area | Result |
| --- | --- |
| Commercial quantity is Sales-owned and revisable | PASS |
| Costing follows the confirmed quantity exactly | PASS |
| Earlier quantity and costing remain frozen | PASS |
| Quantity-dependent inputs recalculated | PASS |
| Enquiry/RFQ carries no costing surface | PASS |
| Selling price blocked until a matching floor exists | PASS |
| No portal customer needed to price | PASS |
| Overall | PASS |

## Rendered QA, 11 Sep: FAILED, and what it found

The page was opened on `SJ-SB-1` and contradicted itself. One enquiry, one
product, four different answers to "how many, and at what floor":

| Source | Says |
| --- | --- |
| The enquiry's product row | 500 — the buyer's opening ask |
| The commercial line | 750 — what Sales confirmed |
| Costing version 2 (approved) | 500 at ₹599 |
| Costing version 3 (calculated, current) | 750 at ₹590 |

The PI workbench stood open at 500. The costing card read "750 confirmed"
directly above "No floor price calculated". A proforma was offered with no
customer, no stock match, no floor and no selling price. Two PI actions and
several overlapping pricing summaries were on screen at once.

Three separate defects, none of which the source-string tests could see.

**The projection chose the approved version regardless of quantity.**
`costingResult.resultFor` read `approvedVersion || latestVersion`, so version 2
always won. Version 3's ₹590 was never sent to the client at all — the card was
telling the truth about what it had received. The version is now chosen by the
confirmed quantity first and its approval second, and only that quantity's
scenarios travel. Approved still wins BETWEEN versions that price the confirmed
quantity.

**The ledger was built without the commercial lines.** `useCostLedger` takes
them as its only quantity authority and was being called with three arguments
instead of four, so every line resolved to no confirmed quantity and every
floor was withheld. The stage reads them once and shares one copy.

**The workbench opened itself.** An effect landed on the invoice whenever the
enquiry had ever had a request — so the editor was already open on arrival,
showing the quantities that request was created with, from before the
commercial line was the authority. Opening a document is a decision now. The
stored request is unchanged and is reached through the single PI action.

Two more quantity fallbacks went with them. The manual PI chooser seeded its
rows from `products[].quantity` and let the number be typed over; it shows the
confirmed quantity read-only, or says none is confirmed.

### The page now

One card per product, in the order the work happens: the confirmed quantity,
then what is still owed OR the one floor for that quantity, then the selling
price, then the commercial review. Underneath, one proforma action.

Removed: the "Where pricing stands" band, the Lines / Quoted / Invoice summary,
the Customer-view / Working-sheet toggle and both tables behind it, the
duplicate "styles not fully costed" banner row, and the second PI panel.

The proforma action is disabled until the quantity is confirmed and in sync,
a floor exists for it, a selling price is saved, that price is commercially
cleared, a stock item is matched and a portal customer is linked. The reasons
are listed beside it. A missing customer or stock match blocks only that
action — never the costing.

### Rendered evidence

`components/sales/crm/journey/stages/costQuoteRendered.test.mjs` puts the exact
contradictory state through the real components and asserts the markup: 750 and
₹590 present, 500 and ₹599 absent, one floor, one confirmed quantity, one PI
action, the price field absent unless the floor is current, and the proforma
disabled and explained for a missing customer and stock match.

`test/costing/sales-estimate-preparation.test.js` asserts the projection half:
versions 2 and 3 in, only 750 at ₹590 out, `59900` and `"500"` nowhere in the
response, and the frozen version not edited.

## Second QA round, 13 Sep: six verified gaps, corrected

The compact flow landed but the stage still carried a second costing surface
and several name-keyed joins.

**The old workspace was still mounted.** `CostQuoteStage` rendered the new
per-product flow and then mounted `CostQuoteWorkspace` underneath it, drawing
total cost, gross profit, margin, cost per piece, profit per piece, "where the
profit comes from" and the product costing sheets. Unmounted — not hidden. The
component file is left for whoever owns that work next.

**Two dead tab branches held cost internals.** A `costing` branch rendering
component amounts, overhead, financing, margin and quantity price breaks, and a
retired `quote` branch with a cost/price/margin table. Both had been commented
out of `stageConfig` and were unreachable — but unreachable is one restored tab
away from visible, and the markup was still written. Removed, along with a
"Costing readiness" list that had drifted onto the Terms tab.

**The proforma gate failed open while its lookups were pending.** The customer
and stock reachability reads start `null`, and `null` was reported as no
blocker — so for the whole window before they answered, and forever if they
failed, the action was enabled in exactly the state the lookups exist to
prevent. Pending is now its own calm blocker, "Checking proforma
requirements…", and nothing proceeds until both answer `true`.

**Commercial state was keyed by product name.** One enquiry legitimately
carries the same garment twice in two colourways. Readiness, ledger rows, the
price lookup and write, each card's async scope, the estimate and review
requests and the style resolution were all keyed by name, so the two collapsed
into one and the first row silently won.

Everything on the active flow is now keyed by `productLineRef + sampleStyleId`:

| Where | Was | Now |
| --- | --- | --- |
| Readiness map | product name | line key |
| Ledger row + price write | product name, `PATCH .../products/:name/cost-ledger` | line key, `PATCH .../cost-ledger/line` |
| Card async scope | company + enquiry + name | plus reference and style |
| Estimate and review requests | `product` | plus `productLineRef`, `sampleStyleId`, verified server-side |
| Style resolution | name → style map | the row's style, else its commercial line, else a name lookup only where that name is unique |
| Costing record | one per product name | `context.secondaryId` carries the style |

The backend additions are additive. The named ledger route and historical rows
still work; a historical row is adopted by a line only where its name is
unambiguous on that enquiry. `costingPreparation.resolve` refuses a pair that
is not on the enquiry, or that contradicts itself, rather than answering with
whatever the name found.

One idea was tried and withdrawn. Encoding the style into `context.externalKey`
broke nine readers across Central Costing that treat that field as the product
name — the technical-style binding, the approved-output lookup, the legacy
sheet import and the enquiry lookup among them. The style went on the context's
existing optional `secondaryId` instead, so the name stays the name.

### The test renders the real stage

`costQuoteRendered.test.mjs` previously composed two components by hand, which
is why it could not see that the page mounted a third. It now renders the real
`CostQuoteStage`, with only the router, the toast, the journey context and the
two fetching leaves controlled; the costing-card stub renders the real
`CostingCard`, so every figure asserted is markup a person sees.

The fixture is two same-name rows: Sand at 750 with a ₹590 floor, Navy at 400
with none, against enquiry rows that both ask for 500 and a historical version
pricing Sand at 500 for ₹599. Fourteen assertions, including that restoring the
workspace mount fails the suite — checked by doing it.

## The PI boundary, 13 Sep

The stage was line-keyed but the command that creates the document was not.

**The browser was the quantity authority.** `piResolve.createRequest` posted to
the generic `POST /customers/:id/create-request` with a stock item, a style and
a quantity it had composed itself. That endpoint has no enquiry identity, so it
could not look up what Sales had confirmed — it stored whatever arrived. A
stale tab could create a draft at 500 against a line confirmed at 750. The
quotation-pricing command would refuse to price it later, but by then a wrong
document existed and had a reference.

`POST /enquiries/:id/proforma-request` replaces that path for Sales. It takes
no quantity. For each item it is given a `productLineRef` and a
`sampleStyleId`, loads the company-owned enquiry, resolves the exact commercial
line, requires a confirmed quantity whose costing is in sync and a floor for
that exact quantity, and stamps the number it read. One bad line refuses the
whole request, and an exact retry replays rather than raising a second
proforma. The generic endpoint is untouched for its historical callers.

**The workbench resolved styles by product name.** It fetched the journey's
styles and paired them to enquiry rows through a map keyed by the lowercased
product name, which two colourways share. The stage's already-resolved rows are
passed in instead, and matching is by style id.

**A failed style lookup read as permission.** Its catch left the product list
unfiltered, turning "could not check whether the customer approved this" into
"the customer approved this". It now refuses the proforma, retryably, and
blocks nothing else.

Two deeper collisions surfaced while testing this and were fixed.

`SampleStyle` is unique on journey, product name and variant key, so two
same-name styles must differ by variant key — the model's own way of saying
"the same garment, twice".

Confirming a costing brief superseded every other confirmed brief for the same
PRODUCT NAME. Two confirmed briefs naming two styles of one garment mean two
different things and the briefs alone cannot tell them apart: with one enquiry
row Sales moved the quotation, with two the customer is buying both colourways.
Superseding unconditionally served the first and broke the second — confirming
Navy silently closed Sand's brief and put a line nobody had touched out of sync.
The enquiry's own rows are now the discriminator.

**Defence in depth is preserved.** Request creation stamps the confirmed
quantity; quotation pricing independently verifies it again and stamps the
approved floor and its provenance. Neither is the other's excuse to relax.

`test/costing/proforma-request.route.test.js` covers all of it in seventeen
route tests, including that restoring the submitted quantity fails the forged
test — checked by doing it.

## Live acceptance, 13 Sep — PARTIAL. Still not marked passed.

Signed in, the Cost & Invoicing stage was opened and read in the browser.

**`SJ-SB-1` does not exist in the live data.** The pipeline, filtered to Team
and Everything, lists one journey: `SJ-2026-0007 · The Park - by Era hotels`.
Opening `SJ-SB-1` returns the layout's own "Enquiry not found — No enquiry
matches SJ-SB-1". That reference is minted by the TEST fixture helper
`test/costing/helpers/sourceBacked.js` (`SJ-SB-${n}`) into an in-memory
database during test runs, so it exists only inside a test process.

The 500/750 and ₹599/₹590 contradiction therefore cannot be reproduced against
live data from this environment. What follows was verified on the real journey.

### Verified on `SJ-2026-0007/cost-quote`

Exact visible text of each product card, five of five identical:

> Final costing pending
> Confirm the commercial quantity to calculate the floor price.
> Quantity [ ] Confirm quantity

Exact visible text of the proforma panel:

> Create proforma invoice
> Not yet — what is outstanding is listed below.
> [Create proforma invoice]
> No approved style is linked to Mens Black mandarin collar shirt, Mens -
> White mandarin collar shirt, Beige highlighted kneelength apron, Mens -
> beige straight trousers, Oversize drop shoulders Black F1 t shirt yet.
> No enquiry line is matched to a stock item yet.

| Element | Count |
| --- | --- |
| Costing cards (`data-sales-costing`) | 5, one per product |
| Quantity forms (`data-confirm-quantity`) | 5 |
| Confirmed quantities (`data-confirmed-quantity`) | 0 |
| Floors (`data-floor-price`) | 0 |
| Selling-price controls (`data-selling-price-input`) | 0 |
| Proforma actions (`data-create-pi`) | 1 |
| Proforma blockers (`data-pi-blocker`) | 2 — `line-key`, `stock` |

The proforma button reports `disabled=true`, `data-blocked="true"`. The customer
blocker is ABSENT, so that lookup positively resolved; the stock lookup
positively resolved to "no match" and blocks. Neither withheld any costing card.

Stage tabs are Negotiation, Approval and Terms. No Costing tab, no Quote tab.

A scan of the rendered text for every banned term returned nothing: total cost,
gross profit, margin, cost per piece, price per piece, profit per piece, where
the profit comes from, overhead, financing, quantity price breaks, none priced
yet, Customer view, Working sheet, Where pricing stands, minimum/target/
preferred price, markup, supplier, fingerprint, costing workbook, costing
sheet. The strings 500, 599, 750 and 590 are all absent, this journey having
nothing confirmed.

No proforma workbench opened by itself, and no stale request appeared.

### Still NOT verified, and why

Every check that needs a confirmed commercial line and a calculated floor:
active quantity 750 only, active floor ₹590 only, no active 500 or ₹599, one
selling-price control, one commercial-review status, and that opening the
proforma produces a 750-piece line.

The only live journey has no confirmed quantity on any of its five products, so
none of those states exists to photograph. Producing them would mean confirming
a commercial quantity and preparing a costing on a real customer's enquiry,
which is a business write on live data and was not authorised.

### Not verified in the browser

The evidence above was taken through the real HTTP routes with a signed-in
session, and through direct reads of the stored records. **The rendered Cost &
Invoicing screen was not verified.**

Two obstacles appeared during this run. The first has cleared: another lane's
`app/marketing/data-health/page.js` was mid-edit with a syntax error that
failed the dev compile, and it now parses. The second has not: the route guard
in `middleware.js` requires an `auth_token` cookie, and neither browser
available to this session carries one. A cookie-only call to the API returns
401 in both, and every navigation to the stage is redirected to
`/?next=/sales/dashboard/journeys/SJ-SB-1/cost-quote`.

Reconstructing that cookie from a token was deliberately not attempted:
modifying authentication was out of scope for this work.

So these six checks remain outstanding and should be run by someone with a
browser session:

1. Enquiry/RFQ contains no costing brief, estimate, floor or review controls.
2. Cost & Invoicing shows the confirmed 750-piece quantity.
3. Exactly one floor, matching that quantity, at Rs 590.00.
4. Selling-price entry is open only because a matching floor exists.
5. No costing internals and no historical Rs 599.00 floor appear.
6. The customer-link message affects only PI issuance.

What can be said without the browser: the code paths behind all six are
covered by 19 tests in `salesCostingSection.test.mjs` and 18 in
`commercial-line-quantity.test.js`, and the stored records behind checks 2, 3
and 5 are the ones tabulated above.

---

## QA correction — Cost & Invoicing quantity and floor authority (11 September 2026)

The 10 September addendum recorded the Cost & Invoicing screen as PASS. **That
was premature for the pricing and proforma path**, and this records why.

### What the QA found

Five defects, all downstream of one root cause: the confirmed commercial line
was introduced as the quantity authority, but the pricing and proforma path was
never moved onto it.

| # | Defect | Where |
| --- | --- | --- |
| 1 | Pricing and draft PI used `enquiry.products[].quantity` — the buyer's opening ask | `costLedger.js:139`, `piResolve.js:136` |
| 2 | The floor was recomputed in the browser as `cost x (1 + markupPct)` whenever cost was visible | `costLedger.js:155` |
| 3 | Three visible floors: the costing card, a Floor column, a Floor total plus variance | `PricingSheet`, `CostSummaryBand` |
| 4 | `floor = cost + N%`, "Sales chooses the published price band", "Target vs cost" on screen | `CostQuoteStage`, `CostQuoteWorkspace` |
| 5 | Revision safety unverifiable, because the quantity never came from the line | — |

Defect 2 was the worst of them: an executive who could see cost got a floor
derived in their browser from a settings percentage, while everybody else got
Central Costing's frozen `MARKUP_FLOOR_V2` figure. Two authorities for one
number, and the wrong one won for the reader most able to act on it.

### What changed

**One quantity.** The confirmed commercial line, matched on permanent
`productLineRef` and `sampleStyleId` — never the product name, which one
enquiry legitimately carries twice in two colourways. Missing, ambiguous or
out-of-sync yields no quantity at all, so pricing is blocked and the line
cannot reach a draft proforma. There is no fallback to the enquiry quantity.

**One floor.** Central Costing's result for the confirmed quantity. The browser
computes none. It is withheld entirely while a recalculation is pending,
because a floor for the previous quantity looks like an answer.

**Shown once.** Only the costing card renders a per-piece floor. The pricing
sheet still USES the value to gate the price cell and flag a below-floor line —
that is a check, not a disclosure — but prints no floor column, no floor total
and no shortfall amount. "X under the floor" was removed too: it is the floor
itself, recovered by subtraction from a price the reader already knows.

**Cost is gone from the Sales screen for everyone**, including an executive who
holds the capability. The capability says who may see cost; it does not make
this the screen for it.

### The server enforces it independently

The price on a sourced line was already resolved server-side. The QUANTITY was
not — it came straight off the request body, so a stale tab or a direct call
could quote 500 against a costing calculated for 750, with every figure on the
document internally consistent and wrong.

`quotationPricing.priceLine` now resolves the confirmed quantity through the
style's enquiry and **refuses** a mismatch with
`QUOTATION_LINE_QUANTITY_NOT_CONFIRMED`, naming both numbers. Refused rather
than silently corrected: a price may be replaced because the company owns the
price, but how many a customer is buying is a commercial fact somebody agreed,
and quietly changing it would issue a document nobody chose.

### The first version of that check failed open — corrected 11 Sep

The resolver returned "unknown" for a missing, ambiguous or unreadable
commercial line, and the caller refused only when a line WAS found and
disagreed. So the verification could be switched off **by sending less**: omit
the product line, arrange two candidate lines, or drop `costingIntent`
entirely, and the client's own quantity was priced unchecked. A check that can
be avoided by sending less is not a check.

Every outcome except a single, valid, in-sync commercial line is now a typed
refusal, and the submitted quantity is never carried onward in any of them.

| State | Refusal | HTTP |
| --- | --- | --- |
| A line naming a quantity nobody confirmed | `QUOTATION_LINE_QUANTITY_NOT_CONFIRMED` | 409 |
| Costing not running for the confirmed quantity | `QUOTATION_LINE_COSTING_NOT_IN_SYNC` | 409 |
| No confirmed line for the style | `QUOTATION_LINE_NO_COMMERCIAL_LINE` | 422 |
| Two candidate lines | `QUOTATION_LINE_COMMERCIAL_LINE_AMBIGUOUS` | 422 |
| A reference that is not this style's line | `QUOTATION_LINE_COMMERCIAL_LINE_NOT_FOUND` | 422 |
| A governed style priced by hand | `QUOTATION_LINE_COSTING_INTENT_REQUIRED` | 422 |
| A quantity that is not a number | `QUOTATION_LINE_QUANTITY_INVALID` | 422 |

Four things changed with it.

**The line is resolved by the exact pair**, `productLineRef` plus
`sampleStyleId`, scoped through the enquiry that owns the style. A reference
belonging to a real line on a DIFFERENT style does not answer for this one. The
link endpoint sends the reference when a style has exactly one confirmed line,
and sends nothing when it has two — picking a colourway is not the browser's
to do.

**Sync is asked, not restated.** Whether the costing is running for the
confirmed quantity is decided by `commercialLine.costingQuantityFor`, the same
authority the commercial-line service uses. A second definition here would be a
second answer, and the second answer is the one that drifts.

**The stored line carries the server's number.** After the comparison passes,
the quantity written to the quotation is the one read from the commercial line,
not the copy in the request body. The two agree at that point, so this changes
no figure today; it decides which copy survives a later edit to the comparison.

**Omitting the intent is not a way round it.** The save route used to run the
pricing pass only when a client sent `costingIntent`, so dropping the field
skipped the check entirely. Any line naming a style — or naming only the
item-master product, through the link SampleStyle already stores — now comes
through the pass, and whether it is governed is decided from the enquiry rather
than from the request. Lines for no style at all (freight, a sample charge) are
untouched.

**The status says which kind of refusal it is — corrected 11 Sep.**

Every refusal was 422, which conflated two different things a caller must do.
A line naming a quantity nobody confirmed, or one whose costing has not caught
up, is WELL-FORMED and no longer true: the document disagrees with the
commercial state as it stands, and the fix is to re-read that state. Those are
now **409** under `QUOTATION_COMMERCIAL_STATE_CONFLICT`. A missing tier, an
inapplicable costing, a currency that does not match, a style with no
commercial line at all — those are incomplete or inapplicable inputs, and
reloading changes nothing about them. They stay **422** under
`QUOTATION_COSTING_UNAVAILABLE`.

Three things did NOT change with it. The per-line payload is identical: index,
line name, typed code, message, and the confirmed and submitted numbers. The
refusal is still for the whole request — no line is written when any line is
refused. And the split is decided in one place, so the two save doors cannot
answer differently.

A MIXED request reports 422, not 409. A 409 tells a caller to re-read and
retry, and that is honest advice only when re-reading is the whole fix; if any
line is also malformed it is not. Each line still carries its own code.

This also exposed a real gap. A quantity of `"several"` compares as `NaN`,
which differs from every number, so it was being reported as a disagreement
and answered with "re-read the order" — advice that fixes nothing. A
malformed quantity is now refused as `QUOTATION_LINE_QUANTITY_INVALID` before
any comparison runs.

**Stored history is preserved, and is not a bypass.** A quotation already
saved with a manual line on what is now a governed style still reads and still
sends: `verifyBeforeSend` checks stamped sources, and an unstamped line has no
source to have moved. What is refused is submitting that same line again today.

### Revision behaviour, 500 to 750

Proved behaviourally: after revising, a line naming 500 is refused and one
naming 750 is not; the enquiry's own product quantity stays at 250 untouched;
the commercial line reads 750 with revisions `[500, 750]`; and the earlier
costing and quotation records are not mutated.

### Corrected verdict

| Area | 10 Sep | 11 Sep |
| --- | --- | --- |
| Engine calculation | PASS | PASS |
| Source traceability | PASS | PASS |
| Sales confidentiality | PASS | **was FAILING** — cost and markup were on the pricing screen; now PASS |
| Quotation provenance | PASS | PASS |
| Quantity authority | not assessed | **was FAILING twice** — fail-open resolver corrected; now PASS |
| Single floor authority | not assessed | **was FAILING** — now PASS |
| Refusal contract | not assessed | **was CONFLATING conflict with malformed** — now PASS |
| Overall Cost & Invoicing | PASS | PASS, with the rendered check outstanding below |

### Not verified in the browser

**The rendered re-check is still outstanding, and this report is NOT marked
passed.** Re-confirmed 13 Sep: the route still redirects to sign-in
(`307 -> /?next=...`), so no authenticated session is reachable.

The dev servers were restarted onto the changed code and the Cost & Invoicing
route compiles, but the preview browser holds no session and authentication was
not changed to obtain one. The screen must be re-opened on `SJ-SB-1` and checked
for: 750 as the only quantity, ₹590 as the only floor, ₹599 and 500 absent, no
PI workbench until the action is pressed, one PI action, and no cost or markup
anywhere.
