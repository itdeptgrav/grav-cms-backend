# Sales → Merchandising → R&D → IE Development Connection Audit

> **Audit date:** 30 September 2026  
> **Scope:** Read-only inspection of the current Sales sample stage,
> Merchandising Development File, R&D style queue and IE Style Engineering
> File.  This document records the verified boundary and the proposed IE
> Development product shape.  It changes no application code and does not
> replace `docs/tasks/current-task.md`.

## 1. Verdict

The system currently contains two pre-order paths:

1. The live R&D and IE path still runs through the shared Sales-owned
   `SampleStyle`. Sales moves its stage, R&D authors and approves the technical
   record on it, and IE freezes the exact approved technical revision into one
   `IeStyleFile`.
2. The newer Sales request → Merchandising Development File → approved
   development BOM → Sales-authorised release is a separate, versioned and
   correctly owned path, but it stops at Merchandising's
   `RELEASED_TO_RND` state. It does not create an R&D receipt, move the linked
   `SampleStyle` into R&D's queue, or bind the released development BOM revision
   to the R&D technical revision IE later consumes.

The current IE demo record is therefore not proof of the full connection. Its
technical revision was seeded as approved while its shared style remained at
the Sales brief stage and it had no Development Request, Merchandising
Development File or order Execution File.

## 2. Verified ownership

| Concern | Owner | IE treatment |
|---|---|---|
| Buyer ask and authorisation to spend on development | Sales | Read a safe reference only |
| Material, trim and packaging identity | Merchandising Development | Read the released immutable revision; never edit it |
| Consumption, construction, technical record and sample evidence | R&D | Consume the approved technical revision as IE's source |
| Operation bulletin, method study, resource requirements, standard layout, capacity and engineering release | IE | Authoritative owner |
| Factory/line booking and production calendar | PPC | Read-only context in IE |
| Physical machine/operator assignment and barcode scans | Production | Read-only actual evidence; never moved into IE Development |

## 3. Existing records that must be reused

### Merchandising Development File

One file per `company + journey + productLineRef`. It answers which material,
trim and packaging identities Merchandising selected. It must not contain IE's
route, SAM, station layout or capacity decisions.

### IE Style Engineering File

One file per `companyId + sampleStyleId`. This is already the correct IE
Development aggregate. It can be opened through an order or directly through
the style before an order exists; both doors return the same record. The file
freezes an approved R&D technical revision and owns the bulletin draft and the
references to reviewed and approved bulletin versions.

There must be no new `IeDevelopmentFile` collection. “IE Development” is a
register and workspace over the existing `IeStyleFile` and its child records.

## 4. Missing connection

The cross-department handoff still needs a receiver-owned R&D contract:

```text
Sales authorises Merchandising development release
  → immutable Development File + BOM revision is published
  → R&D records receipt against the linked SampleStyle
  → R&D technical revision names the received development/BOM revision
  → IE Style Engineering File freezes that lineage with the approved R&D revision
```

Until this exists, IE Development must show the Merchandising lineage as
`UNPROVEN`, not infer it from product names, mutable display labels or the most
recent Development File.

## 5. Proposed IE Development section

### 5.1 Purpose

IE Development is the pre-order engineering work register connected to Sales'
**Sample & Style** stage. A row becomes visible when the company-scoped Sales
style/development case exists; IE must not wait until an order is confirmed or
until R&D has finished before it can see the work coming. It answers:

- which Sales sample/style developments are waiting on Merchandising or R&D;
- which R&D-approved styles are ready for authoritative IE work;
- which have not yet had an engineering file opened;
- which bulletins are being authored, reviewed or returned;
- which approved styles still lack layout or capacity evidence;
- which standards are approved or released;
- which files became stale because R&D approved a newer technical revision.

It is not a second Sales, Merchandising or R&D screen.

### 5.2 Register views

1. **Upstream development** — Sales has opened the sample/style development;
   Merchandising selection, Sales release or R&D technical work is still in
   progress. This is visible context, not permission for IE to approve a
   standard from an unfinished source.
2. **Ready for IE** — an approved R&D technical revision exists but no IE file
   has been opened.
3. **In engineering** — file opened; bulletin, studies or requirements are
   incomplete.
4. **Awaiting review** — a bulletin version is frozen in review.
5. **Returned / needs attention** — returned review, retired-operation gap,
   unresolved compatibility or newer R&D source.
6. **Approved standard** — approved bulletin exists; layout/capacity may still
   be incomplete.
7. **Released** — an IE release exists for the approved aggregate.
8. **All** — bounded history, including styles later attached to orders.

These views are projections of source and lifecycle facts. They are not a new
mutable status enum on `IeStyleFile`.

### 5.3 Register row

- style reference, product and variant;
- Sales sample/style development position;
- Merchandising selection and release position;
- R&D technical and sample position;
- exact R&D technical revision and approval time;
- Merchandising Development/BOM revision identity, or an explicit unproven
  lineage state;
- IE engineer/responsible person when that later assignment slice exists;
- bulletin position, layout position, capacity position and release position;
- total approved SAM when one exists;
- named gaps, owner and next action;
- linked confirmed-order count, without duplicating order data.

No buyer price, quotation, margin, supplier rate, stock, named operator,
physical machine assignment or barcode payload belongs on the row.

### 5.4 Workspace

The detail opens the existing Style Engineering File through a style-first URL
and reuses the existing records and controls:

1. **Summary** — identity, responsibility, current source, readiness and next
   action.
2. **Source evidence** — read-only R&D revision and released Merchandising BOM
   identity; no BOM editor.
3. **Bulletin & process route** — existing draft and version lifecycle.
4. **Method studies** — existing observations and approvals.
5. **Machines, attachments & skills** — requirements, never physical
   allocations.
6. **Line balance** — existing standard station layout and interactive canvas.
7. **Capacity & targets** — existing standards and ramp evidence.
8. **Approvals & release** — bulletin, layout, capacity and IE release chain.
9. **Changes & history** — existing bounded audit records and source-rebase
   events.

An order linked later opens this same file. It never forks the development
work into an order-specific IE file.

## 6. Navigation decision

IE now has two legitimate registers:

- **Development** — before order confirmation, connected to Sales' Sample &
  Style stage. It follows the same style through Merchandising selection, R&D
  technical/sample work and IE engineering. The authoritative IE file opens
  only when an approved R&D technical revision exists.
- **Orders / order execution context** — after order confirmation, showing
  which real order demand consumes the released standard, whether the release
  is still applicable, and the impact of later engineering revisions. IE does
  not schedule the order or execute production from this section.

Development should become the first IE navigation entry and landing page;
Orders remains beside it. This supersedes the September 8 “order-wise only”
decision because the accepted backend now deliberately opens an engineering
file before an order exists.

## 7. Ordered implementation slices

### IE-D0 — upstream lineage contract

Specify and test the R&D receiver described in §4. It is a cross-department
dependency, not an IE-owned write into Merchandising or R&D.

**Exit:** an approved R&D technical revision can prove which released
Development File and BOM revision it consumed, or explicitly state that the
lineage is legacy/unproven.

### IE-D1 — development register read boundary

Add a bounded, company-scoped IE development list that begins with the Sales
Sample & Style development population and composes the safe published position
from Sales, Merchandising and R&D, existing `IeStyleFile` records and their
approved child records. Add server-side views, search and cursor pagination.
Do not create a new aggregate and do not open files as a side effect of reading
the list. Before R&D approval the row is tracking-only; the existing IE file
creation gate remains authoritative.

**Exit:** every register classification is source-backed, cross-company IDs
are non-disclosing, and missing sources are named gaps rather than empty or
zero values.

### IE-D2 — Development frontend

Add the navigation entry, register, view tabs, company context and truthful
loading/empty/error/access states using the shared application UI kit. Opening
a row leads to the style-first workspace.

**Exit:** an IE viewer can inspect all permitted evidence; an IE editor can
open the existing file only for a style with an approved technical revision.

### IE-D3 — style-first engineering workspace

Extract/reuse the current order-nested engineering workspace under a
Development URL. Keep one state implementation and one API contract. Preserve
dirty-draft guards and the existing bulletin/method-study approval behaviour.

**Exit:** opening through Development and later through an Order reaches the
same `fileId`, revision, draft and history.

### IE-D4 — responsibility and due-date coordination

Only after a separate contract decision, add responsible IE engineer, IE
required-by date, priority and hold/reopen coordination. Assignment grants no
permission. Required-by is an input from an owning source, not a date IE
silently invents.

**Exit:** register filters and accountability are real stored facts; no “My
Work” or overdue claim is derived before those facts exist.

### IE-D5 — integrated demo and end-to-end proof

Seed one coherent chain through the real contracts: Sales request,
Merchandising approved/released BOM, R&D receipt and approved technical
revision, IE development file, approved bulletin, layout, capacity and release,
then attach a confirmed order to the same file.

**Exit:** the demo never directly seeds a downstream approval while its
upstream records remain at Brief or Pending.

## 8. Barcode and shop-floor continuity

IE Development creates no barcode and changes no scanner request. Existing
printed work-order barcodes, operation-code snapshots, physical `machineId`
values and scan ingestion remain byte-for-byte compatible. A released IE
aggregate may add stable IE references beside the old operation code, but must
never replace that code, reinterpret an already printed barcode or turn a
planned machine type into a physical machine assignment.

## 9. Decisions still requiring product confirmation

1. Whether Development becomes the IE landing page (recommended) or sits after
   Orders while still remaining a first-class section.
2. Which owning department supplies the IE required-by date before an order:
   Sales development request, R&D handoff, or a later PPC commitment.
3. Whether responsibility assignment is required in the first usable release
   or may follow the read-only register and workspace.
4. Whether legacy styles with no provable Merchandising release appear under
   **Upstream development** with a lineage warning (recommended) or only under
   **All**.
