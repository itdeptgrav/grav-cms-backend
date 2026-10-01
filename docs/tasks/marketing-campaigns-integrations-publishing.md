# Marketing delivery queue — campaigns, integrations and publishing

Requested 22 September 2026. Product scope:
`docs/product/marketing-campaigns-integrations-publishing.md`. This queue is
separate from the unrelated Image Studio active task; do not overwrite
`docs/tasks/current-task.md` while that lane is in progress.

## Slice 1 — budget pacing in Campaigns (backend, then frontend)

Read-only. Use approved budget/basis, schedule and settled daily campaign
observations. Publish a pacing verdict only when they describe the same
campaign revision, one currency and a sufficiently covered elapsed interval.
Otherwise return unavailable with a specific reason. Do not sum reach or
unsettled spend, treat missing days as zero, or invent ROAS. Show the pacing
card in the current Campaigns kit, with a clear route to the campaign detail.
Tests: true zero, missing days, multiple currencies, daily versus total budget,
schedule not started/ended, revised plan, company isolation, no writes and no
provider call on read. No budget mutation or activation.

## Slice 2 — IndiaMART enquiries (backend, then frontend)

First obtain the seller account's Lead Manager API entitlement and documented
response shape. Build a bounded read-only pull, idempotent intake and a
checkpoint that advances only after records are durable. Keep source and
submitted time, never infer marketing permission, and expose sync health and
received enquiries in the existing inbox. Test duplicate windows, partial
failure, late arrival, a wrong key, company isolation and no Sales auto-write.
Do not invent a connection state before real account verification.

## Slice 3 — reviewed prospect enrichment (Apollo, then Zintlr)

The user must have licensed API access. Start with a manually requested,
credit-aware search or enrichment of a named person/company. Return candidates
with provenance and match confidence for human review. Never auto-merge into
the master record, auto-send messages, or turn source data into consent. Each
provider has its own rate/credit/error contract. The integration card gains a
real Connect/status/control only when the connector and revoke flow work.

## Slice 4 — manual LinkedIn company-page publishing

Requires approved LinkedIn app access and a company-page administrator. Add a
publish-ready check to the existing content item, an explicit final
confirmation, immutable publish intent before the provider call, and a
verified published/failed/unknown result. Reconcile an unknown result before
retrying so a lost response cannot make duplicate posts. Show planned,
scheduled and published times separately. No scheduler in this slice.

## Slice 5 — scheduling and additional social channels

After manual publishing is proven with a real company page, add a durable
scheduler with cancellation, time-zone handling, account revocation and
idempotent execution. Add Facebook/Instagram through independently verified
account/media permissions. Video publishing waits for suitable storage and
streaming. A calendar item marked approved is never labelled published merely
because its planned date arrived.

## Slice 6 — campaign controls beyond the current two types

Implement narrower audiences, placements, creative variants, schedule/daypart
and spend safeguards only where the capability matrix says the channel can
apply them and GRAV can read them back. Each change updates the capability
entry, model, validation, mapping, paused-create proof and builder together.
Activating or modifying a delivering campaign is a separate, explicitly
approved safety task; no slice here authorizes spending.

## Release gate

For every slice: focused tests, full Marketing tests, signed-in desktop/phone
checks, a real-account proof where applicable, and exact unresolved blockers.
Do not call a seeded preview a live integration. Preserve the current dirty
worktree and do not commit without an explicit request.
