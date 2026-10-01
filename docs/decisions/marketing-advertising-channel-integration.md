# Marketing advertising channel integration

Status: implemented for reads (connection, campaign inventory, performance).
Date: 10 September 2026.
Governs: `services/marketing/channels/`, `routes/CMS_Routes/Marketing/advertisingChannels.js`,
`constants/marketingChannels.js`.

Related: ADR-004 (the marketing engine is not the CRM authority),
`docs/product/marketing-app-mautic-plan.md` §11 (attribution) and §12 (security).

---

## 1. The channel model

Four channels, and they are not the same kind of thing.

| Channel | Role | Publisher | Named publicly |
|---|---|---|---|
| `google_ads` | advertising | Google Ads | yes |
| `meta_ads` | advertising | Meta Ads | yes |
| `google_analytics` | measurement | none | yes |
| `email` | owned | `marketing_engine` | **no** |

Google Ads and Meta Ads are named because a marketer chose them, holds those
accounts, pays those invoices and reconciles GRAV's figures against those
dashboards. Hiding the name would make every number unverifiable and protect
nothing.

The engine behind `email` is never named. Nobody chose it, nobody signs into it,
and GRAV may replace it. `services/marketing/providerPrivacy.js` is the boundary
that enforces this, and a scanning test asserts that no advertising response
carries the product name, its configuration variable names or its address.

Google Analytics is a measurement source and **not** a fourth publisher. A GA4
property has campaign-shaped report rows, not campaigns: a campaign that ran and
got no tracked traffic is simply absent from them. Presenting those rows as an
inventory would mean a marketer's campaign list quietly omits their
worst-performing campaigns. The channel therefore declares `campaigns: false`,
and the campaign route refuses it by name with that explanation.

## 2. Secrets

Read from deployment environment variables. Never from the website tracking
configuration, which stores public identifiers only and refuses a submitted
token by name.

**Google Ads** — all required:

```
GOOGLE_ADS_CLIENT_ID
GOOGLE_ADS_CLIENT_SECRET
GOOGLE_ADS_REFRESH_TOKEN
GOOGLE_ADS_DEVELOPER_TOKEN
GOOGLE_ADS_CUSTOMER_ID
GOOGLE_ADS_LOGIN_CUSTOMER_ID     optional, only under a manager account
```

**Meta Ads**:

```
META_ADS_ACCESS_TOKEN
META_ADS_ACCOUNT_ID
META_ADS_APP_ID                  optional
META_ADS_APP_SECRET              optional
```

**Google Analytics** — the property, plus either authentication route:

```
GA4_PROPERTY_ID
GA4_SERVICE_ACCOUNT_KEY          either this
GA4_CLIENT_ID                    or these three
GA4_CLIENT_SECRET
GA4_REFRESH_TOKEN
```

**GRAV's own**:

```
MARKETING_CHANNEL_ID_SECRET      signs the opaque campaign identifier
```

A secret value never appears in a response, a log line, a database document or a
query string. A variable **name** does appear, to administrators, in the
connection diagnostic — it is not a secret, and it is the one thing that makes a
broken connection fixable.

### The deferred multi-company vault

Environment variables hold **one** company's credentials. That is honest for the
internal first release and it does not generalise. `assertCompanyMayRead` refuses
a second company outright rather than serving it company A's advertising account,
which is what a company-less environment lookup would otherwise do silently.

A second company needs, before it can be onboarded:

- per-company credential storage with tenant isolation, in a secret manager
  rather than a process environment;
- rotation without a deploy, and revocation that takes effect immediately;
- an audit trail of who read or changed a credential;
- a per-company signing key for campaign identifiers, so a token minted for one
  tenant cannot verify under another's key even if the company check regressed;
- a per-company OAuth consent flow, since one refresh token cannot represent
  several advertisers.

None of that is built. The refusal is the current tenancy guarantee.

## 3. Closed provider adapters

Three adapters, each exporting named read operations and nothing generic.

| Adapter | Operations |
|---|---|
| `googleAdsClient` | `accessibleAccounts`, `verifyAccount`, `verifyReporting`, `listCampaigns`, `campaignReport` |
| `metaAdsClient` | `accessibleAccounts`, `verifyAccount`, `verifyReporting`, `listCampaigns`, `campaignInsights` |
| `googleAnalyticsClient` | `verifyProperty`, `campaignReport` |

None takes a URL, method, path or query fragment from a caller. Google Ads is
queried in GAQL, which has no parameter binding, so every query is a constant and
every substituted value is pattern-checked first: a campaign id is digits or it
is refused, a date is `YYYY-MM-DD` or it is refused, a status filter is a key in
a closed map. Meta's Graph API is one endpoint with a path parameter, so the node
and edge are chosen from constants rather than passed in. Dates go through the
shared calendar validator described in §4e, not a shape check.

`channelHttp.assertReadOnly` refuses every verb but GET, and POST only where the
provider's own read endpoint requires one — Google's `googleAds:search`, GA4's
`runReport`, and the two OAuth token exchanges — each declared at its call site.

Bounds: 15-second timeout, one retry, retries only on transport faults and 5xx.
A 403 is not retried, because a 403 retried is a 403 twice. A 429 is not retried,
because retrying one immediately is how an account gets throttled harder.

## 4. Provider → GRAV normalisation

| GRAV field | Google Ads | Meta Ads |
|---|---|---|
| `campaignId` | HMAC-signed token over company + channel + `campaign.id` | same, over `id` |
| `name` | `campaign.name` | `name` |
| `status` | `campaign.status` through a closed map | `effective_status` through a closed map |
| `providerStatus` | `campaign.status`, unaltered | `effective_status`, unaltered |
| `objective` | `campaign.advertising_channel_type` | `objective` |
| `startDate` / `endDate` | `campaign.start_date` / `end_date` | `start_time` / `stop_time` |
| `dailyBudget` | `campaign_budget.amount_micros` ÷ 1,000,000 | `daily_budget` ÷ minor units for the currency |
| `lifetimeBudget` | `campaign_budget.total_amount_micros` | `lifetime_budget` |
| `currency` | `customer.currency_code` | `account_currency` |
| `providerUpdatedAt` | not exposed by the API — `null` | `updated_time` |

| GRAV metric | Google Ads | Meta Ads | GA4 |
|---|---|---|---|
| `spend` | `metrics.cost_micros` | `spend` | — |
| `impressions` | `metrics.impressions` | `impressions` | — |
| `reach` | **unsupported** | `reach` | — |
| `clicks` | `metrics.clicks` | `clicks` | — |
| `websiteVisits` | **unsupported** | **unsupported** | `sessions` |
| `providerConversions` | `metrics.conversions` | outcome-shaped `actions` | `conversions` |
| `leads` | **unavailable**, `grav_owned` | same | same |
| `costPerClick` | derived | derived | — |
| `costPerLead` | **unavailable** | same | same |

Both the provider's own status word and GRAV's normalisation are published.
Publishing only the normalisation would make a marketer's screen disagree with
the dashboard they reconcile against and give them no way to see why. An
unrecognised status becomes `unknown` and keeps its own word rather than being
bucketed as `ended`, which reads as a decision somebody made.

Money keeps its currency and the provider's own figure. Google reports micros;
Meta reports minor units, and how many make a unit depends on the currency — 100
for a rupee, 1 for a yen, 1000 for a dinar. A currency absent from the table
keeps its minor units and says `precision: "minor_units"` rather than being
divided by an assumed 100.

## 4a. Capability probing, and the states that follow

Each capability is proved by its own read. None is inferred from another.

| Capability | Google Ads | Meta Ads | Google Analytics |
|---|---|---|---|
| `accountRead` | `SELECT customer.* FROM customer LIMIT 1` | `GET /act_{id}` | `GET /properties/{id}` |
| `campaignRead` | `SELECT campaign.* FROM campaign LIMIT 1` | `GET /act_{id}/campaigns?limit=1` | unsupported |
| `reportingRead` | `SELECT metrics.impressions … WHERE segments.date BETWEEN` | `GET /act_{id}/insights` | one-day `runReport` |

Sharing a credential is not sharing an authorisation. Google gates `metrics.*`
behind an approved developer token that `campaign.*` does not require, so a
test-token deployment lists campaigns and cannot report on them. Meta can refuse
the insights edge while serving the campaigns edge, which is the normal state of
a token issued before app review. Inferring one from the other produced a `ready`
channel with a performance screen that could never fill.

A zero-row reporting probe is a success. An account that spent nothing yesterday
is not an account GRAV cannot report on.

When the account read is refused, the remaining probes are not attempted and both
are recorded as `refused` — a refused credential refuses every read. When it fails
transiently they still run, because one endpoint can be briefly unavailable while
another answers.

The top-level state follows from all of them:

| Every needed capability confirmed | `ready` |
|---|---|
| Some confirmed, some broken | `partially_ready` |
| None confirmed | the first failure's own state |
| Not probed | `unknown` |

`partially_ready` names the broken capability in its summary and says the
campaigns themselves may still be running and spending.

## 4b. The email channel is checked, not assumed

Its availability is a real health read through the existing engine health
service. A base URL in an environment variable proves somebody typed a URL. A
configured engine that does not answer is `configured: true`, `available: false`,
`state: unknown` — never `ready`. Nothing from the health report travels: not the
product name, its address, its variable names or its own message.

## 4c. The page cursor is integrity-protected

Not confidential. The payload is decodable and that is fine — a provider page
token is not a secret. It must be unforgeable, so that editing a field produces a
value that fails verification rather than one that pages somewhere unintended.

Format: `base64url(v.company.channel.tokenByteLength.token) + "." + HMAC`, signed
with a key derived from the deployment secret under a purpose string separate
from the campaign identifier's. The token's byte length is written before it, so
parsing is positional and no character inside an opaque provider token can be
structural.

Modified, cross-channel, cross-company and malformed cursors all produce one
refusal, verified locally, with no provider contacted. The raw provider token is
never published as a response field.

## 4d. Absent collections, per endpoint

`requireArray` has no permissive default. Every call states whether that
provider's documented empty response may omit the field.

| Response | Absent means |
|---|---|
| Meta `data` | **malformed** — always sent, `[]` when empty |
| Google Ads `results` | empty — proto3 JSON omits an empty repeated field |
| GA4 `dimensionHeaders` / `metricHeaders` | **malformed** — mandatory, they describe the shape |
| GA4 `rows` | empty — omitted when the report matched nothing |

A provider error envelope arriving with HTTP 200 is caught before any of this.
Meta answers some failures that way, and without the check the body has no `data`
and the status mapping never sees an error status to map — a permission failure
would render as an empty estate. Where the envelope's own code is unambiguous it
is classified as refused or rate-limited rather than malformed.

## 4e. Dates are real calendar days

One shared validator, used by the inventory filters, all three adapters and the
performance range. `new Date("2026-02-31")` does not throw; it rolls over to 3
March. So each date is built and its year, month and day read back — a rollover
changes at least one. This rejects 31 February, 31 April, month 00 and 13, day 00
and 32, and 29 February in a common year, alongside reversed and over-long ranges.
All of it before any provider call.

## 4f. The reporting timezone is read or admitted

It comes from the account read that the connection check already performs. Its
failure does not cost the report — a figure whose day boundaries are unknown is
still worth showing — but the accompanying sentence then says the timezone could
not be read, rather than claiming the figures are in the account's timezone while
the field is null.

## 5. Three ways a number can be missing

Every metric is `{ value, state, source }`.

- `measured` — the channel reported it, and it may legitimately be `0`.
- `unavailable` — the read failed. Nobody knows. **This is not zero.**
- `unsupported` — the channel does not report this and never will.

A campaign whose spend read timed out, rendered as `0`, tells a marketer their
campaign cost nothing while the card is still being charged. A list with
`readState` other than `ok` carries `rows: null`, never `[]`.

`source` is one of `provider_reported`, `analytics_reported`, `grav_derived` or
`grav_owned`. Nothing in this chunk emits `grav_owned`, because nothing in this
chunk has earned it.

Conversions are never totalled across channels. Google counts on its attribution
window, Meta counts a set of action types on its own, GA4 counts events it saw. A
total would be a number that is not so much wrong as meaningless. For Meta, the
response publishes which action types were counted, so a reader who disagrees
with the definition can see it rather than assume one.

## 6. GRAV attribution — defined, not implemented

The intended chain, end to end:

```
advertisement → click → website event → form submission → person
  → qualified prospect → Sales handover → opportunity → revenue
```

**None of this works today, and nothing in the current contract claims it does.**
`leads` and `costPerLead` are `unavailable` with source `grav_owned`, and the
served vocabulary says revenue, opportunities and return on ad spend are not in
this contract.

Each link needs building and proving separately:

| Link | Needs |
|---|---|
| advertisement → click | A GRAV campaign parameter on every destination URL. Proposed: `grav_cid`, carrying the same signed token the API issues, so a landing page can report it without GRAV having to trust a provider id. Google's `{campaignid}` ValueTrack and Meta's `{{campaign.id}}` can populate a parallel provider parameter for reconciliation. |
| click → website event | The website tracking configuration already stores the public identifiers. The first-party capture of `grav_cid` into a session does not exist. |
| website event → form submission | The submission must carry the captured campaign context. Today form submissions arrive through the marketing engine's webhook with no campaign field. |
| form submission → person | `MarketingIdentity` already mints `gravPersonKey`. Campaign context must be written onto it as original-touch and latest-touch, per `marketing-app-mautic-plan.md` §11, and must not be overwritten by a later touch. |
| person → qualified prospect | Handover assessment exists. It records no campaign. |
| prospect → Sales handover → opportunity | The handover contract exists. Campaign references must survive Lead conversion into a Sales Journey without transferring campaign ownership to it. |
| opportunity → revenue | Sales owns this. Marketing may report the association and must label the attribution model, and must not present correlation as channel-owned revenue. |

Conversion events GRAV will need to define, GRAV-side, before any of these
numbers are comparable across channels: form submission, qualified prospect,
accepted handover, and confirmed commercial outcome. Each needs one GRAV
definition applied identically to every channel — that is what makes a
`grav_definition` conversion comparable where a `provider_definition` one is not.

Until every link is implemented and proved, no screen may present a
channel-to-revenue figure.

## 7. What the next chunk must implement

Campaign mutation, as paused drafts. It will need:

- a new route file, because this router declares GET only and a test asserts it;
- new named adapter operations, because the adapters expose reads only;
- a change to `channelHttp.assertReadOnly`, which today refuses every write verb
  and refuses POST without a stated read intent;
- a created campaign that is **paused on creation**, never active, with the
  paused state read back and confirmed before GRAV reports success — the same
  request-then-confirm discipline the acquisition hold uses, for the same
  reason: a record that claims a change nobody verified is worse than no record;
- an approval step with a named human actor, and an audit row per attempt;
- a spend ceiling that GRAV enforces before the provider sees the request, since
  a budget mistake here costs real money immediately;
- idempotency, so a retried creation cannot produce two campaigns.
