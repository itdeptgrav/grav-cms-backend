# Garment order-to-shipment: product and evidence plan

**Status:** Reviewed against the 21 September 2026 working trees and the committed PPC planning/capacity branches. Proposed product contract, not an implementation or deployment claim. This review changed documentation only; it did not activate a roadmap slice.

**Sources:** `Garment-Order-Process Format.pdf` (five pages) and `Production Reports.xlsx` (DPR, OCR, Final Inspection Report), supplied by the product owner; current GRAV frontend and backend; `garment-manufacturer-app-architecture.md`; `merchandising-app-final-plan.md`; `connected-lifecycle.md`; `store-purchase-professionalization.md`; `project-manager-professionalization.md`; ADR-001 and ADR-003. The attachments are business references, not instructions to override approved GRAV ownership or existing records.

**Execution roadmap:** [`../tasks/garment-order-to-shipment-roadmap.md`](../tasks/garment-order-to-shipment-roadmap.md). This plan does not replace `../tasks/current-task.md`; activate one roadmap slice explicitly when ready.

## 1. Outcome and scope

For any confirmed order line, a permitted user can trace the buyer's accepted requirement through material selection, sourcing, receipt, technical and sample approvals, PPC release, cutting, sewing, quality, packing, shipment and commercial closure. Each report is generated from the department's source records, identifies its source versions, and distinguishes a missing fact from a zero or a pass.

The proposed first complete path is one domestic bulk garment order with one style and one delivery commitment, including partial material receipt, one production line, a failed inspection and rework, a partial dispatch, final dispatch and closing. The model must support multiple styles, colour/size splits, delivery drops, sites, outsourced steps and export documents without creating a parallel order master. Uniform/person-wise dispatch remains supported as an existing variation; whether it receives the full new reports in the first rollout remains a product decision (§8).

The PDF is a list of common stages, not a command to make all 24 compulsory in one fixed order. GRAV also has **pre-order development**: Sales requests development; Merchandising approves material selection; R&D measures consumption and makes samples; Costing calculates; Sales may then receive and confirm a PO. For repeat orders, approved development can be reused with a version reference. The confirmed-order path starts when Sales accepts the buyer commitment and issues its controlled handover.

## 2. Vocabulary and record grain

| Term | Meaning and owner |
| --- | --- |
| Buyer PO | External customer's purchase order; Sales records its number, date, file, parties, commercial terms and acceptance decision. |
| Order Confirmation Report | Sales-owned confirmation of the accepted buyer commitment, including order-line/style/colour/size quantities, price, delivery and versions. The workbook calls this **OCR**. Use the full name in GRAV. |
| Order Closing Report | Derived, reviewable closure dossier assembled from source departments after fulfilment. The PDF calls this **OCR**. Use the full name in GRAV. |
| Material Receiving Report | Store/Purchase receipt and inspection view. The PDF calls this **DPR**, meaning daily/detail purchase receiving. Use the full name. |
| Daily Production Report | Production-owned line/shift/day output and exceptions. The workbook and PDF also call this **DPR**. Use the full name. |
| Manufacturing order | Existing Sales-approved `CustomerRequest` projection, per the Project Manager plan; do not invent a second master. |
| Work order | Existing product/variant execution record; preserve its link to the customer request and the confirmed Sales line. |

The **target** linking key is company + Sales order/request ID + immutable Sales line reference. `CustomerRequest.items[].lineRef` and `SalesHandoverVersion.handoverLineRef` already provide the first bridge; Development uses the distinct pre-order `Enquiry.products[].productLineRef`. The remaining WorkOrder, material lot/roll, carton, shipment and invoice bridges are **not proved end-to-end** and must be inventoried before a shared envelope or report is implemented. Names and PO numbers are searchable snapshots, not join keys. New source references should carry ID, source type, version/revision where available, company proof, event time and current/superseded state; do not imply legacy records already carry all of them.

## 3. Ownership contract

| Fact | Authoritative owner | Consumers |
| --- | --- | --- |
| Buyer identity, contacts, PO, price, delivery/payment terms, buyer approval | Sales | Merchandising, PPC, Logistics, Finance, read-only as permitted |
| Approved fabric/trim/packaging identity, execution coordination, TNA | Merchandising | R&D, Purchase, Store, PPC, Quality, Logistics |
| Tech pack, measurements, size chart, pattern, consumption, sample construction/test observations | R&D/Product Development | Merchandising, Costing, PPC, Quality |
| Route, SAM/SMV, method and capacity standard | IE | PPC, Production, Costing |
| Line allocation, production dates, targets and release | PPC | Production, Merchandising, Sales status |
| Supplier, quote, supplier PO and follow-up | Purchase/Store & Purchase boundary | Store, Finance, Merchandising status |
| GRN, lot/roll, receipt inspection disposition, stock, issue/return | Store for custody; Quality for specialist fabric/test decisions | PPC, Production, Costing, Finance |
| Cutting, sewing, washing if applicable, finishing, packing actuals | Production | PPC, Quality, Logistics, Sales status |
| Defects, rework verification, fabric/trim inspection verdict, lab result, final AQL release | Quality | Store, Production, Logistics, Merchandising |
| Cartons, shipment, delivery challan, transport and export document status | Logistics; transitional existing Packaging & Dispatch routes may implement it | Sales, Finance, customer visibility |
| Invoice, receipt, payable, actual costs and settlement | Accounts & Finance | Sales and closing dossier, subject to permissions |

Reports and dashboards are projections of these facts. An approval from another department is a source-linked read, never an editable copied checkbox. Cross-app handovers carry an allowlisted versioned projection and acknowledgement. This preserves the existing Sales-to-Merchandising and Merchandising-to-PPC designs. **Logistics is a target owner, not an existing grant/app boundary in the checked-out code:** the current access registry has `packaging-dispatch` but no `logistics` slug, and the frontend has a Packaging & Dispatch app. G15–G16 must choose whether to extend that boundary with shipment responsibility or establish a separate Logistics grant/app, without creating two dispatch authorities.

## 4. Coverage of the 24 source stages

**Status meanings:** Foundation = relevant source records/routes exist; Partial = an adjacent workflow exists but the specified evidence is incomplete; New = no equivalent dedicated record was established by the code review. These are source-review findings, not live deployment claims.

| PDF stage | Owner and canonical evidence | Current assessment / planned addition |
| --- | --- | --- |
| 1 Order booking | Sales buyer PO, accepted commercial line | Foundation; generate a distinct confirmation view and preserve PO reconciliation. |
| 2 Buyer setup | Sales Account/Contact and order-specific approved tech/quality/packing references | Partial; `CRMAccount.garmentSalesProfile` already stores buyer defaults including inspection/AQL, testing and packing references. Snapshot applicable requirements on the order; do not add another buyer master. |
| 3 Costing | Central Costing version linked to order/style | Foundation; require approved source-backed version at commercial release and actual-cost feedback at close. |
| 4 TNA | Merchandising versioned plan | Foundation; connect source-owned milestone actuals and exception alerts. |
| 5 BOM | Merchandising approved identity + R&D technical consumption + confirmed-order demand | Approved selection, R&D consumption and confirmed-order demand release each exist, but **G00 found the release does not consume the approved selection**: demand is derived from the Central Costing version's requirement, and the release records no selection or execution-file id (`../tasks/g00-source-inventory.md` B7). The gap is that missing connection and a trace from those exact versions through Purchase/Store and WorkOrder quantities — not a second BOM or demand-release command. |
| 6 Sourcing | Purchase supplier PO lines | Foundation; link demand, approved selection and supplier order line. |
| 7 Fabric inward | Store GRN and lot/roll | Partial; GRN, inspection, disposition and putaway already separate received from usable stock. Verify whether roll, shade and length are captured at the required grain before extending these paths. |
| 8 Fabric inspection | Quality inspection of received roll/lot, disposition to Store | New specialist four-point/shade evidence; do not replace GRN quantity disposition. |
| 9 Fabric lab test | Quality/R&D test request and approved result | New structured method/result/evidence/approval and applicability rule. |
| 10 Trim receiving | Store GRN/inspection | Partial; report ordered/received/accepted/rejected, shortage/excess and dates. |
| 11 Sample development | R&D sample rounds; Sales buyer response | Partial; `SampleStyle` already has sample rounds and a buyer-decision log. Reuse them and add only missing PP-specific measurement, construction and immutable version evidence/reporting. |
| 12 PP meeting | PPC/Production readiness meeting with accountable approvals | New controlled record or signed attachment linked to order and open actions. |
| 13 Job/work order | Existing manufacturing/work orders | Partial; WorkOrder has a separate `planningState` decision and legacy execution writers. PPC planning/capacity code is present in the current working trees after a selective, uncommitted integration, but explicitly does **not** release Production. A PPC-to-WorkOrder authority bridge and rollout decision precede any new hard gate. |
| 14 Cutting | Production cut/lay record | Partial; lay/layers, planned vs actual fabric use, wastage and line issue required. |
| 15 Sewing DPR | Production line/shift/day actuals from reconciled scans, manual completion logs and authorized corrections | Partial; the mounted device-scan and manual `production-completion/mark-done` paths are separate, and the latter logs scans without updating WorkOrder/employee progress directly. A single authoritative hourly actual and sign-off are not yet proved. |
| 16 Inline QC/DHU | Quality stage inspections and derived defects per hundred units | Partial; piece/stage defect and rework evidence exists, but line/shift population, coverage and a consistently defined DHU denominator require proof before using it in DPR. |
| 17 Washing | Production routing step only when approved route requires it | Partial; typed lot/quantity/result and external-service reference when outsourced. |
| 18 Finishing | Production operation/scan and quantity | Partial; distinct output/rework/handoff when required by route. |
| 19 Final inspection | Quality lot and AQL decision | Partial QC foundation; new sampling plan, lot, severity counts, disposition and release authority. |
| 20 Packing | Production packing events + Logistics cartonization | Partial; carton-level packing list and reconciliation. |
| 21 Delivery challan | Logistics dispatch record | Partial; transport, ship-to, carton and linked shipment fields. |
| 22 E-way bill | Accounts statutory preparation/export; Logistics shipment reference | Accounts already has e-way-bill preflight/JSON export and saved transport details on vouchers. Reuse it; add only the verified shipment/invoice/reference bridge and externally issued status/attachment if absent. Provider generation remains a separate decision. |
| 23 Shipment/invoice | Logistics shipment events; Finance invoice | Partial; explicit shipment-to-challan-to-invoice links and delivery proof. |
| 24 Closing | Derived closing dossier and authorized close decision | Existing Sales closing report and verdict are **unsafe as a certification gate**: absent/failed verdict permits direct API close, while its paid/cost checks can use quotation and WorkOrder issue fields rather than authoritative invoice/actual-cost proof. Repair the fail-open and unsupported-pass paths first; later enrich the dossier from authoritative sources. |

## 5. Report contracts

All report outputs show company/site, canonical order line and style version, applicable date/shift/lot, report number/version, source IDs, created by/at, checked/approved by/at where required, corrections/history, status and an explicit data-availability state. Printable PDF and spreadsheet exports are views of the same saved facts, not another place to enter them. A later edit makes a revision or correcting event; a signed report is not silently rewritten.

| Output | Minimum source-backed content and control |
| --- | --- |
| Order Confirmation Report | Buyer and parties, accepted PO and quotation/version comparison, style/colour/size quantities and value, delivery, fabric/trim/packing references, exceptions and Sales sign-off. The workbook's fixed S–XXL rows become a dynamic size breakdown. |
| Fabric Inspection Report | GRN/roll/lot and supplier; received and inspected length/area/UoM; sampling basis; defect positions, lengths and four-point scores; calculated points/100 sq yd with an explicit conversion basis; shade-band observations; configurable approved pass/hold/fail policy and independent Quality approval. The PDF's “10%” and “28” are examples, not global rules. |
| Material/Trim Receiving Report | PO line, vendor, expected/actual date, ordered/received/accepted/quarantined/rejected quantities in the same UoM, shortage/excess, reasons, receiver and supplier document. Reconcile to GRN and inspection; do not use the acronym DPR in navigation. |
| PP Sample Report | Sample round/version, material/trim revisions, specification vs measured values with tolerances, construction findings, submission, Sales-owned buyer feedback/approval, approval date and evidence. Rejected rounds remain readable. |
| PP Meeting Minutes | Attendees and roles, approved input versions, material/quality/IE/PPC readiness, decisions, blockers, owners, due dates and signed release or refusal. A meeting alone cannot override failed source gates. |
| Job Order / Work Order | Existing work-order identity and ordered size breakdown, allocated/issued material links, approved IE route and PPC plan/line, dates, cutting and special instructions, revision and release state. |
| Cutting Report | Cut event/lay, fabric lot and issued quantity, planned/actual consumption in compatible units, layer count, size-wise good/rejected cut pieces, wastage and reason, bundle/panel transfer to line. Reconcile issue + return + waste + consumption. |
| Daily Production Report | Company/site, production date, shift, line, style/order/work-order, supervisor, manpower basis, hourly target and accepted output, rejected/rework counts sourced from Quality, cumulative accepted output, shortfall reason, notes and sign-off. The workbook's `IFERROR(produced/target,0)` is labelled **target achievement**, not labour efficiency; its cached zero is not operational evidence. True efficiency is a separate measure using released IE standard minutes and actual available labour minutes, with its formula shown. No target or denominator means unavailable, not 0%. |
| Final Inspection Report | Offered lot/cartons and size/colour population, buyer-required inspection standard/version, inspection level/AQL by severity, sample-selection evidence, sample size and acceptance/rejection numbers from an approved sampling plan, observed critical/major/minor defects, measurement results, pass/fail/hold/reinspect verdict and independent inspector/approver. The workbook's defect totals alone cannot establish AQL pass. |
| Packing List | Shipment/drop, carton IDs, carton contents by style/colour/size, gross/net weight when measured, marks, total pieces, and reconciliation to final released/packed units. |
| Delivery Challan | Unique challan linked to shipment and order, ship-to, carton count, style/size/colour quantities, dispatch date, vehicle/transporter, e-way reference when applicable, receiver and evidence. Existing person-wise and bulk variants remain supported. |
| E-way Bill / export pack | Applicability decision and reason, externally issued bill number, issue/validity dates, invoice, parties, HSN, transporter and vehicle, verified attachment/status. For export, configured document checklist may include commercial invoice, packing list, COO, GSP and transport document. Exact legal rules and automated generation require a separate current-law and provider review. |
| Order Closing Report | Accepted order vs cut/produced/QC-cleared/packed/dispatched/delivered by line/drop; shortages/excess and authorized tolerance; fabric issued/returned/consumed/waste; defects/rejections and open holds; costing version vs actual material/labour/service/freight when priced; invoice and settlement/exception state; delivery proof; unresolved claims; reviewer decision and lessons. Missing inputs stay visible and block a claim of complete reconciliation. |

## 6. Lifecycle gates and exceptions

1. **Confirm:** Sales validates the buyer PO against the accepted quotation and approved style/version, resolves mismatches, and issues a versioned handover. A missing buyer approval is not inferred from an uploaded file.
2. **Plan:** Merchandising approves required selections and TNA; R&D supplies technical consumption and sample status; IE supplies approved route/standard; PPC records line/capacity decision. A release names every version it consumed.
3. **Receive:** Store records each physical receipt; specialist Quality decisions bind to its GRN/lot/roll. Quarantined/rejected quantities never appear as available merely because a GRN exists.
4. **Start production:** PPC/Production receives an explicit readiness verdict and exceptions. The approved WorkOrder lifecycle decision currently preserves scanner and manual-mark starts even without release, recording `productionStartedWithoutRelease` rather than blocking them in its first rollout. Do not silently replace that approved policy with a hard gate; settle the PPC-to-WorkOrder release authority and operational rollout first.
5. **Pack and dispatch (target):** Only QC-released units should enter dispatchable stock. Existing dispatch writers do not yet prove this invariant. Partial shipment stays partial, with remaining order quantity retained. Introduce a canonical shipment/carton link only after the existing bulk, person-wise and challan writers are reconciled.
6. **Close:** Compute the verdict on the server from exact company-scoped source links. Unavailable verdict, unresolved mandatory hold, or absent required evidence must not be presented as a pass. Authorized exceptions need reason, actor, timestamp, scope and later review; “payment outstanding” may be a permitted commercial-close variation only under explicit Finance/Sales policy, rather than an accidental missing-data bypass.

Every gate returns `ready`, `blocked`, `not_applicable` or `unknown`, plus source references and reasons. `unknown` is never coerced to `ready`. Late, duplicate, revised, cancelled, partially completed and offline/replayed events require idempotent commands and auditable correction. No downstream consumer may approve the fact it merely reads.

## 7. Cross-cutting acceptance

- Company/site scope is derived on the server for every read/write; record IDs from another company disclose nothing.
- Every order-line quantity reconciles across accepted order, work orders, cutting, QC release, packing and dispatch, with labelled scrap/rework/returns and allowed partials. Unit conversions are explicit.
- Every material quantity reconciles across PO, receipt, inspection, putaway, reservation, issue, return and consumption at item/variant/lot/UoM grain.
- Reports show provenance and freshness. Missing, stale, conflicting and unpriced source data remain visible; no guessed zeros, rates, timestamps or decisions.
- Buyers' quality, test, packing and export requirements are order-specific snapshots of the approved customer requirement, with a source version and an explicit not-applicable decision where appropriate.
- Roles separate creator, checker, approver and source owner. High-risk approvals and overrides have independent reviewer authority.
- Historical orders remain readable. Migration is previewed, counted by status and company, reversible where possible, and does not fabricate past approval or test results.
- APIs, PDFs, spreadsheet exports and the UI reconcile on one representative order, a partial order, a failed inspection/rework case, and an order with missing evidence.

## 8. Decisions to settle before their dependent slices

1. Which buyer/order types require physical fabric four-point inspection and lab tests; what sampling policy, scoring conversion and approval authority apply? Store/Quality must agree on their handoff.
2. Which released IE/PPC data defines line targets and available minutes for factory efficiency? Confirm shift/break and multi-style-line treatment with IE, PPC and Production.
3. Which final-inspection standard and sampling tables are licensed/approved for use, and how do buyer-specific critical/major/minor AQL levels and reinspections work? Quality must own this before an automatic verdict ships.
4. Who owns the PP meeting release and who may sign exceptions? PPC, Production, R&D, Merchandising and Quality must agree.
5. What does “commercially closed” mean when delivery is complete but a valid receivable is not yet due? Sales and Finance must choose the policy; do not silently force “paid in full” or permit an unknown verdict.
6. Which domestic/export document sets apply by transaction, and whether GRAV only records externally generated e-way bills or will integrate a licensed provider later? Logistics and Finance must confirm.
7. Which system makes an existing `WorkOrder.planningState` release effective after PPC plans an order? The PPC branches explicitly stop short of releasing Production, while the approved PM lifecycle still owns a release transition and permits observable unreleased starts. Decide the handover/authority and rollout with PPC, PM and Production before G09.
8. Is PPC's new planning-line register the durable physical line identity, or a provisional allocation reference until Production supplies a line master? The capacity branch found no physical-line master; do not report a PPC planning line as measured floor assignment without this decision.
9. For the first operational rollout, is the representative path a domestic bulk order, with person-wise/uniform dispatch retained as compatibility, or must both receive identical new reporting in the first release? The current dispatch data has materially different grains.
10. When PPC puts a **previously booked** Planning File on hold, does its capacity remain reserved until an explicit release/replan, or should hold initiate a controlled release? The race fix correctly serializes a concurrent booking and hold, but a hold after booking still leaves an active booking marked as moved. Decide the operational policy before using booked capacity as a firm production commitment.
11. Should shipment/carton ownership stay in the existing **Packaging & Dispatch** app/grant for the first release, or move through an explicitly planned transition to a separate **Logistics** app/grant? The architecture names Logistics as the enduring owner, but neither a Logistics grant nor app exists in the current checkouts. Choose one write authority and migration boundary before G15–G16.

The inspection, target, release, close and document decisions gate **their dependent commands**, not source inventory or honest read-only projections. The first release must also account for repository state: PPC planning/capacity code, including Lane B's `5f7d15e` booking/replan fence, was selectively applied to the current backend/frontend working trees on 21 September. That is uncommitted source integration, not a branch merge or deployment, and it does not authorize Production release. No roadmap slice may assume those routes are deployed until a checkpoint and authenticated workflow are verified.
