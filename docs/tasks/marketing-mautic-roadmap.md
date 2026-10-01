# GRAV Marketing + Mautic — Sequential Delivery Roadmap

**Status:** Approved roadmap; not the active implementation task  
**Product source:** `docs/product/marketing-app-mautic-plan.md`

This roadmap must not replace or expand `docs/tasks/current-task.md` until the
product owner explicitly activates a Marketing chunk.

## One-day MVP boundary

The complete plan below is not a one-day build. A one-day vertical slice is
accepted only as an internal MVP and contains:

1. A separately registered Marketing app shell with Overview, Campaigns and
   Handovers destinations.
2. A Mautic adapter configured only through deployment secrets, with a health
   check and synthetic test double.
3. One consented-person projection into an existing Mautic instance.
4. One inbound form/intent event recorded idempotently.
5. Consent, relevance and duplicate checks followed by one awaiting-review
   Sales Prospect handover.
6. A Sales accept, return, reject or link-duplicate decision.
7. Acquisition pause on acceptance and outcome feedback to Marketing.
8. One transparent, rule-based handover-readiness explanation; no generative
   content and no opaque predictive model in this slice.

The MVP does not include a visual campaign builder, email-template builder,
landing-page builder, advanced attribution, send-time optimisation, autonomous
AI, production mail-domain setup or a full privacy/operations programme.

### One-day schedule

| Time | Outcome |
|---|---|
| Hour 0–1 | Freeze API, ownership, consent and handover contracts; confirm Mautic access |
| Hour 1–3 | Add Marketing app shell, access boundary and read models |
| Hour 3–5 | Implement idempotent Mautic adapter, event ledger and health state |
| Hour 5–7 | Implement Prospect handover plus Sales decisions and duplicate handling |
| Hour 7–9 | Add rule-based readiness explanation and the minimum Marketing/Sales UI |
| Hour 9–10 | Run contract, replay, permission and failure-state acceptance tests |

This schedule assumes a running Mautic instance, API credentials and a safe
test sending configuration already exist. Without them, the adapter is proved
against a local synthetic Mautic contract and live connection is a separate
infrastructure step. This repository currently provides neither Docker nor a
PHP runtime, so it cannot host Mautic locally without environment setup.

## Chunk 0 — Deployment and contract proof

Goal: prove the supported boundary before building screens.

- Deploy one pinned, supported Mautic 7.x instance in development/staging.
- Configure mail transport only for a safe test domain or sink.
- Create a least-privilege integration identity and secret rotation procedure.
- Prove create/update contact, segment enrollment and one signed webhook.
- Record the exact supported API fields and webhook event identifiers.
- Confirm backup, restore and upgrade rehearsal.

Exit: one synthetic GRAV person completes a send and webhook round-trip without
using Mautic's database directly.

## Chunk 1 — Consent, identity and one-way contact projection

- Add the canonical GRAV marketing-consent record and audit history.
- Add GRAV-to-Mautic identity mapping.
- Define the minimal outbound projection allowlist.
- Implement idempotent create/update/suppress commands.
- Add retryable delivery state and a reconciliation query.
- Provide a Data health API; no dashboard yet.

Exit: eligible people sync once, suppressed people do not enroll, email changes
preserve identity, and every failure is queryable.

## Chunk 2 — Engagement intake

- Verify and ledger Mautic webhooks.
- Receive send, delivery, open, click, bounce and unsubscribe events.
- Make replay idempotent and ordering-tolerant.
- Apply suppression conservatively for unsubscribe and hard bounce.
- Project useful engagement into the existing CRM Activity timeline without
  turning the timeline into the event store.

Exit: replaying every captured webhook changes no result and creates no
duplicate Activity.

## Chunk 3 — Prospect handover and Sales acceptance

- Add a Marketing-owned, evidence-backed handover record with awaiting-review,
  accepted, returned, rejected and duplicate-linked outcomes.
- Apply consent, relevance and duplicate checks before submission.
- Create exactly one Sales-owned Prospect on a new accepted handover; never
  create an Active Lead or Sales Journey.
- Add a Sales handover inbox with assignment and response times.
- Pause acquisition campaigns atomically when Sales accepts.
- Let Sales return a Prospect with nurture reason, topic and revisit date.
- Add compact consent, campaign, evidence, attribution and freshness context to
  the Prospect without copying Marketing's raw event stream.
- Add Marketing links that open the canonical Prospect, Account, Lead and Sales
  Journey rather than copied records.
- Publish Lead conversion and named commercial outcomes back to attribution.
- Enforce a Sales-field allowlist for audience selection and reporting.

Exit: a reviewed Marketing handover becomes one Sales Prospect; Marketing
cannot contact it personally or move it, Sales can act without opening Mautic,
and both apps show the same handover decision.

## Chunk 4 — First Marketing app surfaces

- Add Marketing access and app registration.
- Build Overview, Audiences, Campaigns, Content and Data health destinations.
- Use GRAV summaries and links; deep-link to Mautic for complex editing.
- Ensure unavailable integration data never renders as zero.
- Add accessible empty, loading, failed and permission-denied states.

Exit: an internal marketer can understand campaign state and fix integration
failures without database access.

## Chunk 5 — Acquisition and attribution

- Create one controlled intake route for approved Mautic forms.
- Reuse the canonical Prospect/Lead identity and duplicate rules.
- Store original and latest-touch campaign context.
- Preserve attribution references through Lead conversion.
- Report qualified Leads, Sales Journeys and commercial outcomes using a named
  attribution model.

Exit: a campaign-generated submission becomes one GRAV Prospect and its
campaign lineage remains readable after conversion.

## Chunk 6 — Intelligent recommendations foundation

- Create a versioned recommendation record containing type, input snapshot,
  evidence, freshness, uncertainty, model/rule version and status.
- Implement deterministic audience opportunities and campaign-health warnings
  before adding generative behavior.
- Add feedback: accept, edit, dismiss and outcome.
- Build evaluation fixtures for false signals, stale evidence, missing data,
  consent conflicts and prohibited sensitive targeting.
- Make recommendations advisory; provide no activation or Sales-lifecycle write
  path.

Exit: every recommendation is explainable, reviewable, auditable and measurable
against later Sales outcomes.

## Chunk 7 — Campaign copilot and content intelligence

- Draft campaign objectives, audiences, exclusions, journey steps, message
  variants and success measures from an approved brief.
- Add brand, unsupported-claim, fatigue and compliance checks.
- Require preview and named human approval for content, audience and activation.
- Record the approved snapshot so later edits cannot change what was reviewed.
- Compare recommendations and message variants against observed outcomes.

Exit: a marketer can move from brief to an approved Mautic campaign draft, but
no AI path can activate or send without the required human decision.

## Chunk 8 — Operational hardening

- Add alerts for webhook rejection, retry backlog and reconciliation drift.
- Load-test bulk audience changes and webhook bursts.
- Document incident recovery and Mautic outage behavior.
- Complete privacy retention, export and deletion procedures.
- Run security, permission, backup/restore and staged-upgrade acceptance.

Exit: the integration can be operated safely without its original developer.

## Explicit non-goals across all chunks

- No direct Mautic database reads or writes.
- No second Account, Contact, Lead or Sales Journey master.
- No Mautic-driven Lead qualification or Journey stage changes.
- No personal calls, replies, meetings, quotations or negotiation by Marketing.
- No acquisition campaign after Sales accepts a handover.
- No copied Sales profile or second activity timeline inside Marketing.
- No core Mautic fork unless a separate decision record approves it.
- No multi-tenant abstraction for the internal first release.
- No marketing send before consent and suppression controls are accepted.
- No opaque scoring or autonomous campaign activation.
