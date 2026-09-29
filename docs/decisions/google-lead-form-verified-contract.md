# Google lead forms — what was verified, and from where

Status: reference
Date: 2026-09-20
Verified against developers.google.com and support.google.com on 2026-09-20.

Recorded because the instruction was explicit: do not invent fields, questions,
webhook verification methods or retrieval endpoints. Everything GRAV encodes
about Google lead forms traces to one of these pages, and anything not on this
page is not in the code.

## `LeadFormAsset`
`developers.google.com/google-ads/api/reference/rpc/v18/LeadFormAsset`

**Required:** `business_name`, `headline`, `description`,
`call_to_action_type`, `call_to_action_description`, `privacy_policy_url`.

**Optional:** `post_submit_headline`, `post_submit_description`,
`post_submit_call_to_action_type`, `background_image_asset` (exactly
1200×628), `desired_intent`, `custom_disclosure` (allow-listed customers only),
`fields[]`, `custom_question_fields[]`, `delivery_methods[]`.

Two constraints quoted verbatim and load-bearing:

- `custom_question_fields[]` — "subject to a limit of 5 qualifying questions
  per form".
- `fields[]` — "can be updated by reordering questions, but not by adding or
  removing questions." **A form's field set is effectively immutable after
  creation.**
- `delivery_methods[]` — "Only one method typed as WebhookDelivery can be
  configured."

## `LeadFormFieldUserInputType`
`.../rpc/v18/LeadFormFieldUserInputTypeEnum.LeadFormFieldUserInputType`

Two distinct kinds in one enum, and the difference decides the whole design:

**Contact fields** — the person types their own details. `FULL_NAME`,
`FIRST_NAME`, `LAST_NAME`, `EMAIL`, `PHONE_NUMBER`, `POSTAL_CODE`, `CITY`,
`COUNTRY`, `COMPANY_NAME`, `JOB_TITLE`, plus country-specific government ids
(`GOVERNMENT_ISSUED_ID_CPF_BR`, `..._DNI_AR`, `..._RFC_MX`, and others).

Exclusivity, quoted: `FIRST_NAME` and `LAST_NAME` "can not be set at the same
time as `FULL_NAME`".

**Qualifying questions** — each carries a fixed Google-authored question string
and a category, and each is "subject to a limit of 5 qualifying questions per
form and cannot be used if values are set using `custom_question_fields`."
Examples: `JOB_ROLE` ("What is your job role?"), `COMPANY_SIZE` ("What size is
your company?"), `ANNUAL_SALES`, `JOB_INDUSTRY`, `JOB_DEPARTMENT`,
`LEVEL_OF_EDUCATION`, `OVER_18_AGE` … `OVER_65_AGE`, plus vertical-specific
travel, retail, education and real-estate questions.

**The fact that matters most for GRAV.** `JOB_ROLE`, `JOB_INDUSTRY`,
`COMPANY_SIZE`, `ANNUAL_SALES`, `COMPANY_NAME` and `JOB_TITLE` are all things
**the person types or picks about themselves**. Google does not verify any of
them against an employer, a registry or anything else. They are self-reported
answers and GRAV stores them as such — never as firmographic truth, and never
as a basis for claiming a prospect's employer, seniority or purchase authority.

## `WebhookDelivery`
`.../rpc/v18/WebhookDelivery`

| Field | What it is |
|---|---|
| `advertiser_webhook_url` | the endpoint Google posts to |
| `google_secret` | "Anti-spoofing secret set by the advertiser as part of the webhook payload." |
| `payload_schema_version` | the schema version the delivery uses |

**This is a shared secret echoed inside the JSON body, not a signature.** There
is no HMAC, no signing key and no signature header in the documented contract.
GRAV therefore compares the secret in constant time and refuses anything that
does not match, and does **not** invent a signature scheme that Google does not
send. A shared secret is weaker than a signature — it is replayable by anyone
who has ever seen a body — which is exactly why the ingestion boundary must
also be idempotent on the submission id rather than relying on verification
alone.

## Retention and retrieval
`support.google.com/google-ads/answer/9423234`

- Google Ads **stores leads for 60 days**.
- CSV download covers **the last 30 days only**.
- **Google Ads API: "Export up to 60 days of lead data automatically to your
  CRM."**

So missed-lead retrieval genuinely exists, within 60 days. GRAV does not have
to publish a fake recovery promise — and equally must not promise recovery
beyond 60 days, because after that the data is gone from Google.

## `lead_form_submission_data` (the retrieval resource)
`developers.google.com/google-ads/api/fields/v18/lead_form_submission_data`

| Field | Notes |
|---|---|
| `id` | STRING, **filterable and sortable** — the idempotency key and the pagination cursor |
| `submission_date_time` | `"yyyy-mm-dd hh:mm:ss+|-hh:mm"`, filterable and sortable |
| `lead_form_submission_fields[]` | the answers |
| `custom_lead_form_submission_fields[]` | custom-question answers — `CustomLeadFormSubmissionField` is `{question_text, field_value}`, with **no** `field_type` (see Chunk 3C below) |
| `gclid` | the click that led to it |
| `asset`, `campaign`, `ad_group`, `ad_group_ad` | resource names |
| `resource_name` | `customers/{customer_id}/leadFormSubmissionData/{id}` |

Both `id` and `submission_date_time` being sortable and filterable is what makes
a company-scoped, paginated, idempotent reconciliation implementable rather than
aspirational.

## Eligibility rules that constrain the plan
`support.google.com/google-ads/answer/9423234`

These are not GRAV's opinions — they decide whether a lead form will serve at
all, so the readiness evaluator has to know them:

- **Bidding must be conversion-focused.** `maximise_clicks`, GRAV's current
  default, would produce a campaign whose form never serves.
- **The campaign must be optimised towards a Google lead form conversion
  goal**, even when it also optimises for others.
- **Responsive search ads only.** Expanded text ads are ineligible.
- A **privacy policy URL** is mandatory.
- The account needs a good policy-compliance history and an eligible vertical;
  sensitive verticals are refused.
- Lead forms attach to **Search and Performance Max** campaigns.
- There is a **country list where lead forms do not serve at all** (Saudi
  Arabia, UAE, Qatar, Serbia, Slovenia and many others). A campaign targeting
  only those countries would run and collect nothing.

## The webhook payload — verified 2026-09-20 (second pass)
`developers.google.com/google-ads/webhook/docs/{implementation,samples}`

The open item from the first pass is closed. The published proto is
`WebhookLead` with `UserLeadColumnData`, and four things on that page decide the
implementation:

**`column_name` is marked Deprecated**, with "This field might not always be
populated, use `column_id` instead." Identity is `column_id`. A mapping built on
the label passes every test written against the samples — which all carry one —
and starts silently dropping fields in production.

**The ids are int64.** "Clients need to use 8 bytes integer to process" appears
four times, for `form_id`, `campaign_id`, `adgroup_id`, `creative_id` and
`asset_group_id`. JavaScript numbers are not 8-byte integers: `JSON.parse` turns
a value above 2^53 into a nearby number silently, and the correlation it was for
then matches nothing. They are read from the raw body as text.

**Delivery is at-least-once.** "A single lead is not guaranteed to be delivered
exactly once… Use `lead_id` to dedupe leads." Because verification is a shared
secret in the body rather than a signature, a replayed body from anyone who has
seen one is indistinguishable from a genuine redelivery — so deduplication is a
security control here, not an efficiency.

**The HTTP contract carries retry semantics.** 200 with `{}`; 4XX with
`{"message": …}` is *not* retryable; 5XX *is*. So a wrong secret must be 4XX —
it will not become right on a retry — an internal fault must be 5XX or a real
lead is lost to a busy moment, and a duplicate must be 200 or Google keeps
redelivering something that already arrived safely.

**`is_test`:** "If value is false or if field is not present, treat this lead as
valid production lead." Only an explicit true makes it a test.

**`lead_source`:** `"LEAD_FORM"` or `"CONVERSATIONAL_AGENT"`.

### A discrepancy in Google's own samples

The production sample spells the secret `"google_key"`. **Every test sample on
the same page spells it `"Google_key"`, with a capital G.** The proto says
`google_key`, so the capitalised form is almost certainly a documentation typo —
but refusing it would refuse Google's own official test sample, and anybody
following the documented testing procedure would watch verification fail and
conclude the integration was broken. Both spellings are accepted. That is a
second spelling of one field name, not a second secret or a weaker check.

(The published production sample also has a trailing comma after `google_key`,
which is not valid JSON. Not accommodated — no parser would produce it and real
traffic is valid.)

## `LeadFormSubmissionField` (the recovery shape)
`.../rpc/v18/LeadFormSubmissionField`

`field_type` (the same `LeadFormFieldUserInputType` enum as `column_id`) and
`field_value` (string). So a pushed delivery and a pulled recovery carry the
same enum under different key names, and both are converted to one shape before
a single normaliser handles them — separate normalisers would drift, and the
drift would surface as one submission stored twice with slightly different
contents.

## Chunk 3C decisions — recovery and reconciliation (2026-09-21)

**Custom answers were being lost, and are now kept.** 3A read
`custom_lead_form_submission_fields` through the `field_type` path. The
resource has no `field_type`, so every custom answer was skipped silently. They
are now kept under the fixed code `CUSTOM_QUESTION`, flagged for review and left
uninterpreted. The question text is advertiser prose, so it is never used as an
identifier. 3A's test 19 asserted an invented shape and was rewritten to
Google's real one.

**The processing promise is durable and written before Google is answered.**
Ingestion writes a `pending_identity` receipt beside the enquiry
(`leadProcessingQueue.enqueue`, `$setOnInsert` only, so it never rewinds work).
If writing the promise fails, Google is still answered 200, because the enquiry
itself is safe. The sweep also looks for production enquiries that have no
receipt.

**The internal sweep (`leadRecovery.service`) runs company by company:**
- It finds non-terminal receipts untouched for 5 minutes, plus orphaned
  enquiries.
- Each run is bounded to 100.
- It skips `needs_human_review`, and stops retrying a receipt after 10 attempts,
  reporting it as `exhausted`.
- Every effect is still fenced by the 3B unique indexes, so two sweeps at once
  are harmless.
- `server.js` runs it every 5 minutes. It can be switched off through the
  `marketing-lead-recovery` job-registry flag.

**Reconciliation (`leadReconciliation.service`) reads `lead_form_submission_data`
through one closed query:**
- Scope: campaign resource name, plus the form asset when known.
- Every id is digits-gated and the dates are strictly validated.
- `ORDER BY submission_date_time, id`.
- The window runs from where GRAV was last sure (`coveredUntil`, or the
  binding's creation), minus 24 hours of overlap, and is clamped to 60 days back.
  It ends tomorrow.
- Dates are widened by a day because Google evaluates the filter in the
  **account's** timezone.
- Pages are 200 rows, at most 10 per run. The (time, id) cursor and any
  continuation token are saved after every page. A token Google refuses is
  dropped, and the next run restarts from the cursor.
- One run per binding at a time, enforced by a lease.
- Each row goes through the **same** normaliser, `ingestion.record` and
  processor as a webhook delivery. There is no second pipeline.

**Coverage (`recovery_*`) is taken from `coveredUntil`, not from the cursor.** A
campaign with no enquiries for a month is fully covered even though its cursor
is old. If GRAV had not been sure for longer than 60 days, the run records
`gapFrom`/`gapUntil`. For 60 days afterwards the coverage reads `recovery_gap`
("some enquiries may be unrecoverable") and does not claim completeness.

**Convergence when webhook `lead_id` and API `id` might differ.** Google never
states the two are the same value.
- If they are equal, the unique index makes webhook→API and API→webhook one
  enquiry.
- If they ever differ, a new enquiry is **held** (`needs_human_review`,
  `possible_duplicate_submission`) with no downstream effect. The trigger is an
  existing enquiry from the **other** route with the same binding, the same
  gclid, and submission times within 2 minutes (or unknown).
- Held enquiries are never merged.
- Two webhook deliveries with different ids are two leads: Google documents the
  id, and the hold does not second-guess it.

## Chunk 3C.1 revisions (2026-09-21)

The v25 reference changed three 3C design points. The full client audit is in
`google-ads-api-v25.md`.

- **The fields are confirmed in v25.** `id` (STRING) and `submission_date_time`
  (DATE, `"yyyy-mm-dd hh:mm:ss+|-hh:mm"`) are both **sortable**; `campaign` and
  `asset` are filterable attributed resources. So `ORDER BY submission_date_time,
  id` is supported as designed.
- **No page size.** v25 refuses `pageSize` (`PAGE_SIZE_NOT_SUPPORTED`), and a page
  is Google's fixed 10,000 rows. The 3C design paged 200 rows at a time and
  stored Google's page token between runs. Nothing Google publishes says a token
  survives between runs, so none is stored now. Tokens are followed only within
  one run, and a run is bounded by 3 pages and 500 **new** enquiries.
- **The cursor is compared by GRAV, not by Google.** GAQL has no `OR` (the
  grammar is `Condition (AND Condition)*`), so "(time, id) after the cursor"
  cannot be written as a filter. The query bounds are whole days: Google
  documents only `YYYY-MM-DD` for date literals, and this field is typed DATE.
  Every row on a page is checked against what GRAV already holds, in one lookup,
  and only new rows are ingested. The saved (time, id) cursor is the last row
  processed, and the next run starts a day of overlap before it. If a run stops
  after 500 new rows mid-page, the rest of that page is simply read again next
  time.

**Operational boundary (new):**
- `GET /api/cms/marketing/lead-forms/recovery` (any Marketing role) returns:
  - per lead form: coverage state, checked-through time, last successful check,
    enquiries recovered, duplicates ignored, and a closed attention reason;
  - company-wide: the recoverable-from time (now − 60 days), leads recorded,
    leads awaiting internal processing, and held-for-review counts.
- `POST …/recovery/run` is administrator only. It accepts no body or query field
  (refused by name). It runs the one reconciler for the caller's company. If a
  run is already going, it answers 409 `alreadyRunning`.
- The scheduler (`leadReconciliationScheduler.runCycle`, hourly) calls the **same**
  `reconcileCompany`:
  - It is controlled by the `marketing-lead-reconciliation` job flag.
  - It skips everything when Google is not configured or the configured version
    is unsupported.
  - It visits only companies with an active (bound, campaign-known) binding, at
    most 25 companies per cycle and 20 bindings each.
  - It logs failures by code only.
  - One company's failure does not stop the next.
- One run per company across every process: `MarketingLeadReconciliationLease`,
  10 minutes, released in `finally`, presumed dead after expiry.
- The internal-processing sweep (`marketing-lead-recovery`, 5 minutes) stays a
  separate job that never contacts Google.

## Still not verified

- **Whether the webhook `lead_id` equals the API `lead_form_submission_data.id`.**
  The design is safe either way (see above). The first real delivery should
  confirm it.
- **How Google evaluates `submission_date_time >= 'YYYY-MM-DD'`** in the
  account's timezone at day boundaries. GRAV widens every bound by a day, so
  this can only cost a re-read, never a missed row. No live query has been run.

`payload_schema_version` semantics — how `api_version` changes the payload
between versions. Google says it "will be used when migrating to a new schema,
and can be ignored for now", so GRAV records it and does not branch on it.
