# Campaign Health Adviser, and the GRAV AI gateway

Status: accepted
Date: 2026-09-20
Scope: Marketing (Lane A). No CRM, Sales or advertising behaviour changes.

## What this is

The first place in GRAV where a language model sees a customer's data.

It does one thing: explain, in words, what GRAV has already calculated about a
campaign's performance. It cannot change a campaign, an advertising account or
a Sales record, and the design below is mostly about making that guarantee
structural rather than a matter of prompt wording.

## The three risks this is built around

Everything here is one of these, in order of how badly it goes wrong.

**What leaves the process.** A packet carrying an email address, a destination
URL or an account number is, once sent, in a provider's logs and outside GRAV's
control. There is no undo, so the check has to be before transmission and it
has to be on the actual bytes, not on the builder's intent.

**What comes back.** A model will produce a confident sentence containing a
number nobody calculated, a cause nobody established, or a suggestion to pause
somebody's advertising. On a screen, none of those look different from a good
sentence. So the answer is checked against GRAV's own evidence before it is
stored, and a failed check discards the whole answer.

**What it costs.** A ceiling checked after the call is an invoice.

## GRAV calculates; the model explains

The single most important decision.

`services/marketing/intelligence/campaignHealthEvidence.js` is pure and does no
I/O. It compares a complete 7-day period against the 7 before it, using only
days marked `complete`, and produces evidence items that each carry their own
dates, denominators and settled-day counts. It classifies each movement as
improvement, decline, stable, anomaly or insufficient. **It produces no
recommendation.**

The model is never asked to calculate a total, a ratio, a percentage change or
an anomaly threshold. It is handed finished figures and asked to say what they
mean, citing the id of each one it used.

This is what makes the output checkable. A sentence that cites `E1-2` can be
put next to `E1-2` and judged. A sentence containing a number the model derived
cannot.

Three rules inside the evaluator are worth naming because they are the ones
that produce confident wrong answers when they are missing:

- **Unavailable is never zero.** A metric the channel did not report is
  `insufficient`, not a fall to zero. Reporting it as zero would have the
  adviser explain a collapse that did not happen.
- **Reach is never added across days or channels.** It is a count of people; two
  days of reach share people, and adding them produces a number that is not a
  count of anything.
- **Channels stay separate.** Different currencies and different conversion
  definitions, so each deployment gets its own evidence ids and its own
  comparison. A combined figure would be comparable to nothing, and the model
  would explain it just as fluently.

## The gateway is the only model caller on the Marketing surface

### The accurate scope of that claim

GRAV is **not** a repository with one model caller, and an earlier draft of this
document implied it was. Roughly ten direct callers predate this work:

| File | Provider |
|---|---|
| `services/aiAssist.service.js` | Gemini |
| `services/textAssist.service.js` | Gemini |
| `services/callSummary.service.js` | Gemini |
| `services/ai/gravAssistant.js` | a local Ollama model, via `services/ollamaClient` |
| `routes/task_routes/askAI.routes.js` | Gemini |
| `routes/task_routes/meetingSummary.routes.js` | Gemini |
| `routes/task_routes/meetingTranscript.routes.js` | Gemini |
| `routes/CMS_Routes/Measurement/measurementRoutes.js` | Gemini |
| `routes/CMS_Routes/Manufacturing/QC/qcAssistantRoutes.js` | Gemini |
| `routes/CMS_Routes/Inventory/chatbot/inventoryChatbot.routes.js` | Gemini |
| `routes/DevOps/developer.js` | Gemini |

They work and they were not touched. Bringing them behind this gateway — so
that the allowance, the outbound scan, the disabled capabilities and the
GRAV-owned failure codes apply to all of GRAV's model use rather than to
Marketing's — is **later CMS-wide migration work**, and it is a real piece of
work rather than a rename: several of those callers use tool/function calling,
one uses a different provider entirely, and the gateway's closed operation table
would need an entry per use with its own schema and validator.

The claim this slice does make, and a structural test pins it: every file under
`services/marketing/` and `routes/CMS_Routes/Marketing/` reaches a model only
through `services/ai/gravAiGateway.service.js`. Marketing names no provider SDK
and reads no model key.

## The key

`services/ai/gravAiGateway.service.js`. Provider-neutral, with a closed
operation allowlist that currently holds exactly one entry,
`marketing_campaign_health`.

A caller supplies a company, an operation code, a packet, the evidence ids the
answer may cite, and a validator. It cannot supply a model, a URL, a system
prompt, a tool or a generation setting — every one of those would turn a narrow,
auditable capability into a general one.

`run()` performs seven checks in a fixed order, and only the sixth transmits:

1. a known operation
2. configured at all
3. within today's allowance
4. nothing GRAV does not send outside
5. within the input bound
6. **transport**
7. schema validation, then the evidence-citation check

Refusals are **returned, not thrown**. A missing `GEMINI_API_KEY` is not an
error condition for Marketing; it is a capability that is switched off, and
every ordinary Marketing route keeps working. `not_configured` and `unavailable`
are deliberately different codes: one means somebody has to set a variable, the
other means the provider is having a bad day, and a screen that shows one
message for both sends somebody to check a key that was fine.

No tool is ever enabled. `tools: []` is written explicitly rather than omitted,
and grounding, URL context, code execution and function calling are each listed
in `DISABLED_CAPABILITIES` with a reason. Grounding would put text GRAV never
saw into an answer; function calling would let the model act. The whole safety
argument is that it can suggest and cannot act.

## The outbound scan is on values *and* key names

Originally the scan stringified the packet and matched patterns against the
text. That was wrong in both directions, and the way it was wrong is worth
recording.

**It refused ordinary traffic.** Every one of these rules protects something
that reaches GRAV as a *string*. A JSON number in this packet is something GRAV
calculated. Serialising the two together meant `spendMicros: 5000000000` — an
ordinary ₹5,000 — matched the phone-number rule, and so did a ratio of
`-0.37499999999`. This is the dangerous kind of false positive: it surfaces as
"the assistant is broken", and the fix somebody reaches for at speed is to
loosen the pattern, which removes the protection for real phone numbers too.

**And it missed the realistic accident.** A Google campaign id is `3001`; a Meta
one is `120210000000000`. As values they are indistinguishable from an
impression count, so no pattern over values can separate them. The name can.

So the scan now walks the structure, applies the text rules to string leaves,
and applies a separate set of rules to **key names** — any field named like an
identifier, an account, a person, a credential or a destination is refused
whatever it holds. That is what catches the plausible future edit: somebody adds
`externalCampaignId` to the packet to help the model "be specific".

The rules are ordered most-specific-first so the refusal an operator reads names
the thing actually found, and the log line records the *path*, never the value —
a log quoting what it refused would put the protected thing into the log.

For the same reason the evidence packet names its citation field `evidenceId`
rather than `id`. In a packet where a database id must never appear, a bare `id`
is the one field name that cannot mean anything safe.

## What the model may say

Fixed, versioned system prompt (`campaign-health-1.0.0`) plus strict schema
validation. The validator rejects extra keys, wrong types, over-long fields, any
statement without a citation, any citation GRAV did not supply, any
recommendation outside the allowed set, and any prose matching the forbidden
phrases.

Allowed recommendations are seven, and all of them mean *a person should look at
something*: review creative, review targeting, review destination, review
tracking, investigate a performance movement, wait for more settled data, no
action.

Forbidden outright: activate, pause, change budget, change targeting, edit
content, contact a prospect, create or modify a Lead, qualify or convert a Lead,
change a Sales Journey — and, separately, any claim of causation or promise of
performance. The last two are the ones a model produces most naturally, because
they arrive inside ordinary prose attached to a permitted recommendation type
and pass every structural check. "The decline is caused by creative fatigue" is
a claim two periods of aggregates cannot support. "This will improve
conversions" is a promise nobody can keep.

**A failed check discards the entire answer, not the offending item.** A model
that invented one citation may have invented the sentence around it, and
publishing the remainder would be publishing an answer nobody checked.

Campaign text — a plan name, a description — is customer-written and could
contain anything, including something shaped like an instruction. Two defences:
it is not sent at all, and the packet that is sent is labelled as data under a
system prompt that says so.

## The record

`MarketingCampaignAnalysis` is immutable. An analysis is a statement a model
made, at a moment, about specific facts, under a specific prompt version. Every
one of those can change; the statement cannot. Changed evidence, model or prompt
produces a **new** analysis that supersedes the old one, so a recommendation
somebody acted on can still be found beside the figures that produced it. A
partial unique index keeps exactly one `current` row per plan revision while
allowing many superseded ones.

Not stored: the raw provider envelope, hidden reasoning, chain-of-thought. GRAV
keeps the validated result and the evidence it was given, because those are what
can be checked. A raw envelope carries provider metadata and, for some
providers, reasoning traces that are neither reviewable nor safe to render — and
storing it would put all of that in every backup.

Identical evidence under an identical prompt version reuses the stored analysis
and makes no second call, because the model would be asked exactly the same
question.

A **dismissal is a separate append-only fact**, not a flag on the analysis, with
a required free-text reason and the person who gave it. Evaluation has to
include harmful recommendations, not only accepted ones — and a dismissal stored
as a flag on a row that later gets superseded takes that evidence with it. The
reason is free text on purpose: an enum would collect the reasons somebody
anticipated, and the useful signal is always the one nobody did.

Dismissing is deliberately *not* restricted to administrators. The person best
placed to say a suggestion is wrong is the marketer it was written for.

## Cost

Per company, per operation, per day; request and token ceilings both
configurable through the environment and both checked before the call.

Usage is published as **tokens, never money**. Provider pricing changes
independently of this software; a hard-coded rate would be wrong the week it
changed, and a figure labelled in rupees that is wrong is worse than an honest
token count. `estimatedCurrencyCost` is `null` and says why.

Generation is an explicit administrator action on its own route with its own
verb. Reading costs nothing and contacts nobody. A dashboard that generates on
render is how a day's allowance disappears before anybody has read anything.

## The browser never reaches the provider

No key in any response, no proxy route, no signed URL, no client-side SDK. A
browser talks to GRAV; GRAV talks to the gateway; the gateway talks to the
provider. A test walks every file under `services/marketing/` and
`routes/CMS_Routes/Marketing/` and asserts that none of them mentions the
provider SDK or the key variable — the gateway is the only file that may.

## What this does not do

No audience recommendations, no content generation, no lead scoring, no
autonomous action of any kind. The adviser produces words and citations.

## Verification

26 tests in `test/marketing/campaign-health-adviser.test.js`, all with an
injected fake transport. **No live provider call has been made and no real API
key is configured in this environment**, so nothing here is claimed as live
verification.
