# Central Costing Roadmap

> **Status:** Proposed execution plan.
>
> **Objective:** Build one company-owned costing system that consumes factual
> Store, Manufacturing and Finance inputs, calculates versioned garment cost
> and quantity scenarios, applies company margin policy, and gives Sales only
> the approved commercial number it is allowed to see.
>
> **Related durable briefs:**
> `docs/product/store-purchase-professionalization.md`,
> `docs/product/connected-lifecycle.md`, and
> `docs/product/crm-master-requirements.md`.

## 1. Decisions already made

1. Costing is a shared company capability. It does not belong to Sales,
   Store, Accounts or Manufacturing alone.
2. Company costing and margin settings live in central CMS administration.
   Sales consumes approved outputs; it does not maintain costing policy.
3. Store owns commercial facts: item identity, supplier identity, quotations,
   purchase UoM, lead time, MOQ, tax basis and purchase history.
4. Manufacturing owns technical facts: BOM consumption, process loss,
   operation sequence, SAM and production assumptions.
5. Finance owns accounting facts: overhead pools, financing assumptions,
   exchange-rate policy, recoverability of tax and actual posted cost.
6. Cost is calculated independently of profit. Profit bands convert true cost
   into a permitted selling-price range; they never rewrite cost.
7. Economies of scale are calculated, not invented. The engine may dilute
   fixed/setup cost and apply factual supplier quantity quotations. It must not
   manufacture supplier discounts merely because the company wants a margin.
8. Every costing is a frozen version. Later changes to a supplier price,
   overhead policy or BOM create a new version and never alter old history.
9. Budget and costing remain separate controls. Costing answers "what should
   this order cost?" Budget answers "have we authorised this spend?"

## 2. Ownership and output

| Layer | Owns | Must not own |
| --- | --- | --- |
| Store | Supplier offers, purchase terms, purchase history, landed item cost | Margin policy or calculated garment selling price |
| Manufacturing | BOM, consumption, wastage, SAM, operations and capacity assumptions | Supplier commercial terms or profit bands |
| Finance | Overhead pools, financing, tax treatment, FX policy and actual cost | BOM quantities or supplier selection |
| Central Costing | Calculation rules, versions, scenarios, provenance and approvals | Editing upstream masters silently |
| Sales | Customer target, quote context and approved selling output | Company-wide rates, overhead policy or unrestricted margin data |

The output contract for Sales is:

- recommended selling price;
- permitted range or approval-required warning;
- quantity break prices;
- currency, Incoterm, validity and assumptions;
- cost and margin only when the user's server-side capability permits them.

## 3. Delivery approach

Each chunk must leave one usable result and preserve the calculation contract
created before it. Do not wait for every future master to be perfect before
showing an MVP, but label provisional inputs honestly and snapshot them.

### Fast verification rule

For normal chunks run only:

1. focused pure calculation tests for changed rules;
2. one happy-path API or lifecycle test;
3. one permission or tenant-boundary test where protected data is involved;
4. the affected frontend build and a desktop/mobile visual check when UI moves.

Do not run the entire backend and frontend regression suite after every chunk.
Run a broader integration suite only at the end of Chunks 3, 6 and 8. Security,
tenant isolation, money arithmetic, rounding and immutable-version checks are
never optional even in the fast lane.

## 4. Chunk plan

### Chunk 1 - Boundary and calculation contract

**Why first:** the Store professionalisation brief records unfinished tenant
and permission boundaries. Costing will expose supplier prices, internal cost
and margin, so its read paths cannot inherit those gaps.

Build only the narrow safety and domain contract needed by costing:

- define capabilities for viewing cost, editing cost inputs, editing costing
  policy, approving cost and viewing margin;
- enforce company scope on every Store/Manufacturing read endpoint consumed by
  costing;
- define central identifiers: `Costing`, `CostingVersion`, `CostingScenario`
  and stable source-reference shapes;
- define money, quantity, UoM, currency, tax-basis and rounding conventions;
- write an architecture decision covering ownership and visibility.

**Visible result:** an authorised user can create an empty costing draft for a
company/style/order context; another company and an unauthorised role cannot
read it.

**Not in this chunk:** full Store master migration or costing UI.

### Chunk 2 - First usable costing number

**Why now:** users need value early. The engine can calculate correctly from
explicit snapshot inputs before all automatic master integrations exist.

- implement a pure costing engine for materials, operations, services,
  miscellaneous cost, fixed/setup charges, wastage and overhead;
- add company costing policy for base currency, rounding, overhead basis,
  minimum margin, target margin and approval threshold;
- calculate true total/unit cost independently from profit;
- calculate minimum, target and preferred selling prices from margin bands;
- add quantity scenarios so fixed costs dilute as quantity rises;
- adapt the existing Sales enquiry costing data into a frozen
  `CostingVersion` without deleting or rewriting legacy data;
- show Sales the approved commercial output; hide cost/margin unless allowed.

**Visible result:** for one style and several quantities, the system shows a
versioned unit cost and recommended selling-price band with a readable build-up.

**Input status:** manually entered or imported current Store rates are marked
`provisional` and copied into the version. They are never live references.

### Chunk 3 - Store supplier offers and price provenance

**Why:** a mutable `vendorNicknames[].price` is useful for lookup but is not
strong enough to prove what rate a historical costing used.

- introduce a company-scoped supplier-item offer/history model or the
  equivalent approved target from Store Chunk 2;
- record item/variant, supplier, supplier item code, purchase UoM, currency,
  tax-inclusive/exclusive basis, HSN/GST, MOQ, order multiple, lead time,
  quotation reference/document, effective date and validity;
- support factual quantity-price tiers only when a supplier quoted them;
- keep the existing alias price through a compatibility adapter and label it
  as an unverified current price;
- resolve the applicable offer by company, item, variant, quantity, UoM and
  costing date;
- snapshot the selected offer and source provenance into the costing version.

**Visible result:** a costing line can select a current supplier offer and show
exactly which quotation, quantity tier, tax basis and validity produced its
material rate.

**Chunk gate:** run the focused Store integration suite here, including tenant
isolation, expired offers, UoM conversion and immutable history.

### Chunk 4 - Garment technical costing

**Why:** supplier price alone is not garment cost.

- connect style/version and BOM material consumption;
- support fabric, trims, accessories and packaging with consumption UoM,
  allowance, wastage and process loss;
- connect operations/SAM and approved labour or process rates;
- support washing, printing, embroidery, testing and outside services;
- handle one-time development, pattern, tooling and setup charges separately;
- show missing inputs and confidence without silently substituting zero;
- preserve every technical-source version used by the costing.

**Visible result:** one garment style receives a complete material, conversion,
service and overhead cost build-up without retyping available master data.

### Chunk 5 - Economies-of-scale scenarios

**Why:** EOS must explain why cost changes with scale rather than apply an
arbitrary discount.

- calculate fixed/setup-cost dilution by quantity;
- apply factual supplier quantity tiers from Chunk 3;
- model operation efficiency or wastage changes only from an approved company
  policy/rate table with provenance;
- provide three demand bases: current confirmed quantity, selected confirmed
  future demand, and a probability-weighted forecast scenario;
- never combine demand across incompatible item variants, delivery windows,
  suppliers or commercial validity periods;
- display the cause of each unit-cost change: purchase tier, setup dilution,
  efficiency, freight or overhead;
- keep profit bands as a separate selling-price calculation after cost.

**Visible result:** users can compare "this order only", "confirmed combined
demand" and "forecast demand" and see why each unit cost differs.

### Chunk 6 - Review, approval and quotation handoff

**Why:** a calculated number is not yet a commercially controlled number.

- add `Draft -> In review -> Approved -> Superseded` costing lifecycle;
- compare versions and show changed inputs, cost and price impact;
- require approval below the company minimum margin or outside policy;
- store approver, decision, time and reason immutably;
- lock the approved version used by a quotation;
- hand approved price breaks, currency, Incoterm, assumptions and validity to
  Sales quotation without re-entry;
- strip restricted cost, supplier-rate and margin fields server-side.

**Visible result:** Sales can quote from an approved costing version and cannot
quietly alter the underlying cost or restricted margin.

**Chunk gate:** run the first full Style/BOM -> Costing -> Approval -> Sales
quotation lifecycle test.

### Chunk 7 - Procurement and budget projection

**Why:** costing should create demand intelligence, while budget remains the
authorisation control.

- explode an approved/selected costing scenario into item/service demand by
  quantity and required month;
- aggregate demand without creating a PO or budget commitment prematurely;
- show expected procurement value by item, supplier, month and budget head;
- carry stable costing-version and costing-line references into requisitions;
- carry planned-item/budget-line attribution when the item-wise budget model
  authoritatively resolves it;
- allow budget comparison and exception workflow without changing calculated
  cost;
- support one request producing separate supplier POs rather than refusing a
  legitimate multi-vendor requirement.

**Visible result:** the business sees what an accepted costing would require it
to buy and whether the planned spend fits the appropriate budgets.

### Chunk 8 - Actual cost and margin feedback

**Why:** the model becomes trustworthy only when estimates are compared with
what the company actually bought, consumed and posted.

- carry costing/version/line references through requisition, PO, receipt,
  supplier voucher and consumption;
- reconcile quoted supplier price, PO price, received quantity, invoice price,
  landed cost and actual material consumption;
- include non-recoverable taxes and allocated landed charges; exclude
  recoverable GST from cost;
- compare estimated versus actual cost and margin by style/order;
- explain variance by material price, consumption, wastage, labour, service,
  freight, FX and overhead;
- feed approved historical evidence into future-costing suggestions without
  rewriting historical versions.

**Visible result:** after completion, management sees estimated versus actual
unit cost/margin and the precise reasons for variance.

**Chunk gate:** run the broad end-to-end suite from supplier offer and BOM to
costing, quotation, requisition, PO, receipt, voucher and actual-cost report.

## 5. Calculation invariants

The first engine must preserve these rules:

```text
true cost = materials
          + operations/labour
          + outside services
          + packaging
          + allocated fixed/setup cost
          + overhead
          + financing cost
          + freight/duty/non-recoverable charges

selling price at margin m = true cost / (1 - m)
```

- Recoverable GST is not cost.
- Margin and markup are not interchangeable.
- A zero value and a missing value are different.
- No floating-point money arithmetic; calculate in integer minor units.
- Quantity and UoM conversions must retain their source and rounding.
- A provisional or expired source may be used only with a visible warning and
  policy-controlled approval; it is still snapshotted.
- Budgets may warn, authorise or block spend according to budget policy, but
  they never change the cost calculation.

## 6. Work deliberately deferred

- AI-generated supplier prices or discounts;
- automatic use of speculative enquiries as committed volume;
- rewriting the whole Store Item Master inside the costing feature;
- automatic PO creation merely because a costing was approved;
- changing historical costings when masters or policies change;
- putting company policy maintenance in the Sales application.

## 7. Immediate starting scope

Start with **Chunk 1**, then proceed directly to **Chunk 2**. Treat them as one
short launch sequence: Chunk 1 establishes the protected contract; Chunk 2
delivers the first usable result. Do not begin the supplier-offer migration in
Chunk 3 until the Store tenant boundary required by its existing active brief
is demonstrably enforced for the affected masters and read paths.
