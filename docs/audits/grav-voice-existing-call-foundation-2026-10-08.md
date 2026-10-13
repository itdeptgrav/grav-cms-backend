# GRAV Voice Existing Call Foundation Audit

**Audit date:** 8 October 2026  
**Purpose:** Identify what the recorded call bridge can safely reuse.

## Reusable foundation

- `CallEvent` is already the repository's accepted single history for answered,
  missed, rejected and recorded calls.
- The Sales call-log UI already renders call direction, outcome, employee
  attribution, authenticated audio playback, transcript and summary.
- `SalesPerson` already snapshots each selected employee's corporate work
  number, which is the correct agent-leg source.
- CRM routes already match call events to customer phone identities.
- Existing media upload and authenticated playback can be reused after a
  provider recording is copied into GRAV-controlled storage.

## Gaps that block a live Call button

### 1. `CallEvent` was not company-owned

Existing routes query global `CallEvent` rows after Sales role authentication.
That predates the repository's current company-scope contract. Provider-backed
calls must not repeat this pattern.

The additive GRAV Voice fields now permit historical rows to remain unowned but
reject a provider-backed call without `companyId`. New provider/company indexes
also exist. The CRM read routes still need a later, explicit migration so a
provider-backed call is never returned outside its company.

### 2. `SalesPerson` is not company-owned

The roster currently has a globally unique `employeeRef` and every query uses
an unscoped selector. A bridge service cannot describe this as company-safe
until the roster row carries `companyId` and reads are scoped.

Required before CB-01 initiation service acceptance:

- add optional legacy-compatible `companyId` plus ownership metadata;
- stamp all new roster rows from the actor's resolved Sales company;
- scope roster reads and mutations;
- backfill legacy rows only where employee/company ownership is proven;
- refuse unowned roster rows for live calling even in a sole-company fallback;
- replace global uniqueness with company-aware uniqueness if one employee may
  legitimately serve more than one company.

### 3. Legacy ingestion uses a shared optional secret

`/api/call-events` and `/api/recordings` accept an optional shared API key and
are open when it is absent. That is unsuitable for provider webhooks. GRAV
Voice will use a separate high-entropy installation token and authoritative
provider reconciliation. This audit does not change legacy mobile ingestion.

### 4. Phone-plus-time correlation is legacy-only

Existing device event and audio reports are correlated by number and a time
window. Provider calls have stable call IDs and must never use that heuristic.

### 5. Google Drive is an existing storage dependency

The current player expects a Drive-backed `driveFileId`. CB-02 may reuse that
path for the pilot, but provider recording URLs must be ingested server-side
and never copied directly into `driveViewUrl`.

## Conclusion

GRAV Voice should extend the existing call history and UI, not replace them.
The safe implementation order is:

1. canonical provider contract and additive `CallEvent` provider identity;
2. company-scope the Sales Person roster and provider-backed CallEvent reads;
3. implement idempotent bridge initiation with a fake provider;
4. connect the Exotel sandbox;
5. expose the CMS Call action.

