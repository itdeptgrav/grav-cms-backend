# IE — Chunk 0: Boundary, Inventory and Safety Harness

**Status:** Product boundary approved; source audit complete. **Chunks 1A–1E,
Lane A, Chunk 2A, the Chunk 2 Operations frontend, Chunk 3A, Chunk 3B, Chunk 4A,
the Chunk 4A Method Study frontend, Chunk 4B, its frontend, Chunk 5A, its
frontend, Chunk 6A and the Chunk 6A Line Planning frontend are all ACCEPTED**
along with Chunk 6B's required-machine compatibility backend and frontend and
Chunk 6C's reusable-line-template backend and frontend, Chunk 7A's draft
    capacity-standard backend and frontend, Chunk 7B's bounded ramp backend and
    frontend, Chunk 7C1's immutable Operation Bulletin Version lifecycle, and
    Chunk 7C2's Line Layout approval against an approved Bulletin Version, and
    Chunk 7C3's Capacity Standard approval against an approved Line Layout
    revision (latest review 13 September 2026).  
**Date:** 7 September 2026 (navigation decision added 8 September 2026;
Chunks 1A–1C and Lane A accepted 8 September 2026)

| Chunk | What it is | Status |
|---|---|---|
| 1A | IE identity, `ie` grant, read boundary (styles, routes, operation library) | **Accepted** 8 Sep 2026 |
| 1B | Order-wise read boundary (`/api/cms/ie/orders`) | **Accepted** 8 Sep 2026 |
| 1C | Read-only production-data readiness audit | **Accepted** 8 Sep 2026 |
| Lane A | Status-independent style ownership | **Accepted** 8 Sep 2026 |
| **1D** | Order-to-style linkage write path | **ACCEPTED** 8 Sep 2026 |
| 1E | IE frontend (`grav-cms` `/industrial-engineering`) | **Accepted** 9 Sep 2026 |
| 2A | Company-scoped operation-library backend contract | **Accepted** 9 Sep 2026 |
| Chunk 2 frontend | Editable IE Operations library (`grav-cms`) | **Accepted** 9 Sep 2026 |
| 3A | Style Engineering File and editable DRAFT bulletin backend | **Accepted** 9 Sep 2026 |
| 3B | Style Engineering File and editable DRAFT bulletin frontend | **Accepted** 9 Sep 2026 |
| 4A | Draft method study and deterministic normal-time backend | **Accepted** 9 Sep 2026 |
| 4A frontend | Method Study workspace inside the saved bulletin row | **Accepted** 9 Sep 2026 |
| 4B | Allowance policy, standard time and method-study approval backend | **Accepted** 9 Sep 2026 |
| 4B frontend | Allowance Settings and method-study submit/return/approve UI | **Accepted** 9 Sep 2026 |
| 5A | Operation machine, attachment, skill and labour requirements backend | **Accepted** 9 Sep 2026 |
| 5A frontend | Operation Resource Requirements workspace inside Operations | **Accepted** 9 Sep 2026 |
| 5B | Safe machine and labour availability integration | **Blocked** 9 Sep 2026 — upstream Maintenance/HR contracts absent |
| 6A | Versioned IE line layout and deterministic balancing backend | **Accepted** 9 Sep 2026 |
| 6A frontend | Line Planning workspace for station arrangement and balance | **Accepted** 10 Sep 2026 |
| 6B | Frozen required-machine evidence and planned-station compatibility backend | **Accepted** 10 Sep 2026 |
| 6B frontend | Planned station machine types and server compatibility UI | **Accepted** 10 Sep 2026 |
| 6C | Reusable line templates with fresh applied identities backend | **Accepted** 10 Sep 2026 |
| 6C frontend | Template management and safe application UI | **Accepted** 10 Sep 2026 |
| 7A | Draft capacity standard and deterministic target calculation backend | **Accepted** 10 Sep 2026 |
| 7A frontend | Capacity register and DRAFT-standard workspace | **Accepted** 10 Sep 2026 |
| 7B | Company-scoped versioned ramp profiles, frozen onto capacity standards | **Accepted** 10 Sep 2026 |
| 7B frontend | Ramp Profile management and frozen-stage selection in Capacity | **Accepted** 10 Sep 2026 |
| 7B calendar | Authoritative factory working-time calendar integration | **Blocked** 10 Sep 2026 — no safe company-scoped, versioned working-time source exists |
| Chunk 8A audit | Release, PPC acknowledgement, barcode continuity and prerequisite contract | **Accepted** 11 Sep 2026 |
| 7C1 | Immutable Operation Bulletin Version lifecycle | **Accepted** 11 Sep 2026 |
| 7C2 | Line Layout approval against one approved Bulletin Version | **Accepted** 11 Sep 2026 |
| 7C3 | Capacity Standard approval against one approved Line Layout revision | **Accepted** 13 Sep 2026 |
| 7C approval frontend | Bulletin Version, Line Layout and Capacity Standard approval UI | **Next frontend** |
| 8A-i | Immutable IE release and idempotent issue command | **Accepted** 13 Sep 2026 |
| 8A-ii | PPC inbound queue and immutable receiver receipt | **Next backend** |

**Readiness audit verdict:** `NOT_READY_FOR_ORDER_WISE_FRONTEND` — a statement
about the DATA, not a block on building. Frontend work was explicitly authorised
on 8 September 2026 once the corrected Chunk 1D linkage path existed for newly
created orders.  
**Current blocker:** all 95 operational work orders resolve to
`UNRESOLVED_ORDER_LINE` — none has a provable order-to-style/company link.  
**Next backend task:** implement Chunk 8A-ii, the PPC inbound queue and immutable
receiver receipt over the accepted IE release collection, using the receiver-read
boundary in
`docs/audits/industrial-engineering-chunk-08-release-readiness-audit.md`.
**Next frontend task:** expose the accepted 7C1–7C3 submit/review/approve
contracts inside the existing Engineering File, Line Planning and Capacity
workspaces before adding a release UI. The provisional-calendar limitation
remains explicit: approval accepts the stated frozen assumptions; it does not
claim an authoritative factory calendar exists. No legacy backfill is
authorised. The Chunk 7B source audit is
`docs/audits/industrial-engineering-chunk-07b-working-time-audit.md`; its verdict
keeps the calendar half blocked. **Two upstream contracts now block IE, not
one:** Chunk 5B still needs Maintenance/HR availability contracts, and Chunk
7B's calendar integration needs a company-scoped, versioned, publish-frozen
factory working-time standard. WorkOrder provenance remains separately blocked
on Production tenancy/ownership. IE release issuance and its idempotent version
chain are accepted; Chunk 8A-ii is now the next backend slice.

**Barcode continuity is mandatory, but not owned by Chunk 6B.** Existing floor
tracking records the work-order piece barcode, physical `machineId` and active
operation-code snapshot. Chunk 6B must leave that ingestion and every already
printed barcode unchanged. It may prepare stable IE provenance only; Chunk 8
freezes that provenance into the released work-order snapshot and Chunk 9 reads
the resulting scan actuals back against the exact standard. Planned IE machine
types must not be presented as physical machine assignments.

The 6B audit found an important legacy split: the main `/scan` path stores the
piece barcode, physical machine and operator session but leaves `activeOps`
empty; the separate mark-as-done path writes operation-code snapshots. Chunk 6B
preserves both paths exactly. Chunk 8/9 must resolve this ingestion contract
before claiming end-to-end IE traceability.

## Chunk 6B — frozen machine requirements and compatibility (accepted 10 September 2026)

New or explicitly replaced bulletin rows now freeze the operation's configured
machine-type requirements and operation revision. Unrelated bulletin edits
preserve that evidence byte-for-byte. Rows authored before the freeze retain an
explicitly unprovable state; no current library value is backfilled or presented
as historical truth.

Line-layout stations may plan machine types and quantities without naming a
physical machine. Compatibility is calculated by the server from the frozen
row evidence and the station plan. `UNKNOWN` is retained for unprovable or
unconfigured requirements and absent station plans; missing types or short
planned quantities are `INCOMPATIBLE`; configured no-machine work and satisfied
plans are `COMPATIBLE`. Readiness gaps name the affected rows and stations.

Requirement evidence joins the source fingerprint while retaining the exact
legacy fingerprint shape for layouts with no frozen evidence. Existing layouts
therefore remain current/readable without migration, while genuinely changed
evidence supersedes a new layout and never rebases the old one. The response
states the Production connection as `UNKNOWN` until Chunk 8 freezes stable IE
provenance beside the operation-code compatibility key.

Codex independently ran the two focused suites at **28/28** and the complete IE
backend suite at **500/500** across 18 suites. Templates were correctly deferred
to Chunk 6C. No Production scanner/model, frontend, migration, backfill,
physical-machine assignment, employee data, availability, capacity, approval or
release behavior changed.

## Chunk 6B frontend — planned machine types and compatibility (accepted 10 September 2026)

The existing Line Planning workspace now lets an IE editor state each station's
planned machine types and quantities, while a viewer sees the same facts without
write controls. The plan travels on every station update with only type and
quantity; no physical-machine, serial, operator, shift, availability, barcode or
client-computed verdict can leave the browser.

Per-assignment and layout-level compatibility are rendered only from the
server's `COMPATIBLE`, `INCOMPATIBLE` and `UNKNOWN` answers. Unknown evidence is
said explicitly and is never presented as a green or zero result. All new
readiness gaps remain fully visible, and the Production panel states that stable
scan traceability is not yet established.

The UI follows the shared Accounting/Chrome Under Frost presentation language
without importing Accounting business behavior. Codex independently ran the
focused suite at **48/48** and the complete IE frontend suite at **718/718**.
The application compiled successfully; static generation remains blocked by
the previously recorded unrelated Accounting `useSearchParams` boundary. The
stale development process on port 3001 requires a restart before this route can
be judged live.

## Chunk 6C backend — reusable line templates (accepted 10 September 2026)

IE now owns company-scoped reusable line templates captured from existing line
layouts. A template carries station order, labels, notes, planned machine types
and reusable operation slots identified by stable operation id plus deterministic
source-order occurrence. It carries no bulletin row id, layout station id,
source fingerprint, calculated balance, compatibility verdict or Production
allocation.

Templates may be listed, read, edited with optimistic revision control, retired
and restored without hard deletion. Applying an active template to a current
layout resolves every slot against that layout's frozen source, refuses a
partial fit atomically, leaves extra source rows unassigned, mints fresh station
identities and recalculates balance, compatibility and readiness through the
existing layout publisher. The layout trail stores the applied template id and
revision structurally, so reused names remain distinguishable.

Template edits prove every slot operation against the acting company's IE
library, and oversized metadata is refused rather than truncated. Concurrent
applications have one winner under the layout revision check; a stale no-op is
still a conflict. Codex independently ran the focused suite at **52/52** and the
complete IE backend suite at **552/552**. No migration, backfill, Production,
barcode, scanner, physical-machine, availability, capacity, approval or release
behavior changed.

**Live historical coverage remains 0 of 95 operational orders.** That is
expected: no backfill is approved and the 147 existing work orders predate the
canonical link. It is a fact about the DATA and does not block the frontend.

**No historical backfill is approved by this acceptance.** Chunk 1D is a
write-path change for new orders; what to do about the existing unlinked records
is a separate decision that has not been taken.

## Chunk 6A frontend — Line Planning (accepted 10 September 2026)

The existing Line Planning destination now opens from a style's Engineering
File and implements the accepted Chunk 6A line-layout contract. It keeps the
requested URL separate from the accepted file, company and layout; a dirty
station arrangement must be explicitly discarded before any target moves, and
no request is started for the pending target. Cancelling restores the complete
accepted URL context.

The workspace supports station creation, ordering, row assignment, server-owned
balance figures, readiness gaps, current and superseded layouts, optimistic
revision conflicts and the editor/viewer boundary. A source-change refusal
leaves the arrangement readable but permanently freezes that loaded record even
after its message is dismissed. Browser unloads and all same-tab IE navigation
are guarded while dirty; the Engineering File entry uses one specialised prompt
rather than two overlapping guards.

The presentation follows the Accounting/Chrome Under Frost system without
importing Accounting business logic. Codex independently ran the focused suite
at **135/135** and the complete IE frontend suite at **670/670** across 128
suites. Lane B reported successful compilation; the running development server
needs a clean restart after its build cache was replaced during verification.
No backend, Production assignment, availability, capacity, approval, release or
template behaviour changed.

## Chunk 3A — Style Engineering File and draft bulletin (accepted 9 September 2026)

The backend creates one company-scoped IE file idempotently from the exact
approved R&D technical revision and exposes one editable DRAFT operation
bulletin. Rows have server-minted stable identities and server-captured operation
snapshots; unchanged rows retain those snapshots even if the operation library
later changes. New and explicitly replaced operations capture the library's
current revision. Proposed SAM is nullable and totals are deterministic.

Whole-bulletin PATCH uses `expectedRevision`, one atomic document update and an
embedded bounded history. A normalised no-op returns `updated:false` with no
write, revision bump or event; a stale no-op is still a revision conflict.
Retired operations remain readable and raise a typed readiness gap. The focused
review suite passed **37/37** independently; the reported complete IE backend
suite passed **315/315**.

No approval, release, method study, migration, backfill or frontend was added
by Chunk 3A. Its next bounded slice, Chunk 3B, is recorded below.

## Chunk 3B — Style Engineering File frontend (accepted 9 September 2026)

The order-first IE frontend now opens the Style Engineering File from a style
inside its production order and supports the complete accepted Chunk 3A DRAFT
bulletin workflow. It uses the Accounting/Chrome Under Frost visual system,
keeps the frozen R&D route separate from the IE bulletin, exposes readiness and
history honestly, and adds no top-level Styles destination.

The final review accepted the write-safety corrections: missing rows cannot be
converted into an empty bulletin; save/reload freezes local editing; all
file-scoped state resets across order, style and company changes; every stale
async answer is a complete no-op; field errors cannot migrate after row edits;
history refreshes after real changes; and unsaved work is guarded for browser
and in-app navigation. The complete IE frontend suite passed **285/285** in the
independent review.

The production build compiles IE successfully but the repository build remains
blocked during static generation by the unrelated Accounting page
`/accountant/budgets/item-usage`, which lacks a Suspense boundary around
`useSearchParams`. The next IE task is a bounded Chunk 4 backend contract.

## Chunk 1D — canonical order-to-style linkage (implemented, awaiting review)

**Not accepted. Awaiting Codex review.**

`WorkOrder.sampleStyleId` — nullable ObjectId, `ref: "SampleStyle"`, sparse
index, no default. It lives on the WORK ORDER because that is the record whose
question it answers, it is known at the moment the order is built, and it is one
value rather than an array appended from the other end.
`SampleStyle.production.workOrderIds[]` stays as a legacy compatibility
reference and is **not** the authority — two writers on opposite ends of one
relationship drift.

**Source rule.** The value comes only from (1) the exact `CustomerRequest`
item line being converted, or (2) the exact source work order for a split,
replacement, return or remake. A sampling request's request-level
`sampleStyleId` counts only when the request has at most one line — the identical
rule the accepted IE read resolver already applies, so write and read agree by
construction. Never from stock item alone, product name, variant similarity,
customer, enquiry or journey text, the first style found, or a reverse reference
created after the order.

**Refusals** (typed, registered in `services/storePurchase/errors.js`):
`WORK_ORDER_STYLE_LINK_REQUIRED`, `WORK_ORDER_STYLE_LINK_AMBIGUOUS`,
`WORK_ORDER_STYLE_NOT_FOUND`, `WORK_ORDER_STYLE_OWNERSHIP_UNPROVEN`,
`WORK_ORDER_STYLE_COMPANY_MISMATCH`.

**Atomicity.** The Sales release path creates work orders in a loop with no
transaction, so every style is proved in a PRE-FLIGHT before the first write. A
batch that cannot prove every line creates no work order, no progress row, no
reverse link and no notification.

**Writers covered:** `createWorkOrdersAndProgress` and
`createWorkOrderForVariant` (exact request line, refuse); the work-order split
(inherits from its source); both return/remake writers (inherit from the exact
source work order named on the returned units).

**Live audit after implementation:** 0 canonical links across 147 work orders,
0 of 95 operational orders visible, verdict unchanged at
`NOT_READY_FOR_ORDER_WISE_FRONTEND`. Expected: no historical record was touched,
so the register reads exactly as before. The figures move when new orders are
released.

**Chunk 1E (frontend) had not started at the time of this entry.** *(Superseded history — Chunk 1E started 8 September 2026; see the current-status table at the top.)*

## Chunk 1E — the IE frontend (accepted 9 September 2026)

**Started 8 September 2026. Accepted after functional and presentation review
on 9 September 2026.**

Frontend development is **authorised independently of historical backfill**. The
corrected Chunk 1D linkage path exists for newly created orders, so the shell can
be built and used; the existing 147 work orders predate the canonical link and
**may legitimately produce an empty register**. No historical migration or
backfill is approved, and the empty state says so truthfully without claiming the
factory has no production orders.

**Where it lives:** `grav-cms` (the frontend repo), route `/industrial-engineering`,
gated on the `ie` department grant through the shared `FrostShell` guard. It is a
department application, not a designation app, and reuses no Production
Supervisor screen.

**Navigation, in the approved order:** Orders · Operations · Line Planning ·
Capacity · Reports · IE Settings. Orders is the landing page. There is no
Overview, no My Work and no top-level Styles page — a style is reached only by
opening an order, and a test asserts all three routes do not exist. The four
unbuilt sections are shown as clearly labelled planned destinations that state
what they will hold and that they read nothing.

**Built screens:** the Orders register (`GET /api/cms/ie/orders`, server cursor
paging, no invented search or filter) and the opened order
(`GET /api/cms/ie/orders/:orderId` — summary, linked styles, both route sources
shown separately with the comparison state, ordered operations and SAM, typed
gaps with owner and action, lifecycle warnings, honest line-planning
availability, `Read only`). The operation library
(`GET /api/cms/ie/operations`) renders the server's own scope limitation and
marks duplicate codes ambiguous without picking a canonical one.

**No mutation controls anywhere**, asserted by test. The API client cannot
express POST/PUT/PATCH/DELETE at all.

**Final review:** Lane A's Strict Mode-safe company selection and Lane B's
Accounting/Chrome Under Frost presentation layer coexist without overlap. The
combined shell, API, rendering, company-context, presentation and access suite
passed **138/138**. The accepted UI remains order-first, read-only and honest
about the unlinked historical data.

### Chunk 1D — final review corrections (8 September 2026)

Three blockers, all fixed. **Chunk 1D remains implemented and awaiting Codex
review; it is not accepted.**

**1 — Derivative resolution examines all stored evidence.** `styleForDerivative`
loaded legacy references only for sources lacking a canonical field, so a source
with canonical A *and* a reverse or request-line reference to B read as
undisputed because B was never loaded. Now every source is resolved with all
three evidence sources — canonical `WorkOrder.sampleStyleId`, reverse
`SampleStyle.production.workOrderIds[]`, and the exact CustomerRequest line
(including the accepted single-line sampling fallback) — through the shared
`resolveOrderStyleLink`. Each source must yield exactly one attached style,
`ONE_COMPANY` attribution, no conflict, no ambiguity, no unprovable candidate,
and a company equal to the acting company. Several sources must independently
pass and agree. A canonical field is stronger provenance; it may not hide
contradictory stored evidence. No source is mutated or backfilled.

**2 — Department authority, separate from membership.** The shared membership
service provides identity and company scope, explicitly not capability, so it is
no longer treated as permission to mutate. Each writer now carries the
established authority for its act, and neither check substitutes for the other:

| Writer | Department authority | Where it comes from |
|---|---|---|
| Sales approval | `departmentWrites("sales")` | already at the server.js mount (`salesWrites("quotation")`); the earlier test mounted the router bare, which is what let a `Tech` employee approve |
| Internal-order release | `departmentWrites("sales")` | same mount |
| Add-variant creation | `departmentWrites("sales")` | same mount |
| WorkOrder split | `departmentWrites("project-manager")` + admin bypass | the file's own `cancellationGuard`, aliased as `splitGuard` — creating a work order is governed like altering one |
| Person-wise return/remake | `departmentWrites("project-manager")` + admin bypass | new `returnProductionGuard`, route-level so Store's and QC's endpoints on the same router are untouched |
| Bulk return/remake | same | same |

`project-manager` owns the two Manufacturing writers because creating or
altering a work order is the Project Manager's everywhere else in Manufacturing
(`pmOwnedWrite` on the manufacturing-order routes, the work-order cancellation
guard). Store owns the earlier steps of a return; creating the MO is a
production act. Both guards fail open until an administrator grants the first
role, and both use the codebase's own mechanism rather than a new role system.
The admin bypass is the existing contract, copied, not invented.

**3 — Genuine route-level coverage for all six writers.** The previous file
claimed six-writer coverage while mounting only the Sales and IE routers and
exercising one writer. `test/industrial-engineering/ie-chunk-1d-writers.route.test.js`
now mounts the Sales router **behind its department guard exactly as server.js
does**, plus the WorkOrder and return/remake routers, and drives all six writers
through their real handlers: authorised success with the exact stored
`sampleStyleId`, unauthorised-department refusal, non-member refusal, typed
refusals for unresolved/ambiguous/foreign evidence, refusal before any related
record, a safe 500 for an unexpected fault, and `sampleStyleId: null` nowhere.

**Live audit unchanged:** 0 canonical links across 147 work orders, 0 of 95
operational orders visible, verdict `NOT_READY_FOR_ORDER_WISE_FRONTEND`. The
field is genuinely ABSENT on all 147 (0 explicit nulls, 0 ObjectIds) — no
backfill is approved and no historical record was touched.

**Chunk 1E (frontend) had not started at the time of this entry.** *(Superseded history — Chunk 1E started 8 September 2026; see the current-status table at the top.)*

### Chunk 1D review corrections (8 September 2026)

Five contract failures found by Codex, all fixed. **Chunk 1D remains
implemented and awaiting review; it is not accepted.**

1. **Absence never inherits.** Split and return/remake paths could create a work
   order with `sampleStyleId: null` when their source was legacy. Removed. A
   derivative now takes its source's canonical link, or — for a legacy source —
   resolves it through the accepted shared resolver over that source's own
   stored references, and is **refused** when that cannot produce one
   undisputed, company-provable style. Several sources feeding one remake must
   agree. The source record is read, never written to.
2. **Typed errors survive the HTTP boundary.** Linkage and company refusals
   reached callers as generic 500s. Every affected route now returns the
   registered status and `code` with its actionable message; anything
   unexpected is still a 500 with no detail.
3. **The acting company is enforced.** The Sales release routes had no company
   context at all. They now resolve it through the shared membership service —
   the same one the IE boundary, Store and Central Costing use — and pass it as
   `expectedCompanyId`. A non-member is refused, a multi-company actor must
   choose, and a style outside the acting company is refused non-disclosingly.
4. **Canonical never overrules contradictory evidence.** `resolveOrderStyleLink`
   excluded ambiguous line candidates from its comparison, so a canonical style
   could be attached while the request lines disagreed. Canonical is now
   compared against every named ambiguous candidate: a disagreement is
   `REFERENCES_CONFLICT` with no style attached; an unnamed matching line keeps
   the ambiguity and attaches nothing.
5. **No fabricated default.** `default: null` is gone. Legacy documents keep the
   field genuinely absent — proved by a test that re-saves an unrelated field
   and asserts the key still does not exist — and every live writer stores a
   real ObjectId or refuses.

**Route-level coverage.** Helper tests are no longer counted as proof: the main
Sales release, internal-order release, add-variant, split and both remake paths
are now driven through their real routes and the stored document read back.

**Live audit after the corrections is unchanged:** 0 canonical links across 147
work orders, 0 of 95 operational orders visible, verdict
`NOT_READY_FOR_ORDER_WISE_FRONTEND`. No backfill is approved and no historical
record was touched.

**Chunk 1E (frontend) had not started at the time of this entry.** *(Superseded history — Chunk 1E started 8 September 2026; see the current-status table at the top.)*

## Lane A — status-independent style ownership — ACCEPTED 8 September 2026

**Approved product decision, 8 September 2026:**

> Company ownership is permanent record provenance. Lifecycle status controls
> queue participation, not ownership. IE order history therefore retains
> company-proven completed, cancelled and inactive styles, while active
> Merchandising queues may exclude them.

Implemented by having the IE order boundary pass the ownership rule's existing
`activeOnly: false` mode — parentage alone. No new ownership implementation was
written; the endpoint and the audit share one. Merchandising's callers pass
nothing and are unchanged, which
`test/industrial-engineering/ie-lane-a-lifecycle.test.js` asserts directly
against `styleOwnershipClause`.

Each linked style now publishes an allowlisted lifecycle block —
`lifecycleStatus`, `recordActive`, `historical`, `warnings[]` — and the order row
carries `historicalStyles`. Warnings are typed and raised only where the
contradiction is live: `CANCELLED_STYLE_ON_ACTIVE_ORDER` and
`INACTIVE_STYLE_ON_ACTIVE_ORDER`, both only while the order is open. A completed
style raises none, ever.

Live effect: styles with provable ownership 25 → 34; attributable work orders
**1 → 6, so Lane A recovered five orders**. Seven orders have agreeing direct and
order-line references; six are attributable after Lane A, and the seventh is
still refused because its style has no provable company parentage — a separate
fault Lane A deliberately left alone. Operational visibility unchanged at 0 of
95, so the audit verdict remains `NOT_READY_FOR_ORDER_WISE_FRONTEND`. Nothing
was migrated or backfilled.

## Chunk 1C — production-data readiness audit — ACCEPTED 8 September 2026

Read-only audit of the real database, run 8 September 2026 against
`NODE_ENV=development`, database `test`.

**Verdict: `NOT_READY_FOR_ORDER_WISE_FRONTEND`.** 0 of 95 operational work
orders (0.00%) can be displayed by the accepted Chunk 1B boundary. All 6
attributable orders are `completed`.

The boundary is not at fault — there are no conflicts, no ambiguities and no
cross-company attributions in the data. The links simply do not exist: exactly
one CustomerRequest carries an item-level `sampleStyleId`, 7 carry a
request-level one, and 7 of the 13 direct `production.workOrderIds[]` references
point at work orders that are not in the collection.

Nothing was mutated, no field added and no migration written. Six decisions are
raised for review in the audit document; the first — carrying the request line's
style onto the work order at CREATION — is the smallest change that makes future
orders visible, and it is a write-path decision rather than a backfill.

Artefacts: `scripts/audits/ie-order-readiness-audit.js` (read-only, rerunnable),
`services/industrialEngineering/ieOrderAudit.js` (pure classifier reusing the
accepted `resolveOrderLine`), `test/industrial-engineering/ie-order-audit.test.js`.

## Navigation decision — 8 September 2026

Final, and it changes what Chunk 1 builds:

- **IE is department-based and works order-wise.** The landing page is
  **Orders**, not Overview, My Work or Styles.
- **Styles remain engineering units inside an order.** They are reached by
  opening an order; there is no top-level Styles destination.
- **Overview and My Work will not be built.** Neither is scheduled, and neither
  should be re-proposed without its own decision record — see
  `docs/product/industrial-engineering-app-plan.md` §7.0.
- **Eventual navigation:** Orders, Operations, Line Planning, Capacity, Reports,
  IE Settings.
- **The Chunk 1A style endpoints stay** as reusable internal read APIs. The
  order detail composes the same projection and links out to
  `GET /api/cms/ie/styles/:styleId`; they are no longer a navigation surface.
- **No frontend until the order boundary is reviewed.**
- **The company-scoped operation-master migration has not begun** and is still
  Chunk 2.

## Chunk 1B implementation scope — ACCEPTED 8 September 2026

Read-only, order-wise IE backend only.

```text
GET /api/cms/ie/orders
GET /api/cms/ie/orders/:orderId
```

The canonical IE order is **`WorkOrder`** — the record production is authorised,
planned and scheduled from. `CustomerRequest`, which the Project Manager's
screens label "Manufacturing Order", is a CUSTOMER order carrying customer
identity, quotations, quotation prices, payment receipts and uploaded purchase
orders; it is read only as an internal join hop to `items[].sampleStyleId` and
nothing on it, not even its id, is published.

Order-to-style is proved through two ORDER-SPECIFIC stored references only:

1. `SampleStyle.production.workOrderIds[]` names the work order — the style
   names this order, so it is order-specific by construction.
2. The lines of the work order's customer request whose `stockItemId` is the
   work order's own resolve to exactly one style.

Rule 2 replaced an earlier request-level reading that attached every style on a
request to every work order under it. That was invalid: the generator emits one
work order per request line per variant, so sharing a request proves the records
were raised together and nothing more.

**Which identifiers can and cannot narrow a request line** — all four were
inspected:

| Identifier | Verdict |
|---|---|
| request line `_id` | does not exist — `requestItemSchema` is `{ _id: false }` |
| `WorkOrder.variantId` | unusable — it stores the STOCK ITEM variant's `_id`, which is common to every line naming that product; and a `stockItem.variants[0]` fallback in the generator can give two orders the same value |
| `variantAttributes` | copied from the request variant, falling back to the product's — same failure, and free text |
| `WorkOrder.stockItemId` vs `items[].stockItemId` | **the only usable line discriminator**, and insufficient alone when two lines name one product |

So a StockItem match alone is not accepted as proof: two lines sharing a product
resolve to `STYLE_LINK_AMBIGUOUS` and nothing is attached. Zero matching lines,
or a single matching line naming no style, is `STYLE_LINK_UNRESOLVED`. The
request's own top-level `sampleStyleId` is used only when the request has at
most one line, where there is no "which order" question to answer.

The product (`WorkOrder.stockItemId` → styles sharing that finished good) is
one-to-many by construction and attaches nothing. The candidate COUNT it used to
publish has been removed entirely rather than company-scoped: it tallied styles
across every company sharing a product, so it moved when a tenant the caller
cannot see added a style. `styleLinkState` replaces it — a state, not a count of
records the caller may not see.

**Company admission is order-specific.** A work order is admitted for a company
when a style of that company names it directly, or when EVERY style its own
candidate lines resolve to belongs to that company. A request holding two
companies' lines therefore exposes neither company's order to the other.

**Open compatibility finding.** Neither `WorkOrder` nor `CustomerRequest`,
`Customer` or `StockItem` carries a `companyId`. An order is therefore
company-provable only through an order-specific style link, and these work
orders must remain invisible to everyone until the data can prove them:

- a work order no style names, whose customer request has no line matching its
  product;
- one whose own matching line carries no `sampleStyleId`;
- one whose matching lines resolve to styles in more than one company, or to a
  style that cannot itself be attributed;
- a work order with no `customerRequestId` and no naming style at all.

An order whose candidate lines are ambiguous BETWEEN styles that all belong to
one company is still visible to that company — whichever line it is, it is
theirs — with `STYLE_LINK_AMBIGUOUS` and no style attached.

That is a fail-closed refusal, published in the module's own limitations. The
smallest compatibility adapter — a stored order-line identifier on the work
order (the request line has no `_id` to name), or a company stamp on the
production order — is proposed for review and **not** implemented here; no
migration or backfill has been performed.

No separate `GET /orders/:orderId/styles` endpoint was added: a work order names
one product and a handful of styles at most, so the styles are returned inline.

## Objective

Establish IE as a department application without changing live route, SAM,
work-order, schedule, costing or barcode behavior.

## Approved outcomes

- IE and PPC are separate applications.
- Applications represent departments/responsibilities, not designations.
- Production Manager and Production Supervisor remain roles inside Production.
- IE owns operation standards, style bulletins, SAM, method studies, standard
  machine/manpower requirements, line balancing, capacity standards and
  standard targets.
- PPC owns order loading, capacity booking and schedules.
- Production owns actual execution and assignments.

## Chunk 0 deliverables

- [x] IE product and architecture plan.
- [x] Approved ADR separating IE and PPC.
- [x] Current writer/reader and ownership audit.
- [x] Existing frontend surface inventory.
- [x] Initial canonical record proposal.
- [x] Migration hazards and safety gates.
- [x] Sequential implementation roadmap.
- [ ] Runtime data report for duplicate operations, route divergence and
  unprovable ownership. This needs a safe database-backed dry run in the target
  environment; no production data access is assumed by this documentation pass.

## Chunk 1A implementation scope

Build the read-only IE backend boundary only.

### Endpoints

```text
GET /api/cms/ie/styles
GET /api/cms/ie/styles/:styleId
GET /api/cms/ie/operations
```

### Required behavior

1. Install employee authentication and an `ie` department capability guard.
2. Resolve company from authenticated membership, never request-body scope.
3. Return not-found for foreign and unprovable style IDs.
4. Build every response from an explicit allowlist.
5. Publish style identity, R&D technical status, route readiness, safe source
   labels, operation count, calculated SAM and typed gaps.
6. Where both technical and product routes exist, publish them separately and
   calculate a comparison state:
   - `MATCHED`;
   - `DIFFERENT_SEQUENCE`;
   - `DIFFERENT_TIME`;
   - `DIFFERENT_OPERATIONS`;
   - `ONLY_TECHNICAL_ROUTE`;
   - `ONLY_PRODUCT_ROUTE`;
   - `NO_ROUTE`;
   - `AMBIGUOUS`.
7. Do not select one conflicting route as authoritative during this chunk.
8. Publish operation-master ambiguity and company-scope limitations honestly.
9. Include no write endpoints and no frontend Save affordance.
10. Do not mutate or backfill any source record on read.

### Response exclusions

No endpoint may publish:

- Sales Journey or enquiry identifiers;
- customer or buyer names;
- supplier identities or rates;
- operator salary, average salary or labour cost;
- costing amounts, margin or selling price;
- full SampleStyle, StockItem or WorkOrder documents;
- another company's existence through a forbidden/not-found distinction.

### Reuse

Reuse or extract behavior from:

- `services/production/styleRoute.service.js` for ownership proof, style
  allowlisting, row projection and SAM calculation;
- `services/companyContext/companyMembership.service.js` for company context;
- `services/departmentRoles.js` for role evaluation;
- existing Central Costing and production style-route tests for non-disclosure
  and field refusal conventions.

Do not rename the existing Production route or change its payload in this
chunk. The new IE read service may compose shared pure helpers, but compatibility
must be proven.

### Tests required

- unauthenticated request is refused;
- employee without IE access is refused;
- IE viewer may read but no IE write route exists;
- company is server-resolved;
- same-company style is listed and readable;
- foreign and unprovable style IDs are indistinguishable from absent IDs;
- no Sales/customer/financial fields leave any response;
- empty route remains missing, not zero/complete;
- total SAM is deterministic and derived from row times;
- duplicate master code produces `AMBIGUOUS` rather than last-write-wins;
- technical/product route agreement and every divergence state are covered;
- a read causes no model save/update call;
- existing `/api/cms/production/style-route` contract tests remain green;
- current Central Costing technical import and frozen-version tests remain
  green.

### Out of scope

- IE frontend shell;
- operation-master migration or company backfill;
- Style Engineering File model;
- route/SAM editing;
- method study;
- approvals and releases;
- line layout and balance;
- capacity calculation;
- PPC or Production route changes;
- WorkOrder operation migration;
- legacy endpoint redirects or deletion.

## Acceptance

Chunk 1A is accepted when an IE viewer can retrieve a truthful company-scoped
inventory of styles, operation masters and route conflicts through narrow APIs,
while all existing manufacturing and costing behavior remains unchanged.

## Sources

- `docs/product/industrial-engineering-app-plan.md`
- `docs/audits/industrial-engineering-chunk-00-boundary.md`
- `docs/decisions/architecture-decisions.md` — ADR-003
- `docs/product/garment-manufacturer-app-architecture.md`
