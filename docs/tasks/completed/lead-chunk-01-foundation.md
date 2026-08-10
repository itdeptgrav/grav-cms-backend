> **Status:** Active
>
> **Current chunk:** Lead Chunk 1 — Foundation and Boundary Hardening
>
> **Implementation repository:** `/Users/risheeray/grav-cms-backend` (backend only — no frontend work in this chunk)
>
> **Instruction:** Implement and verify only Lead Chunk 1. Do not begin Chunk 2. Do not implement Lead conversion (Account/Contact/Journey creation) in this chunk. Do not modify Sales Journey behavior, its model, its API, or any Sales Journey frontend UI.
>
> **Source document:** This file is a copy of `docs/tasks/lead-chunk-01-foundation.md`, which remains the detailed source of record for this chunk and must not be deleted or treated as superseded by this copy.
>
> **Roadmap:** `docs/tasks/lead-to-journey-roadmap.md` — the rule there applies: implement and review one chunk at a time, do not begin the next chunk automatically.

# Lead Chunk 01 — Foundation and Boundary Hardening

> **Status:** Ready for implementation
>
> **Repository:** `/Users/risheeray/grav-cms-backend`
>
> **Scope:** Backend Lead and shared Activity foundation only
>
> **Do not begin:** Lead Inbox redesign, qualification UI, matching, conversion, Account creation, Contact creation, Journey creation, or Enquiry/RFQ

## 1. Objective

Make the existing Lead backend a safe pre-Journey foundation while preserving all existing records and integrations.

This chunk must remove architectural ambiguity without implementing conversion. At completion, the backend should have a clear canonical Lead state vocabulary, safe references, shared Activity support, validation, permissions and audit hooks that later chunks can use.

## 2. Existing problems to address

The existing `Lead` model currently:

- Uses `countDocuments() + 1` for `LEAD-xxxx` references.
- Offers `proposal_sent`, `negotiation` and `won`, overlapping the Sales Journey lifecycle.
- Treats `won` as customer conversion without creating/linking the new CRM Account and Sales Journey architecture.
- References a legacy `Customer` through `convertedCustomerId`.
- Embeds its own activity subdocuments, duplicating the shared `CRMActivity` architecture.
- Accepts broad request bodies with insufficient field-level ownership.
- Does not consistently use the Step-01 audit conventions.

## 3. Canonical Lead states

New Lead work must use:

```text
new
contacted
qualified
readyToConvert
nurture
disqualified
duplicate
converted
```

Display labels:

```text
New
Contacted
Qualified
Ready to Convert
Nurture
Disqualified
Duplicate
Converted
```

### Backward compatibility

Existing values such as `proposal_sent`, `negotiation`, `won` and `lost` must remain readable and queryable. Do not run a migration and do not destructively rewrite them.

The canonical create/update/stage APIs must reject new attempts to assign overlapping legacy stages unless an explicitly documented compatibility path requires them. Future UI must not offer them.

If modifying the existing `stage` enum creates unacceptable compatibility risk, introduce a clearly named canonical qualification-state field and document the relationship to legacy `stage`. Do not leave two independently editable state machines.

## 4. Model changes

Extend `models/CMS_Models/Sales/Lead.js` using existing CRM conventions.

### Required concepts

- Immutable, safely generated human `leadId`.
- Canonical qualification state.
- Requirement-received timestamp or equivalent qualification evidence where justified.
- `createdBy`, `updatedBy`, archive actors and timestamps consistent with CRM models.
- Conversion outcome placeholders:
  - Resulting `CRMAccount` reference.
  - Resulting `CRMContact` reference.
  - Resulting `SalesJourney` reference.
  - Converted timestamp and actor.
- Conversion state must remain unset in this chunk; no conversion endpoint is implemented.

Preserve legacy fields such as `convertedCustomerId` for reading. Mark them clearly as legacy and do not write them from new canonical flows.

### Reference generation

Replace `countDocuments() + 1` with the atomic, per-year sequence approach already proven by the Sales Journey foundation, producing references such as:

```text
LEAD-2026-0001
```

Do not modify the Sales Journey generator while doing this. A small shared sequence primitive is acceptable only if it preserves the already-verified Journey behaviour and is covered by regression tests; otherwise implement a Lead-specific allocator using the same atomic pattern.

### Indexes

Add only indexes justified by Lead Inbox/qualification access patterns:

- Human reference.
- Active/archive state plus owner and updated date.
- Canonical state.
- Normalized company/contact search fields if the existing query requires them.
- Next follow-up date.
- Resulting Account/Journey references.

Avoid speculative indexes for later Journey stages.

## 5. Shared CRM Activity support for Leads

New Lead calls, notes, meetings, tasks and follow-ups must use `CRMActivity`, not append new embedded Lead activity subdocuments.

The existing `CRMActivity.accountId` is required, but a valid Lead may not have an Account yet. Extend the model safely so an Activity may belong to:

- An Account; or
- A pre-Account Lead.

Preferred direction:

- Reuse the existing forward-link architecture or add the smallest explicit Lead reference consistent with repository query patterns.
- Enforce that an Activity has a valid owning context; do not permit orphan activities.
- Preserve all existing Account Activity behaviour.
- Add indexes required to retrieve a Lead's Activity timeline and due tasks.

Legacy `lead.activities[]` remains readable in this chunk. Stop adding new entries to it through canonical Lead endpoints. Do not migrate or delete it.

Do not modify the separate Call Planner workflow beyond the minimum compatibility required to prevent it from writing new embedded activity duplicates. If changing that integration is not safe in this chunk, document it as a blocker for Chunk 3 rather than silently maintaining two timelines.

## 6. Lead API hardening

Work within:

`routes/CMS_Routes/Sales/leads.js`

Required:

- Preserve list, create, detail, update, state transition and archive capabilities needed by existing callers.
- Whitelist client-editable fields.
- Server-assign Lead reference and audit actors.
- Validate canonical state transitions.
- Require a reason for disqualified and duplicate outcomes where appropriate.
- Do not treat `converted` as a simple state patch; reserve it for the later conversion service.
- Do not set probability to 100 or mark a sale won merely because a Lead is qualified or ready to convert.
- Use the existing Sales authentication/write-approval conventions.
- Invoke `recordChange(...)` for successful mutations.
- Return purpose-built, backward-compatible response contracts.
- Avoid returning unrestricted raw documents when restricted/internal fields are introduced.

### Activity endpoints

Canonical new Lead activity creation/listing should use `CRMActivity` and the shared response conventions. It may be implemented within the Lead router or composed from the existing Activity service/router, whichever avoids duplication.

Do not implement Account/Contact/Journey conversion endpoints in this chunk.

## 7. Duplicate foundations

This chunk may add normalized fields or reusable duplicate-query helpers needed later, but it must not implement the matching UI or make automatic merge decisions.

At minimum, preserve enough normalized information to later compare:

- Company name.
- Email/domain.
- Phone/WhatsApp.
- Website.

Do not automatically create or merge Accounts.

## 8. No Lead/Journey overlap

This chunk must not add or persist:

- Quotation/proposal versions.
- Negotiation rounds.
- Won revenue.
- Style/sample data.
- Order/PO details.
- Production or shipment states.
- Sales Journey lifecycle stages on Lead.
- Account, Contact or Journey creation side effects.

The Sales Journey model, API, Progress Spine and stage pages should remain functionally unchanged.

## 9. Verification

Add focused tests using the repository's existing CRM Jest setup.

Required coverage:

- Concurrent Lead reference allocation without collisions.
- Per-year reference sequence.
- Reference immutability.
- Canonical state validation and transitions.
- Overlapping legacy states cannot be assigned through new canonical writes.
- Existing legacy-state records remain readable.
- Converted cannot be set through an ordinary state patch.
- Audit actors are server-controlled.
- Editable-field whitelist blocks system/conversion fields.
- Account Activity regression.
- Pre-Account Lead Activity creation and retrieval.
- Orphan Activity rejection.
- New Lead activity does not append to legacy embedded activities.
- Existing embedded activities remain readable.
- Authentication and approval-aware write behaviour.

Run only focused CRM tests. Do not run migrations or seeds.

## 10. Acceptance criteria

- New Leads receive safe `LEAD-YYYY-NNNN` references.
- Canonical Lead states stop at Ready to Convert/Converted and do not include commercial proposal or negotiation.
- Legacy Lead records remain readable without migration.
- Converted cannot be faked through a generic patch.
- New Lead interactions use shared CRM Activity records.
- Existing Account activities continue working.
- Successful Lead mutations are audited.
- No Account, Contact or Journey is created.
- No Sales Journey code or UI is functionally changed.
- No Lead frontend redesign is started.
- No dependencies, migrations, seeds or Git settings are changed.
- Unrelated and uncommitted work is preserved.
- Nothing is committed.

## 11. Handoff

Update `docs/handoff/latest-implementation.md` with:

- Model changes and backward-compatibility strategy.
- Canonical versus legacy state behaviour.
- Reference generator implementation.
- CRM Activity ownership changes.
- API validation, permission and audit changes.
- Files changed.
- Focused tests and exact results.
- Known integration limitations, especially Call Planner.
- Confirmation that Chunk 2 and conversion were not started.
- Commit status.

---

## Closing note — Chunk 1 complete, archived

Approved and archived. Backend foundation (safe `LEAD-YYYY-NNNN` refs,
canonical `qualificationState` with an explicit transition graph shared by
every write path including Call Planner, hardened Activity ownership) is
live in `grav-cms-backend`. Full implementation record:
`docs/handoff/latest-implementation.md`, Part 1. Chunk 2 (Lead Inbox) is now
the active task — see `docs/tasks/current-task.md`.
