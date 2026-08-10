# Garment Manufacturing CRM — Connected Lifecycle Workspace

**Parent document:** [Garment Manufacturing CRM — Requirements and Process Flow](./crm-master-requirements.md)  
**Step 01:** [Customer Foundation and Garment Sales Profile](../tasks/current-task.md)  
**Design model:** A connected, sequential workspace inspired by the page-based workflow of DaVinci Resolve

---

## 1. Product Experience

The CRM must not feel like a collection of unrelated departmental modules. It should feel like one garment business journey moving from first conversation to repeat order.

In DaVinci Resolve, Media, Cut, Edit, Fusion, Color, Fairlight, and Deliver are different working pages, but they operate on the same project and shared assets. This CRM should behave similarly:

- The user opens one **Sales Journey**.
- The customer, buying house, brand, contacts, styles, documents, dates, owners, and conversations remain connected.
- The bottom lifecycle bar moves the user through the next stage.
- Each page provides the tools needed for that stage.
- Completing one stage unlocks or prepares the next.
- Information is carried forward rather than re-entered.
- Users can move backward to review or revise earlier work without losing history.

The experience should answer three questions everywhere:

1. Which customer and business journey am I working on?
2. Where is it in the lifecycle?
3. What must happen next?

---

## 2. Core Object — Sales Journey

A **Sales Journey** is the connected container for one commercial lifecycle.

Examples:

- A buying-house enquiry containing five new styles for a brand season
- A direct-brand RFQ for a garment collection
- A hospital uniform tender
- A school uniform contract renewal
- A repeat order based on an approved style
- A uniform replenishment cycle

The Sales Journey connects:

- Customer/account
- Buying house, brand, PO issuer, bill-to party, consignee, agent, and other parties
- Customer contacts and internal team
- Enquiry/RFQ/tender
- Developments, styles, tech packs, and samples
- Costing, quotation, and negotiation
- Contract or purchase order
- Time-and-action calendar
- Production, quality, packing, and shipment milestones
- Delivery, payment visibility, complaint, and repeat business

Later modules must add information to this journey instead of creating disconnected records that the user has to find again.

---

## 3. Application Structure

### 3.1 Project/Journey Hub

When the user opens the application, show a **Journey Hub**, similar to opening a project manager.

Views:

- My active journeys
- Team journeys
- Waiting on customer
- Waiting on internal team
- At risk or delayed
- Closing/dispatching soon
- Uniform programs
- Completed/reorder-ready

Each journey card or row shows:

- Customer
- Buying house and brand, where applicable
- Journey name/reference
- Business type: brand/buying house or uniform
- Current lifecycle stage
- Current status and risk
- Owner/merchandiser
- Next action and due date
- Expected value
- Target delivery date

Primary actions:

- Start new journey
- Open customer library
- Resume recent journey
- View my tasks/approvals
- Search all records

### 3.2 Connected lifecycle bar

After opening a journey, show a persistent page bar at the bottom on desktop. On smaller screens, use a horizontally scrollable stage bar.

```text
ACCOUNT → ENQUIRY → DEVELOP → PRICE → CONFIRM → FULFIL → DELIVER → GROW
```

These are sequential working pages, not independent modules.

### 3.3 Persistent journey header

Every lifecycle page must show the same compact header:

- Journey reference and name
- Customer
- Buying house/brand or uniform program
- Journey owner and merchandiser/coordinator
- Current lifecycle stage
- Business status
- Risk status
- Target price/value, where applicable
- Target ex-factory/delivery date
- Next action and due date
- Overall completion/progress

Header actions:

- Add note/activity
- Create task
- Upload document
- View customer
- View stage checklist
- Mark risk/blocker
- View complete timeline

Changing lifecycle pages must not discard unsaved work without warning.

---

## 4. Lifecycle Page 1 — Account

Purpose: Establish who the customer is, who participates, what they normally buy, and who owns the relationship.

### Working panels

#### Customer identity

- Customer/account and legal name
- Customer roles
- Country, currency, language, and time zone
- Status, tier, and customer potential
- Sales owner, account manager, and merchandiser/program coordinator

#### Garment sales profile

- Business models
- Product categories
- Woven, knit, denim, sweater, outerwear, or other construction capabilities/interests
- Menswear, womenswear, kidswear, unisex, occupational, or uniform categories
- Target markets
- Estimated annual pieces and styles
- Typical order quantity and expected MOQ
- Target price band
- Development and bulk lead-time expectations
- Buying frequency, seasons, and calendar
- Compliance, testing, sustainability, and AQL expectations

#### People and locations

- Buyer, merchandiser, technical approver, procurement, finance, logistics, HR/admin, uniform coordinator, and site coordinator
- Head office, branches, campuses, hospitals, hotels, plants, sites, and delivery locations
- Departments

#### Commercial parties

- Buying house
- Brand/end buyer
- PO issuer
- Bill-to party
- Importer/consignee
- Agent/commission party
- Nominated supplier, testing laboratory, inspector, and forwarder

#### Interaction rail

A persistent side panel shows recent calls, emails, meetings, site visits, notes, documents, and follow-up tasks.

### Stage completion

Account page is ready when:

- Primary customer is selected
- Necessary business roles and commercial parties are identified
- Primary contacts exist
- Internal owner is assigned
- Basic garment sales profile is recorded
- Next customer requirement can be captured

### Continue action

`Start Enquiry/RFQ/Tender`

The next page automatically receives the customer, parties, contacts, owners, currency, Incoterm, compliance defaults, and product interests.

---

## 5. Lifecycle Page 2 — Enquiry

Purpose: Capture what the customer is asking for and decide whether to pursue it.

The page adapts to:

- General enquiry
- Buying-house/brand RFQ
- Uniform requirement
- Formal uniform tender
- Repeat/replenishment request

### Working panels

#### Requirement summary

- Enquiry/RFQ/tender reference
- Customer, buying house, and brand
- Garment categories
- Expected number of styles
- Expected quantity
- Target price and currency
- Sample deadline
- Bulk delivery deadline
- Destination and Incoterm
- Business model: FOB/full package, CMT/CM, uniform supply, or other

#### Product requirement

- Garment description
- Fabric/construction summary
- Color and size summary
- Branding/personalization summary
- Packaging summary
- Testing and compliance requirements
- Tech packs and reference attachments

#### Commercial qualification

- Estimated value
- Win probability
- Capacity/lead-time feasibility
- MOQ fit
- Commercial fit
- Compliance capability
- Strategic value
- Known competitor/current supplier

#### Tender panel, when applicable

- Tender number
- Eligibility checklist
- Submission deadline
- Tender security/deposit
- Mandatory documents
- Technical/sample trial
- Commercial evaluation dates

#### Activities and next action

- Customer clarification
- Internal feasibility task
- Pending documents
- Due dates and owners

### Stage gates

- Customer and parties confirmed
- Requirement sufficiently complete
- Technical/commercial feasibility reviewed
- Pursue/no-pursue decision recorded
- Development items created or linked

### Continue action

`Send to Development`

Customer requirements, files, expected quantity, target price, compliance requirements, dates, and parties flow into the Develop page.

---

## 6. Lifecycle Page 3 — Develop

Purpose: Turn the requirement into approved garment styles.

This page combines product development, tech packs, samples, and approvals into one sequential workspace.

### Style rail

For a multi-style enquiry, show all styles in a left rail with individual status:

- Not started
- Technical review
- Pattern/material preparation
- Sample in progress
- Sent to customer
- Revision required
- Approved
- Dropped

Opening a style changes the central workspace without leaving the journey.

### Working stages within Develop

```text
SPECIFY → PREPARE → SAMPLE → REVIEW → SEND → APPROVE
```

#### Specify

- Internal and buyer style number
- Garment category/type
- Season/collection or uniform role
- Tech pack and drawings
- Construction details
- Measurements and tolerances
- Colors, sizes, and expected quantity

#### Prepare

- Fabric composition, construction, GSM, finish, and source
- Trims/accessories
- Pattern/CAD status
- Artwork, logo, badge, print, embroidery, name, ID, or rank requirements
- Material readiness

#### Sample

- Proto, fit, size set, salesman/photo, wash, PP, shipment, tender, or wearer-trial sample
- Planned and actual dates
- Size, color, quantity, and version
- Sample-room owner
- Internal comments

#### Review

- Internal measurements and quality review
- Deviations and corrective actions
- Approval to send

#### Send

- Dispatch date
- Courier and tracking
- Sent-to contact
- Expected feedback date

#### Approve

- Customer comments
- Annotated documents
- Approved, conditionally approved, or revision required
- Next version
- Final approved reference

### Stage gates

Each style independently reaches:

- Specification stable enough to cost
- Required sample stage complete
- Customer comments resolved or formally accepted as pending
- Approved version identified

### Continue action

`Send Approved/Costable Styles to Price`

The Price page receives style versions, BOM/consumption inputs, quantities, customer targets, commission parties, currency, Incoterm, and delivery assumptions.

---

## 7. Lifecycle Page 4 — Price

Purpose: Calculate a viable garment price, obtain internal approval, quote the customer, and negotiate.

### Style costing rail

Show every style with:

- Costing status
- Latest cost
- Customer target
- Proposed price
- Margin
- Approval status
- Quotation status

### Working stages within Price

```text
COST → REVIEW → APPROVE → QUOTE → NEGOTIATE
```

#### Cost

- Fabric consumption, price, wastage, and process loss
- Trims/accessories
- Cutting, making, finishing, and packing
- Washing, printing, embroidery, and special processes
- Testing and inspection
- Freight/logistics
- Buying-house or agent commission
- Overheads and financing cost
- MOQ/quantity price breaks
- Exchange-rate assumption

#### Review

- Customer target versus calculated cost
- Comparable historical styles
- Estimated margin
- Commercial risks
- Development or material assumptions

#### Approve

- Margin threshold
- Approval owner
- Approval, rejection, or revision comments
- Restricted margin/commission visibility

#### Quote

- Quote-to party
- Style prices and quantity breaks
- Currency and Incoterm
- Payment terms
- Delivery assumption
- Validity
- Quotation document/version

#### Negotiate

- Customer counteroffer
- Revised quantity or specification
- Revised costing/quotation version
- Concessions and approvals
- Accepted, rejected, or expired decision

### Uniform variation

For uniforms, Price can produce a contract price list by garment, size band, personalization, standard/made-to-measure, alteration/replacement charge, and effective period.

### Stage gates

- Costing completed for applicable styles
- Internal commercial approval received
- Customer accepted price/terms or formal award received
- Final costing and quotation version locked for conversion

### Continue action

`Convert to Order/Contract`

The Confirm page receives approved parties, styles, versions, quantities, prices, terms, destinations, dates, and documents without re-entry.

---

## 8. Lifecycle Page 5 — Confirm

Purpose: Convert the accepted business into a controlled PO, contract, or call-off order and prepare it for execution.

### Working stages within Confirm

```text
VERIFY PO → BREAK DOWN → PLAN → APPROVE FOR PRODUCTION
```

#### Verify PO/contract

- Customer PO or contract number
- PO issuer, bill-to, ship-to, consignee, buying house, and brand
- Approved style/version
- Price, currency, payment terms, and Incoterm
- Quantity and delivery dates
- Customer tolerance
- Contract validity for uniform programs

Compare PO against accepted quotation and highlight differences:

- Price mismatch
- Quantity mismatch
- Date mismatch
- Unapproved style/specification
- Changed commercial terms
- Missing destination or documentation

#### Break down

- Style, color, size, and quantity
- Destination/PO split
- Packing/assortment
- Uniform site, department, wearer batch, or issue cycle where applicable

#### Plan

- Time-and-action calendar
- Fabric/trim booking dates
- Approval deadlines
- Testing and inspection dates
- Ex-factory, shipment, and delivery dates
- Owners and dependencies

#### Approve for production

- Mandatory approval checklist
- Missing information
- Recorded exception and authority
- Final internal order confirmation

### Stage gates

- PO/contract reconciled with quotation
- Amendments approved
- Quantity/destination breakdown complete
- Critical path generated
- Mandatory pre-production information present

### Continue action

`Release to Fulfilment`

The Fulfil page receives the confirmed order baseline and time-and-action calendar.

---

## 9. Lifecycle Page 6 — Fulfil

Purpose: Give sales and merchandising connected customer-facing visibility from material readiness through packed goods.

This is not detailed factory ERP/MES. It consumes relevant milestones and supports exceptions, recovery, customer communication, and approvals.

### Milestone rail

```text
MATERIALS → PRE-PRODUCTION → CUT → DECORATE → SEW → FINISH → INSPECT → PACK
```

### Working panels

#### Critical path

- Planned versus actual date
- Owner
- Dependency
- On track, at risk, delayed, or blocked
- Delay reason
- Recovery action
- Revised forecast

#### Approvals

- Lab dip/strike-off
- Fabric and trims
- Artwork/branding
- Fit/size set
- Testing
- Pre-production sample
- Packaging
- Exception approvals

#### Production visibility

- Material readiness
- Cutting
- Printing/embroidery
- Sewing
- Washing/finishing
- Packing
- Planned, completed, rejected, and balance quantity

#### Quality

- Inline/final inspection status
- AQL and result
- Major defect summary
- Corrective action
- Reinspection
- Test report links

#### Customer communication

- Risk notification
- Revised-date approval
- Quantity shortfall/excess decision
- Inspection coordination
- Latest customer commitment

### Uniform variation

Add progress by:

- Site/location
- Department/job role
- Wearer or allocation batch
- Garment type
- Personalization batch

### Stage gates

- Required quantity packed or approved for partial shipment
- Final inspection passed/conditionally accepted
- Shipment documents and booking inputs ready
- Remaining shortages or exceptions explicitly recorded

### Continue action

`Prepare Delivery/Shipment`

Packed quantities, destinations, documents, inspection results, and delivery commitments flow into Deliver.

---

## 10. Lifecycle Page 7 — Deliver

Purpose: Move finished goods from ready-to-dispatch through delivery and commercial closure.

### Working stages within Deliver

```text
PLAN → BOOK → DISPATCH → TRACK → DELIVER → COMMERCIAL CLOSE
```

#### Plan and pack

- Order/quantity selection
- Partial shipment and balance
- Cartons, assortments, and markings
- Uniform packing by wearer, department, or site
- Destination and consignee

#### Book and dispatch

- Freight mode and forwarder
- Booking reference
- ETD/ETA
- Actual ex-factory/dispatch date
- Vehicle, vessel, or flight details

#### Documents

- Commercial invoice
- Packing list
- Bill of lading/airway bill
- Certificate of origin
- Inspection and test reports
- Customer-specific documents

#### Track and deliver

- Tracking milestones
- Delay/exception
- Revised ETA
- Proof of delivery
- Recipient or site acknowledgement

#### Commercial close

Permission controlled:

- Invoice status
- Payment due date
- Paid, part-paid, overdue, or disputed
- Debit note, deduction, chargeback, or credit note
- Agent/buying-house commission status

### Stage gates

- Delivery acknowledged or shipment responsibility completed under the Incoterm
- Documents complete
- Invoice/payment status visible
- Any shortage, damage, delay, or claim converted into an aftercare case

### Continue action

`Close and Grow Account`

Delivery performance, actual quantity/value, payment status, and service issues flow into Grow.

---

## 11. Lifecycle Page 8 — Grow

Purpose: Convert completed business into retention, corrective learning, repeat orders, replenishment, and account growth.

### Working panels

#### Performance review

- Quoted versus ordered value
- Estimated versus actual margin, where integrated and authorized
- Sample and approval performance
- On-time ex-factory and delivery
- Quality and inspection performance
- Claim/service performance
- Payment behavior

#### Complaints and claims

- Order/style/shipment/item
- Issue and evidence
- Root cause
- Replacement, alteration, repair, credit, or rejection
- Corrective/preventive action
- Closure and customer acceptance

#### Repeat business

- Repeat approved style
- Carry forward specification and approvals
- Recalculate costing
- New season/development
- Reorder reminder
- Dormant-account action

#### Uniform aftercare

- Alteration or size exchange
- New joiner
- Replacement
- Stock replenishment
- Next issue cycle
- Contract consumption
- Price review
- Contract renewal

#### Relationship plan

- Customer feedback
- Account review meeting
- Cross-sell product categories
- Next buying season/tender
- Next action, owner, and due date

### Completion options

- `Create Repeat Journey`
- `Create New Development Journey`
- `Create Uniform Replenishment Cycle`
- `Start Contract Renewal`
- `Close Journey`

A new journey should reference the completed one and reuse approved account, party, contact, style, and commercial data without overwriting historical versions.

---

## 12. Uniform Lifecycle Mapping

The same eight lifecycle pages remain visible for uniform business, but their working content adapts:

| Lifecycle page | Uniform interpretation |
|---|---|
| Account | Client, sites, departments, coordinators, wearer estimate, service model |
| Enquiry | Requirement, tender, eligibility, garment list, trial expectations |
| Develop | Uniform design, wearer trial, size set, branding, safety/testing approval |
| Price | Costing, tender price, contract catalog, price list, service charges |
| Confirm | Contract award, catalog, sites, entitlements, call-off rules, T&A |
| Fulfil | Sizing, allocation, personalization, production/stock fulfillment, QC |
| Deliver | Pack by wearer/site, issue, acknowledgement, balance and exceptions |
| Grow | Exchange, alteration, replacement, replenishment, price review, renewal |

Uniform Programs can still have a library/list accessible from the Journey Hub, but an active program should open into this same connected lifecycle rather than a disconnected application area.

---

## 13. Buying-house/Brand Lifecycle Mapping

| Lifecycle page | Buying-house/brand interpretation |
|---|---|
| Account | Buying house, brand, buyer contacts, vendor code, manuals, calendar |
| Enquiry | RFQ, styles, quantities, target price, season, destination |
| Develop | Tech packs, materials, samples, revisions, buyer approvals |
| Price | Costing, commission, quotation, target negotiation, price approval |
| Confirm | PO validation, style/color/size/destination breakdown, critical path |
| Fulfil | Approvals, material/production milestones, quality, recovery actions |
| Deliver | Packing, inspection documents, booking, shipment, delivery/payment visibility |
| Grow | Claim resolution, performance review, repeat style, next season |

---

## 14. Lifecycle State and Navigation Rules

### Pages are sequential but not rigid

- Users may view earlier or later pages according to permission.
- A stage cannot be declared complete until required gates pass.
- Authorized users may record exceptions with a reason and audit event.
- Revising an earlier stage must identify affected downstream data.
- The system should warn when an approved specification, quantity, price, or date changes.

### Stage status

Each lifecycle page has its own state:

- Not Started
- In Progress
- Waiting on Customer
- Waiting on Internal Team
- Complete
- Reopened
- Blocked
- Not Applicable

Do not use one generic order status for the whole journey.

### Readiness and handoff

Every page must show:

- Required inputs
- Completed inputs
- Missing inputs
- Blocking issues
- Responsible owner
- Next recommended action
- What will be carried into the next page

### Shared data

The following must remain consistent across all pages:

- Customer and commercial parties
- Contacts
- Internal owners
- Style and version identifiers
- Customer PO/order references
- Currency and commercial terms
- Key target dates
- Documents
- Activities/tasks
- Approval and audit history

Updates must use connected references and versioning, not copied free-text values, except where a historical commercial snapshot is intentionally required.

---

## 15. Screen Layout

Use a consistent Resolve-like workspace structure:

```text
┌─────────────────────────────────────────────────────────────┐
│ Journey / Customer / Owner / Status / Risk / Next Action   │
├──────────────┬───────────────────────────┬──────────────────┤
│ Record Rail  │ Main Stage Workspace      │ Activity/Tasks   │
│ styles/items │ forms, tables, approvals  │ comments, files  │
│ or batches   │ and stage actions         │ and alerts        │
├──────────────┴───────────────────────────┴──────────────────┤
│ ACCOUNT ENQUIRY DEVELOP PRICE CONFIRM FULFIL DELIVER GROW  │
└─────────────────────────────────────────────────────────────┘
```

### Left rail

Changes with stage:

- Account: related parties, sites, or contacts
- Enquiry: requirements/items
- Develop: styles and sample versions
- Price: style costings and quote versions
- Confirm: POs, destinations, and order lines
- Fulfil: milestones, styles, batches, and exceptions
- Deliver: shipments, destinations, and documents
- Grow: cases, repeat opportunities, and renewal actions

### Main workspace

Contains the primary tools for the selected lifecycle stage.

### Right activity rail

Shows contextual:

- Customer/internal comments
- Tasks
- Approval requests
- Documents
- Mentions
- Change history

The user should not leave the journey to understand what happened.

### Bottom lifecycle bar

Always shows:

- Completed pages
- Current page
- Blocked pages
- Pages with pending customer action
- Next recommended page

---

## 16. Global Libraries

Some records need global access, but they should not dominate the lifecycle navigation.

Accessible from the Journey Hub or global search:

- Customer/account library
- Contact directory
- Style/development library
- Approved uniform catalog
- Active order list
- Uniform program list
- Document search
- Reports
- Settings

Opening a transactional record should return the user to its Sales Journey at the correct lifecycle page.

---

## 17. Dashboards and Reports

Dashboard cards and reports should open the relevant journey and lifecycle page, not an isolated duplicate screen.

Examples:

- “7 samples delayed” opens those journeys on Develop.
- “4 quotations awaiting follow-up” opens those journeys on Price.
- “6 orders at risk” opens those journeys on Fulfil.
- “3 shipments delayed” opens those journeys on Deliver.
- “5 uniform contracts due for renewal” opens those journeys on Grow.

Reports remain focused on:

- Pipeline and win rate
- Development/sample turnaround
- Quotation acceptance and margin
- Order and delivery performance
- Quality and claims
- Uniform consumption/service/renewal
- Customer profitability and repeat business

---

## 18. Role-based Experience

All permitted users see the same lifecycle, but each role receives different tools and edit rights.

### Sales/account manager

Primary pages: Account, Enquiry, Price, Grow. Read visibility into the connected downstream journey.

### Merchandiser

Primary pages: Enquiry, Develop, Price, Confirm, Fulfil, and Deliver.

### Uniform-program coordinator

Works across the complete adapted uniform lifecycle, especially Account, Confirm, Fulfil, Deliver, and Grow.

### Production, quality, and logistics

Open assigned journeys directly on Fulfil or Deliver with limited commercial visibility.

### Finance

Open assigned journeys on Account, Price, Confirm, Deliver, or Grow with controlled access to credit, invoice, payment, deduction, and commission information.

### Management

Can review journey progress, risks, approvals, performance, and reports across stages.

Permissions change available fields and actions, not the underlying lifecycle language.

---

## 19. Recommended Build Sequence

Build the connected shell before adding all lifecycle capabilities.

1. **Foundation and lifecycle shell**
   - Customer accounts, garment sales profile, contacts, sites, related parties, activities, tasks
   - Journey Hub shell
   - Persistent journey header
   - Bottom lifecycle bar with Account enabled and future stages visibly unavailable
2. **Enquiry**
   - Leads, RFQs, opportunities, uniform enquiries, and tenders
   - Sales Journey record and stage transitions
3. **Develop**
   - Styles, tech packs, materials, samples, revisions, and approvals
4. **Price**
   - Costings, approvals, quotations, negotiations, and uniform price lists
5. **Confirm**
   - PO/contract conversion, breakdown, amendments, and time-and-action calendar
6. **Fulfil**
   - Pre-production approvals, milestone integration, quality, risk, and recovery
7. **Deliver**
   - Packing, shipment, documents, delivery, and payment visibility
8. **Grow**
   - Claims, performance, repeat orders, uniform service, replenishment, and renewal
9. **Reports and portal**

Step 01 must not implement the later stages' business features, but it should establish the visual lifecycle shell so the product direction is visible from the beginning.

---

## 20. Lifecycle Acceptance Checklist

- [ ] The user opens one Sales Journey and remains inside it across the lifecycle.
- [ ] Account, Enquiry, Develop, Price, Confirm, Fulfil, Deliver, and Grow appear as sequential pages.
- [ ] A persistent header shows customer, parties, owner, status, risk, dates, and next action.
- [ ] The selected customer, parties, contacts, files, and owners carry forward automatically.
- [ ] Each stage defines readiness, missing inputs, blockers, owner, and next action.
- [ ] Completing a stage prepares the next stage without re-entering data.
- [ ] Earlier-stage changes warn about downstream impact and preserve history.
- [ ] Multi-style enquiries remain within one journey and provide a style rail.
- [ ] Buying-house/brand and uniform journeys use the same lifecycle with adapted stage content.
- [ ] Tasks, approvals, documents, comments, and audit history remain contextual to the journey.
- [ ] Dashboard and report links open the correct journey and lifecycle stage.
- [ ] Libraries support search, but operational work returns to the connected journey.
- [ ] ERP, production, logistics, and accounting data appears as connected milestone/status information rather than separate CRM silos.
- [ ] New journeys can reuse approved customer/style data without overwriting historical records.
