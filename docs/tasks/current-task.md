> **Status:** Central Costing Chunks 1-2 launch sequence is the active scope.
>
> **Active brief:** `docs/tasks/central-costing-roadmap.md`.
>
> **ACTIVE IMPLEMENTATION SCOPE:** Central Costing Chunk 1, specified in
> `docs/handoff/central-costing-chunk-01-prompt.md`. Chunk 2 may start only
> after Chunk 1's company boundary, permissions, immutable version contract
> and protected API are complete.
>
> **PAUSED STORE/PURCHASE SCOPE — Chunk 1: tenant boundary, permissions,
> immutable audit history, idempotency, document sequences and safe lifecycle
> controls. NOT COMPLETE.** Architecture record:
> `docs/decisions/store-purchase-tenancy-permissions.md`.
>
> ### Chunk 1A — foundation and operational-PO pilot: IMPLEMENTED
>
> What exists and is tested:
>
> - **Tenant context** (`services/storePurchase/tenantContext.service.js` +
>   `Middlewear/storePurchaseTenant.js`) with deterministic company selection
>   and fail-closed membership.
> - **Capabilities** (`services/storePurchase/capabilities.js`) — 17 keys,
>   mapped from the existing `DepartmentRole` grants. Authentication alone
>   grants nothing.
> - **Atomic numbering** (`SpDocumentSequence`), **idempotency**
>   (`SpIdempotencyRecord`), **append-only history** (`SpActionHistory`),
>   **approval policy** (`SpApprovalPolicy`), lifecycle guards.
> - **Applied end-to-end to the operational Purchase Order router only.**
> - Frontend capability/forbidden/legacy/conflict states and a history drawer
>   on the two PO screens only.
>
> ### Chunk 1 — REMAINING, and why the boundary is not yet real
>
> **Cross-company access is NOT impossible today.** The following active
> Store/Purchase transaction routers are still unscoped, unpermissioned and
> non-idempotent, exactly as Chunk 0 found them:
>
> - MRF / material-request (review, match, fulfilment decision, issue, return)
> - Requisitions
> - Stock issuance and stock adjustment/correction
> - Vendor returns and replacement receipts
> - Barcode / lot operational writes
> - Deliveries
> - RawItem direct stock writes and its hard-delete path
> - Worksheet PO / worker work orders
> - `/api/cms/units` — still mounted with **no authentication at all**
>
> Any of those can read and mutate another company's records. Until each one
> satisfies the boundary, Chunk 1 is not done.
>
> **Passing tests do not establish completion.** The suites that pass cover
> the routers that were converted. A green run says nothing about the routers
> above, and must not be read as evidence that the boundary holds.
>
> **Chunk 2 is BLOCKED** until every active Store/Purchase transaction path
> satisfies the Chunk 1 boundary. Master-data redesign on top of an
> unenforced tenant boundary would build the new model on the same hole.
>
> **Known migration requirement:** the legacy global index `poNumber_1` must
> be dropped by an authorised migration before multi-company use. A reviewable
> script exists at `scripts/migrations/store-purchase-chunk1-indexes.js`; it
> has **not** been run against any database.
>
> ---
>
> **Chunk 0 — baseline, vocabulary and safety harness: COMPLETE
> (2026-09-01, after a technical correction pass, the Item Master addendum,
> an accuracy correction to both, and a final runtime/report-integrity
> correction).**
> All deliverables exist and are verified:
>
> 1. Full two-repo system inventory: `docs/audits/store-purchase-baseline.md`
>    (56 frontend routes, all models/routers/write paths, flow map, the
>    twelve stock-mutation sites S1–S12), **plus the Item Master audit in
>    §12** — every item-identity field across RawItem, its variants,
>    StockItem/BOM, categories, units and conversions, supplier aliases,
>    barcodes, PO/MRF/Requisition/Intake/Spend item references, budget
>    mappings, reorder fields and catalogue metadata, each classified by
>    data class, trust level, readers/writers and proposed target owner.
> 2. Read-only usage/data baseline: `scripts/store-purchase-baseline-audit.js`
>    (native-driver, provably read-only) + pure arithmetic in
>    `services/storePurchaseBaselineAudit.service.js` and
>    `services/storePurchaseItemMasterAudit.service.js`; **119 node:test
>    cases** plus jest integration tests proving every collection in the
>    gather plan — documents and indexes, including those it finds absent —
>    is unchanged after a run. The item-master half measures SKU/name
>    identity, category and unit conflicts, conversion validity, variant and
>    balance hygiene, **supplier relationships at all three layers**
>    (primaryVendor, alternateVendors[], variant aliases — with "no
>    configured supplier relationship" wording, since history may still name
>    one), **StockItem hygiene as part of one Item Master** (reference/name/
>    barcode/variant-SKU identity, productType vs trackInventory, services
>    holding balances, header vs variant totals, HSN/tax completeness),
>    cross-collection ObjectId collisions, type/lifecycle capability gaps,
>    reference integrity (BOM and barcode), **company-specific budget
>    coverage against an optional mapping collection**, and RawItem↔StockItem
>    overlap **candidates only**, by exact normalised matching with no fuzzy
>    guessing. **NOT yet run against production** — command in audit doc §7,
>    and no coverage figure may be quoted without an authorised run.
> 3. Vocabulary/navigation record:
>    `docs/decisions/store-purchase-vocabulary-navigation.md` — **PROPOSED,
>    awaiting business approval; nothing in it is adopted.** No live labels,
>    routes or navigation were changed.
> 4. Regression harness: existing `test/requests/` suites (upstream chain)
>    plus `test/store-purchase/po-receipt.route.test.js` — 22
>    characterisation tests covering the real DRAFT → ISSUED transition,
>    whether POST can bypass it, PO receipt incl. duplicate receipt, vendor
>    returns, payments, the unauthenticated `/api/cms/units` mount, absent
>    authorisation and company isolation. A literal single end-to-end test is
>    impossible today (spend→PO conversion drops the catalogue-item link —
>    documented) and none was faked.
> 5. Migration traceability: audit doc §9 — no new fields introduced.
> 6. **Item master target model, item types and migration boundaries**:
>    product plan §4.1a / §4.1b / §4.1c — **all PROPOSED, not adopted**.
>    Chunk 2's roadmap entry now specifies the decomposed Item Master it
>    must build; §4.1c fixes the point at which `RawItem.quantity` stops
>    being authoritative (a Chunk 3 gate), forbids a big-bang migration, and
>    states the **non-negotiable collection-identity compatibility
>    requirements**. Target Item identity is **stable after migration**;
>    whether it reuses a legacy id is a Chunk 2 decision, and legacy
>    references keep resolving only because legacy documents remain and
>    adapters use the legacy-source mapping — a Mongoose `ref` resolves
>    against a named collection, so unchanged ObjectIds alone preserve
>    nothing. Legacy documents are
>    retained, Items carry `legacySourceType`/`legacySourceId` under a unique
>    index, adapters serve old references, migration is batched, id
>    collisions are detected before any id reuse, snapshots are preserved,
>    and legacy collections retire only after a reference-coverage gate.
> 7. **Budget/Accounting status classified from `HEAD`**: the **committed
>    Store baseline has NO item-wise budget attribution authority at all** —
>    `RawItem.budgetLedgerId`/`budgetLedgerName`/setter audit fields,
>    `Acc_ItemCategoryBudget`, `itemBudgetHead.service.js` and request-line
>    `budgetAllocation` are none of them in `HEAD`. All are paused,
>    uncommitted integration work; the proposed target is a **company-scoped**
>    ItemAccountingProfile. The audit reads the mapping collection as optional
>    (absence = `MAPPING_COLLECTION_ABSENT` per company — unknown coverage,
>    never `CATEGORY_NEVER_REVIEWED`) and is **company-safe**, evaluating
>    every company in the committed company master including those with no
>    budget configuration at all: an override whose ledger belongs to another company is
>    `ITEM_OVERRIDE_COMPANY_MISMATCH` and the item still falls through to that
>    company's category coverage, never excluded from it. It also reports
>    override target companies, missing ledgers, unverifiable ownership, and
>    that every override is structurally unsafe because RawItem has no company
>    scope. **Discovered risk documented, not fixed:** the paused resolver
>    returns an item override before validating the ledger's company. Those
>    files were not modified or reverted.
> 8. **Barcode identity across the whole future namespace**: product-code
>    collisions item-vs-item, variant-vs-variant and item-level-vs-variant-
>    level, reported **separately** from printed lot instances (the
>    `barcodes` collection, identified by document `_id`), which are a
>    different concept and cannot collide — with one narrow cross-check for
>    an ObjectId pasted into a barcode field.
>
> The technical correction pass is recorded in audit doc §14; the item-master
> measurements and their limitations in §13; budget-attribution statuses,
> company-universe rules and mapping-absence semantics in §12.5a. The final
> pass repaired the human-readable Item Master summary (it was consuming a
> stale budget shape and printing seven `undefined` values), completed the
> company universe from the committed company master, corrected
> mapping-absence semantics, and extended the read-only proof to every
> collection the runner may read — which surfaced and fixed a latent bug
> where the outer report never forwarded the optional collections.
>
> Known-unsafe behaviour was characterised, documented (audit doc §10) and
> deliberately NOT fixed. No Item schema was implemented — that is Chunk 2.
> Pre-existing unrelated failure: `services/salesJourneyOutcome.test.js`
> (sales scope, committed, untouched by this chunk).
>
> **Next after Chunk 1:** Chunk 2 — professional master data (Item,
> ItemVariant, categories, UoM, SupplierItem, warehouse/location). Do not
> begin it before it is separately scoped and requested.
>
> **Paused:** Department-head budget app Chunk 2 and item-wise budget
> attribution after its foundation chunk. Their existing briefs remain durable
> context. Store/Purchase Chunk 8 deliberately reconnects procurement to the
> final item-wise budget model after the operational foundations are sound.
>
> **Previous paused scope — Department-head budget app:** Build a
> department-head budget app whose UI matches the finance/accountant budget
> app. Its planning brief remains
> `docs/tasks/department-head-budget-app.md`.
>
> **Chunk 1:** Shipped. Department app entry + proposals, reusing the existing
> `/api/budget-proposals` server boundary and shared frontend body.
>
> **Paused next step:** Chunk 2 - approved-budget tracking for the department's
> own approved lines and evaluated actuals.
>
> ---
>
> **Previous paused work:** Redesign the full Accounting app in
> `/Users/risheeray/grav-cms` so it follows the current Sales app design
> language. The active planning brief is
> `docs/tasks/accountant-sales-design-redesign.md`.
>
> **Important:** The Sales lead/journey scope below remains durable context, but
> it is not the active implementation target while the Account Budget feature is
> being planned.

> **Previous status before pause:** Active
>
> **Product model (current, supersedes the older 6-chunk plan below):**
> Prospect (a possible buyer we've found and are still preparing to work) and
> Active Lead (one we're actively researching, contacting and qualifying) are
> the SAME `Lead` record — internal `captureStatus: draft`/`active` is
> unchanged; "Prospect" is a user-facing rename only, no field rename, no
> migration. Sales Journey is unaffected: a qualified, specific commercial
> requirement being pursued, created only after qualification (Chunk 5).
>
> **Chunk plan:**
>
> 1. Prospect capture and setup — **done, including the follow-up correction
>    pass.**
> 2. Active Lead activities and controlled statuses — **not formally started
>    as its own chunk, but a meaningful part of it already exists**: see
>    "What Chunk 2 inherits" below. Not yet done: reviewing whether the
>    inherited work fully satisfies Chunk 2's intent, and an editable
>    identity/contact UI for an Active Lead (`LeadWorkspace.js` currently
>    shows Contact facts read-only — Prospect Setup's `IdentitySection` was
>    deliberately trimmed to a short enrichment step in the correction pass,
>    on the understanding that "deeper information belongs in Active Lead";
>    nothing currently provides that surface).
> 3. Requirement, commercial potential and qualification — partially
>    inherited (see below); not formally scoped as its own chunk.
> 4. Secure evidence/document handling — **not started.** The old,
>    unsecured Cloudinary-upload evidence path was hidden from the UI in the
>    correction pass (`EvidenceSection` in `leadSections.js`) rather than
>    presented as if complete; Source URL / Document reference text fields
>    remain available.
> 5. Conversion to Account, Contact and Sales Journey — **not started.**
>
> **Instruction:** Do not implement Chunk 2 (or any later chunk) as new work
> without it being separately scoped and requested — the items above
> describe what already exists, not a green light to proceed. When Chunk 2
> is actually taken up, start by reviewing what's listed below rather than
> assuming a blank slate.
>
> **Superseded:** `docs/tasks/lead-to-journey-roadmap.md`'s six-chunk
> breakdown ("Chunk 1 — Lead foundation", "Chunk 2 — Lead Inbox and quick
> capture", …) is an EARLIER numbering scheme for the same overall Lead →
> Sales Journey arc. The product model and chunk list above are what's
> current; that file's own status line has been marked superseded but its
> body was not rewritten.

# MERCHANDISING LANE A — ROUTES EXTRACTED FROM THE SALES ROUTER (10 Sep 2026)

> Same note as below: `AGENTS.md` assigns this file to Codex, and the other
> lane scopes further down are active. Nothing has been removed.

The final checkpoint blocker. Eleven Merchandising endpoints were registered
inside `routes/CMS_Routes/Sales/sampleStyles.js`, a Sales router carrying
seventy-four hunks of another lane's in-flight rewrite, so the staged
Merchandising application could not be assembled without them.

## What this task did

- Moved the eleven handlers to `routes/CMS_Routes/Merchandising/styleRoute.js`,
  under `/api/cms/merchandising`, behind the live `merchandiser` grant.
- Kept five old URLs answering for the R&D application through
  `legacyPackagingCompat` — the same handler objects, re-exported and mounted
  at the old prefix behind the Sales middleware R&D authenticates with.
- Moved the shared response shape (`publicPackagingSelection` →
  `publicSelection`) into `services/sales/packagingBom.service.js`, which both
  surfaces already import, so no logic exists twice.
- Repointed the Merchandising client to one base URL and four Merchandising
  test suites to the Merchandising router.
- Moved two suites whose subject is a SALES helper to `test/sales/`, with every
  assertion unchanged.
- Removed the Merchandising imports the cut left behind in the Sales router.

## The boundary rule

Ownership of a route follows the DECISION it records, not the record it
touches. Sales owns style identity; Merchandising owns the operations recorded
against it. ADR-006 states it, with the alternatives rejected.

`Enquiry.companyId`, `SalesJourney.companyId`,
`Enquiry.products[].productLineRef` and the `CustomerRequest` order line's
`sampleStyleId` are a Sales-to-Merchandising CONTRACT, not Merchandising
ownership of a Sales record. Sales writes all four; Merchandising reads them.

## Verification

The staged snapshot was built from the Git index alone into a temporary
directory and run there: **21 suites, 669 tests, 669 passed.** The Sales
sample-style router in that snapshot is byte-identical to `HEAD`. Frontend
Merchandising suites: 593 tests, 593 passed.

`test/crm/sample-style.route.test.js` fails six tests, identically on pure
`HEAD`, in the staged snapshot and in the working tree. It is the other lane's
in-flight rewrite and is inherited, not caused.

Nothing committed, nothing pushed, nothing deployed, no production data command
executed.

# MERCHANDISING LANE A — M7: CHANGE CONTROL AND ENTERPRISE SCALE (9 Sep 2026)

> Same note as below: `AGENTS.md` assigns this file to Codex, and the Central
> Costing Lane A scope further down is another lane's ACTIVE task. Nothing has
> been removed; M7 is recorded above M6 so every scope stays readable.

Baseline:

```
M1+M2: FROZEN
M3: DELIVERED
M4: DELIVERED
M5: DELIVERED
M6: DELIVERED
M7: DELIVERED
PRE-ORDER DEVELOPMENT: DELIVERED
PRODUCTION CLOSURE: DELIVERED
DATA AND GO-LIVE CLOSURE: DELIVERED
MERCHANDISING: FEATURE-COMPLETE
LOCAL DATA: READY
PRODUCTION DATA: DRY RUN READY, NOT APPLIED
AUTHENTICATED UI: NOT VERIFIED — a release activity
LANE STATUS: CLOSED
```

The closure run walked the whole journey once through the real routers and
found four seam defects, all fixed: the development-to-execution adoption link
was declared and never written; every adopted row was refused while the
adoption reported success; a file with no Time & Action plan could not be given
one; and the reschedule dialog offered Approve to the only person the server
refuses. See `docs/handoff/latest-implementation.md`.

Both data gates are now closed on a real local database and proved idempotent:
27 product-line references minted across 12 enquiries, and one starter calendar
and template published per Merchandising-enabled company. Neither has been run
against the shared Atlas cluster — the exact unexecuted commands are in
`docs/handoff/latest-implementation.md`, and the manual browser pass is
`docs/handoff/merchandising-browser-checklist.md`.

The go-live run also fixed a real defect: an approved reschedule set the
forecast and then propagation recomputed it away, so a date move could be
approved by a second person and never happen.

The `MERCHANDISING: FEATURE-COMPLETE` line was first written at the end of M7
and was wrong then. M1–M7 built the confirmed-order half of the application;
the company does most of its merchandising before a purchase order exists. The
claim stands now that pre-order development is delivered. See
`## MERCHANDISING LANE A — PRE-ORDER DEVELOPMENT` below and ADR-005.

No earlier contract was reopened.

## MERCHANDISING LANE A — PRE-ORDER DEVELOPMENT AND MATERIAL SELECTION (9 Sep 2026)

The correction to the premature completion claim. Merchandising's work now
starts where it actually starts: Sales asks for a product to be developed,
Merchandising decides what it is made from, and everything downstream is
computed against that decision.

The seven permanent ownership decisions are recorded as ADR-005 in
`docs/decisions/architecture-decisions.md` and summarised in section 4A of
`docs/product/merchandising-app-final-plan.md`. In short:

1. A Journey product line has a permanent, server-minted reference — never a
   position, a name or a mutable index.
2. Sales owns the ask; Merchandising owns the file. Neither has a route into
   the other's record.
3. The Development File is a separate aggregate from the Execution File.
4. The development BOM holds identity only; every other field is refused by
   name, saying which department owns it.
5. Approval is maker/checker and freezes. Owners are not exempt.
6. Release to R&D is Sales', because it is a commercial judgement.
7. The approved development selection outranks the registered product's BOM
   for R&D and Costing.

Navigation is now four entries: Overview, Development, Order Execution,
Time & Action.

Two admitted M7 UI gaps closed with it: a manager-only configuration editor
over the existing template, calendar and reason-code endpoints, and a
spreadsheet-based bulk workflow in place of hand-written JSON. Both are
sections of the existing management page and add no navigation entry.

The legacy Sales materials form is READ and offered for adoption, never
written. It is retired only behind a verified migration gate.

---

## What M7 delivered

- **Sales-authorised change intake.** A versioned, immutable, Sales-owned
  change notice carrying only the typed execution projection, with a stable
  `changeRef` across versions, supersession, cancellation, and a retryable
  carrier into Merchandising's own receiver.
- **A Merchandising change case** rooted in the Execution File: acknowledge or
  ask Sales, assess the internal impact, record the revisions it produced,
  announce it to the applications it reaches, close it.
- **Impact that creates revisions and never overwrites.** The change service
  cannot reach an approved revision, a baseline or a submitted pack; it records
  the number of what the owning service produced.
- **Receiver-owned acknowledgements** with staleness that is shown and never
  counted, and an explicit statement that acknowledged is not ready.
- **Preview-first bulk operations** with a source checksum, an expiry, per-row
  outcomes, partial success, a 500-row refusal and formula-safe CSV results.
- **Exports and eight source-backed reports** that refuse to compute a positive
  from missing data.
- **Archive that hides and never deletes**, with restore.
- **Integration observability as a query** — no daemon, timer or broker.
- **A management page off the navigation**, at `/merchandiser/management`.

## What M7 deliberately did not do

No Merchandising path that authors a change or another application's
acknowledgement. No buyer conversation, price, margin or payment terms. No new
capability constant. No fourth navigation destination. No daemon or broker. No
deletion of any audit or version history.

## Honest gaps carried forward

- No application publishes a change acknowledgement yet, so announced
  applications read PENDING and the register says so.
- Bulk rows are entered as JSON; a CSV upload is the natural next iteration.
- Configuration has full APIs but is not editable from the management page.
- The production build is blocked by four untracked Accounting and Store pages
  missing Suspense boundaries — not Merchandising's, evidenced in the handoff.

## Final full-app acceptance

All seven questions in the product plan's §12 are answerable from Merchandising
without opening a Sales Journey or editing another department's record. The
structural invariants hold: three navigation entries, fourteen capabilities,
live authority, immutable approved revisions and baselines, no cross-application
transaction, database-enforced idempotency, no terminal outbox failure, no
daemon, every count opening its records, and a failed read rendering
"Couldn't check" rather than a zero.

---

# MERCHANDISING LANE A — M6: DEPARTMENT STATUS AND DOWNSTREAM HANDOVER (9 Sep 2026)

> Same note as below: `AGENTS.md` assigns this file to Codex, and the Central
> Costing Lane A scope further down is another lane's ACTIVE task. Nothing has
> been removed; M6 is recorded above M5 so every scope stays readable.

Baseline at start:

```
M1+M2: FROZEN
M3: DELIVERED
M4: DELIVERED
M5: DELIVERED
M6: DELIVERED
```

No earlier contract was reopened.

## What M6 delivered

- **Source-backed department projections** for all eight source departments,
  read-only and event-sourced. Four honest availability states — reported,
  unknown, unavailable, not applicable — with the sentence each renders as, and
  derived freshness. A department that has said nothing reads *"Not yet
  reported by Store"*, never a blank, a zero or a tick.
- **A versioned, immutable Execution Pack** rooted in the Execution File,
  holding exact references (not copies) to the accepted Sales handover, the
  execution units, the three approved M3/M4 revisions, the M4 approval
  position, the M5 template/calendar/plan and approved baseline, a labelled
  forecast snapshot, and Merchandising's completion declaration.
- **Completion gates that are Merchandising's own facts only.** Seven of them,
  and not one is another department's readiness — a pack submits with every
  department UNKNOWN, and PPC decides what to do about that.
- **A PPC receiver-owned receipt**, written by PPC's own route behind a live
  `ppc` grant, with accept and clarification. No generic rejected state.
- **The `Handed Over` lifecycle defect closed properly.** `HANDED_OVER` is a
  real lifecycle value produced by PPC's acceptance and reversed by their
  clarification. The view holds records and its count is real. `OPEN`,
  `ON_HOLD`, `CLOSED` and `CANCELLED` are untouched.
- **The ninth tab**, `Department Status & Handover`, with the pack above and
  the department register below it under its own "context, not a submission
  gate" heading. Navigation is still exactly Overview, Order Execution,
  Time & Action.

## What M6 deliberately did not do

No Store, Supply Chain, Product Development, IE, PPC, Quality, Production or
Logistics features inside Merchandising. No supplier, rate, PO, consumption or
cost. No route, service export or model path that authors a department's
status. No Merchandising path that writes PPC's decision. No change control.

## Honest gaps carried forward

- **No application publishes any of the eight department event kinds yet**, so
  every department currently reads UNKNOWN or UNAVAILABLE. That is the true
  state and the register says so; the door is `receive(event)`, called by each
  producing app's own carrier when one exists.
- **PPC's application is one queue and two decisions.** Planning, capacity,
  line allocation and release are PPC's to build; M6 only ensures the receiving
  decision was theirs from the start.
- **The Department Status & Handover tab was not verified visually** — that
  needs an authenticated session and seeded live dev data, which is not
  authorised.

## What is left for M7

Sales-authorised change intake, impact coordination, acknowledgements and T&A
reforecast; bulk tools, exports, reports, archive and observability;
manager-only configuration.

---

# MERCHANDISING LANE A — M5: TIME & ACTION (9 Sep 2026)

> Same note as below: `AGENTS.md` assigns this file to Codex, and the Central
> Costing Lane A scope further down is another lane's ACTIVE task. Nothing has
> been removed; M5 is recorded above M4 so every scope stays readable.

Baseline at start: frontend FROZEN, M1+M2 FROZEN, M3 DELIVERED, M4 DELIVERED.
No earlier contract was reopened.

**M5: DELIVERED.**

## What M5 delivered

- **The date control.** Versioned process templates and working calendars,
  plans instantiated from them, and three dates per milestone — baseline
  (committed), forecast (expected), actual (happened). It answers one question:
  which milestone threatens the committed delivery date, and what is being done
  about it.
- **The baseline as a commitment.** Nothing but baseline creation and revision
  may write `baselineDate`. A revision writes a new immutable baseline and
  supersedes the old one, which stays readable for the life of the file. One
  ACTIVE baseline per plan, enforced by a partial unique index.
- **Source-owned completion.** A milestone another department owns cannot be
  completed by hand here — there is no route for it and no control on the
  screen. Those close from M4's published approval events, through a delivery
  carrier and an intake ledger, recording a reference to the record that closed
  them and no actor.
- **Rescheduling as a decision.** Preview computes the whole downstream impact
  and writes nothing; approval applies the impact that was SHOWN, refuses with
  `TNA_IMPACT_STALE` if the plan moved underneath, and where the move breaks a
  committed date it revises the baseline and may not be approved by its own
  requester — owners included.
- **The cross-file register.** Every milestone across every order, by the date
  somebody is chasing, as an indexed query with cursor pagination and an
  aggregated count per view.
- **The frontend.** A third navigation destination, an eighth tab on the
  Execution File, three date columns that stay three on mobile, a critical-path
  list rather than a Gantt, and the reschedule dialog.

## What M5 deliberately did not do

No personal tasks, to-dos, checklists, delegation or reminders — a source scan
pins their absence. No Store readiness, PPC capacity or production scheduling.
No second approval model: M4's register is untouched and no approval state is
duplicated. No reach into M4's collections — only its published events.

## What is left for M6/M7

Department Status is the one tab the product plan lists that this screen still
does not show, and the navigation carries no change-management or readiness
destination. Both are held to the same rule Time & Action was held to until this
milestone: no surface before the record behind it exists.

---

# MERCHANDISING LANE A — M4: DEVELOPMENT REQUIREMENTS AND APPROVALS (8 Sep 2026)

> Same note as below: `AGENTS.md` assigns this file to Codex, and the Central
> Costing Lane A scope further down is another lane's ACTIVE task. Nothing has
> been removed; M4 is recorded above M3 so all three scopes stay readable.

Baseline at start: frontend FROZEN, M1+M2 FROZEN, M3 DELIVERED. No earlier
contract was reopened.

## What M4 delivered

- **Development Requirements** as a third family of the M3 revision record —
  same lifecycle, same maker/checker, same idempotency, own row shape. Twelve
  requirement types, a required-by date, whose work it is, and execution-unit
  applicability.
- **An Approval Register** per Execution File: what this order waits to be
  approved, who owns each decision, and what their record last said.
- **The ownership rule made structural.** Merchandising states requirements for
  anybody and records results only for itself. Internal approvals resolve live
  from Merchandising's own approved revisions; external ones are observed, and
  22 decision-shaped fields are refused by name. There is no endpoint and no
  control that completes another department's approval.
- **Honest absence.** Sales, Product Development and Quality publish no record
  this register can read, so those rows say `Awaiting source record` and name
  the department — never "outstanding", never a blank. The reader map is empty
  and wired, so a producer can be added without touching anything else.
- **Transitional development data** adopted read-only-previewed and idempotently
  into a draft, carrying no quantity, basis or costing figure.
- **Two tabs**, making seven. Navigation unchanged: Overview, Order Execution.

## Not started

M5 Time & Action, M6 department status and downstream handover, M7 change
control. No external producer or consumer. No Time & Action or Department
Status tab.

Full detail is in `docs/handoff/latest-implementation.md`.

---

# MERCHANDISING LANE A — M3: MATERIALS, TRIM CARD AND PACKAGING (8 Sep 2026)

> **Note on this file.** `AGENTS.md` assigns the collaboration documents to
> Codex, and the Central Costing Lane A scope below is another lane's ACTIVE
> task. It has not been removed or rewritten. This M3 record is added above it
> so both scopes remain readable; if Codex wants one active task per file, the
> split is Codex's to make.

```
Frontend audit: FRONTEND FROZEN
M1+M2.1 backend audit: pending in Lane B at M3 start
M3 proceeded under explicit user-authorised controlled override
```

## What M3 delivered

Each Execution File now has one authoritative, approved and auditable truth for
its material, trim, accessory and packaging selections.

- **Records:** `MerchandisingMaterialTrimRevision` and
  `MerchandisingPackagingRevision`, rooted on the Execution File — never on the
  shared `SampleStyle`, which has no company of its own and which Sales and
  Product Development also write.
- **Lifecycle:** `DRAFT → SUBMITTED → APPROVED`, superseded on the next
  approval; changes-required is a recorded decision that returns it to DRAFT.
  One draft, one submitted and one approved per file and family, each held by
  a partial unique index rather than by a check somebody can race.
- **Identity:** opaque `MTR-`/`PKG-` row references, carried unchanged by every
  clone; withdrawn rows leave the draft and stay in the revisions that approved
  them.
- **Authority:** `merchandising.selection.write` to author, `.approve` to
  decide, live grants only, with maker/checker separation that owners do not
  bypass.
- **Documents:** the Digital Trim Card and the Packaging Specification, as
  authenticated printable frozen revisions that state their revision number and
  say plainly when they have been superseded.
- **Transitional data:** an idempotent, read-only-previewable adoption path
  from `SampleStyle.materials.packagingSelections[]` into a DRAFT, preserving
  the source and approving nothing.
- **Screens:** two new tabs inside the Execution File. Navigation is unchanged
  — Overview and Order Execution.

## Boundaries held

Merchandising states required identity and specification. Consumption, marker,
supplier, quotation, rate, purchase order, stock, lot, receipt, reservation,
issue, laboratory result, testing outcome, sample construction, buyer
communication and buyer approval are not stored, not asked for, and refused by
name. Cross-app records are referenced by identity and source version only.

## Not started

M4 development requirements and approval register, M5 Time & Action, M6
department status and downstream handover, M7 change control. No outbox
consumer. No QR on the printable card — it would require an unauthenticated
public record, which M3 does not create.

Full detail, including the API surface, the event vocabulary and the
verification results, is in `docs/handoff/latest-implementation.md`.

---

# What exists today (for whoever picks up Chunk 2 next)

## Inherited from the "Lead correction chunk" (predates the 5-chunk product
## model above, but lands squarely inside Chunk 2/3's territory)

- Canonical qualification vocabulary: `new → contactAttempted → contacted →
  qualified/nurture/disqualified/duplicate → readyToConvert` (`new` may also
  reach `contacted` directly for the one-call-and-it-connects case).
- Every transition's prerequisite is enforced server-side in
  `services/leadQualification.js`, not only the UI: Contact Attempted needs a
  logged outreach attempt; Contacted needs a genuinely successful two-way
  contact; Nurture needs a reason + next action + follow-up date; Qualified/
  Ready to Convert share one checklist
  (`services/leadReadiness.js`'s `computeQualificationReadiness`); Duplicate
  requires a genuine, existence-verified Lead/Account link.
- Structured Activity outcomes (`no_answer`/`replied_connected`/
  `meeting_completed`/`other`), `lastContactedAt` gated on a genuinely
  successful contact, Draft Leads blocked from having Activities.
- `Lead.requirementCertainty` (confirmed-requirement side, separate from the
  researched-potential confidence fields) exists but has no UI beyond what
  `LeadWorkspace.js`'s "Supporting details" already shows.
- Manager-only owner/source reassignment; employee names always server-
  derived, never client-trusted.
- The full frontend for this lives in `LeadWorkspace.js` (Active Lead
  workspace) — "Move this lead", the qualification checklist, the duplicate
  picker, structured outcome dropdown are all already built and verified.

## What Chunk 2 (as newly scoped) still needs, if/when it's taken up

- Decide whether the inherited qualification/activity work above already
  satisfies Chunk 2's intent, or whether it needs revision now that the
  product model has Prospect/Active Lead terminology and a 5-item "Start
  Working Lead" bar that didn't exist when it was built.
- An Active Lead identity/contact editing surface (see status note above).
- Whatever else Chunk 2 is scoped to cover once that scoping happens —
  nothing below this line should be treated as decided until it is.
