# Store & Purchase — Baseline System Inventory (Chunk 0)

> **Status:** Chunk 0 deliverables complete after a correction pass
> (audited 2026-09-01, corrected same day). Working trees of
> `/Users/risheeray/grav-cms-backend` (branch `risheecmsbackend`) and
> `/Users/risheeray/grav-cms` (branch `risheecmsfrontend`).
>
> **Purpose:** freeze understanding of the CURRENT Store/Purchase system —
> both repositories — before any source of truth changes. This document
> records what exists, what is used, what is duplicated and what is unsafe.
> It changes nothing and recommends deferring every fix to its planned chunk.
>
> **Companions:**
> - `docs/decisions/store-purchase-vocabulary-navigation.md` — vocabulary and
>   navigation decision record (Deliverable 3). **PROPOSED, not adopted** —
>   no business owner has approved any mapping in it.
> - `scripts/store-purchase-baseline-audit.js` — the read-only usage/data
>   baseline reporter (Deliverable 2; see §7).
> - `test/store-purchase/` + `test/requests/` — the regression harness
>   (Deliverable 4; see §8).

---

## 1. Frontend inventory (`grav-cms`)

### 1.0 Global facts that apply to every Store screen

- Every route under `/store/dashboard/**` is wrapped by
  `app/store/dashboard/layout.js` → `components/Store_DashboardLayout.js`
  (FrostShell, `guardSlug="store"`). Session/department is server-verified by
  the shell; there is **no per-page auth**.
- **No Store page uses the shared API clients** (`lib/api.js` / `utils/api.js`).
  Every page declares its own `API_URL = NEXT_PUBLIC_API_URL || localhost:5000`
  and direct-`fetch`es with `credentials:"include"`. Partial wrappers (still
  direct fetch): `components/mrf/intakeApi.js`, `components/mrf/spendApi.js`,
  `lib/storeSettings.js`, and a local `apiFetch` in
  `registered-operations/page.js`.
- The only client permission mechanism is `components/access/RoleGate.js`
  (40 files). Its default "open" mode passes any signed-in user with **no**
  department role; only an explicitly lower role hides a control. All gates
  are advisory UX — the server enforces nothing beyond a valid JWT on these
  routes (see §2).
- MRF TL-approval happens in the Cowork app (separate repo); the Store
  screens deliberately have no approve button (backend returns 403 on the
  retired store-approve endpoints).
- Subtree size: **56 page.js routes, ~38,700 lines**. Desktop-first
  throughout (tables in `overflow-x-auto`, hard minimum widths up to
  1160px). The two genuinely mobile-shaped surfaces are the `item-info` QR
  landing page and the barcode sticker print flow.

### 1.1 Navigation map (from `Store_DashboardLayout.js`)

Nav groups: **Overview**, **Requests**, **Stock**, **Issues**, **Reports**,
**Configurations** — 18 nav leaves for 56 routes; the rest are drill-downs or
orphans.

| Route | Nav label | Main file (lines) | User job | Backend door(s) | State | True owner |
|---|---|---|---|---|---|---|
| `/store/dashboard/overview` | Overview | `overview/page.js` (1,395) | KPI dashboard, low stock, quick actions | `GET /api/cms/inventory/overview` | Active; 3 dead links to `stock-items` | Store |
| `/store/dashboard` | *(not in nav)* | `page.js` (488) | Second, older dashboard ("Inventory Management") | same overview endpoint | **Legacy duplicate** of `/overview`; own stale mini-nav; 2 dead links | Store (retire) |
| `/store/dashboard/order-requests` | Material Requests | `order-requests/page.js` (872) | Unified desk merging **5 queues**: MOs, MRFs, legacy product requests, intake "To Fulfil", classified spend requests | `/api/cms/store/order-requests`, `/api/cms/inventory/mrf`(+`/product-requests`,`/bypass`), `/api/requests/intake/fulfilment`, `/api/requests/spend/to-send`+`/from-fulfilment` | Active — the central screen | Requests |
| `…/order-requests/[id]` | drill-down | `[id]/page.js` (1,013) | **Manufacturing order** detail + store approval of work orders + issue/return | `/api/cms/store/order-requests/*`, `/api/cms/store/work-orders/*`, `/api/cms/inventory/stock-adjustments/issue` | Active | **Manufacturing** |
| `…/order-requests/mrf/[id]` | drill-down | `mrf/[id]/page.js` (**3,569 — largest file in the app**) | One MRF end-to-end: stock check, match/register/reject, issue, return, fulfilment decision, purchase form, chat | 10+ endpoints on `/api/cms/inventory/mrf/**` + `/api/cms/inventory/requisitions` | Active — combines ≥6 jobs | Requests+Store+Purchase |
| `…/order-requests/intake/[id]` | drill-down | (106) + `Classify.js` | Intake fulfilment/classification decision | `/api/requests/intake/fulfilment` | Active | Requests |
| `…/order-requests/quote/[id]`, `requote/[id]` | drill-down | (286 / 88) | View / re-quote a classified spend request | `/api/requests/spend/**` | Active | Requests/Purchase |
| `/store/dashboard/operations/purchase-order` | Purchase Orders | `page.js` (397) | **Operational PO register** (money stats, receive/edit/delete) | `/api/cms/inventory/operations/purchase-orders` | Active | Purchase |
| `…/purchase-order/[id]` | drill-down | (1,656) | PO detail: overview / items / **payments** tabs, status changes | same + `/payment`, `/status` | Active — oversized | Purchase |
| `…/purchase-order/[id]/receive` | drill-down | (765) | Goods receipt + barcode printing + returns | `/receive`, `/returns`, unit endpoints | Active | Purchase/Store |
| `…/purchase-order/new-edit-purchase-order(/[id])` | drill-down | `NewEditPurchaseOrderClient.js` (**2,872**) | PO authoring incl. multi-vendor blocks, inline variant & vendor-alias creation | PO + raw-items + vendor-nickname endpoints | Active — combines 3 jobs | Purchase |
| `/store/dashboard/operations/requisitions` | Purchase Forms | (386) | Read-only purchase-form register + PDF | `/api/cms/inventory/requisitions` | Active | Purchase |
| `/store/dashboard/operations/delivery`, `…/[id]` | Delivery | (609 / 915) | **Inbound** delivery notes + vendor returns (hub copy wrongly says "outbound dispatch") | `/api/cms/inventory/operations/deliveries`, `…/purchase-orders/:poId/returns` | Active | Purchase/Store |
| `/store/dashboard/vendors-buyer/vendors` (+form, +view) | Vendors | (502 / 1,014 / 988) | Vendor register, form, 360 view w/ alias-item management | `/api/cms/vendors/**` | Active | Purchase |
| `/store/dashboard/raw-items` (+form, +view, +add-stock) | Raw Items | (1,139 / 1,575 / 1,768 / 663) | Catalogue, item form, item 360 (incl. stock history), manual stock-in | `/api/cms/raw-items/**` | Active — form & view oversized | Store |
| `/store/dashboard/operations/barcode-generator` | Product Marking | (507) | QR lot stickers; QR resolves to `/store/dashboard/item-info?itemid=` | `/api/cms/inventory/barcodes` | Active | Store |
| `/store/dashboard/item-info` | *(reached by scanning)* | (22 + client 380) | Scanned-sticker landing page | `/api/cms/inventory/barcodes/:id` | Active; **bug: double-wraps the dashboard shell** | Store |
| `/store/dashboard/configurations/warehouse` (+form) | Warehouse *(shown under Stock)* | (~370 / 641) | Warehouse CRUD — reference data only; no stock is warehouse-located | `/api/cms/warehouses` | Active | Store |
| `/store/dashboard/configurations/units-packaging` (+form) | Unit / Packaging | (~300 / 649) | Unit + conversion CRUD | `/api/cms/units` (**unauthenticated backend**, §2.6) | Active | Store |
| `/store/dashboard/raw-items/stock-adjustments` | Issue & Return | (438 + drawer 594) | Issue/return to people/MOs, barcode-scan driven | `/api/cms/inventory/stock-adjustments/**`, cutting-master barcode endpoint | Active | Store |
| `/store/dashboard/operations/accountability` | Accountability | (513) | All movements for a date range | `/api/cms/raw-items/accountability` | Active | Store |
| `/store/dashboard/operations/stock-ledger` | Item Ledger | (1,021) | Per-item ledger + verification report + **transaction editing** | `/api/cms/inventory/stock-ledger/**` | Active (nav name ≠ page title "Stock Ledger") | Store |
| `/store/dashboard/operations/mrf-history` | Request History | (1,228) | MRF register — **not read-only**: approve/issue/reject/bypass live here too | `/api/cms/inventory/mrf/**` | Active — duplicates desk actions | Requests |
| `/store/dashboard/configurations/registered-operations` | Operations | (1,200 + modal 1,068) | Manufacturing masters: operations, groups, codes, machine types | `/api/cms/operations*`, `/machine-types` | Active | **Manufacturing** |
| `/store/dashboard/configurations/devices-machines` (+form) | Devices / Machines | (450 / 762) | Factory machine register | `/api/cms/machines` | Active | **Manufacturing** |
| `/store/dashboard/configurations/assigned-team` (+view) | Assigned Team | (415 / 411) | Production **operator** roster | `/api/cms/employees/operators` | Active | **Manufacturing/HR** |
| `/store/dashboard/configurations/work-orders` (+create/edit/view) | Work Order Sheet | (488 + form ~700) | Printable outsourced-job worksheets (separate doc type from MO work orders) | `/api/cms/store/work-orders-worker` | Active | Worksheet paperwork |
| `/store/dashboard/configurations/purchase-orders` (+create/edit/view) | Purchase Order Sheet | (439 + form ~700) | **The second PO system** (§3) | `/api/cms/store/purchase-orders` | Active — duplicate concept | Worksheet/Purchase |
| `/store/dashboard/configurations/store-settings` | Store Settings | (254) | PDF letterhead | `/api/cms/inventory/store-settings` | Active | Store |
| `/store/dashboard/product-requests` | *(not in nav)* | (134) | Standalone legacy product-request list | `/api/cms/inventory/mrf/product-requests` | **Legacy/duplicated** (same data shown in desk + raw-items) | Requests |
| `/store/dashboard/operations`, `/configurations`, `/vendors-buyer` (hubs) | *(not in nav)* | (123 / 281 / 323) | Static card hubs with **hard-coded fake stats**; one links to nonexistent `/vendors-buyer/customers` | none | Legacy, unlinked | — |

### 1.2 Broken / dead navigation targets

- `/store/dashboard/stock-items` **does not exist**. Five dead links point at
  it: `page.js:44,397` and `overview/page.js:668,1214,1377`. The real
  stock-item screens live in the sales/PM/merchandiser/CEO apps. The
  overview KPI shows a stock-items count users cannot click through to.
- `/store/dashboard/vendors-buyer/customers` does not exist
  (`vendors-buyer/page.js:56`).
- The three hub index pages carry hard-coded fake statistics
  (`totalWarehouses: 6`, `total: 42, pending: 6`, …).

### 1.3 Client-only gates (all advisory)

Heaviest RoleGate usage: MRF detail (21), registered-operations (20+20),
raw-item view (12), mrf-history (11). Deletes gated `min="owner"` on
machines, work-order sheets and PO sheets. One good server-driven pattern:
the desk hides the intake tab when `GET /api/requests/intake/fulfilment`
403s (`order-requests/page.js:139,167-176`). **None of these gates have a
server counterpart on the inventory routers.**

### 1.4 Cross-app entry points

- CEO app links into Store: `/ceo/dashboard/inventory` ("Inventory Portal"),
  reports page → `/store/dashboard/overview`; accountant budgets item-categories
  page → `/store/dashboard/raw-items`.
- `app/sales/dashboard/raw-items/**` and
  `app/sales/dashboard/inventory-configurations/registered-operations/**` are
  wholesale **copies** of Store subtrees (the raw-items copy still mounts
  `Store_DashboardLayout` itself).
- The requester side of the same flows lives in the standalone Requests app
  (`app/mrf`, `app/requests` → `components/mrf/RequestsApp.js`) and, for
  MRFs, the separate Cowork repo (`/api/cowork/mrf` mounts the same backend
  handlers as `/api/cms/mrf`).
- The launcher tile name comes from **backend department data**
  (`components/shell/useMyApps.js`), not this repo — renaming the app to
  "Store & Purchase" is a backend/data change, not a frontend string (see
  decision record §8).

---

## 2. Backend inventory (`grav-cms-backend`)

### 2.1 Models

| Model → collection | File | Responsibility | Company scope | Numbering |
|---|---|---|---|---|
| `RawItem` → `rawitems` | `models/CMS_Models/Inventory/Products/RawItem.js` | Item catalogue; **`quantity` + `variants[].quantity` are the live stock truth; embedded `stockTransactions[]` is the primary movement history**; per-variant vendor aliases; per-item budget-head override | none | SKU `RAW-<cat3>-<codes>-<rand3>`, unique |
| `StockItem` → `stockitems` | `…/Products/StockItem.js` | Finished goods + BOM (`variants[].rawItems[]` → RawItem refs); `quantityOnHand` set directly, **no ledger of any kind** | none | user `reference`, unique |
| `PurchaseOrder` → `purchaseorders` | `…/Operations/PurchaseOrder.js` | **Operational PO** (§3); embedded `deliveries[]`, `returnRequests[]`, `payments[]`; `spendRequestId` upstream link; `strict:false` | none | `PO<yy><mm><rand4>` random, check-then-insert, unique index backstop |
| `StorePurchaseOrder` → `storepurchaseorders` | `models/CMS_Models/Store/PurchaseOrder.js` | **Worksheet PO** (§3); free-text vendor, PDF-oriented | none | `PurchaseOrderSettings` counter (`PO-0001`), read-inc-save (non-atomic), user-editable |
| `MRF` → **`mrves`** (mongoose pluralisation) | `…/Operations/MRF.js` | Material request: TL→Store flow, per-line issued/returned/consumed + histories, fulfilment decision, budget-head carry, `intakeRequestId`/`spendRequestId` links, `statusHistory[]` audit | none | `MRF-YYMM-####` read-max+1 (race-prone) |
| `Requisition` → `requisitions` | `…/Operations/Requisition.js` | Store "Purchase Form" (pen-and-paper PDF); `purchaseOrder` ref **never written by any route**; `sourceMrfId` back-link | none | `REQ-YYMM-####` read-max+1 — **same prefix as IntakeRequest numbers** |
| `RawItemAddRequest` → `rawitemaddrequests` | `…/Operations/RawItemAddRequest.js` | Legacy product-request door; frozen (creation shims to MRF) | none | none |
| `StockIssuance` → `stockissuances` | `…/Operations/StockIssuance.js` | Manufacturing-order issuance batches (debit/credit) — **not written by MRF flows** | none | none |
| `StockLedger` → `stockledger` | `…/Operations/StockLedger.js` | ONLY compensating entries + edit logs for corrections of embedded transactions | none | none |
| `Barcode` → `barcodes` | `…/Operations/Barcode.js` | One printed lot sticker; PO/vendor/price provenance snapshot; `quantity` decoupled from RawItem stock | none | Mongo `_id` is the QR |
| `Warehouse`, `Unit`, `Machine`/`MachineType`/`Operation`/`OperationCode`/`OperationGroup` | `…/Configurations/` | Config masters. **Nothing links stock to a Warehouse.** Unit conversions drive every quantity conversion. Machines/operations are manufacturing masters | none | — |
| `Vendor` → `vendors` | `…/Vendor-Buyer/Vendor.js` | Supplier master incl. bank details; `companyName` **not unique** | none | — |
| `IntakeRequest` → `intakerequests` | `models/CMS_Models/Requests/IntakeRequest.js` | Unified pre-classification ask; frozen department `approvalChain[]`; budget head + planned item; exactly-one-of `mrfId`/`spendRequestId` | none | `REQ-YYMM-####` unique |
| `SpendRequest` → `spendrequests` | `models/CMS_Models/Requests/SpendRequest.js` | Purchase/service money ask; `commitmentId` → `Acc_BudgetCommitment`; `purchaseOrderId` → operational PO; `sourceMrfId`, `intakeRequestId`; **the only company-scoped model in the domain (`companyId`)** | **yes** | `SPR-YYMM-####` |
| `WorkerWorkOrder`, `PurchaseOrderSettings`, `WorkOrderSettings`, `StoreSettings`, `MrfChatMessage` | `models/CMS_Models/Store/`, `…/Operations/` | Worksheet WOs (with payment fields), numbering singletons, letterhead, chat | none | counters (non-atomic) |

Snapshot-vs-ref pattern is consistent: ObjectId refs paired with denormalised
name/number snapshots that are allowed to go stale. Worksheet documents are
snapshot-only.

### 2.2 Routers, auth and endpoints

**Auth pattern:** every Store/Inventory router mounts
`Middlewear/EmployeeAuthMiddlewear` — JWT verification only. **No router in
this domain checks a role or scopes a company** (the intake/spend/MRF family
is the exception, with real per-document entitlement in
`services/requestIntake.service.js` / `spendApproval` / `resolveAccess`).

| Router | Mount | Writes | Transactions | Idempotency |
|---|---|---|---|---|
| `Inventory/Operations/purchaseOrders.js` | `/api/cms/inventory/operations/purchase-orders` | PO create/edit/status/**receive** (stock S1)/payment | none | none |
| `Inventory/Operations/returnRequests.js` | `…/purchase-orders/:poId/returns` | return create (stock S2), replacement receive (S3), cancel (**does not reverse the deduction**) | none | none — cumulative returns can exceed goods received |
| `Inventory/Operations/deliveries.js` | `…/operations/deliveries` | read-only (per-item delivery quantities are *estimated proportionally* — deliveries store one aggregate number) | — | — |
| `Inventory/Operations/mrfRoutes.js` | `/api/cms/inventory/mrf` | store MRF actions: availability, match/register/reject, **fulfilment-decision** (issue S4 + spawn SpendRequest — stock moves BEFORE spend creation, not atomic), **issue** (S4), **return** (S5), bypass create, unfulfilled, cancel; legacy product-request actions (can create RawItems) | none | none (replay re-issues) |
| `Inventory/Operations/coworkMrfRoutes.js` | `/api/cowork/mrf` AND `/api/cms/mrf` | requester/TL side: create (2-min duplicate-signature guard — the only one), tl-approve/reject, cancel, chat | none | signature window only |
| `Inventory/Operations/requisitionRoutes.js` | `/api/cms/inventory/requisitions` | create/edit/status. **Status CONVERTED is a manual flag — no route ever writes `requisition.purchaseOrder` or converts a form into either PO system** | none | none |
| `Inventory/Operations/stockLedgerRoutes.js` | `/api/cms/inventory/stock-ledger` | transaction edit (S6) — **the only transactional stock write in the domain** (`startSession`) | **yes** | n/a |
| `Inventory/Operations/barcodes.js` | `/api/cms/inventory/barcodes` | sticker create (price read from PO server-side); printing moves no stock | — | — |
| `Inventory/Products/rawItems.js` | `/api/cms/raw-items` | create (S12: initial qty, **no opening transaction**), **PUT edit (S7: sets quantities directly, NO transaction written)**, hard DELETE (S11: destroys item + its embedded ledger, no guard against open POs/MRFs), variant add-stock (S8)/reduce-stock (S9), vendor-nickname CRUD | none | none |
| `Inventory/Products/stockAdjustments.js` | `/api/cms/inventory/stock-adjustments` | **manufacturing issuance** (S10): RawItem mutations then `StockIssuance.create` — non-atomic; debit clamps at 0 with no sufficiency check | none | none |
| `Inventory/Products/stockItems.js` | `/api/cms/stock-items` | StockItem CRUD; `quantityOnHand` direct set, change-log prose only | none | none |
| `Store/storeRoutes.js` | `/api/cms/store` | store verification flags on Manufacturing WorkOrders; **declares dead env flag `PM_APPROVAL_FOR_MRF` (unused repo-wide)** | — | — |
| `Store/purchaseOrderRoutes.js` | `/api/cms/store/purchase-orders` | worksheet PO CRUD incl. hard delete; free status jumps; non-atomic counter | none | none |
| `Store/workerWorkOrderRoutes.js` | `/api/cms/store/work-orders-worker` | worksheet WO CRUD (payment-detail fields) | none | none |
| `Requests/intakeRequests.js` | `/api/requests/intake` | raise, chain approve/reject, **classify** (spawns MRF and/or SpendRequest; may auto-create Vendor docs via `vendorResolve`), cannot-fulfil, cancel | none | none |
| `Requests/spendRequests.js` | `/api/requests/spend` | raise, TL/finance approve (commitment written via `spendFinanceDecision`), confirm/requote/send-to-finance, **`POST /:id/purchase-order`** (spend → operational PO; check-then-act double-submit window), cancel (releases commitment) | none | commitment unique index only |
| `Accountant_Routes/Acc_spendApprovals.js` | `/api/accountant/spend-approvals` | finance approve/reject — same `spendFinanceDecision` service as the CMS door | — | commitment unique index |
| `Inventory/Configurations/units.js` | `/api/cms/units` | **MOUNTED WITH NO AUTHENTICATION AT ALL** — full CRUD on the unit-conversion master every stock movement trusts | none | none |
| `Inventory/Configurations/{warehouses,machines,operations,operators,sizeConfig}` | various | config CRUD (EmployeeAuth) | none | none |
| `Inventory/overview/overview.js`, `Inventory/chatbot/*` | `/api/cms/inventory/overview`, `…/chatbot` | read-only | — | — |

### 2.3 Definitive stock-mutation write paths

Everything below is read-modify-write `document.save()`; **only S6 uses a
session; there are no `$inc` atomics and no duplicate-submission guards on
any of them.**

| # | Path | File:lines | Effect |
|---|---|---|---|
| S1 | PO goods receipt | `purchaseOrders.js:1230-1395` (txn push :1336) | CREDIT `ADD`/`VARIANT_ADD`, reason "Purchase Order Delivery", carries `purchaseOrderId`. Saves each RawItem, then the PO — a crash in between leaves stock credited with no delivery recorded. Surplus (incl. any duplicate submission) is silently credited to stock. Auto-creates missing variants |
| S2 | PO return create | `returnRequests.js:23-66,117-133` | immediate DEBIT of damaged qty |
| S3 | PO return receipt | `returnRequests.js:204-220` | CREDIT of vendor replacement |
| S4 | MRF issue | `mrfRoutes.js:51-83` (`adjustStock`), `applyIssue` :1783-1823; callers :1567 (fulfilment-decision), :1897 (issue) | DEBIT, reason `MRF Issue — <mrfNumber>`; `Math.max(0,…)` clamp can silently absorb over-issue |
| S5 | MRF return | `mrfRoutes.js:1954-1964` | CREDIT, reason `MRF Return — <mrfNumber>` |
| S6 | Stock-ledger correction | `stockLedgerRoutes.js:230-359` | either direction; compensating StockLedger entry; **rewrites the original txn's quantity in place** — the only transactional site |
| S7 | Raw-item PUT edit | `rawItems.js:646-691` | sets `quantity`/variant quantities directly — **no transaction written** (silent stock edit) |
| S8/S9 | Variant add/reduce-stock | `rawItems.js:1067-1071 / 1120-1124` | CREDIT/DEBIT; supplier/PO metadata accepted **from the client** |
| S10 | Manufacturing issuance | `stockAdjustments.js:268-356` | DEBIT/CREDIT + `StockIssuance` doc created after the item saves |
| S11 | Raw-item hard delete | `rawItems.js:737-749` | destroys the item **including its embedded movement history** |
| S12 | Item creation with initial qty | `rawItems.js:504-540` (also MRF register :904-915) | opening balances carry **no opening transaction** |

### 2.4 Request doors — who is actually active

| Door | Created by | Status chain | Links downstream |
|---|---|---|---|
| **IntakeRequest** (unified desk) | any employee, `POST /api/requests/intake` | draft → pending_tl → needs_classification → store_issue \| purchase_required \| service_required \| recurring_required (+rejected/cancelled/closed) | classify → `mrfId` and/or `spendRequestId` (reciprocal links on both) |
| **MRF** | cowork/CMS self door, store `bypass`, intake classification, legacy product-request resolution | PENDING → APPROVED (TL) → PARTIALLY_ISSUED/ISSUED/… ; store approval endpoints retired (403) | fulfilment-decision → `spendRequestId`↔`sourceMrfId`; line `purchaseRequisitionId`; stock via S4/S5 |
| **SpendRequest** | direct form, intake classification, MRF fulfilment decision | pending_tl → (confirmation loop) → pending_finance → approved → ordered (+budget_exception) | finance approval writes `Acc_BudgetCommitment` (unique per request); `POST /:id/purchase-order` → operational PO (`purchaseOrderId`↔`spendRequestId`); `PATCH /:id/ordered` records free-text reference only |
| **RawItemAddRequest** | **frozen** — creation shims to MRF; only pre-cutover PENDING docs still actionable | legacy | `products[].spawnedMrf` |
| **Requisition** ("Purchase Form") | store, from an MRF line or standalone | DRAFT/SUBMITTED/CONVERTED/CANCELLED — CONVERTED is a manual flag | `sourceMrfId` back-link; `purchaseOrder` ref dead |
| **Manufacturing demand** | `stockAdjustments /issue` against a CustomerRequest MO | — | `StockIssuance.manufacturingOrder` |

**Broken link discovered:** `POST /api/requests/spend/:id/purchase-order`
maps PO lines from `l.rawItemId` (`spendRequests.js:1339`) but SpendRequest
lines have **no `rawItemId` field** — every PO raised from an approved spend
request loses its catalogue-item link, so its receipt cannot credit stock to
an item unless the PO is edited by hand first.

### 2.5 Flow map — the chain as actually implemented

```
EMPLOYEE DEMAND
│
├── Unified intake door                          ├── Material app door (cowork MRF)
│   IntakeRequest REQ-YYMM-####                  │   MRF MRF-YYMM-#### (no intake link,
│   dept approvalChain, manager picks head      │    no budget head — by design)
│   ▼ classify (store)                           │   TL approves in Cowork
│   ├─ store stock → MRF (APPROVED, linked) ─────┤
│   ├─ partial     → MRF + SpendRequest          ▼
│   └─ buy/service → SpendRequest ───┐      STORE FULFILMENT DECISION
│                                    │      ├─ issue_from_stock → applyIssue (S4)
│                                    │      ├─ partial → issue + SpendRequest
│                                    │      └─ buy_or_service → SpendRequest
│                                    ▼           (sourceMrfId ↔ spendRequestId)
│                          SPENDREQUEST SPR-YYMM-####
│                          … → pending_finance → approved
│                                    │ finance approve (2 doors, 1 service)
│                                    ├─► Acc_BudgetCommitment (unique/spendRequestId)
│                                    │     released by posted voucher / cancel
│                                    ▼
│         ┌─ POST /:id/purchase-order → OPERATIONAL PO (DRAFT, spendRequestId ✓)
│         │    ✗ lines lose rawItem (l.rawItemId doesn't exist)
│         └─ PATCH /:id/ordered → free-text reference only (✗ no id link)
│
├── Hand-typed PO (POST purchase-orders) → PO PO<yymm><rand4>  ✗ no upstream link
├── Requisition REQ-YYMM-#### ✗ number prefix collides with IntakeRequest;
│     ✗ never converts to a PO (dead ref); worksheet PO system fully parallel
│
▼ RECEIPT  POST /purchase-orders/:id/receive
│   per-line received/pending ✓ · deliveries[] = ONE aggregate qty ✗
│   ✗ no idempotency — replay silently credits stock again as "surplus"
│   ✗ no transaction — RawItems saved before the PO
│
▼ STOCK = RawItem.quantity / variants[].quantity + embedded stockTransactions[]
│   MRF issue/return: mrfNumber only in reason text ✗ no mrfId field
│   Mfg issuance → StockIssuance ✓ · PO returns ✓ purchaseOrderId
│   StockLedger = corrections only · S7 direct edits leave no record ✗
│
▼ FINANCE
    PO.payments[] ◄ store UI (✗ no voucher)  ◄ Acc_vouchers writePaymentToPO
      (posted payment voucher with purchaseOrderId — idempotent mirror) — two
      editable payment truths
    Budget actuals = posted vouchers by ledger (no PO/stock linkage)
```

---

## 3. The two Purchase Order systems

| Dimension | Operational PO | Worksheet PO |
|---|---|---|
| Model / collection | `PurchaseOrder` → `purchaseorders` | `StorePurchaseOrder` → `storepurchaseorders` |
| API | `/api/cms/inventory/operations/purchase-orders` | `/api/cms/store/purchase-orders` |
| Screen | `/store/dashboard/operations/purchase-order` ("Purchase Orders", Requests group) | `/store/dashboard/configurations/purchase-orders` ("Purchase Order Sheet", Configurations group) — **titles nearly identical on screen** |
| Numbering | `PO<yy><mm><rand4>` random + retry | settings counter `PO-0001`, prefix/suffix user-configurable, number editable |
| Statuses | DRAFT / ISSUED / PARTIALLY_RECEIVED / COMPLETED / CANCELLED + payment PENDING/PARTIAL/COMPLETED | Draft / Ordered / Received |
| Vendor | Vendor-master ref + snapshot | free text only |
| Receiving | real: stock effect, deliveries, per-line received/pending, returns cycle | `status = "Received"` — **no stock effect, ever** |
| Payments | embedded `payments[]` + accounting voucher mirror | none |
| Upstream | `spendRequestId` (optional; hand-typed POs have none) | none — outside the requests/budget world entirely |
| Delete | no delete route | hard DELETE |

**Only the operational PO is connected to anything.** The worksheet PO's
"Ordered/Received" reads like the operational lifecycle but changes nothing;
two independent numbering schemes can mint the same visible number.

## 4. Which paths are actually active (code-level evidence)

- **Active PO path:** operational, via three creation doors — spend-request
  conversion (linked), hand-typed (unlinked), emergency (vendor-less). The
  worksheet PO remains fully writable in parallel.
- **Active request doors:** IntakeRequest (the strongest, with chain
  approval and budget heads), MRF (three creation modes), SpendRequest
  (three creation modes). RawItemAddRequest is frozen legacy.
  Requisition is active as a paper form only — it never becomes a PO in
  data.
- **Active stock-update paths:** all twelve S1–S12 above. Usage counts per
  path against real data come from the Deliverable 2 script (§7) — this
  document deliberately reports no invented production numbers.

## 5. Present data-inconsistency mechanisms (how the data gets wrong)

1. No transaction around any multi-write stock operation except ledger
   correction (S6): interrupted receipts/issues leave stock moved with no
   matching document state.
2. No idempotency anywhere in the chain: double-submitted receive inflates
   stock as "surplus"; double payment records duplicate payments; returns
   can cumulatively exceed goods received; replayed issues re-issue.
3. Silent balance edits (S7) and opening balances without transactions (S12)
   make embedded history irreconstructible for affected items.
4. Two editable payment truths (PO `payments[]` vs Accounting vouchers).
5. Random/read-max numbering with no atomic sequence: PO/MRF/REQ/SPR numbers
   race-prone; `REQ-` prefix shared by two collections.
6. Unit conversion silently falls back 1:1 when no path exists
   (`purchaseOrders.js:63`); MRF quantities live in requester units while
   stock moves in base units.
7. Free-text category/unit identity on items (`category` + `customCategory`,
   `unit` + `customUnit`), non-unique vendor names, variant SKUs defaulted to
   colliding `-var` suffixes.
8. `/api/cms/units` is publicly writable (no auth) — the conversion master
   that every movement trusts.
9. Self-approval possible: the same JWT may create, issue and receive a PO,
   and `approvedBy` is stamped from the issuing caller.
10. Hard deletes destroy history: raw item (with its ledger), vendor,
    worksheet documents.

## 6. Cross-app integrations to preserve (verified)

- Intake/MRF/Spend ↔ Requests & Cowork apps (shared handlers on two mounts).
- SpendRequest → `Acc_BudgetCommitment` (unique, released/restored via
  voucher lifecycle) — the budget boundary works and is already tested.
- Accounting → PO payment mirror (`writePaymentToPO`, idempotent via
  `accountantVoucherId` surviving only through `strict:false`).
- Manufacturing → BOM reads + `stockAdjustments /issue`; store verification
  flags on WorkOrders; cutting decrements `Barcode.quantity` only.
- Barcode stickers carry PO/vendor/price provenance; CEO dashboards read
  the overview endpoint; vendor 360 mines `stockTransactions` for history.

## 7. Usage & data baseline (Deliverable 2)

Implemented as:

- `services/storePurchaseBaselineAudit.service.js` — pure, deterministic
  reconciliation arithmetic (injected clock; stable ordering; 4-dp
  rounding; document lists capped at 50 with full counts).
- `scripts/store-purchase-baseline-audit.js` — read-only runner. Uses the
  **native MongoDB driver, not mongoose models**, so no schema registration,
  no index builds and no middleware can run; the only driver calls are
  `find()` with projections. Prints a human summary; `--json out.json`
  writes the full machine-readable report; `--now <ISO>` pins the clock.
- Tests: `services/storePurchaseBaselineAudit.test.js` (39 node:test cases;
  a further 80 cover the Item Master half — see §13, total 119)
  on the arithmetic — drift vs reconciled vs no-history, orphan-vs-unlinked
  rule, variant-orphan vs unverifiable-parent, duplicate detection in both
  its forms, scope presence, write-path attribution, determinism) and
  `test/store-purchase/baseline-audit.integration.test.js` (jest; runs the
  real gather against an in-memory MongoDB and proves that every collection
  in the gather plan — documents AND indexes, including the ones the plan
  finds absent — is unchanged afterwards). The integration test caught that
  mongoose stores MRFs in collection **`mrves`**.

Run against a real environment (reads `MONGODB_URI`, falling back to
`MONGO_URI`, then localhost):

```bash
node -r dotenv/config scripts/store-purchase-baseline-audit.js --json baseline.json
```

It reports:

- per-collection counts across all 14 gathered collections;
- both PO systems' status distributions and recent activity; request-door
  usage and linkage counts;
- **stock-write-path usage**, broken down by the reason signature each route
  stamps (S1 PO receipt, S2/S3 vendor return and replacement, S4/S5 MRF issue
  and return, S8/S9 variant add/reduce, S10 manufacturing issuance). A
  movement whose reason was typed by an operator is reported
  `UNCLASSIFIED_WITH_REASON` rather than guessed at — two paths accept free
  text, so unclassified rows are expected data, not faults;
- **unmeasurable write paths, named as such**: direct quantity edits (S7),
  opening balances (S12) and hard deletes (S11) write no row, so their usage
  cannot be counted historically or now. They are reported with the evidence
  that *does* exist (drifted items; items holding a balance with no history
  at all) and never as zero usage;
- RawItem balance vs embedded-movement reconciliation
  (RECONCILED / DRIFTED / NO_HISTORY) and variant-sum consistency;
- PO header-vs-lines-vs-deliveries consistency; MRF internal and stock
  cross-checks;
- **orphan references** — non-null only; null legacy links are counted
  separately as "unlinked" and never as corruption. Covers item, vendor,
  spend-request, intake, MRF, requisition, ledger, issuance and **barcode**
  links, and all supplier references including `primaryVendor`,
  `alternateVendors[]`, per-variant `vendorNicknames[].vendor`,
  `stockTransactions[].supplierId` and `stockLedger.vendorId`;
- **variant references**, checked against the parent item's own `variants[]`
  — from operational PO lines, MRF lines, StockIssuance, StockLedger,
  Barcode, and the item's own `stockTransactions[]`. Where the parent item
  is itself missing the variant is reported `parentMissing` (unverifiable)
  rather than counted as an orphan;
- **references that cannot be validated at all**, stated rather than
  omitted: warehouse/location (no stock-bearing document carries one, so
  this check is IMPOSSIBLE, not clean), MRF↔movement (reason-string join
  only), per-item delivery quantity (aggregate only), and unit/category
  identity (free text, no Category collection);
- **duplicate identity candidates** in both their forms — exact repeats of
  one spelling and one identity written several ways — reported with
  occurrence counts (documents involved) separately from distinct spellings,
  for SKUs, variant SKUs, categories, units and vendor names, plus exact
  duplicates of PO numbers and vendor GSTINs, and REQ-number collisions
  between IntakeRequest and Requisition;
- **company and site scope**, per collection and separately for each field,
  distinguishing "the schema has no such field" from "no document filled it
  in". SpendRequest declares `companyId` and is the only Store/Purchase model
  that does; no model in the domain declares `siteId`.

Every report embeds its limitations list (direct edits are unrecoverable,
opening stock has no transaction, unit-differing MRF lines are flagged not
judged, worksheet POs have nothing to reconcile, write paths are inferred
from reason strings, warehouse validation is impossible).

**It has not been run against the production database** — that requires
credentials/authorisation this chunk does not assume. It is fully tested
against fixtures; the command above is ready for the owner to run.

## 8. Regression harness (Deliverable 4)

**Already existing** (verified, all passing): `test/requests/` — 8,269 lines
covering intake raise → manager chain → classification → MRF/Spend spawn →
store fulfilment decision (issue moves stock; only shortfall priced) →
finance approval → commitment arithmetic and idempotency → spend-to-PO
conversion ("one approval cannot become two orders") → commitment release by
voucher (incl. cross-company refusal).

**Added in this chunk:** `test/store-purchase/po-receipt.route.test.js` —
22 characterisation tests over the downstream half those suites stop short
of:

- authentication required on the operational PO router; **any** authenticated
  role may create POs (no authorisation) — pinned as characterisation;
- `/api/cms/units` answers with no token at all — pinned;
- **company isolation**, tested with two genuinely distinct company
  identities stamped on the records *and* carried as claims on the tokens
  (a role is not a company): a caller from one company lists the other's
  POs, reads one by id, and can receive stock against it. The create route
  drops a `companyId` from the request body, so company identity is never
  recorded by this API at all — all pinned;
- PO creation: DRAFT, `PO\d{8}` numbering, server-computed totals;
- **the real DRAFT → ISSUED transition** through the status endpoint (which
  stamps `approvedBy` as the calling session — no second pair of eyes), and
  its refusal of statuses outside DRAFT/ISSUED/CANCELLED. Everything
  downstream is exercised against a PO that made that transition;
- **separately**, that `POST /` accepts `status: "ISSUED"` (and even
  `"COMPLETED"`) straight from the request body, so an order can skip the
  transition entirely, is immediately receivable, and carries no
  `approvedBy` — pinned;
- receive refused against DRAFT; partial receipt updates line + header +
  stock + embedded movement (with `purchaseOrderId`); completion;
- **duplicate receipt is not refused** — the repeat quantity is silently
  added to stock as surplus while the PO's own accounting hides it — pinned;
- vendor return deducts immediately; cancelling the return does **not**
  restore stock — pinned;
- Store records payments on the PO and a double-click records them twice —
  pinned;
- legacy worksheet POs stay creatable/readable; marking one "Received" moves
  no stock; the two registers never see each other's numbers.

**The literal single end-to-end test is impossible today** and none was
faked: the chain breaks at PO-line identity (spend lines carry no
`rawItemId`, §2.4), so a PO born from the tested approval flow cannot credit
stock to a catalogue item. The bounded suites above cover each real boundary
and this document records the exact missing link.

None of the pinned unsafe behaviours were fixed — they are Chunk 1
(permissions, idempotency, sequences), Chunk 3 (movement engine), Chunk 7
(receipts) and Chunk 8 (payments) scope respectively.

## 9. Migration traceability (Deliverable 5)

Stable identifiers that later migrations can already rely on, present on all
new records today:

| Concept | Identifier(s) already recorded |
|---|---|
| Intake ↔ MRF ↔ Spend | `IntakeRequest.mrfId/spendRequestId` with reciprocal `intakeRequestId` on both; `MRF.spendRequestId` ↔ `SpendRequest.sourceMrfId` |
| Spend ↔ commitment | `SpendRequest.commitmentId`; `Acc_BudgetCommitment.spendRequestId` (unique) |
| Spend ↔ PO | `SpendRequest.purchaseOrderId` ↔ `PurchaseOrder.spendRequestId` (indexed) |
| PO ↔ stock movement | `stockTransactions[].purchaseOrderId` + poNumber snapshot |
| MRF ↔ stock movement | **reason-string convention only** (`MRF Issue — <mrfNumber>`); mrfNumber is unique, so a deterministic (if fragile) join key exists |
| Requisition ↔ MRF | `Requisition.sourceMrfId` + per-item `productId`; MRF line `purchaseRequisitionId` |
| Ledger corrections | `StockLedger.originalTxnId` / `compensatingFor` |
| Barcode ↔ PO line | `Barcode.purchaseOrder/purchaseOrderItemId` |

**Decision: no new traceability fields are introduced in Chunk 0.**
Rationale: every new document already carries a resolvable source link or a
unique document number embedded in its movement records; the two genuinely
missing links (a first-class `mrfId` on stock transactions, and per-item
delivery identity) belong to write paths that Chunk 3/7 will replace
entirely, and adding fields to the legacy writers now would create a third
partial convention that migration would then also have to understand. The
fragile pieces a migration must plan around are recorded here instead:
MRF↔stock joins go through the reason string; per-item delivery quantities
are unrecoverable (aggregate only); direct edits (S7) and opening balances
(S12) have no movement record and must migrate as unexplained balance facts,
not reconstructed histories.

## 10. Unsafe behaviour found and deliberately NOT fixed

All deferred to their planned chunks; several are pinned by tests so a fix
is a conscious act:

1. `/api/cms/units` unauthenticated (Chunk 1). *Pinned.*
2. No authorisation or company scoping on any inventory router (Chunk 1). *Pinned.*
3. No idempotency on receive/issue/return/payment; duplicate receipt inflates
   stock (Chunks 1/3/7). *Pinned.*
4. No transactions around multi-write stock operations (Chunk 3).
5. Silent direct stock edits and history-destroying hard deletes (Chunks 2/3).
6. Store records supplier payments; two payment truths (Chunk 8). *Pinned.*
7. Race-prone numbering everywhere (Chunk 1).
8. Spend→PO conversion drops the catalogue-item link (Chunk 6 redesigns the
   PO source; fixing the field mapping now would change behaviour under a
   frozen baseline).
9. Return-cancel keeps the stock deduction (Chunk 7). *Pinned.*
10. Silent 1:1 unit-conversion fallback (Chunk 2).
11. Issued POs remain editable in place via PUT until first receipt (Chunk 6).

## 11. Unresolved business-owner decisions

Carried into the decision record (§8 there) and the product plan §12:
requisition thresholds and emergency review; approval matrix; warehouse/
location structure and negative stock; quotation policy; receipt tolerances
and inspection policy; valuation method; lot/roll/serial scope; services in
the requisition chain; vendor-master ownership; legacy cutover date. Plus,
raised by this audit: who owns machines/operations/operators once they leave
Store's menu, and whether the worksheet PO/WO documents survive as print
templates or become read-only history.

## 12. Item Master — field-by-field audit (addendum)

> Scope of this section: every field that constitutes item identity today,
> across both repositories, with its owner in the target model. Read-only.
> The target model itself is in the product plan §4.1a; the measurements are
> in `services/storePurchaseItemMasterAudit.service.js` (see §13).
>
> Column key — **Class**: Ident(ity), Inv(entory), Proc(urement),
> Acct(ounting), Bud(get), Mfg, Disp(lay). **Trust**: AUTH(oritative),
> SNAP(shot), DUP(licated), AMBIG(uous), DERIVED, LEGACY.

### 12.1 RawItem — the item record itself

| Field | Business meaning | Class | Trust | Read/written by | Target owner |
|---|---|---|---|---|---|
| `_id` | The only stable item identity that exists | Ident | AUTH | everything | **Item.id** — unchanged, and the anchor every migration hangs off |
| `name` | What people call it | Ident | AMBIG | every screen; MRF/PO/BOM snapshot it | Item.name |
| `sku` | Item code. Generated `RAW-<CAT3>-<NAMECODES>-<rand3>`; unique index | Ident | AUTH (unique) but **generated, not governed** | rawItems POST; PO/MRF/BOM snapshot it | Item.code — governed sequence, meaning preserved |
| `category` | One of 20 values hard-coded in `rawItems.js`, not a collection | Ident | AMBIG (see `customCategory`) | item screens; budget attribution via `categoryKeyOf` | **ItemCategory.id** — a real master |
| `customCategory` | Free-text escape hatch from that list | Ident | DUP/AMBIG — reads differ on which wins | same | retired into ItemCategory; conflicts go to a review queue |
| `unit` | Stock unit, by NAME not id | Ident/Inv | AMBIG | conversions, PO lines, MRF lines | Item.baseUom (id) |
| `customUnit` | Free-text escape hatch from the Unit master | Ident/Inv | DUP/AMBIG | `customUnit \|\| unit` in most reads | retired into the UoM master |
| `quantity` | **Current on-hand balance** | Inv | AUTH today, and the single biggest problem | 12 write paths (S1–S12); every screen | **InventoryBalance** projection — stops being authoritative at the Chunk 3 cutover |
| `variants[]` | Option-level identity + its own balance | Ident/Inv | AUTH (identity) + AUTH (balance) — two jobs in one array | receive, MRF, BOM, barcode | split: **ItemVariant** (identity) and **InventoryBalance** (quantity) |
| `stockTransactions[]` | Embedded movement history | Inv | AUTH but **mutable and destructible** | S1–S6, S8–S10; ledger edit rewrites rows in place | **InventoryMovement** (immutable, Chunk 3) |
| `minStock` / `maxStock` | Reorder thresholds; also drive derived `status` | Inv | AUTH but global — never per location | item screens, low-stock reports | **ReorderPolicy** per location |
| `status` | "In Stock"/"Low Stock"/"Out of Stock" | Disp | DERIVED (pre-save hook) | list screens | derived from InventoryBalance; **not** a lifecycle |
| `primaryVendor` | Item-level preferred supplier — **layer 1 of 3** | Proc | AUTH; read by vendor screens, **not consulted by purchasing** | vendor screens, item form | **SupplierItem** with `isPreferred` |
| `alternateVendors[]` | Item-level additional suppliers — **layer 2 of 3** | Proc | AUTH; same story | vendor screens, item form | **SupplierItem** rows |
| `budgetLedgerId` + `budgetLedgerName` | Per-item override of the category's budget head. **NOT IN `HEAD`** — part of the paused, uncommitted item-wise attribution work, along with the mapping it overrides. See §12.5a | Bud | PAUSED/UNCOMMITTED; id would be AUTH, name a deliberately stale SNAP | `itemBudgetHead.service` (paused, uncommitted) | **ItemAccountingProfile.budgetHead**, company-scoped (proposed) |
| `budgetLedgerSetBy` / `…SetByName` / `…SetAt` | Who set the override, when | Bud/audit | PAUSED/UNCOMMITTED — not in `HEAD` | budget screens (uncommitted) | ItemAccountingProfile audit |
| `attributes[]` | Option dimensions (name + allowed values) | Ident | AUTH | variant generation | **AttributeTemplate** on ItemCategory |
| `description`, `notes` | Free text | Disp | AUTH | item screens | Item.description |
| `discounts[]` | minQuantity → price | Proc? Sales? | AMBIG — **no reader found** | none located | decide or drop; not carried blindly |
| `createdBy` / `updatedBy` | Audit | audit | AUTH | item screens | Item audit fields |
| — *missing* — | **item type** (raw material / consumable / packaging / spare / trading / finished / service / asset) | Ident | **ABSENT** | — | **Item.itemType** (§12.7) |
| — *missing* — | **lifecycle** (draft/active/blocked/archived) | Ident | **ABSENT** — only a hard delete exists | — | **Item.lifecycle** |
| — *missing* — | tracking policy, inspection policy, valuation link, tax class, HSN, images on the item | Inv/Acct | **ABSENT** | — | InventoryPolicy / ItemAccountingProfile / Item |

### 12.2 RawItem.variants[] — the variant sub-document

| Field | Meaning | Class | Trust | Target owner |
|---|---|---|---|---|
| `_id` | The only variant identity | Ident | AUTH | **ItemVariant.id** |
| `combination[]` | Option values, positional, un-keyed | Ident | AMBIG — position carries meaning nothing declares | ItemVariant.optionValues (keyed) |
| `sku` | Variant code | Ident | **AMBIG — no unique index**; auto-filled `<sku>-var` on receive | ItemVariant.sku, governed + unique |
| `quantity` | Variant on-hand | Inv | AUTH; item `quantity` is supposed to be its sum | InventoryBalance |
| `minStock` / `maxStock` | Variant thresholds, falling back to the item's | Inv | DUP | ReorderPolicy |
| `image` | Cloudinary URL | Disp | AUTH | ItemVariant media |
| `status` | Derived stock state | Disp | DERIVED | derived |
| `vendorNicknames[]` | `{vendor, nickname, price, deliveryDays, notes, specifications}` — **layer 3 of 3, and the only layer carrying a supplier code, price or lead time** | Proc | AUTH, but mixes identity (code) with commercials (price) | **SupplierItem** |
| `unitConversion` | Legacy single `{fromUnit,toUnit,quantity}` (strings) | Inv | LEGACY | **ItemUomConversion** |
| `unitConversions[]` | The current array, same shape | Inv | AUTH but **may contradict the Unit master** | ItemUomConversion |

### 12.3 StockItem — the second catalogue

| Field | Meaning | Class | Trust | Target owner |
|---|---|---|---|---|
| `reference` | Finished-good code (unique, uppercased) | Ident | AUTH | Item.code (type = finished good) |
| `name`, `additionalNames[]` | Names and aliases | Ident | AUTH | Item.name + aliases |
| `productType` | Goods / Service / Combo | Ident | AUTH but a **sales** classification, not the inventory item type | informs Item.itemType; does not become it |
| `trackInventory` | Whether stock is kept | Inv | AUTH | **InventoryPolicy.isStocked** |
| `category` | Free text, required | Ident | AMBIG — a separate namespace from RawItem's | ItemCategory (one hierarchy) |
| `genderCategory`, `measurements[]`, `numberOfPanels` | Garment attributes | Disp/Mfg | AUTH | structured attributes |
| `barcode`, `hsnCode` | Identifiers | Ident/Acct | AUTH | ItemVariant.barcodes / ItemAccountingProfile.hsn |
| `unit` | Sales unit, by name | Ident | AMBIG | Item.baseUom |
| `baseSalesPrice`, `baseCost`, `salesTax`, `purchaseTax` | Commercials | Acct | AUTH | pricing + ItemAccountingProfile |
| `attributes[]` | Variant dimensions | Ident | AUTH | AttributeTemplate |
| `variants[].sku` | Unique (index) | Ident | AUTH | ItemVariant |
| `variants[].quantityOnHand` | Finished-goods balance | Inv | AUTH, **with no movement ledger of any kind** — only change-log prose | InventoryBalance + InventoryMovement |
| `variants[].minStock/maxStock/cost/salesPrice/barcode/images` | Per-variant data | mixed | AUTH | ReorderPolicy / pricing / ItemVariant |
| `variants[].rawItems[]` | **The BOM**: `{rawItemId, rawItemName, rawItemSku, variantId, variantCombination, requiredQuantity, allowancePercent, quantity, unit, baseUnit, unitCost, totalCost}` | Mfg | AUTH (ids) + SNAP (names) + DERIVED (`quantity`, `totalCost`) | BOM stays Manufacturing-owned; it consumes Item/ItemVariant ids |
| `operations[]`, `miscellaneousCosts[]` | Routing and costing | Mfg | AUTH | Manufacturing |
| `totalQuantityOnHand`, `averageCost`, `inventoryValue`, `profitMargin`, … | Roll-ups | Disp | DERIVED, recomputed on write | derived from balances/valuation |

### 12.4 Supporting masters and the item references elsewhere

| Record / reference | What it holds | Trust | Target owner |
|---|---|---|---|
| `Unit` (`name` unique, `conversions[{toUnit ref, quantity}]`) | The UoM master; **items join it by NAME** | AUTH, but reachable through an **unauthenticated router** | UoM master + **ItemUomConversion** |
| `Vendor` | Supplier master; `companyName` **not unique** | AUTH | Supplier (party lifecycle) |
| `Barcode` | One **printed lot instance** — its identity IS the document `_id` (the QR payload); `rawItem` + `variantId` + qty/unit + PO/vendor/price provenance; `cuttingSessions[]`. No barcode-STRING field, so it shares no namespace with StockItem's product barcodes | AUTH (its own facts) + SNAP (provenance) | lot identity under InventoryMovement/lot tracking — **distinct from** ItemVariant.barcodes[] |
| Operational PO `items[]` | `rawItem` ref + `itemName`/`sku`/`unit`/`baseUnit`/`variantId`/`variantSku`/`vendorNickname` snapshots | AUTH (ref) + SNAP (rest) | Item/ItemVariant ids + SupplierItem code |
| Worksheet PO `items[]` | Free text only — `itemName`, `hsnCode`, no ref | **no identity at all** | remains legacy history |
| MRF `items[]` | `rawItem` ref (nullable until matched) + name/sku/unit/baseUnit/category/attributes snapshots | AUTH + SNAP; `UNMATCHED` until Store resolves it | Item ids; the matching queue becomes catalogue matching |
| Requisition `items[]` | `name`, `quantity`, `unit` — **free text, no ref** | no identity | review queue at migration |
| IntakeRequest lines | optional `rawItem` ref + free-text name | AUTH + SNAP | Item ids |
| SpendRequest lines | `name`, `requestedName`, `spec` — **no item ref** (`rawItemId` is read by the PO-conversion route but never stored) | **broken link** | Item ids; fixed when the PO source is rebuilt |
| StockIssuance `items[]` | `rawItem` + `variantId` + issued/native qty and unit | AUTH | InventoryMovement |
| StockLedger | `rawItem` + `variantId` + name/sku snapshots | AUTH | InventoryMovement |
| `Acc_ItemCategoryBudget` | company-scoped `category` → budget head, keyed by `categoryKey` (unique per company) | **PAUSED/UNCOMMITTED** — not in `HEAD`; may not be deployed at all | ItemAccountingProfile / ItemCategory budget mapping (company-scoped) |

### 12.5 Frontend surfaces that write item identity (`grav-cms`)

| Surface | Writes |
|---|---|
| `raw-items/add-edit-raw-item` → `RawItemForm.js` (1,575 lines) | name, SKU (server-generated), category/customCategory, unit/customUnit, variants + images + per-variant supplier aliases + conversions, min/max, attributes |
| `NewEditPurchaseOrderClient.js` (2,872 lines) | creates variants and vendor aliases **inline while authoring a PO** — catalogue identity edited from a procurement screen |
| `order-requests/mrf/[id]` (3,569 lines) | "register as new" mints a RawItem with SKU `<NAME4>-<epoch>` |
| PO `…/[id]/receive` | auto-creates a missing variant with SKU `<sku>-var` |
| `raw-items-view/[id]` | vendor-alias CRUD |
| `configurations/units-packaging` | the Unit master and its conversions |

Four different screens can mint catalogue identity, three of them while doing
something else. That is the practical reason SKU governance has to move
server-side before the UI is reorganised.

### 12.5a Budget attribution — implementation state, classified from `HEAD`

**Corrected.** An earlier version of this section classified the item
override fields as committed because they are present in the working tree.
They are not in `HEAD`. Presence in a dirty worktree is not shipped
behaviour, and the whole item-wise attribution initiative is paused.

| Layer | State (verified against `HEAD`) | Files |
|---|---|---|
| Item-wise budget attribution in the **committed Store baseline** | **NONE.** No item override, no category mapping, no request-line allocation. `RawItem.budgetLedgerId`, `budgetLedgerName` and the setter audit fields do **not** exist in `HEAD`. | — |
| **Paused / uncommitted integration work** | `RawItem.budgetLedgerId` / `budgetLedgerName` / `budgetLedgerSetBy` / `…SetByName` / `…SetAt`; `Acc_ItemCategoryBudget`; `services/itemBudgetHead.service.js`; `budgetAllocation` on `IntakeRequest` and `SpendRequest` lines; the related API and frontend work (`app/accountant/budgets/item-categories/` in `grav-cms`, also uncommitted). | all untracked or unstaged |
| **Proposed target** | Company-scoped `ItemAccountingProfile` | product plan §4.1a |

(`plannedItemKey` on the request models **is** committed — a different,
earlier initiative, and not part of this classification.)

These files were read as optional audit input and were **neither modified nor
reverted**.

#### Company safety — why a global override cannot answer for every company

`RawItem` carries **no company at all**, while `Acc_Ledger` and the category
mapping are both company-scoped (`{companyId, categoryKey}`, unique). A
single global override on an item therefore cannot safely be every company's
answer: an override pointing at Company A's ledger is not Company B's.

The reporter evaluates every item **per company** and reports these states:

| State | Meaning |
|---|---|
| `ITEM_OVERRIDE_COMPANY_MATCH` | the override's ledger belongs to the company being evaluated — a valid answer for it |
| `ITEM_OVERRIDE_COMPANY_MISMATCH` | the ledger belongs to a different company; **the item then falls through to this company's category coverage** rather than being excluded from it |
| `ITEM_OVERRIDE_COMPANY_UNVERIFIABLE` | ledgers were not gathered, so the target's owner cannot be checked |
| `OVERRIDE_TO_MISSING_LEDGER` | the override names a ledger that does not exist |
| `CATEGORY_MAPPED` / `MAPPED_WITHOUT_HEAD` / `CATEGORY_NEVER_REVIEWED` | this company's category coverage |
| `NO_CATEGORY_AND_NO_OVERRIDE` | attributable by no route |
| `MAPPING_COLLECTION_ABSENT` | the mapping collection was not in this database — category coverage is **UNKNOWN**: not zero, and never `CATEGORY_NEVER_REVIEWED`. Blaming the data for an undeployed feature would be a false finding. It is counted **per company**, so a company's row shows how many of its items are unknown rather than unreviewed |

It also reports each override's target ledger company, and counts **every**
override as structurally unsafe for the same reason: the item has no company
scope, so one value applies to every company that reads it while the ledger
it names belongs to exactly one.

**The state counts are two dimensions of one item, not exclusive buckets.**
An item counted `ITEM_OVERRIDE_COMPANY_MISMATCH` for a company is *also*
counted under that company's category state, because the override was not
that company's answer and its category had to be evaluated instead. They
must never be summed into a coverage percentage, and the report says so in
`stateSemantics` and in the rendered summary.

#### The company universe

Coverage is evaluated for **every company in the committed company master**
(`acc_companies`), which the runner gathers read-only with a narrow
projection. That includes companies with no mapping rows, no override-target
ledgers and **no budget configuration at all** — deriving companies from
mapping rows and override targets alone (as an earlier version did) made
exactly those companies disappear, and a company that has configured nothing
is the one a reader most needs to see.

Company ids named by a mapping row or an override-target ledger but **absent
from the company master** are reported as integrity findings
(`mappingCompanyIdsNotInMaster`, `ledgerCompanyIdsNotInMaster`) and are still
evaluated — dropping them would hide the rows that are wrong.

If the company master was not gathered, the universe is labelled
`DERIVED_FROM_DATA_ONLY` and **explicitly incomplete**; no claim is made that
every company was evaluated.

#### Discovered risk (documented, not fixed)

`services/itemBudgetHead.service.js` `headForItem()` returns the item
override **before any company validation**. The company-scoped
`categoryMap(companyId)` is consulted only on the fallback path, and
`assertMappable(ledgerId, companyId)` guards the write path that sets a
category mapping — not this read. An override set against one company's
ledger is therefore returned as the answer when resolving for another.

This is a finding for whoever resumes that paused work. Chunk 0 changes no
application behaviour, and no coverage figure appears in this document
because the reporter has not been run against a real database.

### 12.6 What the model cannot express today

1. **No item type.** Nothing distinguishes fabric from a spare part from a
   service. Every downstream policy question ("should this be received via
   GRN?", "can this be in a BOM?") is unanswerable from the record.
2. **No lifecycle.** No archive, no block, no draft. The only removal is
   `DELETE /api/cms/raw-items/:id`, which destroys the item **and its entire
   embedded movement history** (S11). `status` is a derived stock state.
3. **No location anywhere.** Balances, thresholds and movements are global.
4. **Balance and identity in one document**, so every stock write is an item
   write and vice versa.
5. **Supplier relationship split across three layers** —
   `primaryVendor`, `alternateVendors[]` and `variants[].vendorNicknames[]`.
   The two item-level layers are bare references that purchasing never
   consults; only the variant layer carries the supplier's code, and it
   mixes that identity with price and lead time. An item with none of the
   three has **no configured supplier relationship** — which is not the same
   as having no supplier, since PO history and free-text documents may name
   one.
6. **Three conversion truths** (Unit master, variant `unitConversion`,
   variant `unitConversions[]`) that may disagree, with a silent 1:1
   fallback when no path is found.
7. **Two catalogues** (RawItem, StockItem) with separate category
   namespaces, separate code fields and no rule about which owns a thing
   that could be either.
8. **No single barcode namespace.** `StockItem.barcode` and
   `variants[].barcode` are unconstrained product-code strings at two
   levels; the `barcodes` collection holds printed lot instances identified
   by document `_id`; and RawItem has no product-barcode field at all. The
   target model wants one namespace on ItemVariant, so all three have to be
   reconciled — and the first two are not the same concept as the third.
9. **No company scope on items**, while the (paused) budget mapping and the
   ledgers it points at are company-scoped — so any item-level attribution
   is global by construction and cannot be correct for more than one
   company at a time.

## 13. Item Master measurements (addendum to Deliverable 2)

`services/storePurchaseItemMasterAudit.service.js` — pure, deterministic,
tested by 80 node:test cases in `storePurchaseItemMasterAudit.test.js`. It
is merged into the baseline report under `itemMaster` and rendered into the
human summary, so one command produces both.

It measures: missing SKUs; exact duplicate SKUs (what the unique index would
catch) separately from normalised-only duplicates (what it cannot);
generated-SKU shapes attributed to the route that mints each; missing and
duplicate item names; `category` vs `customCategory` and `unit` vs
`customUnit` conflicts (with shadowed / custom-only / neither broken out);
category identities outside the route's hard-coded list; conversion findings
(missing target, zero/invalid, self, reciprocal pairs with an
exact-inverse check, ambiguous duplicates, cycles, item-level factors
contradicting the master, and variants still on the legacy field); item
balance vs variant-balance totals; balances with no movement history;
duplicate variant combinations; missing variant SKUs; duplicate variant SKUs
split from system-minted `-var` collisions; item type and lifecycle as
schema-capability findings; **supplier relationships at all three layers**
(items with a primary supplier, with alternates, with variant aliases, and
with **no configured supplier relationship at any layer**; dangling
references per layer; the same supplier configured at multiple layers;
duplicate aliases per supplier per variant; aliases carrying price or lead
time); **StockItem hygiene** (missing/exact/normalised-duplicate `reference`
codes, names and aliases in one namespace, category and UoM identities,
`productType`/`trackInventory` contradictions, services carrying inventory
balances, item- and variant-level barcode duplicates, missing/duplicate/
system-shaped variant SKUs, `totalQuantityOnHand` vs variant totals,
balances with no movement ledger, variant min/max errors, missing HSN and
tax classification); **ObjectIds present in both `rawitems` and
`stockitems`**; **barcode identity across the whole future namespace**
(item-vs-item, variant-vs-variant and item-level-vs-variant-level product-code
collisions, reported separately from printed lot-instance identifiers, which
are a different concept and cannot collide with them — with one narrow
cross-check for an ObjectId pasted into a barcode field); **budget
attribution** classified from `HEAD`, with an optional mapping collection and
**company-safe** per-company coverage; referenced
vs apparently-unreferenced items with the sources named; BOM and barcode
references to missing items and to missing variants; RawItem↔StockItem
overlap candidates; budget-head override share and items attributable by
neither route; and reorder-field hygiene including max-below-min.

**Stated limitations** (also embedded in every report):

- Overlap and duplicate findings are **candidates**, produced by exact
  normalised equality only. No fuzzy matching, no edit distance, no token
  overlap — a near-miss like "Cotton Twill 60s" vs "Cotton Twill" produces
  **nothing**, deliberately, and a test pins that. A candidate carries the
  rules that produced it and no verdict field for anything to set.
- SKU-shape classification recognises the shapes the code is known to mint;
  a human SKU that happens to match one is misclassified, and an unknown
  generated shape reads as `HUMAN_OR_UNKNOWN`.
- "Apparently unreferenced" means no ObjectId reference in the gathered
  collections. Requisition and worksheet-PO lines name items as free text;
  manufacturing orders are not gathered.
- Item type and lifecycle counts are the whole catalogue **by
  construction** — the field does not exist, so this is a schema gap.
- Whether a stated conversion factor is physically correct is unknowable;
  only absence, invalidity, self-reference, contradiction and cycles are
  detectable.
- Supplier relationships are measured at all three layers. "No configured
  supplier relationship" means none of the three master layers is populated;
  it does **not** mean the item has no supplier, because purchase-order
  history, requisition lines and free-text documents may name one and none of
  those is a configured relationship this report can count.
- **Both catalogues are measured.** StockItem gets its own identity, balance,
  barcode, variant and compliance hygiene — the target model merges the two
  into one governed Item, so deferring StockItem as "finished-goods scope"
  would leave half the future catalogue unmeasured.
- Budget attributability is **company-specific**, and the mapping collection
  is **optional paused, uncommitted work**: its absence is reported as
  `MAPPING_COLLECTION_ABSENT`, never as zero coverage, and a category string
  alone never means an item is attributable. No production coverage figure
  may be quoted without an authorised run against a real database.
- StockItem has no movement ledger of any kind, so every finished-goods
  balance is unexplained by construction — that count is the populated
  catalogue, not a defect list.
- HSN and tax-classification counts are completeness figures; whether either
  is required depends on item type and sales channel, which no field records.

## 14. Correction pass (same day)

The first cut of this chunk was reviewed and six substantive gaps were
corrected. Recorded here because they were wrong claims, not just missing
work, and because the tests that now prevent their recurrence are the point:

1. **Duplicate detection missed exact repeats.** `duplicateCandidates()`
   filtered on the number of distinct *spellings*, so two records carrying
   the identical value — the commonest duplicate there is — reported clean.
   It now counts occurrences (documents) separately from distinct spellings
   and classifies each group as `REPEATED_VALUE` or `SPELLING_VARIANTS`.
2. **A false limitation claimed no domain collection carried `companyId`.**
   SpendRequest declares it. Scope is now reported per collection, for
   `companyId` and `siteId` separately, distinguishing "not in the schema"
   from "no document filled it in", and covers every gathered collection
   including IntakeRequest, SpendRequest, RawItemAddRequest and Barcode.
3. **Orphan coverage was incomplete.** Barcodes are now gathered and
   checked; variant references are validated against the parent item's own
   `variants[]` from six sources (PO lines, MRF lines, StockIssuance,
   StockLedger, Barcode, and an item's own movement history), with a missing
   parent reported as unverifiable rather than as an orphan; and all
   supplier references are covered, including `alternateVendors[]`,
   per-variant aliases and movement `supplierId`.
4. **Warehouse validation was silently omitted.** It is now stated as
   IMPOSSIBLE — no stock-bearing document carries a warehouse or location at
   all — alongside the other checks that cannot be performed, so an absent
   check can never read as a clean one.
5. **Stock-write usage was a bare type tally.** Movements are now attributed
   to the write path that produced them via each route's reason signature,
   with operator-typed reasons left explicitly unclassified; and the paths
   that write no row at all (direct edits, opening balances, hard deletes)
   are declared unmeasurable with whatever indirect evidence exists, never
   reported as zero usage.
6. **The harness tested the wrong things in two places.** It created POs
   with `status: "ISSUED"` and so never exercised the real DRAFT → ISSUED
   transition; that transition is now exercised, and whether `POST` improperly
   accepts a lifecycle status directly is asked as its own question (it does,
   for `ISSUED` and even `COMPLETED`, leaving `approvedBy` unset). The
   "company isolation" test compared two *roles*, which proves nothing about
   tenancy; it now stamps two distinct company identities on the records and
   carries matching claims on the tokens.

The integration test was also tightened to snapshot every collection in the
gather plan — documents and indexes, including those the plan finds absent —
so "the audit wrote nothing" is proven across the whole plan rather than the
handful of collections a fixture happens to populate.
