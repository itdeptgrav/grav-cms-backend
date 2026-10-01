# Marketing completion: campaign management, lead integrations and publishing

Status: product direction approved by the user on 22 September 2026. This is
the scope for the next Marketing slices, not a claim that these capabilities
are already live. The unrelated Image Studio task remains the current active
task in `docs/tasks/current-task.md`; do not overwrite another lane's work.

## Outcome

A marketer should be able to prepare and review a B2B campaign, bring genuine
enquiries into GRAV, plan creative content, and see whether approved content was
actually published. The interface must distinguish a plan, a paused object in
an advertising account, an active campaign, a scheduled post and a published
post. None may be inferred from another.

## 1. Professional campaign management

The existing capability matrix, draft/revision/approval flow and stopped-only
Google Search and Meta single-image creation are the starting point. Do not
replace them with one generic form or silently accept a setting the channel
cannot apply.

Build in vertical slices, each with server validation, mapping, a preview of
what will be created, the builder control, readback and tests:

1. Audit the supported campaign types for B2B use: destination, conversion
   goal, budget/bidding, geography, language, age where applicable,
   exclusions, creative and tracking. The current Google and Meta mappers
   already resolve named geography/language to channel identifiers and refuse
   unresolved targeting; preserve and verify that boundary. Add narrower
   Meta audiences and provider-supported controls only as their mapping and
   readback are proved. Never widen targeting by dropping a requested setting.
2. Add visible account/campaign/ad-group/ad hierarchy, editable settings where
   the provider permits them, and a change review that shows the provider
   consequence before any mutation. Use expected revision and idempotency on
   every write.
3. Add useful manager reads: per-campaign outcomes, time trends, budget pacing
   and supported breakdowns, each with coverage and attribution warnings.
4. Activation, pausing, budget changes and scheduling are a separate safety
   slice. They can spend money. They require explicit authorization, limits,
   readback, audit and rollback/reconciliation. Stopped-only creation remains
   the rule until that contract is approved and verified with controlled
   accounts. No control should imply an unsupported action exists.

The first new implementation slice is **budget pacing as an honest read-only
manager view**: compare settled spend-to-date with the approved amount and
schedule only when the currency, budget basis, date coverage and attribution
make the comparison valid. Otherwise withhold the verdict and say why. Follow
with a separately scoped Meta audience-control slice; it must not imply job
title or company size has been verified by the advertising channel.

## 2. Lead-source integrations

Keep the catalogue honest: a logo or card does not mean connected. Use one
source-neutral intake contract recording company, source, external event key,
received/submitted times, supplied contact data, provenance, processing state
and permission status. Idempotent retries must not make duplicate enquiries.
Do not treat purchased or enriched contact data as marketing consent, and do
not create a Sales record merely because a connector returned one.

Order:

1. **IndiaMART first:** connect the seller's Lead Manager feed, pull a bounded
   window, deduplicate by source event key, preserve original enquiry context,
   show sync/coverage/errors and route received items to a reviewable Marketing
   enquiries inbox. Its official Zoho plugin identifies a Lead Manager Pull
   API; the exact seller-account entitlement and current endpoint must be
   verified with the owner's account before production use.
2. **Apollo and Zintlr next:** separate prospect *search/enrichment* from an
   inbound buyer enquiry. Results go to an explicit review queue with source,
   cost/credit use and match confidence. No automatic merge into the person
   master, no automatic outreach and no inferred opt-in. Implement only the
   endpoints actually available under the owner's plan and permitted purpose.
3. Credentials remain server-side and company-bound; account authorization,
   revoke, health and last-sync state are visible. A missing subscription or
   key yields a truthful "not connected", never a simulated successful sync.

## 3. Content calendar through publication

Keep existing idea → drafting → in review → approved, creative versions,
company-scoped image library and revision-fenced approval. Approval means
permission to publish, not publication.

1. Give each approved item explicit channel destinations and a publish-ready
   check: channel connection, correct media type/size, copy, owner, time zone,
   permissions and final creative fingerprint. Existing images are usable;
   video/document/design-file publication waits for suitable storage and
   streaming rather than pretending a note is a file.
2. Add a publisher record per destination with append-only intent and outcome.
   States include ready, scheduled, publishing, published, failed and
   outcome-unknown; retain the provider's post identifier internally. A lost
   response is not safe to retry until reconciliation checks whether a post
   already exists.
3. Start with a manually triggered, explicitly confirmed LinkedIn company-page
   post for this B2B business, subject to the account's API permission. Then
   add Meta's eligible Facebook/Instagram surfaces after their own account and
   media contracts are verified. Automatic scheduling comes only after manual
   publication and reconciliation are proven end to end.
4. Calendar shows planned date, scheduled time and verified publication time
   separately; a failed post never appears as published. Editing an approved
   creative invalidates the prior approval and scheduled payload.

## External prerequisites and stop lines

- Obtain controlled Google/Meta ad accounts to prove mapping, stopped
  creation, reporting and eventual activation safety. Do not activate or spend
  during the preparatory slices.
- Obtain IndiaMART seller CRM API access, and decide whether Apollo and Zintlr
  are licensed for GRAV's intended search/enrichment use. Do not store keys in
  the public tracking config or frontend.
- Obtain an authorized LinkedIn company-page app/account before attempting a
  real post. An external post is public and needs a separate explicit publish
  action; this document alone authorizes no posting.
- No live provider access means tests can prove mapping and safety, not claim
  that the integration works in production.

## Evidence for each slice

Every slice reports: exact supported/unsupported settings; contract and UI
screens; role and company isolation; idempotency and lost-response behavior;
the focused and full regression results; real-account proof if available; and
what is still unavailable. Keep preview fixtures labelled as sample data.

Sources checked on 22 September 2026: [Apollo API](https://docs.apollo.io/reference/apollo-api),
[Zintlr API](https://zintlr.com/docs),
[IndiaMART's official Zoho plugin](https://marketplace.zoho.in/app/crm/indiamart-official-plugin-for-zoho-crm),
and [LinkedIn Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api).
