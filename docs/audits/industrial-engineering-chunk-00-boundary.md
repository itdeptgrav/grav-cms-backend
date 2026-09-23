# Industrial Engineering — Chunk 0 Boundary and Source Audit

**Audit date:** 7 September 2026  
**Status:** Complete enough to scope the first implementation chunk; no data
migration or application-code change was made.  
**Decision:** ADR-003 — IE and PPC are separate department applications.

## 1. Executive finding

GRAV does not have an IE application today. It has several useful engineering
capabilities distributed across Sales/R&D, Inventory configuration, Project
Manager and Production Supervisor surfaces.

The most important finding is not that an IE screen is missing. It is that
there are multiple writable answers to "what operations does this style use and
how long do they take?":

1. `Operation` — the global operation master and default SAM;
2. `SampleStyle.techSheet.technical.operations[]` — a style route written by
   the narrow Production style-route service;
3. `StockItem.operations[]` — a product route written by Sales/sample and stock
   item routes;
4. `WorkOrder.operations[]` — a released/planned execution snapshot that can
   still be added to, removed from, reordered and retimed;
5. `SampleStyle.sample.operations[]` — sample-stage operation evidence that can
   be synchronised onto the product.

These records have legitimate historical purposes, but their authority is not
explicit. Building a new IE page on top of all of them would preserve the
ambiguity. The first implementation must establish one company-scoped IE read
boundary and compatibility contract before introducing a new writer.

## 2. Approved ownership map

| Concern | Authoritative department | Rule |
|---|---|---|
| Operation definition and engineering vocabulary | IE | Versioned reusable master |
| Style operation bulletin, sequence and SAM | IE | Immutable after approval |
| Method study and allowances | IE | Evidence-backed and versioned |
| Standard machine, attachment and skill requirement | IE | Requirement, not actual assignment |
| Standard line layout, balance and target | IE | Approved configuration |
| Order loading and capacity booking | PPC | Must reference released IE version |
| Actual operator, machine, line and shift assignment | Production | May differ with recorded deviation |
| Actual output, WIP and downtime | Production | Returned to IE as read-only evidence |
| Defects, hold and release | Quality | Independent from IE and Production |
| Machine availability and maintenance | Maintenance | IE consumes status |
| Labour rate, salary and burden | HR/Finance/Management policy | Never published to IE |

## 3. Verified backend inventory

### 3.1 Operation, code, group and machine-type register

**Model:** `models/CMS_Models/Inventory/Configurations/Operation.js`

Current fields include name, operation code, total SAM, duration seconds,
machine type and salary department/designation mappings.

**Router:** `routes/CMS_Routes/Inventory/Configurations/operations.js`, mounted
at `/api/cms`.

It exposes CRUD/import for:

- `/operations`;
- `/operation-codes`;
- `/operation-groups`;
- `/machine-types`;
- category-wide application of an operation group.

**Access finding:** the router installs employee authentication only. It has no
IE capability check and the master models have no company scope. A signed-in
employee who can call the route can reach global writes. Duplicate codes are
reported on read but are not prevented.

**Confidentiality finding:** `/operations/salary-groups` reads employee
department/designation and headcount, and the wider router contains salary
lookups used for costing. The future IE boundary must expose required skill or
labour grade without exposing salary amounts or making IE own a financial rate.

### 3.2 Style technical route

**Storage:** `SampleStyle.techSheet.technical.operations[]`.

**Narrow router:** `routes/CMS_Routes/Manufacturing/productionStyleRoute.js`,
mounted at `/api/cms/production/style-route`.

**Service:** `services/production/styleRoute.service.js`.

Strengths to preserve:

- company ownership of the style is proved through existing Sales parents;
- foreign or unprovable styles return the same non-disclosing not-found result;
- request and response fields are allowlisted;
- route order is array order, so no competing sequence field exists;
- operation identity, name, code and machine type are re-read from the master;
- money, salary, supplier, Journey, material and status fields are refused;
- approved/submitted technical records are not silently edited;
- the style response contains no Sales Journey or enquiry identity.

Problems to correct through migration:

- the route is explicitly described and authorised as Production/Project
  Manager work (`DEPARTMENT = "project-manager"`), not IE work;
- the route remains inside the R&D technical aggregate;
- the operation register used to validate rows is global and unscoped;
- route replacement has no caller-supplied revision token;
- approval/release is coupled to the R&D technical status rather than an IE
  lifecycle;
- the stored row links the current operation master but not a versioned master
  definition.

### 3.3 Product route

**Storage:** `StockItem.operations[]`.

**Writers include:**

- `routes/CMS_Routes/Inventory/Products/stockItems.js` operation CRUD, tab
  updates, product create/update and operation-group application;
- `PUT /api/cms/sales/sample-styles/:id/operations/route`, which takes operation
  IDs and replaces the linked StockItem route;
- sample approval/synchronisation paths in `sampleStyles.js`;
- product creation paths carrying an operations array.

**Access finding:** the stock-item router installs employee authentication but
does not establish an IE capability or company-scoped product boundary. The
StockItem model itself has no direct company ID.

**Authority finding:** this product route is not the same array as the narrow
style route above. One can change without changing the other. New work orders
are commonly generated from the StockItem route, while Central Costing's
technical source reads the style technical route. That permits execution and
costing to describe different methods for the same style.

The target is to make StockItem operations a downstream projection or legacy
adapter from an approved IE version, never another command authority.

### 3.4 Sample operations

**Storage:** `SampleStyle.sample.operations[]`.

R&D/sample submission currently records operation observations, calculates
operation cost through shared logic and may synchronise priced operations to
the StockItem. This record is useful sample evidence but must not become the
approved bulk-production method by side effect.

Target interpretation:

- R&D publishes construction and sample evidence;
- IE may use that evidence to draft a method study;
- IE approves the manufacturing standard;
- Central Costing combines the approved time with a rate/policy it owns;
- no R&D or IE response publishes salary or labour cost.

### 3.5 Work-order route and planning

**Storage:** `WorkOrder.operations[]` with operation name/code, planned time,
status and notes.

**Router:** `routes/CMS_Routes/Manufacturing/WorkOrder/workOrderRoutes.js`.

Current endpoints can:

- read a work order and its planning context;
- retime operations through `/:id/plan-operations`;
- add an operation;
- delete one or a batch;
- reorder operations;
- bulk-plan work orders;
- complete planning and start production.

**Access finding:** the router has employee authentication globally, but only
the newer `cancel-unrouted` path installs the Project Manager department guard.
The route/SAM mutations listed above are not consistently department-authorised
or company-scoped.

**Integrity finding:** `plan-operations` uses truthy fallbacks, so an explicit
zero cannot replace a previous positive time. Unknown operation row IDs are
silently skipped, and duplicate submitted row IDs can make the last update win.
These behaviors are already characterised in the Project Manager planning
tests and must not be accidentally treated as the new IE contract.

Target interpretation:

- a work order freezes the exact released IE bulletin version;
- PPC may add scheduling context but not redefine the route/SAM;
- Production may record a deviation or request a change;
- exceptional route changes on active work require a named, audited command;
- legacy work-order mutation routes remain compatible until callers and data
  are reconciled.

### 3.6 Legacy Planning aggregate

**Router:** `routes/CMS_Routes/Manufacturing/Planning/planningRoutes.js`.

This creates a separate `Planning` record containing raw-material assignments,
machine assignments, timelines and approval state. It reads StockItem
operations and global machines.

**Access finding:** employee authentication only; no PPC capability or company
scope is established in the router.

**Ownership finding:** material assignment belongs with Inventory/PPC handoff,
machine assignment belongs to Production execution, timeline/capacity booking
belongs to PPC, and the engineering standard belongs to IE. The aggregate must
be characterised and decomposed by ownership rather than adopted by IE.

### 3.7 Production schedule

**Model:** `ProductionSchedule`.

It stores one record per date, work hours, breaks, scheduled work orders,
available and scheduled minutes, utilisation and over-capacity status.

**Critical scope finding:** `{date: 1}` is globally unique and the model has no
company, factory, floor or line identity. It therefore cannot represent two
companies or two lines on the same date as independent schedules.

The server mount has a Project Manager write guard, while the router itself has
employee authentication. This belongs to PPC, not IE. IE will publish capacity
standards; PPC will decide which work occupies capacity.

### 3.8 Machines and layouts

`Machine` is a global master with globally unique serial number and no company
scope. It mixes identity, location, availability and maintenance dates.
Maintenance should own the physical asset and its availability.

`CanvasLayout` carries a string `organizationId` defaulting to `default`, plus
physical machine positions and UI canvas state. It is written from Production
Supervisor and Project Manager production-tracking surfaces. This is an actual
floor layout, owned by Production/Maintenance context—not automatically an IE
style line-balance standard.

IE needs a separate versioned *standard line configuration* that can reference
machine types and proposed stations without taking ownership of physical
machines or the supervisor's live layout.

## 4. Verified frontend inventory

There is no `/ie` application shell.

Relevant current surfaces include:

- Project Manager registered operations, schedule, manufacturing orders,
  planning drawer, work-order detail and production statistics;
- Production Supervisor registered operations, live tracker, physical canvas
  and operation-to-machine assignment;
- shared Sales registered-operation and StockItem editors;
- Store registered-operation wrappers;
- R&D `SampleRoutePanel` and technical record;
- Production `StyleRoutePanel` backed by the narrow style-route API.

Several department routes simply re-export the Sales operation editor. This is
code reuse but not an ownership boundary: Store, Merchandising, Production
Supervisor and Project Manager can all appear to maintain the same master.

Target routing:

| Current surface | Target owner |
|---|---|
| Registered operations editor | IE Operation Library |
| R&D sample operation observations | R&D evidence, read by IE |
| Style Route & SAM editor | IE Style Engineering File |
| Work-order planning and production schedule | PPC |
| Physical canvas and machine assignment | Production |
| Production statistics and scans | Production |
| Machine asset/maintenance fields | Maintenance |
| Operation-linked defect actuals | Quality |

## 5. Dependency map

Approved engineering data currently affects:

- StockItem/product configuration;
- Sales sample and product registration;
- manufacturing-order and work-order generation;
- work-order planning readiness;
- production scheduling duration;
- barcode operation positions;
- production tracking and performance calculations;
- Quality operation and defect attribution;
- packaging/workflow progress;
- CEO production views;
- Central Costing labour assembly and frozen provenance;
- supplier/product catalogue projections.

Operation sequence is particularly sensitive because printed/scanned barcodes
and several readers address an operation by one-based array position. Reordering
a live work order can change what an existing barcode means. No migration may
rewrite active or historical work-order operation order.

## 6. Source-of-truth conflicts to freeze before implementation

1. Do not add another route array to a new IE screen without a canonical
   command/version model.
2. Do not reinterpret `SampleStyle.techSheet.technical.operations[]` and
   `StockItem.operations[]` as already equivalent.
3. Do not bulk-sync a new master SAM into released styles or work orders.
4. Do not move sample observations into IE; link them as evidence.
5. Do not make IE own actual machine assignment or the physical floor canvas.
6. Do not treat Planning's global day minutes as an IE capacity standard.
7. Do not expose salary groups, operator salary or cost through IE APIs.
8. Do not hard-delete duplicate operations; record ambiguity for review.
9. Do not add company filters to models that lack company fields and interpret
   the resulting empty query as successful isolation.
10. Do not retire role-named frontend routes until deep links, notifications and
    callers have migrated.

## 7. First implementation seam

The safest first application change is a read-only, company-scoped IE boundary:

```text
GET /api/cms/ie/styles
GET /api/cms/ie/styles/:styleId
GET /api/cms/ie/operations
```

It should:

- require an `ie` department role;
- resolve company from the authenticated actor;
- list only styles whose company ownership can be proved;
- expose no Journey, enquiry, customer, salary, rate, cost or margin;
- show the current technical route and product route as separately labelled
  legacy sources when both exist;
- calculate and report whether they agree without merging them;
- identify missing, empty, duplicate and ambiguous routes;
- write nothing;
- provide stable response contracts for the future IE shell.

The initial UI is an honest work queue over this read model. It must not offer a
Save button until the canonical Style Engineering File and version model land.

## 8. Migration gates

Before any canonical IE write is enabled:

- every route/SAM writer and consumer has a named owner;
- operation master company strategy is approved;
- active operation-code duplicates have a review owner;
- style-to-company ownership is provable or isolated;
- current style/product route divergence is measured;
- active work orders and barcode semantics are snapshotted and protected;
- Central Costing continues to freeze the exact source it used;
- compatibility reads are tested for legacy records;
- a dry-run reconciliation report exists;
- rollback restores routing without rewriting historical records.

## 9. Chunk 0 conclusion

The IE department boundary is approved. The existing narrow style-route service
is the best behavioral foundation because it already proves company ownership,
uses allowlists and refuses financial fields. It should be adapted behind a new
IE read boundary first, not renamed in place and not immediately turned into the
canonical writer.

The next bounded task is Chunk 1A: add the read-only IE backend projection and
contract tests. Frontend shell work can follow against that stable projection.
