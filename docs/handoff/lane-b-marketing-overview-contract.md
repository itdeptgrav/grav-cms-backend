# Lane B — Marketing Overview contract

Date: 2026-09-20 · Backend: Lane A · Nothing committed.

```
GET /api/cms/marketing/overview?from=YYYY-MM-DD&to=YYYY-MM-DD
```

One read for the `/marketing` landing page. Any Marketing role. It contacts no
advertising channel, asks no model anything and writes nothing — calling it
three times changes nothing and returns the same answer.

`from` and `to` are the only accepted parameters. Anything else is a **400**
naming the field.

---

## The shape a reader must understand first

Every figure is published as:

```jsonc
{ "available": true,  "value": 50000, "unit": "minor_units", "currency": "INR" }
{ "available": false, "value": null,  "unit": "minor_units", "why": "…" }
```

**`available: false` is the only way an unknown figure appears, and
`value: 0` always means a measured zero.** Never coalesce them. "We spent
nothing" and "we do not know what we spent" lead to opposite decisions, and
rendering `value ?? 0` destroys the difference the whole backend protects.

`unit` is `count`, `minor_units` (paise/cents — divide by 100 to display),
`ratio` (a fraction: `0.04` is 4%, do not double-convert) or `decimal`.

---

## `range`

```jsonc
{ "from": "2026-08-21", "to": "2026-09-19", "days": 30, "defaulted": true,
  "timeZone": "Asia/Kolkata", "timeZoneMeans": "…", "means": "…" }
```

Default is the **last 30 finished days, ending yesterday** — today is always
partial and would be excluded from its own totals anyway. Show `means` when
`defaulted` is true so nobody wonders why today is missing.

`timeZone` is the advertising account's reporting timezone, or `null` when GRAV
has read no figures. Do not substitute the browser's.

Reversed or malformed dates are a **400**; render `body.message` as-is.

---

## `performance`

```jsonc
{ "spend": {…}, "impressions": {…}, "clicks": {…}, "conversions": {…},
  "ctr": {…}, "cpc": {…}, "cpa": {…},
  "currency": "INR" | null,
  "withheld": [ { "metric": "spend", "label": "Spent", "why": "…", "currencies": ["INR","USD"] } ],
  "coverage": { "daysRequested": 30, "daysCounted": 10, "daysPartial": 0,
                "daysUnavailable": 20, "complete": false, "means": "…" },
  "freshness": { "code": "fresh|recent|stale|never", "label": "…", "observedAt": "…", "ageMinutes": 0 } }
```

Two figures are withheld rather than computed when they would be meaningless,
and each says so in `why`:

- **Spend**, when campaigns bill in more than one currency. GRAV holds no
  exchange rate; a converted total is a number that looks like money and is
  not. Show each campaign's own spend instead.
- **Conversions**, when more than one channel contributed. Each channel decides
  for itself what a conversion is, so the sum measures nothing.

Anything derived from a withheld figure is withheld too — expect `cpc` and
`cpa` to be unavailable whenever spend is. A ratio over a zero denominator is
also unavailable, with its own sentence ("This campaign was not shown, so there
is no rate to report"), **not** a rate of zero.

`reach` is deliberately absent. It cannot be added across days, channels or
plans, and a company-wide figure would be an invented audience.

---

## `dailyTrend`

One row per calendar day in the range, always — 30 rows for a 30-day range even
if GRAV read none of them.

```jsonc
{ "date": "2026-09-01", "completeness": "complete|partial|unavailable",
  "completenessLabel": "…", "countsTowardTotals": true,
  "reason": "never_read" | null, "reasonMeans": "…",
  "spend": {…}, "clicks": {…}, "conversions": {…} }
```

**Do not plot an unavailable day as zero.** Break the line, or shade the gap.
A run of zeroes reads as a campaign that stopped working, and a reader cannot
tell it from one that did. `partial` days are real figures that will still
change — show them, mark them, and note they are not in the totals.

---

## `campaigns`

```jsonc
{ "rows": [ { "campaignPlanId": "<signed token>", "draftRef": "MCP-2026-0001",
              "name": "Winter uniforms", "objective": "lead_generation",
              "channel": "google_ads", "channelLabel": "Google Ads",
              "approvedRevision": 3,
              "status": "paused|live|unknown", "statusLabel": "Created, not running",
              "statusMeans": "…", "delivering": false,
              "currency": "INR", "spend": {…}, "impressions": {…}, "clicks": {…},
              "conversions": {…}, "ctr": {…}, "cpc": {…}, "cpa": {…},
              "conversionBasis": { "countedTypes": [], "means": "…" },
              "completeness": { "daysRequested": 30, "daysCounted": 10,
                                "complete": false, "measured": true, "means": "…" },
              "ranked": true, "rank": 1,
              "destination": { "code": "campaign", "templated": true, "param": ":campaignPlanId",
                               "path": "/marketing/campaigns/plans/<campaignPlanId>/performance" } } ],
  "rankedBy": "cpa" | null, "rankedByLabel": "…", "why": "…" }
```

Only **confirmed** deployments appear — a campaign that exists in the channel.
A half-built one does not, because it cannot deliver and a row on a dashboard
looks like something that is working.

**Never label a row "running" or "active" from anything but `delivering: true`.**
Use `statusLabel`; it already says "Created, not running" for a stopped
campaign.

`ranked: false` is **not** "worst". A campaign with no conversions has no cost
per conversion, and campaigns in different currencies are not comparable at
all — `rankedBy` is then `null` and `why` explains it. Show unranked rows
after the ranked ones, without a position.

`campaignPlanId` is the signed token used by the campaign, performance and
health routes; pass it straight back in a URL. It is signed, not secret — it is
scoped to the company and cannot be forged or repointed, but its payload is
base64 and decodes to internal ids, so treat it as a URL parameter, not as a
value to log or display.

### Destinations are addresses, not templates

**`destination.path` is complete and correct as published. Use it unaltered.**
Nothing substitutes a parameter, and nothing maps a `code` onto an address of
its own.

| `code` | `path` |
|---|---|
| `campaigns` | `/marketing/campaigns` |
| `campaign` | `/marketing/campaigns/plans/<campaignPlanId>/performance` |
| `handovers` | `/marketing/handovers` |

`template` travels beside `path` and shows the shape —
`/marketing/campaigns/plans/:campaignPlanId/performance` — for anybody who
wants to see it. For a destination with no parameter the two are identical.

> **Corrected 2026-09-20.** This contract previously published
> `/marketing/campaigns/:campaignPlanId`, which the frontend does not serve, so
> every campaign link 404'd. `constants/marketingOverview.js` now holds one
> canonical address per screen and resolves the templated one against the
> identifier the same response already carries; `marketing-overview.route.test.js`
> §6 pins each path against the route the frontend actually serves, refuses a
> published `path` that still contains a `:parameter`, and fails if any overview
> source spells a `/marketing/...` address by hand. A client that was
> translating by `code` should delete that table.

---

## `approvedNotDeployed`

```jsonc
{ "count": 2, "means": "An administrator agreed to this plan. Nothing has been created
   in any advertising channel, no budget is committed and no money can be spent because of it.",
  "plans": [ { "campaignPlanId": "…", "draftRef": "…", "name": "…" } ] }
```

Approval is not deployment. Do not merge these into `campaigns.rows`, and do not
imply they are spending.

---

## `prospectMovement` — not a funnel

```jsonc
{ "coherentFunnel": false, "means": "…", "range": { "from": "…", "to": "…" },
  "stages": [ { "code": "engaged_people", "label": "People who engaged", "count": 12, "means": "…" }, … ],
  "notCountedAsEngagement": [ { "kind": "email_opened", "why": "…" }, … ],
  "peopleAreNotLeads": "…" }
```

Stages, in order: `engaged_people`, `handovers_submitted`, `awaiting_review`,
`accepted`, `returned`, `rejected`, `linked_to_existing`, `blocked`.

**Render these as independent counts. Do not divide one by another.** The
people who engaged in these dates and the prospects handed over in these dates
are different populations; a prospect's current state is a fact about today,
not about the period; and blocked prospects were never submitted at all, so
they are not a remainder of the submitted count. `coherentFunnel: false` is on
the response so a component can refuse to draw a funnel. No `percent` or `rate`
field exists on any stage.

`linked_to_existing` means Sales matched the person to a record it already had.
**It is not a rejection** — showing it as one reports a successful match as a
failure.

Each stage carries its own `means`. Show it; the definitions are the point.

**Do not call these people leads.** A Lead exists only once Sales accepts a
prospect and creates one. `notCountedAsEngagement` lists what was deliberately
excluded — possible email opens, delivery telemetry, page views, and people
GRAV added to a mailing list — so the figure can be reconciled against an email
report that counts differently.

---

## `handoverSummary`

```jsonc
{ "total": 9, "awaitingReview": 3, "accepted": 4, "returnedForNurture": 1,
  "rejected": 0, "linkedToExisting": 1, "blockedBeforeSubmission": 0,
  "scope": "company", "means": "…",
  "destination": { "code": "handovers", "label": "Handovers", "path": "/marketing/handovers" } }
```

Whole-company and **not** date-filtered — the same counts the Handovers page
shows, from the same function, so the two screens cannot disagree. Link with
`destination.path`. No Sales lifecycle copy here; Marketing reads only its own
recorded outcomes.

---

## `attention`

```jsonc
[ { "code": "handovers_awaiting_review", "title": "Prospects waiting for Sales",
    "detail": "3 prospects are waiting for a Sales decision.",
    "tone": "attention", "evidence": { "count": 3 },
    "destination": { "code": "handovers", "label": "Handovers",
                     "path": "/marketing/handovers", "template": "/marketing/handovers" } } ]
```

`best_cost_per_conversion` carries `evidence.campaignPlanId` and its
`destination.path` is already resolved against it — the link opens that
campaign's performance workspace with no work from the client.

A closed list of deterministic observations. **No model is involved and nothing
is predicted.** Every item is reproducible from figures elsewhere in the same
response — `evidence` holds the numbers it was derived from, and they match.

Codes: `best_cost_per_conversion`, `handovers_awaiting_review`,
`handovers_returned_for_nurture`, `handovers_blocked`, `no_performance_measured`,
`performance_partial`, `spend_not_combinable`, `no_campaigns_created`,
`approved_awaiting_creation`.

`tone` is `positive`, `attention` or `neutral` and is for styling only — it is
not a judgement about the business. The array may be empty. Render `detail`
as-is; do not add advice of your own.

---

## `availability`

```jsonc
{ "campaignPerformance": false, "engagement": true, "handovers": false, "partial": false,
  "means": [ { "code": "campaignPerformance", "label": "Campaign figures",
               "available": false, "means": "GRAV has no advertising figures for these dates yet." } ] }
```

Three independent sources plus `partial`. Use these to choose empty states —
each `means` is already written for a marketer. There is nothing technical
behind them to surface, and nothing for the user to retry.

---

## What is never in this response

No email address or contact detail. No advertising account or external campaign
identifier. No raw database id. No provider name. No synchronisation, retry,
reconciliation, mapping, engine, credential, queue or webhook vocabulary. No
reach, revenue, ROAS, attribution or forecast. No lead counts.

Errors use the standard Marketing envelope: `{ success: false, error: { code,
message, details }, message }`. Render `message`.
