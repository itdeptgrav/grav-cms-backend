# Meta advertising: binding, preflight, and the design for a later creation slice

Lane A. Backend only. **This slice ends before the first Meta mutation.** There
is no Meta write client, no mutation operation and no creation route — not
disabled, absent.

## What exists after this slice

GRAV can bind a company to one Meta advertising account, verify that account
read-only, resolve a plan's locations and languages to real Meta identifiers,
map an approved plan to a proposed object graph, and explain in a marketer's
language exactly why the campaign cannot be created.

**It cannot be created, and the reason is the same for every plan:** GRAV has
nowhere to keep an advertising image.

## The one supported shape

`Meta Ads → website traffic → single image`. One campaign, one ad set, one
creative, one advertisement, one image, one primary text, one headline, one call
to action, one destination.

Every other shape is refused **by name internally** — video, carousel,
catalogue, lead form, messages, app install, awareness, sales/conversion
optimisation, Advantage+, dynamic creative, multiple ads, multiple ad sets,
automated budget redistribution — and with **one sentence publicly**, which
names none of them. Listing channel features GRAV cannot do publishes a roadmap
nobody wrote.

Approximate mapping is not offered. A carousel plan turned into a single-image
advertisement is a campaign nobody designed, spending a budget approved for
something else, and it looks entirely normal on every screen.

## No hidden defaults

Meta has a default for the objective, the optimisation goal, the billing event
and the special ad category. Every one decides how money is spent or who may see
the advertisement. All are explicit, and a plan that does not say is blocked.

The **special ad category** is the sharpest. Its default is `NONE`, and a
recruitment, credit or housing campaign declared as `NONE` is a policy
violation and, in several jurisdictions, a legal one — discovered from no screen.
Two new plan fields carry these decisions: `metaOptimisation` and
`specialAdCategory`.

The **budget goes on the ad set**, stated rather than assumed: putting it on the
campaign switches on automated redistribution across ad sets, GRAV's supported
shape has exactly one, and nobody asked for it.

## The advertising image blocker

GRAV's content library holds emails, forms and landing pages. It holds no
advertising image. Four things a marketer will reasonably offer instead, each
refused with its own reason:

| Offered | Why not |
|---|---|
| An email's hero image | A URL inside an email body the marketing engine may rewrite, expire or track. Nothing guarantees it resolves tomorrow. |
| An arbitrary URL | GRAV has never inspected it, does not control it, and cannot prove the company may advertise with it. |
| An attachment | No dimensions, no hash, no rights state, no stable identifier to reconcile against. |
| Free text | An instruction to a person, not an asset. |

**The contract a future asset library must satisfy** — defined here, built
nowhere: `assetId` (immutable), `companyId`, `mimeType`, `width`, `height`,
`byteSize`, `contentHash`, `storageOrigin`, `readMechanism`, `rightsState`,
`approvedPlanRevision`, `usable`, `providerUpload`.

Until one exists and passes: `creationReady` is false, no image hash is ever
invented, no mutation is reachable, and the preflight names the blocker in
marketer-readable language with what would fix it.

## Targeting

Meta targets locations by an opaque key it issues and languages by numeric
locale id. Free text resolves to nothing. Five outcomes, the same vocabulary the
Google path uses: `resolved`, `ambiguous`, `not_found`, `unsupported`,
`provider_unavailable`. Four of the five block.

**Meta's search is a suggestion service.** It answers "Cambridge" with a ranked
list and a misspelling with something plausible. GRAV compares exactly; a near
miss is `not_found` with the suggestions offered as candidates, never targeted.

Inclusions and exclusions resolve into **separate lists** and never merge — Meta
keeps them in separate fields, and an exclusion arriving as an inclusion runs the
campaign in the one place somebody said to avoid.

**Age is validated, not resolved**: `age_min` and `age_max` are plain integers in
Meta's own bounds, so a lookup would be pointless. Out of bounds is refused
rather than clamped.

**Audiences cannot be expressed at all.** Interests and behaviours are taxonomy
items GRAV has no lookup for; custom and lookalike audiences are account-level
objects GRAV does not hold. Each is refused by name rather than dropped.

---

# The design for the later creation slice

## Object hierarchy

```
campaign          status PAUSED     depends on nothing
  └ ad set        status PAUSED     depends on campaign
      creative    NO STATUS         depends on nothing
      └ ad        status PAUSED     depends on ad set AND creative
```

**The creative does not deliver.** It is a reusable description of what an
advertisement looks like; nothing is shown because of it, and it cannot be
paused. Asking whether it is stopped has no true answer — the same distinction
the Google campaign budget forced. It must be recorded with
`deliveryStateApplies: false`, never with an invented status.

The other three carry a status, and each must be created `PAUSED`.

## Expected operation order

`campaign → ad set → creative → advertisement`. The ad needs both the ad set and
the creative, so the creative may be created at any point before it, but placing
it third keeps the order linear and the dependency graph a chain.

## Why Meta creation cannot be treated as atomic

**The Google path is atomic because `GoogleAdsService.Mutate` applies a
cross-resource operation list all-or-nothing. Meta has no documented equivalent,
and its batch facility is not one.**

Meta's `/batch` endpoint sends several HTTP requests in one round trip and
supports `depends_on` so a later request can reference an earlier one's result.
That is *request batching with dependency resolution* — it is not a transaction.
The documented behaviour is that each operation is evaluated independently; a
failure part-way leaves earlier operations applied.

So: **do not claim atomicity from batch or `depends_on` support alone.** Unless
Meta's official documentation for the configured API version explicitly
guarantees all-or-nothing application of the whole set, the creation slice must
be designed as a *sequence* with partial-failure handling — the shape the Google
path deliberately moved away from, here because the platform leaves no choice.

## Behaviour after a partial response

Objects exist that GRAV can name. Record every returned identifier, settle the
attempt as `partially_created`, never as success, and require reconciliation.

**Cleanup is limited and must not be claimed loosely.** Meta supports deleting a
campaign, an ad set and an ad, and deletion cascades downward — so removing the
campaign removes its children. But: a creative may be referenced by other ads and
may not be deletable; a delete can itself fail or time out; and "deleted" in Meta
is a status, not an erasure. A rollback may be reported complete **only when
every deletion was individually confirmed by a read**. Anything less is recorded
as an object that may still exist, with its identifier.

## Behaviour after a lost response

The same rule the Google path settled on, for the same reason: **no retry, no
rollback, no assumption.** A request that timed out may have succeeded. The
attempt stays unresolved, the deployment reports that reconciliation is required,
and no further creation is permitted for that deployment command.

## External marker and reconciliation options

Meta's options, in order of strength:

1. **`campaign.name`** — no. Names are not unique, and anybody with account
   access can type one. The same reasoning that rejected it for Google.
2. **A GRAV marker embedded in the campaign name** — weak. Editable by anybody
   in the interface, and a rename silently destroys the evidence.
3. **Ad labels** — Meta supports `adlabels` on campaigns, ad sets and ads,
   created per account and attachable at creation. This is the closest analogue
   to the Google label marker and is the **recommended** option, subject to live
   verification that a label can be created and attached in the same operation
   sequence and read back by name.
4. **`source_campaign_id` / tracking specs** — not identity fields; do not use.

Whichever is chosen, the marker must have the same properties as the Google one:
derived from the deployment command's immutable identity, stable across retries
of that command, different for every other command, opaque, and written to the
attempt intent **before** the first provider call.

## Evidence required before GRAV may report paused-confirmed

A successful response is what GRAV sent, echoed. Before an attempt settles as
`succeeded` and a deployment as `paused_confirmed`, a separate read must confirm
**all** of:

- the campaign, the ad set and the ad exist and are each `PAUSED`
- the creative exists and is linked to the ad
- the marker is attached, and to this campaign
- the ad set's included locations, excluded locations and locales each match the
  resolved targeting exactly
- the ad set's budget, basis and currency match the approved plan
- the campaign's special ad category matches what was approved
- the account is the bound account and the approved revision is the one deployed

Anything short of that is `partially_created`, with every identifier recorded,
and a person is asked to look.

## Operator reconciliation path

Read-only, by marker, against the bound account. The same five classifications
the Google path uses — `not_found_unconfirmed`, `one_complete_bundle`,
`one_incomplete_or_mismatched_bundle`, `multiple_matches`,
`provider_unavailable` — and only the complete match may settle an unresolved
attempt. An immediate not-found must not authorise recreation: Meta's reads can
lag its writes.

## The accelerated slice: assets, audience, creation

Three dependent chunks, delivered together. The image blocker and the audience
blocker are both resolved — but only when a genuinely approved asset and a
genuinely explicit audience exist. Neither is resolved by default.

### The advertising image library

**Storage reuses `companyDrive.service.js`.** A second general-purpose file
system would be two places to secure, back up and get wrong.

Nothing a caller says about a file is believed. A filename is a string somebody
typed; a multipart `Content-Type` is a string a browser guessed.

| What | How |
|---|---|
| Format | Read from the file's own signature. JPEG and PNG only. |
| Dimensions | Parsed from the PNG `IHDR` chunk / the JPEG `SOF` segment. There is no field to supply them in. |
| Hash | SHA-256 over exactly the bytes that arrived — not a re-encoded copy. |
| Size ceiling | 8MB, enforced by multer while the bytes are still arriving, and again before the storage write. |

Refused **by signature**, each with its own reason: SVG (a document that can
carry scripts), HTML, PDF, GIF (may be animated), WebP (GRAV cannot read its
dimensions without a decoder), video. And refused **by field name**: a URL, a
storage id, an email-attachment link, a channel image hash — a pointer is not an
asset.

**No image library was added.** `sharp` and `jimp` are absent from this
deployment, and adding one would pull a native decoder in and point it at
untrusted bytes — which is the one thing the reader exists to avoid trusting.
PNG and JPEG both state their dimensions in a documented header readable without
decoding a pixel. The JPEG walk is bounded and its frame markers are an
enumerated set, not a range: `0xC4` is a Huffman table sitting inside the
`C0–CF` block, and treating the block as a range reads two bytes of a Huffman
table as an image height.

**Uploading is not approving.** An approval is three separate assertions —
authorised to use, approved for advertising, *this exact version reviewed* —
stored on an append-only history row, made by somebody who is not the uploader.
An approved version's identifying fields are frozen on the document path *and*
on every query path, because a `pre("save")` hook alone leaves `updateOne` and
its siblings open.

Identical bytes deduplicate **within one company only**. Two companies uploading
the same stock photograph is ordinary; a global hash index would collide the
second with a row it cannot see and would leak that somebody else has it.

Revocation blocks future use and explicitly does **not** claim to remove a
picture already uploaded to the channel.

The Drive id is `select: false`, absent from every hand-built view, and never
accepted as input. The public identity is a signed token carrying the company.
Bytes come back through GRAV's own authenticated route and are **re-hashed on
every read** — storage is a shared company Drive people can open.

### The one audience: `broad_prospecting`

Broad must be a **decision**, not an absence. An omitted age range is 13-to-65
in most markets; an omitted gender is everybody; an omitted location is wherever
the channel decides. Those produce campaigns that look identical and cost very
differently, and nobody can tell afterwards which happened.

So every field is required: included locations, excluded locations, `ageMin`,
`ageMax`, genders, languages. **`all` genders is a value somebody picks**, which
is why it exists at all — it maps to omitting Meta's `genders` key, and that is
exactly the case that must be a recorded decision rather than a gap.

`targeting_automation` and `targeting_optimization` are **written off
explicitly**. Omitting them lets the channel's default decide whether it may
show the advertisement outside the approved audience, and the write client
refuses a payload where they are absent.

Refused by name: custom audiences, lookalikes, retargeting, interest and
behavioural targeting, uploaded customer lists, Advantage and automated audience
expansion.

One module — `metaAudience.evaluate` — is the single answer, shared by the plan's
readiness gate, the preflight and the mapper, so a plan cannot be approvable by
one standard and refused by another. The audience is part of the targeting
fingerprint, so changing it invalidates an earlier preflight.

### Creation: a sequence, not a transaction

**Five operations, in order:** upload image → campaign → ad set → creative → ad.
The image is first because it is the only step that is not a campaign object: if
the bytes are refused, nothing structural exists.

Every confirmed result is written to the deployment record **before the next
call is made**. That is the entire recovery story for a non-atomic sequence.

The creative carries **no status** — the write client refuses a creative payload
that has one. The other three must carry `PAUSED`, validated recursively
immediately before transport.

**No delete operation exists**, deliberately. Cleanup means issuing more writes
into an account GRAV has just proved it does not understand, and a delete that
itself fails makes the evidence worse. Everything created is stopped, so a
half-built campaign is inert: it shows nothing and spends nothing.

| Failure | Behaviour |
|---|---|
| Refusal at step 1 | `failed`, no external object claimed, nothing to undo |
| Refusal after step *n* | `partially_created`, every confirmed id preserved, **no rollback claimed**, reconciliation required |
| Lost response at any step | Attempt stays **unresolved**, no next write, no retry, no deletion, every confirmed id preserved, next creation refused |
| Success but read-back disagrees | `partially_created`, never success, nothing deleted |

The command fingerprint covers the **image version hash**, the plan revision, the
binding revision and the resolved targeting — so the same idempotency key with a
different picture, audience or account is a different command, not a retry.

### Reconciliation

Read-only. Six classifications: `no_confirmed_match`, `one_complete_hierarchy`,
`incomplete_hierarchy`, `mismatched_hierarchy`, `multiple_matches`,
`provider_unavailable`. Only the first of those settles an attempt, and only
after every object, stopped state, relationship, audience boundary and the image
hash are checked.

An immediate not-found never authorises recreation — Meta's reads can lag its
writes.

The marker uses **ad labels**, which Meta supports on campaigns, ad sets and ads.
Its read-back behaviour is on the live-verification list, so reconciliation also
compares the identifiers GRAV recorded during its own sequence — which is why
every confirmed step is written down before the next begins.

## Verification

`test/marketing/meta-deployment-foundation.test.js` — 30 tests.
`test/marketing/advertising-assets.test.js` — 17.
`test/marketing/meta-paused-creation.test.js` — 17.

All against fake transports. The write client is exercised **for real** — its
closed table, stopped-status gate, creative no-status rule and audience-expansion
gate all run — with only the HTTP call replaced.

**Live verification remains unavailable.** No controlled Meta test account is
configured in this deployment (`META_ADS_*` are unset). Unconfirmed against a
real account:

*Reads* — the account-describe field set and `account_status` numbering; the
`adspixels`, `owned_domains`, `campaigns`/`adsets`/`adcreatives`/`ads` and
`insights` read edges; the `search?type=adgeolocation` and `type=adlocale`
response shapes and `location_types` filter values.

*Writes* — the `adimages` multipart upload shape and the `{ images: { <name>:
{ hash } } }` response; whether `adlabels` can be created and attached within
this sequence and read back by name; the `object_story_spec.link_data` field
names for a single-image traffic ad; `targeting_automation.advantage_audience`
and `targeting_optimization` as the correct way to switch expansion off in
`v21.0`; the `special_ad_categories` array shape; `daily_budget` as a string of
minor units; `start_time`/`end_time` accepting a naked local timestamp in the
account's timezone; and the `campaign.adlabels ANY` filtering syntax.

*Limits* — every character limit and the minimum daily budget.

Each is written to the documented API behaviour for `v21.0` and will need
confirming by whoever has an account to confirm it in. The contract has not been
weakened to make a live proof pass.
