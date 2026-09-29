# GRAV campaign plans, and how one becomes a paused external campaign

Status: the plan record is implemented. Deployment is BLOCKED pending a
deployment-readiness contract — see §9.
Date: 11 September 2026.
Governs: `constants/marketingCampaignDrafts.js`,
`models/CMS_Models/Marketing/MarketingCampaignDraft.js`,
`services/marketing/campaignDrafts/`,
`routes/CMS_Routes/Marketing/campaignDrafts.js`.

Related: `docs/decisions/marketing-advertising-channel-integration.md` (the
read-only channel foundation this will deploy through), ADR-004.

---

## 1. What a plan is

A GRAV document describing a campaign somebody intends to run: name, objective,
description, channels, audience reference and qualification notes, content-library
references, dates, budget with its currency and basis, conversion goal, UTM
campaign identity, owner, state, revision and an append-only history.

It holds no provider campaign id, no provider account id and no credential — not
as an optional field and not as a nullable one. A test reads the service and route
source and fails if either imports a provider client.

## 2. The lifecycle

```
draft ──submit──> awaiting_approval ──approve──> approved ──cancel──> cancelled
  │                     │  │  │
  │                     │  │  └──return──> returned ──submit──> awaiting_approval
  │                     │  └─────reject──> rejected        (terminal)
  └──cancel──> cancelled│
                        └─────cancel──> cancelled
```

`awaiting_approval` is **immutable**. An approver must decide on the document they
read; if the author can keep editing while it waits, an approval attaches to a
version that no longer exists and the audit trail says somebody approved a plan
they never saw.

`returned` and `rejected` are different decisions on purpose. Returning sends a
plan back editable with a required reason; rejecting ends it. Collapsing them would
force an approver to choose between killing a plan and approving one they have
questions about.

Marketing writes, submits and withdraws. An administrator or the CEO approves,
returns and rejects. Sales appears nowhere: accepting a prospect handover is Sales'
decision, and committing marketing budget is not the same authority. An approver
may not approve a plan they submitted themselves, because an administrator may also
author one and otherwise a single person could write, submit and approve a budget
commitment with an audit trail that reads as controlled.

## 3. What `approved` does not mean

It records that a human with authority agreed to the plan. It creates nothing in
any advertising account, commits no budget and starts no spending.

Three things carry that in the payload rather than only in a comment:
`deployed` is always false, `deploymentMeans` states the boundary, and the
`approved` state's own `means` says NOTHING has been created in any advertising
channel.

## 4. Concurrency and idempotency

Every edit states `expectedRevision`, which is required rather than
optional-with-a-default — a default makes the protection decorative. A save whose
payload matches the stored document creates no revision and says `changed: false`,
because bumping it would make every other open editor conflict for nothing.

Every transition is one conditional update with the expected state and revision in
the selector, so exactly one of two racing callers matches. The loser re-reads and
gets either a duplicate (the plan is already where it wanted it) or a conflict
naming where it actually went. Neither gets a database error. The history's unique
`(company, draft, revision)` index is the second line, and a collision there is
treated as already-written rather than surfaced.

## 5. Identifiers

The public plan identifier is an HMAC-signed token over a version, the company and
the internal id, under a signing purpose separate from both the external campaign
identifier's and the page cursor's. Sharing one derived key would let a value
minted for one contract verify under another, and a plan identifier accepted where
an external campaign identifier was expected turns a read of a GRAV document into a
read of an advertising account.

It is integrity-protected, not confidential: the payload is decodable and that is
fine. What it must be is unforgeable. Malformed, forged and foreign identifiers all
produce one 404 with one sentence, because separating them confirms that a given
company's plan exists.

`MCP-2026-0001` is published as a human reference for somebody to quote, and is
**not** accepted as a path parameter. It restarts per company, so one company
cannot infer another's volume from it.

---

## 6. Durability: the plan and its audit trail

Two collections change on one command and this deployment cannot assume a replica
set, so the pair cannot be atomic. The **history row is written first**, carrying
the complete plan for that revision, and the projection onto the plan follows.

That order is a choice about which half survives an interruption:

| Order | What an interruption leaves |
|---|---|
| plan first | the plan changed and nothing records what it was. The gap is **invisible**, and a retry sees the target state, answers `duplicate: true` and never repairs it |
| history first | the trail holds a revision the plan has not reached. Nothing is lost, the gap is **detectable**, and the row holds exactly what to apply |

The history row is unique on `(company, draft, revision)`. That index is the
serialisation point for the whole feature: a retry cannot append twice, and two
racing callers cannot both claim one revision.

`reconcileDraft` replays every missing row in order, each fenced on its own
predecessor, so a hole in the sequence stops the replay rather than being papered
over by jumping to the newest. It runs before every single-plan read and every
write, and `reconcileCompany` runs before the list — the repair happens the next
time anybody looks, which is what replaces the scheduler this deployment does not
have.

A duplicate response is given only when the recorded row and the projected plan
both confirm it. When reconciliation cannot be confirmed, a single-plan read or any
write answers `CAMPAIGN_DRAFT_REPAIR_PENDING` (503) carrying only a GRAV-owned
stage and the revisions. The list answers, and marks the one plan it could not
confirm, because refusing the page would let one bad plan hide every other.

Edits are one conditional update on id, company, an editable state and the exact
expected revision. There is no read-then-save path left: two callers from the same
revision both compute N+1, the history index admits one, and the loser writes
nothing anywhere.

## 6a. Shared identities are claimed before history

The history-first protocol serialises revisions WITHIN one plan, because
`(company, draft, revision)` is unique. It does nothing for identities shared
BETWEEN plans, and that was the remaining flaw.

Two concurrent creates mint different draft ids, so each reserved a perfectly
valid history row with no collision at all — and both rows carried the same
reference, or the same campaign identity, because both derived it from the same
state a moment earlier. The plan collection's unique index then rejected one
projection and left canonical, append-only history that could never be applied.
Reconciliation would retry it for ever.

So every shared identity is claimed atomically in its own collection, **before any
history is written**. A claim that cannot be had is a 409 at a point where nothing
is recorded.

| Collection | Claims | Constraint |
|---|---|---|
| `marketing_campaign_ref_counters` | the reference sequence | unique `(company, year)`, advanced with `$inc` |
| `marketing_campaign_identities` | UTM campaign identities, permanently | unique `(company, utmCampaign)` |
| `marketing_campaign_create_intents` | creation idempotency | unique `(company, idempotencyKey)` |

### The reference

Allocated by incrementing a single counter document, which MongoDB guarantees
atomically without a transaction. Two concurrent callers receive 0001 and 0002;
they cannot both receive 0001, which is what reading the largest existing reference
allowed. The plan collection's unique index on `(company, draftRef)` stays as
defence in depth.

**Gaps are accepted and documented.** A caller that takes 0005 and then fails
leaves 0005 unused. The sequence is a reference, not a count, and nothing reads it
as one. Returning a number on failure would be a second write that can also fail,
and one two callers could then both take. A gap is cosmetic; a duplicate reference
is two plans that cannot both exist.

### The creation intent

Creation is the only command with no prior revision to recognise a retry by, so it
carries an `idempotencyKey` in the body — the same convention the prospect-handover
submission already uses. An `Idempotency-Key` header is accepted as a convenience
and the body wins, because silently preferring a header would make the effective
key depend on something the payload does not show.

The key is bounded (8 to 128 characters of letters, digits and `. _ : -`) and
refuses credential-shaped values, because it is stored durably and appears in logs.

The intent is claimed FIRST, before the reference and before the identity, and it
accumulates what each step allocated. A retry finds it and continues:

| Interrupted between | The retry |
|---|---|
| intent and reference | allocates the reference; nothing else exists yet |
| reference and identity | reuses the stored reference, claims the identity |
| identity and history | reuses both, reserves the history row |
| history and projection | finds its own row and projects it |
| projection and response | returns the finished plan, flagged `duplicate` |

The same key with the same payload continues or returns the same plan. The same key
with a **different** payload is refused with 409 rather than answered with the
earlier plan, which would hide a client bug behind an apparent success. The
fingerprint is taken over the validated plan with GRAV's own generated values
removed — a content reference's `capturedAt` is stamped at validation time, and
hashing it made every legitimate retry look like a reused key.

### The reference is established once, under a fence

Two concurrent callers under one idempotency key both read `intent.draftRef` as
empty, both allocated a number, and both wrote it. Last write won on the intent
while each caller carried on with its own local number, so the intent could record
`MCP-2026-0002` for a plan that is actually `MCP-2026-0001`.

`ensureIntentReference` is now one operation: it reads the established reference, or
allocates a candidate and writes it with a conditional `$set` that matches only
while the field is still unset. Exactly one caller establishes it; the other is
handed the established value and its candidate becomes an unused gap. Whatever that
operation returns is what the intent, the history row and the plan all carry.

An unused counter number from contention is acceptable. An intent disagreeing with
its plan is not.

Both callers succeed. Whoever reserved the history row is the original creation and
the other is reported as a duplicate, so neither sees an identity conflict or a
pending repair for asking the same thing twice.

### Provisional claims versus permanent identities

"Never release an identity" was applied too early. An edit claimed an identity, lost
the revision race, and held the name for ever on behalf of a revision that never
existed — so a typo in a losing request permanently burned a name nobody used.

A claim is therefore `provisional` when made and `committed` when the revision that
wanted it is accepted:

| Situation | Outcome |
|---|---|
| the revision is accepted carrying this identity | committed, permanent |
| another edit wins the revision | the losing claim is released; the name is free |
| the same interrupted edit retries | it recognises its own claim and continues |
| another plan wants an in-flight identity | refused, and told it may become available |
| another plan wants a committed identity | refused, and told it never will |

A provisional claim still blocks, because an in-flight identity must not be stealable
from a request that is still running.

The claim carries a **durable command identity**: a token derived from the company,
the plan, the revision and the identity. Nothing is held in process memory and
nothing depends on a clock, because an interrupted command can rely on neither. A
retry regenerates the same token and adopts its own claim.

Every release is fenced on that token and requires the row to still be provisional,
so cleanup cannot take a claim from a different running request — which matters more
than it looks: a cleanup that removed "any provisional claim on this identity" would
let a live request reserve history for a name it no longer held, recreating the
unapplicable row the whole protocol prevents.

**The recovery path for a crash between the claim and history is decided by data, not
by a timeout.** `reconcileIdentityClaims` asks whether the revision the claim was
made for actually happened and whether it carried this identity. A revision the plan
has already passed with no matching row can never be recorded, so that claim is
provably dead and released. A revision the plan has not yet reached is genuinely
undecided, so the claim is left alone — blocking for exactly as long as the outcome
is unknown, and no longer.

`current` is a projection of which identity the plan carries, so it is re-derived
from the plan on every reconcile rather than maintained only in the success path. No
committed row is ever deleted.

### The claim token identifies the whole command

It used to cover company, plan, revision and the requested identity. Those four do
not tell two commands apart: two concurrent edits can change different names,
budgets, schedules, content or audiences while requesting the same identity at the
same revision. They derived one token, each treated the provisional row as its own,
and the one that lost the history race released the claim the winner was about to
commit — leaving an accepted revision whose identity nothing reserved.

The token now covers the complete validated resulting plan, with only GRAV-generated
values excluded (a content reference's `capturedAt` is stamped at validation time, so
hashing it would make every retry a different command). Consequences:

- the same retried edit derives the same token and adopts its own claim;
- two edits differing in any caller-chosen field derive different tokens;
- a command can only release a claim created for its own exact resulting state;
- a release is additionally fenced on the row still being provisional, so a
  committed reservation can never be taken.

A caller that finds the revision already taken compares the recorded row's resulting
state with its own intended state. Identical means this is the same command — a retry
or an identical concurrent request — so it resumes, answers as a duplicate, and does
**not** release the shared claim. Different means a different command won, and only
then is this command's own provisional claim released.

A stale `expectedRevision` is also checked this way before a conflict is raised: the
caller's payload is reapplied to the state they were editing and compared with the
row that took the next revision. Their own accepted edit is answered as a duplicate
rather than with "reload and re-apply" for a change that already landed.

A commit is confirmed, never assumed. `committed: false` triggers a restore attempt,
and if the reservation still cannot be confirmed the answer is a pending repair or an
ownership conflict — never success. **An accepted history revision must never exist
without its committed reservation**, so reconciliation restores every identity this
plan's accepted revisions carry before publishing the revision as clean, and reports
rather than reassigns one another plan owns.

### Abandoned provisional claims, stated honestly

A provisional claim whose revision has not happened, on a plan no other edit has
advanced, is genuinely undecided. A slow request and a dead one are
indistinguishable, so **GRAV does not expire claims**: a timer would eventually steal
a claim from a live request, which is the failure the fencing exists to prevent.

The honest consequence: if a request crashes, its caller never retries, and no
competing edit advances the plan's revision, that claim blocks that one campaign
identity indefinitely. GRAV does not describe it as "in flight" for ever.

- `blockedClaims({ companyId })` lists them for an operator with the identity, the
  plan reference, the revision claimed and an age in seconds.
- `releaseBlockedClaim({ … })` is the deliberate operator action. It is fenced on the
  claim's token and on the row still being provisional, and it refuses outright when
  an accepted revision carries the identity — that is a reservation the plan needs,
  not an abandoned claim.

Manual on purpose: only a person can know the request is not coming back.

### Pending is not the same as impossible

`CAMPAIGN_DRAFT_REPAIR_PENDING` (503) promises that a later read finishes the job
and that nothing has been lost. That promise is only made when it can be kept.

A history row claiming a reference or an identity another plan owns can never be
applied, so it answers `CAMPAIGN_DRAFT_HISTORY_UNPROJECTABLE` (409) and says it
will not resolve on its own. Reconciliation returns the same terminal answer every
time and writes nothing, rather than retrying an impossible row for ever. Reaching
that state should now be impossible by construction; the branch remains for data
written before this ordering existed.

### The list contract, and where pending creations live

Pending creations used to be appended to `campaignDrafts` as synthetic rows built
from history. That broke the contract three ways at once: a page could exceed the
requested size, `page.total` disagreed with the number of real plans, and the same
synthetic rows reappeared on every page as a reader moved through them.

`campaignDrafts` now holds confirmed plan documents only, filtered by the requested
state and paginated against those plans alone. `page.total` and `page.pages` describe
confirmed matching plans and nothing else.

Anything recorded but not yet projected is returned under `pendingCreations`, whose
scope is the whole company and is deliberately independent of ordinary pages. It is
returned identically on every page, capped at 50 items, with `total` giving the true
count and `capped` saying whether the list was trimmed. It respects the same state
filter.

```json
{
  "success": true,
  "campaignDrafts": [ { "…the plan…": "…", "repairPending": false } ],
  "page":  { "number": 1, "size": 25, "total": 63, "pages": 3 },
  "pendingCreations": {
    "items": [
      {
        "campaignDraftId": "<signed identifier>",
        "reference": "MCP-2026-0007",
        "name": "Winter uniforms 2026",
        "state": "draft",
        "createdAt": "2026-09-11T08:14:02.551Z",
        "readable": true
      }
    ],
    "total": 2, "limit": 50, "capped": false
  },
  "vocabulary": { "…": "…" }
}
```

A pending item carries only those six fields. No repair stage, no revision, no
database id, nothing about a collection or a driver. `readable` says whether opening
that identifier will work; why it would not is an operator's question and stays in
the server log.

A plan that **exists** but is behind its own history is not a pending creation. It
stays in `campaignDrafts` and carries `repairPending: true` when it appears on the
requested page. Existence is determined across the whole company, not from the ids on
the current page — a plan on page three would otherwise look like a pending creation
to page one.

## 7. The campaign identity is never released

Every non-empty `(company, utmCampaign)` is permanently unique across all plans,
including returned, rejected and cancelled ones. The first version scoped
uniqueness to live plans, which released a cancelled plan's identity for reuse —
wrong in a way that surfaces only later, because the moment any plan has been
deployed its identity exists in the channels' click data and in every analytics
report covering that period. Reusing it merges two campaigns into one plausible-
looking row.

Changing the Mongoose declaration is **not sufficient** on an existing database:
Mongoose creates indexes it does not find and does not reconcile one whose options
changed, so the old state-scoped constraint stays live and the application believes
a rule the database is not enforcing.
`scripts/migrations/marketing-campaign-draft-utm-index.js` reports existing
violations, refuses to choose between them, and on `--apply` builds the new index
before dropping the old so there is never a window with no constraint.

## 8. Every mutation needs an attributable actor

A stable authenticated id is required before anything is read or written. Name and
email are display snapshots and are never the authority. Self-approval is prevented
by comparing ids; a plan whose submitter has no recorded id cannot be approved at
all, because GRAV cannot confirm somebody else is approving it — returning it stays
available so nobody is stuck.

---

## 8a. The supported advertising MVP

Two campaign types, one per advertising channel. Everything else is **unsupported**
and named as such — never approximately mapped, because a near-miss mapping puts a
campaign in somebody's advertising account that does not do what the plan said, and
no GRAV screen would reveal it.

| GRAV type | Channel | Channel's term | What it is |
|---|---|---|---|
| `google_search` | Google Ads | Search | Text advertisements on search results, sending people to a GRAV page |
| `meta_traffic_single_image` | Meta Ads | Traffic | One image advertisement sending people to a GRAV page |

Known-unsupported types are listed per channel so a refusal can name what was asked
for: Performance Max, Display, Demand Gen, Shopping, Video and App on Google; lead
form, carousel, video, catalogue, awareness and engagement on Meta.

**The honest gap.** GRAV's content library holds emails, forms and landing pages. It
holds no advertising image, so a Meta single-image brief identifies its image by a
content reference the library cannot resolve. That is recorded as an external check
(`EXTERNAL_MEDIA_USABLE`), not as a local confirmation. A later chunk that adds an
advertising-media kind turns it into a local check.

The internal email engine is not named anywhere in this decision. `email` is a
channel a marketer selects; it publishes no advertisements, so it has no campaign
type and its findings say so rather than reporting an unsupported type.

## 8b. The deployment brief

Per channel, on the plan, obeying the same editable-state and revision rules as
every other field — a submitted plan's brief is frozen.

Shared: campaign type, destination, geographic targeting, languages, audiences,
exclusion decision and exclusions, bidding strategy with its target, budget
relationship, content references, timezone.

Discriminated, because the channels genuinely differ: `googleSearch` takes several
headlines, several descriptions and keyword themes that Google assembles;
`metaSingleImage` takes one primary text, one headline, one call to action and one
image. Forcing those into shared fields would leave a reader unable to tell a
deliberate value from a filler one.

The brief holds no provider campaign, ad-set, ad-group or creative id, no
advertising-account id, no token, no script and no provider API path. The write
boundary refuses those by name at the top level **and one level into every nested
object**, because a nested object is where a field slips past an allowlist that
checks only the top.

## 8c. Readiness: three verdicts, four sections

`GET /api/cms/marketing/campaign-drafts/:campaignDraftId/deployment-readiness`

Marketing and administrators read it. Sales is refused. The company comes only from
authenticated membership and the signed plan identifier stays company-bound. No
provider request is made, no database write happens, and no readiness result is
persisted — a readiness answer is a judgement about a document at a moment, and
storing one would immediately be read as current truth.

| Verdict | Means |
|---|---|
| `planReady` | the GRAV document holds the planning information GRAV needs |
| `approvalReady` | complete enough to put in front of an approver, and not already decided |
| `deploymentReady` | **always false in this release** |

Four sections, because they have different readers and different fixes:
`locallyConfirmed` (facts about the document, each phrased so it cannot be read as a
fact about the world), `missingFromPlan`, `unsupportedByGrav`, `contradictions`, and
`externalChecksRequired`.

The six external checks are returned for every advertising channel, always, whatever
else is wrong: account access, account currency, content still usable, channel policy
compatibility, mapped-object validation, and paused creation. A list that shrank as a
plan improved would suggest some had been answered. None has been asked.

Every finding carries a stable GRAV code, a plain-language title, an explanation, the
affected channel and field, a severity of blocking or advisory, and a suggested
corrective action. No provider error text appears anywhere.

`evaluatedRevision` and `evaluatorVersion` travel with every answer, so a held result
cannot be mistaken for a current one.

A zero budget is a value, not an absence. `approvalMeaning` states in the payload
that approval created nothing, committed no money, activated no delivery, and
confirmed nothing about a provider or a paused state.

## 8c-i. Readiness, submission and approval tell one truth

Readiness used to report `approvalReady: false` while `submit()` moved the same plan
to awaiting_approval and `decide()` approved it. Two parts of one product told a
marketer two different things about one plan, and the part that actually moved the
record checked nothing.

Both gates now call the same pure function the readiness route calls. Approval
re-evaluates as well as submission, because an approval is the consequential step and
a plan may have reached awaiting_approval before the rule existed. Return and reject
stay available, so nobody is stuck with an incomplete plan.

Only **local** blockers count. The six external preflight checks are excluded
deliberately: nothing inside GRAV can answer them, so blocking a submission on them
would make every plan permanently unapprovable.

The refusal is `CAMPAIGN_DRAFT_ADVERTISING_INCOMPLETE` (422) carrying the findings
grouped exactly as the readiness response groups them, plus the evaluator version and
the evaluated revision. Duplicate submission stays idempotent, because the duplicate
short-circuit runs before the gate.

### Applicability is published, not inferred

`applicable: true` when at least one of `google_ads` or `meta_ads` is selected, and
`false` otherwise. A non-applicable plan is never described as missing advertising
information, and `planReady` no longer requires an advertising channel — requiring
one made a legitimate email-only plan read as unready for a reason that did not apply
to it.

A finding for a channel that carries no advertisements lives in its own
`notApplicable` section rather than under "not supported by GRAV", because it is
information about the channel, not an unsupported choice somebody made.

**The exact response for an email-only plan:**

```json
{
  "applicable": false,
  "planReady": true,
  "approvalReady": true,
  "deploymentReady": false,
  "deploymentBlockedBecause": [
    "this plan has no advertising channel, so there is nothing to deploy to one"
  ],
  "sections": {
    "locallyConfirmed": ["BUDGET_RECORDED", "SCHEDULE_RECORDED", "TRACKING_IDENTITY_RECORDED"],
    "missingFromPlan": [],
    "unsupportedByGrav": [],
    "contradictions": [],
    "externalChecksRequired": [],
    "notApplicable": [
      { "code": "CHANNEL_NOT_A_PUBLISHER", "severity": "advisory", "channel": "email" }
    ]
  },
  "counts": { "blocking": 0, "advisory": 1, "externalOutstanding": 0 }
}
```

Such a plan keeps the ordinary plan-approval rules: it submits and approves with no
advertising gate applied.

## 8c-ii. A channel edit cannot orphan a brief

`applyPayload` validated briefs only when `deploymentBriefs` was in the payload, so
removing a channel on its own left a brief for a channel the plan no longer used.

Both obvious resolutions are wrong. Dropping the orphan means GRAV silently deletes
work a marketer typed. Keeping it means the plan carries a brief nothing evaluates and
the next channel change resurrects it.

So the edit is **refused**, before any history row or projection, naming the orphaned
channels and saying to send the revised channel list and the revised briefs together.
No revision, no history row, no identity change and no timestamp is written.

Adding an advertising channel without its brief stays a valid draft — drafting towards
a second channel is a legitimate intermediate state — and readiness reports the
missing brief. Submission still refuses until it is there.

## 8c-iii. The evaluator coerces nothing

The bidding-target check used `Number.isFinite(Number(x))`, so `null`, `""`, `false`,
`"0"` and `"40"` all looked like a supplied zero — the exact collapse the plan
contract exists to prevent, reintroduced inside the judge.

Only a finite JSON number is a supplied amount, and only a non-empty string is
supplied text. Applied across the evaluator: the budget amount, currency and basis,
the schedule dates, the conversion goal, the tracking identity, the timezone, every
creative list and every destination field. Checked in the evaluator rather than left
to the write boundary, because a legacy snapshot can hold any of those values.

A genuine numeric zero remains a value throughout.

## 8d. The deployment record, defined and unused

`MarketingCampaignDeployment` is defined and **nothing writes one**. Not approval,
not readiness, not any route. Tests assert that the plan service, the evaluator and
the router load no writer for it.

It settles where a provider campaign id lives: here, keyed by company, plan, the
exact approved revision and channel, with an idempotency key, a lifecycle of
not-started, preparing, partially-created, paused-confirmed, failed and activated,
append-only attempts carrying what each created, and separate records of who
requested and who approved each consequential step.

`partially_created` exists because creating a campaign is creating several objects
and any of them can be the last to succeed. `paused_confirmed` is the success state
rather than "created", because created is not the claim worth making.

### An attempt is two append-only facts

A single immutable attempt row could not work. It required its outcome, finish time,
created objects and evidence at creation — and none of those facts exists before the
external request starts, while after it finishes the immutable row cannot be changed
to record them. It could only ever be written at a moment when writing it truthfully
was impossible.

Writing it only afterwards is worse, and is the reason the shape matters: a process
that calls a provider and crashes before recording anything has created real
advertising objects that GRAV has no record of. Nobody would know to look, and the
next retry would create a second set.

| Fact | When | Contains |
|---|---|---|
| **Intent** | before any external request | company, deployment, attempt number, approved plan revision, channel and campaign type, command identity, requester, authoriser, started time, planned fingerprint and a counts-only summary |
| **Result** | after the external interaction | company, intent identity, finished time, outcome, GRAV reason code, scrubbed operator note, every object observed or created, paused read-back evidence |

An intent carries **no claimed outcome**: the schema has no such field, so success
cannot be recorded before the request is made. Exactly zero or one result may settle
an intent, fenced by a unique index on `(company, intent)`.

#### An unresolved attempt is a question, not an answer

A missing result means one thing: GRAV recorded that the attempt started and does not
yet know how it ended.

It does **not** mean failed. It does **not** mean safe to retry. It is **not** proof
that nothing was created. Retrying on top of one is how duplicate campaigns are
created, so a future deployment writer must reconcile the advertising account against
the attempt before starting another external creation. `hasUnresolvedAttempt` is the
question it has to ask first.

The shape says so in its own fields rather than leaving a reader to infer it from a
null, because a null is exactly what somebody would read as "nothing happened":

```json
{
  "attemptNo": 1,
  "startedAt": "2026-09-13T09:05:12.441Z",
  "requestedBy": { "name": "Mo" },
  "resolved": false,
  "outcome": null,
  "finishedAt": null,
  "means": "GRAV recorded that this attempt started and does not yet know how it ended.",
  "mustNotBeReadAs": ["failed", "safe to retry", "proof that nothing was created"],
  "requiresReconciliation": true,
  "reconciliationNote": "Objects may exist in the advertising account that GRAV has no record of. The account must be reconciled against this attempt before another external creation is attempted.",
  "plannedSummary": { "objectCount": 4, "objectRoles": ["advertisement", "audience_group", "budget", "campaign"] }
}
```

`partially_created` is its own outcome, not a kind of failure: a failed attempt may
have left nothing, a partial one certainly left something, and recording a partial as
a failure invites the duplicating retry. An object records whether it was `created`
or merely `observed`, so a reconciliation that finds what a crash left behind does
not look like a deployment.

The rollup is `deliveryObjectsNonDeliveringConfirmed`, and it is false for an empty
object list because `[].every(...)` is true and an attempt that created nothing must
not report everything confirmed stopped. It replaced `allPausedConfirmed`, which was
a name that could never honestly be true: a campaign budget has no status saying
whether anything is being shown, so it cannot be paused, and a set containing one
could only satisfy "all paused" by fabricating an answer for it. Each object now says
whether a delivery state applies before it is asked what that state was — see
`docs/decisions/marketing-google-search-deployment.md`.

#### Attempt numbering

Allocated by `$inc` on a per-deployment counter. Not `count + 1` and not "newest plus
one": both read a value a concurrent caller is about to change, so two attempts can
compute the same number — and the unique fence would then reject one *after* it may
already have started an external request, which is the one moment a rejection is
useless.

A consumed number may leave a gap. An attempt number is an identity, not a count, and
reclaiming one would let two different attempts both be called the third. One logical
retry keeps its intent and its number, fenced by a unique
`(company, deployment, commandKey)`.

#### Mutation protection, and its honest limit

Both fact types refuse re-save, the update family, the replace family, the delete
family, and **`bulkWrite` containing any of those** — the path the previous version
omitted, which could have rewritten an immutable row with no hook objecting. A bulk
write of pure inserts is allowed, because insertion is how an append-only fact is
recorded.

Mongoose middleware cannot see `Model.collection.*`. That is stated rather than
papered over: the model enforces what a model can, all future writes go through
`deploymentAttempt.service.js`, and a structural test asserts that no Marketing
service or route reaches these records through the driver. No stronger claim is made
than the model and that service boundary actually provide.

### The policy check no longer promises a sequence

It used to say acceptance is decided by the channel after creation while still
paused. GRAV has never verified that sequence, and a promise about somebody else's
review process is not GRAV's to make. It now says only that policy compatibility
requires an external check against the channel and cannot be confirmed locally.

## 9. External deployment is BLOCKED

Name, objective, schedule and budget are enough to create a **campaign shell**.
They are not enough to create a campaign that can ever serve an advertisement, and
the previous version of this document implied otherwise.

A shell with no ad group, no targeting, no creative and no destination cannot
deliver. Deploying one would produce a paused object in the advertising account
that looks like progress, requires manual completion in the provider's own
interface, and quietly relocates the work GRAV was supposed to be doing.

**The next implementation chunk is deployment-readiness and mapping, not a real
Google or Meta mutation.** No provider write happens until the supported MVP
campaign types are chosen and a provider-neutral readiness contract exists for all
of the following.

### 9.1 The readiness contract

| Requirement | Why it blocks deployment |
|---|---|
| **Supported campaign type per channel** | Google Search, Performance Max, Demand Gen and Display take different required fields and different child objects. Meta's objectives gate which optimisation goals are even legal. Without a chosen, supported subset there is nothing to validate against. |
| **Bidding strategy** | Neither provider will create a campaign without one, and the default is not neutral — it decides how the budget is spent. |
| **Targeting and exclusions** | Locations, languages, audiences, placements, and the exclusions that stop a uniform advertisement appearing beside content GRAV would not sponsor. A campaign with no targeting is either rejected or targets everywhere. |
| **Destination or lead-capture mechanism** | A landing page URL or a provider lead form. An advertisement with no destination cannot be approved by either provider. |
| **Creative copy and media** | Headlines, descriptions, images and video, each within per-provider length and aspect limits. The content library holds assets; what it does not hold is advertisement-shaped creative. |
| **Provider hierarchy** | Budget → campaign → ad group or ad set → creative → ad. GRAV's plan is one level of a five-level tree, and the other four have to be modelled before anything can be created. |
| **Channel-specific validation and mapping** | GRAV's objective and goal vocabulary onto each provider's, with a refusal where no honest mapping exists rather than a nearest guess. |
| **Authoritative content resolution** | Each `contentId` resolved against the library at deployment time and confirmed to still exist and be usable. The stored `capturedName` is a snapshot for an approver and is not evidence the asset is still there. |
| **UTM application** | The campaign identity appended to every destination URL, consistently, without breaking a URL that already carries parameters. |
| **Spend ceiling and currency agreement** | GRAV checks its own ceiling before the request, and the plan's currency must match the advertising account's — a ₹ plan deployed into a $ account is a hundredfold error both sides consider valid. |
| **Paused-state confirmation per object** | Every created object read back and confirmed paused, not just the campaign. A paused campaign with an active ad set is still inert, but GRAV must not claim a state it has not verified. |
| **Partial-creation recovery** | Creating five objects across two providers is five chances to stop halfway. An orphaned budget or a campaign shell with no ad group must be detectable and either completed or cleaned up, and a retry must not create a second set. |

### 9.2 What the deployment-readiness chunk should actually produce

- A chosen, documented MVP campaign type per channel, and a refusal for everything
  outside it.
- A readiness evaluation on an approved plan that answers, per channel, what is
  still missing — in GRAV's words, with no provider call.
- The mapping tables from GRAV vocabulary onto each provider's, with the gaps named
  rather than guessed.
- The `MarketingCampaignDeployment` record, holding the provider object ids. They
  live there, never on the plan, so a plan can never assert something about an
  advertising account.
- No provider write, and no new write capability in `channelHttp.assertReadOnly`.

### 9.3 What the chunk after that needs

Only then: the paused creation itself, behind the four deliberate changes listed in
§9.4, with activation a separate chunk again — turning a paused campaign on is the
step that spends money and deserves its own authority and its own ceiling.

### 9.4 The four changes a provider write will require

None of them happens by forgetting:

1. **A new route file.** This router declares GET, POST and PATCH for plan
   authoring only, and a test enumerates its routes and fails on a new verb or a
   deploy-shaped path.
2. **New named adapter operations.** The three adapters export reads only.
3. **A write intent in `channelHttp.assertReadOnly`.** It refuses every verb but
   GET, and refuses POST unless the call site declares a READ intent. There is no
   write intent, and adding one is the single most consequential line in that
   chunk.
4. **The deployment record**, with its own audit and its own idempotency.

### 9.5 The plan's own state does not change

`approved` stays the plan's state. Deployment is recorded on the deployment record
and reflected on the plan only as `deployed: true` plus a pointer. A plan does not
gain a `deployed` lifecycle state, because its lifecycle is about the GRAV decision
and deployment is an external side effect — merging them would mean a failed
deployment either corrupts the approval or invents a seventh state meaning
"approved but something went wrong out there".
