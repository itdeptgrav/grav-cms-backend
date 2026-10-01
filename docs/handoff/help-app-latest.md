# GRAV Help — Visual Chunk 5, pass 1 of 2: the visual system

> **Date:** 2026-09-07 · **Commit status:** nothing committed, no branch.
> Frontend 161 → 162 (the new `content/help-assets/` tree); backend unchanged.
>
> **Sequenced at the user's request:** this pass delivers the engine, the
> security boundary and the tests. Screenshot capture and per-guide content are
> pass 2.

## 1. Files changed

**Added:** `lib/help/imageBlock.js`, `lib/help/assetPaths.js`,
`app/help/assets/[app]/[slug]/[file]/route.js`,
`components/help/HelpScreenshot.js`, `scripts/help/assetInspect.mjs`,
`scripts/help/capture.mjs`, four test files
(`imageBlock`, `visualCoverage`, `assetRoute`, `visualFreshness`),
`content/help-assets/getting-started/sign-in/sign-in-screen.png`.

**Modified:** `lib/help/content.js` (image blocks, `visual_status`,
`declaredAssets`, `hasScreenshots` in the index), `components/help/HelpArticle.js`,
`components/help/helpBits.js` (card indicator), `scripts/help/{freshness,roots,report,check,accept}.mjs`,
`package.json` (`help:capture`), the 27 guides (`visual_status`), the baseline
(version 2), and four existing test fixtures.

## 2. Parser contract

`![alt](file.ext "caption")` — its own line, nothing else on it. Emits
`{type:"image", file, alt, caption}` and **nothing else**: no src, no href, no
attribute, no markup. Alt and caption both required. Refused: `/`, `\`, `..`,
URLs, `data:`, absolute paths, query strings, fragments, and any extension other
than `.png/.jpg/.jpeg/.webp`. A line that *meant* to be an image and is broken
**throws** — silence would ship a step the reader cannot follow. An inline image
stays prose; raw HTML (including `<img>` and `<svg onload=…>`) stays text.

## 3. Protected-route contract

`GET /help/assets/<app>/<slug>/<file>` — five checks in order: verify session →
resolve the **same** grants (`resolveHelpGrants`) → authorize the **parent
article** (`visibleArticle`) → confirm the filename is **declared** by that
article → confirm the **bytes** are a PNG/JPEG/WebP matching the extension.

Nothing is inferred from the URL, app name, slug, filename or referrer. Every
refusal is the **same empty 404** — a distinguishable answer would tell an
unauthorized caller which screenshots exist. `lstat`, never `stat`, so a symlink
is refused rather than followed. Headers on every path, success and refusal:
`Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`.

Assets live at `content/help-assets/<app>/<slug>/`, **never `public/`**. A file
in that directory that no image block declares is not servable.

## 4. Freshness integration

Baseline **version 2**: each entry now carries `assets` **separately** from
`sources`, because a changed screenshot and a changed source file are different
work reviewed by different acts. `help:check` reports missing assets, changed
asset bytes (`SCREENSHOT CHANGED`), declared-but-unused assets, size/type
violations (`INVALID SCREENSHOT`), `complete` with no image, and — when a **UI**
source changes — names the screenshots to re-check. Backend source changes do
not put pictures in doubt.

`visual_status: needed` on a published task/screen guide is **reported every run
and never fails**. Failing it would push people to mark operational guides
`not-applicable` for a green build, which is the one thing the field exists to
prevent; a test pins that no operational guide is marked `not-applicable`.

Acceptance of an article with images **refuses without `--visuals-reviewed`** and
lists the screenshots to look at. Still no `accept-all`.

**Two corrections:** acceptance now refuses any non-published guide (draft,
legacy, retired, needs_review); and `hashRef`/`readRef`/`sizeOfRef` refuse a
symlink anywhere along the path — the file itself or any directory above it.

## 5. Tests — 184 pass, 0 fail

| File | Pass |
|---|---|
| routeMatcher 20 · content 31 · authorization 23 · costingAuthorization 29 · routeMapping 8 | 111 |
| imageBlock 9 · visualCoverage 11 · assetRoute 10 · visualFreshness 16 | 46 |
| freshness 27 | 27 |

All 138 Chunk-4 tests still pass; six fixtures gained the new required fields.

## 6. Visual coverage today

1 of 27 complete (`getting-started.sign-in`, a real capture of the public
sign-in screen — placeholder-only, no personal or financial data). 25 published
operational guides report `needed`; `getting-started.understand-access` is
`kind: concept` and is correctly not counted.

## 7. For pass 2

Capture harness is ready: `GRAV_HELP_TOKEN=… npm run help:capture -- --path
/store/dashboard/overview --out store/start-the-day/overview.png [--clip x,y,w,h]`.
Chrome via CDP on a throwaway profile; the token is read from the environment,
never written to a file, a URL or a command line, and the harness refuses any
non-loopback base URL. **No WebP encoder exists on this machine** (`sips` reads
WebP but cannot write it), so captures are PNG — allowed by the route contract.

---

# GRAV Help — Chunk 4 handoff (superseded by Chunk 5 below)

> **Chunk:** Fast Chunk 4 — automatic Help freshness checking
>
> **Date:** 2026-09-07
>
> **Commit status:** NOTHING COMMITTED. No branch. Backend tree unchanged (279);
> frontend 160 → 161, the one new entry being the untracked `scripts/` directory.

## 1. Files changed

**Added:** `lib/help/sourceRefs.js`, `scripts/help/{freshness,roots,report,baseline,check,accept}.mjs`,
`scripts/help/freshness.test.mjs`, `content/help/verification-baseline.json`.

**Modified:** `lib/help/content.js` (refs parsed, normalised and sorted through
the new module), `package.json` (two commands + `scripts/**` in the test glob),
the seven Costing guides (audited backend refs), `content/help/costing/*.md` ×4
(`last_verified` bumped by the demonstration accepts),
`lib/help/costingAuthorization.test.mjs` (its source-ref test rewritten for the
new grammar).

## 2. Source-reference grammar

| Form | Means |
|---|---|
| `app/costing/page.js` | frontend — unchanged, every existing guide still works |
| `frontend:app/costing/page.js` | the same, said explicitly |
| `backend:services/centralCosting/engine.js` | the other repository |

Refused: unknown prefixes, absolute paths (POSIX and Windows), URLs, empty
paths, `..`, empty or `.` segments, backslashes. Stored **normalised** (always
prefixed) and sorted, so one file has one spelling in the baseline.

**The website never resolves a reference.** `lib/help/sourceRefs.js` is pure
string work with no filesystem in it, because `content.js` runs in the Next
server on every Help request and a deployment has one checkout. Resolution lives
only in `scripts/help/roots.mjs`. Verified: nothing under `lib/help/` mentions
the backend root, and `/help` still returns 200.

Roots: frontend = this repository (found from the script's own location, so the
tool works from any cwd); backend = `GRAV_BACKEND_ROOT`, else `../grav-cms-backend`.

## 3. Baseline format

`content/help/verification-baseline.json` — machine-owned, 599 lines, sorted by
article id and then by reference:

```json
{
  "version": 1,
  "articles": [
    { "id": "costing.application-overview",
      "lastVerified": "2026-09-06",
      "sources": [ { "ref": "backend:services/centralCosting/capabilities.js",
                     "sha256": "b9978c48…" } ] }
  ]
}
```

**SHA-256 of contents, never mtime** — a fresh clone gives every file today's
timestamp, so a mtime check calls the whole corpus stale on a new machine and
says nothing after a `git checkout` restores an old file. No absolute path and
no timestamp is stored, so the file is identical on every machine with the same
two checkouts. It sits at the root of `content/help/`, which `loadArticles`
cannot see because that loader walks directories and reads `.md` inside them.

## 4. The everyday workflow

```bash
# 1 · change application code, frontend or backend
# 2 · ask which guides that change may have invalidated
npm run help:check

# 3 · READ each guide it names, against the screen or service that changed
# 4 · correct the guide's wording and its source_refs
# 5 · record that you did, one guide at a time
npm run help:accept -- store.receive-goods

# 6 · confirm
npm run help:check
```

`help:check` loads and validates the corpus, hashes every reference in both
repositories, compares, prints worst-first grouped by guide, and **writes
nothing**. Exit 0 only when every published guide is valid, every referenced
file exists, every hash matches, and no baseline entry is orphaned.

`help:accept` takes **exactly one** id. It refuses zero ids, two ids, an unknown
id (with near-miss suggestions), and any guide whose references are not all on
disk. It changes two things: that article's baseline entry, and that guide's
`last_verified` — replaced as a single front-matter line, so the rest of the file
is byte-identical. **There is no accept-all**, and adding one would turn the
mechanism into a formality that always says yes.

Five verdicts, worst first: `MISSING SOURCE`, `NOT BASELINED`, `STALE`,
`REFS CHANGED` (a reference added/dropped, or `last_verified` edited by hand
without an accept), `ok`. Plus orphan baseline entries, which also fail.

## 5. Test totals

`node --test lib/help/*.test.mjs scripts/help/*.test.mjs` → **tests 138 · pass 138 · fail 0**

| File | Pass |
|---|---|
| `lib/help/routeMatcher.test.mjs` | 20 |
| `lib/help/content.test.mjs` | 31 |
| `lib/help/authorization.test.mjs` | 23 |
| `lib/help/costingAuthorization.test.mjs` | 29 |
| `lib/help/routeMapping.test.mjs` | 8 |
| `scripts/help/freshness.test.mjs` | 27 |

The 27 freshness tests each build their own two-repository world in a temp
directory. They never read the real corpus: a test asserting "27 guides are
current" would go red every time somebody legitimately edited a source file.

## 6. Final `help:check`

```
GRAV Help — freshness check

All 27 published guides are current against their sources.
```
Exit `0`. 108 references baselined — 89 frontend, 19 backend.

## 7. The deliberate proof

No real application code was altered. A temporary fixture backend was built by
copying the nine referenced backend files, and `GRAV_BACKEND_ROOT` pointed at it:

1. fixture untouched → **clean, exit 0** (copies hash identically, which also
   proves hashing is content-based).
2. one line appended to the fixture's `capabilities.js` → **STALE (4)**, exit 1:
   exactly the four guides citing that file, and no others.
3. `help:accept -- costing.review-margin` → accepted, 6 references hashed.
4. re-check → **STALE (3)**: accepting one guide said nothing about the other
   three.
5. accepted the remaining three → **clean**.
6. fixture deleted, the four re-accepted against the real backend → **clean**.

## 8. Broken or insufficient references found

1. **Insufficient, and the reason for the chunk.** All seven Costing guides
   cited only frontend screens, so a change to the capability resolver, the
   visibility serializer or the lifecycle service — which is what those guides
   are actually *about* — flagged nothing. 19 backend references added, each
   governing a specific claim rather than one blanket list: `capabilities.js`
   where a guide asserts the grants are independent, `visibility.js` where it
   asserts withheld-is-not-empty, `policy.service.js` for the margin band's
   ordering rule, `engine.js` for the build-up, `lifecycle.service.js` for
   approval, `versionCreation.service.js` for immutability,
   `approvedOutput.service.js` for what Sales receives, `labourCost.js` for the
   labour assumptions, and the route file for the single `NOT_FOUND`.
2. **A stale comment, not a reference.** `services/centralCosting/capabilities.js`
   still says approval and policy management land "in a later chunk"; both are
   implemented. Reported in Chunk 3, still true, backend untouched.
3. **No broken references remain.** The one found in Chunk 3 (`store.stock-count`
   pointing at a moved module) was fixed then; all 108 now resolve.

---

# GRAV Help — Chunk 3 handoff (superseded by Chunk 4 below)

> **Chunk:** Fast Chunk 3 — capability-aware Costing Help
>
> **Date:** 2026-09-06
>
> **Commit status:** NOTHING COMMITTED. No branch. Both trees unchanged in size
> (frontend 160, backend 279).

## 1. Files changed

**Added:** `lib/help/costingAccess.js`, `lib/help/costingCapabilities.js`,
`lib/help/costingAuthorization.test.mjs`, and seven guides under
`content/help/costing/`.

**Modified:** `lib/help/audience.js` (two new namespaces + structured grants),
`lib/help/content.js` (validates them), `lib/help/routeMatcher.js` (hardened
fallback), `lib/help/catalogue.js` (Costing row), the three `app/help` pages,
`components/help/HelpHome.js` (`extraApps`), `content/help/store/receive-goods.md`
(two `source_refs` added), `content/help/store/stock-count.md` (broken
`source_ref` fixed — see §6), and three existing test files whose Chunk-2
expectations the new corpus legitimately changes.

## 2. Audience / grant contract

| Audience | Granted by |
|---|---|
| `universal` | any verified session |
| `department:<slug>` | `departments[]` on a `state === "ok"` session |
| `application:<slug>` | the application's own server-side check |
| `capability:<exact.name>` | the same check's resolved capability list |

`resolveHelpGrants(session)` is the only grant builder. Costing's half calls
`GET /api/costings/access` **server-side**, forwarding the request cookie,
memoised per request with React `cache()`. The response is intersected with the
six recognised names; `application:costing` is granted only when `hasAccess` is
true **and** at least one recognised capability came back. No implications are
invented: OUTPUT ⇏ COST, COST ⇏ MARGIN, APPROVE ⇏ POLICY.

**Fails closed without taking Help down.** A failed access request leaves the
reader ordinary Help and grants nothing from Costing.

**Back-compatible by construction:** a bare `Set` is still read as departments
only, so every Chunk-2 call site and behaviour is byte-identical.

**Route fallback hardened.** `findHelpForRoute` names an application only when
it is in the authorized set, derived from the already-filtered article list.
This closes the Chunk-2 leak (a Sales-only reader typing a Store route was told
"No guide for that Store screen yet") and stops `/costing` naming Costing to a
reader without access. Side effect, verified live and deliberate: an application
with **no** guides at all (HR) now falls back to Getting Started instead of
saying "no guide for that HR screen yet".

## 3. Guide count by application

| Application | Guides |
|---|---|
| store | 10 |
| costing | 7 |
| getting-started | 5 |
| sales | 5 |
| **Total** | **27** |

Costing IDs: `costing.application-overview` (`application:costing`),
`costing.read-approved-output` (`capability:costing.output.read`),
`costing.build-or-revise` (`draft.write`), `costing.review-cost-breakdown`
(`cost.read`), `costing.review-margin` (`margin.read`),
`costing.approve-a-version` (`approve`), `costing.manage-policy`
(`policy.manage`).

## 4. Test totals

`node --test lib/help/*.test.mjs` → **tests 109 · pass 109 · fail 0**

| File | Pass |
|---|---|
| `routeMatcher.test.mjs` | 20 |
| `content.test.mjs` | 31 |
| `authorization.test.mjs` | 23 |
| `routeMapping.test.mjs` | 8 |
| `costingAuthorization.test.mjs` | 27 |

Eight reader profiles are pinned across every response path (search, route
matching, cards/counts, direct lookup, hub, metadata, contextual fallback).

## 5. Manual pass

Live, with the available account (holds **all six** costing capabilities and 19
departments, **none of them costing**):

- `/api/costings/access` returned all six; the **Costing card showed "7 guides"**
  while `verify` confirmed no costing department row.
- The card is a plain `<a>`; no Help file references `switch-department` in code.
- `/help?from=/costing` surfaced the two `/costing`-routed guides.
- `/help/costing` hub listed 7; `/help/costing/review-margin` rendered.
- `/help?from=/hr/dashboard` → **no** context panel (HR has no guides).
- `/help?from=/store/...store-settings` → still "No guide for that Store &
  Purchase screen yet".

**Limitation:** the only account available holds every capability, so the seven
restricted profiles could not be exercised in the browser. They are pinned at
module level against the same `visible*` functions the pages call, and the
Chunk-2 import guard proves the pages call no others.

## 6. Conflicts found

1. **A `source_ref` pointed at a file that does not exist.** `store.stock-count`
   named `components/store/stock-count/stock-count.mjs`; the real module is
   `components/store/warehouse-stock/stock-count.mjs`. Found by the new
   corpus-wide test, and fixed. All 27 guides' refs now resolve.
2. **`services/centralCosting/capabilities.js` comments are stale.** They say
   approval "lands in a later chunk" and policy management is "a later chunk".
   Both are implemented — `CostingLifecyclePanel.js` runs submit/approve with a
   required reason, and `/costing/policy` is a working editor. Executable
   behaviour won; the guides document what exists. Backend not modified.
3. **`components/store/goods-receipt-entry/receipt.mjs` header is stale**, still
   saying there is "no Goods Receipt document, no quality inspection, no
   quarantine and no put-away". `components/store/goods-receipts/control.mjs`
   and the register page are the current truth. Its one operative claim —
   recording moves stock immediately — agrees with `control.mjs` and is what
   the corrected Store guide says.
4. **`costing.application-overview` is readable by an output-only Sales reader**,
   because `application:costing` is granted by any recognised capability, as the
   contract specifies. It carries no cost, margin, approval or policy
   instruction — only the register's shape and the fact that access differs per
   person. Flagged because it does mean Sales learns a Draft queue exists as a
   product concept; it discloses nothing about any individual costing, which the
   backend's single `NOT_FOUND` still guarantees.

---

# GRAV Help — Chunk 2 handoff (superseded by Chunk 3 below)

> **Chunk:** Fast Chunk 2 — Store and Sales pilot content with server-side
> permission filtering
>
> **Date:** 2026-09-06
>
> **Frontend repository:** `/Users/risheeray/grav-cms`
>
> **Commit status:** NOTHING COMMITTED. No branch created. Both working trees
> are unchanged in size from before this chunk (frontend 157 entries, backend
> 276) — every pre-existing uncommitted Sales/Store/Costing/Accounting change is
> untouched.

## 1. Files changed

### Added

```text
lib/help/audience.js                     the audience vocabulary + authorization
lib/help/authorization.test.mjs          23 focused tests
lib/help/routeMapping.test.mjs           8 focused tests

content/help/store/    ten guides   (audience: department:store)
content/help/sales/    five guides  (audience: department:sales)
```

### Modified

| File | Change |
|---|---|
| `lib/help/content.js` | `audience` added to required metadata and validated; the read API split into an **unfiltered corpus** (`publishedArticles`, `findPublished`, `loadArticles`) and an **authorized response** (`visibleArticles`, `visibleArticle`, `visibleSearchIndex`, `visibleRouteIndex`, `visibleCountsByApp`). |
| `lib/help/session.js` | `verifyHelpSession` wrapped in React's `cache()` so the page body and `generateMetadata` share one `/api/auth/verify` per request. |
| `app/help/page.js` | Derives grants, filters search index, route index and counts. |
| `app/help/[app]/page.js` | Filters the hub; `generateMetadata` authorizes before naming the application. |
| `app/help/[app]/[slug]/page.js` | `visibleArticle` lookup; `generateMetadata` authorizes before naming the guide. |
| `components/help/HelpHome.js` | Takes server-computed authorized counts instead of re-deriving them. |
| `lib/help/content.test.mjs` | Fixture declares `audience`; two new audience-validation cases. |
| `content/help/getting-started/*.md` (5) | `audience: universal` added. |

Nothing else was touched. `components/store/StoreQuickTour.js` and
`components/sales/crm/journey/StageGuide.js` were read as references and **not
modified**. No backend model, route or collection. No dependency added.

## 2. The audience and filtering contract

### Declaration

Every article declares exactly one `audience` in front matter, and it is a
**required** field with no default:

```yaml
audience: universal          # every verified employee
audience: department:store   # only employees whose VERIFIED session grants it
audience: department:sales
```

Validated at load time: the value must parse, and a `department:<slug>` must
name an application the Help catalogue knows. That second check is content
integrity rather than access — `department:stores` would otherwise produce a
guide nobody in the company could ever open, failing silently as "correctly
restricted".

Capability-scoped audiences (costing policy, margin, payroll) are deliberately
**not expressible**: they need a server-side capability contract that does not
exist yet, and an audience nobody can evaluate is worse than one nobody can
write.

### Authorization

One module, `lib/help/audience.js`:

- `grantsFromSession(session)` → `Set<slug>`, and it reads **one thing**: the
  `departments` array on a session `verifyHelpSession()` returned with
  `state === "ok"`. An `unauthenticated` or `unreachable` session yields an
  empty set **even when its payload carries a department list**.
- `canRead(article, grants)` — fails closed. A missing audience, an unparseable
  one, a non-`Set` grants argument and `undefined` all resolve to `false`.
- `authorize(articles, grants)` — a pure filter; it never reorders or reshapes.

Nothing is derived from the route the reader came from, a query parameter,
local storage, the catalogue, or the article's own claims about itself.

### Where filtering happens

All six response paths go through the `visible*` functions, which take `grants`
as their **first** argument — an authorization argument hidden in a trailing
options bag is one somebody forgets:

| Path | Function |
|---|---|
| Search results | `visibleSearchIndex(grants)` |
| Route matches | `visibleRouteIndex(grants)` → `findHelpForRoute` |
| Application hubs | `visibleArticles(grants).filter(...)`, `notFound()` when empty |
| Direct article response | `visibleArticle(grants, app, slug)` |
| Related counts | `visibleCountsByApp(grants)` |
| Dynamic metadata | authorized article, or the generic `Help · GRAV` |

A guide the reader may not read returns `null`, and the page renders the same
`notFound()` it renders for a guide that does not exist. Telling somebody
"forbidden" tells them the guide is there.

**The guard that outlives this chunk:** `authorization.test.mjs` asserts that no
file under `app/help/` or `components/help/` references `publishedArticles`,
`findPublished` or `loadArticles`. The way filtering stops being complete is a
seventh response path added later reaching for the unfiltered name because it is
shorter; that test fails when it does.

### Search payload

Unchanged in kind and stricter in effect: the index carries `id`, `app`, `slug`,
`title`, `summary`, `keywords` and **no body**, for **authorized articles only**.
A restricted title in the payload is a leak even when the row never renders.

## 3. Added article IDs and URLs

### Store — `audience: department:store`, owner Store, verified 2026-09-06

| ID | URL |
|---|---|
| `store.start-the-day` | `/help/store/start-the-day` |
| `store.review-a-request` | `/help/store/review-a-request` |
| `store.reserve-pick-and-issue` | `/help/store/reserve-pick-and-issue` |
| `store.create-a-purchase-order` | `/help/store/create-a-purchase-order` |
| `store.receive-goods` | `/help/store/receive-goods` |
| `store.manage-a-service-order` | `/help/store/manage-a-service-order` |
| `store.record-a-stock-return` | `/help/store/record-a-stock-return` |
| `store.stock-count` | `/help/store/stock-count` |
| `store.item-master` | `/help/store/item-master` |
| `store.investigate-stock` | `/help/store/investigate-stock` |

### Sales — `audience: department:sales`, owner Sales, verified 2026-09-06

| ID | URL |
|---|---|
| `sales.application-overview` | `/help/sales/application-overview` |
| `sales.qualify-a-lead` | `/help/sales/qualify-a-lead` |
| `sales.start-a-journey` | `/help/sales/start-a-journey` |
| `sales.work-the-journey-stages` | `/help/sales/work-the-journey-stages` |
| `sales.follow-the-order` | `/help/sales/follow-the-order` |

All fifteen carry the six required sections in order, plus `routes`,
`source_refs` and `keywords`. No customer values, credentials, financial figures
or example business records appear in any of them.

## 4. Focused test results

```bash
node --test lib/help/routeMatcher.test.mjs lib/help/content.test.mjs \
            lib/help/authorization.test.mjs lib/help/routeMapping.test.mjs
```

**tests 79 · pass 79 · fail 0** (142 ms)

| File | Pass |
|---|---|
| `lib/help/routeMatcher.test.mjs` | 18 |
| `lib/help/content.test.mjs` | 30 |
| `lib/help/authorization.test.mjs` | 23 |
| `lib/help/routeMapping.test.mjs` | 8 |

**The 46 existing tests all still pass** (18 route-matcher + 28 content). The
content fixture gained one line — `audience: "universal"` — because the field is
now required; no existing assertion was changed or removed, and the two extra
content tests are new audience cases (28 → 30).

Coverage of the required checks: universal visibility for all four reader kinds;
Store-only and Sales-only filtering; multi-department access; unauthorized
direct lookup returning null and being indistinguishable from not-found;
unauthorized articles absent from the search and route indexes and from counts;
`generateMetadata` never producing a restricted title; all 20 published guides
validating; every important Store and Sales route mapping to its guide,
including `:id` and `:journeyId/:stage` forms; and the unfiltered-import guard.

## 5. Manual desktop pass

Ran against the live dev server (`:3001`) and backend (`:5050`) with the
available signed-in account.

**Verified live:**

- `/help?from=/store/dashboard/overview` → "Start the day from the Store
  overview" under "For the screen you came from".
- Application cards: **Store & Purchase — 10 guides**, **Sales — 5 guides**,
  **Getting started — 5 guides**, and all seventeen other applications still
  "Guides coming next". Both new cards are clickable.
- `/help/store` → the hub with all ten guides; title "Store & Purchase · GRAV
  Help".
- `/help/store/receive-goods` → renders with owner, verified date, the six
  sections, and "Deliveries (legacy)" flagged as legacy.
- Search "purchase order" → 2 guides, both Store.
- `/help?from=/sales/dashboard/journeys/abc123/enquiry` → "Work through the Sales
  Journey stages", i.e. the `:journeyId/:stage` pattern matched a real record id.
- Full launcher round trip from `/store/dashboard/operations/reservations` →
  Help offered "Reserve, pick and issue available stock".
- `/help/hr` (a department the account **holds**, with no guides) and
  `/help/costing` (not in the catalogue) both render the normal 404 with the
  **generic** title `Help · GRAV` — no application name in the tab.

**Limitation, recorded honestly:** the only signed-in account available holds
**all 19 departments**, so the Store-only, Sales-only and no-grant views could
not be exercised through the browser. Those four reader combinations are pinned
at the module level in `authorization.test.mjs`, which drives the same
`visible*` functions the pages call, and the unfiltered-import guard proves the
pages call no others. Creating a restricted account was out of scope and would
have needed credentials I do not handle.

## 6. Current-code vs manual conflicts found

1. **The Store nav comment is stale about receiving.**
   `components/Store_DashboardLayout.js` says "inspections and put-away are not
   built", but `app/store/dashboard/operations/goods-receipts/page.js` opens "the
   controlled inspection / quarantine / put-away workspace", the detail page
   records accepted/quarantined/rejected/put-away per line, and the Overview
   read model surfaces "Receipts to inspect" and "Put-away pending". **The code
   wins**: `store.receive-goods` documents inspection and put-away. The comment
   should be corrected separately — I did not edit that file.

2. **The Quick Tour points goods receipts at the legacy screen.**
   `StoreQuickTour.js`'s `grn` step navigates to
   `/store/dashboard/operations/delivery`, which the current nav labels
   **"Deliveries (legacy)"**. The authoritative screen is
   `/store/dashboard/operations/goods-receipts`. The Help guide uses the current
   one and names the legacy screen as history only. The tour was **not modified**
   as instructed.

3. **The Quick Tour calls the catalogue "Item master"; the nav calls it
   "Materials".** It moved from Inventory to Masters and was renamed. The guide
   uses the current employee-facing name and mentions the older one only as a
   search term.

4. **Store payment recording is retired.** The PO screen states that Accounting
   owns payment truth against the bill; older manual material describes recording
   payments in Store. The guide follows the code.

5. **The Sales Pipeline draws fewer stages than the lifecycle has.**
   `JOURNEY_HIDDEN_STAGE_KEYS` hides Cost & Invoicing, Order Confirmation,
   Production, Shipment and Order Closing from the Pipeline's stage bar; the last
   three are owned by the **Order Book**. Documented as it is, with a pointer
   from the stage guide to the order guide, rather than as a nine-stage pipeline.

6. **Two Lead states are legacy.** "Contacting" and "Contacted" can be advanced
   out of and nothing can be put into them. Named as legacy, never recommended.

7. **Legacy Store screens named and excluded from new work:** "Purchase forms —
   legacy" (`/operations/requisitions`, a print form that never becomes a
   purchase order in data), "Deliveries (legacy)", and "PO sheets (legacy print)".

## 7. Not done, as instructed

No backend Help model or API. No GRAV AI retrieval, analytics, feedback storage,
screenshots, new tours or browser-based content editing. No Costing, HR,
Accounting or production-floor guides. No new dependency. No change to the Store
Quick Tour or the Sales StageGuide. No full repository test suite and no broad
visual regression run. Nothing committed; no branch created; every unrelated
uncommitted change in both repositories preserved.

## 8. Known limitations for Chunk 3

1. **Audience is department-scoped only.** Guides needing a capability (costing
   policy, margin, payroll, accounting actions) cannot be expressed until a
   server-side capability contract exists. `parseAudience` is the one place to
   extend, and `canRead` is the one place to evaluate it.
2. **The Help catalogue still omits Costing** for the same reason as Chunk 1 —
   a route prefix there would let a typed URL name a capability-gated
   application.
3. **Search remains a client-side rank over authorized metadata.** Correct for
   twenty guides; a real index will be wanted well before the corpus reaches the
   whole company.
4. **Role-level scoping does not exist.** Every employee holding a department
   sees all of that department's guides. A Store viewer and a Store approver get
   the same library.
5. **`visibleCountsByApp` is computed per request** from the full corpus. Fine at
   twenty articles, worth memoising if the corpus grows a lot.

---

# GRAV Help — Chunk 1 handoff (superseded by Chunk 2 below)

> **Chunk:** Fast Chunk 1 — Foundation (frontend Help application + five Getting
> Started guides)
>
> **Date:** 2026-09-06
>
> **Frontend repository:** `/Users/risheeray/grav-cms`
>
> **Commit status:** NOTHING COMMITTED. No branch created. Every change below is
> in the working tree of `MAIN_SUB_BRANCH`, alongside the large pre-existing
> uncommitted Sales/Store/Costing/Accounting work, which was not touched.

## 1. What was built

An authenticated `/help` application inside the existing Next.js frontend:
Help home with search, one topic hub, one reusable article page, five Getting
Started guides, a global "Help for this page" launcher, and a pure route matcher.
No business record is read or changed anywhere in it.

## 2. Files added

```text
grav-cms/
  app/help/layout.js                       metadata only (chrome is per page — see §5)
  app/help/page.js                         /help
  app/help/[app]/page.js                   /help/:app
  app/help/[app]/[slug]/page.js            /help/:app/:slug

  components/help/HelpChrome.js            FrostShell nav config, no guardSlug
  components/help/HelpGate.js              the two failure screens (server component)
  components/help/HelpRetry.js             the retry button on the "unreachable" screen
  components/help/HelpHome.js              home body (server component)
  components/help/HelpSearch.js            the one client island
  components/help/HelpArticle.js           block renderer + article chrome
  components/help/HelpLauncher.js          "Help for this page"
  components/help/helpBits.js              LinkButton, ArticleCard, AppCard

  lib/help/catalogue.js                    display names + route prefixes (NOT access)
  lib/help/content.js                      loader, parser, validator (server only)
  lib/help/routeMatcher.js                 pure matching + safeReturnPath
  lib/help/session.js                      server-side verify (server only)
  lib/help/content.test.mjs                22 focused tests
  lib/help/routeMatcher.test.mjs           18 focused tests

  content/help/getting-started/sign-in.md
  content/help/getting-started/choose-an-application.md
  content/help/getting-started/switch-applications.md
  content/help/getting-started/understand-access.md
  content/help/getting-started/get-help-for-this-page.md
```

## 3. Files changed

| File | Change |
|---|---|
| `components/shell/AppShell.js` | Mounts `HelpLauncher` once, gated on the same `checked && authed && !assistantHidden(pathname)` condition the global assistant already uses. Added in both return branches so its tree position is stable across a navigation. |
| `middleware.js` | `/help` added to `PROTECTED_PREFIXES`. |
| `package.json` | Test glob extended with `"lib/**/*.test.mjs"` so the new tests are discovered by `npm test`. No dependency added. |

No other file was touched. No backend model, route, collection or service was
created or modified.

## 4. Content schema and parser boundary

### Front matter

Required on every article: `id`, `title`, `app`, `summary`, `kind`, `status`,
`owner`, `last_verified`. Optional lists: `routes`, `source_refs`, `keywords`.

Validated at load time, with a developer-facing error naming the file:

- `status` is one of `draft | published | needs_review | legacy | retired`;
- `last_verified` is a real ISO `YYYY-MM-DD` date;
- every `route` starts with `/`;
- every `source_ref` is repository-relative — not absolute, not a URL, and
  containing no `..` segment;
- `id` **must** equal `<app>.<slug>`, `app` **must** equal the folder name and
  `slug` is the filename, so ids, folders and URLs cannot drift apart;
- ids are unique across the corpus;
- a `published` article carries all six visible sections **in order**:
  Use this when · Before you start · Steps · Done when · If blocked · Who acts next.

A malformed published article throws rather than partially rendering. A `draft`
is deliberately exempt from the six-section rule.

### Parser boundary

`lib/help/content.js` emits typed blocks, never HTML:

```text
{ type: "heading",   text }
{ type: "paragraph", spans }
{ type: "bullets",   items: spans[] }
{ type: "numbers",   items: spans[] }
spans: { type: "text" | "code", text }
```

Supported syntax is exactly: `## heading`, paragraphs (wrapped lines joined),
`- bullets`, `1. numbered`, `` `inline code` `` and `**strong**`. There is no
block type that can express raw HTML, a script, an image, a link or an embedded
component, and `HelpArticle.js` uses no `dangerouslySetInnerHTML`. A `<script>`
in an article renders as those characters — pinned by a test.

**`**strong**` was added beyond the brief's list**, and is recorded here as a
deviation. The "If blocked" section of every guide is a run of named cases —
"**Your email or password is refused.**" and then what to do — and without
emphasis they collapse into a paragraph the reader has to parse to find their
own case in. It was caught in the manual pass, where the literal asterisks were
on screen. It is the same class of thing as the code span: one more span type
carrying `text`, with no attribute, no href and no element the author chose,
which a test asserts directly.

No Markdown, search, tour or analytics dependency was added.

## 5. Authentication and safe-return behaviour

### Two layers, matching the app's existing pattern

1. `middleware.js` bounces a visitor with **no** `auth_token` cookie to
   `/?next=<path>` before the page is generated.
2. `lib/help/session.js` `verifyHelpSession()` does the authoritative check on
   the **server**, forwarding the request's own cookie to the same
   `POST /api/auth/verify` the whole app uses.

**Deviation to record.** The chunk brief said to reuse the shared client-side
`verifySession()` rather than add a competing call. Help is verified on the
server instead, for one reason: the thing being protected here IS the page. An
article body is the payload, not a later fetch, so a client gate would hide it
after it had already been sent — which would not satisfy "an unauthenticated
visitor cannot read the Help article body". It is not a second authentication
mechanism: it is the same endpoint, the same cookie, the same database re-read,
differing only in which side of the wire asks. No token is minted and no
department is required or switched into.

Each page calls `verifyHelpSession()` and **returns before loading content** on
any non-`ok` answer, so an article is never read from disk, parsed or serialised
for an unverified request.

Three outcomes, told apart:

| State | Meaning | Screen |
|---|---|---|
| `ok` | verified employee | Help renders |
| `unauthenticated` | server said 401/403 | "Sign in to read GRAV Help" + `/?next=<path>` |
| `unreachable` | network failure or 5xx | "Could not confirm your session" + Try again |

An empty Help library is never shown for a failure — it would claim the guides
do not exist.

### Why the chrome is mounted per page, not in the layout

`FrostShell` carries `DepartmentGuard`, whose own **client** check redirects an
invalid session to the portal. With the chrome in `app/help/layout.js`, the
server gate rendered for one frame and was then replaced by that redirect — two
gates racing, and the less informative one winning. This was observed and fixed:
`layout.js` is metadata only (the `app/planner/layout.js` arrangement), each page
wraps its content in `HelpChrome` only on the `ok` path, and `HelpGate` renders
alone. `HelpGate`/`HelpRetry` therefore use the flat `--g-*` palette
(`--aurora`, `bg-card`, `border-border`), exactly as `DepartmentGuard`'s own
denial screen does, because Frost tokens do not resolve outside `.grav-ui`.

`HelpChrome` passes **no `guardSlug`** — Help is not a department and mints no
token, the same call `Planner_DashboardLayout` makes.

### Application cards

Come only from `departments` on the verified response. `lib/help/catalogue.js`
supplies words and paths for a slug that is *already* in that list; it never adds
one. A department the server returned that the catalogue does not know still gets
a card using the server's own name, so Help cannot silently drop an application
somebody holds.

### Safe return

`safeReturnPath()` (`lib/help/routeMatcher.js`) **refuses** rather than
sanitises. Query and hash are stripped, then the value must be a single-slash
in-app pathname: `//host`, `https://…`, `javascript:…`, `data:…`, backslashes,
control characters, a scheme in the first segment, and anything over 512
characters all return `null`, and the return link is simply not drawn. Nothing is
ever navigated to automatically. `HelpLauncher` applies the same rules before
writing `?from=`, and the receiving page validates independently.

## 6. Route matcher behaviour

`findHelpForRoute(pathname, articles)` is pure, has no I/O, and never throws —
it is called from a page that must not break because somebody typed a strange
address. It returns `{ kind, app, articles }`:

- `"route"` — one or more articles declare this screen. Patterns are literal
  except `:name`, which matches exactly one non-empty segment; the most specific
  pattern is offered first (literal segments weighted over parameterised ones).
- `"app"` — no article matches, but a catalogue prefix names the application.
- `"fallback"` — Help could not place the route; Getting Started is the answer.

Trailing slashes, query strings and hashes never change the result. A malformed
path, a `null` article list, or articles with a non-array `routes` all degrade to
`"fallback"`.

**Costing is deliberately absent from the catalogue.** It is capability-gated
rather than department-assigned, its server-side Help visibility contract does
not exist yet, and a prefix here would let a typed `/costing` URL name the
application — i.e. infer access from an address. `/costing/...` currently falls
back to Getting Started. Pinned by a test.

## 7. The five guides

| id | URL | Status |
|---|---|---|
| `getting-started.sign-in` | `/help/getting-started/sign-in` | published |
| `getting-started.choose-an-application` | `/help/getting-started/choose-an-application` | published |
| `getting-started.switch-applications` | `/help/getting-started/switch-applications` | published |
| `getting-started.understand-access` | `/help/getting-started/understand-access` | published |
| `getting-started.get-help-for-this-page` | `/help/getting-started/get-help-for-this-page` | published |

All five carry `owner: Platform`, `last_verified: 2026-09-06`, and `source_refs`
pointing at the code each was written from (`app/login/page.js`,
`components/onboarding/DepartmentPortal.js`, `components/shell/AppSwitcherNav.js`,
`components/shell/useMyApps.js`, `lib/roles.js`, `components/access/RoleGate.js`,
`components/access/HeldChangeWatcher.js`, `components/access/ApprovalQueue.js`,
`middleware.js`, `components/access/DepartmentGuard.js`).

Content is general and client-safe: no Costing, margin, salary, payroll or
financial figures. Nothing was invented — the access guide describes the four
roles, hidden controls, read-only screens and the held-for-approval (HTTP 202)
path that the code above actually establishes, and says explicitly that some
applications show approvals on the work screen rather than on a queue page.

## 8. The launcher

Mounted once, in `AppShell`, beside the global assistant. Hidden on the same
public/sign-in boundary the assistant uses (`assistantHidden`), and on `/help`
itself. Visible on `/onboarding`, which is authenticated.

Position: **fixed, right edge, vertically centred, `z-[80]`**. Every other
candidate is occupied, which is why:

- bottom centre — the GRAV assistant composer (`fixed bottom-6`, up to 660px, `z-[120]`);
- bottom right — `CrmDrawer`'s toast stack (`fixed bottom-4 right-4`, `z-[95]`);
- bottom edge — the department rail becomes a 62px strip below 720px, i.e. the mobile navigation;
- top bar — FrostShell's own per-department controls.

`z-[80]` is below `CrmDrawer`/modals (`z-[85]`), toasts (`z-[95]`) and the
assistant (`z-[120]`), so the launcher disappears behind an open drawer instead
of floating over it. It is a link, keyboard reachable, labelled "Help for this
page", with the label revealed on hover and on `:focus-visible`. It uses the
`--g-*` palette because it mounts outside any `.grav-ui` subtree.

No department layout was edited.

## 9. Checks and exact results

### Focused tests

```bash
node --test lib/help/routeMatcher.test.mjs lib/help/content.test.mjs
```

- `lib/help/routeMatcher.test.mjs` — **18 pass, 0 fail**
- `lib/help/content.test.mjs` — **22 pass, 0 fail**

Covering: front-matter parsing including duplicate-key rejection; the parser
boundary (HTML in, characters out; only four block types exist); required
metadata; the five statuses; ISO dates; routes starting with `/`; source refs
that escape the repository; id/folder/filename drift; every one of the six
sections individually missing; section order; duplicate ids; exact,
parameterised and fallback route matching; unsafe `from` values; and
draft/unpublished content excluded from navigation and from a typed URL.

One real bug was found and fixed by these tests: the body was left with a
leading blank line when front matter was followed by more than one newline.

### Server-response checks (dev server on :3001, backend on :5050)

With an invalid session cookie, so middleware passes and the server gate decides:

| URL | Status | Gate shown | Article body in response |
|---|---|---|---|
| `/help` | 200 | yes | no |
| `/help/getting-started` | 200 | yes | no |
| `/help/getting-started/sign-in` | 200 | yes | no |

With no cookie at all, `/help` returns **307** to `/?next=/help` from middleware.

### Lint

Not run. `npm run lint` is broken repository-wide, independently of this chunk:
ESLint 10 requires `eslint.config.*` and the repository has none, so the script
fails before reading any file. Not repaired — out of scope.

### Manual checks

Both ran, against the live dev server with a real signed-in session. Results in
§12.

## 10. Known limitations for Chunk 2

1. **No permission filtering of content.** Every published article is visible to
   every verified employee, which is correct while the corpus is Getting Started
   only. Before any restricted application content lands, filtering must happen
   on the server **before** the search index or any article reaches the browser.
   The seam exists: `searchIndex()` / `routeIndex()` / `publishedArticles()` in
   `lib/help/content.js` are the four call sites to gate.
2. **Costing and other capability-only applications are not in the catalogue.**
   They need a real server-side Help visibility contract first.
3. **Search is client-side over metadata only** (title, summary, keywords). It is
   correct for five guides and will need a real index — and body coverage — once
   the corpus is tens of articles.
4. **Route mappings cover Getting Started only.** Store and Sales task-level
   mappings are Chunk 2 work; the matcher already supports `:id` patterns for
   them.
5. **No feedback storage.** Articles print "tell the named owner" and a verified
   date; nothing is recorded.
6. **`content/help` is read from `process.cwd()` at request time.** Fine for
   `next start`; a serverless target would need the tree bundled.
7. **Every Help route is `force-dynamic`** because the session is read per
   request. Acceptable at this size; worth revisiting if Help grows.
8. **The Sales stage playbook and the Store Quick Tour still hold their own
   copies of instructions.** Neither was touched. Unifying them behind the Help
   content registry is the Chunk 2 job the product plan §6.5 describes.

## 11. Not started, as instructed

No Store or Sales guide migration. No screenshots. No tours. No GRAV AI /
assistant integration. No analytics. No browser authoring. No backend Help API,
model, route or collection. No dependency added. No existing Store/Sales help
implementation changed. No business workflow changed. `docs/tasks/current-task.md`
untouched. All unrelated uncommitted work in both repositories left alone.
Nothing committed; no branch created.

## Correction note — strict `last_verified` calendar validation

The `last_verified` validator now requires the existing zero-padded
`YYYY-MM-DD` shape and round-trips the parsed components through a UTC `Date`,
rejecting impossible month/day combinations while applying the platform's real
leap-year rules without locale or timezone dependence. Focused cases cover
rejection of `2026-02-29`, `2026-02-30`, and `2026-04-31`, and acceptance of
`2024-02-29`.

Focused verification: `node --test lib/help/routeMatcher.test.mjs lib/help/content.test.mjs`
— **52 tests passed, 0 failed** (Node emitted only the existing module-type
warnings). No other implementation scope changed. Chunk 2 was not started.
Nothing is committed; no branch was created.

## 12. Manual check results

Run on the local dev server (`:3001`) against the live backend (`:5050`), signed
in as a real employee holding 19 applications.

### Desktop — passed

1. Opened `/ceo/dashboard`. The launcher is present at the right edge, clear of
   the department rail, the top bar and the assistant.
2. Its href was `/help?from=%2Fceo%2Fdashboard`.
3. Help home opened, showed "No guide for that CEO screen yet" (correct — the
   CEO family is in the catalogue and has no guides), Getting Started with five
   guides, and all 19 application cards, each labelled "Guides coming next".
4. Searched "approval" → 1 result, "Understand access and approvals".
   Searched "zzqq" → "No guide mentions “zzqq”" with the honest next step.
5. Opened the guide from home. The article rendered with owner, verified date,
   the six sections in order, and the "Information out of date?" note.
6. "Back to where you were" → `/ceo/dashboard`. Confirmed by navigation.
7. Repeated from `/onboarding`: Help offered "Choose an application" and "Switch
   between GRAV applications" under "For the screen you came from" — the route
   match, not the fallback.

### Phone width (375 × 812) — passed

1. On `/sales/dashboard` (no bottom rail) and `/ceo/dashboard` (mobile bottom
   rail present), the launcher sits mid-right and covers neither the bottom
   navigation strip, the assistant bubble, nor any control — only read-only
   text passes behind it.
2. The article page reads at a single column with no horizontal scroll, and the
   mobile bottom navigation is unobstructed.
3. The launcher's label does not expand on touch, because mobile emulation
   translates pointer to touch. That is correct rather than a defect: the reveal
   is a pointer/keyboard affordance and the `aria-label` names the control on
   every device.

### Additional verifications

- **Unauthenticated body:** `/help/getting-started/sign-in` with an invalid
  session returns 200 with the gate and **zero** article content in the
  response — checked by grepping the raw HTML for phrases unique to the body.
- **Hostile `from`:** `/help?from=https%3A%2F%2Fevil.example%2Fsteal` renders no
  return link, and **no `href`, `action` or `src` anywhere in the document
  contains the value**. (It appears once inside Next's own RSC payload as the
  request URL, which Next serialises for every route and which is not navigable.)
- **Empty hub:** `/help/store` — an application Help can name but has no guides
  for — returns the application's normal 404, and its `<title>` is the neutral
  "Help · GRAV" rather than "Store & Purchase".
- **Launcher boundary:** absent on `/login` and on every `/help` route; present
  on `/onboarding`, which is authenticated.

### Three defects found by the manual pass, and fixed

1. **The gate was being redirected away.** With the chrome in `app/help/layout.js`,
   FrostShell's `DepartmentGuard` bounced an invalid session to the landing page
   before the reader could read the sign-in card. Fixed by moving the chrome into
   each page's authenticated branch — see §5.
2. **`**bold**` rendered literally** in the guides' own text. Fixed by adding the
   `strong` span — see §4.
3. **The return context survived exactly one click.** Opening a guide from Help
   home dropped `?from=`, so the article had no way back. Fixed by threading the
   validated `returnTo` through every in-Help link (`ArticleCard`, `AppCard`,
   search results, breadcrumbs, hub links). This is what the "Back to where you
   were" step of the desktop check now proves.

### Full test suite

`npm test` runs 2559 tests: 2556 pass, 3 fail. **All three failures pre-date this
chunk** and are in the uncommitted Store work
(`components/store/inventory-valuation/valuation.test.mjs`,
`components/store/navigation/nav.test.mjs`,
`components/store/service-master/services.test.mjs`). Confirmed by running the
*original* test glob, which reports the same 3 failures out of 2493 tests. This
chunk adds 66 tests, all passing, and touches none of those files.
