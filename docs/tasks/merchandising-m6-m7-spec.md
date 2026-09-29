# Merchandising M6 + M7 — Implementation Specification

> **Status:** Ready for implementation. Prepared by Lane B so Lane A has no
> planning delay after M5.
>
> **Authority:** `docs/product/merchandising-app-final-plan.md` §6.8, §6.9, §7,
> §8, §9, §11 (M6, M7), §12. Companion: `docs/tasks/merchandising-m5-time-action-spec.md`.
>
> **Reuse, do not reinvent.** M0–M3 already establish every mechanism these two
> milestones need. Cited by file and line throughout.
>
> **Scope:** Specification only. No application file, handoff or
> `current-task.md` is changed by this document.

---

# PART A — M6: DEPARTMENT STATUS AND DOWNSTREAM HANDOVER

## 1. M6 purpose and boundary

**Purpose.** Merchandising can see every source department's own recorded
status, declare its own execution pack complete, and hand one immutable version
downstream to PPC — while every downstream owner keeps its authority.

**Exit (plan §11).** Merchandising can hand off a complete version while every
downstream owner retains its authority.

### 1.1 Two hard rules

| Rule | Enforcement |
|---|---|
| Merchandising never marks another department ready | Projections are **read-only, event-sourced**. No route accepts a Merchandising-authored department status. `POST /department-status` does not exist. |
| Merchandising cannot mutate a PPC record | PPC's receipt is **PPC-owned**, written by PPC's own route. Merchandising's outbox announces; it never writes across. |

### 1.2 The defect M6 closes

`services/merchandising/execution.service.js:50-58` maps the register's
`handed-over` view to lifecycle `HANDED_OVER`, with the comment *"the M6 state
no M2 command can produce — its view is honestly empty."*
`models/CMS_Models/Merchandising/ExecutionFile.js:46` confirms it:
`LIFECYCLE` is `OPEN | ON_HOLD | CLOSED | CANCELLED`.

**M6 step 1 is to make that view functional** — see §2.1.

### 1.3 Boundary with M4/M5

M6 **reads** and never writes: M3's approved selection revisions, M4's approved
development-requirement revision and approval register, M5's active baseline
and forecast. If M4's shape is not final, implement §4 against the reference
contract and bind M4's concrete ids last.

### 1.4 Explicitly not M6

Store stock decisions, PPC capacity/planning/release, IE routes, Quality
verdicts, Production scheduling, Logistics booking — read as status, never
authored. No supplier, rate, PO, consumption or cost. No change control (M7).

---

## 2. M6 models and state machines

All in `models/CMS_Models/Merchandising/`. All company-scoped, all date rules
per M5 §6.1 (calendar dates as `YYYY-MM-DD` strings; timestamps as `Date`).

### 2.1 `ExecutionFile` — two additive changes

```js
LIFECYCLE.HANDED_OVER = "HANDED_OVER"          // new enum member
executionPhase enum: ["INTAKE", "COORDINATION", "PACK_SUBMITTED", "HANDED_OVER"]
```

Plus:

| Field | Type | Notes |
|---|---|---|
| `currentPackVersionNo` | Number \| null | the submitted pack in force |
| `downstreamReceiptState` | String \| null | mirrored from PPC's receipt; display only |

`OPEN → HANDED_OVER` on PPC acceptance. `HANDED_OVER → OPEN` on PPC
clarification or Merchandising supersession. No other path.

### 2.2 `DepartmentStatusProjection`

One row per (file, department, sourceRecord). Written **only** by the intake
service.

| Field | Type | Notes |
|---|---|---|
| `companyId`, `fileId` | ObjectId | required, index, immutable |
| `projectionRef` | String | `DSP-` + 10 hex |
| `department` | Enum | §3.1 |
| `sourceApp` | String | the owning application's slug |
| `sourceRecordType`, `sourceRecordRef` | String | what the source calls it |
| `sourceRecordVersion` | Number \| null | |
| `statusCode` | String | must be in the department's allowlist (§3.2) |
| `statusLabel` | String | source-supplied display text |
| `availability` | Enum | `AVAILABLE` \| `UNKNOWN` \| `UNAVAILABLE` \| `NOT_APPLICABLE` — §3.3 |
| `unitDiscriminator` | String | when the status is per-unit; else `""` |
| `sourceObservedAt` | Date | when the **source** says it happened |
| `receivedAt` | Date | when Merchandising recorded it |
| `sourceEventId` | ObjectId | the event that carried it |
| `supersededByProjectionId` | ObjectId \| null | |
| `isCurrent` | Boolean | |

Indexes:
- unique `{companyId, fileId, department, sourceRecordRef, sourceRecordVersion}`
- partial unique `{companyId, fileId, department, sourceRecordRef}` where
  `isCurrent: true` — one current row per source record, database-enforced
- `{companyId, fileId, department, isCurrent: 1}`

**No `updatedBy`.** A projection has no Merchandising actor, by construction —
the same rule `handoverIntake.onIssued` follows with `source: "sales"` and no
actor.

### 2.3 `ExecutionPack`

| Field | Type | Notes |
|---|---|---|
| `companyId`, `fileId` | ObjectId | immutable |
| `packVersionNo` | Number | `min: 1`, immutable |
| `state` | Enum | §2.5 |
| `contents` | Subdoc | §4.1 — **immutable after submission** |
| `completeness` | Subdoc | the gate result frozen at submission (§4.2) |
| `declaration` | Subdoc | `{statement, byActor, at}` — §4.3 |
| `submittedBy`/`submittedAt` | actorRef/Date | |
| `supersedesPackVersionNo`, `supersededByPackVersionNo`, `supersededAt` | | |
| `withdrawnBy`/`withdrawnAt`/`withdrawalReason` | | DRAFT only |
| `revision` | Number | optimistic concurrency |

Indexes:
- unique `{companyId, fileId, packVersionNo}`
- partial unique `{companyId, fileId}` where `state: "DRAFT"` (`one_draft_pack_per_file`)
- partial unique `{companyId, fileId}` where `state: "SUBMITTED"` (`one_submitted_pack_per_file`)

**Immutability guard.** A pre-save hook rejects every change to `contents`,
`completeness` and `declaration` once `state !== "DRAFT"`. Same device as
`SelectionRevision`'s published-version guard.

### 2.4 `DownstreamHandoverReceipt` — **PPC-owned**

Copied in shape from `models/CMS_Models/Merchandising/HandoverReceipt.js`, which
is the audited receiver-owned pattern. Lives in `models/CMS_Models/PPC/`.

| Field | Type | Notes |
|---|---|---|
| `companyId` | ObjectId | immutable |
| `packId`, `packVersionNo`, `fileId` | | immutable |
| `state` | Enum | `ACCEPTED` \| `CLARIFICATION_REQUESTED` \| `SUPERSEDED` \| `CANCELLED_BY_MERCHANDISING` |
| `clarification` | Subdoc | `{category (enum), reason (min 15), byActor, at}` |
| `decidedBy`/`decidedAt` | actorRef/Date | |

unique `{companyId, packId}`.

**`PENDING` is computed, not stored** — a pack with no receipt row is pending.
**There is no `REJECTED`.** PPC asks for clarification; it does not reject a
commercial commitment, exactly as Merchandising cannot decline a Sales handover.

### 2.5 Pack state machine

```
DRAFT ──submit──► SUBMITTED ──PPC accepts──► ACCEPTED ──► (file HANDED_OVER)
  │                   │                          │
  │                   ├─PPC requests clarification─┴──► CLARIFICATION_REQUESTED
  │                   │        (file returns to OPEN; new DRAFT allowed)
  │                   └─Merchandising supersedes──► SUPERSEDED
  └─withdraw (DRAFT only)──► WITHDRAWN
                            any ──file CANCELLED──► CANCELLED
```

| Transition | Capability | Notes |
|---|---|---|
| create `DRAFT` | `HANDOVER_SUBMIT` | snapshots current references |
| `DRAFT → SUBMITTED` | `HANDOVER_SUBMIT` | completeness gate must pass; contents freeze |
| `SUBMITTED → ACCEPTED` | PPC's own | receiver route; mirrors file to `HANDED_OVER` |
| `SUBMITTED → CLARIFICATION_REQUESTED` | PPC's own | file returns to `OPEN` |
| `SUBMITTED → SUPERSEDED` | `HANDOVER_SUBMIT` | new pack version submitted |
| `DRAFT → WITHDRAWN` | `HANDOVER_SUBMIT` | reason required |
| any → `CANCELLED` | receiver only | mirrored from Sales cancellation |

---

## 3. Department projection contract

### 3.1 Departments

`PRODUCT_DEVELOPMENT`, `SUPPLY_CHAIN`, `STORE`, `IE`, `PPC`, `QUALITY`,
`PRODUCTION`, `LOGISTICS`.

### 3.2 Allowlisted statuses

One frozen map, `services/merchandising/departmentStatus.contract.js`. A
`statusCode` outside its department's list is **refused at intake** and recorded
as a `NOOP` with the reason — never stored as free text.

| Department | Allowlisted `statusCode` |
|---|---|
| `PRODUCT_DEVELOPMENT` | `TECHPACK_ISSUED`, `PATTERN_READY`, `SAMPLE_IN_PROGRESS`, `SAMPLE_SUBMITTED`, `SAMPLE_APPROVED`, `SAMPLE_REJECTED` |
| `SUPPLY_CHAIN` | `SOURCING_STARTED`, `PO_PLACED`, `SUPPLIER_CONFIRMED`, `IN_TRANSIT`, `SOURCING_BLOCKED` |
| `STORE` | `AWAITING_RECEIPT`, `PARTIALLY_RECEIVED`, `RECEIVED`, `ISSUED`, `SHORTAGE_RECORDED` |
| `IE` | `ROUTE_DRAFT`, `ROUTE_RELEASED`, `SAM_PUBLISHED` |
| `PPC` | `PLAN_PENDING`, `CAPACITY_BOOKED`, `LINE_ALLOCATED`, `RELEASED_TO_PRODUCTION` |
| `QUALITY` | `TEST_PENDING`, `TEST_PASSED`, `TEST_FAILED`, `INSPECTION_PASSED`, `INSPECTION_FAILED`, `ON_HOLD` |
| `PRODUCTION` | `NOT_STARTED`, `CUTTING`, `SEWING`, `FINISHING`, `COMPLETED` |
| `LOGISTICS` | `BOOKING_PENDING`, `BOOKED`, `DOCUMENTS_READY`, `DISPATCHED` |

These are **status names, not permissions**. Recording `RELEASED_TO_PRODUCTION`
is Merchandising observing PPC's own statement, never Merchandising releasing.

### 3.3 Availability — the four honest answers

| Value | Meaning | Rendered |
|---|---|---|
| `AVAILABLE` | a source event has been received | the status + freshness |
| `UNKNOWN` | the department applies but has said nothing yet | *"Not yet reported by Product Development"* |
| `UNAVAILABLE` | the source app is not integrated / delivery failing | *"Product Development is not reporting to Merchandising yet"* |
| `NOT_APPLICABLE` | the source declared it does not apply | *"Not applicable"* |

`UNKNOWN` is the **default** for every expected department with no row. It is
never rendered as a zero, a blank, or a green tick. This is the plan's §11 M6
requirement: *"explicit unknown/unavailable states instead of guessed readiness."*

### 3.4 Freshness

Derived, not stored:

```
ageDays = todayInZone(tz) - dateOf(sourceObservedAt)
freshness = ageDays <= 3  ? "FRESH"
          : ageDays <= 14 ? "AGEING"
          :                 "STALE"
```

`STALE` is displayed, never acted on. A stale status is still the source's
status; Merchandising does not expire another department's fact.

### 3.5 Intake

`services/merchandising/departmentStatusIntake.service.js`, copying
`handoverIntake.service.js` exactly: one handler per event kind,
`{outcome: "APPLIED"|"NOOP", note}`, a `MerchandisingIntakeLedger` row keyed on
the unique+immutable `sourceEventId`, `11000` → `{duplicate: true}`.

**Stale-event rule.** Apply only if `sourceObservedAt` is **later** than the
current row's, or no current row exists. An older event is a `NOOP` with a note.
Superseding sets `isCurrent: false` on the previous row and keeps it.

**Matching.** Events carry `{handoverRef, handoverLineRef}` — M2.1's permanent
line identity, never a style id — resolved against `ExecutionFile`'s unique
immutable index.

---

## 4. Execution Pack contract

### 4.1 `contents` — exact references, no copies

Every entry is a **reference plus the version it pointed at**, so the pack is
reproducible and cannot drift.

| Key | Reference |
|---|---|
| `salesHandover` | `{versionId, versionNo, handoverRef, handoverLineRef, acceptedAt}` |
| `materialTrim` | `{revisionId, revisionNo, approvedAt, approvedByName}` (M3) |
| `packaging` | `{revisionId, revisionNo, approvedAt, approvedByName}` (M3) |
| `developmentRequirements` | `{revisionId, revisionNo, approvedAt}` (M4) |
| `approvalRegister` | `{position: "COMPLETE"\|"OUTSTANDING", outstandingCount, entries[{approvalRef, state, decidedAt}]}` (M4) |
| `timeAndAction` | `{planId, baselineNo, baselineApprovedAt, templateVersionId, calendarVersionId}` (M5) |
| `forecastPosition` | `{asOf, milestonesTotal, completed, overdue, forecastLate, deliveryAtRisk: Boolean}` (M5) |
| `executionUnits[]` | `{unitDiscriminator, quantity, dropRef, active}` (M2.1) |
| `declaration` | §4.3 |

`forecastPosition` is a **snapshot with `asOf`**, explicitly labelled as the
forecast at submission — not a live figure, and not a promise.

### 4.2 Completeness gates — Merchandising's own facts only

| Gate | Passes when | Owner |
|---|---|---|
| `HANDOVER_ACCEPTED` | a CURRENT accepted Sales handover version exists | Sales fact, Merchandising's acceptance |
| `MATERIAL_TRIM_APPROVED` | an APPROVED M3 material/trim revision exists | Merchandising |
| `PACKAGING_APPROVED` | an APPROVED M3 packaging revision exists | Merchandising |
| `DEVELOPMENT_APPROVED` | an APPROVED M4 requirements revision exists | Merchandising |
| `APPROVALS_SETTLED` | no outstanding Merchandising-owned approval | Merchandising |
| `TNA_BASELINED` | plan has an ACTIVE baseline | Merchandising |
| `UNITS_RECONCILE` | active units total the confirmed line quantity | Merchandising (M2.1 rule) |

**Every gate is a Merchandising-owned fact.** There is deliberately **no gate**
on Store stock, PPC capacity, supplier confirmation or Quality results. Gating
Merchandising's submission on another department's readiness would make
Merchandising the judge of that department's work — the exact inversion the
plan forbids (§6.8).

Department projections are **shown beside the gates as context**, clearly
separated and never counted. A pack may be submitted with every department
`UNKNOWN`; that is a legitimate state and PPC decides what to do about it.

`completeness` stores `{gates: [{key, passed, detail}], allPassed, evaluatedAt}`
frozen at submission — the pack records what was true when it was sent.

### 4.3 Declaration

A single explicit statement, stored with actor and time:

> *"Merchandising's execution pack for this order line is complete as stated in
> version N. Each reference above is an approved Merchandising record. Source
> department status is shown as reported and is not a Merchandising assertion."*

Submission requires the declaration; the API refuses without it.

### 4.4 Immutability

After `SUBMITTED`, `contents`, `completeness` and `declaration` are frozen. A
change means a **new pack version** superseding the old, which is kept. Never an
edit. Same discipline as M3 revisions and M5 baselines.

---

## 5. PPC handover contract

### 5.1 Flow

```
Merchandising                          PPC
─────────────                          ───
POST /files/:id/pack/submit
  ├─ txn: pack SUBMITTED
  │       + audit event
  │       + outbox row               ← one transaction, Merchandising records only
  └─ after commit: deliverPending()
                        ──event──►  PPC receiver
                                    ├─ writes DownstreamHandoverReceipt (PPC-owned)
                                    ├─ ledger row on sourceEventId
                                    └─ accept | request clarification
                        ◄─event──   merchandising receiver mirrors file state
```

### 5.2 Non-negotiables (all already implemented patterns)

| Requirement | Mechanism | Precedent |
|---|---|---|
| No cross-app transaction | delivery runs **after** commit | `salesHandoverDelivery.service.js` |
| No direct PPC model write from Merchandising | PPC's route writes PPC's receipt | `handoverIntake.service.js` inversion |
| Idempotent | `MerchandisingIntakeLedger.sourceEventId` unique + immutable | M1 |
| Retryable | outbox status `PENDING`\|`DELIVERED` — **no terminal FAILED** | `SalesHandoverEvent.js:105` |
| Retry records attempts | `attempts`, `lastError`, `lastAttemptAt` | M1 |
| Ordered | sort `{occurredAt: 1, _id: 1}` | M1 |
| Duplicate is a delivery | mark delivered on `duplicate: true` | M1 |

### 5.3 Supersession and cancellation

- **Supersession** — submitting pack *n+1* sets *n* to `SUPERSEDED` and emits
  `merchandising.execution_pack.superseded`. PPC's receipt for *n* moves to
  `SUPERSEDED`; its decision on *n* is preserved.
- **Cancellation** — a Sales cancellation mirrors through the **existing**
  `handoverIntake.onCancelled`, extended to also mark the pack `CANCELLED`.
  Merchandising never authors it.

### 5.4 Making `Handed Over` functional

1. Add `HANDED_OVER` to `LIFECYCLE` (`ExecutionFile.js:46`).
2. `FILE_VIEWS` (`execution.service.js:55`) already maps it — no change.
3. PPC acceptance moves the file `OPEN → HANDED_OVER`, `executionPhase → HANDED_OVER`.
4. PPC clarification moves it back to `OPEN`.
5. Register row gains the receipt state; the `handed-over` tab count becomes
   real in `getExecutionOverview`.
6. Remove the *"honestly empty"* comment; the view now has records.

---

## 6. M6 APIs, events and permissions

### 6.1 Routes — `routes/CMS_Routes/Merchandising/handoverPackRoute.js`

```
GET   /files/:id/department-status                     FILE_READ    all departments, availability + freshness
GET   /files/:id/department-status/:department         FILE_READ    history, newest first, cursor
GET   /files/:id/pack                                  FILE_READ    current pack + gate results
GET   /files/:id/pack/versions                         FILE_READ    cursor
GET   /files/:id/pack/versions/:packVersionNo          FILE_READ    frozen
POST  /files/:id/pack                                  HANDOVER_SUBMIT  create DRAFT (snapshot)
POST  /files/:id/pack/refresh                          HANDOVER_SUBMIT  re-snapshot a DRAFT
POST  /files/:id/pack/submit                           HANDOVER_SUBMIT  gate + freeze + outbox
POST  /files/:id/pack/withdraw                         HANDOVER_SUBMIT  DRAFT only, reason
GET   /files/:id/pack/receipt                          FILE_READ    PPC's decision, read-only
POST  /downstream/delivery/retry                       HANDOVER_SUBMIT  drain pending
```

PPC's own routes (PPC application, not Merchandising):

```
GET   /api/cms/ppc/inbound-packs                       PPC capability
POST  /api/cms/ppc/inbound-packs/:packId/accept        PPC capability
POST  /api/cms/ppc/inbound-packs/:packId/clarify       PPC capability   category + reason ≥15
```

All mutations take `idempotencyKey`; all record mutations take
`expectedRevision`. Lists return `{rows, nextCursor, hasMore}`.

### 6.2 Events

`OUTBOX_KIND` additions (dotted form, per `MerchandisingEvent.js`):

```
merchandising.execution_pack.submitted
merchandising.execution_pack.superseded
merchandising.execution_pack.withdrawn
```

Consumed by Merchandising (department status + PPC receipt mirroring):

```
product_development.sample.status_changed
supply_chain.sourcing.status_changed
store.material.status_changed
ie.route.released
ppc.plan.status_changed
quality.result.recorded
production.progress.recorded
logistics.shipment.status_changed
ppc.inbound_pack.accepted
ppc.inbound_pack.clarification_requested
```

`AUDIT_ACTIONS` additions: `PACK_DRAFTED`, `PACK_REFRESHED`, `PACK_SUBMITTED`,
`PACK_WITHDRAWN`, `PACK_SUPERSEDED`, `PACK_ACCEPTED_BY_PPC`,
`PACK_CLARIFICATION_REQUESTED_BY_PPC`, `DEPARTMENT_STATUS_OBSERVED`.

### 6.3 Permissions

| Action | Capability | Role |
|---|---|---|
| Read status, pack, receipt | `FILE_READ` | viewer |
| Create / refresh / withdraw a draft pack | `HANDOVER_SUBMIT` | approver |
| Submit a pack | `HANDOVER_SUBMIT` | approver |
| Retry delivery | `HANDOVER_SUBMIT` | approver |
| Author a department status | — | **no path exists** |
| Accept / clarify a pack | PPC's own | PPC |

`HANDOVER_SUBMIT` already exists at approver in `access.service.js:125`. **No
new capability constant.** `isAdmin` grants nothing; assignment grants nothing.

### 6.4 Error codes

`PACK_NOT_FOUND`, `PACK_EXISTS`, `PACK_IMMUTABLE`, `PACK_GATE_FAILED`
(details list every failed gate), `PACK_DECLARATION_REQUIRED`,
`PACK_STATE_CONFLICT`, `PACK_ALREADY_DECIDED`, `DEPT_STATUS_NOT_ALLOWLISTED`,
`DEPT_STATUS_STALE`.

---

## 7. M6 frontend

**No new navigation destination.** Nav stays Overview / Order Execution /
Time & Action (plan §3). Everything below is inside the Execution File or the
existing registers.

### 7.1 New tab — `Department Status & Handover`

`TABS` becomes seven. Update the pinned tab-list test in
`app/merchandiser/merchandisingShell.test.mjs` in the same commit.

**Composition** (frozen Accounting language, unchanged):
`frost-panel border border-hairline rounded-card` bands, `Badge`, desktop table
in a bounded `md:overflow-y-auto` scrollport with a sticky opaque header,
`md:hidden` mobile cards.

**a) Department status register**

Desktop columns: Department · Status · Source record · Reported · Freshness.
`Badge` variants: `AVAILABLE` slate/emerald by status semantics, `UNKNOWN`
slate, `UNAVAILABLE` amber, `NOT_APPLICABLE` slate.
Every row shows *"as reported by <App>"* — no row may read as a Merchandising
statement. Mobile cards: department, status badge, reported date.
All eight departments always render; missing ones show `UNKNOWN` with the
sentence, never an empty row.

**b) Execution Pack preview**

Gate checklist — each gate with pass/fail and, on failure, the sentence saying
what is missing and which tab fixes it. Below it, the reference list with
version numbers. Department status appears in a **visually separate** band
titled *"Source department status — context, not a gate"*.

**c) Submit**

`MerchandisingDialog` (existing focus trap, Escape, focus restore, busy guard):
the declaration text, an explicit acknowledgement control, and the gate summary.
Confirm disabled until all gates pass and the declaration is acknowledged.

**d) Receipt and history**

Receipt band: PPC's decision, decider, time; a clarification shows its category
and reason verbatim. Version history: every pack version, state, submitted/decided
times, each opening its frozen preview.

**e) Role-aware**

Viewer sees everything, no controls. Approver gets draft/refresh/submit/withdraw.
Controls that a role may never use are **not rendered** — the M2 rule.

### 7.2 Register and Overview

- `Handed Over` view becomes populated; row gains a receipt-state `Badge`.
- Overview gains one count: `Awaiting PPC decision`, opening the `handed-over`
  view filtered to pending. Failed read → *"Couldn't check"*, never zero.
- Summary tab gains a `Downstream` fact group: pack version, state, receipt.

---

## 8. M6 tests and implementation sequence

### 8.1 Tests — `test/merchandising/`

| Area | Assertions |
|---|---|
| Company isolation | packs, projections, receipts invisible cross-company by id |
| Capability matrix | every §6.3 row, plus the role below it; admin/Sales/other-dept refused; revocation on next request |
| No Merchandising-authored status | no route, service export or model path allows it; source scan finds no such handler |
| Allowlist | out-of-list `statusCode` → `NOOP` with reason; never stored |
| Availability | all four render distinctly; a department with no row is `UNKNOWN`, never a tick |
| Freshness | FRESH/AGEING/STALE boundaries; stale still displays the source status |
| Pack immutability | post-submit `contents`/`completeness`/`declaration` edits rejected; superseded pack readable and unchanged |
| Gates | each gate fails independently with its own sentence; **no gate references Store/PPC/supplier/Quality**; submission succeeds with all departments `UNKNOWN` |
| Concurrency | two concurrent submits → one wins, one `PACK_EXISTS` from the partial unique index |
| PPC receipt | Merchandising cannot write it; PPC accept → file `HANDED_OVER`; clarification → back to `OPEN`; no `REJECTED` in the enum |
| Idempotency | redelivery finds the ledger row, `duplicate: true`, no second write; concurrent delivery → `11000` handled |
| Stale events | older `sourceObservedAt` is a `NOOP`; event for a cancelled file is a `NOOP` |
| No cross-app txn | receiver failure leaves outbox `PENDING`, retryable, Merchandising act committed |
| `Handed Over` view | returns records; count is real; the "honestly empty" comment is gone |
| Frontend/a11y | seven tabs pinned; tablist contract; dialog focus; mobile cards, no horizontal scroll; every status row attributes its source |
| No authority import | source scan of the M6 surface finds no rate, supplier, PO, consumption, stock decision, capacity or release verb |

### 8.2 Sequence

| # | Step | Exit |
|---|---|---|
| 1 | `HANDED_OVER` lifecycle + `executionPhase` values | register view functional, existing suites green |
| 2 | `DepartmentStatusProjection` + allowlist contract | allowlist/availability/freshness tests |
| 3 | `departmentStatusIntake.service.js` + delivery | idempotency + stale-event tests |
| 4 | `ExecutionPack` model + immutability guard | immutability + concurrency tests |
| 5 | Gates + snapshot + declaration | gate tests, incl. the no-foreign-gate assertion |
| 6 | Submit + outbox + audit | events tests |
| 7 | PPC receipt model + PPC routes + mirroring | receipt tests |
| 8 | Frontend: API client + tab + registers | a11y/mobile tests |
| 9 | Overview/register/Summary integration | source-backed only |
| 10 | Verification + handoff | two orderings, tsc, build, `git diff --check`; **not** declared frozen |

---

# PART B — M7: CHANGE CONTROL AND ENTERPRISE SCALE

## 9. M7 purpose and boundary

**Purpose.** A buyer-authorised change reaches Merchandising as a versioned
notice; Merchandising records only the internal execution impact, sends the
versioned change to affected applications, tracks their acknowledgements, and
reforecasts T&A — while every prior approved revision and baseline is preserved.

**Exit (plan §11).** The same operating model works across companies, divisions,
factories, buyers, teams and high-volume history.

### 9.1 Hard rules

| Rule | Enforcement |
|---|---|
| Sales owns and authorises commercial change | Merchandising has **no** change-creation route. Intake only. |
| No buyer communication in Merchandising | The notice payload allowlist excludes message, email, contact, thread, quotation, price, terms. Refused at intake. |
| Never overwrite an approved revision | Impact creates a **new** M3/M4 revision; the old is superseded and kept. |
| Never overwrite a T&A baseline | Impact triggers M5's baseline **revision** (new `baselineNo`); the old is kept. |
| Each application owns its acknowledgement | Receiver-owned receipts; Merchandising never writes one. |

### 9.2 Not M7

No Sales CRM, Tasks, Store or PPC screens inside Merchandising. No new daily
navigation destination — configuration is manager-only and reached from app
settings (plan §3).

---

## 10. Sales change-intake contract

### 10.1 `SalesChangeNotice` — **Sales-owned**, `models/CMS_Models/Sales/`

| Field | Type | Notes |
|---|---|---|
| `companyId` | ObjectId | immutable |
| `changeRef` | String | `CHG-` + 12 hex — **stable identity across versions** |
| `versionNo` | Number | immutable |
| `handoverRef`, `handoverLineRef` | String | M2.1 line identity — **never a style id** |
| `state` | Enum | `ISSUED` \| `SUPERSEDED` \| `CANCELLED` |
| `changeKind` | Enum | `QUANTITY` \| `DELIVERY_DATE` \| `SPLIT` \| `PACKING_REQUIREMENT` \| `TESTING_REQUIREMENT` \| `DELIVERY_REQUIREMENT` \| `STYLE_REFERENCE` \| `CANCELLATION` |
| `before`, `after` | executionProjection subset | **the typed M2.1 projection schema**, not `Mixed` |
| `authorisedBy`, `authorisedAt` | actorRef/Date | Sales' authority |
| `effectiveFrom` | DateOnly | |

Partial unique `{companyId, changeRef}` where `state: "ISSUED"` — one current
version per change. Written only by Sales, in the same transaction as its audit
and outbox rows — the M1 producer pattern (`merchandisingHandover.service.js`).

### 10.2 Payload allowlist

`before`/`after` accept **only** fields already in
`models/CMS_Models/Sales/executionProjection.js`. Anything else is refused at
issue with `CHANGE_FIELD_NOT_ALLOWED` naming the field and its owner. Mongoose
`strict: true` strips the rest, so nothing unexpected can persist or escape.

### 10.3 `ChangeIntakeReceipt` — Merchandising-owned

| Field | Notes |
|---|---|
| `companyId`, `changeRef`, `changeVersionNo`, `noticeId`, `fileId` | immutable |
| `state` | `ACKNOWLEDGED` \| `CLARIFICATION_REQUESTED` \| `SUPERSEDED` \| `CANCELLED_BY_SALES` |
| `clarification` | `{category, reason ≥15, byActor, at}` |

unique `{companyId, noticeId}`. **`PENDING` computed, not stored. No
`REJECTED`** — Merchandising cannot reject a commercially authorised change; it
asks Sales for clarification. Identical to `HandoverReceipt`.

Intake via `services/merchandising/changeIntake.service.js`, the
`handoverIntake` pattern: ledger on `sourceEventId`, `11000` → duplicate, no
backwards movement, stale version → `NOOP`.

---

## 11. Impact and acknowledgement contracts

### 11.1 `ChangeImpact` — Merchandising-owned

| Field | Type | Notes |
|---|---|---|
| `companyId`, `changeRef`, `changeVersionNo`, `fileId` | | immutable |
| `impactRef` | String | `IMP-` + 10 hex |
| `state` | Enum | `DRAFT` \| `ASSESSED` \| `COORDINATED` \| `CLOSED` |
| `affectedUnits[]` | String | `unitDiscriminator` list (M2.1) |
| `materialTrimImpact` | Subdoc | `{impacted, newRevisionNo, note}` |
| `packagingImpact` | Subdoc | same shape |
| `developmentImpact` | Subdoc | same shape (M4) |
| `approvalImpact` | Subdoc | `{reopenedApprovalRefs[], note}` |
| `tnaImpact` | Subdoc | `{baselineRevisionNo, milestonesMoved, deliveryAtRisk}` (M5) |
| `downstreamImpact` | Subdoc | `{packSupersededVersionNo, resubmissionRequired}` (M6) |
| `affectedApplications[]` | Enum | which receivers are notified |
| `coordinationReason` | Subdoc | `{reasonCode, note ≥15}` |
| `decision` | Enum | `ABSORB` \| `REVISE` \| `ESCALATE_TO_SALES` |
| `assessedBy`/`coordinatedBy` | actorRef | |
| `revision` | Number | |

unique `{companyId, changeRef, changeVersionNo, fileId}`.

**Impact never mutates in place.** Each sub-impact records the **new** revision
number the change produced. M3/M4 revisions supersede; M5 revises the baseline.
Prior versions are preserved and readable — the rule already enforced by those
milestones' immutability guards.

### 11.2 `ChangeAcknowledgement` — receiver-owned, one per application

Lives in each receiving application's namespace. Merchandising reads, never
writes.

| Field | Notes |
|---|---|
| `companyId`, `changeRef`, `changeVersionNo`, `application` | immutable |
| `state` | `PENDING` (computed) \| `ACCEPTED` \| `CLARIFICATION_REQUESTED` \| `REJECTED_AS_INVALID` |
| `reason` | required for the latter two, ≥15 chars |
| `sourceVersionAcknowledged` | Number — **which version was acknowledged** |

`REJECTED_AS_INVALID` exists here (unlike the Sales/PPC receipts) for one
narrow case: the receiver can prove the change does not apply to it. It is a
statement about applicability, not a veto of the commercial change.

**Staleness.** An acknowledgement naming an older `changeVersionNo` than the
current one is recorded and shown as `STALE` — never counted as coverage.

Delivery, retry, ordering, idempotency: the M1 outbox mechanism, unchanged.

---

## 12. Bulk operations

### 12.1 Universal contract

Every bulk command is two calls. **No all-or-nothing lie.**

```
POST /merchandising/bulk/:command/preview   → { previewId, expiresAt, rows[], summary }
POST /merchandising/bulk/:command/apply     → { previewId, rows[], summary, resultFileId }
```

| Rule | Detail |
|---|---|
| Preview writes nothing | except the preview record itself |
| Apply requires `previewId` | mismatch → `BULK_PREVIEW_STALE`; re-preview |
| Per-row result | `{rowIndex, fileId, ref, outcome: APPLIED\|SKIPPED\|REFUSED, reason}` |
| Partial failure reported | a refused row never discards applied rows |
| Idempotent | `idempotencyKey` per call, reusing `once()` |
| Cap | 500 rows; over is an explicit refusal, never silent truncation |
| Downloadable | `resultFileId` → `GET /merchandising/bulk/results/:id.csv`, generated server-side, `EXPORT` capability |

### 12.2 Commands

| Command | Capability | Notes |
|---|---|---|
| `assignment` | `FILE_ASSIGN` (owner) | assignee must hold a live merchandiser grant; grants no authority |
| `forecast` | `TNA_EXECUTE` | forecast only |
| `reschedule` | `TNA_MANAGE` | reuses M5's per-milestone impact; baseline-breaching rows flagged in preview |
| `change-coordination` | `CHANGE_COORDINATE` | one impact per file |
| `downstream-submit` | `HANDOVER_SUBMIT` | **only rows whose gates all pass**; others `REFUSED` with the failing gate named |
| `import` | `CONFIGURATION_MANAGE` | templates/calendars/reason codes only — **never orders, never selections** |

---

## 13. Enterprise scale and observability

### 13.1 Scope

`companyId` on every record (existing). M7 adds optional `divisionRef`,
`teamRef`, `factoryRef` to `ExecutionFile`, populated from the projection where
present. All are **filters**, never permission boundaries — authority stays the
company-scoped `DepartmentRole`.

### 13.2 Configuration — manager-only, not a destination

All template, calendar, reason-code, division/team and retention configuration
sits behind `CONFIGURATION_MANAGE` (owner) at `/merchandiser/settings/*`,
reached from app settings. **It does not appear in `MERCHANDISING_NAV`**, which
stays at three entries (plan §3).

### 13.3 Indexes

| Collection | Index |
|---|---|
| `ExecutionFile` | `{companyId, lifecycleStatus, updatedAt: -1, _id: -1}` (exists); add `{companyId, buyerRef, updatedAt: -1}`, `{companyId, factoryRef, updatedAt: -1}` |
| `TnaMilestone` | `{companyId, status, forecastDate, _id}`; `{companyId, ownerDepartment, status}` |
| `DepartmentStatusProjection` | `{companyId, fileId, department, isCurrent}` |
| `ExecutionPack` | `{companyId, state, submittedAt: -1}` |
| `ChangeImpact` | `{companyId, changeRef, changeVersionNo}` |
| Outbox | `{status, occurredAt, _id}` (exists) |
| Audit | `{companyId, recordType, recordId, at: -1}`; `{companyId, at: -1}` for search |

Pagination is cursor-based everywhere, `{rows, nextCursor, hasMore}`, `limit`
capped. **No `skip`** — it degrades linearly and is wrong under insertion.

### 13.4 History, archive, retention

- Audit events are append-only and never edited or deleted.
- Files `CLOSED` or `HANDED_OVER` beyond a configured age are marked
  `archived: true` and excluded from default register queries; still readable by
  direct reference and still exportable. **Archiving hides, it never deletes.**
- Retention is configuration with a floor: audit and outbox rows are never
  purged below the statutory minimum, and any purge is itself audited.
- Partition by `{companyId, createdAt}` when a collection exceeds the agreed
  threshold; a partition move changes no identity.

### 13.5 Observability

| Surface | Content |
|---|---|
| `GET /merchandising/ops/outbox` | counts by kind and status; oldest pending age |
| `GET /merchandising/ops/receipts` | acknowledgement coverage per change version |
| `GET /merchandising/ops/stuck` | pending > threshold, or `attempts >= N`, with `lastError` |
| `POST /merchandising/ops/retry` | drains; `HANDOVER_SUBMIT` |

**Stuck-event alerting is a query, not a daemon.** No timer, no broker, no
background worker — the same position `salesHandoverDelivery.service.js`
already documents. A stuck row is surfaced on the Integration health panel and
in the ops endpoint; a human or an existing scheduler drains it.

### 13.6 Exports

`EXPORT` capability (owner). Server-generated CSV of the caller's **current
filtered view only**, company-scoped, audited with the filter that produced it.
No export contains rate, cost, margin, supplier or buyer contact.

---

## 14. M7 APIs, events and permissions

### 14.1 Routes

```
GET   /files/:id/changes                          FILE_READ           notices + impacts, newest first
GET   /files/:id/changes/:changeRef               FILE_READ           notice, before/after, impact, acks
POST  /files/:id/changes/:changeRef/acknowledge   CHANGE_COORDINATE   Merchandising's intake receipt
POST  /files/:id/changes/:changeRef/clarify       CHANGE_COORDINATE   category + reason ≥15
POST  /files/:id/changes/:changeRef/impact        CHANGE_COORDINATE   create/assess
POST  /files/:id/changes/:changeRef/impact/coordinate  CHANGE_COORDINATE  emit to affected apps
GET   /files/:id/changes/:changeRef/acknowledgements   FILE_READ       per application, with staleness
GET   /merchandising/changes?state=&cursor=       FILE_READ           portfolio
POST  /merchandising/bulk/:command/preview        per §12.2
POST  /merchandising/bulk/:command/apply          per §12.2
GET   /merchandising/bulk/results/:id.csv         EXPORT
GET   /merchandising/reports/:report              FILE_READ           source-backed only
GET   /merchandising/audit/search?q=&from=&to=    FILE_READ           cursor
GET   /merchandising/ops/*                        per §13.5
GET|POST /merchandising/config/*                  CONFIGURATION_MANAGE
```

Sales' own: `POST /api/cms/sales/change-notices/...` (issue, supersede, cancel)
— Sales authority, `handoverAuthority.js`'s live-grant pattern, never
`bypassesApproval`.

### 14.2 Events

Emitted:
```
merchandising.change_impact.coordinated
merchandising.change_impact.closed
merchandising.execution_pack.superseded      (reused from M6)
```

Consumed:
```
sales.change_notice.issued | .superseded | .cancelled
<app>.change_acknowledgement.recorded         (per receiving application)
```

`AUDIT_ACTIONS` additions: `CHANGE_OBSERVED`, `CHANGE_ACKNOWLEDGED`,
`CHANGE_CLARIFICATION_REQUESTED`, `CHANGE_IMPACT_ASSESSED`,
`CHANGE_IMPACT_COORDINATED`, `CHANGE_IMPACT_CLOSED`,
`CHANGE_ACK_RECEIVED`, `BULK_APPLIED`, `CONFIGURATION_CHANGED`,
`EXPORT_GENERATED`, `RECORD_ARCHIVED`.

### 14.3 Permissions

| Action | Capability | Role |
|---|---|---|
| Read changes, impacts, acknowledgements, reports, audit search | `FILE_READ` | viewer |
| Acknowledge / clarify a change | `CHANGE_COORDINATE` | editor |
| Assess and coordinate impact | `CHANGE_COORDINATE` | editor |
| Bulk forecast | `TNA_EXECUTE` | editor |
| Bulk reschedule | `TNA_MANAGE` | approver |
| Bulk downstream submit | `HANDOVER_SUBMIT` | approver |
| Bulk assignment | `FILE_ASSIGN` | owner |
| Configuration, bulk import | `CONFIGURATION_MANAGE` | owner |
| Export, bulk results download | `EXPORT` | owner |
| Author a change notice | — | **Sales only** |
| Write another app's acknowledgement | — | **no path** |

Every capability already exists in `access.service.js:99-114`. **M7 adds no
capability constant.**

---

## 15. M7 frontend

Accounting language throughout; **no new navigation destination**.

| Surface | Addition |
|---|---|
| **Overview** | two counts — `Changes awaiting impact`, `Acknowledgements outstanding` — each opening its filtered list. Failed read → *"Couldn't check"*, never zero. |
| **Order Execution** | one column, `Open changes`, with a count `Badge`; a `Has open changes` toolbar filter. Nothing else — the register is dense. |
| **Execution File → Changes & History** | the tab becomes two bands: **Changes** (notice, before/after side by side using the typed projection fields, impact state, acknowledgement coverage) above the existing **History** timeline, which gains business sentences for the M7 audit actions in `executionPresentation.js`'s `EVENT_SENTENCE`. |
| **Impact editor** | `MerchandisingDialog`; per-area impact toggles, affected units by `unitDiscriminator`, reason code + note ≥15, and the resulting revision numbers shown **before** confirm. |
| **Acknowledgement register** | one row per application: state `Badge`, acknowledged version, `STALE` flag, reason verbatim. Merchandising has no control on these rows — read-only by construction. |
| **Bulk preview/results** | full-width preview table with per-row outcome `Badge` and reason; summary band (`applied / skipped / refused`); `Download results` (CSV) after apply. Apply disabled until a preview exists and is unexpired. |
| **Operational reporting** | `/merchandiser/reports` — source-backed only: on-time delivery against baseline, milestone slip by department, change volume by buyer, downstream acceptance latency. Every figure opens the records behind it. |
| **Integration health** | manager-only panel: outbox by kind/status, oldest pending age, stuck rows with `lastError`, a Retry action. |
| **Configuration** | `/merchandiser/settings/*`, `CONFIGURATION_MANAGE` only, **absent from the nav**. Templates, calendars, reason codes, divisions/teams, retention. |

Mobile: every register keeps the table/card pair, no horizontal scroll, no
nested scroll region. Accessibility: the frozen standard — tablist contract,
dialog focus management, `role="alert"`, `aria-live` counts, no
`overflow-hidden` above a sticky header.

**Forbidden:** no Sales CRM, Tasks, Store or PPC screen inside Merchandising.

---

## 16. M7 tests and implementation sequence

### 16.1 Tests

| Area | Assertions |
|---|---|
| Company isolation | notices, impacts, acks, bulk previews, exports |
| Capability matrix | every §14.3 row + the role below; admin/other-dept refused; revocation next request |
| No Merchandising-authored change | no create route/service/model path; source scan |
| Buyer-communication exclusion | message/email/contact/thread/quotation/price/terms refused at intake and absent from the schema |
| Stable change identity | `changeRef` constant across versions; `handoverLineRef` used, never a style id |
| Idempotent intake | duplicate → ledger hit, no second write; concurrent → `11000` handled |
| Supersession/cancellation | older version `NOOP`; cancelled → `NOOP`; prior receipt preserved |
| Revision preservation | impact creates new M3/M4 revisions; **old readable and byte-identical**; M5 baseline revised, old baseline intact |
| Acknowledgements | receiver-owned; Merchandising cannot write one; stale version flagged, not counted; `REJECTED_AS_INVALID` requires a reason |
| Bulk | preview writes nothing; apply needs a matching `previewId`; refused row does not discard applied rows; >500 explicit refusal; CSV matches per-row outcomes |
| Pagination | cursor stable under insertion; `limit` capped; **no `skip` anywhere** |
| Indexes | portfolio, milestone, change and audit queries use an index — assert the query plan, not wall-clock |
| High volume | 1,000 files × 40 milestones × 5 changes: first page within budget; counts by aggregation |
| Archive | archived files excluded from default lists, reachable by reference, still exportable, **never deleted** |
| Observability | stuck query returns pending-over-threshold with `lastError`; retry is idempotent; **no daemon/broker introduced** |
| Export | company-scoped, filter audited, contains no rate/cost/margin/supplier/contact |
| Frontend/a11y | Changes & History two-band layout; impact dialog focus; bulk table mobile cards; nav still three entries; config absent from nav |
| No foreign screens | source scan: no CRM, Tasks, Store or PPC screen under `app/merchandiser/**` |

### 16.2 Sequence

| # | Step | Exit |
|---|---|---|
| 1 | `SalesChangeNotice` + Sales producer (issue/supersede/cancel, live authority) | Sales-side tests |
| 2 | `ChangeIntakeReceipt` + `changeIntake.service.js` + delivery | idempotency/stale tests |
| 3 | `ChangeImpact` model + assess | revision-preservation tests |
| 4 | Coordinate + outbox to affected applications | events tests |
| 5 | `ChangeAcknowledgement` (receiver-owned) + staleness | acknowledgement tests |
| 6 | Bulk framework (preview/apply/results) | bulk contract tests |
| 7 | Bulk commands, one at a time | per-command tests |
| 8 | Indexes, archive, retention, pagination audit | index + high-volume tests |
| 9 | Ops endpoints + integration health | observability tests |
| 10 | Frontend: Changes & History, impact dialog, ack register | a11y/mobile tests |
| 11 | Frontend: bulk, reports, config (off-nav) | nav still three entries |
| 12 | Overview/register integration | source-backed only |
| 13 | Verification + handoff | two orderings, tsc, build, `git diff --check`; **not** declared frozen |

---

## 17. Final full-app acceptance checklist

The plan's §12 test. The app is correct only when a user can answer each of
these **without opening a Sales Journey or editing another department's record**:

| # | Question | Answered by | Milestone |
|---|---|---|---|
| 1 | What confirmed requirement are we executing? | Sales Handover tab, accepted version | M1/M2 ✅ |
| 2 | Which material, trim, accessory and packaging versions are approved? | Materials & Trims + Packaging tabs, approved revision | M3 ✅ |
| 3 | What development and approval requirements remain unresolved? | Development + Approvals tabs | M4 |
| 4 | Which T&A milestone threatens the committed date? | T&A portfolio + file tab, critical-path list | M5 |
| 5 | What has changed since the accepted baseline? | Changes & History, notice + impact + preserved revisions | M7 |
| 6 | What is each source department's latest recorded status? | Department Status register, with availability and freshness | M6 |
| 7 | Which exact execution-pack version was handed downstream and accepted? | Execution Pack history + PPC receipt | M6 |

**Boundary check — the app is wrong if any screen asks a merchandiser to
manage:** customers, quotations, supplier rates, technical consumption, stock,
production release, quality results, or generic tasks.

**Structural invariants that must hold at every milestone:**

- Navigation is exactly three entries: Overview, Order Execution, Time & Action.
- No capability constant was added after M0 — the 14 in `access.service.js` are
  the complete vocabulary.
- `isAdmin` is not a rung; assignment grants nothing; authority is read live.
- Every approved revision and every baseline is immutable and preserved.
- No cross-application transaction exists.
- Every idempotency guarantee is a database uniqueness constraint.
- No outbox has a terminal `FAILED` state.
- No daemon, timer or broker was introduced.
- Every count on every screen opens the records that produced it.
- A failed read renders "Couldn't check", never a zero.

---

*Prepared by Lane B. No application file, handoff or `current-task.md` was
modified in producing this document.*
