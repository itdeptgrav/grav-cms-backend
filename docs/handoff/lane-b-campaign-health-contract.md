# Lane B — Campaign Health frontend contract

Date: 2026-09-20
Backend: Lane A, `/api/cms/marketing`. Nothing committed.

This is the contract for the empty **Campaign Health** section of the Campaign
Performance page, and for the **Advertising Connections** workspace that the
binding correction unblocks.

---

## 1. Campaign Health

### Routes

```
GET  /api/cms/marketing/campaign-drafts/:id/health            any Marketing role
POST /api/cms/marketing/campaign-drafts/:id/health/generate   any Marketing role, body {}
POST /api/cms/marketing/campaign-drafts/:id/health/dismiss    any Marketing role
GET  /api/cms/marketing/campaign-drafts/:id/health/history    any Marketing role
GET  /api/cms/marketing/intelligence/usage                    administrator only
```

`:id` is the opaque campaign-draft id already used on the performance page.

### Page load: call `GET …/health` only

It costs nothing and contacts nobody. **Never call `generate` on render, on a
performance refresh, on a tab change or on a poll.** Generation is the only
thing that spends a rate-limited allowance, and a page that generates on render
empties a day's allowance before anybody has read anything.

```jsonc
{
  "success": true,
  "intelligenceAvailable": true,
  "intelligenceUnavailableReason": null,   // "not_configured" | "unavailable" | null
  "evidenceSufficient": true,
  "evidenceMessage": null,                 // sentence when insufficient
  "freshness": { "code": "fresh", "label": "Just read", "observedAt": "…", "ageMinutes": 0 },
  "analysis": { /* below, or null */ },
  "generatedAt": "…",
  "analysisIsOfCurrentEvidence": true,
  "vocabulary": { "recommendationTypes": [...], "confidenceLevels": [...] },
  "means": "…",
  "assistantCanChangeAnything": false
}
```

### Render in this order — the four "no"s are different

1. `intelligenceAvailable === false` → show `intelligenceUnavailableReason`,
   hide the generate button. **Do not collapse the reasons into one message.**
   `not_configured` means somebody has to switch the capability on;
   `unavailable` means the service is having a bad day and retrying is
   reasonable. One message for both sends people to check something that was
   fine.
2. `evidenceSufficient === false` → show `evidenceMessage`, hide the generate
   button. This is not an error; it is "not enough finished days yet".
3. `analysis === null` → the empty state. Offer **Explain these figures**.
4. otherwise → render `analysis`.

When `analysisIsOfCurrentEvidence === false`, caption it as explaining earlier
figures and offer **Explain again**. Do not auto-regenerate.

### The analysis object

```jsonc
{
  "analysisId": "mca1.…",
  "approvedRevision": 1,
  "headline": "…",
  "summary": "…",
  "observations":    [{ "text": "…", "evidenceRefs": ["E1-2"] }],
  "recommendations": [{ "type": "review_creative", "text": "…", "evidenceRefs": ["E1-2"] }],
  "confidence": "medium",                  // high | medium | low — never a number
  "uncertainty": "…",
  "missingInformation": ["…"],
  "evidence": [ { "channel": "google_ads", "currency": "INR", "conversionBasis": {…},
                  "periods": {…}, "facts": [ { "evidenceId": "E1-2", "measure": "clicks",
                  "finding": "decline", "recentValue": 140, "previousValue": 280,
                  "absoluteChange": -140, "percentChange": -0.5,
                  "betterWhen": "higher_is_better", "note": "…" } ] } ],
  "performanceFreshness": { "code": "fresh", "observedAt": "…" },
  "generatedAt": "…",
  "status": "current",
  "producedBy": { "model": "gemini-3.8-flash", "promptVersion": "campaign-health-1.0.0" },
  "usage": { "inputTokens": 900, "outputTokens": 300, "cachedTokens": 0 },
  "changedAnything": false,
  "canActOnItsOwn": false
}
```

**Every `evidenceRefs` entry resolves to an `evidenceId` in `evidence[].facts[]`.**
Show each sentence beside the figure it cites — that is the point of the whole
design, and a rendering that hides the citations throws away the only thing that
makes the text checkable. The backend has already discarded any answer citing an
id it did not supply, so an unresolvable ref is a bug, not a case to handle
gracefully.

Render `evidence[]` per channel. **Never sum across channels** — currencies and
conversion definitions differ, which is why each carries its own `currency` and
`conversionBasis`. Never render `reach` as a total.

`betterWhen` is `higher_is_better`, `lower_is_better` or `neutral`. Colour the
arrow from that, not from the sign of `percentChange` — spend going up is
neutral, cost-per-acquisition going up is not.

Take labels from `vocabulary`; do not hard-code the seven recommendation types.
Say "this is a suggestion to review something" near the recommendations —
`changedAnything` and `canActOnItsOwn` are `false` on every response and are
there to be shown.

### Generate — an explicit button

`POST …/health/generate` with **`{}`**. Any other key is a 400. There is no
model, temperature, window or prompt parameter, by design.

```jsonc
{ "success": true, "generated": true, "reused": false, "modelCalled": true,
  "evidenceSufficient": true, "reason": null, "message": null,
  "freshness": {…}, "analysis": {…}, "generatedAt": "…", "usage": {…},
  "vocabulary": {…}, "assistantCanChangeAnything": false }
```

| Outcome | `generated` | `reused` | `modelCalled` | `reason` | Show |
|---|---|---|---|---|---|
| new answer | `true` | `false` | `true` | `null` | the analysis |
| nothing changed | `false` | `true` | `false` | `null` | the same analysis + `means` |
| not enough data | `false` | `false` | `false` | `INSUFFICIENT_COVERAGE` | `message` |
| not set up | `false` | `false` | `false` | `not_configured` | `message` |
| allowance used | `false` | `false` | `false` | `limit_reached` | `message` + `usage.resetsOn` |
| unreadable answer | `false` | `false` | `true` | `malformed_output` | `message`, offer retry |
| unsupported answer | `false` | `false` | `true` | `ungrounded_output` | `message`, offer retry |
| refused answer | `false` | `false` | `true` | `forbidden_output` | `message`, offer retry |
| no response in time | `false` | `false` | `true` | `timeout` | `message`, offer retry |
| service down | `false` | `false` | `true` | `unavailable` | `message`, offer retry |

`message` is always GRAV's own wording — render it as-is. Do not invent your
own text for a `reason` code.

`reused: true` is worth surfacing quietly ("nothing has changed since this was
written") so people do not think the button failed.

### Dismiss

`POST …/health/dismiss` with `{ analysisId, reason, recommendationType? }`.
**`reason` is required and free text** — an empty one is a 400. Omit
`recommendationType` to dismiss the whole analysis. Open to any Marketing user:
the person best placed to say a suggestion is wrong is the marketer it was
written for. Returns `{ success, dismissed: true, means }`; a follow-up
`GET …/health` then returns `analysis: null`.

### History

`GET …/health/history?limit=` → `{ success, analyses: [ …, { dismissals: [{ at, by, reason, recommendationType }] } ], means }`.

### Usage — administrator only

`GET /intelligence/usage` → `{ intelligenceAvailable, intelligenceUnavailableReason,
operation, date, used, limits, requestsRemaining, tokensRemaining, withinLimits,
estimatedCurrencyCost: null, costMeans }`.

**`estimatedCurrencyCost` is always `null`.** Show tokens. Do not multiply them
by a rate in the frontend — provider pricing changes independently of this code,
and a wrong number labelled in rupees is worse than an honest token count.
A marketer calling this gets 403; hide the panel rather than showing the error.

### What never appears in any of these responses

No API key, no environment-variable name, no system prompt, no raw provider
response, no chain-of-thought, no provider error text, no external account or
campaign identifier, no database id.

**Changed in this pass:** `missingConfiguration` has been **removed** from every
response. If you built against it, drop it — `reason: "not_configured"` plus
`message` is now the whole contract. The variable name lives in the server log
and the deployment documentation.

---

## 2. Advertising Connections — the binding fix

`POST /api/cms/marketing/advertising-accounts/:channel` previously allow-listed
Google's four field names for **every** channel, so a Meta binding could never
carry `businessId` — it came back as a 400 "not part of it". The service had
accepted and stored it the whole time; only the HTTP path was closed. This is
what blocked the workspace.

**The body is now per channel, and they are not the same list:**

| Channel | Required | Optional |
|---|---|---|
| `google_ads` | `externalAccountId` | `loginAccountId`, `externalAccountName`, `note` |
| `meta_ads` | `externalAccountId` | `businessId`, `externalAccountName`, `note` |

`businessId` is **optional**, matching the existing service contract: a personal
advertising account legitimately belongs to no business, and Meta preflight
already reports an absent business as `not_applicable` rather than failing.
Render it as optional, and say what it improves — with a business recorded,
preflight can confirm the account sits in it and can check destination-domain
verification; without one, both checks report `not_applicable`.

Sending the other channel's field is a 400 naming the owner, e.g.
`"businessId belongs to meta ads, not google ads. A google ads account binding
records: externalAccountId, loginAccountId, externalAccountName, note."` Render
the message; it tells the user exactly what to do.

Binding stays **administrator-only** (403 otherwise). Reading is open to any
Marketing user, and `GET` returns `mayBind` so the form can be shown read-only
rather than hidden. Credential-shaped field names and credential-shaped values
are refused on both channels, and nothing is stored on a refusal.
