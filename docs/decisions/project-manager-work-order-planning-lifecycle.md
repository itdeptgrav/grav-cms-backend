# Work-order planning lifecycle

> **Status: APPROVED IN PART — decisions 1–14 accepted at their recommended
> defaults (3 Sep 2026). Decision 15 is OUTSTANDING.**
>
> Nothing in this document has been implemented. No application code, model,
> route, test, migration, frontend file or database has been changed. Approval
> of the design is not implementation: Chunk 4B has **not** started.
>
> **Decision 15 (operational owner for the review queue) has no answer.** It has
> no default by construction — only a human can supply a name. Per §13, the
> legacy classification backfill **cannot be signed off** without one, so the
> backfill step of the rollout (§14) is blocked. Every other approved decision
> may proceed.
>
> Supersedes nothing. Extends the recommendation in
> `docs/audits/project-manager-work-order-planning-integrity.md` §10 with the
> evidence needed to accept or reject it.

---

## 1. Evidence inventory

### 1.1 Every writer of `WorkOrder.status`

An earlier draft said "six, across five applications" above a table of nine
rows, then claimed 12 functions over an owner breakdown that summed to 11. Both
were wrong, and re-checking against the code found a **writer that had been
missed entirely**: `POST /:id/work-orders/:woId/mark-stage` on the
manufacturing-order router — the PM "Mark Production" manual entry — which
writes `completed`/`in_progress` and never downgrades. It is **W10** below.

(One apparent writer was a false positive and is excluded: `status: "forwarded"`
inside `GET /stats/overview` is a `countDocuments` filter, not a write.)

Counted explicitly, because these are four different measures:

| Measure | Count |
|---|---|
| Distinct status-writing **mechanisms** (rows W1–W10) | **10** |
| **Route/service functions** that write | **12** |
| **Applications / execution contexts** | **5** |
| **HTTP endpoints** that can cause a write (W8 is a cron with none) | **11** |

Rows and functions differ only because W5 is one mechanism implemented as three
vendor route handlers. No function is counted twice for having several branches:
packaging writes from the single helper `markUnitsAsFullyCompleted`, reached from
two internal helpers but from exactly one route.

| Owner | Rows | Functions | Endpoints |
|---|---|---|---|
| PM planning | W1 `allocate-raw-materials`, W2 `complete-planning`, W3 `start-production`, W4 `bulk-plan` | 4 | 4 |
| Vendor | W5 `accept`, `reject`, `progress` | 3 | 3 |
| MO — vendor forwarding | W6 `share-to-vendor` | 1 | 1 |
| MO — manual production marking | **W10 `mark-stage`** | 1 | 1 |
| Packaging | W7 `markUnitsAsFullyCompleted` (via `POST /done`) | 1 | 1 |
| Scan / background sync | W8 `productionSyncService.updateWorkOrder` | 1 | **0** |
| Sales | W9 `PUT /requests/:requestId/person/:employeeId` | 1 | 1 |
| **Total** | **10** | **12** | **11** |

Stable route/function names throughout; line numbers move.

| # | File · route/function | Endpoint | Precondition | Status before → after | Retry | Partial? | Frontend caller |
|---|---|---|---|---|---|---|---|
| W1 | `workOrderRoutes.js` · `PUT /:id/allocate-raw-materials` | work-orders | **none** | *any* → `planned` or `partial_allocation` | idempotent since 4A.1 | yes (splits a child WO first) | PM `PlanningDrawer`, PM planning page |
| W2 | `workOrderRoutes.js` · `POST /:id/complete-planning` | work-orders | **none** | *any* → `scheduled` | overwrites `plannedAt`/`plannedBy` | no | both PM planning callers |
| W3 | `workOrderRoutes.js` · `POST /:id/start-production` | work-orders | status ∈ {`scheduled`,`ready_to_start`} **and** every material `issued` | → `in_progress` | 2nd call 400s | no | PM work-order detail |
| W4 | `workOrderRoutes.js` · `POST /bulk-plan` | work-orders | none | → `scheduled` | not idempotent | yes (many WOs) | none found |
| W5 | `vendorWorkOrderRoutes.js` · `accept` / `reject` / `progress` | `/api/vendor/**` | `status: "forwarded"` in the filter | `forwarded` → `planned`; `forwarded` → `cancelled`; `planned` → `in_progress` → `completed` | accept/reject 404 on replay | no | **vendor portal (separate repo)** |
| W6 | `manufacturingOrderRoutes.js` · `POST /share-to-vendor` | manufacturing-orders | status ∉ {completed, cancelled, forwarded} | → `forwarded` | idempotent `updateMany` | no | PM MO detail |
| W7 | `packagingRoutes.js` · packaging accept | manufacturing/packaging | accepted units > 0 | `pending` → `in_progress`; all accepted → `completed` | idempotent-ish | no | Packaging app |
| W8 | `productionSyncService.js` · `updateWorkOrder` (**cron, scan-driven**) | none — background | scan evidence | → `in_progress` when any unit complete; → `completed` at full quantity; **never downgrades** | idempotent | no | barcode scanners |
| W9 | `quotationRoutes.js` · quantity revision | sales | new quantity 0 | → `cancelled` | idempotent | no | Sales |
| W10 | `manufacturingOrderRoutes.js` · `POST /:id/work-orders/:woId/mark-stage` | manufacturing-orders | `status !== completed` | `pending` → `in_progress`; full quantity → `completed` | **mixed — the route as a whole is not replay-safe.** Production, QC and packaging are **capped targets** (`max(existing, requested)`, only the missing delta written), so an identical repeat of *those three* is a no-op. **Dispatch is incremental** — `min(quantity, packagedQuantity − alreadyDispatched)` — so an identical repeat appends a further `bulkDispatchHistory` entry and dispatches more units until packaged stock is exhausted (§9.3) | **yes — three sequential writes, no transaction** (§9.1) | PM MO detail — *Mark Production* |

**The most important row is W8.** Production start and completion are *already*
written from real scan evidence by a background service, independently of the
`start-production` button (W3). W8 also stamps `timeline.actualStartDate` /
`actualEndDate`. Any lifecycle proposal that treats a button press as the
definition of "started" contradicts a service that is already running.

### 1.2 Dead enum values

`ready_to_start`, `paused` and `delayed` are **written by nothing**. Verified by
searching every production writer; the only `paused` hits are in the unrelated
Planner module's tests. `ready_to_start` is *read* by W3 as an alternative entry
condition, so it is reachable only by direct database edit.

### 1.3 Other stored evidence

| Field | Writers | Notes |
|---|---|---|
| `plannedAt` / `plannedBy` | W2 only | overwritten on every replay — no first-planned record survives |
| `operations[].status` | `plan-operations` → `scheduled`; W3 resets **all** to `pending`; W8 sets per-operation from scans | three writers, two vocabularies |
| `rawMaterials[].allocationStatus` | W1 writes `not_allocated`/`partially_allocated`/`fully_allocated`. **`issued` is written only by Store** | the gate W3 depends on |
| `assignedDeadline` + `assignedDeadlineMeta` | `quotationRoutes.js` (Sales) | not a planning field |
| `timeline.actualStartDate` | W3 and W8 | W3 throws when `timeline` is absent (audit defect #11) |
| `forwardedToVendor`, `forwardedAt`, `forwardedBy` | W6 | set alongside `status: "forwarded"` |
| ProductionSchedule membership | `productionScheduleRoutes.js`, `salesScheduleRoutes.js` | pushes into `ProductionSchedule.scheduledWorkOrders[]` with its **own** per-segment `status: "scheduled"` — **it does not touch `WorkOrder.status`** |
| return/rework WorkOrders | `returnRequestRoutes.js` · `POST /:id/create-mo` | created `status: "pending"`, `priority: "high"` |

**Schedule placement is already stored separately from `WorkOrder.status`.**
That is the single most load-bearing fact for this decision: Option A's premise
is not a proposal, it is the existing data model.

### 1.4 Readers — what each distinguishes vs collapses

| Reader | Distinguishes | Collapses |
|---|---|---|
| PM MO register + detail (`moListProjection`) | `cancelled`; ≥100% complete | `pending`/`planned`/`scheduled`/`ready_to_start`/`in_progress` → one `in_progress` |
| PM work-order detail | `scheduled`/`ready_to_start` (enables Start) | the rest |
| Both PM planning callers | none — they write and re-read | everything |
| PM + Sales scheduling | reads WOs to place; writes ProductionSchedule | `WorkOrder.status` irrelevant to placement |
| Production Supervisor / production dashboard | `in_progress` | planning states |
| Cutting, QC | no `WorkOrder.status` writes; read for display | all planning states |
| Packaging / Dispatch | `pending` vs not (W7) | planning states |
| Store | `allocationStatus`, not `WorkOrder.status` | all |
| Vendor portal | `forwarded` (its entire inbox filter) | all others |
| CEO / reporting (`CEO_Routes/Production.js`) | `in_progress`, `completed` | everything else |
| Barcode / scan clients | none — resolve by `_id.slice(-8)` | all |
| `manufacturingOrderRoutes` `/detailed` | counts `planned`, `scheduled`, `in_progress`, `completed` separately | `ready_to_start`, `partial_allocation` |

**No reader anywhere distinguishes `scheduled` from `planned` as a business
fact except the Start-production gate (W3) and one counter.** That is what makes
an additive planning axis cheap.

---

## 2. Current contradictions

1. **`scheduled` means three different things.** W2 writes it to mean "planning
   finished". W3 reads it to mean "released, may start". ProductionSchedule
   membership means "actually on a calendar" — and is not it.
2. **A work order can be `scheduled` and on no schedule**, or on a schedule and
   `planned`. Nothing reconciles the two.
3. **Two definitions of "started".** W3 (button, requires all materials
   `issued`) and W8 (scan evidence, requires nothing). W8 can move a work order
   to `in_progress` that W3 would have refused.
4. **No state means "planning in progress".** After allocation only, a work
   order is `planned` with unplanned operations and is indistinguishable from
   one an operator abandoned.
5. **`partial_allocation` is a quantity fact, not a planning stage**, but it
   occupies the same field as the stages.
6. **`plannedAt` cannot answer "when was this planned"** — every replay
   overwrites it.
7. **Three enum values are dead**; one of them (`ready_to_start`) is a live
   entry condition for starting production.

---

## 3. Options compared

| | A — derive only | B — reuse `ready_to_start` | **C — additive `planningState`** | D — full rewrite |
|---|---|---|---|---|
| Represents "planning in progress" | ✗ | ✗ | ✓ | ✓ |
| Represents an explicit release decision | ✗ | ✓ | ✓ | ✓ |
| Separates planning from execution | partly | ✗ (same field) | ✓ | ✓ |
| Existing readers unaffected | ✓ | ✓ (all fold to `in_progress`) | ✓ | ✗ |
| Migration required | none | backfill ambiguous `scheduled` | additive, backfillable | full, risky |
| Vendor portal (separate repo) impact | none | none | none | **breaks** |
| Reversible | n/a | hard | ✓ | ✗ |

---

## 4. Recommendation — **C + A**, unchanged after this evidence

Add `planningState` as its own additive field; derive everything that already
has an authoritative home. `WorkOrder.status` is not renamed, migrated or
reinterpreted.

The evidence **strengthened** the recommendation in two ways:

- schedule placement is *already* stored in ProductionSchedule, so Option A is
  describing the system rather than changing it;
- no reader except one gate and one counter distinguishes `planned` from
  `scheduled`, so an additive axis costs almost nothing in compatibility.

The evidence **complicated** it in three ways, each resolved below rather than
left as a contradiction:

- W8 already writes execution status from scans, so release must be a *planning*
  concept that gates the **button**, not a claim about whether the floor has
  begun — the floor can begin without asking. Production that starts while
  unreleased — by **device scan or manual mark** — appends a durable
  `productionStartedWithoutRelease` event (§9.2), never a silent promotion to
  released.
- Ambiguous legacy records cannot be expressed in a four-value vocabulary, so the
  persisted axis carries **five** values including `unknown` (§5). A Mongoose
  schema default was measured to hydrate legacy records as `not_started`, so
  none is proposed (§5.3).
- The split write set spans two documents and **transactions are unavailable in
  CI** (measured), so the first orchestration endpoint plans a single document
  and splitting stays on its existing route (§11.1).

---

## 5. Planning axis — exact definitions

Field: `planningState`. Additive. **Five persisted values**, including
`unknown`.

An earlier draft listed four values while the migration required a fifth for
ambiguous records. Both cannot describe one persisted field, so `unknown` is
part of the vocabulary.

**`scheduled` is deliberately absent** — calendar placement is ProductionSchedule
membership (§7).

### 5.1 Values

| Value | Meaning | Entry | Required evidence | Allowed next | Terminal | Who | Audit |
|---|---|---|---|---|---|---|---|
| `unknown` | legacy record whose planning history cannot be established, **or** a live contradiction found later | backfill classification, or a guard detecting contradictory evidence | — | `not_started`, `in_progress`, `complete` — **only by explicit human classification** | no | PM **approver** | `planning.classified` with required reason |
| `not_started` | nobody has planned this | assigned to **newly created** work orders only | none | `in_progress` | no | — | creation record |
| `in_progress` | someone is planning; not finished | first allocation or operation save | ≥1 material allocated **or** ≥1 operation timed | `in_progress`, `complete` | no | PM editor+ | `planningStartedAt`, actor |
| `complete` | planning finished and self-consistent | explicit complete-planning | §7 `materialsReady` **or** recorded accepted shortage; §7 `operationsReady` | `in_progress` (reopen), `released` | no | PM editor+ (held for approval) | **first** `plannedAt`/`plannedBy`, never overwritten |
| `released` | PM authorises production to begin | explicit release | `planningState === "complete"` | `in_progress` (reopen, approver) | no | PM **approver+** | `releasedAt`, `releasedBy` |

### 5.2 `unknown` — persisted, and never inferred as `not_started`

- **Persisted**, not projected. A projected value could not be resolved by a
  human decision and could not carry the reason for that decision.
- **A missing field on a legacy record reads as `unknown`, never as
  `not_started`.** "We never planned this" and "we cannot tell" are different
  facts, and only one of them is safe to release from.
- `unknown` **blocks** release, and blocks any transition requiring proven
  completed planning. It does **not** block execution — the floor keeps working
  (§9).
- Leaving `unknown` requires an **explicit PM approver classification** with a
  **required reason**, emitting `planning.classified`.
- **PM UI:** shown as *"Planning history unclear"* with a Classify action for
  approvers; never rendered as "not started".
- **Included in the review queue** (§10), which is its purpose.

### 5.3 Implementation mechanism — verified, not assumed

Mongoose's behaviour was measured against a legacy document with no stored
value:

| Schema | `findOne()` hydrated | `.lean()` | Raw driver |
|---|---|---|---|
| `{ default: "not_started" }` | **`"not_started"`** | absent | absent |
| no default | absent | absent | absent |

**A schema default masks legacy absence** — through the ORM a never-classified
record would read as `not_started`, while a `.lean()` read of the same document
shows nothing. Two readers, two answers, and the unsafe one wins wherever the
ORM is used. Therefore:

- **No general schema `default`.**
- New work orders get `not_started` from an **`isNew` model invariant**, the
  same mechanism Chunk 4A.2 used for `workOrderNumber` — proven to cover
  `save`, `create` and `insertMany`.
- Every reader maps **absent → `unknown`** in the projection layer.
- Existing records are given a value only by the explicit backfill (§10).

---

## 6. Execution axis — `WorkOrder.status` unchanged

All eleven values keep their present meaning. Nothing renamed, migrated or
removed.

| Value | Class | Written by |
|---|---|---|
| `pending` | actively written | model default, return/rework, split children |
| `planned` | **ambiguous** — "allocation ran", not "planning done" | W1, W5 |
| `scheduled` | **ambiguous** — three meanings (§2) | W2, W4 |
| `ready_to_start` | **dead as a writer**, live as a read gate in W3 | nothing |
| `in_progress` | actively written | W3, W5, W7, W8 |
| `paused` | **dead** | nothing |
| `completed` | actively written | W5, W7, W8 |
| `cancelled` | actively written | W5, W9 |
| `delayed` | **dead** | nothing |
| `partial_allocation` | **transitional** — a quantity fact in a status field | W1 |
| `forwarded` | actively written | W6 |

---

## 7. Derived facts — total, and non-vacuous

Every rule below is **total**: it returns `unavailable` rather than guessing.
`unavailable` is not `false` and never satisfies a gate.

### `materialsReady`

**An empty `rawMaterials` array is not, by itself, evidence that no materials
are required.** It is equally consistent with a BOM snapshot that was never
generated, or with legacy data that lost its lines. Treating it as "ready"
would let an order with no recorded materials pass the same gate as one whose
materials are genuinely all allocated.

**Affirmative evidence of "no materials required"** is one of:

- a **recorded BOM snapshot** on the work order whose required-line count is
  **zero** — the snapshot exists and says nothing is needed; or
- an explicit **`noMaterialsRequired`** decision recorded with actor, timestamp
  and reason (the same shape as the shortage marker, §11.2).

Neither exists on a legacy record today, so legacy empty-material work orders
resolve to `unavailable` until one is supplied. That is deliberate.

| Case | Result |
|---|---|
| non-empty array, every line `fully_allocated` or `issued` | **ready** |
| empty array **with** affirmative evidence above | **ready**, `noMaterialsRequired: true` |
| empty array **without** affirmative evidence | **unavailable** — never ready |
| `rawMaterials` missing, not an array, or any line lacks `allocationStatus` | **unavailable** |
| mixed `fully_allocated` and `issued` lines | **ready** (issued is further along) |
| any line `not_allocated` / `partially_allocated` | **not ready** |
| accepted shortage recorded | **not ready** — a shortage makes planning *completable with an exception*, it does not make materials ready |

An empty `.every()` returns `true` in JavaScript. That must never be allowed to
become product policy by accident, which is why the empty case requires proof
rather than being folded in.

### `materialsIssued`

Same structure and the same evidence requirement: non-empty and every line
`issued` → issued; empty **with** affirmative evidence → issued with
`noMaterialsRequired: true`; empty **without** it, or missing/malformed →
**unavailable**.

### `operationsReady`

| Case | Result |
|---|---|
| ≥1 operation, each with a distinct id and a finite `plannedTimeSeconds ≥ 0` | **ready** |
| **no** operations | **not ready** — an empty plan is not a plan |
| `operations` missing or not an array | **unavailable** |
| any operation missing an `_id` | **unavailable** |
| `plannedTimeSeconds` missing | **not ready** |
| `plannedTimeSeconds === 0` **explicitly set** | **ready** — but see decision 14: an explicit zero is currently unstorable, so until that is fixed this case cannot be distinguished from "missing" and the rule degrades to **not ready** |
| negative, `NaN` or `Infinity` | **unavailable** |
| duplicate operation ids | **unavailable** |

### `canStartProduction`

The earlier draft said only `released && materialsIssued`, which silently
dropped the status gate the current route enforces. Full rule:

1. `planningState === "released"`; **and**
2. `materialsIssued` is ready (including the legitimate no-materials case); **and**
3. `WorkOrder.status` ∈ {`scheduled`, `ready_to_start`} — the **existing** gate,
   preserved; **and**
4. production has not already started (`timeline.actualStartDate` is null and no
   completed scan exists); **and**
5. status ∉ {`completed`, `cancelled`, `forwarded`}; **and**
6. `planningState !== "unknown"`.

Any `unavailable` input makes the whole fact `unavailable`, which does **not**
permit starting.

### `productionStarted` — evidence, source and exceptions

The fact returns **four independent fields**:

```
{ state: "started" | "not_started" | "unavailable",
  startedAt: <timestamp> | null,
  source: "scanner" | "manual_mark" | "unknown" | null,
  exceptions: [] }
```

**`source` exists because two different mechanisms write the same ledger.**
W8 (`productionSyncService`) records device scans. **W10 (`mark-stage`)** writes
into the *same* `ProductionCompletionScanRecord` collection through
`addProductionScans`, labelling each entry
`scannedBy: "<actor> (manual mark)"`. Describing every ledger entry as a device
scan would misreport who actually did the work, so the label is read back:

| Ledger evidence | `source` |
|---|---|
| `scannedBy` ends with `(manual mark)` | `manual_mark` |
| any other `scannedBy` | `scanner` |
| mixed entries, or none legible | `unknown` |

| Evidence | `state` | `startedAt` | `exceptions` |
|---|---|---|---|
| `timeline.actualStartDate` present, `status = in_progress` | `started` | that timestamp | — |
| `actualStartDate` present, `status ∈ {pending, planned, scheduled}` | **`started`** | that timestamp | `startedButNotInProgress` |
| ledger entries exist, no `actualStartDate` | **`started`** | `null` | `startedWithoutTimestamp` |
| `status = in_progress`, no timestamp and no ledger entries | `not_started` | `null` | `inProgressWithoutEvidence` |
| no timestamp, no ledger entries, status not in progress | `not_started` | `null` | — |
| ledger unreadable | `unavailable` | `null` | `executionEvidenceUnavailable` |

**Exceptions never erase real execution evidence.** A timestamp or a ledger
entry — device or manual — establishes that work began; an incompatible status
adds an exception *beside* that conclusion. The only case where evidence fails
to establish a start is where there is none.

`state: started` while `planningState !== "released"` additionally appends the
**durable `productionStartedWithoutRelease`** event, carrying the `source` above
— an appended immutable record, not a derived comparison, so a later release
cannot erase it (§9.2).

`hasPlanningExceptions` is the union of the contradictions above plus accepted
shortages and `productionStartedWithoutRelease` records from either source (§9).

### Authority table

| Fact | Authoritative source |
|---|---|
| `materialsReady` / `materialsIssued` | `rawMaterials[].allocationStatus` — **Store owns `issued`** |
| `operationsReady` | `WorkOrder.operations[]` |
| `isScheduled` / `scheduledPlacement` | **ProductionSchedule membership** — never a status value |
| `planningComplete` / `released` | `planningState` |
| `productionStarted` | `timeline.actualStartDate` and the **production/execution ledger** (`ProductionCompletionScanRecord`), whose entries come from **device scans (W8) or manual marks (W10)** — never a button press alone |

---

## 8. Proposed transition matrix

`PS` = `planningState`. **Eighteen transitions.** Refusals are **409** with a
machine-readable `code`, except validation (**400**) and capability (**403**).

| # | Transition | Required `PS` | Permitted `status` | Capability | Validation | Idempotency | Stores | Audit |
|---|---|---|---|---|---|---|---|---|
| 1 | begin planning | `not_started`, `in_progress` | not completed/cancelled/forwarded | PM planning | — | no-op if already | `PS=in_progress` | `planning.started` |
| 2 | save material allocation | `not_started`→`in_progress` | as above | PM planning | 4A.1 quantity rules | replay no-op | allocation fields | `planning.materials` |
| 3 | save operation plan | same | same | PM planning | array; ids exist | replay no-op | `operations[]` | `planning.operations` |
| 4 | complete planning | `in_progress` | not completed/cancelled/forwarded | PM planning (held) | `materialsReady` or recorded shortage; `operationsReady` | replay 200; **`plannedAt` not overwritten** | `PS=complete`, first `plannedAt` | `planning.completed` |
| 5 | place on schedule | `not_started`, `in_progress`, `complete`, `released` — **and `unknown` until the backfill completes** (§8.2) | not completed/cancelled | scheduler (PM/Sales) | existing | existing | ProductionSchedule only | `schedule.placed` |
| 6 | move / reschedule | any | as above | scheduler | existing | existing | ProductionSchedule only | `schedule.moved` |
| 7 | remove from schedule | any | as above | scheduler | existing | existing | ProductionSchedule only | `schedule.removed` |
| 8 | release | `complete` | not completed/cancelled/forwarded | PM **approver** | `PS === complete` | replay 200, first `releasedAt` kept | `PS=released` | `planning.released` |
| 9 | start production (button) | `released` | `scheduled`, `ready_to_start` | Production Supervisor **or** PM | §7 `canStartProduction` | 2nd call 409 | `status=in_progress`, `actualStartDate` | `production.started` |
| 10 | pause | any | `in_progress` | Production Supervisor | — | — | `status=paused` (**currently dead — decision 11**) | `production.paused` |
| 11 | resume | any | `paused` | Production Supervisor | — | — | `status=in_progress` | `production.resumed` |
| 12 | complete | any | `in_progress` | execution-ledger evidence (W8 scans or W10 manual marks) or supervisor | — | never downgrades | `status=completed`, `actualEndDate` | `production.completed` |
| 13 | cancel | any | not completed | PM approver / Sales | — | idempotent | `status=cancelled` | `production.cancelled` |
| 14 | forward to vendor | `complete` or `released` | not completed/cancelled/forwarded | PM approver (already held) | vendor active | idempotent (4A.1) | `status=forwarded`; **`PS` unchanged** | existing ChangeLog |
| 15 | create return/rework | n/a — new WO | n/a | Store/PM | existing | existing | new WO `PS=not_started`, `status=pending` | existing |
| 16 | **reopen / re-plan** | `complete`, `released` — **never `unknown`** | **not** `in_progress`, `completed`, `cancelled`, `forwarded` | PM **approver** | **must not be on a schedule** (§8.1); reason required | — | `PS=in_progress`; original `plannedAt` kept | `planning.reopened` |
| 17 | **classify** (leave `unknown`) | `unknown` **only** | any | PM **approver** | destination evidence must be present (§8.3); reason required | replay 409 — already classified | `PS` = chosen value; `classifiedAt`, `classifiedBy`, `previousValue`, `reason` | `planning.classified` |
| 18 | **manual production mark** (W10 `mark-stage`) | any — **not gated on `released`** in the first rollout (§9) | `status !== completed`; never downgrades | **PM manual-mark capability, direct** (§12) — *not* held for approval | stage and quantity valid | **mixed — not replay-safe as a whole** (§9.3). Production, QC and packaging apply `quantity` as a **capped target**, so an identical repeat of those stages is a no-op and a higher target legitimately records more progress; **dispatch applies `quantity` as an additional amount**, so an identical repeat dispatches further units while packaged stock remains. **Not atomic** across its three writes (§9.1) | ledger entries `scannedBy: "… (manual mark)"`; `status` `pending`→`in_progress`, or →`completed` at full quantity; `timeline.actualEndDate`; on a **dispatch** mark also a new `bulkDispatchHistory` entry and `isDispatched` on whole employee allocations | `production.markedManually`, and a durable `productionStartedWithoutRelease` event with `source: manual_mark` when unreleased (§9.2) |

### 8.1 Reopening a **scheduled** work order — the schedule comes first

An earlier draft allowed re-planning a scheduled work order because "scheduling
is not a lock", and said nothing about the segments already on the calendar.
Changing quantity, operations or planned time invalidates segment duration,
capacity, machine assignment, start/end times and downstream commitments —
leaving a placement that still *looks* operational.

**Recommended first-cut rule:**

1. A work order with **active ProductionSchedule membership cannot re-enter
   planning**. Transition 16 refuses with `409 SCHEDULED_MUST_BE_REMOVED_FIRST`.
2. The operator removes it via the **existing scheduling authority** (transition
   7). No planning route ever deletes a schedule segment.
3. After removal, a PM approver may reopen planning with a **required reason**.
4. The audit links the removal and the reopen where evidence permits
   (`schedule.removed` → `planning.reopened`, same work order, adjacent).
5. If schedule membership **cannot be determined** — the query fails, or a
   segment references a missing schedule — the transition **fails closed** and
   the work order is marked `hasPlanningExceptions` with
   `staleScheduleMembership`. It is never assumed unscheduled.

This is deliberately stricter than "scheduling is not a lock", and it is the
only version in which no stale placement can be silently treated as valid.

### 8.2 Scheduling eligibility — explicit

Decision 8 says scheduling has **no planning-complete prerequisite**. That
stands: `not_started` and `in_progress` work orders **may** be scheduled, exactly
as today, because both Sales and PM schedule work before planning finishes and
requiring completion would be a workflow change with its own blast radius.

`unknown` is a different case. It does not mean "planning is unfinished" — it
means *we cannot tell what happened to this record*, so no statement about it is
trustworthy, including "it is safe to commit capacity to it".

**But absent currently projects as `unknown`, so on day one every legacy work
order would be `unknown`.** Refusing to schedule them would break every existing
scheduling client at once. Therefore:

1. **Until the backfill and review queue are resolved, `unknown` is schedulable.**
   Scheduling behaviour is unchanged for every existing client.
2. The restriction on `unknown` activates **only after** the backfill has run and
   the review queue is worked down — the same gate as the §8 state guards
   (implementation step 7), behind the same flag.
3. When active, scheduling an `unknown` work order returns
   `409 UNKNOWN_NOT_SCHEDULABLE` and directs the operator to classify it first.

This is the general rule for this design: **an additive field must not break a
legacy operation merely because its value is not yet known.**

### 8.3 Leaving `unknown` is classification, not reopening

An earlier draft let `unknown` exit through the generic reopen transition while
also describing classification as its own action emitting `planning.classified`.
Those are different operations and are now separated:

| | Reopen (16) | Classify (17) |
|---|---|---|
| From | `complete`, `released` | `unknown` **only** |
| To | `in_progress` | `not_started`, `in_progress` or `complete` — **never `released`** |
| Means | "this plan is being redone" | "we have established what this record's history actually was" |
| Evidence | reason | reason **plus** the evidence required by the destination |
| Audit | `planning.reopened` | `planning.classified`, recording `previousValue` and reason |

**`unknown` must not escape through the reopen endpoint.** Transition 16 refuses
it with `409 UNKNOWN_REQUIRES_CLASSIFICATION`.

Classification may only choose a destination whose own evidence is present:
`complete` requires `materialsReady` (or a recorded shortage) **and**
`operationsReady`; `in_progress` requires at least one allocation or operation
time; `not_started` requires no planning evidence **and** no contradicting
execution, schedule or vendor evidence. It cannot classify directly to
`released` — release is a decision (transition 8), not a historical finding.

### 8.4 Vendor interaction

Forwarding is permitted from `complete` or `released`.

- Forwarding **preserves** `planningState` exactly: `complete` stays `complete`,
  `released` stays `released`.
- The vendor portal's `forwarded → planned`, `planned → in_progress`,
  `in_progress → completed` writes affect **only the legacy execution status**.
  **Vendor acceptance must never downgrade or overwrite the planning axis.**
- Vendor rejection/cancellation preserves planning history and records its own
  outcome on the execution axis.
- Returning work to internal production requires an **explicit transition**, not
  an inference from `status === "planned"` — that value is also what W1 writes,
  so it cannot distinguish "vendor handed it back" from "allocation ran".
- **No change is proposed to the vendor repository**, which is not in this
  workspace.

---

## 9. Production started without release — an exception, not a bypass

**Two** mechanisms can start production without any release check, and both
write the same `ProductionCompletionScanRecord` ledger:

| | Mechanism | Actor |
|---|---|---|
| **W8** | `productionSyncService` — barcode ingestion | shop-floor devices |
| **W10** | `POST /:id/work-orders/:woId/mark-stage` — the PM *Mark Production* action | a person in the PM UI |

Both are correct and neither may be discarded: the ledger records what actually
happened on the floor, and W10 is the **manual backup flow** used when a scanner
is unavailable. It also means **release is not, today, a reliable production
gate** — by either route.

Stated precisely:

- **Execution evidence remains authoritative** and is never overwritten.
- A work order whose production starts while `planningState !== "released"`
  raises **`productionStartedWithoutRelease`**, carrying
  `source: "scanner" | "manual_mark" | "unknown"`. One exception, one taxonomy —
  **a manual mark is never reported as a device scan.**
- It is **not** silently promoted to `released`, and **no planning timestamp is
  fabricated**.
- It appears in observability (§16) and the PM exception queue.

**Visibility-only in the first rollout — for W10 exactly as for W8.** Blocking
the manual mark before its operational impact is measured would remove the
backup flow the floor falls back to when scanning fails, which is a worse
outcome than an unreleased start. Measure first (decision 9); enforcement at
either ingestion path is a separate rollout decision requiring shop-floor
compatibility verification.

**Why W10 takes a direct capability rather than an approval hold.** The original
reason given — "a replayed hold would double-count production" — was wrong, and
so was the correction that replaced it ("an identical repeat is a no-op"). That
correction was true only of three of the route's four stages. The accurate
position, stage by stage, is §9.3.

The reasons for a direct capability are:

- **The route is genuinely not replay-safe as a whole.** Its dispatch stage
  applies `quantity` as an *additional* amount, so re-issuing a stored request
  later dispatches further units (§9.3). An approval workflow whose whole
  purpose is to hold a request and re-issue it after a delay is therefore unsafe
  here — not because production is double-counted, but because dispatch is.
- It records an **immediate operational fact** — the manual backup for a
  scanner, used when a device is unavailable.
- **Approval latency would obstruct production**: the floor cannot wait for a
  second person to accept a record of work already done.
- The route is **not transactionally atomic** across its ledger, WorkOrder and
  employee-progress writes (§9.1), so a re-issued request may land against a
  partially-applied earlier attempt.
- Therefore it **must not be routed through the asynchronous approval-replay
  workflow** at all.

### 9.1 W10's existing partial-write boundary — characterisation only

`mark-stage` writes **three documents in sequence, with no transaction**:

1. `ProductionCompletionScanRecord` — the execution ledger (`addProductionScans`);
2. `WorkOrder` — status, `productionCompletion`, timeline (`wo.save()`);
3. `EmployeeProductionProgress` — per-person progress.

A failure after step 1 or 2 leaves the earlier evidence **committed**. This is
recorded as **characterisation, not a proposal**: Chunk 4B does **not** redesign
or fix this route, and nothing here calls it atomic.

- **Execution-ledger evidence remains authoritative** — it is what actually
  happened, and a later failure does not invalidate it.
- **Reconciliation and observability must detect disagreement** between the
  ledger, the WorkOrder snapshot (`productionCompletion.overallCompletedQuantity`)
  and the sum of employee progress, and surface it rather than silently
  preferring one.

### 9.2 The unreleased-start exception must be durable

A derived comparison of *current* `planningState !== "released"` is not enough:
if someone releases the work after it already started, the comparison turns
false and the historical violation disappears. So the exception is **an
appended immutable event**, not a computed flag.

- The trigger is **newly observed production evidence** — a scan record, or a
  manual mark whose *production* delta is greater than zero. A `mark-stage`
  call that adds no production (a QC, packaging or dispatch repeat whose
  production target was already met) is **not** a production start and must
  **not** append a further occurrence. Repeating such a call therefore leaves
  the exception history unchanged even though the call itself is not a no-op
  (§9.3).
- On the **first observed** production start while not released, append a
  `productionStartedWithoutRelease` event recording: `source`
  (`scanner` | `manual_mark` | `unknown`), the evidence/event identity that
  established the start, the observed timestamp, the WorkOrder id, and the
  **planning state observed at that moment**.
- A later release may **resolve** the active exception. It must **never delete or
  rewrite** the historical event.
- **Execution recording stays primary:** a failure to append the exception must
  never reject a valid scan or manual backup action.
- A **reconciliation process** derives and backfills a missing exception from
  execution evidence, so an append that failed is recovered rather than lost.

Observability therefore distinguishes three different numbers (§16):
**historical occurrences** (immutable, only ever grows), **currently unresolved
exceptions** (a queue that should fall), and the **new-occurrence rate** (which
should fall as releases become routine). "Should fall" applies to the latter two
— never to the immutable historical total.

### 9.3 W10 replay semantics, stage by stage — what the code proves

Read from `manufacturingOrderRoutes.js` · `POST /:id/work-orders/:woId/mark-stage`.
Three of the four stages take `quantity` as a **target**; the fourth takes it as
an **increment**. This distinction is why the route as a whole is **not
replay-idempotent**, and it corrects two earlier statements that were both
wrong — see §9 above.

| Stage | Computation | `quantity` means | Identical repeat |
| --- | --- | --- | --- |
| **Production** | `prodTarget = cap(max(prodBefore, quantity))`; only `prodTarget − prodBefore` scans appended | **target** | **no-op** — target already met, delta 0 |
| **QC** | `qcAfter = min(prodAfter, max(qcBefore, quantity))` | **target**, capped by production | **no-op** — delta 0, no history row |
| **Packaging** | `packAfter = min(qcCompleted, max(packBefore, quantity))` | **target**, capped by QC | **no-op** — delta 0, no packaging record |
| **Dispatch** | `dispatchQty = min(quantity, packagedQuantity − alreadyDispatched)` | **additional amount** | **not a no-op** — dispatches again, up to remaining packaged stock |

Consequences that follow directly from that table:

- **Dispatch has no target semantics and no upper anchor other than availability.**
  `alreadyDispatched` is the sum of `bulkDispatchHistory[].quantity`, so each
  accepted repeat both *appends a new history entry* and *reduces the remaining
  availability*. Repeats stop only when `packagedQuantity − alreadyDispatched`
  reaches zero — not because the request was recognised as a duplicate.
- **The route as a whole is therefore not replay-idempotent**, and must not be
  described as one. Equally, it must not be described as double-counting
  *production*: production, QC and packaging are capped and do not.

**Effect of a repeated dispatch on `EmployeeProductionProgress`.** Stating only
what the code proves: the reflection step runs once per stage delta over the
work order's progress documents sorted by `unitStart`.

- The production and packaging loops are driven by *quantities* and are skipped
  entirely when their delta is zero — so a dispatch-only repeat does not touch
  them.
- The dispatch loop is driven by a **per-employee boolean**. It skips any
  document already flagged `isDispatched`, and flags a document only when the
  remaining delta covers that employee's **whole** allocation (`totalUnits`),
  appending one `dispatchHistory` entry and decrementing the remainder.
- Therefore a repeated dispatch **can advance further, not-yet-dispatched
  employee records** — one whole allocation at a time, as many as the new delta
  covers. It cannot flag or re-append to the same document twice: the
  `isDispatched` guard makes that document's transition one-way.
- A remainder smaller than every remaining un-dispatched allocation is
  **dropped**: the units are recorded in `bulkDispatchHistory` but no employee
  record is advanced. The loop `continue`s past an allocation too large for the
  remainder rather than stopping, so a later, smaller allocation can still be
  flagged out of `unitStart` order.

This subsection is **characterisation of existing behaviour**. Chunk 4B does not
change `mark-stage`.

## 10. Legacy classification (design only — not implemented, not run)

Additive backfill of `planningState`. **Every existing `status` byte preserved.**
Absent field reads as `unknown` until classified.

The earlier version was a table of independent rules that **overlapped**: an
`in_progress` record with no `plannedAt`, no allocation and no operation times
matched rule 1 (`not_started`) *and* a later rule (`unknown`). Replaced with an
**ordered decision tree**. Rules are evaluated top to bottom and **the first
match wins**, so every record receives exactly one outcome by construction.

### 10.1 Definitions used by the tree

- **completion claim** — `plannedAt` present. **This proves only that the legacy
  `complete-planning` endpoint was invoked.** That endpoint validates neither
  material readiness nor operation readiness (audit defect #4), so a claim is
  *not* evidence that the new definition of `complete` was ever satisfied.
- **verified completion** — a completion claim **and** the record's *current*
  evidence satisfies the new total rules: §7 `materialsReady` is **ready**
  (including the affirmative "no materials required" case) **and**
  `operationsReady` is **ready**.
- **partial planning evidence** — ≥1 raw-material line not `not_allocated`, or
  ≥1 operation with a stored `plannedTimeSeconds`, without verified completion.
- **execution evidence** — `timeline.actualStartDate`, any
  `ProductionCompletionScanRecord` entry (device **or** manual mark), or
  `productionCompletion.overallCompletedQuantity > 0`.
- **schedule membership** — a `ProductionSchedule.scheduledWorkOrders[]` entry
  references this work order.

**Schedule membership is read before classification**, in the same pass. **If
the lookup is unavailable or throws, the record is classified `unknown`** and
flagged `scheduleLookupUnavailable` — never assumed unscheduled.

### 10.2 No legacy record may become `released`

`released` is defined as an explicit PM approver decision carrying `releasedAt`
and `releasedBy`. **No legacy record contains that decision**, and circumstantial
evidence cannot manufacture it: `status ∈ {in_progress, completed}` with a
completion claim shows that work *began*, not that anyone authorised it.

Therefore:

- **The backfill assigns `released` to zero records.** It is not a destination
  of any rule below.
- Human classification from `unknown` **cannot choose `released`** either (§8.3).
- **Only transition 8, performed after cutover, may create
  `planningState = released`.**
- Every legacy record that has started production therefore carries a
  `productionStartedWithoutRelease` event (§9.2) until someone releases it or
  the exception is accepted. **That is the honest state.** Observability (§16)
  should expect the **unresolved queue** and the **new-occurrence rate** to
  start high and fall as the backlog is worked — **not** the immutable
  historical total, which only ever grows.

### 10.3 The ordered tree

First match wins, so every record receives exactly one outcome.

| # | Condition | → | Deterministic? |
|---|---|---|---|
| 1 | `status ∈ {ready_to_start, paused, delayed}` | `unknown` | ✗ review — no writer produces these; a hand edit |
| 2 | `status ∈ {in_progress, completed}` **and** verified completion | `complete` | ✓ |
| 3 | `status ∈ {in_progress, completed}` **and** a completion claim without verified completion | `unknown` + `legacyCompletionUnverified` | ✗ review |
| 4 | `status ∈ {in_progress, completed}` **and no** completion claim | `unknown` | ✗ review — execution without any planning claim |
| 5 | `status = forwarded` **and** verified completion | `complete` | ✓ |
| 6 | `status = forwarded` **and** anything less | `unknown` (+ `legacyCompletionUnverified` if a claim exists) | ✗ review |
| 7 | schedule membership **and** verified completion | `complete` | ✓ |
| 8 | schedule membership **and** anything less | `unknown` (+ `legacyCompletionUnverified` if a claim exists) | ✗ review |
| 9 | `status = scheduled` **and** verified completion | `complete` | ✓ |
| 10 | `status = scheduled` **and** anything less | `unknown` (+ `legacyCompletionUnverified` if a claim exists) | ✗ review — W4 `bulk-plan` wrote `scheduled` with no validation at all |
| 11 | execution evidence (any status) **and** verified completion | `complete` | ✓ |
| 12 | execution evidence **and** anything less | `unknown` (+ `legacyCompletionUnverified` if a claim exists) | ✗ review |
| 13 | verified completion | `complete` | ✓ |
| 14 | completion claim **without** verified completion | `unknown` + `legacyCompletionUnverified` | ✗ review |
| 15 | partial planning evidence, no execution / schedule / vendor signal | `in_progress` | ✓ |
| 16 | no planning evidence, no execution evidence, no schedule membership, `status ∈ {pending, planned, partial_allocation, cancelled}` | `not_started` | ✓ |
| 17 | anything not matched above | `unknown` | ✗ review — the catch-all is deliberately `unknown` |

Rules 1–12 put **execution, exceptional-status, vendor and scheduling evidence
ahead of every planning conclusion**. Rule 16 is the only path to `not_started`
and requires every contradicting signal to be absent. **`released` appears
nowhere.**

**Cancellation invents nothing.** `cancelled` is not a rule of its own: it falls
through to whichever rule its remaining evidence satisfies — 13, 14, 15 or 16 —
so a cancelled record that was never planned becomes `not_started`, and one with
an unverifiable claim becomes `unknown`.

**Execution truth is independent of planning classification.** A record
classified `unknown` whose `actualStartDate` is set is still
`productionStarted: { state: "started" }` (§7). Classification describes what we
know about *planning*; it never rewrites what happened on the floor.

### 10.4 Truth table

Each row is one record and the single rule that claims it. "verified" means the
record's current material and operation evidence satisfies §7.

| `status` | claim (`plannedAt`) | verified? | exec | sched | **Outcome** | Rule |
|---|---|---|---|---|---|---|
| `in_progress` | — | — | — | — | `unknown` | 4 |
| `in_progress` | ✓ | ✗ | scans | — | `unknown` + `legacyCompletionUnverified` | 3 |
| `in_progress` | ✓ | ✓ | scans | — | **`complete`** (never `released`) | 2 |
| `completed` | ✓ | ✓ | manual mark | — | **`complete`** (never `released`) | 2 |
| `completed` | — | — | scans | — | `unknown` | 4 |
| `scheduled` | — | — | — | — | `unknown` | 10 |
| `scheduled` | ✓ | ✗ | — | ✓ | `unknown` + `legacyCompletionUnverified` | 8 |
| `scheduled` | ✓ | ✓ | — | ✓ | `complete` | 7 |
| `ready_to_start` | ✓ | ✓ | — | — | `unknown` | 1 |
| `forwarded` | — | — | — | — | `unknown` | 6 |
| `forwarded` | ✓ | ✓ | — | — | `complete` | 5 |
| `planned` | — | — | — | ✓ | `unknown` | 8 |
| `planned` | — | — | — | — | `in_progress` *(if partial evidence)* | 15 |
| `pending` | — | — | — | — | `not_started` | 16 |
| `cancelled` | — | — | — | — | `not_started` | 16 |
| `cancelled` | ✓ | ✗ | — | — | `unknown` + `legacyCompletionUnverified` | 14 |
| `cancelled` | ✓ | ✓ | — | — | `complete` | 13 |
| *(empty materials, no BOM proof)* | ✓ | **✗ — `materialsReady` unavailable** | — | — | `unknown` + `legacyCompletionUnverified` | 14 |
| *(schedule lookup fails)* | any | any | any | **?** | `unknown` + `scheduleLookupUnavailable` | fail-closed |

Note the empty-materials row: because §7 makes an unproven empty BOM
`unavailable` rather than ready, such a record can never reach `complete` — it
goes to review, which is the intended direction.

**`unknown` is never a guess dressed as a state.** Of the **17** rules in §10.3:

- **8 are deterministic** — 2, 5, 7, 9, 11, 13, 15, 16;
- **9 route to `unknown` for review** — 1, 3, 4, 6, 8, 10, 12, 14, 17.

8 + 9 = 17, and the two sets are disjoint, so every rule is accounted for
exactly once. **More than half of the tree lands in the review queue**, which is
the honest consequence of refusing to guess.

Mandatory requirements, inherited from the 4A.2 corrections: dry-run default
with explicit `--apply`; one outcome per candidate per run; restartable and
idempotent; documented backup before apply; verification by re-report; rollback
limited to records actually written; and — because concurrent writers can change
`status` mid-run — either a quiesced window or acceptance that `unknown` grows.

---

## 11. Orchestration contract (specification only)

`POST /api/cms/manufacturing/work-orders/:id/plan` — **additive**. All **four**
existing planning routes keep working unchanged — `allocate-raw-materials`,
`plan-operations`, `complete-planning` and `bulk-plan` (§11.3).

### 11.1 Atomicity — the contradiction, resolved

An earlier draft promised "all-or-nothing" while also saying transactions were
optional and that creating the child before the parent update plus idempotency
was sufficient. **That is not true.** Idempotency prevents a *retry* from
duplicating work; it cannot undo a split child already created when the parent
update then fails.

**Measured:** the test environment (`mongodb-memory-server`) runs a
**standalone**, and `session.withTransaction` fails with *"Transaction numbers
are only allowed on a replica set member or mongos."* **Transactions are not
available to CI today.**

| Option | Viable now? |
|---|---|
| **1 — transaction-backed** (parent + child in one transaction; idempotency record and audit transactionally compatible; no success unless all commit) | **No.** Requires a replica set in production *and* in CI. Not verified; CI proven not to support it. |
| **2 — no split in the first orchestration endpoint** (same-document planning only; splitting stays on the existing compatibility route; the endpoint then truthfully promises atomicity for its actual write set) | **Yes** |
| **3 — durable resumable saga** (persisted attempt with explicit phases; retry resumes or compensates; partial state visible) | Possible, but a large build. Write ordering alone is **not** a saga and must not be described as one. |

**Recommendation: Option 2** — but "single document" is only honest once the
**complete write set** is stated, which the earlier draft did not do.

### 11.1.1 The complete write set

Removing the split does not by itself make the operation atomic. The contract
also requires an idempotency receipt, an immutable planning-history entry, and a
`services/changeLog` event — and `ChangeLog` is a **separate collection**, so it
is a second write no matter what.

| Write | Where | In the atomic commit? |
|---|---|---|
| canonical domain mutation (quantity, allocation, operations, `planningState`) | WorkOrder document | **yes** |
| idempotency receipt — key, body hash, replayable response | **embedded on the WorkOrder** | **yes** |
| immutable planning-history / outbox event | **embedded on the WorkOrder** | **yes** |
| central `ChangeLog` entry | separate collection | **no — projected** |

**Recommended design:**

- The first three are one `updateOne` on one document, so they commit or fail
  together without a transaction.
- **Same key + same body hash:** read the stored receipt and return the stored
  response. The mutation is not repeated.
- **Same key + different body hash:** `409`.
- The central `ChangeLog` entry is **projected from the durable outbox event**,
  not written inline.
- **A failed projection is observable and retryable and never erases the
  canonical audit event** — the outbox entry on the work order is the record of
  truth; `ChangeLog` is the projection of it — and becomes the canonical archive for any event later evicted from the work order (see Audit retention below).
- The `ChangeLog` projection is **explicitly not part of the atomic commit**, and
  this document does not claim otherwise.

**Retention, stated honestly.** A capped list cannot promise unbounded replay
safety: once an old receipt is evicted, its key would be accepted again. So the
promise is bounded and written into the contract.

- **Idempotency window: 7 days minimum.** A key is guaranteed to be recognised
  for at least that long. The cap is expressed as *"the greater of 20 receipts or
  everything within 7 days"*, so eviction can never remove a receipt inside the
  window.
- **Client contract:** replay protection is promised **only** inside the window.
  A retry older than 7 days is a new request and may re-apply. Clients that
  cannot retry within 7 days must not rely on the key.
- The alternative — durable key uniqueness in a separate collection with
  tombstones that are never evicted — is available if an unbounded promise is
  required, at the cost of a second document and losing single-document
  atomicity. **Not recommended**; a 7-day window covers every realistic retry.

**Concurrency — the atomic claim rule.** Two requests carrying the same key must
never both mutate. The receipt is claimed by a **conditional single-document
update**:

| Situation | Result |
|---|---|
| key absent | the update that matches "no receipt for this key" **wins and claims it**; it performs the mutation |
| the losing concurrent request | its conditional update matches nothing; it re-reads the winner's receipt and returns the **stored result** |
| same key, same body hash (later) | returns the stored result; the mutation is **not** repeated |
| same key, different body hash | **409** |
| key outside the retention window | treated as a new key — see the window contract above |

Because the claim and the mutation are the same single-document update, two
simultaneous requests cannot both perform it.

**Audit retention and authority.** The outbox/history entry on the work order is
the canonical audit event **while it is there**, and:

- **An unprojected event is never evictable.** Eviction may only consider entries
  whose projection has been confirmed.
- Projection is confirmed by **stable event id** written back onto the entry, so
  confirmation is idempotent and verifiable.
- **Eviction is a separate later operation**, never part of a planning request.
- Once an event is evicted from the work order, **`ChangeLog` is the canonical
  archive for that event** — not a convenience index. The authority moves with
  the data, and this document does not claim both at once.
- Projection and archival failures stay **visible and retryable**; a failure
  simply means the entry remains on the work order and is not yet evictable.

**Honest guarantee, stated once:** the endpoint is atomic **for the WorkOrder
document and everything embedded on it**. It is **not** atomic with respect to
the `ChangeLog` projection, which is eventually consistent and retryable. It
performs **no** multi-document mutation. If this design is rejected, the
alternatives are to narrow the guarantee explicitly or defer the endpoint until
replica-set transactions are available — not to keep saying "partial failure:
none possible".

### 11.2 Contract

- **Auth:** `EmployeeAuthMiddleware` + a **route-specific** PM planning
  capability (§12). Not a router-wide guard.
- **Request:** `{ quantity, operations[], planningNotes?, acceptShortage? }` —
  **no `splitRemaining`** under Option 2.
- **`Idempotency-Key`:** required. Same key + same body → original response
  replayed; same key + different body → 409.
- **Validation order:** id → work order exists → state guard (§8) → quantity
  (4A.1 rules) → BOM snapshot consistency → operations array, ids, durations →
  shortage policy → write.
- **Shortage:** refused unless `acceptShortage: true`. When set, a **structured
  shortage marker** is required and written **inside the same atomic WorkOrder
  mutation** — never left implicit in `planningNotes`:

  | Field | Required | Meaning |
  |---|---|---|
  | `shortageAccepted` | yes | boolean, the decision itself |
  | `shortageReason` | **yes — non-empty** | why production may proceed short; a blank reason is a `400` |
  | `shortageAcceptedBy` | yes | actor id and email, from the session |
  | `shortageAcceptedAt` | yes | server timestamp |
  | `shortageLines[]` | yes | the raw-material lines short at the time of the decision, with required and allocated quantities |

  **Replay:** an idempotent replay returns the stored receipt and does **not**
  re-stamp `shortageAcceptedAt` or the actor — the original decision stands. A
  *different* body that changes the shortage decision is a `409`, not a silent
  overwrite.

  **A recorded shortage never makes `materialsReady` true.** It makes planning
  *completable with a recorded exception*: `materialsReady` stays **not ready**
  (§7), `planningState` may reach `complete`, and the work order carries
  `hasPlanningExceptions` with `acceptedShortage`.
- **Response:** `{ success, workOrder, planningState, derived, exceptions[] }`.
- **Partial failure:** none for the WorkOrder document and its embedded receipt,
  history and outbox entry — they commit together. The `ChangeLog` projection can
  fail independently and is retried; that is visible, not silent (§11.1.1).
- **Stock:** **never reserves or deducts.** Store stays authoritative.

### 11.3 All four legacy planning routes during compatibility rollout

The earlier text said "the three existing routes" while the inventory lists
four. `POST /bulk-plan` has no frontend caller, but it is a live API that writes
`scheduled` today, so its behaviour is not irrelevant.

| Route | Resulting `planningState` | Validation | Idempotency | Status | May overwrite a later state? |
|---|---|---|---|---|---|
| `PUT /:id/allocate-raw-materials` | `not_started` → `in_progress`; leaves `complete`/`released` **unchanged** | 4A.1 quantity rules | idempotent since 4A.1 | **supported**, deprecated once `POST /:id/plan` ships | **no** |
| `PUT /:id/plan-operations` | `not_started` → `in_progress`; leaves `complete`/`released` **unchanged** | array; ids must exist | idempotent for the same body | **supported**, deprecated with the above | **no** |
| `POST /:id/complete-planning` | `in_progress` → `complete` **only when** §7 `materialsReady` (or recorded shortage) **and** `operationsReady` hold; otherwise leaves the state unchanged and returns the existing 200 during the compatibility window, then `409` once guards are enabled | evidence checks above | replay does not overwrite `plannedAt` | **supported**, deprecated with the above | **no** |
| `POST /bulk-plan` | **`in_progress` only — never `complete`** | performs **no** material or operation validation | not idempotent | **supported but frozen**; refused once §8 guards are enabled unless it gains the same validation | **no** |

**`bulk-plan` must not mark work `complete`.** It writes `scheduled` without
checking a single material line or operation time, so treating it as completed
planning would manufacture exactly the false confidence this axis exists to
remove. It sets `in_progress` — planning was touched — and nothing more.

**No route may silently downgrade `complete` or `released`.** Every one of the
four takes the maximum of its computed state and the stored state; a work order
that is `released` stays `released` when someone re-saves an allocation. Moving
backwards requires transition 16 (reopen) or 17 (classify), both approver-only.

**Frontend migration:** both callers move together in one Lane B change. Because
the legacy routes keep working, they may also move one at a time; whichever has
not moved keeps the non-atomic three-step sequence, and splitting continues to
use the legacy route in either case.

---

## 12. Authorization — route-specific, never router-wide

The work-order router is **shared**. A blanket PM capability would break the
Production Supervisor, Store, vendor and scan paths that legitimately write to
these work orders. Using the department capability system from Chunk 2:

| Mutation | Capability | Mode |
|---|---|---|
| `allocate-raw-materials`, `plan-operations`, `complete-planning`, `POST /:id/plan` | **PM planning** (editor) | **held for approval** — replay-safe, so the existing hold works |
| `POST /bulk-plan` | **PM planning** (editor) | **held for approval**; frozen at `in_progress` and refused once §8 guards enable unless it gains the same validation (§11.3) |
| release (transition 8) | **PM planning** (approver) | **direct** — it *is* the approval decision; holding it would need a second approver |
| reopen (transition 16) | **PM planning** (approver) | **direct**, reason required |
| **classify** (transition 17) | **PM planning** (approver) | **direct**, reason plus destination evidence required |
| **manual `mark-stage`** (transition 18, W10) | **PM manual-mark**, its own route-specific capability | **direct — never held.** The route is **not replay-safe as a whole** (§9.3): production, QC and packaging are capped targets, but **dispatch applies `quantity` as an additional amount**, so re-issuing a stored request later dispatches further units. It also records an immediate operational fact (the manual backup when a scanner is unavailable), approval latency would obstruct production, and it is not transactionally atomic across its three writes (§9.1). It must not go through the asynchronous approval-replay workflow. *Not* because a replay double-counts **production** — that earlier claim was disproven; production, QC and packaging repeats are no-ops. **Visibility-only in the first rollout** (§9): the capability is added, the release gate is not enforced. |
| `start-production`, pause, resume | **Production Supervisor**, or PM | direct |
| material **issue** (`allocationStatus = "issued"`) | **Store** — unchanged, Store keeps stock authority | direct |
| vendor accept / reject / progress | **vendor portal auth** — unchanged, separate repository | direct |
| scan / background sync (W8) | **no HTTP capability** — a cron with no endpoint | n/a |
| all read endpoints | authenticated employee — **unchanged**, no department restriction | n/a |

**Never a router-wide PM guard.** The work-order and manufacturing-order routers
are shared; a blanket guard would break Production Supervisor, Store, vendor and
scan writers. Every row above is route-specific.

**Existing non-PM callers of the legacy planning routes were searched for:** the
only callers of `allocate-raw-materials`, `plan-operations` and
`complete-planning` anywhere in `grav-cms` are the two PM planning surfaces
(`PlanningDrawer.js` and the PM planning page). `start-production` is called only
from the PM work-order detail page. No Cutting, QC, Packaging, Store or Sales
surface calls any of them. So a PM planning capability on the planning routes has
**no known legitimate non-PM caller to break** — but it is still an access change
for anyone using the API directly, which is decision 12.

Frontend `RoleGate` remains an affordance, never security.

---

## 13. Decisions requiring approval

**Decisions 1–14 were approved at their recommended defaults on 3 Sep 2026.**
The "Default" column below is therefore the accepted position for those rows.
**Decision 15 remains unanswered.**

Decisions 2 and 15 were previously duplicates — both asked who owns the review
queue. They are now distinct: **2 is the policy** (approved), **15 is the
person** (outstanding). Only **15** has no default, because only a human can
supply a name; the approval message left the placeholder unsubstituted.

| # | Decision | Recommendation | Alternative | Compatibility consequence | Implementation consequence | Default |
|---|---|---|---|---|---|---|
| 1 | Additive **five-value** planning axis (`unknown`, `not_started`, `in_progress`, `complete`, `released`) | Adopt | Keep one status field (Option B/D) | None — `WorkOrder.status` untouched | New field, `isNew` invariant, projection maps absent → `unknown` | Adopt |
| 2 | Legacy `unknown` **treatment and classification policy** | Persist `unknown`; absent reads as `unknown`; only transition 17 leaves it, approver-only, with a reason and the destination's own evidence | Infer `not_started` from thin evidence | Safe: no record is ever claimed planned | Fifth enum value, projection mapping, Classify action, `planning.classified` audit | **Adopt** |
| 3 | Scheduled re-planning rule | Refuse while scheduled; remove from schedule first, then approver reopens with reason | Allow with a stale-schedule marker | Stricter than today | 409 code, audit linkage, fail-closed on unresolvable membership | Refuse-first |
| 4 | In-progress re-planning | **Refuse** | Allow with approver | Stricter than today | 409 | Refuse |
| 5 | Completed / cancelled changes | **Refuse** | Allow | Stricter than today | 409 | Refuse |
| 6 | Release explicit or automatic | **Explicit PM approver** | Automatic on completion | None | One more transition + capability | Explicit |
| 7 | Shortage-acceptance evidence | **Add** a stored marker (actor, reason, timestamp) | Leave undefined | Additive field | Without it `planningComplete` is undefinable for short orders | Add |
| 8 | Scheduling prerequisite | **No** planning-complete requirement initially | Require `complete` | None now | Revisit once `planningState` is populated | No requirement |
| 9 | Production-without-release: visibility or enforcement — **both** ingestion paths, W8 device scans **and W10 manual marks** | **Visibility-only** first, for both | Enforce at every ingestion path | Enforcement could **stop the floor** and would remove the **manual backup flow** used when scanners fail | `productionStartedWithoutRelease` + metrics split by `source` now; enforcement later, separately per source | Visibility-only |
| 10 | Vendor-forwarding interaction | Preserve `planningState`; vendor writes execution only | Let vendor acceptance reset planning | None — vendor repo untouched | Guard so vendor writes cannot touch the planning axis | Preserve |
| 11 | Dead enum values (`ready_to_start`, `paused`, `delayed`) | **Keep**, unwritten | Remove | Removal would break W3's read gate | None | Keep |
| 12 | **Route-specific** capabilities per §12, including a **direct PM manual-mark capability for W10** | Adopt per §12 | No capability (today's state) | No known non-PM caller; still an API access change | Per-route guards, never router-wide. W10 is **direct, never held** — the endpoint contains a **non-idempotent dispatch operation** (`quantity` is an additional amount there, a capped target only for production/QC/packaging, §9.3) *and* is not atomic across its three writes (§9.1); it also records an immediate operational fact, and approval latency would obstruct production | Adopt |
| 13 | Transaction-backed orchestration **vs** split deferral | **Option 2 — defer split**; revisit Option 1 only if a replica set is confirmed in production *and* CI | Option 1 now; Option 3 saga | Split keeps working on its existing route | Endpoint promises atomicity only for a single document | Option 2 |
| 14 | Explicit **zero** operation duration | **Fix** (audit defect #12) | Leave | None | Until fixed, `operationsReady` cannot distinguish zero from missing | Fix |
| 15 | **Operational owner / team for the review queue** | Name a specific team or person | Leave unassigned | None technical | The queue is worked by a named owner; the backfill cannot be signed off without one | **OUTSTANDING — no name supplied; blocks backfill sign-off only** |

---

## 14. Rejected alternatives

- **Option D (full rewrite).** Stored statuses are read by the PM projections,
  the schedule, the **vendor portal in a separate repository**, CEO reporting
  and the scan floor. Disproportionate risk.
- **Option B (`ready_to_start` as the release gate).** Two axes in one field,
  and the same backfill without the separation.
- **A four-value planning axis.** Cannot express "we cannot tell", so ambiguous
  legacy records would have to be guessed.
- **A schema `default` for `planningState`.** Measured to hydrate legacy records
  as `not_started` through the ORM while `.lean()` shows absent (§5.3) — two
  answers, and the unsafe one wins.
- **Storing `isScheduled` or `materialsReady`.** Duplicates of ProductionSchedule
  membership and of Store-owned allocation state.
- **"All-or-nothing without transactions."** Measured impossible for the split
  write set; CI has no replica set.
- **Blocking scan-driven start on release.** Would stop real production for a
  data-entry state.
- **A router-wide PM capability.** Would break Production Supervisor, Store,
  vendor and scan writers on the shared router.

---

## 15. Implementation sequence after approval

1. Add `planningState` to the model — **no schema default**; `isNew` invariant
   assigns `not_started` to new work orders only.
2. Projection maps **absent → `unknown`** and exposes the §7 derived facts and
   exceptions.
3. Teach the **four** existing planning routes to maintain `planningState` per
   §11.3 — no preconditions yet, so behaviour is unchanged.
4. Add the shortage-acceptance marker (decision 7) and fix the explicit-zero
   duration defect (decision 14), so `planningComplete` becomes definable.
5. Ship the backfill dry-run; work the `unknown` queue with its named owner
   (decision 15); then apply.
6. Add `POST /:id/plan` (single-document, Option 2) with idempotency and
   route-specific capability.
7. Add the §8 state guards behind a flag; enable after the backfill is clean.
8. Add the **durable** `productionStartedWithoutRelease` event (§9.2) for
   **both** ingestion paths — W8 device scans and **W10 manual marks** — as an
   appended immutable record, never a derived comparison, plus the
   reconciliation pass that backfills a missing event from execution evidence
   and the three metrics below (decision 9, **visibility-only**, nothing
   blocked). Appending must never reject a valid scan or manual mark.
9. Add the **PM manual-mark route capability** for W10 as a *direct* guard
   (decision 12). It is not held for approval and does not gate on `released`.
10. Lane B migrates both planning callers.
11. Only then reconsider the legacy `planned`/`scheduled` values, split
    orchestration, and any enforcement at ingestion — each a separate decision.

Steps 1–3 are backward-compatible and reversible. Step 7 is the first behaviour
change and needs its own sign-off.

---

## 16. Rollback and observability

- **Rollback:** steps 1–4 by reverting code; the field may be left in place
  unread. Step 5 by restoring the pre-apply backup. Step 7 by disabling the
  flag — no data change.
- **Observability required before step 7:**
  - work orders by (`planningState` × `status`);
  - size and age of the `unknown` review queue;
  - **`productionStartedWithoutRelease`, as three distinct numbers** (§9.2),
    each split by `source` so the manual backup flow can be judged separately
    from device ingestion:
    - **historical occurrences** — immutable, only ever grows; never expected to
      fall, and a fall would mean events were destroyed;
    - **currently unresolved exceptions** — the queue that should fall as
      releases are recorded;
    - **new-occurrence rate** — should fall as releasing becomes routine, and is
      the measurement that decides whether enforcement (decision 9) is ever safe;
  - **ledger / WorkOrder / employee-progress disagreement** (§9.1) — the
    detector for a partially-failed `mark-stage`;
  - 409 count per transition — a spike means the guards contradict how people
    actually work;
  - contradiction counts from §7 (`inProgressWithoutEvidence`,
    `startedButNotInProgress`, `staleScheduleMembership`).
- **Audit:** every §8 transition emits a named event through the existing
  `services/changeLog`. **Planning has no audit at all today** (audit defect #7);
  this is where that is fixed.
