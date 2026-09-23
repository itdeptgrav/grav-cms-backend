# G00 — Source inventory and order-line trace

**Status:** Read-only inventory, 21 September 2026. Completes G00 of
[`garment-order-to-shipment-roadmap.md`](garment-order-to-shipment-roadmap.md).
The closing path is **not** re-traced here — see
[`g03-closing-path-trace.md`](g03-closing-path-trace.md).

**Post-inventory integration note (21 September):** §1c and the live-data counts
below describe the checkout as inventoried. PPC Order Book, Planning File and
Capacity source was subsequently applied to the current working trees without
a commit or deployment. That changes the code-availability finding, not the
record counts, missing WorkOrder release bridge or Production authority.

**Method.** Backend and frontend working trees on `MAIN_SUB_BRANCH` (both dirty;
read as they stand), mounts in `server.js`, models, writers, readers and tests.
One order was traced through the live database with a read-only harness (every
driver write method replaced with a throw before connecting; only
`find`/`count`/`aggregate`/`distinct` issued). **No application code, seed data
or live record was changed.** Records below are shown as opaque tags (`…c8bc02`),
never by buyer, product, PO number or amount. Links were followed **by id only**;
where no id exists the link is recorded as missing, never inferred from a name
or number.

Paths are backend-relative unless prefixed `FE:` (frontend). Claims marked ✔
were re-verified by direct inspection after the fan-out inventory; the rest are
cited to file:line from that inventory.

---

## 0 · Headline findings

1. **The first broken link is the order line itself.** `CustomerRequest.items[].lineRef`
   is minted in code (`customerRequestLineIdentity.js:59-61`, pre-validate hook
   `CustomerRequest.js:1354-1364`) but **0 of 25 live orders carry one** — the
   backfill (`scripts/backfill-customer-request-line-refs.js`) is dry-run by
   default and was never applied. Everything keyed on `lineRef` downstream
   (Sales handover, Merchandising file, demand release) is therefore unreachable
   from any real order.
2. **The only live record of the new Sales → Merchandising → demand chain is a
   smoke-test fixture** (created 10 Sep 2026; test markers in its order ref,
   product name and handover ref). Every id it holds upstream and downstream —
   `sourceRecord.recordId`, `sampleStyleId`, demand `orderId`, `costingId`,
   `costingVersionId`, `productRequestId`, `serviceRequestId` — **resolves to
   nothing in any collection.** It is test data in the production database.
3. **Real orders run the legacy spine**, which holds by id from order to
   WorkOrder to cutting, then **breaks at dispatch**: challan lines carry only
   `productRef` text (19/19 lines), no `workOrderId`. There is no issued invoice
   of any kind linked to an order (0 `acc_invoices`; sales vouchers link by
   free-text `referenceNumber`).
4. **Two dispatch ledgers on WorkOrder that never reconcile** —
   `dispatchedQuantity`/`dispatchRecords` and `bulkDispatchHistory` — each
   limited only against itself. The same packed units can be dispatched once in
   each. (Two independent inventories agree.)
5. **Material issue to a WorkOrder does not exist.** `rawMaterials[].quantityIssued`
   is only ever written as `0` ✔; `StockIssuance` refuses order-linked issues
   (503). So "actual material consumed" has no source.
6. **The approved Merchandising selection does not feed procurement demand** ✔.
   `orderDemandRelease.service.js` reads no selection revision; demand comes
   from the Central Costing version's requirement. This disproves one roadmap
   claim (corrected in the roadmap and plan).
7. **The pre-order line identity is destroyed on every edit** ✔.
   `PATCH /api/cms/crm/enquiries/:id` replaces products with
   `sanitizeProducts()` (`enquiries.js:1680`), whose rebuilt rows drop
   `productLineRef` (`:523`), so the validate hook mints new refs every save —
   orphaning development records keyed on the old ones.

---

## 1 · Permanent IDs and source versions at every boundary

### 1a. Target spine (code) vs. what live data carries

```
 PRE-ORDER                                   CONFIRMED ORDER
 Enquiry.products[].productLineRef ──────▶ CustomerRequest.items[].productLineRef ─┐
   PL-… (re-minted on every edit ✗)         (stamped by proformaRequest.service:449) │
                                                                                    ▼
                                            CustomerRequest.items[].lineRef  LN-…   ◀── FIRST BROKEN LINK
                                              live: 0 / 25 orders have one ✗
                                                        │ (id)
                                                        ▼
                                            SalesHandoverVersion {companyId, handoverLineRef, versionNo}
                                              live: 1 row — smoke fixture, sourceRecord dangling ✗
                                                        │ (id: handoverVersionId)
                                                        ▼
                                            MerchandisingHandoverReceipt → ExecutionFile (MEF-…)
                                                        │ (text: handoverRef + handoverLineRef)
                                                        ▼
                     Central Costing version ◀──(sampleStyleId)── order line
                     (costing ↔ style joined by enquiryId + PRODUCT NAME ✗)
                                                        │
                                                        ▼
                                            DemandRelease {orderId, lineRef, costingVersionId}
                                              no executionFileId, no selection ✗
                                                        │ (ids: demand.spendRequestIds, forward only)
                                                        ▼
                                            SpendRequest (order/line only as free text `purpose` ✗)
                                                        │ (id: spendRequestId / spendLineId)
                                                        ▼
                                            PurchaseOrder line (_id) ──▶ GoodsReceipt line (poItemId)
                                              live legacy POs: 103, with spendRequestId: 0 ✗
                                              live GRNs: 0
                                                        │ (id: goodsReceiptLineId)
                                                        ▼
                                            Inspection / Disposition / Putaway      no roll/lot/shade ✗
                                                        │
                                                        ✗ no issue record references a WorkOrder
                                                        │
 LEGACY SPINE (what real orders use)                    ▼
 CustomerRequest._id ──(customerRequestId + stockItemId + variantId)──▶ WorkOrder
   no lineRef on WorkOrder ✗, no companyId ✗, planningState never set on 143/143 live WOs
                                                        │ (id: entries.woId)          │ (barcode text WO-<short>-<unit>)
                                                        ▼                             ▼
                                            CuttingMasterRecord           ProductionTracking /
                                                                          ProductionCompletionScanRecord
                                                                          DefectRecord (QCInspection)
                                                        │
                                                        ▼
                                  WorkOrder.packagedQuantity → dispatchedQuantity  ║  bulkDispatchHistory
                                                        │ (two ledgers ✗)
                                                        ▼
                                            DispatchChallan {manufacturingOrderId → CustomerRequest}
                                              lines: productRef text only, workOrderId null ✗
                                                        │
                                                        ✗ no id link to any invoice
                                                        ▼
                                  Acc_Voucher (sales) — referenceNumber = requestId TEXT ✗
                                  Acc_Invoice — no writer, no companyId, 0 live rows
                                                        │
                                                        ▼
                                  Closing (see g03 trace): payment and actual cost UNAVAILABLE
```

### 1b. Boundary table

| # | From → To | Permanent id carried | Source version | Company proof | Live data | Verdict |
|---|---|---|---|---|---|---|
| B1 | Enquiry product → order line | `productLineRef` PL- (`Enquiry.js:255`; hook `:1123`) stamped onto `CustomerRequest.items[].productLineRef` (`proformaRequest.service.js:449`); order-level `salesOrigin.enquiryId` (`CustomerRequest.js:1004`), stamped server-side | none | Enquiry has `companyId`; CR none | 0 CRs with `productLineRef`; **0 with `salesOrigin.enquiryId`**; the 1 live journey's enquiry links to no CR | **Broken** — re-minted on edit ✔; successor orders mint new `lineRef`s with no mapping (`proformaRequest.service.js:563,590`) |
| B2 | Order → order line | `items[].lineRef` LN- (`CustomerRequest.js:84-88`) | none on the order; quotes revise via `quotations[].revision` (`:689`) | **none** (`merchandisingHandover.service.js:599`) | **0 / 25** | **Broken — first link.** No `immutable`; `updateOne` bypasses the hook |
| B3 | Order line → Sales handover | `handoverLineRef` = `lineRef`; `sourceRecord.recordId` = CR `_id` | `versionNo`, `supersedesVersionId`, `sourceRecord.sourceVersion` = CR `updatedAt`, `publication.state` (`SalesHandoverVersion.js:62-122`) | `companyId` required | 1 row, fixture; `sourceRecord.recordId` → not found | Code **OK**; live **fixture only** |
| B4 | Handover → Merchandising file | receipt `handoverVersionId` (id) → file `currentHandoverVersionId` (id); file keyed by text `handoverRef`+`handoverLineRef` (`ExecutionFile.js:79-80,233`) | `revision`, `sourceVersionHistory[]` | `companyId` | 1 receipt ACCEPTED → 1 file | Code **OK**; file stores no CR id — reaches order only via the version (`fileDemandRelease.service.js:120-129`) |
| B5 | Order line → approved selection | via file only (`SelectionRevision.js:114,331`) | `revisionNo`, DRAFT→APPROVED→SUPERSEDED | `companyId` | not traced (no real file) | **Not consumed downstream** ✔ — see B7 |
| B6 | Order line → R&D style / costing | `sampleStyleId` on CR item (`:96`); costing ↔ style by **`{enquiryId, productName}`** (`technicalSource.service.js:361-368`, `costingContext.js:93-95`) | `CostingVersion.versionNumber`, APPROVED; style `techSheet.technical.revision` | Costing `companyId`; SampleStyle **none** | 0 CRs with `sampleStyleId` | **Ambiguous** — name join |
| B7 | Line → demand | `DemandRelease {orderId, lineRef, costingVersionId, requirementRevision}` (`DemandRelease.js:57-73`) | `supersedes/supersededByReleaseId`, `releaseKey` | `companyId` | 1 row, fixture; `orderId`/`costingId`/`costingVersionId` → not found | Code **OK but** no `executionFileId`, no selection ✔; priced line found by **first `sampleStyleId` match** (`orderDemandRelease.service.js:395-400`) |
| B8 | Demand → Purchase | `demand.spendRequestIds` (forward only); SpendRequest carries costing ids, order/line only in text `purpose` (`:978`) | costing version | SpendRequest `companyId` | — | **Broken backwards** — PO → line needs reverse lookup |
| B9 | Purchase → receipt | PO line `_id` → GRN `poItemId` (`GoodsReceipt.js:21`) | GRN immutable | GRN `companyId` required; PO optional (`:265`) | 103 legacy POs, 0 with `spendRequestId`, 3 with `companyId`; **0 GRNs**; 1 `storepurchaseorders` (text-only model) | Code **OK**; live **no receipts** |
| B10 | Receipt → roll/lot/shade | none — not captured (`GoodsReceipt.js:18-54`); `Barcode` per roll has no `goodsReceiptId`, no `companyId` (`Barcode.js:3-16,59-69`) | — | — | — | **Missing** |
| B11 | Material → WorkOrder issue | none. `quantityIssued` only ever `0` ✔; `StockIssuance.manufacturingOrder` → CR not WO, refuses order-linked issue (`stockAdjustments.js:427-437`); MRF has no WO link (`MRF.js:206,250`) | — | — | — | **Missing** |
| B12 | Order line → WorkOrder | `customerRequestId` + `stockItemId` + `variantId` (`WorkOrder.js:230,270-279`); **no line ref** | none; `planningState` set once, never moved ✔ | **none** | 143 WOs, all with `customerRequestId`; traced order 10/10 WOs match its items by `(stockItemId, variantId)`; 0 with `planningState` | **Id-based but not line-based** — two lines of one stock item/variant are indistinguishable; creation falls back to `variants[0]` (`quotationRoutes.js:3013-3016`) |
| B13 | WorkOrder → IE / PPC | IE ↔ WO only via shared `sampleStyleId` (`ieReleaseImpact.service.js:579`); PPC on main = receipts only, `booksCapacity:false` (`ieReleaseAck.service.js:505`) | `IeRelease` ISSUED/SUPERSEDED | IE `companyId` | 0 PPC receipts | **Missing** — PPC planning branches not merged (see §1c) |
| B14 | WorkOrder → cutting | `entries[].woId` (`CuttingMasterRecord.js:10-17`) — nullable from body (`bulkCuttingRoutes.js:221`) | none | none | traced order: 3 records by `woId` | **OK (partial)** — no lay, layers, consumption, wastage |
| B15 | WorkOrder → production scans | barcode text `WO-<short>-<unit>[-<op>]` (`server.js:2709-2724`); no WO id on scan docs | none | none | 0 short-id collisions across 143 WOs today | **Ambiguous by design** — 8-hex suffix match (`server.js:2726-2733`) |
| B16 | WorkOrder → QC | `DefectRecord.workOrderId` + `barcodeId` (`DefectRecord.js:62-67`) | `reworkRound` | none | **0 defect records** | Code **OK**; no severity, no AQL record |
| B17 | WorkOrder → packing | `packagedQuantity`, `packagingRecords[]` (`WorkOrder.js:453-465`) | none | none | traced: 150/150 | **No carton identity** |
| B18 | Packing → dispatch | challan `manufacturingOrderId` → CR (`DispatchChallan.js:49-54`); lines `workOrderId` optional (`:7-23`) | none | **none** | 6 challans, 19 lines: `workOrderId` 0, `productRef` 19 | **Broken** at line level |
| B19 | Dispatch → invoice | none. Voucher `referenceNumber` = `requestId` text (FE:`app/accountant/sales-vouchers/new/page.js:1297`); `Acc_Invoice.customerRequestId` has no writer | voucher GST/e-way | voucher `companyId` | 0 `acc_invoices`; 1 Accounts proforma, no order link | **Broken** |
| B20 | Invoice → closing | payment and cost **unavailable** (g03). Ownership proof in the current tree tries `salesOrigin.enquiryId` first, then the Account-customer chain with a cross-company refusal (`services/closingVerdict.js` header) — a later change than the g03 trace §6, which describes one chain | — | — | — | **Blocked (by design, G03)** |

### 1c. PPC integration — verified, not assumed

- Backend `codex/ppc-planning-foundation` (tip `90fc4a9`) and
  `codex/ppc-capacity-planning` (tip `5f7d15e`) are **not ancestors of
  `MAIN_SUB_BRANCH` HEAD `f57a2f6`**; `5f7d15e` exists but is not in HEAD.
- Frontend: neither branch is an ancestor of HEAD `710c7fb`.
- **What main does have:** a PPC *receipt* layer — `/api/cms/ppc`
  (`server.js:1681,1688`) with inbound Merchandising packs
  (`inboundPacksRoute.js`) and IE release receipts (`ieReleasesRoute.js`),
  models `DownstreamHandoverReceipt` / `IeReleaseReceipt`, and one frontend
  screen `FE:app/ppc/engineering-releases/page.js`. No planning, booking or
  capacity code; no PPC file references WorkOrder or ProductionSchedule. Live:
  0 rows in both PPC receipt collections. No frontend screen for inbound packs.

---

## 2 · Writers and readers

Every HTTP path is the full mounted path. "Unmounted" means the file exists but
`server.js` does not mount it.

### 2a. Order-line identity (`lineRef`, `handoverLineRef`, `productLineRef`)

| Kind | Writer / reader | Where |
|---|---|---|
| Mint `lineRef` | CR pre-validate hook → `ensureLineIdentities` | `CustomerRequest.js:1354-1364`, `customerRequestLineIdentity.js:75-108` |
| Carry `lineRef` on edit | `carryLineIdentities` — **falls back to first unclaimed line with the same `stockItemId`** (heuristic) | `customerRequestLineIdentity.js:135-167`; callers `routes/CMS_Routes/Sales/customerRequests.js:720`, `routes/Customer_Routes/CustomerRequests.js:785`, `routes/Customer_Routes/EditRequests.js:178` |
| Backfill `lineRef` | script, dry-run unless `--apply --authorized-by`; rollback via `updateOne` | `scripts/backfill-customer-request-line-refs.js:143-213` |
| Write `handoverLineRef` | `issue()` / `cancel()` via `POST /api/cms/sales/merchandising-handovers/requests/:requestId/lines/:lineRef/{issue,cancel}` | `merchandisingHandover.service.js:328-545`; `routes/CMS_Routes/Sales/merchandisingHandovers.js:85,100` |
| Deliver to Merchandising | route-triggered only, no cron | `services/integration/salesHandoverDelivery.service.js:58`; `ops.service.js:217` |
| Read `handoverLineRef` | intake, execution, selection, PPC inbound | `handoverIntake.service.js:110,191,347`; `execution.service.js:151-161,535`; `selection.service.js:1223`; `ppc/inboundPack.service.js:164` — **no frontend reader** |
| Read `lineRef` for demand | `GET/POST /api/cms/merchandising/demand-release`, `…/files/:fileId/demand-release` | `executionRoute.js:108-152`; `orderDemandRelease.service.js:174,706,727` |
| Mint `productLineRef` | Enquiry pre-validate hook | `Enquiry.js:1123-1125`; `enquiryProductLineIdentity.js:53` |
| **Destroy** `productLineRef` | `PATCH /api/cms/crm/enquiries/:id` → `sanitizeProducts` drops it ✔ | `enquiries.js:1534,1680,523` |
| Carry `productLineRef` | `carryProductLineIdentities` — **never called in production** ✔; falls back to lower-cased product name | `enquiryProductLineIdentity.js:115-150` |
| Backfill `productLineRef` | script | `scripts/readiness/backfill-product-line-refs.js:46-64` |
| Namespace mix | PL- written into `MerchandisingIntakeLedger.handoverLineRef` | `developmentIntake.service.js:338` |

### 2b. WorkOrder status and `planningState`

| Writer | Mounted path | File:line | Sets |
|---|---|---|---|
| Create (Sales approve / internal order) | `POST /api/cms/sales/requests/:requestId/quotation/sales-approve`; `PATCH …/mark-internal-order` | `quotationRoutes.js:2927,3078,3235,3360` | new, `pending`; hook sets `planningState: not_started` (`WorkOrder.js:562-563`) |
| Create (sample production) | `POST /api/cms/crm/sample-styles/:id/production/submit` | `sampleStyles.js:3417,3547` | new |
| Create (person-wise variant) | `PUT /api/cms/sales/requests/:requestId/person/:employeeId` | `quotationRoutes.js:2043,2331` | new |
| Create (split) | `PUT /api/cms/manufacturing/work-orders/:id/allocate-raw-materials` | `workOrderRoutes.js:790,932` | new child, `parentWorkOrderId` |
| Create (return MO) | `POST /api/cms/manufacturing/return-requests/:id/create-mo` | `returnRequestRoutes.js:327,428,474` | new CR + WOs |
| Allocate | same as split | `workOrderRoutes.js:1010` | `partial_allocation` / `planned` |
| Cancel unrouted | `POST /api/cms/manufacturing/work-orders/:id/cancel-unrouted` | `:1326` | `cancelled` |
| Planning | `POST …/:id/complete-planning`, `POST …/bulk-plan` | `:1386,1591` | `scheduled` |
| Start | `POST …/:id/start-production` | `:1428` | `in_progress` |
| Vendor forward | `POST /api/cms/manufacturing/manufacturing-orders/share-to-vendor` | `manufacturingOrderRoutes.js:1252` | `forwarded` |
| PM manual mark | `POST /api/cms/manufacturing/manufacturing-orders/:id/work-orders/:woId/mark-stage` (no production-role guard) | `manufacturingOrderRoutes.js:1688,1777,1780` | `completed` / `in_progress` |
| Packaging | `POST /api/cms/manufacturing/packaging/done` | `packagingRoutes.js:156,253,256,1516` | `completed` / `in_progress` |
| Vendor | `POST /api/vendor/work-orders/work-orders/:id/{accept,reject,progress}` | `vendorWorkOrderRoutes.js:222,296,361,365` | `planned` / `cancelled` / `completed` / `in_progress` |
| Scan sync | `POST /api/cms/production/sync/manual` — **cron disabled** (`server.js:793`) | `productionSyncService.js:340-342,510` | forward-only status |
| Hard delete | customer purge | `customerPurge.service.js:98-100,206` | deletes |
| `planningState` after create | **none** ✔ | — | — |
| Unmounted legacy | `dispatchRoutes.js`, `markAsDoneRoutes.js`, `WorkOrder/productionCompletionRoutes.js`, `Barcode_Scan_Punchings/trackingRoutes.js` | — | not reachable |

Readers: `services/productionView.js:235,301` (Sales), `services/shipmentView.js:77,83`,
`services/manufacturing/moListProjection.js:81-99`, `routes/CEO_Routes/Production.js`,
`ieOrders.service.js:294,313,692,718`, `planningEvidence.js:334-351`,
`planningFacts.js:100`, `productionSchedule` (read-only), `closingVerdict.js`.

Live: `scheduled` 83, `completed` 56, `planned` 4; **none carries `planningState`**.

### 2c. Dispatch quantity

| # | Writer | Mounted path | File:line | Ledger |
|---|---|---|---|---|
| A | Challan create | `POST /api/cms/manufacturing/dispatch-challans` | `dispatchChallanRoutes.js:45-112` | **document only — touches no WO** ✔, no quantity check |
| B | Person-wise dispatch | `POST /api/cms/manufacturing/packaging-dispatch-view/dispatch/person-wise` | `packagingDispatchViewRoutes.js:923-1041` | `dispatchedQuantity` + `dispatchRecords` |
| C | Bulk dispatch | `POST …/packaging-dispatch-view/dispatch/bulk` | `:1048-1101` | `dispatchedQuantity` + `dispatchRecords` |
| D | MO bulk dispatch | `POST /api/cms/manufacturing/manufacturing-orders/:id/dispatch-bulk` (no frontend caller found) | `manufacturingOrderRoutes.js:1585-1623` | `bulkDispatchHistory` |
| E | PM mark-stage (dispatch) | `…/:id/work-orders/:woId/mark-stage` | `:1763-1771` | `bulkDispatchHistory` |
| F | Legacy | `dispatchRoutes.js` **unmounted**; FE `EmployeeTrackTab.js:439` still POSTs to it → 404 | — | — |

Readers split by ledger: `dispatchedQuantity` → `closingVerdict.js:70`,
`closingReport.js:103`, `shipmentView.js:83`, `Acc_vouchers.js:1786` (invoice
line quantities), `CustomerReturns.js:113`; `bulkDispatchHistory` →
`productionActual.service.js:271`, `manufacturingOrderRoutes.js:1504-1527`;
`OrderTracking.js:113-115` uses the larger of the first ledger and ignores the
second. **A PM-marked dispatch never counts as delivered for closing.** No cron,
import or script writes either ledger.

### 2d. Closing state

| State | Writer | File:line |
|---|---|---|
| Journey closed (`stageStates.retention = complete`) | stage route `close` only (G03 gated) | g03 trace §1 |
| `CustomerRequest.status` ∈ `shipping/delivered/completed` | `PATCH /api/cms/sales/requests/:requestId/status` — **writes the body value with no transition check** | `customerRequests.js:521-535`; FE `app/ceo/dashboard/sales/page.js:57,151` (offers invalid values) |
| CR status from quotation | sync | `quotationRoutes.js:77-87` |
| `WorkOrder.status = completed` | packaging, mark-stage, sync, vendor (see 2b) — **production-based, ignores dispatch** | — |
| `ProductionCostCloseout.closedAt` | `PUT/POST /api/cms/production-closeout/:workOrderId/{draft,close,correct}` — `WorkOrder.findById` without company filter | `productionCloseout.service.js:192,350-503`; `productionCloseout.js:79,96,112` |

Live: CR statuses `pending` 12, `quotation_sales_approved` 11, `quotation_draft` 2
— **no order has ever reached `production`/`shipping`/`delivered`/`completed`,**
even the traced order whose 10 WorkOrders are `completed` and fully dispatched.

---

## 3 · Field matrix

**Status:** **P** present (stored) · **D** derivable from stored facts ·
**M** missing · **A** ambiguous (stored, but not provably the fact asked for).
Owner is the approved authority from the plan §3; "Source" is the exact file
holding the field today.

### 3a. PDF format 1 — Fabric Inspection Report (owner: Quality; custody Store)

| Field | Status | Source |
|---|---|---|
| Report No. / Date | M | no fabric-inspection record |
| Buyer / PO No. / Style No. | A | GRN → PO has no order/style link (B8) |
| Fabric vendor | P | `GoodsReceipt.supplierId` / `supplierName` snapshot (`GoodsReceipt.js:70-71`); PO vendor |
| Fabric type / quality | P | GRN line `rawItemId`, `itemName`, `variantCombination` (`:25-28`) |
| Invoice / challan no. | P / A | supplier `invoiceNumber` (`:81`); no separate challan-number field |
| Total rolls received | M | no roll identity (B10) |
| Total metres/yards received | P | GRN line `receivedQuantity` + `conversionFactor` (`GoodsReceipt.js:34-37`) |
| Rolls inspected (%) | M | — |
| 4-point system, total points, points/100 sq yd, pass criterion | M | Store inspection is a quantity split only (`GoodsReceiptInspection.js:29-32`) |
| Defects found, shade band | M | — |
| Result pass/fail/hold | A | accepted/quarantined/rejected **quantities**, no verdict field |
| Checked by | P | `inspectedBy` (`GoodsReceiptInspection.js:64-65`) |
| Approved by | M | — |

### 3b. PDF format 2 — Material/Trim Receiving Report (owner: Store/Purchase)

| Field | Status | Source |
|---|---|---|
| Report No. / Date | P | `GoodsReceipt.receiptNumber`, `receiptDate` (`:63,82`) |
| Buyer / PO No. / Style No. | A | supplier PO **P** (`purchaseOrderId`, `poNumber`); buyer/style **M** (B8) |
| Vendor | P | PO vendor; GRN snapshot |
| Material type | P | raw item category |
| Ordered qty | P | GRN line `quantityOrdered` (`:41`); PO `items.quantity` |
| Received qty | P | GRN line `receivedQuantity` (`:34`) |
| Expected date | P | PO `expectedDeliveryDate` (`PurchaseOrder.js:311`, line `:52`) |
| Actual received date | P | `receiptDate` — **client-supplied** (`goodsReceipt.service.js:269`) |
| Delay (days) | D | expected vs receipt date; not stored (only outstanding lines computed, `poExceptionsRegister.service.js:115-125`) |
| Quality status OK/Reject | A | quantity split + Disposition RELEASE/REJECT (`GoodsReceiptDisposition.js:42`) |
| Shortage / excess | P / A | shortage `pendingAfter` (`GoodsReceipt.js:44`); excess refused on new, computed for legacy (`poReconciliation.service.js:241`) |
| Remarks | P | `GoodsReceipt.notes` (`:83`) |
| Received by | P | `recordedBy` (`GoodsReceipt.js:89-92`) |

### 3c. PDF format 3 — PP Sample Report (owner: R&D, buyer decision via Sales)

| Field | Status | Source |
|---|---|---|
| Style No. / Buyer | P | `SampleStyle.sampleStyleId`, `styleCode` (`SampleStyle.js:142-145`); buyer via journey |
| Sample type: PP | P | `sample.rounds[].type` ∈ `proto,fit,sms,size_set,pp` (`:111`, `constants/crm.js:1106`) |
| Submitted date | P | round `madeAt` (`:118`) |
| Fabric / trims used | A | `techSheet.technical.materials[]` is the style's current spec, **not** the round's actual (`:480-607`) |
| Measurement spec vs actual | M | no per-round measurement actuals |
| Construction check | M | only free-text round `note` |
| Buyer comments | P | round `feedback` (`:115`); `customerApproval.log[]` (`:1121`) |
| Approval status | A | `outcome` ∈ pending/accepted/rejected/superseded — **no "approved with comments"** |
| Approved date | P | round `judgedAt` (`:116`) |

### 3d. PDF format 4 — Job Order / Work Order (owner: PPC; record: Production)

| Field | Status | Source |
|---|---|---|
| Job order no. / date | P | `workOrderNumber` (`WorkOrder.js:229`), `createdAt` |
| Buyer / Style / PO | A | buyer `customerName` snapshot (`:282-283`); style `sampleStyleId` sparse (`:264`); PO on journey only |
| Order qty (size-wise) | A | one WO per variant — size-wise is **the set of WOs**, not a breakdown on one |
| Fabric / trims allocated | A | `rawMaterials[].quantityAllocated` is a snapshot of stock availability (`workOrderRoutes.js:978-1005`) |
| Production line no. | M | no line field (§3f) |
| Planned start / end | A | `ProductionSchedule` per-day slots (`ProductionSchedule.js:8-126`); PPC planning not on main |
| Cutting instructions | M | — |
| Special instructions | A | free text notes |

### 3e. PDF format 5 — Cutting Report (owner: Production)

| Field | Status | Source |
|---|---|---|
| Cutting no. / date | P | `CuttingMasterRecord` `_id`, `date` string — **UTC, not IST** (`bulkCuttingRoutes.js:217`) |
| Style / Lay no. | P / M | style via WO; **lay no. M** |
| Fabric consumption planned vs actual | M | planned in costing/tech sheet; actual M (B11) |
| Total layers | M | — |
| Pieces cut (size-wise) | A | `entries[].quantityCut` per WO = per variant (`CuttingMasterRecord.js:10-17`) |
| Wastage % | M | — |
| Cut panel issued to line | M | no line |

### 3f. PDF format 6 & workbook sheet **DPR** — Daily Production Report (owner: Production)

| Field | Status | Source |
|---|---|---|
| Date | P | scan ledgers (`ProductionTracking.js:64`, `ProductionCompletionScanRecord.js:6`) |
| Line no. | **M** | no physical line master; only machine/operator (`ProductionTracking.js:5-45`) |
| Buyer / Style / Order no. / PO | A | via barcode → WO short id (B15) |
| Order quantity | P | `WorkOrder.quantity` |
| Supervisor name | M | — |
| Total manpower | M | no attendance ↔ line link |
| Shift | A | `ProductionSchedule` shift minutes (planned, not actual) |
| **Hour / time slot** | D | scan timestamps (`barcodeScans.timeStamp`) |
| Target qty | A | `IeCapacityStandard` per-line pieces/hour is an engineering standard (`IeCapacityStandard.js:3-52`), not a PPC target |
| Produced / achieved qty | D | two ledgers — tracking scans **and** completion scans, plus PM synthetic barcodes (`manufacturingOrderRoutes.js:115-119`) — **A** until one is chosen |
| Rejected qty | D | `DefectRecord.status = rejected` (0 live rows) |
| Cumulative produced | D | `productionCompletion.overallCompletedQuantity` (`WorkOrder.js:180-192`) |
| Efficiency % | M | needs actual labour minutes (no denominator) |
| Defect qty / DHU | D / M | defects D; DHU needs inspected-unit denominator (M) |
| Rework qty | D | `DefectRecord.status = defective`, `isRework` (`:87,127-128`) |
| Reason for shortfall | M | — |
| Balance qty | D | quantity − cumulative |
| Prepared / checked / approved by | M | — |

### 3g. PDF format 7 & workbook sheet **Final Inspection Report** (owner: Quality)

| Field | Status | Source |
|---|---|---|
| Buyer / Style / Order / PO | A | via WO |
| Inspection date | M | no final-inspection record |
| Total order qty | P | CR / WO quantity |
| Qty offered / carton-lot selected | M | no carton or lot (B17) |
| AQL level | A | buyer **default** only: `garmentSalesProfile.defaultAqlLevel` (`Account.js:81`) — not an order-level plan |
| Sample size (per AQL) | M | no sampling plan |
| Critical / Major / Minor | **M** | no severity field anywhere; `QCDefectType.category` only (`QCDefectType.js:67`) |
| Defect description | D | `DefectRecord.defects[].types[]` (`:49-57`) |
| Measurement check | M | — |
| AQL result pass/fail | M | a QC stage verdict is per piece, not a lot |
| Remarks / corrective action | M | — |
| Inspector | P | `DefectRecord` inspector fields (`:131-137`) |
| Approver | M | — |

### 3h. PDF format 8 — Delivery Challan (owner: Logistics; transitional Packaging & Dispatch)

| Field | Status | Source |
|---|---|---|
| DC no. / date | P | `challanNumber` `DC-YYYYMMDD-NNNN` — count-based, can collide under concurrency (`dispatchChallanRoutes.js:19-30`) |
| Buyer / ship-to | P / M | `customerName`, `customerInfo` snapshot (`DispatchChallan.js:56-58`); ship-to M |
| PO / Style | A | style `productName`/`productRef` text; PO M |
| Carton count | M | — |
| Total qty (size/colour) | A | `variantAttributes[{name,value}]` free pairs (`:7-23`) |
| Vehicle / transporter / e-way no. | **M on challan** | exist only on the sales voucher (`Acc_VoucherModels.js:510-524`) |

### 3i. PDF format 9 — E-way Bill (owner: Finance)

| Field | Status | Source |
|---|---|---|
| E-way no., date, validity | P | `voucher.eWayBillDetails.{ewbNumber, ewbDate, validUpto}` (`Acc_VoucherModels.js:511-513`) |
| From / to address | P | voucher parties + `Acc_Company` |
| Invoice no. & value | P | the voucher itself |
| HSN | P | line `hsnCode` (`:88`) |
| Transporter id, vehicle | P | `transporterId`, `vehicleNo` (`:514-521`) |
| Link to challan / order | **M** | e-way routes reference no DispatchChallan, CR or WO (`Acc_ewayBill.js`) |

### 3j. PDF format 10 — Order **Closing** Report (owner: derived; Sales decision)

| Field | Status | Source |
|---|---|---|
| Buyer / PO / Style | A | journey + CR; PO on journey only |
| Order qty vs shipped qty | A | shipped from `dispatchedQuantity` — **one of two ledgers** (§2c) |
| Shortage / excess | D | same caveat |
| Fabric utilisation | M | no issue record (B11) |
| Total rejections | D | `DefectRecord` (0 live) |
| Final invoice no. | M | no invoice ↔ order id (B19) |
| Payment status | M | unavailable by design (g03) |
| Order closing date | P | `SalesJourney.closedAt` |
| Remarks / learnings | M | — |

### 3k. Workbook sheet **OCR** — Order **Confirmation** Report (owner: Sales)

| Field | Status | Source |
|---|---|---|
| Buyer name | P | CR `customerInfo`; Account `companyName` (`Account.js:174`) |
| Confirmation date | A | quotation sales-approval time; no confirmation record |
| Style / design no. | A | CR item `stockItemName`/`stockItemReference` (`CustomerRequest.js:112-117`); `sampleStyleId` 0 live |
| PO number | P | `SalesJourney.po.number`; `quotations[].poProof` (`CustomerRequest.js:752-762`) |
| Order date / delivery date | P | CR `createdAt`; journey/handover deliveries |
| Fabric details / colour | A | variant attributes; handover projection |
| Trims / accessories | M | not on the order |
| Price per piece | P | quotation item price |
| **Size-wise qty (S…XXL, Others)** | D | `items[].variants[]{attributes, quantity}` (`:7-66`) — **dynamic sizes, not fixed S–XXL** |
| Unit price / total value | P | quotation items |
| Special instructions | A | notes |
| Confirmed by / approved by | M | no signed confirmation; PO file not stored (FE `PoUpload.js:14-18`) |
| (Report itself) | **M** | no Order Confirmation Report or PDF exists in either repo |

### 3l. PDF Part 3 — Buyer master (owner: Sales)

| Field | Status | Source |
|---|---|---|
| Name, code | P | `Account.companyName`, `accountId` (`:174,171`) |
| Address, country | P | `:223,226` |
| Contact person | P | `primaryContact` (`:280`) → CRMContact |
| GST / tax | P | `gstNumber`, `taxRegistrationNumber` (`:179,181`) |
| Payment terms | A | `creditDays` on Account (`:237`); full terms on Enquiry (`Enquiry.js:163`) and journey (`SalesJourney.js:311`) — three places |
| Currency | P | `defaultCurrency` (`:231`) |
| Tech pack / size chart | A | on `SampleStyle` tech sheet, per style, not per order |
| Fabric spec, testing, AQL, packing | P (defaults) | `garmentSalesProfile.{requiredCertifications, defaultTestingProtocol, defaultInspectionStandard, defaultAqlLevel, buyerManualRef, packagingManualRef}` (`Account.js:75-111`) — buyer defaults, **not order snapshots** |

### 3m. PDF formats with no source at all

Wash Report, Finishing Report, PP Meeting Minutes, Lab Test Report, Inline
Inspection Report as a report (defects exist; report and denominator do not),
DHU Report, Packing List, Shipment Advice: **M**. Stage-level coverage for all
24 PDF stages is already in the product plan §4 and is not repeated here.

---

## 4 · Acceptance scenarios (for later slices)

Both are **specifications**, to be built as isolated test fixtures — not live
data. Refs are illustrative shapes, never real records.

### S1 — Normal domestic bulk order

One buyer Account (company A, `linkedCustomer` set), one Sales-confirmed order,
**one style, two colours × four sizes = 8 order lines**, one delivery drop.

1. Enquiry with two product lines (`PL-…`), edited twice — **refs survive both edits**.
2. Proforma → CustomerRequest; each item carries its `productLineRef` and a minted `lineRef`.
3. Sales issues handover v1 per line; Merchandising accepts → one execution file per line.
4. Approved costing version; demand released per line; one SpendRequest → one supplier PO.
5. **Partial** GRN (70%), then balance GRN; inspection accepts all; put-away.
6. Material issued **against the WorkOrders** (requires B11).
7. 8 WorkOrders, each carrying its order line (requires B12); one cutting session per colour.
8. Production scans on one line/shift; one inline defect reworked and passed.
9. Final inspection on the packed lot passes.
10. Packed into cartons; one challan whose lines each name a WorkOrder; one sales voucher/invoice linked to the order by id; receipt recorded.
11. Close: every check `met` from its authoritative source.

**Pass when:** every boundary B1–B20 resolves by id from the delivered line
back to its enquiry product line; a report built from each department's record
matches its source; nothing is joined by name, buyer or PO text.

### S2 — Partial / failed order

Same shape, with these failures injected:

- Enquiry product renamed after costing → **costing lookup must still resolve by id** (today: by name — fails).
- Two order lines share one `stockItemId` + variant (a repeat line) → WorkOrders, demand pricing and challans must keep them apart.
- GRN short-received and one roll quarantined; issue must not exceed released quantity.
- Final inspection **fails**, lot reworked and re-inspected.
- Dispatch split over two challans; **one dispatch recorded through PM mark-stage** → must count once, in one ledger.
- No invoice raised → close refused with *payment unavailable*, not *unpaid*.
- A second company's order links to the same portal customer → nothing crosses.
- The Sales order is superseded by a successor → old and new line refs mapped, not silently re-minted.

**Pass when:** each failure appears as a named, source-linked gap — never as a
zero, a pass, or a merged count.

---

## 5 · G01 prerequisites

### 5a. Must be settled before G01 can hold

| # | Prerequisite | Why | Owner | Type |
|---|---|---|---|---|
| P1 | Apply the existing `lineRef` backfill to the 25 live orders (dry run first; `--apply --authorized-by`) | 0/25 orders have a line identity; the contract has nothing to key on | Sales | **decision + authorised run** — no new code |
| P2 | Remove or quarantine the smoke fixture in live Atlas (1 handover, receipt, file, demand release, all dangling) | It is the only "new chain" record and points at nothing | Sales + Merchandising + platform | **decision** — not done here |
| P3 | Stop `PATCH /enquiries/:id` re-minting `productLineRef` | A pre-order identity that changes on every edit cannot anchor a contract | Sales | small code — **the recommended first G01 task (§6)** |
| P4 | Choose the one dispatch ledger (`dispatchedQuantity` vs `bulkDispatchHistory`) | Any envelope carrying "dispatched" is ambiguous until then | Logistics / Packaging & Dispatch | **decision** (then G15/G16 code) |
| P5 | Decide PPC branch integration | B13 cannot be specified against code that is not on main | PPC + platform | **decision** |
| P6 | Decide whether `carryLineIdentities`' same-`stockItemId` fallback stays | It is a heuristic reassignment of line identity on edit | Sales | **decision** |

### 5b. Explicitly excluded — already exists, do not rebuild

- A new order or line master — `CustomerRequest` + `items[].lineRef` + `SalesHandoverVersion` exist.
- A new line-ref minting scheme or backfill script — `customerRequestLineIdentity.js`, `scripts/backfill-customer-request-line-refs.js`, `scripts/readiness/backfill-product-line-refs.js` exist.
- A new handover, intake, execution-file or demand-release command — `merchandisingHandover.service`, `handoverIntake.service`, `execution.service`, `orderDemandRelease.service` exist.
- A second BOM editor or demand release — per roadmap G04.
- A second GRN, inspection, disposition or put-away ledger — Store & Purchase has them.
- A second scan ledger or actuals counter — two already exist (§3f).
- A second e-way-bill generator — `Acc_ewayBill.js` exists.
- Closing-verdict work — done in G03.

---

## 6 · Smallest implementable G01 task

**G01a — Keep the pre-order line identity across Enquiry edits.**

The frontend already sends each product row back as loaded, including its
`productLineRef` (FE `components/sales/crm/journey/stages/EnquiryStage.js:975`
→ `lib/salesJourney/adapter.js:461`). The server discards it:
`sanitizeProducts` (`routes/CMS_Routes/Sales/enquiries.js:523-570`) rebuilds
each row without it, `PATCH /:id` assigns the result (`:1680`), and the
validate hook (`models/CMS_Models/Sales/Enquiry.js:1123-1125`) mints fresh refs.

- **Change:** in `sanitizeProducts`, pass through an incoming `productLineRef`
  **only if the enquiry already holds that exact ref**; unknown, foreign or
  malformed refs are dropped and the hook mints a new one. Id-only — **do not**
  use `carryProductLineIdentities`' name fallback
  (`enquiryProductLineIdentity.js:137-138`).
- **Refuse** a payload that assigns one held ref to two rows.
- **Tests** (extend `test/merchandising/preorder-development.route.test.js`):
  a product edit keeps every ref; reordering rows keeps each row's own ref; a
  renamed product keeps its ref; a new row gets a new ref; a forged ref from
  another enquiry is not accepted; one ref on two rows is refused; a
  `DevelopmentFile` keyed on the ref is still reachable after the edit.
- **Out of scope:** costing's product-name key (`costingContext.js:93-95`),
  successor-order mapping, the `lineRef` backfill.

Why this one: it is one function and its tests, needs no decision from §5a, no
schema change and no data migration, and it stops the only live writer that is
currently **destroying** a permanent line identity. The next G01 step —
carrying `lineRef` onto new Sales-origin WorkOrders at
`quotationRoutes.js:2927-3078` — depends on P1.
