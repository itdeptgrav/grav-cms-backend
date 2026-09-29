# Charts in Custom Reports: a hidden question and a two-minute ticket

Date: 25 September 2026. Metabase **v1.63.1**, OSS, no Enterprise token.

GRAV keeps its own designer, its own spreadsheet and its own Excel export.
Metabase draws the chart. The browser gets an address and a signed token, and
with them can render one chart and do nothing else.

Everything below was measured against the running pilot, not read in a
changelog.

---

## The gate: what the running instance actually does

| Asked | Answer |
|---|---|
| Create a question through the API with the query-builder key | **works** (`POST /api/card` → 200) |
| Use GRAV's own compiled MBQL as its query | **works** — the same object the preview runs |
| Set a visualization | **works**; all 18 displays are accepted by the API without any check that the shape suits — choosing sensibly is the server's job |
| Sign a short-lived embed token | **works** (HS256, `resource.question`) |
| Render chart-only with **no API key** | **works** — `/embed/question/<token>` → 200 HTML, `/api/embed/card/<token>/query` → 202 rows |
| Tenant restrictions immutable | **yes** — the question declares no parameters, so `?company_id=…` and a signed `params:{company_id}` both answer **400 "Unknown parameter"** |
| The question openable as a SQL editor | **no** — anonymous `/api/card/:id` and `/api/dataset` → 401; native SQL with the query key → **403** |
| Enable embedding on a card with the query-builder key | **403 — superuser only** |
| …and after an admin enables it, does the flag survive a runtime update? | **yes** — so the admin credential is needed once per question, never again |
| Archive a question with the query-builder key | **works** — cleanup needs no admin |
| Expired token | refused — **with about a minute of clock-skew leeway**: `exp` 45 s in the past was accepted, 60 s in the past was refused |
| Token for another question / forged signature | **400** both |
| CSV download through the token | **works** |

### The administrator credential, and why it exists

`enable_embedding` is gated behind superuser in 1.63.1. The reporting key
belongs to a query-builder-only group and is refused. So the bridge holds a
second, separate key (`METABASE_EMBED_ADMIN_API_KEY`) that authenticates
**exactly one call**: `PUT /api/card/:id {enable_embedding:true}`, on a question
that has just been created. `assertKeyUse` in the service refuses it for any
other path or method, and a test asserts the source has one call site.

An Enterprise token with the `embedding` feature would remove the need for it.
This instance reports `embedding: false`, `embedding_sdk: false`,
`embedding_simple: false` — all three are EE features; **static embedding**, the
one used here, is the OSS path.

---

## Which report shapes can be one Metabase question

A chart is one question and a question holds one query, while the preview is a
plan of up to a dozen. So:

| Shape | One question? |
|---|---|
| Detail listing | **yes** — the preview's own main query, as a table |
| Rows + one value | **yes** — byte for byte the preview's main query |
| Rows + columns + several values | **yes** — same breakouts, same aggregations |
| Previous-period comparison | **yes**, for a **total** or a **count** |
| Previous-year comparison | **yes**, same condition |
| Other-company comparison | **yes**, same condition |
| Difference and percentage difference | **yes** — arithmetic between aggregations, `((current − prior) ÷ \|prior\|) × 100`, null when prior is 0, identical to `matrix.js` |
| A comparison of an **average, minimum or maximum** | **NO** |

The trick that makes comparisons work in one query is the conditional
aggregation: the date filter widens to cover both windows and each figure
carries its own window (`sum-where`, `count-where`). Metabase 1.63.1 has no
`avg-where`, `min-where` or `max-where` — each answers HTTP 500 — and its
`offset()` is unsupported here (`Assert failed: (= (count clause) 4)`).

So a comparison of an average is answered with `chartSupported: false` and a
sentence, the spreadsheet still shows it, and nothing is approximated.

**Verified end to end:** a percentage-difference chart and the sheet beside it
produce `2706.0469488452277` and `null` for the same rows.

---

## What the browser can see, stated plainly

GRAV's own response carries no key, no database/table/field/collection/question
id, no MBQL and no SQL. The **Metabase embed page inside the iframe** fetches
its own card definition, so a person with devtools can read the MBQL — the
mart's internal field and table ids — **for a chart they are already allowed to
see**. No credential is exposed and no other tenant's data is reachable. That is
a property of static embedding, not something this design chose; removing it
would mean proxying and re-implementing Metabase's own page.

## What is not available in this embed mode

- **Drill-through: no.** Clicking a bar to see the records behind it needs
  interactive embedding, which is an Enterprise feature this licence does not
  carry. Tooltips, legends, formatting, the chart's own scales and CSV/XLSX
  downloads all work.
- **Alerts, subscriptions and dashboard editing: not exposed.** Each needs an
  authenticated Metabase *user* rather than a signed token — SSO (JWT or SAML,
  both EE) or real accounts for every accountant — plus email/Slack
  configuration for subscriptions. None of that is in place, and none of it
  should be turned on by a chart bridge.
