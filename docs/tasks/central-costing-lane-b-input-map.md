# CENTRAL COSTING — LANE B: NON-PACKAGING INPUT MAP (7 Sep 2026)

## 28 · Board input GST treatment — the fourth governed policy (done, 8 Sep 2026)

`GST_TAX_POLICY` is no longer a field on the costing policy. It is a **Board
policy version**, resolved at the same seam as overhead and labour.

### Four facts called "GST", and this is one

The **rate** is the supplier's, on their quotation (Store). **Customs duty** is
a different charge with no source at all. **Output GST** is the customer's
invoice (Sales/Accounts). This policy answers only the fourth question:
whether eligible **input** tax is reclaimed or becomes what the garment cost.

### The quotation keeps its exception

`offerPricing.taxPositionFor` was **not touched**. A quotation recorded
`NON_TAXABLE` carries no GST whatever the policy says, and a company treatment
on one is *refused* rather than applied. A taxable quotation with no recorded
rate is still refused rather than called zero-rated; a recorded `0` is still
honoured as the supplier's statement.

**The Board decides how ELIGIBLE input tax is treated; it does not decide what
is taxable.**

### One overlay, five families

Materials, packaging, outside processes, bought-in development services and
freight all read `policy.inputGstTreatment` from one object, so one overlay
covers them. Engine arithmetic unchanged: recoverable is reported on
`recoverableTaxMinor` and added to nothing; non-recoverable is added to the
line.

### Duty and GST: one family, two facts

The `duty` family covers both because both are tax that stays with the company.
They are **not** merged into one Board policy — that would mean approving a
customs position nobody can compute. Readiness now names
`INPUT_GST_TREATMENT` (migrated) beside `CUSTOMS_CLASSIFICATION` (no source),
and `dutyDecision` still refuses to close the family on domestic sourcing alone
while the treatment is unset.

### What is frozen

The per-line workings were already frozen and stay: `tax.treatment`,
`tax.ratePercent`, per-scenario `taxMinor` and `recoverableTaxMinor`, and the
quotation's own rate on `offerProvenance`. New:
`CostingVersion.gstProvenance` — which Board decision produced the treatment,
its effective date, its approver.

### Legacy

`GST_POLICY_MOVED` (409); clearing only; value retained for historical
explanation and applied to nothing. A company with no approved policy has its
quotation-backed lines **refused**, which is the existing behaviour — only its
source moved. `/costing/policy` lost its select.


## 27 · Board labour methodology — the third governed policy (done, 8 Sep 2026)

`LABOUR_METHODOLOGY` is no longer four fields on the costing policy. It is a
**Board policy version** on the lifecycle §25 established, resolved against the
costing's own date at the same seam overhead uses.

### The arithmetic did not change

`services/centralCosting/labourCost.js` was **not touched** and remains the
single labour authority:

```
employer cost = net salary × (1 + burden %)
productive    = stated minutes, OR 12,480 × efficiency %
per minute    = employer cost ÷ productive
per garment   = per minute × SAM
```

`getPolicy(ctx, {asOf})` overlays the Board's approved version onto the four
names that module reads. Nothing else moved.

### One rule that is not "is it filled in"

The productive basis is **exactly one** of stated minutes or an efficiency.
Neither is a company that has not decided; both is a company that has said two
different numbers — 9,000 and 80% of 12,480 (9,984). Refused at the write, and
at approval, matching what `labourCost.productiveBasis()` has always enforced
at calculation time.

### Production keeps its half

The route, the SAM and each operation's salary basis are Production's. The
Board decides how a paid month becomes productive, the employer burden, and
where machine cost sits.

### Machine burden — approvable and still blocked

The only Board answer that can be valid and still leave a costing incomplete.
`IN_OPERATION_RATE` names a machine-cost source **nobody has built** (owner:
not yet assigned); `IN_OVERHEAD` depends on the overhead policy being in force;
`NOT_COSTED` depends on nothing but must state why. Reported as dependencies
separate from the policy, and frozen on the version as they stood.

### What is frozen

`CostingVersion.labourProvenance`: the Board decision, **both halves of the
productive basis** (the efficiency AND the minutes it resolved to, taken from
`labourCost` itself), the burden, the treatment, any open dependency — and
**every operation's working**: SAM, salary, employer monthly cost, productive
minutes, cost per minute, resulting figure. No version has ever kept those, so
a labour figure could not be checked once the sample, the operation master or
the policy had moved.

### Legacy

`LABOUR_POLICY_MOVED` (409) on write; all four clear together, because they are
one methodology. Values stay readable for historical explanation and feed no
calculation. `/costing/policy` had four live controls — more than any other
retired family — and all are gone.


## 26 · Board overhead — the second governed policy (done, 8 Sep 2026)

`OVERHEAD_POLICY` is no longer a field on the costing policy. It is a **Board
policy version** on the lifecycle §25 established — drafted, approved by a
named person, effective from a date, superseded rather than overwritten — and
resolved against the costing's own date.

### What changed, and what deliberately did not

**The arithmetic did not change at all.** Overhead is still a percentage of a
named subtotal, still synthesised by `engine.js` as its own `PERCENT_OF_BASIS`
line, still ordered by the same basis graph. `engine.js` was not touched.

What changed is where the rate comes from. `getPolicy(ctx, {asOf})` resolves the
effective Board version and **overlays** it onto `policy.overheadRatePercent` /
`policy.overheadBasis` — the two names the engine already reads — and
`versionCreation` passes the costing's own `meta.asOf`. One seam, one
resolution.

### Why it is one rate

"Company and factory overhead" stays one figure. Every frozen costing carries a
single overhead line and nothing here records the corporate pool separately
from the factory pool, so splitting them would mean asking the Board to approve
an allocation nobody has computed.

### The legacy writer, and the hazard it created

`savePolicy` refuses `overheadRatePercent` / `overheadBasis` with
`OVERHEAD_POLICY_MOVED` (409). Clearing is the one write still accepted. The
fields stay readable — old versions have to stay explicable, and a company has
to see the number it needs approved — but they feed no calculation: applying an
unapproved value under a Board-governed family would be treating it as
Board-approved.

**The `/costing/policy` screen genuinely had controls** here, unlike financing:
a basis select and a rate input. Both are gone, replaced by a read-only
statement and, where one survives, the legacy figure shown as retired.

The hazard: `getPolicy` stopped projecting those two names, and `savePolicy`
`$unset`s anything undefined — so a save of an unrelated setting would have
wiped the legacy value. `validatePatch` seeds them from `legacyOverhead*` and
only an explicit clear removes them. There is a test named for it.

### Readiness — four states, no rate

`resolveState` reports `EFFECTIVE` / `FUTURE_ONLY` / `DRAFT_ONLY` / `NONE`. A
draft is waiting for an *approver*, and a future-dated policy needs nobody to
act; a department told "the Board has not decided" would be wrong in two of the
four cases. The projection publishes the state, the dates and the approver's
name — never the rate or the basis.

### What is frozen

`CostingVersion.overheadProvenance`: the Board decision (id, effective date,
approver, approval time), the rule (rate, basis), and **per scenario** the
`basisAmountMinor` beside the `overheadMinor` it produced — because
`DIRECT_PLUS_FIXED` is a computed subtotal and "12% of direct plus fixed"
cannot otherwise be re-derived without recalculating the whole costing.

### The fixture migration

Overhead was ordinary fixture in ~17 suites, which is why this migration was
larger than financing's (3). Rather than seventeen copies of an approval call,
`test/costing/helpers/sourceBacked.js` `configureProduction()` now approves one
— idempotently, since several suites call it after every policy save — at the
same 12% of `DIRECT_PLUS_FIXED` those suites used to write inline, so every
figure they assert is unchanged. `overhead: null` opts out.


## 25 · The Board's financing methodology — the first governed policy (done, 7 Sep 2026)

`FINANCING_POLICY` is no longer a field on the costing policy. It is a **Board
policy version** with a draft, an approval, an approver, an effective date and
a history — and financing is now calculated per order from that decision and
the payment terms §24 gave Sales.

**With it, the `financing` family is closed at both ends.** It is the first
family in this lane where the operational contract and the Board policy behind
it both exist.

### What the flat rate was, and why it had to go

`CostingPolicy.financingRatePercent` + `financingBasis` — one company number
applied as a percentage of a subtotal to every costing. It knew nothing about
how long the money was out, so two orders with the same materials and payment
terms ninety days apart carried identical financing. It was a surcharge with a
cost of capital's name on it, which §5.2 recorded and §24 closed the Sales half
of.

It also had three defects of *governance*, which are the reason the replacement
is a lifecycle and not another field:

| | `CostingPolicy` | `BoardPolicy` |
|---|---|---|
| draft | none — a save is in force immediately | `DRAFT`, editable, applies to nothing |
| approval | none | `BOARD_APPROVED`, with the approver stamped server-side |
| history | `revision` counts changes and keeps none | every version kept, never rewritten |
| effective date | none | required on approval; resolution is by date |

### The record

`models/CMS_Models/Board/BoardPolicy.js` — `{companyId, policyKey}` versioned.
`policyKey` is `FINANCING` and nothing else today; the lifecycle is built to
carry the rest.

**Only two statuses are stored** — `DRAFT` and `BOARD_APPROVED`, the two that
are *acts*. `EFFECTIVE` and `SUPERSEDED` are **derived** from the calendar and
from what else is approved. Storing them would mean something has to run at
midnight to make a future-dated policy true, and something has to write to
every earlier row on every approval; a job that does not run then leaves the
company on last year's rate with nothing saying so.

**Resolution is a query, not a state machine:**

> the approved version with the greatest `effectiveFrom` at or before the
> costing's own date.

Which makes two required rules structural rather than enforced: a future-dated
version cannot affect an earlier calculation because the query does not select
it, and at most one version is in force on a date because the greatest
qualifying date is unique. A partial unique index on
`{companyId, policyKey, effectiveFrom}` over approved rows makes sure two
approvals never share one.

### The methodology contract

| Field | Why it has no default |
|---|---|
| `annualRatePercent` | what money costs this company; nobody else can say |
| `basis` | a rate with no basis is not a rule (the engine's own basis vocabulary, so a basis this record can name is one the engine can resolve) |
| `advanceTreatment` | `REDUCES_FINANCED_AMOUNT` \| `IGNORED` — **a Board decision, deliberately not hard-coded.** "Money already received is not money being financed" is the common answer and not the only defensible one |
| `dayCountBasis` | 365 or 360. They differ by ~1.4% of the figure |
| `effectiveFrom` | required to approve; a rule with no start applies to everything ever costed |
| `rationale` | the figure says what; this says on what basis |

Nothing is seeded. A company with no approved policy has none, and its
costings say so.

### The formula

```
financedShare    = advanceTreatment === REDUCES_FINANCED_AMOUNT ? (100 − advance%) / 100 : 1
effectivePercent = annualRate × financedShare × creditDays ÷ dayCountBasis
financing        = selected basis × effectivePercent ÷ 100
```

The derived percent is applied through the existing `PERCENT_OF_BASIS`
machinery, so financing still joins the same basis graph and is still ordered
after overhead by `SUBTOTAL_BEFORE_FINANCING`. What changed is where the
percentage comes from — `services/centralCosting/financing.service.js`, which
is pure and tested on its own.

### Five answers, and only two of them are a line

| State | Line | Why |
|---|---|---|
| `CALCULATED` | a figure | both records answered |
| `RECORDED_ZERO` | a nil line, with the terms frozen beside it | 100% advance, or 0 credit days — the money is out for no time, which is an **answer** |
| `NOT_APPLICABLE` | a nil line, with the reason frozen | Sales stated a condition. Needs no Board policy: asking the Board to decide the borrowing rate before an intercompany transfer can be recorded as unfinanced is asking the wrong person about the wrong order |
| `TERMS_MISSING` | **none** | nobody has agreed when this order gets paid |
| `POLICY_MISSING` | **none** | the Board has not decided |

The last two produce no line — never a zero, which would be the claim that this
order costs nothing to finance. Both gaps are reported, not the first: they are
fixed at different desks, and reporting one leaves the other department
believing their half was done.

**They do not block the save**, for the reason a missing freight arrangement
does not: a draft that cannot be calculated at all stops every costing in the
company until the Board has met and somebody has been round every open enquiry.
The FAMILY is blocked, `costComplete` cannot be reached, and the draft still
calculates — honestly incomplete rather than silently wrong.

### What is frozen

`CostingVersion.financingProvenance` — the Board's half (`boardPolicyId`,
`policyEffectiveFrom`, `policyApprovedAt`, `policyApprovedByName`,
`annualRatePercent`, `basis`, `advanceTreatment`, `dayCountBasis`) and Sales'
half (`enquiryRef`, `termsState`, `advancePercent`, `creditDays`,
`creditDaysFrom`, `termsSource`, `termsConfirmedAt`, `termsConfirmedByName`),
plus the arithmetic (`financedSharePercent`, `effectivePercent`, `formula`).

Copied **by value**. `boardPolicyId` is there so the decision can be found;
every figure beside it is there so the calculation can be checked without
finding it — and so a policy approved next quarter, a backdated one, or a
customer renegotiating cannot restate a costing frozen before any of it
happened. That is the same guarantee `policySnapshot` and `freightProvenance`
already give, obtained the same way.

### The old writer

`policy.service.savePolicy` **refuses** `financingBasis` and
`financingRatePercent` with `FINANCING_POLICY_MOVED` (409), by name rather than
by silently dropping them. **Clearing is the one write still accepted**, so a
company can retire its legacy rate through the screen it was set in without
that being a way to set a new one.

`engine.js` no longer synthesises a line from the retired field, and warns
`POLICY_FINANCING_RETIRED` where one survives — a rule that stops applying
without saying so is a number that changes for a reason nobody can find. The
fields stay on the model, in `policySnapshot` and in the GET response
(`financingPolicy.editable: false`), because versions frozen under the flat
rate have to stay explicable.

There was **no financing control on `/costing/policy`** to remove — the two
fields were writable only through the API. The screen now states where the
decision lives, with no link: a reader there may well not be on the Board, and
a control that navigates somewhere they cannot open is worse than a sentence.

### The Board app

`app/board/dashboard/policies/financing`, in its own app — `/board`, with its
own shell, navigation and switcher tile.

It shipped at `/ceo/dashboard/policies/financing` and was moved, because the
first placement answered the wrong question. The `ceo` grant was already the
board-level boundary, so filing the screen inside the CEO app meant nothing had
to be seeded — a sound argument about ACCESS that settled IDENTITY by accident.
Everything else in the CEO dashboard reports what the company *did*; a Board
policy is the company deciding what it *will* do, and filed under one office it
read as that office's setting.

**The app is Board; the access grant is still `ceo`.** `hrAccess.js` and
`fulfilmentAccess.js` have both declared `BOARD_DEPT_SLUGS = new Set(["ceo"])`
since before this screen existed, and a `board` slug would need an
`AccessDepartment` row seeded before anybody could be granted it — so the app
would be unreachable by everyone rather than restricted to the Board. The split
lives in three constants (`guardSlug`, `BOARD_VIA_SLUG`, `BOARD_DEPT_SLUG`);
seeding a real grant moves those and nothing else.

The old address redirects and renders no editor: `app/board/…/financing` is the
only page that mounts `FinancingPolicyPanel`, and a test counts them. The CEO
nav entry went with the screen rather than staying as a second way in.

`requireDepartmentRole` is **deliberately not used**: it waves through
`req.user.isAdmin`, which would hand the company's financing rate to every
platform administrator, and it lets *everyone* through when a slug has no
grants yet. `services/board/boardAccess.js` reads the grant directly, per
request, with no bypass — `viewer` to read, `editor` to draft, `approver` to
approve. Drafting and approving are different ranks on purpose: a policy whose
author is always its approver has a review step in name only.

The screen reads the rule back **in words and on one round order** before
anybody approves it. Nobody on a Board will compute a financing figure by hand,
and an advance rule set the wrong way round is invisible as a dropdown reading
`IGNORED` and obvious as a sentence.

### What is still the Board's, and unmigrated

*(Written when financing was the only migrated key. All eight are Board
records now — overhead, labour methodology, GST treatment, development
charges, contingency, margin and customs duty followed. `policyFacts` reports
a real effective date and approver for each, and still reports `null` where a
company has approved nothing, because claiming an effective date a record does
not hold would be worse than saying it is not recorded.)*


## 24 · Sales payment terms — the financing duration (done, 7 Sep 2026)

`PAYMENT_TERMS_DURATION` is no longer a missing source contract. **With it,
every operational source contract in Lane B is closed.**

**Destination:** `SALES_PAYMENT_TERMS` → `payment-terms`, on the Enquiry stage.

### What was already there, and what was reused

| Field | Record | Structured? | Reused |
|---|---|---|---|
| `advancePercent` | Account | yes (0–100, unset ≠ 0) | **yes** — the standing default |
| `creditDays` | Account | yes | **yes** — the standing default |
| `paymentTermsCode`, `negotiatedTerms` | Account | no, prose | carried for display, **never parsed for days** |
| `advancePercent`, `balanceTerms` | `SalesJourney.po.paymentTerms` | mixed | **untouched** — it gates production, at the PO stage |
| — | Enquiry | nothing existed | **new** |

`services/paymentTerms.js` (Account → PO, production gate) is unchanged and
still does exactly what it did. It answers at the PO stage, long after a
costing runs, and the only duration it produces is a display string built from
free text. A financing cost cannot be worked out from prose, so the enquiry
answers the same question one record earlier and structurally.

### What Sales can now record, on the Enquiry

`Enquiry.paymentTerms`: `advancePercent`, `creditDays`, `creditDaysFrom`
(`INVOICE` / `DISPATCH` / `BILL_OF_LADING` — new vocabulary, because nothing
distinguished them before and a duration with no anchor cannot become a cost),
`notApplicable` + `notApplicableReason`, `note`, plus provenance:
`source`, `accountDefaultAtConfirmation`, `confirmedAt`, `confirmedBy`.

### Defaults are copied, never read through

The Account is the **default**. Its figures are offered as a labelled
suggestion and written nowhere until Sales confirms; on confirmation they are
**copied** onto the enquiry with `source: ACCOUNT | ENQUIRY` and a snapshot of
what the Account said at that moment.

So a customer renegotiating in November cannot restate what an order costed in
March was quoted on — and an override stays legible as a *difference* after
the Account has moved again. Re-typing the customer's own figures records
`ACCOUNT`, not an override: agreement is not deviation, the same reasoning
`services/paymentTerms.js` already applies to the PO. Editing confirmed terms
re-opens them rather than carrying somebody's name onto figures they never saw.

### The projection Central Costing receives

`paymentTermsResolution.projectionFor(enquiry)` — the enquiry's own confirmed
copy, with **no account fallback**:

```
{ state, advancePercent, creditDays, creditDaysFrom, creditDaysFromLabel,
  notApplicable, notApplicableReason,
  source, overridden, accountDefaultAtConfirmation,
  confirmedAt, confirmedByName, gaps[] }
```

**No financing rate, amount or margin is in it**, for any caller. The rate and
the methodology are the Board's.

### Readiness

| Sales recorded | Status |
|---|---|
| Confirmed, complete | `ready` |
| Explicit condition + reason | `not_applicable` |
| Started but incomplete, or complete but unconfirmed | `in_progress` |
| Nothing | `not_started` — *"an unanswered question is not a cash sale"* |

`not_applicable` is reachable **only** through a stated commercial condition —
never from silence, and never from a 100% advance, which is a financing
duration of zero rather than an absence of financing.

Server-side validation refuses each field by name, and refuses the one genuine
contradiction: a 100% advance with a credit period. A zero duration needs no
anchor ("0 days from the invoice" and "0 days from dispatch" are the same
term); a non-zero one does.

### Can financing now be calculated? No — and the gap is the Board's

`assembly.service.js` applies `financingRatePercent` × a basis subtotal, with
**no duration participating at all**. That is unchanged, deliberately: turning
an advance and a credit period into a cost of capital needs a **methodology**
— is the rate annual, is it applied to the financed portion only, is it
`rate × days/365` — and that is a Board decision, not a narrow correction to
make on their behalf. Inventing one here would be exactly the "percentage of a
subtotal dressed as a cost of capital" this contract exists to end, in a new
place.

So `PAYMENT_TERMS_DURATION` reaches `ready` while the `financing` **family**
stays blocked on `FINANCING_POLICY` (§12). Two blockers, two owners.

**Frozen-version note.** Requirement asked that a frozen Costing Version retain
the payment-term facts it used. It uses none yet — the assembler does not
consume them, because the methodology does not exist — so there is nothing to
freeze and no `paymentTermsProvenance` was added. The durable guarantee that
*does* exist today is one record earlier and is tested: the enquiry copies at
confirmation, so no later Account or Enquiry edit can restate what a costing
read. When the Board methodology lands, the version should freeze the
projection alongside `policySnapshot`, the way `freightProvenance` already
freezes the arrangement.

### All operational source contracts are closed

| Requirement | Owner | Where |
|---|---|---|
| `MATERIAL_BOM_IDENTITY` | Merchandising | Style BOM |
| `MATERIAL_CONSUMPTION`, `TECHNICAL_SPECIFICATION`, `SHIPMENT_PACKED_WEIGHT` | R&D | Style technical record |
| `OPERATION_ROUTE_AND_SAM`, `OUTSIDE_PROCESS_REQUIREMENT` | Production | Route & SAM tab |
| `DEVELOPMENT_REQUIREMENT_IDENTITY` | Merchandising | Style BOM → Development |
| `FREIGHT_ARRANGEMENT`, `FREIGHT_DESTINATION`, `FREIGHT_RECOVERY_DECISION`, `PAYMENT_TERMS_DURATION` | Sales | Enquiry stage |
| `MATERIAL_QUOTATION`, `SERVICE_QUOTATION`, `FREIGHT_QUOTATION`, `SOURCING_ORIGIN_EVIDENCE` | Store | Quotation registers + item master |

One operational gap remains and is **not** a missing contract:
`OPERATION_SALARY_BASIS` — a real Production screen (the operation master)
that is not style-scoped.

### Next: the Board policy app

Everything left is Board-owned (§12). The smallest first task is the
**financing methodology**, because it is the only Board policy whose *input*
contract is now complete and whose family is blocked solely on it: a rate, a
statement of what the rate is per (annual / per order), and what it is applied
to (the financed portion, or the whole basis). `overhead` and
`labour methodology` need a rate table each; `duty` additionally needs the
tariff × origin table §23 named.

## 23 · Store sourcing and origin evidence (done, 7 Sep 2026)

`SOURCING_ORIGIN_EVIDENCE` is no longer a missing source contract. Store
records it in the existing supplier-quotation register and the item master.

**Destination:** `STORE_MATERIAL_QUOTATIONS` → `materials`.

### Where each fact lives, and why

| Fact | Record | Why there |
|---|---|---|
| Domestic or imported | `SupplierOffer.sourcing.type` | Varies by offer — a local mill and an importer may quote the same fabric |
| Country of origin | `SupplierOffer.sourcing.countryOfOrigin` (ISO-2) | Same: it is a fact about *this* supplier's goods |
| Origin evidence cited | `SupplierOffer.sourcing.evidenceNote` | Certificate of origin, bill of entry — what the claim rests on |
| Customs tariff classification | `RawItem.customsTariffCode` | A property of the **goods**. Two suppliers of one fabric do not classify it differently, and storing it per offer would let them appear to |

**Nothing was duplicated.** `SupplierOffer.hsnCode` stays what it was — the
**GST** code the supplier wrote. The two derive from the same Harmonised System
and are routinely different for the same goods: the HSN is what the seller
charges tax under, the tariff code is what the importer clears customs under.
Reading one as the other works a duty out against the wrong heading, so they
are separate fields with the difference written down in both models.

`Vendor.address.country` is deliberately **not** a fallback: where the supplier
*is* differs from where the goods were *made*, and a Ludhiana trader may quote
Chinese fabric.

### Controlled values

Sourcing type is a two-value enum. Country of origin is ISO-2 from the
company's own `constants/crm.js` `COUNTRIES` — now exported so Store shares the
CRM's codes rather than growing a second list where "China", "CN" and
"P.R. China" are one origin and three strings. The frontend mirrors the list
and the **server validates against its own copy**, so drift is a refusal rather
than a silently accepted bad code.

### The contract Central Costing receives

`services/storePurchase/sourcingEvidence.service.js` → `evidenceForItems(ctx, {itemIds})`,
company-scoped on both reads:

```
{ items: [{ itemId, itemName, itemSku, customsTariffCode,
            sourcingType, countryOfOrigin, evidenceNote,
            quotation: { offerId, reference, quotationDate,
                         effectiveFrom, validUntil, expired },
            state, blocking, missing: [{ field, owner, message }] }],
  complete, blocking }
```

**No rate, tier, MOQ, supplier name or amount is in it**, for any caller —
which is what makes it safe to answer Merchandising, R&D, Production and Sales
with "can this costing proceed" without telling them what the company pays.

### Readiness, and the one rule that matters

**Missing is never duty-free.** `NOT_APPLICABLE` is reachable *only* through an
explicit `DOMESTIC` decision recorded on a quotation. There is no path from
silence to it — that is why the state is an enum rather than a boolean.

| Store recorded | Requirement status |
|---|---|
| Imported, with origin **and** tariff code | `ready` |
| Domestic, on every material | `not_applicable` — a decision, traceable to a quotation |
| Imported, missing origin or tariff code | `in_progress`, naming the item |
| Nothing | `not_started` — "an unanswered question is not a domestic supply" |
| No ACTIVE quotation to record against | `awaiting_other_department` (Store) |
| BOM not chosen yet | `awaiting_other_department` (Merchandising) |

### Quotation lifecycle

Only an **ACTIVE** quotation is read. A `DRAFT` is not evidence — nobody
published it. A `WITHDRAWN` or `SUPERSEDED` one is a claim the company
retracted. Expiry is deliberately *not* a filter: an expired quotation is a
Store decision to revise and is still the last thing anybody said, so it is
reported with `expired: true` for the reader to weigh. Where several are
active, the most recently effective is the current statement.

### What remains blocked, and it is not Store's

*(Superseded — the table now exists. `DUTY_POLICY` is a Board policy with an
effective-dated tariff heading × origin table, and §6G of the lifecycle
document is the record of it. What survives from this section is the
separation it argued for: `SOURCING_ORIGIN_EVIDENCE` and the duty **rate** are
still two blockers with two owners, deliberately not collapsed, because
merging them would tell Store to fix something only the Board can.)*

No duty rate is invented, defaulted or temporarily parked anywhere. Tested by
asserting the projection's source names no rate at all.

### Next remaining source input

**`PAYMENT_TERMS_DURATION`** (Sales) — the last operational `SOURCE_CONTRACT_MISSING`.
`CostingPolicy.financingRatePercent` says what money costs; nothing says how
long this order's money is out, so financing is a percentage of a subtotal
dressed as a cost of capital. It needs payment terms (days, and whether an
advance is taken) on the Account and the Enquiry, published read-only to
costing — a smaller contract than this one, on a record Sales already owns.

`OPERATION_SALARY_BASIS` (a real Production screen that is not style-scoped)
also remains open.

## 22 · Merchandising development and tooling (done, 7 Sep 2026)

`DEVELOPMENT_REQUIREMENT_IDENTITY` is no longer a missing form. It is the
**Development** section of the existing Merchandising Style BOM at
`/merchandiser/styles/[id]`, anchored `development` — the same id the
source-app action names.

**Destination:** `MERCH_STYLE_DEVELOPMENT` → `development`.

### What Merchandising owns

| Fact | Where it goes |
|---|---|
| That the style needs one-time work at all | a `DEVELOPMENT_TOOLING` row |
| Where the work comes from | `developmentSource` — `SUPPLIER_QUOTATION` or `COMPANY_POLICY`, never both |
| Which service, or which published charge | `serviceId` from the company Service Master, or `developmentChargeKey` from the Board's approved catalogue |
| The specification | `specification` |
| A count, where the charge is priced per unit | `quantity`; the `unit` comes from the charge, never typed |
| That it does not apply, and why | `included: false` + `excludedReason` |
| An operational note | `notes` |

Storage is the existing `sample.serviceRequirements[]` — no second collection,
no migration, no backfill. `basis` is forced to `FIXED_PER_RUN`: a setup charge
stored as per-garment would be multiplied by the run.

### The ownership contract

- **Merchandising** states what work is needed and how much of it.
- **Store & Purchase** obtains the supplier quotation for work bought outside.
- **Board / Finance** publishes what the company charges for work it does
  itself. Merchandising chooses the charge **by name**; the amount is resolved
  at costing time from the policy table.

No rate, supplier, quotation, amount, margin, tax or policy value is accepted,
stored by this door, or returned — for anybody. The charge list published to
the screen carries key, label, calculation and unit, and no `rates`,
`amountMinor` or `currency`. Tested.

### The shared array, and its three former writers

`sample.serviceRequirements[]` now has exactly two owners and one bystander:

| Rows | Owner | Door |
|---|---|---|
| `purpose: OUTSIDE_PROCESS` | Production | Route & SAM tab (§21) |
| `purpose: DEVELOPMENT_TOOLING` | Merchandising | Style BOM → Development |
| — | R&D | **writes neither** |

Each door rebuilds only its own rows and carries the other's through as the
**stored objects** — not re-read field by field, not re-validated — so neither
can alter the other by accident, and a row whose shape a door does not
understand passes intact. R&D's sample submit no longer assigns the array at
all; it still *validates* what it was sent, so a malformed body is refused the
way it always was, and then does not apply it. R&D keeps a read-only summary
on its technical record, because the setup work is genuine technical context.

Row identity survives through `rowId`, minted server-side. Two requirements
naming the same charge — screens for the body and screens for the sleeve —
stay two rows. Tested.

### Remaining limitations

**The `owner` enum has no `MERCHANDISING` value.** `serviceRequirements[].owner`
is `RND | PRODUCTION`, and `SampleStyle` is Lane A's file, so this door writes
no `owner` on a development row rather than stamping a wrong one. The
user-facing ownership is correct — `sourceApps.js` names Merchandising — but
the stored field is coarse. *Proposed contract, not built here:* add
`MERCHANDISING` to that enum and stamp it, when Lane A's edits to that model
settle.

**A style needing no development work still reads `not_started`.** There is no
style-level "none needed" flag, and one was not invented. The way to answer it
is to record the requirement that was considered and mark it not applicable
with a reason — which is what `included: false` is for — or to acknowledge the
`development` family on the costing version, which already exists.

### Next remaining source input

**Store's sourcing and origin evidence** (`SOURCING_ORIGIN_EVIDENCE`) — *built,
and no longer a `SOURCE_CONTRACT_MISSING` blocker.* The quotation now carries
the sourcing type, the country of origin and whether the quoted rate already
includes the duty; the item master carries the customs tariff heading; and the
Board approves the rate table. Customs duty is costed from those three, and an
unanswered sourcing question still blocks rather than reading as nil.

The other open items are `OPERATION_SALARY_BASIS` (a real Production screen
that is not style-scoped) and `PAYMENT_TERMS_DURATION` (Sales, no record).

## 21 · Production outside processes (done, 7 Sep 2026)

`OUTSIDE_PROCESS_REQUIREMENT` is no longer a missing form. It is in the
existing **Production Manager → Product → Route & SAM** tab, alongside the
route it accompanies.

- Production selects an active, company-owned Service Master entry and records
  specification, quantity, billing unit, basis and production note.
- It writes only `sample.serviceRequirements[]` rows whose purpose is
  `OUTSIDE_PROCESS`, forces `owner: PRODUCTION`, and preserves every
  `DEVELOPMENT_TOOLING` row unchanged.
- The Service Master supplies identity; Store still owns supplier quotations,
  rates and validity. None of those fields is accepted, returned or rendered.
- R&D's sample submit preserves Production's outside-process rows, so its
  remaining development work cannot overwrite them.

The source-app action is now `PM_OUTSIDE_PROCESSES` → `outside-processes`.
The next unbuilt operational source remains **Merchandising development/tooling
requirement identity** on the Style BOM.

Lane A owns Packaging. This document owns everything else, and deliberately
records no Packaging decision: `PER_CARTON`, packaging selection, packaging
consumption, carton calculation and the packaging half of `CostingVersion` are
Lane A's, and nothing here reads, restates or re-decides them.

---

## 1 · What the audit found

### 1.1 The families, and where their state comes from today

`services/centralCosting/costCoverage.js` already holds the family list, an
`authority` (`AUTOMATIC` / `POLICY` / `AWAITING_SOURCE`), an `owner`
`{department, system}` and a one-line `awaitingMessage`. `assess()` produces
one of five states per family and `versionCreation` freezes the result on
`CostingVersion.completeness`. `visibility.js` republishes it inside the `cost`
block, behind `costing.cost.read`.

So the *state* was never the missing thing. What the frozen assessment does
**not** carry, and what this lane adds around it, is:

| Missing | Consequence on screen today |
|---|---|
| a **typed** owner (a department string, not a role or a grant) | the panel prints "Finance" and cannot decide whether *this* reader may act |
| **which exact fact** is absent | "Needs input" against a family with four possible inputs |
| **where** the fact is entered | the reader is told whose problem it is and left to find the screen |
| an **action identifier** | `actionsFor()` returns `"addCost"` / `"fixSource"` / `"reviewSource"` and `CostingWorkspace` renders each as an inert `<span>` — a chip that looks like a button and does nothing |
| a **provenance summary when ready** | a `CALCULATED` family shows a per-unit amount and the word "Calculated", with the evidence sitting unused in `offerProvenance` / `policyProvenance` / `freightProvenance` |

### 1.2 The dead-end rows, named

`components/costing/costingSummary.js::costCompleteness` maps every family with
no amount to the literal string `"Not available"` (`NOT_AVAILABLE`), and
`CostingWorkspace.js::CompletenessPanel` renders `f.actions` as
`<span data-action=…>` elements. Not one of them navigates. `"Not applicable"`
rows do carry `decidedBy` / `decidedAt`, but the panel prints them only as a
trailing dash-clause on the reason line, so an audited decision and an
unaudited one look the same at a glance.

### 1.3 A blocking gap never reaches a saved version

`versionCreation.service.js::refuseOnBlockingGaps` refuses the whole
calculation when the assembly still has a blocking gap. A **saved** version
therefore never carries an unresolved freight arrangement or a missing service
quotation — those are refusals, surfaced live in the editor from
`technicalPreview`. What a saved version *does* carry as `NEEDS_INPUT` is a
family that produced no line and no policy rule and that nobody acknowledged:
customs duty, financing and overhead when their policy is unset, and any family
the style simply has no requirement for.

That distinction is why the readiness payload in this lane is derived from the
**frozen version only**. See §6.

### 1.4 Deep links that already exist, and one that does not

`components/costing/assembledInputs.js` already builds `fixAt` links for three
rows. Two are correct; one points at a screen that does not exist:

| Row | `fixAt.href` | Verdict |
|---|---|---|
| service missing quotation | `/store/dashboard/supplier-offers?subject=services` | **exists** — `app/store/dashboard/supplier-offers/page.js` switches on `?subject=` |
| development, internal charge | `/board/dashboard/policies/development` | **exists** — a Board policy since 8 Sep 2026; `/costing/policy` shows only what the company still carries |
| freight missing quotation | `/store/dashboard/freight-offers` | **does not exist.** The freight register is the third tab of the same workspace: `?subject=freight` |

`AssembledInputs` is also rendered with `canFix` hard-coded to `true`, so the
link is offered to every reader regardless of grant.

---

## 2 · The source map (the required ownership table, resolved against the code)

`role` is the department grant that authorises the change —
`models/Access/DepartmentRole.js`, slug + ranked role, the same vocabulary
`services/storePurchase/capabilities.js` and `services/centralCosting/capabilities.js`
already resolve. `destination` is a stable identifier; the frontend maps it to
a route, and only to a route that exists.

| Family | Source of truth | Role permitted to change it | Destination id | Route |
|---|---|---|---|---|
| `materials` | `SampleStyle` material requirements (consumption); `SupplierOffer` register (rate) | `research-development` (editor+) for consumption; `store` (editor+) for the quotation | `RND_TECHNICAL_RECORD`, `STORE_MATERIAL_QUOTATIONS` | `/research-development/styles`, `/store/dashboard/supplier-offers` |
| `operations` | `SampleStyle` SAM (R&D); `Operation` master salary basis (`services/operationCosting.js`); `CostingPolicy` labour assumptions | `research-development` (editor+); `inventory`/`store` (editor+) for the operation master; `costing.policy.manage` for the labour policy | `RND_TECHNICAL_RECORD`, `OPERATION_MASTER`, `COSTING_POLICY` | `/research-development/styles`, `/store/dashboard/configurations/registered-operations`, `/costing/policy` |
| `services` | `SampleStyle.serviceRequirements[]` with `purpose: OUTSIDE_PROCESS`; `ServiceSupplierOffer` register | `research-development` (editor+); `store` (editor+) | `RND_TECHNICAL_RECORD`, `STORE_SERVICE_QUOTATIONS` | `/research-development/styles`, `/store/dashboard/supplier-offers?subject=services` |
| `freight` | `Enquiry.freight` delivery terms (arrangement, mode, prepaid treatment) with `Account.freightArrangement` as the standing fallback; `SampleStyle.sample.shipment` packed weight / garments per carton; `FreightOffer` lane register | `sales` (editor+) for the commercial terms; `research-development` (editor+) for the shipment facts; `store` (editor+) for the lane quotation | `SALES_ENQUIRY_DELIVERY_TERMS`, `RND_TECHNICAL_RECORD`, `STORE_FREIGHT_QUOTATIONS` | `/sales/dashboard/journeys` (enquiry stage), `/research-development/styles`, `/store/dashboard/supplier-offers?subject=freight` |
| `duty` | **Non-recoverable GST**: `SupplierOffer.gstTreatment` + `CostingPolicy.inputGstTreatment`, already applied per line. **Customs duty**: nothing | `store` (editor+) for the quotation's tax facts; `costing.policy.manage` for the GST policy. Customs has **no owner in this repository** | `STORE_MATERIAL_QUOTATIONS`, `COSTING_POLICY`, and `NONE` for customs | as above; none for customs |
| `financing` | `CostingPolicy.financingRatePercent`; the enquiry/account payment terms that decide how long the money is out | `costing.policy.manage`. **The payment-term half has no costing-facing contract** — see §5 | `COSTING_POLICY` | `/costing/policy` |
| `development` | `SampleStyle.serviceRequirements[]` with `purpose: DEVELOPMENT_TOOLING`; either `ServiceSupplierOffer` (bought outside) or the Board's `DEVELOPMENT_CHARGE_POLICY` catalogue (done in-house) | `research-development` (editor+); `store` (editor+) for the quotation; **`ceo` approver+ for the catalogue** | `RND_TECHNICAL_RECORD`, `STORE_SERVICE_QUOTATIONS`, `BOARD_DEVELOPMENT_POLICY` | `/research-development/styles`, `/store/dashboard/supplier-offers?subject=services`, `/board/dashboard/policies/development` |
| `overhead` | `CostingPolicy.overheadRatePercent` | `costing.policy.manage` | `COSTING_POLICY` | `/costing/policy` |

`packaging` is **absent from this table on purpose.** It is Lane A's, and the
readiness payload built in this lane skips it rather than describing it.

---

## 3 · The Costing read model

Costing reads, and never writes, every fact above. The readiness payload is a
**pure derivation** — no live source read, no database access, no new frozen
field:

```
inputReadiness(frozen version) →
  [{ family, state, headline, explanation,
     owner:      { department, role, grant },
     missingFacts: [{ key, label, owner, destination }],
     destination:  { id, label, requires } | null,
     decision:     { reason, decidedBy, decidedAt } | null,
     evidence:     { summary, entries[] } | null,
     sourceContract: "PRESENT" | "MISSING" }]
```

`state` is one of seven, and the four that are answers stay distinguishable
from the three that are questions:

| State | Means | Blocks readiness |
|---|---|---|
| `READY` | a line or a policy rule produced an amount | no |
| `RECORDED_NIL` | a real rule produced nil — the customer collects, a charge is waived | no |
| `NOT_APPLICABLE` | somebody decided, and said why, and is named | no |
| `MISSING_INPUT` | a fact this family needs has not been recorded | **yes** |
| `AWAITING_DECISION` | the missing fact is a commercial decision, not data | **yes** |
| `BLOCKED_SOURCE` | the source was supposed to answer and did not | **yes** |
| `SOURCE_CONTRACT_MISSING` | no authoritative record for this exists anywhere yet | **yes** |

`SOURCE_CONTRACT_MISSING` is the state this lane adds, and it exists so that a
family with no source stops being offered a blank box. It never becomes zero
and it never becomes "not applicable" on its own.

---

## 4 · Readiness states, by family

| Family | `READY` when | `MISSING_INPUT` / `AWAITING_DECISION` when | never |
|---|---|---|---|
| `materials` | the frozen assessment has an amount | no consumption, or no applicable quotation | costed at zero for a missing rate — `versionCreation` refuses the calculation |
| `operations` | as above | no SAM, or the operation's salary basis is unset | a free operation |
| `services` | as above | a `SERVICE` requirement with no applicable quotation | a `DEVELOPMENT_TOOLING` requirement counted here |
| `freight` | a lane quotation priced it | arrangement unrecorded (`MISSING_INPUT`, Sales); `prepaid` with no treatment (`AWAITING_DECISION`, Sales) | zero because nobody answered. `ex_works` / `to_pay` are `RECORDED_NIL` **with the arrangement frozen**, which is an answer |
| `duty` | non-recoverable GST was applied per line | customs: `SOURCE_CONTRACT_MISSING` | silently zero |
| `financing` | the policy rate produced a line | the policy rate is unset | silently zero |
| `development` | a quotation or a published charge priced it | neither exists for a `DEVELOPMENT_TOOLING` requirement | typed into the costing |
| `overhead` | the policy rate produced a line | the policy rate is unset | silently zero |

**Freight's accounting distinction is preserved exactly as the freight chunk
left it.** `ex_works` and `to_pay` are recorded zeros carrying
`freightProvenance.arrangement` and `arrangementSource`; `delivered` is priced;
`prepaid` is a decision owned by Sales and is never priced at nil. This lane
reads that frozen provenance and reports it — it does not re-derive it.

---

## 5 · Families still blocked by a missing source contract

Two, and both stop at the boundary rather than growing a Costing input.

### 5.1 Customs duty — no import classification exists

Nothing in the repository records an import classification, a duty rate, a
country of origin against a purchased item, or a preferential-origin claim.
`SupplierOffer` carries an HSN code taken from the quotation and a GST rate;
neither is a customs classification.

**The Store half is built — see §23.** Sourcing type and country of origin on
the supplier quotation, the customs tariff classification on the item master.
`SOURCING_ORIGIN_EVIDENCE` now has a real Store form and reaches `ready`.

**The Board half is not.** A duty table keyed by tariff heading and origin,
effective-dated the way `CostingPolicy.developmentCharges[]` already is, owner
Finance (`costing.policy.manage`). Until it exists the `duty` FAMILY stays
blocked — on `DUTY_POLICY`, naming the Board, not on Store.

### 5.2 Financing — CLOSED at both ends (see §25)

This section recorded the defect: `CostingPolicy.financingRatePercent` answered
*what money costs* and nothing answered *how long this order's money is out*,
so a financing cost was a percentage of a subtotal dressed as a cost of
capital.

**Both halves now exist.** §24 gave Sales the duration, structured and
confirmed on the Enquiry. §25 gave the Board the rate AND the methodology, as
an approved, effective-dated policy version — and the assembler now combines
them per order instead of applying a flat percentage.

`PAYMENT_TERMS_DURATION` and `FINANCING_POLICY` remain **two blockers with two
owners**, deliberately not collapsed: either can be the one outstanding, and
telling Sales to fix the Board's rate is how a family sits still for a month.

### 5.3 Recorded, not proposed: per-fact resolution is not frozen

`CostingVersion.completeness.families[]` freezes a state, an amount, an
authority and an owner *department* — not **which** of a family's facts was
the one that was absent. This lane therefore reports a family's required facts
from the static contract in §2 and marks them as the facts this family needs,
rather than claiming the version recorded which single one was missing.

Adding `completeness.families[].missingFacts[]` to the frozen assessment would
close this, and it is a change to `CostingVersion` and `versionCreation` —
**Lane A's files.** It is recorded here and not made.

---

## 6 · A frozen version's evidence never moves

The readiness payload is computed from `CostingVersion` alone: the frozen
`completeness`, `freightProvenance`, `policyProvenance`, `offerProvenance` and
`policySnapshot`. Nothing in it reads `SampleStyle`, `SupplierOffer`,
`ServiceSupplierOffer`, `FreightOffer`, `CostingPolicy` or `Enquiry` live.

So a supplier revising a quotation, Finance publishing a new overhead rate, or
Sales changing an account's standing freight term changes **nothing** on a
version already frozen — the same guarantee `offerProvenance` was built to give
for rates, extended to the readiness statement about them.

The only live thing on the row is the **destination link**, which is
navigation, not evidence. A link is where a person goes; it makes no claim
about what this version was built from.

---

## 7 · What this lane does not do

- No Packaging. No `PER_CARTON`, no packaging selection, no carton maths, no
  Packaging test, no edit to `SampleStyle`, `technicalSource`, `offerPricing`,
  `assembly`, `versionCreation`, `technicalBinding`, `engine` or
  `CostingVersion`.
- No manual cost, rate or quantity field on a readiness row. Costing is not a
  master-data, technical-consumption, quotation or policy-entry form, and the
  readiness payload emits no action that would make it one.
- No removal of the pre-existing "Add provisional override" control in the
  assembled-inputs editor. It predates this lane, it is exercised by existing
  tests, and deleting it is a change to the calculation path rather than to the
  readiness surface. It is recorded here as an open question for whoever owns
  the override policy.
- No new source. Where a family has no truthful source it says so and stops.

---

# LANE B, PART 2 — THE INPUTS MOVE INTO THE OWNING APPS (7 Sep 2026)

## 8 · The product decision this part implements

**No operational user will work inside Central Costing.** It is an internal
calculation, validation, versioning and audit engine, and its UI may later be
removed altogether. Sections 1–7 above stay true — the frozen-version readiness
payload is still how a costing explains itself — but they describe a *costing*
screen, and nobody is going to open one.

So every input Costing needs is now surfaced **where the person who owns it
already works**: on their own Style or Enquiry, inside their own department's
app. The existing Costing cards in §4 are left in place as internal
compatibility surface and receive no further investment.

## 9 · The backend contract

| Layer | File | What it is |
|---|---|---|
| The map | `services/centralCosting/sourceApps.js` | Which department owns which fact, the grant that proves it, the six statuses, the typed blockers, and the Board policy list. Pure. |
| The projection | `services/centralCosting/sourceAppRequirements.service.js` | Reads the LIVE style, enquiry, quotation registers and policy, proves the company, and resolves each requirement. Creates nothing. |
| The door | `routes/CMS_Routes/Costing/sourceRequirements.js` → `/api/cms/costing-inputs` | `GET /apps`, `GET /requirements`. Gated on a **department grant**, not a costing capability. |

**Mounted outside `/api/costings` on purpose.** That namespace requires a
costing capability, and the departments that own these facts hold none — the
same reasoning that put the supplier register under
`/api/cms/inventory/supplier-offers`. A merchandiser must not need a costing
session to be told their own bill of materials is unfinished.

### The six statuses

`not_started` · `in_progress` · `awaiting_other_department` · `blocked` ·
`ready` · `not_applicable`.

`awaiting_other_department` is the one that earns its place: R&D cannot measure
a component Merchandising has not chosen, and telling R&D "missing" sends them
to a form that cannot accept the answer. It names the other department and
offers **no action**.

`blocked` means there is nowhere to record the fact at all. It offers no action
either, and carries the contract that would have to exist.

### What the payload may contain, and what it never can

Presence only. A quotation EXISTS or does not; a policy is IN FORCE or is not.
No rate, no quoted amount, no supplier name, no quotation reference, no policy
value, no margin, no cost — for any caller, including a platform
administrator. `storeFacts` uses `distinct` on ids rather than `find`, so there
is no path by which a price could reach the response even by accident.

## 10 · Field ownership, and the actual mounts

| Department | Facts it owns | Mounted on | Real local action |
|---|---|---|---|
| Merchandising | `MATERIAL_BOM_IDENTITY` | `StyleSampleStage` (Style context; mounted by Sales, Merchandiser and Project Manager dashboards) | scrolls to `#style-bom`, the finished good's BOM panel already on that page |
| Merchandising | `DEVELOPMENT_REQUIREMENT_IDENTITY` | same | **none — typed blocker.** See §11 |
| R&D | `MATERIAL_CONSUMPTION`, `TECHNICAL_SPECIFICATION` | `app/research-development/styles/[id]` | scrolls to `#technical-materials` |
| R&D | `SHIPMENT_PACKED_WEIGHT` | same | scrolls to `#shipment` |
| Production | `OPERATION_SALARY_BASIS` | `StyleSampleStage` | the operation master is a real Production screen; no in-page section, so the row names it without a button |
| Production | `OPERATION_ROUTE_AND_SAM`, `OUTSIDE_PROCESS_REQUIREMENT` | same | **none — typed blocker.** See §11 |
| Sales | `FREIGHT_ARRANGEMENT`, `FREIGHT_DESTINATION`, `FREIGHT_RECOVERY_DECISION` | `EnquiryStage` (Enquiry context) | scrolls to `#delivery-terms`, the existing `DeliveryTermsPanel` |
| Sales | `PAYMENT_TERMS_DURATION` | same | **none — typed blocker.** See §11 |
| Store | `MATERIAL_QUOTATION`, `SERVICE_QUOTATION`, `FREIGHT_QUOTATION` | `app/store/dashboard/supplier-offers` when opened with `?styleId=` or `?enquiryId=` | switches the register's own `?subject=` tab |
| Store | `SOURCING_ORIGIN_EVIDENCE` | same | **none — typed blocker.** See §11 |
| Board | company policy only | nowhere | named blockers on the families they stop. See §12 |

**Packaging is absent from this table.** Lane A owns the Merchandising
selection, R&D's consumption, `PER_CARTON` and the BOM → Packaging section
being built for it. `sample.shipment.garmentsPerCarton` in particular is Lane
A's to surface: it is the carton capacity shared between packaging and freight,
and restating it here would put two screens in charge of one field. Lane B
reports the packed weight and nothing else about the shipment.

### The panel

`components/costing-inputs/CostingRequirementsPanel.js`, over the pure
`sourceRequirements.js`. Three properties matter:

1. **It renders nothing when nothing is owed.** No heading, no empty box. Most
   people on most screens own no costing input, and a card saying so is noise.
2. **Every action is a SECTION of the page it is already on**, resolved through
   a `sections` map the *host* declares. An action id the host has not declared
   is not navigated to, and nothing falls back to a URL. That is the mechanism
   by which a costing requirement cannot send anybody into `/costing` — not a
   promise that it will not.
3. **Not holding a grant is not an outage.** A 401/403 clears the panel
   silently; only a genuine failure is announced.

## 11 · Source forms that do not exist

Five, each reported as `blocked` with a `SOURCE_FORM_MISSING` or
`SOURCE_CONTRACT_MISSING` code, no action, and the contract written down.

| Fact | Owner | Where it lives today | The contract that would close it |
|---|---|---|---|
| `OPERATION_ROUTE_AND_SAM` | Production | R&D's technical record (`techSheet.technical.operations[]`) | A per-style route and SAM screen in the Project Manager app writing the same rows, with R&D's entry retired rather than duplicated |
| `OUTSIDE_PROCESS_REQUIREMENT` | Production | R&D's `sample.serviceRequirements[]` | An outside-process section in the Project Manager app writing rows with `purpose: OUTSIDE_PROCESS` |
| `DEVELOPMENT_REQUIREMENT_IDENTITY` | Merchandising | R&D's `sample.serviceRequirements[]` with `purpose: DEVELOPMENT_TOOLING` | A development-requirement section on the Merchandising BOM screen, naming the published charge type and nothing about money |
| `PAYMENT_TERMS_DURATION` | Sales | nowhere | Payment terms (days, and whether an advance is taken) on the Account and the Enquiry, published read-only to costing |
| `SOURCING_ORIGIN_EVIDENCE` | Store | nowhere | Country-of-origin and import-status facts on the supplier quotation, alongside a Board-owned duty table keyed by tariff heading and origin |

**And one missing entry point, not a missing form.** Store's registers exist
and are real screens; what does not exist is a *style-scoped sourcing worklist*
that would take a storekeeper from "this style needs quoting" to the register
with the subject already set. The panel accepts `?styleId=`/`?enquiryId=` and
is ready for it; nothing links there yet.

## 12 · Board-owned policy

Seven policies, reported as `BOARD_POLICY_REQUIRED` blockers on the families
they stop — never as a field anybody could fill in from a departmental screen.

| Key | Policy | Blocks |
|---|---|---|
| `OVERHEAD_POLICY` | Company and factory overhead | `overhead` |
| `FINANCING_POLICY` | Cost of financing | `financing` |
| `LABOUR_METHODOLOGY` | Labour costing methodology | `operations` |
| `GST_TAX_POLICY` | Input GST treatment | `duty` |
| `DEVELOPMENT_CHARGE_POLICY` | Development and tooling charges | `development` — migrated to the Board 8 Sep 2026 |
| `CONTINGENCY_POLICY` | Standard contingency | **no cost family** — a cushion ON a cost, not an input to one; the line is `MISC`, which `costCoverage` leaves ungated. Reported as an open Board decision, never blocking. Migrated to the Board 8 Sep 2026 |
| `MARGIN_POLICY` | Pricing floor — one management markup | **no cost family** — it governs the selling decision, not what the garment costs. It is the one policy whose absence stops a costing outright: the floor price is derived from it, so version creation is refused with `MARGIN_POLICY_REQUIRED` rather than a gap being reported. Migrated to the Board 8 Sep 2026; the three-band margin model it carried was replaced by one markup on 9 Sep 2026 — the KEY is unchanged, the contract is versioned (§6H of the lifecycle document) |
| `DUTY_POLICY` | Customs duty | `duty` — **has a record now.** Store records import + origin on the quotation, `RawItem.customsTariffCode` carries the heading, and the Board approves the rate table. Charged on the quotation-backed purchase amount, **not** statutory CIF. Migrated 9 Sep 2026 |
| `DUTY_POLICY` | Customs duty | `duty` — and has no field to configure at all |
| `MARGIN_GUARDRAILS` | Pricing floor (management markup) | **nothing.** It governs the selling decision, which is a different readiness question |

Each blocker carries the policy NAME, the company scope, the recorded effective
date, and the recorded Board approval — and **no value**. A merchandiser
learning the company's overhead percentage from a readiness panel is precisely
the leak this boundary exists to prevent, and "in force / not in force" is the
whole of what anybody outside Finance and the Board needs.

### The lifecycle this task deliberately does not build

```
draft → Board-approved → effective-dated → superseded
```

A policy is drafted, approved by the Board as a body, comes into force on a
stated date, and is **superseded rather than edited**. `CostingPolicy` today
has a `revision` counter, no approval state and no effective dating, so the
projection reports `boardApproved: null` and `effectiveFrom: null` — *not
recorded*, which is the truth, rather than asserting a date the record does not
hold.

**Old Costing Versions stay frozen through all of it.** Every version resolved
its policy once and kept a snapshot (`CostingVersion.policySnapshot`, and the
per-charge `policyProvenance` rows). Publishing a new policy version,
superseding an old one, or backdating an effective date cannot restate a
costing that has already been calculated. Whatever the Board lifecycle
eventually looks like, it must **preserve that property rather than replace it
with a live lookup** — a costing that re-reads policy at display time is a
costing whose history changes underneath its approvals.

## 13 · What part 2 does not do

- No new screen, queue, form, action or navigation inside `/costing`. The
  existing Lane B cards from §4 remain as internal compatibility surface and
  receive no further investment. No "My Costing Inputs" page was added.
- No change to costing arithmetic, to any frozen-version schema, or to any
  Lane A file.
- No duplicate data. The projection creates no task, no checklist row, no
  shadow BOM and no shadow quotation — it resolves the presence of records that
  already exist.
- No Board policy schema, no approval workflow, no effective dating. Only the
  typed `BOARD_POLICY_REQUIRED` state and the lifecycle recorded above.

---

## 14 · Correction — the Merchandising and Production mounts are gone (7 Sep 2026)

The Pipeline was removed from the Merchandiser and Project Manager apps, routes
included: `app/merchandiser/dashboard/journeys/**` and
`app/project-manager/dashboard/journeys/**` are deleted, and both navs lost the
item. The Sales Journey itself is untouched and lives where it always did, at
`/sales/dashboard/journeys`.

**§10's Merchandising and Production rows are now wrong, and this is the
correction.** Those two departments reached `StyleSampleStage` only through
their own journey mounts. With the mounts gone they have **no** surface for
their Costing inputs:

| Department | Facts | Mount as of now |
|---|---|---|
| Merchandising | `MATERIAL_BOM_IDENTITY` | **none** |
| Production | `OPERATION_SALARY_BASIS` | **none** (its two other facts were already blocked — §11) |

Nothing is broken by this. The panel is department-filtered server-side, so the
`StyleSampleStage` mount now renders for a Sales viewer as an empty card that
draws nothing, and `/api/cms/costing-inputs` still answers correctly for both
departments — there is simply no screen calling it for them.

**The unchanged mounts** are R&D (`app/research-development/styles/[id]`),
Sales (`EnquiryStage`, still reached from the Sales journey) and Store
(the supplier-offer register behind `?styleId=`/`?enquiryId=`).

**What would restore them**, in each department's own app rather than through a
second copy of somebody else's journey:

- **Merchandising** — the panel on `app/merchandiser/products/stock-item-view/[id]`
  or the item form's Materials tab, which is where the BOM identity is actually
  entered. That screen is per stock item, not per style, so the projection would
  need a `stockItemId` subject or the styles resolved from it.
- **Production** — the panel on
  `app/project-manager/inventory-configurations/registered-operations`, which is
  where `OPERATION_SALARY_BASIS` is entered. That screen is the operation
  master, not per style, so the same subject question applies.

Both are real screens that exist today; what neither has is a Style or Enquiry
in scope. That is the missing piece, and it is a subject-resolution problem
rather than a missing form — recorded here rather than solved, because
inventing a style-less requirements view would report facts against nothing.

---

# LANE B, PART 3 — PRODUCTION OWNS THE ROUTE AND SAM (7 Sep 2026)

## 15 · What moved, and what did not

**The record did not move.** `techSheet.technical.operations[]` is still the one
stored route and standard time. What moved is the **owner** and, with it, the
**door**.

| | Before | Now |
|---|---|---|
| Writer | `PUT /api/cms/crm/sample-styles/:id/technical` (R&D, `salesAuth`), alongside materials and requirements | `PUT /api/cms/production/style-route/styles/:styleId/route` (Production, `project-manager` grant) |
| R&D's writer | rebuilt `t.operations` from the body | **ignores** `operations` entirely and never writes the array |
| R&D's screen | full editor — search, add, remove, minutes/seconds inputs | read-only summary, with the ownership stated on the section |
| Gap owner | `operationGaps → owner: "RND"` | `owner: "PRODUCTION"`, message reworded |
| Lane B contract | `SOURCE_FORM_MISSING`, no action | a real local action, `PM_STYLE_ROUTE` → section `route-and-sam` |

R&D's writer **ignores** rather than refuses an `operations` key: their screen
still renders the route as technical context and its payload still echoes what
it was given, and refusing that would break every legitimate save over a field
nobody was trying to change. What matters is that nothing there writes it.

## 16 · The Style/Product destination

Production has no Journey and no enquiry list. Their work begins at a Product:

```
Production Manager → Products → a product → Route & SAM → a style → the route
```

| | |
|---|---|
| Screen | the existing product workspace, `/project-manager/products/stock-item-view/[id]` |
| Section | a **Route & SAM** tab, offered only to a `project-manager` grant (or an administrator) |
| Action id | `PM_STYLE_ROUTE` → local section `route-and-sam`. No URL, no Journey, no `/costing` |
| Editing | needs the record open **and** Production editor; either missing is read-only and the row says which |

The tab is deliberately distinct from the existing **Operations** tab on the
same page, which shows the finished good's own costed manufacturing route
(`StockItem.operations`, with rupee columns). Two operations concepts on one
page is confusing enough without offering the second to people who do not own
it.

## 17 · The ownership rule, on the screen

> Production records time and route. Company policy determines the approved
> rupee cost of a minute.

Rendered verbatim on the panel. There is no rate field, no cost column and no
rupee anywhere in the section — absent, not hidden behind a permission, because
a form that merely omits a field leaves people looking for it. The service's
allowlist refuses `operatorCost`, `operatorSalary`, `rate`, `salaryDept` and
`salaryDesig` by name, so a body carrying one is told what it may not carry
rather than having it quietly dropped.

## 18 · What the boundary accepts

`services/production/styleRoute.service.js`, reached only through
`routes/CMS_Routes/Manufacturing/productionStyleRoute.js`:

- **Allowlist, not blocklist** — `operationId`, `minutes`, `seconds`, `notes`,
  and `sequence` (accepted, never stored). Anything else is refused by name,
  including at the envelope, so the next field added to the model does not
  become writable here by accident.
- **Identity from the register** — code, name and machine are re-read from
  `Operation` on every save. An id the register does not hold is refused with
  `OPERATION_NOT_REGISTERED` and the **whole save is rejected**; the previous
  writer silently dropped such a row, which left a person unable to tell a
  mis-click from a register that changed under them.
- **Order is sequence.** The array's order is the route's order; `sequence` is
  echoed back derived from the index. Storing it twice would give two answers
  the first time somebody reordered without renumbering.
- **Nothing else moves** — not the technical record's status, not its revision,
  not materials, not packaging, not requirements. Production recording a route
  must not send R&D's record anywhere.
- **Read-only when the record is with Sales or approved**, with the reason
  naming who unlocks it. An approved revision is what a costing may already
  have been calculated from.
- **No Journey leaves the file.** Company ownership is proved through the
  style's linked journey or enquiry — that is where a `SampleStyle`'s company
  lives — but `styleView()` is built field by field, and no journey id, enquiry
  id, enquiry number or customer name is in any response.

## 19 · Remaining limitations

### 19.1 Two masters have no company scope at all

Neither `Operation` nor `StockItem` carries a `companyId`. They are global
registers today.

So the boundary enforces what is real: **the STYLE is the tenancy boundary**,
proved one at a time through `ownershipProofFor`. A product's styles that
belong to another company are not listed; an operation is checked for being
*registered*, not for being *this company's*, and the code says so rather than
filtering on a field the model does not have.

**This also fixed a live defect.** `sourceAppRequirements.operationMasterFacts`
queried `Operation.find({ companyId, ... })`, which matched **nothing** — so
every style reported "every operation has a salary basis" whether or not any
did. Exactly the false-ready the whole projection exists to prevent.

**Proposed contract, not built here.** `companyId` on `Operation` and
`StockItem`, stamped at creation and enforced at every read, with a migration
that assigns existing rows deliberately rather than by guess.

### 19.2 There is no separate route lifecycle

The route is editable only while R&D's technical record is `draft`, `rework` or
`not_started`. Production is therefore gated by another department's workflow
for a fact they own — the honest consequence of the record living inside R&D's
subdocument. Loosening it would let an approved revision disagree with the copy
it was approved as.

**Proposed contract, not built here.** A route lifecycle of its own — recorded,
approved, superseded — independent of the technical record's, or the route
lifted out of `techSheet.technical` into a record Production owns outright.

### 19.3 Machine and setup are not separately recorded

The model holds `machineType`, which is the **register's** fact and is shown
read-only, and `notes`, which is free text. There is no structured
"setup required" field, and one was not invented: the section asks for the
machine or setup need in the note rather than pretending a field exists.

**Proposed contract, not built here.** A typed setup requirement on the route
row, if Production wants it separated from the note.

### 19.4 Legacy rows

`operationId` is schema-required on this array, so a row naming no registered
operation cannot be written through the model. Rows already stored are read and
published as they stand, with their own code and name snapshot, and are never
migrated, backfilled or dropped. A save replaces the route with what was sent,
in the order it was sent — nothing rescues a row the caller removed.

## 20 · Correction to §10

`OPERATION_ROUTE_AND_SAM` no longer appears in §11's missing-form table. §10's
Production row now reads: **mounted on** the product workspace's Route & SAM
tab, **real local action** `PM_STYLE_ROUTE`.

Production's two remaining blockers are unchanged:
`OUTSIDE_PROCESS_REQUIREMENT` (still recorded on R&D's technical record, still
no Production screen) and `OPERATION_SALARY_BASIS` (the operation master is a
real Production screen but is not style-scoped).
