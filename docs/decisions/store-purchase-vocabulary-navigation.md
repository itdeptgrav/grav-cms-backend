# Decision record — Store & Purchase vocabulary and navigation (Chunk 0)

> **Status: PROPOSED — awaiting business approval. Not adopted.**
>
> No business owner has signed off on any mapping in this document. It is
> the audit's *recommendation* of how the current vocabulary and navigation
> should map onto the product plan's Section 8 target
> (`docs/product/store-purchase-professionalization.md`), written so that the
> owners have something concrete to accept, amend or reject. Chunk 0's brief
> was to produce this proposal, not to obtain approval for it.
>
> Until an owner records approval here, later chunks must treat every
> mapping below as a draft: a chunk that renames or moves a live surface
> needs the relevant row approved first, and the ownership questions in §5
> and §9 answered.
>
> **Nothing in this record changes live labels, routes or navigation** —
> Chunk 0 is observation only.
>
> Baseline evidence for every claim: `docs/audits/store-purchase-baseline.md`.
>
> | Decision area | Approved by | Date |
> |---|---|---|
> | Application name "Store & Purchase" | *not yet approved* | — |
> | Canonical vocabulary (§2) | *not yet approved* | — |
> | Target navigation & route mapping (§3, §4) | *not yet approved* | — |
> | Owning application for the misplaced config pages (§5) | *not yet approved* | — |
> | Legacy retirement / redirect list (§6, §7) | *not yet approved* | — |
> | Status language (§8) | *not yet approved* | — |

---

## 1. Application name

**Proposed** (not approved): the launcher application becomes
**Store & Purchase**.

Recorded consequences before any chunk changes the live launcher:

- The tile name comes from **backend department data**
  (`components/shell/useMyApps.js` reads `slug`/`dashboardPath` from the
  departments the login returns), not from a frontend string. Renaming is a
  data/backend change; the `store` slug, `guardSlug="store"` shell check,
  `services/access/fulfilmentAccess.js` (dept slug `store`) and the login
  redirect map all key on the slug and must NOT change with the display name.
- `Store_DashboardLayout.js` deliberately renders the single word "Store" as
  the department label today (a previous "Store & purchase" label was
  trimmed); the shell label and launcher tile should change together or not
  at all.
- The Cowork/Requests apps describe the `mrf` app as "the request half of
  what `store` fulfils" — copy there references the Store app by name and
  will need the same pass.

## 2. Current term → canonical product term

| Current user-facing term | Where it appears | Canonical term (plan §8.3) | Notes |
|---|---|---|---|
| "MRF" (raw, often unexpanded) | desk, mrf-history, detail pages, numbers `MRF-…` | **Material request** (number stays `MRF-…`) | abbreviation only after first expansion |
| "Material Requests" (nav) vs "Request History" (nav) vs "Material Requests" (page title on mrf-history) | nav/pages disagree | **Material requests** (queue) / register named for what it is | two nav labels currently name the same concept |
| "Purchase Forms" / "Requisition" / `REQ-…` | operations/requisitions, MRF detail sidebar | **Purchase requisition** | today's Requisition is a pen-and-paper form that never becomes a PO in data; the canonical requisition of Chunk 4 is a different, governed document. Until then the legacy screen keeps its name with "(print form)" qualifier |
| "Purchase Orders" (operational) and "Purchase Order Sheet" (worksheet) | two registers, near-identical on-screen titles | **Purchase order** = the operational document ONLY | the worksheet becomes "PO print template / legacy PO sheets" wording; it must stop presenting Draft/Ordered/Received as an order lifecycle |
| "Order Requests" (route segment), "Material Requests" (its nav label) | `/store/dashboard/order-requests` | **Request desk** (working queue) | route segment renamed only in Chunk 10 |
| "Quote" / "Requote" | spend screens | **Supplier quotation** (supplier's answer) vs Store pricing | today's "quote" is Store's own pricing of a spend request, not a supplier document; RFQ/quotation vocabulary arrives with Chunk 5 |
| "Delivery" / "Delivery Note" | operations/delivery | **Goods receipt** (per plan) | today deliveries are aggregate, embedded records; GRN becomes real in Chunk 7 |
| "Receive Delivery" | PO detail/receive | **Record goods receipt** | |
| "Issue & Return" (nav) → "Stock Issue & Return" (title) | stock-adjustments | **Issues & returns** | one name |
| "Item Ledger" (nav) vs "Stock Ledger" (title) | stock-ledger | **Movement ledger** | plan vocabulary; also stop calling an editable history a ledger until Chunk 3 makes it immutable |
| "Accountability" | operations/accountability | **Movement report** (or fold into Movement ledger views) | "accountability" names a report, not a job |
| "Product Marking" (nav) for barcode-generator | nav | **Lot labels / barcodes** | |
| "Raw Items" | everywhere | **Items** (with item type) | plan §4.1 makes one item master; renaming waits for Chunk 2 |
| "Stock Items" | dead links from Store; real screens in other apps | **Finished goods** (owned outside Store & Purchase until the master merges) | remove Store's dead links in Chunk 10 |
| "In Stock / Low Stock / Out of Stock" derived statuses | RawItem | **Stock on hand / below minimum / none on hand** wording at UI level | derivation stays |
| Raw enums shown to users: `PARTIALLY_RECEIVED`, `SUBMITTED`, `PARTIALLY ISSUED` | PO register, requisitions filters, desk chips | Status language per plan §8.4 — state + who acts next | no raw enum strings in copy |
| "Vendors & Suppliers" | vendors pages | **Suppliers** | one word |
| "Assigned Teams (Operators)", "Registered Operations", "Devices / Machines", "Work Order Sheet" | Store configurations | not Store & Purchase vocabulary at all | see §5 |

## 3. Current route/screen → proposed future workspace

Target navigation is the plan's §8.2 tree (Overview / Purchase / Receive /
Inventory / Masters / Reports / Settings). Mapping of every current surface:

| Current route | Future workspace | Move type |
|---|---|---|
| `/store/dashboard/overview` | Overview | keep (single home) |
| `/store/dashboard` (old dashboard) | — | retire → redirect to Overview |
| `/store/dashboard/order-requests` (desk) | Purchase → Requisitions (+ Inventory → Issues & returns queues) | split by job in Chunk 10; MO queue moves out (§5) |
| `…/order-requests/mrf/[id]` | Material-request workspace (Inventory → Issues & returns) with purchase hand-off | decompose the 3,569-line page along plan §8.5 anatomy |
| `…/order-requests/intake/[id]`, `quote/[id]`, `requote/[id]` | Purchase → Requisitions (classification & pricing queues) | keep jobs, re-home |
| `/store/dashboard/operations/purchase-order/**` | Purchase → Purchase orders | becomes THE PO workspace |
| `/store/dashboard/configurations/purchase-orders/**` | Settings → print templates, or read-only legacy register | Chunk 6 decision executes; no new operational writes |
| `/store/dashboard/operations/requisitions` | Purchase → Requisitions (legacy print forms, read-only) | label as legacy |
| `/store/dashboard/operations/delivery/**` | Receive → Goods receipts / Expected deliveries | Chunk 7 replaces the data underneath |
| `…/purchase-order/[id]/receive` | Receive → Goods receipts | |
| `/store/dashboard/vendors-buyer/vendors/**` | Masters → Suppliers | |
| `/store/dashboard/raw-items/**` | Masters → Items (+ Inventory → Stock on hand) | catalogue vs stock views separate |
| `…/raw-items/stock-adjustments` | Inventory → Issues & returns | |
| `…/raw-items/raw-items-view/add-stock/[id]` | Inventory → Adjustments (permissioned) | direct stock-in becomes an adjustment/receipt, Chunk 3 |
| `/store/dashboard/operations/stock-ledger` | Inventory → Movement ledger | editing moves behind adjustment permissions |
| `/store/dashboard/operations/accountability` | Reports | |
| `/store/dashboard/operations/mrf-history` | Reports (read-only register) | its write actions collapse into the queue workspaces |
| `/store/dashboard/operations/barcode-generator`, `/store/dashboard/item-info` | Inventory → Lot labels / scan landing | keep; item-info stays route-stable (printed QRs point at it — treat the URL as frozen) |
| `/store/dashboard/configurations/warehouse/**` | Masters → Warehouses & locations | locations arrive Chunk 2 |
| `/store/dashboard/configurations/units-packaging/**` | Masters → Units of measure | |
| `/store/dashboard/configurations/store-settings` | Settings | |
| `/store/dashboard/product-requests` | — | retire (desk already shows the same data as "Legacy Product Requests") |
| hubs `/operations`, `/configurations`, `/vendors-buyer` | — | retire → redirect to parent group |
| `/store/dashboard/order-requests/[id]` (MO detail) | Manufacturing app | move out (§5) |
| `configurations/{registered-operations, devices-machines, assigned-team}` | Manufacturing app | move out (§5) |
| `configurations/work-orders/**` (worker worksheets) | Manufacturing or HR/contracting; NOT Store & Purchase | move out; carries payment fields — Finance must see it before it moves |

## 4. Proposed sidebar hierarchy

Taken verbatim from the product plan §8.2 (itself a proposal) (Overview; Purchase:
Requisitions, RFQs, Supplier quotations, Purchase orders, Supplier returns;
Receive: Expected deliveries, Goods receipts, Inspections, Put-away;
Inventory: Stock on hand, Reservations, Transfers, Issues & returns, Cycle
counts, Movement ledger; Masters: Items, Categories, Units of measure,
Warehouses & locations, Suppliers; Reports; Settings). Entries whose
documents do not exist yet (RFQ, inspections, put-away, reservations,
transfers, cycle counts) appear only in the chunk that builds them — no
placeholder nav items.

## 5. Configuration pages that belong to another application

The audit's **proposed** owners — this is where the pages evidently belong
from the code, not a decision anybody has taken. Each row still needs the
receiving application's owner to accept it, and §9.2 records that as open.
The "Real owner" column is therefore the audit's reading, not an agreement:

| Page | Real owner | Evidence |
|---|---|---|
| Registered Operations (operations/groups/codes/machine-types) | **Manufacturing** | manufacturing masters on `/api/cms/operations*`; duplicated wholesale in the Sales app |
| Devices / Machines | **Manufacturing** | factory machine register, maintenance statuses |
| Assigned Team | **Manufacturing** (production operators; HR owns the people) | `/api/cms/employees/operators` |
| Work Order Sheet (worker worksheets) | **Manufacturing/contracting**, with Finance sign-off (payment fields) | separate collection from MO work orders |
| Manufacturing-order queue + WO approval inside order-requests | **Manufacturing** (Store keeps a verification action, not the workspace) | `/api/cms/store/order-requests` reads Manufacturing data |
| Store Settings (letterhead) | Store & Purchase | genuinely local |

## 6. Duplicate screens to consolidate later

1. `/store/dashboard` vs `/store/dashboard/overview` — same API, two
   dashboards → one home + redirect (Chunk 10).
2. Operational PO vs worksheet PO registers → one PO register + template/
   legacy treatment (Chunk 6).
3. Order-requests desk vs `mrf-history` — the register duplicates approve/
   issue/reject/bypass actions → queue acts, register reports (Chunk 10).
4. `product-requests` page vs the desk's "Legacy Product Requests" filter vs
   the raw-items page's embedded requests section — three surfaces, one
   legacy dataset → one read-only legacy view.
5. Sales-app copies of raw-items and registered-operations → single owner
   after the moves in §5.
6. Both dashboards' dead `stock-items` links → remove with the redirect.

## 7. Legacy routes that eventually redirect or become read-only

- Redirect: `/store/dashboard`, the three hub pages, `product-requests`.
- Read-only legacy: worksheet PO register (if not converted to templates),
  legacy Requisition print-form register, RawItemAddRequest views (already
  read-only server-side), pre-cutover MRF documents (always readable).
- Frozen URL: `/store/dashboard/item-info` — printed QR stickers in the
  field encode it; it must survive every navigation change or be 301-served
  forever.

## 8. Canonical status labels and next-action wording

Proposed, following plan §8.3/§8.4. Additions grounded in this audit:

| Document | Internal state | Shown as | Next-action line |
|---|---|---|---|
| Material request | PENDING | Waiting for approval | Team lead must review |
| Material request | APPROVED + UNMATCHED lines | Needs matching | Store must match or register the item |
| Material request | APPROVED | Ready to issue | Store must issue or decide the shortfall |
| Material request | PARTIALLY_ISSUED | Partly issued | n units still owed |
| Spend request | awaiting_requester_confirmation | With the requester | Requester must confirm the priced quote |
| Spend request | pending_finance | With finance | Finance approver must decide |
| Spend request | budget_exception | Over budget | Requester must revise or ask for budget |
| Purchase order | DRAFT | Draft | Buyer must issue to the supplier |
| Purchase order | ISSUED | Issued — awaiting delivery | Record goods receipt when delivery arrives |
| Purchase order | PARTIALLY_RECEIVED | Partly received | n units still due |
| Worksheet PO | any | Legacy PO sheet | (no operational next action) |

Rules: no raw enum strings in copy; "Pending" never appears without whom
it waits on; colour never carries meaning alone; abbreviations (PO, MRF,
GRN, UoM) only after their full term established per page.

## 9. Unresolved business-owner decisions

**All of these are open.** None has an owner or a date against it, and the
whole of this record stays PROPOSED until at least §9.1–§9.4 are answered —
they decide whether the mappings above are even the right shape.

Beyond the product plan's §12 list, this audit adds:

1. Do worksheet POs and worker work-order sheets survive as print templates,
   or freeze as read-only history? Who owns the worker-payment fields?
2. Which application receives machines / operations / operators when they
   leave Store's menu, and who maintains them in the interim?
3. Is the paper Requisition (petty-cash purchase form) still a required
   business artefact once canonical requisitions exist, or does it retire?
4. Approve display-name "Store & Purchase" and the timing of the launcher
   change (it is user-visible across every department that can see the tile).
5. The MRF number prefix stays `MRF-` while the desk says "Material
   request" — acceptable, or renumber at cutover? (Renumbering breaks
   printed/remembered references; recommendation: keep numbers.)
