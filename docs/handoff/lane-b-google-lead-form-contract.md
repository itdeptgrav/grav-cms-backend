# Lane B — Google lead forms

Date: 2026-09-20 · Backend: Lane A · Nothing committed.

## Status: not yet available to build against

`google_lead_form` is published by
`GET /api/cms/marketing/campaign-capabilities` with **`deployable: false`**.
Show it in the campaign-type list, greyed, with its `blockedBy` sentence. Do not
build the lead-form builder step yet — the form contract below is settled and
will not change shape, but nothing can be created until GRAV can receive a
submitted lead.

```jsonc
{
  "campaignType": "google_lead_form",
  "label": "Lead form",
  "channel": "google_ads",
  "deployable": false,
  "blockedBy": "GRAV cannot yet receive a lead submitted through a Google form, so a campaign like this would collect enquiries that reach nobody. The form itself is fully modelled and validated; only delivery is unproven.",
  "needs": [ "the shape of what Google sends when somebody submits a form, …", … ],
  "localContract": { "complete": true, "means": "The form definition, its validation and Google's eligibility rules are modelled and tested." },
  "settings": [], "sections": []
}
```

`localContract.complete` is what tells you the form design is safe to build
against in advance; `deployable` is what tells you whether a campaign can be
created. They are deliberately separate.

---

## What a lead form is, in marketer terms

A form hosted by Google, opened straight from a search advertisement, so
somebody can enquire without going to the site. GRAV collects the enquiry,
matches it to a person it may already know, and it becomes a Marketing prospect
— the same prospect the existing qualification and handover process already
deals with. **It never becomes a Sales record directly.**

---

## The form definition

Six pieces Google requires. A form missing any of them cannot be created.

| Field | Means |
|---|---|
| `businessName` | The business being advertised |
| `headline` | What the form is asking for |
| `description` | A fuller description |
| `callToAction` | The words on the button that opens it |
| `callToActionDescription` | What somebody gets by filling it in — the line people actually read |
| `privacyPolicyUrl` | **Must be a full `https://` link.** Google refuses a form without one |

Optional: `postSubmitHeadline`, `postSubmitDescription`,
`postSubmitCallToAction` — the thank-you screen and what somebody may do next.

### Contact details you may ask for

`FULL_NAME`, `FIRST_NAME`, `LAST_NAME`, `EMAIL`, `PHONE_NUMBER`, `CITY`,
`POSTAL_CODE`, `COUNTRY`, `COMPANY_NAME`, `JOB_TITLE`.

Two rules the builder must enforce, both refused by the backend anyway:

- **`FULL_NAME` cannot appear with `FIRST_NAME` or `LAST_NAME`.** Google's own
  rule — offer the two shapes as a choice, not as ten checkboxes.
- **At least one of `EMAIL` or `PHONE_NUMBER`.** GRAV's rule, not Google's:
  Google will accept a form collecting only a city, and an enquiry nobody can
  reply to is one nobody can act on.

### Qualifying questions

Eight offered, each with wording Google authors and GRAV shows verbatim:

| Code | The question as shown |
|---|---|
| `JOB_ROLE` | What is your job role? |
| `JOB_INDUSTRY` | What industry do you work in? |
| `JOB_DEPARTMENT` | What is your job department? |
| `COMPANY_SIZE` | What size is your company? |
| `ANNUAL_SALES` | What is your annual sales volume? |
| `LEVEL_OF_EDUCATION` | What is your highest level of education? |
| `CATEGORY` | Which category are you interested in? |
| `OFFER` | Which offer are you interested in? |

**Maximum five per form** — Google's limit. No duplicates. **No custom
questions**, deliberately: using one switches off every pre-defined question on
the same form, and produces free text nothing can group or compare.

### Answers are what somebody said, never a verified fact

**This is the single most important line in this document for the interface.**

Google does not check `JOB_ROLE`, `COMPANY_SIZE`, `ANNUAL_SALES`,
`JOB_INDUSTRY`, `COMPANY_NAME` or `JOB_TITLE` against an employer, a registry
or anything else. Somebody typed them, or picked them from a list, about
themselves.

Render every answer with its question and label it as self-reported. Never show
a badge, a filter or a summary that presents one as established — a "verified
procurement manager at a 500-person company" built from these is a claim nobody
made. `ANSWER_PROVENANCE.label` is `"Answered by the person"`; use it.

---

## Readiness — why a form is not ready

The same evaluation answers the readiness screen, the submission gate and the
approval gate, so they can never disagree. Each check is
`{ code, status, means, … }` with `status` one of `passed`, `failed`,
`external`, `not_applicable`. Render `means` as-is.

**Blocking, and visible before anybody tries to create anything:**

`form_content_complete` · `privacy_policy_present` · `fields_supported` ·
`fields_compatible` · `reachable` · `questions_supported` ·
`questions_within_limit` · `questions_distinct` · `consent_notice` ·
`lead_form_conversion_goal` · `conversion_bidding` · `serving_country` ·
`account_bound`

**Three of those deserve their own explanation in the interface,** because they
are the ones that produce a campaign which looks like it worked:

- **`conversion_bidding`** — Google only shows a lead form on a campaign using
  conversion-focused bidding. GRAV's default is click-maximising, which would
  create a campaign that runs, spends its budget, and never shows the form.
- **`lead_form_conversion_goal`** — the campaign must be judged by an outcome a
  form produces. Judged by page views, the form never appears.
- **`serving_country`** — Google does not serve lead forms in every country. A
  campaign aimed only at countries on that list collects nothing. A mixed
  selection passes and reports which will not show.

**External, and never shown as locally confirmed:**
`account_vertical_eligible` and `responsive_search_ads_only`. GRAV cannot read
an account's policy history or vertical from a plan. Show these as "Google
decides when the campaign is created" — a confident local pass followed by a
provider refusal is worse than an honest unknown, because people plan around it.

---

## Consent

**Submitting an enquiry is not permission to market to somebody.** A person
asking for a quote has asked for a quote.

`consent_notice` is `not_applicable` when the form does not ask — and that is
not a problem to fix. The enquiry is still a person GRAV may reply to about
what they asked for; there is simply no marketing permission recorded.

If the form does ask, it must carry both the exact wording shown
(`marketingConsent.noticeText`) and its version (`noticeVersion`). Without
both, the check **fails** rather than recording weak consent: permission whose
wording nobody kept cannot be evidenced later, and unevidenced consent is worse
than none because it will be relied on.

---

## Leads, once they arrive — the shape, not yet the route

Not built. Specified here so the screens can be designed against the final
vocabulary.

A received enquiry will carry: a GRAV submission reference, the campaign it came
from, when it was submitted, the contact details given, the qualification
answers with their questions, consent evidence where it was explicitly captured,
and an ingestion state. **No Google account id, form id, campaign id, API path,
credential or raw payload will ever appear** — the same boundary every other
Marketing response holds.

Duplicates will not create a second enquiry, a second person or a second
prospect. Google's webhook carries a shared secret rather than a signature, so a
body anybody has seen can be replayed — deduplication on the submission id is
part of the contract rather than an optimisation.

**Recovery is real but bounded: Google keeps submitted leads for 60 days**, and
a missed delivery can be read back within that window. After 60 days it is gone
from Google. Do not design a screen that implies older leads can be recovered.

---

## The Sales boundary

An enquiry becomes a **Marketing prospect**, not a Lead. The existing
qualification and handover process decides when Marketing may submit it to
Sales, and Sales alone decides whether to accept, return or reject it.

Do not label these people leads anywhere in the interface, and do not build a
control that sends one to Sales directly.

---

## What is not being built

Meta Lead Ads, offline conversion uploads, campaign activation and automatic
budget changes are all out of scope. There is no Activate, Launch or Publish
control for any campaign type, and none should be built — see the
`deliveryBoundary` on every capabilities response.

---

# Chunk 3A — leads now arrive and are stored

**Nothing is built for Lane B to render yet.** There is no read API for leads in
this chunk. This section publishes the stored shape so the screens can be
designed against the final vocabulary, and states plainly what has *not*
happened to a stored lead.

## What works now

A Google lead form configured against a GRAV delivery address can post a
submitted enquiry, and GRAV verifies it and records it once. That is the whole
of Chunk 3A.

## The normalized lead-submission record

```jsonc
{
  "submissionRef": "MLS-3f9a2c…",        // GRAV's public identity for the submission
  "channel": "google_ads",
  "draftRef": "MCP-2026-0001",           // which campaign plan
  "approvedRevision": 3,
  "submittedAt": "2026-09-20T12:30:00Z", // when the person submitted
  "receivedAt":  "2026-09-20T12:30:04Z", // when GRAV received it

  "contact": {                            // only the fields that were asked for
    "fullName": "", "firstName": "", "lastName": "",
    "email": "", "workEmail": "",
    "phone": "", "workPhone": "",
    "postalCode": "", "streetAddress": "", "city": "", "region": "", "country": "",
    "companyName": "", "jobTitle": ""
  },

  "answers": [                            // qualifying questions
    { "code": "JOB_ROLE",
      "question": "What is your job role?",   // the wording Google showed
      "answer": "Procurement Manager",
      "selfReported": true }
  ],

  "unmapped": [                           // a question GRAV does not recognise
    { "code": "PREFERRED_DEALERSHIP", "answer": "North branch",
      "selfReported": true, "needsReview": true }
  ],

  "phoneVerified": true,                  // or null — see below
  "clickId": "Cj0KCQ…",
  "leadSource": "LEAD_FORM",              // or "CONVERSATIONAL_AGENT"
  "leadStage": "",
  "ingestionOrigin": "delivery",          // "recovery" once the sweep exists
  "classification": "production"
}
```

### Three things the interface must get right

**Always render an answer with its question.** "201-500" means nothing on its
own. `question` is the exact wording Google displayed.

**`selfReported: true` is on every answer, and it means it.** Google checks none
of `JOB_ROLE`, `COMPANY_SIZE`, `ANNUAL_SALES`, `JOB_INDUSTRY`, `COMPANY_NAME` or
`JOB_TITLE` against an employer or a registry — somebody typed or picked them
about themselves. Never show one as a verified fact, never build a filter that
presents it as firmographic truth.

**`phoneVerified` is the one exception, and it is narrower than it looks.** It
means Google confirmed the phone line answers. It says nothing about who owns
it, where they work or what they do. `null` means Google did not report it — not
that the number is unverified.

`unmapped` answers are kept verbatim and deliberately not interpreted. Show them
as "an answer to a question GRAV does not recognise", with `needsReview`.

### Never in any lead response

No raw payload, no webhook key, no `column_name`, no route token, no request
headers, no advertising account, form or campaign identifier, no database id.
The provider ids exist as backend correlation evidence and are `select: false`.

## Test deliveries are separate and carry no person

Google sends test leads from a button in the advertising interface, carrying
"John Doe" and a real-looking phone number. GRAV records four facts — which
binding, when, which schema version, and that verification passed — and
**discards the sample name, email and phone before writing**.

They are in their own collection and never appear in production leads or counts.
If you build a "connection tested" indicator, this is its source. Do not build
anything that shows a test person.

## What has NOT happened to a stored lead

**This is the important part for Chunk 3A.** A lead in this collection is
evidence that somebody submitted a form. Nothing has acted on it:

| | |
|---|---|
| Marketing identity resolved | **no** |
| Engagement recorded | **no** |
| Marketing consent written | **no** |
| Prospect handover created | **no** |
| Any Sales record | **no** |
| Recovered via the 60-day sweep | **no — the sweep does not exist yet** |

So do not design a screen that implies a lead is a prospect, shows a person's
Marketing history, or offers to send one to Sales. Those arrive in the next
chunk, along with the read API that will surface all of this.

The record itself is append-only and carries no processing state on purpose:
identity, consent and handover decisions are things GRAV *later decided*, and a
decision stored on the evidence it was drawn from can be revised until the
evidence appears to have always said so. They will arrive as separate
projections beside this row.

## Campaign type

`google_lead_form` is still `deployable: false`. The next missing boundary is
identity, engagement and consent handling. `meta_lead_form` is untouched.

---

# Chunk 3B — a lead now becomes a person

**Still no read API.** This publishes the states a screen may show, so the
interface can be designed against the final vocabulary.

## What happens to a lead now

After a verified production delivery is recorded, GRAV resolves who submitted
it, records one engagement, and decides whether the submission proves marketing
permission. That work is detached from the webhook — Google is answered as soon
as the enquiry is safely stored — so a lead can briefly exist before it has been
processed.

## The states you may show

```jsonc
{ "submissionRef": "MLS-3f9a2c…",
  "states": ["new_person_created", "engagement_recorded",
             "no_marketing_permission_recorded"],
  "finished": true,
  "updatedAt": "…" }
```

| State | Means |
|---|---|
| `lead_recorded` | Somebody submitted the form and GRAV has their enquiry. |
| `matched_existing_person` | The enquiry belongs to a person already in Marketing. |
| `new_person_created` | GRAV had not seen this person before and has added them. |
| `needs_identity_review` | GRAV cannot tell which person this is and will not guess. |
| `engagement_recorded` | Submitting the form is recorded as something they did. |
| `marketing_permission_recorded` | They explicitly agreed to the wording the form showed. |
| `no_marketing_permission_recorded` | No permission recorded. **Not a refusal.** |
| `processing_incomplete` | GRAV has the enquiry and has not finished with it. |

**Never published:** stage names, retry counts, reason codes, person keys,
database ids, provider identifiers, driver errors.

## Three things the interface must get right

**`no_marketing_permission_recorded` is not an opt-out.** It is the normal
outcome for most lead forms, because most do not ask. Somebody who requested a
quote and was never asked about marketing has not said no — showing this as
"opted out" or "unsubscribed" would misrepresent them and suppress a person who
declined nothing. Use wording like "no marketing permission recorded", and make
clear their enquiry still stands.

**`needs_identity_review` is a queue, not an error.** It means the email matched
one person GRAV knows and the phone matched another, or that there was no usable
email or phone at all. GRAV will not guess or merge. These need a human, and the
enquiry is safe until one looks.

**`processing_incomplete` is ordinary and usually brief.** A lead is recorded
before it is processed. Do not show it as a failure; if it persists, that is
worth surfacing, but the first few seconds are normal.

## What still has NOT happened

| | |
|---|---|
| Prospect handover created | **no** |
| Any Sales record | **no** |
| Recovered via the 60-day sweep | **no — the sweep does not exist** |
| Google campaign or form created | **no** |

A processed lead is a person GRAV knows who did something. **Whether they go to
Sales is the existing qualification and handover contract's decision** — do not
build a control that sends one directly, and do not call these people leads in
the interface.

## Campaign type

`google_lead_form` is still `deployable: false`. The remaining boundaries are
**60-day reconciliation** and **external paused creation**.
