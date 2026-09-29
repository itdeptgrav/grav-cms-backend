# Industrial Engineering (IE) App — Product and Architecture Plan

> **Status:** Approved department boundary; proposed delivery plan. No
> application code is changed by this document.
>
> **Plan date:** 7 September 2026
>
> **Product direction:** IE is a dedicated application. It owns manufacturing
> methods and standards. Production Planning consumes approved IE standards;
> Production executes them and returns actual results.
>
> **Related direction:**
> [GRAV Garment Manufacturer App Architecture](./garment-manufacturer-app-architecture.md)

## 1. Product outcome

Build one Industrial Engineering application that answers four questions for
every style:

1. What operations are required, and in what sequence?
2. What is the approved standard time for each operation and for the garment?
3. What machines, attachments and people are required to run it?
4. What output should a line be capable of under a stated configuration?

The permanent flow is:

```text
Approved technical style from R&D
  -> IE work queue
  -> method study
  -> operation bulletin and route
  -> operation-level SAM/SMV
  -> machine and skill requirements
  -> proposed line layout and balance
  -> capacity standard and target
  -> review and approval
  -> controlled release to Production Planning and Production
  -> actual performance feedback
  -> analysed revision or retained approved standard
```

The app is not a production-control screen. IE defines the approved way and
expected performance; Production records what actually happened.

## 2. Permanent ownership boundary

### 2.1 IE owns

- operation library and engineering vocabulary;
- operation bulletin for each style/version;
- operation route and sequence;
- operation-level and total SAM/SMV;
- method-study observations and evidence;
- machine-type, attachment and workstation requirements;
- skill and manpower requirements by role, not named employee assignment;
- standard line configuration and proposed line layout;
- line balancing and bottleneck analysis;
- capacity standards under stated assumptions;
- standard production targets;
- engineering revisions, approvals and supersession;
- comparison of approved standards with safe Production actuals.

### 2.2 IE does not own

- customer, enquiry, quotation, PO or commercial dates — Sales;
- material/component selection and style coordination — Merchandising;
- tech pack, measurements, construction specification or sample evidence — R&D;
- order loading, factory/line booking or production calendar — Production Planning;
- named operator, machine or shift assignment — Production;
- physical machine availability, maintenance or calibration — Maintenance;
- material stock, reservation, issue or return — Inventory;
- inspection, defect approval, hold or release — Quality;
- salary, labour burden, cost rate, margin or selling price — HR, Finance and Board policy;
- purchase or subcontract rate — Purchase;
- actual output, downtime, rejection or rework — Production and Quality.

### 2.3 Boundary in one sentence

IE publishes an approved standard; Planning commits capacity against it;
Production executes it; Quality and Production return actual evidence; only IE
can revise the standard.

## 3. Relationship with Production and Production Planning

| Fact or action | Owner | IE access |
|---|---|---|
| Operation route and standard time | IE | Full control |
| Machine type and attachment requirement | IE | Full control |
| Standard line layout and balance | IE | Full control |
| Factory and line booking | Production Planning | Read-only status |
| Planned start/end and order loading | Production Planning | Read-only status |
| Named machine/operator assignment | Production | Read-only where needed for analysis |
| Floor scans, WIP and actual output | Production | Read-only aggregate |
| Downtime and machine availability | Maintenance/Production | Read-only status |
| Defects, rework and quality holds | Quality | Read-only aggregate |

Production may request an engineering change but cannot edit an approved
bulletin or SAM. IE may propose a revised method but cannot silently alter an
already released production order. A revision states its downstream effect and
requires acknowledgement from affected Planning and Production records.

### 3.1 Barcode and machine-tracking continuity

The existing shop-floor connection must survive the department split. Today a
scan records a printed work-order piece barcode against a physical `machineId`
and the operation-code snapshot active on that machine; work-order operations
also carry those codes. This remains Production execution evidence and is not
moved into IE.

IE must provide the upstream provenance, not replace the scanner contract. A
future approved release freezes stable IE operation, bulletin-row and standard
version references into the Planning/Production snapshot while retaining the
operation code needed by deployed devices and already printed barcodes. A later
read-only actuals projection may then connect scans back to that exact frozen IE
standard. It must never infer a match from a mutable display name, silently
reinterpret an old code, or invalidate a barcode already printed.

The physical `Machine` asset and scan-time `machineId` remain owned by
Production/Maintenance. IE's planned machine type is not a physical assignment.
Linking the two requires a company-scoped upstream machine identity/type
contract; the current global free-text machine register is not safe enough.
Until that contract exists, the relationship is explicitly unknown rather than
guessed.

## 4. Current codebase assessment

GRAV has useful IE fragments but no coherent IE product boundary.

### 4.1 Existing foundations to retain

- `Operation` stores an operation name, code, SAM, duration and machine type.
- `OperationCode` and `OperationGroup` provide partial operation-library
  organisation and bulk reuse.
- `SampleStyle.techSheet.technical.operations[]` currently stores the style
  route used by Central Costing.
- `services/production/styleRoute.service.js` provides an allowlisted style
  route boundary and correctly refuses materials, status and financial fields.
- `StockItem.operations[]` stores a downstream product route used by current
  planning, work-order and costing behavior.
- `WorkOrder.operations[]` is a planning/execution snapshot with operation code
  and planned time.
- `ProductionSchedule` provides a basic day schedule and capacity calculation.
- `Machine`, `MachineType` and `CanvasLayout` provide machine and layout
  foundations.
- Production and Quality records already return operation-linked actuals that
  can later feed method improvement.

These are migration inputs. They must not become parallel writable authorities.

### 4.2 Principal problems

1. **The route is labelled as Production-owned.** The current service says the
   route and standard time are Production's engineering judgement. Under the
   approved boundary, they belong to IE.
2. **The canonical route lives inside an R&D aggregate.** Keeping a temporary
   adapter is acceptable; keeping R&D's style document as the permanent IE
   command record is not.
3. **Global masters are not company-scoped.** Operation codes, operations,
   machines and schedules need explicit company and organisational scope.
4. **Operation identity is weak.** Duplicate codes are reported but permitted;
   product and work-order records carry names/codes without one stable,
   versioned engineering reference.
5. **SAM is mutable.** Updating a library operation can change its current
   value without establishing which released styles use the old standard.
6. **No complete operation bulletin exists.** Sequence and time exist, but
   workstation, attachment, skill, helpers, quality point, method evidence and
   revision rationale are not one governed record.
7. **Capacity is too simple.** The present day schedule compares work-order
   minutes with one day-minute total; it does not model line configuration,
   manpower, efficiency, bottleneck machines, shift calendars or style SAM.
8. **Layout represents physical placement, not an approved style balance.** A
   machine canvas cannot by itself answer which operation, skill and standard
   work content belongs at every station.
9. **Salary and time are coupled in the operation master.** IE may select a
   labour-grade requirement but must not see payroll or own the financial rate.
10. **The UI is scattered.** Operation configuration appears through Store,
    Sales, Project Manager, Merchandiser and Production Supervisor routes.
11. **Planning and execution are mixed under Project Manager.** Existing screens
    must be assigned to IE, Planning or Production by fact ownership before
    migration.
12. **Legacy records lack reliable scope and provenance.** No broad backfill
    may guess company, standard version or approval state.

## 5. Canonical records

### 5.1 Operation Library Entry

A reusable engineering definition, company-scoped and versioned:

- stable operation ID and unique active code within company;
- name, aliases and product/process category;
- description and standard method;
- default machine type and required attachments;
- required skill/grade;
- default observed and allowed-time guidance;
- active, retired and replacement references;
- effective dates and change history.

Library time is a starting standard, not permission to rewrite a released
style. Copying an operation into a bulletin creates a versioned snapshot.

### 5.2 Style Engineering File

The root IE record for one technical style/version:

- company, legal entity/division and applicable factory scope;
- style ID and approved R&D technical-version reference;
- product/variant identity snapshots for readability;
- assigned IE engineer, reviewer and approver;
- engineering state and readiness gaps;
- current approved bulletin version;
- downstream release and acknowledgement state;
- revision and audit history.

The file contains no Sales Journey, customer pipeline, supplier rate, salary,
costing amount or margin.

### 5.3 Operation Bulletin Version

An immutable-on-approval ordered set of rows:

- stable row ID and sequence;
- operation-library version reference;
- operation code/name snapshot;
- department/process stage;
- observed time, rating, allowances and resulting standard time;
- machine type, attachment, workstation and skill requirement;
- operators/helpers required;
- predecessor/dependency and parallel-operation rules;
- method note, sketch/video/document evidence;
- quality checkpoint indicator;
- change reason and source row when revised.

The version stores calculated totals and the exact policy/configuration version
used. Draft recalculation never changes an approved version.

### 5.4 Method Study

A governed evidence record:

- style and bulletin-row reference;
- observer, place, date and method;
- repeated cycle observations;
- exclusions and abnormal-cycle reasons;
- performance rating;
- allowance categories and effective policy;
- calculated basic and standard time;
- evidence attachments and review decision.

Manual standard-time entry requires a reason and suitable approval. Missing
observations never become zero.

### 5.5 Line Configuration and Balance Version

- applicable style and bulletin version;
- intended factory, floor, line type and shift pattern;
- station order;
- operation rows assigned to each station;
- machine types and attachments per station;
- operator/helper/skill requirements;
- station work content, pitch time and balance loss;
- bottleneck and constraint notes;
- approved target assumptions;
- layout diagram/version and evidence.

This is a standard/proposal. Production owns the actual line, people and
machines used on a given run.

### 5.6 Capacity Standard

A reproducible calculation tied to an approved bulletin and line configuration:

- available minutes and shift/calendar source;
- planned operators and helpers;
- SAM/SMV;
- target efficiency;
- learning-curve/ramp assumptions where configured;
- machine or workstation constraint;
- expected hourly/shift/day output;
- effective period, applicability and approval.

The minimum transparent calculation is:

```text
standard minutes required = order quantity × approved garment SAM
earned minutes            = good output × approved garment SAM
efficiency                 = earned minutes / attended productive minutes
target output              = available operator minutes × target efficiency / garment SAM
```

The result remains provisional or blocked when its calendar, manpower, SAM or
constraint inputs are missing. A later phase may add simulation, but it must
not hide these inputs behind an unexplained target.

## 6. Lifecycle and states

### 6.1 Engineering file

`AWAITING_TECHNICAL_RELEASE -> READY_FOR_IE -> IN_ENGINEERING -> IN_REVIEW -> APPROVED -> RELEASED -> SUPERSEDED`

Additional terminal state: `CANCELLED`, with reason. Rejected review returns a
new draft revision; it does not erase the reviewed submission.

### 6.2 Bulletin version

`DRAFT -> SUBMITTED -> APPROVED -> RELEASED -> SUPERSEDED`

Approval requires:

- an approved R&D technical-version reference;
- at least one valid operation;
- unique row identity and deterministic sequence;
- positive standard time for every timed operation;
- machine/skill requirement or an explicit not-applicable reason;
- no unresolved duplicate operation code;
- calculated total SAM matching the sum of included rows;
- reviewer distinct from author when segregation policy requires it;
- stated applicability and effective date.

### 6.3 Change control

- Approved versions are immutable.
- Editing creates a successor draft from the approved version.
- Every changed row records before, after, reason and actor.
- Impact analysis identifies affected plans, work orders, costings and active
  production runs.
- Released work keeps its frozen standard unless an authorised re-release is
  acknowledged.
- Emergency deviations are Production records; they do not silently redefine
  the standard.

## 7. Application information architecture

**Superseded 8 September 2026 — IE navigates order-wise.** The numbered list
below this note is the approved navigation; the earlier style-first proposal it
replaced is kept only as the paragraph that follows, so the change is legible
rather than silently rewritten.

Use the simple application name **IE** and the following navigation:

1. **Orders** — the landing page. A bounded, company-scoped register of the
   production orders IE must engineer, each showing its linked styles, their
   engineering readiness, route/SAM position and typed gaps.
2. **Operations** — reusable operation methods, codes, machine types and
   attachments (the operation library).
3. **Line Planning** — standard line configurations, stations and balancing.
4. **Capacity** — capacity standards, line assumptions and target comparison.
5. **Reports** — SAM history, balance loss, capacity and plan-versus-actual.
6. **IE Settings** — allowance policies, templates, approvals and numbering.

### 7.0 What was decided, and what will not be built

- **IE works order-wise.** A department that engineers what the factory is
  about to make navigates by the thing the factory is about to make. The
  landing page is Orders.
- **A style is an engineering unit inside an order, not a peer of it.** Styles
  are reached by opening an order. There is no top-level Styles section.
- **Overview and My Work will NOT be built.** Both were personal-queue
  abstractions over an order register that did not exist yet. An Overview is a
  set of counts nobody can act on without opening the order behind them, and My
  Work presumes a per-person assignment model IE has not defined and this
  architecture does not yet store. Neither is scheduled; if a case for either
  returns later it must arrive as its own decision, with the record that makes
  it truthful.
- **The Chunk 1A style endpoints remain.** `GET /api/cms/ie/styles`,
  `GET /api/cms/ie/styles/:styleId` and `GET /api/cms/ie/operations` are kept as
  reusable internal read APIs — the order detail composes the same projection
  and links out to the style endpoint — but they are no longer a navigation
  destination of their own.
- **No frontend until orders are actually linkable.** Chunk 1B's order contract
  has since been reviewed and accepted, and the shell is still blocked — for a
  second and larger reason. The readiness audit found 0 of 95 operational orders
  with a provable order-to-style/company link. The shell is **Chunk 1E** and may
  begin only after **Chunk 1D** — the order-to-style linkage write path — is
  implemented, tested and the audit rerun. A shell built over a register that
  renders empty is how a provisional shape becomes permanent.

### 7.0.1 Lane A — ownership is provenance, not queue membership

**Approved and ACCEPTED 8 September 2026.**

> Company ownership is permanent record provenance. Lifecycle status controls
> queue participation, not ownership. IE order history therefore retains
> company-proven completed, cancelled and inactive styles, while active
> Merchandising queues may exclude them.

- A completed, cancelled or archived style **proves** which company a work order
  belongs to. Its order stays in the IE register.
- Active Merchandising queues continue to exclude those styles. That behaviour
  is unchanged — IE opts out of the lifecycle clauses through the ownership
  rule's existing `activeOnly: false` mode; Merchandising's callers pass
  nothing and get the same answer they always did.
- A cancelled or archived style behind an **open** order raises an explicit
  typed warning (`CANCELLED_STYLE_ON_ACTIVE_ORDER`,
  `INACTIVE_STYLE_ON_ACTIVE_ORDER`). It is never silently removed.
- A **completed** style raises no warning. Development that finished is what
  production is built on, and reporting it as a defect would train people to
  ignore the warnings that matter.
- Parentage is untouched: a named journey is authoritative, an enquiry answers
  only for a style with no journey, and a missing, dangling or company-less
  journey stays unprovable. Customer, creator, product name and free text
  establish nothing.

Measured effect on the live database: styles with provable ownership rose from
25 to 34, and attributable work orders **from 1 to 6 — five orders recovered**.
Seven orders have agreeing direct and order-line references; six of those are
attributable after Lane A, and the seventh remains unattributable because its
style has no provable company parentage, which Lane A deliberately did not
relax. Operational coverage stayed at 0%, because the open population's fault is
a missing link rather than a closed style.

### 7.1 Style workspace

One style workspace contains:

- **Summary** — identity, technical baseline, state, readiness and release;
- **Bulletin** — ordered operations and total SAM;
- **Method Study** — observations, rating, allowances and evidence;
- **Machines & Skills** — machine, attachment, skill and manpower requirements;
- **Line Balance** — stations, pitch, bottlenecks and balance loss;
- **Capacity & Targets** — transparent inputs and calculated output;
- **Revisions** — comparison, impact, approvals and acknowledgements;
- **Actuals** — read-only Production and Quality feedback.

Screens lead with missing inputs, decisions and exceptions. They do not expose
raw database documents or display invented dashboard figures.

## 8. Roles and permissions

| Role | Access |
|---|---|
| IE Viewer | Read approved records and permitted drafts |
| IE Engineer | Create studies, draft bulletins, layouts and capacity standards |
| IE Reviewer | Review methods, return drafts and comment |
| IE Approver | Approve and release standards within assigned scope |
| IE Manager | Assign work, manage scope, approve overrides and monitor performance |
| Production Planner | Read released standards and acknowledge handoffs |
| Production Manager | Read released standards, request changes and return actuals |
| R&D | Read handoff state, answer clarification and publish technical revisions |
| Quality | Read relevant operations/checkpoints and publish defect aggregates |
| Management | Read approved standards, risks and aggregate performance |

Permissions are further bounded by company, division, factory, product category
and assigned team. Frontend visibility is not authorisation; every command is
checked server-side.

The maker-checker rule is configurable, but the system always records who
authored, reviewed and approved. Nobody gains salary, margin or supplier-rate
visibility merely by receiving IE access.

## 9. Cross-application contracts

| From | IE consumes | IE publishes |
|---|---|---|
| R&D | approved technical version, construction and measurements, revision notice | clarification, engineering readiness, approved method reference |
| Merchandising | execution priority and approved requirement-change notice | safe status, target readiness and engineering risk |
| Production Planning | required-by date, candidate factory/line constraints | released bulletin, SAM, machine/manpower requirement, capacity standard |
| Production | actual configuration, productive minutes, output, downtime and deviation | executable route, standard target, layout and approved revision |
| Quality | operation-linked defect/rework aggregates | operation and quality-checkpoint reference |
| Maintenance | machine/attachment availability and capability status | required machine types, attachments and required-by dates |
| HR | anonymised skill availability/count by scope where authorised | required skills and manpower quantities; no named allocation |
| Central Costing | no costing input enters IE | approved route/SAM projection with provenance; no salary or rate |
| Management | policy/configuration and approval assignments | risks, capacity and variance aggregates |

Every handoff is company-scoped, versioned, allowlisted, idempotent and
auditable. Names are historical snapshots; stable IDs are the links. Consumers
acknowledge a release or state why it was refused.

## 10. Reports and operating indicators

### Operational

- styles awaiting technical release;
- engineering workload and overdue studies;
- drafts awaiting review or approval;
- missing machine, skill or method evidence;
- unacknowledged releases;
- active-production change requests;
- styles blocked by duplicate or retired operation definitions.

### Engineering

- total SAM and revision trend by style/category;
- operation contribution and bottleneck analysis;
- line balance efficiency and balance loss;
- target versus actual efficiency using frozen standards;
- learning curve by run without rewriting the standard;
- downtime and defects by operation/machine type;
- standard-versus-actual variance requiring study.

### Governance

- standards used after supersession;
- manual-time overrides;
- maker-checker exceptions;
- missing acknowledgements;
- records with unprovable company or style ownership;
- configuration and approval-policy changes.

## 11. Technical and migration architecture

1. Introduce a company-scoped IE read boundary before moving any data.
2. Treat the existing SampleStyle route as a compatibility source, not the
   permanent IE record.
3. Add the Style Engineering File and immutable bulletin versions beside the
   current storage.
4. Link a bulletin to the exact approved R&D technical version.
5. Adapt the current Production style-route endpoint to read the IE projection;
   new IE writes go through IE-owned commands only.
6. Freeze approved route/SAM snapshots into downstream work orders and costing
   versions, with the IE version reference and provenance.
7. Make StockItem operations a downstream projection or legacy adapter; do not
   allow it to compete as a second route authority.
8. Split physical machine placement from style line-balance layouts.
9. Build an outbox and idempotent consumers for release and revision events.
10. Backfill only when company, style and route identity are provable. Ambiguous
    records enter a named review queue; nothing is guessed.
11. Preserve old routes as read aliases until caller inventory, reconciliation,
    rollback and reference-coverage checks pass.
12. Retire shared Store/Sales/Project Manager operation editors only after the
    IE replacement has parity and their deep links have been migrated.

All mutable drafts use revision tokens. Stale writes return a conflict rather
than overwriting another engineer's work. Multi-record releases use a database
transaction where available or a durable saga with reconciliation where not.

## 12. Sequential implementation plan

### Chunk 0 — boundary, inventory and safety harness

- Approve IE as a dedicated app and record the architecture decision.
- Inventory every operation/route/SAM writer and reader in backend and frontend.
- Produce an authority and endpoint-access matrix.
- Characterise current route propagation to SampleStyle, StockItem, WorkOrder,
  Production, Quality and Costing with tests.
- Measure duplicate operation codes, unscoped masters, empty routes and legacy
  records; do not mutate them.
- Define compatibility, reconciliation and rollback gates.

### Chunk 1 — truthful IE read boundary and order worklist

Revised 8 September 2026 to match the order-wise decision in §7.

- **Chunk 1A — ACCEPTED 8 September 2026.** The IE department identity and `ie`
  role grant, and an allowlisted, company-scoped read boundary: the style
  projection, the two legacy route sources published separately with a
  comparison state between them, and the operation library with its scope
  limitation stated. No writer, no frontend.
- **Chunk 1B — ACCEPTED 8 September 2026.** The order-wise read boundary the
  landing page is built on: `GET /api/cms/ie/orders` and
  `GET /api/cms/ie/orders/:orderId`, company-scoped, with per-style engineering
  readiness composed from Chunk 1A. No Overview and no My Work — see §7.0.
- **Chunk 1C — ACCEPTED 8 September 2026 (after the Lane A review).** The
  read-only production-data readiness audit —
  `docs/audits/industrial-engineering-order-readiness-data-audit.md` and
  `scripts/audits/ie-order-readiness-audit.js`. Chunk 1C is the AUDIT and
  nothing else; the frontend is Chunk 1E below.
- **Lane A — ACCEPTED 8 September 2026.** Status-independent style ownership;
  see §7.0.1.
- **Chunk 1D — ACCEPTED 8 September 2026.**
  Each writer carries its established department authority (Sales for the three
  release paths, Project Manager for the split and both remakes) *and* proves
  company membership separately — neither substitutes for the other.
  Every newly created work order stores one proved `sampleStyleId` in its
  original write, or creation is refused before any related write — derivatives
  included. Acting company proved from membership; typed HTTP refusals;
  canonical never overrules contradictory stored evidence. `WorkOrder.sampleStyleId`, the
  canonical order-specific style link, written at creation by every live
  work-order writer from the exact request line or the exact source order, with
  typed refusals where neither proves a style. No backfill: the 147 existing
  orders are untouched and the live audit still reports 0 of 95 operational
  orders visible. Originally specified as: a reliable
  order-specific style linkage write path, so newly created work orders carry a
  provable link to the style they are made from. This is the blocker: the audit
  found **0 of 95 operational orders** with a provable order-to-style/company
  link — every one resolves to `UNRESOLVED_ORDER_LINE`. Acceptance of Chunks
  1A–1C and Lane A approves **no historical backfill**; Chunk 1D is a write-path
  change for new orders, and what to do about existing records is a separate,
  unapproved decision.
- **Chunk 1E — ACCEPTED 9 September 2026.** Registered as a
  real launchable department (`AccessDepartment` slug `ie`, landing
  `/industrial-engineering/orders`), with a membership-bound company selector
  and order detail that carries its route rows. The IE application
  shell in `grav-cms` at `/industrial-engineering`, gated on the `ie` grant:
  Orders (landing) and Operations built against the accepted read boundary, and
  Line Planning, Capacity, Reports and IE Settings present as clearly labelled
  planned destinations. No Overview, no My Work, no top-level Styles page, and no
  mutation control anywhere. The final presentation pass uses the shared
  Accounting/Chrome Under Frost visual system while keeping IE-specific
  components and behaviour. The combined frontend review suite passed 138/138.

  Frontend work is authorised **independently of historical backfill**: the
  corrected Chunk 1D path links newly created orders, and existing orders may
  legitimately produce an empty register. The readiness audit's
  `NOT_READY_FOR_ORDER_WISE_FRONTEND` remains a statement about the DATA.
- Keep all existing writes unchanged throughout Chunks 1A–1C.

### Chunk 2 — company-scoped operation library

- **Chunk 2A — ACCEPTED 9 September 2026.** A separate company-scoped
  `IeOperation` master now provides stable identity, unique ACTIVE code per
  company, aliases, retirement/restore and atomic optimistic concurrency under
  `/api/cms/ie/operations/library`. IE editors may write; viewer reads and
  company membership remain separate checks. The legacy global Operation
  register is unchanged and no migration or backfill was performed.
- **Chunk 2 Operations frontend — ACCEPTED 9 September 2026.** The IE
  Operations page now consumes the company library and supports create, edit,
  retire and restore against the accepted editor boundary. Revision conflicts,
  typed field errors and write refusals preserve the user's draft; restore-code
  conflicts are resolved as two explicit decisions rather than a hidden
  two-write chain. The complete IE frontend suite passes 166/166.
- **Chunk 5A backend — ACCEPTED 9 September 2026.**
  Each company operation now carries a revisioned RESOURCE-REQUIREMENT profile:
  machine types with quantities, attachments with codes and quantities, and
  operator/helper requirements with skill and grade. Requirements only — no
  named employee, no serial-numbered machine, no availability and no capacity.
  The audit found no company-scoped Maintenance or HR master safe to reference
  (`MachineType` is global, `Machine` is a physical asset, and no Skill or Grade
  master exists), so the rows hold normalised snapshots and this chunk creates
  no cross-department master. Read is `GET`, write is `PATCH` on
  `/operations/library/:operationId/requirements`, revision-controlled and
  atomic; bulletin snapshots, method studies and approved standard times are
  provably unaffected. First configuration must explicitly answer all three
  groups; later PATCH requests may update one group while preserving the
  others. The complete IE backend suite passed 435/435 independently in Codex
  review.
- **Chunk 5A frontend — ACCEPTED 9 September 2026.** The existing Operations
  destination now includes a Resource Requirements workspace using the shared
  Accounting/Chrome Under Frost presentation language. Its client preserves
  the backend's real sibling envelope (`operation`, `requirements`, `history`),
  takes status and revision from the operation, supports explicit first
  configuration and later partial group edits, and refreshes the complete
  bounded history only after a real update. Viewer and retired-operation states
  are read-only. No named allocation, live availability, capacity or release
  behaviour was introduced. The complete IE frontend suite passed 534/534
  independently in Codex review.
- Introduce stable operation identity, company scope, aliases and retirement.
- Enforce unique active code per company after ambiguity is reconciled.
- Add machine type, attachment, skill and method metadata.
- Version changes that affect an engineering standard.
- Import/export with row-level validation and preview.
- Replace scattered editors with read aliases before retiring any route.

### Chunk 3 — Style Engineering File and draft bulletin

- **Chunk 3A backend — ACCEPTED 9 September 2026.** One company-scoped IE file
  is created idempotently from the exact approved R&D technical revision. Its
  DRAFT bulletin has ordered stable row identities, server-captured operation
  snapshots, nullable proposed SAM, deterministic totals, typed readiness gaps,
  embedded atomic history and optimistic revision conflicts. Unchanged rows do
  not silently rebase when their library operation changes; a normalised no-op
  save performs no write and creates no revision or history event. There is no
  submit, approval, release, migration, backfill or frontend in this slice.
- **Chunk 3B frontend — ACCEPTED 9 September 2026.** From a style inside an
  opened order, IE can open the file and edit its ordered DRAFT bulletin using
  the accepted company operation library. The Accounting/Chrome Under Frost UI
  shows the frozen R&D source separately, proposed SAM and readiness gaps,
  revision-conflict recovery and on-demand history. Unsaved work is protected,
  stale cross-style/company responses are ignored completely, and the client
  cannot omit `rows` and accidentally clear a bulletin. No top-level Styles
  route and no submit, approval, release or standard-time control were added.
  The complete IE frontend review suite passed 285/285.
- Create one IE file from an approved R&D technical version, idempotently.
- Build ordered bulletin editing with stable row IDs and revision conflicts.
- Calculate total SAM deterministically on the server.
- Record readiness gaps, assignment and audit history.
- Adapt legacy SampleStyle routes for reading without creating a second write.

### Chunk 4 — method study and standard-time approval

- **Chunk 4A backend — ACCEPTED 9 September 2026.** A company-scoped draft
  method study now records repeated timed cycles, explicit exclusions,
  performance rating and evidence notes against a captured bulletin-row
  operation snapshot. It calculates observed and normal time deterministically,
  preserves stale studies as evidence, and adds no allowance, standard time,
  approval, bulletin write-back or release behaviour. The complete IE backend
  suite passed 350/350 in review.
- **Chunk 4A frontend — ACCEPTED 9 September 2026.** Each saved bulletin row
  now opens an Accounting-style Method Study workspace for repeated cycles,
  exclusions, rating, evidence, saved calculations and historical studies.
  Viewer/editor controls, unsaved-work protection, stale-source handling and
  revision-conflict recovery are explicit. The complete IE frontend suite
  passed 357/357; the focused corrected suite passed 72/72 in Codex review.
- **Chunk 4B backend — ACCEPTED 9 September 2026.** Company-scoped,
  effective-dated allowance policies and the method-study submit, return and
  maker-checker approve lifecycle now produce an immutable standard-time
  snapshot. The active-study uniqueness rule covers both DRAFT and IN_REVIEW;
  zero-percent policy is explicit; manual overrides must remain finite through
  stored minute/second arithmetic. No bulletin write-back, release or
  downstream publication was added. The complete IE backend suite passed
  407/407 independently in Codex review.
- **Chunk 4B frontend — ACCEPTED 9 September 2026.** IE Settings now manages
  effective-dated allowance policies, including explicit zero-percent policy,
  immutable published-policy detail and maker-checker publishing. The Method
  Study workspace now supports submit, return and approve, displays frozen
  standard-time and policy snapshots, and retains every submission attempt.
  The correction pass made lifecycle input and policy state target-scoped,
  ended every busy state on refusal, and made a server write refusal final.
  The complete IE frontend suite passed 464/464 independently in Codex review.
- Record repeated observations, rating, allowances and evidence.
- Configure effective-dated allowance policy.
- Calculate basic/normal/standard time with explicit precision rules.
- Add submit, review, return and approve actions with maker-checker controls.
- Freeze approved bulletin versions.

### Chunk 5 — machines, skills and manpower requirements

- Define machine-type and attachment requirements per operation.
- Define skill/grade and operator/helper quantities.
- **Chunk 5B availability integration — BLOCKED 9 September 2026.** The source
  audit found no safe upstream contract to consume. The machine asset register
  is global, uses free-text types and exposes condition rather than availability
  or commitment. HR has no company-scoped skill/grade capability master or
  anonymised availability aggregate. Attendance, absence and Store/Purchase
  access membership are not substitutes. No IE endpoint was created; missing
  availability remains unknown, never zero.
- Consume safe availability statuses from Maintenance and HR.
- Surface shortages without exposing named employees or payroll.
- Publish approved requirement projections to Planning.

### Chunk 6 — line layout and balancing

- **Chunk 6A backend — ACCEPTED 9 September 2026.** A separate IE-owned,
  company-scoped DRAFT layout binds ordered bulletin rows to the exact bulletin
  revision and a deterministic fingerprint of their approved standard-time
  evidence. It provides stable ordered stations, coverage gaps, optimistic
  revision control, bounded history and server-calculated work content, pitch,
  bottleneck, balance efficiency and loss. Any accepted bulletin edit or newer
  approved standard makes the old layout read-only evidence and permits a new
  exact-source layout. Production's physical `CanvasLayout` is unchanged. No
  people/machine assignment, availability, capacity, approval or release was
  added. The complete IE backend suite passed 472/472 independently in Codex
  review.
- **Chunk 6A frontend — ACCEPTED 10 September 2026.** The existing Line
  Planning destination now provides the station-arrangement workspace against
  the exact accepted source. Requested and accepted targets are kept separate;
  unsaved work is protected across layout, file, company and page navigation;
  source-change refusals permanently freeze the loaded record; and all balance
  figures and readiness gaps remain server-owned. It follows the shared
  Accounting/Chrome Under Frost presentation language without importing
  Accounting business behavior. The complete IE frontend suite passed 670/670
  independently in Codex review.
- **Chunk 6B backend — ACCEPTED 10 September 2026.** New or explicitly replaced
  bulletin rows freeze their operation's required machine-type evidence;
  historical rows with no proof remain explicitly unknown. Stations may state
  planned machine types and counts, and the server publishes per-assignment and
  layout-level `COMPATIBLE`, `INCOMPATIBLE` or `UNKNOWN` results with actionable
  readiness gaps. Frozen requirement evidence participates in source identity
  without changing the fingerprint of legacy layouts. The existing barcode,
  physical-machine, operator-session and active-operation-code paths are
  unchanged. The complete IE backend suite passed 500/500 independently in
  Codex review.
- **Chunk 6B frontend — ACCEPTED 10 September 2026.** Line Planning now exposes
  planned machine types and quantities per station to editors and the same
  facts read-only to viewers. It renders only the server's per-assignment and
  layout-level compatibility verdicts, keeps every unknown state explicit, and
  prints all new readiness gaps. The Production link remains honestly unknown:
  no barcode, scanner, physical-machine, availability or work-order API was
  connected. The UI follows the shared Accounting/Chrome Under Frost language.
  The focused suite passed 48/48 and the complete IE frontend suite passed
  718/718 independently in Codex review.
- **Chunk 6C backend — ACCEPTED 10 September 2026.** Company-scoped line
  templates capture station patterns without copying layout, station, row,
  source, revision, history or ownership identity. Slots use stable operation
  ids plus deterministic source-order occurrence; application either resolves
  every required slot or refuses atomically, then mints fresh station ids and
  recalculates the target layout through its existing publisher. Templates have
  optimistic edits and reversible retirement, and the layout audit stores the
  applied template id and revision structurally. The focused suite passed 52/52
  and the complete IE backend suite passed 552/552 independently in Codex
  review.
- **Chunk 6C frontend — ACCEPTED 10 September 2026.** IE Settings now manages
  active and retired line templates, while Line Planning can capture the stored
  arrangement and safely apply an active template. Both template and operation
  pickers follow their server cursors; permission loss preserves a draft as
  read-only; dialog and asynchronous state cannot cross company, file or layout
  targets; and successful capture/application completes atomically without
  weakening the busy-close guard. The UI keeps planned machine types separate
  from Production's physical assignments and preserves the existing barcode
  boundary. Codex independently passed the focused suite at 93/93 and a broad
  IE frontend review sweep at 756/756; the implementation report records the
  complete frontend suite at 811/811.
- Build station assignment and layout versioning.
- Calculate pitch, bottleneck, balance efficiency and balance loss.
- Validate operation coverage and required machine compatibility.
- Support reusable line templates without copying their identity.
- Keep actual people/machine assignment in Production.

Chunk 7A's backend and frontend and Chunk 7B's bounded ramp backend and frontend
are now accepted. **Chunk 7C1's immutable Operation Bulletin Version lifecycle,
Chunk 7C2's Line Layout approval and Chunk 7C3's Capacity Standard approval are
ACCEPTED:** submit,
return and approve move the bulletin version and
Style File in real MongoDB transactions; the embedded bulletin remains the sole
draft; submitted snapshots are immutable in every state; and approval maintains
one current approved version with exact source and audit evidence. Codex
independently passed the focused replica-set suite at 58/58; the implementation
report records the complete IE backend suite at 711/711. Line Layout approval
binds one exact approved Bulletin Version, requires maker-checker and complete
provable machine compatibility, and makes the approved layout immutable. Codex
independently passed its corrected focused suite at 47/47; Lane A reports the
complete IE backend suite at 755/755. Capacity approval binds the standard to
one exact approved Line Layout revision, re-proves its complete frozen source,
keeps assumed working time explicitly provisional, and makes the approved
standard permanent evidence. Codex independently passed its corrected focused
suite at 46/46; Lane A reports the complete IE backend suite at 801/801. The Chunk 8
release-readiness audit is also accepted: PPC can
receive a company-scoped IE release, while freezing provenance into WorkOrders
is separately blocked on Production tenancy and ownership. IE issuance now has
all three IE-owned approval prerequisites. **Chunk 8A-i is ACCEPTED 13 September
2026:** one immutable, company-scoped release freezes the approved bulletin,
exact approved layout revision and approved capacity standard; issuance is
idempotent, maintains one version-chain head, and writes the release,
predecessor supersession and command ledger in one real MongoDB transaction.
Every accepted key is bound, including an identical-aggregate no-op, and release
and ledger evidence is protected from application deletion or bulk mutation.
Codex independently passed the corrected focused suite at 46/46; Lane A reports
847/847 across all IE backend suites and 82/82 across the named Production,
barcode, Style File, Line Layout and Capacity regressions. The next backend
slice is **8A-ii**, the PPC inbound queue and immutable receiver receipt. In parallel,
the frontend must expose the accepted 7C1–7C3 approval contracts before it adds
a release action. The calendar half
remains blocked rather than guessed. IE still does not own Production assignment
or scan ingestion, and Chunk 5B remains blocked on the missing Maintenance/HR
availability contracts.

### Chunk 7 — capacity standards and targets

- **Chunk 7A backend — ACCEPTED 10 September 2026.** A company-scoped DRAFT
  capacity standard freezes one exact line-layout revision and its approved
  SAM provenance, accepts explicit working-time and manpower assumptions, and
  deterministically publishes hourly, shift and daily targets with conservative
  whole-piece floors. No authoritative company-scoped factory working-time
  calendar exists, so the linkage is explicitly `UNKNOWN` and otherwise valid
  records remain `PROVISIONAL`. A changed layout or bulletin freezes the record;
  unavailable provenance fails closed; strict calendar dates, optimistic edits,
  honest no-ops and bounded history are enforced. Codex independently passed
  the focused suite at 60/60; the implementation report records all 20 IE
  backend suites at 612/612 and the Production/barcode regression group at
  68/68.
- **Chunk 7A frontend — ACCEPTED 10 September 2026.** Capacity is now a real
  company-scoped register and DRAFT-standard workspace, opened from the exact
  accepted Line Planning layout. It renders only server-published source,
  assumptions, calculations, readiness and history; it adds no approval,
  release, booking or Production promise. Dirty layouts cannot open a standard,
  dirty capacity assumptions survive company/standard navigation until an
  explicit keep-or-discard decision, and reload, internal navigation and every
  editor exit protect unsaved work. Create answers are scoped by company,
  engineering file, line layout and a monotonic dialog epoch, then rechecked
  against render-current identity before any browser navigation. Codex
  independently passed the focused frontend suite at 115/115; the implementation
  report records every IE frontend test file at 927/927.
- **Chunk 7B backend — ACCEPTED 10 September 2026.** IE now
  owns a company-scoped, versioned ramp profile: named, reviewable stages that
  tile a run from production day one, each stating a target efficiency greater
  than zero and at most 100. Stage order is derived from the production days
  themselves, overlaps and gaps are both refused, retirement is reversible and
  releases the active name, and optimistic revisions, honest no-ops, bounded
  history and typed field-level refusals follow the register pattern held since
  Chunk 2A. A capacity standard FREEZES the profile id, revision, name, stage
  identity, day range and percentage, and the ramp target is produced by Chunk
  7A's own calculator under the same `HALF_UP_4DP` rounding and the same floor —
  there is no second formula. Correcting or retiring a profile afterwards
  rewrites no standard. A ramp is an assumption and says so: it holds no date,
  scan, output, operator or machine, and which stage applies is stated
  explicitly rather than inferred from progress. Codex independently passed the
  focused suite at 41/41; the implementation report records all 21 IE backend
  suites at 653/653 and the Production/barcode regression group at 68/68.
- **Chunk 7B frontend — ACCEPTED 10 September 2026.** IE Settings now manages
  company-scoped ramp profiles without adding a seventh navigation item, and
  Capacity requires an explicit profile and stage choice before freezing the
  accepted backend evidence. Saved standards display that frozen profile,
  revision, stage and target without refreshing from the live profile. Dirty
  profile drafts survive company/profile navigation until an explicit decision;
  keeping one restores the parent Settings company and URL. Create, retire and
  restore completions are atomic and scoped by render-current company, epoch and
  record identity, so stale answers cannot clear a newer draft, replace another
  open profile or trigger a blind reload. Codex independently passed the focused
  Ramp and Capacity suites at 213/213; the implementation report records every
  IE frontend test at 1025/1025.
- **Chunk 7B calendar integration — BLOCKED 10 September 2026.** See below. The
  audit is `docs/audits/industrial-engineering-chunk-07b-working-time-audit.md`.
- Consume working calendars and candidate line constraints.
- Calculate hourly, shift and daily capacity transparently.
- Support target efficiency and configured ramp assumptions.
- Block incomplete or contradictory inputs.
- Publish approved capacity standards to Production Planning.

**The working-time calendar is BLOCKED, not deferred.** The Chunk 7B source audit
re-checked every candidate against current code and found no safe authoritative
source. Merchandising's `WorkingCalendarVersion` is company-scoped, versioned and
publish-frozen, but proves only working DAYS: it carries no shift duration, no
break duration and no shifts per day, and those three are exactly what the
calculation consumes. `ProductionSchedule` holds shift minutes and breaks with no
company scope, no revision and no version, inside Production's own booking
document. HR `AttendanceSettings` is a platform-wide singleton attendance-grading
policy, read through a short memo and back-filled with defaults. So
`calendarLinkage.state` stays `UNKNOWN`, working time remains an explicitly
labelled `IE_PLANNING_ASSUMPTION`, and readiness stays `PROVISIONAL`.

The missing upstream contract is a company-scoped, versioned, publish-frozen
**factory working-time standard** exposing, per effective period: a stable id and
an immutable version, gross shift minutes, non-productive break minutes, shifts
per day, optionally a working-day pattern or a reference to a calendar version
that proves one, effective dates, and a horizon past which it refuses to answer.
Until an accountable department owns that record, IE will not manufacture it.

### Chunk 8 — release, acknowledgement and change impact

- **Release-readiness audit — ACCEPTED 11 September 2026.** The Style
  Engineering File remains the stable one-per-style root and its embedded
  bulletin remains the sole working draft. Submission will create a separate,
  immutable Operation Bulletin Version; review pointers stored on the Style
  File close the submit-versus-edit race, and submit, return and approve each
  require a transaction because they move the version and root together. PPC is
  already a valid company-scoped receiver and will read immutable releases
  directly, keeping its receipt decisions immutable and deriving supersession.
  Chunk 8A deliberately has no best-effort pseudo-outbox. Existing barcode,
  operation-code, physical-machine and scan identities remain unchanged.
  WorkOrder projection is a separate Production-owned blocker. The executable
  prerequisite contract is §11 of
  `docs/audits/industrial-engineering-chunk-08-release-readiness-audit.md`.

- Release an approved IE version through an idempotent command.
- Require downstream Planning/Production acknowledgement.
- Freeze IE references into work orders and costing provenance.
- Retain the operation-code compatibility needed by existing barcode devices
  and already printed work-order barcodes while freezing the stable IE
  operation, bulletin-row and standard-version references beside it.
- Add revision comparison and downstream-impact analysis.
- Prevent silent restatement of scheduled or active work.

### Chunk 9 — actuals and continuous improvement

- Consume operation-level output, productive time, downtime, defect and rework
  aggregates.
- Compare actuals to the exact frozen standard used by the run.
- Resolve barcode/machine actuals through the released frozen references; use
  legacy operation-code matching only as an explicitly reported compatibility
  path, never as silent proof of IE identity.
- Build variance and learning-curve views.
- Let evidence open a method-study/change request; never auto-rewrite SAM.

### Chunk 10 — scale, migration and legacy retirement

- Add division/factory/team scope, pagination and bulk assignment.
- Add durable outbox, replay, reconciliation and observability.
- Reconcile provable legacy routes and isolate ambiguous ones for review.
- Migrate deep links and Help content.
- Retire legacy write paths only after parity and rollback gates pass.

## 13. Verification strategy

Every chunk requires:

- company and organisational-scope isolation tests;
- viewer/editor/reviewer/approver/manager capability tests;
- foreign and unprovable records returning non-disclosing refusals;
- idempotency and stale-revision tests;
- calculation fixtures with explicit rounding and missing-input cases;
- immutable approved-version and supersession tests;
- cross-app allowlist tests proving confidential fields cannot leak;
- backward-compatibility tests for current routes and frozen work orders;
- audit actor/time/reason tests;
- desktop, tablet and factory-floor responsive checks;
- accessibility and keyboard-order checks;
- migration dry run, reconciliation report and rollback proof before apply.

## 14. First-release acceptance criteria

The first operational release is complete only when:

1. An approved R&D technical style appears once in IE without a Sales Journey.
2. An IE Engineer can create a draft bulletin from versioned operation entries.
3. Every row has stable identity, sequence, standard time and requirements.
4. Total SAM is server-calculated and reproducible.
5. An independent permitted user can review and approve the version.
6. Approval makes the version immutable.
7. Planning and Production receive only the approved allowlisted projection.
8. A work order retains the exact IE version and standard it was released with.
9. Production cannot edit the approved route or SAM.
10. Production can request a change and IE can issue a controlled successor.
11. Existing live routes and work orders remain readable.
12. No IE response exposes salary, cost, margin, supplier rate or Sales pipeline.
13. Every action is company-scoped, authorised, idempotent where repeatable and
    auditable.

## 15. Decisions required before implementation

1. **Standard-time method:** confirm rating and allowance policy terminology
   used by GRAV. Recommended: configure it; do not hard-code one formula policy.
2. **Approval rule:** decide which styles require independent IE review and who
   may release an emergency revision. Recommended: maker-checker for every bulk
   production style.
3. **Initial organisation scope:** name the first factory, floors and lines that
   will use IE. Recommended: one factory pilot with the model ready for more.
4. **Legacy review owner:** name the person/role responsible for ambiguous
   operation codes and unprovable routes. No migration apply without this owner.
5. **Target policy:** decide whether production targets are pure IE standards or
   require Production Manager acceptance. Recommended: IE calculates and
   approves the standard; Production acknowledges feasibility and records any
   deviation.
6. **Terminology:** choose `SAM` or `SMV` as the primary displayed label while
   retaining the other as an alias. Recommended: `SAM`, matching current GRAV
   records.

## 16. Recommended immediate task

Start with **Chunk 0 only**. The first deliverable should be an evidence-backed
writer/reader and ownership audit, plus characterisation tests. Do not begin by
moving the existing route or redesigning the operation master: both already feed
Production, Quality and Central Costing, so changing them before the dependency
map exists risks restating active manufacturing and frozen costs.
