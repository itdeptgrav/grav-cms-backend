# PPC multi-stage production planning

**Status:** implementation brief, not an implemented feature  
**Prepared:** 22 September 2026  
**Scope:** one Sales-confirmed order line, across all applicable production processes

## Outcome

PPC must be able to answer, for each confirmed order line: which processes are required, in what order, where and when each will run, what capacity has actually been committed, which predecessor or source is blocking the next step, and what Production has actually completed. Sewing-line booking is one stage of this plan, not the whole plan.

An example route is cutting → embroidery → sewing → washing → finishing → packing. It is **not** a default route: embroidery, printing, washing and external processing appear only when the approved order/style basis requires them. A process can occur before or after another only as the approved route specifies; do not hard-code this example's order.

## Verified starting point and boundaries

- `PpcPlanningFile` is keyed by company and the permanent Sales `orderLineRef`, with a frozen upstream basis. It holds PPC planning intent, not process-stage commitments.
- `PpcCapacityLine` and `PpcCapacityBooking` model a sewing line and operator-minute booking. They cannot be relabelled as cutting, washing or embroidery capacity.
- IE owns the approved route and technical standard. The in-progress IE slice has added an optional, frozen `processRoute` to approved versions and releases, and a company-scoped read by release ID. Earlier releases remain `UNKNOWN`. PPC must consume that declared route, never infer stage from operation names or machine codes. This working-tree addition is not yet a user-visible IE editor or an order-line applicability proof.
- The new IE process-route publication is style-scoped. A confirmed Sales order line is a different identity: two lines may use the same style yet require different buyer-specific decoration or processing. PPC must not treat a style route as proof of an individual line's applicability until Sales' line-level approved requirement is checked against that exact IE release. A mismatch is a blocker requiring an approved technical revision or an explicit line-specific technical basis, not a PPC override.
- Cutting has employee/day work-order sessions; embroidery has piece/barcode completion records. They are execution evidence, not PPC stage plans. Washing and other special-process evidence is incomplete. Do not add substitute PPC completion checkboxes.
- The PPC-to-Production release/WorkOrder authority bridge is still a separate decision. A stage schedule or capacity booking must not be presented as Production release.

Sources: `docs/decisions/architecture-decisions.md` ADR-003; `docs/product/industrial-engineering-app-plan.md` §5.3; `docs/product/production-floor-ppc-integration-plan.md` §§3–4; `docs/product/garment-order-to-shipment-plan.md` §§3–4; `docs/tasks/garment-order-to-shipment-roadmap.md` G09–G13.

## Ownership

| Fact | Owner |
| --- | --- |
| Buyer quantity, delivery commitment, approved special-process requirement | Sales, with the confirmed line identity |
| Approved process route, operation sequence, technical standards and version | IE, consuming approved style requirements |
| Stage dates, resource allocation, capacity commitment, dependency/recovery decision | PPC |
| Cutting, embroidery, sewing, washing, finishing and packing actuals | Production / the responsible execution department |
| Quality verdict and rework release | Quality |
| Material custody, issue and return | Store |

PPC reads other departments' source-linked states; it cannot mark their work complete or approve it for them. Merchandising may coordinate the execution and see progress, but does not own this stage schedule.

## Required schedule handoffs to the execution apps

**A shared plan is not shared app access.** PPC users stay in PPC. Cutting, Embroidery and Production users stay in their own apps and see the part of PPC's published plan assigned to them: the confirmed order-line/work-order identity, required quantity, stage start/finish target, predecessor, source-plan version, publication time and any changed-deadline notice. The receiving app must label a proposed date as proposed; only a published/accepted commitment may be called a deadline. It must not make the recipient's actual completion editable by PPC.

The return path is a source-owned progress/readiness publication from each execution app to PPC. PPC may show that status and its freshness beside the planned dates, without opening the source app or acquiring its permissions. A missed date is a schedule exception for PPC to replan and communicate, not an automatic edit of Sales' buyer delivery promise or another department's completion record.

| Stage | Existing source to reuse | Schedule handoff and return path |
| --- | --- | --- |
| Cutting | Mounted Cutting Master routes and `CuttingMasterRecord` work-order/day sessions | Cutting sees its published cut-by date and quantity in its own work queue; PPC reads back source-owned cut progress. Link confirmed Sales line to exact WorkOrder(s) before doing either. Do not count employee sessions twice. |
| Embroidery, when required | Mounted Embroidery routes and unique-barcode `EmbroideryRecord` | Embroidery sees its assigned window and required quantity in its own work queue; PPC reads back source-owned scan progress. A missing scan is not proof that embroidery is unnecessary. |
| Sewing | Existing PPC sewing booking plus Production scan/manual records | Production sees the PPC-published sewing window and line allocation; the booking is a commitment, not an actual. Reconcile Production's distinct scan writers before showing a single accepted-output figure. |
| Washing, printing or external processing, when required | Production/service records only where a real source and identity are verified | The responsible app or external-service workflow receives its scheduled window and quantity, then publishes receipt/return/actuals. Until a real owner and contract exist, PPC shows `handoff not connected`, never a fabricated completion. |
| Finishing and packing | Production actuals and the later Quality/Logistics handoffs | The responsible app sees its planned window and required quantity, then publishes its own accepted/packed result; PPC cannot mark it done. |

**Identity blocker verified in the present models:** the Sales order line has a permanent `CustomerRequest.items[].lineRef` and PPC uses it, but `WorkOrder` exposes `customerRequestId` without that line reference. Cutting sessions and Embroidery records refer to WorkOrders, not directly to the Sales line. A customer-request-level join is ambiguous when one request contains multiple lines. Build and test an explicit, company-proven order-line ↔ WorkOrder bridge before aggregating either app into PPC; never join by style/product name, barcode prefix or WorkOrder number alone. Preserve historical records that cannot be proved as `unlinked`, not silently assigned.

The PPC order-line screen should use one compact process strip/table with stage, planned window, handoff state, actual quantity/status, blocker and owner. **Do not show `Open in Cutting` or `Open in Embroidery` actions to PPC users.** Only required stages appear. A stage with no readable source says `Couldn't check`; an applicable stage with no source event says `Not yet reported`; neither is rendered as zero or complete. The all-lines register and overview may aggregate those same read models, but must not introduce separate manually maintained progress.

On initial publication and every approved replan, notify/republish to only the affected stage owners with the old and new target dates, reason and version. The receiving app acknowledges the exact version or reports an explicit refusal/constraint; silence is `awaiting acknowledgement`, not acceptance. Preserve the prior target and acknowledgement in history. A later stage cannot silently inherit a moved predecessor date. Deduplicate delivery/retries by company, order line, plan version and stage identity. App visibility follows each department's own grants; publication does not grant PPC access to the receiving app, or vice versa.

## Delivery slices

### 1. Approved process-route contract — IE owner, PPC consumer

Trace the exact current route writer, frozen bulletin and IE release projection before editing. Add stable, typed process-stage identity and predecessor/parallel relationships to an approved IE route only where missing. Preserve existing row IDs and versions; do not infer stage from display names or rewrite historical approvals. Make stage applicability explicit, including an approved `not applicable` outcome for optional steps. Publish a company-scoped, versioned read projection for PPC. If an existing approved release cannot prove stages, return `route stage unknown` rather than inventing a route.

**Exit:** cutting, sewing and an optional special process can be distinguished from approved evidence; a revision creates a new version; an old PPC plan keeps its original source version.

Before slice 2, prove the order-line applicability bridge: trace Sales' `Enquiry.products[]` decoration/special-process facts through `SampleStyle`, the confirmed `CustomerRequest.items[]` and the Sales-to-Merchandising handover. Identify which facts are actually approved and frozen per permanent `lineRef`, and whether two confirmed lines of one style can differ. If the line requires a process the selected IE release marks `NOT_APPLICABLE`, or the line requirement cannot be proved, PPC shows a named source mismatch/unknown and cannot publish that stage schedule. IE remains the technical approver; Sales remains owner of the buyer requirement. Do not silently convert a style-scoped release into an order-line approval.

### 2. PPC process-plan read and draft

Build one process plan for the permanent Sales order line. It references the exact approved IE route version and PPC planning-file generation. Show required stages and dependencies in a compact order-level view: process, owner/site, planned start/end, dependency, capacity state, actual/freshness and next action. Use calendar dates (`YYYY-MM-DD`) for business days. No prefilled dates, fabricated capacity, or green completion when the source is absent. An optional step is omitted only by the approved route, not by a planner hiding it.

**Exit:** two same-name styles/colourways remain separate by line identity; missing IE stage evidence is a visible blocker; save/reload and successor semantics preserve history.

### 3. Stage capacity and scheduling

Keep the existing sewing-line booking unchanged. Model capacity for cutting, embroidery, washing/processing and finishing only after inventorying their real resource/site/calendar constraints and deciding internal versus outsourced capacity ownership. A stage may be scheduled without falsely claiming booked capacity; label `proposed`, `committed`, `external confirmation pending`, and `unknown` distinctly. Enforce predecessor dates, overlapping resource limits, partial quantities and company scope. A moved upstream version requires a controlled successor/replan, never silent restamping.

**Exit:** an impossible overlap is refused; an unbooked or externally unconfirmed stage cannot look committed; sewing booking remains one traceable stage commitment.

### 4. Department schedule handoffs and actuals

Publish the versioned, stage-specific dates and quantities to Cutting, Embroidery and other responsible apps through their own read surfaces and acknowledgement contracts; do not broaden cross-app permissions. The separate PPC-to-Production release contract still governs when a schedule authorizes Production to start. Consume Cutting, Embroidery, sewing-scan, washing and Quality evidence through their owners, with explicit identity bridges to the confirmed line/WorkOrder and deduplication. Do not use a manual PPC `done` toggle. Show planned versus actual quantities and dates, holds, rework and partial movement without double counting. Connect final packing/dispatch through the order-to-shipment roadmap.

**Exit:** a user can trace one order line from required route through each stage and its real outcome; unknown evidence is not displayed as zero or pass.

### 5. Connected browser proof

With safe test data, publish one confirmed line requiring cutting, embroidery and sewing, plus one without embroidery. Sign in separately as PPC, Cutting and Embroidery users. Verify that each execution app displays only its assigned dates, quantity and source version without giving PPC access to that app. Record a Cutting or Embroidery actual in its owning app, then verify PPC reads the update without re-entry. Replan one deadline and prove the prior version remains visible, the affected app receives the change, and unacknowledged changes are not labelled accepted. Verify a multi-line customer request never merges its WorkOrders, a wrong-company source remains invisible, a missing source is labelled unknown, and duplicate scans/sessions do not inflate progress. Include a required washing/external stage with `handoff not connected` until its real source contract exists. Do not claim an end-to-end flow from unit tests alone.

## First implementation task

**Lane:** IE route/contract lane first; PPC implementation begins only after the contract is demonstrably consumable. Do not assign simultaneous edits to the same IE release, PPC order-line or floor-canvas files.

Read-only trace `IeOperation`, `IeStyleFile` draft bulletin, `IeBulletinVersion`, `IeRelease`, the release publication service, PPC's IE receipt and `PpcPlanningFile`. Produce an exact field-level map of what can currently prove process-stage identity, order and optionality, with one representative approved route and one route missing that evidence. Then implement only the smallest versioned IE publication addition needed for that proof, with tests for stable identity, approval immutability, optional stage, company boundary and old-version preservation. Do **not** add PPC stage dates, capacity, Production release or UI in this first task.

## Product decisions before slice 3

1. Which real resources define cutting, embroidery, washing/processing and finishing capacity at each factory, including outsourced steps?
2. Which department records external processor acceptance and return, and at what quantity/lot grain?
3. Whether PPC may commit a stage before materials, sample/Quality and PP-meeting evidence is complete, and how that tentative state is labelled.
4. Exact authority for PPC release into Production and its relationship to existing WorkOrders, as already called out in the integration plan.

These are not reasons to delay slice 1 or a truthful stage read. They are reasons not to invent capacity or release semantics while building it.
