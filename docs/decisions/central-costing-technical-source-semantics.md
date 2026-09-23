# Central Costing — what the technical records actually mean

Written for Chunk 4A (Technical Cost Builder), by reading the complete write
and read paths rather than the field names. Every claim below names the code
that establishes it. Where nothing establishes a claim, that is said too, and
the importer refuses to guess.

## The two material sources are not two costs

`SampleStyle.materials.rawItems[]` and `SampleStyle.sample.consumptionRawItems[]`
are **alternative technical evidence for the same material**, not two separate
consumptions to add together.

| | `materials.rawItems` | `sample.consumptionRawItems` |
|---|---|---|
| Who writes it | Merchandiser / PM, via `PATCH /sample-styles/:id/materials` | R&D, at sample submission (`routes/CMS_Routes/Sales/sampleStyles.js:1409`) |
| What it is | the **planned** pick — what the style needs | the **measured** amount consumed making the physical sample |
| Approved by | `bomApproval.status === "approved"` (Project Manager, by email) | `sample.status === "approved"` + `sample.approvedAt` (Sales, gate 2) |
| Carries an allowance | no field at all | `allowancePercent`, and see below |

Both are synchronised onto the linked `StockItem`'s variant BOM, and **both are
written as `requiredQuantity` with `allowancePercent: 0`** —
`sampleStyles.js:779` for the planned pick, `sampleStyles.js:1514` for the
measured consumption.

## Quantity basis: per garment, and what proves it

`processVariantRawItems` (`routes/CMS_Routes/Inventory/Products/stockItems.js:71`)
stores `quantity = requiredQuantity × (1 + allowancePercent / 100)` on the
StockItem variant BOM, and `recomputeVariantCostsFromBom` prices one finished
good from it. A StockItem BOM row is per finished good. Both sync paths feed
these numbers straight into it, so the system's own established reading of both
sources is **per garment**.

Nothing anywhere stores how many garments a sample round produced. There is no
denominator to divide by, so the importer never divides. Instead it grades the
proof:

- `PER_GARMENT_CONFIRMED` — the linked StockItem's BOM carries this same raw
  item at this same quantity, so the per-garment reading is confirmed by stored
  data, not by convention.
- `PER_GARMENT_BY_APPROVAL` — the sample is approved, so the approval sync ran
  and wrote these numbers as per-garment BOM quantities.
- `NEEDS_CONFIRMATION` — neither holds. The row is shown with its numbers and
  is **not importable** until somebody confirms the basis. It is never silently
  divided by an assumed sample size.

## Is the allowance already in the quantity?

**For measured sample consumption, yes.** `sampleStyles.js:1508` is explicit:
`r.quantity` "is already the EFFECTIVE amount R&D measured consuming it (the
'Consumed' field they typed), not a pre-allowance base — so it's passed as
requiredQuantity with `allowancePercent` left at 0 rather than
`r.allowancePercent`, which would otherwise multiply it a second time".

The schema comment on the field (`SampleStyle.js`, "Wastage/buffer % on top of
`quantity`") says the opposite. The write path is what actually runs and what
the product BOM was built from, so it wins; `allowancePercent` is carried into
the preview as **informational** — what R&D was planning around — and is never
multiplied in again.

**For the planned pick, there is no allowance at all** — no field, and
`sampleStyles.js:779` passes `allowancePercent: 0` with the comment "the
Merchandiser types the quantity actually needed".

Either way the allowance is applied exactly once, and by whoever recorded it.

## Operation cost: per garment, per operation

`services/operationCosting.js` computes
`operatorCost = (operatorSalary / 12,480) × SAM minutes`, where 12,480 is
26 working days × 8 hours × 60. A monthly salary divided by the minutes in a
month, times the minutes one operation takes on **one piece**. The service's
own header calls it "a rupee figure per piece", and
`recomputeVariantCostsFromBom` adds `Σ operatorCost` to the cost of one
finished good.

So `operatorCost` is **per garment, per operation**, and importable directly as
a `PER_UNIT` `OPERATION` line.

The trap: `costOperations` returns `operatorCost: 0` when it could resolve no
salary basis, and 0 is also a legitimate stored value. A zero cost with
`operatorSalary: 0` and no `salaryDept`/`salaryDesig` is **missing**, not free.
The importer reports it as a missing-rate blocker and imports nothing.
Likewise `totalSeconds === 0` with no minutes or seconds is a missing time.

## Which state means "approved"

Three separate gates, and they approve different things:

- `bomApproval.status === "approved"` — the Project Manager signed off the
  **materials list**. `round` counts the requests; `decidedAt`,
  `decidedByName`, `decidedByEmail` record the decision.
  (`routes/CMS_Routes/Sales/sampleBomApproval.js`.)
- `techSheet.status === "approved"` — Sales accepted the **tech pack**.
- `sample.status === "approved"` with `sample.approvedAt` — Sales accepted the
  **physical sample**, which is what triggers the consumption-and-operations
  sync onto the product.

The importer treats **measured consumption as superseding the planned pick only
when `sample.status === "approved"`**. Before that the sample is evidence but
not a decision, and the planned pick is still what was agreed.

## Which identifier connects a costing to a style

An `ENQUIRY_STYLE` costing carries `context.primaryId` = the enquiry `_id` and
`context.externalKey` = the **product name** (`costingContext.js`, and the
legacy `Enquiry.costingSheets` it mirrors).

`SampleStyle` is keyed within a journey by `{ journeyId, productName,
variantKey }` and carries `enquiryId` plus `enquiryProductId`. The match is
therefore `{ enquiryId, productName }` — which can legitimately return
**several** styles, because one enquiry product may be developed as sibling
variant styles (navy poly-cotton and white PC, offered together). The importer
returns them as selectable candidates with style code and technical status. It
never takes the first.

## Company ownership

`SampleStyle` has **no `companyId`**. `Enquiry`, `SalesJourney` and
`CRMAccount` now do (`models/CMS_Models/Sales/companyOwnership.js`). So
ownership of a style is proved through its parents, in this order:

1. `journeyId` → `SalesJourney.companyId` must equal the costing's company —
   the Sales Journey is the spine, and this is the proof Chunk 4A requires;
2. no journey (an in-house `sampleType: "house"` style) → the enquiry's own
   `companyId`, already proved by `contextResolver.service.js` before the
   costing was created.

Neither provable means the style is not returned at all — the same refusal for
a foreign style as for one that does not exist, so the endpoint cannot be used
to discover which style ids are real.

## The source-authority table (5 Sep 2026)

The audit this chunk opened with. Every cost family has to say which system is
supposed to answer it — and for several of them the honest answer is "nothing in
this repository does yet". Recording that is the point: a family with no source
is a gap in the company's RECORDS, not in the screen, and naming its owner turns
"add a manual line" into "ask Production to configure the rate".

| Family | Authority | Owner | Source of record |
|---|---|---|---|
| Materials | AUTOMATIC | R&D + Store | `SampleStyle` consumption (allowance already inside the measured figure) for HOW MUCH; the supplier quotation register, resolved per scenario, for WHAT IT COSTS |
| Production operations and labour | AUTOMATIC | Production | SAM from the sample; RATE from `Operation.salaryDept`/`salaryDesig` → average net salary (`services/operationCosting.js`) |
| Allocated overhead | POLICY | Finance | `CostingPolicy.overheadRatePercent` + `overheadBasis` |
| Financing | POLICY | Finance | `CostingPolicy.financingRatePercent` + `financingBasis` — **added by this chunk** |
| Contingency | POLICY | Finance | `CostingPolicy.contingencyRatePercent` + `contingencyBasis` — **added by this chunk** |
| Outside services | AUTOMATIC | R&D / Production + Store | The style's required processes for WHICH and HOW MUCH; the service quotation register for WHAT IT COSTS — *was AWAITING_SOURCE* |
| Packaging | AUTOMATIC | Merchandising + R&D + Store | Merchandising selects the items, R&D states the consumption and its basis on the `SampleStyle`, Store quotes them — *was AWAITING_SOURCE* |
| Freight and logistics | AUTOMATIC | Sales, R&D and Store | The enquiry's delivery arrangement and destination, the sample's shipment facts, and a transporter's dated quotation — *was AWAITING_SOURCE* |
| Customs duty | AWAITING_SOURCE | Finance | **None exists.** Non-recoverable GST already comes from the quotation per line; customs duty needs an import classification nothing records |
| Fixed, setup and development | AUTOMATIC | R&D and Store or Finance | The style's development requirements for WHAT; a supplier's service quotation (bought outside) or Finance's published development charge (done in-house) for WHAT IT COSTS — *was AWAITING_SOURCE* |

**Financing has moved too**, from a flat company percentage to a Board-approved
methodology applied to the enquiry's confirmed payment terms — see
`docs/tasks/central-costing-lane-b-input-map.md` §25.

**One family out of ten now has no authoritative record**, down from five. That
single remaining gap is the whole reason the paragraph that used to sit here —
"answerable today only by a decision or a provisional override" — no longer
holds. Overrides are retired; see below. Customs duty is answerable by a
decision with a reason, and by nothing else.

The screen says which department owns each gap rather than offering a blank box,
which was always the intent and is now the only behaviour.

### The assembly contract

`services/centralCosting/assembly.service.js` is the one place these are
stitched together. The preview route calls it and renders; `technicalBinding`
calls it on save and freezes. Two careful implementations of one thing is two
answers to the same question, and the only way to learn they disagreed was to
watch a number change on save.

Its states are workflow states, not error codes: `ASSEMBLED`,
`AWAITING_RND_TECHNICAL_DATA`, `SEVERAL_TECHNICAL_RECORDS`, `NOT_SOURCE_BACKED`.
`preview: null` used to mean all three of the first, and left the screen to guess.

A style named from outside the costing's own candidate list is refused BEFORE
any state is reported — answering "awaiting R&D technical record" for a foreign
id would confirm this costing has no record of its own, which is a fact about our
data offered to somebody asking about theirs. Inside the company, a style for a
different product keeps its precise 409: the caller can see both records, and a
404 would send them looking for something sitting in front of them.

### The Product BOM is not a source

Deliberate, and now guarded by a test that scans every file in
`services/centralCosting/` for a reference to it. The product BOM is DOWNSTREAM
of an approved sample — it is what manufacturing will build, and it inherits from
the `SampleStyle` with the allowance already flattened out. Costing from it would
cost the record the technical record produced, one step removed.

### Provisional overrides — RETIRED (7 Sep 2026)

**No user may type a cost figure inside Central Costing. There is no control
that offers one, and no route that accepts one.**

#### What an override was, and why the contract was not enough

A hand-entered figure was legitimate where no source existed — which is what
five rows of the table above once meant. The contract around it was careful: an
override declared its cost family, carried a reason, was stamped with the actor
and the time by the SERVER from the session, was frozen as `PROVISIONAL`, could
never wear `SUPPLIER_QUOTATION` or `VERIFIED`, and was refused outright on a
quotation-backed or technically-sourced line.

Every one of those safeguards was about making the figure READABLE in the
version's provenance. None of them made it distinguishable in the version's
TOTAL — and the total is the number a quotation goes out to a customer on.
"Somebody typed this" does not survive into a price.

#### What changed underneath it

The argument for overrides was the last column of the table: five of ten
families with no authoritative record. That is no longer the state of the
system. Materials, operations, packaging, outside services, development and
tooling, freight and financing each read a record now, and the table below the
fold has been rewritten accordingly.

**Customs duty is the one family still awaiting a source**, and it is answered
the only honest way an unrecorded fact can be: a decision that it does not
apply, with a reason, frozen on the version. Not a figure somebody estimated.

#### The rule that replaces it

> When a source fact is missing, the calculation stays blocked and names the
> missing fact, the department that owns it, and the record they keep it in.
> Missing information never becomes a costing line.

A blocked costing is the honest answer to an unanswered question. A dead end is
not: "this cannot be entered here", with nowhere to go, is precisely what sent
people to the override in the first place. So every refusal redirects —
`costCoverage.ownerOf()` resolves the owning department and its system for a
family, and both the message and the typed details carry them.

#### The refusal contract

| Payload | Code | Status |
|---|---|---|
| `lines[].override` — any family, however complete | `COSTING_MANUAL_INPUT_RETIRED` · `MANUAL_OVERRIDE_RETIRED` | 400 |
| `lines[].replacesLineKey` — the wrapper removed | `COSTING_MANUAL_INPUT_RETIRED` · `REPLACEMENT_LINE_RETIRED` | 400 |
| a plain line with no `technicalKey` | `COSTING_MANUAL_LINE_REFUSED` · `UNDECLARED_MANUAL_LINE`, `remedy: RECORD_IN_OWNING_APPLICATION` | 400 |
| a `confidence` other than `PROVISIONAL` | `VALIDATION` · `CONFIDENCE_NOT_CLIENT_SETTABLE` | 400 |

Two layers, deliberately. `calculationInput.parseLine` refuses at the request
edge, before the style, the quotations and the policy are read, so a hostile
payload costs one parse rather than four reads. `assembly.assembleLines` refuses
again for any internal caller that built an input without passing the edge.

**Refused, never stripped.** Silently dropping a typed figure and calculating
the rest is the worst outcome available: the save succeeds, the person believes
their figure is in the costing, and the version they go on to approve does not
contain it.

#### What was removed

`assembly.mergeOverrides`, `versionCreation.freezeOverrides`, the
`PROVISIONAL_OVERRIDE` member of `costCoverage.AUTHORITY`, and — on the screen —
"Add provisional override" with its form, the completion panel's "Add cost"
button, `technicalImport.lineForGroup`, `CostingWorkspace.toWireLine`,
`offerPicker.useManualRate` and `SOURCE.PROVISIONAL_MANUAL`, and the unmounted
`SupplierOfferPicker.js`, which still carried a typed rate field and a
"Use provisional manual rate instead" button.

**`sourceBackedPayload` now takes no `lines` argument at all** and sends
`lines: []`. The parameter is gone rather than ignored: a builder that accepted
rows and silently dropped them is a caller that believes it sent them.

#### Reads are untouched

Retiring creation is not rewriting history. Versions frozen while overrides
existed keep their `PROVISIONAL` cost lines and their `MANUAL_ENTRY` source
references, still say who typed what and why, and still render — including the
provisional tag on the build-up. Historical manual (`ADHOC`) costings keep their
label, their read-only state and their reason. `STATE.PROVISIONAL` stays in the
frontend vocabulary for exactly this reason.

#### What is still interactive in Costing

Two things, and neither of them is a number:

1. **Which quantities to cost**, and the proposed selling price against each —
   a commercial proposal, which no cost line reads.
2. **"Does not apply", with a reason** — a decision, frozen with its author.

Plus the lifecycle acts: submit for review, and approve.

**Quotation selection was the third, and it has moved to Store** — see below.

## Material allowance — the second half of the consumption fact (8 Sep 2026)

> Effective consumption per piece = base × (1 + allowance ÷ 100), **unless the
> row records that the allowance is already inside the quantity**, in which case
> the recorded quantity IS the effective one.

### The two facts, and why they are two

`consumptionPerPiece` is what the garment CONTAINS — the net length, weight or
count that ends up in the product. `allowancePercent` is what the process
additionally CONSUMES to put it there: cutting loss, end bits, shrinkage, the
unusable part of the roll. The company buys the second as surely as the first
and pays the same rate for it.

R&D records them separately and deliberately. The moment they are one number
nobody can tell whether the allowance has been applied, and the next person to
apply it doubles it — which is exactly what `allowanceAlreadyInQuantity` exists
to prevent.

### The three evidence paths, and what each says about allowance

| Row | Source | `allowancePercent` | `allowanceAlreadyInQuantity` |
|---|---|---|---|
| `engineeredRow` | R&D's approved technical revision | R&D's own figure, nullable | `false` — applied by the costing |
| `plannedRow` | the Merchandiser's shortlist | always `null` — the pick says WHICH material, not how much | `false` |
| `measuredRow` | legacy `sample.consumptionRawItems` | carried as information | `true` — what R&D typed was already the consumed amount |

The legacy flag is not a guess about the number: `sampleStyles.js` writes that
list as the EFFECTIVE consumed amount and syncs the approval with
`allowancePercent: 0`. Multiplying it again would charge the allowance twice.

### The defect this corrected, which was larger than an unapplied percentage

**`engineeredRow` was built, returned as `facts.engineered`, and read by
nobody.** `technicalPreview.mergeMaterial` paired `planned` and `measured` only.
So a style with a complete, approved R&D technical record was costed from the
Merchandiser's pick — not merely without its allowance, but without its
consumption figure at all.

`engineeredRow`'s own doc comment had said since it was written that it
outranks both: *"the fact its owner established and Sales approved… the only
one of the three that carries an allowance the costing may apply, because it is
the only one where somebody was asked for it."* That precedence is now
implemented — `CHOSEN.ENGINEERED`, ahead of measured and planned, with both
kept visible beside it as they always were.

### One value, everywhere

`technicalSource.effectiveConsumption` is the only place base and allowance are
combined, and it is attached to every material row where the row is built. Each
of these reads that one number:

1. the material cost quantity (`lineFromMaterial` → `quantityPerUnit`);
2. quotation applicability at the largest scenario;
3. the supplier's minimum order and the quantity tier;
4. Store's sourcing-decision candidate list;
5. the revalidation of a recorded sourcing decision;
6. the binding check against the live record;
7. the frozen provenance;
8. the displayed consumption working.

The understatement never stopped at the total: the same field is multiplied by
the run size to decide what the supplier is asked for, so a minimum order and a
tier boundary were both judged on a quantity nobody was going to buy.

**And it is exact decimal.** `Number(stated) * largest` was floating point at
both applicability sites; 1.47 × 500 is 734.9999999999999 in binary, and a tier
boundary reached by luck is a rate nobody quoted.

### Absent, zero, and the difference

`materialGaps` in `technicalRecord.service.js` makes the allowance **optional
but explicit**: a null means "R&D has not said", which is a legitimate answer
that blocks nothing. Nothing is invented here — a null adds nothing, and the
provenance records `allowanceInQuantity: "none recorded"` rather than `0`, so an
unanswered field and a deliberate zero stay distinguishable for ever.

Three answers, not two:

| Frozen `allowanceInQuantity` | Meaning |
|---|---|
| `no` | R&D stated an allowance and the costing applied it |
| `yes` | legacy row — the quantity already includes it |
| `none recorded` | R&D left it blank, which is allowed |

### Frozen provenance

`baseConsumptionPerPiece`, `allowancePercent`, `allowanceInQuantity`,
`effectiveConsumptionPerPiece` and `unit`, beside the existing evidence and
basis facts. With the scenario quantity already frozen, a reader can reproduce
the priced quantity without guessing:

```
base × (1 + allowance/100) = effective        (unless already included)
effective × run quantity   = what is bought
```

This replaced `fact("allowancePercent", m.measured?.allowancePercent)` and an
`allowanceInQuantity` derived from the evidence being `SAMPLE_MEASURED` — both
about the legacy path only. An engineered row carrying a real 5% allowance froze
the allowance as absent and the flag as "none recorded", which was false.

### What was deliberately not touched

Packaging, services, development and freight get no allowance: an allowance is a
property of a material being cut, not of a process being performed or a bag
being filled. Frozen versions are never recalculated on read. The retired manual
wastage line stays refused — `allowancePercent` IS the wastage fact, and a
second field for it would be the same number twice.

## Store owns the sourcing decision (8 Sep 2026)

> When several valid quotations can price the same requirement, Store makes the
> choice in the Store app. Central Costing consumes it read-only.

### What moved, and why it had to

`quotationChoices` was `{ [lineKey]: offerId }` — held in React state in the
costing workspace, posted with the calculation, frozen into `offerProvenance`.
As a *payload contract* it was careful and it held: an identity and never a
rate, re-read and revalidated per scenario before anything was priced.

What it could not fix is **who was answering**. Choosing between suppliers
weighs lead time, capacity, quality history, terms and the relationship, and a
person costing a garment has none of that in front of them. Costing was merely
the screen where the ambiguity became visible, and visibility is not ownership.

It was also kept nowhere. Nobody's name was on the choice, nothing recorded
when it was made, and closing the tab asked again.

### The record

`models/CMS_Models/Inventory/Sourcing/SourcingDecision.js`.

**Identity: `{companyId, costingId, lineKey}`** — one requirement on one order,
unique over `ACTIVE` rows so history survives a change of mind.

That is the smallest truthful key. The costing carries the company, the
enquiry, the product and the style; the line key carries the subject and its
variant. Deliberately **not** keyed by item — "which supplier do we use for
Oxford cotton" is a standing preference, a different question, and answering it
with a choice somebody made for one enquiry at one run size is how a decision
outlives the facts it was made on. Deliberately **not** per scenario either: a
costing prices several run sizes from one assembled row set, and a per-scenario
decision would let one comparison be priced from two suppliers.

The rate is **not stored**. The quotation is re-read from its own register every
time; a copy here would be a second number that could drift from the one the
costing uses.

What *is* stored beside the choice is the context it was made in —
`judgedQuantity`, `judgedUom`, `asOf`, `currency`, `offerRevision`,
`quotationReference`, `supplierName`, `candidateCount` — read by people, never
by anything that calculates. A decision that has gone stale must be able to say
what it was made against, or "choose again" is an instruction with no
information in it.

### Automatic versus explicit

Unchanged, and deliberately: **exactly one applicable quotation is still
attached automatically**, in all five families. Sending every unambiguous
requirement to a queue would turn a working automatic path into somebody's
inbox, and the real decisions would be invisible among the non-decisions.

| Applicable quotations | What happens |
|---|---|
| 0 | blocking gap owned by Store — *record one*, not *choose one* |
| 1 | attached automatically; nothing is asked |
| 2+ | blocking gap, and an open sourcing decision in Store's queue |

Nothing sorts by price, marks one cheapest or pre-selects. A default is a
decision with nobody's name on it.

### The queue

One authority, two readers. `openDecisionsForCosting` runs the **same
assembly** a costing runs and collects the gaps it reports, so Store's screen
cannot disagree with the costing about what is open. A second implementation
would be a second answer to "is this decided", discoverable only as a costing
that stayed blocked while Store's screen said it was done.

It is capped and **says so** (`moreCostingsNotScanned`): a work queue that
silently stopped at fifty reads as "you are done".

### Validity, and what reopens a decision

Every read revalidates the chosen quotation against the live register at the
costing's own quantities and date. This is the check that already guarded the
browser's map — feeding it Store's record changed where the decision comes
from without changing what happens to a stale one.

A decision becomes **unresolved, never substituted**, when the quotation is
withdrawn or superseded, is not effective for the costing's date, no longer
fits its tier or minimum at the run sizes, has an incompatible unit or
currency, the freight lane or mode changed, the requirement changed, or company
ownership does not match.

**The successor is never assumed.** Revising a quotation supersedes it with a
new document at a new rate; following the chain would price the costing at a
figure Store has not agreed to. The requirement reopens and says why.

**Frozen versions keep what they used.** `offerProvenance` is untouched by any
later change to the live decision.

### Access

`sp.read` to see the queue, `sp.sourcing.manage` to decide — the identical pair
`supplierOffers.js` already uses, because the people who record what a supplier
offered are the people who choose between them. A viewer sees the queue and is
told why they cannot act, rather than meeting a refusal on a control that
looked available.

*Observed, not changed:* a platform administrator holds `ADMIN_SET`, which
includes `sp.sourcing.manage`, so an admin can decide. That is the repo-wide
convention every Store write route already runs on — the same authority that
lets an admin create and withdraw the quotations in the first place — and
narrowing it here would be a different task, touching every Store route.

### The information boundary

| Reader | Sees |
|---|---|
| Store's decision screen | the rate, the unit, the tier, the MOQ, the order multiple, the lead time, the validity, and the ruled-out quotations with their reasons |
| A costing reader | that a sourcing decision is outstanding, **how many** quotations are in contention, who owns it, and where it is made |
| Merchandising, R&D, Production, Sales readiness | status and owner only |

The count is deliberate: "two suppliers quoted this" says why the costing is
waiting without saying what either charges.

### What Costing lost

The radios and their candidate list, `quotationChoices` in the payload
builder, the `onChooseQuotation` handler and the state behind it, and the gate
clause that treated a just-clicked radio as a cleared blocker. A payload still
carrying `quotationChoices` is refused with
`COSTING_QUOTATION_CHOICE_MOVED` (400) naming Store and the screen — never
stripped, which would calculate from whatever Store decided while the person
who pressed Calculate believed they chose.

## Sales owns what is being costed (8 Sep 2026)

**Which approved style is being quoted, at what quantities, in what unit, at
what proposed selling price and why are commercial facts. Sales confirms them
on the enquiry; Central Costing reads the brief and cannot be sent one.**

### Where it lives, and why not on the product row

`Enquiry.costingBriefs[]`, top-level, keyed by **`SampleStyle._id`**.

`sanitizeProducts()` rebuilds `products[]` on every requirement save and
reassigns each row a fresh `_id`, so anything stored on a row is lost the next
time somebody edits a quantity — which is why `costLedger` and `costingSheets`
are top-level and keyed by product name. Name is the fallback those two had to
take and it breaks on a rename; the style's own id does not. `productName` is a
display snapshot here and is never joined on.

### The gate is the approved revision

`technicalRecord.approvedRevisionOf(techSheet)` — the frozen revision Sales
approved, which is also what `readStyleFacts` costs from. Reading
`techSheet.status` instead would let a style be briefed that the engine then
refuses, and the refusal would land on the costing rather than where the choice
was made.

### One unit, for the whole brief

It used to be `scenarios[].quantityUom` — per scenario — which allowed one
costing to quote 500 pieces beside 500 metres. Sales states it once and the
server stamps it onto every quantity.

### Supersession, never a retarget

A confirmed brief is what a frozen version cites. Moving the quotation to
another style confirms a NEW brief and closes the old one with its successor
and a reason; editing the old one to point elsewhere would make every version
citing it describe a garment it was not calculated for.

### And a quantity is a quotation break point

Not a production order quantity. Several are normal and they are hypothetical;
the committed figure is the work order's, and it arrives later through a
different record.

### What a version freezes

A `SALES_COSTING_BRIEF` source reference carrying the brief's id **and its
revision**, so a reader can tell a costing made against Monday's requested
quantities from one made against Thursday's.

## Applicability is the owning department's, not Costing's (8 Sep 2026)

**Central Costing does not decide whether a business fact applies.** Each
department records the applicability of the fact it owns; Costing consumes it
read-only. Missing information is never equivalent to "not applicable".

### What this replaced

`technicalAcknowledgements: [{ key, reason }]` — a list posted with a
calculation, letting whoever was costing a garment declare a whole cost family
irrelevant. It was careful about what a payload can be careful about: the
reason was compulsory, the vocabulary was fixed, and the decision was frozen
with its author's name.

It was still the wrong desk. Whether the customer supplies the packaging is
Merchandising's fact; whether anything is sent outside is Production's; whether
the goods are imported is Store's; whether this order is financed is Sales'. A
person costing a garment has none of that in front of them, and the reason they
typed was their best guess at somebody else's answer — frozen, permanently, as
evidence.

### Who may excuse a family, and who may not

`familyApplicability.APPLICABILITY_OWNER` is the whole table. A family absent
from it can never be inapplicable: no record answers it, and offering an escape
would be the acknowledgement under another name.

| Family | Owner | Record |
|---|---|---|
| `packaging` | Merchandising | `SampleStyle.materials.packagingDecision` |
| `services` | Production | `SampleStyle.sample.outsideProcessDecision` |
| `development` | Merchandising | `SampleStyle.sample.developmentDecision` |
| `duty` | Store / Purchase | `SupplierOffer.sourcing.type` per material, via `sourcingEvidence.rollUp` |
| `materials` | **nobody** | a garment is made of something |
| `operations` | **nobody** | a blank route is missing Production work |
| `overhead` | **nobody** | the Board's rate, including an approved zero |
| `freight` | **nobody** | Sales' arrangement already produces a `RECORDED_ZERO` **line** |
| `financing` | **nobody** | Sales' stated condition already produces a nil **line** with its reason |

The last two are the important distinction. Freight and financing *can* be
inapplicable, and already are — but as a line the engine produced, which is a
stronger record than an exclusion. A family-level escape beside them would be a
second way to say one thing.

### The three-field answer

`services/styleApplicability.js` is the shape all three owning apps write, and
nothing else — no authority, no ownership proof, no route.

```
required: Boolean   // NO DEFAULT. Absent is a question nobody asked.
reason:   String    // compulsory when `required` is false, ignored when true
decidedBy: { id, name }   // the server's actor, never the body's
decidedAt: Date
```

`required` has no default deliberately. `true` would make every style in the
deployment claim somebody had answered; `false` would remove a cost from every
one of them. Only `false` needs a reason, because only `false` removes a cost —
the rows that follow a `true` are its reason.

A "no" is refused while live rows contradict it: a style with an approved poly
bag and a statement that it needs no packaging is two answers, and the costing
would have to choose. Row-level exclusions (`included: false` +
`excludedReason`) do not count — they are already decided against, and they are
a *narrower* fact that says nothing about whether the family applies.

### Duty answers one of the two questions in its family

`duty` gates `DUTY` and `NON_RECOVERABLE_TAX`. Store stating that every
material is bought in India settles the first — no customs entry, so no duty —
and says nothing whatever about GST. So the family closes only when **both**
hold: Store's roll-up is `NOT_APPLICABLE`, **and** an input-GST treatment is in
force. Without the second, a domestic style would quietly clear a tax question
nobody answered.

A failed read resolves to no decision at all. "We could not check" and "there is
nothing to pay" are different facts, and only one of them is an answer.

### The refusal

```
POST /versions { technicalAcknowledgements: [...] }
→ 400 COSTING_APPLICABILITY_DECISION_MOVED
```

Refused, never silently stripped. Dropping it would calculate from whatever the
departments had actually decided while the person who pressed Calculate
believed they had excluded something else — a version that is right and
unexplainable. An empty list is refused too. The refusal names each family's
owner and its record, and marks the ones nobody may excuse as
`inherentlyRequired`, so a client is not sent looking for a screen that does not
exist.

### The unresolved-group checklist is retired

`technicalSource.UNRESOLVED` was four named groups — outside services,
embellishment, packaging, development — returned on every style, closable
either by a costing line of the right kind or by a Costing-side "does not
apply". It was right when it was written: none of them had a source.

Three of the four have records now and are assessed as FAMILIES from those
records, so the list had become a second checklist over the same three
questions — and could only be closed the one way this retires. The fourth,
`embellishment`, was outside processes under another name: no record, no
department, no family.

Frozen versions keep their `not-applicable:<group>` source references and read
exactly as they did.

### What a new decision freezes as

`DEPARTMENT_DECISION`, not `MANUAL_ENTRY`, with the family, the reason, the
person, their department and the record named. Dated when the **department**
decided — not when somebody pressed Calculate, which is what the actor and date
used to be.

Old `MANUAL_ENTRY` acknowledgements are untouched and are never reinterpreted.

## The labour formula, and why the old one was too low (5 Sep 2026)

`operationCosting.js` computes `net salary / 12,480 × SAM`, where 12,480 is
26 days × 8 hours × 60. It is the stock-item editor's own formula and correct
for what that screen does. As a COSTING it makes three unstated claims:

1. every paid minute is productive — no line balancing loss, no changeover, no
   absence, no rework. Garment lines run at 45–75%;
2. an operator costs their take-home pay — PF, ESI, gratuity, bonus and leave
   encashment are absent;
3. machines are free, or somebody else is paying for them.

The first two understate labour, usually the second-largest number in a garment
costing, by a third or more between them.

`services/centralCosting/labourCost.js` is now the one calculation, used by both
preview and save:

```
employer cost per month = net salary × (1 + employer burden %)
productive minutes      = stated minutes, OR 12,480 × efficiency %
cost per minute         = employer cost per month ÷ productive minutes
labour cost per garment = cost per minute × SAM
```

**Worked example.** ₹18,000 net, 18% burden, 9,000 productive minutes, SAM 1.5:
`18,000 × 1.18 = 21,240` → `21,240 ÷ 9,000 = ₹2.36/min` → `× 1.5 = ₹3.54`.
The old formula gives `18,000 ÷ 12,480 × 1.5 = ₹2.16` — **39% lower**.

**Both bases set is refused**, not resolved by precedence: 9,000 minutes and 80%
efficiency say 9,000 and 9,984, and silently preferring either buries a
disagreement inside every labour rate.

**An enum is not a machine-cost source.** `IN_OPERATION_RATE` states an
intention and supplies no number — nothing here records a machine hourly rate,
a depreciation schedule or a power rate — so that family stays unresolved.
`IN_OVERHEAD` and `NOT_COSTED` are answers.

Until all assumptions are configured, the sample's own `operatorCost` stands and
the line is reported PROVISIONAL. It is never presented as verified.

## The manual bypass, closed

`assembleLines` used to return the client's own lines when assembly was
`AWAITING_RND_TECHNICAL_DATA` or ambiguous, reasoned as "refusing them would
make an awaiting-R&D costing unusable". That reasoning was backwards: the whole
claim of a source-backed costing is that its consumption came from the sample,
so a version built from typed lines while that record is missing is a manual
costing wearing an enquiry product's name — and nothing on it said so.

It now refuses with `COSTING_AWAITING_SOURCE` (409), naming the state, the
owner and the candidates. No version is created. Ad-hoc costings keep the manual
calculator in full, and `POST /versions/legacy-import` is exempt — the Sales
costing sheet is an authoritative record that predates technical records, and
demanding a SampleStyle would make historical enquiries permanently
un-importable.

## Packaging and outside services get real sources (6 Sep 2026)

Two of the five AWAITING_SOURCE families above are closed by this chunk. The
audit that opened it confirmed the intended authorities and corrected one row of
the table.

### What the audit found

| Question | Answer found in the repository |
|---|---|
| Does R&D record which packaging a garment needs? | **No.** `SampleStyle.sample` holds `consumptionRawItems` and `operations` and nothing else. Packaging items exist in `RawItem` and can carry quotations; nothing connects a garment to them. |
| Does anything record which outside processes a garment needs? | **No.** `Service` is a master of what the company buys, not of what a style requires. |
| Is there a dated, company-scoped service quotation register? | **No.** `ServiceOrder.lines[].rate` is an approved rate on a downstream operational document; `SpendRequest.lines[].rate` is a requester's or Store's quote on an approval document. Neither is a register: neither is dated for validity, neither has a lifecycle, and both exist only once somebody has already decided to buy. |
| Can `Service.defaultRate` price a costing? | **No.** Its own schema comment says it: "an estimate for planning, NOT an approved cost and not an invoice price." |

### The corrected authorities

**Packaging** — the table above gave the whole family to R&D, which is wrong in
the same way it would be wrong for materials. It is split, and now reads exactly
like Materials because it is the same shape of problem:

- R&D owns **which packaging is required and how much** — a new
  `sample.packagingRequirements[]` collection on the technical record.
- Packaging identity is the existing company-scoped `RawItem` master. A poly bag
  is a material the company buys; it needs no second master.
- Store owns **what it costs** — the existing `SupplierOffer` register, with its
  tax basis, validity, MOQ, order multiple, tiers and lead time. No rate is
  duplicated onto the `SampleStyle`.
- The Product BOM stays unread. It is downstream of the approved sample.

**Outside services** — split the same way, across three desks:

- R&D/Production owns **which process is required and how much** — a new
  `sample.serviceRequirements[]` collection.
- Service identity is the existing company-scoped `Service` master.
- Store/Purchase owns **what it costs** — a new `ServiceSupplierOffer` register,
  because none existed. It follows the `SupplierOffer` conventions rather than
  extending it: see below.
- `Service.defaultRate` is planning guidance and is never read by costing.
- `ServiceOrder` is downstream and is never read by costing.

### Why a separate service quotation register, not a polymorphic one

`SupplierOffer.itemId` is `required` and refs `RawItem`; its unit is a stock UoM
resolved against the Unit Master with a conversion factor. A service is billed
per visit, per hour, per month — units that are deliberately NOT in the Unit
Master, for the reason `Service.billingUnit` already states. Making one model
serve both would mean relaxing `itemId` to optional and making the UoM
conversion conditional, which weakens the material contract for every existing
row in order to accommodate a different one.

So: a separate model, the same conventions, and the genuinely shared logic
extracted rather than duplicated — `offerApplicability.checkQuantity` (MOQ,
order multiple, tier coverage) and the tax-basis rules are the same commercial
questions and are reused. A service adds one thing a material has not got: a
**minimum charge**, which is a floor on the line total rather than on the
quantity ordered.

### The two new families, in the assembly

Both behave like Materials: a requirement with no applicable quotation is a
BLOCKING gap owned by Store, several applicable quotations is a decision with a
person's name on it, and a requirement whose quantity or unit R&D has not
recorded is a BLOCKING gap owned by R&D — never a zero and never dropped.

Both carry a basis the materials family does not need: `PER_GARMENT` scales with
the run, `FIXED_PER_RUN` dilutes across it. A carton quoted for the order and a
screen-making charge are the same arithmetic.

| Family | Authority | Owner | Source of record |
|---|---|---|---|
| Packaging | AUTOMATIC | R&D + Store | `SampleStyle.sample.packagingRequirements[]` for HOW MUCH; `SupplierOffer` for WHAT IT COSTS |
| Outside services | AUTOMATIC | R&D/Production + Store | `SampleStyle.sample.serviceRequirements[]` for WHAT IS REQUIRED; `ServiceSupplierOffer` for WHAT IT COSTS |

Three families remained without a source after this chunk: **freight**, **customs
duty**, and **fixed/setup/development**.

*Superseded (7 Sep 2026):* freight and development have since acquired sources
of their own, and **provisional overrides are retired for every family** — see
"Provisional overrides — RETIRED" above. Customs duty is answerable by a
recorded "does not apply" with a reason, and by nothing else. Each still names
its owner, which is now the whole of the answer rather than half of it.

## Development, pattern, tooling and setup — the source decision

*(Recorded before implementing the chunk after the one above, which closes the
third of those three.)*

One-time setup is not one kind of cost with one kind of supplier. Pattern
making, marker making and grading are usually done by the company's own pattern
room; screen making, die making and lab dips are usually bought. A single
source would have forced half of it to be typed, which is what this family did
before.

So the requirement is classified where it is stated — on the technical record,
by the desk that knows — and the money follows the classification:

| Purpose | Source | Identity | Price of record |
|---|---|---|---|
| `OUTSIDE_PROCESS` | supplier | `Service` master | `ServiceSupplierOffer` (recurring, `SERVICE`) |
| `DEVELOPMENT_TOOLING` + `SUPPLIER_QUOTATION` | supplier | `Service` master | `ServiceSupplierOffer` (one-time, `FIXED_SETUP`) |
| `DEVELOPMENT_TOOLING` + `COMPANY_POLICY` | the company itself | `CostingPolicy.developmentCharges[].key` | the rate period in force at the costing's date — see the corrected table below |

Consequences, each of which is a rule somewhere in code:

- **One source per requirement, never two.** A row naming both a service and a
  charge would have two prices and nothing choosing between them. The declared
  source decides which half is read; the other is cleared on the way in and the
  combination is refused at save.
- **The basis is forced, not read.** A tooling row is `FIXED_PER_RUN` by
  definition. Stored as `PER_GARMENT` it would be multiplied by the run — ₹10,000
  of pattern work becoming ₹1,00,00,000 on a thousand-piece order.
- **No amount reaches R&D.** They choose a charge by its key; the label is for
  reading and the money stays in the costing policy. The engine resolves the
  effective entry at the costing's own `asOf`, so publishing next quarter's
  charge cannot re-price a version already frozen against this quarter's.
- **An internal line is `VERIFIED`, not `SUPPLIER_QUOTATION`.** It carries no
  supplier and no reference; claiming a quotation would claim evidence that
  does not exist. It is authoritative because Finance published it, and it
  still falls to `PROVISIONAL` when the requirement itself was planned rather
  than confirmed on the sample.
- **No configured charge is a BLOCKING gap owned by Finance**, naming the keys
  that ARE configured — not an invitation to type a figure.

| Family | Authority | Owner | Source of record |
|---|---|---|---|
| Development, tooling and setup | AUTOMATIC | R&D + Store, or Finance | `SampleStyle.sample.serviceRequirements[]` (purpose + source) for WHAT IS REQUIRED; `ServiceSupplierOffer` or `CostingPolicy.developmentCharges[]` for WHAT IT COSTS |

### The internal charge table, corrected

The first cut of the company table held ONE amount per key and let the policy
update replace it. Two consequences, both accounting defects rather than
inconveniences:

- **A rate had no history.** Publishing October's amount deleted September's,
  so a September costing could not be recalculated at the figure it was
  actually costed at, and "what did this cost when we quoted it" had no answer.
- **Every charge was flat.** Screen making is ₹2,000 A SCREEN. Forced into a
  flat charge, Finance had to publish a "four screens" rate — a rate that lies
  about what it is — or somebody had to type ₹8,000 into the costing.

So a definition is now a stable key with a LIST of rate periods and an explicit
calculation mode:

| Field | Meaning |
|---|---|
| `key` | permanent; what a stored requirement holds |
| `label` | editable; renaming orphans nothing |
| `calculation` | `FLAT_PER_RUN`, or `PER_REQUIREMENT_UNIT` |
| `unit` | what one IS — Screen, Plate, Pattern. Per-unit charges only |
| `rates[]` | `{ amountMinor, currency, effectiveFrom, effectiveTo }` |

Rules, each enforced where the table is WRITTEN so a costing never meets a
table it cannot resolve:

- Periods are half-open, `[effectiveFrom, effectiveTo)`. A period ending on the
  1st and one starting on the 1st are adjacent, not overlapping, and a costing
  dated the 1st resolves to the later one. Closed intervals make midnight
  ambiguous, and the ambiguity is invisible: two rates match and the first one
  found wins, which depends on the order somebody typed them in.
- Overlapping periods are refused; a start date is required; only the last
  period may be open-ended.
- A rate must be in the company's base currency. Nothing in this system holds
  an exchange rate on a date, so another currency could only reach a costing by
  being guessed at.
- Resolution selects exactly one period at the costing's `asOf`. **Zero and
  several are both refusals** — the first is a gap Finance closes, the second
  is a table contradicting itself, and neither is resolved by picking one.

`asOf` is the moment the version is calculated and is deliberately not
client-supplied: a date in the request would let a costing be backdated onto a
cheaper rate.

**The key is permanent, and withdrawal is deactivation.** The model has always
said so; whole-array policy writes quietly allowed otherwise, because a key
that simply did not appear in the submitted list was gone. Requirements on
styles point at these keys and the frozen provenance of approved versions names
them, so a disappearing key leaves the first unpriceable and the second
unexplainable. At policy-write time the submitted table is compared with the
stored one by KEY — never by array position or label:

- every stored key must still be present, or the save is refused with
  `DEVELOPMENT_CHARGE_KEY_REMOVED` (409) naming the charges and the remedy;
- renaming a key is the same refusal, because the old one is missing;
- clearing the table is the same refusal;
- labels, descriptions, rate periods, the calculation mode and `active` are all
  freely revisable under the existing revision check;
- a new definition is **minted** a readable, unique key server-side from its
  name — nobody is asked to invent a permanent identity while naming a form
  field, and nobody can edit one afterwards.

A stale revision is now diagnosed before the table is validated, so the loser
of a race is told they lost a race rather than told what is wrong with a form
that is fine. The write condition `{company, revision}` remains the protection.

**Compatibility.** A definition written in the flat shape — amount at the top
level, one window around it — IS one rate period, so it is adapted into one
rather than discarded (`developmentCharges.adaptCharge`, applied on read, on
write and in the assembly). A flat row with no start date applied from whenever
it was published; it adapts to the epoch, which says the same thing in a shape
a date can be compared against.

### Requirement identity

A line key derived from the charge key or the service id makes two legitimate
requirements one line — screens for the body and screens for the sleeve
collide, and the second is either merged away or counted twice. Neither is
visible: the costing simply shows one row.

So each requirement row carries a `rowId`, minted server-side, preserved across
edits and resubmissions, and honoured from the browser only when the style
already holds it. The assembled line key is built from it. Rows stored before
`rowId` existed fall back to what they name, so an old style's costing does not
change its keys underneath it.

### Where each desk meets the table

| Desk | Sees | Route |
|---|---|---|
| Finance | definitions, every rate period, amounts | `GET/PUT /api/costings/policy/current`, edited in the Costing Policy screen |
| R&D | key, label, description, calculation, unit, active — **no amounts, no periods** | `GET /api/cms/sales/sample-styles/:id/development-charges` |
| Costing | the resolved rate, server-side, frozen into provenance | assembly; nothing client-supplied |
| Sales | nothing of this table | — |

R&D selects a definition and supplies a quantity **only** when the calculation
is `PER_REQUIREMENT_UNIT`. The costing resolves the applicable rate at its own
`asOf` and freezes charge key and label, calculation, unit, quantity, unit
amount, computed run total, currency, the selected period's start and end,
policy revision, `asOf`, the requirement row identity and the technical
evidence.

**Two** families now remain without a source: **freight** and **customs duty**.
They are the only two for which a hand-entered figure is still the answer the
screen offers, and the coverage row says so per family rather than offering the
same blank box to all of them.
