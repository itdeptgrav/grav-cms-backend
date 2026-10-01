# PROCUREMENT RELEASE MOVES TO THE CONFIRMED ORDER (9 Sep 2026)

> A dedicated note. `docs/handoff/latest-implementation.md` and
> `docs/tasks/current-task.md` were both being written by other lanes at the
> time of this work, so nothing here was added to either.

**Status: implemented — backend only, awaiting review. Nothing committed.**

## The gap this closes

An approved costing says a **price may be quoted**. It does not say the company
has an order.

Until now the only way to raise purchasing demand was a button in the Costing
app, whose sole precondition was that the costing had an approved version. It
could not see whether a customer had confirmed anything, could not check that
the ordered quantity was one the costing was approved for, and could not tell an
order line from a style. So it could raise demand for an enquiry nobody ordered.

Costing **approval** never had a procurement side effect — `lifecycle.service.js`
has never referenced the handoff, spend requests or reservations, and the suite
now asserts that by scanning the file. What existed was a manual control in the
wrong app, and that is what moved.

## The authoritative confirmed-order event

`services/sales/merchandisingHandover.service.js` already defines commercial
confirmation and exports it:

```
CONFIRMED_STATUSES = quotation_sales_approved, production, shipping,
                     delivered, completed
```

`quotation_customer_approved` is **not** confirmation — it still awaits Sales'
own sign-off. The release imports that list rather than restating it, so there
is one definition.

## Ownership

| Act | Owner |
|---|---|
| Confirm the customer order | Sales |
| Release approved demand | **Merchandising** |
| Source and purchase | Store / Procurement |

Capability `procurement.demand.release`, added to the existing Merchandising
ladder at **approver** and **owner**. `viewer` and `editor` do not hold it — an
editor states requirements; releasing them is a commitment to spend.

**No Sales rank holds it at any level**, asserted directly. Confirming an order
and committing the company's money against it are different acts.

It is named outside the `merchandising.*` family on purpose: what it authorises
happens in procurement, and somebody auditing who can create purchasing demand
should find it by that name.

### On platform administrators

The brief asked for administrators to hold it. `access.service.js` deliberately
refuses `isAdmin` as a rung — at length, and for good reasons: it is a token
claim, invisible in Access Control, and unrevokable by removing a Merchandising
grant. Rather than punch a hole through that, an administrator holds this the
same way anybody does: by being granted an explicit, visible, revocable
`merchandiser` approver role. That satisfies the intent without reintroducing a
documented bypass.

## The five preconditions

1. `CustomerRequest.status` ∈ `CONFIRMED_STATUSES`
2. the line's own permanent `lineRef`, its chosen style, and a positive
   `totalQuantity`
3. the technical revision frozen on the approved costing version, with **both**
   gates (`bomApprovalStatus`, `sampleStatus`) recorded as approved
4. the named `costingVersionId` is `APPROVED`, floor-priced, and is the one the
   quotation line was actually priced from
5. company proved through the style's journey/enquiry chain; style, line and
   quantity all matched

## The quantity rule

The ordered quantity **must equal a scenario quantity frozen on the approved
costing**. Where it does not, the refusal is
`DEMAND_RELEASE_RECOST_REQUIRED`, naming the quantities that *were* approved.

Nothing is derived: not the nearest scenario, not consumption multiplied out,
not an interpolation. The engine freezes a purchase quantity per scenario rather
than deriving one, so a quantity with no scenario has no answer — and a purchase
quantity nobody approved is a purchase nobody approved.

## What it produces

Draft spend requests, through the existing `projectionHandoff` →
`costingDemand` authority. No purchase order, no supplier, no reservation, no
placed order. Every quantity is regenerated server-side from the frozen approved
version; nothing in the request body describes one.

## Idempotency and succession

`releaseKey` hashes six facts: company, order, `lineRef`, costing version,
frozen requirement revision, ordered quantity. A unique index on
`{companyId, releaseKey}` makes an exact retry lose to the database rather than
raise a second set of drafts — no bookkeeping row that can expire.

Any of the six changing is a **different** subject and produces a successor:
`supersedesReleaseId` forward, `supersededByReleaseId` back, the earlier row
flipped to `SUPERSEDED` with its own demand references **untouched**. Those
requests were really raised and somebody may already have bought against them.

## Three stored-vs-serialised paths found

Same family as the two corrected earlier in this domain:

| Read | Serialised name | Stored name |
|---|---|---|
| costing source | order line | **quotation line**, joined by `sampleStyleId` |
| frozen requirements | `cost.sourceReferences` | `sourceReferences` |
| order company | `companyId` field | proved via style → journey/enquiry |

A `CustomerRequest` carries no `companyId`; ownership is proved through
`technicalSource.ownershipProofFor`, the same helper the Sales producer and the
Merchandising scope use.

## Four corrections before acceptance

### 1 · Ownership is proved before any business fact

`subjectFor` checked status, line and costing source before proving the order
belonged to the caller's company — so a foreign order could answer
`ORDER_NOT_CONFIRMED` or `LINE_NOT_FOUND`. **Every one of those refusals
confirms the order exists.** Telling a stranger "that order is not confirmed
yet" tells them there is an order.

It now calls `merchandisingHandover.loadOwnedRequest` first, exposed read-only
for this purpose rather than reimplemented — a second copy of a tenancy rule is
a second boundary, and the weaker one answers. Foreign orders return `NOT_FOUND`
whatever is wrong with them, asserted across five different faults plus a
missing line, and the mirror test proves the same faults on the caller's OWN
order are still named.

### 2 · The exact frozen quotation source

A version that merely contains a scenario at the ordered quantity is not
enough: if the quotation was priced from a **different** scenario, releasing
against the matching one buys for a run size nobody quoted while every other
identity looks correct. That case has its own test.

Eleven checks, each with its own refusal reason: customer origin, style
agreement across order line / quotation line / provenance, `costingId`,
`costingVersionId`, `priceTier === "floor"`, provenance quantity, the named
`scenarioKey` present on the version, that scenario's quantity, a floor
subdocument on the version, the saved price equal to the approved floor, and
the canonical `approvedOutput.fingerprintOf` over the six identities.

The fingerprint test is non-vacuous by construction: a correct fingerprint is
stamped and proved to release before a corrupted one is refused.

### 3 · Superseded demand is not left actionable

Marking the old release `SUPERSEDED` did nothing to the requests it raised. If
those were live, Store held two sets of demand for one order line.

Before a successor, the prior release's spend requests are read through a new
narrow Requests-domain reader, `costingDemand.stateOfRequests` — which answers
from `ACTIVE_STATUSES`, the same list every other caller uses, so Merchandising
never holds a copy of that rule. Any active request refuses with
`DEMAND_RELEASE_RECONCILIATION_REQUIRED`, naming the open request numbers and
`remedy: CLOSE_IN_REQUESTS`.

**Merchandising cancels nothing.** Not automatically and not on request; a
request is closed through its own workflow by whoever owns it. Asserted: after
the refusal, the requests are exactly as they were.

### 4 · The partial-write gap

The order was: handoff creates requests → release row written. A process dying
between them left active requests, no release row, and a retry that raised a
**second** set.

The intent is now claimed as a `PENDING` row under the same unique key
**before** the handoff runs. A retry finds the claim, asks the handoff again —
which replays on the key derived from the same six release facts — and finishes
the row from work already done. The fault-injection test crashes the completion
write, proves one `PENDING` claim survives, then proves the retry returns
`RECOVERED`, names the **same** spend request ids, and leaves exactly one
current release.

## Five hardening corrections

### 1 · Complete source verification

A missing fingerprint was accepted — which made the one field that proves the
rest of the provenance optional, so anybody able to write the provenance could
omit it and the check would politely skip itself. It is now **required**.

Added beside it: the quotation line's actual stored `unitPrice` must equal
`costingSource.unitPriceMinor` (compared through `quotationPricing.toMajor`, so
the two never disagree about rounding), and the costing's base currency, the
provenance currency and the quotation currency must all agree.

The canonical `approvedOutput.supersessionFor` is now asked rather than
duplicated, and an unanswered check is **not** a pass — the same rule
`quotationPricing.verifyBeforeSend` applies.

### 2 · Recovery replays a frozen command

The mocked fault test reported requirements as selectable on every call. In
production they read as already spoken for once requests exist, so a recovery
that re-derived its selection would find nothing and refuse a release that had
in fact succeeded.

Selection now happens **before** the claim, while it still has an answer, and
the resolved requirement ids, scenario, purpose and idempotency key are frozen
onto the claim as `handoffCommand`. Recovery replays that command verbatim. No
selection logic runs on the recovery path.

`order-demand-release.integration.test.js` proves it against the real
projection, the real `SpendRequest` writes and the real handoff idempotency
record, on a replica set. It asserts the re-derived selection is genuinely
empty before replaying — so it cannot pass by accident.

**It found a real defect:** `spendRequestIds` was being stored **empty**,
because `createDraftsFromCosting` returns `{requestId, requestNumber}`
summaries rather than mongoose documents. The reconciliation guard would have
had nothing to account for.

### 3 · Every boundary recovers

Three faults are injected and each retry finishes the chain idempotently:
before the handoff, after it but before the demand ids are stamped, and after
the successor is RELEASED but before the predecessor is linked. The stamp is
conditioned on the row still being PENDING and the link on the pointer still
being empty, so a repeat completes rather than doubles.

### 4 · One active release per order line

The release key protects identical facts only: two concurrent successors with
different quantities or versions hash to two keys and both would claim. A
**partial unique index** over `{companyId, orderId, lineRef}` restricted to
PENDING and RELEASED makes the database enforce a single active slot.

The predecessor therefore has to leave that set before the successor may enter
it. **This was originally done as two statements — vacate, then claim — and
that was wrong.** See the correction below.

### 5 · Prior demand must be fully accounted for

`stateOfRequests` now returns three distinguishable answers: every reference
found and closed (`accounted: true`), some still active, or some **missing or
unreadable**. A read failure or a reference with no record can never report
`anyActive: false` — that would let a successor be raised over demand that may
still be open. Both refuse with `PRIOR_DEMAND_UNVERIFIABLE`.

## Correction: the replacement boundary

An earlier version of this note claimed that vacating the predecessor before
creating the successor's claim was safe, on the reasoning that no demand had
been raised yet, so an interruption merely left a line with no active release
for the next attempt to fill.

**That reasoning was wrong, and the ordering was unsafe.** Between the vacate
and the claim sat command resolution, which can refuse; a database write, which
can fail; and a process, which can stop. Any of the three left the predecessor
SUPERSEDED with no successor in existence. The next attempt then looked for a
RELEASED predecessor, found none, and wrote a successor with
`supersedesReleaseId: null`. The chain was gone, and nothing in the record said
it had ever existed.

The order is now:

1. Prove ownership, eligibility and the frozen quotation source.
2. Account for the predecessor's demand (`assertPriorSettled`).
3. **Resolve and validate the complete handoff command** — while selection is
   still answerable, and before any row moves.
4. **One transaction** (`replaceAtomically`): move that exact predecessor from
   RELEASED to SUPERSEDED, and insert the successor's PENDING claim carrying
   `supersedesReleaseId` and the frozen `handoffCommand`. Either both, or
   neither.
5. Outside the transaction, replay the frozen command through the existing
   idempotent handoff, then stamp the demand and write the back-pointer.

The handoff is deliberately **not** inside the transaction. The durable claim
must commit first; the Requests domain then runs on its own, and its
idempotency record is what makes a replay return the same requests rather than
a second set.

### The condition is the concurrency control

The vacate names the exact row *and* the exact state it was validated in. A
second replacement racing the first finds nothing to move and is refused with
`PRIOR_DEMAND_ACTIVE`, rather than superseding a row twice or raising a second
set of actionable demand. The partial unique index remains as the backstop for
the case the condition cannot see: two *first* releases, neither of which has a
predecessor to move.

### Fail closed where it cannot be guaranteed

A replacement asks `unitOfWork.transactionsAvailable()` — the repository's
existing probe, which proves the capability with a real write inside a
transaction rather than assuming it. A deployment that cannot give one is
refused with `MERCHANDISING_TRANSACTION_REQUIRED` (503) **before either row
moves**. Losing a release is recoverable; losing the chain is not. A first
release is a single insert and needs no transaction.

### What is not done

Rows already orphaned by the old ordering — SUPERSEDED with no successor
naming them — are left exactly as they are. No history is repaired or
discarded here. They are identifiable as `state: "SUPERSEDED"` with
`supersededByReleaseId: null` and no release naming them in
`supersedesReleaseId`.

### Proved by

`order-demand-release.test.js` now runs on a replica set, because the service
refuses a replacement it cannot make atomically. Seven tests hold the boundary:

- an unresolvable command, and a command with nothing selectable, each leave
  the predecessor RELEASED and create no successor;
- a failure injected between the two mutations rolls the vacate back — checked
  by mutation, since removing the session from that update makes this test
  fail;
- a crash after the swap commits leaves a SUPERSEDED predecessor and a linked
  PENDING successor, which a retry completes;
- a completed retry heals the link in both directions, and repeating it changes
  nothing;
- two concurrent different successors yield one active release, one demand set
  and exactly one call into the handoff;
- a deployment reporting no transaction support is refused before either row
  moves.

## Correction: recovery is by identity, not by today's facts

Two recovery guarantees were still incomplete after the atomic swap landed.

### 1 · A committed claim is found before any live source is read

`release()` ran the full `subjectFor` verification first, and only then looked
for an existing claim. Once a claim has committed the command has **started** —
requests may already exist under its idempotency key — so from that moment the
durable row, not the quotation, is the authority for finishing it. Verifying
live sources first meant a change to the order's status, its quantity, the
frozen quotation provenance or the current approved costing could refuse the
retry before it ever reached the claim. The half-run command could then be
finished by nobody, while its demand sat in Requests with no release row able to
account for it.

The order is now: capability, then the three identifiers, then a
**company-scoped** lookup for the active release on that exact order line.

| What the lookup finds | Answer |
|---|---|
| PENDING, same `costingVersionId` | replay its frozen command and complete it |
| RELEASED, same `costingVersionId` | report it from the durable record |
| PENDING, different version | refused — another release in progress |
| RELEASED, different version | a successor: full `subjectFor` verification |
| nothing | a new attempt: full `subjectFor` verification |

A completed exact retry is therefore answered from the release row. It does not
ask whether today's quotation still says the same thing: the demand was raised,
and re-deriving the answer could refuse to describe work that has already
happened.

Because the lookup is scoped to the caller's company, another company's release
is never seen. A stranger naming that order falls through to `subjectFor` and
gets the same NOT_FOUND, with the same message, as an order that does not exist
— "already in progress" would confirm both the order and the work.

Exact-version identity and the one-active-slot rule are untouched. A different
version is neither a recovery of the claim nor able to start its own, because
the line's one active slot is taken.

### 2 · The replay keeps the identity that started it

`replayCommand` built the handoff context from whoever pressed retry. The
handoff resolves the requester from `ctx.actorId` and stamps it onto every
Spend Request, so a colleague finishing an interrupted release authored the
purchase requests to themselves while `DemandRelease.releasedByActorId` still
named the initiator — two records disagreeing about who committed the company
to buy.

The claim already freezes `releasedByActorId` and `releasedByActorName`. The
replay now uses those. The retrying user must still hold
`procurement.demand.release`; holding it lets them finish the command, it does
not make them its author.

### Proved by

In the replica-set integration suite, against the real handoff and real Spend
Requests:

- a claim commits and raises real requests, the order is then moved to an
  unconfirmed status with a revised quantity and a broken provenance
  fingerprint — the test first asserts that a new attempt **would** now be
  refused, then that the exact retry still recovers, returns the same request
  ids, and creates no second claim;
- a colleague with the same grant retries a claim whose handoff had not run:
  the release completes, and every raised Spend Request plus the release row
  names the initiator, not the retrying user.

In the unit suite:

- a different version against the same PENDING line is refused, the claim's
  frozen command is unchanged, the handoff is never entered, and the rightful
  version still recovers it;
- a foreign company naming an order with an active claim gets the identical
  refusal — same code, same message, same reason — as one naming an id that
  does not exist, and neither leaks the claim;
- with no claim on the line, a broken fingerprint and an unconfirmed order are
  each still refused by name, so the short path is for recovery only.

Both corrections are mutation-checked: forcing the early lookup to find nothing,
and replaying under a non-frozen identity, each make the corresponding test
fail.

## The Execution File's own door

The release authority asks for three identities. The Execution File screen holds
none of them, and a browser that guessed, searched for, or asked somebody to
type one would be a way to release demand against the wrong order. So the
resolution happens on the server.

### The chain, and why each link is the one it is

| From | To | Why not the obvious alternative |
|---|---|---|
| `ExecutionFile.currentHandoverVersionId` | `SalesHandoverVersion.sourceRecord.recordId` — the CustomerRequest | `handoverRef` and `orderRef` are Sales' display string for the order, not an identity |
| `ExecutionFile.handoverLineRef` | the order line | immutable on the file, stamped from the line's own permanent `lineRef`; a style may sit on two commercial lines |
| that line's `sampleStyleId` | the quotation line | `pricedLineFor`, the authority's own joiner, which accepts only `APPROVED_COSTING` |
| the quotation line's `costingSource` | the exact approved costing version | never "the latest": a newer approved version the quotation was never restamped onto is not what the customer was priced from |

Nothing is chosen. Where a link is missing the answer is a named blocker —
`HANDOVER_SOURCE_MISSING`, `ORDER_NOT_READABLE`, `ORDER_LINE_NOT_FOUND`,
`LINE_HAS_NO_STYLE`, `NO_APPROVED_COSTING_SOURCE` — because "this file cannot
release" is not something a merchandiser can act on and "the line this file was
opened for is no longer on the order" is.

### The routes

```
GET  /api/cms/merchandising/files/:fileId/demand-release
POST /api/cms/merchandising/files/:fileId/demand-release
```

The GET sits behind `file.read`, the POST behind `procurement.demand.release`,
which starts at Merchandising **approver**. Both go through the existing
Execution File ownership loader, so a malformed id, a missing file and another
company's file all answer the identical `NOT_FOUND`.

### The read

```json
{
  "eligible": true,
  "blocked": null,
  "subject": {
    "orderRef": "REQ-1042", "lineRef": "L-1", "styleRef": "SC-880",
    "productName": "Pique polo", "orderedQuantity": "500",
    "requirementRevision": "r2", "costingVersionNumber": 1
  },
  "current": null,
  "releases": [],
  "permitted": { "release": true },
  "expectedVersion": "9f2c…"
}
```

Every field is named by an allowlist rather than spread from the authority's
answer, so a cost, a markup or a supplier added upstream later cannot arrive
here by being carried along. There is no order id and no costing version id in
it: the browser never holds an internal identity.

### The command

```json
POST { "expectedVersion": "9f2c…" }
```

That is the entire body. No order, no line, no version, no quantity — nothing
the caller could get wrong or substitute.

`expectedVersion` is a SHA-256 over company, file, order, line and costing
version, truncated to 32 hex characters. It is opaque and cannot be reversed
into any of them, and because the company is inside it a handle minted in one
tenant cannot be replayed in another.

Its job is the window between reading the screen and pressing the button. If
Sales repriced the line onto a different approved costing in that window,
acting anyway would release demand against a version the person never saw. So a
mismatch is refused with `DEMAND_RELEASE_VERSION_CHANGED` (409), and the refusal
carries the **current** handle so the screen can re-read and the person can
decide again, deliberately. A missing handle is
`DEMAND_RELEASE_EXPECTED_VERSION_REQUIRED` (400). Neither writes anything.

The response is the read shape plus `outcome`, `releaseId` and
`supersededReleaseId`.

### What this layer does not do

It holds no business rule. Eligibility, provenance verification, order
ownership, active-claim recovery, idempotency, concurrency and the release
itself all stay in `orderDemandRelease.service.js`. A test asserts the file
service mentions none of that vocabulary and that it delegates instead.

The identity-addressed `GET`/`POST /demand-release` pair still works and is not
removed. No frontend caller should be added to it now that the file-scoped
contract exists.

### A defect this found

`releaseCtx` in the Execution router called `liveMerchandisingRole`, which was
never imported. **Both identity-addressed demand-release routes returned 500 on
every call** and had done since they were added; they were only ever exercised
at service level, so nothing caught it. The import is fixed and the routes are
now covered by a route test.

### Proved by

`file-demand-release.route.test.js`, over HTTP on a replica set: the file
resolves the exact order line and frozen version; a newer approved version does
not become the answer; a line never priced from an approved costing is a named
blocker; the read writes nothing and contains no cost, markup, supplier, rate,
policy value or internal id; the release enters the authority exactly once with
the file-resolved identities; a missing and a stale handle are each refused
without writing; an interrupted claim recovers through the file route; foreign,
missing and malformed files are indistinguishable; viewer and editor are
refused while approver and owner may act; no Sales rank holds the grant; and a
source scan proves only the two routes reach the authority.

`order-demand-release.integration.test.js` runs the whole chain unstubbed — real
costing, real quotation provenance, real Sales handover, real acceptance — and
proves a release addressed by nothing but a file id and a handle raises genuine
DRAFT spend requests against exactly the resolved identities, leaves the file
untouched, and creates no second demand on retry.

## Correction: the wrapper must not re-gate the authority

The file-scoped wrapper resolved today's quotation before delegating, which
put back the exact gate the authority had just been reordered to remove.

The sequence that breaks: the screen reads version A and gets handle A; a
release commits a PENDING claim for A; Sales reprices the line onto B; the user
retries with handle A. The wrapper recomputed the handle from today's
quotation, got B, and answered `DEMAND_RELEASE_VERSION_CHANGED`. The committed
A claim never reached the authority's recovery-first path, and could stay
unfinished with its demand unaccounted for.

The read had the same fault more quietly. After a reprice it reported handle B,
and because `subjectFor` then refuses, `permitted.release` came back false — so
the screen could not even offer the retry that would resolve it.

### What changed

Resolution is now in two halves.

**The stable half** proves company ownership through the Execution File loader,
then reads only the order the file was opened from and the line's permanent
reference. No quotation, no costing version, no provenance. Those two
identities are enough to ask whether a command has already been started, which
has to be answerable even when today's provenance no longer verifies.

**The moving half** joins today's quotation, and is asked only for a genuinely
new attempt.

Between them, both entry points ask the authority for the durable release in
force:

```js
orderDemandRelease.activeReleaseFor(ctx, { orderId, lineRef })
```

a narrow read returning `releaseId`, `state`, `costingVersionId` and
`costingVersionNumber` — no frozen command, no demand references, no actor. It
shares one query builder with `release()` inside the authority, so "active"
cannot come to mean two things. The wrapper opens no query on `DemandRelease`
and writes nothing; a test asserts both.

| Situation | What happens |
|---|---|
| Claim in force, echoed handle names it | delegate on its **frozen** version; today's quotation is never read. PENDING recovers, RELEASED reports itself |
| Claim in force, handle names something else | today's quotation resolves and the authority decides — it refuses a different version taking a line that already has a claim |
| No claim in force | today's quotation resolves and the stale-handle check applies, unchanged |

The stale check did not go away. It moved behind the durable claim, which is
where it belongs: a handle that names neither the started command nor the
current price is a reader acting on a screen the world has moved past.

The read now also carries `recoverable`, naming the PENDING release when one
exists, and treats holding the grant as sufficient to offer that retry even
when today's sources would refuse a new attempt. Nothing else about the
response changed, and it still carries no cost, markup, supplier, rate, policy
value or internal identity.

The missing `liveMerchandisingRole` import stays fixed.

### Proved by

Five tests in `file-demand-release.route.test.js`, each over HTTP:

- a real PENDING version-A claim, a reprice onto B that breaks A's live
  provenance, and a direct assertion that a fresh A attempt **would** now fail
  verification — so the recovery beneath it is not passing by accident;
- the read then returns handle A, names the recoverable claim, and permits the
  release;
- posting handle A recovers the same claim, replays the same frozen requirement
  ids, keeps version A on the row, and leaves one release and one demand set;
- posting B's handle while A is PENDING is refused and leaves the claim byte
  for byte as it was, with handle A still finishing it afterwards;
- with no claim in force, a stale handle after a reprice is still
  `DEMAND_RELEASE_VERSION_CHANGED`, and another company can neither see nor
  finish the claim.

Mutation-checked: forcing the wrapper back to quotation-first fails three of
the five.

## Correction: a released predecessor is history, not a full stop

The durable-claim correction made the read take its handle from whichever
release was in force. That is right for PENDING and wrong for RELEASED.

Once version A was released and Sales repriced onto B, the read kept publishing
A's handle for ever. Pressing the button only ever answered `ALREADY_RELEASED`,
the browser could never obtain B's handle, and the successor flow already
implemented in `release()` was unreachable from the file.

`stateFor` compounded it. `eligible` was `Boolean(subject) && !current`, so any
released predecessor set `permitted.release` to false whatever the situation —
including a fully verified, reconciled successor waiting to be taken. Both the
identity-addressed and the file-scoped reads inherited that.

### The rule now

| Release in force | Handle the read publishes |
|---|---|
| PENDING | its own frozen version — dominant, and today's quotation is not read |
| RELEASED, quotation still on that version | the same version; the line reads as released and offers nothing |
| RELEASED, quotation moved on | the **new candidate's**, while the released row stays in `current` and `releases` |
| RELEASED, quotation no longer joinable | the released version, so a line with real demand against it is still reported |
| none | today's quotation, as before |

Nothing about PENDING changed. It still decides the handle outright, still
recovers without reading a live source, and still refuses to let another version
take the line.

### One reconciliation rule, asked by both

`assertPriorSettled` threw, so a read model could not consult it. The verdict is
now its own function:

```js
orderDemandRelease.priorDemandVerdict(ctx, prior)
  // → { ok, reason, message, details }
```

`assertPriorSettled` throws from it, and `stateFor` reads it. Three outcomes,
one of which allows a successor: every reference found and closed; some still
active (`PRIOR_DEMAND_ACTIVE`); or some missing or unreadable
(`PRIOR_DEMAND_UNVERIFIABLE`). The third is not "nothing is active" — it is not
knowing, and it fails closed.

No Requests status vocabulary appears in the wrapper or in the presentation.
`ACTIVE_STATUSES` stays where it is, in `costingDemand`, consulted through
`stateOfRequests` exactly as before.

`stateFor` also now returns `supersedes`, naming the release a successor would
replace when one is on offer.

### Everything else is preserved

Recovery before live sources for PENDING; exact-version handles; one active slot
per order line; the transaction-backed replacement; confidentiality; company
isolation; and no automatic release. Each still has its own test, and they all
still pass.

### Proved by

Seven tests in `file-demand-release.route.test.js`:

- released with the quotation still on A reads as released and offers nothing;
- repriced onto B with prior requests still open publishes B's handle, refuses
  with `PRIOR_DEMAND_ACTIVE`, and still presents the released row;
- one prior request missing fails closed with `PRIOR_DEMAND_UNVERIFIABLE`, and
  the test asserts it is distinct from the open answer;
- every prior request closed publishes B's handle with `permitted.release`
  true, and posting it creates exactly one successor linked to A in both
  directions, leaving one active slot;
- the old released handle still answers `ALREADY_RELEASED` and creates nothing;
- a PENDING claim still outranks the repriced quotation and still recovers;
- a viewer and an editor see the successor state but never get the control, and
  are refused if they post anyway.

Mutation-checked twice. Making RELEASED dominant again fails four of them;
restoring the old `permitted.release` expression fails two.

## End-to-end acceptance

`test/costing/acceptance-order-to-demand.test.js` follows ONE garment order the
whole way and asserts what comes out:

```
department records → costing preparation → frozen MARKUP_FLOOR_V2 version
  → Sales commercial review → confirmed order → Execution File
  → file-scoped demand release → DRAFT spend requests
```

### The arithmetic, on real engine output

A fabric rate of **₹407.81 per Metre**, quoted by Store on a supplier offer, is
the input. Everything else follows from it:

| | |
|---|---|
| true unit cost | **₹500.00** |
| markup | **20%** |
| markup amount | ₹100.00 |
| floor price | **₹600.00** |
| rounding uplift | 0 |

The rate is chosen so the answer lands on ₹500.00; the unit cost is the
engine's, and the suite asserts it rather than arranging it. The floor is
asserted **not** to be ₹625.00 — what a 20% *margin* would give — and the
scenario is asserted to carry no minimum, target, preferred or
`requestedMarginPercent` field.

### The trace, family by family

| Family | Owner | Authoritative record | Per garment |
|---|---|---|---|
| Materials | Store quotation · R&D consumption | `SupplierOffer`, `sample.consumptionRawItems` | ₹407.81 |
| Operations / labour | Production · Board | style operations, `LABOUR_METHODOLOGY` | ₹3.54 |
| Outside services | Production | `ServiceSupplierOffer` | ₹8.00 |
| Packaging | Merchandising | packaging selection + quotation | ₹2.50 |
| Development / tooling | Merchandising | development requirement, `FIXED_PER_RUN` | ₹20.00 |
| Freight | Sales | ex-works arrangement | ₹0.00, **RECORDED ZERO** |
| Duty / tax | Store · Board | `sourcing.type` DOMESTIC + recoverable input GST | no duty line |
| Overhead | Board | `OVERHEAD` 12% of `DIRECT_PLUS_FIXED` | ₹16.08 |
| Financing | Board · Sales | financing policy on 45-day confirmed terms | ₹1.55 |

Freight is a VERIFIED line naming its arrangement, not a silent zero. Duty
resolves to no line because Store's evidence says domestic **and** the Board's
input-GST treatment is recoverable — one decision is not allowed to answer two
tax questions.

A later source change is detectable because the version freezes
`provenance.sourceFingerprint` plus its named, owned parts.

### What Sales receives

The floor price, the proposed price and its floor standing, and readiness. The
suite asserts the projection contains no true cost, no markup amount or
percentage, no supplier, no rate, no overhead or financing internals, no
retired three-tier guidance — and that the floor value IS present, so the
absences mean something.

### The decisions

Commercial review runs with an exact `versionId` and an action key; a command
missing either is refused by name. An at-or-above-floor price takes the
ordinary approval path. A retry with the same key **replays**: the approver,
the instant and the note on the record are unchanged and no second version
exists.

Release is addressed by **`fileId` and the opaque `expectedVersion` only**.
Approving the costing releases nothing, confirming the order releases nothing,
and accepting the handover releases nothing — each asserted with a count.

### What the release produced

Genuine DRAFT spend requests, one demand set, linked to the exact order line,
frozen costing version, ordered quantity and requirement revision. No purchase
order exists, no supplier is named on any request, and no order is placed. A
retry returns `ALREADY_RELEASED` with the same release id and creates nothing.

### Fail-closed, proved by mutation

R&D's consumption on the style moves from 1 Metre to 1.2 **after** the version
is frozen. The estimate then reports itself stale, names which fact moved and
who owns it — never the value — and a new commercial decision is refused with
`COSTING_REVIEW_STALE_INPUTS`. Nothing is repaired inside the test: no costing
record is rewritten and no second version appears.

### Historical isolation

Stronger than expected. A company whose approved margin policy still states the
retired three bands **cannot produce a costing at all**: preparation refuses
with `MARGIN_POLICY_REQUIRED`, names the Board as owner, and says that nothing
converts an old margin automatically. A historical band scenario still reads
back in its own vocabulary — no floor is invented, `floorStatus` is null,
`historical` is true, and its standing never appears in the floor vocabulary.
The end-to-end refusal of a stored `MARGIN_BAND_V1` version as a demand source
is proved in `order-demand-release.test.js` ("a historical MARGIN_BAND_V1
costing releases nothing").

### No manual seam

`prepareForCosting` delegates to `prepareAsRoute`, the same entry the HTTP route
uses — asserted by scanning the fixture. The acceptance suite scans **itself**
and asserts it writes no costing version, scenario, line, floor or policy
amendment, and that its cost-building function states no cost figure anywhere.
The standalone Costing app is not used at any point.

## End-to-end acceptance

`test/costing/acceptance-order-to-demand.test.js` follows ONE garment order the
whole way and asserts what comes out:

```
department records → costing preparation → frozen MARKUP_FLOOR_V2 version
  → Sales commercial review → Sales prices the quotation → confirmed order
  → Execution File → file-scoped demand release → DRAFT spend requests
```

### The arithmetic, on real engine output

A fabric rate of **₹407.81 per Metre**, quoted by Store on a supplier offer, is
the input. Everything else follows from it:

| | |
|---|---|
| true unit cost | **₹500.00** |
| markup | **20%** |
| markup amount | ₹100.00 |
| floor price | **₹600.00** |
| rounding uplift | 0 |

The rate is the input; the unit cost is the engine's answer, and the suite
asserts it rather than arranging it. The floor is asserted **not** to be
₹625.00 — what a 20% *margin* would give — and the scenario is asserted to
carry no minimum, target, preferred or `requestedMarginPercent` field.

### The trace, family by family

| Family | Owner | Authoritative record | Per garment |
|---|---|---|---|
| Materials | Store quotation · R&D consumption | `SupplierOffer`, `sample.consumptionRawItems` | ₹407.81 |
| Operations / labour | Production · Board | style operations, `LABOUR_METHODOLOGY` | ₹3.54 |
| Outside services | Production | `ServiceSupplierOffer` | ₹8.00 |
| Packaging | Merchandising | packaging selection + quotation | ₹2.50 |
| Development / tooling | Merchandising | development requirement, `FIXED_PER_RUN` | ₹20.00 |
| Freight | Sales | ex-works arrangement | ₹0.00, **RECORDED ZERO** |
| Duty / tax | Store · Board | `sourcing.type` DOMESTIC + recoverable input GST | no duty line |
| Overhead | Board | `OVERHEAD` 12% of `DIRECT_PLUS_FIXED` | ₹16.08 |
| Financing | Board · Sales | financing policy on 45-day confirmed terms | ₹1.55 |

Freight is a VERIFIED line naming its arrangement, not a silent zero. Duty
resolves to no line because Store's evidence says domestic **and** the Board's
input-GST treatment is recoverable — one decision is not allowed to answer two
tax questions. Contingency is implemented but unused here: the Board has
approved no contingency policy, so the engine writes no line rather than
substituting nought.

A later source change is detectable because the version freezes
`provenance.sourceFingerprint` plus its named, owned parts.

### What Sales receives

The floor price, the proposed price and its floor standing, and readiness. The
projection is asserted to contain no true cost, no markup amount or percentage,
no supplier, no rate, no overhead or financing internals and no retired
three-tier guidance — and to contain the floor value, so the absences mean
something.

### Sales prices the quotation; the server stamps it

There is **no manual Sales seam**. The order is created with items and no
price, and the quotation is saved through the real authenticated route:

```
POST /api/sales/requests/:requestId/quotation
  items[0].costingIntent = { sampleStyleId, tier: "floor" }
```

That intent is the whole of what the client says about the price.
`quotationPricing.priceLines` resolves and stamps the rest, and the suite reads
the saved line back and asserts every field the server wrote: `source ===
"APPROVED_COSTING"`, the exact approved costing and version and version number,
`priceTier === "floor"`, `unitPriceMinor === 60000`, the scenario key, quantity
500, currency INR, an approval instant, and a fingerprint recomputed
independently through `approvedOutput.fingerprintOf` over the six identities.

**Tampering is discarded, not argued with.** A second pass posts ₹0.01 beside a
forged `costingSource` naming another version, a fake scenario, USD and a fake
fingerprint. The saved line carries the server's ₹600.00 floor and canonical
provenance, and none of the submitted strings survives anywhere on it — a
forged block is deleted rather than validated, because validating it would let
the shape a client sends decide whether the check runs.

The only status the fixture writes afterwards is the order's own commercial
confirmation. No price, provenance or costing field is touched by it.

### The decisions

Commercial review runs with an exact `versionId` and an action key; a command
missing either is refused by name. An at-or-above-floor price takes the
ordinary approval path. A retry with the same key **replays**: the approver,
the instant and the note on the record are unchanged and no second version
exists.

Release is addressed by **`fileId` and the opaque `expectedVersion` only**.
Approving the costing releases nothing, confirming the order releases nothing,
and accepting the handover releases nothing — each asserted with a count.

### What the release produced

Genuine DRAFT spend requests, one demand set, linked to the exact order line,
frozen costing version, ordered quantity and requirement revision. No purchase
order exists, no supplier is named on any request, and no order is placed. A
retry returns `ALREADY_RELEASED` with the same release id and creates nothing.

### Fail-closed, proved by mutation

R&D's consumption on the style moves from 1 Metre to 1.2 **after** the version
is frozen. The estimate then reports itself stale, names which fact moved and
who owns it — never the value — and a new commercial decision is refused with
`COSTING_REVIEW_STALE_INPUTS`. Nothing is repaired inside the test: no costing
record is rewritten and no second version appears.

### Historical isolation

Stronger than expected. A company whose approved margin policy still states the
retired three bands **cannot produce a costing at all**: preparation refuses
with `MARGIN_POLICY_REQUIRED`, names the Board as owner, and says that nothing
converts an old margin automatically. A historical band scenario still reads
back in its own vocabulary — no floor is invented, `floorStatus` is null,
`historical` is true, and its standing never appears in the floor vocabulary.
The end-to-end refusal of a stored `MARGIN_BAND_V1` version as a demand source
is proved in `order-demand-release.test.js` ("a historical MARGIN_BAND_V1
costing releases nothing").

### The prohibition scan

The suite scans **itself**. Both world builders are read on their own and must
construct none of `costingSource`, `costingVersionId`, `unitPriceMinor`,
`fingerprint`, `scenarioKey`, `priceTier`, `floorPriceMinor`,
`trueUnitCostMinor`, `markupAmountMinor`, `unitCostMinor`, `scenarios` or
`prices`. No `CostingVersion` write of any kind is permitted anywhere.

A literal is a construction; a reference is a read. `scenarioKey:
src.scenarioKey` inside the fingerprint verification is the SAVED value being
checked, which is the point of the suite; a quoted literal in the same position
is not allowed.

The one provenance block the file builds is `FORGED_SOURCE`, and it exists so
the route can be caught deleting it. The scan proves it is the only such
construction, that no model write is ever handed it, and that it travels only
as an HTTP request body.

The one markup figure in the file is the Board's approved input, asserted to
appear exactly once and only inside the `approveMarginPolicy` call.

`prepareForCosting` delegates to `prepareAsRoute`, the same entry the HTTP
route uses, asserted by scanning the fixture. **The standalone Costing app is
not used at any point, and no step of the chain is performed by hand.**

## Legacy

`POST /api/costings/:id/procurement-projection/requests` is marked **deprecated**
in place, kept working, and gains no new caller. Retire it once the
Merchandising control is in use.

## Seam reported before touching

None was needed. `CONFIRMED_STATUSES` was already exported from
`merchandisingHandover.service.js`, and `commercialReview.service.js` was not
modified: the approved-costing link is read from the order's own quotation line.

## The merchandiser's control (10 Sep 2026)

The file-scoped door now has a screen. It is a **card in the Execution File
Summary** — not a tab, not a journey, not an app. The merchandiser is already
standing on the file when "has this gone to Requests?" comes up, so the answer
and the action are there.

### Files

| | |
|---|---|
| `components/merchandiser/demandRelease.js` | pure presentation + allowlist |
| `components/merchandiser/ProcurementDemandCard.js` | the card |
| `components/merchandiser/demandRelease.test.mjs` | 35 tests |
| `lib/merchandising/api.js` | `getFileDemandRelease`, `releaseFileDemand` |
| `app/merchandiser/execution/[fileId]/page.js` | loader + Summary mount |

### The allowlist, and why the payload is not a view model

`present()` already excludes money, and the response is still not safe to
render whole: `current` and `releases[]` carry `releaseId`,
`supersedesReleaseId`, `supersededByReleaseId`, and demand-request identities
can sit inside `current.demand`. Those are internal database identities — a
merchandiser cannot use one, cannot quote one to Requests, and cannot be helped
by one.

So nothing is spread. Every visible field is named and copied; succession
survives as the booleans `supersedesEarlier` / `supersededByLater`, which is
the part that means something on a screen. `expectedVersion` is carried as an
opaque POST value and is never displayed. A test seeds `rel_SECRET_*` and
`req_SECRET_*` values throughout the payload and asserts none reaches the view.

### Presentation order — recovery outranks succession

```
recoverable            → "Retry demand release"
eligible && current    → "Release revised demand"
eligible               → "Release demand to Requests"
otherwise              → status / blocker only
```

A PENDING claim holds the line. Offering the successor while one is
outstanding would invite somebody to start a second command on a line that
already has one in flight — refused by the authority, *after* they had decided
to do it.

**The `eligible && current` derivation chooses a LABEL only.** Whether any
control exists is `permitted.release === true` and nothing else; a test pins
that the combination with `permitted.release: false` offers nothing.

### Blockers

The server's `message` is always what is shown. `blocked.code` and
`blocked.reason` only select whether a further sentence about *what to do* is
worth adding, and for everything else nothing is added:

* `DEMAND_RELEASE_RECONCILIATION_REQUIRED` + reason `PRIOR_DEMAND_ACTIVE` →
  close it in Requests first;
* the same code + `PRIOR_DEMAND_UNVERIFIABLE` → fails closed, said as a
  refusal rather than an assumption;
* any other code, or an unrecognised reason → the message alone.

`DEMAND_RELEASE_VERSION_CHANGED` is treated as a **typed POST refusal, not a
GET blocker**: the displayed handle is discarded, the confirmation withdrawn,
the state re-read, and the new version deliberately **not** released — the
person confirmed a different thing.

### Confirmation

Before any release: *"This creates DRAFT Spend Requests only. It does not
select a supplier, create a purchase order, reserve stock, or place an order
with anybody."* All four negatives are asserted.

### Interactions

No client idempotency key — the release authority owns its durable identity,
and a retry finishes the claim it already holds.

**The in-flight guard is a ref, claimed synchronously.** `if (busy) return` was
not a guard: `busy` is React state, so two activations before the next render
both read `false` and both POST, and `disabled` is applied on that same delayed
render. `claim` / `owns` / `release` / `invalidate` live in the pure module,
the card calls exactly those, and `busy` now only renders the button.

The claim carries a SUBJECT, so it is "a release is running for this file"
rather than "a release is running". Switching files invalidates it at once —
otherwise a guard held for a file nobody is on would block the file they are
on, and its owner might never return. A late completion from file A cannot
release file B's claim, which is what would leave B's in-flight release
unguarded.

### One owner for each refresh

| moment | who reloads |
|---|---|
| successful POST | the page — demand and the execution file, once each |
| `DEMAND_RELEASE_VERSION_CHANGED` | the card — the POST never reached the page's success path |

The card used to reload after a success as well, which made two demand GETs
where one answers the question. Asserted as exact counts.

### Cancellation

The demand read has its own `AbortController`: the previous request is aborted
before the next starts, and on a file or company change and on unmount. The
file/sequence check stays as a second boundary, because an abort is not
instantaneous and a response already in flight can still land.

The card is keyed on the **route's** `fileId`, threaded through `SummaryTab` as
`demandFileId`. The loaded `file` object still holds the previous subject while
the next one loads, so a card keyed on it would carry a confirmation dialog and
an in-flight claim across a navigation.

### A correction to how this was previously evidenced

The first version of these tests ran the card's sequence through a harness that
mutated its own `busy` flag synchronously. That harness was **stronger than the
component**: it proved a guard the screen did not have, and the non-vacuity
check — neutering the harness and watching three tests fail — proved the
harness bites, not the card.

The claim now lives in the shipped module and the tests drive that. Neutering
`claim`/`owns` in `demandRelease.js` fails **eight** tests, including both
synchronous-double-press cases and every late-completion case. A source
assertion proves the component calls those functions; nothing is presented as
component proof that is not.

### Totals

Focused 46/46 · all Merchandising frontend 504/504 · full frontend 5415/5418 in
a verified clean window. The three failures are the Store lane's
`components/store/**`, unrelated and pre-existing.
