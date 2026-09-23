# Production floor, PPC and IE integration plan

**Status:** Proposed implementation plan for review  
**Prepared:** 21 September 2026  
**Repositories:** [grav-cms frontend](https://github.com/itdeptgrav/grav-cms) and [grav-cms-backend](https://github.com/itdeptgrav/grav-cms-backend)  
**Source reviewed:** local checkouts at `/Users/risheeray/grav-cms` and `/Users/risheeray/grav-cms-backend`, including uncommitted work. This document does not claim that the same code is on the GitHub default branches or deployed.

## 1. Outcome

Bring the useful parts of the existing Production Supervisor and Project Manager experience into the target Sales → Merchandising → IE/PPC → Production → shipment workflow:

- Carry the Sales-confirmed order and its permanent order-line reference through planning, execution and eventual shipment; show delivered and outstanding quantities back to Sales without creating another order identity.
- Preserve the interactive physical machine canvas, machine and operator visibility, piece search, and barcode-driven floor evidence.
- Let IE publish the approved operation route, standard times, planned machine requirements and planned line layout.
- Let PPC plan orders, book capacity, allocate the line and release a specific plan to Production.
- Let Production accept that release, assign physical machines and operators, execute the work, and show plan versus actual progress to Supervisors and Managers.
- Keep printed labels and deployed scanner clients working throughout the transition.

This is an integration and migration plan. It does not make the IE layout the physical floor layout, turn a PPC capacity booking into a Production release, or declare either existing scan ledger authoritative before its writers and consumers have been traced.

## 2. Governing decisions and source references

The ownership split in [ADR-003](../decisions/architecture-decisions.md#adr-003-ie-and-ppc-are-separate-department-applications) is the governing decision: IE owns methods and standards; PPC owns loading, capacity and schedules; Production owns execution. Production Manager and Production Supervisor are roles within Production. The current `project-manager` and `production-supervisor` routes are transitional shells.

The [garment manufacturer architecture](garment-manufacturer-app-architecture.md) and [IE barcode-continuity contract](industrial-engineering-app-plan.md#31-barcode-and-machine-tracking-continuity) add two constraints: the existing device operation codes and already printed work-order barcodes remain valid, and IE's planned machine type must not be confused with a physical `Machine` asset.

The [order-to-shipment roadmap](../tasks/garment-order-to-shipment-roadmap.md) records the unresolved PPC-to-WorkOrder authority decision, hold-after-booking policy, and the two active Production scan ledgers. Resolve those questions through a reviewed contract before implementing a new release or actuals counter.

### Code entry points to inspect at each handoff

| Area | Frontend | Backend |
| --- | --- | --- |
| Physical floor canvas | `app/production-supervisor/dashboard/tracker/`; `app/project-manager/dashboard/production/productionStats/` | `routes/CMS_Routes/Production/Dashboard/`; `models/CMS_Models/Manufacturing/Production/CanvasLayout.js` |
| IE standards and layout | `app/industrial-engineering/`; IE components | `routes/CMS_Routes/IndustrialEngineering/`; `models/CMS_Models/IndustrialEngineering/` |
| PPC plan and capacity | `app/ppc/`; `components/ppc/` | `routes/CMS_Routes/PPC/`; `models/CMS_Models/PPC/`; `services/ppc/` |
| Work orders and actuals | Production Record and manager work-order pages | `models/CMS_Models/Manufacturing/WorkOrder/WorkOrder.js`; `routes/CMS_Routes/Manufacturing/Production/productionCompletionRoutes.js`; `services/productionSyncService.js` |
| Deployed scanner paths | Scanner firmware/device clients, to be inventoried | Mounted `/api/cms/production/tracking/scan` and `/bulk-scans` handlers in `server.js`; `ProductionTracking` model; also inspect any separately mounted barcode routes before asserting which clients use them |

## 3. Current state, verified from the local code

| Capability | State | Boundary or gap |
| --- | --- | --- |
| Supervisor floor canvas | Implemented in the current shell | Physical machine positions, chambers, separators, zoom/pan, tooltips and live scan data exist. It is not linked to an approved IE layout or PPC release. |
| Manager floor view | Existing route | A second canvas and assignment interface exist under `productionStats`; the current manager navigation does not expose that route. Both views need one shared read model and role-specific controls. |
| Canvas persistence | Implemented, with defects | The designer sends separator width/height but the `CanvasLayout` separator schema omits them. Save increments `version` without rejecting a stale editor. The route accepts a caller-supplied `orgId` that defaults to `default`. |
| Machine operation assignment | Implemented through browser writes to Firebase | Supervisor and Manager have different modals writing the same `machines/{id}/activeOps` path. The Manager also writes `productRef`; the Supervisor clears it. There is no single backend-owned assignment command that verifies the released route and records an audit trail. |
| IE release and planned standards | Implemented in IE work, subject to a fresh integration audit | IE has approved standards/layout and a release surface; PPC has a receiver-owned IE release receipt. Preserve their stable identities and source versions. Do not make IE write a Production work order. |
| Sales → Merchandising → PPC order line | Implemented in the current working trees | `CustomerRequest.items[].lineRef` is the Sales-owned permanent line identity. Sales issues a versioned handover, Merchandising accepts it into an Execution File and publishes that same `orderLineRef` to PPC. A PPC planning file is scoped to `(companyId, orderLineRef)`. A style name, style ID or WorkOrder number is not a substitute for the Sales line identity. |
| PPC planning and capacity | Implemented in the current working trees | Planning files, line/calendar configuration, previews, bookings, release of a **capacity reservation**, and replan exist. The capacity route explicitly states that it does not release a work order to Production. |
| Production release handoff | Not established by the inspected PPC capacity route | Decide authority, exact frozen source references, acknowledgement, idempotency and treatment of already active work before adding a Production release command. The current `WorkOrder` schema has neither companyId nor the permanent Sales `orderLineRef`; an execution join cannot be inferred from its number or style. |
| Device and manual scan records | Both active | Device scans populate `ProductionTracking`; manual `production-completion/mark-done` writes `ProductionCompletionScanRecord`. Their downstream meanings and possible overlaps must be traced before reporting a single accepted-output number. |
| Barcode continuity tests | Partial | `test/industrial-engineering/ie-production-tracking-continuity.test.js` pins an existing barcode route and IE boundary. Add checks against the exact routes mounted by `server.js`, including the manual completion path. |

“Implemented” here means code is present in the local checkout, not that a production deployment or end-to-end release has been verified.

## 4. Target contracts

### 4.1 IE → PPC: immutable engineering basis

IE publishes an allowlisted, versioned release **for a style**, not an order line. It identifies the company, approved bulletin and row identities, stable IE operation identities, sequence, operation codes required by existing devices, frozen standard-time evidence, planned machine type/count requirements, and approved planned line-layout version. The release carries a source fingerprint and approval/release timestamps. PPC binds that style-scoped release to a specific permanent Sales order line in its own planning file and records its own acknowledgement of the exact release version. One IE release may legitimately support two order lines; IE must not acquire or invent their `orderLineRef` values.

An IE revision creates a new version. Existing PPC planning files and Production work orders retain the version they used; they become source-moved or require a controlled successor/change decision rather than silently inheriting new SAM, route or station assignments. A physical machine ID, employee, barcode or scan does not belong in an IE release.

### 4.2 PPC → Production: one release of one plan

PPC's planning file and capacity booking are prerequisites, not synonyms for Production release. Specify one idempotent, company-scoped PPC release command and one Production-owned receipt. The released payload should identify the **Sales-owned permanent `orderLineRef` and orderRef**, its confirmed line quantity and delivery commitment, Merchandising Execution File and frozen source versions, frozen IE release and standard versions, PPC planning-file revision, capacity-booking generation, factory/line, dates or shift commitments, material/readiness decisions and the actor. The server derives source identities from the confirmed line and the existing PPC planning/booking records; the browser does not submit an arbitrary Sales line, IE version or booked minutes. A later partial shipment must refer back to this same line so Sales can see delivered and outstanding quantities without treating dispatch as a new order.

Before building it, decide whether PPC creates an existing `WorkOrder`, requests Production to create it, or projects into an existing one. **Recommended for decision, not yet approved:** PPC issues the plan and Production owns its receipt and creation/link of the execution WorkOrder. The decision must define company proof for that WorkOrder, the permanent Sales line link, ownership of `WorkOrder.planningState`, replan, hold-after-booking, cancellation, partial quantity and already active legacy orders. Record the approved choice in `docs/decisions/` and update the order-to-shipment roadmap. A capacity booking's `release` endpoint must continue to mean release of the reservation unless a separately reviewed contract changes it.

### 4.3 Production: plan, assignment and actuals

Production receives the PPC release and holds a frozen execution basis: work order, order line, released IE route and operation codes, PPC plan/booking, company/site/line and planned dates. Production alone assigns physical `Machine` assets and operators. An assignment records machine, work order, approved operation identity plus legacy operation code, effective time, actor, revision and reason. A backend command validates company, released basis, machine eligibility and stale revisions; Firebase receives the resulting device projection. Browser clients no longer own the assignment truth.

The physical floor canvas is a Production view. IE's planned stations and machine types may appear as a read-only overlay. A visual link between planned station and physical machine is explicit and company-scoped, with `matched`, `incompatible` or `unknown` status. Do not infer that link from a name, position or free-text machine type.

### 4.4 Barcode and scan contract

Keep both printed `WO-<id>-<unit>` forms in use where already supported, including the older short-ID form and any optional operation suffix used by a deployed client. Preserve existing request fields, endpoint URLs, operator sign-in/out semantics, `machineId`, scan-time `activeOps` operation-code snapshot and existing response shapes until a versioned device migration is separately approved. Add frozen IE/PPC/Production references beside existing values through a server-side join or additive fields. Never reinterpret historical scans using today's editable master data.

Do not make IE or PPC consume or write scan records. Device retries need a stable event identity and deduplication strategy, but introducing one must accept existing clients that cannot send it yet. Keep legacy scans with uncertain route matches visible as `unknown` rather than assigning an IE identity from a display name. Device scans and manual completion scans retain their distinct meanings until reconciliation proves a shared metric.

## 5. Execution sequence and acceptance gates

Each slice is small enough to review independently. No slice silently changes a printed barcode, firmware contract, historical scan, IE standard or PPC booking.

### Slice 0 — Baseline and inventory (Codex specification; Production/PPC/IE review)

1. Trace every **mounted** scanner route, firmware/client caller, barcode generator, scan writer, sync job and report consumer. Distinguish device scans, manual completion and any legacy unmounted route. Record request/response samples with sensitive data removed.
2. Trace the current release paths from IE to PPC, PPC planning to booking, and old Project Manager WorkOrder lifecycle. Record the exact point where the new PPC path stops.
3. Capture representative legacy records: old/new printed labels, active and completed work orders, live machine assignments, canvas layouts, device and manual scans, and planned lines. Define a reversible test fixture, not a production data rewrite.
4. Record baseline results for focused backend and frontend tests and a real-device test plan. Add the currently mounted scan paths to the compatibility suite if they are missing.

**Exit:** A reviewed source/writer matrix, sample contracts, baseline test results and unresolved questions. No writer or scan schema has changed.

### Slice 1 — IE release contract (IE owner; PPC and Production consumers)

1. Verify that a released IE version exposes stable operation/bulletin-row IDs, legacy operation codes, standard-time version and approved planned layout/requirement versions through an allowlisted read contract.
2. Define the revision-impact result for an IE change while PPC has planned/booked or Production has started. No downstream record is silently restamped.
3. Provide mapping evidence for legacy work-order operation codes: exact frozen reference, explicit compatibility match, ambiguous, or unknown. Avoid creating a new barcode identity.

**Exit:** PPC and Production can read a single immutable engineering basis; the IE test suite proves IE still owns no physical machine, operator or scan fields.

### Slice 2 — PPC production-release decision and command (PPC owner; Production receiver)

The contract-only first task is [Slice 2A — Sales-line-to-Production release contract](../tasks/ppc-production-release-slice-2a.md). It is not a writer task and does not replace `current-task.md`.

1. **Slice 2A, contract before writer:** trace one Sales-confirmed line through the versioned Sales handover, Merchandising Execution File, PPC planning file and capacity booking; record exact identifiers and refusals. Approve the PPC-to-WorkOrder authority, WorkOrder company/line proof, legacy-active-order treatment and hold-after-booking policies. Do not add a new Sales line identity or infer one from a style or WorkOrder number.
2. **Slice 2B, writer after decision:** build the release contract against the existing planning file and capacity booking, using their exact revisions and idempotency rules. Preserve the Sales-owned `orderRef`/`orderLineRef` and frozen Merchandising/IE/PPC versions through the Production receipt.
3. Require readiness and source-health checks. Refuse stale Sales/Merchandising or IE sources, invalid capacity, cross-company targets and conflicting second releases with actionable errors.
4. Record one release history and one Production receipt. A retry returns the original result; a replan creates a controlled successor rather than rewriting the original basis.

**Exit:** One Sales-confirmed order line can move from its accepted Merchandising/IE basis and booked PPC capacity to one Production-recognised plan without losing its permanent line identity. Existing `WorkOrder` links and legacy active orders remain readable.

### Slice 3 — Production execution bridge (Production owner)

1. Attach the exact PPC and IE source references to the Production work-order execution snapshot while retaining current work-order IDs and operation codes.
2. Define machine/line identity, company scope, physical machine compatibility, and operator assignment. Keep planned machine types distinct from physical assets.
3. Add read-only plan-versus-actual projections first. Return `unknown` for missing denominator, no physical assignment, unproven route match, or unverified scan provenance.

**Exit:** A Supervisor can open a released work order and see its approved plan and actual evidence without changing scanner behavior. A legacy order still renders with an explicit legacy/unknown basis.

### Slice 4 — Shared interactive floor canvas (Production owner)

1. Extract the useful existing canvas interactions into a shared Production component: machine positions, chambers/dividers, zoom/pan, filters, piece search and tooltips. Give Manager and Supervisor different controls through role permissions rather than separate data logic.
2. Fix separator width/height persistence; derive company/site identity from the session; validate geometry; enforce optimistic layout version checks and preserve prior versions for recovery.
3. Separate machine states: signed in, device online, producing recently, idle, maintenance and unknown. Label the evidence and timestamp behind each state. Show the IE planned layout as a read-only overlay only where explicit station-to-machine mapping exists.
4. Correct work-order filtering so unrelated signed-in machines are not highlighted as participating in the selected order.

**Exit:** Both roles see the same physical layout and machine facts; only authorised users can edit the layout; concurrent edits cannot overwrite each other silently; old saved layouts still load.

### Slice 5 — Server-owned operation assignment (Production owner; IE validation input)

1. Replace the two browser-to-Firebase write flows with one authenticated backend command. Validate the assigned codes against the work order's frozen IE route and released Production basis, with a documented exception path for legacy work.
2. Record actor, before/after values, work order, machine, source revision, effective time and reason. Publish the resulting device projection to Firebase without changing what existing devices read.
3. Reconcile existing `activeOps` and `productRef` records. Do not let one role's UI clear another role's context as a side effect.

**Exit:** A valid assignment reaches the device and survives reload; an invalid or stale assignment is refused; the audit trail identifies who changed it; current hardware still scans.

### Slice 6 — Actuals and manager view (Production owner; PPC and IE read-only consumers)

1. Reconcile `ProductionTracking`, `ProductionCompletionScanRecord`, work-order progress, sync jobs and packaging consumers. Define each metric's event grain and source: scans received, unique pieces, operation completions, accepted output, rejected/reworked units and WIP.
2. Build a server-owned, company/site/line/work-order-scoped projection from existing evidence. Keep device and manual entry provenance visible. Add deduplication and retry handling to scan ingestion through a backward-compatible adapter.
3. Compare actuals to the **frozen** IE standard and PPC plan. Manager screens show output, WIP, bottlenecks, delayed orders, idle/maintenance machines and exceptions; Supervisor screens show immediate floor actions and corrections.

**Exit:** Every displayed total can be traced to its source; manual and device evidence are not double counted; missing source data produces `unknown`, not a fabricated efficiency or on-time claim.

### Slice 7 — Rollout and retirement (Production/PPC/IE jointly)

1. Run the old and new views side by side on a pilot site and compare layout, work-order state, scan counts and device responses for representative shifts and orders.
2. Roll out read-only views, then assignment writes, then Production release, with separate switches and a rollback procedure for each writer. Do not hard-block a first scan for an unreleased legacy order in this rollout; record an exception until a separate operational decision approves enforcement.
3. Migrate navigation from the transitional `project-manager` and `production-supervisor` shells only after roles, deep links, approvals and current orders are covered. Retire duplicate UI code and legacy write paths only when no caller remains.

**Exit:** Pilot reconciliation is signed off by PPC and Production, scanners continue to function on deployed devices, and rollback does not erase scans or released decisions.

## 6. Barcode protection gate for every slice

Before merging a slice that touches work orders, operations, assignments, layout-derived views or scan consumers, run and record:

- Old short-ID and current full-ID printed labels; optional operation suffix where present; invalid and out-of-range labels.
- Operator sign-in, sign-out, switch-machine and barcode scan with the same physical `machineId` and `activeOps` snapshot.
- Single scan and bulk scan paths **as mounted in `server.js`**, including repeated requests, offline replay, out-of-order timestamps and concurrent submissions.
- Production Record preview and `mark-done`: routed and unrouted orders, duplicate barcodes across days, mixed valid/invalid batches, and existing voided scans.
- Work-order progress, device socket updates, piece search, downstream sync and packaging/report consumers.
- A legacy active order and an already printed label after an IE revision or PPC replan.

Use the existing IE continuity and manufacturing routing tests as a starting point, not as proof that every deployed endpoint is covered. Compare response shapes and persisted scan fields before/after each change. If a migration needs a device protocol change, design and approve that as a separate versioned rollout with old-client compatibility.

## 7. Decisions required before writer changes

| Decision | Owner | Required before |
| --- | --- | --- |
| Who creates or updates `WorkOrder` from a PPC release, and how `planningState` maps to it? | PPC + Production, architecture approval | Slice 2 |
| How does Production prove the company and permanent Sales `orderLineRef` for a new or legacy `WorkOrder` without deriving either from a style, barcode or display name? | Sales + PPC + Production, architecture approval | Slice 2A |
| What does a hold after capacity booking do to reserved minutes and a Production release? | PPC | Slice 2 |
| What is the canonical company/site/line identity shared by IE planned stations, PPC capacity lines and Production physical machines? | IE + PPC + Production | Slices 3–4 |
| Which scan evidence means received scan, operation completion and accepted finished unit? | Production + Quality where applicable | Slice 6 |
| What is the supported device authentication and retry identity for existing firmware? | Production/device owner | Slice 5–6 |
| Who may edit physical layout or assign operations, and what approval is needed? | Production owner + access administrator | Slices 4–5 |

The absence of one of these decisions is a design dependency, not permission to invent a second authority. Read-only inventory and compatibility tests can proceed while the decision is pending.

## 8. Handoff to the IE chat

The IE chat should start with **Slice 0 and Slice 1 only**. It should audit the current code, confirm the IE release contract and legacy operation-code compatibility, and report proposed small implementation tasks with file paths and acceptance tests. It should not edit Production scanner routes, physical machine assignments, Firebase device settings, PPC bookings or WorkOrder release semantics under an IE task. PPC and Production slices should be handed to their respective owners after the shared contracts and decisions are reviewed.

This plan is durable product direction. `docs/tasks/current-task.md` remains the active implementation scope until a specific slice is selected and written there.
