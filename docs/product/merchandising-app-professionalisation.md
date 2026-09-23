# Merchandising App Professionalisation Plan (Superseded)

> **Status:** Superseded on 8 September 2026 by
> [Merchandising App Final Plan](./merchandising-app-final-plan.md). This file is
> retained only as design history. Its proposed `My Work`, `Styles`,
> `Samples & Approvals`, `Readiness & Exceptions`, `Changes`, `Reports`, and
> `Templates & Settings` navigation must not be implemented.
>
> **Decision basis:** [GRAV Garment Manufacturer App Architecture](./garment-manufacturer-app-architecture.md)
>
> **Backend:** `/Users/risheeray/grav-cms-backend`
>
> **Frontend:** `/Users/risheeray/grav-cms`
>
> **Plan date:** 7 September 2026

## 1. Product outcome

Build one Merchandising application whose operating process remains valid from
GRAV's present scale through a multi-division, multi-factory apparel enterprise.
Growth must add organisational scopes, users, queues, templates, automation and
integration capacity. It must not require the company to replace its core
merchandising process.

The permanent process is:

```text
Approved Sales requirement
  -> Merchandising intake and ownership
  -> style execution brief
  -> material / packaging / development selections
  -> technical and sample coordination
  -> buyer-decision follow-up
  -> pre-production and material-readiness control
  -> controlled change management
  -> bulk-ready release
  -> fulfilment follow-up and closure
```

This is not a promise that regulations, customer requirements or company policy
will never change. It is a design commitment that those changes are expressed
as effective-dated configuration, templates, rules and new integrations rather
than a new workflow or a replacement application.

### 1.1 What “Shahi-level” means for this plan

This is a scale and operating-complexity benchmark, not a claim about Shahi's
private internal processes or software. Shahi publicly describes a footprint of
50 factories, more than 100,000 employees and more than 150 million garments a
year, with vertical integration across textile and garment operations. It also
describes design/prototyping, textile processing, garmenting and internal
laboratory capabilities. The GRAV design must therefore tolerate:

- many legal entities, business divisions, factories and internal mills;
- many buyer, brand, season and product-category teams;
- internal and external material/service supply channels;
- high-volume style portfolios and long historical retention;
- global-brand approval, testing, compliance and traceability requirements;
- central policy with division-, buyer- and factory-specific execution.

Public benchmark sources:

- [Shahi — company scale and footprint](https://shahi.co.in/)
- [Shahi — capabilities and vertical integration](https://shahi.co.in/what-we-do/)
- [Shahi — FY 2023–24 sustainability report](https://www.shahi.co.in/wp-content/uploads/2024/12/Shahi-Exports-Sustainability-Report-FY-2023-24.pdf)

## 2. Permanent design rules

These rules must survive every implementation chunk.

1. **Merchandising works from a Style Execution File, not a Sales Journey.**
   Sales may prove ownership through its records, but the Journey, pipeline and
   negotiation workspace do not appear in Merchandising.
2. **A controlled brief crosses from Sales.** Merchandising receives only the
   approved customer, product, commercial and date context required to execute
   the style, with a source reference and version.
3. **One fact has one owner.** Merchandising coordinates work; it does not absorb
   R&D, Store, PPC, Quality, Logistics or Finance records.
4. **Missing never means zero, complete or approved.** Every unresolved fact has
   a typed state, owner, due date and destination.
5. **A revision never overwrites an approved baseline.** Approved facts are
   versioned; later changes state their effect and preserve history.
6. **Rules are configured, not hard-coded per buyer or factory.** Buyer manuals,
   T&A calendars, approval matrices, sample requirements and readiness gates are
   effective-dated templates.
7. **Scale is hierarchical.** Company, legal entity, division, factory, team,
   buyer, brand, season and product-category scopes are first-class.
8. **Screens are work queues, not database tables.** The app leads with actions,
   blockers, deadlines, approvals and exceptions.
9. **All cross-app updates are idempotent and auditable.** Retries must not make
   duplicate styles, requirements, tasks or notifications.
10. **Retirement is explicit.** Existing routes remain readable until a named
    canonical replacement, migration and reference-coverage test exist.

## 3. Current codebase assessment

### 3.1 What exists and should be retained

The frontend currently has a Merchandising shell and 19 page routes. The useful
new core is:

- `/merchandiser/styles` — company-scoped style list;
- `/merchandiser/styles/[id]` — Style BOM entry point;
- Packaging selection — Merchandising chooses identity/specification and sees
  only a safe R&D handoff state;
- Development and tooling requirements — Merchandising says what is needed and
  never receives supplier rates or company policy amounts;
- department roles — viewer, editor, approver and owner;
- controlled company ownership proof through the existing Sales parents;
- structured R&D technical and sample records on `SampleStyle`;
- revision/history concepts and approval gates already present on styles.

The Packaging implementation is the reference ownership pattern:

| Fact | Owner |
|---|---|
| Component identity, packing instruction and selection lifecycle | Merchandising |
| Consumption, unit, basis and sample evidence | R&D |
| Supplier, quotation, validity and rate | Store / Supply Chain |
| Calculated amount and frozen provenance | Costing engine |

### 3.2 What is currently misleading or borrowed

The present Merchandising dashboard is not a Merchandising dashboard. It reads
Sales overview, customer-request and customer endpoints and describes Purchase
Orders / PI, Customers and Products & BOM as the app's work.

Most non-style Merchandising pages are thin re-exports:

| Current route group | Actual owner | Required treatment |
|---|---|---|
| `customer-requests`, `customers` | Sales | Remove from Merchandising navigation; preserve temporary deep-link compatibility |
| `products` / existing Stock Item BOM | downstream product/inventory records | Replace as the Merchandising work entry; retain only controlled reference visibility |
| warehouse, unit, operation and machine configuration | Store, IE or Engineering | Remove edit access and navigation from Merchandising |
| Sales settings re-export | Sales | Replace with Merchandising-owned templates and preferences |

The comments in the layout already say some Sales surfaces were removed, while
the dashboard still links to and reports them. The dashboard and navigation
therefore contradict one another today.

### 3.3 Missing professional capabilities

- no accepted, versioned Sales-to-Merchandising execution brief;
- no Merchandising work queue by owner, due date, buyer, season or risk;
- no assignment model for team, backup owner or escalation owner;
- no Time-and-Action calendar or milestone template engine;
- no complete Materials selection workspace in the new Style BOM;
- no buyer/brand/season/program portfolio without exposing the Sales Journey;
- no sample coordination board across R&D rounds and buyer decisions;
- no material-readiness or production-readiness control centre;
- no bulk baseline, amendment or downstream-impact workflow;
- no enterprise organisational scope beyond company plus department role;
- no safe bulk import, mass assignment or mass rescheduling;
- no Merchandising-specific reports or SLA measures;
- no archive/partition strategy for large historical style volumes.

### 3.4 Structural limits that matter at enterprise scale

`SampleStyle` is currently a large shared document containing brief, material
selection, approvals, technical work, sample rounds, packaging, services,
operations, discussion and history. This is convenient at low volume but becomes
a write-contention and document-growth boundary when multiple teams update one
style concurrently.

The style itself has no direct `companyId`; every access proves company through
its Sales parent. That is safe when implemented correctly but expensive and
fragile as the primary partition key for a large merchandising work queue.

Some list routes cap results at 200 and prove records one by one. That is a safe
boundary today, not an enterprise search or pagination architecture.

The Development screen replaces its whole list in one write. Before broad use,
the app needs an explicit revision/concurrency token so two merchandisers cannot
silently overwrite each other's changes.

## 4. Ownership boundary

### 4.1 Merchandising owns

- acceptance or clarification of the approved requirement handoff;
- internal style execution identity and coordination status;
- assigned merchandiser, team, backup and escalation route;
- buyer, brand, season and program execution context received from Sales;
- material, trim, accessory and packaging selection/specification;
- development and tooling requirement identity;
- sample requests and coordination deadlines;
- internal follow-ups and Time-and-Action plan;
- visibility of buyer decisions recorded by Sales;
- readiness coordination and exception ownership;
- style/order amendment coordination and downstream-impact acknowledgement;
- bulk-readiness recommendation based on approved facts from owning apps;
- merchandising notes, attachments, tasks and audit events.

### 4.2 Merchandising does not own

| Fact | Authoritative owner |
|---|---|
| Customer, contacts, enquiry, quotation, negotiation, customer PO and buyer communication | Sales |
| Technical specification, measurement, pattern, marker and consumption | Product Development / R&D |
| SAM, route and operation standards | IE |
| Capacity booking, factory/line allocation and production plan | PPC |
| Supplier master, quotation, rate, lead time and PO | Supply Chain |
| Physical stock, receipt, lot, location, reservation and issue | Stores |
| Production output, WIP and rework execution | Production |
| Inspection result, hold and release | Quality |
| Shipment booking, documents and dispatch | Logistics |
| Cost, margin, budget, receivable and profitability | Finance / governed Costing engine |

Merchandising may receive approved status, date and exception projections from
these owners. It must not edit their underlying facts or copy their full records.

## 5. Stable operating model

### 5.1 The root object: Style Execution File

A **Style Execution File** is Merchandising's durable coordination record. It is
created exactly once from an accepted Sales handoff or from an authorised
in-house development request.

It references, without replacing:

- the versioned Sales requirement brief;
- one stable style identity and its colour/size variants;
- the R&D technical record and sample rounds;
- IE route release;
- PPC order/plan allocation;
- Supply Chain and Stores readiness projections;
- Quality approvals;
- Logistics milestones;
- customer decisions recorded by Sales.

It carries historical snapshots only where the wording at the time matters,
such as buyer name, brand, season label, customer style number and requested
delivery date. Each snapshot records its source version.

### 5.2 Intake states

```text
ISSUED_BY_SALES
  -> ACCEPTED
  -> CLARIFICATION_REQUIRED -> REISSUED_BY_SALES -> ACCEPTED
  -> DECLINED_WITH_REASON
```

Acceptance assigns the internal file number, owner, team and first T&A plan. It
does not copy the Sales Journey or transfer customer ownership.

### 5.3 Execution workstreams

One generic status must not pretend to describe the whole style. The file has
separate, typed workstreams:

- Requirement clarification
- Materials and trims
- Packaging
- Development and tooling
- Technical development
- Sampling
- Buyer approvals
- Material readiness
- Pre-production readiness
- Bulk follow-up
- Change control

Each workstream has its own state, owner, required facts, due date, blockers and
latest approved version. The file's headline state is derived from these facts.

### 5.4 Permanent stage sequence

```text
INTAKE
  -> DEVELOPMENT_COORDINATION
  -> SAMPLE_COORDINATION
  -> PRE_PRODUCTION_READINESS
  -> BULK_FOLLOW_UP
  -> CLOSED
```

Stages may overlap. For example, long-lead sourcing can begin while a later
sample round is running if policy permits. Stage names remain stable; buyer- or
product-specific differences live in required milestone templates and gates.

### 5.5 Completion and reopening

A file closes only when:

- the final approved technical and BOM baselines are identified;
- all required buyer decisions have a recorded outcome;
- every exception is resolved, waived by an authorised person or transferred
  to a named downstream owner;
- final handoff receipts exist;
- remaining tasks are zero or explicitly cancelled with reason.

Any later amendment reopens only the affected workstreams, identifies impacted
downstream releases and preserves the previous closure.

## 6. Enterprise organisation and access

### 6.1 Organisational scopes

Every Style Execution File is stamped directly with:

- group/company;
- legal entity;
- business division;
- operating unit or factory cluster;
- nominated production factory when known;
- merchandising team;
- buyer, brand and season/program;
- product category;
- data-retention class.

These are references to governed masters. Historical labels are snapshotted for
audit, but filters and permissions use stable identifiers.

### 6.2 Roles and capabilities

Keep viewer/editor/approver/owner as simple UI levels, but enforce fine-grained
server capabilities underneath:

- `merchandising.file.read`
- `merchandising.file.assign`
- `merchandising.brief.accept`
- `merchandising.selection.write`
- `merchandising.selection.approve`
- `merchandising.tna.manage`
- `merchandising.readiness.decide`
- `merchandising.change.raise`
- `merchandising.change.approve`
- `merchandising.bulk_release.recommend`
- `merchandising.template.manage`
- `merchandising.report.export`

Every grant is constrained by organisation scope. A division approver cannot
approve another division merely because both use the Merchandising app.

### 6.3 Segregation of duties

Configuration can require that:

- the person selecting a component cannot approve that selection;
- the file owner cannot approve their own exception waiver;
- bulk-readiness recommendation and downstream production release are different
  decisions owned by different apps;
- temporary delegation has a start, end, reason and audit trail.

## 7. Canonical records

| Record | Purpose | Write owner |
|---|---|---|
| `SalesRequirementBriefVersion` | Immutable approved input required by Merchandising | Sales |
| `StyleExecutionFile` | Merchandising coordination root and organisational partition | Merchandising |
| `StyleExecutionAssignment` | Primary, backup, team and escalation ownership history | Merchandising |
| `ComponentSelectionSet` | Versioned material/trim/accessory choices and specifications | Merchandising |
| `PackagingSelectionSet` | Existing Packaging selection contract, versioned as a set | Merchandising |
| `DevelopmentRequirementSet` | Existing development/tooling identity contract | Merchandising |
| `TnaPlan` | Template version, milestone instances, dependencies and baseline dates | Merchandising |
| `CoordinationTask` | Action, owner, SLA, blocker and escalation | Merchandising |
| `ExternalDecisionReference` | Safe projection of a Sales-recorded buyer decision | Source app; read by Merchandising |
| `ReadinessProjection` | Versioned summary from technical, material, quality and planning owners | Derived/read model |
| `MerchandisingChange` | Proposed change, reason, impact, approvals and receipts | Merchandising coordinates; facts remain with owners |
| `HandoffReceipt` | Idempotent proof that a destination accepted a particular version | Receiving app |
| `MerchandisingEvent` | Append-only audit and integration event | System |

### 7.1 Identity and numbering

References must be unique within company/legal-entity policy, not globally by
accident. A number format is configured and may include division, year, buyer or
sequence, but the database identity never changes when the display format does.

Examples of distinct identities that must never be collapsed:

- internal style identity;
- buyer style number;
- brand style number;
- development/style execution file number;
- Sales enquiry or customer PO reference;
- technical revision;
- BOM/selection revision;
- colourway and size-set identifiers.

## 8. Application information architecture

### 8.1 Primary navigation

```text
Overview
My Work
Styles
Samples & Approvals
Time & Action
Readiness & Exceptions
Changes
Reports
Templates & Settings
```

Do not include Customers, Sales Journey, Purchase Orders, Warehouses, Machines,
Operations, Supplier Rates or Costing in this navigation.

### 8.2 Overview

The overview contains only factual Merchandising measures:

- files requiring acceptance or clarification;
- milestones due/overdue by owner;
- samples awaiting internal action or buyer decision;
- material and pre-production blockers;
- unresolved changes and downstream impact;
- styles approaching ex-factory risk;
- workload by team and owner;
- SLA trend and exception ageing.

Every figure opens the filtered work queue that produced it. No placeholder or
client-invented KPI is permitted.

### 8.3 My Work

Saved operational views:

- assigned to me;
- unassigned intake;
- due today / this week;
- waiting on Sales;
- waiting on R&D;
- waiting on Supply Chain or Stores;
- waiting on buyer decision;
- at risk;
- changes needing acknowledgement;
- backup/delegated work.

Support bulk assignment, rescheduling and acknowledgement only through
permission-tested commands with a preview and per-row result.

### 8.4 Styles portfolio

Filters include company/division/factory, buyer, brand, season, product type,
owner, stage, risk, sample state, readiness and date range. Lists use cursor
pagination and server-side search; they do not load an arbitrary first 200 and
filter in the browser.

### 8.5 Style Execution workspace

```text
Overview | Brief | BOM | Samples | T&A | Readiness | Changes | Files | History
```

Persistent header:

- internal and buyer style references;
- buyer/brand/season summary received from Sales;
- owner/team and organisational scope;
- current execution stage and derived risk;
- next action and due date;
- target sample, ex-factory and delivery dates where permitted;
- current approved baseline versions.

The workspace never exposes quotation cost, supplier rates, margins, Sales
pipeline data or the Sales Journey.

### 8.6 BOM

One Style BOM workspace contains separate owned sections:

- Materials
- Trims and accessories
- Packaging
- Development and tooling

Materials must replace the current placeholder using the same boundary quality
as Packaging:

- Merchandising selects identity, variant applicability and specification;
- R&D records measured consumption and allowance evidence;
- Store owns rate and supplier;
- every selection has proposed, approved, withdrawn and returned-for-correction
  semantics;
- row identity is stable even when two rows use the same item;
- approved versions freeze; changes create a new revision.

### 8.7 Samples and approvals

Merchandising coordinates but does not perform R&D work or record the buyer's
decision:

- request sample type and required date;
- see R&D accepted/start/submitted status;
- see sample round and safe technical summary;
- request Sales to send to buyer;
- see buyer decision recorded by Sales;
- coordinate correction and next round;
- track counter/reference sample custody and courier reference;
- preserve each round and its reason.

Buyer-specific sample types are configured aliases mapped to stable semantic
classes such as development, fit, size set, photo, sales, pre-production and
shipment/reference.

### 8.8 Time and Action

The T&A engine is a dependency graph, not a spreadsheet copied into fields.

Each template defines:

- milestone key and display label;
- responsible app/role;
- predecessor/successor dependencies;
- offset anchor and working calendar;
- evidence and approval required;
- escalation intervals;
- whether parallel execution is allowed;
- applicability conditions by buyer, product, order type and source channel.

Applying a template creates a frozen baseline. Reforecasting preserves baseline,
current forecast and actual dates. A milestone may be completed automatically
from an authoritative external event, but nobody may manually complete another
app's owned task.

### 8.9 Readiness and exceptions

Readiness is a projection with four distinct answers:

- ready with source and version;
- recorded not applicable with reason and approver;
- waiting on a named owner and fact;
- blocked by a contradiction or failed source contract.

Minimum readiness domains:

- requirement clarity;
- approved component selections;
- technical and sample approval;
- testing/compliance approval;
- material sourcing and stock coverage;
- packaging readiness;
- IE route readiness;
- PPC plan acknowledgement;
- pre-production approval;
- buyer approvals.

Merchandising recommends readiness. PPC/Production owns production release.

### 8.10 Change control

Every change records:

- requested change and reason;
- source: buyer, Sales, Merchandising or internal exception;
- affected style/variant/colour/size/order scope;
- previous and proposed version;
- impact requests sent to R&D, IE, PPC, Supply Chain, Stores, Quality,
  Logistics and Finance as applicable;
- returned impact summaries;
- required approvals;
- effective point and disposition of obsolete work/stock;
- downstream acknowledgement receipts;
- final outcome and audit trail.

The app never edits another owner's record as part of a change. It coordinates
commands and waits for accepted versions.

## 9. Cross-app contracts

| From | To Merchandising | From Merchandising |
|---|---|---|
| Sales | approved brief version, buyer decision status, accepted PO/date amendment | clarification request, execution acceptance, sample-send request, risk summary |
| R&D | technical/sample status, approved version, returned selection reason | approved selections, development needs, sample request and priority |
| IE/PPC | route/plan readiness and exceptions | bulk-readiness recommendation, approved requirement version, change notice |
| Supply Chain | sourcing status, lead-time risk, approved source status | approved material/service requirement and required-by date |
| Stores | stock/reservation/shortage projection | demand priority and approved requirement reference |
| Production | safe milestone/output/exception status | approved change coordination and priority context |
| Quality | inspection/hold/release status | required buyer/testing protocol reference |
| Logistics | shipment readiness/milestones | approved packing and date requirement reference |
| Finance/Costing | approved/not-ready status only where needed | source selections and requirement readiness; never a typed cost |

Every handoff contains:

- immutable source record and version;
- company and organisation scope;
- correlation/idempotency key;
- issued by/at;
- required acknowledgement by;
- minimal allowlisted payload;
- acceptance, refusal or supersession receipt.

## 10. Configuration that prevents future process changes

The following are configuration, never custom code branches:

- buyer/brand requirement profiles;
- product-category and construction templates;
- sample-type aliases and required sample sequence;
- T&A milestone templates and working calendars;
- approval matrices and financial/quantity thresholds;
- component and packaging requirement rules;
- testing, compliance and document checklists;
- allowed internal mill, nominated supplier and external supplier channels;
- SLA and escalation policy;
- numbering formats;
- risk thresholds;
- factory/division applicability;
- retention and archive policy;
- locale, time zone, currency display and units of measure.

Published configuration is effective-dated and versioned. Existing execution
files remain bound to the version they started with unless an authorised person
applies a controlled migration.

## 11. Data and integration architecture

### 11.1 Evolution from the current model

Do not attempt a destructive rewrite of `SampleStyle`.

1. Add direct company/organisation stamps to new merchandising-owned records.
2. Introduce the Style Execution File beside existing `SampleStyle`.
3. Link each file to the current style and Sales source; backfill only when
   ownership is provable.
4. Serve new screens from explicit allowlisted read models.
5. Adapt existing Packaging and Development records behind the new file.
6. Move high-contention collections—tasks, T&A, changes, events and versioned
   selection sets—into their own records.
7. Keep legacy styles readable through adapters.
8. Stop a legacy write only after parity, reference coverage, reconciliation
   and rollback gates pass.

### 11.2 Concurrency

- every mutable aggregate carries a revision;
- commands include the revision last read;
- stale writes return a conflict with the current version;
- row commands use stable row IDs;
- approval and handoff commands are idempotent;
- no whole-list replacement is allowed without a revision check;
- multi-record workflows use transactions where supported or durable saga and
  compensation semantics where they are not.

### 11.3 Events and read models

Write transactions publish through a durable outbox. Consumers acknowledge by
event ID; replay does not duplicate work. Build denormalised read models for:

- personal/team work queues;
- portfolio filters;
- T&A exceptions;
- readiness;
- dashboard aggregates;
- cross-app status.

The command record remains authoritative. A read-model delay is shown as stale
or updating; the UI never invents a current answer.

### 11.4 Files and communication

Store files in governed object storage with checksum, classification, source,
version and retention metadata. Do not grow the style document with file data.
Email/WhatsApp messages are delivery channels for a recorded command or decision,
not a separate source of truth. Public approval links are single-purpose,
expiring, revocable and confirmed before mutation.

## 12. Enterprise operating requirements

- company and organisation isolation on every query and unique index;
- server-side capability checks on every command;
- cursor pagination and indexed search on all large lists;
- immutable audit of old/new version, actor, reason, time and source;
- encryption in transit and at rest, with secrets outside records and logs;
- configurable data retention, legal hold and export;
- accessible keyboard and screen-reader workflows;
- locale/time-zone aware dates with UTC storage;
- background jobs for imports, exports, PDFs, notifications and recalculation;
- per-row validation and resumable import for large buyer/style sheets;
- observability by request/correlation ID without exposing buyer-sensitive data;
- backup and tested point-in-time recovery;
- zero-downtime schema evolution and backward-compatible event contracts;
- published service objectives for interactive reads, writes and background jobs;
- load tests using approved workload profiles representing multi-factory scale;
- archive/partition strategy so closed history does not slow active work.

## 13. Reporting

### Operational

- intake ageing and acceptance SLA;
- milestone adherence and delay ownership;
- sample rounds and approval turnaround;
- first-pass sample approval;
- material/readiness blocker ageing;
- change frequency and downstream impact;
- on-time bulk-readiness recommendation;
- workload and reassignment history;
- styles at risk by buyer, season, division and factory.

### Management

- buyer/brand/season portfolio health;
- development lead time;
- approval bottlenecks;
- long-lead material exposure;
- planned versus actual milestone trend;
- repeat-style and carry-forward performance;
- exception root-cause distribution.

Reports must declare the source, as-of time and inclusion rules. Cost, margin and
profitability remain Finance outputs and are not reconstructed here.

## 14. Sequential implementation plan

Only one chunk is active at a time. Every chunk includes backend contract,
frontend workflow, permissions, migration/compatibility, tests, documentation
and an authenticated browser walkthrough.

### Chunk 0 — freeze the boundary and measure the baseline

- adopt this plan and mark conflicting older Merchandising descriptions as
  superseded;
- inventory every `/merchandiser` route, API, model write and cross-app link;
- classify each route canonical, transitional, legacy, shared or misplaced;
- record production data volumes, index health and document-size distribution;
- add ownership/security contract tests before moving anything;
- define rollback and reference-coverage gates.

**Exit:** one approved ownership matrix and zero unknown Merchandising writes.

### Chunk 1 — truthful shell, overview and work queue

- replace the Sales-derived dashboard with Merchandising-owned facts;
- remove Customer, PO, warehouse, machine, operation and unit links;
- introduce Overview, My Work and Styles navigation;
- add paginated assigned/unassigned/overdue/blocker queues;
- preserve removed deep links with honest transitional handling.

**Exit:** every dashboard number opens its factual source list; no Sales or
Store editing surface is presented as Merchandising.

### Chunk 2 — organisation scopes and authorisation

- add division/factory/team/buyer/brand/season scopes;
- introduce capabilities and scoped grants;
- add delegation, backup owner and segregation-of-duty rules;
- stamp all new records directly with company and organisation identity.

**Exit:** cross-company and out-of-scope access is refused and tested at route,
service and query levels.

### Chunk 3 — versioned Sales intake

- define the minimal `SalesRequirementBriefVersion`;
- issue, accept, request clarification, reissue and supersede;
- create one Style Execution File idempotently;
- preserve source and acknowledgement receipts;
- support authorised in-house styles without inventing a customer.

**Exit:** Merchandising receives enough approved context to work without opening
or copying a Sales Journey.

### Chunk 4 — Style Execution workspace

- build persistent header and Overview/Brief/Files/History tabs;
- assignment history, next action, deadlines and typed workstreams;
- cursor-paginated portfolio and saved views;
- version/concurrency protection.

**Exit:** one canonical Merchandising file supports multi-team ownership and
parallel safe reads/writes.

### Chunk 5 — complete the Style BOM

- implement Materials, trims and accessories in the new boundary;
- adapt existing Packaging and Development sections;
- version selection sets and approvals;
- add return-for-correction, withdrawal and variant applicability;
- retire the downstream Stock Item page as the Merchandising BOM editor.

**Exit:** every selection is owned, versioned, auditable and safely handed to
R&D without quantity/rate ownership leakage.

### Chunk 6 — Time and Action

- template/version model;
- dependency graph, calendars, baselines and forecasts;
- automatic completion from source events;
- exception, escalation and mass-reschedule workflows;
- timeline and queue UI.

**Exit:** buyer/division variation is configuration; the process remains the
same for every execution file.

### Chunk 7 — sample coordination

- request types and due dates;
- safe R&D round/status projection;
- Sales send/decision request and decision projection;
- sample custody/courier reference;
- revision and correction loop.

**Exit:** the full sample loop is traceable without Merchandising performing R&D
or Sales actions.

### Chunk 8 — readiness and exception control

- source-backed readiness projections;
- material, technical, sample, testing and pre-production gates;
- named blockers and responsible app;
- waiver policy, expiry and approval;
- bulk-readiness recommendation and PPC receipt.

**Exit:** no green status can be produced from missing facts or manual summaries.

### Chunk 9 — change management

- raise, assess, approve/refuse and implement changes;
- impact fan-out and response collection;
- obsolete material/work disposition references;
- version supersession and downstream acknowledgement.

**Exit:** an approved-baseline change can never silently alter production-bound
facts.

### Chunk 10 — enterprise portfolio and bulk operations

- buyer/brand/season/program views;
- controlled templates and carry-forward styles;
- import preview/apply/resume/rollback;
- bulk assignment and scheduling with per-row outcomes;
- archive and retention operations.

**Exit:** high-volume work does not require spreadsheets as a second truth.

### Chunk 11 — reports, integrations and management controls

- operational and management reports;
- governed exports and scheduled delivery;
- APIs/webhooks/event consumers with contract versions;
- SLA, capacity and data-quality monitoring;
- dashboard materialisation and reconciliation.

**Exit:** every report reconciles to source records and every integration is
replay-safe.

### Chunk 12 — scale, resilience and legacy retirement

- approved multi-factory workload tests;
- concurrency, failover and recovery tests;
- archive/partition validation;
- security and permission audit;
- migration reconciliation and reference coverage;
- stop legacy writes, observe, then remove dead navigation and code.

**Exit:** the app meets agreed service objectives at the benchmark workload,
legacy paths are read-only or retired, and rollback evidence is retained.

## 15. Definition of done for every chunk

- ownership remains consistent with the product architecture;
- no other app's fact becomes writable through Merchandising;
- company and organisation scope are applied server-side;
- state transitions and permissions are tested as allow and deny cases;
- missing, empty, error, stale, forbidden, conflict and legacy states are
  designed explicitly;
- commands are idempotent and concurrency-safe;
- old records remain readable or have an approved migration result;
- audit history names actor, time, reason, source and versions;
- list performance uses indexed server queries and pagination;
- automated tests pass in both repositories;
- authenticated browser acceptance passes for editor, approver, viewer and
  out-of-scope user;
- durable product/decision/task documents are updated before closure.

## 16. Whole-app completion criteria

The Merchandising application is professionally complete when:

1. every file begins with an accepted versioned requirement or authorised
   in-house brief;
2. Merchandising has no Sales Journey, customer-master, supplier-rate, technical
   consumption, production-plan or costing editor;
3. Materials, Packaging and Development selections have stable row identity,
   versions, approvals and correction history;
4. T&A templates support buyer/division differences without code branches;
5. sample and buyer-decision coordination is end-to-end traceable;
6. material and pre-production readiness are source-backed;
7. every baseline change produces impact and acknowledgement evidence;
8. users operate from truthful queues at personal, team, division and company
   scope;
9. all large lists, imports, exports and reports operate at the approved
   multi-factory workload;
10. legacy borrowed routes are retired or explicitly read-only;
11. a new factory, division, buyer or product category is onboarded through
    masters, templates and permissions—not a software process redesign;
12. audit, recovery, retention, security and integration contracts have passed
    production acceptance.

## 17. Decisions required before implementation

Chunk 0 must obtain named business owners for these decisions:

1. organisational hierarchy and which level owns a Style Execution File;
2. internal style/file numbering policy;
3. buyer/brand/season master ownership and who may create each;
4. standard sample semantic classes and buyer-specific alias rules;
5. T&A baseline anchors and working-calendar ownership;
6. approval/segregation rules for component selection and exception waiver;
7. who recommends bulk readiness and the exact PPC acknowledgement contract;
8. legal retention periods for samples, approvals, files and change history;
9. which existing Product/Stock Item BOM remains authoritative downstream;
10. approved workload and service-objective profile for enterprise acceptance.

None of these decisions should change the permanent process. They configure who
does it, where it applies, which evidence is required and how quickly it must be
completed.
