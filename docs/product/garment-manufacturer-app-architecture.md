# GRAV Garment Manufacturer App Architecture

**Decision date:** 7 September 2026  
**Status:** Product direction

## Purpose

GRAV should be organised around the operating flow of a professional garment
manufacturer. An app represents a stable area of responsibility, not every
department name or factory section. Closely connected teams may work in
separate role-controlled workspaces inside one app, while each business fact
still has one authoritative owner.

The design principle is:

> One fact has one owning app. Other apps receive only the approved information
> or status they need to perform their own work.

The company flow is:

`Sales → Merchandising → R&D → IE → PPC → Purchase / Store → Production → Quality → Logistics → Accounts & Finance`

Board & Executive controls company policy and monitors performance. Maintenance
keeps equipment available. HR & Compliance supports the workforce.

## Recommended core apps

### 1. Board & Executive

Owns company-wide decisions and management control:

- Profit and margin policies
- Labour and overhead policies
- Credit and approval limits
- Budget policies
- Capital expenditure approvals
- Company targets
- Cross-department risk monitoring
- Final escalations
- Effective-dated policy approval and supersession

Board & Executive does not manage individual styles, orders or departmental
forms.

**Built so far:** the effective-dated policy lifecycle
(`DRAFT → BOARD_APPROVED → EFFECTIVE → SUPERSEDED`) and the first policy on
it — the **financing methodology**: the annual rate, the costing subtotal it
applies to, whether the customer's advance reduces the financed amount, and
the day-count convention. Central Costing combines that approved decision with
the payment terms Sales confirms on each order; it holds no financing rate of
its own and offers no way to enter one.

The app is at **`/board`**, with the financing policy at
`/board/dashboard/policies/financing`. Decision record:
`docs/decisions/board-policy-lifecycle.md`.

### The name, and the access row, are two different things

**The app is Board & Executive.** That is its name in this document, its
address, its chrome, its navigation and its switcher tile. It is not a section
of the CEO dashboard, and it is not called Management — an earlier revision of
this document renamed app 1 to "Management" while the financing policy was
being built, and that rename is reverted here on the product owner's explicit
decision. Every other edit made in that revision is preserved.

**Its access grant is still `ceo`.** `services/access/hrAccess.js` and
`services/access/fulfilmentAccess.js` have both declared
`BOARD_DEPT_SLUGS = new Set(["ceo"])` since before this app existed, so `ceo`
is the repository's genuine board-level boundary today. A `board` slug would
need an `AccessDepartment` row seeded before anybody could be granted it — so
the app would be unreachable by everyone rather than restricted to the Board —
and it would leave two access rows meaning one thing, of which the one nobody
maintains is the one a guard happens to read.

Keeping the two apart is deliberate, and it is what went wrong the first time:
the financing screen was filed under `/ceo/dashboard/policies` because the
`ceo` grant admitted the right people, and a decision about ACCESS settled the
app's IDENTITY by accident. When a real `board` grant is seeded, two constants
change — `guardSlug` in `components/Board_DashboardLayout.js` and
`BOARD_DEPT_SLUG` in `services/board/boardAccess.js`, with `BOARD_VIA_SLUG` in
`components/shell/boardApp.js` for the switcher — and no route moves, no
bookmark breaks and no chrome is renamed.

Every other company policy — profit and margin, overhead, labour methodology,
GST treatment, development charges — is still a mutable field on
`CostingPolicy` with no draft, no approval and no history. Each is its own
migration onto this lifecycle.

### 2. Sales

Owns the external customer relationship and commercial process:

- Leads and opportunities
- Customers and contacts
- Enquiries and RFQs
- Commercial quotations
- Negotiation
- Payment and delivery terms
- Customer PO and contract acceptance
- Buyer communication
- Customer approvals and rejections
- Retention and repeat business

Sales sends a controlled requirement brief to Merchandising. Merchandising
does not receive a duplicate Sales pipeline or Journey.

### 3. Merchandising

Owns internal coordination of a confirmed buyer requirement:

- Style execution brief
- Fabric, trim and accessory selection
- Packaging selection
- Development and tooling requirements
- Sample coordination
- Internal department follow-up
- Follow-up on buyer decisions recorded by Sales
- Time-and-Action coordination
- Material-readiness monitoring
- Production-readiness monitoring
- Style and order change coordination

Merchandising does not own customers, quotations, negotiation, supplier rates,
technical consumption, production planning or company costing policy.

### 4. R&D

Combines R&D, technical development, pattern/CAD and sample-room work around
one style-development record:

- Technical specification and tech pack
- Measurement and size chart
- Pattern and CAD
- Marker development
- Material consumption
- Sample requests and sample-room execution
- Fit and wash observations
- Technical revisions
- Pre-production sample preparation
- Packed weight and carton-capacity facts

Pattern/CAD and Sample Room can later become separate workspaces without
creating duplicate style data.

### 5. IE

Industrial Engineering owns manufacturing methods and standards:

- Operation bulletin
- Route and operation sequence
- SAM/SMV
- Machine requirement
- Manpower requirement
- Method study
- Line layout
- Capacity standards
- Line balancing
- Production targets

IE publishes an approved route, standard time and capacity standard. It does
not book orders onto factory capacity or execute production.

### 6. PPC

Production Planning and Control owns production plans and capacity commitments:

- Order loading
- Factory and line allocation
- Capacity booking
- Cutting, sewing and finishing plans
- Material-required dates
- Production calendar
- Plan-versus-actual monitoring
- Delay recovery plans

PPC consumes the approved IE route and standard time. It does not redefine
them.

### 7. Purchase

Owns sourcing and purchasing rather than physical stock custody:

- Supplier discovery and approval
- Material and service sourcing
- Supplier quotations
- Lead times
- Country of origin
- Purchase requisitions
- Purchase orders
- Service and job-work orders
- Supplier follow-up
- Supplier performance
- Subcontract coordination

### 8. Store

Owns physical custody and movement of materials and finished goods:

- Fabric store
- Trims, accessories and packing-material stores
- Finished-goods warehouse
- Goods receipt
- Inspection handoff
- Lot, roll and shade records
- Putaway
- Stock reservations
- Material issues and returns
- Stock counts
- Shortages
- Location transfers

Store does not negotiate suppliers or design the garment BOM.

### 9. Production

One execution app with workspaces for:

- Cutting
- Numbering and bundling
- Sewing
- Washing
- Printing
- Embroidery
- Finishing
- Ironing
- Folding and packing
- Production-floor scanning
- WIP tracking
- Output and rejection
- Rework
- Shift handover

Production executes the approved IE route and PPC plan. Cutting, Sewing,
Finishing and Packing are workspaces, not separate apps.

### 10. Quality

Quality remains independent from Production and owns:

- Fabric and trim inspection
- Cutting quality
- Inline and end-line inspection
- Finishing inspection
- Measurement audits
- AQL and final inspection
- Defect classification
- Non-conformance records
- Rework verification
- Hold and release decisions
- Customer claims investigation

Production may request an inspection, but it cannot approve its own output.

### 11. Maintenance

Owns factory equipment availability:

- Machine register
- Attachments and tooling
- Preventive maintenance
- Breakdown tickets
- Spare parts
- Calibration
- Utility equipment
- Machine availability
- Maintenance history
- Downtime causes

For a smaller factory this may initially be a Production workspace, while its
ownership remains separate.

### 12. Logistics

Owns physical and documentary shipment execution:

- Shipment planning
- Packing lists
- Cartonisation
- Dispatch
- Transport coordination
- Freight documents
- Export and customs documentation
- Shipment milestones
- Proof of dispatch and delivery
- Customer-return receipt

It consumes the confirmed delivery terms owned by Sales.

### 13. Accounts & Finance

Owns financial truth:

- Chart of accounts
- Budgets
- Purchase accounting
- Supplier payables
- Customer receivables
- Sundry debtors and creditors
- Sales invoices
- Payments and receipts
- Banking
- Tax
- Payroll accounting
- Fixed assets
- Actual order cost
- Variance analysis
- Profitability reporting

Costing remains a shared calculation, validation, versioning and audit engine.
Employees do not work inside a standalone Costing app. Accounts & Finance,
Sales and Board & Executive receive only the outputs permitted for their
responsibilities.

**Nobody types a cost into Costing (7 Sep 2026).** An engine that accepts a
typed figure is not an engine; it is a spreadsheet with an audit trail. Every
material rate, service rate, freight rate, quantity, cost line and policy value
is read from the record of the department that owns it, and the last path that
allowed otherwise — the *provisional override* — is retired at the request
contract and again at the assembly.

When a source fact is missing, the calculation stays **blocked** and names three
things: the missing fact, the department that owns it, and the record they keep
it in. A missing fact never becomes a costing line. This is what makes Costing
an invisible engine rather than a screen people fill in, and it is the condition
on which the "no standalone Costing app" decision below actually holds — a
workspace with a blank rate box is a place people go to work.

Costings frozen before this rule keep their provisional inputs, their
attribution and their labels, and go on reading exactly as written. Retiring
creation does not authorise rewriting the record.

See `docs/decisions/central-costing-technical-source-semantics.md` for the
refusal contract and the source-authority table it rests on.

### 14. HR & Compliance

Owns the workforce and statutory operating environment:

- Employee records
- Attendance and shifts
- Leave
- Payroll inputs
- Recruitment
- Skill matrix
- Training
- Contractor labour
- Social compliance
- Health and safety
- Audit documentation
- Licences and statutory records

This is required operationally but can follow after the core manufacturing
flow is stable.

## Apps not to create separately yet

- No standalone Costing app
- No Customer app outside Sales
- No separate BOM app
- No separate Packaging app
- No separate Cutting, Sewing or Finishing apps
- No separate Sample app outside R&D
- No separate Procurement and Sourcing apps initially
- No supplier or customer portal yet

These are workspaces or modules inside the owning app. They may be separated
later only when company scale, independent ownership or operational volume
makes that separation useful.

## Implementation priority

The first complete manufacturing rollout should focus on:

1. Sales
2. Merchandising
3. R&D
4. IE
5. PPC
6. Purchase
7. Store
8. Production
9. Quality
10. Logistics
11. Accounts & Finance

Board & Executive supplies policy and oversight across this flow. Maintenance
and HR
& Compliance can be expanded after
the primary order-to-shipment workflow is coherent.
