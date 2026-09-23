# Merchandising M5 — Time & Action: Implementation Specification

> **Status:** Ready for implementation. Prepared by Lane B for Lane A to begin
> immediately after M4 (Development Requirements and Approvals) completes.
>
> **Authority:** `docs/product/merchandising-app-final-plan.md` §3, §6.7, §7,
> §8, §9, §11 (M5). Where this document and the plan differ, the plan wins.
>
> **Scope:** Specification only. No application code, test, migration or
> handoff entry is changed by this document.

---

## 1. M5 purpose and boundary

### 1.1 What M5 is for

A merchandiser controls dates across many simultaneous orders. Time & Action is
the instrument for that, and the plan makes it the third and final everyday
destination for exactly that reason (§3, §7).

The question M5 must answer, per file and across the portfolio:

> Which milestone threatens a committed delivery date, and what is being done
> about it?

### 1.2 What a milestone is

A **milestone** is a dated control point on the execution of one confirmed
order line — "fabric in-house", "PP sample approved", "cutting starts". It has
a baseline date the company committed to, a forecast date it is currently
expected to land on, and an actual date once it happened.

### 1.3 What a milestone is NOT

The plan is explicit (§7): *"A T&A milestone is not a personal task. Any
reminder, follow-up, checklist, or assigned action is created and managed in
the Tasks app with a reference back to the Merchandising Execution File."*

M5 therefore does not build, and must actively refuse:

| Excluded | Why | Where it lives |
|---|---|---|
| Personal tasks, to-dos | A milestone is a date on an order, not work assigned to a person | Tasks app |
| Checklists, subtasks | Decomposition of somebody's work | Tasks app |
| Delegation, assignment of a milestone to a person | Responsibility is a file attribute (M2), not a per-milestone one | `ExecutionFile.responsibleMerchandiser` |
| Reminders as stored records | A reminder is a notification preference, not a company record | Tasks app |
| Generic project management (arbitrary user-created milestones outside a template) | Turns a controlled process into a spreadsheet | — |
| Store readiness, stock availability | Store owns it | Store app |
| PPC capacity, factory/line plan, production release | PPC owns it (ADR-003) | PPC app |
| Production scheduling, WIP, output | Production owns it | Production app |

**The test that decides a borderline case:** if the record answers *"when must
this order reach this control point, and where is it now"*, it is M5. If it
answers *"what should this person do next"*, it is Tasks.

### 1.4 Boundary with M4 (running concurrently)

M4 is building Development Requirements and Approvals. At the time of writing
no M4 route or model exists yet (`routes/CMS_Routes/Merchandising/executionRoute.js`
carries no `requirement` or `approval` route; `services/merchandising/styleDevelopment.service.js`
is the transitional Styles-page implementation, not the M4 record).

M5 **consumes** M4; it does not define it. Two integration points, both
one-directional:

1. **A development requirement's `requiredByDate`** may seed or constrain a
   milestone forecast. M5 reads it. M5 never writes it.
2. **An approval outcome** (M4's register) is an authoritative completion event
   for an approval-class milestone — see §9.3.

If M4's shape is not final when M5 starts, implement §9.3's consumer against
the event contract and leave the M4-specific handler as the last step. M5 must
not block on M4, and must not reach into M4's collections directly.

---

## 2. Current-code evidence

Everything below was read in the working tree. M5 builds on it and must not
re-invent it.

### 2.1 The capability rungs already exist

`services/merchandising/access.service.js:99` already declares the two
capabilities M5 needs, and `ROLE_CAPABILITIES` already places them:

```js
TNA_MANAGE:  "merchandising.tna.manage",    // approver and above
TNA_EXECUTE: "merchandising.tna.execute",   // editor and above
```

`CONFIGURATION_MANAGE` (owner) is the third rung M5 uses, for templates and
calendars. **No new capability constant is required.** `requireMerchandisingCapability`
and `merchandisingCapability(CAPABILITY.X)` are the existing guards; refusals
already name `{department, capability, minimumRole}`.

### 2.2 The versioned-record pattern M5 must copy

`models/CMS_Models/Merchandising/SelectionRevision.js` establishes the house
pattern for an approved, frozen, superseded record. M5's baseline reuses it
verbatim in shape:

- `companyId`, `fileId` — `required, index, immutable`
- `revisionNo` — `min: 1, required, immutable`
- `supersedesRevisionId` / `supersededByRevisionId` / `supersededAt`
- `approvedBy` (actorRef) / `approvedAt`
- unique `{companyId, fileId, revisionNo}`
- **partial unique indexes enforcing one-per-state**:
  `one_draft_per_file`, `one_submitted_per_file`, `one_approved_per_file`

That last device is how M5 guarantees one live baseline per plan at the
database rather than in a service.

### 2.3 Idempotency and optimistic concurrency already have an implementation

`services/merchandising/selection.service.js` has `once(ctx, {scope,
idempotencyKey, request}, run)` with `hashRequest()`, a stored
`requestHash`, a `11000` catch, and a refusal when the same key arrives with a
different body. `expectedRevision` is the optimistic-concurrency token on every
mutating call.

**M5 reuses `once()` and `expectedRevision` unchanged.** If `once()` needs to
serve a second service, extract it to `services/merchandising/idempotency.js`
without changing its behaviour, and update M3's import in the same step.

### 2.4 Audit and outbox already have a home

`models/CMS_Models/Merchandising/MerchandisingEvent.js` exports
`MerchandisingAuditEvent` (append-only, `merchandising_audit_events`),
`MerchandisingOutboxEvent` (`merchandising_outbox_events`, unique on
`{correlationId, kind}`) and `MerchandisingIntakeLedger`
(`merchandising_intake_ledger`, unique+immutable `sourceEventId`).

`OUTBOX_KIND` already uses the dotted `<app>.<record>.<what happened>` form that
M3 adopted. M5 extends both `AUDIT_ACTIONS` and `OUTBOX_KIND` in place.

### 2.5 The source-event consumer pattern already exists

`services/merchandising/handoverIntake.service.js` is the reference
implementation for consuming another application's event: one handler per kind,
`{outcome: "APPLIED" | "NOOP", note}`, a ledger row keyed on the source event
id, an `11000` catch returning `{duplicate: true}`, and a hard rule that
nothing moves a record backwards. `services/integration/salesHandoverDelivery.service.js`
is the carrier: never throws, leaves a failure `PENDING`, no cross-application
transaction.

**M5's source-owned completions use exactly this mechanism.** Do not invent a
second one.

### 2.6 What the plan hangs off

`ExecutionFile` identity is `(companyId, handoverRef, handoverLineRef)`, unique
and immutable, with `revision` for optimistic concurrency and
`lifecycleStatus` in `OPEN|ON_HOLD|CLOSED|CANCELLED`.
`currentExecutionProjection.deliveries[]` carries `dropRef`,
`committedDeliveryDate`, `targetExFactoryDate`, `nominatedFactoryRef`,
`quantity`. `ExecutionUnit.unitDiscriminator` is the stable per-unit identity
M2.1 built from source references only.

### 2.7 There is no working-calendar model to reuse

A repository-wide search for `workingDay|businessDay|isHoliday|holiday` finds
only HR attendance, payroll and approval-policy code. **No shared company
working calendar exists.** M5 creates one, scoped to Merchandising, and must
not annex HR's shift or attendance records — those answer a different question
(who was at work) from the one M5 asks (which days count for a lead time).

### 2.8 Frontend integration points

- `components/merchandiser/merchandisingNavigation.js:57` — `MERCHANDISING_NAV`
  is a two-entry array; M5 adds the third and only remaining entry.
- `lib/merchandising/api.js:349` — `EXECUTION_VIEWS`, the segmented-view
  pattern the T&A portfolio mirrors.
- The frozen frontend's Accounting composition: `PageContainer`
  (`max-w-[1480px]`), `AcctPageSlab`, `frost-panel border border-hairline
  rounded-card`, `Badge`, the segmented pill control, desktop table in a
  bounded `md:overflow-y-auto` scrollport with a sticky opaque header, and
  `md:hidden` mobile cards.
- `components/merchandiser/FileTabs.js` — the tablist M5 extends to six tabs.
- `components/merchandiser/useMerchandisingRole.js` — mirrors the server ladder
  and deliberately never reads `isAdmin`. M5 adds `canRunTna` / `canManageTna`
  to it, by the same rule.

---

## 3. Permanent records

All models live in `models/CMS_Models/Merchandising/`. All are company-scoped.
All date-only fields follow §6.1.

### 3.1 `TnaTemplate` — the named process

The stable identity of a T&A process. It holds no dates and no milestones; it
is the thing versions belong to.

| Field | Type | Notes |
|---|---|---|
| `companyId` | ObjectId | required, index, **immutable** |
| `templateRef` | String | `TPL-` + 10 hex, server-minted, **immutable** |
| `name` | String | display text only; renaming must not orphan anything |
| `description` | String | |
| `isActive` | Boolean | default true; deactivating hides it from new plans only |
| `createdBy` / `createdAt` | actorRef / Date | |

Unique: `{companyId, templateRef}`.

### 3.2 `TnaTemplateVersion` — effective-dated and immutable once published

| Field | Type | Notes |
|---|---|---|
| `companyId`, `templateId` | ObjectId | required, index, **immutable** |
| `versionNo` | Number | `min: 1`, required, **immutable** |
| `state` | Enum | `DRAFT` \| `PUBLISHED` \| `RETIRED` |
| `effectiveFrom` | DateOnly | required at publish |
| `effectiveTo` | DateOnly \| null | set only when a later version is published |
| `selectors` | Subdoc | see §7.2 |
| `milestones[]` | Subdoc | see §3.3 |
| `dependencies[]` | Subdoc | see §3.4 |
| `defaultCalendarId` | ObjectId | the working calendar a plan inherits |
| `publishedBy` / `publishedAt` | actorRef / Date | |
| `retiredAt` | Date \| null | |

Rules:

- Unique `{companyId, templateId, versionNo}`.
- Partial unique `{companyId, templateId}` where `state: "DRAFT"` — one draft
  version at a time, exactly as M3 does for selections.
- **A `PUBLISHED` version is immutable.** Every field except `effectiveTo`,
  `state` and `retiredAt` is rejected by a pre-save guard once published.
  Changing a process means publishing a new version.
- Publishing validates the whole graph (§6.4) and refuses a cyclic or
  unreachable definition.

### 3.3 `templateMilestoneSchema` (embedded in a template version)

| Field | Type | Notes |
|---|---|---|
| `milestoneCode` | String | `^[A-Z][A-Z0-9_]{2,39}$`, unique within the version. **This is the stable identity** — never the label |
| `name` | String | display text; renaming does not change identity |
| `ownerDepartment` | Enum | §5.1 |
| `completionAuthority` | Enum | `MERCHANDISING` \| `SOURCE_EVENT` — §5.2 |
| `sourceEventKinds[]` | String | which event kinds may complete it, when `SOURCE_EVENT` |
| `anchor` | Enum | `PLAN_START` \| `DELIVERY` \| `EX_FACTORY` \| `PREDECESSOR` |
| `offsetWorkingDays` | Number | signed; negative counts back from the anchor |
| `scope` | Enum | `FILE` \| `PER_DELIVERY` \| `PER_UNIT` — §3.6 |
| `criticalPathCandidate` | Boolean | informational only; the path is computed |
| `sortOrder` | Number | display order, never identity |

### 3.4 `templateDependencySchema`

| Field | Type | Notes |
|---|---|---|
| `dependencyRef` | String | `DEP-` + 8 hex, stable |
| `predecessorCode` | String | a `milestoneCode` in this version |
| `successorCode` | String | a `milestoneCode` in this version |
| `type` | Enum | `FINISH_TO_START` (M5 supports this one only) |
| `lagWorkingDays` | Number | ≥ 0 |

`FINISH_TO_START` is the only dependency type in M5. Start-to-start and
finish-to-finish are deliberately excluded: they are not needed to answer "what
threatens the delivery date", and every one added multiplies the forecast
engine's cases.

### 3.5 `WorkingCalendar` and `WorkingCalendarVersion`

Separate models, same versioning discipline, because a holiday added in June
must not silently move every baseline computed in March.

`WorkingCalendar`: `companyId`, `calendarRef`, `name`, `timezone` (IANA, e.g.
`Asia/Kolkata`), `isActive`.

`WorkingCalendarVersion`:

| Field | Type | Notes |
|---|---|---|
| `calendarId`, `companyId` | ObjectId | immutable |
| `versionNo` | Number | immutable |
| `state` | Enum | `DRAFT` \| `PUBLISHED` \| `RETIRED` |
| `effectiveFrom` / `effectiveTo` | DateOnly | |
| `weekPattern` | [Boolean] × 7 | index 0 = Monday. `true` = working day |
| `exceptions[]` | Subdoc | `{ date: DateOnly, working: Boolean, reason: String }` |
| `horizonTo` | DateOnly | the last date this version can answer for — §6.3 |

An exception overrides the week pattern for that one date, in both directions:
a declared holiday on a Tuesday, and a worked Sunday.

### 3.6 `TnaPlan` — one per Execution File

| Field | Type | Notes |
|---|---|---|
| `companyId`, `fileId` | ObjectId | required, index, **immutable** |
| `templateId`, `templateVersionId` | ObjectId | **immutable after creation** |
| `calendarId`, `calendarVersionId` | ObjectId | **immutable after creation** |
| `state` | Enum | `DRAFT` \| `BASELINED` \| `ACTIVE` \| `COMPLETED` \| `CANCELLED` |
| `planStartDate` | DateOnly | the anchor for `PLAN_START` milestones |
| `currentBaselineNo` | Number \| null | |
| `revision` | Number | optimistic concurrency, mirrors `ExecutionFile.revision` |
| `completedAt`, `cancelledAt` | Date \| null | |

Unique: `{companyId, fileId}` — one plan per file.

**The pinned-version rule.** `templateVersionId` and `calendarVersionId` are
immutable after creation. This is how the plan's requirement — *existing files
retain the template version they started with* — is enforced structurally
rather than by convention. Publishing template version 7 changes nothing for a
file baselined on version 6. Moving a live file to a newer template is a
deliberate, audited **baseline revision** (§4.3), never a side effect.

### 3.7 `TnaMilestone` — the instance

| Field | Type | Notes |
|---|---|---|
| `companyId`, `planId`, `fileId` | ObjectId | immutable |
| `milestoneRef` | String | **stable identity** — see below |
| `milestoneCode` | String | copied from the template version, immutable |
| `name` | String | copied at creation; a later template rename does not reach it |
| `ownerDepartment`, `completionAuthority` | Enum | copied, immutable |
| `scopeKind` | Enum | `FILE` \| `DELIVERY` \| `UNIT` |
| `dropRef` | String | when `scopeKind: DELIVERY` |
| `unitDiscriminator` | String | when `scopeKind: UNIT` — M2.1's identity |
| `sequenceRank` | Number | topological rank, recomputed on baseline |
| `baselineDate` | DateOnly \| null | **written once per baseline, never edited** |
| `forecastDate` | DateOnly \| null | |
| `actualDate` | DateOnly \| null | |
| `status` | Enum | §4.2 |
| `blocked` | Subdoc \| null | `{ reasonCode, note, byActor, at }` |
| `completion` | Subdoc \| null | §3.10 |
| `lastForecastAt`, `lastForecastBy` | Date / actorRef | |
| `revision` | Number | optimistic concurrency |

**`milestoneRef` is deterministic, not random:**

```
FILE      →  `${milestoneCode}`
DELIVERY  →  `${milestoneCode}::DROP:${dropRef}`
UNIT      →  `${milestoneCode}::UNIT:${unitDiscriminator}`
```

Built from stable references only — never from the name, the buyer, the factory
or a position. This is the same rule M2.1's `unitDiscriminator` follows, and for
the same reason: a renamed colourway or a corrected factory must not withdraw a
milestone and open a new one, taking its history with it.

Unique: `{companyId, planId, milestoneRef}`.

### 3.8 `TnaBaseline` — the immutable commitment

| Field | Type | Notes |
|---|---|---|
| `companyId`, `planId`, `fileId` | ObjectId | immutable |
| `baselineNo` | Number | `min: 1`, immutable |
| `state` | Enum | `ACTIVE` \| `SUPERSEDED` |
| `templateVersionId`, `calendarVersionId` | ObjectId | what it was computed from |
| `planStartDate` | DateOnly | immutable |
| `entries[]` | Subdoc | `{ milestoneRef, milestoneCode, baselineDate }` — **immutable** |
| `approvedBy` / `approvedAt` | actorRef / Date | |
| `supersededByBaselineNo`, `supersededAt` | Number / Date | |
| `revisionReason` | Subdoc \| null | required for `baselineNo > 1` — §4.3 |

Rules:

- Unique `{companyId, planId, baselineNo}`.
- Partial unique `{companyId, planId}` where `state: "ACTIVE"` — **at most one
  live baseline per plan, enforced by the database.**
- A saved baseline document is **immutable except** `state`,
  `supersededByBaselineNo` and `supersededAt`. Enforce with a pre-save guard,
  the same device the template version uses.
- A superseded baseline is **kept**, never deleted. "What did we originally
  commit to?" must remain answerable for the life of the file.

### 3.9 `TnaReschedule` — the audited move

| Field | Type | Notes |
|---|---|---|
| `companyId`, `planId` | ObjectId | immutable |
| `rescheduleRef` | String | `RS-` + 10 hex |
| `state` | Enum | `PREVIEWED` \| `APPROVED` \| `REJECTED` \| `WITHDRAWN` |
| `scope` | Enum | `MILESTONE` \| `PLAN` |
| `milestoneRef` | String | when scope is `MILESTONE` |
| `reasonCode` | Enum | from the approved list, §3.11 |
| `reasonNote` | String | required, min 15 chars — the M2 clarification rule |
| `proposedDate` | DateOnly | |
| `impact` | Subdoc | the computed preview, frozen at request time |
| `createsBaselineRevision` | Boolean | true when the move breaches a committed date |
| `requestedBy` / `requestedAt` | actorRef / Date | |
| `decidedBy` / `decidedAt` / `decision` | actorRef / Date / Enum | |

`impact` stores what the requester was shown: affected milestone refs, each
one's before/after forecast, the number of days the delivery-critical milestone
moves, and whether any committed delivery date is breached. **An approver
approves the impact they were shown, not a recomputation** — if the plan has
changed underneath, approval is refused with `TNA_IMPACT_STALE` and the
requester previews again.

### 3.10 `completion` — the source-owned reference

Embedded on `TnaMilestone`. This is how Merchandising records that another
department finished something **without pretending to be that department**.

| Field | Type | Notes |
|---|---|---|
| `recordedVia` | Enum | `MERCHANDISING_ENTRY` \| `SOURCE_EVENT` |
| `sourceApp` | String | e.g. `product-development`, `quality`, `sales` |
| `sourceEventId` | ObjectId \| null | the event that carried it |
| `sourceRecordType`, `sourceRecordRef` | String | what the source calls it |
| `sourceRecordVersion` | Number \| null | |
| `observedAt` | Date | when the source says it happened |
| `actor` | actorRef \| null | **null for `SOURCE_EVENT`** |

**`actor` is null for a source event, deliberately.** Naming a merchandiser on
another department's completion is a false attribution — the same rule
`handoverIntake.onIssued` already follows with its `source: "sales"` and no
actor.

### 3.11 Reference data

`TnaReasonCode` — `{companyId, code, label, kind: BLOCK|RESCHEDULE, isActive}`.
Seeded, owner-manageable. The plan requires *"approved rescheduling reasons"*
(§7); a free-text-only reason is not an approved reason.

### 3.12 Audit and outbox additions

Extend `MerchandisingEvent.js` in place.

`AUDIT_ACTIONS` gains: `TNA_PLAN_CREATED`, `TNA_BASELINE_APPROVED`,
`TNA_BASELINE_REVISED`, `TNA_FORECAST_UPDATED`, `TNA_MILESTONE_BLOCKED`,
`TNA_MILESTONE_UNBLOCKED`, `TNA_RESCHEDULE_REQUESTED`,
`TNA_RESCHEDULE_APPROVED`, `TNA_RESCHEDULE_REJECTED`,
`TNA_MILESTONE_COMPLETED`, `TNA_MILESTONE_COMPLETION_OBSERVED`,
`TNA_MILESTONE_REOPENED`, `TNA_PLAN_COMPLETED`, `TNA_PLAN_CANCELLED`.

`OUTBOX_KIND` gains, in the established dotted form:

```
merchandising.tna_plan.baselined
merchandising.tna_plan.rebaselined
merchandising.tna_milestone.blocked
merchandising.tna_milestone.at_risk
merchandising.tna_plan.completed
```

`OUTBOX_REQUIRED` gains the matching payload field lists.

---

## 4. State machines

### 4.1 Plan lifecycle

```
                 ┌──────────────── cancel (file CANCELLED) ─────────────┐
                 ▼                                                       │
DRAFT ──baseline approved──► BASELINED ──first forecast/actual──► ACTIVE ─┴─► COMPLETED
  │                              │                                  │            │
  │                              └──────── baseline revision ────────┘            │
  └── cancel                                (stays BASELINED/ACTIVE)         reopen ──► ACTIVE
```

| Transition | Trigger | Capability | Notes |
|---|---|---|---|
| → `DRAFT` | plan created from a template version | `TNA_MANAGE` | milestones instantiated, forecast computed, **no baseline dates yet** |
| `DRAFT` → `BASELINED` | baseline 1 approved | `TNA_MANAGE` | writes `baselineDate` on every milestone, once |
| `BASELINED` → `ACTIVE` | first forecast update, block, or actual | `TNA_EXECUTE` | automatic, not a command |
| `ACTIVE` → `COMPLETED` | every non-cancelled milestone has an `actualDate` | — | automatic |
| `COMPLETED` → `ACTIVE` | reopen | `TNA_MANAGE` | reason required; audited |
| any → `CANCELLED` | `ExecutionFile` becomes `CANCELLED` | receiver only | mirrored from Sales, never authored here |

`CANCELLED` is terminal and is only ever reached by mirroring the file's own
lifecycle, exactly as `handoverIntake.onCancelled` does today. Merchandising
does not cancel a plan on its own; it has nothing to cancel if the commercial
requirement stands.

### 4.2 Milestone status

`status` is **derived and stored**, recomputed on every write that could change
it, so the register can index and sort on it:

| Status | Condition |
|---|---|
| `PENDING` | no actual, forecast ≥ today, not blocked |
| `DUE_SOON` | no actual, forecast within the due-soon window (default 7 working days) |
| `OVERDUE` | no actual, forecast < today |
| `FORECAST_LATE` | no actual, forecast > baseline |
| `BLOCKED` | `blocked` is set; overrides the above for display |
| `COMPLETED` | `actualDate` set |
| `NOT_APPLICABLE` | withdrawn by a baseline revision; kept, never deleted |

`OVERDUE` and `FORECAST_LATE` are independent and can both be true; the
register shows the more urgent (`OVERDUE`).

### 4.3 The controlled actions

**Forecast update** (`TNA_EXECUTE`). Sets `forecastDate` on one milestone and
cascades to successors through the dependency graph. Never touches
`baselineDate`. Recomputes status for the affected subgraph only.

**Block / unblock** (`TNA_EXECUTE`). Sets or clears `blocked` with a
`reasonCode` from the approved list and a note. A blocked milestone keeps
forecasting; blocking states a fact, it does not stop arithmetic.

**Reschedule preview** (`TNA_EXECUTE`). Pure computation, writes only a
`TnaReschedule` in `PREVIEWED`. Returns the full impact: every affected
milestone's before/after, and whether a committed delivery date breaks.

**Reschedule approval** (`TNA_MANAGE`). Applies a `PREVIEWED` request whose
impact still matches. If `createsBaselineRevision`, it triggers a baseline
revision in the same transaction — the approver is told this before they press.

**Baseline revision** (`TNA_MANAGE`). Supersedes baseline *n*, writes baseline
*n+1* with a required `revisionReason`. The superseded baseline is kept. This is
the **only** way a `baselineDate` ever changes, and it changes by writing a new
immutable document, never by editing the old one.

**Cancellation** — receiver only, see §4.1.

**Reopen** (`TNA_MANAGE`). A completed plan or milestone returns to `ACTIVE`
with a reason. Clears `actualDate` and records the clearing in the audit trail;
the previous actual is preserved in the audit event, not silently lost.

**Source-event completion** — §9.3. No capability: it is not a person acting.

---

## 5. Milestone ownership matrix

### 5.1 `ownerDepartment`

| Value | Owns the fact that the milestone happened |
|---|---|
| `MERCHANDISING` | Merchandising's own coordination acts |
| `SALES` | Buyer decisions, commercial amendments, PO receipt |
| `PRODUCT_DEVELOPMENT` | Tech pack, pattern, sample rounds, technical approval |
| `QUALITY` | Test results, inspection outcomes, release |
| `STORE_SUPPLY_CHAIN` | Material in-house, receipt, issue |
| `IE_PPC_PRODUCTION` | Route release, line loading, cutting/sewing start, output |
| `LOGISTICS` | Booking, documents, dispatch, shipment events |

### 5.2 `completionAuthority` — the rule that stops fabrication

| Value | Who may set `actualDate` |
|---|---|
| `MERCHANDISING` | A Merchandising editor, directly. Only valid where `ownerDepartment: MERCHANDISING` |
| `SOURCE_EVENT` | **Only** an authoritative event from the owning application |

**A template version that pairs a non-Merchandising `ownerDepartment` with
`completionAuthority: MERCHANDISING` is refused at publish**, with the message
naming the department that owns the fact. This is the structural expression of
the plan's rule (§6.8): *"Merchandising coordinates visibility; it cannot mark
another department ready."*

Merchandising may always **forecast** any milestone, whoever owns it — that is
coordination, and it is the whole job. What it may not do is assert that
somebody else's work is finished.

**Where the source application does not yet publish an event** (true for most
departments at M5), the milestone's `actualDate` stays null and the register
shows `Awaiting <department>` — an explicit unknown, never a guess and never a
Merchandising-entered stand-in. The plan requires exactly this at M6:
*"explicit unknown/unavailable states instead of guessed readiness."*

---

## 6. Date and calendar rules

### 6.1 Timezone safety: two distinct types

This is the single most common source of off-by-one-day defects, so M5 makes it
a type distinction rather than a convention.

**Milestone dates are calendar dates, not instants.** "Fabric in-house on 12
March" is the same fact in Delhi and in London. Store them as
**`String`, `^\d{4}-\d{2}-\d{2}$`** — never as `Date`. A `Date` is an instant;
serialising `new Date("2026-03-12")` and reading it back in a UTC+5:30 process
yields 11 March, and a milestone silently moves a day when a server is
redeployed in another region.

Fields that are calendar dates: `baselineDate`, `forecastDate`, `actualDate`,
`planStartDate`, `effectiveFrom`, `effectiveTo`, `horizonTo`, `exceptions[].date`,
`proposedDate`.

**Timestamps are instants** and stay `Date`: `approvedAt`, `requestedAt`,
`observedAt`, `createdAt`, `lastForecastAt`.

`WorkingCalendar.timezone` (IANA) is used for exactly one thing: deciding what
"today" is when computing `DUE_SOON` and `OVERDUE`. Implement as
`todayInZone(tz)` returning a `YYYY-MM-DD` string. Never `new Date()` compared
against a stored date.

### 6.2 Deterministic working-day arithmetic

One pure module, `services/merchandising/tnaCalendar.js`, with no I/O:

```js
isWorkingDay(dateStr, calendarVersion) → boolean
addWorkingDays(dateStr, n, calendarVersion) → dateStr      // n may be negative
workingDaysBetween(fromStr, toStr, calendarVersion) → number
todayInZone(timezone) → dateStr
```

Rules that make it deterministic:

- Operates on the `YYYY-MM-DD` string and a plain integer day index. No
  `Date` arithmetic, no `setDate`, no DST exposure.
- `exceptions[]` is indexed into a `Map` once per calendar version.
- `addWorkingDays(d, 0)` returns `d` unchanged **even if `d` is a non-working
  day** — it is not a rounding function.
- Iterates day by day. At M5 volumes (lead times of tens to low hundreds of
  days) this is fast, obviously correct, and trivially testable. Do not
  optimise it into week arithmetic; the exception list makes that wrong.

### 6.3 The calendar horizon

`horizonTo` is the last date a calendar version can answer for. Computing past
it throws `TNA_CALENDAR_HORIZON` naming the calendar and the date, rather than
silently assuming Saturdays are holidays forever. A plan whose forecast reaches
the horizon is a real operational signal that somebody must extend the calendar.

### 6.4 Dependency graph and cycle prevention

- Only `FINISH_TO_START`.
- Validated at **two** points: template-version publish, and plan baseline.
- Validation is a **Kahn topological sort**. If any node remains unranked, the
  graph has a cycle: refuse with `TNA_DEPENDENCY_CYCLE` and **name the cycle**
  (`A → B → C → A`) rather than reporting "invalid graph".
- Also refused: an edge naming a `milestoneCode` the version does not have; a
  self-edge; a duplicate `(predecessor, successor)` pair.
- The resulting rank is stored as `sequenceRank`, so forecast propagation is one
  ordered pass with no recursion and no revisit.

### 6.5 Forecast propagation

```
forecast(m) = max(
  anchorDate(m),
  max over predecessors p of addWorkingDays(effective(p), lag(p→m) + 1)
)
where effective(p) = p.actualDate ?? p.forecastDate
```

An actual always beats a forecast: once something has happened, the date it
happened is the input, not what anybody expected.

Propagation walks milestones in `sequenceRank` order, so one pass settles the
plan. A milestone whose recomputed forecast is unchanged stops the walk down
that branch.

---

## 7. Template and version rules

### 7.1 Immutability

A `PUBLISHED` template version is frozen. The pre-save guard rejects any change
except `state`, `effectiveTo` and `retiredAt`. This is what makes a baseline
reproducible: given `templateVersionId` and `calendarVersionId`, the baseline
can be recomputed and must come out identical.

### 7.2 Effective dating and selection

`selectors` on a template version, all optional and all matched by **stable
reference**, never by display text:

```js
selectors: {
  buyerRefs:      [String],   // matched against the file's buyer reference
  brandRefs:      [String],
  productCategoryRefs: [String],
  factoryRefs:    [String],   // the drop's nominatedFactoryRef
}
```

**Resolution, when a plan is created for a file on date `D`:**

1. Candidate versions: `state: PUBLISHED`, `effectiveFrom <= D`, and
   `effectiveTo` null or `> D`.
2. Score each by **selector specificity** — the count of non-empty selector
   arrays that match the file. A version with no selectors scores 0 and is the
   company default.
3. Highest score wins. A tie is a **configuration error**, refused with
   `TNA_TEMPLATE_AMBIGUOUS` naming both versions — not silently resolved by
   `createdAt`, which would make the process depend on the order somebody
   happened to configure it.
4. No candidate → `TNA_TEMPLATE_NOT_FOUND`, naming what was searched for.

This is the plan's requirement that *"buyer-, division-, factory- and
product-specific differences are configuration and versioned templates, not new
workflows"* (§2). There is exactly one process; selectors choose its parameters.

### 7.3 What publishing a new version does and does not do

**Does:** set `effectiveTo` on the previous version; make itself the resolution
target for plans created from now on.

**Does not:** touch any existing plan, milestone, baseline or forecast. Ever.
Existing files retain the template version they started with (§3.6). Moving a
live file forward is a baseline revision, requested and approved (§4.3).

---

## 8. API contracts

All routes mount on the existing Merchandising router
(`routes/CMS_Routes/Merchandising/executionRoute.js`, or a sibling
`tnaRoute.js` mounted at the same root — prefer the sibling, the file is already
large). All use `requireCompany` and the existing capability guards. All list
endpoints use cursor pagination with the established `{rows, nextCursor,
hasMore}` shape. All mutations take `idempotencyKey`; all record mutations take
`expectedRevision`.

### 8.1 Templates and versions — `CONFIGURATION_MANAGE` to write, `FILE_READ` to read

```
GET    /tna/templates                                   list
POST   /tna/templates                                   create
GET    /tna/templates/:templateId/versions              list
POST   /tna/templates/:templateId/versions              create DRAFT
PATCH  /tna/templates/:templateId/versions/:versionNo   edit DRAFT only
POST   /tna/templates/:templateId/versions/:versionNo/publish
POST   /tna/templates/:templateId/versions/:versionNo/retire
GET    /tna/templates/resolve?fileId=                   which version a file would get, and why
```

`resolve` returns the winning version, its score, and every candidate with its
score. A merchandiser who cannot see why a file got template 4 will assume the
system is wrong.

### 8.2 Working calendars — same capabilities

```
GET    /tna/calendars
POST   /tna/calendars
GET    /tna/calendars/:calendarId/versions
POST   /tna/calendars/:calendarId/versions
PATCH  /tna/calendars/:calendarId/versions/:versionNo    DRAFT only
POST   /tna/calendars/:calendarId/versions/:versionNo/publish
GET    /tna/calendars/:calendarId/versions/:versionNo/working-days?from=&to=
```

`working-days` returns the resolved day-by-day answer for a range — the only
honest way to let somebody check a calendar before committing baselines to it.

### 8.3 Plan and milestones

```
GET    /files/:id/tna                                    plan + milestones + current baseline
POST   /files/:id/tna                          TNA_MANAGE   create from a resolved template version
GET    /files/:id/tna/milestones?status=&owner=&cursor=   filtered, paginated
GET    /files/:id/tna/dependencies                        the graph, for the dependency view
GET    /files/:id/tna/baselines                           every baseline, newest first
GET    /files/:id/tna/baselines/:baselineNo               one, frozen
POST   /files/:id/tna/baseline           TNA_MANAGE        approve baseline 1
POST   /files/:id/tna/baseline/revise    TNA_MANAGE        supersede and write the next
GET    /files/:id/tna/history?cursor=                     the plan's audit trail
POST   /files/:id/tna/reopen             TNA_MANAGE
```

### 8.4 Milestone operations

```
PATCH  /files/:id/tna/milestones/:milestoneRef/forecast   TNA_EXECUTE
POST   /files/:id/tna/milestones/:milestoneRef/block      TNA_EXECUTE
POST   /files/:id/tna/milestones/:milestoneRef/unblock    TNA_EXECUTE
POST   /files/:id/tna/milestones/:milestoneRef/complete   TNA_EXECUTE  (MERCHANDISING authority only)
POST   /files/:id/tna/milestones/:milestoneRef/reopen     TNA_MANAGE
```

`complete` refuses with `TNA_SOURCE_OWNED` when `completionAuthority` is
`SOURCE_EVENT`, naming the department whose event is required. The refusal is
the feature.

### 8.5 Reschedule

```
POST   /files/:id/tna/reschedules              TNA_EXECUTE   preview; writes PREVIEWED, changes nothing else
GET    /files/:id/tna/reschedules?state=       list
POST   /files/:id/tna/reschedules/:ref/approve TNA_MANAGE    applies; refuses TNA_IMPACT_STALE
POST   /files/:id/tna/reschedules/:ref/reject  TNA_MANAGE    reason required
POST   /files/:id/tna/reschedules/:ref/withdraw TNA_EXECUTE  requester only
```

Segregation of duties: **the requester may not approve their own reschedule**
when it carries `createsBaselineRevision`. This mirrors M4's selection-approval
rule and the plan's §11 M4 requirement.

### 8.6 Portfolio (cross-file)

```
GET    /tna/portfolio?view=&q=&assignedTo=&buyer=&factory=&from=&to=&cursor=
GET    /tna/portfolio/counts
```

`view` ∈ `due-soon` | `overdue` | `blocked` | `forecast-late` | `completed` |
`all`. One row is **one milestone**, carrying its file number, order reference,
buyer, milestone name, owner department, baseline, forecast, actual and status.

`counts` feeds the Overview and the portfolio's segmented tabs, and is the same
shape `getExecutionOverview` already returns.

### 8.7 Bulk

```
POST   /tna/bulk/reschedule/preview   TNA_EXECUTE   per-row outcomes, writes nothing
POST   /tna/bulk/reschedule/apply     TNA_MANAGE    requires a previewId; per-row outcomes
```

Per the plan §9: *"Bulk import, reassignment, and rescheduling require preview,
validation, and per-row outcomes."* Every row returns
`{fileId, milestoneRef, outcome: APPLIED|SKIPPED|REFUSED, reason}`. A partial
failure is reported, not rolled back — one bad row must not discard forty good
ones. Cap at 200 rows per call.

### 8.8 Error codes

`TNA_PLAN_NOT_FOUND`, `TNA_PLAN_EXISTS`, `TNA_TEMPLATE_NOT_FOUND`,
`TNA_TEMPLATE_AMBIGUOUS`, `TNA_TEMPLATE_IMMUTABLE`, `TNA_DEPENDENCY_CYCLE`,
`TNA_DEPENDENCY_UNKNOWN_CODE`, `TNA_CALENDAR_HORIZON`, `TNA_BASELINE_EXISTS`,
`TNA_BASELINE_REQUIRED`, `TNA_BASELINE_IMMUTABLE`, `TNA_MILESTONE_NOT_FOUND`,
`TNA_SOURCE_OWNED`, `TNA_IMPACT_STALE`, `TNA_STATE_CONFLICT`,
`TNA_SELF_APPROVAL`, `TNA_REASON_REQUIRED`.

All raised through the existing `fail(code, message, details)` in
`services/storePurchase/errors.js`. Every message is a business sentence.

---

## 9. Events and cross-app contracts

### 9.1 What Merchandising announces

Written to `MerchandisingOutboxEvent` inside the same transaction as the record
change, exactly as M1–M3 do. The outbox's unique `{correlationId, kind}` index
already makes a retried decision unable to enqueue twice.

| Kind | When | Payload |
|---|---|---|
| `merchandising.tna_plan.baselined` | baseline 1 approved | fileId, planId, baselineNo, milestone count, critical dates |
| `merchandising.tna_plan.rebaselined` | baseline *n+1* approved | + previous baselineNo, reasonCode |
| `merchandising.tna_milestone.blocked` | block recorded | milestoneRef, ownerDepartment, reasonCode |
| `merchandising.tna_milestone.at_risk` | forecast crosses a committed delivery date | milestoneRef, dropRef, days late |
| `merchandising.tna_plan.completed` | last milestone actualised | fileId, planId, completedAt |

### 9.2 What M5 does NOT announce

No milestone-level forecast chatter. A forecast that moves three times in a day
is Merchandising's working state, not a company fact. Only crossing a
**committed** date is worth another application's attention.

### 9.3 Source-owned completion — the consumer

Reuse `handoverIntake.service.js`'s mechanism exactly. A new
`services/merchandising/tnaIntake.service.js`:

- One handler per source event kind.
- Returns `{outcome: "APPLIED" | "NOOP", note}`.
- Writes a `MerchandisingIntakeLedger` row keyed on `sourceEventId`
  (unique, immutable) — **idempotency is a database fact, not a careful
  handler**.
- Catches `11000` and returns `{duplicate: true, outcome: "NOOP"}`.
- Carried by `services/integration/` alongside the existing
  `salesHandoverDelivery.service.js`. Never throws; a failure leaves the event
  `PENDING` and retryable; no cross-application transaction.

**Stale-event rule.** An event completes a milestone only if:

1. the milestone's `completionAuthority` is `SOURCE_EVENT`;
2. the event kind is in the milestone's `sourceEventKinds[]`;
3. the milestone has no `actualDate`, **or** the incoming `observedAt` is
   earlier than the recorded one — an earlier authoritative observation
   corrects a later guess, never the reverse;
4. the plan is not `CANCELLED`.

Anything else is a `NOOP` with a note saying which rule declined it. Nothing
moves backwards; nothing is silently dropped.

**Matching.** Events carry `{handoverRef, handoverLineRef}` — M2.1's permanent
line identity — never a style id. The consumer resolves the file by
`(companyId, handoverRef, handoverLineRef)`, the unique immutable index that
already exists.

### 9.4 M4 integration

When M4 publishes `merchandising.development_requirement.*` and
`merchandising.approval.*` events, register them as `sourceEventKinds` on the
relevant template milestones. No M5 code changes; that is the point of driving
completion from a declared list rather than a switch statement.

---

## 10. Accounting-style frontend

The frozen frontend's composition is the specification: `PageContainer`
(`max-w-[1480px] px-4 py-6 deck:px-8`), `AcctPageSlab`, `frost-panel border
border-hairline rounded-card` bands, `Badge`, the segmented pill control,
desktop tables in a bounded `md:overflow-y-auto` scrollport with a sticky
opaque header, `md:hidden` mobile cards. **Do not introduce a new visual
language for M5.**

### 10.1 Navigation

`components/merchandiser/merchandisingNavigation.js` gains its third and final
entry:

```js
{ key: "tna", name: "Time & Action", href: "/merchandiser/time-action" }
```

`PREFIX_ROUTES` gains `["/merchandiser/time-action", "tna"]`. The nav is then
complete per plan §3 and must not grow again.

### 10.2 T&A portfolio — `/merchandiser/time-action`

- `AcctPageSlab`: icon, title "Time & Action", company in `sub`, a refresh
  `SlabGhost`. No figures on the slab — the counts live on the tabs, where they
  are also what you click (the Order Execution register's own rule).
- Segmented views with counts, mirroring `EXECUTION_VIEWS`:
  **Due soon · Overdue · Blocked · Forecast late · Completed · All**
- Toolbar band: search, `Assigned to me`, buyer and factory filters, reset,
  live result count.
- Register: desktop table — Milestone · File / order · Buyer · Owner ·
  Baseline · Forecast · Actual · Status. Baseline and forecast are adjacent so
  the slip is readable without arithmetic. Mobile cards carry milestone name,
  file number, forecast, and the status `Badge`.
- Every count opens its filtered list; the URL carries view, search, filters
  and cursor, as the register already does.

### 10.3 Execution File T&A tab

`TABS` becomes six: Summary · Sales Handover · Materials & Trims · Packaging ·
**Time & Action** · Changes & History. Update the pinned tab-list test in
`app/merchandiser/merchandisingShell.test.mjs` in the same commit.

Content:
- A plan header band: template name and version, calendar name and version,
  baseline number and approval, plan state `Badge`.
- The milestone register for this file, in `sequenceRank` order.
- Actions gated by capability: forecast/block/unblock (editor), baseline,
  revise, approve reschedule (approver).

### 10.4 Baseline vs forecast vs actual

Three columns, always all three, never a single "date" column:

```
Milestone            Baseline     Forecast     Actual      Status
Fabric in-house      12 Mar       18 Mar ▲6    —           FORECAST LATE
PP sample approved   20 Mar       20 Mar       19 Mar      COMPLETED
```

The slip (`▲6`) is rendered beside the forecast, in the `rework` tone, only when
non-zero. A milestone with no baseline (plan still `DRAFT`) shows an em-dash and
the plan header says why. **Never** render a forecast in the baseline column;
that is the defect this layout exists to prevent.

### 10.5 Dependency view

**No Gantt chart.** A Gantt across 40 milestones on a laptop is a picture of a
plan, not a tool for changing one; it answers "what does the schedule look like"
when the operational question is "what is holding this up".

Instead: an expandable **critical-path list**. The longest dependency chain
ending at the delivery-critical milestone, in order, each row showing its slip
and its owner department. One click expands a milestone to show its immediate
predecessors and successors with their dates. This answers the plan's
*"cross-file calendar and critical-path list"* (§7) with the half that changes
decisions.

If a timeline is later shown to materially help, it is a separate, evidenced
decision — not part of M5.

### 10.6 Reschedule dialog

Built on the existing `MerchandisingDialog` (focus trap, Escape, focus
restoration, busy-guard already implemented and audited):

1. New date picker.
2. Reason code `Select` from the approved list — required.
3. Reason note `Textarea`, minimum 15 characters — the M2 clarification rule.
4. **The impact, before the confirm button:** every affected milestone with
   before → after, and, if a committed delivery date breaks, a prominent line
   saying so and that approving creates a baseline revision.
5. Confirm disabled until reason code and note are valid.

An approver sees the same impact the requester saw, and approval refuses if it
has gone stale.

### 10.7 Accessibility

The frozen frontend's standard, which is now audited and must not regress:
real tablist semantics (arrow keys, roving `tabIndex`, `aria-controls` to one
stable panel id), dialog focus management via `useDialogSurface`, `role="alert"`
on failures, `aria-live` on result counts, and no `overflow-hidden` ancestor
above a sticky table header.

---

## 11. Permissions

| Action | Capability | Minimum role |
|---|---|---|
| Read plan, milestones, baselines, portfolio, history | `FILE_READ` | viewer |
| Update forecast | `TNA_EXECUTE` | editor |
| Block / unblock | `TNA_EXECUTE` | editor |
| Complete a `MERCHANDISING`-authority milestone | `TNA_EXECUTE` | editor |
| Request a reschedule (preview) | `TNA_EXECUTE` | editor |
| Withdraw own reschedule | `TNA_EXECUTE` | editor |
| Create a plan | `TNA_MANAGE` | approver |
| Approve baseline 1 | `TNA_MANAGE` | approver |
| Revise a baseline | `TNA_MANAGE` | approver |
| Approve / reject a reschedule | `TNA_MANAGE` | approver |
| Reopen a milestone or plan | `TNA_MANAGE` | approver |
| Bulk apply | `TNA_MANAGE` | approver |
| Manage templates and calendars | `CONFIGURATION_MANAGE` | owner |
| Complete a `SOURCE_EVENT` milestone | — | no human path |

Rules that hold regardless of the table:

- Authority is the **live** `DepartmentRole`, read per request via
  `getEffectiveRole`. `isAdmin` is not a rung and grants nothing, matching
  `access.service.js` and `useMerchandisingRole.js`.
- Being the responsible merchandiser on a file grants nothing. Assignment is a
  record attribute, never authorisation — the rule M2 established and the plan
  states (§9).
- Self-approval of a reschedule that creates a baseline revision is refused.
- The frontend's `canRunTna` / `canManageTna` are usability hints. The server
  refuses independently, on every request.

---

## 12. Migration and compatibility

**No data migration.** M5 adds records; it changes none. No existing collection
gains or loses a field.

**No plan is created retroactively.** Files open at M5's release have no T&A
plan, and the tab says so plainly — *"No Time & Action plan yet"* with the
create action for those who may — rather than inventing baselines nobody
committed to. Backdating a baseline would be the one thing M5 exists to
prevent.

**Seeding.** One `TnaTemplate` with one published version and one
`WorkingCalendar` with a Mon–Sat pattern may be seeded per company by an
**explicit, dry-run-by-default script**, following
`scripts/backfill-customer-request-line-refs.js`: `--apply` refused without
`--authorized-by`, unknown arguments refused with exit 2, batch identity
recorded, rollback that refuses to withdraw anything a plan already references.
Seeded content is a starting point for configuration, never a claim about how
this company works.

**Frozen contracts.** M1–M3 contracts are inputs: `lineRef` semantics,
allocation derivation, `unitDiscriminator`, event ownership, receiver
idempotency, live Sales authority, the shared execution projection. M5 reads
them and does not modify them. The 15 compatibility redirects are untouched.

---

## 13. Tests

Backend under `test/merchandising/`, frontend as `.test.mjs` beside the source.

### 13.1 Company isolation
A plan, milestone, baseline, template and calendar from company A are invisible
and unreachable from company B, on every read and every write, by id.

### 13.2 Capability matrix
Every row of §11, both directions: the role that may, and the role immediately
below it that may not. Plus: platform admin without a Merchandising grant is
refused; a `sales` grant is refused; a revoked grant fails on the next request.

### 13.3 Template immutability
A published version refuses every field change except `effectiveTo`, `state`,
`retiredAt`. Publishing version *n+1* leaves an existing plan's
`templateVersionId`, milestone set and baselines byte-identical.

### 13.4 Effective dating and selection
Overlapping windows resolve by date; specificity beats generality; an exact tie
raises `TNA_TEMPLATE_AMBIGUOUS` naming both; no candidate raises
`TNA_TEMPLATE_NOT_FOUND`; `resolve` shows every candidate and its score.

### 13.5 Working days and holidays
`addWorkingDays` across a weekend, across a declared holiday, across a worked
Sunday exception, with `n = 0` on a non-working day, and with negative `n`.
`workingDaysBetween` is consistent with `addWorkingDays` in both directions.
Beyond `horizonTo` raises `TNA_CALENDAR_HORIZON`.

### 13.6 Timezones
Every stored milestone date matches `^\d{4}-\d{2}-\d{2}$`. A baseline computed
under `TZ=UTC`, `TZ=Asia/Kolkata` and `TZ=America/Los_Angeles` produces
identical strings. `todayInZone` returns the calendar day in the calendar's
zone, not the server's. **Run at least one suite under a non-UTC `TZ`.**

### 13.7 Dependency cycles
A → B → A and a 5-node cycle are both refused at publish and at baseline, and
the message names the cycle. A self-edge, an unknown code and a duplicate pair
are refused. A valid diamond ranks correctly.

### 13.8 Baseline protection
`baselineDate` cannot be written by forecast, block, complete or reschedule
approval — only by baseline creation or revision. A saved baseline document
rejects edits. Two concurrent baseline approvals: one wins, one gets
`TNA_BASELINE_EXISTS` from the partial unique index. A superseded baseline
remains readable and its entries unchanged.

### 13.9 Forecast changes
A predecessor's forecast moving cascades to successors and stops where nothing
changes. An `actualDate` overrides a forecast as the propagation input. Status
recomputes to `FORECAST_LATE`, `OVERDUE`, `DUE_SOON` at the right boundaries.
A blocked milestone still forecasts.

### 13.10 Rescheduling approval
Preview writes only a `PREVIEWED` row. Approval applies the previewed impact.
A plan changed between preview and approval raises `TNA_IMPACT_STALE`. A
breach-of-committed-date reschedule creates baseline *n+1* atomically with the
approval. Requester self-approval of such a reschedule is refused. Missing
reason code or a note under 15 characters is refused.

### 13.11 Source-owned completion
A `SOURCE_EVENT` milestone refuses `POST /complete` with `TNA_SOURCE_OWNED`
naming the department. An event of a kind not in `sourceEventKinds` is a
`NOOP`. A valid event completes it with `actor: null` and the source reference
recorded. A `MERCHANDISING`-authority milestone paired with a non-Merchandising
`ownerDepartment` is refused at template publish.

### 13.12 Stale and duplicate events
Redelivering one event finds the ledger row and returns `duplicate: true`
without a second write. Two concurrent deliveries: one applies, one gets
`11000` and reports the duplicate. An event older than the recorded completion
is a `NOOP`. An event for a cancelled plan is a `NOOP`. A receiver failure
leaves the outbox row `PENDING` and retryable, and never rolls back the
Merchandising act that produced it.

### 13.13 Bulk preview
Preview writes nothing. Every row returns an outcome; a refused row does not
prevent the others. Apply requires a matching `previewId`. Over 200 rows is an
explicit refusal, not a silent truncation.

### 13.14 Cursor pagination
Portfolio and milestone lists page stably under insertion, return
`{rows, nextCursor, hasMore}`, and cap `limit`. A cursor from one filter is not
honoured under another.

### 13.15 Frontend, mobile and accessibility
Register renders as a table at `md` and cards below it, with no horizontal
scroll and no nested scroll region on mobile. The sticky header has a bounded
scrollport and no `overflow-hidden` ancestor. Portfolio tabs keep the full
tablist contract (arrow keys, Home/End, roving `tabIndex`, one stable panel id,
focus follows selection). The reschedule dialog traps focus, closes on Escape,
restores focus, and disables confirm until valid. Baseline, forecast and actual
are three distinct columns.

### 13.16 No Tasks overlap
A source scan of the M5 surface finds no `assignee`, `dueReminder`,
`checklist`, `subtask`, `delegat`, `todo`, or `snooze`. No route accepts a
per-milestone person. No model stores a reminder.

### 13.17 High-volume portfolios
A synthetic company with 500 files × 40 milestones (20,000 rows): the portfolio
first page returns within the suite's budget on the declared indexes; forecast
propagation for one plan is a single ordered pass; the counts query is an
aggregation, not 20,000 documents. Assert the query plan uses an index rather
than asserting a wall-clock number, so the test does not become flaky on a
loaded machine.

### 13.18 Regression
The full `test/merchandising` suite passes in at least two orderings. M1–M3
contract suites are unchanged. Frontend Merchandising suite and
`npx tsc --noEmit` stay green. `git diff --check` clean on every M5 file.

---

## 14. Sequential implementation steps

One chunk at a time, each ending green.

| # | Step | Deliverable | Exit |
|---|---|---|---|
| 1 | **Calendar engine** | `tnaCalendar.js`, pure, no I/O | §13.5, §13.6 pass; zero database code |
| 2 | **Reference models** | `TnaTemplate`, `TnaTemplateVersion`, `WorkingCalendar(+Version)`, `TnaReasonCode`; publish-time graph validation | §13.3, §13.4, §13.7 pass |
| 3 | **Template and calendar API** | §8.1, §8.2 routes; `CONFIGURATION_MANAGE` | §13.2 rows for config pass |
| 4 | **Plan and milestone models** | `TnaPlan`, `TnaMilestone`, `TnaBaseline`; deterministic `milestoneRef`; partial unique indexes | §13.8 pass |
| 5 | **Plan creation and baseline** | resolve → instantiate → forecast → approve baseline 1 | §13.1, §13.8 pass |
| 6 | **Forecast, block, complete** | §8.4; propagation in rank order | §13.9, §13.11 pass |
| 7 | **Reschedule** | `TnaReschedule`, preview/approve/reject, baseline revision | §13.10 pass |
| 8 | **Events** | audit + outbox additions; `tnaIntake.service.js`; delivery | §13.12 pass |
| 9 | **Portfolio and bulk** | §8.6, §8.7; indexes | §13.13, §13.14, §13.17 pass |
| 10 | **Frontend: API client + role hook** | `lib/merchandising/api.js`, `canRunTna`/`canManageTna` | typecheck green |
| 11 | **Frontend: portfolio page** | nav third entry, slab, tabs, toolbar, register, mobile cards | §13.15 pass |
| 12 | **Frontend: file T&A tab** | sixth tab, three-column dates, critical-path list, reschedule dialog | §13.15 pass; tab-list pin updated |
| 13 | **Summary integration** | §15.1 below | source-backed only |
| 14 | **Seed script** | dry-run default, `--apply` + `--authorized-by`, rollback | mirrors the M2.1 backfill's discipline |
| 15 | **Verification and handoff** | two orderings, tsc, build, `git diff --check`, handoff entry | M5 **not** declared frozen; Lane B audits |

### 14.1 Summary integration (step 13)

Real, source-backed additions only — no figure without a record behind it and a
list to open:

- **Overview** — two new counts beside the existing four: `Milestones overdue`
  and `Delivery dates at risk`, each opening its portfolio view. Both come from
  the same `/tna/portfolio/counts` endpoint. A failed read renders
  *"Couldn't check"*, never a zero, matching the existing rule.
- **Order Execution rows** — one column, `Next milestone`, showing the earliest
  incomplete milestone's name and forecast, with the status `Badge`. Nothing
  else; the register is already dense.
- **Execution File Summary** — a `Time & Action` fact group: plan state,
  baseline number, next milestone, count at risk. Absent entirely when there is
  no plan, with the honest sentence rather than zeros.
- **Changes & History** — the M5 audit actions get business sentences in
  `components/merchandiser/executionPresentation.js`'s `EVENT_SENTENCE`, in the
  established voice: *"Priya approved baseline 2, moving 6 milestones"*, not
  `TNA_BASELINE_REVISED`.

---

## 15. Explicit M5 exclusions

Not built in M5. Each is either a later milestone or another application's.

**Deliberately not T&A:**
- Personal tasks, checklists, subtasks, delegation, reminders as records,
  snoozing, per-milestone assignment. Tasks app (plan §7).
- Generic project management: user-created milestones outside a template
  version.

**Other applications':**
- Store readiness, stock availability, shortage. Store.
- PPC capacity, factory/line plan, order loading, production release. PPC
  (ADR-003).
- Production scheduling, WIP, output, rework. Production.
- IE route, SAM, method standards. IE (ADR-003).
- Supplier, rate, quotation, purchase order, procurement status. Supply Chain.
- Test and inspection outcomes as Merchandising-authored facts. Quality.
- Shipment booking, documents, dispatch. Logistics.
- Cost, margin, budget. Finance/Costing.

**Later Merchandising milestones:**
- M6: department status projections, execution-pack completion, PPC handover
  receipt.
- M7: Sales-authorised change intake, impact coordination, acknowledgements,
  T&A reforecast from a change, exports, archive, observability.

**Deliberately deferred within T&A:**
- Start-to-start and finish-to-finish dependencies (§3.4).
- Gantt/timeline rendering (§10.5) — until evidenced.
- Automatic template migration of live plans (§7.3) — a baseline revision is
  the only route.
- A background scheduler or daemon. Delivery is called after commit and by an
  operator, exactly as M1's outbox is. No timer nobody asked for.
- Milestone-level forecast events to other applications (§9.2).

---

*Prepared by Lane B. No application code, test, migration, `current-task.md` or
handoff entry was modified in producing this document.*
