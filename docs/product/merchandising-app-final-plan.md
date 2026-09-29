# GRAV Merchandising App — Final Product Plan

> **Status:** Approved product direction and durable source of truth
>
> **Decision date:** 8 September 2026
>
> **Supersedes:** `merchandising-app-professionalisation.md`
>
> **Scope:** Product structure and implementation sequence. No application code
> is changed by this document.

## 1. Purpose

The Merchandising app controls the internal execution of a requirement that
Sales has commercially confirmed.

In one sentence:

> Sales confirms what was promised to the buyer; Merchandising coordinates how
> the factory fulfils that promise correctly and on time.

The app is for production/order merchandising. It is not a second Sales CRM, a
Product Development workspace, a Store system, a production planner, or a task
manager.

## 2. Permanent process

Merchandising's work starts BEFORE there is an order. This plan originally
described only the confirmed-order half, and an application built to it was
missing the half the company actually spends most of its time in: choosing what
a garment is made from, for a buyer who has not ordered anything yet.

```text
PRE-ORDER DEVELOPMENT
Sales has a Journey with a product line
  -> Sales issues a versioned development request against that product line
  -> Merchandising accepts it, or asks Sales a question
  -> Merchandising selects the materials, trims, labels, accessories
     and sample packaging
  -> a Merchandising approver who did not write it approves the
     development BOM, which is then frozen
  -> Sales sees the approved selection and authorises the release to R&D
  -> R&D records technical consumption against the approved identities
  -> Costing consumes the approved identity plus R&D's consumption
  -> Sampling is made against the same approved selection
```

```text
CONFIRMED ORDER
Sales issues a versioned confirmed requirement
  -> the execution file adopts the approved development BOM
  -> Merchandising reviews and accepts or requests clarification
  -> Merchandising opens the order execution file
  -> material, trim, accessory and packaging requirements are selected
  -> development/tooling and approval requirements are issued
  -> the Time and Action plan controls milestone dates
  -> source-app progress and buyer decisions are monitored
  -> confirmed changes are coordinated without overwriting old versions
  -> Merchandising submits its completed execution pack downstream
  -> PPC owns production release; the file remains traceable through closure
```

The process stays the same as the company grows. Buyer-, division-, factory-
and product-specific differences are configuration and versioned templates,
not new workflows.

## 3. Final primary navigation

```text
Overview
Development
Order Execution
Time & Action
```

This is the complete everyday navigation.

Development is second because the bar reads in the order the work happens:
Merchandising chooses the materials before there is an order to execute. A
person asked to develop a product should not have to learn that the register
for it sits behind the register for orders.

There is no `My Work`, `My Styles`, `All Styles`, `Samples`, `Readiness`,
`Changes`, `Reports`, or `Tasks` top-level section.

- Personal responsibility is a filter in Order Execution, not a separate app
  section.
- Samples are made and technically controlled in Product Development.
- Readiness facts are owned by their source departments and shown as status.
- Changes belong to the affected execution file.
- Reports are views/exports over the canonical records.
- Configuration is available only to authorised managers through app settings.
- Tasks and reminders remain entirely in the Tasks app.

## 4. Overview

Overview answers whether Merchandising-controlled order execution is healthy.
It shows only source-backed counts:

- new Sales handovers awaiting review;
- active execution files;
- Merchandising selections or approvals still incomplete;
- T&A milestones due, missed, or forecast late;
- confirmed changes whose internal impact is unresolved;
- files whose downstream handover is blocked;
- delivery dates at risk based on the current T&A forecast.

Overview also answers the same question for the pre-order half, in a second
deck of source-backed counts:

- new development requests Sales has issued and nobody has answered;
- files where Merchandising is choosing materials;
- development BOMs submitted and awaiting an internal approver;
- clarifications Merchandising has asked Sales;
- approved selections waiting on Sales to authorise the release to R&D.

The last of those counts work that nobody in Merchandising can move, and it is
shown for exactly that reason: a merchandiser whose approved selection has sat
for a week needs to know there is somebody to chase.

Every number opens the corresponding filtered Development, Order Execution or
T&A view. It must not show Sales revenue, quotations, customer pipeline, Store
inventory KPIs, production output, or invented risk scores. A source that fails
renders "Couldn't check", never a zero — and the two decks read separately, so
one failing does not blank the other.

## 4A. Development

Development is the pre-order register. One row is one **Merchandising
Development File**, opened by a Sales development request against one Journey
product line and by nothing else.

It is not the Sales pipeline: a Journey Sales is still working on does not
appear here, and no amount of buyer interest puts a row on it. It is not Order
Execution either: no order exists, so there is no confirmed quantity, no
delivery date to coordinate and no Time & Action plan.

### 4A.1 Record grain

One file per `company + journey + productLineRef`. The product line reference is
server-minted and permanent — never the array position, the product name, the
style display text or a mutable index, because one enquiry legitimately carries
"Polo" twice in two colourways, and those are two development jobs with two
different selections.

A second request against a line that already has an open one becomes VERSION 2
on the SAME file. A merchandiser who accepted version 1 sees a revision of the
thing they already looked at, not a second file.

### 4A.2 Views

New requests, Active, Awaiting approval, Approved, Released to R&D, Closed.

`Approved` is deliberately not shown as a finished state: Merchandising's part
is done and the file is waiting on Sales.

### 4A.3 The Development File

Six tabs: Summary, Sales Brief, Materials & Trims, Packaging, Approvals &
Handover, Changes & History.

There is no sample-round tab — rounds are R&D's and Sampling's record. There is
no consumption editor — consumption is engineered by R&D. There is no Sales
control — no buyer, no enquiry, no quotation.

### 4A.4 The development BOM

Versioned, maker/checker, and IDENTITY ONLY: which material, which colour,
which finish, where it goes. Eight fields, and the server refuses every other
one BY NAME, saying which department owns the fact:

- quantity, consumption, unit, allowance, wastage — R&D's, once the pattern is
  engineered;
- rate, unit cost, total cost, price — Costing's;
- supplier, supplier quotation — Supply Chain's, chosen when it is bought;
- purchase order, stock, reservation, issue quantity — Store's;
- sample construction result — R&D's, recorded when the sample is made.

The approver may not be the author or the submitter. An owner is not exempt.
An approved revision is frozen; changing it means a new revision, and the
previous one stays readable.

### 4A.5 Two places a selection may already exist

The registered product's approved BOM, and whatever the old Sales materials
form left on the style. Both are OFFERS into a DRAFT, never automatic and never
approved by adopting: "the registered product says oxford cotton" is evidence
about a product, not a decision about this buyer's sample. Each adopted row
carries where it came from, and the legacy record is left exactly as it is.

### 4A.6 Release is Sales'

Merchandising approving says the materials are settled. Sales authorising the
release says the buyer relationship justifies spending the development budget
on them. Merchandising has no route for it and no button.

## 5. Order Execution

Order Execution is the main register. One row is one **Merchandising Execution
File**, not a task and not a Sales Journey.

### 5.1 Record grain

One file is created idempotently for one confirmed Sales order line/style
execution. Colourways, delivery drops, size ranges, or nominated factories are
child execution units when they need distinct dates, selections, approvals, or
downstream handoffs. They do not create unrelated duplicate files.

### 5.2 List views

The same register supports:

- New handovers
- Active
- On hold
- Handed over
- Closed

Filters include responsible merchandiser, team, buyer reference, brand,
season, product category, factory, stage, delivery date, T&A condition, and
status. `Assigned to me` is simply a saved filter.

### 5.3 Row content

Each row shows:

- Merchandising file number;
- Sales order/requirement reference;
- buyer style and internal style reference;
- product and colourway summary;
- responsible merchandiser;
- current execution phase;
- next critical T&A milestone;
- selection/approval summary;
- target ex-factory date;
- latest confirmed change or blocking source status.

## 6. Merchandising Execution File

The file is the permanent order-level coordination record. Its everyday UI is
organised around five questions a merchandiser asks, not around the underlying
record types:

```text
Order Brief
Product Requirements
Approvals & PP Meeting
Schedule & Handover
Changes & History
```

These are presentation groups, not merged ownership or storage boundaries.
Each group may contain compact subsections backed by the separate versioned
records described below. Existing deep links to the earlier individual tabs
must continue to open the corresponding subsection during migration.

Every group begins with a short position summary: current state, next move,
owning person or department, blocker, and the most important date. Detail is
progressively disclosed so the file remains scannable even when its audit
history and source references are large.

### 6.1 Summary

Shows the latest approved execution position, responsible merchandiser, key
dates, selection completion, approval position, T&A condition, external
blockers, and downstream handover state.

### 6.2 Sales Handover

Shows the minimal confirmed commercial requirement received from Sales:

- immutable source and version;
- customer/buyer and style references;
- quantity and delivery breakdown required for execution;
- agreed product, packing, testing, and delivery requirements;
- authorised buyer decisions and amendments.

It is read-only in Merchandising. Customer, quotation, negotiation, price,
payment terms, Sales pipeline, and buyer messages stay in Sales.

### 6.3 Materials & Trims

Merchandising owns the required identity and approved selection of fabric,
trims, labels, accessories, colours, finishes, placement, and applicability.

The principal outputs are:

- Fabric Selection Sheet
- Digital Trim Card
- approved selection revision
- printable/QR-linked frozen card

Each row has a stable identity. Approval freezes a version; later changes make
a new version and preserve the superseded one.

Merchandising does not own technical consumption, supplier quotation/rate,
purchase order, stock receipt, lot, reservation, issue, or laboratory result.

### 6.4 Packaging

Merchandising owns the packaging identity and buyer-facing packing
specification: polybag, carton, tags, stickers, folding, assortment, marks, and
selected component references.

R&D owns measured consumption, Supply Chain owns supplier/rate/procurement,
Store owns physical stock, and Logistics owns shipment execution.

### 6.5 Development Requirements

Merchandising states what development is required, for example sample class,
print, embroidery, wash, artwork, mould, screen, die, or other tooling need,
with the required-by date and approved reference.

Product Development owns the technical specification, pattern, measurement,
consumption, sample construction, sample rounds, and corrections. Their safe
status is displayed here as a reference; their work is never edited here.

### 6.6 Approvals

This is an approval register for the execution file, not a buyer-communication
screen.

- Merchandising records its own internal selection approvals.
- Sales records buyer communication and buyer approval/rejection.
- Product Development and Quality record their technical/test outcomes.
- Merchandising reads those source decisions with record and version.

No source decision may be copied into a second manually editable truth.

### 6.7 Time & Action

Shows this file's baseline, forecast, and actual milestone dates and their
dependencies. The full cross-file calendar is available from the primary
Time & Action section.

### 6.8 Pre-Production Meeting

Records the controlled minutes of the cross-functional pre-production review:
attendees, source versions reviewed, observations, decisions, unresolved
clarifications, and the issued minutes version.

Merchandising coordinates and records the meeting. The meeting does not mark
another department ready, replace the execution pack, create a second task
system, or release production. Issued minutes are immutable; a later meeting
creates a successor version. PPC reads the issued minutes as evidence and
retains ownership of its planning and production-release decisions.

### 6.9 Department Status & Handover

Shows minimal read-only status from Product Development, Supply Chain, Store,
IE, PPC, Quality, Production, and Logistics. Merchandising may confirm only its
own execution pack is complete and submit that version downstream.

- Store owns stock/material availability.
- Supply Chain owns sourcing and procurement status.
- Product Development owns technical and sample status.
- IE owns route/SAM status.
- Quality owns test and inspection status.
- PPC owns production readiness and production release.

Merchandising coordinates visibility; it cannot mark another department ready.

### 6.10 Changes & History

Sales records and authorises commercial/buyer changes. Merchandising records
the internal execution impact, sends the versioned change to affected apps,
tracks their acknowledgements, revises affected T&A forecasts, and preserves
the previous baseline.

History is append-only and records actor, time, old version, new version,
reason, source, and acknowledgements.

## 7. Time & Action

Time & Action is the only other daily operating section because a merchandiser
must control dates across many simultaneous orders.

It provides:

- cross-file calendar and critical-path list;
- baseline, forecast, and actual dates;
- predecessor and successor dependencies;
- milestones due, missed, blocked, or forecast late;
- buyer/brand/factory-specific effective-dated templates;
- working-day calendars and approved rescheduling reasons;
- source-owned milestones completed from authoritative events.

A T&A milestone is not a personal task. Any reminder, follow-up, checklist, or
assigned action is created and managed in the Tasks app with a reference back
to the Merchandising Execution File.

## 8. Ownership boundaries

| App | Authoritative facts |
|---|---|
| Sales | Lead, customer, enquiry, quotation, negotiation, price, payment/delivery terms, customer PO, buyer communication, buyer decision, commercial amendment |
| Merchandising | Accepted execution file, responsible merchant, material/trim/accessory/packaging selection, development requirement, T&A plan, internal change coordination, execution-pack handover |
| Product Development | Tech pack, measurements, pattern/CAD, marker, consumption, sample construction/rounds, technical correction |
| Tasks | Tasks, reminders, follow-ups, checklists, delegation, personal work queue |
| Supply Chain | Supplier, quotation, rate, lead time, purchase order, procurement status |
| Store | Stock, receipt, lot, location, reservation, shortage, issue |
| IE | Operations, SAM, route and method standards |
| PPC | Capacity, factory/line plan, production readiness and release |
| Quality | Testing, inspection, hold, approval and release |
| Production | WIP, output, rework and actual manufacturing execution |
| Logistics | Booking, documents, packing/dispatch and shipment events |
| Finance/Costing | Cost, margin, policy, budget, receivable and profitability |

The permanent rule is:

> If a fact changes the commercial promise to the buyer, Sales owns it. If it
> defines or coordinates how the confirmed requirement is executed internally,
> Merchandising owns it. Each specialist app still owns its technical or
> operational result.

A buyer-stated target-price ceiling may cross from Sales into a Development
File only as a read-only material-selection constraint. Sales remains its
owner; Merchandising cannot edit, approve or replace it, and it is not a
costing or quotation.

The same employee may hold more than one departmental role, especially at a
small company. That does not merge the records or permissions.

## 9. Enterprise rules

- Every new Merchandising record is directly company-, division-, team-, and
  factory-scoped where applicable.
- Every mutation requires a live Merchandising capability; assignment alone
  never grants access.
- Approved briefs, cards, selections, calendars, and handoffs are versioned.
- Writes use optimistic concurrency and idempotency keys.
- Lists use server-side search, indexed filters, and cursor pagination.
- Cross-app data is allowlisted and references its source record/version.
- Cross-app delivery uses a durable outbox; audit history is separate from
  integration delivery.
- Buyer/factory variations use effective-dated templates and never overwrite
  active-file baselines.
- Closed history is archived/partitioned without changing the live process.
- Bulk import, reassignment, and rescheduling require preview, validation, and
  per-row outcomes.

## 10. Current code treatment

The current `/merchandiser/work` exception list is not the permanent product.
Its trustworthy rules may later feed Overview counts or Order Execution
filters, but it must not become a task system.

The current `/merchandiser/styles` and shared `SampleStyle` routes are
transitional. They may be adapted behind the new execution file, but the future
Merchandising root is not the Sales Journey or the shared R&D style document.

Sales Customers, Order Book, Pipeline, Sampling, Products & BOM, and Sales
settings must not be re-exported or presented as Merchandising navigation.
Legacy deep links remain readable until a named replacement and migration gate
exist.

## 11. Sequential delivery plan

Only one implementation chunk is active at a time.

### M0 — Freeze ownership and stop expansion

- adopt this document as the durable source;
- classify every current Merchandising route/write;
- preserve current user work and legacy deep links;
- fix company isolation, live role enforcement, and failing backend tests;
- do not add more UI to `My Work` or shared Sales surfaces.

**Exit:** zero unknown Merchandising writes and a green security/test baseline.

### M1 — Versioned Sales handover

- minimal approved Sales brief version;
- issue, accept, clarify, reissue, supersede, cancel;
- idempotent receiver-owned acknowledgement;
- no Sales Journey or buyer-message exposure.

**Exit:** one safe, versioned door from Sales into Merchandising.

### M2 — Order Execution and Merchandising File

- create the Merchandising Execution File and child execution units;
- build Overview and Order Execution list;
- Summary, Sales Handover, and History tabs;
- responsible merchandiser is a record attribute, not authorisation.

**Exit:** confirmed requirements can be received and controlled without opening
Sales or Product Development screens.

### M3 — Materials, Trim Card, and Packaging

- versioned material/trim/accessory selections;
- digital trim card and printable frozen revision;
- versioned packaging specification;
- adapt current safe packaging work without importing rates or consumption.

**Exit:** Merchandising-owned selections have one approved, auditable truth.

### M4 — Development requirements and approval references

- versioned development/tooling/sample requirements;
- safe Product Development status references;
- Sales-recorded buyer decision references;
- internal selection approval with segregation of duties.

**Exit:** Merchandising can coordinate requirements and decisions without
performing another department's work.

### M5 — Time & Action

- effective-dated templates and working calendars;
- frozen baseline, forecast, actual, dependencies, and reasoned rescheduling;
- cross-file T&A calendar and exception filters;
- authoritative-event completion for external milestones.

**Exit:** order dates are controlled without spreadsheets or Tasks duplication.

### M6 — Department status and downstream handover

- minimal source-backed department status projections;
- Merchandising execution-pack completion;
- PPC receiver-owned handover receipt;
- explicit unknown/unavailable states instead of guessed readiness.

**Exit:** Merchandising can hand off a complete version while every downstream
owner retains its authority.

### M7 — Change control and enterprise scale

- Sales-authorised change intake and impact coordination;
- affected-record acknowledgements and T&A reforecast;
- bulk tools, exports, operational reports, archive, and observability;
- manager-only configuration without adding daily navigation.

**Exit:** the same operating model works across companies, divisions, factories,
buyers, teams, and high-volume history.

### Pre-order development and material selection

Delivered after M7, as a correction. `MERCHANDISING: FEATURE-COMPLETE` had been
claimed at the end of M7 and was wrong: every milestone above describes an
application that begins when Sales confirms an order, and the company's
merchandisers spend most of their time before that point.

- a Sales-owned, versioned development request against a permanent product-line
  reference;
- a separate Merchandising Development File aggregate, opened by the request
  and never by Merchandising itself;
- a versioned, maker/checker development BOM holding identity only;
- R&D and Costing reading the approved development selection FIRST, ahead of
  the registered product's BOM;
- Sales-authorised release to R&D;
- the confirmed order adopting the approved development BOM;
- a migration path off the legacy Sales-authenticated materials form that reads
  it, offers it, and never writes it;
- the two M7 UI gaps closed: a manager-only configuration editor over the
  existing endpoints, and a spreadsheet-based bulk workflow in place of
  hand-written JSON.

**Exit:** a merchandiser can answer "what is this garment made from, and who
agreed it" before anybody has placed an order.

## 12. Final acceptance test

The Merchandising app is correct only when a user can answer, without opening a
Sales Journey or editing another department's record:

1. What has Sales asked us to develop, and what did we choose for it?
2. Which development BOM revision is approved, who approved it, and is Sales
   holding the release?
3. What confirmed requirement are we executing?
4. Which material, trim, accessory, and packaging versions are approved?
5. What development and approval requirements remain unresolved?
6. Which T&A milestone threatens the committed date?
7. What has changed since the accepted baseline?
8. What is each source department's latest recorded status?
9. Which exact execution-pack version was handed downstream and accepted?

If the screen instead asks the merchandiser to manage customers, quotations,
supplier rates, technical consumption, stock, production release, quality
results, or generic tasks, the boundary has been broken.

And if a merchandiser can only answer questions 3 onwards, the application is
incomplete in the way this plan originally was: it describes the half of the
work that starts with a purchase order, and the company does most of its
merchandising before one exists.
