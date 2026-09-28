# Lane B — Receive Slice B1 parity matrix and audit

> **Status:** Implementation record, 28 September 2026. Read-only composition.
> Durable direction: `docs/product/store-purchase-simplification-plan.md`.
> Coordination boundary: `docs/tasks/store-purchase-two-lane-plan.md`.

## 1. Audit of the current receiving surfaces

| Surface | Route / service | What it authoritatively owns |
|---|---|---|
| Goods Receipts register | `GET /api/cms/store/goods-receipts` | Recorded receipts, bounded newest-first scan (`GR_REGISTER_SCAN_CAP`, default 500), derived stage via `goodsReceiptControl.deriveControl` |
| Goods Receipt detail | `GET /api/cms/store/goods-receipts/:grnId` (+ `/control`) | Lines, movement evidence, action availability |
| Receipt control mutations | `POST :grnId/inspection`, `/putaways`, `/dispositions`, `/supplier-returns` | The only inspection / put-away / disposition / return authority |
| Customer-material register | `GET /api/cms/store/customer-materials` → `customerMaterial.register` | Issued + cancelled expectations, per-row `standing` from `customerMaterialReceipt.standingFor` |
| Customer-material detail | `GET :docId` (+ `/lots`, `/production-targets`) | Ownership lots, targets |
| Customer-material mutations | `POST :docId/receipts`, `/short-close`, `/reopen`, `/issues`, `/customer-returns`, `/lots/:lotId/labels` | The only customer-owned receipt / issue / return authority |
| Purchased expectation | `PurchaseOrder` `status ∈ {ISSUED, PARTIALLY_RECEIVED}`, `items[].pendingQuantity > 0` | Outstanding purchased arrivals |

### Authoritative vocabulary reused, not redefined

`goodsReceiptControl.STAGE` — `Awaiting inspection`, `Quarantine decision
required`, `Supplier return required`, `Awaiting put-away`, `Complete` — plus
its independent `flags` (`awaitingInspection`, `awaitingPutaway`,
`hasQuarantined`, `hasRejected`, `complete`). B1 derives no stage of its own.

Ownership comes from the explicit `GoodsReceipt.sourceType`
(`PURCHASE_ORDER` | `CUSTOMER_MATERIAL`), never from an absent supplier field.

## 2. Parity matrix

Classification per the two-lane gate: **(1)** presented in the consolidated
workspace, **(2)** preserved through a direct contextual link, **(3)** preserved
unchanged on its existing route.

| Current action | Route | Capability | Class | B1 destination |
|---|---|---|---|---|
| Expected purchased delivery / partial receipt | PO detail `/receive` | `sp.read` + receive | 2 | Expected tab row → existing PO receiving screen |
| Customer-material expectation, short-close, reopen | customer-materials detail | `sp.read` + receive | 2 | Expected tab row → existing customer-material detail |
| Record purchased receipt | PO `/receive` | receive | 3 | Unchanged |
| Record customer-material receipt | `POST :docId/receipts` | receive | 3 | Unchanged |
| Inspection | `POST :grnId/inspection` | inspect | 2 | Action-required row → GRN detail |
| Partial / multi-location put-away | `POST :grnId/putaways` | putaway | 2 | Action-required row → GRN detail |
| Quarantine release / rejection | `POST :grnId/dispositions` | disposition | 2 | Action-required row → GRN detail |
| Supplier return + replacement visibility | `POST :grnId/supplier-returns` | return | 2 | Action-required row → GRN detail |
| Customer-material lots, labels, movements, targets, issues, customer returns | customer-materials detail sub-routes | various | 3 | Unchanged |
| Receipt search / filters / pagination / coverage warning | register | `sp.read` | 1 | Workspace search + source filter + honest coverage |
| Receipt detail evidence + action history | GRN detail | `sp.read` | 3 | Unchanged |
| Location selection, unit conversion, idempotent retry, permission refusal, reconciliation blockers | detail mutations | various | 3 | Unchanged — B1 writes nothing |

No row is "not shown". Every existing route stays reachable.

## 3. Tab assignment rules

- **Expected** — never-recorded arrivals. Purchased: PO `status ∈ {ISSUED,
  PARTIALLY_RECEIVED}` with at least one `items[].pendingQuantity > 0`.
  Customer-owned: issued expectations whose `standing.lines[]` carry
  `pendingQuantity > 0`.
- **Action required** — recorded `GoodsReceipt` whose `deriveControl().flags`
  show `awaitingInspection`, `awaitingPutaway`, `hasQuarantined` or
  `hasRejected`.
- **Completed** — recorded `GoodsReceipt` whose `deriveControl().flags.complete`
  is true.

A receipt appears in exactly one of Action required / Completed; the flags are
mutually exhaustive over recorded receipts.

## 4. Next-action priority

Highest first, from authoritative flags only:

1. `hasRejected` → **Return rejected stock**
2. `hasQuarantined` → **Resolve quarantined stock**
3. `awaitingInspection` → **Inspect receipt**
4. `awaitingPutaway` → **Put away accepted stock**
5. `complete` → **View receipt**

Expected rows: purchased → **Receive against this order**; customer-owned →
**Record customer delivery**.

## 5. Safety invariants

B1 adds one `GET` and mutates nothing. No stock quantity, location balance,
reservation, PO receipt quantity, ownership lot, inspection / put-away /
disposition / return record, Accounting bill or payment, and no idempotency or
permission behaviour changes.

## 6. Lane A dependency

None. The workspace endpoint lives on the existing Lane-B-owned
`routes/CMS_Routes/StorePurchase/goodsReceipts.js` router and reads
`PurchaseOrder` through its model only. No Purchase-owned file is edited.
