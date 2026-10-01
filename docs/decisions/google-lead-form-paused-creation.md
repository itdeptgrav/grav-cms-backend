# Google lead forms — paused creation, proof-account only (2026-09-21)

This slice adds preflight and the external write path for `google_lead_form`: a
Google Search campaign with a Google-hosted lead form attached, created
**stopped**. The type stays **not deployable**. Creation is possible only into
the advertising account an administrator names as the proof account, until two
recorded events have happened:
- a creation there has been read back as stopped with its form attached;
- a real enquiry from that form has been delivered to GRAV and processed.

## What Google's v25 contract says (read 2026-09-21)

Sources: Google's "Add lead form asset" sample, and the v25 reference for
`Asset`, `LeadFormAsset`, `LeadFormField`, `LeadFormDeliveryMethod`,
`WebhookDelivery`, `CampaignAsset` and the enums below.

- **The form** is an `Asset` carrying `name`, `final_urls` and
  `lead_form_asset`.
  - Required: `business_name`, `headline`, `description`,
    `call_to_action_type`, `call_to_action_description` and
    `privacy_policy_url`.
  - `fields[]` are `{ input_type }`.
  - `delivery_methods[]`: "Only one method typed as WebhookDelivery can be
    configured".
  - `WebhookDelivery` is `{ advertiser_webhook_url, google_secret,
    payload_schema_version (int64) }`.
- **The link** is a `CampaignAsset` with `{ asset, campaign, field_type:
  LEAD_FORM, status }`.
  - `status` is an advertiser-set `AssetLinkStatus`: ENABLED, PAUSED or REMOVED.
- **Enums verified:**
  - `LeadFormCallToActionType`: 14 values.
  - `LeadFormPostSubmitCallToActionType`: DOWNLOAD, LEARN_MORE, SHOP_NOW,
    VISIT_SITE.
  - `AssetFieldType.LEAD_FORM` and `AssetType.LEAD_FORM`.
  - Every contact field and qualifying question GRAV offers exists in
    `LeadFormFieldUserInputType`.
- **The read-back:** `campaign_asset` attributes only `asset` and `customer`, so
  it is filtered on `campaign_asset.campaign` (a filterable resource name), not
  on `campaign.id`. The query also selects `asset.lead_form_asset.delivery_methods`.
- **Payload schema version:** Google's own sample sets `3`. The webhook
  documentation says the version "can be ignored for now". GRAV sends 3 and
  records where the number came from.

## Decisions

**A lead form rides in the same atomic mutate as the campaign.** The Search
bundle gains two create operations: `assetOperation` (temporary name
`assets/-6`) and `campaignAssetOperation`. The request stays all or nothing, so
none of the Search recovery story changes:
- a refusal creates nothing and needs no undo;
- a lost response leaves the attempt unresolved, and the next creation is
  refused until reconciliation by marker.

**The form's link is PAUSED as well as the campaign.** Starting the campaign
alone in Google Ads must not show anybody the form. The bundle refuses a
lead-form link that is not `LEAD_FORM`/`PAUSED`, on the bytes it is about to send.

**Success means stopped, read back — both halves.**
- The campaign bundle is read back by marker.
- The link is read back by campaign: exactly one, typed LEAD_FORM, PAUSED, to a
  LEAD_FORM asset.
- Anything else is `partially_created`, not success, and the delivery binding
  is not bound.

Whether Google's read echoes the webhook address is **unverified**:
- If it echoes GRAV's address: `deliveryAddressConfirmed: true`.
- If it echoes a different address: a mismatch, so `partially_created`.
- If it echoes none: still a stopped success, with
  `deliveryAddressConfirmed: false`. The first real enquiry settles it.

**The delivery binding is GRAV's row, written before the intent.**
- Prepared idempotently under `<creation key>:delivery`, so a retry of the
  creation finds the same binding, address and secret.
- Bound to the created form (`attachProviderIdentity`) only after the read-back
  confirms it.
- The 3C reconciliation scheduler then finds it automatically as an active
  binding.

**The secret is sent once and kept nowhere.**
- `google_secret` is derived (HKDF, existing `leadWebhookKey`) at the moment of
  sending and injected into the envelope by the bundle.
- It is never part of the mapping, the attempt, the deployment, the binding, a
  response or a log.
- A test scans every collection and captured log line for it.

**The address** is `API_PUBLIC_URL` + `/api/cms/marketing/google-leads/<delivery
token>`. It must be https and not a local address. There is no fallback: a form
pointing at localhost collects enquiries nobody receives.

**THE GATE.** `MARKETING_LEAD_FORM_CONTROLLED_ACCOUNTS` (digits,
comma-separated) names the proof account(s).
- Preflight blocks creation into any other account.
- Unset means no account, which is the safe default.

**A controlled type is not a supported type.** `SUPPORTED_CAMPAIGN_TYPES` stays
the deployable list and remains pinned to the capability matrix.
`CONTROLLED_CAMPAIGN_TYPES` holds `google_lead_form`:
- readiness judges it;
- drafts, deployments and attempts may record it;
- the matrix does not offer it.

**Deployability** is derived from **every** `UNVERIFIED` item in
`constants/marketingGoogleLeadForm.js`: `webhookPayloadSchema`,
`controlledAccountCreation` and `realLeadDelivery`. Each flag records an event,
and no mocked test can set it.

**Fixed while building this:**

| Defect | Effect | Fix |
|---|---|---|
| The lead-form evaluator's "conversion-focused bidding" list named `maximise_conversions`, `target_cpa`, `maximise_conversion_value` and `target_roas` | None is a strategy a GRAV plan can store, so no real plan could ever pass | Now `target_cost_per_action`, GRAV's one conversion-focused strategy (Google `TargetCpa`) |
| The evaluator accepted `sales_handover` as a lead-form goal | Readiness refuses that goal for every type, because nothing connects a campaign to a handover | Goals now come from `GOAL_COMPATIBILITY.google_lead_form` (form_submission, qualified_prospect) |
| The Search preflight asks for a conversion action only if a first-pass mapping (holding just the campaign name) says one is needed | A cost-per-action Search plan is never checked; the row always reads not_applicable | Fixed for lead forms: their preflight reads it directly and blocks on it. **The Search path is unchanged. Flagged as separate work.** |
| The evaluator checked that the call to action was non-empty, not that it was one of Google's values | A free-text label would reach Google | Checked against the v25 enums |

**Not offered in this slice:** asking for marketing permission on a Google form.
Google publishes no permission field whose answer GRAV could evidence, so the
draft refuses `marketingConsent`.

## What remains unverified — and needs the controlled account

1. **Whether Google accepts the envelope as written.** A validate-only pass runs
   before every creation, but no request has reached Google yet.
2. **Whether the lead-form read echoes `delivery_methods` / the webhook URL.**
3. **The lead-form conversion goal.** Google requires the campaign to be
   "optimized towards a Google lead form conversion goal".
   - GRAV neither sets nor reads it. v25's `SUBMIT_LEAD_FORM`/`GOOGLE_HOSTED`
     descriptions did not confirm that this is the right category and origin
     pair.
   - Preflight reports it as an external check. It must be confirmed in the
     account before anybody starts the campaign.
4. **Account eligibility** (policy history, vertical). Google decides.
5. **Real delivery.** The first real enquiry must arrive at the webhook,
   verify, ingest and process. This also retires `webhookPayloadSchema`.
6. **Pre-vetted questions without answer choices.** `single_choice_answers` "can
   be set only for pre-vetted question fields", minimum 2. GRAV sends questions
   as free text. Whether Google requires choices for any of GRAV's questions
   shows up in validate-only.
7. **Google Cloud API access** for GRAV's OAuth client (from 3C.1).

## How to run the proof (administrator)

1. Set `MARKETING_LEAD_FORM_CONTROLLED_ACCOUNTS` to the proof account's
   customer id.
2. Set `API_PUBLIC_URL` to the backend's public https origin.
3. Set `MARKETING_GOOGLE_LEAD_WEBHOOK_MASTER_SECRET_V1` (64 hex characters).
4. Bind that account for the company, then write, submit and approve a
   lead-form plan.
5. `GET …/deployment/google_ads/preflight` must show `creationReady: true`.
6. `POST …/deployment/google_ads/create-paused` with `{ idempotencyKey,
   expectedRevision }`.
7. Check the result: `outcome: "succeeded"`, `leadFormStopped: true`,
   `deliveryBound`.
8. In Google Ads, confirm the campaign and the form link are paused, the
   lead-form conversion goal, and the form's webhook address.
9. Use Google Ads' "send test data" on the form. It arrives with `is_test`,
   exercises the webhook and verification, and creates no production record.
   **It does not prove real delivery.**
10. **Real delivery needs a serving form.** That means a person deliberately
    enabling the campaign **and** the form link in Google Ads, which starts
    spending. GRAV has no activation path and will not add one. It is a
    business decision, taken in Google Ads, with a budget somebody approved.
11. Record the two events by flipping `controlledAccountCreation` and
    `realLeadDelivery` to `verified: true`, with the evidence, in a reviewed
    change.
