# Store & Purchase simplification plan

> **Status:** Revised proposal after navigation review. No application-code
> change is authorised by this document alone.
>
> **Goal:** Reduce the number of concepts, screens, and decisions presented to
> an ordinary user. Do not merely move the existing complexity into hub pages.

## 1. Correction to the first proposal

The first proposal reduced the number of top-level navigation labels but put
the old destinations onto new landing pages. That is relocation, not
simplification: the user still has to understand every old subsystem and now
needs an extra click to reach it.

There will be no Buying, Receiving, Stock, or Manage card hub whose main job is
to repeat navigation. All navigation belongs in the application top bar.
Top-level items may open compact dropdowns containing direct links to real
workspaces.

The deeper simplification is to consolidate related records into a small
number of end-to-end workspaces and make technical sub-records part of their
parent workflow.

## 2. Final top-bar structure

The top bar has six stable entries:

1. **Overview** — direct link
2. **Requests** — direct link to the single request desk
3. **Purchase** — dropdown
4. **Receive** — dropdown
5. **Inventory** — dropdown
6. **Masters** — dropdown

Settings is a gear action at the right of the top bar for authorised managers.
Help, account, and company selection remain shell actions. Reports are reached
from the workspace that owns the reported facts, not from a miscellaneous
Reports section.

### Immediate dropdown contents

These direct links are the transition state while workflows are consolidated:

| Top-bar item | Direct destinations |
|---|---|
| Overview | Overview |
| Requests | Request desk |
| Purchase | Purchase orders; Service orders; Supplier offers; Sourcing decisions |
| Receive | Goods receipts; Customer-supplied receipts |
| Inventory | Stock on hand; Reservations and picking; Issues and returns; Counts; Movements |
| Masters | Materials; Finished products and BOM; Services; Suppliers; Units; Warehouses |

Rules:

- No intermediate navigation landing pages.
- Dropdowns contain direct links only and remain grouped by user job.
- Store settings live behind the settings gear in the top bar. Operational
  warehouse locations remain in Inventory; Warehouse under Masters maintains
  the warehouse definition.
- Sourcing decisions remain in the Purchase dropdown during transition because
  the current workspace is otherwise not discoverable. Phase 2 embeds them in
  the purchasing requirement or quotation comparison and then removes the
  separate link.
- Stock exceptions appear inside Inventory as an attention filter, not as a
  separate application destination.
- Purchase exceptions appear inside Purchase as an attention filter.
- Valuation appears inside Inventory as a report/view.
- Material-request history appears in Requests as the Completed/Register view.
- Accountability appears in Inventory's movement view.
- Location map, finder, scanner, layout, and reconciliation are modes of the
  Inventory workspace, not top-level destinations.
- Legacy and production-owned pages do not appear in normal navigation.

## 3. Target product: five operational workspaces

The application should ultimately have five real operational workspaces. The
sixth top-bar item, Masters, is administrative reference data rather than a
daily workflow.

### 3.1 Overview

Overview answers only:

- What needs attention?
- What am I allowed and expected to do next?
- What is late, blocked, or exceptional?

It is not a second register and does not show decorative KPIs. Each row opens
the actual document at the required action. The default is “My work”; managers
may switch to “All company work”.

### 3.2 Requests

One request desk covers material, purchase, service, and manufacturing-driven
needs without making the user select a backend document type first.

The list uses four user-facing stages:

- Needs review
- Ready to fulfil
- In progress
- Completed

The request detail shows one primary decision at a time:

1. issue from stock;
2. issue part and purchase the shortfall;
3. purchase goods;
4. order a service;
5. return for clarification or decline.

MRF, Intake Request, Spend Request, and source links remain available under
Details and History. They are not separate mental models the ordinary user
must learn.

### 3.3 Purchase

Replace separate purchase-order, supplier-offer, sourcing-decision, and
purchase-exception experiences with one purchasing workspace.

Its tabs are stages of work, not model names:

- **To source** — approved needs requiring supplier selection
- **Draft orders** — commercial choice made, order not issued
- **On order** — issued and awaiting completion
- **Completed** — received goods or accepted services

Opening a requirement shows quotations side by side. Recording or revising a
supplier offer and selecting it happen in that requirement. “Sourcing
decision” is history on the requirement, not a separate place to visit.

Materials and services use the same Purchase workspace. Their fulfilment
remains technically different:

- material order -> goods receipt and stock;
- service order -> completion report and department acceptance.

The UI labels the type clearly and presents only the applicable actions.

Purchase exceptions appear as a filter/badge on the affected stage and line.
The user never visits a separate exception register to discover the problem.

### 3.4 Receive

One receiving workspace covers both purchased and customer-supplied arrivals.
Its tabs are:

- Expected
- Arrived — action required
- Completed

The detail page guides the user through the relevant sequence:

```text
Record arrival -> Inspect -> Put away accepted stock
                           -> Resolve quarantine
                           -> Return rejected stock
```

Inspection, put-away, quarantine disposition, and supplier return are sections
and actions on the receipt. They are not standalone destinations.

Customer-supplied goods use the same physical arrival experience with a
prominent **Customer-owned** identity. Supplier, price, bill, and payment
concepts are absent because they do not apply.

The old Delivery register is removed from ordinary navigation. Its historical
records remain reachable from the linked order/receipt history.

### 3.5 Inventory

One search-first Inventory workspace answers:

- What do we have?
- What is reserved or available?
- Where is it?
- What moved?
- What action is required?

The page opens with item/SKU/barcode/location search. An item result combines:

- company on-hand;
- reserved and available quantities;
- locations and lots;
- customer ownership where relevant;
- incoming purchase quantity;
- open demand;
- recent movements and exceptions.

Actions are contextual buttons on the item/location:

- Reserve or pick
- Issue or return
- Move
- Count
- Adjust, when authorised
- Print/scan label

Counts and Movements remain direct dropdown destinations during transition
because they are substantial work queues. The long-term goal is for them to be
views of Inventory, not separate mini-apps.

The location tree, map, scanner, layout editor, locator, and reconciliation
become modes within Inventory. Users should not choose between seven location
routes before they can find a roll of fabric.

### 3.6 Masters

Masters contains governed reference data only:

- Materials
- Finished products and BOM
- Services
- Suppliers
- Units
- Warehouses

Every master register uses the same pattern: search, status, primary action,
record detail, history. Stock quantities are not edited from a master form.

Store settings are reached from the top-bar gear. Warehouse master definition
is under Masters; warehouse layout and operational locations are Inventory
modes. Supplier offers belong to Purchase, not Supplier master. Inventory facts
belong to Inventory, not Material master.

## 4. Remove these concepts from normal user navigation

The following must not merely move to another menu:

- Sourcing decisions — embedded in Purchase requirement history
- Purchase exceptions — embedded in Purchase filters and line warnings
- Stock exceptions — embedded in Inventory filters and item warnings
- Inventory valuation — Inventory view/report
- Material request register — Completed view in Requests
- Movement report/accountability — Movement view in Inventory
- Location finder/map/scan/layout/reconciliation — Inventory modes
- Legacy deliveries — linked historical evidence only
- Legacy purchase forms and PO sheets — read-only archive, manager access only
- Work-order sheets, machines, operations, and assigned team — move to the
  owning Manufacturing/HR application after owner approval

## 5. Page behaviour standard

Every operational document follows the same structure:

1. identity and plain-language status;
2. “Next action” panel naming who acts and why;
3. essential lines/quantities;
4. exceptions beside the affected line;
5. evidence and notes;
6. collapsed technical details;
7. immutable history.

There is one primary action. Secondary actions sit in an overflow menu. Raw
enum values, capability keys, internal model names, database IDs, and recovery
metadata are never primary copy.

Lists default to actionable records. Completed/history is a deliberate filter,
not half of the initial screen.

## 6. Safety boundaries that remain

Simplification must not remove:

- company isolation and membership selection;
- server-side capabilities and approvals;
- idempotency and concurrency protection;
- strict unit conversion;
- receipt, inspection, put-away, return, and ownership evidence;
- action history and document numbering;
- reservation and location integrity;
- Accounting ownership of bills and payments;
- explicit exception and reconciliation states.

Complexity necessary for correctness remains in the system; it is revealed
only when the relevant user and situation require it.

## 7. Implementation sequence

### Phase 1 — correct navigation without hub pages

- Replace the current six direct hub links with the final top-bar structure.
- Use compact top-bar dropdowns with direct links to existing workspaces.
- Delete the new Buying, Receiving, Stock, and Manage navigation-hub pages if
  they have no purpose other than repeating links.
- Preserve all established operational URLs.
- Remove legacy and production pages from normal navigation without deleting
  their routes.
- Add explicit route-to-top-bar ownership so nested routes highlight the right
  dropdown.
- Update navigation tests and perform desktop/mobile visual verification.

**Exit:** no daily task requires visiting an intermediate menu page, and the
top bar exposes only the approved direct destinations.

### Phase 2 — consolidate Purchase

- Build the stage-based Purchase workspace.
- Embed quotation comparison, offer editing, sourcing decision, and exceptions
  into requirement/order detail.
- Keep existing APIs initially; introduce a read adapter if one workspace needs
  several sources.
- Remove Supplier Offers as a top-bar destination after the embedded flow is
  complete.

**Exit:** a buyer can source, select, order, and follow up without leaving the
Purchase workspace.

### Phase 3 — consolidate Receive

- Build Expected / Arrived / Completed queues.
- Put all receipt-control actions on receipt detail.
- Add customer-owned arrivals as a typed filter of the same workspace.
- Remove Customer-supplied as a separate top-bar destination after parity.

**Exit:** a receiver handles one arrival end-to-end without changing modules.

### Phase 4 — consolidate Inventory

- Build the unified item/location availability view.
- Bring reservations, issue/return, movement, count, exception, and label
  context onto the item/location workspace.
- Collapse the separate location routes into modes of Inventory.
- Preserve specialised count and movement queues until the unified workspace
  reaches full functional parity.

**Exit:** stock quantity, availability, location, provenance, and next actions
are visible from one search result.

### Phase 5 — clean Masters and retire legacy presentation

- Standardise master registers and detail pages.
- Remove stock mutation from material forms.
- Move production-owned configuration to its real owner.
- Freeze legacy PO sheets, purchase forms, and delivery summaries as read-only
  history after measured-use and owner approval.
- Update help and durable architecture documents to match production.

## 8. Acceptance criteria

- No navigation-only hub pages.
- Six top-bar entries, in the approved order.
- Dropdown entries link directly to real workspaces and never to navigation
  hubs.
- One visible workspace for Requests, Purchase, Receive, and Inventory.
- Quotations and sourcing decisions can be completed inside Purchase.
- Inspection through put-away/return can be completed inside one receipt.
- An item search reveals on-hand, reserved, available, location, incoming, and
  movement context without opening separate registers.
- Legacy and production-owned pages never appear in ordinary navigation.
- Existing bookmarks continue to resolve during migration.
- No regression in tenant, permission, idempotency, stock, receipt, or
  reconciliation tests.
- Desktop and scanner/mobile journeys are verified with real user roles.

## 9. First correction to make now

Fix the top bar before building another workspace:

1. remove the Buying, Receiving, Stock, and Manage hub destinations;
2. make Purchase, Receive, Inventory, and Masters top-bar dropdowns;
3. link dropdown items directly to the existing real pages;
4. remove legacy/production links from ordinary navigation;
5. preserve routes and business behaviour;
6. verify active-state ownership for every existing Store route.

This correction is navigation only. The later phases remove the underlying
workflow complexity rather than hiding it behind a different menu.
