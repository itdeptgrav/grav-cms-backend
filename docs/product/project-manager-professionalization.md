# Project Manager Professionalisation Plan

> **Status:** Proposed product and architecture plan; implementation has not
> started.
>
> **Backend:** `/Users/risheeray/grav-cms-backend`
>
> **Frontend:** `/Users/risheeray/grav-cms`
>
> **Goal:** Turn the existing Project Manager area into a dependable,
> professional production-control application while preserving its live links
> to Sales, Store, Manufacturing, R&D, Cutting, Production Supervisor, QC,
> Packaging & Dispatch, Vendors, CEO reporting and the shared access system.
>
> **Scheduling note:** Store & Purchase professionalisation remains the active
> scope in `docs/tasks/current-task.md`. This plan is ready to become active
> when the user explicitly switches scopes; it does not silently replace that
> work.

---

## 1. Product outcome

The Project Manager application is the production-control layer between an
approved customer commitment and execution on the factory floor:

```text
Sales Journey / confirmed customer request
  -> manufacturing order
  -> product/variant work orders
  -> material and operation planning
  -> capacity schedule
  -> cutting / production / QC / packaging / dispatch
  -> delivery and closing evidence back to Sales and CEO
```

The finished application must answer, without invented data:

1. What has Sales committed to produce?
2. What needs planning or a management decision now?
3. Are materials, operations, time and capacity ready?
4. What is scheduled today and what is at risk?
5. Where is each order, work order and piece in the production flow?
6. Which department or person owns the next action?
7. What changed, who changed it and which downstream application consumed it?

### Professional SaaS standard for this module

“SaaS level” means:

- every KPI is live, sourced and explainable;
- worklists lead with exceptions and next actions rather than launcher tiles;
- one canonical status vocabulary is projected consistently across screens;
- server-side authorisation matches the department grant and approval model;
- mutations are validated, idempotent where retries are possible, and audited;
- loading, empty, forbidden, partial-data and retryable-error states are real;
- dense production screens remain usable from 375 px through office desktop;
- shared records stay shared instead of being copied into a PM-only truth;
- API and URL compatibility is tested before internal code is reorganised;
- observability distinguishes a slow dependency from an empty business result.

It does not mean replacing the existing ERP, renaming factory vocabulary for
fashion, or cloning a generic project-management product.

---

## 2. Current system map

### 2.1 Application shape

The frontend is a Next.js App Router application. The Project Manager shell is
configured in `components/DashboardLayout.js` and rendered under
`app/project-manager/**`. It already uses the shared GRAV Frost shell and shared
UI primitives.

The backend is an Express/Mongoose service mounted from `server.js`. Project
Manager behavior is spread across Sales, Customer Request, manufacturing,
work-order, scheduling, production-tracking, inventory and notification
routers. Socket.IO carries live production updates.

### 2.2 Current navigation

Visible navigation:

- Dashboard
- Manufacturing orders
- MF production schedule
- Products & BOM
- Setting & Config
- Pipeline
- Requests

Routes for production stats, work-flow track, approvals, settings and support
still exist even though their navigation entries were intentionally removed.
They must not be deleted until callers, bookmarks and notification links are
inventoried.

### 2.3 Record ownership

There is no separate ManufacturingOrder model. A manufacturing order is a
`CustomerRequest` with the Sales-approved status
`quotation_sales_approved`. `WorkOrder.customerRequestId` connects its
product/variant production work.

The authoritative records remain owned by their existing modules:

| Concern | Current authority |
|---|---|
| Customer commitment and commercial lifecycle | Sales Journey / Enquiry / CustomerRequest |
| Manufacturing-order projection | Sales-approved CustomerRequest |
| Product/variant production unit | WorkOrder |
| Product and BOM | StockItem and linked raw items |
| Day and capacity placement | ProductionSchedule |
| Piece and machine execution | ProductionTracking and completion scan records |
| Cutting | Cutting records and WorkOrder cutting projection |
| QC | QC inspection records; WorkOrder contains a limited aggregate/manual projection |
| Packaging and dispatch | Packaging/dispatch records and WorkOrder projections |
| Material request | MRF; approval belongs to the requester's manager/TL |
| Department access | AccessDepartment and DepartmentRole |

Professionalisation must improve these relationships; it must not create PM
copies of the records.

### 2.4 Shared frontend surfaces

Products & BOM and the configuration pages are thin route wrappers around
shared pages. `AutoDashboardLayout` and `useStockItemsBasePath` keep the user in
the shell from which the shared screen was opened. The Pipeline similarly
reuses the Sales Journey implementation with a Project Manager scope.

These are deliberate integration boundaries. A cleanup must not fork these
screens merely to make the folder tree look self-contained.

### 2.5 Existing role model

The codebase contains both a legacy `ProjectManager` account model and the newer
department-grant model. The shared shell checks access to the
`project-manager` department. Department roles are viewer, editor, approver and
owner; editor writes may be held for approval.

The backend boundary is incomplete. Some PM-specific mounts use
`departmentWrites`, while many shared manufacturing routers require only a
valid employee session. The production-dashboard router imports employee auth
but does not currently install it. This is a finding to verify and correct in a
dedicated access chunk, not an excuse for an unreviewed blanket guard over all
`/api/cms/manufacturing/**` routes: Cutting, QC, Packaging and Production
Supervisor legitimately write through the same namespace.

---

## 3. Principal problems

### 3.1 The landing dashboard presents fictional facts

`app/project-manager/dashboard/page.js` contains hard-coded totals, activity
and alerts. A production dashboard that confidently shows sample figures is
worse than an honest empty state.

**Direction:** the landing page becomes a live, read-only production worklist.
Every number links to the records behind it, and unavailable data is labelled
unavailable rather than replaced with a sample.

### 3.2 Status is derived in several places

CustomerRequest, WorkOrder, ProductionSchedule and department execution records
all have status fields. The manufacturing-order list derives display status
from work-order data, while other screens use different buckets and labels.
Planning completion currently sets a work order to `scheduled`, which also
describes calendar placement.

**Direction:** retain storage values for compatibility, define a canonical
read projection, then move transitions behind named domain actions. Do not run
a broad status migration before readers and writers are mapped.

### 3.3 Large files mix view, orchestration and persistence assumptions

Several PM pages exceed 800 lines and core routers exceed 1,000–2,000 lines.
This makes a styling change capable of changing business behavior and makes
contract drift difficult to detect.

**Direction:** extract tested selectors, adapters, API clients and focused view
components incrementally. Never rewrite a whole screen and its API in one
unreviewable pass.

### 3.4 Authorisation is route-history dependent

Authentication is present in most routers but department authorisation is not
uniform. A frontend `RoleGate` is useful affordance, not security. Mount-level
blanket guards are also dangerous because different departments share the
manufacturing prefix.

**Direction:** produce an endpoint ownership/capability matrix, then protect
named mutations according to their true owner. Reads need an explicit audience
policy too. Preserve legacy and admin access through tested compatibility
rules.

### 3.5 Requests show contradictory affordances

MRFs are deliberately read-only for Project Manager because the requester's
manager/TL approves them. The generic request list can still render PM action
controls for an MRF, and the server then answers 403.

**Direction:** present MRF oversight as read-only and reserve PM decisions for
manufacturing-order requests. The UI and server must describe the same
authority.

### 3.6 Tracking has competing formats and projections

Barcode parsing, completion scans, production tracking and work-order progress
are implemented through multiple paths and formats. Some progress endpoints
scan broad collections and rebuild state in application memory.

**Direction:** first document and test the accepted formats and current source
of truth. Then create one read projection and one explicit ingestion contract;
do not “clean up” formats by invalidating already printed codes.

### 3.7 Legacy and hidden routes have unknown callers

Removing a navigation item does not retire a route. Bookmarks, notifications,
PDF links, other departments and mobile clients may still use it.

**Direction:** maintain a compatibility register. A route can redirect, become
an alias or be retired only after its callers and replacement are recorded.

---

## 4. Non-negotiable preservation boundaries

Every chunk must preserve unless its brief explicitly says otherwise:

- existing `/project-manager/**` URLs and meaningful bookmarks;
- the shared Frost shell and GRAV design tokens;
- department switching and the `project-manager` access guard;
- legacy ProjectManager login and platform-admin access;
- Sales-approved CustomerRequest as the manufacturing-order source;
- WorkOrder IDs and `customerRequestId` relationships;
- Sales Journey reuse and PM-scoped behavior;
- Products & BOM/configuration reuse through `AutoDashboardLayout`;
- Store material verification and inventory references;
- Cutting, Production Supervisor, QC, Packaging and Dispatch workflows;
- notification and socket destinations;
- existing barcode values and printed-label compatibility;
- existing API response fields; additions may be made compatibly, but fields
  are not renamed or removed without a versioned migration;
- all unrelated uncommitted work in both repositories.

---

## 5. Sequential implementation chunks

### Chunk 1 — trustworthy landing and contract safety

Replace the fictional PM dashboard with live, read-only manufacturing data and
add characterization coverage around the exact APIs it consumes.

- Characterize the existing manufacturing-order stats route and preserve its
  URL and response fields; change route ordering only if a test proves it is
  unreachable in the running Express version.
- Keep it authenticated and prove anonymous access is refused.
- Render live production totals and a short recent/priority manufacturing-order
  worklist using the existing manufacturing-order APIs.
- Add links to Manufacturing orders, Schedule, Requests and Pipeline.
- Implement loading, retryable error, empty and partial-data states.
- Remove hard-coded production counts, activity and alerts.
- Do not change models, statuses, scheduling, work-order planning, approvals,
  barcode behavior or downstream records.

This is the first user-visible improvement and the first compatibility harness.

### Chunk 2 — endpoint ownership, access and audit boundary

- Inventory every API called from `app/project-manager/**`, including shared
  page calls.
- Classify owner, readers, mutation capability, approval behavior, audit event
  and other app consumers.
- Fix confirmed missing authentication.
- Apply department capabilities to PM-owned mutations only.
- Preserve Cutting/QC/Packaging/Production Supervisor writes on shared routes.
- Add forbidden, held-for-approval and direct-write tests.
- Define migration behavior for legacy ProjectManager accounts.

### Chunk 3 — manufacturing-order worklist and detail architecture

Split into 3A (the list) and 3B (the detail), so the register could be made
dependable without a single large mixed frontend/backend rewrite.

**3A — canonical list projection and query contract. Complete (3 Sep 2026).**

- Establish one tested manufacturing-order read projection. — *done:
  `services/manufacturing/moList{Query,Projection}.js` + `moList.service.js`,
  pure policy and projection behind one persistence seam.*
- Make filters, search, pagination, deadlines and risk indicators server-backed.
  — *done for the list: `priority` and `deadlineRisk` filters, escaped literal
  search, normalised pagination with documented maximum page and page size,
  stable sort, and a completion percentage bounded to 0-100.*

**3B — detail projection. Backend complete (3 Sep 2026); decomposition not started.**

- Reconcile `GET /:id`, `/:id/detailed` and `/emplloyeeTracking/:id` with the 3A
  projection. — *done: `services/manufacturing/moSummary.service.js` reuses the
  list's derivation stages, and all three now publish the same eight canonical
  fields the register does, additively. Two defects on `/:id/detailed` (a 500 on
  any order with a work order, and a silently empty raw-material summary) were
  reproduced and fixed.*
- Decompose the detail page into focused panels without changing URLs. —
  **not started; Lane B**, now that the contract is stable.
- Separate order identity, work-order plan, execution progress and exceptions.
- Remove dead/static components only after reference checks.
- Preserve every downstream tab and deep link.

### Chunk 4 — work-order planning integrity

Split into 4A (audit) and 4B (implementation), because changing planning
lifecycle meanings needs a product decision first.

**4A — audit and contract characterisation. Complete (3 Sep 2026).**
See `docs/audits/project-manager-work-order-planning-integrity.md` and
`test/project-manager/work-order-planning-characterization.route.test.js`
(52 tests). Sixteen defects ranked, three of them data-corruption paths; three
suspicions disproven; stock authority confirmed to rest correctly with Store.

**4A.1 — emergency data-integrity corrections. Complete (3 Sep 2026).**
Four proven defects fixed in `PUT /:id/allocate-raw-materials` only: strict
quantity validation (omitted/boolean/string/array/object now 400, previously
either a 500 or silent corruption), an ID-derived `workOrderNumber` for split
children (splitting was a one-shot capability database-wide), and a stable
material-scaling basis (replay no longer compounds). No lifecycle state,
authorization, audit or orchestration was touched. 22 unsafe findings remain.

**4A.2 — canonical work-order identity. Complete (3 Sep 2026).**
`workOrderNumber` was declared unique while no production creation path
assigned it — the two Sales generators and both return/rework generators — so
only one numberless work order could exist. A `pre("validate")` invariant on the
WorkOrder model now assigns `WO-<full 24-character ObjectId>` to every new
record before its first write, covering `new+save`, `create` and `insertMany`.
No existing record was renamed and no migration was run; a dry-run-by-default
pre-check and backfill script is provided unexecuted.

**4A.2 corrections (3 Sep 2026).** Return/rework scan barcodes now derive from
`_id.slice(-8)` rather than the canonical `workOrderNumber`, which parsed but
resolved to nothing; the backfill's write log is exact per record, uses one
definition of a usable number, and refuses apply on any canonical-target
collision before its first write. The migration remains unexecuted.

**4A.2 second correction pass (3 Sep 2026).** The return route's corrected
barcodes are now proven at the route boundary by intercepting the progress
update before mongoose discards the unknown field; the backfill pages on a
stable `_id` cursor so every candidate gets exactly one outcome per run; the
cross-document target race is documented honestly as requiring either a unique
index or a quiesced-writer window; and the barcode gap is inventoried by
behaviour (5 building paths, 8 persistence sites, 4 still building from
`workOrderNumber`, all 8 discarded by the schema).

**4B-D — decision package. Complete (3 Sep 2026). Decisions 1–14 approved;
decision 15 outstanding.**
`docs/decisions/project-manager-work-order-planning-lifecycle.md`, status
**APPROVED IN PART**: decisions 1–14 accepted at their recommended defaults on
3 Sep 2026; **decision 15 (review-queue owner) has no name yet**, which blocks
sign-off of the legacy classification backfill and nothing else. Chunk 4B
implementation has **not** started. Evidence inventory of all **ten**
`WorkOrder.status` writers and every reader; Option C (additive `planningState`)
+ Option A (derive schedule placement and material readiness) re-tested against
that evidence and still recommended; full transition matrix, derived-fact
authority table, orchestration contract, conservative legacy classification with
an explicit `unknown` review queue, and compatibility matrix. Corrected after
review: the persisted planning axis carries **five** values (`unknown`
included), no Mongoose schema default is proposed, the first orchestration
endpoint plans a single document because transactions are unavailable in CI, and
re-planning a scheduled work order requires removing it from the schedule
first. A final pass integrated the manual *Mark Production* writer (W10)
throughout, ruled out backfilling any legacy record to `released`, and stopped
treating `plannedAt` as proof that planning was ever validated. A closing
cleanup settled W10's replay semantics — production, QC and packaging are
capped targets whose identical repeat is a no-op, but **dispatch is
incremental**, so the route as a whole is **not replay-idempotent** —
characterised its non-transactional three-write boundary,
and made the unreleased-start exception durable.
**Decisions 1–14 were approved on 3 Sep 2026** and authorize the schema,
projection, compatibility-route, orchestration and observability work they
describe. **Decision 15 — the named operational owner of the legacy review
queue — remains unanswered.** It blocks only sign-off and application of the
**legacy classification backfill** and ownership of its `unknown` review queue.
Chunk 4B implementation may begin; **no backfill may be approved or applied
until decision 15 has a real named owner.**

**4B — approved, implementation begun (4B.1).** The audit's §10 asks which of *planning in
progress*, *planning complete*, *ready to schedule*, *placed on the schedule*,
*released to production* and *production started* the business wants
distinguished. `WorkOrder.status` conflates them today. Recommended: an additive
`planningState` field, with derivable facts computed in the projection layer
rather than stored. Decided: adopted (decision 1). **Implementation started —
4B.1 adds the additive field and its new-record invariant only.**

The original scope below stands:


- Define named transitions for material allocation, operation planning,
  planning completion and production start.
- Separate “planned” from “placed on the schedule” in the read vocabulary while
  retaining compatible stored values until migration is approved.
- Make the multi-step planning acceptance safe to retry and honest on partial
  failure.
- Validate BOM snapshots, units, shortages, operation sequence and time.
- Produce an immutable planning/audit history.
- Keep Store as stock authority and configuration masters shared.

### Chunk 5 — production scheduling reliability

- Consolidate duplicated Sales/PM scheduling behavior behind shared services or
  adapters while preserving both API prefixes.
- Formalize capacity, breaks, holidays, overrides, locking and over-capacity
  decisions.
- Add conflict detection, optimistic concurrency and idempotent moves.
- Make undo explicit and server-backed where promised.
- Verify month/week/day and narrow-screen behavior.

### Chunk 6 — execution and exception control centre

- Define one backward-compatible barcode ingestion contract.
- Build one efficient work-order/piece progress projection from authoritative
  execution records.
- Replace duplicated manual aggregates where they disagree with source records.
- Surface stalled work, invalid scans, shortages, rework, missed deadlines and
  blocked department handoffs with an owner and next action.
- Preserve existing printed barcodes and shop-floor clients.

### Chunk 7 — requests, Pipeline and cross-department decisions

- Align the Requests UI with actual authority: MRF oversight is read-only; MO
  decisions are actionable for the correct role.
- Define what PM approval means downstream and whether rejection merely flags
  or blocks release; do not infer this business decision in code.
- Keep the shared Sales Journey implementation and expose only PM-relevant
  actions, pending work and production evidence.
- Verify notifications and deep links in both Sales and PM shells.

### Chunk 8 — shared masters, cleanup and SaaS hardening

- Confirm ownership and editing permissions for Products & BOM, measurements,
  operations, machines, warehouses and units.
- Keep shared route wrappers; remove only proven duplication.
- Add response-time budgets, query/index checks, structured error logging and
  operational health indicators.
- Complete accessibility, keyboard, mobile/tablet and bright-floor contrast QA.
- Remove obsolete routes/components only through documented redirects or an
  approved retirement plan.
- Run full regression, build and cross-application browser verification.

---

## 6. Definition of done for every chunk

A chunk is complete only when:

- its exact frontend routes and backend endpoints are listed;
- preserved cross-application contracts are named;
- no unrelated code or uncommitted work was reverted;
- changed behavior has automated coverage at the appropriate boundary;
- loading, empty, error, forbidden and success states are handled;
- relevant desktop and mobile/tablet screens are checked;
- no sample data is presented as live data;
- build/test results and pre-existing failures are reported honestly;
- durable docs record any changed ownership, status or compatibility decision;
- the next chunk can begin without silently inheriting an unresolved decision.

---

## 7. Decisions required before later chunks

These do not block Chunk 1:

1. Whether PM approval is advisory or a hard release gate for manufacturing.
2. The business distinction between planned, schedule-ready, scheduled and
   released-to-production.
3. Whether Project Manager may edit shared product/configuration masters or
   only propose changes.
4. Which execution aggregate is authoritative when WorkOrder projections and
   department records disagree.
5. The supported lifetime for legacy ProjectManager accounts.
6. Whether hidden legacy PM routes should redirect, remain deep-link-only or be
   retired.
