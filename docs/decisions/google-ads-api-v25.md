# Google Ads API — v25, and what changed to get there (2026-09-21)

Chunk 3C.1. Every statement below was read from Google's own pages on
2026-09-21. Where Google's pages disagree, or are silent, this record says so.

## The version

| | |
|---|---|
| Selected | **v25** — `constants/marketingGoogleAdsApi.js` `SELECTED_VERSION` |
| Released | 22 July 2026 |
| Sunset | **August 2027** (Google publishes a month; GRAV stops on the 1st) |
| Why | The newest stable major whose v25 field and message reference GRAV read field by field. v25.1/v25.2 are served under `/v25/` and change nothing GRAV sends. |
| Previously | v18 in two files. **v18 is sunset**: every live Google Ads call from both clients would have failed. |

Source: `developers.google.com/google-ads/api/docs/sunset-dates`:

| Version | Released | Sunset |
|---|---|---|
| v22 | 2025-10-15 | October 2026 (tentative) |
| v23 | 2026-01-28 | February 2027 |
| v24 | 2026-04-22 | May 2027 |
| v25 | 2026-07-22 | August 2027 |

**One boundary.** `constants/marketingGoogleAdsApi.js` is the only file that
contains the Google Ads host. Both the read client (`googleAdsClient.js`) and the
write bundle (`googleSearchBundle.js`) build every URL through
`googleAdsErrors.versionedBase(env)`. `GOOGLE_ADS_API_VERSION` may point one
environment at another **supported** version during an upgrade. Anything outside
the supported set, or past its sunset month, is refused as
`CHANNEL_API_VERSION_REJECTED` before a request is built. Nothing falls back.

## Authentication — the September 2026 change

**Developer tokens were sunset on 9 September 2026**
(`docs/api-policy/developer-token`). Google says:

- "You can continue sending developer tokens in your API call headers, but this
  is optional and ignored by the API servers."
- Google "will start rejecting developer tokens in API calls in a future major
  version".
- "Your API access levels are now determined by the Google Cloud project you
  used to generate your OAuth credentials": the project that owns the OAuth
  client for user authentication, or the service account's project.
- An existing token's access level "has been automatically transferred to your
  Google Cloud projects based on recent API activity".

**Conflict in Google's own pages.** `docs/rest/auth` and
`docs/concepts/call-structure` still say a developer token is "required … for
every API call". GRAV follows the dated policy page, because it is the one that
describes the change. If a live call ever refuses for a missing developer token,
this is the line to revisit.

**What GRAV sends now:**
- `Authorization: Bearer <OAuth access token>`, always.
- `Content-Type: application/json`.
- `login-customer-id`, only when the bound account sits under a manager.
- No developer token. `GOOGLE_ADS_DEVELOPER_TOKEN` is no longer a required
  variable and is not read.

**Credentials GRAV needs:** `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`,
`GOOGLE_ADS_REFRESH_TOKEN` and `GOOGLE_ADS_CUSTOMER_ID`, plus optionally
`GOOGLE_ADS_LOGIN_CUSTOMER_ID`. None is stored in MongoDB.

**Access migration still required: an administrator must confirm it.**
- Access was transferred automatically only "based on recent API activity".
- GRAV's calls went to v18 and would have failed, so GRAV cannot assume its
  Cloud project inherited anything.
- An administrator must open the Google Ads API overview for the Cloud project
  that owns GRAV's OAuth client. They must confirm that the project has
  production access (Explorer or above; Test is test accounts only), and that the
  Ads users hold owner or editor roles on it.
- Until then GRAV does not claim readiness. Readiness is a real read, and a
  refusal is reported as `CHANNEL_API_ACCESS_UNAVAILABLE`.

### Six access states, told apart (`googleAdsErrors.classify`)

| GRAV code | From |
|---|---|
| `CHANNEL_NOT_CONFIGURED` | OAuth variables absent |
| `CHANNEL_OAUTH_UNAVAILABLE` | token endpoint `invalid_grant`/`invalid_client`; `authenticationError: OAUTH_TOKEN_*`, 2-step verification or advanced protection |
| `CHANNEL_API_ACCESS_UNAVAILABLE` | `authorizationError: PROJECT_DISABLED`, `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION`, `DEVELOPER_TOKEN_*`, `ORGANIZATION_*`, `MISSING_TOS`, `INCOMPLETE_SIGNUP` |
| `CHANNEL_ACCOUNT_BINDING_UNAVAILABLE` | `INVALID_LOGIN_CUSTOMER_ID_SERVING_CUSTOMER_ID_COMBINATION`, `CUSTOMER_NOT_FOUND`, `CUSTOMER_NOT_ENABLED` |
| `CHANNEL_ACCESS_REFUSED` | `USER_PERMISSION_DENIED`, `ACTION_NOT_PERMITTED` |
| `CHANNEL_API_VERSION_REJECTED` | unsupported configured version; `PAGE_SIZE_NOT_SUPPORTED`; a 404 carrying no `GoogleAdsFailure` (*inference*: Google does not document the sunset response) |
| `CHANNEL_UNAVAILABLE` / `CHANNEL_RATE_LIMITED` | 5xx (retried), transport errors, 429 |

These codes come from the v25 `AuthorizationError` and `AuthenticationError`
enums. Only enum names are logged, never Google's message.

## Defects found by auditing against v25

None of these was caught by a test, because every earlier test accepted whatever
the client sent.

| # | Where | Defect | Effect | Fix |
|---|---|---|---|---|
| 1 | both clients | v18 | every live call fails | v25 via one boundary |
| 2 | every paged read | `pageSize` in the body | v25: `PAGE_SIZE_NOT_SUPPORTED`, and "This field is deprecated" | removed. Bounded reads use GAQL `LIMIT`; campaign listing pages by a `campaign.id` keyset |
| 3 | campaign list, marker read-back | `campaign.start_date`, `end_date` | fields do not exist in v25 | `start_date_time`, `end_date_time` |
| 4 | `readDeliveryStates` | `FROM audience_group` / `advertisement` / `targeting_term` | GRAV role names, not Google resources | `ad_group`, `ad_group_ad`, `ad_group_criterion` via `ROLE_TO_RESOURCE` |
| 5 | marker read-back | `FROM campaign_budget WHERE campaign.id = …` | `campaign_budget` has only `customer` attributed | read budget fields `FROM campaign` |
| 6 | mapper → bundle | campaign `startDate`/`endDate` | not v25 fields | `startDateTime` `yyyy-MM-dd 00:00:00` / `endDateTime` `… 23:59:59` |
| 7 | mapper → bundle | no `containsEuPoliticalAdvertising` | `FieldError.REQUIRED` on every create, including through `GoogleAdsService.Mutate` (`docs/api-policy/eu-par`) | new brief field `euPoliticalAdvertising` (`does_not_contain` / `contains`). **Never defaulted**, mirroring Meta's `specialAdCategory`; if empty, mapping is refused with `EU_POLITICAL_DECLARATION_MISSING` |
| 8 | mapper | `campaign_total` sent `amountMicros` with `CUSTOM_PERIOD` | v25: `amount_micros` is daily-only and mutually exclusive with `total_amount_micros` | `totalAmountMicros` for `CUSTOM_PERIOD` |
| 9 | mapper | manual-CPC bid compared `targetLevel` with `"audience_group"`; the table says `"ad_group"` | bid silently dropped from the ad group | compare with `"ad_group"` |
| 10 | bundle | `requestId` in the request body | not a `MutateGoogleAdsRequest` field in v25 (`customer_id`, `mutate_operations`, `partial_failure`, `validate_only`, `response_content_type`) | removed |
| 11 | bundle | temporary resource names on ads and criteria (`adGroupAds/-5`, …) | those names are composite (`{parent}~{id}`), and Google's own example omits the name when nothing references it | omitted; kept on label, budget, campaign and ad group, which later operations reference |
| 12 | bundle | int64 amounts as JSON numbers | proto3 JSON's int64 form is a string; a number above 2^53 is already wrong | every `*Micros` field is sent as its digit string |
| 13 | both clients | developer-token header | sunset; to be rejected later | not sent |

The bundle now also asserts, over the bytes it is about to send:
- each create carries only fields in `ALLOWED_CREATE_FIELDS`, which is taken from
  the v25 `Label`, `CampaignBudget`, `Campaign`, `CampaignLabel`, `AdGroup`,
  `AdGroupAd`, `AdGroupCriterion` and `CampaignCriterion` messages;
- every campaign create carries one of the two EU declarations.

The existing guarantees are unchanged:
- `create` only;
- PAUSED on every object that has a delivery status;
- no status on campaign criteria;
- `partialFailure: false`;
- no update, remove or activation operation.

## Every closed read, as sent

| Operation | Endpoint | Resource | Selected | Filtered | Sorted | Bounded by |
|---|---|---|---|---|---|---|
| OAuth refresh | `POST oauth2.googleapis.com/token`, form | — | — | — | — | not retried |
| Account listing | `GET /v25/customers:listAccessibleCustomers` | — | — | — | — | — |
| Account verify | `POST …/googleAds:search` | customer | id, descriptive_name, currency_code, time_zone | — | — | `LIMIT 1` |
| Account describe | ″ | customer | + manager, status, test_account | — | — | `LIMIT 1` |
| Campaign list | ″ | campaign | id, name, status, advertising_channel_type, start/end_date_time, campaign_budget amount/total, currency | status; `campaign.id >` keyset | campaign.id | `LIMIT n+1` |
| Campaign report | ″ | campaign | metrics cost/impressions/clicks/conversions, currency | campaign.id, segments.date | — | window |
| Daily report | ″ | campaign | segments.date + metrics | campaign.id, segments.date | — | window |
| Name lookup | ″ | campaign | id, name, status, channel type | campaign.name (escaped) | — | `LIMIT 50` |
| Conversion verify | ″ | conversion_action | id, status | status = ENABLED | — | `LIMIT 1` |
| Reporting verify | ″ | campaign | id, metrics.impressions | segments.date (yesterday) | — | `LIMIT 1` |
| Delivery states | ″ | campaign(+campaign_budget), ad_group, ad_group_ad, ad_group_criterion | ids, statuses; budget id/status/amounts/period | campaign.id; criterion type KEYWORD | — | campaign `LIMIT 1` |
| Geo / language lookup | ″ | geo_target_constant, language_constant | as before | name/code exact, status/targetable | — | `LIMIT 25` |
| Marker read-back | ″ | label, campaign_label, campaign, ad_group, ad_group_ad, ad_group_criterion, campaign_criterion | as before, with v25 fields | label.name, campaign.id | — | `LIMIT` per query |
| Lead submissions | ″ | lead_form_submission_data | see below | campaign, asset, submission_date_time | submission_date_time, id | Google's 10,000-row page + `pageToken` |

Every selected, filtered and sorted field was checked against the v25 field
pages (Selectable, Filterable, Sortable), and every cross-resource filter against
the resource's "Attributed resources". Manager scoping is the
`login-customer-id` header, taken from the binding; the account is always in the
URL path, digits only.

A budget has no delivery status. `campaign_budget.status` means
ENABLED/REMOVED, i.e. whether the budget object exists. `readDeliveryStates`
returns budgets separately as `budgets[]` with `deliveryStateApplies: false`.
The provider-neutral `states` array the orchestrator reads is unchanged and
never contains a budget.

## What could and could not be tested without a controlled account

**Proved offline** (`test/marketing/google-ads-v25-contract.test.js`, 30 tests):
- the exact URL, method, headers, query text and body for every read;
- the exact mutate envelope;
- error classification from contract-shaped `GoogleAdsFailure` bodies;
- int64 safety;
- that no caller value reaches a query;
- that no executable file builds its own Google Ads URL or names a sunset version.

**Not provable without a controlled Google Ads account:**
- that Google accepts each query as written;
- that the Cloud project has access;
- the exact response to a sunset version (the 404 inference);
- how `submission_date_time >= 'YYYY-MM-DD'` behaves at day boundaries in the
  account's timezone;
- whether webhook `lead_id` equals API `id`.

The safest first live step is a `validate_only` mutate and one lead-submission
read against a test account.
