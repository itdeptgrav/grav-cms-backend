# Store & Purchase Overview — Marketing rebuild

**Status: IMPLEMENTED against the source-read reference. Visual verification is
PENDING — no authenticated session is available.**

Proceeding without Lane B frozen was explicitly authorised. This pass touched
only Overview files; the Lane B files it links to were last written at 15:31 and
14:17 and were not opened.

## The one remaining gap

### Authenticated visual verification is impossible

§16 is titled **Mandatory visual verification**: *"Do not declare completion
from imports or automated tests alone,"* and *"Acceptance is based on the
rendered page composition, density, spacing, hierarchy and responsive
behaviour."* §1 requires opening the real Marketing Overview in an authenticated
session; §13 requires measuring actual bounding boxes.

`localhost:3001` redirects every route to `/?next=…`. No usable credential
exists: the only one in the repository (`scripts/demo/ppc-demo-server.js`)
belongs to a throwaway `MongoMemoryReplSet` that the script starts itself, not
to the running dev app.

**Consequence:** the reference was read from source, not measured, and the
rendered result has not been seen. Composition, primitives, states and
responsive construction are verified by test and by the kit's own behaviour.
Pixel geometry, visual density and side-by-side comparison with `/marketing`
are **not** verified and are not claimed.

---

## §1 Reference audit — read from source, not inferred

### Reference route

`/marketing` → `app/marketing/page.js` (951 lines).

### Real export paths

| Component | Import from |
|---|---|
| `MarketingPage` | `@/components/marketing/MarketingUi` |
| `MarketingPageSlab`, `SlabPill`, `SlabAction`, `SlabGhost` | `@/components/marketing/ui` |
| `MarketingMetricStrip` | `@/components/marketing/ui` |
| `MarketingActionQueue` | `@/components/marketing/ui` |
| `MarketingDataTable`, `TableValue`, `TableStatus` | `@/components/marketing/ui` |
| `MarketingNotice`, `NOTICE_MEANINGS` | `@/components/marketing/ui` |
| `MarketingSegmentedControl`, `MarketingControlBar` | `@/components/marketing/ui` |
| `MarketingSkeletonText`, `MarketingHoldWidth` | `@/components/marketing/ui` |
| `UNAVAILABLE` | `@/components/marketing/ui` |

Barrel: `components/marketing/ui/index.js`. The Overview also uses `Panel` from
`@/components/ceo/ui/Primitives` and helpers from
`@/components/marketing/overviewDashboard`.

### APIs that matter

- **`MarketingActionQueue`** — `[{ id, kind, what, why, who, href, ctaLabel,
  evidence, figure?, count? }]`, plus a skeleton sample
  `[{ kind, what, why, evidence, cta?, link? }]`. This is the attention-queue
  primitive §5 asks for; its shape already carries subject, reason, owner,
  action and destination.
- **`MarketingMetricStrip`** — `{ title, sub, columns, className }`, rendering
  `Panel padded={false}` over a `deck:grid-cols-{3..6}` deck grid.
- **`MarketingNotice`** — **refuses to render without an explicit `meaning`**
  from `NOTICE_MEANINGS`, and warns. Section errors and "valuation unavailable"
  must each name their meaning.
- **`SlabAction` / `SlabGhost`** — primary and quiet actions designed to sit
  *inside* the slab. This is what §3 means by not floating actions.
- **`UNAVAILABLE`** — the kit's own token, which §9 and §11 require instead of
  a zero.

### Composition to follow

`MarketingPage` → slab → metric strip → action queue → `MarketingDataTable`
sections using `TableStatus` / `TableValue`, with `Panel` + `PanelHeading` for
grouped lists. Gutters and max width come from `MarketingPage` itself — so **no
local `max-w-*` and no page padding**, which is precisely what §13 forbids.

---

## §14 Parity inventory — every current capability

Server read model: `GET /api/cms/inventory/overview/operations`
(`routes/CMS_Routes/Inventory/overview/operations.js`). Eleven computed sections
plus two link-only doors; all must survive.

| Section key | What it holds | Destination today |
|---|---|---|
| `requestsToClassify` | MRFs awaiting Store review | `/store/dashboard/order-requests` (+ per-row MRF detail) |
| `quotationsActive` | Live supplier quotations | `/store/dashboard/supplier-offers` |
| `posToIssue` | Draft purchase orders | `…/purchase-order?status=DRAFT` |
| `posToReceive` | Issued / partly received | `…/purchase-order` |
| `receiptsToInspect` | Receipts awaiting inspection | `…/goods-receipts` |
| `putawayPending` | Receipts awaiting put-away | `…/goods-receipts` |
| `reservationShortages` | Backordered reservations | `…/reservations?group=BACKORDERED` |
| `readyToPick` | Reserved and pickable | `…/reservations?group=READY_TO_PICK` |
| `partlyIssued` | Partly issued reservations | `…/reservations?group=PARTLY_ISSUED` |
| `serviceAcceptance` | Service orders awaiting acceptance | `…/service-orders` |
| `openStockCounts` | Stock counts in progress | `/store/dashboard/raw-items/stock-count` |
| `exceptions` | **link-only** — purchase/bill-match | `…/purchase-exceptions` |
| `stockExceptions` | **link-only** — inventory integrity | `…/stock-exceptions` |

Page-level: **Refresh**, **New purchase order**, the inventory-valuation link,
whole-page `ErrorState` with retry, per-section unavailability, permission and
tenant scoping.

Two facts the rebuild must not flatten:

- `exceptions` and `stockExceptions` are **deliberately link-only** — the route
  says the per-order reconciliation is expensive and belongs in its workspace:
  *"a door, not a fabricated number."* The new Overview must not invent counts.
- They are **kept separate on purpose** — *"never a combined count."*

### Destinations to re-point during the rebuild

The current Overview predates the A1 workspaces, so several links go to legacy
registers rather than the URL-backed stages §10 requires:

| Current | Should become |
|---|---|
| `…/purchase-order?status=DRAFT` | Purchase / **Draft orders** (`?stage=draft-orders`) |
| `…/purchase-order` | Purchase / **On order** (`?stage=on-order`) |
| `…/goods-receipts` (inspect) | Receive / **Action required** |
| `…/goods-receipts` (put-away) | Receive / **Action required** |
| approved needs (not shown today) | Purchase / **To source** |
| expected deliveries (not shown today) | Receive / **Expected** |

§10's warning — *"Do not link a spend-request ID to the generic work-order
route"* — is the defect already corrected in A1: a `SpendRequest` opens at
`/store/dashboard/order-requests/quote/{id}`, never `/order-requests/{id}`,
which reads `/api/cms/store/order-requests/{id}` and serves a different record.

### Valuation (§9)

`…/inventory-valuation` is the authoritative surface. Customer-owned material is
excluded from company inventory value while remaining visible in operational
receiving counts — the ownership split established in Lane B. No valuation
formula changes in a UI task.

---

## What was built

`app/store/dashboard/overview/page.js`, rewritten:

```
PageContainer
  MarketingPageSlab      icon · title · sub · status · pills · figures · hero
                         action = RoleGate > SlabAction (governed New PO)
                         onRefresh
  MarketingNotice        refresh failure — last good read left standing
  MarketingNotice        blocked / unavailable (whole page)
  MarketingActionQueue   Needs attention, ranked by what the work is
  MarketingNotice        "N sections could not be read", with its own Try again
  § Purchasing           MarketingDataTable ×3
  § Incoming and receiving   MarketingDataTable ×4
  § Inventory operations     MarketingDataTable ×4
  § Exceptions           two separate doors, no count
  § Stock value          a door, no figure
```

`components/store/overview/operations.mjs` gained `SECTION_DESTINATION` /
`destinationFor`, `slabFigures`, `attentionHero`, `actionQueue`, `overviewRow` /
`overviewRows`, `sectionsForBand`, `exceptionDoors`, and the `URGENCY` table.

### Notes on two deliberate departures

- **No kicker.** `MarketingPageSlab` has `icon`, `title` and `sub` and no
  kicker slot; the application name is carried by the shell. Hard-coding an
  eyebrow would be the Store-only styling §13 forbids.
- **Stock value is a door, not a figure.** The valuation workspace owns the
  ownership split — customer-supplied material is received and tracked but is
  never company inventory value. Printing a number here would be a second
  answer to a question that already has an authority, and would create the ₹0
  risk §9 warns about.

### Guards proven by neutralisation

Moving the action out of the slab, printing a zero for an unreadable figure,
ranking attention by array order, putting a count beside an exception door, and
reverting a destination to the legacy register — each failed its test, then
restored.
