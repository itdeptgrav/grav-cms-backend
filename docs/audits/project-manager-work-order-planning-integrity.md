# Project Manager — work-order planning integrity audit

> **STATUS UPDATE (3 Sep 2026).** Four of the defects below were corrected in
> **Chunk 4A.1** — an emergency data-integrity pass, scoped to
> `PUT /:id/allocate-raw-materials` only. Defects **#1, #2, #3 and #5** are
> **FIXED**; every other finding in this document still stands. The lifecycle
> decision in §10 was **approved on 3 Sep 2026 for decisions 1–14**; decision 15
> (the review queue's named owner) is outstanding and blocks only sign-off and
> application of the legacy classification backfill. **Chunk 4B implementation
> has begun with slice 4B.1** (additive `planningState` field and its
> new-record invariant); no backfill has been approved, run or dry-run.
>
> **Chunk 4A. Audit only.** No production behaviour was changed by the audit
> itself. Every claim
> below is backed by route-level evidence in
> `test/project-manager/work-order-planning-characterization.route.test.js`
> (52 tests) or by a cited file and line.
>
> §10 was the decision packet for Chunk 4B. Decisions 1–14 are now approved;
> decision 15 gates the backfill alone.

---

## 1. Executive summary

Work-order planning is three independent, unguarded, unaudited, non-idempotent
writes behind a UI that presents them as one action.

Five findings are serious enough to act on regardless of what Chunk 4B decides:

1. **Splitting is a one-shot capability for the whole installation.** Split
   children are created with no `workOrderNumber`, and that field has a
   **unique, non-sparse** index. The first split anywhere stores `null`; every
   later split — any work order, any user — dies on `E11000 duplicate key` and a
   500.
2. **`quantity: true` silently reduces a ten-unit order to one unit**, and
   **omitting `quantity` entirely unsets the work order's quantity**. Both
   return 200.
3. **`complete-planning` validates nothing.** It writes `status = "scheduled"`
   unconditionally from any state — including `completed` and `cancelled` — with
   no allocation or operation checks, and each replay overwrites `plannedAt` and
   `plannedBy`.
4. **Allocation is not idempotent.** Replaying it rescales `quantityRequired`
   from the already-scaled stored value, so every retry shrinks the material
   requirement (100 → 60 → 36 → 21.6).
5. **No planning mutation is authorised beyond "is signed in", and none is
   audited.** The router carries no `departmentWrites` guard and makes no
   `recordChange` call.

The computed producible quantity is calculated and then discarded; a missing
unit conversion silently passes the number through unconverted; and the planning
read is N+1 in raw items.

Planning does **not** touch stock. Store remains authoritative — that part of
the design is sound and should be preserved.

---

## 2. Lifecycle vocabulary as it exists today

**`WorkOrder.status`** — `models/…/WorkOrder.js:246-255`, eleven values:

```
pending  planned  scheduled  ready_to_start  in_progress
paused   completed  cancelled  delayed  partial_allocation  forwarded
```

Only five are ever written by the planning routes:

| Value | Written by | Meaning in practice |
|---|---|---|
| `pending` | model default; split children | nothing has happened |
| `partial_allocation` | allocate, when `quantity < originalQuantity` | quantity was reduced |
| `planned` | allocate, when `quantity === originalQuantity` | allocation ran |
| `scheduled` | complete-planning, **unconditionally** | someone pressed the button |
| `in_progress` | start-production | the floor started |

`ready_to_start` is **accepted** by start-production but written by nothing in
this router. `delayed`, `paused` and `forwarded` are untouched by planning.

**`operations[].status`** — `WorkOrder.js:28-31`: `pending | scheduled |
in_progress | completed | delayed`. plan-operations writes `scheduled`;
start-production resets every one back to `pending`.

**`rawMaterials[].allocationStatus`** — `WorkOrder.js:63-67`:
`not_allocated | partially_allocated | fully_allocated | issued`. Planning
writes the first three. **Nothing in this router ever writes `issued`** — that
is the Store's, and it is the gate start-production depends on.

The vocabulary conflates four different questions under one field: *has anyone
planned this*, *is the material covered*, *is it on a schedule*, *has the floor
started*. That conflation is what §10 asks you to decide about.

---

## 3. Endpoint contract table

Mount: `server.js:1541` — `app.use("/api/cms/manufacturing/work-orders", workOrderRoutes)`.
**No `departmentWrites` guard.** Router-local `EmployeeAuthMiddleware` only
(`workOrderRoutes.js:22`). So for all five endpoints the authorisation boundary
is identical: **any authenticated employee, any department.**

| Method + path | Callers | Authorisation | Accepted starting states | Validation | Fields mutated | Resulting state | Retry result | Audit |
|---|---|---|---|---|---|---|---|---|
| `GET /:id/planning` | PlanningDrawer.js, planning/[id]/page.js, work-orders/[id]/page.js | any authenticated employee | **any** | none; malformed id → **500** | none (read) | — | same | none |
| `PUT /:id/allocate-raw-materials` | PlanningDrawer.js:140, planning/[id]/page.js:135 | any authenticated employee | **any**, incl. `completed`/`cancelled` | `quantity <= 0`, `quantity > wo.quantity` only | `quantity`, `originalQuantity`, `rawMaterials[].quantityRequired/quantityAllocated/allocationStatus`, `planningNotes`, `status`; creates a child WorkOrder | `planned` or `partial_allocation` | **not idempotent** — requirement shrinks each time | none |
| `PUT /:id/plan-operations` | PlanningDrawer.js:158, planning/[id]/page.js:155 | any authenticated employee | **any** | none | `operations[].plannedTimeSeconds/notes/status/operationCode`, `timeline.totalPlannedSeconds`, `planningNotes` | unchanged | idempotent for the same body | none |
| `POST /:id/complete-planning` | PlanningDrawer.js:170, planning/[id]/page.js:170 | any authenticated employee | **any** | **none at all** | `status`, `plannedBy`, `plannedAt`, `planningNotes` | `scheduled` | **overwrites `plannedAt`/`plannedBy`** | none |
| `POST /:id/start-production` | work-orders/[id]/page.js:238 | any authenticated employee | `scheduled` \| `ready_to_start` **and** every material `issued` | state + issuance | `status`, `timeline.actualStartDate`, `operations[].status` → `pending` | `in_progress` | second call 400s (state moved) | none |

**Audit column is uniformly "none":** `workOrderRoutes.js` contains zero
`recordChange` / `changeLog` / `auditTrail` references, and the `auditTrail`
floor is mounted only on `/api/hr` and `/api/employees` (`server.js:1055-1066`).

---

## 4. The three-step frontend sequence

Implemented **twice**, identically:

- `app/project-manager/dashboard/production/manufacturing-orders/components/PlanningDrawer.js:132-180`
- `app/project-manager/dashboard/production/manufacturing-orders/planning/[id]/page.js:135-175`

```
PUT  /:id/allocate-raw-materials     → throw on failure
PUT  /:id/plan-operations            → throw on failure
POST /:id/complete-planning          → throw on failure
```

Three requests, no transaction, no idempotency key, no compensation. The first
failure throws and the user sees an error; whatever the earlier steps wrote
stays written. A retry re-runs step 1, which is where the requirement-shrinking
defect bites.

Two copies means a fix applied to one leaves the other wrong.

---

## 5. Partial-failure state table

| Failure point | `status` | `quantity` | materials | operations | `plannedAt` | Distinguishable from "still planning"? |
|---|---|---|---|---|---|---|
| after step 1 (split) | `partial_allocation` | **already reduced** | allocated | `pending` | unset | **No** |
| after step 1 (no split) | `planned` | unchanged | allocated | `pending` | unset | **No** |
| after step 2 | `planned` | unchanged | allocated | **`scheduled`** | unset | Only by inspecting `plannedAt` |
| after step 3 | `scheduled` | — | — | `scheduled` | set | complete |

After step 2 the operation vocabulary says "scheduled" while the work order says
"planned" — the two disagree, and nothing reconciles them.

There is **no state that means "planning is in progress"** and none that means
"planning was abandoned". A half-planned order is indistinguishable from an
untouched one apart from side-effects a reader would have to know to look for.

---

## 6. Stock and unit-conversion authority

**Stock authority is correct and must be preserved.** Planning reads RawItem
documents with `.lean()` and never saves them; `complete-planning` carries an
explicit note that deduction was removed deliberately. Allocation records
*intent* on the work order (`quantityAllocated`) and nothing else. Proven by
test: raw-item quantity is byte-identical before and after allocation.

Three defects sit on top of that sound base:

- **`Math.max(1, maxProducibleQuantity)`** (`workOrderRoutes.js:517`) — with
  zero stock the read reports 1. Proven.
- **`convertQuantity` returns its input unchanged** when no conversion path
  exists, logging a warning nobody sees (`workOrderRoutes.js:52-53`). A
  requirement in metres is then compared against a stock figure in kilograms as
  if commensurable. Proven: 2 m/unit against 100 kg reports 50 producible units.
- **`canProduceQuantity` is computed and never read.** The allocation route
  spends a loop calculating the true limit across every material and then
  discards it. Proven: 10 units accepted and marked `planned` against stock for 2.

A declared conversion **is** applied correctly when one exists.

---

## 7. Query and performance findings

| Endpoint | Behaviour |
|---|---|
| `GET /:id/planning` | **N+1 confirmed.** One `RawItem.findById` per material inside a `Promise.all` map, plus up to two `Unit.findOne` per material via `convertQuantity` called without the batching `unitMap`. Proven: 5 materials → 5 raw-item queries. |
| `PUT /:id/allocate-raw-materials` | **Already batched.** One `RawItem.find({$in})` and one `Unit.find({$in})`. Proven: 5 materials → 1 raw-item query. |

The batching helper the allocation route uses (`convertQuantity(..., unitMap)`)
already exists; the read simply does not pass it.

---

## 8. Proven defects, by severity

| # | Severity | Defect | Evidence |
|---|---|---|---|
| 1 | ~~**Critical**~~ **FIXED 4A.1** | Only one split can exist database-wide. Children get no `workOrderNumber`; the field is uniquely and non-sparsely indexed, so every later split 500s on `E11000 … workOrderNumber: null`. | now `REGRESSION: two unrelated work orders can both be split` |
| 2 | ~~**Critical**~~ **FIXED 4A.1** | `quantity: true` reduces a 10-unit order to 1 and returns 200. | now `REGRESSION: every malformed quantity is a controlled 400 that writes nothing` |
| 3 | ~~**Critical**~~ **FIXED 4A.1** | Omitting `quantity` **unsets** the work order's quantity (mongoose treats `undefined` as unset, so `min: 1` never fires) and marks it `planned`. | now `REGRESSION: every malformed quantity is a controlled 400 that writes nothing` |
| 4 | **High** | `complete-planning` validates nothing and overwrites any state, including `completed` and `cancelled`. | test "completing planning accepts and overwrites any state" |
| 5 | ~~**High**~~ **FIXED 4A.1** | Allocation replay rescales the requirement each time: 100 → 60 → 36 → 21.6. | now `REGRESSION: replaying an identical allocation does not shrink the requirement` |
| 6 | **High** | No authorisation beyond authentication on any planning mutation. | test "any authenticated employee may mutate planning" |
| 7 | **High** | No audit record for any planning mutation. | test "no planning mutation is audited" |
| 8 | **Medium** | The computed producible limit is never enforced. | test "the computed producible limit is not enforced" |
| 9 | **Medium** | Missing unit conversion silently passes the number through. | test "a missing unit conversion silently keeps the original number" |
| 10 | **Medium** | Unknown operation ids are skipped and reported as success; a mixed body applies partially and still reports success. | tests "unknown operation ids are silently skipped", "a mixed valid/unknown body …" |
| 11 | **Medium** | `start-production` 500s when `timeline` is absent (no schema default). Latent — the main generator sets one. | test "start-production 500s when the timeline subdocument is absent" |
| 12 | **Low** | Explicit `0` cannot be stored for `plannedTimeSeconds` or `totalPlannedSeconds` (`\|\|` fallbacks). | tests "an explicit zero duration cannot be stored", "a zero totalPlannedSeconds is discarded" |
| 13 | **Low** | Malformed ids are 500 rather than 400, inconsistent with the manufacturing-order detail routes. | test "a malformed id is a 500, not a 400" |
| 14 | **Low** | `operations: "abc"` reports success and does nothing (strings are iterable). | test "a string operations value reports success and does nothing" |
| 15 | **Low** | `maxProducibleQuantity` floored to 1. | test "zero stock still reports maxProducibleQuantity 1" |
| 16 | **Low** | `GET /:id/planning` is N+1. | test "GET /:id/planning is N+1 in raw items" |

### Suspicions **disproven**

- **"Retrying a split allocation may create another split."** It does not. The
  first call sets `workOrder.quantity = quantity`, so the replay computes
  `remainingQuantity = 0` and skips the split branch entirely. Recorded as a
  passing test so the belief is not re-inherited. (A split at a *different,
  lower* quantity would divide again — but now fails on defect #1 first.)
- **"Allocation may deduct or reserve stock."** It does not; Store is
  authoritative.
- **"Duplicate operation ids may double-apply."** They do not; the last value
  wins.

---

## 9. Compatibility constraints for Chunk 4B

- `GET /:id/planning` is read by **three** frontend surfaces; its response shape
  (`workOrder.rawMaterials[].currentStock/requiredPerUnit/status`,
  `maxProducibleQuantity`, `stockItemOperations`) is load-bearing.
- The three-step sequence exists in **two** frontend files. Any orchestration
  endpoint must keep the three existing routes working until both are migrated,
  or both must change together.
- `start-production` depends on `allocationStatus === "issued"`, which only the
  Store writes. Do not fold issuance into planning.
- The eleven stored `status` values are read by the manufacturing-order list and
  detail projections (Chunks 3A/3B) — `scheduled`, `planned`, `ready_to_start`
  all map to `in_progress` in `displayStatus`. **Adding or renaming a stored
  status changes the register**, so any new state must either reuse an existing
  stored value or be introduced with a matching projection change.
- Fixing #15 (`Math.max(1, …)`) changes a number the planning screen displays.
- Fixing #12 (explicit zero) changes what a caller can express, not what
  existing callers send.

---

## 10. Decision packet

### 10.1 The question

One field, `WorkOrder.status`, currently answers six different questions badly.
Chunk 4B needs to know which of these the business wants to distinguish:

| Concept | Today |
|---|---|
| planning in progress | **not representable** |
| planning complete | `scheduled` (written unconditionally) |
| ready to schedule | **not representable** |
| placed on the schedule | `scheduled` (same value) |
| released to production | **not representable** |
| production started | `in_progress` |

`scheduled` currently means all three of *planning complete*, *ready to
schedule* and *on the schedule*. `ready_to_start` exists in the enum, is
accepted by start-production, and is written by nothing.

### 10.2 Options

**Option A — derived vocabulary, no stored change.** Keep the eleven stored
values. Compute a richer `planningState` in a projection, the way Chunks 3A/3B
compute `displayStatus`, from evidence already stored (`plannedAt`,
`allocationStatus`, `operations[].status`, ProductionSchedule membership).
*Migration:* none. *Compatibility:* total — no consumer changes.
*Limit:* cannot distinguish "ready to schedule" from "on the schedule" unless
schedule membership is queried, and cannot record an explicit release decision.

**Option B — use `ready_to_start` as the release gate.** `complete-planning`
writes `planned` + `plannedAt`; a new explicit action writes `ready_to_start`;
scheduling writes `scheduled`. Every value already exists in the enum.
*Migration:* existing `scheduled` rows are ambiguous and need a backfill rule.
*Compatibility:* the register already folds all three into `in_progress`, so no
visible change there. *Limit:* still one field carrying two axes.

**Option C — a separate `planningState` field alongside `status`.** Add
`planningState: not_started | in_progress | complete | released` as its own
path; leave `status` exactly as it is for every existing consumer.
*Migration:* additive, backfillable from `plannedAt`. *Compatibility:* total.
*Limit:* two fields to keep consistent.

**Option D — full lifecycle rewrite.** New enum, migration of all stored values,
every consumer updated. *Migration:* large and risky. *Compatibility:* breaks
the register, the schedule, the detail projections and the barcode floor.

> **Superseded by the decision package (3 Sep 2026).** §10 remains the audit's
> original reasoning. The recommendation was re-tested against a full writer and
> reader inventory in
> `docs/decisions/project-manager-work-order-planning-lifecycle.md`
> (status: **APPROVED IN PART** — decisions 1–14 accepted 3 Sep 2026,
> decision 15 outstanding) and **still stands**, with two
> refinements the evidence forced: schedule placement is already stored in
> ProductionSchedule rather than in `WorkOrder.status`, and production start is
> already written from scan evidence by `productionSyncService`, so "released"
> can gate the start *button* but not the floor. **15 consecutive decisions** in
> that document, of which **1–14 were approved on 3 Sep 2026**. Decision 15 has
> no default and remains unanswered; it blocks sign-off and application of the
> **legacy classification backfill** and ownership of its `unknown` review
> queue, not the schema, projection, route, orchestration or observability work. Corrected after review:
> the persisted planning axis carries **five** values (`unknown` included), no
> Mongoose schema default is proposed (a default was measured to hydrate legacy
> records as `not_started`), the first orchestration endpoint plans a single
> document because transactions are unavailable in CI, and re-planning a
> scheduled work order requires removing it from the schedule first. A second
> review pass added a **tenth** status writer that had been missed —
> `POST /:id/work-orders/:woId/mark-stage`, the PM *Mark Production* action —
> replaced the overlapping legacy-classification table with an ordered
> first-match-wins decision tree, and stated the orchestration endpoint's
> complete write set rather than claiming blanket atomicity. A final pass
> integrated W10 through the whole design — it writes the same production
> ledger as a device scan, labelled `(manual mark)`, so the release-bypass
> exception is `productionStartedWithoutRelease` with a `source` of `scanner`
> or `manual_mark` — established that **no legacy record may be backfilled to
> `released`** (no historical approval exists to infer), stopped treating
> `plannedAt` as proof of validated completion (the legacy endpoint validated
> nothing), and required affirmative evidence before an empty bill of
> materials counts as "no materials required". Two successive cleanups settled W10's
> replay semantics, the first over-correcting the second. What the code proves,
> stage by stage: production, QC and packaging apply `quantity` as a **capped
> target** (`max(existing, requested)`, only the missing delta written), so an
> identical repeat of those three is a no-op and the original "double-counts
> production" claim was wrong; but **dispatch applies `quantity` as an
> additional amount** (`min(quantity, packaged − alreadyDispatched)`), so an
> identical repeat appends another dispatch entry and dispatches more units
> until packaged stock is exhausted. **The route as a whole is therefore not
> replay-idempotent**, which is the actual reason its capability is direct
> rather than held for approval. The same pass characterised its **three-write,
> non-transactional** boundary (ledger → WorkOrder → employee progress), and
> made the unreleased-start exception a **durable appended event**, keyed on
> newly observed *production* evidence so a dispatch-only repeat adds no further
> occurrence, and so a later release cannot erase the history.

### 10.3 Recommendation — **Option C**, with **A** for anything derivable

Add `planningState` as its own field and leave `status` untouched. It is the
only option that can represent *planning in progress* and an explicit *released*
decision without changing a single value any current consumer reads. It is
additive, backfillable from `plannedAt`, and reversible. Anything that can be
derived rather than stored — "is the material covered", "is it on the schedule" —
should be derived in the projection layer (Option A), because a stored duplicate
of a fact that lives elsewhere is a fact that will disagree.

**Not recommended: Option D.** The stored statuses are read by the register, the
detail endpoints, the production schedule and the scan floor. Migrating them is a
separate, larger piece of work with its own rollback plan.

**This is a recommendation, not a decision, and nothing has been implemented.**

### 10.4 Mechanism recommendations for Chunk 4B

| Mechanism | Recommendation | Migration / compatibility effect |
|---|---|---|
| **Single orchestration endpoint** | **Yes**, additive. Add `POST /:id/plan` performing all three steps; keep the three existing routes working. | None until the two frontend files migrate. Both must move together, or the older one keeps its partial-failure behaviour. |
| **Idempotency key** | **Yes.** The Store & Purchase work already established an `Idempotency-Key` convention; reuse it rather than inventing one. | Additive — absent header behaves as today. Directly fixes defects #5 and the retry path. |
| **Conditional state transitions** | **Yes**, and this is the highest-value change. Refuse allocation and completion from `completed`, `cancelled`, `in_progress`. | **Behaviour change**: calls that silently succeed today will 409. Needs an explicit decision, because some operator may rely on re-planning a live order. |
| **MongoDB transaction** | **No, not yet.** The split writes two documents, which is the only genuine multi-document case, and it is currently broken for a simpler reason (#1). Transactions need a replica set; confirm the deployment supports them before designing around one. | Would require infrastructure confirmation. An idempotency key plus conditional transitions covers most of the risk without it. |
| **Immutable planning history** | **Yes.** Reuse `services/changeLog.recordChange` — the mechanism Chunk 2 already uses — rather than a second audit system. | Additive. Fixes #7. Do not overwrite `plannedAt` on replay; append instead. |

### 10.5 Fixes that need no decision

Defects #1, #2, #3, #11, #13 and #14 are input-validation and data-integrity
bugs with no product question attached. They can be fixed in Chunk 4B — or
sooner — without waiting on the lifecycle decision. **#1, #2 and #3 are
data-corruption paths and should be fixed first.**



---

## 11. Chunk 4A.1 — corrections applied (3 Sep 2026)

Scoped to `PUT /api/cms/manufacturing/work-orders/:id/allocate-raw-materials`.
No lifecycle state, authorization, orchestration, audit, transaction, unit
conversion, sufficiency policy or frontend file was touched.

| Defect | Before | After |
|---|---|---|
| **#3** omitted `quantity` | 200; the stored `quantity` was **unset** (mongoose treats `undefined` as unset, so `min: 1` never fires); status → `planned` | **400**, nothing written |
| **#2** `quantity: true` | 200; cast to 1 — a ten-unit order silently became one unit | **400**, nothing written |
| **#2** `"abc"`, `{}` | 500 from a mongoose cast failure | **400**, nothing written |
| **#2** `[]`, `null` | 400 by coercion accident (`[] → "" → 0`) | **400** by intent |
| **#1** split children | saved with **no** `workOrderNumber`; first child stored `null`, every later split anywhere died on `E11000` | child gets `WO-<last 8 of _id>` before its first save; unrelated splits both succeed |
| **#5** allocation replay | requirement compounded: 100 → 60 → 36 → 21.6 | stable: 100 → 60 → 60 → 60 |

**Accepted `quantity`:** a finite JSON **number** greater than zero and no
greater than the work order's current quantity. Numeric strings are refused —
a caller sending `"5"` is a caller whose contract cannot be vouched for.
**Fractional quantities remain legal**: nothing durable forbids them and the
schema says `min: 1`, not integer. A work order whose own stored quantity is
missing or unusable is refused rather than divided by.

**Split-number format:** `WO-<last 8 chars of _id>` — the ID-derived fallback
this codebase already displays for a numberless work order
(`services/productionSyncService.js:106`,
`routes/…/dispatchRoutes.js:325`) and the same short id the unit barcode
`WO-<shortId>-<unit>` is built from. Deterministic, no second counter, and
unmistakable for a scan: all ten barcode parsers require `parts.length >= 3`
and this has two.

**Scaling basis:** the per-unit figure is now derived from the work order's
quantity *as the request arrived* (`basisQuantity`), not from `originalQuantity`
against an already-rescaled requirement.

**Preserved:** Store remains the stock authority (no reservation, no
deduction); the allocation-status vocabulary; the `planned` vs
`partial_allocation` outcome; split/no-split semantics; the response envelope;
and the unique index, which was not weakened.

**Explicitly NOT fixed here:** the discarded sufficiency calculation (#8) is
policy and belongs to Chunk 4B.

### A larger, pre-existing finding surfaced while fixing #1 — RESOLVED in 4A.2

**Neither canonical work-order generator sets `workOrderNumber` either.**
`routes/CMS_Routes/Sales/quotationRoutes.js:1868` and `:2768` both construct a
`WorkOrder` with no number, there is no pre-save hook and no counter, and the
field carries a unique, non-sparse index. Proven in an isolated database: the
first numberless work order saves, the second fails with
`E11000 … workOrderNumber: null`.

The many `wo.workOrderNumber || \`WO-${_id.slice(-8)}\`` fallbacks scattered
through the codebase exist precisely because the field is normally empty.

This was **not** fixed in 4A.1 — it would have meant changing a Sales write
path and deciding a numbering scheme, which that chunk was told to report
rather than invent. **Chunk 4A.2 resolved it** at the model boundary; see §12.
No existing document was renamed.

### Still unsafe after 4A.1

Twenty-two findings remain pinned as `CHARACTERISATION — UNSAFE` in the test
suite, including every one of: no authorization beyond authentication, no audit,
`complete-planning` validating nothing and overwriting any state, replay
destroying `plannedAt`, the discarded sufficiency limit, silent unit-conversion
pass-through, silently skipped operation ids, unstorable zero durations, and the
N+1 planning read. **Nothing in this pass makes the rest of planning safe.**


---

## 12. Chunk 4A.2 — canonical work-order identity (3 Sep 2026)

The systemic half of defect #1, fixed where it cannot be reintroduced.

### Every production creation path

Inventoried across the whole backend (`new WorkOrder`, `WorkOrder.create`,
`insertMany`, and every update capable of upserting — none upserts):

| Path | File | Assigned a number before 4A.2? |
|---|---|---|
| Sales generator A | `routes/CMS_Routes/Sales/quotationRoutes.js:1868` | **no** |
| Sales generator B | `routes/CMS_Routes/Sales/quotationRoutes.js:2768` | **no** |
| Return generator | `routes/CMS_Routes/Manufacturing/Return/returnRequestRoutes.js:340` | **no** |
| Rework generator | `routes/CMS_Routes/Manufacturing/Return/returnRequestRoutes.js:375` | **no** |
| Split child | `routes/CMS_Routes/Manufacturing/WorkOrder/workOrderRoutes.js:871` | only since 4A.1 |

Not production writers, and deliberately excluded: `seed_cad_test_orders.js`
(a hand-run seed script) and the test fixtures under `test/`.
`scripts/backfillOperationCodes.js`, `quotationRoutes.js:932`,
`manufacturingOrderRoutes.js:990` and `storeRoutes.js:430` issue updates only —
none can create a document.

### The invariant

`models/…/WorkOrder.js` now carries a `pre("validate")` hook and a
`WorkOrder.canonicalNumber(id)` static. A **new** document with no usable
number receives `WO-<full 24-character ObjectId>` before its first write.

`validate` rather than `save`, because it is the one document hook that fires
for every persistence API this repository uses — `new X().save()`,
`Model.create()` single and array, and `Model.insertMany()`, which runs no save
middleware at all. All four are covered by tests.

Guarded on `isNew`, so an existing numberless record is **never** renamed by an
unrelated save. The field is deliberately **not** `required`: that would refuse
to save a legacy document for an unrelated edit.

4A.1's explicit split-path assignment was **removed** — the model covers it, and
two numbering standards for newly created records would be worse than none.

### Why the full ObjectId, not its last eight characters

The eight-character form some readers display
(`services/productionSyncService.js:106`, `dispatchRoutes.js:325`) is a
**presentation fallback**, not an identity. It keeps 32 bits, and 32 bits behind
a unique index is a collision waiting for enough rows; a handful of passing
fixtures proves nothing about that. The full id is unique wherever ObjectIds
are, needs no counter or coordination service, and is known before the first
write.

### Compatibility evidence

The scan subsystem is **independent of `workOrderNumber`**. Every unit barcode
is built from `_id.slice(-8)` (`packagingRoutes.js:1249`,
`productionCompletionRoutes.js:331`, `embroideryRoutes.js:42`,
`manufacturingOrderRoutes.js:113`, `markAsDoneRoutes.js:113`) and resolved the
same way (11 `slice(-8)` call sites). None reads `workOrderNumber`, so none of
it moves.

Proven by test:

- the bare number is **not** parsed as a scan — `WO-<id>` is two segments and
  every parser requires `parts.length >= 3`;
- `WO-<id>-001` and `WO-<id>-007-3` both parse, yielding the whole id in the
  segment a parser calls the short id;
- **no parser asserts a segment length** — 24-, 8- and arbitrary-length
  segments all pass the same guard;
- legacy short-form and explicitly numbered records read exactly as before;
- `bulkCuttingRoutes.js:136`'s normaliser leaves a canonical number untouched;
- lookup by number resolves the record.

**Barcodes composed from `workOrderNumber` — corrected for returns.**
`returnRequestRoutes.js` built `${woDoc.workOrderNumber}-<unit>` from the work
order it had just created. Before 4A.2 that produced the literal
`"undefined-001"`, which fails every parser's `parts[0] === "WO"` guard
outright; after 4A.2 it produced `WO-<full id>-001`, which **parses and then
resolves to nothing**, because the resolvers compare against `_id.slice(-8)`.
A barcode that parses and resolves to nothing is a worse failure than one that
is rejected. See §13.

### Existing data — pre-check written, migration NOT executed

`scripts/migrations/work-order-number-backfill.js` **defaults to dry run** and
requires `--apply`. **It has not been connected to any database.** It reports:

- whether the unique `workOrderNumber` index actually exists, and whether it is
  sparse;
- the count of records whose number is missing, null or blank;
- duplicate non-empty numbers, with ids;
- and, when the index is absent while duplicate nulls exist, it says so — that
  combination is the signature of an index build that **failed** on legacy
  nulls, which is the likeliest reason creation never broke in production.

The migration assigns `WO-<_id>` to numberless records only, never renames a
non-empty number, refuses to run at all while duplicates exist, is restartable
and idempotent (its filter re-checks the numberless condition inside the write,
so a concurrent writer wins), logs every id it touches, and documents backup and
rollback. Ensuring the unique index is a **separate, later** step, only once the
report is clean.



---

## 13. Chunk 4A.2 corrections (3 Sep 2026)

Four corrections to the work delivered in §12. The identity invariant itself is
unchanged.

### 13.1 Return/rework scan barcodes

`returnRequestRoutes.js` now builds its person-wise barcodes through one named
helper, `scanBarcodeFor(workOrderId, unit)`, deriving the identifier from
**`_id.slice(-8)`** rather than from `workOrderNumber`.

| | Segment | Parses? | Resolves? |
|---|---|---|---|
| before 4A.2 | `undefined` | **no** | no |
| after 4A.2, before this correction | full 24-char ObjectId | yes | **no** |
| now | `_id.slice(-8)` | yes | **yes** |

**The two identities are separate concerns, and this is the boundary:**

- **`workOrderNumber`** — the canonical business identity,
  `WO-<full 24-character ObjectId>`, assigned by the model invariant.
  **Unchanged by this correction.**
- **the scan segment** — `_id.slice(-8)`, what every barcode in the codebase is
  built from (5 builders) and resolved by (11 resolvers).

The barcode **format** was not changed, no existing barcode value was rewritten,
no parser was touched, and the correction is confined to one call site.

**Proving the ROUTE uses it.** Because `assignedBarcodeIds` is discarded by
mongoose (§13.2), nothing about the persisted document reveals which builder
produced it — a regression to the old builder would leave a helper-level test
suite green. The route-wiring tests therefore intercept
`EmployeeProductionProgress.findOneAndUpdate`, capture the update object as the
route hands it over — **before** mongoose strips the unknown field — and call
through so the persisted ranges and assignments are still exercised for real.
They assert that each captured array is exactly the barcodes for that person's
unit range, that every captured barcode parses and resolves to the work order
the route created, that the two employees receive distinct contiguous ranges
with no gap or duplicate unit, and that no captured barcode carries the
canonical full-ObjectId segment, `undefined` or `null`.

Verified by reverting the route to the old builder: the four route-wiring tests
fail while all ten helper-level tests stay green — exactly the blind spot the
capture exists to close.

### 13.2 Barcode inventory — by behaviour, not line numbers

The earlier note said "four sites in quotationRoutes.js" while citing five
locations. Re-inventoried by what the code does, with stable context names
rather than line numbers.

**1. Distinct barcode-building paths — 5 in total, 4 still wrong.**

| Builder | Context | Builds from |
|---|---|---|
| `barcodesFor(woNumber, unitStart, unitEnd)` | shared local helper in `quotationRoutes.js` | `workOrderNumber` |
| inline loop | `POST /requests/:requestId/add-employees-batch` | `workOrderNumber` |
| inline loop | `createWorkOrdersAndProgress(request, userId)` | `workOrderNumber` |
| inline loop | `POST /requests/:requestId/add-employee` | `workOrderNumber` |
| `scanBarcodeFor(workOrderId, unit)` | `returnRequestRoutes.js` | **`_id.slice(-8)` — corrected** |

`barcodesFor` is itself called from two contexts — `replanUnitRange(...)` and
`PUT /requests/:requestId/person/:employeeId` — so four Sales *call sites* run
through three inline builders plus one shared helper.

**2. Persistence / propagation call sites — 8 in total.**

Seven in `quotationRoutes.js`: the three inline builders' own persisted objects,
the `replanUnitRange` assignment onto a progress document, the
`person/:employeeId` update, and two places that COPY an existing value forward
(`assignedBarcodeIds: pd.assignedBarcodeIds`). One in `returnRequestRoutes.js`,
the corrected `$set`.

(A ninth mention, `barcodeCount: assignedBarcodeIds.length`, is a response
counter and persists nothing.)

**3. Which paths build from `workOrderNumber`:** all four Sales paths. Since
Chunk 4A.2 that is the canonical `WO-<full ObjectId>`, so those barcodes would
parse and resolve to nothing. Only the return path is correct.

**4. Which values are silently discarded:** **all eight.**
`EmployeeProductionProgress` does not declare `assignedBarcodeIds`, and mongoose
is strict by default, so every one of these writes is dropped. No barcode from
any of these paths has ever reached the database — which is also why the Sales
defect has had no observable effect yet.

**The schema field is deliberately NOT added here.** Adding it would make all
eight persist, including the four that do not resolve. Pinned by a test so the
gap cannot be mistaken for working behaviour.

**Safe future sequence — in this order:**

1. Centralise every builder onto the established scan identity
   (`_id.slice(-8)`), replacing the inline loops and `barcodesFor`.
2. Characterise all consumers, and every barcode format already stored or
   printed, before changing what is written.
3. Only then add `assignedBarcodeIds` to the schema so values persist.
4. Verify newly stored values resolve through the real scanners.

Doing step 3 first would persist wrong data at scale.

### 13.3 Migration: exact write log

The backfill logged every candidate in a batch as written. A conditional update
matches nothing when another writer numbered the record between the read and the
write, so that log — **which is the rollback list** — could name records the
migration never touched. A rollback would then `$unset` a number somebody else
assigned.

Now: **per-record conditional updates**, and a record is logged as written only
when its update reports `modifiedCount === 1`. Concurrent records are reported
separately as skipped and are explicitly excluded from the rollback
instructions. The summary reports exact totals for examined, written,
concurrently skipped and failed. A restart still processes only records that are
still numberless. Bulk-write speed was traded for a trustworthy rollback list;
an administrative backfill is not a hot path.

**Exactly one outcome per candidate per run.** The loop re-selected "the first
N numberless records" every iteration. A *failed* record stays numberless, so it
reappeared in the next query and was examined, logged and counted again — for as
long as its batch-mates kept succeeding. `examined`, `failed` and the per-record
list were therefore wrong for any batch mixing a success with a failure. The
loop now pages on a stable `_id > lastId` cursor and advances past every
candidate before attempting its write, so within one invocation `written`,
`skipped` and `failed` are disjoint, cover every examined id, and
`examined === written + skipped + failed`. A failed record is not retried within
the run; a later invocation retries it, because it is still numberless. Batching
stays bounded and the batch size is injectable so the paging behaviour can be
tested.

### 13.4 Migration: one definition of a usable number

A usable number **must be a string whose trimmed value is non-empty**. Missing,
`null`, empty, whitespace-only and non-string values are all numberless. One
`$expr` now drives the numberless selector and the duplicate report, so they
cannot drift.

Previously the duplicate aggregation used a different exclusion list, so several
whitespace-only records were grouped as one duplicate `"   "` identity — both
misreporting them as a duplicate business identity and **blocking their own
backfill**. Real non-empty numbers are never normalised or trimmed by the
migration.

### 13.5 Migration: collisions, and what is NOT guaranteed

There are **two separate protections**, and neither is the other:

1. **Pre-flight collision detection.** Before any write, every canonical target
   is checked against numbers other documents already hold. Any conflict reports
   the target and both document ids and **refuses the whole apply before the
   first write**. This runs even when the unique index is absent — the index is
   what would otherwise catch such a collision, and its possible absence is the
   reason this script exists.
2. **Per-candidate concurrency guard.** Each conditional update re-asserts that
   *that document* is still numberless, so a value assigned by another writer
   between the read and the write is preserved rather than overwritten.

**Neither closes the cross-document target race.** An earlier draft of this
document claimed "each conditional write re-checks the condition, so a conflict
introduced after pre-flight fails safely". **That is not true without a unique
index.** Guard (2) proves only that the *candidate* is still numberless; it says
nothing about whether some *other* document acquired the candidate's target
string after the report. With no unique constraint, two documents can end up
holding the same number and both writes succeed.

All-or-nothing target uniqueness across concurrent writers requires one of:

- **(a)** an enforced compatible unique index on `workOrderNumber`, built before
  apply; or
- **(b)** **a deployment window in which all WorkOrder writers are stopped or
  quiesced** for the duration of the run.

This script does **not** install an index — that is its own deployment decision
with its own compatibility review, and the index cannot be built while duplicate
values exist. **So (b) is required when applying today**, and the script prints
that requirement at apply time. A post-run re-report will *detect* a duplicate
introduced by a concurrent writer: that is detection and rollback guidance, not
atomic prevention. No transaction was introduced.

The requirement is pinned by structural assertions in
`work-order-number-migration.test.js`, so the warning cannot disappear silently.

### 13.6 Still not executed

The migration has **not** been run against any database. It still defaults to a
dry run, still requires `--apply`, and still refuses to start without
`MONGODB_URI`. Its policy is tested against the isolated in-memory database
only (21 tests).
