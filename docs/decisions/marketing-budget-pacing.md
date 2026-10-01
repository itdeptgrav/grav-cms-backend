# Budget pacing: a read-only verdict, only when the figures support it (2026-09-22)

Slice 1 of `docs/tasks/marketing-campaigns-integrations-publishing.md`. Backend
only. Nothing here reads an advertising channel, writes a record, or changes a
campaign or budget.

## The calculation

Each **deployment** is paced on its own. A deployment is one campaign GRAV
created in one channel for the plan's approved revision.

| Term | Definition |
|---|---|
| `scheduleDays` | Days from the plan's start date to its end date, inclusive. |
| `asOf` | The last day of the unbroken run of **settled** (`complete`) days that begins on the start date. Never later than the end date or yesterday, in the advertising account's time zone. |
| `elapsedDays` | Days from the start date to `asOf`, inclusive. |
| `spentToDate` | The channel's reported spend on those days, added in micros and rounded once. |
| Daily budget | `expected = amount × elapsedDays`; `scheduleBudget = amount × scheduleDays` |
| Total budget | `expected = amount × elapsedDays ÷ scheduleDays` (an even spread, the only one the plan records); `scheduleBudget = amount` |
| `paceRatio` | `spentToDate ÷ expected` |
| Verdict | `over_budget` if spend exceeds `scheduleBudget`; otherwise `over_pace` above 1.10, `under_pace` below 0.80, `on_pace` between |

**Settled** means the reporting contract's `complete`: a day read more than
three days after it ended (`observationSync` `SETTLING_DAYS`). After `asOf`,
only up to three still-settling (`partial`) days may follow. Any other gap
withholds the verdict.

**A reported zero is zero.** A day that was never read, a day the channel did
not answer, or a settled day with no spend figure is **not** zero; each
withholds the verdict.

**Only a campaign confirmed running is paced** (corrected 2026-09-22). Both
facts must be present:
- GRAV's record says it was started: deployment state `activated`.
- The campaign object was read back from the channel as delivering:
  `nonDeliveringConfirmed: false`, a read time, and the channel's running word
  (Google `ENABLED`, Meta `ACTIVE`).

Running is never inferred from the schedule having begun or from spend
appearing. A `paused_confirmed` deployment was deliberately created stopped:
- It gets `campaign_stopped` and **no** `under_pace`/`on_pace`/`over_pace`/`over_budget`
  verdict, even when the channel reports a genuine zero.
- Its measured spend stays in the performance report
  (`GET /campaign-drafts/:id/performance`).

Today nothing in GRAV sets `activated` (activation is a separate, unbuilt safety
slice), so in practice every current deployment reads `campaign_stopped` until
that slice exists.

**Money precision** (corrected 2026-09-22). Money is in the currency's
**ISO 4217 minor unit**, and every response states how many decimal places that
is (`minorUnitDigits`):
- INR, USD and EUR: 2.
- JPY and KRW: 0.
- KWD, BHD and OMR: 3.

The digits come from an explicit table (`constants/currencyMinorUnits.js`), not
from `Intl`, whose CLDR digits depend on the runtime. For a currency not in the
table, pacing returns `currency_precision_unsupported`, and
`budget.amountMinorUnits` and `budget.minorUnitDigits` are `null`. No money
field is ever published in an assumed unit. Micros remain millionths of the
**major** unit in every currency, which is the channels' convention.

**Which budget.** Both the Google and Meta mappers create each channel's
campaign with the plan's **full** approved amount. GRAV records no split
between channels, so:
- each channel is compared with the full amount;
- channels are never added together;
- a plan in more than one channel has no plan-level verdict
  (`several_campaigns`).

Currencies are never converted.

## When there is no verdict

`pacing.available: false` carries `reason: { code, label, means }` and,
where useful, a `detail` object:

| `reason.code` | When | `detail` |
|---|---|---|
| `plan_not_approved` | Plan state is not `approved` | `{ planState }` |
| `budget_missing` | No valid amount, currency and basis | — |
| `budget_zero` | Approved amount is 0 | — |
| `schedule_missing` | Start or end missing, or start after end | — |
| `not_deployed` | No deployment for any revision | — |
| `revision_changed` | The campaign belongs to an earlier approved revision | per deployment `{ campaignRevision, approvedRevision }`; plan `{ approvedRevision }` |
| `several_campaigns` | Plan-level only: more than one current deployment | `{ channels }` |
| `campaign_stopped` | Deployment is `paused_confirmed` (created and read back stopped). Label: "Campaign is stopped; spending pace does not apply" | `{ campaignState: "paused_confirmed", measuredSpendIn: "performance_report" }` |
| `running_state_unconfirmed` | Deployment is `activated`, but its campaign object was not read back as delivering (no read-back, read back paused, or an unrecognised state word) | `{ campaignState: "activated" }` |
| `campaign_not_created` | Any other deployment state (`not_started`, `preparing`, `partially_created`, `failed`) | `{ campaignState }` |
| `budget_basis_conflict` | The channel brief's arrangement (`campaign_daily` / `campaign_total`) contradicts the plan's basis | — |
| `budget_per_audience` | The brief is `ad_set_daily` (Meta, per audience) | — |
| `time_zone_unknown` | No reporting time zone, and no brief time zone | — |
| `not_started` | No schedule day has ended yet in the account's time zone | `{ startDate, timeZone }` |
| `no_settled_days` | The first schedule day is read but still settling | `{ startDate }` |
| `missing_days` | An elapsed day is unread or unavailable | `{ missingDays, firstMissingDate, evaluatedThrough }` |
| `settled_data_behind` | More than 3 unsettled days after the last settled one | `{ lastSettledDate, unsettledDays }` |
| `spend_not_reported` | A settled day has no spend figure | `{ firstDate }` |
| `currency_precision_unsupported` | GRAV's ISO 4217 table does not list the budget's currency; checked before any deployment is read | `{ currency }` |
| `currency_mismatch` | The channel reported a currency other than the budget's | `{ budgetCurrency, reportedCurrencies }` |

## Contract for Lane B

`GET /api/cms/marketing/campaign-drafts/:campaignDraftId/pacing`

- **Auth:** read access (Viewer and above; admin, CEO).
- **Parameters:** none; any query parameter gives 400. The window is always the
  plan's approved schedule.
- **Errors:** another company's plan, or a forged identifier, gives 404
  `CAMPAIGN_DRAFT_NOT_FOUND`.

```jsonc
{
  "success": true,
  "campaignPlan": { "draftRef": "MCP-2026-0007", "state": "approved", "approvedRevision": 3 }, // approvedRevision null unless approved
  "budget": { "amountMinorUnits": 100000, "minorUnitDigits": 2, "currency": "INR", "basis": "daily" },
    // null when the plan has none; amountMinorUnits and minorUnitDigits are null for an unsupported currency
  "schedule": { "startDate": "2026-09-02", "endDate": "2026-10-02" },

  "pacing": PacingResult,          // the plan's answer (one current campaign), or why not
  "deployments": [{
    "channel": "google_ads",
    "channelLabel": "Google Ads",
    "approvedRevision": 3,
    "campaignState": "activated",           // only an activated, read-back-delivering campaign can carry a verdict
    "pacing": PacingResult
  }],

  "calculation": { "daily": "…", "total": "…", "settled": "…", "ratio": "…", "channels": "…", "running": "…", "units": "…" },
  "vocabulary": {
    "verdicts":    [{ "code", "label", "means" }],   // under_pace, on_pace, over_pace, over_budget
    "unavailable": [{ "code", "label", "means" }],   // every reason above
    "thresholds":  { "underBelow": 0.8, "overAbove": 1.1 },
    "maxStillSettlingDays": 3
  },
  "means": "Read from GRAV's stored results. Opening this contacts no advertising channel…",
  "readsAdvertisingChannels": false,
  "canChangeBudget": false,
  "canChangeCampaign": false
}
```

A `PacingResult` takes one of two shapes. When a verdict exists:

```jsonc
{
  "available": true,
  "verdict": { "code": "on_pace", "label": "On pace", "means": "…" },
  "paceRatio": 1,                        // 3 decimal places
  "basis": "daily" | "total",
  "currency": "INR",
  "timeZone": "Asia/Kolkata",
  "scheduleState": "running" | "ended",
  "asOf": "2026-09-18",                  // last settled day counted
  "elapsedDays": 17,
  "scheduleDays": 31,
  "stillSettlingDays": 3,                // after asOf, not counted
  "minorUnitDigits": 2,                  // decimal places of the minor unit every *MinorUnits field is in
  "spentToDateMinorUnits": 1700000,      // 0 is a real zero
  "expectedToDateMinorUnits": 1700000,
  "scheduleBudgetMinorUnits": 3100000,
  "remainingBudgetMinorUnits": 1400000,  // never negative
  "overBudgetMinorUnits": 0
}
```

When there is no verdict:

```jsonc
{ "available": false, "reason": { "code", "label", "means" }, "detail"?: { … } }
```

Money is in the ISO 4217 **minor unit** of `currency`. To display it, divide
by `10 ** minorUnitDigits`: 170000 fils with `minorUnitDigits: 3` is 170.000 KWD,
and 17000 with `0` is ¥17,000. Do not assume two decimal places.

- **Render** `reason.label` and `reason.means` as given.
- **Never** show a verdict when `available` is false, and never read an absent
  figure as 0.
- **Show** `asOf` beside every verdict. It is "as of the last settled day", not
  today.
- **For several channels:** show each deployment's own card. There is no
  combined figure to show.

### Lane B rendering for stopped campaigns

For `reason.code === "campaign_stopped"`:
- show the reason label ("Campaign is stopped; spending pace does not apply");
- offer the campaign's performance view for measured spend;
- show no pace badge, ratio or expected figure.

`running_state_unconfirmed` is the same with its own wording.

### Known gap, outside this slice

The performance report (`campaignReport.service.js`) still converts every
currency with a fixed 100 minor units per major (`MONEY.MICROS_PER_MINOR_UNIT`),
so its `spendMinorUnits` is wrong for currencies other than two-decimal ones. It
should adopt `constants/currencyMinorUnits.js` in its own slice.

## Also changed

`managementReads.budget_pacing` in the capability matrix is now
`available: true`, `servedBy: "GET /campaign-drafts/:id/pacing"`, with a caveat.

## Not verified live

No controlled Google or Meta account exists, so pacing has run only against
stored test observations. The settling window and the reporting assumptions
listed in `marketing-campaign-performance.md` apply unchanged.
