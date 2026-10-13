# Claude Code Handoff — GRAV Voice CB-01

Implement only `docs/tasks/grav-voice-cb-01-provider-neutral-foundation.md`.

Read first:

1. `AGENTS.md`
2. `docs/product/grav-voice-call-bridge.md`
3. `docs/decisions/grav-voice-call-bridge-provider-boundary.md`
4. `docs/tasks/grav-voice-cb-01-provider-neutral-foundation.md`
5. `models/CallEvent.js`
6. `models/CMS_Models/Sales/SalesPerson.js`
7. `services/companyContext/salesScope.service.js`
8. `routes/CMS_Routes/Sales/callEvents.js`

Repository cautions:

- the worktree contains unrelated active changes; do not reformat, revert or
  include them;
- `CallEvent` remains the one call-history collection;
- new bridge calls must be company-scoped even though legacy call rows are not;
- use a fake provider only in CB-01—do not add credentials or make network
  calls;
- do not add a frontend Call button in this chunk;
- do not weaken Sales authentication or accept phone/company/provider fields
  from the browser;
- use `apply_patch` for edits and run only focused tests.

Return:

- changed files;
- focused test commands and results;
- remaining assumptions;
- a concise diff summary for Codex review.

