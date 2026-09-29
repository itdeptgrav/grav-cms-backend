# Google lead-form webhook keys are derived, not stored

Status: accepted
Date: 2026-09-20
Scope: Marketing. Replaces the blocked "needs a credential vault" position.

## The problem

A Google lead form carries a webhook key. Google hands it back inside every
delivery, and GRAV has to decide whether a delivery is genuine by comparing it.

Marketing's binding contract forbids the obvious answer. It is explicit that a
credential never enters the database — *"the credential in deployment secrets,
this in the database — so that a database dump is not an advertising account
and a leaked environment is not a decision about where to spend."* There is no
company-scoped secret store in this repository, and the only encryption utility
(`utils/salaryEncryption.js`) is keyed on `SALARY_ENCRYPTION_KEY` and encrypts
numbers.

So the first pass stopped here and said so.

## The observation that dissolved it

**GRAV never needs to retrieve the key. It needs to recognise one.**

Google lets the advertiser choose the key and only ever presents it back. There
is no flow in which GRAV must read a stored key and show it to anybody. The key
is needed at exactly two moments: once, when configuring the form at Google, and
once per delivery, to compare.

Anything that can be recomputed does not have to be kept.

## The design

One deployment master secret. One deterministic key per company and delivery
binding, derived on demand. Nothing secret in Mongo.

```
key = HKDF-SHA256(
        ikm  = master(version),
        salt = "grav.marketing.google-lead-webhook.v1",
        info = len(purpose)‖purpose ‖ len(company)‖company
             ‖ len(binding)‖binding ‖ len(version)‖version,
        len  = 32
      )  →  base64url  →  43 characters
```

The database stores the binding identity and `secretVersion: 1`. Neither is a
secret. Everything else needed to recompute the key lives in the deployment
environment.

Four details that are load-bearing rather than decorative:

**Domain separation.** The purpose string is the HKDF salt and carries its own
version. Without it, the same master used for a second purpose would produce
related keys, and a weakness in either would become a weakness in both.

**Length-prefixed inputs.** Concatenating fields means `("ab","c")` and
`("a","bc")` produce identical bytes, so two different bindings would derive one
key. Every field carries its byte length, so the encoding is unambiguous
whatever the values are.

**Comparison lives inside the module.** `verifyWebhookKey` takes the candidate
in rather than handing the derived key out. Returning it would be the one moment
the secret exists outside — in a variable somebody may later log, return in an
error, or attach to an object that gets serialised.

**Refusing weak configuration.** At least 32 bytes of material, measured in
bytes rather than characters (a 32-character hex string is 16 bytes — a 128-bit
master in a 256-bit costume), plus a check that the material is not a short
block repeated. That second check exists because the realistic mistake is
`changeme-changeme-changeme-…`: 43 bytes, eight distinct characters, and it
passes both a length test and a distinct-byte floor. It is caught by counting
distinct 4-byte windows — 0.22 for that string, 1.0 for anything random or for
an ordinary passphrase.

## Blast radius — the cost, stated plainly

**One master is a single point of compromise for every company's webhook keys at
once.** Whoever holds it can derive any key for any company and forge deliveries
into any tenant.

That is the trade. Weighed honestly:

| Event | Stored-in-Mongo | Derived |
|---|---|---|
| Database dump or backup leak | every key exposed | **no key material at all** |
| Deployment environment compromised | keys exposed (the decryption key is there) | every key derivable |
| Read-only Mongo access | every key exposed | nothing |

The environment column is a wash: an attacker holding the deployment
environment already holds the Google Ads credentials, which are strictly worse
than the webhook keys — they can spend money. The database column is not a wash,
and a database dump is much the likelier event.

**What an exposed webhook key actually permits** is worth being precise about,
because it bounds the damage: forging lead deliveries into one company's
Marketing records. It does not reach the advertising account, cannot spend, and
cannot create a Sales record — a forged lead becomes a Marketing prospect that a
person still has to qualify and hand over.

## Rotation

A key ring, not a single permanently-named variable. `KEY_RING` maps version to
environment variable; a binding records the version it was created under and
derives with that one for life.

To introduce a generation: add `..._MASTER_SECRET_V2`, add the ring entry, raise
`CURRENT_VERSION`. New bindings use it. **Existing bindings keep deriving with
the version on them**, so nothing in flight breaks.

To retire one: every binding on that version must first be rotated at Google,
which means updating the form's configured key and confirming it. Until then the
old master stays configured. **If an old master is absent, derivation fails
closed** rather than falling through to the newest — deriving with the wrong
generation produces a key that verifies nothing, so every delivery for that form
would be refused as a bad secret and somebody would go looking for an attacker
who was not there.

**Rotation of a live form's key is not automatic and must not be.** It is a
two-sided change: derive the new key, update Google's form configuration,
confirm the update, and only then consider the old generation retired. A
one-sided rotation silently breaks delivery for every form it touches.

## What was explicitly not reused

`SALARY_ENCRYPTION_KEY` (payroll — deriving advertising secrets from it makes
one leak into two across unrelated domains), `MARKETING_CHANNEL_ID_SECRET`
(signs the public identifiers this system hands to browsers, and is therefore
exercised by anyone who can open a page), `JWT_SECRET` (authentication), and
`GEMINI_API_KEY`. The list is in the module as `FORBIDDEN_SOURCES` and a test
asserts none is read.

## Status

The derived-secret boundary is built and tested. The delivery binding, webhook
route, lead record, identity/consent wiring, reconciliation and creation path
are not, and `google_lead_form` remains not deployable until they are.

---

# Addendum — Chunk 3A (2026-09-20)

## Master-secret validation replaced

The randomness heuristic is gone. `MARKETING_GOOGLE_LEAD_WEBHOOK_MASTER_SECRET_V1`
must now be **exactly 64 hexadecimal characters, decoding to 32 bytes**, and
nothing else is accepted.

The heuristic was the wrong shape of check twice over, and it is worth recording
why so it is not reintroduced. Thirty-two genuinely random bytes are
indistinguishable from any other thirty-two bytes, so a test that claims to
detect randomness is really a list of the patterns its author happened to think
of. It waves through the next placeholder nobody predicted — the first version
missed `changeme-changeme-…` entirely — and it refuses legitimate material for
looking unusual, which teaches an operator to work around the check.

A format rule has neither failure. One exact case still needs naming, because
`0000…`, `ffff…` and `aaaa…` are all valid 64-character hex: a value of one
repeated character is refused, as an exact test rather than a score.

**Operators generate it with a cryptographically secure random generator:**
`openssl rand -hex 32`. The refusal message says so. The supplied value never
appears in an error.

## What Chunk 3A added

A delivery binding (`marketing_lead_delivery_bindings`), a signed route token
with its own purpose, the webhook route, an immutable lead-submission record and
a separate test-delivery note.

**The trust order is the design**, and it is fixed: the signed route token says
*which binding*; the binding says *is it still listening*; the derived key says
*is this really Google*; only then do the payload's own identifiers mean
anything, and then only as a correlation check.

Nothing in the body is believed before the key verifies. In particular the
company is never taken from a payload — `campaign_id` and `form_id` are values a
sender chooses, and letting one select a tenant would let anybody who guessed a
campaign number post enquiries into that company's records, where they would
look entirely ordinary.

## Two implementation details that were nearly wrong

**Int64 parsing.** Node 24's `JSON.parse` reviver exposes the exact source text
of each number, so a campaign id above 2^53 keeps its digits without a regular
expression over the raw body. A regex would have had to re-implement JSON's own
rules about strings, escapes and nesting, and would eventually have read a
number out of something that only looked like one.

**An oversized body is answered, not hung up on.** The obvious implementation
destroys the socket at the limit. Google's table treats anything that is not a
4XX as retryable, and a connection reset is not a 4XX — so a body GRAV will
never accept would have been redelivered for as long as Google kept trying.

**Mongoose `immutable` is not usable here.** Combined with `strict: "throw"` it
rejects a document when it is *loaded*, not when it is changed, so a binding
became unreadable the moment it existed. Frozen fields are enforced by an
explicit hook, which is the pattern the rest of this repository already uses.

## Where Chunk 3A stops

A verified production delivery becomes one deduplicated lead-submission record.
**Nothing downstream happens**: no identity is resolved, no engagement recorded,
no consent written, no prospect created, nothing reaches Sales, no reconciliation
sweep runs and no Google campaign is created.

That boundary is structural rather than a matter of discipline — the ingestion
service imports none of those, and a test walks its imports. `google_lead_form`
remains not deployable, and the next missing boundary is identity, engagement and
consent handling.

---

# Addendum — Chunk 3B (2026-09-20)

Identity, engagement and consent. One verified submission becomes a person GRAV
knows, one thing they did, and a decision about marketing permission.

## The receipt is a separate row, and that is the design

The submission is immutable evidence of what somebody typed. Processing state
is mutable — it is retried, resumed and reviewed. A flag written onto the
evidence would make the evidence editable, and six months on nobody could tell
whether a field said what the person typed or what a later process concluded.

The receipt is keyed on **company + submission + contract version**. The version
is part of the identity rather than a label: if the rules below change, an old
receipt describes a decision made under the old rules, and reprocessing is a
different question rather than a quiet overwrite of a conclusion somebody may
have acted on.

## Only two things may identify a person

A normalized email and a normalized phone. Not a name, a company name, a job
title, a postcode, a qualification answer, a campaign or a click id — not as a
fallback and not in combination.

Two people called "R Sharma" at "Acme" are two people, and matching on that
would merge two humans on a coincidence. Every one of those fields is also
self-reported and unverified.

**Normalisation is the repository's**, imported from the handover contract. A
second Google-flavoured phone rule would agree with it today and drift the first
time either changed, and the symptom would be a person matched by one part of
Marketing and not another.

### A conflict waits for a person

Email matching one identity and phone matching another has no safe automatic
answer. Choosing one attaches the enquiry to possibly the wrong human; merging
destroys two records that may be two real people and cannot be undone; creating
a third makes the problem permanent. The receipt stops at `needs_human_review`
and **records no engagement and no consent**, because both would have to belong
to somebody and GRAV does not know who.

## Exactly one engagement, at the submission time

`form_submitted` — already an explicit request in the existing vocabulary. The
source-event identity is derived from the submission, so a replay computes the
same one and the ledger's unique index refuses the second.

`occurredAt` is when the person submitted, as Google reported it — not when GRAV
received it. A recovery sweep can deliver a week-old submission after a newer
one, and ordering a person's history by arrival would put their story backwards.

## Consent: the answer is almost always "no permission", and that is correct

Four things must all be true, and any one missing means nothing is recorded
while everything else about the person is kept:

1. the form asked,
2. GRAV knows exactly what it asked — notice identifier, version, and which
   answer is the permission question, **all from the binding**,
3. the person answered,
4. the answer is on a closed list of agreements, matched exactly.

**The notice never comes from the delivery.** A notice version arriving in a
payload is a value the sender chose, and consent assembled from the sender's own
claims evidences nothing.

**Nothing fuzzy.** No "starts with y", no "not obviously negative". "Very
interested" is somebody saying they want the product, not agreeing to be
marketed to. The asymmetry is the reason: recording permission nobody gave is a
legal claim GRAV cannot support and will not discover until somebody complains;
failing to record one somebody did give costs a marketing email.

**No permission is not a refusal.** Somebody who asked for a quote and was never
asked about marketing has not said no. Recording an opt-out would take an
unrelated decision on their behalf, so the state is "no marketing permission
recorded" and the public wording says explicitly that it is not the same as
saying no.

**The notice is frozen once leads arrive under it.** Changing which question
meant "yes", or which version was shown, would re-describe permission people
already gave — retrospectively, to evidence somebody may have relied on.

## Resuming is checked, not assumed

Each effect is written to the receipt the moment it succeeds rather than in a
batch at the end, which is the only reason a crash is survivable. "A later
record exists, so the earlier step finished" is the tempting shortcut and is
wrong: a record belonging to a different company, submission or contract version
proves nothing about this one, so every resume check carries all three.

## Google is answered before the slow work

The 200 depends only on the submission being durably recorded. Identity,
engagement and consent are several more writes, and holding the connection open
for them risks Google's timeout — at which point it redelivers a lead GRAV
already has. Processing is detached, which is safe precisely because it is
idempotent and resumable: a failure there can never make Google redeliver.

## Where 3B stops

No handover, no Sales record, no Google call, no reconciliation, no campaign
creation. `google_lead_form` remains not deployable, and the next missing
boundaries are **60-day reconciliation** and **external paused creation**.
