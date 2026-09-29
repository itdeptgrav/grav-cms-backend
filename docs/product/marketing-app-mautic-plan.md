# GRAV Marketing App — Mautic Integration Plan

**Date:** 9 September 2026  
**Status:** Approved product direction  
**Deployment scope:** One internal GRAV organisation and one Mautic instance

## 1. Purpose

GRAV Marketing gives the internal marketing and sales teams one connected,
intelligent place to select audiences, run campaigns and understand which
marketing work produces qualified Leads and Sales Journeys.

Mautic supplies the marketing-automation engine. GRAV remains the system of
record for customer identity and the commercial lifecycle. The first version
is not a multi-customer SaaS product and has no tenant provisioning, customer
billing or per-tenant Mautic instances.

The handover must feel continuous with Sales without merging the applications:
Marketing supplies a complete, evidence-backed Prospect handover; Sales owns
the Prospect, every personal conversation and every later commercial record;
and Sales outcomes improve Marketing's recommendations.

"Intelligent" means the product explains what deserves attention, recommends
the next useful action and learns from recorded outcomes. It does not mean
unreviewed autonomous sending or hidden lifecycle changes.

## 2. Product boundary

### GRAV owns

- Company scope, users, roles and access.
- Account, Contact and Lead identity.
- The canonical email address and phone attached to each person.
- Marketing consent, lawful basis, source, notice version and evidence.
- Lead qualification and conversion.
- Sales Journey, opportunity, quotation, order and revenue outcomes.
- The durable activity timeline shown to Sales.
- Campaign attribution to a Lead or Sales Journey.

### Mautic owns

- Marketing segments and segment membership computation.
- Campaign definitions and automation paths.
- Marketing email and landing-page assets.
- Forms used specifically for campaign acquisition.
- Send scheduling, frequency controls and campaign execution.
- Delivery, open, click, bounce and campaign-action events.
- Marketing scores used for prioritisation.

### Neither system may silently overwrite the other

- Mautic receives a minimal, consented Contact/Lead projection with a stable
  GRAV external identifier. It does not become another editable customer
  master.
- Mautic engagement events are immutable observations when received by GRAV.
- A Mautic score can recommend attention; it cannot qualify, convert or move a
  GRAV Lead.
- A Mautic form submission may create a Prospect through one explicit,
  idempotent intake path. It may not write directly into Account, Contact or
  Sales Journey collections.
- Sales outcomes flow to Mautic only as labelled campaign context. Mautic does
  not own commercial value or revenue.

## 3. Communication boundary

Marketing does not conduct human-to-human customer conversations.

### Marketing may

- publish advertising, landing pages, catalogues and case studies;
- send approved, branded one-to-many campaigns through Mautic;
- send a neutral automatic acknowledgement after a form submission;
- collect consented responses and engagement evidence;
- select audiences, manage campaign automation and measure results; and
- prepare and submit a Prospect handover to Sales.

### Marketing may not

- personally call, email, message or meet a potential customer;
- reply conversationally from Mautic as if it were Sales;
- discuss or confirm a requirement;
- quote a price, negotiate a term or promise a delivery date;
- decide that a Prospect is an Active Lead; or
- continue acquisition messaging after Sales accepts a handover.

Sales owns every personal customer conversation. Supporting automated material
may be sent during Sales work only when Sales deliberately places the person in
an approved Sales-assisted nurture sequence.

## 4. Marketing-to-Sales handover

The handover is a controlled business record, not a contact export.

```text
Marketing audience
    → approved campaign
    → person responds or shows meaningful intent
    → consent, relevance and duplicate checks
    → Marketing submits handover
    → Sales Prospect: awaiting review
    → Sales accepts, returns, rejects or links a duplicate
    → salesperson makes the first personal contact
    → confirmed two-way interest + internal approval
    → Active Lead
    → requirement captured
    → Enquiry Ready
    → Pipeline / Sales Journey
```

### Handover threshold

A single open or general page view is not enough. A handover needs an explicit
request — callback, consultation, quotation, sample or requirement form — or a
reviewed combination of fit, recency and repeated meaningful engagement.

### Handover package

Marketing sends Sales:

- person and organisation details;
- original source, campaign, asset and captured time;
- consent and suppression state;
- form answers and stated product interest;
- concise engagement evidence, not raw event noise;
- the reason the handover deserves Sales attention;
- recommendation confidence and freshness;
- suggested response time; and
- possible existing Prospect, Lead, Account or Journey matches.

The handover creates a Sales-owned Prospect with `Awaiting review`; it never
creates an Active Lead. If the person already belongs to Sales, the signal is
attached to the existing record and no duplicate Prospect is created.

### Sales decision

Sales may:

- **Accept and assign** — Sales owns the Prospect and contacts the person;
- **Return for nurture** — Marketing resumes approved automation with the
  reason, suggested topic and revisit date supplied by Sales;
- **Reject** — invalid, irrelevant, spam or outside the business scope; or
- **Link duplicate** — preserve the campaign evidence on the existing Sales
  record.

On acceptance, acquisition campaigns pause immediately. Marketing can see the
decision and later outcome but cannot edit the Sales record or conversation.

## 5. Seamless Sales integration

Marketing and Sales are separate applications connected by handover and
outcome records, not two CRMs joined by a nightly export.

### Shared experience

- Marketing opens the canonical GRAV Account, Contact, Lead or Sales Journey;
  it does not show a copied profile page.
- Sales sees campaign membership, recent engagement, consent and suppression
  in its existing customer and Lead context.
- The CRM Activity timeline receives useful marketing milestones such as form
  submission, meaningful click, reply, unsubscribe and campaign qualification.
  Raw delivery telemetry stays in the marketing event store.
- A marketer can create an audience from approved GRAV traits and lifecycle
  states without exporting a spreadsheet.
- A salesperson can return a Prospect for nurture or request an approved
  Sales-assisted nurture path when consent and permissions allow it.
- Marketing can submit a **Prospect handover** with reasons and evidence. Sales
  accepts, returns, rejects or links it; the handover never moves a Lead.
- When Sales converts a Lead, creates a Journey or records a confirmed outcome,
  attribution and model feedback update without the user re-entering data.

### Interaction contract

- Prefer event-driven updates for consent withdrawal, form submission, strong
  engagement, Lead conversion and commercial outcome; use reconciliation for
  recovery rather than as the normal user experience.
- Every cross-app link carries stable GRAV identifiers.
- Marketing may read only the Sales fields approved for audience selection and
  attribution. Price, margin and sensitive commercial detail remain hidden
  unless a specific report is authorised.
- Sales users can see why a person is in a campaign and why an intelligent
  signal was raised.
- Duplicate, stale or unavailable marketing state must be visible rather than
  quietly presented as current.

## 6. Recommended technical shape

Run Mautic as a separately deployed application with its own supported PHP
runtime and relational database. Do not embed Mautic tables in MongoDB and do
not import Mautic application code into the GRAV Node backend.

```text
GRAV CRM records
      |
      | consented projection + stable external ID
      v
GRAV marketing integration service  <---- Mautic webhooks
      |                                      |
      | Mautic API                           | delivery/engagement events
      v                                      |
Mautic: segments, assets, campaigns, execution
```

The integration service is an anti-corruption layer. GRAV routes and models
must not depend on Mautic's internal database schema.

Prefer, in order:

1. Mautic's supported API and webhooks.
2. A small Mautic plugin for a capability unavailable through supported
   extension points.
3. A maintained core fork only when an essential requirement cannot be met by
   either option and its upgrade and GPL consequences have been approved.

## 7. Consent and communication rules

Consent is a business record, not a Mautic checkbox copied into GRAV.

For each channel, GRAV records:

- state: unknown, opted in, opted out or suppressed;
- purpose and channel;
- capture source and timestamp;
- notice/version accepted, where applicable;
- evidence reference and recorded actor/system;
- withdrawal timestamp and reason;
- last successful synchronization state.

No record with unknown or opted-out email consent may be enrolled in a
marketing email campaign. Transactional customer communication is a separate
purpose and must not be enabled by marketing consent.

An unsubscribe or hard-bounce webhook must immediately create an immutable
event, update the appropriate suppression state idempotently and prevent later
campaign enrollment. Conflicts resolve toward suppression until reviewed.

## 8. First user experience

The Marketing app should initially have five destinations:

1. **Overview** — audience size, active campaigns, sends, engagement,
   suppressions and attributed Lead/Journey outcomes.
2. **Audiences** — GRAV-defined audience eligibility and Mautic segment status.
3. **Campaigns** — campaign summary, schedule, audience, status and performance;
   editing may deep-link to Mautic during the first release.
4. **Content** — email, form and landing-page inventory; editing may initially
   remain in Mautic.
5. **Data health** — sync failures, missing consent, duplicate identities,
   rejected webhooks and records awaiting retry.

Within Sales, add a handover inbox and compact marketing context rather than
another Marketing dashboard:

- consent and suppression state;
- active/recent campaigns;
- meaningful engagement and last-engaged time;
- current score or intent band with its reason and freshness;
- awaiting, accepted, returned or rejected handovers; and
- attributed source/campaign.

The Sales app keeps Leads and Sales Journeys. Marketing may open those records
through links but must not reproduce or edit their commercial lifecycle.

## 9. Intelligent Marketing layer

Mautic executes campaigns; GRAV's intelligence layer combines Mautic engagement
with authoritative Sales context and outcomes.

### First intelligent capabilities

1. **Audience opportunity finder** — identifies consented groups with a clear
   shared need, lifecycle position or inactivity pattern and explains the
   inclusion criteria.
2. **Campaign copilot** — drafts an objective, audience, message variants,
   journey steps, exclusions and success measures from an approved brief.
3. **Content intelligence** — checks clarity, tone, duplication, unsupported
   claims, missing calls to action and brand consistency; generated content is
   always a draft.
4. **Next-best-action recommendations** — suggests nurture, prepare handover,
   pause, suppression or no action from recent evidence.
5. **Handover readiness** — ranks meaningful buying signals using fit,
   recency, frequency and breadth of engagement, with the factors shown.
6. **Send-time and fatigue guidance** — recommends timing and warns when a
   person is over-contacted across active campaigns.
7. **Campaign health and anomaly detection** — surfaces unusual bounce,
   unsubscribe, complaint, delivery or conversion movement early.
8. **Learning from Sales outcomes** — measures which audiences, campaigns and
   messages lead to qualified Leads, Journeys and confirmed outcomes.

### Intelligence safety contract

- Recommendations must show their supporting factors, source freshness and
  confidence or uncertainty.
- Missing data may reduce confidence; it may not be invented or treated as
  negative evidence.
- A person must never be targeted solely from sensitive personal data or an
  inferred sensitive trait.
- Generated content, audience changes and campaign activation require a human
  preview and approval in the first release.
- AI cannot override consent, suppression, frequency caps or access controls.
- AI cannot personally reply, qualify or convert a Lead, change a Journey
  stage, promise price or delivery, or communicate as a salesperson.
- Every accepted recommendation records its input snapshot, model/version,
  explanation, approver and resulting action.
- Users can dismiss a recommendation and give a reason; evaluation must include
  harmful recommendations, not only accepted ones.

## 10. Identity and integration contract

- Use an opaque GRAV person identifier as Mautic's external key. Never use an
  email address as the durable identity key.
- Maintain one explicit mapping record between the GRAV person and Mautic
  contact identifiers.
- All outbound commands and inbound webhooks require an idempotency key.
- Verify webhook authenticity before accepting an event.
- Store the source event identifier, type, occurrence time, received time and
  processing result.
- Retry transient failures; preserve terminal validation failures for review.
- Never report a failed or unavailable Mautic read as zero.
- Reconciliation must detect missing mappings, drift and unprocessed events
  without editing customer data automatically.

## 11. Attribution

Capture original and latest-touch campaign context on the pre-Journey Lead,
including campaign, asset/form, source, medium, content and captured time.
Conversion preserves those references; it does not transfer campaign ownership
to the Sales Journey.

Reports may associate campaigns with qualified Leads, created Sales Journeys
and confirmed commercial outcomes. They must label the attribution model used
and must not present correlation as Mautic-owned revenue.

## 12. Security and operations

- Keep Mautic administrative access separate from ordinary GRAV Marketing
  access during the first release.
- Store Mautic credentials in deployment secrets, never database documents or
  frontend configuration.
- Grant the integration identity only the Mautic permissions it uses.
- Redact secrets and unnecessary personal data from logs.
- Back up Mautic's database and uploaded assets together.
- Test Mautic upgrades in staging against the integration contract before
  production rollout.
- Pin a supported Mautic 7.x release; do not track a moving branch in
  production.

## 13. First release acceptance

The first release is complete only when:

- an eligible GRAV person synchronizes exactly once to Mautic;
- an ineligible or suppressed person cannot be enrolled;
- a changed canonical email is reconciled without creating a second identity;
- unsubscribe and hard-bounce events suppress future marketing sends;
- webhook replay produces no duplicate GRAV activity;
- campaign engagement appears on the correct Lead/Contact timeline;
- campaign attribution survives Lead conversion into a Sales Journey;
- Sales shows meaningful marketing context without opening Mautic;
- a Marketing handover creates one awaiting-review Sales Prospect, or links to
  the exact existing Sales record, and cannot change its lifecycle;
- accepting a handover pauses acquisition campaigns before Sales begins its
  personal outreach;
- Marketing has no path for personal reply, quotation or negotiation;
- the campaign copilot produces only a reviewable draft with sources and
  exclusions;
- every intelligent recommendation explains its evidence and freshness;
- consent, suppression and frequency caps cannot be bypassed by automation;
- failures are visible and retryable from Data health;
- Mautic downtime renders unavailable states rather than false zeroes; and
- no Mautic path can qualify a Lead or edit a Sales Journey.

## 14. Deferred

- Multi-customer SaaS tenancy and tenant provisioning.
- Customer subscriptions and billing.
- A complete replacement UI for Mautic's builders.
- SMS, WhatsApp and paid-ad connectors.
- Fully autonomous campaign activation or customer communication.
- Opaque predictive lead scoring with no explanation or outcome evaluation.
- Bidirectional custom-field synchronization beyond the approved projection.
- A core Mautic fork.
