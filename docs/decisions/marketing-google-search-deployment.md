# Google Search deployment: binding, preflight, and paused creation

Lane A. Backend only. This is the first chunk in which GRAV changes anything
inside an advertising account.

## What exists after this chunk

GRAV can create one Google Search campaign, stopped, in an advertising account a
named person chose, from a plan a named person approved — and it can tell you
honestly what happened when that goes wrong.

It cannot start a campaign. It cannot deploy to Meta. It cannot change or delete
a campaign after creating it, except as part of rolling back a creation that
failed partway through.

## The five decisions worth reading

### 1. The account is bound, not configured

`GOOGLE_ADS_CUSTOMER_ID` is a deployment secret, and it decides which account the
**read** surfaces report on. Nothing on the write path reads it.

One OAuth identity commonly reaches several advertising accounts — an agency's
own, two clients', a test one. Taking the write target from an environment
variable means the first real campaign is created in whichever one a deployment
variable happened to name. Nobody chose it, nobody finds out until an invoice
arrives, and the campaign sits in somebody else's account carrying GRAV's
tracking parameters.

So `MarketingAdvertisingAccountBinding` records which account **this company's**
campaigns are created in, who decided that, and what GRAV read back from the
account when they did. `accountBinding.forDeployment()` is the only account
source the orchestrator has, and it throws rather than falling back.

A binding holds an account number, a manager account number, a currency, a
timezone, a name and a note. It holds no credential and cannot: the write
boundary is an allow-list over the caller's own keys, every accepted value is
then checked for a credential's *shape* so a token pasted into `note` is refused
too, and the model is `strict: "throw"` as a third line. A binding plus a
credential reaches an account; neither alone does, and they live in different
places so that a database dump is not an advertising account.

### 2. Refuse, never trim

GRAV allows a 120-character headline because a plan is written before anybody
picks a channel. Google allows 30. `googleSearchMapper` refuses, naming the
field, the actual length and the allowance.

Truncating would produce "Winter uniforms for the entire hospi" — money spent on
a sentence that stops mid-word, approved by nobody, discovered weeks later by
somebody reading a Google screen. The same rule covers absences: Google has a
default bidding strategy, a default match type and a default network setting, and
every one of them decides how money is spent. A plan that does not say is a plan
that cannot be deployed.

The mapper is pure — no clock, no random, no database, no `process.env` — so a
preflight can promise exactly what creation will do, and so the command
fingerprint the attempt record is keyed on is stable across retries.

### 3. Not every object can be paused

A campaign budget is a shared money object. It has no status saying whether
anything is being shown, and it cannot be paused.

The earlier attempt contract asked every created object whether it was "confirmed
paused", which for a budget had no true answer: `false` reads as *we checked and
it is running*, and `true` is a fabrication. The rollup `allPausedConfirmed` was
worse — it could never honestly be true for any set containing a budget.

Replaced by three fields per object — `deliveryStateApplies`, then
`nonDeliveringConfirmed` and `stateReadAt` only where it does — and one rollup,
`deliveryObjectsNonDeliveringConfirmed`, which requires at least one
delivery-capable object. A budget is recorded with its identifier, because an
orphaned budget in an account needs something pointing at it, and its delivery
answer is `null` rather than `false`.

The old name is gone from the models, the service and the tests. No production
data migration is needed; nothing had written a row.

### 4. A lost response is not a failure

Three outcomes, and they are different facts:

| What happened | What GRAV does |
|---|---|
| The channel refused | Roll back what was created, confirming each removal individually |
| The channel did not answer | Nothing. No retry, no rollback, no lookup |
| Everything succeeded | Read the delivery states back, then settle |

The middle row is the one that matters. A request that timed out **may have
succeeded**. Retrying it creates a second campaign with nothing recording the
first; rolling back may remove an object a working call created; and looking the
campaign up by name and treating a match as proof is trusting a marker nobody has
verified (see below). So the attempt intent stays unresolved, the deployment goes
to `partially_created`, and the next call is refused with a message telling a
person to reconcile.

A rollback is reported `complete` **only when every removal was individually
confirmed**. A removal whose response was lost counts as unremoved, with its
identifier, because an operator told the account is clean will not go and look.

### 5. Nothing here can start a campaign

Enforced in four independent places rather than asserted once:

1. Google's word for a delivering object appears nowhere in
   `googleAdsWriteClient.js` — a test greps for it.
2. `assertNonDelivering` walks every payload recursively before it is sent and
   refuses any `status`, at any depth, that is not the stopped one.
3. The mutation table is closed: five creates and five removals, no generic
   mutate, no caller-supplied resource, URL or method. There is no `update` verb
   at all.
4. `channelHttp.assertMutation` is a separate function from `assertReadOnly`, so
   the write allowance cannot be reached by a typo at a read call site, and no
   route offers activation.

## What is NOT verified, and must not be relied on

**The campaign-name reconciliation marker.** Google Ads has no user-settable
external id on a campaign, so a campaign's name is the only marker GRAV can
attach and read back. `findCampaignsByName` exists and is used in preflight **to
refuse** — a name already present blocks creation.

It is deliberately **not** used to decide that a lost create succeeded. Campaign
names are not unique in Google Ads, a removed campaign keeps its name, and this
behaviour has **not been verified against a real account**: this deployment holds
no Google Ads credentials (`GOOGLE_ADS_*` are unset; the existing
`GOOGLE_CLIENT_*` are Drive-scoped), so no controlled test account was available.

**Reconciliation after a lost response is therefore operator-driven.** GRAV
records what it had confirmed and refuses to act further. Automating it requires
first confirming, against a real account, that the marker can be read back
reliably — and that work belongs to whoever has an account to confirm it in.

**Audience targeting is not applied**, and that is a disclosure rather than a
refusal. A Search campaign's audiences are account-level lists GRAV does not
hold; unlike a missing location, a missing audience narrows nothing and widens
nothing, because the search terms are the targeting. The preflight says so with
the names that were not carried across.

Location and language targeting **is** applied — see the section below, which
corrected the original behaviour.

## The targeting correction (later pass)

### What was wrong

The first version resolved nothing. A campaign was created with **no** location
and **no** language criteria, and that was reported honestly as a decision:
`GEO_NOT_APPLIED`, with the names that had been dropped.

Honest, and not sufficient. In Google, a Search campaign with no location
criteria targets **everywhere**, and one with no language criteria targets every
language. The campaign was created stopped, so nothing was spent — but a stopped
campaign is one button away from a running one, and the person pressing that
button is inside the advertising interface looking at a campaign that appears
complete. They never see GRAV's disclosure. A disclosure after creation does not
contain that risk; only a refusal before creation does.

### Five answers, not two

Every location and language is resolved against the **bound account**, read-only,
through `geo_target_constant` and `language_constant`, and produces exactly one
of:

| Outcome | Means | Blocks creation |
|---|---|---|
| `resolved` | Exactly one match. GRAV has the stable criterion id. | no |
| `ambiguous` | Several matches. Candidates returned for a human choice. | **yes** |
| `not_found` | No match. Probably spelled differently in the channel. | **yes** |
| `unsupported` | GRAV cannot express this kind of target — a map radius. | **yes** |
| `provider_unavailable` | The channel did not answer. Not a wrong name. | **yes** |

Nothing is chosen automatically. The match is **exact on the name**, narrowed by
Google's own target types for the kind of place the author said it was — not a
suggestion endpoint, not a similarity score. Google will answer "Cambridge" with
a ranked list, and taking the top would target Cambridgeshire when somebody meant
Massachusetts. Nobody reviews a criterion id, and the campaign looks correct on
every screen.

`ambiguous` returns the candidates: criterion id, full canonical name, target
type, country code. Nothing else — no URL, no credential name, no provider error,
no raw row.

### Exclusions are a separate list, and stay separate

`deploymentBriefs.geoExclusions` was added. It is **not** the existing
`exclusions` field, which holds audience exclusions: an audience exclusion
narrows who sees an ad within a place, and a location exclusion says the ad must
not be shown there at all. Collapsing them would make the mapper guess which kind
each entry was, and guessing wrong turns an exclusion into an inclusion.

`negative` is written **explicitly** on every location criterion, including the
`false` case, because proto3 JSON omits a false boolean — an inclusion and an
exclusion that lost its flag are the same bytes on the wire. The write client
refuses a location criterion that does not state it, and refuses one whose flag
disagrees with what the caller said it intended.

It is then **read back**. `negativeConfirmed` is a separate read, exactly like
`nonDeliveringConfirmed`: an exclusion the account stored as an inclusion is not
a success, and an attempt carrying one settles as `partially_created`.

### The gate is before everything

Creation is refused — before the attempt intent, before the deployment record,
before the first provider write — when any location or language is unresolved,
ambiguous, unsupported or uncheckable; when an exclusion cannot be mapped; when a
place is both targeted and excluded; when no location remains; when no language
remains; or when the resolution belongs to a different plan revision or account.

A blocked preflight creates **no** budget, campaign, ad group, ad, keyword,
criterion, attempt intent or deployment record.

### The approved-revision fence

Every resolution carries `resolvedFor` — the plan id, the plan reference, the
approved revision, the bound account id, the binding id and its revision — and a
fingerprint computed over that plus every requested name with the identifier it
resolved to.

Changing any location, exclusion, language, the account binding or the approved
revision changes the fingerprint. Creation re-resolves from scratch and compares
`resolvedFor` against the plan and binding it actually holds; a caller may also
quote the fingerprint from the preflight it looked at, and a plan edited between
that screen and the button is refused rather than created with targeting nobody
reviewed.

### `deploymentReady` is still false

The preflight route publishes `deploymentReady: false` explicitly.
`creationReady: true` says GRAV **could** create this campaign, stopped, in the
bound account right now — not that it has, and not that anything is running.

## The atomic correction (later pass)

### What was wrong

Creation was nine objects in nine calls. Every gap between two of them was a
window with its own recovery story, and the worst of them — a campaign built but
with no location criteria — is a campaign that runs **everywhere** the moment
somebody enables it.

The compensating rollback was the honest best effort and could not be made safe.
Rolling back after a *lost* response can delete objects a request that actually
succeeded created; rolling back after a refusal still leaves whatever GRAV could
not confirm removed. And nothing could answer the only question that mattered
after a timeout: did my request take effect?

### The atomic object graph

One `GoogleAdsService.Mutate` request. Eleven operations for the default plan,
in this order, each temporary resource defined before anything refers to it:

```
 1  labelOperation            labels/-1              ← the GRAV marker
 2  campaignBudgetOperation   campaignBudgets/-2
 3  campaignOperation         campaigns/-3           campaignBudget → -2
 4  campaignLabelOperation                           campaign → -3, label → -1
 5  adGroupOperation          adGroups/-4            campaign → -3
 6  adGroupAdOperation        adGroupAds/-5          adGroup → -4
 7… adGroupCriterionOperation adGroupCriteria/-1000… adGroup → -4   (keywords)
 …  campaignCriterionOperation campaignCriteria/-2000… campaign → -3 (locations)
 …  campaignCriterionOperation campaignCriteria/-3000… campaign → -3 (exclusions)
 …  campaignCriterionOperation campaignCriteria/-4000… campaign → -3 (languages)
```

The label is first because the campaign-label relationship refers to it.
Targeting is last because a campaign criterion refers to the campaign. Temporary
ids are negative, allocated from separate per-kind ranges, and checked for
uniqueness across the whole request — two operations sharing one would make the
second silently overwrite the first's meaning.

`partialFailure` is written explicitly as `false`. Google's default already is,
but the entire recovery story depends on it: `true` would let the budget and
campaign be created while the location criteria failed, and report success.

Three outcomes, and only three:

| | |
|---|---|
| The channel refused | Nothing was created. Nothing needs undoing. |
| The channel accepted | The complete bundle exists. |
| No response arrived | Unknown, until reconciliation by marker. |

**The sequential path is gone.** `googleAdsWriteClient.js` is deleted; there is
no per-object create, no `remove`, and no compensating rollback anywhere. A test
walks every file under `services/marketing` and `routes/CMS_Routes/Marketing`
and asserts that none but `googleSearchBundle.js` contains `:mutate`,
`mutateOperations` or `mutationIntent`, and that nothing imports the old client.

### The marker

`GRAV-D1-<32 hex>` — 40 characters, inside Google's 80-character label limit.

An HMAC, under its own signing purpose, over the deployment command's
**immutable** identity: company, binding, account, plan, approved revision,
command key, channel, campaign type. Nothing derived from the plan's editable
content is in it.

- **Stable** across retries of the same command — which is what makes a lost
  response recoverable rather than a permanent unknown.
- **Different** for a different company, binding, account, plan, revision or
  command — so one company's reconciliation can never match another's campaign.
- **Opaque.** No credential, no database id, no person's name, no plan name, no
  business text. An advertising account is visible to agencies and contractors,
  and a label is visible to all of them.
- **Refused when incomplete.** A marker derived from a missing field would be
  stable, look valid, and collide with every other incomplete command's.

It is derived **before** the attempt intent, stored on the intent and on the
deployment record, created as a label in the atomic request, and attached to the
campaign **inside that same request**.

### Why a campaign name is not identity

Names are not unique in Google Ads. Two GRAV plans can legitimately produce the
same name. A removed campaign keeps its name for ever. Anybody with account
access can create, rename or copy a campaign into that name by hand. A name
match is a coincidence that looks like proof, and acting on it either abandons a
real campaign or creates a second one.

`findCampaignsByName` therefore exists only to **refuse** a duplicate name at
preflight. It is never evidence of what a lost request did.

### The lost-response state machine

```
            one atomic write
                  │
    ┌─────────────┼─────────────┐
 refused      accepted        silence
    │             │               │
 settle       read back       intent stays UNRESOLVED
 as failed,   by marker       deployment: partially_created
 no objects        │          next create: REFUSED
 no rollback  ┌────┴────┐
              │         │
         matches    disagrees / unreadable
              │         │
        succeeded   partially_created
        paused_     + reconciliation required
        confirmed
```

Reconciliation (read-only, by marker) classifies as:

| Outcome | Settles? | Then what |
|---|---|---|
| `one_complete_bundle` | **yes** | attempt settled `succeeded`, objects recorded `observed` |
| `one_incomplete_or_mismatched_bundle` | no | administrator |
| `multiple_matches` | no | administrator; GRAV picks none |
| `not_found_unconfirmed` | no | stays unresolved — reads can lag writes |
| `provider_unavailable` | no | stays unresolved |

`not_found_unconfirmed` is deliberately **not** terminal and never authorises a
second create. A channel's reads can lag its writes, and acting on an immediate
empty answer is how a second complete campaign gets created on top of a live
first.

**One deployment command can cause at most one provider write while its outcome
is unknown.** Enforced in three places: an unresolved attempt refuses the next
`createPaused` before any envelope is built; a second idempotency key for one
plan revision conflicts on the deployment record; and `attempts.begin` refuses
the same key with `reconciliation_required`. Reconciliation itself has no access
to the bundle client.

### Read-back requirements

A successful mutate response is what GRAV **sent**, echoed. It is not evidence.
Before an attempt settles as `succeeded` and a deployment as `paused_confirmed`,
the bundle is read back by marker and every one of these must hold: the campaign,
its ad group and its ad exist and are stopped; every keyword exists and is
stopped; the marker relationship is present; the location inclusions, the
location exclusions and the languages each match the resolved targeting exactly;
and the campaign is a Search campaign. The account and the approved revision are
proved by the marker itself, since it is derived from both.

Anything short of that is `partially_created` with every identifier the response
gave, and a person is asked to look.

### Validate-only

`validateOnly: true` is a request-level flag on `GoogleAdsService.Mutate` and
applies to every operation in this bundle, so the validation pass sends the
**same envelope** as the create — byte for byte, built by the same pure function.
There is no separate approximate payload to drift. A refusal at that pass settles
the attempt as a provider refusal with no external object claimed.

## Verification

`test/marketing/google-search-deployment.test.js` — 55 tests: 19 numbered proofs
for the creation foundation, 18 (numbered 20–37) for targeting resolution and its
gate, 11 (numbered 38–48) for the marker and lost-response reconciliation
including one structural proof of the closed mutate boundary, and seven route
tests. `deployment-readiness.test.js` — 119.

Every provider call is a fake. The write client runs for real — closed table,
status assertion, exclusion-integrity assertion, URL building, parent-field
mapping — against a fake transport and a fake credential lookup. The read-backs
are derived from what the transport actually recorded, so "what the account
holds" and "what GRAV sent" are the same thing unless a test deliberately makes
them disagree. Route tests spy the real client module, so the route, the
preflight, the resolver and the privacy boundary all run for real.

**Live API verification remains unavailable.** No controlled Google Ads account
is configured in this deployment (`GOOGLE_ADS_*` are unset; the existing
`GOOGLE_CLIENT_*` are Drive-scoped), so nothing here has been confirmed against a
real account. Unconfirmed: the geo and language constant queries; the campaign
criterion mutate shape; the `campaign_criterion.negative` read-back; that
`GoogleAdsService.Mutate` accepts `labelOperation` and `campaignLabelOperation`
alongside the campaign operations in one request; that negative temporary
resource names resolve across all eight operation kinds used here; that
`validateOnly` covers every one of them; and the `campaign_label` / `label`
query shapes used for reconciliation.

The contract has not been weakened to make a live proof pass — every one of
those is written to the documented API behaviour, and each will need confirming
by whoever has an account to confirm it in.

## Operational note

`MarketingAdvertisingAccountBinding` adds a partial unique index,
`companyId_1_channel_1_live`, over the non-withdrawn states. It is created on
first use in a new database. An existing database gets it on model
initialisation; no migration script is needed because the collection is new.
