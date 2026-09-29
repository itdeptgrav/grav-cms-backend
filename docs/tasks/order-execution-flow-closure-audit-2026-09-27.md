# Order Execution flow-closure audit — 27 Sep 2026

## Why this audit exists

The complete Order Execution demo is useful for visual review, but a populated
screen is not proof that the operational workflow can produce the same state.
This audit compares every major fact shown by
`scripts/demo/merchandising-demo-complete-file.js` with the real producer,
route and user surface that should create it.

No application behaviour was changed during this audit.

## Classification

- **Complete** — a person can reach the state through the owning application's
  UI and the owning service persists it.
- **Partial** — a service or consumer exists, but an authoring UI, source link,
  or producer is missing.
- **Demo-only** — the seed injects a model or event that no current product
  workflow can produce.

## Executive finding

The core Merchandising workflow is real: accepting a Sales handover, creating
and approving requirement revisions, creating a T&A plan, recording and
issuing PP Meeting minutes, preparing an execution pack, and PPC accepting or
clarifying that pack all have real services and user surfaces.

The incomplete part is the cross-application flow. The demo currently makes
several source applications appear connected when they are not. In particular,
the approval register, department-status panel, source-owned T&A completion,
and change-acknowledgement panel contain consumer contracts without live
producers.

## Field-by-field audit

| Area shown in the demo | How the demo creates it | Current real workflow | State | Closure required |
|---|---|---|---|---|
| Sales order identity, buyer, quantity | Direct model creation for Account, Journey, Enquiry, SampleStyle and CustomerRequest | Sales has the underlying order/customer surfaces | Partial proof | Replace the demo's direct setup with an existing Sales fixture/service where practical; direct fixture setup is acceptable only as test precondition and must not be described as a user journey. |
| Sales handover: drops, splits, allocation and special processes | Direct `SalesHandoverVersion.create` with a complete projection | Sales' handover UI issues versions and supports drops, splits, allocation, embroidery/printing/washing and authority evidence | Complete for these fields | Seed through `merchandisingHandover.service.issue`, not direct model creation, so the demo proves the same contract. |
| Packing, testing and delivery requirement in the Sales handover | Written directly into the seeded projection | Backend `issue` accepts all three, but `MerchandisingHandoverCard` sends none of them | **Partial** | Add the three plain-language fields to the Sales issue/corrected-version form, carry current values forward explicitly, validate/restatement on successor versions, and test UI → issued version → Merchandising read. |
| Development link on the handover | Demo stamps `developmentReference` directly on `SalesHandoverVersion` | Live Sales issue does not write it. Merchandising can later discover its own Development file for BOM adoption, but the handover/reference-image read still looks at the unstamped Sales version | **Partial / misleading demo** | Use one authoritative resolution path for both BOM lineage and displayed reference images. Do not give Sales arbitrary Merchandising ids. Resolve by stable `sampleStyleId`/released Development record in Merchandising, record the result once on the Execution File, and read images through that recorded link. |
| Buyer/product reference images | Static demo assets are attached to a directly-created Sales Development Request | Development Request service accepts `referenceImages`, but the visible Sales request form has no attachment authoring control | **Partial** | Add image attachment/removal/caption controls to the Sales Development Request flow using the application's real media/storage mechanism. Prove that the same images appear in Development, handover review and Order Execution through source references rather than copies. |
| Accept handover and create Execution File | `execution.acceptHandover` | Real New Handovers review, clarify and accept surfaces exist | Complete | Keep. Remove the demo's raw file-number override from any claim of production reachability; it is cosmetic fixture setup only. |
| Import approved Development materials and packaging | Acceptance calls the real adoption service | Real acceptance attempts a safe draft import; manual retry/preview exists; lineage is recorded | Complete with a visibility caveat | Surface import failure prominently instead of silently falling back to an empty-looking order. Never tell a user “nothing selected” when an approved Development source exists but import failed. |
| Add a new order-only material or trim | Demo adds free-text selection rows through the selection service | The order-stage `SelectionTab` uses a typed form. It does not use Store's `MaterialCatalogueDialog`; catalogue identity is present only when carried from Development | **Partial** | Use the Store raw-item/variant picker for new order rows, retain the explicit unregistered-material path, persist `catalogueRef`, and show source/identity. Do not allow the demo to imply all rows are registered Store items when they are not. |
| Materials/Packaging draft → submit → approve | Real selection services with separate maker/checker | Real Order Execution UI supports the lifecycle | Complete | Keep. |
| Development Requirements list | Real selection service; demo author chooses rows, owner and dates | Merchandising UI can create/edit/submit/approve rows and can adopt transitional Development service requirements | Complete as a requirement-authoring workflow | Clearly label these as work requirements, not completed work. Show row source: Sales requirement, adopted Development need, or manually added by Merchandising. |
| Development Requirements derived from Sales | Demo author manually translates the product story into six rows | Sales' `processRequirements` are not proposed or reconciled against the Development Requirements revision | **Partial** | Add a server-side intake/preview that turns explicit Sales process facts into proposed requirements without inventing owner/date. Show omissions and conflicts (for example Sales says embroidery REQUIRED but no embroidery requirement exists). A person reviews and completes the draft. |
| Development Requirement progress/next action | Demo coordination notes make rows look active | The revision records only the approved requirement, owner and due date. It has no authoritative work-status producer | **Missing** | Do not fabricate progress. Until source apps publish work records, show “Requirement approved; progress not reported”. Later join source records by stable reference and show source-owned status/next action. |
| Internal approvals | Approval register resolves Materials, Packaging and Development approvals from Merchandising revisions | Real and source-backed | Complete | Keep. |
| Buyer, Product Development and Quality approvals | Demo creates required rows but intentionally leaves them awaiting source | `EXTERNAL_READERS` is explicitly all `null`; Sales has no buyer-decision reader, Product Development no released sample/tech reader, Quality no test/inspection reader | **Missing** | Build the source records/readers first, then connect the register. Do not add manual “approve” controls in Merchandising. Each decision must link to source id/version and decision date. |
| PP Meeting draft, conduct and issue | Real PPM services | Full Merchandising UI exists with maker/checker separation | Complete | Keep. Make its position relative to PPC readiness explicit; do not imply that conducting the meeting releases production. |
| T&A template, calendar, plan and baseline | Real configuration and plan services | Management configuration UI and order plan UI exist | Complete | Keep. Improve plain-language guidance, but this is not a flow gap. |
| Automatic T&A completion from Merchandising approvals | Demo drains real outbox events | T&A consumes Materials, Packaging and Development approval events | Complete | Keep and add the missing internal source events below. |
| Automatic T&A completion for PP sample, Quality, Store, PPC, Production and Logistics | Demo inserts source-owned milestones and later injects synthetic status events; most milestones remain dependent on publishers that do not exist | No source application publishes those T&A completion events. A `SOURCE_EVENT` milestone also cannot be manually completed | **Missing / potentially stuck** | Define and implement producer contracts per owning application before templates may use those events. Configuration must refuse or visibly warn about event kinds with no integrated producer. |
| PP Meeting and execution-pack T&A milestones | Demo marks PP Meeting manually and does not connect pack submission | Both are real Merchandising records with real event moments, but T&A intake currently listens only to the three selection approvals | **Partial** | Publish/consume PPM-issued and execution-pack-submitted events so these milestones close from the authoritative record instead of manual recollection. |
| Department Status & Handover panel | Demo calls `departmentStatusIntake.receive` with seven synthetic events | The consumer and allowlists exist, but `REPORTING_APPS` is empty and repository search finds no producer for any of the eight event kinds | **Demo-only** | Remove synthetic “reported” statuses from the honest demo or visibly mark them simulated. Implement producers incrementally in Product Development, Supply Chain, Store, IE, PPC, Quality, Production and Logistics; add an app to `REPORTING_APPS` only in the same change. |
| Execution pack preparation/submission | Real pack service and Merchandising UI | Real gates, versioning and submission exist | Complete | Keep. The demo must report whether submission actually succeeded instead of swallowing the error and presenting the file as complete. |
| PPC receipt of execution pack | Real PPC inbound service and decision UI | Queue, detail, accept and clarification exist | Complete | Keep. There is intentionally no “reject confirmed order” action. |
| Sales buyer-change notice | Demo calls the real Sales change service directly | Backend route exists; repository search finds no Sales UI that issues a change notice | **Partial** | Add a Sales order-line change UI with a before/after preview, complete projection restatement and authority. Prove delivery to the linked Execution File. |
| Merchandising change impact assessment | Real change-control service and UI | Acknowledge, assess, coordinate and record produced revisions exist | Complete once a notice arrives | Keep. |
| Department acknowledgements of a change | Demo injects Supply Chain and Logistics acknowledgement events directly | Consumer exists; `ANSWERING_APPS` is empty and no application publishes any acknowledgement kind | **Demo-only** | Add an affected-change inbox and publish action in each source application. Until then the demo must show pending/unavailable, not accepted/clarification responses. |
| Hold, resume, assignment, close/reopen and history | Real Execution File commands and audit records | Real controls exist subject to role | Complete | Keep. |

## Direct writes in the current demo that must not be mistaken for product flows

The current demo directly creates these models rather than reaching them through
their owning user journeys:

- `Account`
- `SalesJourney`
- `Enquiry`
- `SampleStyle`
- `CustomerRequest`
- `SalesDevelopmentRequest`
- `DevelopmentFile`
- `SalesHandoverVersion`

It also injects:

- seven department-status events whose producers do not exist;
- two change-acknowledgement events whose producers do not exist;
- a cosmetic raw update to the otherwise immutable file number.

Direct fixture setup is not automatically wrong. The problem is describing a
state as end-to-end when the owning application cannot produce it. Every demo
fact must therefore carry one of these provenance labels in test/seed notes:

1. `REAL_UI_FLOW`
2. `REAL_SERVICE_NO_UI`
3. `SIMULATED_EXTERNAL_SOURCE`
4. `FIXTURE_ONLY`

## Closure order

### P0 — stop the demo from teaching a false workflow

1. Add a seed result manifest listing provenance for every populated section.
2. Remove or clearly label synthetic department statuses and change answers.
3. Fail the complete-demo seed when a required step fails; do not swallow a
   failed pack submission or meeting issue and continue as if complete.
4. Add a flow-closure test that rejects a “complete” demo containing an
   unlabeled direct model write or synthetic source event.

### P1 — close Sales → Order Execution intake

1. Add packing, testing and delivery fields to the Sales handover UI.
2. Fix authoritative Development/image linkage for live handovers.
3. Add reference-image authoring to the Sales Development Request flow.
4. Add Sales UI for versioned buyer/order change notices.
5. Add Sales-process → Development-requirement proposal and conflict checks.

### P2 — close source-owned decisions

1. Define and build the minimum source record for buyer approval, Product
   Development sample/technical decision, and Quality test/inspection result.
2. Connect those records to approval-register readers.
3. Publish their authoritative completion events into T&A.
4. Connect PPM issue and pack submission to T&A from their existing records.

### P3 — close cross-department operational status

Implement one department at a time, producer plus consumer tests in the same
change. Recommended order: Store, PPC, Product Development, Quality, Supply
Chain, IE, Production, Logistics. Never enable a reporting/answering flag
before its producer exists.

### P4 — enforce catalogue identity at order stage

Use Store's material catalogue for new order-only selections, preserve a named
unregistered path, and make lineage/source visible in every row.

## Acceptance definition

Order Execution is flow-complete only when a fresh database can reach the same
state as the showcase order through authenticated product surfaces, with two
exceptions permitted and explicitly labelled:

- administrative configuration fixtures such as a published working calendar
  or template;
- external-system simulation where that external system is outside this
  repository.

No screen may display a department decision, progress state, approval, receipt,
or acknowledgement that was authored by the demo on that department's behalf.

