# Lead to Sales Journey — Chunked Implementation Roadmap

> **Status: SUPERSEDED.** The overall Lead → Sales Journey arc and boundary
> below are still accurate, but the six-chunk numbering in this file
> ("Chunk 1 — Lead foundation", "Chunk 2 — Lead Inbox and quick capture", …)
> has been replaced by a newer product model (Prospect/Active Lead
> terminology, a 5-chunk plan starting with "Prospect capture and setup").
> See `docs/tasks/current-task.md` for the current chunk list and status —
> that file is authoritative now, not the chunk breakdown below.
>
> **Rule:** Implement and review one chunk at a time. Do not begin the next chunk automatically.

## Boundary

```text
LEAD
Find → Capture → Contact → Qualify → Ready to Convert
                                      │
                                      ▼
CONVERSION BRIDGE
Match/Create Account → Match/Create Contact → Create Journey
                                      │
                                      ▼
SALES JOURNEY
Account → Enquiry/RFQ → Style & Sample → Cost & Quote →
PO/Contract → Production → Shipment → Retention
```

### Lead owns

- Lead source and campaign/provenance.
- Unverified person and company information.
- Initial requirement summary.
- Initial quantity, timing and value estimates.
- Qualification checklist and outcome.
- Contact attempts and follow-up tasks.
- Assigned salesperson.
- Nurture, disqualification, duplicate or conversion outcome.
- Links to the resulting Account, Contact and Sales Journey.

### Lead does not own

- Detailed Enquiry/RFQ records.
- Style or sample versions.
- Costings or quotations.
- Commercial negotiation history.
- PO/contract or Order records.
- Production, quality, shipment or delivery records.
- Won revenue merely because a Lead was converted.

### Journey owns

- One qualified customer requirement moving through the approved lifecycle.
- Current lifecycle stage and stage states.
- Commercial context, risk, ownership and target dates.
- References to Enquiry, style/sample, quote, Order, production and shipment records when those modules exist.

The Journey references the source Lead. It does not copy the Lead into another editable lead record.

## Chunk sequence

### Chunk 1 — Lead foundation and boundary hardening

Backend/data-contract work only:

- Establish the canonical pre-Journey Lead states.
- Preserve legacy records without offering overlapping legacy stages for new work.
- Replace unsafe Lead reference generation.
- Add audit metadata and conversion-link placeholders.
- Extend CRM Activity safely for pre-Account Lead activity.
- Harden Lead API validation, permissions and audit.
- Do not create Accounts, Contacts or Journeys yet.

Task: `docs/tasks/lead-chunk-01-foundation.md`

### Chunk 2 — Lead Inbox and quick capture

- Redesign `/sales/dashboard/leads` as a focused Lead Inbox.
- Minimal Add Lead flow.
- My Leads/Team scope.
- Search, source, owner, qualification-state and follow-up filters.
- Next action and overdue visibility.
- No conversion yet.

### Chunk 3 — Lead detail and qualification workspace

- Lead identity and requirement summary.
- Qualification checklist.
- Shared CRM Activity timeline, tasks and follow-ups.
- Ready-to-Convert gate.
- Nurture/disqualify/duplicate outcomes.
- No Account or Journey creation yet.

### Chunk 4 — Duplicate and Account/Contact matching

- Search and rank possible Account matches.
- Search Contacts under a selected Account.
- Show why a match is suggested.
- Select existing or prepare a new Account/Contact draft.
- No conversion commit yet.

### Chunk 5 — Idempotent Lead conversion bridge

- Link or create Account.
- Link or create Contact.
- Create one Sales Journey with `sourceLeadId`.
- Link resulting IDs back to Lead.
- Create/retain next Activity.
- Mark Lead Converted.
- Handle approval-held and partial failure without duplicates.
- Open the Journey at Account.

### Chunk 6 — Legacy transition and navigation cleanup

- Rename `Leads (Existing)` to `Leads` only after the new flow is verified.
- Hide proposal, negotiation and won from new Lead UI.
- Keep legacy stages/history readable.
- Remove obsolete embedded-activity writes after compatibility is confirmed.
- Update reporting so Lead conversion and Journey outcomes are separate metrics.

### Later — Enquiry/RFQ

Only after Chunk 6 is accepted should the real Enquiry/RFQ module begin.

## Review gate after every chunk

Before starting the next chunk, Codex reviews:

- Git diff and uncommitted-work preservation.
- Lead/Journey boundary compliance.
- Backward compatibility.
- Data duplication risks.
- Permissions and audit.
- Tests and handoff.
- Confirmation that the following chunk did not begin.
