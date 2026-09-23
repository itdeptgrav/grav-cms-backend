# Garment order-to-shipment: sequential delivery roadmap

**Status:** Reviewed against both 21 September 2026 working trees and committed PPC branches; conditional roadmap, not a deployment assertion. This review changed documentation only. Do not overwrite `current-task.md` until a slice is explicitly made active.

**Product contract:** [`../product/garment-order-to-shipment-plan.md`](../product/garment-order-to-shipment-plan.md). Read it with the existing Sales, Merchandising, Store/Purchase, IE/PPC, Project Manager, Quality and Finance plans. Existing approved decisions take precedence over examples in the supplied PDF and workbook. Surface conflicts to Codex for a product decision before changing source ownership.

## How to work this roadmap

Give Claude Code **one numbered slice at a time**. For each slice, have it first inspect current writers, readers, route mounts, records and tests; state the exact reuse/migration choice; implement backend source truth and authorization before UI/export; test the business invariant; then send Codex the Git diff and verification results for review. Keep a slice's scope to its named output. A report-only slice may be implemented as a read projection over existing records; do not add a model simply because the paper template has a field.

Each slice is done only when: company scoping and role permissions pass; source IDs and versions are traceable; missing data is not represented as zero/pass; retry and correction behavior is specified; UI and export agree with the saved record; relevant API and calculation tests pass; one realistic order has been walked through; and the Git diff has been reviewed. Broad end-to-end tests are reserved for integration slices and the release gate.

### Priorities

- **P0 safety and spine:** G03 is the first application-code slice, after its narrow read-only closing-path inventory from G00. The remaining G00 field matrix, G01 identity contract and G02 Sales confirmation work then precede new cross-app reports. G17 completes the closing dossier after its source evidence exists.
- **P1 core domestic bulk path:** G04–G16. Deliver in dependency order below.
- **P1 rollout control:** Begin G18's compatibility/shadow checks with the first new writer and finish its release reconciliation after G17. E-way reference/document status in G16 is P1 when applicable.
- **P2 optional integration:** G19 provider/export automation only after the core path and its rollout evidence are stable.

### Verified baseline: reuse before adding records

This is a code inventory, not proof of live data or deployed routes. The backend and frontend main working trees are dirty. On 21 September, PPC Order Book, Planning File and Capacity code was selectively applied from the committed PPC branches to the current working trees, with the required PPM publication and route mounts; it is **uncommitted**, not a Git merge or deployment. Focused PPC and PPM tests pass, but verify a committed checkpoint and authenticated workflow before treating it as a release prerequisite.

| Slice | What exists; implement only the gap |
| --- | --- |
| G00 | `CustomerRequest.items[].lineRef`, Sales handover versions, WorkOrders, GRNs, QC scans, challans and finance documents exist, but no audited single-order trace connects all of them. Inventory every writer, especially legacy dispatch. |
| G01 | Sales already mints an order-line ref; `Enquiry.products[].productLineRef` is a **different pre-order identity**. Scope this slice to missing bridges and an additive projection contract, not new order/line IDs. |
| G02 | The current frontend has an Order Confirmation workspace; PO upload/payment gate, `CustomerRequest` lines and versioned Sales handover already exist in code. Verify actual PO comparison and saved version before adding only the missing signed report/requirement snapshot; this is not a deployment claim. |
| G03 | `closingVerdictForJourney` returns `null` on missing links/errors and `salesJourneyProgress` permits `close` without a verdict. Its current `paid` check also derives an invoice-like amount from a quotation/CustomerRequest and its cost check from WorkOrder issue fields. Fix absence **and** refuse unsupported pass claims; this is not a new closing workflow. |
| G04 | R&D consumption and `orderDemandRelease.service` connect a confirmed line + approved costing version to procurement demand. **Corrected by G00 (`g00-source-inventory.md` §0.6, B7):** the Merchandising approved selection is **not** read by the release — demand comes from the costing version's frozen requirement, and `DemandRelease` stores no execution-file or selection id. Decide whether the approved selection must gate or feed release before proving reconciliation. Do not duplicate the BOM editor or release command; prove downstream PO/WorkOrder reconciliation. |
| G05 | Store has GoodsReceipt, GoodsReceiptInspection, GoodsReceiptDisposition and Putaway records. Determine roll/shade/length and report gaps without replacing its received/accepted/quarantined/rejected ledger. |
| G06 | Store inspection currently makes one immutable quantity decision per receipt. Specialist Quality four-point evidence is missing; first define how a later Quality decision affects Store's existing disposition without rewriting it. |
| G07 | Account buyer defaults already include testing protocol; no dedicated order/lot lab-result authority was established. Add only after applicability and Quality authority are decided. |
| G08 | `SampleStyle` has sample rounds and a Sales customer-approval log; R&D technical record exists. PP report must cite the exact round and buyer decision rather than create a second sample workflow. |
| G09 | `WorkOrder.planningState` and PM release semantics are approved; PPC order-book/planning/capacity code is now in the current working trees but uncommitted and explicitly returns `releasesProduction: false`. PPC Lane B's `5f7d15e` booking/replan fence was included. The Sales-owned permanent `CustomerRequest.items[].lineRef` already reaches Merchandising and PPC as `orderLineRef`, but `WorkOrder` has no company or order-line field. A committed integration checkpoint, release authority, WorkOrder company/line proof and the hold-after-booking capacity policy remain open. |
| G10 | `CuttingMasterRecord` stores employee/day/work-order cut sessions, not lay/roll/consumption reconciliation. Extend source evidence, preserving those existing sessions. |
| G11 | `ProductionSchedule` exists; PPC branch adds planning lines/calendar and IE has released standards. No verified physical Production line master or actual labour-minute denominator exists. Decide identity and denominator before a factory-efficiency claim. |
| G12 | `DefectRecord` already stores piece, stage, defect, reject and rework evidence. Prove inspected-unit denominator and line/shift attribution before deriving DHU. |
| G13 | The mounted device route writes `ProductionTracking`; the mounted manual `production-completion/mark-done` route writes `ProductionCompletionScanRecord` and explicitly does **not** update WorkOrder or `EmployeeProductionProgress` at that point. Legacy `markAsDoneRoutes.js` exists but is not mounted by `server.js` in this checkout. Reconcile the active paths and downstream sync/packaging before designating any one ledger or hourly accepted count as authoritative; do not add a parallel actuals counter. |
| G14 | Stage QC exists, but no approved final AQL sampling-plan authority was found. Do not infer a pass from workbook defect totals. |
| G15 | Packaging/dispatch views and WorkOrder packaged counts exist; no canonical carton/content/shipment identity was established. The checked-out access registry has Packaging & Dispatch, not a Logistics grant. Reconcile legacy writers and settle the target boundary before new cartonization. |
| G16 | Bulk/person-wise `DispatchChallan` and multiple dispatch writers exist. Accounts already has e-way-bill preflight/JSON export and voucher transport details. Integrate those authorities through the chosen Packaging & Dispatch/Logistics transition; do not build a second dispatch or e-way generator. |
| G17 | Sales already has `closingReport`, and Central Costing has a versioned production closeout/material-actual service. Enrich from these and Finance's actual invoice/receipt, not the legacy report's client-side estimate join or quotation-as-invoice fallback. |
| G18–G19 | Run per-slice compatibility/shadow checks from the first writer change, not only after G17. Provider automation remains optional and requires a separate current-law/provider decision. |

## Wave A — establish the order spine and prevent false close

### G00 — Source inventory and sample-order trace

**Owner:** Codex specification; Claude Code read-only inventory. **Depends on:** nothing.

- **Before G03**, do a short read-only trace of the close transition, verdict, CustomerRequest link and company proof; record the distinct missing, legacy and dependency-error cases. Do not wait for the full field matrix to fix a confirmed fail-open close.
- Then trace one real or safely anonymized Sales-confirmed order from `SalesJourney`/`CustomerRequest` line to Merchandising file, approved selection, IE/PPC plan (only if the separate branches have been integrated), PO/GRN, work order, cutting, QC, packing, challan, invoice and closing view. Record missing, ambiguous and duplicate links without editing live data.
- Inventory all active writers and readers for order line, work-order status, dispatch quantity and closing state. Include legacy and new UI paths, background scan sync and imports.
- Produce a source-to-report field matrix for the PDF's report formats and all three workbook sheets: present, derivable, missing, ambiguous, and owner. Choose a representative domestic bulk scenario and one partial/failed scenario for later acceptance.

**Gate A, before G03:** a read-only close-path trace names the existing link and failure cases, including direct API close with no linked request, a downstream record from another company, a dependency error, and a quotation without an invoice. Record the exact mounted route and current tests; do not change application code. **Full G00 exit, before G01:** an evidence-backed inventory and link diagram; each missing field has a proposed owner, not a speculative new collection. No app mutation.

### G01 — Canonical identity, terminology and availability contract

**Owner:** Sales for order line; shared read contract for downstream. **Depends on:** G00.

- Freeze the distinct names `Order Confirmation Report`, `Order Closing Report`, `Material Receiving Report`, `Daily Production Report`. Remove ambiguous standalone OCR/DPR labels from new APIs/UI/export names; preserve old route compatibility.
- Preserve `CustomerRequest.items[].lineRef` → `SalesHandoverVersion.handoverLineRef` as the confirmed-order spine. Keep the distinct pre-order `Enquiry.products[].productLineRef` and its explicit adoption bridge. Specify the missing PPC/WorkOrder, Quality, packing, dispatch and Finance links; do not issue replacement IDs or infer a link by display name.
- Define shared source-reference envelope and `ready/blocked/not_applicable/unknown` availability vocabulary for new projections. Add contract tests for wrong company, stale/superseded version, duplicate line and missing link.

**Exit:** One exact identity and status contract adopted by the next slices, with no new order master.

### G02 — Sales order confirmation and buyer requirement snapshot

**Owner:** Sales. **Depends on:** G01.

- Audit the **live** `OrderConfirmationWorkspace`, PO upload/payment gate, `CustomerRequest` line and Sales handover version before adding any writer. Extend only missing server-owned comparison fields, order-specific buyer requirement snapshots and authorized discrepancy resolution.
- Assemble a read-only Order Confirmation Report from the issued Sales state with dynamic sizes (not fixed S–XXL). Verify which fields are frozen by the handover and which are only current mutable UI data; do not label a mutable view a signed version. Sales owns sign-off and successor issuance.
- Hand over only the allowlisted operational requirement to Merchandising. Preserve commercial confidentiality in the existing handover schema.

**Exit:** One confirmed and one mismatched PO can be reviewed; mismatch blocks issue until resolved; exported confirmation exactly matches the issued version and size totals.

### G03 — Reliable closing verdict before expanding closure content

**Owner:** Sales stage transition. **Depends on:** the narrow G00 closing-path inventory; **does not wait for G01 or a new Finance/Logistics integration**. This is the first application-code task.

- Change `closingVerdictForJourney`/`salesJourneyProgress` so **missing verdict, failed dependency and `canClose:false` all refuse a new close**. The current planner only refuses `canClose:false` when a verdict exists. Do not add a generic legacy bypass; if one is required, specify an exact server-verified record cohort, authority, reason and durable audit for product-owner approval before enabling it.
- Prove the linked CustomerRequest and any WorkOrder/challan data belong to the acting company. The current verdict scopes the enquiry but reads the downstream IDs without independent ownership proof.
- Do not certify `paid` from a quotation/CustomerRequest total or `actual cost complete` from a positive WorkOrder issued quantity. If the existing route cannot prove a required Finance/Store source, return an explicit unavailable blocker. Keep G03 to safety and honest status; G17 owns the richer Finance/production reconciliation and the final commercial-close policy.
- Make report availability and the exact blocking source visible to the user. Do not invent invoice/payment or production quantities.
- Test direct API close, missing enquiry link, cross-company link, unavailable dependency, incomplete dispatch and quotation-without-invoice; old completed journeys stay readable. An exception route is tested only if its separately approved policy exists.

**Exit:** A direct API call cannot close a current order by causing the verdict query to return `null` or throw, or by substituting a quotation for an invoice; a forged foreign-company link leaks no closing facts. Historical already-closed journeys remain readable. No unapproved generic legacy bypass is introduced.

## Wave B — material and pre-production evidence

### G04 — Approved BOM and demand-to-purchase trace

**Owner:** Merchandising for selection, R&D for consumption, Purchase for PO. **Depends on:** G02.

- Audit and extend the existing `orderDemandRelease.service` chain from confirmed `CustomerRequest.items[].lineRef` and approved costing/BOM to SpendRequest and supplier PO lines; bridge the missing WorkOrder demand references through stable IDs.
- Reconcile quantity/UoM at each boundary. Show missing approved selection, consumption, supplier rate or PO as separate blockers.
- Reuse Merchandising development BOM, execution selection, R&D technical revision and Store/Purchase documents. Do not add a second BOM editor **or another confirmed-order demand-release command**.

**Exit:** A material on one order line can be traced from approved selection to purchased quantity, with revisions and shortages visible.

### G05 — Roll/lot-aware GRN and material receiving report

**Owner:** Store. **Depends on:** G04.

- First map existing GoodsReceipt → immutable GoodsReceiptInspection → disposition/putaway and the supplier PO. Capture only missing challan/date/UoM/roll/lot/shade/length fields at the correct grain; do not overwrite the existing accepted/quarantined/rejected classifications.
- Produce the Material/Trim Receiving Report from those records; show shortage/excess and delay with explicit date basis. Keep supplier PO and GRN identity separate.
- Ensure quarantined/rejected stock is not available to reservation/issue.

**Exit:** Partial and repeat receipts reconcile to the supplier PO; a rejected line does not increase usable stock; report totals match GRN and inspection.

### G06 — Fabric four-point and shade inspection

**Owner:** Quality decision; Store custody. **Depends on:** G05 and the fabric policy decision in the product plan.

- Add specialist inspection evidence per GRN roll/lot: sample selection/coverage, area and UoM conversion, individual defects and point rules, points per 100 sq yd, shade observations, policy version and pass/hold/fail with reviewer.
- Design a Quality-owned decision/event that Store consumes to move or keep a roll's disposition. Store's present inspection is one immutable quantity decision per receipt, so a late Quality failure cannot be implemented by editing that decision or pretending a score is a GRN quantity check.
- Provide a Fabric Inspection Report and corrections/reinspection history. Thresholds and sampling are configurable approved policy, not hard-coded PDF examples.

**Exit:** The score independently recalculates; a failed/held roll cannot be issued as approved fabric; repeat submission does not duplicate disposition.

### G07 — Fabric lab testing and applicability

**Owner:** Quality with R&D technical context. **Depends on:** G06 and buyer test-policy decision.

- Define order/lot/style test requirement from the approved buyer/spec version; capture request, laboratory, sample, method, shrinkage/fastness results with units, tolerances, certificate and reviewer.
- Record `not_applicable` with authority and reason. Late or failed results hold the dependent release; retests retain the first outcome.

**Exit:** Release shows exactly which approved test version it used; a missing required certificate is never shown as passed.

### G08 — PP sample and buyer-approval report

**Owner:** R&D sample facts; Sales buyer decision; Merchandising coordination. **Depends on:** G02 and G04; can start while G05–G07 are underway if no shared code is touched.

- Start from the existing `SampleStyle` sample-round ladder, R&D technical revision and Sales buyer-decision log. Link the exact PP round to tech pack/spec, measurements and tolerances, material/trim revisions, construction findings and submitted date; add only facts they do not already hold.
- Sales records buyer approval, approval with comments, or rejection against the exact sample version. Generate the PP Sample Report from those source records.
- Revised sample round preserves rejected history and cannot inherit a prior buyer approval silently.

**Exit:** A PP rejection blocks production readiness until a new approved round or recorded authorized exception exists.

### G09 — PP meeting, readiness and PPC release

**Owner:** PPC planning/production-release proposal; source approvals remain with their departments. **Depends on:** G04, G07 where required, G08, a committed and verified checkpoint of the applied PPC planning/capacity code including the `5f7d15e` fence, the PPC-to-WorkOrder authority decision, and the hold-after-booking capacity policy.

- Define a signed meeting record and action list referencing approved Sales, Merchandising, R&D, IE, material/test and capacity versions. Show each readiness fact and its owner.
- PPC's current working-tree code owns a planning file and capacity booking but explicitly **does not release Production**. First trace one Sales-confirmed line through its Sales handover, Merchandising Execution File and PPC plan/booking; retain its permanent `orderLineRef` and frozen source versions. Decide Production's company/line proof and the authority bridge to existing `WorkOrder.planningState` and exact IE route/SAM before adding a writer; do not mint a second release merely to satisfy the meeting template.
- Follow the approved PM lifecycle decision: scanner and manual-mark starts without release remain recorded exceptions in the first rollout. Any later hard gate on those writers needs a separate operational decision and compatibility proof. Preserve existing vendor and barcode behavior.

**Exit:** Meeting minutes cannot mark Quality or Sales approved by proxy; any bridged release names its source versions; first scan and manual start retain the approved exception semantics until an explicit enforcement rollout.

## Wave C — production and quality actuals

### G10 — Cutting and material-use report

**Owner:** Production/Cutting; Store issue/return remains authoritative. **Depends on:** G05 and G09.

- Preserve existing employee/day `CuttingMasterRecord` work-order sessions. Add the missing lay, fabric roll/lot, layers, planned/actual consumption with units, good/rejected pieces by size, waste/reason and panel/bundle handoff only after deciding their event grain and avoiding duplicate cut counts.
- Build Cutting Report from cut events plus Store material movements. Keep measurement/person-wise and bulk workflows compatible.
- Check issue = used + waste + return + documented variance at lot/UoM grain; prevent double counting on replay.

**Exit:** Cut totals match work-order size plan or show a named exception; fabric variance is explainable, not a single manually typed percentage.

### G11 — Line, shift and target standard

**Owner:** PPC target; IE standard; HR attendance if used; Production actual line assignment. **Depends on:** G09 and IE/PPC efficiency decision.

- Map existing ProductionSchedule and the PPC branch's planning-line/calendar register to the actual floor assignment. Define line/shift/day/style allocation and target revision only after deciding whether the PPC line is a physical line identity or a provisional planning reference; preserve multiple styles per line and overnight shifts.
- Specify two separate metrics: target achievement = accepted output / planned target; true labour efficiency = earned standard minutes / actual available labour minutes. Define denominator provenance, breaks, rework and zero/missing handling.
- Expose an exact calculation contract before the DPR screen. Do not relabel the workbook's produced/target formula as factory efficiency.

**Exit:** Independent sample calculations agree with API output for a normal, multi-style and missing-denominator shift.

### G12 — Inline QC, DHU and rework handoff

**Owner:** Quality. **Depends on:** G09; its aggregate feeds G13.

- Reuse `DefectRecord` stage-aware piece inspections, defect taxonomy and rework rounds; determine whether line/shift and inspected-unit population can be proved from each scan. Do not derive a line DHU from defect rows alone.
- Standardize DHU numerator as individual defects and denominator as inspected units; distinguish defect rate, reject rate and rework. Link every reworked piece to its reinspection outcome.
- Publish read-only aggregates and hold/release events to Production/PPC/Logistics.

**Exit:** A garment with multiple defects produces the right DHU; failed/reworked/rejected counts reconcile and cannot become shippable merely through a production scan.

### G13 — Daily Production Report

**Owner:** Production. **Depends on:** G10, G11 and G12, plus a verified active scan/manual/packaging source-of-truth map and replay policy.

- First map the mounted device scan route, mounted manual completion-log route, production sync, WorkOrder completion snapshots and packaging-time employee-progress updates. These are not proved to be one shared ledger; do not use the unmounted legacy `markAsDoneRoutes.js` as an active writer. Define which event means hourly *accepted* output and how repeat/offline scans and later packaging are deduplicated. Then assemble the report, with controlled corrections carrying reason, actor and original event link. Show target, shortfall, shift, supervisor, manpower basis and cumulative accepted production.
- Pull reject/rework and DHU from Quality, labelled with freshness and coverage; never ask Production to re-enter Quality's verdict.
- Add prepared/checked/approved workflow if the operational owner requires it, with versioned printable and spreadsheet views matching the workbook's intent.

**Exit:** Hourly rows sum to the daily and cumulative totals without counting a piece twice; target achievement and true efficiency are labelled separately; Quality outage yields unknown Quality fields.

### G14 — Final AQL inspection and release

**Owner:** independent Quality. **Depends on:** G12 and approved final-sampling policy.

- Define offered lot/cartons, population, sampling standard/edition, inspection level, severity-specific AQL, approved sample size and acceptance/rejection numbers. Preserve buyer-specific requirements and selected-carton evidence.
- Capture measured findings and critical/major/minor defect counts, pass/fail/hold/reinspection and independent approval. Generate the Final Inspection Report; do not derive pass from the workbook's total alone.
- Bind release to exact inspected units/lot and prevent substitution after approval.

**Exit:** A failed/held lot cannot pass the dispatch gate; a reinspection is a new linked decision; two different buyer policies can yield different verdicts on the same counts.

## Wave D — shipment, finance and closure

### G15 — Cartonization and packing list

**Owner:** Production for packed actuals, target Logistics for shipment carton record. **Depends on:** G13 and G14, plus the Packaging & Dispatch/Logistics authority decision.

- Reconcile existing packaged-unit projections and bulk/person-wise dispatch writers first. Then give cartons stable IDs and contents by style/colour/size/order line; link packed piece IDs or a controlled aggregate basis, labels, marks and measured weights if applicable.
- Build a shipment-specific Packing List. Partial and multiple shipments each own their cartons; neither can reuse an already-dispatched carton.
- Reconcile packed = released and assigned to shipment + remaining, with exceptions shown.

**Exit:** A carton scanned twice or assigned to two shipments is refused; packing-list totals match carton detail and Quality release.

### G16 — Challan, shipment and document pack

**Owner:** Target Logistics (or the existing Packaging & Dispatch boundary during an approved transition); Finance owns invoice. **Depends on:** G15, applicable document-policy decision and the shipment authority decision.

- Inventory and reconcile **all** bulk, person-wise, PM manual-mark and Packaging/Dispatch writers before choosing the canonical shipment event. Extend the existing challan path with ship-to, carton count, style/colour/size totals, transport/vehicle, shipment ID and document references without rewriting historic challans.
- Reuse Accounts' existing e-way-bill preflight/JSON export and voucher transport details. Logistics tracks shipment applicability and the externally issued reference/evidence; Accounts retains statutory preparation. For exports, track the configured document set. Link Finance's actual invoice, not the quotation or CustomerRequest grand total, and do not author financial truth inside Logistics.
- Record dispatch, proof of delivery or transfer-of-responsibility event under the agreed delivery terms; make partial shipment and outstanding quantity visible to Sales.

**Exit:** Shipment, challan, packing list, e-way/export references and invoice reconcile by the same shipment; a missing required document blocks dispatch or records an authorized exception.

### G17 — Full Order Closing Report and close policy

**Owner:** Sales close decision; Finance financial truth; other owners supply evidence. **Depends on:** G03, G10, G12, G13, G14, G16 and the commercial-close policy decision.

- Expand the existing Sales closing report, using the G03 fail-closed verdict, to reconcile accepted vs manufactured/QC-released/packed/dispatched/delivered quantities, fabric utilization, rejects, final invoice, payment/receivable position and estimated vs actual costs with source availability. Reuse Central Costing's production closeout for material/output actuals and approved costing versions for estimates. The legacy Sales report's client-side CoWork estimate, WorkOrder unit-cost arithmetic and quotation-as-invoice fallback are not authoritative substitutes.
- Define `operationally complete`, `delivered`, `invoiced`, `financially settled` and `closed` separately. Under an approved policy, a valid not-yet-due receivable may coexist with closed fulfilment; it must remain visible as open money, not be marked paid.
- Retain a reviewer decision, unresolved-exception register, correction path and lessons. Closing must use the G03 server-side verdict, not a disabled button or fuzzy customer-name match.

**Exit:** Four cases are proved: complete/settled, complete/valid receivable, short/held, and missing source. Only policy-eligible cases close, and each decision explains the source data it used.

## Wave E — rollout, optional automation and scale

### G18 — Historical compatibility and phased rollout

**Owner:** cross-app delivery. **Depends on:** G17.

- Start compatibility/shadow checks with the **first new writer**, not only after G17. Here consolidate legacy records per company and field coverage. Preview any link/backfill with counts for matched, ambiguous, missing and impossible. Do not fabricate old inspections, approvals, carton IDs or invoice payments.
- Run the new reporting path in read-only/shadow mode for representative orders, compare source totals, and activate per company/site with a rollback flag. Preserve legacy URLs, PDFs and customer visibility until consumers are migrated.
- Verify role access, performance, pagination, logging, alerts and retry behavior on the actual order volume.

**Exit:** A signed reconciliation of at least one full bulk order, one uniform/person-wise order, one partial order, and one held/reworked order. No unexplained quantity or money variance.

### G19 — Optional provider and export integrations

**Owner:** Logistics/Finance integration, separately approved. **Depends on:** G16 and G18.

- If the business wants automated e-way bill generation or export filings, verify current legal requirements, provider contract, credentials, error/retry/cancellation and document retention before integration.
- Add integration behind the existing document-status record; do not let provider failure rewrite dispatched or invoiced facts. Prove round trip in a provider sandbox and define operational fallback.

**Exit:** Provider-specific contract and live/sandbox evidence are reviewed separately. Manual external reference remains usable.

## Release gate for the full program

Use one end-to-end acceptance workbook outside the application to record evidence, not to become another source of truth. For each scenario, compare the buyer-confirmed quantity to work orders, cutting good/reject, line accepted/rework, Quality release, cartons, shipments, challans and closing; compare selected BOM/demand to PO, GRN, accepted lot, issue, return and actual consumption; compare quotation/costing version to invoice and actual-cost availability. Include an unavailable dependency, wrong-company ID, duplicate API retry, late correction, PO amendment, sample rejection, failed fabric roll, failed AQL lot, partial receipt and partial dispatch. Each failed case must show an honest blocker and retain earlier history.

Codex reviews each slice's specification/diff and updates this roadmap's status only from verified evidence. Do not mark a wave complete because its screens exist.
