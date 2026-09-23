# Campaign performance: the normalised reporting contract

Lane A. Backend only. Reading advertising results, in one shape, for both
channels.

## What this is for

A marketer opens a GRAV campaign plan and sees what it actually did, without
opening Google Ads or Meta Ads Manager. The same normalised records are what a
later intelligence layer reads — so the shape below is the contract, and it is
designed to be stable.

**No AI recommendations here.** This slice produces facts.

## The one rule

**Never invent a number.** Every failure mode of a reporting feature is the same
shape: a figure that looks real and is not.

| The lie | What stops it |
|---|---|
| A missing metric rendered as `0` | Every metric is `null` unless a channel reported it, in the database and in the response |
| A half-counted day summed into a month | Totals count `complete` days only; partial ones are shown in the series and excluded from totals |
| A click-through rate over zero impressions | Every ratio needs both inputs known **and** a denominator above zero, or it returns `null` with a reason |
| Two currencies added together | Money combines only within one currency, and no conversion rate is applied |
| Reach added across channels or days | Never summed — the same person can be reached twice, and no data says where |
| Conversions added across channels | Never summed — each channel decides for itself what one is |

## Raw provider responses are not stored

The brief permits keeping them only if this repository already has an approved
**encrypted diagnostic** pattern. It does not. `utils/salaryEncryption.js` is
scoped in its own header to "Employee model salary fields only", keyed on
`SALARY_ENCRYPTION_KEY`, and reusing that key for advertising diagnostics would
be exactly the key-reuse mistake every other signing purpose in Marketing was
careful to avoid.

A raw advertising response is also not innocuous: it carries account
identifiers, and error envelopes carry request fragments. Storing one
unencrypted would put that in every backup.

So the normalised facts are stored and the raw body is not. A failed read is
logged server-side with its real status and operation. The API publishes
`rawResponsesStored: false` so nobody has to guess.

## The observation record

One row per `(company, deployment, reporting date)`, unique. Keyed by company,
campaign plan, **approved revision**, deployment, channel, advertising account,
external campaign and date — the revision is in the key because a plan edited
and re-approved is a different campaign, and its figures belong to the revision
that was running.

Money is kept twice: `spendMicros` is what the channel actually said, and
`spendMinorUnits` is the rounded presentation. Google reports micros —
`1_234_567` micros is `123.4567` minor units — and rounding each day before
adding loses up to half a minor unit per day. Totals sum in micros and round
once.

`metricRevision` increments only when the facts change. A re-sync reading the
same numbers is a genuine no-op; one reading different numbers supersedes the
row and appends the previous values to an append-only revision history, because
channels revise their own figures routinely as spend reconciles and late
conversions arrive.

## The external operations added

Both are reads, both take an explicitly named account, and neither accepts a
caller-supplied URL, query or operation.

| Channel | Operation | What it does |
|---|---|---|
| Google Ads | `campaign.dailyReport` | GAQL with `segments.date`, one row per day, for one campaign |
| Meta Ads | `campaign.dailyInsights` | `time_increment: 1` against the campaign node |

Nothing in this slice can reach a write client. A test greps the sync service,
the report service and the route for `googleSearchBundle`, `metaAdsWriteClient`,
`mutationIntent` and `:mutate`.

## The stable response shape

`GET /api/cms/marketing/campaign-drafts/:id/performance?startDate=&endDate=`

```jsonc
{
  "success": true,
  "campaignPlan": { "draftRef": "MCP-2026-0001" },
  "range": { "startDate": "2026-08-22", "endDate": "2026-09-20", "days": 30 },

  "deployments": [{
    "channel": "google_ads",            // never an account or campaign id
    "channelLabel": "Google Ads",
    "approvedRevision": 1,
    "campaignState": "paused_confirmed",
    "currency": "INR",                  // null until a channel has reported one
    "reportingTimeZone": "Asia/Kolkata",

    "totals": {                         // settled days only; null ≠ 0
      "impressions": 6000,
      "reach": null,                    // Google never reports it
      "reachMeans": null,               // present when reach is
      "clicks": 240,
      "landingPageViews": null,
      "spendMinorUnits": 741,
      "conversions": 12,
      "conversionValueMinorUnits": null
    },

    "derived": [{                       // ctr, cpc, cpa — always all three
      "code": "ctr", "label": "Click-through rate",
      "value": 0.04, "available": true,
      "means": "…", "format": "ratio"
      // when unavailable: value null, available false, why "…"
    }],

    "conversionBasis": {                // what this channel counted
      "countedTypes": ["lead"],
      "means": "Outcome-shaped actions only — not every tracked action."
    },

    "coverage": {
      "daysRequested": 30, "daysCounted": 6,
      "daysPartial": 0, "daysUnavailable": 24,
      "means": "…"
    },

    "gaps": [{                          // why days are missing, once each
      "code": "never_read", "label": "…",
      "completeness": "unavailable", "days": 24
    }],

    "freshness": {
      "code": "fresh|recent|stale|never",
      "label": "…", "observedAt": "…", "ageMinutes": 0
    },

    "daily": [{                         // every day in range, including gaps
      "date": "2026-09-10",
      "completeness": "complete|partial|unavailable",
      "completenessLabel": "…",
      "countsTowardTotals": true,
      "reason": null, "reasonMeans": "",
      "impressions": 1000, "reach": null, "clicks": 40,
      "landingPageViews": null, "spendMinorUnits": 123,
      "conversions": 2, "conversionValueMinorUnits": null,
      "observedAt": "…",
      "metricRevision": 1               // rises when the channel revised itself
    }]
  }],

  "combined": {
    "applicable": true,                 // false when the plan has ≤ 1 deployment
    "channels": ["Google Ads", "Meta Ads"],
    "currency": "INR",                  // null when they differ
    "totals": { "impressions": 18000, "clicks": 600, "spendMinorUnits": 8151 },
    "derived": [ /* same shape as above */ ],
    "withheld": [{                      // every figure NOT combined, with why
      "metric": "reach", "label": "People reached",
      "why": "…", "currencies": ["INR", "USD"]   // currencies only when relevant
    }],
    "daysRequested": 30,
    "means": "…"
  },

  "freshness": { /* across the whole plan */ },
  "vocabulary": { "metrics": [], "completeness": [], "derived": [] },
  "means": "These are the figures GRAV last read…",
  "rawResponsesStored": false,
  "canChangeCampaign": false,
  "canActivateCampaign": false
}
```

### Notes for Lane B

- `deployments` is always an array, one entry per deployment. A plan in one
  channel has one entry and `combined.applicable: false`.
- **Render `null` as "not available", never as 0 or "—".** The distinction is
  the whole point of this contract.
- `derived` always contains all three ratios. Check `available` before reading
  `value`.
- `withheld` is not an error list. It is the set of figures that deliberately
  have no combined total, each with a sentence that can be shown as-is.
- `vocabulary` carries every label and explanation, so no metric name needs
  hard-coding in a component.

### Notes for the intelligence layer

- Read `completeness` before any figure. Only `complete` days are settled.
- `metricRevision` is the supersede marker: a day whose revision rose has been
  corrected by the channel, and the previous values are in
  `marketing_campaign_observation_revisions`.
- `conversionBasis.countedTypes` is what makes two channels' conversion figures
  non-comparable. Do not add them.
- Spend is in **minor units** in the API and in **micros** in the database. Sum
  in micros.

## The refresh route

`POST /api/cms/marketing/campaign-drafts/:id/performance/refresh`
Body: `{ startDate?, endDate? }` — nothing else.

Reads outward, writes only GRAV. Administrator or CEO — not because the data is
sensitive (a marketer may read all of it) but because the **action** makes real
requests against a rate-limited API, and an unauthenticated refresh button on a
dashboard is how an account gets throttled.

Defaults to the last seven days: the recent days are the ones that change, and
a month-long refresh on every press is the same throttling problem.

One channel failing does not stop the other being read, and a failed read never
overwrites a figure that was true.

## Live verification still blocked

No controlled Google Ads or Meta account is configured (`GOOGLE_ADS_*` and
`META_ADS_*` are unset). Unconfirmed against a real account:

- that `segments.date` in a GAQL campaign query returns one row per day with
  `metrics.cost_micros` in the account's currency;
- that `metrics.conversions_value` is in major units, as assumed;
- that Meta's `time_increment: 1` returns `date_start` per day and
  `account_currency` on every row;
- that Meta's `landing_page_view` / `omni_landing_page_view` action types are
  the right ones to read, and that they are absent rather than zero when no
  pixel is configured;
- the exact set of Meta action types that should count as an outcome;
- both platforms' real attribution-settling windows, against which GRAV's
  conservative three-day `SETTLING_DAYS` should be re-examined.

Each is written to the documented API behaviour. The contract has not been
weakened to make a fake proof appear live.
