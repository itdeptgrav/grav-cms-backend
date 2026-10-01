# The campaign capability matrix

Status: accepted
Date: 2026-09-20
Scope: Marketing. A declaration. No behaviour changed, no campaign type enabled.

## The problem

The Campaign module has to become a professional campaign manager rather than a
plan list, and the obvious way to build one is wrong.

A single campaign form, reused for every channel, is the natural design and it
fails in a specific way: a marketer types "job title: Procurement Manager" into
a Google Search campaign, GRAV accepts it, and the campaign runs against
nothing. The field was there, so it looked like a setting. Nobody finds out
until the money is gone.

The fix is not documentation. It is a table the interface is built from, so a
setting a channel cannot apply is structurally incapable of appearing as an
input.

## What was built

`constants/marketingCampaignCapabilities.js` — 57 provider-neutral settings
across eight sections, four campaign types, and a support state plus a sentence
for every setting on every deployable type.

`GET /api/cms/marketing/campaign-capabilities` publishes it. The builder reads
it at runtime rather than carrying a copy, because a copy goes stale silently: a
field GRAV stopped supporting would keep rendering, and one it started
supporting would stay hidden until somebody noticed.

## Six support states, not two

The decision most likely to be undone by somebody simplifying later, so the
reasoning is recorded.

"Supported or not" collapses three genuinely different answers:

- **`unavailable`** — the channel cannot do it. Permanent.
- **`not_modelled`** — the channel does it; GRAV has not built it. A piece of
  work somebody could ask for.
- **`requires_external_audience`** — reachable today, by supplying a list, with
  no code change at all.

Rendering all three as "unavailable" tells a marketer to give up on two things
they could have had. `required`, `supported` and `externally_verified` complete
the set.

## Firmographics are never a targeting input

`job_role`, `job_seniority`, `industry` and `company_size` are
`requires_external_audience` on both deployable types, on purpose.

No advertising channel verifies where somebody works. What they offer under
those names is self-reported profile data or an interest cluster, so a campaign
aimed at procurement managers reaches people who once showed an interest in
procurement. Offering these as fields would be the single most expensive lie the
builder could tell a B2B advertiser, because the campaign would appear correctly
configured and would spend correctly against the wrong people.

They are reachable by supplying a list, and the state says exactly that — which
is a different answer from "no", and the useful one.

## Declaring is not permitting

`google_lead_form` and `meta_lead_form` are declared with `deployable: false`
and no settings column.

GRAV models no channel-hosted lead form. The existing destination contract says
so in as many words: accepting a plan that said "lead form" would mean deploying
a campaign whose lead capture does not exist — the enquiries would be collected
by the provider and reach nobody. Declaring the types records what is missing so
that adding them is a piece of work rather than a redesign; it does not create
them, and a test asserts the deployable set still equals
`SUPPORTED_CAMPAIGN_TYPE_CODES` from the contract that actually creates
campaigns.

**A note on the brief.** The task described "the existing Google lead-form
scope". There is none: `google_lead_form` was not defined anywhere, and the
existing scope is the explicit *exclusion* of native lead forms. That exclusion
is preserved exactly, and the type is declared as blocked rather than invented.

They have no settings column because publishing one would describe a form that
leads nowhere.

## The lifecycle is declared in full and controlled in part

Twelve states, so the read contract needs no redesign when the missing ones
arrive. Six are reachable.

`scheduled`, `active`, `paused`, `completed` and `archived` are not, each with a
reason. The first four all begin or end spending, and activation is a separate
safety contract that does not exist. `offersControl: false` is what keeps a
button off the screen — a frontend may draw the whole sequence, because showing
somebody where a campaign sits in a process is useful, but it must not offer a
control for a state nothing can reach.

`scheduled` is the one that looks harmless and is not: a campaign that starts by
itself is a campaign that begins spending with nobody present.

`deliveryBoundary` is published on every response: GRAV creates every campaign
stopped and confirms it stopped by reading it back.

## Reads and intelligence, declared honestly

`managementReads` names thirteen campaign-manager views, ten available with the
route that serves them and three blocked with the reason. The blocked ones are
worth recording because each is a request somebody will make:

- **breakdowns** need a different read from each channel, and their parts do not
  add to the campaign total the way people expect — a person in two age bands is
  counted in both.
- **budget pacing** needs a contract comparing spend-to-date against a committed
  budget over a schedule. The figures exist; the comparison does not.
- **lead volume** would require attribution. GRAV counts prospects handed to
  Sales, not leads attributed to a campaign, and publishing a number without an
  attribution contract would be inventing one.

`intelligenceReadiness` declares seven future capabilities with the evidence
each needs, so the campaign contract carries that evidence rather than being
retrofitted. Every one requires human approval, carrying forward the Campaign
Health rule: the assistant may suggest that a person looks at something, and may
not act. Nothing is implemented and no model is called.

## What this deliberately did not do

No model change, no new campaign type, no relaxed validation, no activation, no
frontend file. Creation, readiness, preflight and approval still belong to the
contracts that already own them. This file describes; it permits nothing.

The settings marked `not_modelled` — radius targeting, dayparting, frequency
caps, creative variants, device targeting, placement previews, spend safeguards
— are the work this matrix makes orderable. Each can be added as an entry
changing from `not_modelled` to `supported`, plus the model field and validation
behind it, without touching the shape of this contract or the builder that reads
it. That was the point.
