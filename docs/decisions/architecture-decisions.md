# Architecture Decision Log

Use the following template for each approved architecture decision.

## Decision template

- **Decision ID:** ADR-XXX
- **Date:** YYYY-MM-DD
- **Status:** Proposed | Approved | Superseded | Rejected
- **Context:**
- **Decision:**
- **Alternatives considered:**
- **Consequences:**
- **Related task/files:**

---

## ADR-001: Keep core commercial records distinct

- **Decision ID:** ADR-001
- **Date:** 2026-08-06
- **Status:** Approved
- **Context:** The CRM collaboration needs a stable boundary between customer identity, the sales process, and operational execution records.
- **Decision:** Account, Sales Journey, and order/fulfilment records must remain distinct unless a later approved architecture decision explicitly changes this architecture.
- **Alternatives considered:** Combining these concepts into a single record; deferred because it would blur ownership, lifecycle, and data boundaries.
- **Consequences:** Requirements and implementations must preserve separate domain concepts and connect them through explicit relationships.
- **Related task/files:** `docs/product/crm-master-requirements.md`, `docs/product/connected-lifecycle.md`

---

## ADR-002: Lead ends where the qualified Sales Journey begins

- **Decision ID:** ADR-002
- **Date:** 2026-08-06
- **Status:** Approved
- **Context:** The existing Lead module contains proposal, negotiation and won stages, while the newer Sales Journey architecture owns Enquiry/RFQ, development, quotation, confirmation, fulfilment and delivery. Without a hard boundary, the same commercial process would be stored and edited twice.
- **Decision:** A Lead is a pre-Journey prospect and qualification record. It may exist without an Account. It owns source, initial person/company information, first requirement summary, qualification, contact attempts and conversion outcome. It does not own styles, samples, costing, quotations, negotiation, orders, production, shipment or delivery. Once the requirement is qualified, conversion links or creates the Account and Contact, creates one Sales Journey, records the resulting references on the Lead and ends active Lead progression at `Converted`. The Lead remains as source history and is never overwritten by the Journey. Proposal, negotiation and won/lost commercial outcomes belong to the Journey and its referenced records, not to the canonical Lead workflow.
- **Alternatives considered:** Continue the legacy Lead pipeline through proposal/negotiation/won; rejected because it duplicates Cost & Quote and PO/Contract. Eliminate Lead and create Journeys for every unqualified prospect; rejected because it pollutes customer and Journey records with low-confidence prospects. Merge Lead into Account; rejected because a person or company can be discovered before its durable organization identity is verified.
- **Consequences:** Lead and Journey need an explicit, idempotent conversion bridge. New Lead activities must use the shared CRM Activity architecture rather than a second embedded activity system. Legacy Lead stages and embedded activities remain readable for backward compatibility but are not offered for new work. Navigation and reporting must distinguish pre-Journey Leads from active Sales Journeys.
- **Related task/files:** `docs/tasks/lead-to-journey-roadmap.md`, `docs/tasks/lead-chunk-01-foundation.md`, `models/CMS_Models/Sales/Lead.js`, `models/CMS_Models/Sales/SalesJourney.js`, `models/CMS_Models/Sales/Activity.js`

---

## ADR-003: IE and PPC are separate department applications

- **Decision ID:** ADR-003
- **Date:** 2026-09-07
- **Status:** Approved
- **Context:** The original garment-manufacturer direction grouped Industrial Engineering and Production Planning and Control in one application. GRAV is organising applications by stable departmental responsibility, not by employee designation. IE owns manufacturing methods and standards; PPC owns order loading, capacity commitments and schedules. Keeping them behind one application boundary would make it easier for a plan to redefine the standard it is meant to consume.
- **Decision:** IE and PPC are separate department applications. IE owns operation bulletins, routes, SAM/SMV, method studies, machine/manpower requirements, line-balance standards, capacity standards and standard targets. PPC consumes released IE versions and owns factory/line allocation, order loading, capacity booking, production calendars and recovery plans. Production executes the released plan. Production Manager and Production Supervisor remain roles inside the Production application, not separate applications.
- **Alternatives considered:** One combined Planning & IE application with role-controlled workspaces; superseded because the departments have independent authority and approval boundaries. Separate applications by designation; rejected because designations change while departmental responsibility remains stable.
- **Consequences:** The existing `project-manager` and `production-supervisor` interfaces are transitional shells. Their features must move by fact ownership to IE, PPC or Production without deleting live records or links. Production may request an IE revision but cannot directly change an approved route or SAM. PPC must retain the exact IE version used by each plan.
- **Related task/files:** `docs/product/garment-manufacturer-app-architecture.md`, `docs/product/industrial-engineering-app-plan.md`, `docs/audits/industrial-engineering-chunk-00-boundary.md`, `docs/tasks/industrial-engineering-chunk-00.md`

---

## ADR-004: Mautic is the Marketing automation engine, not the CRM authority

- **Decision ID:** ADR-004
- **Date:** 2026-09-09
- **Status:** Approved
- **Context:** GRAV needs an internal Marketing application and intends to build
  from Mautic. GRAV already owns Account, Contact, Lead, Activity and Sales
  Journey records. A deep Mautic fork or a bidirectional customer-master sync
  would create competing identity, consent and commercial lifecycles.
- **Decision:** Deploy one separately operated Mautic instance for the internal
  GRAV organisation. GRAV owns identity, consent, qualification and commercial
  outcomes. Mautic owns segments, campaign definitions, marketing assets,
  automation execution and native engagement events. Integrate through a
  GRAV-owned adapter using supported APIs and authenticated webhooks. Prefer a
  Mautic plugin to core changes; a core fork requires a separate approved ADR.
  Sales and Marketing use canonical GRAV records and one CRM Activity timeline.
  GRAV's intelligence layer may recommend audiences, content and Sales
  handovers from Mautic engagement plus approved context, but its outputs
  remain explained, auditable and human-approved; it cannot override consent
  or write Sales lifecycle decisions. Marketing may operate approved branded
  one-to-many communication and a neutral automatic acknowledgement, but Sales
  owns every personal customer conversation. A new handover enters Sales as an
  awaiting-review Prospect, never as an Active Lead.
- **Alternatives considered:** Make Mautic the primary CRM; rejected because it
  duplicates and weakens GRAV's established domain ownership. Import Mautic
  code or tables into the Node/Mongo application; rejected because it couples
  GRAV to Mautic internals and creates an unsupported mixed runtime. Maintain a
  deep white-label fork immediately; deferred because the internal first
  release does not justify the upgrade and licensing burden.
- **Consequences:** GRAV needs canonical channel-consent and identity-mapping
  records, an idempotent outbound projection, a verified webhook ledger,
  conservative suppression behavior and reconciliation. The initial Marketing
  UI may deep-link to Mautic for complex asset and automation editing. There is
  no multi-tenant abstraction in the first release. Intelligent features need
  versioned input snapshots, evidence/freshness, explicit feedback and outcome
  evaluation rather than an opaque score alone.
- **Related task/files:** `docs/product/marketing-app-mautic-plan.md`,
  `docs/tasks/marketing-mautic-roadmap.md`,
  `docs/product/crm-master-requirements.md`,
  `docs/product/connected-lifecycle.md`

---

## ADR-005: Pre-order development is Merchandising's, and its ownership is split seven ways

- **Decision ID:** ADR-005
- **Date:** 2026-09-09
- **Status:** Approved
- **Context:** The Merchandising application was declared feature-complete at
  the end of M7 while implementing only the confirmed-order half of the work.
  Before an order exists, Sales asks for a product to be developed and
  Merchandising decides what it is made from — and everything downstream (R&D's
  engineered consumption, Costing's rates, the sample itself) is computed
  against that decision. The application had no home for it. What existed
  instead was a Sales-authenticated materials form writing raw items onto
  `SampleStyle.materials`, which put a Merchandising decision behind a Sales
  seat, addressed a product line by its name, and carried a quantity nobody had
  engineered. Two departments held one fact, and neither version had an
  approver.
- **Decision:** Pre-order development is a first-class Merchandising workflow
  with a navigation entry of its own, and its ownership is settled by seven
  rules that do not move:
  1. **A Journey product line has a permanent, server-minted reference.**
     Nothing outside the enquiry may address a line by array position, product
     name, style display text or a mutable index. One enquiry legitimately
     carries the same product twice in two colourways, and those are two
     development jobs with two different selections.
  2. **Sales owns the ask; Merchandising owns the file.** The development
     request is a versioned Sales record on a Sales router behind the live
     Sales grant. Merchandising has no route that creates one, and Sales has no
     route that reads or writes a Development File. A second ask against an
     open line becomes version 2 on the same file.
  3. **The Development File is a separate aggregate from the Execution File.**
     It is keyed on `company + journey + productLineRef` and exists before any
     order does. Merging the two would mean either an execution file with no
     confirmed requirement or a development decision that cannot be made until
     the buyer has ordered.
  4. **The development BOM holds identity and nothing else.** Quantity,
     consumption, unit, allowance, wastage, rate, cost, price, supplier,
     supplier quotation, purchase order, stock, reservation, issue quantity and
     sample construction result are each refused by name, and each refusal says
     which department owns the fact. Merchandising selects the material; it
     does not engineer it, price it, buy it or test it.
  5. **Approval is maker/checker and freezes.** The approver may not be the
     author or the submitter, and an owner is not exempt. An approved revision
     is immutable; change means a new revision, and the previous one stays
     readable because R&D and Costing consumed it.
  6. **Release to R&D is Sales'.** Merchandising approving says the materials
     are settled. Sales authorising the release says the buyer relationship
     justifies spending the development budget on them. That is a commercial
     judgement, so Merchandising has no route for it.
  7. **The approved development selection outranks the registered product's
     BOM.** R&D's shortlist and Costing's identity both read the approved
     development revision first. A product-level BOM is what the product is
     usually made from; a development revision is what somebody agreed for this
     buyer's sample.
- **Alternatives considered:** Extend the Execution File backwards to cover
  pre-order work; rejected because it would require an execution file with no
  confirmed requirement, and every field on it would then be conditionally
  meaningless. Keep the Sales materials form and add an approval step; rejected
  because the authority is wrong at the root — a Sales seat should not be the
  gate on a Merchandising decision — and because the form addresses lines by
  name. Let Merchandising raise its own development work; rejected because the
  ask commits company money against a buyer relationship Sales owns. Let
  Merchandising release to R&D once it has approved; rejected for the reason in
  rule 6. Delete the legacy materials form immediately; rejected because live
  styles hold data in it, so it is read and offered for adoption and retired
  only behind a verified migration gate.
- **Consequences:** Merchandising's primary navigation becomes four entries —
  Overview, Development, Order Execution, Time & Action — with Development
  second, in the order the work happens. The Sales Journey gains a surface that
  sends a line for development, shows Merchandising's published answer and
  authorises the release, and carries no material-selection control at all.
  What Sales sees of the selection is a projection Merchandising publishes: a
  statement of state and the approved identities, with no document identifier a
  caller could act on and no write anywhere in the module. Only an APPROVED
  revision is published, because a draft is Merchandising still working and
  publishing one would let a salesperson quote a fabric nobody agreed. A
  confirmed order adopts the approved development BOM into a DRAFT selection,
  never an approved one, so the order-stage approval is a real decision rather
  than a formality. No new capability constant was introduced: the fixed
  fourteen-capability vocabulary covers all of it.
- **Related task/files:** `docs/product/merchandising-app-final-plan.md`,
  `models/CMS_Models/Sales/enquiryProductLineIdentity.js`,
  `models/CMS_Models/Sales/DevelopmentRequest.js`,
  `models/CMS_Models/Merchandising/Development.js`,
  `services/sales/developmentRequest.service.js`,
  `services/merchandising/development.service.js`,
  `services/merchandising/developmentPublication.service.js`,
  `services/merchandising/developmentAdoption.service.js`,
  `services/merchandising/developmentLegacy.service.js`,
  `services/approvedMaterialShortlist.service.js`,
  `routes/CMS_Routes/Sales/developmentRequests.js`,
  `routes/CMS_Routes/Merchandising/developmentRoute.js`,
  `test/merchandising/preorder-development.route.test.js`

## ADR-006: Sales owns style identity; Merchandising owns the operations on it

- **Decision ID:** ADR-006
- **Date:** 2026-09-10
- **Status:** Approved
- **Context:** Eleven Merchandising endpoints — the style list and identity
  read, the Development File read and write, the packaging decision, and the
  packaging-selection and packaging-requirement lifecycle — were registered
  inside `routes/CMS_Routes/Sales/sampleStyles.js`. They were written there
  because that is where the `SampleStyle` record's own doors already were, and
  the shortest way to reach the record was to add a route beside them. The cost
  only became visible at release: the file is a 4,500-line Sales router under
  concurrent rewrite, so a Merchandising release could not be assembled without
  taking whatever state seventy-four unrelated in-flight hunks happened to be
  in. Merchandising's own tests mounted that router to reach eleven endpoints,
  and Merchandising's client held a second base URL pointing at a Sales mount.
- **Decision:** Ownership of a route follows the DECISION it records, not the
  record it touches.
  1. **Sales owns style identity.** The `SampleStyle` record, its creation, its
     stage, its Sales-facing surface and its notification helpers stay on the
     Sales router. Merchandising has no route that creates a style.
  2. **Merchandising owns every Merchandising operation on that style**, in
     `routes/CMS_Routes/Merchandising/styleRoute.js`, under
     `/api/cms/merchandising`. Same handlers, same services, same live
     `merchandiser` grant as the rest of the application.
  3. **No logic is duplicated.** The handlers moved; they were not copied. One
     implementation answers every address, and `publicSelection` — the response
     shape the two surfaces share — moved into
     `services/sales/packagingBom.service.js`, which both already import.
  4. **An old URL that must keep answering gets a thin compatibility mount, not
     a second implementation.** The five packaging URLs the R&D application
     still calls are re-exported from the Merchandising router as
     `legacyPackagingCompat`, mounted at the old prefix behind the Sales
     middleware R&D authenticates with. It is a second doorway onto one room.
  5. **Three schema fields are a Sales-to-Merchandising CONTRACT, not
     Merchandising ownership of a Sales record.** `Enquiry.companyId` and
     `SalesJourney.companyId` make the acting company provable on a record
     Merchandising must scope by; `Enquiry.products[].productLineRef` is the
     permanent, server-minted line identity ADR-005 rule 1 requires; and
     `CustomerRequest` order lines carry `sampleStyleId` so a confirmed line
     names the style it was developed from. Sales writes all three. Merchandising
     reads them and writes none of them.
- **Alternatives considered:** Leave the endpoints on the Sales router and
  release the two lanes together; rejected because it makes every Merchandising
  release wait on an unrelated rewrite and gives Merchandising's authorisation
  boundary a Sales-shaped hole. Copy the handlers into a Merchandising router
  and leave the originals; rejected because two implementations of one decision
  drift, and the packaging lifecycle has maker/checker rules that must not exist
  twice. Move the `SampleStyle` model to Merchandising; rejected because Sales
  genuinely owns the record — the style exists before Merchandising is involved
  and is presented on Sales' own journey stage. Redirect the old URLs with a
  3xx; rejected because the R&D client sends PATCH and POST bodies and would
  need its own change to follow one.
- **Consequences:** The Sales sample-style router loses 689 lines and is
  byte-identical to its committed state in the Merchandising checkpoint, so the
  two lanes no longer share a file. Merchandising's client names one base URL.
  Four Merchandising test suites mount the Merchandising router instead of the
  Sales one, and two suites whose subject turned out to be a SALES helper —
  the R&D raw-item search, the stage routing, the legacy material routes and
  the `customerNameFor` notification lookup — moved to `test/sales/`, where
  their subject lives. Not one assertion changed. The R&D application needs no
  change at all.
