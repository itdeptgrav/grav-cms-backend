# PPC multi-stage planning — clean handoff

**Prepared:** 22 September 2026  
**Purpose:** Give a fresh Codex task the context and ordered work for planning the *whole garment order*, not only a sewing line.  
**Status:** Working-tree handoff, not a claim of deployed or end-to-end-complete functionality. Do not replace `docs/tasks/current-task.md` merely because this file exists.

## The product outcome

For each permanent, Sales-confirmed order line, PPC should see the applicable production route and coordinate dates, capacity and handoffs across cutting, embroidery/printing if required, sewing, washing/processing if required, finishing and packing. The route comes from approved IE technical evidence checked against that order line's buyer requirements; it is **not** a fixed list or an inference from a style name. The sequence may include parallel work and partial quantities where the approved route permits them.

PPC owns the plan and recovery decisions. The departments executing each process own their work and actual progress. PPC does not need access to the Cutting, Embroidery, Washing or Production apps. Instead, a published PPC stage commitment appears in the responsible app with its exact source version, and that app's source-owned progress returns to PPC. A planning target is not an accepted deadline, a sewing capacity booking is not a production release, and a blank/failed read is not zero progress.

## What is already present in the local working tree

| Capability | Evidence | Limit |
| --- | --- | --- |
| Sales-line-based PPC planning file and sewing capacity booking | `models/CMS_Models/PPC/PpcPlanningFile.js`, `PpcCapacityBooking.js`, `services/ppc/planningFile.service.js`, `capacityPlanning.service.js` | Booking explicitly reports `releasesProduction: false`; it does not schedule other departments. |
| IE's versioned process-route projection | `models/CMS_Models/IndustrialEngineering/processRoute.schema.js`, `services/industrialEngineering/releasePublication.service.js` | Style-scoped, not proof of a buyer-specific order line. Old releases may have `routeState: UNKNOWN`. Verify the current IE writer and release state before consuming it. |
| PPC internal multi-stage dates | `models/CMS_Models/PPC/PpcStageSchedule.js`, `services/ppc/stageSchedule.service.js`, `routes/CMS_Routes/PPC/orderBookRoute.js` | A first read/save/versioned-replan implementation exists. It has no department publication, capacity booking for non-sewing stages, actuals or production-release authority. |
| PPC stage UI | `/Users/risheeray/grav-cms/components/ppc/StageSchedule.js` and `stageScheduleState.js` | Shows planned targets and honest `Not connected` handoffs; not a complete multi-stage operating console. |
| Permanent Sales line to WorkOrder link | `services/production/salesLineWorkOrderLink.service.js` and `models/CMS_Models/Manufacturing/WorkOrder/WorkOrder.js` | New, uncommitted working-tree work. Verify its tests and all creation paths. Historical WorkOrders may be explicitly unlinked. This identity bridge is not itself a PPC stage publication or Production release. |
| Cutting and Embroidery source evidence | Mounted Cutting and Embroidery routes; see `docs/tasks/ppc-multistage-production-planning.md` | They are execution records keyed to WorkOrders, not PPC commitments. Their event grain and completeness must be traced before computing progress. |

These paths were inspected in the local checkout on the date above. They are not assertions about GitHub, the running server, the main database, or a production deployment. Several are untracked in a heavily shared working tree.

## Ownership and non-negotiable boundaries

| Fact/action | Owner |
| --- | --- |
| Confirmed quantity, buyer delivery commitment, approved decoration/special-processing requirements, permanent `lineRef` | Sales |
| Execution coordination and PP-meeting/execution-pack information | Merchandising |
| Approved process route, operation sequence and technical standards | IE |
| Stage schedule, feasible resource allocation, capacity commitment and recovery/replan | PPC |
| Physical execution and actual quantities for cutting, embroidery, sewing, washing, finishing and packing | The responsible Production/execution department |
| Inspection, reject/rework and release verdict | Quality |
| Material stock, issue and return | Store |

The permanent Sales `lineRef` plus company scope is the order-line key. A style, display name, colourway, barcode prefix, WorkOrder number or customer-request ID alone cannot substitute for it. IE's style-level route must be checked against the exact confirmed line: two lines of the same style may differ in buyer-specific embroidery, print or wash requirements. If that evidence is absent or contradictory, show a named blocker; PPC must not choose applicability on IE's behalf.

## Work to finish, in dependency order

### 0. Reconcile the moving baseline

Read the current working tree, staged tree and recent commits in both repositories. Read this file alongside `docs/tasks/ppc-multistage-production-planning.md`, `docs/product/production-floor-ppc-integration-plan.md`, `docs/product/garment-order-to-shipment-plan.md` and `docs/tasks/garment-order-to-shipment-roadmap.md`. Identify active writers before editing shared IE, PPC order-line, WorkOrder or Production files. Run focused current tests and distinguish pre-existing failures. Do not redo implemented route, schedule or identity work because an older document still calls it missing. Update stale plan claims rather than treating them as architecture truth.

### 1. Prove line-level route applicability

Trace approved buyer-specific process requirements from Sales through Merchandising and the exact IE release frozen in the PPC planning file. Produce a source-field map for two lines of one style with different decoration/washing needs, a historical `UNKNOWN` route, and a requirement/release mismatch. Only an approved, compatible route may yield scheduleable stages. Preserve IE release and planning-file versions; changes require explicit successor/reconciliation, never silent restamping.

### 2. Harden the internal stage schedule already built

Verify stage IDs, predecessors, calendar-day dates, version history, idempotency, company boundary, stale revision refusal and successor planning-file behavior in `stageSchedule.service.js`. Reconcile route changes after first save, optional/non-applicable stages, partial quantity/parallel dependencies if the approved IE contract allows them, and how a sewing booking is shown without being implied for every stage. Keep the UI compact and scannable using the PPC/Marketing kit; show the plan source, planned versus committed status, responsible owner, blocker and next action. This remains PPC-internal until a publication contract exists.

### 3. Decide stage resources and commitment semantics

Inventory real cutting, embroidery, wash/processing, finishing and packing resources, sites, shifts/calendars and outsourced providers. Do not relabel `PpcCapacityLine` as a generic machine or process resource. Distinguish `proposed target`, `capacity committed`, `external confirmation pending`, `accepted deadline`, `not connected` and `unknown`. Define overlap, partial-quantity and predecessor rules from actual resource evidence. Record decisions before adding non-sewing capacity writers.

### 4. Connect PPC commitments to each execution owner

Using the verified company + Sales-line ↔ WorkOrder identity, define a versioned stage publication and recipient acknowledgement/refusal. Cutting and Embroidery are the first concrete receivers. Each owning app shows its assigned stage, quantity, target dates, predecessor, PPC source/version and changed-deadline notice without granting its users PPC editing privileges. PPC users do not acquire the recipient app's privileges. A changed target publishes a new version with old/new dates and reason; silence remains `awaiting acknowledgement`. Delivery retries are idempotent. Where an app has no valid receiver (for example washing/external processing), keep `handoff not connected` visible instead of inventing one.

### 5. Read source-owned actuals back into PPC

Cutting/Embroidery/Production publish or expose company-scoped actuals at a documented event grain. Reconcile WorkOrder lineage, employee/day cutting sessions, unique-piece embroidery scans, device versus manual sewing scans, Quality holds/rework and partial quantities before aggregating. Show source and freshness. An unreadable source means `Couldn't check`; no event means `Not yet reported`; neither means zero or complete. PPC must not get a manual `mark done` action. Keep Production start authority separate from this reporting integration.

### 6. Production release, then browser proof

The separate PPC → Production release decision and receiver contract in `docs/product/production-floor-ppc-integration-plan.md` still governs start authorization; a stage date or sewing booking must not silently trigger a WorkOrder. After that authority is settled, prove the connected flow in safe data through separate PPC, Cutting and Embroidery sessions: a line requiring cutting → embroidery → sewing; a similar line without embroidery; a changed stage date; an actual in the owning app visible in PPC; two lines of one customer request kept separate; a wrong-company source hidden; an unlinked historical WorkOrder labelled as such; duplicate events not inflating progress. Do not claim completion from isolated unit tests or synthetic screenshots alone.

## Decisions requiring the product owner

1. What resource/capacity unit is authoritative for each non-sewing stage, including subcontractors?
2. Which app owns external processing acceptance, outward/return quantities and loss/rework?
3. May PPC publish a provisional date before materials, PP meeting and Quality prerequisites are complete? If yes, what exact label and receiver behavior?
4. What action releases a PPC plan into Production, and does Production create or link the WorkOrder? See the separate release plan; the Sales-line link alone does not decide authority.
5. Which stage completions count as accepted output versus mere activity, especially across device/manual scans and Quality rework?

Do not block truthful reads and internal planning on these decisions. Do block any writer that would falsely assert capacity, recipient acceptance, actual completion or Production release.

## Exact first task for the new Codex chat

> Continue PPC multi-stage production planning from the **current** `/Users/risheeray/grav-cms-backend` and `/Users/risheeray/grav-cms` working trees. Read this entire handoff and the four durable/roadmap documents named in section 0. First perform a read-only reconciliation of IE's versioned process-route publication, the existing PPC `PpcStageSchedule` service/UI/tests, and the new Sales-line ↔ WorkOrder bridge. Show exactly which of slices 1–6 are implemented, partial or absent, citing code and focused test results; identify concurrent-file ownership. Then execute the smallest safe next slice: establish and test the **confirmed Sales-line ↔ frozen IE route applicability** contract (slice 1), unless the code already proves it—in that case identify and implement the next missing boundary, not a duplicate. Preserve other lanes' changes. Do not seed or mutate the shared database, broaden app permissions, mark another department complete, treat a target as an accepted deadline, or treat a booking as Production release. Report changed files, tests, and the next dependent slice. Do not replace `docs/tasks/current-task.md` or commit unless explicitly requested.

## Related source of truth

- `docs/tasks/ppc-multistage-production-planning.md` — detailed product/task brief.
- `docs/product/production-floor-ppc-integration-plan.md` — IE/PPC/Production authority and scanner continuity.
- `docs/product/garment-order-to-shipment-plan.md` — whole-order lifecycle.
- `docs/tasks/garment-order-to-shipment-roadmap.md` — dependencies G09–G16; portions may be stale versus current working tree.
- `docs/decisions/architecture-decisions.md` — ADR-003 departmental ownership.
