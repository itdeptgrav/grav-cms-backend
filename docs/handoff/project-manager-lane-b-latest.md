# Project Manager — Lane B handoff

> Lane B is the frontend lane of the Project Manager professionalisation. It
> projects the authority the backend already declares and never invents one.
> Lane A owns `docs/handoff/latest-implementation.md`; this file is Lane B's.

## B1 — Requests desk truth and responsive worklist (complete)

**Frontend repo:** `/Users/risheeray/grav-cms`

### Files changed

| File | Change |
|---|---|
| `components/pm/requestDesk.js` | **new.** Pure, dependency-free desk vocabulary: kind, PM state, TL state, counting, filtering and the "may this be submitted" gate. |
| `components/pm/requestDesk.test.mjs` | **new.** `node:test` coverage for the split and the two review corrections (17 tests). |
| `app/project-manager/dashboard/requests/page.js` | Two explicit worklists — Decisions (MO) and MRF oversight — scoped KPIs, TL vocabulary, no MRF action controls, desktop table + stacked cards below `lg`. |
| `app/project-manager/dashboard/requests/[type]/[id]/page.js` | Status chip and action availability derived from the helper; PM decision trail restricted to MOs; TL decision trail added for MRFs; shortage copy reworded as coordination information. |
| `components/pm/RequestActionSlider.js` | Manufacturing-order decisions only. Every MRF branch removed; an MRF renders nothing at all. |

No backend file was edited. No URL, request, response field, query parameter or
business rule was changed.

### B1 review corrections (second pass)

**1. The MRF ownership banner is state-aware.** It previously read "this one is
with `<approverName>`, then go straight to the Store" for every MRF that carried
an assigned approver — present tense, in every state. On a request the TL
approved in July, rejected, or that was cancelled, that sends someone to chase a
decision already made. `mrfRouting()` in `components/pm/requestDesk.js` now
returns the fact — `state`, `stage`, `decided`, `proceedsToStore`, `ownerLabel`,
`holderName`, `summary` — and the page renders it:

| MRF state | Banner |
|---|---|
| Awaiting TL | awaiting its assigned Primary Manager/TL, naming `approverName` when present |
| TL approved / part-issued / issued / returned / completed / unfulfilled | the TL has already decided; fulfilment is the Store's |
| TL rejected | the TL rejected it; not passed on for fulfilment |
| Cancelled / unknown | view-only explanation, no owner and no next action claimed |

`approverName` is the ASSIGNED approver, not a record of who decided, so it is
quoted only while the decision is still theirs. Who actually decided stays on
the TL decision trail (`tlApprovedByName` / `tlRejectedByName`). No new field,
call or workflow state.

**2. The Decisions subtitle follows the filter.** A fixed "Manufacturing-order
requests awaiting a Project Manager decision" contradicted the table as soon as
anyone chose PM Approved. `decisionsSubtitle(status)` supplies copy per filter
and falls back to neutral wording that is true of any selection; the default
Pending PM view still reads as an actionable queue.

Everything from the first pass is unchanged: the Decisions/oversight split, the
PM and TL counters, default filters, responsive behaviour, MO approve/reject,
the defensive MRF-mutation gate, and the Lane A dependency below.

### What the screen now asserts

- Manufacturing-order requests are PM decisions (`pmApproved` / `pmRejected`),
  labelled *Pending PM / PM Approved / PM Rejected*.
- Material requests are oversight, labelled in TL vocabulary
  (*Awaiting TL / TL Approved / TL Rejected*), with no approve or reject
  control anywhere and no PM decision recorded against them.
- MRFs contribute to no PM total. The two scopes have separate KPI strips,
  separate status filters and separate empty states.
- A legacy `pmApproved` still stored on an old MRF is treated as history and is
  never rendered as a live PM decision.

## Dependency for Lane A

**`GET /api/cms/pm/requests` cannot report an MRF's TL state.**

`routes/CMS_Routes/pm/pmRequestsRoutes.js` maps each MRF with

```js
tlApproved: !!m.tlApproved,   tlRejected: !!m.tlRejected,
approverName: m.approverName, tlApprovedByName: m.tlApprovedByName,
autoForwarded: !!m.autoForwarded,
```

but the `.select(...)` on the same query (line 44) does not list any of those
fields, so the lean document never carries them. Every MRF in the list response
therefore arrives as `tlApproved: false, tlRejected: false, approverName: ""` —
including ones the TL approved months ago. `GET /mrf/:id` is unaffected: it
returns the whole document, and the detail page shows the real TL trail.

Lane B has **not** worked around this by inventing a state. The desk helper
reads the explicit TL flags first and falls back to the MRF's own lifecycle
`status`, which the query does select and which the model documents as the TL
decision it records (`PENDING` = awaiting TL, `APPROVED` = TL approved,
`REJECTED` = TL said no, `UNFULFILLED` = TL said yes / store cannot supply).
A row with neither signal renders *TL status unknown*, never *Awaiting TL* and
never *Pending PM*.

**Asked of Lane A:** add `tlApproved tlApprovedAt tlApprovedByName tlRejected
tlRejectedAt tlRejectionNote approverName autoForwarded` to that `.select(...)`
so the fields the route already promises are actually sent. The frontend needs
no change when it lands — the explicit flags simply start winning over the
status fallback. `CANCELLED` is deliberately left as *unknown*: a withdrawn
request is not a TL verdict, and inventing one is the failure mode this chunk
exists to remove.

## Verification

- `node --test components/pm/requestDesk.test.mjs` — 17/17 pass (12 from the
  first pass, plus four on MRF routing copy and one on the Decisions subtitle).
- `npm test` — 201/201 pass.
- SWC parse check clean on all changed files.
- `next build` fails only on the pre-existing, unrelated
  `app/accountant/sales-vouchers/new/page.js` duplicate `splitGstByRate`.
- Browser-verified at 375 px, 768 px and 1440 px against local fixtures with no
  live backend write: pending/approved/rejected MO, awaiting/approved/rejected/
  unknown MRF, mixed, empty Decisions, empty oversight, loading, API failure,
  and viewer vs approver affordances. The only mutation any MRF interaction
  produced was none; the MO path still sends
  `PATCH /api/cms/pm/requests/mo/:id/approve` unchanged.
- Correction pass re-verified in the browser across all seven MRF detail states
  — pending, issued, completed, unfulfilled, rejected, cancelled and a record
  with no TL evidence — each carrying an assigned `approverName`. Only the
  pending one names them; no decided or rejected request is described as
  waiting with its TL. The four Decisions subtitles were checked against their
  filters, with the PM counters (3/1/1/1 beside seven MRFs) unmoved.

---

## B2 — Navigation simplification (complete)

> B2 was re-scoped from "manufacturing-order register usability" to the
> navigation bar. The register and `moStatus.js` are still in Lane A's working
> tree; nothing in this chunk touches either.

### Files changed

| File | Change |
|---|---|
| `components/pm/projectManagerNavigation.js` | **new.** The five entries as pure data, the route→active-key resolver, and the Pipeline badge rule. Dependency-free. |
| `components/pm/projectManagerNavigation.test.mjs` | **new.** 14 `node:test` cases — nav contract and route resolution. |
| `components/DashboardLayout.js` | Renders that structure with icons keyed by nav key; resolves the active key from `usePathname()`. |
| `components/shell/FrostShell.js` | Top variant now honours `item.badge` (see the shared-shell note below). |

No route was renamed, removed, redirected or recreated. No page body, no API
call, no backend file.

### Old versus new

| Before (7) | After (5) |
|---|---|
| Dashboard | **Overview** → `/project-manager/dashboard` |
| Requests | **Requests** → `/project-manager/dashboard/requests` |
| Manufacturing orders | **Production** ▾ — Manufacturing orders, Production schedule, Products & BOM |
| MF production schedule | **Pipeline** → `/project-manager/dashboard/journeys` (keeps its live count) |
| Products & BOM | **Setup** ▾ (`minRole: "editor"`) — Measurements, Units & packaging, Operations, Warehouses, Devices & machines |
| Setting & Config ▾ | |
| Pipeline | |
| Requests | |

Renamed labels only: "MF production schedule" → "Production schedule",
"Setting & Config" → "Setup", "Measurement to product" → "Measurements",
"Units & conversions" → "Units & packaging", "Warehouse" → "Warehouses",
"Dashboard" → "Overview". The `{ section: … }` headings are gone; the two
groups are the grouping now.

### Route → active key

Exact: `/project-manager/dashboard` → `overview`. As a prefix it would light
Overview on every screen in the app, including the hidden ones.

Prefix rules (longest wins, whole segments only, nesting included):

| Route prefix | Active key |
|---|---|
| `…/dashboard/production/manufacturing-orders` | `manufacturing-orders` |
| `…/dashboard/production/work-orders` | `manufacturing-orders` (a work order is reached from its order) |
| `…/dashboard/production/schedule` | `production-schedule` |
| `…/dashboard/requests` | `requests` |
| `…/dashboard/journeys` | `journeys` |
| `/project-manager/products` | `products` |
| `/project-manager/size-config` | `size-config` |
| `…/inventory-configurations/units-packaging` | `units-packaging` |
| `…/inventory-configurations/registered-operations` | `operations` |
| `…/inventory-configurations/warehouse` | `warehouse` |
| `…/inventory-configurations/devices-machines` | `devices-machines` |

Unmapped routes keep whatever the page passed as `activeMenu`; with no
fallback the resolver returns `null`. Deliberately unmapped: the retired
`/dashboard/production` launcher, `work-flow-track`, `productionStats`,
`approvals`, `settings`, `support` — hidden pages with no nav button, where
highlighting some other button would be its own small lie. All stay reachable;
`HeldChangeWatcher` still deep-links to `/dashboard/approvals`.

**Why a resolver rather than editing the pages.** Manufacturing-order screens
pass `activeMenu="production"`, which matched no nav key — nothing was
highlighted. The shared screens the PM reuses (products, size-config, inventory
configurations) pass Sales' own keys. Those pages are shared with Sales,
Merchandiser and Production Supervisor, so fixing this shell by editing them
would change what three other shells receive. The resolver is PM-only and no
page needed to know.

### One shared-shell change, and why it was unavoidable

`FrostShell`'s nav contract documents `badge` on a nav item. The **side**
variant rendered it; the **top** variant silently dropped it. Two top-variant
consumers already set it — this layout's Pipeline count and Merchandiser's
Journeys count — so both computed a number the shell threw away. Rendering it
in the top bar and the top drawer is additive in CODE: a consumer that never
sets `badge` is byte-identical.

**It is not additive on screen for Merchandiser.** That layout already
configures a Journeys badge (`Merchandiser_DashboardLayout.js`), so this change
makes a count appear in its bar that was previously computed and discarded.
That is the behaviour its own code always asked for, but it IS a visible change
to another application's navigation and should be described as one — an earlier
report said no other application's navigation changed, without that
qualification. No other consumer sets `badge` on a top-variant nav item, so
nothing else moved. Nothing else in `FrostShell` changed.

### Role gating

`minRole: "editor"` stays on Setup and on nothing else, and the layout still
fails closed while the role resolves. Verified with a viewer session sampled
every 40 ms from mount: four entries (Overview, Requests, Production, Pipeline),
Setup never present in any sampled frame. An approver session shows Setup with
all five children. Reading the floor stays open to viewers.

### Browser results

Desktop (1440×900, authenticated PM session, fixture API):

- five entries, nav strip `scrollWidth === clientWidth` (954 px, no horizontal
  scroll), every label on one 32 px line, none clipped;
- both dropdowns open fully inside the viewport, hold exactly their required
  children at their required hrefs, and close on an outside click;
- selecting a child closes the dropdown and navigates;
- active state confirmed on: Overview, Requests, request detail
  (`/requests/mrf/:id`), Pipeline, MO list, **MO detail** (`…/manufacturing-orders/:id`
  → Production / Manufacturing orders), Production schedule, Products & BOM,
  product create, Measurements, Units & packaging, Operations, Warehouses,
  Devices & machines;
- Pipeline shows its badge (4) in the bar and in the drawer.

Mobile (375×812): the menu button opens the drawer, all eleven destinations are
reachable, the two groups appear as labelled PRODUCTION and SETUP sections with
the active child highlighted, selecting a route closes the drawer and navigates,
and the page has no horizontal overflow.

Two honest notes:

1. The top variant's drawer rendered groups as always-open labelled sections
   rather than collapsible accordions. **Fixed in B2.1 below.** The reasoning
   that an accordion would affect every other top-variant department was right;
   the fix is an opt-in prop, so their drawers are untouched.
2. The work-order and MO-planning pages render their *not-found* branch outside
   `DashboardLayout`, so with a fixture id there is no bar to highlight. That is
   page-body behaviour predating this chunk and out of its scope; both URLs are
   covered by the resolver's tests, and the MO detail page — whose error branch
   does render the layout — was confirmed in the browser.

### Tests and build

- `node --test components/pm/projectManagerNavigation.test.mjs` — 14/14.
- `npm test` — 296/296 (the suite also grew from the concurrent Store lane).
- SWC parse check clean on all four changed files.
- `next build` fails only on the pre-existing, unrelated
  `app/accountant/sales-vouchers/new/page.js` duplicate `splitGstByRate`.
- `git diff --check` clean in both repositories.

### Untouched

No backend application code. Lane A's dashboard, manufacturing-order register
and `moStatus.js` are unchanged, as is `docs/handoff/latest-implementation.md`.
All Store/Purchase work is untouched. The B1 request-desk changes are intact.

---

## B2.1 — Collapsible mobile drawer groups (complete)

B2 left the phone drawer printing Production and Setup as static `<p>` headings
with their children always beneath: two groups' worth of links permanently on
screen, and neither group collapsible. The desktop dropdowns behaved one way
and the drawer another.

### Files changed

| File | Change |
|---|---|
| `components/shell/drawerGroups.js` | **new.** The open/closed rules, dependency-free: which group holds the active key, the seed state, the toggle, and "open the active group without disturbing the rest". |
| `components/shell/drawerGroups.test.mjs` | **new.** 6 `node:test` cases — the rules, the default-off prop, and who opts in. |
| `components/shell/FrostShell.js` | New opt-in prop `collapsibleTopDrawerGroups` (default `false`). Set, the top variant's drawer groups render as `<button type="button">` with `aria-expanded`, a chevron and children only while open. Omitted, the static-heading drawer renders exactly as before. |
| `components/DashboardLayout.js` | Passes `collapsibleTopDrawerGroups`; stale header comment corrected. |

### Behaviour

- Group headings are buttons with `type="button"` and `aria-expanded`, and a
  chevron that rotates when open.
- Toggling goes through the existing `openGroups` map, so Production and Setup
  are independent.
- The group holding the current page opens itself: on first render (seed), when
  a client-side navigation changes `activeMenu`, and each time the drawer is
  reopened. `openActiveGroup` returns the SAME object when nothing changes, so
  the effect cannot loop, and a group collapsed by hand stays collapsed until
  the route or the drawer actually moves.
- A group that holds the active page while collapsed shows a small dot, so the
  signal survives the collapse.
- Selecting a child still closes the drawer (`NavLink`'s `closeDrawer`).

### Stale comment

`DashboardLayout.js` still claimed Production's three destinations "are
top-level entries now". They have been children of the Production group since
B2; the comment now says so.

### Browser results (375×812, authenticated session, fixture API)

| Step | Result |
|---|---|
| Open drawer on `/dashboard` | Production and Setup both `aria-expanded="false"`; no static `<p>` group headings remain; only the three direct links visible |
| Expand Production | `true`; its three children appear |
| Expand Setup | `true`; Production stays `true`; all five children appear |
| Collapse Production | Production `false`, **Setup still `true`** with its five children — independent |
| Reopen Production, collapse Setup | states flip back independently |
| Select "Production schedule" | navigates to `/dashboard/production/schedule`; drawer closes |
| Reopen the drawer there | Production auto-opens (`true`), Setup stays closed, "Production schedule" carries `aria-current="page"` |
| Collapse Production by hand, close and reopen the drawer | Production reopens — the page you are on is never hidden inside a closed group |
| Collapsed active group | shows its marker dot |
| Select "Warehouses" (approver) | navigates; drawer closes; reopened, Setup is open with "Warehouses" active and Production closed |
| Viewer on `/production/schedule` | only Production is a group; Setup absent in all 9 sampled frames (40 ms interval) |
| Horizontal overflow | none at any step |

Desktop rechecked at 1440×900 on `/production/schedule`: five entries, the nav
strip does not scroll, Production is active, its portalled dropdown holds the
three children with "Production schedule" marked, Setup holds its five, both
stay inside the viewport and close on an outside click, and the drawer is
`display: none`. Unchanged.

### Tests and build

- `node --test components/pm/projectManagerNavigation.test.mjs` — 14/14.
- `node --test components/shell/drawerGroups.test.mjs` — 6/6.
- `npm test` — 330/330.
- SWC parse clean on all four changed files.
- `next build` fails only on the pre-existing, unrelated
  `app/accountant/sales-vouchers/new/page.js` duplicate `splitGstByRate`.
- `git diff --check` clean in both repositories.

### Untouched

No backend application code, no Lane A file, no Store/Purchase file, no route,
no page body. The five-entry structure, the route resolver, every href, the
desktop dropdowns, the Pipeline badge and the viewer/editor gating are as B2
left them.

---

## B2.2 — Manufacturing-order register usability (complete)

The register asked the server one question and painted whatever came back. Three
faults all looked like the data's fault:

1. **A failure looked like an empty register.** `if (res.ok)` with no `else`
   swallowed every non-OK response, so a 500, an expired session and a genuinely
   empty register all rendered the words "No manufacturing orders".
2. **A slow answer could overwrite a newer one.** It fetched on every keystroke
   with no cancellation, so the response to `ac` could land on top of the
   results for `acme`.
3. **A filtered register could not be linked, refreshed or reached with Back.**
   The filters lived in component state.

It also only offered status; Lane A 3A had shipped `priority`, `deadlineRisk`,
and the additive `deadline` / `deadlineRisk` row fields, all unused.

### Files changed

| File | Change |
|---|---|
| `components/manufacturing/moRegister.js` | **new.** The question (normalise, URL, request params, identity), the filter vocabularies, deadline-risk wording, pagination arithmetic and the missing-versus-zero rules. Dependency-free; imports the shared vocabulary from `moStatus.js` rather than restating it. |
| `components/manufacturing/moRegister.test.mjs` | **new.** 23 `node:test` cases. |
| `app/project-manager/dashboard/production/manufacturing-orders/page.js` | Rewritten around that helper: URL-backed filters, debounced and abortable search, explicit request states, honest rows, accessible controls. Lane A's Chunk 1 work in this file (server-computed `displayStatus`, the shared `moStatus` vocabulary, the single-query comment) is preserved. |

`components/manufacturing/moStatus.js` and its 14 tests are untouched. No
backend file, no new endpoint, no URL change: the detail link is byte-identical.

### Filters

Search / Status / Priority / Deadline / Clear filters / view toggle, in one
responsive bar. The search placeholder states its real coverage —
**"Search MO number, customer or email"** — which is exactly what the server
matches (`searchMatch` in `moListProjection.js`).

Deadline maps to the backend's own values: Overdue → `overdue`, Due within 7
days → `due_soon`, **Later than 7 days → `on_track`**, No deadline → `none`,
Closed → `closed`. "Later than 7 days" rather than "on track" on purpose: the
server compares one date to one instant and models no capacity — calling it
"on track" would promise a prediction the data cannot make. A test asserts no
label reads as a prediction and none leaks a raw enum.

Any filter change resets to page 1. An active-filter summary appears only when
something is active, in the controls' own words ("Status: In progress", never
`in_progress`), and Clear filters appears only alongside it.

### Request lifecycle

Seven distinct states: initial loading, rows, genuinely empty, no matches for
the filters, refusal (401/403), server or network failure, and a background
refresh failure that keeps the previous rows with a banner beside them. A
failure never renders "No manufacturing orders". Manual refresh re-asks the same
question — same filters, same page — and keeps the rows visible while it runs.

The refresh-failure banner is rendered outside the state switch, because an
EMPTY register is also an answer worth keeping: left inside the rows branch, a
failed refresh over an empty register was completely silent and the screen still
read "No manufacturing orders" — the same failure-looks-empty bug arriving by a
different door. Found in the browser, fixed, re-verified.

### Search and stale answers

Search is debounced ~300 ms; obsolete requests are aborted with `AbortController`
and an abort is not an error. Every request also carries the identity of the
question that asked it (`queryKey`), and an answer is compared against the
question on screen before it may paint. `view` is deliberately not part of that
identity, so switching grid/list neither refetches nor discards an answer.

### URL state

`search`, `status`, `priority`, `deadlineRisk`, `page`, `view` — the backend's
own parameter names. Defaults (`page=1`, `view=grid`) are omitted. Malformed
values fall back safely: `page=abc` → 1, `view=banana` → grid, and an
unrecognised filter falls back to "All" rather than being passed through, which
would have produced an empty register beneath a filter bar reading "All
statuses".

### Rows

Both views carry the same facts: MO number, customer, PM status, notable
priority only (`high`/`urgent`), the effective deadline from `order.deadline`
with the legacy delivery/estimate fields as fallback, the risk wording from
`order.deadlineRisk` (never re-derived from the date), work-order count,
completed-versus-total quantity, bounded percentage, order value and a
read-only View link.

**Missing is not zero.** A field the server did not send renders `—`, and no
progress meter is drawn for a percentage that never arrived — an empty track
reads as "nothing done". A genuine zero still renders as `0`, `0 / 40`, `0%`,
`₹0`.

### Browser results (authenticated PM session, read-only fixtures, no mutations)

At 1440 px: initial loading; 16-row register; each filter individually; three
filters combined (`?status=pending&priority=urgent&deadlineRisk=overdue`, one
matching row, summary "Status: Pending · Priority: Urgent · Deadline: Overdue");
no-matches; empty register; server failure; refusal; failed refresh over rows
(12 rows before, the same 12 after, banner shown); failed refresh over an empty
register (banner shown, not silent).

- **Debounce**: four keystrokes in ~240 ms produced **1** request.
- **Stale answers**: a 2.5 s answer to `search=Customer 1` never painted over
  the instant answer to `search=Customer 3`.
- **Pagination**: `1–12 of 16 / Page 1 / 2`, Previous disabled on page 1, Next
  disabled on the last page, `13–16 of 16` on page 2.
- **Page recovery**: `?status=completed&page=9` recovered to page 1 in exactly
  two requests and settled — no loop.
- **Back/Forward**: Back restored `?page=2` and its four rows; Forward restored
  `?status=in_progress`.
- **View toggle**: 0 requests, `aria-pressed` correct on both buttons.
- **Honesty**: the fixture with no numbers renders `— / —`, `—`, "Progress
  unavailable"; the fixture with real zeros renders `0 / 40`, `₹0`, `0%`.

At 768 px and 375 px: no horizontal page overflow
(`scrollWidth === clientWidth`), list rows wrap into a stacked block with no
sideways scrolling, pagination inside the viewport and usable. Search, all three
selects, the view group and every icon button carry accessible labels; nothing
is removed from the tab order; loading and error changes are announced through a
polite live region.

### Tests and build

- `node --test components/manufacturing/moRegister.test.mjs` — 23/23.
- `node --test components/manufacturing/moStatus.test.mjs` — 14/14, unchanged.
- `npm test` — 370/370.
- SWC parse clean on every changed file.
- `next build` fails only on the pre-existing, unrelated
  `app/accountant/sales-vouchers/new/page.js` duplicate `splitGstByRate`.
- `git diff --check` clean in both repositories.

### A note on the concurrent Store lane

Mid-verification the dev server 500'd: the Store lane saved
`app/store/dashboard/configurations/units-packaging/page.js` and
`app/store/dashboard/raw-items/page.js` with an unclosed `MaintenanceOnly`
element. Those are Store/Purchase files, untouched here and not in this route's
module graph; the compile error forced a full reload that wiped the test
harness, which was reinstalled. The `next build` reported above ran against the
tree before those saves and shows one error. If a later build reports those two
files, they belong to that lane's in-flight work.

### Untouched

No backend application code. Lane A's Chunk 1 changes inside the register file
are preserved, `moStatus.js` and its tests are unchanged, and
`docs/handoff/latest-implementation.md` is untouched. Store/Purchase work, the
request desk (B1) and the navigation (B2/B2.1) are all intact.

---

## B3A — Manufacturing-order detail truth and page shell (complete)

The detail page is ~1,300 lines mixing lifecycle, adaptation, aggregation,
header, work-order rendering, tabs, vendor sharing, planning, delivery and
portals. B3A takes the read-only shell and the request lifecycle, and begins the
decomposition. It does not rewrite the page and does not start B3B.

### Old versus new request lifecycle

`fetchData` did this:

```js
const data = await res.json();
if (!data.success) return;      // no status check, no envelope failure path
} catch (err) { console.error(...) }   // and nothing reaches the screen
```

so `manufacturingOrder` stayed null and the page rendered **"Not Found"** for a
500, an expired session, a network drop and a genuinely deleted order alike.

| Case | Before | After |
|---|---|---|
| First load in flight | spinner | spinner, announced politely |
| 200 + `success: true` + order | ready | ready |
| 401 / 403 | "Not Found" | `PermissionDenied`, no Retry (retrying a refusal asks the same question) |
| 404, and 400 invalid id | "Not Found" | "No such manufacturing order", server's own wording |
| 500 / 502, JSON or HTML | "Not Found" | `ErrorState` + Retry; an unparseable body is no message, not a crash |
| Network drop | "Not Found" | `ErrorState` + Retry |
| 200 + `success: false` | "Not Found" | error, with the server's message |
| 200 + `success: true`, no order | "Not Found" | error ("The server returned no manufacturing order") |
| **Refresh fails over a visible order** | order wiped to "Not Found" | order kept, `InlineError` banner beside it, announced |
| Answer arrives for a previous `:id` | painted over the new route | aborted; the id guard was **ineffective as first written** — corrected below |

Endpoint unchanged, including the misspelled `emplloyeeTracking` path, which is
a compatibility boundary. No second request was added; refresh re-asks the same
one.

### B3A correction — two lifecycle defects found in review

The first version of this lifecycle shipped with two real defects. Both are
fixed; neither was already safe.

**1. A failed request for a NEW route kept the PREVIOUS order.** The
preservation rule was one boolean, `hadOrder: Boolean(orderRef.current)`. On a
route change without a remount — order A loaded, route becomes B, B's first
request 404s — `orderRef.current` still held A, so the failure was treated as a
background-refresh failure and **order A stayed on screen under order B's URL**.
Reproduced against the shipped code before changing it:

```
B returns 404 -> outcome.state = "ready"   << A STAYS VISIBLE UNDER B's URL
B returns 403 -> outcome.state = "ready"   << A STAYS VISIBLE UNDER B's URL
B returns 500 -> outcome.state = "ready"   << A STAYS VISIBLE UNDER B's URL
```

**2. The "independent" id guard compared a closure with itself.** The callback
did `const askedFor = id` and then `isCurrentOrderAnswer(askedFor, id)` — both
sides the same captured binding, so it was true forever. Reproduced:

```
live route is now B; old callback's guard says current = true   << GUARD IS INEFFECTIVE
```

The `AbortController` was doing all the real work; the second guard added
nothing.

**The corrected identity model.** Three separate identities, which the first
version had collapsed into one:

| Identity | Where it lives | What it answers |
|---|---|---|
| `liveIdRef.current` | ref, assigned every render | which route is on screen **now** |
| `loadedIdRef.current` | ref, set on a successful load, cleared otherwise | which route the visible order was loaded for |
| `askedFor` | captured per request | which route this request asked about |

`shouldPreservePreviousOrder({ isRefresh, loadedId, requestedId, liveId })` now
requires **all four**: it was explicitly a background refresh, a previous order
exists, that order was loaded for the same id being refreshed, and the route has
not moved on. `resolveDetailOutcome` returns an action rather than a state —
`discard` (the answer is for a route nobody is on), `paint`, `preserve`,
`replace` — and `replace` clears any stale refresh banner along with the order.
An initial load (route change or Retry) now clears the order, the work orders,
the raw materials, the banner and `loadedIdRef` before it starts, so no previous
order can reappear if the new request fails. The abort remains the primary
cancellation; the live-id comparison is now a genuinely independent second
guard, because it reads the ref rather than the closure.

Verified in the browser across six transitions, all with zero non-GET requests:

| # | Transition | Result |
|---|---|---|
| 1 | A loaded → B → 404 | "No such manufacturing order"; no A identity, summary, work order or section remained |
| 2 | A loaded → B → 500 | error state with Retry; A gone |
| 3 | A loaded → B → 403 | `PermissionDenied`; A gone |
| 4 | slow A → B (instant) → A finishes | B visible from 1.1 s and at every 700 ms sample through 4.6 s; A never painted |
| 5 | B loaded → refresh B fails | B kept, banner shown, summary and all 11 sections intact |
| 6 | refresh B succeeds | banner cleared, new figures painted (12 / 20, 60%) |

Also checked: a refresh banner raised on B does not survive a navigation to A.

### Component boundaries

| File | Owns |
|---|---|
| `components/manufacturing/moDetail.js` | **new, pure.** Response classification, refresh outcome, id-answer identity, identity strings, canonical summary adaptation, safe status/priority/risk metadata, section inventory and fallback. |
| `components/manufacturing/moDetail.test.mjs` | **new.** 17 `node:test` cases. |
| `components/manufacturing/mo-detail/DetailStates.js` | **new.** Loading, refusal, absence, breakage. |
| `components/manufacturing/mo-detail/DetailIdentityHeader.js` | **new.** The identity header. |
| `components/manufacturing/mo-detail/CanonicalSummary.js` | **new.** The eight-field strip. |
| `components/manufacturing/mo-detail/SectionNav.js` | **new.** The section bar. |
| `components/manufacturing/mo-detail/DrawerPortal.js` | **new.** Moved verbatim from the page. |
| `components/manufacturing/mo-detail/ImageZoomModal.js` | **new.** Moved verbatim from the page. |
| `app/.../manufacturing-orders/[id]/page.js` | Network orchestration, planning, vendor sharing, and every tab body — deliberately still here. |

Nothing was moved merely to reduce the line count: the page is 1,330 lines,
barely changed, because what left it was policy and shell, not bulk.

### Canonical summary mapping

Lane A Chunk 3B merges eight top-level fields into the same detail response
(`{ ...manufacturingOrder, ...summary }` in all three detail routes).

| Server field | Shown as |
|---|---|
| `displayStatus` | Status chip, shared four-value vocabulary |
| `priority` | Priority — every known level named, tone only for high/urgent |
| `deadline` | The date, formatted; legacy `customerInfo.deliveryDeadline` / `estimatedCompletion` only as fallback |
| `deadlineRisk` | The band beside it — Overdue / Due within 7 days / **Later than 7 days** / No deadline / Closed |
| `workOrdersCount` | Work orders |
| `completedQuantity` + `totalQuantity` | "27 / 60" |
| `completionPercentage` | "(45%)" and the meter |

`on_track` is rendered as **"Later than 7 days"**, never as a delivery
prediction — the server compares one date to one instant. The band is never
re-derived in the browser: the browser's clock is not the server's.

Unknown values degrade rather than leak: an unrecognised `displayStatus` reads
"Status unavailable" (deliberately stricter than the register's fallback to
"Pending" — on a worklist that keeps a row drawable, on the summary that IS the
status it would be inventing a fact), an unrecognised risk reads "Deadline
status unavailable", an unrecognised priority reads "—". Missing numbers are em
dashes and draw **no meter**; genuine zeros stay `0`, `0 / 0`, `0%` and do draw
one.

Additive only: every legacy tab, the nested `progress` / `workOrderStats`
shapes and the per-work-order deadline warnings are untouched. Those warnings
remain local heuristics about one work order, in the Work Orders section, and
are not presented as the manufacturing order's canonical band.

### Section inventory

All eleven preserved, in order, on the same keys the bodies switch on: Work
Orders, Raw Materials, Bulk Order Tracking, Employee Tracking (measurement
orders only, and never a replacement for Bulk Order Tracking), Cutting,
Production, QC, Embroidery, Packaging & Dispatch, Delivery Details, Dispatch
History. Counts show only where a real count exists — an uncounted section shows
no number rather than a confident "(0)". A section key that is unavailable for
the order falls back to the first that is, for the nav and the body alike.

### Browser results (authenticated, read-only fixtures, no mutations)

At 1440×900: loading; customer order with all eight fields
(`MO-REQ-1042` · Acme Textiles · Quotation QT-77 · CUSTOMER; In Progress / High
/ 03 Oct 2026 Later than 7 days / 3 / 27 of 60 (45%)); measurement order (11
sections including Employee Tracking, Urgent, Overdue); missing fields (Status
unavailable, —, — / —, "Progress unavailable", no meter); genuine zeros
(0, 0 / 0, 0%, counts "(0)"); unknown enums (no raw value on screen);
403; 404; 502 with an HTML body; network drop; Retry recovering; a failed
refresh keeping the order with its banner and announcement; a successful
refresh clearing it; a 2.5 s answer for `mo-1` never painting over `mo-2`.

All eleven sections clicked in turn — each selects and renders. Work-order
"View WO" navigation is untouched (`/project-manager/dashboard/production/
work-orders/:id`, unchanged in the diff).

768 px and 375 px: no horizontal page overflow, the summary grid reflows
(5 → 3 → 2 columns) without overflowing, header and summary stay readable, the
section strip scrolls horizontally and carries `tabIndex={0}` so a keyboard can
reach the sections past the fold, and `aria-selected` tracks the active one.

**Zero mutations were issued across the entire verification session** (every
non-GET request was logged; the counter finished at 0).

### Deliberately left unchanged, for Lane A / security review

- The hard-coded forwarding identity and the planning status logic in this page
  were not touched, per the mutation freeze. They remain worth a look: the
  Share-to-Vendor and Create-Plan paths were not audited here.
- `PlanningDrawer.js`, planning mutations, vendor loading and every
  cutting / production / QC / embroidery / packaging / dispatch action are
  byte-identical.

### Tests and build

- `node --test components/manufacturing/moDetail.test.mjs` — **23/23** (17 at
  first delivery, plus six pinning the complete preservation decision: a failed
  same-id refresh preserves; a failed initial load never does; a failed request
  for B never preserves an order loaded for A; an answer for A is stale once the
  live route is B; a good answer for B paints only while B is current; a
  successful same-id refresh replaces the record and clears its banner).
- `moRegister` 23/23 and `moStatus` 14/14, both unchanged.
- `npm test` — **424/424** (384 before B3A, 401 at first delivery).
- SWC parse clean on all nine changed/added files.
- `git diff --check` clean in both repositories.
- `next build` — **1 error**, the pre-existing unrelated Accountant
  `splitGstByRate` duplicate. (At first delivery there was a second, an
  unbalanced JSX brace in `app/store/dashboard/raw-items/components/
  RawItemForm.js` — the Store lane's in-flight work, since fixed by them.) The
  detail page does not appear in the log.

### Untouched

No backend application code. Lane A's manufacturing-order routes, services and
tests, Store/Purchase work, B1, B2, B2.1 and B2.2 are all as they were, and
`docs/handoff/latest-implementation.md` and `docs/tasks/current-task.md` were
not edited.

---

## B3B — Work-order panel decomposition, truthful rows, route-safe selection (complete)

### What was proven before anything changed

**The route-state risk in the brief does not reproduce in this application.**
Selecting all of order A's work orders and navigating to order B leaves the
panel reading "None selected", and the grid/list choice resets too — the App
Router remounts this page when `[id]` changes, which destroys all seven pieces
of transient state. That is an accident of routing, not a designed guarantee, so
the reset is now explicit (`INITIAL_WORK_ORDER_UI`, applied in an effect on
`id`) and the action payloads are derived rather than trusted. Reported as
defence in depth, not as a bug fixed.

**A different, real defect was found and reproduced.** A REFRESH does not
remount, so a work order that disappears from the refreshed order kept its id in
the selection. With three selected and a refresh that dropped one:

| | Before | After |
|---|---|---|
| Panel | `3 selected` over 2 rows | `2 selected` over 2 rows |
| Share modal | "3 Work Order(s) Selected", naming only two | 2, naming two |
| Blocked payload | `["A-wo-1","A-wo-2","A-wo-3"]` | `["A-wo-1","A-wo-2"]` |

`A-wo-3` no longer existed in the order at all.

### Files changed

| File | |
|---|---|
| `components/manufacturing/moWorkOrders.js` | **new, pure.** Row adaptation, exact variant-image precedence, status/planning vocabulary, missing-vs-zero formatting, the deadline heuristic, pagination arithmetic, selection reconciliation and payload derivation. |
| `components/manufacturing/moWorkOrders.test.mjs` | **new.** 21 `node:test` cases. |
| `components/manufacturing/mo-detail/work-orders/` | **new.** `WorkOrdersPanel`, `WorkOrderToolbar`, `WorkOrderStats`, `WorkOrderCard`, `WorkOrderRow`, `WorkOrderPagination`, `WorkOrderParts`. |
| `app/.../manufacturing-orders/[id]/page.js` | 1,330 → 874 lines. Keeps the fetch, the mutations and every other section. |

### Component boundaries

The page still owns the request lifecycle (B3A, untouched), the vendor and
planning mutations, and the selection — because the selection has to be
reconciled against the rows on every load, which is where the defect was. The
panel and its children receive rows and callbacks and own nothing but which page
is showing. No mutation logic moved into a display component.

### Route-state behaviour

| | Before | After |
|---|---|---|
| Reset on `[id]` change | incidental, via remount | explicit: page, view, selection, share modal, vendor, planning drawer, zoom |
| Share payload | `selectedWorkOrders` verbatim | `actionableWorkOrderIds(selection, loadedRows)` |
| Bulk plan payload | `selectedWorkOrders` verbatim | same, `{ pendingOnly: true }` |
| After a refresh | selection untouched | intersected with the rows that still exist |
| Page after a refresh | left as-is | `recoverWoPage` |

### Missing versus zero

| Field | Missing | Genuine zero |
|---|---|---|
| quantity | `—` | `0` |
| completed quantity | `—` | `0` |
| completion percentage | `—`, **no meter** | `0%`, meter at zero |
| operations count | no chip (only a real `operations` array counts) | `0`, no chip (unchanged) |
| work-order number | "Work order — no number" | n/a |
| deadline (absent or malformed) | "No Deadline Assigned" — never `Invalid Date` | n/a |

`_id` remains the row key, the identity and the detail-link id in every case; a
missing number never becomes one.

### The work-order deadline heuristic

A LOCAL heuristic about one work order, worded and toned separately from the
manufacturing order's server-computed band under the page header. Thresholds are
unchanged and now pinned exactly: overdue + incomplete → critical; due today +
incomplete → critical; ≤3 days and <70% → at risk (70% exactly is not); ≤7 days
and <30% → behind (30% exactly is not); complete → no alarm ("Done · N days
late"); no deadline → none.

The corrected case: a **missing** completion percentage used to arrive as `0`
via `|| 0` and produce "BEHIND SCHEDULE — only 0% done" for a work order nobody
had reported on. It now reads "Progress not reported" and is not counted as a
deadline issue. A reported `0%` still produces the real warning.

### Pagination

Page size unchanged (12) and still client-side. `woPageButtons` clamps the
window to the real range — the previous inline `pg = totalPages - (4 - i)` could
emit `0` and negative page numbers once the page passed 3 on a short set.
Verified: 15 rows → 2 pages; on page 2 (rows 13–15) a refresh down to 5 rows
recovered to page 1 and rendered all five, instead of a false empty panel.

### Browser results (authenticated, read-only fixtures, mutations blocked)

1440×900, 768 px, 375×812 — no horizontal overflow at any width; list view
verified at 768; at 375 there are 36 focusable controls, none removed from the
tab order, the view toggle is a labelled group and every checkbox names its work
order.

Covered: 0, 1, 12 and 15 work orders; grid and list; **the four labels the panel
then had** (PENDING, IN-PROGRESS, COMPLETED, CANCELLED) — which was itself the
defect corrected below, since eleven stored statuses were being collapsed into
those four; exact variant image wins over the top-level image, top-level used
when there are no variants, and no image renders the placeholder; missing figures and genuine zeros side by side; selection across
pages; refresh reconciliation; pagination recovery; route change A→B; viewer
role (facts and both View WO buttons present, Plan / Create Plan / Share to
Vendor absent — `RoleGate min="editor"` unchanged).

**Zero successful mutations.** Every non-GET was captured and refused by the
fixture; the counter finished at 0 in every session.

### Deliberately unchanged, for Lane A / security review

- **The hard-coded `forwardedBy: "67af6c06fd53cfbfb6e97e0a"`.** Left in place,
  and checked rather than assumed: `share-to-vendor` in
  `manufacturingOrderRoutes.js` writes `forwardedBy: forwardedBy || null`
  straight onto the work order and does **not** derive it from the authenticated
  session. Removing it would change stored data and inventing a user id would be
  worse. It remains a real security concern and is Lane A's to fix at the route.
- **Planning eligibility.** `needsPlanning` still accepts `pending`, `planned`
  and `partial_allocation`, unchanged. Noted, not acted on: `simplifyWoStatus`
  files `planned` under the IN-PROGRESS chip while `needsPlanning` still offers
  it the Plan button, so one work order can read "In-Progress" and offer
  planning at once. That is a lifecycle question, not a presentation one.
- The planning request sequence, its payload and `PlanningDrawer.js` are
  untouched.

### Tests and build

- `node --test components/manufacturing/moWorkOrders.test.mjs` — 21/21.
- `moDetail` 23/23, `moRegister` 23/23, `moStatus` 14/14 — all unchanged.
- `npm test` — **447/447** (baseline before this chunk: 425).
- SWC parse clean on every changed file. Worth recording: the parse check
  passed a file the BUILD rejected — a `WO_PAGE_SIZE` declared locally and also
  imported. Caught by the build, fixed, rebuilt.
- `next build` — **1 error**, the pre-existing unrelated Accountant
  `splitGstByRate` duplicate. No file from this chunk appears in the log.
- `git diff --check` clean in both repositories.

### Untouched

No backend application code, no API URL or response field, no Lane A file, no
Store/Purchase file. The B3A request lifecycle, the canonical MO summary, the
section keys and every section body outside Work Orders are unchanged, as are
the work-order detail URLs.

---

## B3B corrections — three truthfulness defects found in review

All three were real, all three passed the tests as first written, and one was a
contradiction in my own test file.

### Correction 1 — an incomplete aggregate looked complete

`WorkOrderStats` was handed figures built by summing every finite value. Nine
rows reporting a quantity and one not produced the sum of nine under the heading
"of 60" — a total-looking number covering 90% of the work. "Overall Progress"
was an unweighted mean of the percentages that happened to exist: 20 units at
10% beside 1 unit at 100% averaged to **55%** when the real figure is **14%**.

`workOrderPanelStats(rows)` now owns the policy and returns display-ready facts
with completeness metadata. A total is stated only when **every** displayed row
supplied its part; progress is quantity-weighted from the two totals and only
when both are complete. Otherwise `—` and "Incomplete data" — never a partial
subtotal, never `of —`, never an invented percentage. The zero denominator is
defined explicitly (0 of 0 is 0%, not `NaN`), over-completion is bounded to
100%, and an empty collection reports "No work orders" rather than 0%. The
component renders the result and does no arithmetic of its own.

| Fixture | Panel reads |
|---|---|
| all rows recorded | `Completed Units 30 of 100 · Overall Progress 30% completion` |
| one row missing both | `Completed Units — Incomplete data · Overall Progress — Incomplete data` |
| all rows zero | `0 of 0 · 0% completion` |
| 20 units at 10% + 1 unit at 100% | `3 of 21 · **14%**` (an average would say 55%) |

### Correction 2 — an arbitrary variant's image

`pickWorkOrderImage` fell back to "the first image on any variant" when no exact
match and no top-level image existed, so a navy medium could be illustrated by a
red extra-large. The test I wrote even said *"wrong photo is worse than none"*
while asserting that fallback — the comment and the assertion disagreed, and the
assertion won.

Precedence is now: exact `variantId` → exact **full** attribute-set match →
top-level product image → the work order's own `productImage` → **no image**.
There is no "any variant" step. A partial attribute match is not a match.

Verified in grid *and* list with two visually different variants: the exact
match renders `red-l.png`, the top-level fallback renders `top.png`, and the
unmatched navy/XS row renders the **placeholder** — exactly one placeholder in
each view, and no borrowed photograph.

### Correction 3 — eleven stored statuses shown as four

The WorkOrder schema allows `pending`, `planned`, `scheduled`, `ready_to_start`,
`in_progress`, `paused`, `completed`, `cancelled`, `delayed`,
`partial_allocation`, `forwarded`. The panel collapsed them into four buckets,
so `delayed`, `paused` and `forwarded` all read **"In-Progress"** — two of them
the opposite of progress — and `planned`, `scheduled` and `ready_to_start` lost
their distinction. An unrecognised value read as "In-Progress" too.

Every stored value now has its own label: Pending, Planned, Scheduled, Ready to
start, In progress, Paused, Completed, Cancelled, Delayed, Partially allocated,
Forwarded to vendor. Anything unknown, absent, blank or malformed reads **Status
unavailable**, never a healthy label, and no raw enum reaches the screen. Labels
are distinct text, so colour is never the only distinction; the chip is no
longer upper-cased, because "FORWARDED TO VENDOR" is harder to read, not
clearer.

This is a read vocabulary only. **`needsPlanning()` and bulk-selectability are
unchanged** and pinned by their own test across all eleven values. No stored
value, transition or mutation changed, and Lane A's Chunk 4B decision is not
pre-empted. `simplifyWoStatus` is gone — its only purpose was the four-bucket
collapse.

Verified live: all eleven labels render in grid and list, the unknown and blank
fixtures both read "Status unavailable", and nothing leaks `in_progress`,
`ready_to_start`, `partial_allocation` or the unknown value itself.

### Files changed

| File | |
|---|---|
| `components/manufacturing/moWorkOrders.js` | `workOrderPanelStats` added; `pickWorkOrderImage` last-resort removed; `WO_STATUS_META` expanded to the schema's eleven values with `WO_STATUS_UNKNOWN`; `simplifyWoStatus` removed. |
| `components/manufacturing/moWorkOrders.test.mjs` | 21 → **32** tests. |
| `components/manufacturing/mo-detail/work-orders/WorkOrderStats.js` | renders the helper's result; no arithmetic. |
| `components/manufacturing/mo-detail/work-orders/WorkOrderParts.js` | status chip drops `.toUpperCase()`. |
| `components/manufacturing/mo-detail/work-orders/WorkOrdersPanel.js` | passes `stats` as one object. |
| `app/.../manufacturing-orders/[id]/page.js` | calls `workOrderPanelStats`; the local `sumOf`/average is gone. |

### Verification

- `moWorkOrders` — **32/32** (was 21).
- `moDetail` 23/23, `moRegister` 23/23, `moStatus` 14/14 — unchanged.
- `npm test` — **458/458** (baseline before these corrections: 447).
- SWC parse clean on all six changed files.
- `next build` — **1 error**, the pre-existing unrelated Accountant
  `splitGstByRate` duplicate binding. No file from this chunk appears.
- `git diff --check` clean in both repositories.
- Browser at 1440 / 768 / 375 px: no horizontal overflow at any width; viewer
  sees facts and both View buttons with Plan / Create Plan / Share to Vendor
  absent; editor sees them. **Zero mutations** — every non-GET captured and
  refused, counter 0 in every session.

### Noted, not acted on

The **work-order detail page**
(`app/project-manager/dashboard/production/work-orders/[id]/page.js`) still
carries its own local `simplifyWoStatus` and four-bucket `WO_STATUS_META`. It is
outside this chunk's scope and unchanged; it should adopt the shared vocabulary
when that page is next touched.

### Preserved

B3A's request lifecycle and route-identity protection, selection reconciliation
and current-row payload derivation, all URLs and endpoint contracts, the
planning and vendor mutation sequences, `PlanningDrawer.js`, every
non-Work-Orders section, Lane A files and Store/Purchase work.

---

## B3C — Delivery Details truth and decomposition (complete)

### The defect: one page, two answers

The Delivery section rebuilt the manufacturing order's totals itself, from
`workOrderProgress` with `|| 0` for every gap, and produced "Overall Progress"
as an **unweighted mean** of the per-work-order percentages:

```js
overallPct += p.overallCompletionPercentage || 0;   // missing counted as zero
avgCompletionPercentage: count > 0 ? Math.round(overallPct / count) : 0
```

The canonical summary under the same page's header already showed the server's
figure. One screen could therefore state two different completions for one
order. Three smaller defects sat beside it:

| Rendered | Cause |
|---|---|
| `undefined, undefined` | the address was `` `${city}, ${postalCode}` `` — a template over two fields that are routinely absent |
| `Invalid Date` | `new Date(malformed).toLocaleDateString()` in a field labelled as a deadline |
| `₹0` | `formatCurrency(amount \|\| 0)` for a price the server never sent |

### Canonical fields now reused

The section asks `canonicalSummary()` — the **same adapter the header uses** —
for `workOrdersCount`, `completedQuantity` / `totalQuantity` and
`completionPercentage`. There is no second calculation to drift, and a test
feeds one payload to both consumers and demands identical output. Verified live:

| Payload | Header | Delivery section |
|---|---|---|
| normal | `3 · 27 / 60 (45%)` | `3 · 27 / 60 · 45%` |
| canonical fields absent | `— · — / — (—) Progress unavailable` | `— · — / — · —`, no meter |
| canonical zeros | `0 · 0 / 0 (0%)` | `0 · 0 / 0 · 0%`, meter at zero |

### Missing-value rules

- **Address** — composed only from the parts that exist, joined with ", ", so a
  comma appears only between two things that are both there. Every present part
  survives a missing neighbour (`12 Mill Road, 753001` when the city is absent).
  Nothing recorded reads "Not recorded". No `undefined`, `null`, duplicate,
  leading or trailing commas in any shape tested.
- **Contact** — a blank string is missing, not a value. `tel:` / `mailto:` links
  are built only from the value itself and the visible text is always that
  value. Nothing is borrowed from another field to fill a gap.
- **Customer delivery deadline** — labelled precisely, because the canonical
  header deadline falls back to the production estimate and the two can
  legitimately differ. Absent or malformed reads "Not specified"; `deadlineRisk`
  is not re-derived here.
- **Money** — `finalOrderPrice`, `totalPaidAmount`, `totalDueAmount` are three
  separately recorded amounts. A finite number formats as INR (₹0 included);
  absent, `NaN`, `Infinity` and a numeric **string** all render `—`. Nothing is
  added, subtracted or reconciled — a balance computed in the browser would be a
  claim the backend never made — and an inconsistent set is shown rather than
  repaired.
- **Partial records stay usable**: one missing field does not collapse the
  panel. Only a record with nothing at all in it shows the empty treatment.
  (Corrected once — see the B3C correction below.)

### Backend defaulting limitation

The detail response applies its own defaults in places
(`finalOrderPrice: customerRequest.finalOrderPrice || 0` and similar). Where a
default was substituted server-side, the frontend receives a real number and
cannot tell it from a recorded one. This section is honest about the payload it
is handed; it cannot be honest about a zero that was invented before it arrived.
Recorded for Lane A; no backend code was changed.

### Before / after page structure

The route component loses the last of its inline presentation logic:

| Removed from the page | |
|---|---|
| `calculateMOStats()` | the unweighted average and `\|\| 0` totals |
| `workOrderProgress` state + `progressData` map | existed only to feed it |
| `formatDate` / `formatCurrency` | replaced by the policy module's honest versions |
| the inline Delivery JSX | now `<DeliveryDetailsSection facts={deliveryFacts(order)} />` |
| six orphaned imports | `PanelHead`, `MapPin`, `Truck`, `User`, `Phone`, `Mail` |

`workOrders` is **kept** — Employee Tracking, the selection and the vendor modal
still read it. Page: 874 → **787 lines**.

### Files changed

| File | |
|---|---|
| `components/manufacturing/moDelivery.js` | **new, pure.** Address composition, contact fields, customer deadline, recorded amounts, and the canonical production summary by delegation. |
| `components/manufacturing/moDelivery.test.mjs` | **new.** 17 `node:test` cases, including a structural regression asserting the route no longer contains `calculateMOStats`, `workOrderProgress` or the averaging accumulator. |
| `components/manufacturing/mo-detail/delivery/DeliveryDetailsSection.js` | **new.** |
| `components/manufacturing/mo-detail/delivery/DeliveryContactPanel.js` | **new.** |
| `components/manufacturing/mo-detail/delivery/DeliveryOrderSummary.js` | **new.** |
| `app/.../manufacturing-orders/[id]/page.js` | renders the section; dead aggregation removed. |

### Browser evidence (read-only fixtures, zero mutations)

Complete record; partially populated address (`Cuttack` alone, not
"Cuttack, undefined"); no delivery information at all (empty treatment, with the
order summary still shown); malformed deadline → "Not specified"; missing /
numeric-string / `NaN` money → `— — —` with **no ₹0**; genuine zero money →
`₹0 ₹0 ₹0`; canonical missing and canonical zero both matching the header.
"Invalid Date", "NaN" and "undefined" appear nowhere on the page.

1440 / 768 / 375 px: no horizontal overflow at any width; 19 focusable controls
at 375 px with none removed from the tab order and both contact links reachable.
Delivery Details and Dispatch History remain separate sections with their own
keys. B3A's lifecycle re-verified in a clean session: navigating to a 404 order
shows "No such manufacturing order" and retains no trace of the previous one.

*Method note:* an earlier reading in a long-lived browser session appeared to
show a route-change regression. It was the test rig — layered `window.fetch`
wrappers plus a fixture that fell back to a valid order for unknown ids. Chased
to ground and disproved in a clean session rather than reported as a defect.

### Correction — organisation-only records were classified as empty

`deliveryContact()` returns `organisation` and `DeliveryContactPanel` renders
it, but `hasAnyDeliveryInformation()` listed only address, name, phone, email
and deadline. An order carrying nothing but
`customerInfo: { organizationName: "Acme Textiles" }` was therefore called empty
and the panel hid the one fact it had — contradicting B3C's own rule that a
partially populated record must remain usable. Reproduced before the fix:

```
organisation supplied : {"text":"Acme Textiles","available":true,...}
hasAnyDeliveryInformation: false   << PANEL SHOWS THE EMPTY STATE AND HIDES IT
```

The fix removes the possibility of the drift rather than adding one more field
to a list:

- `hasAnyDeliveryFact({ address, contact, deadline })` is the single rule, and
  it counts **any** contact field by iterating the object instead of naming a
  subset — a field added to `deliveryContact()` is covered with no further
  change.
- `deliveryFacts()` derives address, contact and deadline **once** and computes
  `hasAny` from those same values, so the empty-state predicate cannot disagree
  with what the component was handed.
- `hasAnyDeliveryInformation(order)` is kept for existing callers and delegates
  to the same rule.
- No fallback organisation is invented; a blank or whitespace-only value is
  still missing.

Browser-verified: **organisation only** renders the normal panel with
"Organisation Acme Textiles" and the other fields reading "Not recorded", with
no empty-state message; **blank organisation only** and **completely empty
customer information** both show the empty state. Zero mutations.

### Verification

- `moDelivery` — **19/19** (17 at first delivery, plus two pinning the
  corrected predicate: every individually populated field keeps the record
  non-empty, and `hasAny` is computed from the facts the component receives).
- `moDetail` 23/23, `moWorkOrders` 32/32, `moRegister` 23/23, `moStatus` 14/14 —
  all unchanged; manufacturing suite **111/111**.
- `npm test` — **497/497**. Honest baseline note: at the start of this chunk the
  full suite was **464/466**, with two failures in the Store lane's
  `components/store/stock-ledger/movements.test.mjs` ("Sept" vs "Sep" date
  formatting). That lane fixed them while this chunk was in progress; neither
  the failures nor the fix are mine.
- SWC parse clean on all six changed files.
- `next build` — **1 error**, the pre-existing unrelated Accountant
  `splitGstByRate` duplicate binding. No file from this chunk appears.
- `git diff --check` clean in both repositories.

### Preserved

B3A's request lifecycle and route-identity protection; B3B's work-order panel,
selection reconciliation, pagination, status vocabulary and payload safety; the
planning and vendor mutation sequences; `PlanningDrawer.js`; scheduling; every
department execution tab; Dispatch History; all URLs and section keys; Lane A
files; Store/Purchase work. No backend application code was touched, and the
separate work-order detail page has **not** adopted the shared status vocabulary
— that waits for Lane A's 4B lifecycle decision.

---

## B3D — Grouped, bookmarkable detail navigation (complete)

### Old versus new

Up to eleven sections sat in one horizontal strip. It scrolled, so nothing was
unreachable, but it read as a list to be searched rather than a map of the work,
and the selected section lived only in React state — it could not be
bookmarked, refreshed, shared, or walked with Back/Forward. The strip also
carried `role="tablist"` with no panel relationship, no roving tab index and no
arrow keys, and made the scroll container itself a tab stop.

Two compact levels now: the four stages of the work, and the sections of the
open stage.

| Group | Sections |
|---|---|
| **Plan** | `workOrders`, `rawMaterials` |
| **Track** | `bulkTrackingTab`, `employeeTrackingTab` (measurement orders only) |
| **Execute** | `cutting`, `production`, `qc`, `embroidery` |
| **Fulfil** | `packagingDispatch`, `delivery`, `dispatchHistory` |

Every section **key** is unchanged and every body still switches on it. A test
flattens the four groups and asserts the result equals the previous eleven-item
inventory exactly — same keys, same order, each once. No "Overview" and no
"Exceptions" were invented: both would be screens built from facts the backend
does not publish.

Group defaults are the first AVAILABLE child, not a fixed name: Plan → Work
Orders, Track → Bulk Order Tracking, Execute → Cutting, Fulfil → Packaging &
Dispatch. Counts remain only on the sections that already carried real ones; the
number on a group control is how many sections that stage has, never a sum of
unrelated facts.

### Section keys and URL compatibility

The section is the `section` query parameter on the existing `[id]` route — no
new route, no path change:

- `?section=qc`, `?section=delivery`, `?section=rawMaterials` — the exact
  existing keys.
- Work Orders is the default and is **omitted**, so the plain detail URL stays
  plain.
- Unknown, blank, malformed and unavailable sections fall back to Work Orders.
- Unrelated query parameters are preserved; only `section` is written.
- View mode, work-order page, selection, modals and drawers stay **out** of the
  URL — they are what the reader is doing, not what they are looking at.
- A section change alters only the query, so B3A's route identity (the `id` in
  the path) never moves and nothing refetches.

### Measurement orders

Employee Tracking appears under Track for measurement orders only and does not
replace Bulk Order Tracking; both render their existing separate bodies. On a
customer order it is absent from the group entirely, and
`?section=employeeTrackingTab` falls back to Work Orders rather than rendering
an empty body.

### Keyboard and semantics

The four stage controls are ordinary buttons in a `role="group"` labelled
"Workflow area", with `aria-pressed` — deliberately **not** tabs, because they
do not own panels. The child sections are real tabs: stable `id`,
`aria-selected`, `aria-controls`, and a roving `tabIndex` (0 on the active tab
only). The page renders one matching `role="tabpanel"` with a stable `id`,
`aria-labelledby` and `tabIndex={0}`. The container is no longer a tab stop.

Arrow Left/Right, Home and End move and activate together, and focus follows to
the newly selected tab — verified at every step that focus is on the selected
tab, so it is never stranded on a tab whose panel is not showing. The set wraps
at both ends.

### Browser evidence (read-only fixtures, zero mutations)

**Customer order:** Plan shows Work Orders + Raw Materials; Track shows Bulk
Order Tracking alone; Execute shows all four; Fulfil shows all three. Employee
Tracking never appears. **Measurement order:** Track shows both, each with its
own panel id.

**URL:** deep-link `?section=qc` opens QC with Execute active; `?ref=email`
survives a section change (`?ref=email&section=embroidery`); Back/Forward walks
delivery → qc → default → qc correctly; `?section=nonsense`, `?section=` and
`?section=employeeTrackingTab` on a customer order all fall back to Work Orders
with a non-empty body. **Six section changes produced zero manufacturing-order
refetches** (counter unchanged at 4 across the sequence).

*Method note:* "direct open" and "refresh" were exercised as fresh mounts
reading the URL, since a real document reload would lose the read-only fixture
and hit the live backend.

**Keyboard:** ArrowRight Cutting → Production → QC, ArrowLeft back to
Production, End → Embroidery, ArrowRight wraps to Cutting, Home → Cutting — each
updating `aria-selected`, the panel id and the URL together.

**Responsive:** 1440 px four compact group controls with the children on one
row; 768 px groups wrap cleanly and children fit; 375 px both wrap onto two rows
with no page overflow, "Packaging & Dispatch" not clipped, and **zero container
tab stops**.

### Files changed

| File | |
|---|---|
| `components/manufacturing/moDetail.js` | `MO_DETAIL_GROUPS`, `groupedDetailSections`, `groupForSection`, `firstSectionInGroup`, `resolveDetailNavigation`, the `section` URL adapter (`parseSectionParam`, `sectionSearchParams`, `sectionHref`), `detailTabId` / `detailPanelId`, `nextSectionForKey`. |
| `components/manufacturing/moDetail.test.mjs` | 23 → **37** tests. |
| `components/manufacturing/mo-detail/SectionNav.js` | rewritten as the two-level navigator with full tab semantics and focus handling. |
| `app/.../manufacturing-orders/[id]/page.js` | section read from the URL; grouped nav; `role="tabpanel"` wrapper; `Suspense` boundary for `useSearchParams`. |

### Tests and build

- `moDetail` — **37/37**.
- `moWorkOrders` 32/32, `moDelivery` 19/19, `moRegister` 23/23, `moStatus`
  14/14 — unchanged; manufacturing suite **125/125**.
- `npm test` — **538/538** (baseline before this chunk: 501/501).
- SWC parse clean on all four changed files.
- `next build` — **1 error**, the pre-existing unrelated Accountant
  `splitGstByRate` duplicate binding. No file from this chunk appears.
- `git diff --check` clean in both repositories.

### Preserved

No section body changed. B3A's request lifecycle and route identity, B3B's
work-order panel, status vocabulary, selection, pagination and payload
derivation, and B3C's delivery facts and components are untouched — the
work-order selection is not reset by changing sections, because the reset effect
still depends only on the route `id`. Planning and vendor mutations,
`PlanningDrawer.js`, the work-order detail page, scheduling, department tracking,
Dispatch History, all route paths, Lane A files and Store/Purchase work are
unchanged, and no backend application code was touched.

## B3E — Honest header actions and the vendor-sharing dialog (complete)

Two controls in the manufacturing-order detail header were weaker than the page
around them.

**Print did nothing.** It was a `<Button>` with no `onClick` — a control that
looks like an action, on the screen where a person is most likely to want one.

**Share to Vendor reported itself through browser alerts.** Four `alert()` calls
carried the whole outcome vocabulary, and between them the dialog had no states
at all:

| What happened | What the reader was told |
|---|---|
| the vendor lookup failed | **"No active vendors found."** — a broken request presented as a fact about the business |
| a share succeeded | an `alert()` reading `✅ <message>`, outside the dialog |
| a share failed | an `alert()` reading `❌ <message>`; the dialog had already been left as it was |
| the network dropped | `alert("Failed to share work orders")` |
| a 500 whose body carried `success` | treated as a success — the code read `data.success` and never looked at the status |
| submit pressed twice | two requests; nothing blocked the second |
| Escape or the backdrop mid-request | the dialog closed, and the reader could not tell whether outside parties had been sent the work |

### What changed

**Print.** Wired to `window.print()`, labelled **"Print current section"**, and
given a print stylesheet. The label is the narrow truth: what the browser prints
is the section on screen, because that is what is rendered. Mounting the other
ten sections to make a broader promise true would mean fetching and drawing work
nobody asked for. Nothing claims PDF — the browser's own dialog decides that.

The printed document is the order identity, the canonical summary and the
current section. Application chrome, the Back control, the header actions, the
section navigator, the bulk-actions strip, the pager, all buttons and all form
controls are omitted; anchors survive, so a phone number prints as a phone
number. Colours are forced to black on white, because the theme's ink can be
near-white and paper is not.

**Scoping.** Every rule is written under `body:has([data-mo-print-document])`,
and that attribute exists only on this screen — when the page is not mounted the
selector matches nothing, so no other application's printing changed. The
technique is hide-the-body-then-reveal-the-document, chosen deliberately over
naming the chrome: the shell's markup belongs to `FrostShell` and
`DashboardLayout`, and a print rule listing their elements would rot the moment
either changed. `@page { size: A4 }` is the one genuinely global declaration and
exists only while this component is mounted. A test asserts that every selector
inside `@media print` is anchored to the document attribute.

**The sharing dialog** moved out of the route into
`components/manufacturing/mo-detail/ShareToVendorDialog.js`, with every decision
in the dependency-free `components/manufacturing/moVendorShare.js`. Eight states,
each distinct on screen:

| State | What it says |
|---|---|
| vendor list loading | "Loading vendors…" |
| vendor list ready | the vendors, with code and place |
| **no active vendors** | "No active vendors" — a fact, with no Retry |
| **vendor lookup failed** | the failure, **with Retry** — never "no vendors" |
| ready to submit | Share enabled once a vendor is chosen |
| submitting | "Sharing…", every control disabled, announced politely |
| submission failed | the server's reason **inside the dialog**, still open, still retryable, selection intact |
| confirmed success | the server's own sentence, kept on the page after the dialog closes |

**No optimistic success.** `classifyShareResponse` reads the HTTP status first;
a 500 carrying `success: true` is a failure. Nothing is closed, cleared or
refreshed until `shouldCompleteShare()` is true, and the confirmation is the
server's message, not a client-authored celebration with an emoji in it.

**Dismissal.** Escape, the backdrop, Close and Cancel all route through one
`requestClose`, which asks `canDismissShareDialog({ submitting })`. While a
request is in flight the answer is no, and the page refuses a second time for
any caller that forgets. When idle all four dismiss normally.

**Focus.** Entry focuses the dialog itself, so the title and description are
heard before the first field; Tab and Shift+Tab are trapped; on close focus
returns to the Share button.

  *Found in the browser, not by reasoning:* on the **success** path that
  restore silently did nothing. The share clears the selection, which disables
  the Share button, and focusing a disabled button drops the reader to the top
  of the document. The dialog now checks the target is still focusable and
  otherwise focuses what the page nominates as the news — the confirmation
  banner.

**Work-order numbers.** The dialog prints each selected work order's stored
number **exactly as stored, exactly once**. The card and row label abbreviates —
`WO-${number.slice(-8)}` — which both prepends a prefix the stored value may
already carry and truncates a canonical number to its tail. Tolerable on a dense
card; not tolerable in the dialog where somebody checks the number before work
leaves the company. `adaptWorkOrder` now carries `workOrderNumber` alongside
`reference` so neither caller has to compromise. A missing number reads
**"Work-order number unavailable"**; `_id` remains the submission identity in
every case, and nothing is ever assembled from an id.

Verified side by side in the browser: the cards behind the dialog read
`WO-26000123` while the dialog reads `WO2026000123`.

**No dialog over an empty selection.** The Share button is disabled when nothing
live is selected, with the reason beside the control — "Select work orders in
the Plan area first." — rather than an alert after the click. The selection is
reconciled against the rows currently loaded, so a work order removed by a
refresh cannot reach the payload.

**Every `alert()` in this flow is gone**, including the bulk-planning one: the
toolbar already disables Create Plan when nothing is plannable and states in
words how many selected rows are not, so there was nothing left for an alert to
say.

### ⚠ Unresolved security dependency — Lane A owns this

`POST /api/cms/manufacturing/manufacturing-orders/share-to-vendor` receives
`forwardedBy` from the client, and `manufacturingOrderRoutes.js` writes that
client-supplied value onto the work order verbatim:

```js
forwardedBy: forwardedBy || null
```

The frontend sends a **hard-coded ObjectId**, `67af6c06fd53cfbfb6e97e0a`. Any
client can therefore name anybody as the person who forwarded the work.

**This chunk did not fix it and deliberately preserved it.** Inventing a
different user id would be worse; dropping the field would silently change
stored data. The wire payload is byte-identical to before — a test pins the
constant so it cannot drift while Lane A decides.

> **The vendor-sharing workflow is not security-complete.** The fix belongs at
> the route: derive the actor from the authenticated session and ignore any
> client-supplied `forwardedBy`. Until Lane A does that, forwarding attribution
> in the database is not trustworthy.

Also unchanged, and still Lane A's: the planning lifecycle and work-order status
logic. Nothing in this chunk touched stored values, transitions or planning
eligibility.

> **Status corrected (3 Sep 2026).** This paragraph said
> `docs/decisions/project-manager-work-order-planning-lifecycle.md` was
> "PROPOSED — awaiting user approval". It is **APPROVED IN PART** — decisions
> 1–14 accepted, decision 15 outstanding and blocking only the legacy backfill
> sign-off. Approval is not implementation: nothing in that document has been
> built, which is why this lane still touches none of it.

### Files changed

| File | |
|---|---|
| `components/manufacturing/moVendorShare.js` | **new** — vendor-list classification, work-order labelling, submission gating, response classification, dismissal policy, and the pinned wire payload. |
| `components/manufacturing/moVendorShare.test.mjs` | **new** — 32 tests. |
| `components/manufacturing/mo-detail/ShareToVendorDialog.js` | **new** — the dialog and its opening button; focus, trap and restore. |
| `components/manufacturing/mo-detail/PrintStyles.js` | **new** — the scoped print stylesheet. |
| `components/manufacturing/moDetail.js` | `PRINT_ACTION_LABEL`, `printActionDescription`. |
| `components/manufacturing/moWorkOrders.js` | `adaptWorkOrder` carries `workOrderNumber`; `INITIAL_WORK_ORDER_UI.shareSubmitError`. |
| `components/manufacturing/mo-detail/work-orders/WorkOrdersPanel.js` | bulk-actions strip and pager marked `data-mo-print="hide"`. |
| `app/.../manufacturing-orders/[id]/page.js` | vendor lookup and share request rewritten around the policy; four `alert()` calls removed; inline modal replaced; print document wrapper; confirmation banner. |

### Tests

- `moVendorShare` — **32/32** (new).
- Manufacturing suite **157/157** (was 125/125; +32).
- `npm test` — **583/583**. The full-suite total is not baseline + 32: the
  Store/Purchase lane changed its own tests in the working tree while this
  chunk ran. The manufacturing delta is exact.
- `next build` — still the **one pre-existing, unrelated** error:
  `app/accountant/sales-vouchers/new/page.js` both imports (line 41) and
  declares (line 109) `splitGstByRate`. That file is unmodified in git and came
  from the `origin/risheesales` merge; no file from this chunk appears. Because
  the build aborts there, route compilation for this page was verified by the
  dev server instead, which compiled and rendered it.

### Browser verification — zero mutations

Method as in earlier chunks: `window.fetch` replaced with a fixture that answers
every `/api/` call locally and passes RSC payloads through, then client-side
navigation into the guarded route. **`read_network_requests` for the backend
origin recorded no requests at all** — nothing left the browser for any endpoint,
mutating or otherwise. Every `POST` the page issued was answered by the fixture.

One method note worth keeping: a second `window.fetch` wrapper layered over the
first was silently lost mid-session and briefly made the header read
"Manufacturing order" / "Status unavailable". That was the test rig, not the
page — the same layering hazard recorded in B3C. Re-installing a single clean
wrapper restored it. Do not layer fixtures.

**Cases exercised**

| | Result |
|---|---|
| Share disabled with nothing selected | disabled, reason shown beside it, no dialog |
| dialog opens after selecting | title/description wired, focus inside, submit disabled |
| vendor list loading | "Loading vendors…" |
| vendor lookup — network failure | "Failed to fetch" + **Retry**; **not** "No active vendors" |
| vendor lookup — 500 | "Vendor directory is unavailable." + Retry |
| vendor list genuinely empty | "No active vendors", no Retry |
| Retry after a failure | re-asks and repaints |
| work-order numbers in the dialog | `WO2026000123`, `WO2026000124`, `Work-order number unavailable` |
| submit disabled until a vendor is chosen | confirmed |
| in flight | "Sharing…", submit/Cancel/Close all disabled, live region announced |
| second press, Escape and backdrop mid-flight | all refused; **exactly one POST** |
| confirmed success | dialog closed, selection cleared, refresh issued, server's sentence on the page |
| 500 carrying `success: true` | **treated as failure**; dialog open, selection kept, nothing celebrated |
| 500 with a reason / network failure | reason inside the dialog, still dismissable and retryable |
| Escape when idle | dismisses; focus returns to the Share button |
| Print — work-orders section | identity + summary + section; no chrome, no controls, black on white |
| Print — delivery section | follows the section; title reads "…the Delivery Details section" |
| 1440 / 768 / 375 | dialog intact at all three; no horizontal page overflow at 375 |

Print was verified by re-applying the page's **own** stylesheet with the media
condition lifted, so the declarations under test are the shipped ones. Computed
styles confirmed the body and every top-level element hidden, the print document
visible, buttons inside it `display: none`, and the section navigator's wrapper
`display: none` at zero size.

### Preserved

The endpoint, method, credentials and request body are unchanged, `forwardedBy`
included. No section body changed. B3A's request lifecycle and route identity,
B3B's status vocabulary, selection and payload derivation, B3C's delivery facts
and B3D's grouped navigation are untouched. Planning mutations, `PlanningDrawer`,
the work-order detail page, Lane A files and Store/Purchase work are unchanged,
and no backend application code was touched.

## B3E corrections — request identity (complete)

Review found four races. None of them is visible in the state matrix above,
because all four are about *when* an answer arrives rather than *what* it says.
The corrections are all frontend; the endpoint, method, credentials, body and the
hard-coded `forwardedBy` are untouched, and print is unchanged.

### 1. The submission lock was render state

`sharingLoading` updates the interface; it is not a lock. Two calls made from the
**same render closure** both read `false` — React has committed nothing between
them — so both passed `canSubmitShare` and both posted. A source check for
`disabled={sharingLoading}` proves nothing about this, which is why the test does
not do one.

There is now an imperative lock, claimed **synchronously before the first
`await`**, and the page's only way into a submission is `submitShare()` — so a
caller cannot forget the guard. `sharingLoading` remains, for rendering only.

The lock is released on every terminal path: success, server failure, a thrown
request, and the route-changed discard. A release only frees the claim that made
it, so a late release from a superseded attempt cannot free somebody else's lock.
It is **not** cleared when the route changes — the POST it guards may still be
executing, and freeing it would let a second one start against the same work
orders.

### 2. The vendor lookup had no identity

Open → close → reopen: lookup 1's answer arrived last and painted over lookup 2's.

Vendor lookup now has its own lifecycle. Starting one aborts the previous; the
dialog closing and the route changing both abort it too. Alongside the abort
there is a **monotonic token**, because abort alone is not enough: a response
that already resolved and is waiting on the microtask queue never sees its signal
fire. The token moves on begin *and* on abort, so such an answer is stale by
identity.

Four ways to be irrelevant — cancelled, superseded, dialog closed, route moved —
and one way to paint. **An aborted lookup is cancellation, not an error**, so a
close never produces "the vendor list could not be loaded". Genuine empty,
refusal and failure classify exactly as before.

### 3. A share outcome could outlive its route

A share for order A finishing after navigation to order B would clear B's
selection, show A's confirmation on B, and call A's captured `fetchData(true)` —
which aborts B's detail request through the shared in-flight ref.

The route that asked is captured at submit; the live route is read **as a
function** after the answer lands (comparing a captured value with itself is
always true — the mistake B3A already paid for). On a mismatch the outcome is
discarded: B's dialog, vendor selection, work-order selection, confirmation and
errors are untouched, A's `fetchData` is not called, and B's detail request is
neither aborted nor replaced. The lock is still released.

**The POST is never aborted as a route-change strategy.** Once sent, its
server-side outcome is uncertain; cancelling the client's knowledge of it would
not cancel the work. A test asserts `submitShare` contains no abort at all.

Render state for the route being *left* — `sharingLoading`, the snapshot — is
cleared at navigation, not by a late answer from the previous order.

### 4. The live-selection gate was only a disabled button

`canOpenShareDialog` was imported and never called. `openShareDialog()` is now
gated on it, before both the open and the vendor lookup it would start —
verified in the browser by stripping the `disabled` attribute and clicking: the
handler still refused, and no lookup began.

If the live selection becomes invalid while the dialog is open and nothing is in
flight, the dialog closes rather than becoming a zero-selection confirmation
surface. Once a submission starts, the dialog shows a **frozen snapshot of what
was actually sent**, so a refresh landing mid-request cannot rewrite the list
somebody is reading.

### Found in the browser, not by reasoning

The selection guard was first placed **below** `if (loading) return` — so the
loading render had one hook fewer than the loaded one and React threw *"Rendered
more hooks than during the previous render"*, taking the whole route down. Moved
above every early return, with a test that pins its position relative to them.

Separately, the B3E test suite's comment-stripping helper stripped block comments
before line comments. The route's own header contains the path `mo-detail/*` in
prose, which opened a block comment that closed 33k characters later — deleting
most of the file, so **two negative assertions ("no `alert()`", "the page does not
re-author the payload") had been passing vacuously**. Line comments are stripped
first now, and the helper asserts the stripped source is still recognisably the
file. Both assertions pass genuinely.

### Files changed

| File | |
|---|---|
| `components/manufacturing/moVendorShare.js` | `createShareLock`/`claimShareLock`/`releaseShareLock`/`isShareInFlight`; `createVendorLookup`/`beginVendorLookup`/`abortVendorLookup`/`isCurrentVendorLookup`/`isAbortError`/`resolveVendorLookup`; `submitShare` — the single submission boundary. |
| `components/manufacturing/moVendorShare.test.mjs` | 32 → **57** tests. |
| `app/.../manufacturing-orders/[id]/page.js` | lookup and submission rewritten around the lifecycle; `canOpenShareDialog` gate; snapshot; selection guard; route-change cancellation; three imports the corrections made unused removed. |

### Tests

- `moVendorShare` — **57/57** (was 32/32).
- Manufacturing suite **182/182** (was 157/157; +25).
- `npm test` — **625/625** (was 583/583). The delta is not +25: other lanes added
  tests in the working tree while this ran. The manufacturing delta is exact.
- `git diff --check` clean in both repositories.
- `next build` still fails only on the pre-existing, unrelated Accountant
  `splitGstByRate` duplicate binding; `@swc/core` is not installed in this tree,
  so the route's syntax was verified by the **dev server compiling and rendering
  it** — which is also what caught the hook-order defect above.

Every race test drives the **same functions the page calls**, with `{ current:
null }` standing in for the React ref — so passing means the boundary behaves
this way, not that the source contains a particular string.

### Browser verification — zero mutations

Two orders (MO1, MO2) served from one intercepted fixture. `read_network_requests`
for the backend origin recorded **no requests at all**. Six POSTs were issued
across the session, all answered by the fixture; every body had exactly the keys
`forwardedBy, vendorId, workOrderIds` with the pinned actor value.

| Case | Result |
|---|---|
| 1. slow lookup → close → reopen → fast lookup | the stale answer **never painted**, and the cancellation surfaced no error |
| 2. lookup finishes after close | nothing written; reopening with a failing lookup showed the failure, never the stale vendor |
| 3. three submit clicks in one turn | **exactly one POST** |
| 4. submit on A → navigate to B → late **success** | B's selection unchanged, no confirmation, no error, and the detail-GET list **byte-identical** before and after — no refresh, no abort |
| 5. submit on A → navigate to B → late **failure** | no error anywhere on B, no dialog, selection intact, no extra GET; Share usable again (lock released) |
| 6. same-route failure | stays in the dialog with the server's reason, selection kept, retryable, dismissable, no refresh |
| 7. same-route confirmed success | closes, clears, announces, **exactly one refresh and one POST** |
| 8. empty selection | no dialog and **no vendor lookup**, even with the `disabled` attribute stripped off the button |
| snapshot | a refresh removing a work order mid-share did not change the list on screen; after the request settled the list reflected reality again |
| selection emptied while open | dialog closed rather than showing a zero-selection surface |

Console clean apart from pre-existing service-worker push-registration errors.

### Preserved

Print behaviour and styling are untouched. The share endpoint, method,
credentials and request body are unchanged, `forwardedBy` included — **the
hard-coded actor remains an explicitly documented Lane A security dependency,
and this workflow is still not security-complete.** No backend application code,
no planning or status logic, no work-order eligibility, no B3A–B3D behaviour, and
no Lane A or Store/Purchase file was touched.

## B3E corrections, round two — request coordination (complete)

Review found four more coordination defects. Fixing them turned up a fifth,
which the browser proved and which invalidates a premise of the previous round.

### The premise that was wrong

**The App Router remounts this page when `[id]` changes.** Verified directly: a
share POST was left in flight, the route was changed, and the new route already
showed *no* outstanding share — the state and refs had been destroyed with the
previous component instance.

The previous round therefore did not do what its own notes claimed. A `useRef`
lock does not survive navigation, so nothing prevented a second share starting
on the new order; and a route epoch held in a ref restarts at zero, so
A → B → A produces `{A,1}` twice — the exact collision the epoch exists to
prevent. That round's route-isolation evidence was real but explained by the
remount making the old component's `setState` calls no-ops, not by the guard.

**The lock, the vendor lookup and the visit counter now live at module scope**,
outside the component, and the lock carries a subscription the page reads with
`useSyncExternalStore`. There is exactly one copy of "a share is outstanding":
the interface renders the authority instead of a flag kept beside it.

### 1. Nothing visible happens before the lock is owned

The page set the snapshot, cleared the error and entered the submitting state,
then called `submitShare()` and discovered the attempt was refused — leaving the
route claiming a submission that was never its own, with nothing to undo it.

Validation and the claim are now both synchronous and both inside the boundary.
`onStart` fires once, immediately after a successful claim, and is the only place
the page may freeze the snapshot or clear its error. A refused duplicate, and an
attempt blocked because another route holds the lock, return having touched
nothing at all.

### 2. The lock survives navigation, and the interface says so

The route reset used to call `setSharingLoading(false)` while deliberately
keeping the lock — the interface and the authority disagreeing by construction.

`sharingLoading` is gone. The single lock is held across route changes until its
POST settles; while it is held by another order the current route's Share action
is disabled and reads **"A previous vendor share is still resolving."**; opening
a dialog and entering a submitting state are both refused. `onSettle` runs on
every terminal path from any route, so the busy indicator settles wherever the
reader is — that crossing is allowed; painting the previous order's
confirmation, error, selection, vendor or refresh is not.

The open-dialog invalid-selection guard now asks whether **this visit** owns the
lock, so another order's share is never mistaken for this dialog submitting.

### 3. A → B → A: the id matches, the visit does not

Comparing ids alone, a reader returning to A was accepted as the asker of a share
started on the previous visit. Every submission and every vendor lookup now
carries a **route visit** — id plus a monotonically increasing epoch — and an
answer may touch the screen only when both still match. `attemptId` is not a
substitute: it identifies a claim on the lock, and two visits can each hold
attempt 1.

A stale answer from an earlier visit releases its lock and settles the busy
indicator, and does nothing else.

### 4. The dialog-open ref was a render behind

`openShareDialog()` set React state and started the lookup in the same turn,
while `shareModalOpenRef` was assigned from render — so an answer that resolved
synchronously was judged against a ref still saying "closed" and discarded.

The ref is now authoritative and written first by all four places that open or
close the dialog: open, close, a confirmed share, and the route reset. The
render-derived assignment is gone entirely — a test asserts it cannot come back.

### Tests

- `moVendorShare` — **65/65** (was 57/57).
- Manufacturing suite **190/190** (was 182/182).
- `npm test` — **641/641** (was 625/625). The delta is not exactly +8: other
  lanes changed their own tests in the working tree while this ran. The
  manufacturing delta is exact.
- `git diff --check` clean in both repositories.
- `@swc/core` is not installed in this tree, so route syntax was verified by the
  **dev server compiling and rendering the page**. `next build` still fails only
  on the pre-existing, unrelated Accountant `splitGstByRate` duplicate binding.

Every coordination test drives the real helpers — `submitShare`,
`claimShareLock`, `beginVendorLookup`, `resolveVendorLookup`,
`currentRouteVisit` — with plain objects standing in for the module-scope
singletons. Two tests earned their place by failing first: one caught a leftover
`shareModalOpenRef.current = showShareModal` assignment, the other a
`setOutstandingShare` copy that had no reason to exist once the lock was
subscribable.

### Browser verification — zero mutations

Two orders from one intercepted fixture; undelayed vendor answers return an
already-resolved promise, so the same-turn case is genuinely exercised.
`read_network_requests` for the backend origin recorded **no requests at all**.
Eight POSTs were issued across the session, all answered by the fixture; every
body carried exactly `forwardedBy, vendorId, workOrderIds` with the pinned actor.

| Case | Result |
|---|---|
| three submit clicks in one render turn | **exactly one POST**; the snapshot showed what was sent |
| immediate vendor lookup on open | a synchronously resolved answer **paints**; no stuck "Loading vendors", no error |
| close before the answer | nothing written; reopening with a failing lookup showed the failure, never the stale vendor |
| A → B while pending | B reads **"A previous vendor share is still resolving."**, opens no dialog, starts no vendor lookup, issues no second POST |
| B after A settles | usable again the moment the request settled, with **no** confirmation, error, selection cleanup or refresh from A (GET count unchanged) |
| A → B → A, late **success** | discarded: selection kept, no confirmation, no refresh, action restored |
| A → B → A, late **failure** | discarded: no error anywhere on the returning visit, no refresh |
| same-route failure | stays in the dialog with the server's reason, selection kept, retryable, dismissable, no refresh |
| same-route confirmed success | closes, clears, announces, **exactly one refresh and one POST** |

Console clean apart from pre-existing service-worker push-registration errors.

### Preserved

Print implementation and styling untouched. Endpoint, method, credentials and
payload unchanged, `forwardedBy` included — **the hard-coded actor remains a
Lane A security dependency and this workflow is still not security-complete.**
Dialog copy is unchanged except the new outstanding-request explanation beside
the Share action. No planning or status behaviour, no backend application code,
and no Lane A or Store/Purchase file was touched.

## B3E corrections, round three — identity (complete)

Two identity defects, both reproduced with failing tests before any code moved.

### Correcting the previous round's claim first

The last round reported A → B route isolation as verified in the browser. **That
evidence did not prove what it was offered as proving.** It showed the screen was
unaffected and the detail-GET list unchanged — which is what you see whether the
policy discarded the answer or wrongly accepted it, because React silently drops
state updates from an unmounted component. Harmless *visible* behaviour is not a
verdict. This round instruments the policy result itself.

### 1. The remount-safe guard was not remount-safe

The page handed the boundary `liveVisit: () => routeVisit(liveIdRef.current,
visitEpochRef.current)` — a callback over its own refs. When route A unmounts
those refs freeze at A's original visit, so a late answer compared **A1 with A1**
and was accepted with B, or a second visit to A, on screen.

Reproduced against the shipped code:

```
✖ a frozen liveVisit from an UNMOUNTED component accepts a stale success
    + 'complete'   - 'discard'
✖ the same hole accepts a stale failure
      'fail' !== 'discard'
```

Not merely cosmetic: `setState` from a dead component is a no-op, but the
captured `fetchData(true)` on the success branch is a plain function and was
still reached.

**The model now holds two distinct facts.** A request owns an **immutable frozen
token**, allocated once per mounted page instance. The **active visit** — the one
committed to the screen — lives in a module-scope coordinator that outlives any
component, and a late request reads it *from there* after the await. The
boundary no longer accepts a "what route am I on" callback at all: the injection
point is gone, and a test asserts the parameter cannot come back.

Allocation happens in the **commit phase**, never during render, so a discarded
double render cannot burn a sequence number. Cleanup stands down only if still
active, so an older instance's teardown cannot erase a newer published visit. A
re-render creates no visit; A → B → A creates three. Vendor lookups consult the
same authority.

### 2. Lock release contradicted its own documented rule

`releaseShareLock()` compared `attemptId` alone, directly beside a comment saying
an attempt id does not identify a visit. Reproduced:

```
✖ a ticket from another visit releases the owner's lock
      true !== false
```

Release is now the **identity of the ticket `claimShareLock()` returned**. A
forged tuple carrying the same three fields is refused, so no other route, visit
or superseded attempt can free a lock and let a second POST start against work
orders the first is still forwarding.

### Tests

- `moVendorShare` — **68/68** (was 65/65).
- Manufacturing suite **193/193** (was 190/190).
- `npm test` — **663/663** (was 641/641). Not exactly +3: other lanes changed
  their own tests in the working tree while this ran. The manufacturing delta is
  exact.
- `git diff --check` clean in both repositories.
- Route syntax verified by the dev server compiling and rendering the page;
  `@swc/core` is not installed in this tree. `next build` still fails only on the
  pre-existing, unrelated Accountant `splitGstByRate` duplicate binding.

The regressions model the real remount — mount, submit, unmount, mount B, mount
A again — against the actual coordinator, not a source regex.

### Browser verification — the verdict, not the screen

A **temporary** browser probe recorded what the policy returned, because an
unchanged screen after unmount proves nothing. **It has since been removed** —
test instrumentation does not belong in shipped code, not even behind
`NODE_ENV !== "production"` — and the evidence below is preserved here as the
record of that run. What the probe demonstrated is now carried permanently by
pure regressions in `moVendorShare.test.mjs`, which drive the same coordinator
and assert the same `discard` verdicts without touching the application. A test
asserts `__shareOutcomes`, and any `window.__` hook, cannot return to the page,
the policy module or the dialog. `read_network_requests` for the backend origin
recorded **no requests at all**; five POSTs were issued, all answered by the
fixture, every body carrying exactly `forwardedBy, vendorId, workOrderIds` with
the pinned actor.

| Case | Recorded verdict | Screen |
|---|---|---|
| three submit clicks in one turn | one `complete`, two `ignored / in-flight` | **exactly one POST** |
| A → B, late success | **`discard / route-changed`** (state `success`) | B keeps its selection, no confirmation, no error, GET count unchanged |
| A → B → A, late success | **`discard / route-changed`** | returning visit keeps its selection, no confirmation, no dialog |
| A → B → A, late failure | **`discard / route-changed`** (state `error`) | no error anywhere, GETs unchanged at 14 |
| B while A is pending | — | reads "A previous vendor share is still resolving.", opens no dialog, starts no lookup, issues no second POST |
| B after A settles | — | usable again, with none of A's outcome |
| same visit, failure | `fail` | stays in the dialog with the server's reason, selection kept, retryable, no refresh |
| same visit, success | `complete` | closes, clears, announces, exactly one refresh and one POST |

### Preserved

Endpoints, method, credentials and payload keys unchanged; print implementation
and styling untouched; selection reconciliation and dialog accessibility
unchanged. **The hard-coded `forwardedBy` remains an unresolved Lane A security
dependency and this workflow is still not security-complete.** No backend
application code, no planning or status behaviour, and no Lane A or
Store/Purchase file was touched.

## B3E — closed

Cleanup pass. The verification probe is gone from
`app/.../manufacturing-orders/[id]/page.js`; nothing else changed. The
coordinator, immutable visit tokens, exact-ticket lock release, request
behaviour, interface, endpoints and payload are all exactly as verified in the
previous round.

**Sweep:** `__shareOutcomes` appears nowhere in the frontend repository —
tracked or untracked, excluding `node_modules`/`.next` — and no `window.__` hook
survives in the page, the policy module or the dialog. Confirmed again in the
browser: after deleting the leftover global by hand, a real submission did **not**
recreate it.

**Permanent regressions** now carry what the probe proved:

| Proof | Test |
|---|---|
| a frozen callback cannot influence submission identity | asserts both directions — it can neither accept a stale answer nor reject a current one — and that the parameter cannot come back |
| A → B late success / failure | `discard` / `route-changed`, lock settled |
| A → B → A late success / failure | `discard` / `route-changed`, three distinct visits |
| a foreign or reconstructed ticket cannot release the lock | another route, a later visit, and a forged identical tuple are all refused |
| rapid duplicate submission | exactly one request; the extras return `ignored / in-flight` |
| same-visit success and failure | `complete` and `fail`, unchanged |
| vendor lookup uses the shared active-visit authority | paints for the committed visit, discards for an unmounted one |

One test-rig fix worth recording: the comment-stripping helper guarded itself
with "at least half the source must survive", which is wrong for files that are
deliberately comment-heavy — the policy module is 37% code. The guard is now
structural: the END of the file must survive, which is precisely what the
runaway block comment destroyed, plus an optional named sentinel.

### Verification

- `moVendorShare` — **71/71**.
- Manufacturing suite **196/196**.
- `npm test` — **665/666**. The single failure is **not this lane's**: the
  Store/Purchase lane changed `app/store/dashboard/configurations/warehouse/page.js`
  at 17:31 (history paging moved from `?page=&limit=10` to a cursor), while its
  own `components/store/warehouse-master/warehouse.test.mjs` still asserts the
  old URL. Both files are theirs, neither mentions manufacturing, and the same
  suite was 666/666 minutes earlier in this pass. Left untouched.
- Route compiled and rendered by the dev server on a **pristine page with a
  single fetch wrapper**: identity, canonical summary, Print current section,
  the dialog with its ARIA relationships, stored work-order numbers
  (`WO2026-000701`, `WO2026-000702`), three submit clicks → **one POST** with
  keys `forwardedBy, vendorId, workOrderIds` and the pinned actor, and a
  same-visit failure held in the dialog with the selection intact.
- `read_network_requests` for the backend origin: **no requests at all**. Console
  clean apart from pre-existing service-worker push-registration errors.
- `git diff --check` clean in both repositories.
- Backend footprint: this handoff only. (`project-manager-lane-b-chunk-01-prompt.md`
  is the B1 prompt document from 2 Sept and was not touched.) No Lane A or
  Store/Purchase file was modified.

### Status

**B3E is complete.** Print is honest and scoped; the vendor-sharing dialog has
eight real states, no `alert()`, no optimistic success, a focus trap and honest
work-order numbers; and share coordination is correct across duplicate
submission, vendor-lookup races, navigation and remounts.

**The hard-coded `forwardedBy` remains an unresolved Lane A security dependency.
The sharing workflow is not security-complete.** The fix belongs at the route:
derive the actor from the authenticated session and ignore any client-supplied
value.

## PM Overview — the Accounts product language (complete, graph deferred)

The Project Manager landing page now reads as the production counterpart of the
Accounts cash-flow forecast: the same dark summary slab, 1480px measure,
restrained palette, frosted surfaces and hairline borders, exception rail and
dense operational table, on the FrostShell chrome both departments already
share.

### What was built

**Summary slab.** `AcctPageSlab` rendered directly — not forked. That component
carries no money in it (no `fmtINR`, no finance wording, no finance ARIA), so it
is the shared silhouette rather than a finance component. **No file under
`app/accountant/`, `components/accountant/` or `app/accountant-ui.css` was
edited**, and `git status` for those paths is empty.

**Action rail.** Three items, each a real question with a real destination:
requests awaiting a PM decision (the Requests desk's own `countDecisions`, MO
rows only — MRFs are view-only for a PM and would send somebody to a 403), and
two register links built with the register's own `queryToHref`, so the number
and the page it opens are the same question. A count that fails reads as an em
dash and never as zero: "nothing needs you" is the most damaging thing this rail
could say wrongly. A fourth "planning exceptions" row was deliberately not
added — nothing truthfully supplies it, and a permanently-zero row teaches
people to stop reading the rail.

**Recent orders.** Dense table at `deck` and above, the existing card list below,
both from the register's own projection.

### What was deliberately NOT built

**No graph, and no frame for one.** `stats/overview` is eight scalars with no
time dimension; the five recent orders are a page of a list, not a sample of
history. No empty panel and no inert 4/8/12-week pills stand in for it — an
empty frame with dead controls is a promise the page cannot keep. The layout
leaves the graph a full-width row between the slab and the rail, so it can
arrive without anything below it moving.

**"Completed this month" is gone.** The server counts it as

```js
WorkOrder.countDocuments({ status: "completed", updatedAt: { $gte: startOfMonth } })
```

— `updatedAt`, not a completion date, so any completed work order touched by an
unrelated edit inflates it. It can only overstate and cannot be corrected on the
client. `completedWO` took its place, labelled **"Completed … to date"**, and the
footnote says outright that there is no per-period completion figure yet. A test
asserts the `updatedAt`-based figure reaches neither the slab nor the page.

**"Loaded HH:MM", not "as of".** This response carries no server timestamp, so
the only honest claim is when the browser received it.

### Lane A dependency — the production-trend contract

Validated against `models/CMS_Models/Manufacturing/WorkOrder/WorkOrder.js`:
`timeline.actualStartDate` and `timeline.actualEndDate` both exist, are typed
`Date`, and **default to `null`** — which is why `coverage` is part of the
contract and not an afterthought. The planning-lifecycle decision already
documents work orders with execution-ledger evidence and no `actualStartDate`
(`startedWithoutTimestamp`).

```
{ success, trend: { bucket: "week", weeks,
    points: [{ periodStart, periodEnd, startedWorkOrders, completedWorkOrders }],
    coverage: { startedWithoutTimestamp, completedWithoutTimestamp } } }
```

`updatedAt` must not stand in for a completion date. Recorded in code as
`PRODUCTION_TREND_DEPENDENCY` in `components/manufacturing/pmOverview.js`, beside
the consumer, so the two cannot drift.

**Note for Lane A — corrected.** An earlier draft of this section said the
planning-lifecycle document was "PROPOSED — awaiting approval". That was stale.
It is **APPROVED IN PART**: decisions 1–14 were accepted at their recommended
defaults on 3 Sep 2026, and only decision 15 (the review queue's operational
owner) is outstanding — which blocks sign-off of the legacy classification
backfill, not this page. **The graph is blocked because the read contract does
not exist yet**, nothing more. When the endpoint lands, the graph and a real
"Completed in selected period" figure ship together.

### Two things found in the browser

- **The slab overflowed at 768px.** `AcctPageSlab` lays its figures out as a
  single non-wrapping row from `sm:` up, and four long labels pushed "In
  progress" off the edge as "IN PROGRE". Fixed in this page's CONTENT — labels
  shortened to "Not yet started" and "Completed" — because the slab is the
  books' component too and changing its layout would move theirs.
- **The order list overflowed at 375px**, sizing its column to 416px inside a
  375px screen: grid items default to `min-width: auto` and refuse to shrink
  below their content. Fixed with `min-w-0` on both columns.

One shared-component trait observed and deliberately **not** patched: on the
`compact` silhouette the tab sits at `calc(52px * -1 + 18px)` while the
title-plus-sub stack is ~45px tall, so the sub dips ~11px under the slab's top
edge at narrow widths. `AcctPageSlab`'s own comment documents this, it is
identical for every Accounts page passing a `sub`, and fixing it here would
change Accounts. Raised for the design system.

### Files and tests

| File | |
|---|---|
| `components/manufacturing/pmOverview.js` | **new** — slab figures, the refused stat and why, the loaded-at claim, the rail, the awaited contract. |
| `components/manufacturing/pmOverview.test.mjs` | **new** — 17 tests. |
| `app/project-manager/dashboard/page.js` | slab, rail and dense table; the `StatStrip` section removed. |

- `pmOverview` **17/17**; manufacturing **213/213**; `npm test` **694/694**.
- `git diff --check` clean in both repositories.
- Verified in the browser at **1440 / 768 / 375** against intercepted read-only
  fixtures; every non-GET was blocked and none was attempted. Nav, URLs and role
  gates are unchanged — the five-entry information architecture, grouped
  Production and Setup, and the 1480px measure were already in place from B2.

## PM Overview — correction pass (complete)

Five corrections. Two were false statements this lane published; three were
defects in the new page.

### 1. The planning decision's status was stale — corrected

The Overview report and handoff said the planning-lifecycle document was
"PROPOSED — awaiting user approval". It is **APPROVED IN PART**: decisions 1–14
accepted at their recommended defaults (3 Sep 2026); decision 15 outstanding,
blocking only sign-off of the legacy classification backfill. Corrected in all
three places this lane repeated it.

The graph is blocked for a narrower and more ordinary reason, now stated
wherever it appears: **no endpoint serves weekly buckets yet.** Recorded in code
as `PRODUCTION_TREND_DEPENDENCY.blockedBy`. Lane A's decision document was not
edited.

### 2. "Completion timestamps are not yet recorded" was false — corrected

`timeline.actualEndDate` is written today by **four live paths**:

| Path | |
|---|---|
| `services/productionSyncService.js:511` | production sync |
| `routes/…/Packaging/packagingRoutes.js:254` | packaging completion |
| `routes/Vendor_Routes/vendorWorkOrderRoutes.js:363` | vendor completion |
| `routes/…/manufacturingOrderRoutes.js:1451` | PM manual mark |

What is genuinely absent is **coverage**, not the evidence: every one of those
writes is guarded (`if (wo.timeline && !wo.timeline.actualEndDate)`), the field
defaults to null, and work orders completed before those paths existed carry
nothing. `SUMMARY_NOTE` now says completion timestamps are recorded going forward,
are not guaranteed for older work orders, and that this endpoint reports no time
buckets or coverage totals. `completedWOThisMonth` is still refused — it reads
`updatedAt` — but the refusal no longer rests on a false claim about the evidence.

### 3. Missing progress was rendered as 0% — corrected

Both new row variants carried `order.completionPercentage ?? 0`, drawing an empty
meter and "0%" for an absent value — reintroducing exactly the bug
`moPercentValue` exists to prevent (its own comment: `|| 0` "turned every absence
into a confident nothing-done"). Both now read `formatMoPercent` and
`moPercentValue`:

- finite → bounded meter and percentage;
- genuine `0` → `0%` **with** a meter;
- missing, null, `NaN` or a numeric **string** → `—` and "Progress unavailable",
  **no meter at all** — an empty bar is a claim that nothing is done.

### 4. A second deadline policy was created — corrected

The rows read `deliveryDeadline || estimatedCompletion`, bypassing the canonical
`order.deadline`, and derived the tone from the **browser clock** via
`deadlineToneClass` — so a row could contradict the server filter that selected
it. Both variants now use `moDeadline(order)` and
`deadlineRiskMeta(order.deadlineRisk)`: the server's band, in the register's
words. `deadlineToneClass` is gone from this page.

Both variants now share **one adapter** (`overviewRow`); every derived field is
read inside it and nowhere else, which is what stops the wide table and the
narrow list drifting apart.

### 5. A failed refresh discarded the answer on screen — corrected

The page's comment claimed previous data was kept while reloading; both failure
branches assigned `data: null`. Initial failure and refresh failure are now
different outcomes (`sectionLoading` / `sectionLoaded` / `sectionFailed`):

- nothing loaded and the request fails → normal error state;
- data on screen and the refresh fails → **data kept, `loadedAt` kept**, inline
  refresh warning;
- successful retry → data replaced, warning cleared, stamp moved.

The slab's stamp is now the **stats section's own** arrival time. It came from a
single page-level `updatedAt` written by both loaders, so a successful
recent-orders reload re-stamped a slab whose own request had failed — figures
from earlier, labelled with the current minute. The rail's three counts remain
independent.

### Tests

- `pmOverview` **33/33** (was 17/17). Manufacturing **229/229** (was 213/213).
- `npm test` — **717/717** (baseline this pass: 701/701).
- `git diff --check` clean in both repositories.
- The state policy is tested as behaviour — `sectionFailed` on a loaded section
  keeps both the data and the timestamp — not by source-text assertion.

### Browser verification — 1440 / 768 / 375

Authenticated read-only fixtures on a pristine page; **zero non-GET attempts**,
and `read_network_requests` for the backend origin recorded **no requests at all**.

| Case | Result |
|---|---|
| complete valid fixture | slab, rail, table and card list all correct |
| genuine `0` progress | `0%` **with** a meter |
| missing / string `"100"` progress | `—` + "Progress unavailable", **no meter** |
| conflicting deadlines | canonical `2026-08-20` beat legacy `2027-12-31` and `2020-01-01` |
| risk vocabulary | Overdue · Due within 7 days · No deadline · Closed; unknown enum → "Deadline status unavailable", never raw |
| failed initial stats load | error shown, figures `—`, **no stamp**; rail and table still loaded |
| failed stats refresh | figures kept, **stamp frozen at 18:45** while a successful orders reload ran; warning shown, no blank error |
| failed recent refresh | 5 rows kept with their own warning; stats recovered independently |
| successful retry | both warnings cleared, stamp moved 18:45 → 18:46 |
| horizontal overflow | none at any width; 0 elements past the viewport at 375 |

Zero Accounts files and zero backend application files changed — the only backend
file this lane touches is this handoff.

## B3F-A — Work-order detail shell and truthful read states (complete)

A clearly visible frontend change: the work-order detail page now reads as part
of the same platform as the Accounts cash-flow forecast, and its reads no longer
lie about missing facts. No mutation, endpoint, payload or role gate changed.

### Visible before → after

| | Before | After |
|---|---|---|
| Identity | Header read **"Work Order"** on every order | Dark identity slab: the order's **number**, product, and **exact status** as the headline (WorkOrderSlab over `AcctPageSlab`) |
| Status | `simplifyWoStatus()` collapsed eleven statuses into four — `delayed`, `paused`, `forwarded` all read **"In-Progress"**, and an unknown value did too | The shared **eleven-value** vocabulary; `delayed`/`paused`/`forwarded` read as themselves, unknown reads **"Status unavailable"** |
| Failure | 403, 500, network drop and a deleted order all showed **"Work Order Not Found"** | Distinct **permission wall / "No such work order" / retryable error** screens |
| Missing money | `formatCurrency(n \|\| 0)` → **₹0** | missing → **"—"**, genuine ₹0 prints |
| Missing progress | `Meter value={pct \|\| 0}` → an empty bar at **0%** | **no meter** when the percentage is absent; a genuine 0% still draws one |
| Missing materials | `?.length \|\| 0` → **"0 / 0"** | missing array → **"—"**, empty array → "0 / 0" |
| Missing duration | `if (!s) return "0s"` → **"0s"** | missing → **"—"**, genuine 0s prints "0s" |

### The five corrections

**1. Status vocabulary.** `simplifyWoStatus`, the local four-value `WO_STATUS_META`,
`statusBadge`, `statusLabel` and `opStatusBadge` are gone. Chips come from
`woStatusMeta` (moWorkOrders.js) and a small `operationStatus`. No raw enum, no
`.replace(/_/g," ")`, no `.toUpperCase()` of a status reaches the screen. Stored
`WorkOrder.status` and every mutation gate are untouched.

**2. Request lifecycle.** `if (!res.ok) return; if (!data.success) return;` are
replaced by `classifyWorkOrderResponse` → `resolveWorkOrderOutcome`, with a
module-scope **route-visit coordinator** (from moVendorShare.js). An answer for
visit A never paints under B, and **A → B → A** is safe because the returning
visit carries a fresh epoch. A background refresh keeps the visible order and a
failed refresh keeps it with an inline warning at its own load time. The
progress read is a genuinely independent secondary: its failure sets only its
own error and can never produce "not found". The redundant `/panel-count`
sub-fetch was dropped — the primary response already carries `panelCount` — so
"secondary reads fail independently" is demonstrated by the progress read that
actually feeds the slab. **No production-only browser probe was added.**

**3. Missing ≠ zero.** A pure adapter per fact in `workOrderDetail.js`:
`formatWoMoney`, `formatWoDuration`, `woPlannedTime` (which distinguishes "no
operations array" from "operations present, each zero seconds"), `woAllocation`
(missing array vs empty array), `woCount`, and `workOrderProgress` (a meter only
when the percentage is non-null). Every one is tested with genuine-zero and
missing side by side.

**4. Accounts-style shell.** `WorkOrderSlab` renders `AcctPageSlab` directly —
no fork, and it carries no money in it, so no Accounts file was touched. The
slab answers identity, product, exact status (hero), quantity, progress *when
the endpoint answered*, deadline *when set*, and vendor-managed as a pill.
Absent progress and an unset deadline are simply omitted from the slab, not
drawn as 0%/"Not set". Below it: a compact **"Loaded HH:MM"** strip tied to the
last successful primary read, then a light action row (Back, QR, Plan/Start/
Pause/Complete/Resume) so the shared Button primitives keep their ground and
every `RoleGate` wrapper stays byte-identical. The 1480px measure is unchanged.
No fake graph.

**5. Actions frozen.** Plan/Start/Pause/Resume/Complete, QR generate/view, and
vendor read-only behaviour keep their exact handlers, POST endpoints and role
gates. `canStartProduction` and the local `needsPlanning` predicate are
byte-for-byte unchanged; the additive `planningState` foundation is **not**
consumed.

### Files

| File | |
|---|---|
| `components/manufacturing/workOrderDetail.js` | **new** — the lifecycle, the fact adapters, the slab mapping, the deadline notes. |
| `components/manufacturing/workOrderDetail.test.mjs` | **new** — 29 tests. |
| `components/manufacturing/mo-detail/work-order/WorkOrderSlab.js` | **new** — the identity slab. |
| `components/manufacturing/mo-detail/work-order/WorkOrderStates.js` | **new** — loading / permission / not-found / error screens. |
| `app/.../production/work-orders/[id]/page.js` | the shell, lifecycle and honest facts wired in; mutations untouched. |

### Tests

- `workOrderDetail` — **29/29** (new). `moWorkOrders` — **32/32**, unchanged.
- Manufacturing suite **258/258** (was 229/229). `npm test` — **749/749**.
- `git diff --check` clean in both repositories.
- `@swc/core` is not installed in this tree, so the page's syntax was verified by
  the **dev server compiling and rendering it** across every case below. The
  known unrelated Accountant `splitGstByRate` duplicate-binding build error was
  not touched.

### Browser verification — 1440 / 768 / 375, zero mutations

Authenticated read-only fixtures on a pristine page. `read_network_requests` for
the backend origin recorded **no requests**, and the fixture log shows **zero
non-GET calls** except session `auth/verify` — no work-order mutation POST was
issued across the whole session.

| Case | Result |
|---|---|
| planned / in-progress / completed / forwarded orders | correct exact status; forwarded reads "Forwarded to vendor", shows "Read Only", no Start |
| all eleven statuses | 11 distinct labels (pure test); unknown → "Status unavailable" |
| missing facts | quantity "—", materials "—", total time "—", deadline "Not set", cost "—" |
| genuine-zero facts | quantity "0", materials "0 / 0", total time "0s", cost "₹0" — **side by side with the missing case** |
| 403 | permission wall, never "not found" |
| 404 | "No such work order" with Go back |
| non-JSON 500 | retryable "didn't load" error, never "not found" |
| failed refresh | order stays, inline "Refresh failed" warning, **stamp frozen** at the last good load |
| secondary (progress) failure | order stays; never becomes "not found" |
| A → B / A → B → A | each URL shows its own order; no cross-paint |
| viewer vs editor/approver | RoleGate wrappers byte-identical and unit-verified; the in-browser viewer sim is limited by the session's in-memory role cache (a full reload would drop the fixture), so this is asserted structurally rather than clicked |
| responsive | no page overflow at any width; the tab strip scrolls inside its own container at 375 |

### Preserved

No Accounts file, no backend application file, and no Lane A or Store/Purchase
file was changed — the only backend file this lane touches is this handoff. The
dirty worktree's Lane A / Store-Purchase changes were left intact.

## Recommended next

**Superseded — kept for the record.** When B2.2 was written, B3 had not started
and Lane A's eight canonical detail fields were unread by the detail page. Both
statements are now out of date:

- **B3A** consumed the eight canonical fields and rebuilt the detail request
  lifecycle; **B3B** decomposed the work-order panel; **B3C** corrected the
  Delivery Details section; **B3D** grouped and made the section navigation
  bookmarkable. All four are complete and recorded in their own sections below.
- **B3E** — honest header actions and the vendor-sharing dialog — is also
  complete, together with three rounds of request-coordination and identity
  corrections; see its four sections above.

**B3F-A** (work-order detail shell and truthful read states) is complete; see
its section above. Its dependency note is corrected here:

- The `tlApproved`/`tlRejected` fields are **no longer missing** — Lane A added
  them to `routes/CMS_Routes/pm/pmRequestsRoutes.js:54`'s `.select(...)`. That
  was never a blocker for B3F anyway (it concerns the requests desk, not the
  work-order shell); it is simply resolved.
- **Vendor-forwarding actor attribution remains unresolved** and is NOT claimed
  solved: the backend still writes the client-supplied `forwardedBy` verbatim.
  But it blocks only truthful *vendor mutation* attribution — B3F-A is a
  read-shell change that performs no mutation, so it was never gated on it.

The work-order planning lifecycle decision is **APPROVED IN PART** — decisions
1–14 accepted, decision 15 outstanding, blocking only the legacy backfill
sign-off — but **none of it is implemented**. B3F-A therefore does not consume
the additive `planningState` foundation: planning eligibility is the same local
predicate it always was. The next step is **B3F-B**, not started.

## Superseded note

Manufacturing-order register usability, against the live APIs and the existing
`components/manufacturing/moStatus.js` contract — the original B2 scope. Both
files are still in Lane A's working tree, so it must wait until Lane A's
manufacturing-order work is committed and they are free.
