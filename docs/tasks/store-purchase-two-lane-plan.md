# Store & Purchase simplification — two-lane delivery plan

> **Status:** Active coordination boundary, 28 September 2026.
>
> **Purpose:** Allow two implementation lanes to simplify Store & Purchase in
> parallel without editing the same application surfaces or inventing competing
> workflow contracts.

Durable product direction:
`docs/product/store-purchase-simplification-plan.md`.

## Shared baseline — frozen while both lanes run

Phase 1 navigation is the shared baseline. Neither lane changes it without an
explicit coordination decision:

- `components/Store_DashboardLayout.js`
- `components/shell/TopBar.js`
- `components/shell/FrostShell.js`
- `components/store/navigation/nav.test.mjs`
- `/store/dashboard` and `/store/dashboard/overview`

The six top-bar areas remain Overview, Requests, Purchase, Receive, Inventory,
and Masters. The settings gear remains separate.

Both lanes preserve all backend safety contracts: tenant scope, capabilities,
idempotency, action history, strict units, Accounting ownership, and existing
operational URLs.

## Non-negotiable feature-preservation gate

Simplification may consolidate presentation, but it must not remove a feature.
Before either lane hides, replaces, redirects, or retires any current screen,
it must produce a feature-parity matrix containing:

- current route and visible action;
- user role/capability that can perform it;
- API and mutation used;
- new workspace location or preserved deep link;
- desktop and mobile/scanner access path;
- focused regression test;
- parity status and any known limitation.

Every current action must be classified as one of:

1. **Presented in the consolidated workspace**;
2. **Preserved through a direct contextual link**;
3. **Preserved unchanged on its existing route**.

“Not shown”, “not linked”, and “planned for later” do not count as parity.
Existing routes stay available throughout the transition. A screen may leave
normal navigation only after every feature it owns has a tested destination.
No destructive migration or legacy-route retirement belongs to either
parallel lane.

## Lane A — Purchase simplification

Lane A owns the Purchase workspace and only the purchasing side of the request
handoff.

### In scope

- Stage-based Purchase workspace: To source, Draft orders, On order, Completed
- Purchase-order register/detail presentation
- Service-order register/detail presentation
- Supplier-offer comparison and editing within purchasing context
- Sourcing-decision presentation within purchasing context
- Purchase exceptions shown on the affected order/line
- Purchase-specific pure helpers and tests
- Purchase read adapters where existing endpoints need one presentation shape

### Frontend ownership

- `app/store/dashboard/operations/purchase-order/**`
- `app/store/dashboard/operations/service-orders/**`
- `app/store/dashboard/supplier-offers/**`
- `app/store/dashboard/operations/purchase-exceptions/**`
- `components/store/purchase-order-*/**`
- `components/store/service-orders/**`
- `components/store/supplier-offers/**`
- `components/store/purchase-exceptions/**`

### Backend ownership, only if required

- Purchase-oriented reads under operational purchase-order/service-order and
  sourcing routes/services
- No receipt posting, inspection, put-away, customer-material, stock, or
  location mutation code

## Lane B — Receive simplification

Lane B owns the complete arrival-to-disposition experience for purchased and
customer-owned material.

### In scope

- One Receive workspace with Expected, Arrived — action required, and Completed
- Purchased/customer-owned type filter in the same experience
- Receipt detail as the one place for inspection, put-away, quarantine,
  disposition, and supplier-return actions
- Clear ownership badge so customer material is never presented as purchased
- Receiving-specific next-action derivation, blockers, and completion state
- Receiving pure helpers and tests
- Read-only aggregation/adapters needed to compose the workspace from existing
  authoritative documents

### Frontend ownership

- `app/store/dashboard/operations/goods-receipts/**`
- `app/store/dashboard/operations/customer-materials/**`
- `components/store/goods-receipts/**`
- `components/store/goods-receipt-entry/**`
- `components/store/customer-materials/**`
- New receiving-only helpers under `components/store/receiving/**`

### Backend ownership, only if required

- `routes/CMS_Routes/StorePurchase/goodsReceipts.js`
- `routes/CMS_Routes/StorePurchase/customerMaterials.js`
- Receiving-only read adapters/services under `services/storePurchase/`
- Receiving DTO/presentation tests

Lane B must not change the purchase-order mutation engine or duplicate receipt
posting. Purchase orders remain the source for expected purchased arrivals;
GoodsReceipt and CustomerMaterialLot remain the authoritative receipt evidence.

## Files neither lane owns during parallel work

- Store navigation and shell files listed in the frozen baseline
- `app/store/dashboard/order-requests/**`
- `app/store/dashboard/raw-items/**`
- `app/store/dashboard/locations/**`
- reservation, stock-count, stock-ledger, location, valuation, and inventory
  exception files
- material/service/supplier master forms unless a separate owner is agreed
- Accounting, Manufacturing, Merchandising, HR, Sales, and shared authentication
  code
- durable plan changes, except through Codex review

## Cross-lane contract

1. Existing URLs remain stable. A lane may add internal tabs/views but does not
   redirect or delete the other lane's routes.
2. A lane may consume another domain's existing API but does not edit its files.
3. Shared DTO needs are documented before either lane changes a shared route.
4. No lane edits the same file concurrently.
5. Each lane maintains a changed-file list and checks it against this ownership
   table before every handoff.
6. Each lane runs focused tests for its surfaces. The combined Store suite and
   authenticated browser acceptance run only after both lanes land.
7. Build failures in unowned files are reported with evidence, never repaired
   opportunistically.

## Merge order

The lanes are functionally independent. Recommended integration order:

1. Phase 1 navigation baseline
2. Lane A Purchase or Lane B Receive, whichever finishes first
3. The other lane
4. Combined navigation/highlighting verification
5. Combined Store test/build/browser acceptance
6. Inventory simplification as the next separately owned phase

## Lane B first slice

Lane B begins with a read-only Receive composition and does not change stock:

1. audit the current Goods Receipts and Customer-supplied registers and detail
   DTOs;
2. define one receiving row and next-action vocabulary;
3. implement tested pure composition helpers;
4. reshape the Goods Receipts register into Expected / Arrived / Completed;
5. include customer-owned arrivals through an explicit type filter;
6. keep all mutations on their established detail routes and services;
7. prove no receipt, inspection, put-away, return, stock, or Accounting write
   changed.

Before implementation, Lane B records the receiving parity matrix for at least:

- expected purchased deliveries and partial receipts;
- customer-material expectations, short-close, and reopen;
- purchased and customer-material receipt recording;
- inspection;
- partial and multi-location put-away;
- quarantine release and rejection;
- supplier return and replacement visibility;
- customer-material lots, labels, movements, production targets, issues,
  customer returns, and available-quantity integrity;
- receipt search, filters, pagination, coverage warnings, detail evidence, and
  action history;
- location selection, unit conversion, idempotent retry, permission refusal,
  and reconciliation blockers.

If any row has no destination, Lane B preserves the existing screen and link;
it does not hide or remove it.

Lane B does not begin Inventory consolidation or modify Purchase files.
