# Garment CRM — Complete Sales Journey Frontend/UI Specification

## 1. Document purpose

This document defines the complete frontend experience for the garment CRM Sales Journey:

`ACCOUNT → ENQUIRY/RFQ → STYLE & SAMPLE → COST & QUOTE → PO/CONTRACT → PRODUCTION → SHIPMENT → RETENTION`

It describes the intended screens, information hierarchy, interactions, states, responsive behavior, reusable components, and future backend contracts for every lifecycle stage.

This is a product and UI specification. It does not authorize backend implementation for stages outside the active task in `docs/tasks/current-task.md`. Until later implementation tasks are approved, later-stage interfaces must be treated as prototypes and must not claim to persist data.

Canonical companion documents:

- [CRM master requirements](./crm-master-requirements.md)
- [Connected lifecycle](./connected-lifecycle.md)
- [Current implementation task](../tasks/current-task.md)
- [Architecture decisions](../decisions/architecture-decisions.md)

---

## 2. Product model

### 2.1 One connected Sales Journey

A Sales Journey is the commercial workspace for one connected customer requirement and its progression into development, pricing, order confirmation, fulfilment, delivery, and growth.

Examples include:

- A buying-house enquiry containing several styles for one brand season.
- A direct-brand RFQ for a new collection.
- A hospital uniform tender.
- A school uniform contract renewal.
- A repeat order based on an approved style.
- A uniform replenishment cycle.

The UI must keep the following context connected across all stages:

- Primary customer Account.
- Buying house, brand, PO issuer, bill-to party, consignee, agent, and other commercial parties.
- Customer Contacts.
- Internal sales owner, account manager, merchandiser, coordinator, and approvers.
- Journey reference, name, business type, status, risk, and target dates.
- Styles, versions, quantities, commercial assumptions, documents, activities, and approvals.
- Readiness, blockers, next action, and stage handoff information.

The system must not represent the journey as eight unrelated departmental modules.

### 2.2 Required domain separation

The frontend must communicate that these are distinct records:

- **Account:** durable customer and partner identity.
- **Sales Journey:** one commercial lifecycle.
- **Development/style:** versioned product-development work within a Journey.
- **Quotation:** versioned commercial proposal.
- **Order/contract:** confirmed commercial commitment.
- **Fulfilment records:** operational milestones and exceptions connected to an Order.

The UI may display these records together, but must not imply they are one database object.

### 2.3 Frontend implementation modes

Every screen must declare one of three data modes:

1. **Live:** backed by an existing API and persistent data.
2. **Prototype:** backed by centralized fixtures or a local adapter and visibly labeled as preview data.
3. **Unavailable:** visible as part of the lifecycle direction but not interactive.

Prototype screens must not:

- Call invented endpoints.
- Show false save-success messages.
- Store important business data only in browser memory while implying persistence.
- Duplicate live Account or Contact data into unrelated fixture structures.

### 2.4 Verified frontend architecture

This specification has been checked against the current frontend repository at `/Users/risheeray/grav-cms`.

The implementation must work with the architecture that already exists:

- **Framework:** Next.js 16 using the App Router under `app/`.
- **Language:** The Sales application is predominantly client-side JavaScript using `page.js` files. Shared primitives may be TypeScript/TSX where they already exist.
- **Root shell:** `app/layout.js` mounts the global providers, toast provider, and `AppShell`.
- **Sales shell:** Sales pages render through `components/Sales_DashboardLayout.js`.
- **Shared department chrome:** `Sales_DashboardLayout` configures `components/shell/FrostShell.js` using its top-navigation variant.
- **Access boundary:** `FrostShell` applies the Sales department guard. Pages must not create a competing authentication or layout wrapper.
- **Department permissions:** UI capability checks use `components/access/useDeptRole.js`. Client-side checks are presentation rules; the server remains the security boundary.
- **Write approvals:** Sales writes may return HTTP `202` because an editor's change is held for approval. The UI must treat this as “submitted for approval,” not “saved.”
- **Approval visibility:** `HeldChangeWatcher` is already mounted by `Sales_DashboardLayout` and links users to the existing Sales approvals screen.
- **CRM data access:** Existing Account work uses `lib/crmApi.js`, which scopes requests to `/api/cms/crm`, includes credentials, normalizes errors, and preserves the held-write response.
- **Authentication transport:** The application supports cookie authentication and a broader cookie/Bearer-aware fetch layer. New CRM code must reuse the established request utilities instead of implementing another token store.
- **Design primitives:** Existing CRM pages reuse `components/ceo/ui/Primitives.tsx` for panels, headings, fields, inputs, buttons, chips, empty states, errors, and skeletons.
- **CRM primitives:** `components/sales/crm/crmShared.js` owns CRM lookups, Account selection helpers, permission-aware commercial visibility, drawers, key/value display, role selection, and CRM notifications.
- **CRM shell components:** `components/sales/crm/shell/LifecycleBar.js`, `WorkspaceHeader.js`, and `RailGroup.js` already establish the Account-stage shell.
- **Styling:** The shared visual language is provided by `app/grav-ui.css` and the existing frost/surface/state tokens. Do not introduce a parallel stylesheet or design system.
- **Current Account routes:** The Account library is at `app/sales/dashboard/accounts/page.js`; the connected Account detail is at `app/sales/dashboard/accounts/[id]/page.js`.
- **Current Account sections:** Contacts, Sites/Addresses, Departments, Relationships, Team, Activities, Documents, Audit, Commercial information, Overview, and Garment Profile are implemented as section components under `app/sales/dashboard/accounts/[id]/_sections/`.
- **Existing Sales routes:** Leads, Contacts, Accounts, call planning, CRM settings, customer requests/POs, customers, products/BOM, measurements, approvals, and configuration screens already exist. A Journey UI must connect to or coexist with them; it must not casually delete, rename, or duplicate them.

### 2.5 Verified uncommitted-work boundary

The frontend currently contains substantial uncommitted work, including:

- The Account list and connected Account workspace.
- CRM shared components and API utilities.
- Garment Sales Profile work.
- Sales dashboard and shared shell visual changes.
- Reference images under `app/sales/references/`.
- Unrelated `.DS_Store` files.

An implementing agent must inspect `git status` before every slice and preserve these changes. It must not clean, revert, reformat, stage, or commit unrelated files.

### 2.6 Required route and component placement

Use the current App Router structure. The recommended placement for the future connected Journey UI is:

```text
app/sales/dashboard/
├── journeys/
│   ├── page.js                         # Journey Hub
│   └── [journeyId]/
│       ├── layout.js                   # persistent Journey shell/context
│       ├── page.js                     # redirect/default to current stage
│       └── [stage]/
│           └── page.js                 # deep-linkable stage workspace
└── accounts/
    ├── page.js                         # existing Account library
    └── [id]/page.js                    # existing Account workspace

components/sales/crm/
├── shell/                              # existing reusable CRM shell pieces
└── journey/
    ├── JourneyWorkspace.js
    ├── JourneyHeader.js
    ├── JourneyContextRail.js
    ├── JourneyActivityRail.js
    ├── StageChecklistDrawer.js
    ├── PrototypeDataBanner.js
    └── stages/                         # stage-specific workspace components

lib/salesJourney/
├── adapter.js                          # common live/prototype interface
├── capabilities.js                     # live, prototype, unavailable flags
├── stageConfig.js                      # labels, ordering, readiness metadata
└── fixtures/                           # centralized prototype data only
```

The exact filenames may be adapted to repository conventions, but the implementation must preserve these boundaries:

- Route files compose screens; they do not contain thousands of lines of stage-specific business UI.
- Shared Journey chrome lives in reusable components.
- Each stage has its own workspace component but receives the same Journey context.
- Fixture data lives outside React page components.
- The stage is represented in the URL so refresh, browser navigation, bookmarks, and dashboard deep links return to the correct workspace.
- The existing Account library remains the durable customer library.
- A Journey's Account stage reuses the existing Account components and data rather than creating another Account form or Contact store.

Recommended stage slugs:

| Display label | URL slug |
|---|---|
| Account | `account` |
| Enquiry/RFQ | `enquiry` |
| Style & Sample | `style-sample` |
| Cost & Quote | `cost-quote` |
| PO/Contract | `po-contract` |
| Production | `production` |
| Shipment | `shipment` |
| Retention | `retention` |

### 2.7 Existing screens that must not be mistaken for Journey stages

Several current screens contain related functionality but are not automatically the new Journey model:

- `/sales/dashboard/leads`
- `/sales/dashboard/customer-requests`
- `/sales/dashboard/customer-requests/[id]`
- `/sales/dashboard/customers`
- `/sales/dashboard/stock-items`
- `/sales/dashboard/call-planner`

These screens may later supply data or deep links, but a frontend prototype must not silently reclassify their records as Sales Journeys. Until backend contracts are approved, connect them through explicit prototype adapters or leave them as existing libraries/workflows.

---

## 3. Global application structure

### 3.1 Main Sales CRM navigation

The current Sales navigation is configured by the `NAV` array in `components/Sales_DashboardLayout.js`. New Journey navigation must be added there when implementation is authorized; individual pages must not create a second permanent navigation system.

Current relevant destinations include:

- Sales dashboard
- Purchase orders / PI (`customer-requests`)
- Approvals
- Customer list
- Products & BOM
- Leads
- Contacts
- Accounts
- Call planner
- CRM settings

Recommended future Journey destination:

- Journey Hub

Add Journey Hub as the primary operational CRM entry point while retaining Accounts and Contacts as durable libraries. Do not remove or rename current navigation entries during a frontend prototype. Any consolidation of Leads, customer requests, customers, or products requires a later approved migration decision.

Accounts and Contacts are durable libraries. Operational work should open inside the relevant Sales Journey and lifecycle stage.

### 3.1A Navigation and naming migration

The current Sales navigation contains overlapping concepts:

- `Customer list` points to `/sales/dashboard/customers`.
- `Accounts` points to `/sales/dashboard/accounts`.
- `Leads` is a standalone CRM screen even though Enquiry/RFQ will become a Journey stage.
- `Purchase orders / PI` is a top-level item outside the CRM group even though PO/Contract is a Journey stage.
- `Products & BOM` and `MPC measurements` are operational libraries that later stages may reference but must not absorb into the Journey record.
- The generic breadcrumb renders route segments and raw record IDs rather than business names.

The frontend implementation must deliberately resolve this information architecture. It must not simply add `Journeys` to the existing menu and leave every overlapping label unexplained.

#### Target primary Sales navigation

Use the existing `NAV` configuration and `FrostShell` top navigation, but reorganize the Sales information architecture toward the following model:

```text
OVERVIEW
├── Sales Overview
├── Journey Hub
└── Approvals

CUSTOMER LIBRARIES
├── Accounts
├── Contacts
└── Call Planner

OPERATIONS & LIBRARIES
├── Orders & PI
├── Products & BOM
└── Measurements

CONFIGURATION
├── CRM Settings
├── Product/Measurement Mapping
├── Units & Conversions
├── Operations
├── Warehouses
├── Devices & Machines
├── Customer Departments
└── Sales Settings
```

The exact visual grouping may adapt to available top-navigation width, but these conceptual boundaries must remain clear.

#### Navigation labels

Use these primary labels consistently:

| Current or ambiguous label | Target label | Meaning |
|---|---|---|
| `Sales dashboard` | `Sales Overview` | Department-level metrics, alerts, and shortcuts. |
| New route | `Journey Hub` | Primary operational entry for connected garment Sales Journeys. |
| `Customer` menu group | `Customer Libraries` or `Customers` | Durable Account and Contact records, not active commercial journeys. |
| `Accounts` | `Accounts` | Canonical organization/customer/partner master. |
| `Customer list` | `Order Customers (Existing)` during transition | Existing order-customer records until their relationship to Accounts is formally migrated. |
| `Leads` | `Leads (Existing)` during transition | Existing lead records until Step 02 defines how they become Enquiry/RFQ Journey records. |
| `Purchase orders / PI` | `Orders & PI` | Existing confirmed-order/PI workflow; not the Journey itself. |
| `MPC measurements` | `Measurements` | Existing measurement library/workflow. |
| `CRM settings` | `CRM Settings` | CRM-controlled values and configuration. |
| `Call planner` | `Call Planner` | Cross-Account calls and follow-ups; Journey-specific activity remains contextual. |

Do not permanently rename a legacy record type to a new domain concept unless the underlying records actually match. Transitional labels such as `Leads (Existing)` and `Order Customers (Existing)` are preferable to pretending they are already Journey Enquiries or Accounts.

#### Legacy-route transition rules

- Preserve existing URLs and functionality.
- Do not delete, redirect, or hide a legacy screen until equivalent live behavior exists and an approved migration decision identifies the source of truth.
- Move legacy entries into a clearly labeled transitional group if keeping them in the main hierarchy creates confusion.
- Do not duplicate their data into Journey fixtures.
- Prototype Journey links may open existing live screens in a new tab or clearly labeled library context, but must not imply the records are linked when no stable relationship exists.
- Record all temporary labels and transitions in the frontend handoff.

#### Lifecycle stages are not primary navigation tabs

Do not add eight top-navigation items for the lifecycle. The stages belong inside an opened Journey:

`ACCOUNT → ENQUIRY/RFQ → STYLE & SAMPLE → COST & QUOTE → PO/CONTRACT → PRODUCTION → SHIPMENT → RETENTION`

The top navigation answers “which workspace or library am I entering?” The lifecycle bar answers “where am I inside this Journey?” These must not compete.

#### Stage and sub-navigation naming

Use the following display names and subordinate workspace labels:

| Lifecycle stage | Permitted inner tabs/sections |
|---|---|
| Account | Overview; Garment Profile; People & Locations; Related Parties; Account Team; Activity; Documents; Audit |
| Enquiry/RFQ | Requirement; Qualification; Tender; Clarifications; Pursue Decision |
| Style & Sample | Specify; Prepare; Sample; Review; Send; Approve |
| Cost & Quote | Costing; Commercial Review; Approval; Quotation; Negotiation |
| PO/Contract | Verify; Breakdown; Plan; Release |
| Production | Materials; Pre-production; Cut; Decorate; Sew; Finish; Inspect; Pack |
| Shipment | Plan; Book; Dispatch; Documents; Track; Deliver; Commercial Close |
| Retention | Performance; Claims; Repeat Business; Uniform Service; Relationship Plan |

Inner tabs are stage-local views. They must not appear as separate global modules, and they must preserve the same Journey and selected-record context.

#### Naming source of truth

Stage keys, slugs, display labels, descriptions, order, state labels, and prototype/live capabilities must be centralized in `lib/salesJourney/stageConfig.js` or an equivalent single configuration module.

Do not hard-code lifecycle display labels independently in:

- Navigation
- Journey cards
- Journey header
- Lifecycle bar
- Breadcrumbs
- Page titles
- Empty states
- Fixture objects

Stable internal keys should remain short (`account`, `enquiry`, `styleSample`, `costQuote`, `poContract`, `production`, `shipment`, `retention`) while display labels remain changeable.

#### Active-menu behavior

- All Journey Hub and Journey-stage routes use one active navigation key, recommended as `journeys`.
- Account library/detail routes continue to use `accounts`.
- Contact routes continue to use `contacts`.
- Existing order/PI routes continue to use their existing key until the navigation config is deliberately renamed together with every caller.
- No Journey stage should highlight `leads`, `accounts`, or `customers-po` merely because it displays related data.

#### Breadcrumb behavior

The existing generic breadcrumb derives text directly from URL segments. Journey routes require business-aware labels.

Target Journey breadcrumb:

```text
Sales / Journey Hub / SJ-2026-0042 · MetroCare Uniform Program / Cost & Quote
```

Requirements:

- Show Journey reference and readable Journey name instead of raw database ID.
- Show the current lifecycle display label from the central stage configuration.
- Link `Journey Hub` to `/sales/dashboard/journeys`.
- Link the Journey crumb to its default/current-stage route.
- Do not render both the generic breadcrumb and a second Journey breadcrumb.
- Extend the existing breadcrumb system or allow the Journey layout to provide resolved labels; do not fork an unrelated breadcrumb component with different styling.
- Account detail breadcrumbs should similarly prefer Account code/name over raw `_id` when the data is available.

#### Page titles and action naming

- Use nouns for libraries: `Accounts`, `Contacts`, `Orders & PI`.
- Use journey/stage language for operational work: `Journey Hub`, `Style & Sample`, `Cost & Quote`.
- Use explicit verbs for actions: `Start Enquiry/RFQ`, `Send to Style & Sample`, `Submit for Commercial Approval`, `Convert to PO/Contract`, `Release to Production`, `Prepare Shipment`, `Create Repeat Journey`.
- Avoid generic actions such as `Continue`, `Proceed`, or `Submit` when the business transition can be named.
- Never label a prototype-only action `Save`, `Confirm`, `Release`, or `Send` without a visible preview qualifier.

### 3.2 Journey Hub

The Journey Hub is the default operational entry point.

#### Hub views

- My active journeys
- Team journeys
- Waiting on customer
- Waiting on internal team
- At risk
- Delayed or blocked
- Approaching quotation deadline
- Closing or dispatching soon
- Uniform programs
- Completed and reorder-ready
- Recently viewed

#### Journey card/row content

- Journey reference and name
- Customer Account
- Buying house and brand, when applicable
- Business type: brand/buying house, uniform, direct brand, repeat, replenishment
- Current lifecycle stage
- Stage status
- Overall business status
- Risk state and primary risk reason
- Sales owner and merchandiser/coordinator
- Next action, owner, and due date
- Expected or confirmed value
- Target sample, ex-factory, shipment, or delivery date as appropriate
- Progress/readiness indicator
- Last activity timestamp

#### Hub actions

- Start new journey
- Resume journey
- Open Account
- Add activity
- Create task
- View blocker
- View pending approval
- Filter and sort
- Switch between cards and table

#### Filters

- Search by Journey, Account, brand, buying house, PO/RFQ reference, Contact, or owner
- Lifecycle stage
- Stage status
- Risk state
- Business type
- Owner/team
- Customer
- Date range
- Expected value range
- Waiting party
- Completed/archive state

#### Hub states

- First-use empty state with explanation and permitted action
- Filtered empty state
- Loading skeleton
- Partial-data warning
- Permission-restricted state
- API error with retry
- Read-only state

---

## 4. Shared Sales Journey shell

Every lifecycle stage must use the same structural shell.

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Journey header: customer, parties, owner, status, risk, next action│
├────────────────┬────────────────────────────────┬───────────────────┤
│ Context rail   │ Main stage workspace           │ Activity rail     │
│ records/items  │ forms, tables, gates, actions │ tasks/docs/history│
├────────────────┴────────────────────────────────┴───────────────────┤
│ ACCOUNT  ENQUIRY/RFQ  STYLE & SAMPLE  COST & QUOTE  PO/CONTRACT    │
│ PRODUCTION  SHIPMENT  RETENTION                                    │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.1 Persistent journey header

Always show:

- Journey reference and name
- Primary customer
- Buying house/brand or uniform program label
- Current lifecycle stage
- Stage status
- Overall business status
- Risk state
- Primary owner
- Merchandiser or uniform coordinator
- Next action and due date
- Primary target date
- Expected or confirmed value, when permitted
- Overall progress/readiness

Header actions:

- Add note/activity
- Create task
- Upload or link document
- View Account
- View stage checklist
- Add or update blocker
- View full timeline
- Open actions menu

### 4.2 Left context rail

The rail changes by stage but keeps a consistent interaction pattern.

It must support:

- Search within rail items
- Status badges
- Counts
- Selection
- Add/link action when authorized
- Compact empty state
- Collapsed mobile presentation

### 4.3 Main stage workspace

The workspace contains stage-specific tools. Each major section must support:

- View and edit modes
- Required-field indicators
- Validation messages
- Saved/unsaved state
- Loading and submission state
- Permission-aware actions
- Empty, error, and partial-data states
- Audit/history access where relevant

### 4.4 Right contextual rail

Shared contextual groups:

- Recent activities
- Upcoming tasks
- Overdue tasks
- Pending approvals
- Waiting-on-customer items
- Documents
- Mentions/comments
- Change history

Items must remain scoped to the current Journey and, where appropriate, the selected style, quotation, order, shipment, or case.

### 4.5 Lifecycle bar

The bar must show, in order:

`Account → Enquiry/RFQ → Style & Sample → Cost & Quote → PO/Contract → Production → Shipment → Retention`

Each stage shows:

- Stage name
- Current/completed/blocked/waiting/not-started state
- Lock state when unavailable
- Warning indicator for missing or stale inputs
- Pending-customer indicator
- Reopened indicator

Selecting a stage must preserve the Journey context. An unavailable stage explains why it is unavailable and must not open a blank module.

### 4.6 Stage checklist drawer

Every stage checklist contains:

- Required inputs
- Completed inputs
- Missing inputs
- Blocking issues
- Recommended next action
- Responsible owner
- Data that will carry forward
- Exceptions and approval history

### 4.7 Responsive behavior

Desktop:

- Three-column shell with persistent lifecycle bar.
- Rails independently collapsible where useful.

Tablet:

- Main workspace plus one contextual drawer.
- Horizontally scrollable lifecycle bar.

Mobile:

- Single-column workspace.
- Compact sticky journey header.
- Context rail and activity rail become drawers/sheets.
- Lifecycle bar remains reachable and horizontally scrollable.
- Primary stage action remains visible without obscuring fields.

---

## 5. Stage 1 — Account

### 5.1 Purpose

Establish who the customer is, which organizations and people participate, what they usually buy, and who owns the relationship internally.

### 5.2 Left rail

Groups:

- Contacts
- Sites and operational locations
- Departments
- Addresses and destinations
- Parent/child Accounts
- Related commercial parties
- Internal Account team

Each group shows a count, short preview, empty state, and Manage action.

### 5.3 Main workspace sections

#### Customer identity

- Display and legal name
- Account code
- Multiple business roles
- Status and lifecycle classification
- Country, currency, language, and time zone
- Customer tier and potential
- Primary location
- Parent Account
- External/ERP reference

#### Garment Sales Profile

- Business models
- Product categories
- Construction types
- Wearer/consumer categories
- Target markets
- Estimated annual pieces and styles
- Typical order quantity range
- Expected MOQ
- Target price band and currency
- Development and bulk lead-time expectations
- Order frequency
- Peak seasons
- Buying calendar notes
- Customer potential

#### Compliance and quality

- Required certifications
- Social-compliance requirements
- Sustainability requirements
- Restricted-substance requirements
- Default testing protocol
- Default inspection standard
- AQL expectation
- Nominated laboratories and suppliers
- Quality manuals and routing documents
- Reminder/expiry dates

#### Buying-house/brand profile

Shown only for relevant roles:

- Vendor/customer code
- Brand division/product department
- Buying office and country
- Default PO issuer
- Bill-to Account
- Importer/consignee Account
- Agent Account
- Commission reference with restricted visibility
- Delivery destination
- Freight preference
- Buyer, packaging, and routing manuals
- Seasonal notes

#### Uniform-client profile

Shown only for relevant roles:

- Customer industry
- Estimated wearer count
- Estimated service-site count
- Ordering model
- Fulfilment model
- Sizing model
- Personalization types
- Issue frequency
- New-joiner process
- Replacement process
- Service regions
- Tender/contract cycle

Do not show or store individual wearer measurements here.

### 5.4 Account interactions

- Create/edit Account
- Add/remove roles
- Link parent Account
- Link external commercial party
- Add/edit/archive/restore Contact
- Mark primary Contact
- Add/edit/archive/restore Site, Address, and Department
- Assign Account team
- Log activity
- Create/complete/cancel task
- Archive/restore Account with impact warning
- View audit history

### 5.5 Stage readiness

Account is ready when:

- Primary customer is selected.
- Required roles are assigned.
- Primary Contact exists.
- Internal owner exists.
- Required commercial parties are identified.
- Basic garment profile is recorded.
- Next requirement can be captured.

### 5.6 Continue action

`Start Enquiry/RFQ/Tender`

When Step 02 is not live, this action must be disabled with an explanation.

---

## 6. Stage 2 — Enquiry/RFQ

### 6.1 Purpose

Capture what the customer is asking for, qualify it, establish commercial and technical feasibility, and decide whether to pursue it.

### 6.2 Enquiry variants

- General enquiry
- Buying-house or brand RFQ
- Formal tender
- Uniform requirement
- Repeat order request
- Replenishment request

The UI adapts labels and conditional panels without changing the underlying lifecycle language.

### 6.3 Left rail

Items represent requirement lines or enquiry groups:

- Garment categories
- Styles expected
- Tender lots
- Uniform garment groups
- Repeat/replenishment references

Each item shows completeness, feasibility, owner, and blocker state.

### 6.4 Main workspace sections

#### Requirement summary

- Enquiry/RFQ/tender reference
- Enquiry type
- Customer, buying house, and brand
- Customer Contacts
- Garment categories
- Expected style count
- Expected quantity
- Target price and currency
- Sample deadline
- Ex-factory/delivery deadline
- Destination and Incoterm
- Business model

#### Product requirement

- Garment description
- Fabric/construction summary
- Colors and sizes
- Branding/personalization
- Packaging
- Testing/compliance
- Tech packs, images, references, and manuals

#### Commercial qualification

- Estimated value
- Win probability
- MOQ fit
- Capacity fit
- Lead-time feasibility
- Compliance capability
- Strategic value
- Competitors/current supplier
- Commercial concerns

#### Tender panel

- Tender number
- Eligibility checklist
- Submission deadline
- Security/deposit
- Mandatory documents
- Trial/sample expectations
- Technical evaluation dates
- Commercial evaluation dates

#### Clarifications and feasibility

- Customer questions
- Internal questions
- Missing documents
- Assigned reviewer
- Due date
- Resolution state

#### Pursue decision

- Pursue
- Pursue with conditions
- Hold
- Decline
- Decision owner
- Decision date
- Reason and evidence

### 6.5 Right rail emphasis

- Clarification tasks
- Missing customer inputs
- Internal feasibility tasks
- Tender deadlines
- Recent customer communication

### 6.6 Stage readiness

- Customer and parties confirmed
- Requirement sufficiently complete
- Feasibility reviewed
- Pursue/no-pursue decision recorded
- Development items created or identified
- Required documents present or explicitly pending

### 6.7 Continue action

`Send to Development`

Carry forward customer, parties, Contacts, owners, requirements, files, dates, quantities, targets, and compliance expectations.

---

## 7. Stage 3 — Style & Sample

### 7.1 Purpose

Turn the customer requirement into stable, costable, approved garment styles while preserving every meaningful revision.

### 7.2 Style rail

Each style row shows:

- Internal and customer style number
- Thumbnail
- Garment category
- Current development substage
- Latest version
- Sample status
- Approval status
- Owner
- Target sample date
- Blocker/risk

Rail filters:

- Not started
- Technical review
- Preparing materials/pattern
- Sampling
- Sent to customer
- Revision required
- Approved
- Dropped

### 7.3 Development substages

`SPECIFY → PREPARE → SAMPLE → REVIEW → SEND → APPROVE`

#### Specify

- Style identity
- Season/collection or uniform role
- Tech pack and drawings
- Construction details
- Measurements and tolerances
- Colorways
- Size range
- Expected quantities
- Destination breakdown summary

#### Prepare

- Fabric composition, construction, GSM, finish, and source
- Trims and accessories
- Pattern/CAD status
- Artwork and branding
- Embroidery/print/badge/name requirements
- Material readiness
- Testing prerequisites

#### Sample

- Sample type
- Version
- Size/color/quantity
- Requested and planned dates
- Actual completion date
- Sample-room owner
- Material status
- Internal notes and photos

#### Review

- Measurement review
- Construction review
- Quality findings
- Deviations
- Corrective action
- Internal send approval

#### Send

- Sent-to Contact
- Dispatch date
- Courier
- Tracking number
- Expected receipt
- Expected feedback date
- Documents sent

#### Approve

- Customer decision
- Decision Contact
- Decision date
- Comments and annotated files
- Approved/conditional/revision-required state
- Conditions
- Next version
- Final approved reference

### 7.4 Version behavior

- Never overwrite prior specifications, samples, or customer comments.
- Show version comparison.
- Identify the active costable version.
- Show who changed what and why.
- Warn when revising an input already used downstream.

### 7.5 Multi-style behavior

- Bulk assignment of owner or target date
- Shared requirement/document linking
- Per-style readiness
- Journey-level completion summary
- No requirement that every style follows the same result; styles may be approved, pending, or dropped independently

### 7.6 Stage readiness

For each applicable style:

- Specification is stable enough to cost.
- Required sample stage is complete.
- Customer comments are resolved or formally pending.
- Costable/approved version is identified.

### 7.7 Continue action

`Send Costable Styles to Price`

Carry forward exact style versions, consumption/BOM inputs, quantities, customer targets, commission parties, currency, Incoterm, and delivery assumptions.

---

## 8. Stage 4 — Cost & Quote

### 8.1 Purpose

Calculate viable prices, review commercial risk, obtain internal approval, issue quotations, and preserve negotiation history.

### 8.2 Style costing rail

Show per style:

- Latest approved/costable version
- Costing status
- Latest calculated cost
- Customer target
- Proposed price
- Margin, when permitted
- Approval state
- Quote state
- Negotiation state

### 8.3 Pricing substages

`COST → REVIEW → APPROVE → QUOTE → NEGOTIATE`

#### Cost

- Fabric consumption and price
- Wastage/process loss
- Trims/accessories
- Cutting/making/finishing/packing
- Washing, printing, embroidery, and special processes
- Testing and inspection
- Packaging
- Freight/logistics
- Commission
- Overheads
- Financing cost
- Exchange-rate assumption
- MOQ and price breaks

#### Review

- Customer target versus cost
- Comparable historical styles
- Margin
- Commercial risk
- Development/material assumptions
- Quantity sensitivity
- Delivery sensitivity

#### Approve

- Approval threshold
- Approver
- Submitted date
- Approved/rejected/revision-required
- Restricted comments
- Exception reason
- Approval history

#### Quote

- Quote number/version
- Quote-to Account and Contact
- Style and quantity-break prices
- Currency and Incoterm
- Payment terms
- Delivery assumption
- Validity
- Included/excluded charges
- Quotation document preview

#### Negotiate

- Customer counteroffer
- Requested concessions
- Revised quantity/specification
- Revised costing and quote versions
- Approval required
- Accepted/rejected/expired state
- Decision date and Contact

### 8.4 Restricted information

Margin, supplier prices, commission, and approval thresholds must render according to permission. Hidden fields must not be recoverable from client payloads.

### 8.5 Uniform variation

Support a price-list workspace by:

- Garment
- Size band
- Standard/made-to-measure
- Personalization
- Alteration/replacement charge
- Service charge
- Effective period
- Location or contract variation

### 8.6 Stage readiness

- Applicable styles costed
- Internal approval obtained
- Customer price/terms accepted or formal award recorded
- Final costing and quotation versions locked for conversion

### 8.7 Continue action

`Convert to Order/Contract`

Carry forward approved parties, style versions, quantities, prices, terms, destinations, dates, and documents.

---

## 9. Stage 5 — PO/Contract

### 9.1 Purpose

Convert accepted business into a controlled PO, contract, or call-off order and establish an executable baseline.

### 9.2 Left rail

- Customer POs/contracts
- Order lines
- Destinations
- Delivery windows
- Uniform call-offs or issue cycles

### 9.3 Confirmation substages

`VERIFY PO → BREAK DOWN → PLAN → APPROVE FOR PRODUCTION`

#### Verify PO/contract

- Customer PO/contract number
- PO issuer
- Customer
- Bill-to
- Ship-to/consignee
- Buying house/brand
- Approved style/version
- Price/currency
- Payment terms
- Incoterm
- Quantity
- Dates
- Tolerance
- Contract validity

Comparison panel highlights:

- Price mismatch
- Quantity mismatch
- Date mismatch
- Specification/version mismatch
- Commercial-term change
- Missing destination
- Missing document

#### Break down

- Style/color/size quantities
- Destination or PO split
- Packing/assortment
- Delivery window
- Uniform site/department/wearer-batch summary
- Issue cycle where applicable

#### Plan

- Time-and-action milestones
- Planned dates
- Owners
- Dependencies
- Approval deadlines
- Testing/inspection dates
- Ex-factory/shipment/delivery dates

#### Approve for production

- Mandatory checklist
- Missing information
- Approved exceptions
- Exception authority
- Baseline version
- Release decision

### 9.4 Amendment behavior

- Never silently overwrite the confirmed baseline.
- Show amendment number and reason.
- Compare original and proposed values.
- Route required approvals.
- Show downstream impact.
- Preserve accepted history.

### 9.5 Stage readiness

- PO/contract reconciled
- Differences resolved or approved
- Breakdown complete
- Critical path generated
- Mandatory pre-production information available
- Release authorization recorded

### 9.6 Continue action

`Release to Fulfilment`

Carry forward the confirmed Order baseline and time-and-action calendar. Do not convert the Sales Journey itself into the Order record.

---

## 10. Stage 6 — Production

### 10.1 Purpose

Provide connected, customer-facing visibility from material readiness through packed goods without duplicating detailed ERP/MES execution.

### 10.2 Milestone rail

`MATERIALS → PRE-PRODUCTION → CUT → DECORATE → SEW → FINISH → INSPECT → PACK`

Each milestone shows:

- Planned date
- Actual date
- Forecast date
- Owner
- Dependency
- Status
- Risk/blocker
- Evidence/source system

### 10.3 Main workspace sections

#### Critical path

- Planned versus actual
- Current forecast
- Delay reason
- Recovery action
- Customer impact
- Escalation state

#### Approvals

- Lab dip/strike-off
- Fabric/trims
- Artwork/branding
- Fit/size set
- Testing
- Pre-production sample
- Packaging
- Approved exceptions

#### Production visibility

- Planned quantity
- Started quantity
- Completed quantity
- Rejected quantity
- Packed quantity
- Balance
- Latest milestone update
- Source and timestamp

This is summary visibility. Do not recreate workstation, line, payroll, inventory, or procurement execution.

#### Quality

- Inspection type
- AQL/standard
- Result
- Major defect summary
- Corrective action
- Reinspection
- Test-report links

#### Customer commitments

- Last committed date
- Revised date
- Customer notification
- Customer acknowledgement
- Quantity shortfall/excess decision
- Inspection coordination

### 10.4 Uniform variation

Views by:

- Site/location
- Department/job role
- Allocation/wearer batch
- Garment type
- Personalization batch

Personal data must remain permission controlled.

### 10.5 Risk interaction

Users can:

- Mark At Risk, Delayed, or Blocked
- Select reason
- Describe impact
- Assign recovery owner
- Set next review date
- Record revised forecast
- Notify customer or prepare communication
- Close risk with evidence

### 10.6 Stage readiness

- Required quantity packed or partial shipment approved
- Inspection passed or conditionally accepted
- Shipment inputs ready
- Exceptions and shortages explicitly recorded

### 10.7 Continue action

`Prepare Delivery/Shipment`

Carry forward packed quantities, destinations, documents, inspection results, and delivery commitments.

---

## 11. Stage 7 — Shipment

### 11.1 Purpose

Move finished goods from ready-to-dispatch through shipment/delivery and customer-visible commercial closure.

### 11.2 Shipment rail

Each shipment/delivery shows:

- Shipment reference
- Destination
- Quantity
- Mode
- Status
- ETD/ETA
- Document readiness
- Tracking state
- Exception

### 11.3 Delivery substages

`PLAN → BOOK → DISPATCH → TRACK → DELIVER → COMMERCIAL CLOSE`

#### Plan

- Order lines and quantities
- Partial shipment and balance
- Destination
- Consignee
- Cartons/assortments/markings
- Uniform wearer/department/site packing summary

#### Book

- Freight mode
- Forwarder
- Booking reference
- Planned ETD/ETA
- Handover location
- Routing instructions

#### Dispatch

- Actual ex-factory/dispatch date
- Vehicle/vessel/flight
- Dispatched quantities
- Seal/tracking references
- Dispatch evidence
- Customer notification

#### Documents

- Commercial invoice
- Packing list
- Bill of lading/airway bill
- Certificate of origin
- Inspection reports
- Test reports
- Customer-specific documents
- Completeness/approval status

#### Track

- Tracking events
- Current location/status
- Revised ETA
- Delay/exception
- Owner and recovery action
- Customer communication

#### Shipment

- Actual delivery date
- Proof of delivery
- Recipient/site acknowledgement
- Damage/shortage note
- Balance handling

#### Commercial close

Permission controlled:

- Invoice status
- Payment due date
- Paid/part-paid/overdue/disputed
- Deduction/debit note/chargeback/credit note
- Commission status

### 11.4 Stage readiness

- Delivery acknowledged or Incoterm responsibility completed
- Required documents complete
- Invoice/payment state visible
- Exceptions converted to an aftercare case

### 11.5 Continue action

`Close and Grow Account`

Carry forward delivery performance, actual quantity/value, payment visibility, and service issues.

---

## 12. Stage 8 — Retention

### 12.1 Purpose

Turn completed business into learning, issue resolution, repeat orders, replenishment, renewal, and relationship growth.

### 12.2 Left rail

- Complaints/claims
- Alterations/exchanges
- Repeat candidates
- Renewal opportunities
- Replenishment cycles
- Account-growth actions

### 12.3 Main workspace sections

#### Performance review

- Quoted versus ordered value
- Estimated versus actual margin when integrated and authorized
- Sample turnaround
- Approval delays
- On-time ex-factory
- On-time delivery
- Inspection/quality performance
- Claims/service performance
- Payment behavior

#### Complaints and claims

- Related Order/style/shipment/item
- Complaint type/severity
- Evidence
- Customer-requested resolution
- Root cause
- Corrective/preventive action
- Replacement/repair/alteration/credit/rejection
- Closure and customer acceptance

#### Repeat business

- Repeat approved style
- Carry forward approved specification
- Recalculate price
- Create new development
- Reorder reminder
- Dormant-account action

Do not overwrite the completed Journey or historical versions.

#### Uniform aftercare

- Alteration
- Size exchange
- New joiner
- Replacement
- Replenishment
- Next issue cycle
- Contract consumption
- Price review
- Contract renewal

#### Relationship plan

- Customer feedback
- Account-review meeting
- Cross-sell categories
- Next season/tender
- Relationship risk
- Next action, owner, and due date

### 12.4 Completion actions

- Create Repeat Journey
- Create New Development Journey
- Create Uniform Replenishment Cycle
- Start Contract Renewal
- Close Journey

Every new Journey references the completed Journey and reuses approved Account, party, Contact, style, and commercial data without overwriting history.

---

## 13. Shared activities, tasks, comments, approvals, and documents

### 13.1 Activity model in the UI

Activity types:

- Note
- Call
- Email log
- Meeting
- Site visit
- Task
- Follow-up

Every activity shows:

- Type
- Subject
- Author/owner
- Related Contact
- Related Journey/stage
- Optional selected style/order/shipment/case context
- Activity/due date
- Status
- Priority
- Outcome
- Next action
- Visibility

### 13.2 Tasks

Views:

- Upcoming
- Overdue
- Waiting on customer
- Waiting on internal team
- Assigned to me
- Created by me
- Completed

### 13.3 Approvals

Approval cards show:

- Approval type
- Related record and version
- Requester
- Approver
- Submitted date
- Due date
- Decision
- Comments
- Conditions
- Previous decisions

### 13.4 Documents

Document cards show:

- File name/type/size
- Category
- Version
- Related record
- Uploaded by/at
- Approval state
- Access state
- Source/storage state

Prototype UI must not implement insecure uploads.

---

## 14. State language

Use consistent state vocabulary.

### 14.1 Stage state

- Not Started
- In Progress
- Waiting on Customer
- Waiting on Internal Team
- Complete
- Reopened
- Blocked
- Not Applicable

### 14.2 Risk state

- On Track
- At Risk
- Delayed
- Blocked

### 14.3 Approval state

- Not Required
- Draft
- Submitted
- Approved
- Conditionally Approved
- Rejected
- Revision Required
- Expired

### 14.4 Data readiness

- Missing
- Partial
- Ready
- Confirmed
- Superseded

Do not overload one generic status field to represent all these concepts.

---

## 15. Component architecture

Prefer shared components and view models.

### 15.1 Reuse before creation

The following existing components/utilities are the starting point and must be extended rather than replaced:

| Existing file | Required use |
|---|---|
| `components/Sales_DashboardLayout.js` | Wrap every Sales/Journey route and register the Journey Hub navigation item. |
| `components/shell/FrostShell.js` | Continue using the shared top-navigation shell and department guard. |
| `components/ceo/ui/Primitives.tsx` | Reuse established panels, headings, controls, chips, status states, skeletons, and errors. |
| `components/access/useDeptRole.js` | Render permission-aware controls without treating the client as the security boundary. |
| `components/sales/crm/crmShared.js` | Reuse lookups, Account options, commercial visibility, drawers, key/value patterns, and held-write notifications. |
| `components/sales/crm/shell/LifecycleBar.js` | Extend its configuration to the approved stage labels; do not build a second lifecycle bar. |
| `components/sales/crm/shell/WorkspaceHeader.js` | Evolve into or compose the shared Journey header. |
| `components/sales/crm/shell/RailGroup.js` | Reuse for Journey context and activity rails. |
| `lib/crmApi.js` | Use for existing `/api/cms/crm` Account-related operations and approval-aware writes. |
| `app/sales/dashboard/accounts/[id]/_sections/` | Reuse the live Account-stage sections instead of copying their forms and behavior. |

The current `LifecycleBar` still contains the earlier display vocabulary. When frontend implementation is authorized, update its stage configuration to:

`ACCOUNT → ENQUIRY/RFQ → STYLE & SAMPLE → COST & QUOTE → PO/CONTRACT → PRODUCTION → SHIPMENT → RETENTION`

Keep stable internal keys/slugs separate from display labels so a later label change does not break URLs or stored stage codes.

### 15.2 Component placement

Recommended shared components:

- `JourneyHub`
- `JourneyCard`
- `JourneyTable`
- `JourneyWorkspace`
- `JourneyHeader`
- `LifecycleBar`
- `StageStatusBadge`
- `StageChecklistDrawer`
- `ContextRail`
- `ContextRailItem`
- `ActivityRail`
- `ReadinessSummary`
- `RiskBanner`
- `BlockerCard`
- `ApprovalCard`
- `DocumentCard`
- `VersionBadge`
- `VersionHistoryDrawer`
- `ComparisonView`
- `EmptyState`
- `PermissionState`
- `PrototypeDataBanner`

Stage pages should configure the shared shell rather than copy it.

### 15.3 Page composition rule

Each `page.js` should primarily:

1. Resolve the route parameters.
2. Load or request the Journey/stage view model through the adapter.
3. Declare the appropriate `activeMenu` for `Sales_DashboardLayout`.
4. Render loading, error, permission, or stage workspace state.
5. Pass data and capabilities to shared components.

Large forms, tables, timelines, comparison views, and fixture objects belong in components or adapter modules, not directly in route files.

### 15.4 Approval-aware interaction rule

Existing Sales writes can return a held response. Any live Journey action must distinguish:

- **Saved:** the backend committed the change.
- **Submitted for approval:** the backend returned `202`/`held: true`.
- **Preview only:** the prototype action is not persisted.
- **Failed:** a real API error occurred.

These outcomes must never share the same success message or visual state.

---

## 16. Prototype data architecture

Until APIs exist, later-stage UI should use:

- One centralized fixture directory.
- Stable fixture IDs.
- Shared Account/Contact references rather than copied free text.
- Stage-specific view models.
- A small adapter interface matching the shape expected from future APIs.
- Explicit latency/error/empty-state controls for design verification.

Suggested adapter responsibilities:

- Load Journey Hub summaries.
- Load one Journey context.
- Load stage-specific records.
- Return declared capability flags.
- Identify whether a response is live or prototype.

Prototype mutations should either be disabled or clearly labeled as non-persistent preview interactions.

---

## 17. Accessibility and interaction requirements

- Full keyboard navigation for lifecycle bar, rails, forms, tables, drawers, and menus.
- Visible focus states.
- Semantic headings and landmarks.
- Accessible names for icon buttons.
- Status must not rely on color alone.
- Tooltips/popovers accessible by keyboard and screen reader.
- Focus trapped and restored correctly for drawers/dialogs.
- Form errors linked to inputs.
- Tables remain usable at zoom and smaller widths.
- Reduced-motion preferences respected.
- Confirmation required for destructive or history-affecting operations.

---

## 18. Verification checklist

### Global

- [ ] Journey Hub clearly presents operational work by Journey.
- [ ] Sales navigation distinguishes Overview, Journey work, customer libraries, existing operations, and configuration.
- [ ] Accounts are the canonical organization library; the existing Customer-list route is not silently presented as the same record type.
- [ ] Existing Leads and order-customer screens have honest transitional labels until an approved data migration exists.
- [ ] Lifecycle stages appear only inside a Journey and are not duplicated as global navigation tabs.
- [ ] Journey routes consistently highlight the `journeys` active-menu item.
- [ ] Journey and Account breadcrumbs display business references/names instead of raw database IDs.
- [ ] Navigation, page titles, breadcrumbs, lifecycle bar, and actions use the centralized naming configuration.
- [ ] All eight lifecycle stages appear in the correct order.
- [ ] The same Journey context persists across stages.
- [ ] Account, Journey, Order, and fulfilment concepts remain distinct.
- [ ] Global libraries return users to the correct Journey/stage.
- [ ] Prototype data is clearly identified.
- [ ] Unsupported actions do not claim persistence.
- [ ] No invented backend calls are made.

### Shell

- [ ] Persistent header works at desktop, tablet, and mobile widths.
- [ ] Context and activity rails adapt correctly.
- [ ] Lifecycle bar remains reachable and readable.
- [ ] Stage checklist communicates readiness and blockers.
- [ ] Unsaved changes are protected.

### Account

- [ ] Existing live Account workflows remain functional.
- [ ] Garment, compliance, buying-house/brand, and uniform profiles have coherent UI.
- [ ] Contacts, Sites, Departments, Addresses, relationships, team, activities, and audit remain connected.

### Enquiry/RFQ

- [ ] General, RFQ, tender, uniform, repeat, and replenishment variants are represented.
- [ ] Qualification and pursue decisions are clear.

### Style & Sample

- [ ] Multi-style work stays inside one Journey.
- [ ] Version and approval history is visible.

### Cost & Quote

- [ ] Costing, approval, quotation, and negotiation versions are distinct.
- [ ] Restricted commercial information has permission-aware states.

### PO/Contract

- [ ] PO/contract differences and amendments are understandable.
- [ ] The Order remains distinct from the Journey.

### Production

- [ ] The screen provides customer-facing milestones without duplicating ERP/MES execution.
- [ ] Risks and recovery actions are prominent.

### Shipment

- [ ] Partial shipments, documents, tracking, delivery, and commercial visibility are connected.

### Retention

- [ ] Claims, repeat business, uniform aftercare, and renewal preserve historical Journeys.

### Quality

- [ ] Loading, empty, populated, error, read-only, permission-denied, blocked, waiting, and completed states exist.
- [ ] Accessibility checks pass.
- [ ] Frontend lint and production build pass when implementation is authorized.

---

## 19. Explicit exclusions from a frontend-only implementation

- New backend models or APIs
- Database migrations
- Demo-data seeding
- Live email or calendar sending
- Real quotation/order/production/shipment transactions without APIs
- Shop-floor execution
- Inventory/procurement duplication
- Accounting-ledger duplication
- Individual wearer measurements
- Browser-only persistence presented as production data
- Step progression that bypasses real stage gates once backend workflows exist

---

## 20. Handoff expectations

A frontend implementation handoff must record:

- Routes and screens created
- Shared components created or reused
- Live APIs used
- Prototype adapters and fixtures
- Non-persistent interactions
- Required backend contracts per stage
- Responsive and accessibility verification
- Lint/build results
- Known limitations
- Unrelated work preserved
- Confirmation that no unauthorized backend functionality or commit was created
