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
