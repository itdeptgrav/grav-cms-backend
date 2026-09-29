# Lane B — Campaign capability matrix and builder contract

Date: 2026-09-20 · Backend: Lane A · Nothing committed.

```
GET /api/cms/marketing/campaign-capabilities                 the whole matrix
GET /api/cms/marketing/campaign-capabilities/:campaignType   one type's column
```

Any Marketing role. Read-only, static, identical between calls — safe to fetch
once and cache for the session.

---

## What this is for

**Build the campaign form from this response, not from a design document.**

The failure this prevents is specific: a builder that shows the same fields for
every channel. A marketer types a job title into a Google Search campaign, GRAV
accepts it, the campaign runs against nothing, and nobody finds out until the
money is gone. The field existed, so it looked like a setting.

Every setting, for every campaign type, carries a support state and a sentence.
Render inputs for what is settable; show the rest disabled with `why` attached,
or not at all — but never invent a reason, and never show a field the matrix
does not mark settable.

---

## The six support states

| `support` | `settable` | Render as |
|---|---|---|
| `required` | yes | An input. A plan is refused without it. |
| `supported` | yes | An input. |
| `externally_verified` | yes | An input, noting GRAV confirms it against the advertising account. |
| `not_modelled` | no | Disabled, "not available in GRAV yet". **The channel does this; GRAV hasn't built it.** |
| `unavailable` | no | Disabled or hidden. **The channel cannot do it at all.** |
| `requires_external_audience` | no | Disabled, with the `why` — it is reachable, by supplying a list. |

**Do not collapse the last three into one "unavailable".** They mean three
different things to the person reading the screen: one is a permanent fact, one
is a piece of work they could ask for, and one is a task they can do today in
the advertising account. Telling somebody to give up on two of them is the
practical cost of merging them.

`supportStates` is on every response with the label and meaning of each — render
one legend from it rather than hard-coding six strings.

---

## Response shape

```jsonc
{
  "success": true,
  "steps": [ { "code": "goal", "label": "Goal and measurement", "step": 1, "means": "…" }, … ],
  "supportStates": [ { "code": "required", "label": "Required", "means": "…",
                       "settable": true, "blocksCreation": true }, … ],
  "campaignTypes": [ {
      "campaignType": "google_search",
      "label": "Search",
      "channel": "google_ads",
      "channelTerm": "Search",
      "means": "Text advertisements on search results, sending people to a GRAV page.",
      "deployable": true,
      "audienceModel": "intent",
      "audienceMeans": "People are reached because of what they searched for…",
      "blockedBy": null,
      "needs": [],
      "sections": [ { "code": "goal", "label": "…", "step": 1, "means": "…",
                      "settings": ["campaign_name", …] }, … ],
      "settings": [ { "code": "keyword_themes", "label": "Keyword themes",
                      "section": "audience", "means": "…",
                      "support": "required", "supportLabel": "Required",
                      "supportMeans": "…", "settable": true, "required": true,
                      "why": null }, … ],
      "summary": { "required": [...], "supported": [...], "notModelled": [...],
                   "unavailable": [...], "requiresExternalAudience": [...],
                   "externallyVerified": [...] }
  }, … ],
  "deployableCampaignTypes": ["google_search", "meta_traffic_single_image"],
  "lifecycle": [ { "code": "active", "label": "Running", "order": 6, "means": "…",
                   "reachable": false, "offersControl": false, "terminal": false,
                   "blockedBy": "…" }, … ],
  "deliveryBoundary": { "createsDelivering": false, "offersActivation": false, "means": "…", "why": "…" },
  "managementReads": [ { "code": "core_metrics", "label": "…", "available": true,
                         "servedBy": "GET /campaign-drafts/:id/performance",
                         "blockedBy": null, "caveat": null }, … ],
  "intelligenceReadiness": [ { "code": "negative_keywords", "label": "…",
                               "needsEvidence": ["search_terms"],
                               "requiresHumanApproval": true, "blockedBy": "…" }, … ],
  "intelligenceRules": { "callsAModel": false, "mayAct": false, "means": "…" },
  "means": "…"
}
```

`sections` is the same settings grouped by builder step and ordered by it — use
it to render a step without filtering client-side.

---

## The builder: Goal → Channel → Audience → Budget → Creative → Tracking → Review → Approval

**Step 2 decides everything after it.** Fetch the column for the chosen
`campaignType` and drive steps 3–6 entirely from it. Changing the channel after
step 3 invalidates targeting and creative — warn before discarding, and
re-derive rather than keeping fields that the new type cannot carry.

Step 7 (Review) should list every `required` setting still empty. Step 8
(Approval) is a named person agreeing; nothing is created in any advertising
channel before it, and nothing delivers after it.

### The two deployable types differ substantially — 15 and 16 required settings

| | Google Search | Meta website traffic |
|---|---|---|
| Aimed by | `keyword_themes` (required) | `age_range`, `gender` (supported), `audience_expansion` (required) |
| Keywords | required / supported / supported | **all three `unavailable`** — Meta does not match on searches |
| Creative | `headlines` + `descriptions` required | `primary_text` + `image` + `call_to_action` required |
| Age / gender | `unavailable` — Search aims by intent | `supported` |
| Placements | `unavailable` — it appears on search results | `not_modelled` |
| Frequency cap | `unavailable` | `not_modelled` |

`audienceModel` is `intent` or `profile` and is worth surfacing: it explains, in
one line, why the audience step looks completely different between them.

### Firmographics — the B2B answer

`job_role`, `job_seniority`, `industry` and `company_size` are
**`requires_external_audience` on both types**, never a targeting input.

No advertising channel verifies where somebody works. What they offer under
those names is self-reported profile data or an interest cluster, so a campaign
aimed at procurement managers reaches people who once showed an interest in
procurement. They are reachable — by supplying a list — and the `why` says so.
Render that sentence; it is the difference between "you cannot do this" and
"here is how".

---

## Lifecycle — draw the whole thing, control only part of it

Twelve states are declared: `draft`, `ready_for_review`, `awaiting_approval`,
`approved`, `returned`, `rejected`, `scheduled`, `active`, `paused`,
`completed`, `cancelled`, `archived`.

**Use `offersControl`, not `reachable`, to decide whether to render a button.**
Showing somebody where a campaign sits in a process is useful; offering a
control for a state nothing can reach is not.

Six are reachable today. `scheduled`, `active`, `paused`, `completed` and
`archived` are **not**, each with a `blockedBy`. The first four all begin or end
spending, and activation is a separate safety contract that does not exist yet.

**There is no Activate, Launch or Publish control, and you should not build
one.** `deliveryBoundary` is on every response saying GRAV creates every
campaign stopped and confirms it stopped by reading it back. When the activation
contract lands, these states flip to `reachable: true` and this contract does
not change shape — that is what it was designed for.

Note `paused` means *was running and has been stopped*. A campaign created
stopped has never run, and is `approved` plus a deployment record — do not label
it "paused".

---

## Lead-form campaign types: declared, not available

`google_lead_form` and `meta_lead_form` appear in `campaignTypes` with
`deployable: false`, an empty `settings` array and a `blockedBy`.

GRAV models no channel-hosted lead form. Enquiries would be collected by the
provider and reach nobody, because there is nothing to deliver them into.
`needs` lists what is missing.

Show them greyed with the reason rather than hiding them — hiding them makes a
marketer conclude GRAV cannot do lead generation at all, which is not what is
true. They have no settings column on purpose: publishing one would describe a
form that leads nowhere.

---

## Management reads

`managementReads` says which campaign-manager views exist and which do not, each
with the route that serves it or the reason it cannot be served.

Available today: inventory, status and schedule, core metrics, cost per outcome,
daily trend, readiness, approval history, change history, Sales outcomes,
channel connection state.

Not available, with reasons worth reading before designing around them:

- **breakdowns** — GRAV reads one row per campaign per day, and a breakdown's
  parts do not add to the campaign total the way people expect (a person in two
  age bands is counted in both).
- **budget_pacing** — the figures exist; the contract comparing spend-to-date
  against a committed budget does not.
- **lead_volume** — GRAV counts prospects handed to Sales, not leads attributed
  to a campaign. Joining the two needs an attribution contract nobody has
  written, and publishing a number without it would be inventing attribution.

**Unknown stays unavailable.** Every figure across the Marketing API uses
`{ available, value, unit, why }`; never render a missing value as zero.

---

## Intelligence

`intelligenceReadiness` declares what a future intelligence layer would do and
what evidence each needs. **Nothing is implemented and no model is called
anywhere in this contract** — `intelligenceRules` says `callsAModel: false,
mayAct: false`.

Every entry carries `requiresHumanApproval: true`. That is the existing Campaign
Health rule carried forward: the assistant may suggest that a person looks at
something; it may not act. Design any future surface around a suggestion a
person accepts, never an automatic change.
