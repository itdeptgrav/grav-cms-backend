# Store & Purchase Professionalisation Plan

> **Status:** Proposed product and architecture plan; implementation has not
> started.
>
> **Backend:** `/Users/risheeray/grav-cms-backend`
>
> **Frontend:** `/Users/risheeray/grav-cms`
>
> **Goal:** Turn the existing Store and Purchase surfaces into one dependable,
> professional procurement and inventory application while preserving their
> connections to Requests, Manufacturing, Budget Control, Accounting, Vendors,
> CEO reporting and barcode workflows.

---

## 1. Product outcome

The finished application must provide one traceable operating chain:

```text
Demand
  -> approved purchase requisition
  -> supplier enquiry / quotations
  -> approved purchase order
  -> goods receipt and inspection
  -> accepted stock in a location
  -> supplier bill matched in Accounting
  -> payment visible from Accounting
```

For stock already owned:

```text
Demand
  -> stock reservation
  -> issue from a warehouse location
  -> consumption / return / transfer
  -> immutable stock movement history
```

Every quantity and rupee must be explainable from its source document. The
Store app must not become a second accounting system, and Accounting must not
become a second inventory system.

### Professional standard for this project

“Professional SaaS level” means the system has:

- one authoritative record for every business concept;
- controlled state transitions instead of arbitrary status edits;
- server-side permissions and approval policies;
- immutable, reversible operational history;
- warehouse/location-aware stock;
- request, order, receipt, return, bill and payment traceability;
- company isolation and stable document numbering;
- concurrency-safe quantity and amount changes;
- exception queues instead of silent guesses;
- usable operational worklists, not only CRUD registers;
- reports that reconcile to their source transactions.

It does not mean copying another product's terminology or building every ERP
feature at once.

---

## 2. Current system map

### 2.1 Store frontend

The Store app currently contains approximately 69 page/module files under
`app/store/dashboard`. Its navigation groups:

- Overview
- Requests
  - Material Requests
  - Purchase Orders
  - Purchase Forms
  - Delivery
  - Vendors
- Stock
  - Raw Items
  - Product Marking
  - Warehouse
  - Units / Packaging
- Issues
  - Issue & Return
  - Accountability
- Reports
  - Item Ledger
  - Request History
- Configurations

The main operational surfaces are substantial rather than placeholders. The
purchase-order editor, raw-item form, request desk and Store overview together
contain several thousand lines of application logic.

### 2.2 Request and demand paths

There are several active paths into Store/Purchase:

1. `IntakeRequest` — the newer unified request door.
2. `MRF` — material request and stock issue/return.
3. `SpendRequest` — outside purchase or service, with Finance and budget
   approval.
4. `RawItemAddRequest` — legacy product/item registration requests.
5. `Requisition` — Store's purchase form preceding a PO.
6. Manufacturing-order raw-material requirements and stock adjustments.

The unified intake flow is the strongest future-facing boundary: it preserves
the employee's need and then lets Store decide whether to issue stock, buy a
shortfall or buy/procure the whole request.

### 2.3 Purchase-order duplication

Two different purchase-order applications are mounted and still reachable:

| System | Backend | Frontend | Model |
|---|---|---|---|
| Operational PO | `/api/cms/inventory/operations/purchase-orders` | `/store/dashboard/operations/purchase-order` | `Inventory/Operations/PurchaseOrder` |
| Worksheet/configuration PO | `/api/cms/store/purchase-orders` | `/store/dashboard/configurations/purchase-orders` | `Store/PurchaseOrder` |

Only the operational PO has the meaningful upstream `SpendRequest` connection,
receiving, returns, stock updates and payment tracking. The worksheet PO is a
separate truth with its own numbering, statuses and vendor snapshots.

### 2.4 Stock truth today

Current on-hand quantity is stored directly on `RawItem.quantity` and on
`RawItem.variants[].quantity`. Most movement history is embedded in
`RawItem.stockTransactions[]`.

Other collections also describe stock movement:

- `StockIssuance` records issue/return batches;
- `StockLedger` records compensating entries and edit history;
- PO deliveries are embedded under Purchase Orders;
- MRF issue/return data is stored on MRF lines;
- barcode records preserve some lot/provenance information.

The code currently updates raw-item quantities independently in purchase
receipt, PO return, MRF issue/return, manual stock adjustment and raw-item
variant endpoints. Only the stock-ledger correction route visibly uses a
database transaction. This is not a safe long-term stock engine.

### 2.5 Masters today

- `RawItem` owns item identity, SKU, category/custom category, unit/custom
  unit, variants, thresholds, supplier aliases and current stock.
- `StockItem` owns finished/stock products and BOM/raw-material links.
- `Warehouse` is a configuration record but stock is not held per warehouse,
  location, rack or bin.
- `Unit` stores conversions, while raw items and variants also store conversion
  data.
- `Vendor` is the operational supplier master. Accounting separately uses
  supplier ledgers and exposes a link field, but the operational and accounting
  responsibilities are not yet presented as one governed party lifecycle.

### 2.6 Existing cross-application connections to preserve

- Requests -> Intake/MRF/SpendRequest
- SpendRequest -> Budget commitment
- SpendRequest -> operational PO
- Operational PO receipt -> RawItem stock
- Voucher posting -> budget actual / commitment release
- Manufacturing order/BOM -> material requirements and issues
- Vendor -> purchase history and vendor aliases
- RawItem/barcode -> cutting and shop-floor traceability
- Store overview -> CEO/inventory visibility
- Accounting vendor ledger -> GST, bills, due dates and payments

---

## 3. Principal problems to solve

### 3.1 More than one truth for the same operation

Two POs, several request doors, embedded delivery records, an embedded stock
history and multiple supporting movement collections make it possible for two
screens to answer the same question differently.

**Decision:** the operational procurement chain becomes canonical. Legacy
documents remain readable and are migrated or retired deliberately; they are
never silently blended into the new chain.

### 3.2 Stock is a mutable balance before it is a ledger

`RawItem.quantity` is edited by several routes. An interrupted PO receipt can
update some raw items and fail before the PO is saved. Repeated requests are not
uniformly idempotent. A professional inventory system derives or maintains
balances from immutable movements written atomically.

**Decision:** one `InventoryMovement` journal becomes the authoritative stock
event history. Balances may be cached in `StockBalance`, but they must reconcile
to movements and may never be edited without producing a movement.

### 3.3 Warehouse is decorative

Warehouse records exist, but purchase receipts, balances, transfers and issues
do not consistently identify a warehouse/location. The system therefore cannot
answer where stock is, only how much the item record says exists globally.

**Decision:** every stock-affecting movement has source and/or destination
locations. A warehouse contains internal locations such as receiving,
inspection, usable stock, quarantine, returns and scrap.

### 3.4 Master data permits competing identities

Category plus custom category, unit plus custom unit, random SKU generation and
hard deletion create unstable references. Item variants are powerful but their
identity and conversion rules are distributed.

**Decision:** controlled category and UoM masters use stable IDs/codes. Items
and vendors are archived, not hard-deleted after use. Display snapshots remain
on transactions, while IDs remain authoritative.

### 3.5 Procurement starts too late

The operational PO can be typed directly. There is no canonical RFQ and
supplier-quotation comparison stage, no durable approval matrix, no PO
amendment document and no clear segregation between requesting, buying,
receiving and paying.

**Decision:** approved requisition, sourcing, PO approval, receipt and bill
matching are separate controlled decisions with separate actors.

### 3.6 Receiving is not a full goods-receipt process

Deliveries are embedded and acknowledged as simplified in the code. There is
no authoritative per-line GRN, inspection/quarantine/acceptance flow or
put-away. Surplus can be added to stock automatically without a separate
acceptance decision.

**Decision:** a Goods Receipt is its own document. Received, accepted,
rejected, quarantined and returned quantities are distinct. Only accepted and
put-away quantity becomes available stock.

### 3.7 Store records financial facts it does not own

Operational POs store payments and payment status. Accounting already owns
vouchers, supplier ledgers, bills, due dates and payment allocation. Two
editable payment records will eventually disagree.

**Decision:** Store reads bill/payment status from Accounting. It never records
a payment. Procurement owns expected terms and commercial commitments;
Accounting owns the posted payable and settlement.

### 3.8 Permissions are too broad

Most inventory routers use employee authentication, while frontend `RoleGate`
controls some buttons. Authentication is not authorisation. A professional
money-and-stock system must enforce permissions server-side.

**Decision:** introduce explicit permissions for master maintenance,
requisition approval, sourcing, PO approval, receipt, quality acceptance,
stock issue, stock adjustment, return and configuration.

### 3.9 Reporting is expensive and sometimes synthetic

Some endpoints load whole item sets or embedded transaction histories and then
filter/page in application memory. Vendor performance includes placeholder
metrics. Two Store overview pages consume the same endpoint and can drift.

**Decision:** one operational dashboard, queryable movement documents,
materialised/recomputed measures with declared sources, and no placeholder KPI
presented as measured performance.

---

## 4. Target domain model

### 4.1 Masters

#### Company and operating site

Every new operational record must carry `companyId`. Where multiple factory
sites matter, it also carries `siteId`. Existing global masters require an
explicit migration decision; absence of a company must never mean “visible to
all companies.”

#### Item

One item master with:

- stable item code/SKU;
- item type: raw material, consumable, packing, spare, service or finished
  good;
- controlled category ID;
- stock UoM and purchase UoM;
- conversion rules owned by a UoM category;
- variant dimensions and stable variant IDs;
- inventory tracking policy: none, quantity, lot/batch or serial;
- purchase, stock, quality and budget-control settings;
- active/archived lifecycle;
- duplicate detection and merge governance.

Services share procurement cataloguing where useful but never carry stock.

### 4.1a Item master decomposition (Chunk 0 addendum — PROPOSED)

> **Status: proposed, not adopted.** Nothing below has business, Finance or
> Manufacturing sign-off. Evidence: `docs/audits/store-purchase-baseline.md`
> §12 (field-by-field audit of what exists) and §13 (what was measured).
> Schema implementation is **Chunk 2**; the balance cutover is **Chunk 3**.

Today one document — `RawItem` — is simultaneously the catalogue entry, the
stock balance, the movement history, the supplier relationship, the
conversion table, the reorder policy and the budget mapping. Every stock
write is therefore an edit to the catalogue, and every catalogue edit can
move stock. The decomposition below separates them by owner and lifetime.

#### Item

Company-owned product or service identity. One record per thing the business
buys, makes, holds or sells.

| Field | Notes |
|---|---|
| `id` | **Stable after migration.** Whether it reuses a legacy `RawItem`/`StockItem` `_id` is a **Chunk 2 decision**, informed by the cross-collection collision measurement. It does **not** by itself preserve any existing reference — see §4.1c, which is authoritative: legacy references keep resolving because the legacy documents remain and adapters resolve them through the legacy-source mapping. |
| `code` | Governed SKU from a company sequence. Replaces generated `RAW-…-<rand3>`; existing codes are preserved as-is, never regenerated. |
| `name`, `description` | Identity and prose. |
| `itemType` | One of the eight types in §4.1b. Drives every policy default. |
| `categoryId` | → ItemCategory. Replaces `category` + `customCategory`. |
| `lifecycle` | `draft` → `active` → `blocked` → `archived`. Archive replaces today's hard delete. |
| `baseUomId` | The unit balances are kept in. An id, not a name. |
| `isStocked` / `isPurchasable` / `isSellable` / `isBomComponent` | Behaviour flags, defaulted from `itemType` and overridable with a reason. |
| `trackingPolicy` | none / quantity / lot / batch / serial / roll. |
| `taxClass`, `hsnCode` | Compliance classification. |
| `media[]`, `documents[]` | Images and specification files. |
| `attributes[]` | Structured values against the category's AttributeTemplate. |
| audit | created/updated by and when; every lifecycle change recorded. |

Item holds **no quantity, no price and no supplier**.

#### ItemVariant

A separately identifiable purchasable/stockable variation. Created only where
the difference is real — a colour that is ordered, received and counted
separately, not a description.

`id` (stable after migration; reuse of `variants[]._id` is Chunk 2's
decision, subject to §4.1c) · governed `sku`, unique ·
`optionValues[]` **keyed** (`{attribute, value}`, replacing today's
positional `combination[]`) · `barcodes[]` (GTIN/EAN and internal) ·
`lifecycle` · variant-specific physical properties (weight, dimensions,
shelf life) and any tracking override.

**No supplier prices. No stock quantities.** Both live elsewhere.

#### ItemUomConversion

`fromUomId` → `toUomId` · `factor` · `precision`/rounding rule ·
`packagingContext` (e.g. "carton of 12" vs a pure dimensional conversion) ·
`effectiveFrom`/`effectiveTo` · scope (global, category, item or variant).

Server-validated: no zero or negative factor, no self-conversion, no
contradictory duplicate for one pair and scope, and reciprocal definitions
must be exact inverses or one direction is derived rather than stored.
**No silent 1:1 fallback** — a missing conversion is an error the caller
must see, not a quantity quietly passed through unchanged (today's
`convertQuantity` returns the input, which is how a metre becomes a
centimetre without anybody noticing).

#### SupplierItem

The procurement relationship. One record per supplier per item/variant.

`supplierId` · `itemId` / `variantId` · supplier's own `code` and
`description` · `isPreferred` · `moq` · `orderMultiple` · `leadTimeDays` ·
`purchaseUomId` (with the conversion to base) · `lastAgreedPrice` +
`agreedAt` + source document, or a price-history collection where history
matters.

This is **procurement data**: what we expect to pay and how the supplier
identifies the thing. It is not an inventory balance and not an accounting
settlement — Accounting owns what was actually invoiced and paid. Replaces
`variants[].vendorNicknames[]`, which today mixes the supplier's code with a
price on the catalogue record.

#### InventoryPolicy

Per company/site, per item or variant: `isStocked` behaviour · negative-stock
policy (with the authority required to override) · lot/batch/serial/roll
tracking · shelf-life and expiry rules · inspection requirement on receipt ·
valuation-method linkage.

Policy is deliberately separate from Item so one catalogue entry can behave
differently at two sites without duplicating identity.

#### InventoryBalance

Per company/site/warehouse/location/item/variant/lot:
`onHand` · `reserved` · `available` · `quarantine` · `inTransit`.

**A projection of InventoryMovement, never user-editable.** No screen and no
API writes a balance directly. This is what replaces `RawItem.quantity` and
`variants[].quantity` as the answer to "how much is there" — see §5 for when
that switch happens.

#### InventoryMovement

The immutable stock-event source of truth, with reversal links and full
traceability. Specified in §4.2 and **implemented in Chunk 3**; named here
because Item and InventoryBalance are meaningless without it.

#### ReorderPolicy

Per location, per item or variant: `minimum` · `maximum` · `safetyStock` ·
`reorderPoint` · `reorderQuantity` · `preferredSupplierId` ·
`leadTimeAssumptionDays`.

Replaces `minStock`/`maxStock`, which today sit on both the item and every
variant, are global rather than per-location, and additionally drive a
display status.

#### ItemAccountingProfile

Accounting-owned mappings: inventory asset account · purchase/expense
account · COGS account · purchase price-variance account · tax treatment ·
budget-head/category attribution.

Two rules, both already true and both easy to break: **budget mapping never
determines a bookkeeping ledger**, and **no stock movement mutates budget
attribution**.

Status of what exists today, kept distinct because they are not the same
kind of thing:

| Layer | Status (verified against `HEAD`, not the working tree) |
|---|---|
| Item-wise budget attribution in the **committed Store baseline** | **NONE.** No item override, no category mapping, no request-line allocation exists in `HEAD` |
| `RawItem.budgetLedgerId` / `budgetLedgerName` / setter audit fields, `Acc_ItemCategoryBudget`, `services/itemBudgetHead.service.js`, request-line `budgetAllocation` on IntakeRequest/SpendRequest, and the related API and frontend work | **Paused, uncommitted** — present in the working tree, absent from `HEAD`. Not established Store production behaviour, and may not be deployed at all |
| `ItemAccountingProfile`, **company-scoped** | **Proposed** — nothing implements it |

The audit therefore treats the mapping collection as **optional**: its
absence is reported as `MAPPING_COLLECTION_ABSENT`, never as zero coverage.

**Company safety is a design requirement, not a detail.** `RawItem` carries
no company while ledgers and mappings are company-scoped, so a single global
item override cannot be every company's answer — an override on Company A's
ledger is not Company B's. The target `ItemAccountingProfile` is therefore
**per company**, and the migration must decide what a legacy global override
means for each company rather than copying it to all of them. A category
string alone never makes an item budget-attributable, and no production
coverage figure may be quoted without an authorised run against a real
database.

**Discovered risk, recorded for whoever resumes the paused work:** the paused
resolver (`services/itemBudgetHead.service.js` `headForItem()`) returns an
item override *before* validating that the target ledger belongs to the
company being resolved for. Chunk 0 documents it and changes nothing.

#### ItemCategory and AttributeTemplate

A controlled hierarchy with a stable id and code — **category names stop
being identity**. Each category carries its allowed attributes
(AttributeTemplate), default policies (tracking, inspection, valuation) and
its budget classification. Replaces the 20-value list hard-coded in
`routes/CMS_Routes/Inventory/Products/rawItems.js` plus the free-text
`customCategory` that bypasses it.

### 4.1b Item types (PROPOSED — needs Finance and Manufacturing approval)

Behaviour is defaulted from the type and overridable per item with a
recorded reason. "Y" is the default, not a hard rule, except where marked.

| Type | Stocked | Purchasable | Sellable | In BOM | Via GRN | Lot/serial | Inventory-valued | Budget-attributed |
|---|---|---|---|---|---|---|---|---|
| Raw material | Y | Y | N | Y | Y | by policy (roll/lot common) | Y | Y |
| Consumable | Y | Y | N | rarely | Y | usually none | Y | Y |
| Packaging material | Y | Y | N | Y | Y | usually none | Y | Y |
| Spare / MRO | Y | Y | N | N | Y | by policy | Y | Y |
| Trading good | Y | Y | Y | N | Y | by policy | Y | Y |
| Finished good | Y | rarely | Y | as output | on return only | by policy | Y | via production, not purchase |
| Service | **N (never)** | Y | Y | N | **N** | N | **N** | Y |
| Fixed asset | N (asset register, not stock) | Y | N | N | Y (receipt evidenced) | asset tag | **N — capitalised** | Y, as capex |

Decisions this table needs from owners, and the reason each is not
software's to make:

1. **Service and fixed asset must never hold stock.** Proposed as hard rules
   rather than defaults; needs Finance to confirm the fixed-asset boundary
   and who maintains the asset register.
2. **Fixed-asset capitalisation threshold** — below it, a purchase is an
   expense; above it, an asset. Finance owns the figure.
3. **Which types require inspection on receipt**, by type and by category.
4. **Which types are lot/roll/serial tracked** — Manufacturing owns this for
   fabric rolls; it drives whether the barcode lot record becomes a
   first-class lot.
5. **Whether finished goods may be purchased** (bought-in vs made) and how
   that interacts with the BOM.
6. **Valuation method per type**, agreed with Finance (plan §12.6).
7. **Whether services use the same requisition/RFQ/PO chain** (plan §12.8).

Until these are answered, the table is the audit's proposal and no chunk may
enforce it.

### 4.1c Item migration and compatibility boundaries (PROPOSED)

**No big-bang.** The sequence below is additive at every step, and the
authority of `RawItem.quantity` changes exactly once, at a gate that has to
be proved before it opens.

#### Legacy → target mapping

| Legacy | Target | Treatment |
|---|---|---|
| `RawItem._id` | `Item.legacySourceId` (source type `rawitem`) | **The document stays in `rawitems`.** An id alone does not make a reference resolve — see "Collection identity" below. |
| `RawItem.variants[]._id` | `ItemVariant.legacySourceId` | Same treatment, same reason. |
| `name`, `description`, `notes` | Item | Direct. |
| `sku` | `Item.code` | **Preserved verbatim.** New codes come from a governed sequence; existing ones are never regenerated — a printed sticker or a supplier's file still has to match. |
| `category` / `customCategory` | `ItemCategory.id` | Controlled values map directly; free-text values seed new categories where unambiguous. **Conflicts (both fields filled, disagreeing) go to a review queue** — measured today by the addendum. |
| `unit` / `customUnit` | `Item.baseUomId` | Name → id where the Unit master has the name. Anything unmatched is a review-queue row; **no unit is invented**. |
| `quantity`, `variants[].quantity` | `InventoryBalance` | Becomes an **opening balance movement** per item/variant at cutover, not a copied number. Until the Chunk 3 gate, it stays authoritative and is shadow-compared. |
| `stockTransactions[]` | `InventoryMovement` | Migrated as history with a `legacySource` marker. Rows whose `newQuantity` chain does not reconcile are migrated **as recorded** and flagged, never recomputed into agreement. |
| `minStock`/`maxStock` (item and variant) | `ReorderPolicy` | Direct, at the default location, once locations exist. |
| `variants[].vendorNicknames[]` | `SupplierItem` | Code, price and lead time split into identity vs commercial snapshot. Aliases with a missing vendor go to review. |
| `variants[].unitConversion(s)` | `ItemUomConversion` | Valid ones migrate scoped to the item; ones contradicting the master go to review with **both** figures shown. |
| `budgetLedgerId` + name | `ItemAccountingProfile` | Id migrates as authority; the name stays a display snapshot. |
| `status` | — | **Not migrated.** Derived from balance. |
| `StockItem` | `Item` (type = finished good) + BOM | Its variants become ItemVariants; `quantityOnHand` becomes an opening balance. Overlap candidates with RawItem are resolved by a human first. |
| `StockItem.variants[].rawItems[]` | BOM (Manufacturing-owned) | References become Item/ItemVariant ids; name/sku snapshots stay for historical readability. |
| Worksheet PO lines, Requisition lines | — | **Never matched to items.** They are free text and stay legacy history; guessing an item id here would invent provenance. |

#### Collection identity — why unchanged ids are NOT enough

An earlier draft of this section claimed that keeping `_id` values unchanged
was sufficient to preserve every reference. **That is wrong, and the error
matters enough to state plainly:**

- A Mongoose `ref` resolves an ObjectId against a **named collection**.
  `{ type: ObjectId, ref: "RawItem" }` populates from `rawitems`;
  `ref: "StockItem"` populates from `stockitems`. A new `Item` model
  populates from the new Item collection and **from nowhere else**.
- Copying an id into a third collection therefore changes nothing about what
  an existing `ref` resolves. Every PO line, MRF line, barcode, BOM line,
  ledger row and stock transaction in the database keeps pointing at
  `rawitems`/`stockitems` until the reference *itself* is migrated.
- An ObjectId is unique **per collection, not per database**. The same id can
  legitimately exist in two collections and name two different documents.
  The baseline reporter measures this
  (`itemMaster.crossCollectionIdCollisions`) precisely so the question is
  answered with data before anybody decides whether target ids may be reused.

**Non-negotiable compatibility requirement.** Whatever Chunk 2 chooses as its
implementation, it must satisfy all of the following. The mechanism is
proposed; the requirement is not:

1. **Legacy documents are retained.** `rawitems` and `stockitems` keep their
   documents for as long as any reader or any un-migrated reference exists.
   Nothing is deleted to make room for the new model.
2. **Every Item carries `legacySourceType` (`rawitem` \| `stockitem`) and
   `legacySourceId`,** and a **unique index on the pair** — one legacy
   document maps to exactly one Item, and the mapping is enforced by the
   database rather than by convention. The reverse lookup (legacy id → Item
   id) is a first-class, indexed query, not a scan.
3. **Adapters, not rewrites, during transition.** Readers that still hold a
   legacy reference resolve it through the mapping; they are not asked to
   know which model they are looking at.
4. **Writers and readers migrate in controlled batches**, each independently
   reversible, with reference-coverage measured after every batch: how many
   references of each kind now point at Item, how many still point at a
   legacy collection.
5. **Never assume an id copied into another collection changes what an
   existing `ref` resolves.** Any migration step whose correctness depends on
   that assumption is rejected.
6. **Cross-collection ObjectId collisions are detected before** deciding
   whether target ids may be reused at all. If a collision exists, id reuse
   is off the table and Items take fresh ids with the mapping as the only
   link.
7. **Historical snapshots are preserved regardless.** The name, SKU, unit and
   supplier text already written onto a PO line, MRF line or movement row
   stays exactly as it is. Reference migration never rewrites what a document
   said at the time.
8. **Legacy collections are retired only after a reference-coverage gate:**
   every reference type reconciled to 100% migrated (or explicitly accepted
   as permanently legacy, such as free-text worksheet-PO and requisition
   lines), signed off, and held through a full business cycle.

Whether Item is a new collection with fresh ids plus the mapping, or reuses
legacy ids where collisions permit, is **Chunk 2's decision** — and it is a
decision the collision measurement above informs.

#### Archive, merge and duplicate resolution

- **Archive replaces delete.** An item with any movement, PO line, MRF line,
  BOM reference or barcode may never be hard-deleted. Hard delete is removed
  from the API in Chunk 2.
- **Merge is a documented operation, not an edit**: the surviving item is
  named, the merged item is archived with a `mergedInto` pointer, and every
  reference keeps pointing at the archived id, which resolves through the
  pointer. History is never rewritten to pretend the merged item never
  existed.
- **Duplicate resolution is human.** The addendum produces candidates by
  exact normalised matching only; a merge needs a person to confirm it. No
  automatic merge, ever — a wrong merge silently rewrites what was bought.
- Items measured as apparently unreferenced are **archive candidates for
  review**, not garbage to collect: reference detection cannot see free-text
  references.

#### Preview, apply, rollback

Every migration step ships as three commands: **preview** (read-only, writes
a report of what would change, including every review-queue row), **apply**
(idempotent, resumable, writing a `migrationBatchId` on every touched
record) and **rollback** (reverses one batch by id). No step deletes a
legacy field in the same release that stops reading it — the field is
ignored first, removed a release later, so a rollback has something to
return to.

#### When `RawItem.quantity` stops being authoritative

One gate, in Chunk 3, and it is the only moment the answer to "how much is
there" changes hands:

1. Movements are **shadow-written** alongside every existing stock path;
   reads still come from `RawItem.quantity`.
2. A reconciliation report compares projected balances against legacy ones
   for every item and variant, and must show **zero unexplained differences
   across a full business cycle** (the existing baseline reporter is what
   measures the starting gap).
3. Reads switch to `InventoryBalance`. `RawItem.quantity` is retained,
   read-only, as a reconciliation witness.
4. Only after the switch has held do the legacy write paths (S1–S12) get
   removed, one at a time, each with its own release.

**Why the schema is not built here.** Chunk 0 is a baseline: the numbers this
addendum produces are what decide how large the review queues are, and
therefore whether the category and UoM masters can be seeded automatically
or need a data-cleaning project first. Building the schema before those
numbers exist would be choosing a migration strategy blind. Chunk 2 builds
Item, ItemVariant, ItemCategory, UoM and SupplierItem; Chunk 3 owns the
movement engine and the balance cutover above.

#### Supplier

Operational supplier identity owns contacts, addresses, purchasing status,
products, compliance documents and performance. It links explicitly to the
Accounting creditor ledger. GSTIN and legal-name conflicts are surfaced, not
resolved by loose name matching.

#### Warehouse and location

```text
Warehouse
  -> Receiving
  -> Inspection
  -> Usable stock
  -> Quarantine
  -> Returns
  -> Scrap
  -> configurable racks/bins
```

#### Procurement policy

Company settings own numbering sequences, approval thresholds, quotation
requirements, tolerance percentages, default receiving location, emergency
rules and whether particular categories require inspection.

### 4.2 Transaction documents

#### Purchase Requisition

The approved statement of demand. It may originate from an IntakeRequest,
manufacturing shortage, reorder rule or authorised manual entry. Each line
keeps source references, item/service identity, quantity, needed-by date,
department/project/cost centre, budget allocation and fulfilment status.

#### RFQ and Supplier Quotation

One requisition may generate enquiries to several suppliers. Supplier answers
store line price, tax, freight, lead time, validity, payment terms, MOQ and
attachments. Comparison is line-aware; the chosen supplier may differ per
line.

#### Purchase Order

The binding commercial order created from approved requisition/quotation
lines. Issued POs are immutable except through a recorded amendment. Each line
tracks ordered, received, accepted, rejected, returned, billed and cancelled
quantities.

#### Goods Receipt

A standalone GRN for one delivery event, supporting partial receipts and
multiple receipts per PO. It records supplier challan/invoice references,
warehouse receiving location, line quantities, lot/roll/serial information,
receiver and timestamps.

#### Quality Inspection

Optional by item/category policy. It records accepted, rejected and quarantine
quantities with reason/evidence. Acceptance triggers put-away; rejection feeds
a supplier return or replacement workflow.

#### Inventory Movement

An immutable movement with:

- company, site, item and variant;
- quantity in canonical stock UoM;
- source and destination locations;
- movement type;
- source document type/id/line;
- lot/batch/serial where applicable;
- actor, event time and idempotency key;
- reversal link rather than destructive editing.

#### Stock Balance and Reservation

Balance is per item/variant/location/lot. Reservation separates:

- on hand;
- reserved;
- available;
- incoming;
- outgoing;
- quarantine.

Manufacturing and approved MRFs reserve before issue where the business needs
availability guarantees.

#### Supplier Return

References receipt/inspection lines and creates reverse movements. Replacement
receipts remain linked to the return.

#### Accounting match

A supplier bill remains an Accounting voucher. A link layer records the match
between PO, receipt and voucher lines, plus quantity/price/tax variances. Store
sees read-only bill and payment state.

---

## 5. Target lifecycle and controls

### 5.1 Demand to requisition

1. Employee/manufacturing raises demand.
2. Department approval confirms necessity and budget ownership.
3. Store fulfils available stock or records the purchasable shortfall.
4. Purchasable lines become one canonical requisition.
5. Duplicate/open-demand and available/incoming-stock checks warn before a new
   buy is started.

### 5.2 Source to order

1. Buyer selects eligible suppliers.
2. RFQs are issued and quotations captured.
3. Comparison shows total landed commercial position, not price alone.
4. Buyer recommends; authorised approver decides according to threshold.
5. Approved lines create an issued PO with a stable sequence.
6. Any later change is a versioned amendment with approval where required.

Emergency purchasing remains possible, but requires reason, actor, threshold
authority and retrospective review. “Emergency” must never mean “untracked.”

### 5.3 Receive to stock

1. Receiver records a GRN against outstanding PO lines.
2. Duplicate supplier invoice/challan and repeated submission checks run.
3. Quantity tolerances are enforced; surplus requires explicit acceptance.
4. Goods enter Receiving or Inspection, not usable stock immediately.
5. Accepted quantities are put away into a location.
6. Rejected quantities enter quarantine/return.
7. All steps write atomic inventory movements and update cached balances in
   the same transaction.

### 5.4 Bill to payment

1. Accounting records/imports the supplier bill.
2. The system proposes a PO/GRN match using explicit references.
3. Quantity, rate, tax and freight variances are shown.
4. Within-tolerance match can proceed under policy; exceptions require review.
5. Accounting posts the payable and later payment.
6. Store sees matched/billed/paid status read-only.

### 5.5 Issue, consume, transfer and count

- MRF/manufacturing reservation -> pick -> issue -> consumption/return.
- Warehouse transfer uses an outbound and inbound location movement under one
  transfer document.
- Stock adjustment requires reason and permission.
- Cycle count freezes/counts a defined scope and posts approved variances as
  movements.
- No screen directly edits on-hand quantity.

---

## 6. Integration boundaries

| Application | Owns | Store/Purchase consumes or publishes |
|---|---|---|
| Requests | Employee need, approval trail | Store classifies fulfilment and returns progress |
| Manufacturing | MO/BOM/demand, consumption context | Reservations, shortages, issues and returns |
| Budget | Allocation, commitment and actual rules | Requisition/PO allocation and exception status |
| Accounting | Supplier ledger, voucher, GST, payable, payment | PO/GRN match references and read-only settlement state |
| Store/Purchase | Item, procurement, receipt, stock/location movements | Operational source documents and availability |
| CEO | Cross-company oversight | Read-only KPIs derived from authoritative transactions |
| Barcode/Cutting | Physical lot/roll identity and use | Lot provenance, location and remaining quantity |

Integration is by stable IDs and explicit source links. Names remain snapshots
for historical readability, never substitutes for links.

---

## 7. Non-negotiable invariants

1. One canonical PO model accepts new operational writes.
2. Every record is company-scoped; empty scope never widens access.
3. An issued PO cannot be edited in place.
4. A receipt cannot exceed policy tolerance without an authorised exception.
5. Accepted stock changes only through inventory movements.
6. A repeated API submission cannot receive, issue or return stock twice.
7. Negative stock is blocked unless an explicit company policy and authorised
   exception allow it.
8. Quantity conversion is server-owned and stored with its basis.
9. Historical source names/rates remain snapshots; current master IDs remain
   links.
10. Used items, vendors, locations and documents are archived/cancelled, not
    hard-deleted.
11. Store never records supplier payments.
12. Accounting posting remains Accounting's responsibility.
13. Budget attribution never changes bookkeeping ledgers.
14. Every override, reversal, adjustment and emergency action has actor, time
    and reason.

---

## 8. Frontend product architecture

The professionalisation is a whole-product redesign. Backend correctness and
frontend clarity ship together in each chunk. A correct model hidden behind
legacy names, duplicated navigation and generic CRUD pages is not a completed
professional application.

### 8.1 Application name and boundary

The application is named **Store & Purchase** in the launcher and shell. This
describes the two connected responsibilities without pretending they are the
same job:

- **Store** owns stock, locations, receiving, put-away, reservations, issues,
  transfers, returns and counts.
- **Purchase** owns requisitions, sourcing, quotations, orders and supplier
  follow-up.

Finance approval and payment remain in Accounting. Employee demand remains in
Requests. Manufacturing demand remains in Manufacturing.

### 8.2 Target navigation

Navigation is organised by user job and document lifecycle, not by model name
or implementation folder:

```text
Overview

Purchase
  Requisitions
  Requests for quotation
  Supplier quotations
  Purchase orders
  Supplier returns

Receive
  Expected deliveries
  Goods receipts
  Inspections
  Put-away

Inventory
  Stock on hand
  Reservations
  Transfers
  Issues & returns
  Cycle counts
  Movement ledger

Masters
  Items
  Categories
  Units of measure
  Warehouses & locations
  Suppliers

Reports
  Purchase analysis
  Inventory valuation
  Stock ageing
  Supplier performance
  Exceptions & reconciliation

Settings
  Numbering
  Approval policies
  Receipt tolerances
  Quality policies
  Roles & permissions
```

Items such as machines, manufacturing operations, worker worksheet templates
and assigned teams do not automatically belong in Store & Purchase merely
because they currently sit in its configuration menu. Chunk 0 must name their
real owning application before the navigation is changed.

### 8.3 Canonical vocabulary

The UI must use one business term for one concept. Internal legacy field names
may remain temporarily, but they do not leak into user-facing copy.

| Use in the product | Meaning | Avoid |
|---|---|---|
| Request | What an employee needs | order request when no order exists |
| Material request | Request for stock already held or expected from Store | MRF as unexplained primary wording |
| Purchase requisition | Approved internal demand to buy | purchase form, indent and requisition used interchangeably |
| Request for quotation | Enquiry sent to suppliers | quote request / enquiry without distinction |
| Supplier quotation | Supplier's commercial response | quote where the actor is ambiguous |
| Purchase order | Approved order sent to a supplier | PO sheet as a second operational document |
| Expected delivery | PO quantity still due | pending PO when the user means goods due |
| Goods receipt | One delivery received against a PO | delivery and GRN used as competing records |
| Inspection | Acceptance decision on received goods | QC when no quality decision was recorded |
| Put-away | Move accepted goods into usable stock | receive when stock is still in inspection |
| Stock on hand | Physical quantity present | available stock |
| Reserved | On-hand quantity promised to demand | committed, which Budget already uses for money |
| Available | On hand minus reserved | balance without qualification |
| Supplier return | Goods sent back to supplier | return request without direction |
| Movement ledger | Immutable stock event history | editable stock history |
| Adjustment | Authorised variance movement with reason | direct quantity edit |

Abbreviations such as PO, RFQ, GRN, MRF and UoM may appear after their full
term has been established, but they must not be the only explanation offered
to a new user.

### 8.4 Status language

Statuses describe business state and next responsibility. The UI must not show
raw enum strings such as `PARTIALLY_RECEIVED` or vague words such as “Pending”
without saying pending what or whom.

Examples:

| Document | State shown | Supporting next-action text |
|---|---|---|
| Requisition | Waiting for approval | Finance approver must review |
| RFQ | Waiting for supplier | Response due 12 Sep |
| Purchase order | Ready to issue | Approved; buyer must send to supplier |
| Purchase order | Partially received | 320 m still due |
| Goods receipt | In inspection | 4 lines awaiting acceptance |
| Inspection | Partly rejected | Create supplier return for 18 m |
| Transfer | In transit | Destination Store must receive |
| Cycle count | Variance review | Store manager must approve adjustment |

Colour reinforces meaning but never carries it alone. Expense/budget severity,
procurement progress, stock health and quality exceptions keep distinct visual
vocabularies.

### 8.5 Page structure

Every document workspace follows the same anatomy:

1. **Slab header** — document number/name, state, supplier/requester and the
   primary next action.
2. **Context strip** — source request, department/project, dates, warehouse,
   buyer/owner and budget state.
3. **Line table** — the authoritative quantities and commercial/stock state,
   with exceptions on the affected line.
4. **Progress rail** — request -> approval -> sourcing -> order -> receipt ->
   bill, with completed and waiting actors.
5. **Evidence and communication** — private quotations, challans, invoices,
   inspection evidence and notes.
6. **History** — immutable decisions, amendments and movements with actor,
   time and reason.

List pages are operational queues. They lead with “what needs attention,” not
with decorative KPIs. Registers still support search, saved filters, columns,
export and bulk action where the underlying permission allows it.

### 8.6 Role-specific workspaces

The same documents are presented through different work queues:

- **Requester:** my requests, what is waiting, what was issued/ordered.
- **Department approver:** need and budget decision.
- **Buyer:** requisitions to source, quotations due, POs to issue, late orders.
- **Receiver:** expected deliveries and GRNs to record.
- **Inspector:** receipts awaiting acceptance and quarantine action.
- **Storekeeper:** put-away, reservations, picks, issues, transfers and counts.
- **Purchase/Store manager:** approvals, exceptions, workloads and performance.
- **Finance:** budget/commitment and bill-match exceptions through Accounting,
  with linked procurement context.

Permissions change available actions, not the truth shown about a document.

### 8.7 Responsive and shop-floor interaction

- Desktop supports dense line work, comparison and multi-column review.
- Phone/scanner layouts optimise receiving, put-away, picking, issue, transfer
  and cycle count as one-step tasks.
- Barcode scanning fills verified item/variant/lot/location identity; it never
  bypasses quantity or permission validation.
- Tables that cannot collapse remain horizontally scrollable with identity and
  action columns kept visible.
- Drafts warn before navigation discards work.
- Dialogs/drawers trap focus, close on Escape and restore focus.
- Error copy states what failed, what was preserved and what the user can do.

### 8.8 Frontend engineering rules

- One canonical route per workspace; old routes redirect or become labelled
  read-only legacy history.
- Shared API client and authentication transport; no new direct-fetch pattern.
- Server is authoritative for permissions, amounts, transitions and identity.
- Shared components for document header, state chip, line exceptions, progress
  rail, attachments and history.
- URL-backed filters and selected tabs so queues are linkable and restorable.
- Loading, empty, error, forbidden and legacy states are designed explicitly.
- No placeholder metric, invented status or client-only approval rule.
- Frontend completion requires build checks plus authenticated desktop and
  mobile visual verification of every changed workflow.

---

## 9. Implementation roadmap

Each chunk must be independently testable and leave the current application
usable. No chunk may silently migrate or delete live data.

### Chunk 0 — Baseline, vocabulary and safety harness

**Purpose:** freeze understanding before changing authorities.

- Inventory all active frontend routes, API routes, models and document counts.
- Produce a screen inventory naming every route, audience, user job, API,
  duplicate surface, unreachable page and broken/dead navigation target.
- Approve the vocabulary, target navigation and ownership of configuration
  pages before renaming or moving routes.
- Measure which PO system, request doors and stock-update paths are used.
- Define canonical status and document vocabulary.
- Add read-only reconciliation reports:
  - RawItem balance versus embedded movements;
  - PO received totals versus line receipts;
  - MRF issued/returned totals versus stock movements;
  - orphan item/vendor/document references;
  - duplicate SKU, category, vendor and PO-number candidates.
- Add end-to-end tests for the current request -> Store -> Finance -> PO ->
  receipt path before altering it.
- Record migration identifiers on all later writes from day one.

- Audit the item master field by field (identity, inventory, procurement,
  accounting, budget, manufacturing and display data; authoritative vs
  snapshot vs derived vs legacy) and propose the decomposition in §4.1a,
  the item types in §4.1b and the migration boundaries in §4.1c.

**Done when:** current data quality and every active write path are quantified,
the item master's identity, hygiene and reference integrity are measured, and
the existing critical chain has a regression harness.

### Chunk 1 — Tenant boundary, permissions, audit and sequences

**Purpose:** secure the foundation before increasing automation.

- Add/enforce `companyId` and optional `siteId` on new Store/Purchase records.
- Define server-side permissions and an approval matrix.
- Introduce atomic document-number sequences per company/document type/FY.
- Add immutable action history and request idempotency keys.
- Define archive/cancel rules; remove hard-delete from used records.
- Keep legacy global data readable under an explicit legacy scope.

**Done when:** cross-company access is impossible, critical writes are
permission-tested and duplicate submissions cannot create duplicate documents.

**Partially implemented — Chunk 1A (2026-09-02): foundation and operational-PO
pilot only. Chunk 1 is NOT complete.** The MRF, requisition, stock
issuance/adjustment, returns, barcode, delivery, raw-item and worksheet-PO
routers remain unscoped and unpermissioned, and `/api/cms/units` remains
unauthenticated — so cross-company access is still possible today. Chunk 2 is
blocked until they are converted. Architecture record:
`docs/decisions/store-purchase-tenancy-permissions.md`. Facts this
implementation established, which later chunks inherit:

- **Company membership did not exist anywhere in the CMS identity chain** —
  not on `Employee`, `DeptUser`, `DepartmentRole` or the JWT. `SpCompanyMembership`
  is the authoritative record; a single-company deployment resolves without one,
  and anything else fails closed.
- Capabilities are resolved from the **existing** department-grant vocabulary
  (`DepartmentRole`, viewer<editor<approver<owner) rather than a new role system.
- **Numbering uniqueness must be scoped to the tenant.** Per-company sequences
  legitimately repeat a number across companies, so a global unique index on a
  document number makes a second company unable to raise its first document.
  `PurchaseOrder` now carries a compound `{companyId, poNumber}` index; the
  legacy global `poNumber_1` index must be dropped by an authorised migration.
- Applied end-to-end to the operational Purchase Order router only. The MRF,
  requisition, stock-adjustment, returns, barcode and raw-item routers remain
  as Chunk 0 found them, as does the unauthenticated `/api/cms/units` mount.

### Chunk 2 — Professional master data

**Purpose:** make item, UoM, category, vendor and warehouse identity
reliable, by implementing the decomposition specified in §4.1a.

Scope is now explicit (Chunk 0's Item Master addendum did the analysis;
`docs/audits/store-purchase-baseline.md` §12–§13 is the evidence):

- **Item** with governed code, `itemType` (§4.1b), lifecycle
  (draft/active/blocked/archived), `baseUomId`, behaviour flags and
  structured attributes. Existing SKUs are preserved; whether a target Item
  reuses a legacy `_id` is a Chunk 2 decision governed by §4.1c, and legacy
  references remain compatible through retained documents and adapters rather
  than through ObjectId equality alone.
- **ItemVariant** with a unique governed SKU, **keyed** option values
  replacing positional `combination[]`, barcodes and its own lifecycle.
- **ItemCategory** hierarchy with stable ids/codes and **AttributeTemplate**;
  retire the hard-coded 20-value list and `customCategory`.
- **UoM master + ItemUomConversion**: one conversion truth, server-validated,
  **no silent 1:1 fallback**; retire `customUnit` and the two variant-level
  conversion fields.
- **SupplierItem**: supplier code, preference, MOQ, order multiple, lead
  time, purchase UoM and last-agreed price. It must absorb **all three**
  present layers — `primaryVendor`, `alternateVendors[]` and
  `variants[].vendorNicknames[]` — with preference expressed as a flag
  rather than as which field the reference happened to sit in.
- **InventoryPolicy** and **ReorderPolicy** records (per site/location where
  locations exist), taking over `minStock`/`maxStock` and tracking rules.
- **ItemAccountingProfile**, **company-scoped**, holding the accounting
  mappings and budget attribution. It must resolve what a legacy *global*
  item override means per company — a Chunk 0 finding: the paused override
  field is unscoped while the ledger it points at belongs to one company,
  and the paused resolver returns the override before checking that owner.
- **One barcode namespace** on ItemVariant, reconciling
  `StockItem.barcode`, `StockItem.variants[].barcode` and RawItem's absence
  of any product barcode — while keeping **printed lot instances** (the
  `barcodes` collection, identified by document `_id`) as the separate
  concept they are.
- **Archive/merge**: remove hard delete from items and vendors; merge writes
  a `mergedInto` pointer and keeps every reference resolving.
- **Warehouse + nested location model.**
- **Supplier-to-accounting-ledger link** with GSTIN/legal-name conflict checks.
- **Review queues**, sized by the Chunk 0 measurements: category and unit
  conflicts, unmatched unit names, contradictory conversions, supplier
  aliases with a missing vendor, RawItem↔StockItem overlap candidates,
  uncategorised items, and default `-var` variant SKUs.
- **StockItem folded into the same governed Item** (type = finished good),
  with its own identity hygiene resolved: `reference` collisions, name and
  alias collisions, barcode duplicates at item and variant level,
  `productType`/`trackInventory` contradictions, services carrying
  inventory balances, and `totalQuantityOnHand` vs variant totals.
- **The collection-identity compatibility requirements in §4.1c are
  mandatory**: legacy documents retained, `legacySourceType` +
  `legacySourceId` with a unique index, adapters during transition, batched
  reader/writer migration, collision detection before any id reuse, snapshots
  preserved, and legacy retirement only after the reference-coverage gate.
- **Migration preview/apply/rollback** per §4.1c, additive throughout.

**Explicitly NOT in Chunk 2:** the movement engine, balance cutover, and any
change to what `RawItem.quantity` means — all Chunk 3.

**Done when:**

- new transactions reference stable item, variant, category, UoM, supplier
  and location identities with no free-text fallback posing as a link;
- no API can hard-delete an item or vendor that anything references;
- every conversion used by a stock or purchase path resolves through one
  validated table, and an unresolvable conversion fails loudly;
- the Chunk 0 measurements re-run against migrated data show every review
  queue either empty or explicitly accepted by an owner, for **both**
  catalogues;
- every legacy reference either resolves through the mapping or is explicitly
  accepted as permanently legacy, and the reference-coverage report says
  which for every reference type;
- `RawItem.quantity` is untouched and still authoritative — proving the
  master-data work changed no balance.

### Chunk 3 — Canonical inventory movement engine

**Purpose:** establish one stock truth before rebuilding receiving and issues.

- Add InventoryMovement, StockBalance and StockReservation.
- Central movement service with Mongo transaction, idempotency and reversal.
- Support receipt, put-away, issue, return, transfer, adjustment, consumption,
  supplier return and opening balance movement types.
- Shadow-write from existing stock paths without yet changing reads.
- Reconciliation proves shadow balances equal current balances.
- Cut reads to the new balance only after a defined zero-difference gate.

**Done when:** no new stock-changing feature needs to edit RawItem quantity
directly and the new journal reconciles to the legacy source.

### Chunk 4 — Unified demand and purchase requisition

**Purpose:** give every purchase a governed origin.

- Make unified Intake the preferred employee door.
- Convert purchasable shortfalls into canonical Purchase Requisition lines.
- Carry requester, department, project/cost centre, item/service, needed-by,
  source MRF/MO and budget allocation per line.
- Catalogue matching queue for physical free-text items.
- Services remain non-stock lines.
- Duplicate-demand and incoming-stock warnings.
- Preserve legacy MRF and direct spend reads through adapters; restrict new
  bypass writes according to policy.

**Done when:** every new ordinary purchase can answer who requested it, why,
who approved it and which exact line is being sourced.

### Chunk 5 — Sourcing, RFQ and quotation comparison

**Purpose:** professionalise supplier selection before the PO.

- RFQ creation from requisition lines.
- Multi-supplier issue/response tracking and private attachments.
- Line-level quotation terms: rate, GST, freight, other charges, MOQ, lead time,
  validity and payment terms.
- Normalised comparison using server-owned totals and UoM conversions.
- Recommendation and approval trail.
- Supplier eligibility/blacklist/compliance checks.

**Done when:** the selected supplier and commercial terms are evidenced rather
than typed directly into a PO without provenance.

### Chunk 6 — Canonical Purchase Order and approval

**Purpose:** replace the two-PO ambiguity with one controlled order.

- Extend/rebuild the operational PO as the only canonical model.
- Generate from approved requisition/quotation lines.
- Approval thresholds and segregation of duties.
- Draft -> submitted -> approved -> issued -> partially received -> received ->
  closed/cancelled state machine.
- Versioned amendments and supplier acknowledgement.
- Server-derived amounts, tax/charge snapshots and expected dates.
- Convert the worksheet PO screen into a template/print configuration or make
  it read-only legacy history; stop new operational writes to its model.

**Done when:** every new PO is unique, approved, source-linked, immutable after
issue and visible through one register.

### Chunk 7 — GRN, inspection, put-away and supplier returns

**Purpose:** make receipt a controlled inventory event.

- Standalone GoodsReceipt and per-line receipt records.
- Partial receipt and delivery/challan/invoice duplicate checks.
- Quantity tolerance and authorised surplus handling.
- Lot/roll/serial capture according to item policy.
- Quality inspection, quarantine, rejection and evidence.
- Put-away to warehouse location.
- Supplier return/replacement tied to original receipt.
- Atomic movements through Chunk 3's service.

**Done when:** ordered, received, accepted, available, rejected and returned
quantities reconcile per PO line and per location.

### Chunk 8 — Accounting, budget and three-way match

**Purpose:** connect procurement to financial control without duplicating it.

- Complete item-wise budget allocations and multi-allocation commitments.
- Carry allocation identity through requisition and PO lines.
- Match supplier purchase voucher to PO and accepted GRN quantities.
- Show price, quantity, GST and charge variance with tolerance policy.
- Release/settle commitments by matched allocation.
- Remove editable PO payment records; display Accounting bill/payment state.
- Queue manual/Tally bills with no PO as explicit procurement/budget
  exceptions rather than guessing.

**Done when:** Procurement, Budget and Accounting agree on the source and
amount while retaining separate responsibilities.

### Chunk 9 — Reservations, picking, issues, transfers and counts

**Purpose:** professionalise internal material movement.

- Reserve stock for approved MRF/manufacturing demand.
- Pick/issue from explicit locations and lots.
- Partial issue, substitution and backorder rules.
- Return unused material to a location.
- Warehouse transfer documents.
- Cycle count and approved variance posting.
- Negative-stock policy and exception queue.

**Done when:** on-hand, reserved, available and consumed stock are distinct and
traceable to demand and location.

### Chunk 10 — Workspaces, alerts and reporting

**Purpose:** turn reliable transactions into day-to-day control.

- One Store home route; retire the duplicate dashboard.
- Apply the target navigation, canonical vocabulary, document-page anatomy and
  role-specific workspaces defined in Section 8.
- Role-specific work queues: requester, buyer, approver, receiver, inspector,
  storekeeper and manager.
- Alerts for shortages, overdue requisitions/RFQs/POs, late suppliers,
  inspection holds, unmatched bills and unreconciled stock.
- Inventory valuation method chosen with Finance and derived from accepted
  receipts/movements.
- Supplier performance from measured delivery, quality and commercial data;
  remove placeholder metrics.
- Reports use database pagination/aggregation, not full-array in-memory paging.
- Mobile/scanner-focused receipt, put-away, pick and count experiences.

**Done when:** each user opens the app to actionable work and every KPI links
to the transactions that produce it.

### Chunk 11 — Migration and legacy retirement

**Purpose:** remove ambiguity only after the replacement proves itself.

- Classify legacy documents by source system and migration readiness.
- Backfill explicit links where evidence exists; preserve unresolved records as
  legacy, never guessed.
- Establish opening balances by item/location/lot and reconcile them.
- Run shadow then parallel operation with signed reconciliation.
- Disable legacy PO, direct-quantity and duplicate dashboard writes.
- Preserve read-only history and redirect users to canonical routes.
- Delete no historical records as part of cutover.

**Done when:** one write path remains for each concept, live balances reconcile
and legacy history is still readable.

---

## 10. Delivery rules for every chunk

Each implementation brief must include:

- exact in-scope models, routes and screens;
- old and new source-of-truth declaration;
- additive compatibility behaviour;
- state-transition table;
- permission matrix;
- company-isolation tests;
- idempotency/concurrency tests for money or stock writes;
- end-to-end integration test across affected apps;
- migration preview, apply and rollback where data changes;
- observable reconciliation/exception report;
- explicit out-of-scope list.
- frontend routes/components/copy affected and their target user job;
- desktop and mobile acceptance scenarios for every changed workflow.

No chunk is complete on frontend compilation alone. Stock and money changes
require HTTP-level tests against a transaction-capable MongoDB setup.

---

## 11. Required test matrix

### Master data

- duplicate item/SKU/category/vendor identities;
- archive versus delete;
- unit conversion direction and precision;
- cross-company reference refusal;
- service versus stock-item behaviour.

### Procurement

- unauthorised transitions;
- threshold and four-eyes approval;
- repeated submit/approve/issue calls;
- partial line sourcing and multiple suppliers;
- PO amendments, cancellation and closure;
- server recomputation of totals.

### Inventory

- simultaneous receipt/issue on the same item/location;
- partial receipt, over-receipt and duplicate GRN;
- inspection acceptance/rejection/quarantine;
- lot/variant/UoM conversion;
- reservation and available-stock arithmetic;
- reversal without history deletion;
- movement/balance reconciliation.

### Integrations

- Intake/MRF -> requisition;
- manufacturing shortage -> requisition;
- requisition -> RFQ -> PO;
- PO -> GRN -> stock;
- PO/GRN -> purchase voucher match;
- budget commitment -> allocation actual;
- supplier return -> stock reversal and accounting visibility;
- legacy records remain readable.

---

## 12. Decisions requiring business owners

The software cannot decide these safely:

1. Which purchases require requisition and how emergency purchasing is
   reviewed.
2. Approval thresholds and who may request, buy, approve, receive, inspect,
   adjust and return.
3. Warehouse/location structure and whether negative stock is ever allowed.
4. Which categories require quotation comparison and how many quotations.
5. Receipt tolerance and quality-inspection policy by item category.
6. Inventory valuation method agreed with Finance.
7. Lot/roll/serial tracking scope.
8. Whether services use the same requisition/RFQ/PO chain without inventory.
9. Vendor-master ownership and verification responsibility.
10. The cutover date after which legacy PO/direct purchase paths become
    read-only.

---

## 13. Recommended starting point

Start with **Chunk 0**, not master-data edits or a new PO screen. The current
system contains real stock and connected approvals. Before changing its source
of truth, quantify the active paths, pin the present lifecycle with tests and
produce reconciliation reports. That evidence determines what can be migrated,
what must remain legacy and where the first safe cutover boundary lies.
