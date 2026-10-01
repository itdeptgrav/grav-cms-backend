# Slice 2A — Sales-line-to-Production release contract

**Status:** Proposed contract task; not the active `current-task.md` and not authority to add a writer.  
**Owners:** PPC release proposal; Production receipt and WorkOrder authority; Sales and Merchandising source-line review. IE publishes its existing style-scoped release only.  
**Depends on:** A verified checkpoint of the current PPC planning and capacity work, and agreement on the decisions below.

## Outcome

Specify one company-scoped handoff from a booked PPC plan for a **Sales-confirmed permanent order line** to a Production-recognised execution plan. The `CustomerRequest` line's `lineRef` remains `orderLineRef` through Sales handover, Merchandising Execution File, PPC planning/booking, Production receipt and eventual shipment. A style, display name, barcode or WorkOrder number is never used to reconstruct that identity.

This task produces a reviewed contract and decision record. It changes no application writer, current task, WorkOrder, booking, scanner, Firebase record or shipment state.

## Verified starting facts in the local checkout

- `services/sales/merchandisingHandover.service.js` issues a versioned Sales handover from a Sales-confirmed `CustomerRequest` line and publishes its permanent `lineRef`; Sales alone writes that producer record.
- `services/merchandising/planningPublication.service.js` publishes the accepted Execution File's `handoverLineRef` as `orderLineRef` along with `orderRef`, execution-file identity, style and confirmed quantity. PPC reads this contract rather than Sales tables.
- `services/ppc/planningFile.service.js` creates one active planning file for `(companyId, orderLineRef)` and freezes its accepted Merchandising, IE and PPC-receipt basis. `services/ppc/capacityPlanning.service.js` books capacity but explicitly returns `releasesProduction: false` and `createsWorkOrder: false`.
- The IE release is style-scoped; PPC binds it to the Sales line. `models/CMS_Models/Manufacturing/WorkOrder/WorkOrder.js` currently has neither `companyId` nor `orderLineRef`. No WorkOrder join is approved from a matching style or number.
- Legacy device and manual scan paths already exist. This contract must preserve current WorkOrder IDs, operation codes, printed labels, request/response shapes and historical scans.
- Baseline on 21 September 2026: the focused Sales handover, Merchandising Execution File and PPC order-book suites passed 116/116 against the isolated in-memory test database. This proves those separate contracts, not a Production release or shipment.

## Contract questions to settle before Slice 2B writes

1. **Receiver authority:** Does Production create a WorkOrder from a PPC release, bind an existing one, or accept both under distinct proven cases? Recommended direction for review: PPC issues an immutable plan; Production owns its receipt and execution WorkOrder. Do not mark this recommendation approved without PPC and Production agreement.
2. **Company and line proof:** What evidence proves an existing legacy WorkOrder belongs to this company and this permanent Sales line? No inference from style, buyer, work-order number or barcode. Unprovable legacy orders remain readable and explicitly unlinked.
3. **Frozen payload:** Name the exact Sales `orderRef`/`orderLineRef`, confirmed quantity and delivery commitments, Merchandising Execution File and version, IE release and version, PPC planning-file revision, active booking generation, chosen site/line and decision actor. Define which fields are identifiers, immutable snapshots and display labels. The server derives upstream identifiers; the browser cannot substitute them.
4. **Lifecycle:** Define idempotent issue and Production receipt, source-moved refusal, hold after booking, release after hold is lifted, cancellation, replan/successor, partial quantity and an already-started legacy WorkOrder. A capacity-reservation release remains a different verb from release to Production.
5. **Downstream Sales return:** Define the future shipment-to-Sales read contract at the same line identity for shipped and outstanding quantities, including partial and multiple shipments. This task does not implement dispatch or let PPC/Production write Sales records.

## Acceptance evidence for this contract task

- Trace one confirmed Sales line through Sales handover, Merchandising publication, PPC order book, planning file and booking with the **same** permanent line reference and company. Record exact source fields and versions at every edge.
- Show two lines of the same style remain two independent PPC plans and cannot accidentally share a Production receipt merely because they share an IE release.
- Show a Sales cancellation/change, moved IE release, held plan, expired booking, wrong-company target, stale revision and duplicate retry each has an explicit proposed outcome; no silent restamp or second WorkOrder.
- Identify the first Production-owned write and the exact receipt/WorkOrder linking rule, including treatment of unprovable historical orders.
- Record PPC + Production approval of receiver authority and hold-after-booking policy in `docs/decisions/` before any Slice 2B writer work. Update the order-to-shipment roadmap and `current-task.md` only when that later implementation scope is selected.
- Attach a barcode-continuity baseline for current full/short labels, optional deployed suffix, scanner fields `machineId`/`activeOps`, live single/bulk routes and manual completion. This is a comparison gate for the later writer, not permission to alter any of them now.

## Likely code to inspect, not edit in Slice 2A

`models/Customer_Models/CustomerRequest.js`; `services/sales/merchandisingHandover.service.js`; `services/merchandising/execution.service.js`; `services/merchandising/planningPublication.service.js`; `services/industrialEngineering/releasePublication.service.js`; `services/ppc/orderBook.service.js`; `services/ppc/planningFile.service.js`; `services/ppc/capacityPlanning.service.js`; `models/CMS_Models/Manufacturing/WorkOrder/WorkOrder.js`; mounted Production routes in `server.js` and `routes/CMS_Routes/Manufacturing/`.

## Slice 2B gate

Only after the decisions are accepted, give PPC a bounded release-command task and Production a separate receiver/WorkOrder-link task. Do not put Production WorkOrder mutations into IE or PPC receipt code by convenience. The first end-to-end acceptance scenario is one Sales-confirmed line, one accepted IE release, one PPC planning file and booking, one PPC-to-Production issue, one Production receipt, and the unchanged legacy scanner path. Shipment is a later, separately owned gate.
