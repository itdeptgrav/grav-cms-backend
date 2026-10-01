# IndiaMART as a Marketing lead source: a bounded, idempotent pull (2026-09-22)

This is the first lead-source integration from
`docs/product/marketing-campaigns-integrations-publishing.md`. It is backend
only.

**Not verified live.** GRAV has no IndiaMART seller key, so nothing here has
called IndiaMART. Every test uses an injected transport.

## What IndiaMART publishes, and what GRAV relies on

The source is IndiaMART's "LMS CRM Integration V2" page,
<https://help.indiamart.com/knowledge-base/lms-crm-integration-v2/>. The page
was last updated on 11 Dec 2025; GRAV read it on 22 Sep 2026.

| Fact | Where GRAV uses it |
|---|---|
| `GET https://mapi.indiamart.com/wservce/crm/crmListing/v2/?glusr_crm_key=&start_time=&end_time=` | `indiamartClient.buildUrl` |
| Times are in IST. The page's example is `07-Dec-202109:00:00`. | `formatIst` writes exactly that shape. |
| At most 7 days per call. | Each window is 7 days less one minute. |
| Only the last 365 days are held. | The window never starts earlier than 365 days less one hour. |
| One call per 5 minutes, otherwise CODE 429. More than 5 calls in a minute blocks the key for 15 minutes. | There are 5 minutes between calls, and 15 minutes after a 429. |
| Overlapping windows return duplicates. Deduplicate on `UNIQUE_QUERY_ID`. | There is a unique index on (company, source, `UNIQUE_QUERY_ID`). |
| Response: `{CODE, STATUS, MESSAGE, TOTAL_RECORDS, RESPONSE[]}` | `interpret` |
| CODE values: 200 success; 204 no leads in the window; 401 key wrong or expired; 429 too frequent; 400 a date problem; 500 an IndiaMART error | See the error mapping below. |
| `QUERY_TYPE` values: W direct enquiry, B Buy-Lead, P PNS call, BIZ catalog view, WA WhatsApp enquiry | See the kind mapping below. |
| Paid sellers only. The key is generated at <https://seller.indiamart.com/leadmanager/crmapi>. It expires after 7 days of inactivity, and regenerating a key cancels the old one. | The `key_rejected` action text points there. |
| Enquiries from before the key was generated become available 24 hours later. | A coverage note. |

A Push API (webhook) also exists. It is out of scope.

## Design

- **Record:** a new append-only `MarketingSourceEnquiry` record, separate from
  the Google `MarketingAdvertisingLead`.
  - The Google record requires a campaign plan, a revision and a binding.
    Inventing those would disguise a marketplace enquiry as a campaign
    response.
  - `UNIQUE_QUERY_ID` is stored as `externalEventKey` with `select: false`. It
    is never published.
  - The record holds only `MSE-<16 hex>` as its public reference.
- **State:** a `MarketingLeadSourceState` row per company and source holds the
  cursor (`coveredFrom`/`coveredThrough`), the rate fence (`lastCallAt`,
  `blockedUntil`), the lease, the last run and any gaps.
- **Check sequence:**
  1. Take the lease atomically, but only when no lease is live, 5 minutes have
     passed since `lastCallAt`, and no 429 backoff is in force. The same write
     sets `lastCallAt` before the call.
  2. Compute the window, make one call and save each record.
  3. If every record in the window is durable, advance `coveredThrough`.
     Otherwise leave it where it was.
- **Window:**
  - The first check covers the last 7 days (less one minute).
  - Each later check starts at `coveredThrough` minus 15 minutes. The overlap
    catches late indexing, and deduplication absorbs the repeats.
  - Each check ends at the earlier of 7 days after its start and now.
  - It never starts earlier than now minus 365 days plus one hour. A range
    skipped this way is recorded in `gaps`.
- **Idempotency:**
  - **Overlap, a retried check, a lost IndiaMART answer, a lost answer to the
    browser:** the same window is fetched again and the unique index turns
    repeats into `alreadyHeld`. The first stored copy stands; nothing is
    overwritten.
  - **A partial save:** the records already saved stay, the cursor stays, and
    the next check refetches the window. Tests 11–13 cover these cases.
- **Unreadable records:** a record with no usable `UNIQUE_QUERY_ID` (or one the
  schema refuses) cannot be deduplicated. It is counted as `unreadable` and
  does not block the window.
- **Cut-short answers:** a `TOTAL_RECORDS` larger than the records sent is
  treated as a cut-short answer (`incomplete_response`): nothing is saved and
  the window is not covered.
- **Credentials:**
  - The key is read only from `MARKETING_INDIAMART_CRM_KEY`, and only for the
    company named by `MARKETING_COMPANY_ID`.
  - The key is not in MongoDB, a response, a log line or an error. The URL
    carrying it goes only to the transport.
  - Transport errors are replaced with `unreachable` before anything else sees
    them.
  - IndiaMART's `MESSAGE` text is never repeated.
- **Schedule and Sales routing:** superseded. See
  [Scheduled pull and routing to Sales](#scheduled-pull-and-routing-to-sales-2026-09-22-second-slice)
  below.
- **The pull itself creates nothing outside the inbox:**
  - no processing receipt, person, engagement event or consent record;
  - no Sales Lead, Sales enquiry, journey, activity or handover.

  Test 31 counts all of them before and after a pull.

### Kind: buyer enquiries vs prospects

| `QUERY_TYPE` | `kind` | `isEnquiry` |
|---|---|---|
| W, P, WA | `buyer_enquiry` | true |
| B | `purchased_lead` (a Buy-Lead the seller took from IndiaMART) | false |
| BIZ | `catalog_view` | false |
| anything else | `unclassified` | false |

A lead-form submission is always `buyer_enquiry`.

### Permission

IndiaMART never asks buyers for marketing permission. A pulled enquiry
therefore reads:
- `consent: "no_permission_recorded"`
- `consentBasis: "source_does_not_ask"`

This is a fact about the source, not an inferred outcome, and nothing is
stored to say it. Such an enquiry is never `permission_recorded`, and it never
reads `unknown`, because no processing is pending that could change it.

## Contract for Lane B

The error codes used below:

| Code | Status | When |
|---|---|---|
| `LEAD_SOURCE_NOT_CONFIGURED` | 409 | No key for this company. |
| `LEAD_SOURCE_CHECK_IN_PROGRESS` | 409 | A check is already running. |
| `LEAD_SOURCE_CHECK_TOO_SOON` | 429 | Less than 5 minutes since the last call, or inside a 429 backoff. `error.details.nextAllowedAt` gives the next allowed time. |

Both routes refuse any query parameter or body field with 400 `VALIDATION`.

### `GET /api/cms/marketing/lead-sources/indiamart`

- **Auth:** read. Viewer and above, admin and CEO.
- **Behaviour:** never calls IndiaMART.

```jsonc
{
  "success": true,
  "indiamart": {
    "source": { "code": "indiamart", "label": "IndiaMART", "method": "pull_api" },
    "configured": true,
    "connection": { "code": "not_configured" | "configured_unverified" | "connected" | "failing", "label", "means" },
    "lastCheck": null | {
      "startedAt", "finishedAt",
      "outcome": { "code": "completed" | "failed", "label", "means" },
      "window": { "from", "to" },
      "counts": { "received", "recorded", "alreadyHeld", "unreadable" }
    },
    "lastSuccessAt": null | "…", "lastFailureAt": null | "…", "consecutiveFailures": 0,
    "lastError": null | { "code", "label", "means", "action", "retryable", "at" },   // only while the last check failed
    "coverage": {
      "coveredFrom": null | "…", "coveredThrough": null | "…",
      "catchingUp": false,           // more than one check (7 days) behind
      "gaps": [{ "from", "to" }],    // ranges that aged out of IndiaMART before GRAV read them
      "retentionDays": 365, "maxWindowDays": 7,
      "notes": ["…"]                 // render as given
    },
    "enquiries": { "total": 6, "byKind": [{ "code", "label", "isEnquiry", "count" }] },
    "checkNow": {
      "allowed": false,
      "blockedBy": null | { "code": "not_administrator" | "not_configured" | "running" | "too_soon", "label", "means" },
      "running": false,
      "nextAllowedAt": null | "…"
    },
    "automaticChecks": { "enabled": false, "means": "…" }
  },
  "vocabulary": { "connectionStates", "kinds", "errors", "runOutcomes", "checkBlocks" }
}
```

`lastError.code` is one of the following:

| Code | Retryable | Means |
|---|---|---|
| `key_rejected` | no | The action names the key page. |
| `rate_limited` | yes | Wait 15 minutes. |
| `window_rejected` | no | A GRAV bug. |
| `provider_error` | yes | |
| `unreachable` | yes | This includes a lost answer. |
| `malformed_response` | yes | |
| `incomplete_response` | yes | |
| `storage_failed` | yes | |

### `POST /api/cms/marketing/lead-sources/indiamart/check`

- **Auth:** administer (admin or CEO). Anyone else gets 403.
- **Body:** none.
- **Behaviour:** at most one call to IndiaMART.

The route answers 200 whether the check succeeded or failed:

```jsonc
{
  "success": true,                   // false when check.outcome is "failed"
  "check": {
    "outcome": "completed" | "failed",
    "window": { "from", "to" },
    "reachedNow": true,              // false: still catching up; check again after nextAllowedAt
    "counts": { "received", "recorded", "alreadyHeld", "unreadable" },
    "error": null | { "code", "label", "means", "action", "retryable", "at" }
  },
  "indiamart": { … as GET … },
  "vocabulary": { … }
}
```

Refusals come back as errors instead:
- 409 `LEAD_SOURCE_NOT_CONFIGURED`
- 409 `LEAD_SOURCE_CHECK_IN_PROGRESS`
- 429 `LEAD_SOURCE_CHECK_TOO_SOON`, with `details.nextAllowedAt`
- 403 `FORBIDDEN`

### `GET /api/cms/marketing/enquiries`: additions

- **New filters:**
  - `source`: `google_lead_form` or `indiamart`.
  - `kind`: `buyer_enquiry`, `purchased_lead`, `catalog_view` or `unclassified`.
  - Both are echoed in `filters`.
- **New row keys:** `source` and `kind`. Every row now has both.
- **An IndiaMART row:**
  - `submissionRef` is `MSE-…`.
  - `campaign` is `null`.
  - `ingestionOrigin` is `"pull"`.
  - `processing` is `"not_processed"`.
  - `consent` is `"no_permission_recorded"`, with `consentBasis`
    `"source_does_not_ask"`.
  - `reviewReason` is `null`.
  - `states` is `["lead_recorded"]`.
  - `contact` is `{ name, companyName, hasEmail, hasPhone }`. `name` is `""`
    when IndiaMART sent its "IndiaMART Buyer" placeholder.
- **How filters apply to IndiaMART rows:**
  - `campaign=`, `consent=unknown`, `consent=permission_recorded` and any
    `processing` other than `not_processed` exclude them.
  - `processing=not_processed` returns only them.
- **Vocabulary additions:**
  - `processing` gains `not_processed`.
  - `consentBases` gains `source_does_not_ask`.
  - `ingestionOrigins` gains `pull`.
  - New lists: `sources` and `kinds` (the latter with `isEnquiry`).
  - `provenance` gains `source_reported`.

### `GET /api/cms/marketing/enquiries/:submissionRef`: additions

Every detail now carries `source`, `kind` and `enquiryContext`
(`null` for a lead-form submission). For an `MSE-` reference:

```jsonc
{
  "supplied": [{ "field": "phone", "code": "SENDER_MOBILE", "label": "Mobile number", "value": "…", "provenance": "source_reported" }],
  "answers": [], "unmapped": [], "phoneVerified": null, "lastProcessedAt": null,
  "enquiryContext": {
    "sourceType": { "code": "P", "label": "Phone call" } | null,
    "nameIsPlaceholder": false,
    "submittedAtAsSent": "2026-09-20 10:15:00" | null,   // show this when submittedAt is null
    "fields": [{ "field": "subject" | "productName" | "categoryName" | "message" | "callDurationSeconds" | "receiverPhone", "code", "label", "value" }]
  }
}
```

### Rendering rules

- Show `kind.label`. Never call a `purchased_lead` or `catalog_view` an
  enquiry to the buyer's name: they did not contact GRAV.
- Show `connection.label` and `lastError.action` as given. For `too_soon`,
  show `nextAllowedAt`.
- Show Check now only when `checkNow.allowed` is true, and otherwise show
  `blockedBy.means`.
- Never show a count from a failed check as coverage. Coverage is
  `coverage.coveredThrough`.
- Show `coverage.notes`. They include "no automatic schedule yet".

## What still needs the seller account

1. **Paid-seller status and the key itself.** Set `MARKETING_INDIAMART_CRM_KEY`
   and `MARKETING_COMPANY_ID` in the server environment, then use Check now.
2. **The exact time format.**
   - `start_time`/`end_time` are sent as `DD-Mon-YYYYHH:MM:SS`, following the
     page's example. The first live check confirms or refutes this: a 400
     would show as `window_rejected`.
   - `QUERY_TIME` is read as `YYYY-MM-DD HH:MM:SS` IST. Any other text is kept
     as `submittedAtAsSent` with `submittedAt: null`.
3. **Whether window boundaries are inclusive.** The 15-minute overlap covers
   either answer.
4. **Whether a response has a record cap.** None is documented.
   `TOTAL_RECORDS > RESPONSE.length` is treated as incomplete. If live data
   shows a cap, the window needs to shrink adaptively.
5. **Which `QUERY_TYPE`s GRAV's account actually receives,** and whether their
   field names match. The sample on the official page is an image; the field
   names come from its text list and from community integrations.
6. **HTTP status versus body `CODE`.** Both are handled. Which one IndiaMART
   uses for 401 and 429 in practice is unconfirmed.
7. **Whether fetching resets the key's 7-day inactivity timer.** If it does
   not, the key will lapse unless someone uses the seller panel, and the
   status will show `key_rejected` with the regeneration step.

## Files

New files:
- `constants/marketingIndiamart.js`
- `models/CMS_Models/Marketing/MarketingSourceEnquiry.js`
- `models/CMS_Models/Marketing/MarketingLeadSourceState.js`
- `services/marketing/leads/indiamartClient.js`
- `services/marketing/leads/indiamartSync.service.js`
- `routes/CMS_Routes/Marketing/leadSources.js`
- `test/marketing/indiamart-lead-source.route.test.js` (35 tests)

Changed files:
- `constants/marketingEnquiries.js`
- `services/marketing/leads/enquiryInbox.service.js`
- `routes/CMS_Routes/Marketing/enquiries.js` (comments only)
- `services/marketing/marketingAccess.js` (an `ADMINISTER` entry)
- `services/storePurchase/errors.js` (three codes)
- `server.js` (the mount)
- `test/marketing/marketing-enquiries.route.test.js` (the pinned row keys and
  filters)
- `test/marketing/marketing-access.route.test.js` (the router list and the
  elevated routes)


---

# Scheduled pull and routing to Sales (2026-09-22, second slice)

**Everything below is proven against a simulated IndiaMART.** Tests inject
the transport. No seller key exists and nothing has called IndiaMART. A real
seller-account check is still outstanding; see the end of this section.

## What already existed, and what this slice reuses

| Contract | Where | Used as |
|---|---|---|
| Marketing handover | `prospectHandover.submit` → `MarketingProspectHandover` plus an outbox row | The only way anything reaches Sales. |
| Delivery | `services/integration/marketingProspectDelivery.deliverPending` | Unchanged. |
| The one Sales writer | `services/sales/marketingProspectIntake.receive` | Deduplicates against Leads, Contacts and Accounts. A high-confidence email or phone match is LINKED; otherwise it creates a single draft (`captureStatus: "draft"`, `reviewStatus: "researching"`) **unassigned** Lead. Receipts are unique per handover. |
| Sales assignment | `marketingHandoverDecision.decide` | Sales assigns a Lead when it accepts it. There is no automatic assignment service anywhere in the codebase, so routed Leads arrive in the Sales handover inbox unassigned, like every other handover. |

## The flow

1. **Schedule.**
   - `services/integration/indiamartScheduler.runCycle` runs from `server.js`
     every 6 minutes, plus one run 60 seconds after boot to catch up after
     downtime.
   - It is idle without a key for `MARKETING_COMPANY_ID`.
   - It can be switched off with the `marketing-indiamart-pull` job flag.
   - It never throws.
2. **Pull.** The cycle calls `indiamartSync.check` with `startedBy: "scheduler"`.
   - Its state row is the cross-process lock, the rate fence (one call in 5
     minutes, 15 after a 429) and the cursor. The cursor advances only after a
     window is fully saved.
   - When the fence is closed the cycle does not call IndiaMART and goes
     straight to routing.
3. **Route.** `services/integration/indiamartSalesRouting.routeCompany` is
   bounded to 50 per cycle.
   1. **Discover:** create a `MarketingSourceEnquiryRouting` row for each
      enquiry that has none. The row is unique per company and enquiry.
   2. **Claim:** take one due row atomically. The claim lasts 5 minutes.
   3. **Decide:** a pure function returns route, hold or not-routed (see below).
   4. **Record the request in the Marketing intent ledger:**
      - `source: "indiamart"`, `sourceEventId: indiamart-enquiry:<MSE ref>`,
        `kind: form_submitted`;
      - `occurredAt` is the buyer's `QUERY_TIME`;
      - the email is set if valid, and `externalContactId` is `indiamart:<MSE ref>`.

      This is the same pattern Google lead processing uses, and it is the
      evidence the handover threshold reads.
   5. **Submit:** call `prospectHandover.submit` with the idempotency key
      `indiamart-enquiry:<company>:<MSE ref>`. The permission sent is
      `unknown` for email and phone.
   6. **Deliver:** call `deliverPending` for that correlation.
   7. **Retry delivery:** every cycle re-delivers any `sent_to_sales` row not
      yet delivered.
4. **Check now** (administrators) runs the same pull and routing once
   (`startedBy: "manual"`).

**Where the code lives.** The writer is in `services/integration/`, beside
`marketingProspectDelivery`, because it reaches Sales. The read side
(`services/marketing/leads/indiamartRouting.read.js`) reads only Marketing
records. Test 23 pins both.

### Decision (`decide`)

| Condition | Result |
|---|---|
| `purchased_lead` (B), `catalog_view` (BIZ) | `not_routed` / `kind_not_routed`. Never sent automatically and not releasable. |
| `unclassified` | Held: `unclassified_type`. Releasable with `confirmBuyerEnquiry: true`. |
| No readable `QUERY_TIME` | Held: `submitted_time_unknown`. Dismiss only. |
| Older than 30 days (the handover threshold's recency) | Held: `too_old`. Dismiss only. |
| No phone and no email | Held: `contact_missing`. Dismiss only. |
| Invalid email | Held: `contact_invalid`. Releasable with `usePhoneOnly: true` when a phone exists. |
| No name, or the "IndiaMART Buyer" placeholder | Held: `name_missing`. Releasable with `contactName`. |
| No company | Held: `company_name_missing`. Releasable with `companyName`. |
| Handover returns BLOCKED | Held: `handover_blocked`, with the handover's own reason. Dismiss only. |
| Handover rejects a field (400) | Held: `handover_refused`, naming the field. Dismiss only. |
| Temporary error | `retrying`, with backoff of 1 min × 2ⁿ⁻¹ (at most 6 h). After 8 attempts: held `routing_failed`, releasable with `retry: true`. |
| Otherwise | `sent_to_sales`. |

A buyer enquiry is W (direct), P (call) or WA (WhatsApp). Only these are
routed. Marketing does not approve them; only the exceptions above wait for a
person.

### Once, whatever repeats

| Repetition | What stops a duplicate |
|---|---|
| Overlapping or repeated pulls | The enquiry is unique on the IndiaMART id, so there is one routing row. |
| Concurrent workers | The pull lease allows one IndiaMART call; routing claims are atomic per row. |
| A crash after the handover is written | The retry's `submit` finds the handover by correlation and returns it (test 9). |
| Repeated delivery | The outbox is unique per correlation, and Sales' receipt is unique per handover (test 8). |
| The same buyer enquiring twice | Two handovers, but Sales LINKs the second to the first Lead (test 11). |

### What Sales receives

- **The Lead:**
  - `source: "marketing_campaign"`, as for every handover. The Lead enum has
    no IndiaMART value, so see the gaps below.
  - `sourceDetails: "IndiaMART — Direct enquiry | Phone call | WhatsApp enquiry"`
  - `campaignOrEvent: "IndiaMART buyer enquiries"`
  - `interestSignal: "requested_product_info"`
  - `marketingHandover.sourceSystem: "indiamart"`, with `emailConsent` and
    `phoneConsent` both `"unknown"`.
- **`possibleNeed`:** the buyer's request, from the new `sourceEnquiry` block:
  channel, source, submitted time, GRAV reference, product, category, subject,
  message and call length.

**Additive change to the boundary.** `sourceEnquiry` is a new optional block
on these three:
- `MarketingProspectHandover`
- the Sales receipt `package` snapshot
- the handover contract

Existing handovers carry `null`. `leadFromPackage` uses it only when present.
It holds GRAV's own `MSE-` reference, never IndiaMART's id (test 13).

**Consent.** No consent record is created (test 13), and permission travels as
`unknown`. The existing handover path does upsert a `MarketingIdentity` (a
best-effort person link), as it does for every handover.

## Contract for Lane B

### `GET /api/cms/marketing/lead-sources/indiamart`

- **Auth:** read.
- **Behaviour:** never calls IndiaMART.

The earlier shape still applies, with these additions:

```jsonc
{
  "indiamart": {
    "lastCheck": { "…": "…", "startedBy": "scheduler" | "manual" | null },
    "coverage": {
      "…": "…",
      "freshness": { "code": "never_checked" | "current" | "catching_up" | "stalled", "label", "means" },
      "lagMinutes": 12 | null            // now − coveredThrough
    },
    "automaticChecks": {
      "enabled": true,                   // key configured AND job switch on
      "switchedOff": false,
      "everyMinutes": 6,
      "lastCycleAt": "…" | null,
      "lastCycleOutcome": "completed" | "failed" | "waiting_rate_limit" | "another_check_running" | "error" | null,
      "means": "…"
    }
  },
  "salesRouting": {
    "byState": [{ "code", "label", "means", "count" }],        // pending, retrying, sent_to_sales, held_for_review, not_routed, dismissed
    "heldOrNotRoutedByReason": [{ "code", "label", "means", "count" }],
    "delivery": { "delivered": 3, "pending": 0 },
    "salesOutcomes": [{ "code": "awaiting_sales_review" | "accepted" | "returned" | "rejected" | "duplicate_linked", "label", "means", "count" }],
    "automaticRouting": { "routedKinds": ["buyer_enquiry"], "means" },
    "marketingPermission": { "recorded": false, "means" }
  },
  "vocabulary": { "…existing…", "coverageFreshness", "routingStates", "holdReasons", "deliveryStates", "salesOutcomes" }
}
```

`freshness` is decided as follows:
- `current`: coverage ends within 30 minutes of now.
- `catching_up`: a check succeeded in the last 30 minutes, but coverage is
  older.
- `stalled`: no success for more than 30 minutes.

### `GET /api/cms/marketing/lead-sources/indiamart/routing?state=&reason=&page=&limit=`

- **Auth:** read.
- **Paging:** `limit` defaults to 25, maximum 100. An unknown parameter or code
  gives 400.

```jsonc
{
  "success": true,
  "routing": [{
    "submissionRef": "MSE-…",
    "kind": "buyer_enquiry",
    "state": { "code", "label", "means" },
    "reason": null | { "code", "label", "means", "detail": "…" | null, "release": "companyName" | "contactName" | "confirmBuyerEnquiry" | "usePhoneOnly" | "retry" | null },
    "handoverRef": "MHO-2026-0042" | null,
    "sentAt", "deliveredAt", "decidedAt",
    "nextAttemptAt": "…" | null,        // only while retrying
    "attempts": 0,
    "delivery": null | { "code": "delivered" | "pending", "label", "means" },
    "salesOutcome": null | { "code", "label", "means", "decidedAt" },
    "review": null | { "action": "release" | "dismiss", "at", "byName", "note" }
  }],
  "page": { "number", "size", "total", "pages" },
  "filters": { "state", "reason" },
  "vocabulary": { … }
}
```

No contact detail, IndiaMART id, correlation id or claim token appears here.

### `POST …/lead-sources/indiamart/enquiries/:submissionRef/release`

- **Auth:** write (Editor and above).
- **Body:** `note` plus only the field that `reason.release` names:
  - `{ "companyName": "…" }`
  - `{ "contactName": "…" }`
  - `{ "confirmBuyerEnquiry": true }`
  - `{ "usePhoneOnly": true }`
  - `{ "retry": true }`
- **Behaviour:** routes the enquiry immediately and returns
  `{ success, routing: <row>, vocabulary }`.
- **Errors:**

  | Status | Code | When |
  |---|---|---|
  | 400 | `VALIDATION` | A wrong or missing field. |
  | 409 | `INVALID_TRANSITION` | The row is not held, or its reason cannot be released. |
  | 404 | — | Another company's reference, or one that does not exist. |

### `POST …/enquiries/:submissionRef/dismiss`

- **Auth:** write.
- **Body:** `{ "note": "why" }`. The note is required, up to 500 characters.
- **Result:** the row becomes `dismissed`. The same errors apply as for
  release.

### `POST …/lead-sources/indiamart/check`

- **Auth:** administer.
- **Response:** as before, plus:
  - `routed`: `{ discovered, routed, sentToSales, held, notRouted, retrying, delivered }`
  - `salesRouting`: the summary above.

### `GET /enquiries/:submissionRef` (for an `MSE-` reference)

Adds `salesRouting`: the routing row above, or `null` if the enquiry is not
routed yet.

### Rendering rules

- Show `freshness.label`. When it is `stalled`, show
  "not fetched since `coverage.coveredThrough`".
- Show held items with `reason.label`, `reason.detail` and the one release
  field `reason.release` names. Offer Dismiss for all of them.
- Show `salesOutcome` as Sales' decision, not Marketing's.
- Never label a `not_routed` row as a lost enquiry. It is a Buy-Lead or a
  catalog view.

## Gaps, stated exactly

1. **Lead source label.** `Lead.source` has no IndiaMART value, so routed
   Leads read `marketing_campaign` with `sourceDetails: "IndiaMART — …"`.
   Adding a value is a Sales model decision and was not made here.
2. **A company name is required.** The handover contract requires
   `company.name`, deliberately stricter than Sales' own rule. IndiaMART
   buyers who give no company are held (`company_name_missing`) until a
   reviewer supplies one. That is a person's step in an otherwise automatic
   path.
3. **No automatic assignment.** No Sales assignment service exists. Routed
   Leads arrive unassigned in the Sales handover inbox, and ownership is set
   when Sales accepts.
4. **Requests older than 30 days are held.** The handover threshold ignores
   older requests, so after more than 30 days of downtime the older enquiries
   need a person, and can only be dismissed. The limit is shown as `too_old`.
5. **Unrecorded intent events.** The IndiaMART intent events have no
   `MarketingEventReceipt`. Data Health's "events missing receipts" count will
   include them, exactly as it already includes Google lead-form events
   recorded by lead processing.

## Simulated proof, and the real seller-account check

**Proven in tests, with a simulated transport and a real Mongo replica set:**
- the schedule;
- the 5- and 15-minute fences;
- concurrent workers;
- catching up after downtime;
- freshness;
- partial saves;
- repeated pulls, routing passes and deliveries;
- a crash after the handover is written;
- Sales refusing and retrying delivery;
- Sales linking a second enquiry from the same buyer;
- holds, release and dismiss;
- company isolation;
- no consent;
- no IndiaMART id in the handover or in Sales.

**Not proven:**
- any real IndiaMART answer;
- the real `QUERY_TIME` format. If it is not `YYYY-MM-DD HH:MM:SS`, **every**
  enquiry is held as `submitted_time_unknown` and nothing reaches Sales. The
  first live check shows this at once.
- which `QUERY_TYPE` codes arrive;
- how often real buyers omit their company;
- whether scheduled pulling keeps the key from expiring.

**The real check, once a key exists:**
1. Set `MARKETING_INDIAMART_CRM_KEY` and `MARKETING_COMPANY_ID`.
2. Use Check now once and read `lastCheck` and `salesRouting`.
3. Open one routed Lead in the Sales handover inbox and compare it with the
   enquiry in IndiaMART's Lead Manager.

---

# Truthful and actionable in Sales (2026-09-22, third slice)

Simulated only. No seller key exists, and nothing has called IndiaMART.

## 1. IndiaMART is its own Lead source

**One list.** `constants/crm.js` `LEAD_SOURCES` is now the one list of Lead
source codes, with labels.
- `models/CMS_Models/Sales/Lead.js` builds its `source` enum from it. The order
  and meaning of the existing codes are unchanged.
- `indiamart` is added before `other`.
- `GET /api/cms/crm/lookups` serves the list as the `lead_source` category.
- If the lookup collection was seeded before this category existed, that
  category is served from the constants until `scripts/seedCrmLookups.js` runs
  again. The script is idempotent; it was not run against any database.

**The Sales writer** (`marketingProspectIntake.leadFromPackage`, the only
writer) maps a handover to a Lead source. It uses `indiamart` only when both
of these hold:
- `marketing.sourceSystem` is `indiamart`;
- the handover carries an IndiaMART `sourceEnquiry`.

Everything else keeps `marketing_campaign`, byte-for-byte, as before. For an
IndiaMART Lead:
- `sourceDetails` is the channel: Direct enquiry, Phone call or WhatsApp
  enquiry.
- `campaignOrEvent` is not set, because it was not a campaign.
- A new `marketingHandover.sourceEnquiry` holds:
  - `source`, and `sourceRef` (GRAV's `MSE-` reference, never IndiaMART's id);
  - `kind` and `channel`;
  - `submittedAt` and `submittedAtText` (IndiaMART's own text, always kept);
  - `submittedAtProvenance` (`source` | `reviewer_confirmed`) and
    `submittedAtConfirmedBy`.

**No data migration.** No key was ever configured and the routing has never
been committed, so no IndiaMART Lead exists. The enum change is additive.

**Follow-ups for display and manual entry:**
- The frontend label table the Lead model points to
  (`lib/leadQualification.js` SOURCES) is not in this repository. Lane B needs
  an `indiamart` → "IndiaMART" label, or can read it from the lookups.
- `CRMSettings.leadSources`, the editable list behind the manual-capture
  dropdown, is unchanged. It already lacked `google`, `linkedin`, `directory`,
  `field_visit` and `marketing_campaign`. Adding `indiamart` there is an
  administrator's settings choice.

## 2. Every routed enquiry is in a visible, actionable Sales queue

**Why the inbox is the queue.**
- A handover creates a draft Prospect with no owner.
- The Leads list shows drafts only to their creator, their owner and Sales
  managers (`routes/CMS_Routes/Sales/leads.js` `canSeeRestricted`), so an
  ordinary salesperson never sees an unowned handover draft there.
- The Sales handover inbox, `GET /api/cms/sales/marketing-handovers`, is
  readable and answerable by every Sales user. It is the queue.

**What the inbox now adds** (everything existing is unchanged):

| Addition | What it is |
|---|---|
| `?source=indiamart\|marketing_campaign` | Filter by source. |
| `?order=newest\|oldest` | Default `newest`. |
| Validation | An unknown `state`, `source` or `order` gives 400. |
| `total` | Every match, not just the page. |
| `summary` | `{ awaiting, awaitingBySource[{code,label,count}], oldestWaitingSince, oldestAgeMinutes, ownershipRule }` |
| `filters` | The filters applied. |
| `queue` block | On every row, and on `GET /:handoverRef` (below). |

```jsonc
"queue": {
  "source": { "code": "indiamart", "label": "IndiaMART" },
  "sourceEnquiry": { "ref": "MSE-…", "kind": "buyer_enquiry", "channel": "Phone call",
                     "madeAt": "…" | null, "madeAtAsSent": "…" | null,
                     "madeAtProvenance": "source" | "reviewer_confirmed" | "none", "madeAtConfirmedBy": "…" | null } | null,
  "waitingSince": "…", "ageMinutes": 45,            // null once decided
  "enquiryAgeMinutes": 225 | null,                  // null when the time is unknown
  "owner": null | { "id", "name" },
  "ownershipRule": { "automatic": false, "means": "…" } | null,   // while awaiting
  "nextAction": { "code": "accept_or_answer" | "confirm_existing_record" | "first_contact", "label", "means" } | null,
  "suggestedFirstStep": { "code", "label" } | null,   // Marketing's recommendation
  "decision": { "code", "label", "at" } | null,
  "prospectRef": "LEAD-…" | null,
  "contacted": false                                 // a handover never records contact
}
```

**Ownership.**
- Nothing is assigned by the system, and nothing is marked contacted.
- Accepting assigns the Prospect to the salesperson who accepts. Only a Sales
  manager may accept on someone else's behalf. The Prospect stays a draft.
- **Gap:** GRAV has no rule for who should own an incoming handover. There is
  no round robin, territory or default owner. Until the business defines one,
  each enquiry waits, unowned, in the inbox, with its age showing.
- **Gap:** there is no Sales dashboard or notification that counts waiting
  handovers. The new `summary` is the data for one; nothing pushes it to
  anyone.

## 3. The enquiry time: read, or confirmed by a named person, never invented

**What is kept.** IndiaMART's text is always kept on the enquiry. The enquiry
record is append-only and is never changed.

**What routing uses:**
1. **The source's time**, when it can be read and is possible: no later than
   10 minutes after GRAV received it, and no earlier than 366 days before.
2. **Otherwise, a reviewer-confirmed time**, if one exists.
3. **Otherwise, the enquiry is held:**
   - `submitted_time_unknown`: the text cannot be read.
   - `submitted_time_implausible`: the text was read, but the time cannot be
     right.

Both holds can be released with `confirmSubmittedAt`:

```
POST /api/cms/marketing/lead-sources/indiamart/enquiries/:ref/release
{ "submittedAt": "2026-09-20T10:15:00+05:30", "note": "Checked in IndiaMART Lead Manager" }
```

**Rules for a confirmation:**
- The time zone is required.
- The note is required.
- The time must be possible for this enquiry.
- No other field is accepted.

**Where the confirmation is stored.** It goes to the routing row's
`timeConfirmation` (`{submittedAt, fromReason, at, by, note}`). It is set
once, and a later release (for example, supplying a company) cannot erase it.

**Where the provenance travels:**

| Record | What it carries |
|---|---|
| Intent event | `evidence.providerRecordType: "indiamart_enquiry_time_confirmed"`; `providerTimestamp` is the original text. |
| Handover `sourceEnquiry` | `submittedAtProvenance`, `ConfirmedBy`, `ConfirmedAt`, `ConfirmationNote`. |
| Sales Lead `marketingHandover.sourceEnquiry` and the Sales queue | The same provenance. |
| `possibleNeed` | "…, confirmed by Mo Marketer; source time "…"". |

**Old is not invalid.** `too_old` means the time is valid but more than 30
days ago. It still cannot be released, only dismissed, because Sales'
handover accepts requests from the last 30 days. A confirmation that turns
out to be more than 30 days ago lands in `too_old`.

**Marketing routing rows** now carry `enquiryTime`:

```jsonc
{ "asSent": "…" | null, "readAs": "…" | null, "confirmed": { "submittedAt", "byName", "at", "note" } | null, "provenance": "source" | "reviewer_confirmed" | "none" }
```

## Tests

- `test/marketing/indiamart-sales-handover.test.js`, 13 tests:
  - the source and its enum;
  - campaign handovers unchanged;
  - the lookups;
  - duplicate deliveries;
  - the Sales queue, and accepting from it;
  - company isolation;
  - unreadable, impossible and old times;
  - release with a missing company;
  - long downtime.
- Seven mutations were tried, and all were caught.
- `indiamart-sales-routing` test 12 now expects `indiamart`.

## What a real seller-account check must still verify

1. **The real `QUERY_TIME` text.**
   - If it is not `YYYY-MM-DD HH:MM:SS`, every enquiry is held as
     `submitted_time_unknown`. Each can then only reach Sales through a
     person's confirmation, which works but does not scale.
   - One live record settles the format, and the parser is then a one-line
     change.
2. **Whether IndiaMART's time is IST** as documented. The plausibility check
   would catch a gross offset but not an hour's.
3. **Which `QUERY_TYPE`s arrive, and how often the company is blank.** A blank
   company sends the enquiry to review.
4. **The end-to-end appearance in Sales:**
   - Open one routed Prospect in the Sales handover inbox as an ordinary
     salesperson.
   - Accept it, and confirm that its source reads IndiaMART in the Sales
     screens. That needs Lane B's label.

---

# Status-contract correction: automatic checks vs coverage (2026-09-22)

This correction is limited to `GET /api/cms/marketing/lead-sources/indiamart`
(and the `indiamart` block that `POST …/check` also returns). Routing, Sales
handovers and the `confirmSubmittedAt` release are unchanged.

**What `automaticChecks` looks like now:**

```jsonc
"automaticChecks": {
  "state": { "code": "scheduled" | "switched_off" | "no_key", "label", "means" },   // NEW
  "enabled": true,              // unchanged meaning: state === "scheduled"
  "switchedOff": false,         // unchanged: the job switch, whatever the key
  "everyMinutes": 6,
  "lastCycleAt": "…" | null,    // history, kept when switched off or the key is removed
  "lastCycleOutcome": "completed" | "failed" | "waiting_rate_limit" | "another_check_running" | "error" | null,
  "lastCycleOutcomeLabel": { "code", "label", "means" } | null,                      // NEW
  "means": "…"                  // now always equals state.means
}
```

**How `state` is decided.** `no_key` wins over the switch: with no key,
nothing runs whatever the switch says. Otherwise the job switch
`marketing-indiamart-pull` gives `scheduled` or `switched_off`.

**`lastCycleOutcome` is only ever a labelled code.** Anything else stored
reads as `null`.

**The scheduler heartbeat now upserts** the state row. Before this, a cycle
that failed before the first pull ever wrote the row lost its `error`
outcome.

**Coverage notes.** `coverage.notes` now describe coverage only, and are true
in all three states. The fourth note no longer says that GRAV checks on a
schedule. It now reads: "Coverage moves forward only when a check succeeds.
Whether checks run on their own is shown separately under automatic checks."
Coverage history (`coveredFrom`, `coveredThrough`, `gaps`, `freshness`) is
unaffected by the schedule state.

**New vocabulary lists:**
- `vocabulary.automaticCheckStates`: `[{code,label,means}]` × 3
- `vocabulary.scheduledCycleOutcomes`: `[{code,label,means}]` × 5

**Tests.** `test/marketing/indiamart-status-contract.test.js`, 11 tests:
- each of the five outcomes, produced by a real cycle and read back through
  the live route;
- an unlabelled stored value;
- schedule on, switched off (through the real job flag), and no key, both
  with and without history.

Four mutations were tried and all were caught.
