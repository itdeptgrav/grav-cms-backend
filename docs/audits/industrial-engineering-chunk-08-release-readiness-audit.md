# IE Chunk 8A — release, acknowledgement and change-impact source audit

**Date:** 10 September 2026. **Revised 11 September 2026** after review: the
source findings stood, the proposed architecture did not. **Method:** read-only
source audit of current code. No application file was changed, no migration or
backfill was written, and no mutation was run against any data.

**Implementation status — 13 September 2026:** Chunks 7C1, 7C2, 7C3 and 8A-i
are accepted. The immutable IE release, atomic version chain and idempotent issue
command identified by this audit have been delivered. The next backend slice is
8A-ii, the PPC inbound queue and immutable receiver receipt. The historical
source findings below describe the state that led to the contract and are
retained as audit evidence.

> ## Verdict — three separate questions, three separate answers
>
> The earlier draft of this audit collapsed these into one "release is
> impossible" and was wrong to. They are independent, they are blocked by
> different owners, and two of the three are not blocked at all.
>
> | Question | Verdict | Blocked by |
> |---|---|---|
> | **Can IE issue a release?** | **DELIVERED — 8A-i accepted 13 Sep 2026** | Nothing |
> | **Can PPC receive and acknowledge one?** | **NOT BLOCKED** | Nothing. PPC is already a company-scoped, role-gated downstream receiving boundary with an accepted receipt pattern |
> | **Can IE references be frozen into WorkOrders?** | **SEPARATELY BLOCKED** | Production tenancy and ownership. Needs the Production owner's agreement and a company-scope decision IE cannot make |
>
> **Missing `companyId` on Production records does not block an IE release sent
> to PPC.** The release is addressed to a company-scoped PPC queue, not to a
> work order, so Production's tenancy gap constrains only the third question.
>
> **Current next backend implementation: Chunk 8A-ii — PPC inbound queue and
> immutable receiver receipt.** Chunk 8A-i is accepted. The frontend should
> expose those approval decisions before adding the release action.

---

## 1. The releasable aggregate, and the artefact that is missing

### 1.1 The Style File is the root and must stay the root

`IeStyleFile` is unique per company and style —
`{ companyId, sampleStyleId }`, `unique`, named
`ie_style_file_one_per_style_per_company`. It is the stable identity for "this
company's engineering of this style", and the product plan (§5.2) describes it
as the root that *points to* the current approved bulletin version.

**Its status must not be used as a substitute for bulletin approval, and it must
not be versioned as the approved artefact.** Three reasons from the code:

1. **It is one root per style, for ever.** Approving the root would mean either
   one approval for all time or mutating the root's status back and forth, and
   neither is a version chain.
2. **`revision` is a whole-file concurrency counter, not a bulletin version.**
   It increments on every accepted mutation, including ones that change no row.
   `ieLineLayout.service.js:378` already writes `bulletinRevision: file.revision`,
   and that conflation is a defect the corrected design removes.
3. **The plan already names the right artefact.** §5.3 — "Operation Bulletin
   Version: an immutable-on-approval ordered set of rows… Draft recalculation
   never changes an approved version."

The file today carries exactly one mutable embedded bulletin:
`bulletin: { rows: [bulletinRowSchema] }`, capped at `LIMITS.ROWS = 400`, with
`FILE_STATUS = ["DRAFT"]` and `EVENT_TYPES` covering row add, edit, remove and
reorder. There is no version, no submit, no approve and no successor.

### 1.2 The missing artefact: Operation Bulletin Version

| Design | Concurrency | Document growth | Immutable history | Successor creation |
|---|---|---|---|---|
| **A — versions embedded in `IeStyleFile`** | **Bad.** The file has one `revision`. Every submitted version would contend with every unrelated file mutation | **Bounded but real.** At the declared 400-row cap a version is roughly 160 KB; the 16 MB ceiling arrives at about 100 versions, and `history` (cap 500) shares the document | **Not enforceable.** A `pre("save")` guard cannot freeze one embedded subtree while its parent stays mutable; any writer holding the file can reach an approved version's rows | **Awkward.** A version has no identity of its own |
| **B — separate `ie_bulletin_versions` collection** | **Good.** Each version is its own optimistic-concurrency unit, as `IeLineLayout`, `IeMethodStudy` and `IeAllowancePolicy` already are | **Good.** One document per version; the file stops growing with engineering activity | **Enforceable.** State-naming filters on every mutation, plus query-layer guards covering `save`, `updateOne`, `replaceOne` and `findOneAndUpdate` — §11.1 | **Natural.** A version is a new document; the working draft stays where it already is |

**Selected: B, a separate company-scoped `IeBulletinVersion` collection.**

The deciding argument is immutability, not size. An immutable-on-approval
artefact whose immutability cannot be enforced by a schema guard is a
convention, and every other governed IE record here is already a collection of
its own for exactly that reason.

### 1.2.1 There is exactly one writable bulletin draft, and it is where it already is

**`IeStyleFile.bulletin` remains the sole working draft.**
`PATCH /api/cms/ie/engineering-files/:fileId/bulletin` →
`ieStyleFile.updateBulletin` remains its only writer, and the existing IE
frontend keeps writing through it unchanged.

**`IeBulletinVersion` never holds a writable draft.** It holds submitted
snapshots only. Its states are `IN_REVIEW`, `APPROVED`, `RETURNED` and
`SUPERSEDED` — **there is no `DRAFT` member**, so the state cannot be reached by
any route, present or future, without the model changing. This is the same
device `DownstreamHandoverReceipt` uses to make "PPC cannot reject" structural
rather than conventional.

Consequently **the partial unique index on `state: "DRAFT"` proposed in the
previous revision of this audit is removed.** That collection owns no draft, so
there is nothing for such an index to protect. What it does need is a partial
unique index on `state: "IN_REVIEW"` — one submission in review per file at a
time — which is the rule that actually matters.

The lifecycle:

| Step | What moves | Where the draft lives afterwards |
|---|---|---|
| Edit | `IeStyleFile.bulletin.rows[]`, `file.revision` + 1 | The Style File |
| **Submit** | A complete snapshot of the draft becomes a new `IeBulletinVersion` at `IN_REVIEW` | The Style File, **frozen** — see below |
| **Return** | That version becomes `RETURNED` | The Style File, editable again |
| **Approve** | That version becomes `APPROVED` and immutable; the file's pointer moves | The Style File, editable again as the **successor draft** |
| Edit after approval | `IeStyleFile.bulletin.rows[]` again | The Style File |
| Submit again | The next snapshot becomes version *n*+1 at `IN_REVIEW` | — |

**While a submission is `IN_REVIEW`, bulletin edits are refused** with
`IE_BULLETIN_VERSION_IN_REVIEW` 409, naming the version and who submitted it.
That refusal is the whole reason there is no second draft: the snapshot under
review and the draft it was taken from cannot diverge, because the draft cannot
move.

The freeze is a **stored field on the file** — `bulletinReviewVersionId`, set in
the same transaction that creates the snapshot — so the existing PATCH enforces
it in its own atomic filter rather than by reading another collection first.
§11.9 works the interleavings through.

There is no separate "successor draft" record. After approval the Style File's
working bulletin simply **is** the successor, carrying forward exactly the rows
that were approved, and the next submission mints the next version.

### 1.3 The aggregate a release must freeze

| # | Fact | Record and field | Present today |
|---|---|---|---|
| 1 | Style file identity | `IeStyleFile._id`, `.companyId`, `.sampleStyleId` | Yes |
| 2 | **Bulletin version** | **`IeBulletinVersion._id`, `.versionNo`, `.state`** | **No — §1.2** |
| 3 | Bulletin rows | `IeStyleFile.bulletin.rows[]` today; frozen into the version at submit | Yes, on the file |
| 4 | Operation identity | `rows[].ieOperationId` (`ref: "IeOperation"`) | Yes |
| 5 | Operation revision | `rows[].ieOperationRevision` | Yes |
| 6 | Operation-code snapshot | `rows[].operationCode`, `.operationName`, `.machineType` | Yes |
| 7 | Required-machine evidence | `rows[].requirementSnapshot` — `capturedAt`, `ieOperationRevision`, `requirementsConfigured`, `machineTypes[]` | Yes; `null` on pre-Chunk-6B rows, deliberately un-backfilled |
| 8 | Approved standard time | `IeMethodStudy.approved.{submissionId, standardTimeMinutes, standardTimeSeconds, standardTimeSource, normalTimeSeconds, totalAllowancePercent, allowancePolicyId, at, byName}` | **Yes — the only approved member** |
| 9 | Line-layout revision | `IeLineLayout._id`, `.revision`, `.bulletinRevision`, `.sourceFingerprint`, `.sourceApprovalDigest`, `.sourceRequirementDigest`, `.sourceRows[]`, `.stations[]` | Record yes; **approval no** |
| 10 | Capacity-standard revision | `IeCapacityStandard._id`, `.revision`, `.source.*`, `.workingTime.*`, `.manpower.*`, `.targetEfficiencyPercent` | Record yes; **approval no** |
| 11 | Frozen ramp evidence | `IeCapacityStandard.ramp.{rampProfileId, rampProfileRevision, rampProfileName, stageId, stageSequence, stageLabel, fromProductionDay, toProductionDay, targetEfficiencyPercent, capturedAt}` + `basis: "STATED_IE_ASSUMPTION"` | Yes, already frozen by copy |

**No single approved IE-version record exists.** This was checked, not assumed:
no model, service or route in `models/CMS_Models/IndustrialEngineering/`,
`services/industrialEngineering/` or `routes/CMS_Routes/IndustrialEngineering/`
declares an aggregate root spanning these facts.

### 1.4 The fingerprint, not the revision, is the source identity

`IeLineLayout` already solved this and the release inherits it verbatim:
`sourceFingerprint` is a server-computed hash over the ordered rows **and** the
approved evidence behind each, split into `sourceApprovalDigest` and
`sourceRequirementDigest` so a superseded record can say which half moved. The
model's own comment gives the reason — a row already approved can be re-timed and
approved again without the bulletin moving, and that second approval is a
different standard.

Once §1.2 exists, a layout gains `ieBulletinVersionId` and `bulletinVersionNo`
**beside** its existing `bulletinRevision` and source fields — see §3.2. Nothing
is renamed and nothing is reinterpreted. The fingerprint continues to carry the
approved-evidence half that no version number can.

### 1.5 The approved standard time is not on the bulletin row

`rows[].proposedSamMinutes` is a proposal and is documented as one: `null` means
IE has not proposed a time and raises a readiness gap. The approved figure lives
on `IeMethodStudy.approved` and reaches a layout only by being copied into
`IeLineLayout.sourceRows[]` as `standardTimeMinutes`, with `methodStudyId`,
`approvedSubmissionId` and `approvedAt` beside it. The bulletin version
approval in 7C1 must freeze the same copy, from the same source, so the two can
never disagree.

---

## 2. Lifecycle state of every required record

| Record | File | Status enum, exactly as declared | Approval? |
|---|---|---|---|
| Style Engineering File | `IeStyleFile.js:44` | `FILE_STATUS = ["DRAFT"]` | **None — and none is proposed** |
| **Bulletin Version** | — | — | **The artefact does not exist** |
| Line Layout | `IeLineLayout.js:49` | `LAYOUT_STATUS = ["DRAFT"]` | **None** |
| Capacity Standard | `IeCapacityStandard.js:58` | `STATUS = Object.freeze(["DRAFT"])` | **None** |
| Method Study | `IeMethodStudy.js:66` | `["DRAFT", "IN_REVIEW", "APPROVED"]` | **Yes** |
| Method-study submission | `IeMethodStudy.js:69` | `["IN_REVIEW", "RETURNED", "APPROVED"]` | **Yes**, maker-checker |
| Allowance Policy | `IeAllowancePolicy.js:42` | `["DRAFT", "PUBLISHED"]` | **Yes**, publish |
| Operation (library) | `IeOperation.js:89` | `["ACTIVE", "RETIRED"]` | N/A — register |
| Ramp Profile | `IeRampProfile.js:38` | `{ACTIVE, RETIRED}` | N/A — assumption |
| Line Template | `IeLineTemplate.js:39` | `["ACTIVE", "RETIRED"]` | N/A — pattern |

Counted directly across the three records a release depends on: `"APPROVED"`
appears 0 times, `"RELEASED"` 0 times, `approvedBy` 0 times, `releasedAt` 0
times. Each model says so in its own header — `IeStyleFile.js:31`,
`IeLineLayout.js:42`, `IeCapacityStandard.js:60` — and the capacity standard
publishes `canApprove: false`, `canRelease: false`, `booksCapacity: false`,
`promisesDelivery: false` on every read (`ieCapacityStandard.service.js:872`).

**`DRAFT` must not be read as approved.** A release built on today's records
would freeze a set of drafts and label them a production standard.

---

## 3. The prerequisite sequence — three small backend-only chunks

Each is independently reviewable and independently shippable. None touches
Production, a barcode, a scan, a work order or any frontend.

### 3.1 Chunk 7C1 — the immutable Bulletin Version lifecycle

**The one to build first, and the only slice specified to executable detail
here.** Everything else in this document waits on it. The complete contract —
model, indexes, endpoints, envelopes, transitions, gates, transaction boundary,
refusals, concurrency outcomes, legacy coexistence and tests — is **§11**.

In one line: the Style File's embedded bulletin stays the working draft and
keeps its existing writer; submit snapshots it into an immutable
`IeBulletinVersion`; return unfreezes the draft; approve freezes the snapshot
and moves the file's pointer in one transaction.

### 3.2 Chunk 7C2 — Line Layout approval

Adds `APPROVED` to `LAYOUT_STATUS`, with `approvedBy`, `approvedByName`,
`approvedAt` and `approvedRevision`.

**Nothing on the existing layout is renamed or reinterpreted.** `bulletinRevision`,
`sourceFingerprint`, `sourceApprovalDigest`, `sourceRequirementDigest` and
`sourceRows[]` keep their present meanings and their present writers. Two
nullable fields are **added beside** them:

| Added field | Notes |
|---|---|
| `ieBulletinVersionId` | The approved version this layout was opened from |
| `bulletinVersionNo` | Its version number, for readability |

Both are **absent, not `null`**, on every layout written before 7C1 — the
`sampleStyleId` rule from Chunk 1D: a `default: null` writes a null onto every
legacy document the moment an unrelated field is saved, fabricating the claim
"this layout was considered and has no bulletin version."

> **Pre-7C1 layouts remain readable historical evidence and are not
> approvable.** A layout with no `ieBulletinVersionId` was balanced against a
> mutable embedded bulletin, and nothing stored proves which approved version
> that was. It keeps its metrics, its frozen source rows and its place in the
> file's layout list; it is refused for approval with
> `IE_LAYOUT_BULLETIN_VERSION_UNPROVEN` 409.
>
> **To enter 7C2 approval, a new layout must be opened from an `APPROVED`
> Bulletin Version.** That is a fresh `openLayout` call against the approved
> version, producing a new layout document.
>
> **No backfill is approved.** There is nothing truthful to backfill with, for
> the same reason `requirementSnapshot` was left `null` on pre-Chunk-6B rows.

- **Bound to one approved bulletin version.** Approval is refused unless
  `ieBulletinVersionId` names an `APPROVED` version whose fingerprint still
  matches.
- **Frozen approved evidence.** `sourceRows[]` already carries
  `standardTimeMinutes`, `methodStudyId`, `approvedSubmissionId`, `approvedAt`
  and `requirementSnapshot`. Approval freezes them; it does not re-resolve them.
- **Readiness gates** — the existing codes are reused rather than reinvented:
  `IE_LAYOUT_ROWS_UNASSIGNED`, `IE_LAYOUT_NO_STATIONS`,
  `IE_LAYOUT_EMPTY_STATION`, `IE_LAYOUT_METRICS_UNAVAILABLE`,
  `IE_LAYOUT_SOURCE_CHANGED`, `IE_LAYOUT_OPERATION_STATION_INCOMPATIBLE`.
- **Immutability, maker-checker, concurrency, successor, history** — as §11.
- **Typed refusals** — `IE_LAYOUT_NOT_APPROVABLE` 409,
  `IE_LAYOUT_BULLETIN_NOT_APPROVED` 409,
  `IE_LAYOUT_BULLETIN_VERSION_UNPROVEN` 409, `IE_LAYOUT_IMMUTABLE` 409,
  `IE_LAYOUT_MAKER_CHECKER` 403, plus the existing revision-conflict and
  source-changed codes.

### 3.3 Chunk 7C3 — Capacity Standard approval

Adds `APPROVED` to the capacity standard's status.

- **Bound to one approved line-layout revision**, refused otherwise.
- **The provisional calendar limitation is retained explicitly.** Approval does
  **not** clear it: `calendarLinkage.state` stays `UNKNOWN`, the working time
  stays `IE_PLANNING_ASSUMPTION`, readiness stays `PROVISIONAL`, and
  `IE_CAPACITY_WORKING_TIME_ASSUMED` travels with the approved record. Approval
  means "a second person accepts these stated assumptions", not "the calendar is
  proved". The blocked upstream contract is unchanged and is still the one named
  in `docs/audits/industrial-engineering-chunk-07b-working-time-audit.md`.
- **A `PROVISIONAL` standard may be approved and released.** Refusing otherwise
  would block IE indefinitely on a record no department owns. What must never
  happen is a release presenting assumed working time as calendar-proved.
- **Typed refusals** — `IE_CAPACITY_STANDARD_NOT_APPROVABLE` 409,
  `IE_CAPACITY_STANDARD_LAYOUT_NOT_APPROVED` 409,
  `IE_CAPACITY_STANDARD_IMMUTABLE` 409,
  `IE_CAPACITY_STANDARD_MAKER_CHECKER` 403, plus the existing
  `IE_CAPACITY_STANDARD_REVISION_CONFLICT` and `..._SOURCE_CHANGED`.

### 3.4 Common to all three

- Company from `resolveCompanyForActor`, never a request body.
- Approval behind `requireIe("approver")` with `IE_WRITE_FORBIDDEN`;
  `ieRoutes.js:154` already anticipates precisely this.
- `history[]` bounded by `$slice` at the record's own `LIMITS.HISTORY` (200 on
  the capacity standard, 500 on the style file). Each entry: `eventId`, `type`,
  `at`, `actorId`, `actorName`, the revision or version reached, and a `summary`
  capped at 300. Never a copy of the record.
- Out of scope for all three: release, acknowledgement, PPC, any work-order
  write, any barcode or scan change, any frontend, any migration or backfill.

---

## 4. Barcode and scan continuity

*These findings were accepted at review and are unchanged.*

### 4.1 The two paths, as they actually persist

**Path A — the scanner (`routes/Barcode_Scan_Punchings/trackingRoutes.js`).**

- A piece barcode is recognised by `isBarcodeId` = `startsWith("WO-")` (line 19).
- `parseBarcode` (line 24) splits on `-` and reads
  `WO-<workOrderShortId>-<unitNumber>[-<operationNumber>]`.
- `findWorkOrderByShortId` (line 42) resolves by
  `wo._id.toString().slice(-8) === shortId`. **The work-order `_id`, not
  `workOrderNumber`, is the printed identity.**
- The scan persists exactly two fields:
  `barcodeScans.push({ barcodeId: scanId, timeStamp: scanTime })` (line 124).
  **`activeOps` is left at its default `[]` on this path.**
- The operator session is Production's: `operatorIdentityId`, `signInTime`,
  `signOutTime`, and `machines[].machineId` (`ref: "Machine"`, required).

**Path B — mark-as-done (`routes/CMS_Routes/Manufacturing/Manufacturing-Order/markAsDoneRoutes.js`).**

- Builds `operationCodes` as `string[]` from
  `workOrder.operations[].operationCode` (line 81).
- Writes virtual scans carrying `activeOps: operationCodes` (line 153).

**The load-bearing join** is `services/productionSyncService.js:55`,
`resolveActiveOpsCodesToOperationNumbers`: it lower-cases each `activeOps` entry
and matches it against `workOrderOperations[i].operationCode`, deriving
`operationNumber` from the **array index**. A mutable-code, positional match —
what Chunk 9 is eventually meant to replace, but not by breaking it.

### 4.2 Readers, counted

- `activeOps` is read in 8 non-test files: `workOrderRoutes.js`,
  `packagingRoutes.js`, `qcRoutes.js` (×2 aggregations),
  `productionDashboardRoutes.js` (×3), `CEO_Routes/Production.js`,
  `Production/Tracking/trackingRoutes.js`, `productionSyncService.js`,
  `markAsDoneRoutes.js`.
- The `slice(-8)` barcode identity appears **54 times across 27 non-test
  files**, from `trackingRoutes.js` through QC, packaging, dispatch, returns,
  vendor routes, the CEO command centre and `services/manufacturingOrderPdf.js`,
  which prints the label.

Both readers accept a string **or** a comma-joined string (`qcRoutes.js:396`,
`productionDashboardRoutes.js:296`), so deployed clients of two vintages are
already in the field.

### 4.3 Compatibility table

| Field | Owner | Chunk 8 effect | Why |
|---|---|---|---|
| Printed label `WO-<id.slice(-8)>-<unit>[-<op#>]` | Production | **UNCHANGED** | Labels are printed; 54 call sites parse this form |
| `WorkOrder._id` as the barcode key | Production | **UNCHANGED** | The parser resolves from the id, never `workOrderNumber` |
| `WorkOrder.workOrderNumber` | Production | **UNCHANGED** | Renaming an order must not invalidate a printed label |
| `ProductionTracking.machines[].machineId` (`ref: "Machine"`) | Production/Maintenance | **UNCHANGED** | A physical asset. IE's planned machine **type** is not this |
| `machines[].currentOperatorIdentityId` | Production | **UNCHANGED** | Operator session identity |
| `operators[].operatorIdentityId`, `signInTime`, `signOutTime` | Production | **UNCHANGED** | |
| `barcodeScans[].barcodeId`, `.timeStamp` | Production | **UNCHANGED** | Both `required` |
| `barcodeScans[].activeOps: [String]` | Production | **UNCHANGED** | Operation **codes**, written by mark-as-done, read by 8 files |
| `WorkOrder.operations[].operationCode` | Production | **UNCHANGED — still the device's comparison key** | `productionSyncService` matches on it |
| `WorkOrder.operations[].operationType` | Production | **UNCHANGED** | |
| `POST /api/tracking/scan`, `/bulk-scans`, `/status/:date`, `/status/today`, `/machine/:machineId/operations` | Production | **UNCHANGED** | Deployed devices |
| — | — | — | — |
| `WorkOrder.ieReleaseId`, `.ieReleaseVersionNo` | **may be ADDED**, nullable, absent on legacy | Order-level provenance | Additive; no reader changes |
| `WorkOrder.operations[].ieOperationId`, `.ieOperationRevision`, `.ieBulletinRowId` | **may be ADDED**, nullable, absent on legacy | Stable per-operation provenance **beside** `operationCode` | Additive; hangs off the existing `operations[]._id` |
| `WorkOrder.operations[].ieStandardTimeMinutes` | **may be ADDED**, nullable | The frozen approved standard | Never overwrites `plannedTimeSeconds` |

**The rule, stated once:** a stable IE reference is stored **beside** the legacy
compatibility field, never instead of it. In Chunk 8 the operation code remains
the matching key; the IE reference is provenance only. Chunk 9 may then prefer
the stable reference and report code-matching as an explicitly labelled
compatibility path.

`WorkOrder.operations[]` carries `{ _id: true }`, so each operation row already
has a stable id to hang a reference beside. Any added field must be **absent,
not `null`**, on legacy documents, for the reason Chunk 1D recorded on
`sampleStyleId`: a `default: null` writes a null onto every legacy document the
moment an unrelated field is saved, fabricating the claim "this order was
considered and has no IE release."

**Existing fence:**
`test/industrial-engineering/ie-production-tracking-continuity.test.js` already
pins all five identifiers from the IE side. Chunk 8 must extend it, not replace
it.

### 4.4 Why this half is separately blocked

| Model | `companyId` occurrences |
|---|---|
| `WorkOrder` | **0** |
| `ProductionSchedule` | **0** |
| `ProductionTracking` | **0** |
| `EmployeeProductionProgress` | **0** |
| `ProductionCompletionScanRecord` | **0** |

Company for a work order is **derived, never stored**: `sampleStyleId` →
`SampleStyle` → journey/enquiry → `styleOwnerFrom`. The accepted Chunk 1C audit
measured the result — 6 of 147 orders `ONE_COMPANY`, 141 `NO_COMPANY_PROOF`, and
**0 of 95 operational orders attributable**.

`WorkOrder.planningState` exists with a `"released"` member and **nothing writes
it**: a repository-wide search finds no writer outside tests. It is a declared
axis with readers only, and it is Project Manager's planning axis, not IE's
engineering release.

Adding `companyId` to `WorkOrder` is a Production/Project-Manager decision with
147 existing documents behind it. **This constrains the WorkOrder provenance
projection only.** It does not constrain a release addressed to PPC.

---

## 5. The IE release record and its atomic mechanics

### 5.1 Release identity

New IE-owned collection `ie_releases`:

| Field | Notes |
|---|---|
| `companyId` | Required, immutable, indexed. From membership |
| `releaseRef` | Stable across versions of one style's release line |
| `versionNo` | Required, immutable, from 1 |
| `ieStyleFileId`, `sampleStyleId` | Required, immutable |
| `state` | `ISSUED` / `SUPERSEDED` / `WITHDRAWN`. **No `DRAFT`** — a release exists only once issued |
| `aggregateFingerprint` | Required, immutable, server-computed over the complete canonical frozen payload in §5.2; distinct from the bulletin's `sourceFingerprint` |
| `source` | The frozen payload, §5.2 |
| `issuedBy`, `issuedAt` | Actor + date, immutable |
| `supersededByVersionNo` | Nullable |
| `retiredOperationOverrides[]` | §6 |
| `history[]` | Bounded, §3.4 |

There is no outbox reference on this record and no event id. Delivery is a read
of this collection — §7.3.

Unique: `{ companyId, releaseRef, versionNo }` — the arbiter for the next version
number, exactly as `{companyId, fileId, packVersionNo}` is for `ExecutionPack`.
Also unique: `{ companyId, ieStyleFileId, aggregateFingerprint }` partial on
`state: "ISSUED"` — re-releasing an identical aggregate is a no-op, not a second
version. `aggregateFingerprint` is **not** `source.sourceFingerprint`: the latter
proves only the bulletin rows, so reusing it here would incorrectly collapse two
releases whose Line Layout or Capacity Standard changed.

Immutability: the same two layers §11.1 requires of the bulletin version —
every service mutation filter names the legal current state, and query-layer
guards over `save`, `updateOne`, `updateMany`, `replaceOne` and
`findOneAndUpdate` refuse any content change to an `ISSUED`, `SUPERSEDED` or
`WITHDRAWN` release. A `pre("save")` hook alone would be bypassed by the atomic
update queries every IE service actually writes through. Only `state` and
`supersededByVersionNo` may move, and only inside the release transaction.

### 5.2 The frozen provenance payload

Copied at issue, never referenced live — the discipline `IeCapacityStandard.ramp`
already follows:

```
source: {
  bulletinVersionId, bulletinVersionNo,
  sourceFingerprint, sourceApprovalDigest, sourceRequirementDigest,
  rows: [{ rowId, sequence, ieOperationId, ieOperationRevision,
           operationCode, operationName, machineType,
           standardTimeMinutes, standardTimeSource,
           methodStudyId, approvedSubmissionId, approvedAt,
           requirementSnapshot }],
  garmentSamMinutes, samRowCount, samDerivation,
  lineLayout:       { id, revision, stationCount, metrics },
  capacityStandard: { id, revision, inputs, calculation, rampCalculation,
                      workingTimeSource, calendarLinkage, readiness },
  ramp:             { …IeCapacityStandard.ramp verbatim… },
  capturedAt,
}
```

### 5.3 The issue command

```
POST /api/cms/ie/style-files/:fileId/releases
Header: Idempotency-Key: <opaque, required>
Body:   { bulletinVersionId, expectedBulletinVersionNo,
          lineLayoutId, expectedLayoutRevision,
          capacityStandardId, expectedCapacityRevision,
          retiredOperationOverrides?: [...], note? }
201 →   { success: true, created: true,  release: {…} }
200 →   { success: true, created: false, release: {…} }   // replay or no-op
```

Refused unless every member is `APPROVED` and every binding still matches. Items
1–3 of that list are not expressible until 7C1–7C3 exist. That is the block.

### 5.4 The atomic boundary

**Four effects, and only four**, must be one fact:

1. assign `versionNo` — read the highest for `{companyId, releaseRef}` inside
   the unit, add one;
2. create the immutable release;
3. set the preceding release's `state: "SUPERSEDED"` and
   `supersededByVersionNo`;
4. record the idempotency result in the command ledger.

**There is no fifth effect.** The previous revision of this audit published a
notification event here; §7.3 removes it, because delivery is a read and an
event that delivers nothing does not belong inside a transaction that guards a
version chain.

**A MongoDB transaction is required.** The four span three documents, and a
crash between 2 and 3 would leave two `ISSUED` releases in one chain — a version
chain with two heads, which every downstream reader would then have to
disambiguate by guessing.

The accepted mechanism already exists:
`services/storePurchase/unitOfWork.service.js`. It settles transaction support
**before any domain work** with a real write inside a real transaction against a
scratch collection, because a standalone `mongod` accepts `startSession()` and
`startTransaction()` and then silently commits outside any transaction. Its two
modes are declared and the caller is told which ran.

**IE's release command must not accept the degraded mode.** Store & Purchase's
`MARKED` fallback is safe for a single-document effect with a marker; a
multi-document version chain has no equivalent marker. So:

> If `transactionsAvailable()` is false, the release command **fails closed**
> with `IE_RELEASE_ATOMICITY_UNAVAILABLE` 503, stating that issuing a release
> needs a replica set. Nothing partial is written.

Two concurrent release commands then produce one consistent chain: the loser
fails on the `{companyId, releaseRef, versionNo}` unique index inside its
transaction, the whole attempt rolls back, and it is retried or handed the
winner's result through the ledger.

### 5.5 Repeated release

| Case | Result |
|---|---|
| Same key, same request | `200`, `created: false`, the first result replayed |
| Same key, different request | `409 IDEMPOTENCY_KEY_REUSED` |
| No key | `400 IDEMPOTENCY_KEY_REQUIRED` |
| New key, identical aggregate fingerprint | `200`, `created: false`, the existing release — a no-op, not version 2 |
| New key, moved aggregate | `201`, version *n*+1; the previous becomes `SUPERSEDED` |

The ledger is the accepted `{companyId, scope, idempotencyKey}` unique pattern
with a `requestHash`, so the same key reused for a **different** request is
refused as a client bug rather than silently replaying an unrelated answer.

### 5.6 Release after source movement

`IeLineLayout` already models this and the release inherits it verbatim: a
fingerprint that no longer matches supersedes with a **new record** and never
rebases the old one. An issued release is immutable; a moved source produces a
new version; the previous one keeps its own frozen payload and its own
acknowledgement for ever.

**A released version is never silently restated.**

### 5.7 Change-impact comparison

```
GET /api/cms/ie/releases/:releaseId/impact
```

Read-only, computed, never stored. Compares the release's frozen rows against
the current approved bulletin version and reports, per row: `UNCHANGED`,
`RETIMED` (naming both studies), `REQUIREMENT_CHANGED`, `ADDED`, `REMOVED`,
`RESEQUENCED`, `OPERATION_REPLACED`; which of the two digests moved; and the
delta in garment SAM and in the capacity target.

It names affected work orders **only where `sampleStyleId` proves the style and
`styleOwnerFrom` proves the company** — 6 of 147 orders today. Every other order
is reported as `UNPROVABLE_OWNERSHIP`, never silently omitted and never guessed
at.

---

## 6. Retired operations — one decision, taken once

Two rules, at two different moments, so the same retirement is never decided
twice.

### 6.1 At Bulletin Version approval: every operation must be ACTIVE

> **A bulletin version cannot be approved while any row names a `RETIRED`
> operation. There is no override at this gate.**

Refused with `IE_BULLETIN_VERSION_OPERATION_RETIRED` 409, listing every retired
operation with its id, revision and code. The way through is to replace the row
or restore the operation — both are ordinary, reversible IE actions, and
neither needs a special authority.

This is the existing `IE_BULLETIN_OPERATION_RETIRED` readiness gap
(`ieStyleFile.service.js:61`) promoted from a warning to a hard approval gate.

### 6.2 At release: an override, only for a retirement that came afterwards

An operation can be retired **between** bulletin approval and release. Blocking
the release would strand an approved bulletin behind a library change nobody
made against it, so:

> **Release is refused if any row names a `RETIRED` operation, unless that exact
> operation and revision is named in a `retiredOperationOverrides[]` entry
> supplied with the command — and an override is accepted only when the
> operation was `ACTIVE` at bulletin-version approval and was retired after it.**

No third outcome. An operation retired *before* approval cannot reach this gate,
because §6.1 refused the approval; an override naming one is refused as not
applicable.

**Request field**

```
retiredOperationOverrides: [
  { ieOperationId, ieOperationRevision, reason }   // reason: 10–2000 chars
]
```

**Applicability rule.** The override is accepted only if the operation's
`statusChangedAt` is later than the bulletin version's `approvedAt`. Otherwise
`IE_RELEASE_OVERRIDE_NOT_APPLICABLE` 400 — as it is when the named operation is
not retired, or is not on the bulletin.

**Authority rule.** Accepted only from an IE `approver`, and the approver's
actor id must differ from `IeOperation.statusChangedBy` for that operation: the
person who retired it may not be the person who overrides its retirement.
Compared by id, with no owner or platform-administrator exemption, exactly as
`IE_METHOD_STUDY_MAKER_CHECKER` already does.

**Frozen evidence shape**, stored on the release and immutable with it:

```
retiredOperationOverrides: [{
  ieOperationId, ieOperationRevision,
  operationCode, operationName,          // snapshots, as at release
  retiredAt, retiredByName,              // copied from the library
  approvedWhileActiveAt,                 // the bulletin version's approvedAt
  reason,
  overriddenBy: { id, name }, overriddenAt,
}]
```

**Refusals.** `IE_RELEASE_OPERATION_RETIRED` 409 listing every uncovered retired
operation; `IE_RELEASE_OVERRIDE_REASON_REQUIRED` 400;
`IE_RELEASE_OVERRIDE_MAKER_CHECKER` 403;
`IE_RELEASE_OVERRIDE_NOT_APPLICABLE` 400.

## 7. The PPC receiving contract

**Not blocked.** PPC is already a company-scoped receiving boundary with an
accepted receipt pattern (`models/CMS_Models/PPC/DownstreamHandoverReceipt.js`,
`services/ppc/inboundPack.service.js`,
`routes/CMS_Routes/PPC/inboundPacksRoute.js`). This contract mirrors it rather
than inventing a second shape.

`docs/tasks/industrial-engineering-chunk-00.md` already assigns ownership: "PPC
owns order loading, capacity booking and schedules; Production owns actual
execution and assignments."

### 7.1 The surfaces

```
GET  /api/cms/ppc/ie-releases?view=pending|decided|all&cursor=&limit=
GET  /api/cms/ppc/ie-releases/:releaseId
POST /api/cms/ppc/ie-releases/:releaseId/accept
POST /api/cms/ppc/ie-releases/:releaseId/clarify
```

- **The queue** lists `ISSUED` and `SUPERSEDED` releases for the acting company,
  cursor-paged, newest first. `view` mirrors PPC's existing
  `["pending", "decided", "all"]`.
- **Read one** returns an **allowlisted projection** of the frozen release —
  the bulletin rows, garment SAM, the layout metrics, the capacity figures, the
  ramp evidence, the readiness verdict and its gaps, and the calendar limitation
  in full. It returns no IE working state: no draft, no history of the file, no
  method-study observations, no allowance breakdown beyond the total, and no
  Sales, customer or costing field. PPC receives a handover, not IE's workspace.
- **Accept / clarify** write PPC's own receipt.

### 7.2 The receipt — written once by PPC, never touched by IE

Collection `ppc_ie_release_receipts`, PPC-owned:

| Field | Notes |
|---|---|
| `companyId` | Required, immutable, indexed |
| `releaseRef`, `releaseVersionNo`, `ieReleaseId` | Required, immutable |
| `state` | `ACCEPTED` / `CLARIFICATION_REQUESTED` — **PPC's own decision, and nothing else** |
| `clarification` | `{ category, reason }`, category from a closed list |
| `decidedBy`, `decidedAt` | PPC's own actor, from session, never a body |

Unique: `{ companyId, releaseRef, releaseVersionNo }`. One answer per version;
a redelivery cannot mint a second, and a later version legitimately can.

**PENDING is computed, not stored.** An `ISSUED` release with no receipt row
**is** pending, and every reader derives it — `inboundPack.service.js:165`
states the same rule for packs. Writing a PENDING row at release time would mean
IE creating a PPC record before PPC had done anything.

**There is no reject.** Following `DownstreamHandoverReceipt`, PPC may ask for
clarification; refusing an engineering standard outright is not PPC's call any
more than declining a Sales handover is Merchandising's.

> ### 7.2.1 A receipt is immutable, and IE never writes one
>
> The previous revision of this audit put `SUPERSEDED` and `CANCELLED_BY_IE` in
> the receipt's own enum, which implied IE reaching into PPC's collection to
> move a row when a release was superseded. **That is removed.** IE must never
> insert, update or delete a PPC receipt, and a test must scan
> `services/industrialEngineering/` for any import of the receipt model —
> the same inversion `inboundPack.service.js` documents for the Merchandising
> direction.
>
> The stored row therefore holds only what PPC decided, and it stays exactly as
> written. **"PPC accepted version 2 on the 4th" remains true for ever**, and it
> remains stored that way.

**`effectiveState` is derived at read time**, by joining the receipt to its IE
release's current state. It is never persisted:

| Release state | Receipt row | `effectiveState` |
|---|---|---|
| `ISSUED` | absent | `PENDING` |
| `ISSUED` | `ACCEPTED` | `ACCEPTED` |
| `ISSUED` | `CLARIFICATION_REQUESTED` | `CLARIFICATION_REQUESTED` |
| `SUPERSEDED` | absent | `SUPERSEDED_UNDECIDED` |
| `SUPERSEDED` | `ACCEPTED` | `ACCEPTED_SUPERSEDED` |
| `SUPERSEDED` | `CLARIFICATION_REQUESTED` | `CLARIFICATION_REQUESTED_SUPERSEDED` |
| `WITHDRAWN` | any or none | `WITHDRAWN` |

Every one of those names both halves, so a reader can always see what PPC said
**and** what has happened to the thing it said it about.

### 7.3 Delivery — a receiver read, and Chunk 8A has no outbox

**Decision: PPC reads the immutable IE release directly.** The queue in §7.1 is
a company-scoped query over `ie_releases` by `companyId` and `state`, exactly as
`inboundPack.service.listInbound` queries `ExecutionPack` by state.

**Chunk 8A therefore has no outbox.** The previous revision described one, and
it was decoration: with delivery as a read, an event delivers nothing, can only
disagree with the queue, and would still have to be reconciled against it. So
`ie_outbox_events` and `sourceEventId` are removed from this contract entirely,
and the atomic transaction in §5.4 covers four effects rather than five.

- **Replay** — not applicable. There is no stream to replay. A release read
  twice is the same document twice.
- **Idempotency** — every PPC decision takes an `Idempotency-Key` through the
  same `once()` ledger helper PPC already uses, scoped
  `{companyId, scope, idempotencyKey}` with a `requestHash`, so the same key
  reused for a different request is refused rather than silently replayed.
- **Reconciliation** — the queue *is* the reconciliation. Any `ISSUED` release
  with no receipt is pending, by definition, at every read. No job, no lag, and
  no way for a release to be lost in transit because there is no transit.

> **A genuine transactional outbox is still wanted — later.** The product plan's
> migration architecture already names it: item 9, "Build an outbox and
> idempotent consumers for release and revision events." It belongs with the
> replay worker and the observability it needs, in the scale-and-operations
> chunk, when there is a real remote consumer that cannot simply read the
> collection. Building an unused one now would mean maintaining a second, weaker
> copy of a fact PPC can already read directly.

### 7.4 How IE publishes without writing PPC's receipt

IE issues a release into its own collection. That is the whole of publishing:
the release's presence in `ie_releases` with `state: "ISSUED"` and the acting
company's id is what puts it in PPC's queue.

**Nothing in `services/industrialEngineering/` may import the PPC receipt model
or the PPC service**, and a test must scan for it. If IE later needs to show
"PPC accepted this", it **reads** the receipt or is handed a mirrored copy
through its own receiver, labelled "as PPC recorded it", with the receipt
remaining authoritative. Reading and mirroring are not authoring.

### 7.5 Repeated delivery, repeated decision, superseded release

| Case | Result |
|---|---|
| The same release appears twice in the queue | Impossible — the queue is a query over one document |
| Second decision, same version, identical | `200`, replayed from the ledger |
| Second decision, same version, different | `409 IE_RELEASE_ALREADY_ACKNOWLEDGED` |
| A decision on a `SUPERSEDED` version | `409 IE_RELEASE_VERSION_SUPERSEDED`, naming the current version. **An older release can never be newly accepted or clarified** |
| A decision on a `WITHDRAWN` release | `409 IE_RELEASE_WITHDRAWN` |
| A new version issues while an older one is undecided | **Nothing is written to PPC.** The older release becomes `SUPERSEDED` in `ie_releases`; it has no receipt, so it reads `SUPERSEDED_UNDECIDED`. No answer is fabricated for it |
| A new version issues after the older one was accepted | **The acceptance row is untouched.** It reads `ACCEPTED_SUPERSEDED` |
| The new version | Appears in the queue **independently as `PENDING`**, because it has no receipt of its own |

### 7.6 Company and role enforcement

- Company from `resolveCompanyForActor` on both sides; never a body.
- Issuing: **IE `approver`** (`requireIe("approver")`, `IE_WRITE_FORBIDDEN`).
- Reading a release in IE: IE `viewer`.
- Reading the PPC queue: **PPC `viewer`** via `ppcCapability`.
- Deciding: **PPC `approver`** via `ppcCapability`.
- An IE role must not be able to acknowledge on PPC's behalf, and a PPC role
  must not be able to issue. `services/ppc/access.service.js` already refuses a
  Merchandising role that can accept on PPC's behalf; the same rule applies
  here, with `IE_RELEASE_ACKNOWLEDGEMENT_FORBIDDEN` 403.

---

## 8. Typed refusal catalogue

To be registered in `services/storePurchase/errors.js` beside the 84 existing
`IE_*` codes, following the same `{ status, code }` shape.

| Code | HTTP | Meaning |
|---|---|---|
| `IE_BULLETIN_VERSION_NOT_FOUND` | 404 | Absent, foreign or malformed — indistinguishable |
| `IE_BULLETIN_VERSION_REVISION_CONFLICT` | 409 | `{ expected, actual }` |
| `IE_BULLETIN_VERSION_IMMUTABLE` | 409 | Any write to an approved version |
| `IE_BULLETIN_VERSION_IN_REVIEW` | 409 | A submission is under review; the draft is frozen |
| `IE_BULLETIN_VERSION_SUBMISSION_EXISTS` | 409 | A second submission while one is in review |
| `IE_BULLETIN_VERSION_OPERATION_RETIRED` | 409 | §6.1 — no override at this gate |
| `IE_BULLETIN_VERSION_NOT_READY` | 409 | Carries the full gap list |
| `IE_BULLETIN_VERSION_TRANSITION_INVALID` | 409 | Not a legal state move |
| `IE_BULLETIN_VERSION_MAKER_CHECKER` | 403 | Approver is the submitter |
| `IE_BULLETIN_VERSION_ATOMICITY_UNAVAILABLE` | 503 | Transactions unavailable — §11.7 |
| `IE_BULLETIN_VERSION_REVIEW_REASON_REQUIRED` | 400 | A return needs a reason |
| `IE_LAYOUT_NOT_APPROVABLE` | 409 | Carries the layout's blocking gap codes |
| `IE_LAYOUT_BULLETIN_NOT_APPROVED` | 409 | Bound version is not approved |
| `IE_LAYOUT_BULLETIN_VERSION_UNPROVEN` | 409 | A pre-7C1 layout; open a new one from an approved version |
| `IE_LAYOUT_IMMUTABLE` | 409 | Any write to an approved layout |
| `IE_LAYOUT_MAKER_CHECKER` | 403 | |
| `IE_CAPACITY_STANDARD_NOT_APPROVABLE` | 409 | |
| `IE_CAPACITY_STANDARD_LAYOUT_NOT_APPROVED` | 409 | |
| `IE_CAPACITY_STANDARD_IMMUTABLE` | 409 | |
| `IE_CAPACITY_STANDARD_MAKER_CHECKER` | 403 | |
| `IE_RELEASE_NOT_FOUND` | 404 | |
| `IE_RELEASE_NOT_APPROVED` | 409 | Names every unapproved member |
| `IE_RELEASE_SOURCE_CHANGED` | 409 | Fingerprint moved since binding |
| `IE_RELEASE_REVISION_CONFLICT` | 409 | `{ expected, actual }` |
| `IE_RELEASE_LAYOUT_NOT_READY` | 409 | Carries the layout's own gap codes |
| `IE_RELEASE_CAPACITY_NOT_BOUND` | 409 | Standard not bound to the released layout revision |
| `IE_RELEASE_OPERATION_RETIRED` | 409 | Lists every uncovered retired operation |
| `IE_RELEASE_OVERRIDE_REASON_REQUIRED` | 400 | §6.2 |
| `IE_RELEASE_OVERRIDE_MAKER_CHECKER` | 403 | §6.2 |
| `IE_RELEASE_OVERRIDE_NOT_APPLICABLE` | 400 | §6.2 — not retired, not on the bulletin, or retired before approval |
| `IE_RELEASE_IMMUTABLE` | 409 | Any write to an issued release |
| `IE_RELEASE_WITHDRAWN` | 409 | |
| `IE_RELEASE_VERSION_SUPERSEDED` | 409 | Names the current version |
| `IE_RELEASE_ALREADY_ACKNOWLEDGED` | 409 | A conflicting second answer |
| `IE_RELEASE_ACKNOWLEDGEMENT_FORBIDDEN` | 403 | IE actor attempting PPC's decision |
| `IE_RELEASE_ATOMICITY_UNAVAILABLE` | 503 | Transactions unavailable — §5.4 |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Already registered |
| `IDEMPOTENCY_KEY_REUSED` | 409 | Already registered |

---

## 9. Verdict and implementation order

> ### Chunks 7C1–7C3 and 8A-i are accepted; build Chunk 8A-ii next.
>
> Not the approval of three records together, and **not** an `APPROVED` status
> on `IeStyleFile`. The Style File stays the stable root and gains only a
> pointer to its current approved bulletin version.
>
> 7C1 delivered the immutable Bulletin Version lifecycle, 7C2 delivered Line
> Layout approval against that version, and 7C3 delivered Capacity Standard
> approval against one exact approved layout revision while retaining the
> provisional calendar truth. The complete approval aggregate now exists.
> **7C1's retained executable contract is §11.**

| Slice | Depends on | Blocked by |
|---|---|---|
| **7C1** — immutable Bulletin Version submit/review/approve/successor (**accepted 11 Sep 2026**) | — | Nothing |
| **7C2** — Line Layout approval against one approved bulletin version (**accepted 11 Sep 2026**) | 7C1 | Nothing |
| **7C3** — Capacity Standard approval against one approved layout revision, provisional calendar retained (**accepted 13 Sep 2026**) | 7C2 | Nothing |
| **8A-i** — immutable IE release and idempotent issue command (**accepted 13 Sep 2026**) | 7C1–7C3 | Nothing |
| **8A-ii** — PPC inbound queue and receipt | 8A-i | 8A-i only. **PPC itself is not blocked** |
| **8A-iii** — change-impact comparison | 8A-i | 8A-i |
| **WorkOrder provenance projection** | 8A-i | **Separately blocked** — Production ownership and tenancy approval (§4.4). Not on this path |
| **Transactional outbox, replay worker, observability** | 8A-ii | Deferred by design to the scale-and-operations chunk the product plan already names (migration architecture, item 9). **Chunk 8A has none** — §7.3 |

---

## 10. Explicit scope

**Included in this audit:** IE models, services, routes and tests through Chunk
7B; `WorkOrder`; `ProductionSchedule`; `ProductionTracking`;
`EmployeeProductionProgress`; `ProductionCompletionScanRecord`; the scan and
mark-as-done routes and every `activeOps` reader;
`constants/workOrderPlanningState.js`; PPC's access service, receipt model,
inbound service and route; Merchandising's change-control, execution-pack,
outbox, intake-ledger and command-ledger precedents; Store & Purchase's
unit-of-work transaction probe.

**Explicitly excluded by design:** an outbox, a notification event, a replay
worker and any `sourceEventId` — Chunk 8A has none, and §7.3 says why; any
writable draft in `IeBulletinVersion`; any IE write to a PPC receipt; any
override of a retirement at bulletin approval.

**Explicitly excluded and unchanged:** every application file — nothing was
edited; any migration or backfill, including of the existing embedded bulletin
and of pre-7C1 line layouts;
the printed barcode format; work-order barcode identity; `machineId`; scan
payloads and routes; operation-code snapshots and their readers; Production
ownership of assignment and execution; `WorkOrder.planningState`, which is
Project Manager's axis; the working-time calendar, still blocked on the contract
named in the Chunk 7B audit; any IE frontend.

## 11. The executable 7C1 contract

Everything needed to implement the immutable Bulletin Version lifecycle, and
nothing beyond it. Backend only.

### 11.1 Model — `ie_bulletin_versions`

| Field | Type | Notes |
|---|---|---|
| `companyId` | ObjectId, required, immutable, indexed | From membership, never a body |
| `ieStyleFileId` | ObjectId, required, immutable | |
| `sampleStyleId` | ObjectId, required, immutable | Copied from the file |
| `versionNo` | Number, required, immutable, min 1 | Allocated at submit — §11.8 |
| `state` | String, required, enum **`["IN_REVIEW", "APPROVED", "RETURNED", "SUPERSEDED"]`** | **No `DRAFT`** — §1.2.1 |
| `revision` | Number, default 1, min 1 | This document's own optimistic counter |
| `fileRevisionAtSubmit` | Number, required, immutable | Which `IeStyleFile.revision` was snapshotted |
| `rows[]` | Sub-schema, immutable once `APPROVED` | §11.2 |
| `totals` | `{ garmentSamMinutes, samRowCount, samDerivation }` | Server-computed |
| `allowancePolicyId`, `allowancePolicyRevision` | ObjectId / Number, nullable | The published policy behind the approved times |
| `sourceFingerprint`, `sourceApprovalDigest`, `sourceRequirementDigest` | String, required | Server-computed; never accepted from a client |
| `submittedBy`, `submittedByName`, `submittedAt` | ObjectId / String / Date, required | Actor **id** for maker-checker |
| `reviewedBy`, `reviewedByName`, `reviewedAt`, `returnReason` | nullable | Set by return |
| `approvedBy`, `approvedByName`, `approvedAt` | nullable | Set by approve |
| `supersedesVersionNo`, `supersededByVersionNo` | Number, nullable | |
| `history[]` | Bounded, `$slice: -200` | `eventId`, `type`, `at`, `actorId`, `actorName`, `versionNo`, `summary` ≤ 300 |

Event types: `BULLETIN_VERSION_SUBMITTED`, `BULLETIN_VERSION_RETURNED`,
`BULLETIN_VERSION_APPROVED`, `BULLETIN_VERSION_SUPERSEDED`.

**Immutability guard — two layers, because one is not enough.**

A `pre("save")` hook alone does **not** protect this record. Document middleware
runs on `save()` and on nothing else, and every IE service writes through atomic
update queries: `ieStyleFile.service.js:882` uses `findOneAndUpdate`, and so
does every mutation in the layout, capacity and ramp services. A hook would be
bypassed by the very code that is supposed to be constrained by it.

So both layers are required:

1. **Every service mutation filter explicitly names the legal current state.**
   No update on this collection may be written without a `state` clause. Return
   and approve filter on `state: "IN_REVIEW"`; the supersession step filters on
   `state: "APPROVED"`. A filter that omits the state is the defect, and the
   test in §11.12 scans for it.
2. **Model-level query protection covering `save`, `replaceOne`, `updateOne`,
   `updateMany` and `findOneAndUpdate`** — pre-hooks on all of them. A Bulletin
   Version is a frozen submitted snapshot from the instant it is created, so
   content fields are immutable in **every** state: `IN_REVIEW`, `RETURNED`,
   `APPROVED` and `SUPERSEDED`. Transition updates use closed allowlists:
   return may write only return/reviewer metadata, revision and history;
   approval only approval metadata, revision and history; supersession only
   `state`, `supersededByVersionNo`, revision and history. `RETURNED` and
   `SUPERSEDED` accept no later mutation.

**Only the controlled approval transaction may move `APPROVED` → `SUPERSEDED`
and set `supersededByVersionNo`** (§11.7, step 3). That is the one exception the
second layer permits, and it is permitted by naming those two fields, not by
exempting a caller.

### 11.2 The frozen row

The Style File's row shape, plus the approved evidence resolved at submit:

```
{ rowId, sequence,
  ieOperationId, ieOperationRevision, operationCode, operationName, machineType,
  proposedSamMinutes, note, requirementSnapshot,
  standardTimeMinutes, standardTimeSource,
  methodStudyId, approvedSubmissionId, approvedAt }
```

The last five are resolved by **the existing
`ieLineLayout.service.approvedTimesFor`**, including its `laterApproval`
tie-break — newest `approved.at`, then the larger `_id`. Reusing it is not
convenience: a version and any layout later opened from it must bind the same
study, and two resolvers would eventually disagree.

### 11.3 Indexes

| Index | Kind | Why |
|---|---|---|
| `{ companyId, ieStyleFileId, versionNo }` | **unique** | The arbiter for version allocation — §11.8 |
| `{ companyId, ieStyleFileId }` partial on `state: "IN_REVIEW"` | **unique** | One submission in review per file |
| `{ companyId, ieStyleFileId, versionNo: -1 }` | plain | The list endpoint's own order |
| `{ companyId, state, updatedAt: -1, _id: -1 }` | plain | Cross-file review queue |

**No partial unique index on `DRAFT`.** That state does not exist here — §1.2.1.

### 11.4 Four fields added to `IeStyleFile`

| Field | Notes |
|---|---|
| `currentApprovedBulletinVersionId` | ObjectId, nullable, **absent on legacy** |
| `currentApprovedVersionNo` | Number, nullable, **absent on legacy** |
| `bulletinReviewVersionId` | ObjectId, nullable, **absent on legacy** |
| `bulletinReviewVersionNo` | Number, nullable, **absent on legacy** |

The last two are **the review pointer**: they name the one submitted Bulletin
Version currently freezing the working draft. Their presence *is* the freeze —
see §11.7 and §11.8. A file with no submission in review has neither field, and
they are absent rather than `null`, for the Chunk 1D reason: a `default: null`
writes a null onto every legacy document the moment an unrelated field is saved,
fabricating the claim "this file was considered and has no submission".

The freeze is therefore a **stored, queryable fact on the file itself**, not a
lookup into another collection. That is what lets the existing bulletin PATCH
close its own race in a single atomic filter (§11.9) instead of reading the
version collection first and acting on what it found.

`FILE_STATUS` stays `["DRAFT"]`. The file gains no status, no approval and no
version of its own.

### 11.5 Endpoints

| Route | Role | Body | Success |
|---|---|---|---|
| `POST /api/cms/ie/engineering-files/:fileId/bulletin-versions` | `editor` | `{ expectedRevision }` | `201 { success, created: true, version, file }` |
| `GET /api/cms/ie/engineering-files/:fileId/bulletin-versions` | `viewer` | — | `200 { success, versions[], limit, hasMore, nextCursor, sort }` |
| `GET /api/cms/ie/bulletin-versions/:versionId` | `viewer` | — | `200 { success, version }` (with history) |
| `POST /api/cms/ie/bulletin-versions/:versionId/return` | **`approver`** | `{ expectedRevision, reason }` | `200 { success, updated: true, version, file }` |
| `POST /api/cms/ie/bulletin-versions/:versionId/approve` | **`approver`** | `{ expectedRevision }` | `200 { success, updated: true, version, file }` |

Submit is `editor` because it proposes; return and approve are `approver`
because they decide. `PATCH /engineering-files/:fileId/bulletin` remains the
only writer of the draft; its request and response shapes are unchanged, and the
one thing that changes about it is a clause in its atomic filter (§11.9).

Every `file` envelope carries `bulletinReviewVersionId`, `bulletinReviewVersionNo`,
`currentApprovedBulletinVersionId` and `currentApprovedVersionNo`, so a client
can render "frozen, under review by X" without a second request.

Every route: `requireCompany`, company from `resolveCompanyForActor`, actor from
`actorOf(req)` — identity only, never authority.

### 11.6 Transitions

| From | Command | To | Review pointer | Draft afterwards | Illegal from |
|---|---|---|---|---|---|
| — | submit | `IN_REVIEW` | **set** | **frozen** | any state while one is `IN_REVIEW` |
| `IN_REVIEW` | return | `RETURNED` | cleared | editable | `APPROVED`, `RETURNED`, `SUPERSEDED` |
| `IN_REVIEW` | approve | `APPROVED` | cleared | editable, as the successor | `APPROVED`, `RETURNED`, `SUPERSEDED` |
| `APPROVED` | *(a later version approves)* | `SUPERSEDED` | — | — | not a command; an effect of §11.7 |

`RETURNED` and `SUPERSEDED` are terminal. A returned submission is evidence and
is never reopened: the draft is edited and submitted again as a **new** version.

The review pointer is set by exactly one command and cleared by exactly two, and
in all three cases it moves inside the same transaction as the version itself.
It is never set or cleared on its own.

### 11.7 All three commands are transactional

Submit, return and approve each write **two documents** — the version and the
Style File — so all three are transactions. The previous revision made only
approval transactional, and that was wrong: a submit that created a snapshot and
failed before setting the review pointer would leave an `IN_REVIEW` version
alongside an editable draft, which is precisely the divergence this lifecycle
exists to prevent.

**Support is settled before any domain work** by
`services/storePurchase/unitOfWork.service.js`'s probe, which writes inside a
real transaction against a scratch collection — because a standalone `mongod`
accepts `startSession()` and `startTransaction()` and then silently commits
outside any transaction. **All three commands fail closed** with
`IE_BULLETIN_VERSION_ATOMICITY_UNAVAILABLE` 503 when transactions are
unsupported, and write nothing.

#### Submit

1. prove transaction support;
2. allocate `versionNo` — the highest for `{companyId, ieStyleFileId}` read
   inside the transaction, plus one (§11.8);
3. create the `IN_REVIEW` snapshot;
4. conditionally update the Style File on
   `{ _id, companyId, revision: expectedRevision, status: "DRAFT",
      bulletinReviewVersionId: { $exists: false } }`;
5. `$set` `bulletinReviewVersionId` and `bulletinReviewVersionNo`;
6. `$inc: { revision: 1 }` and push the history event;
7. commit both, or neither.

The `$exists: false` clause in step 4 is what makes a second submission
impossible even before the partial unique index is consulted: a file already
holding a review pointer matches no filter.

#### Return

1. prove transaction support;
2. conditionally move the version on
   `{ _id: versionId, companyId, ieStyleFileId, state: "IN_REVIEW",
      revision: expectedRevision }` → `RETURNED`, with `reviewedBy/Name/At`,
   `returnReason`, `$inc: { revision: 1 }` and a history push;
3. conditionally clear the Style File's review pointer on
   `{ _id: fileId, companyId, bulletinReviewVersionId: versionId }` —
   **only when it names that exact version** — with
   `$unset: { bulletinReviewVersionId: "", bulletinReviewVersionNo: "" }`;
4. `$inc: { revision: 1 }` on the file;
5. commit both, or neither.

Step 3's predicate is the point. A blind `$unset` would let a return for one
version release a freeze belonging to another.

#### Approve

1. prove transaction support;
2. conditionally approve the version on
   `{ _id: versionId, companyId, ieStyleFileId, state: "IN_REVIEW",
      revision: expectedRevision }` → `APPROVED`, with `approvedBy/Name/At`,
   `$inc: { revision: 1 }` and a history push;
3. when a previously approved version exists, conditionally move it on
   `{ companyId, ieStyleFileId, state: "APPROVED", _id: { $ne: versionId } }`
   → `SUPERSEDED` with `supersededByVersionNo`;
4. clear the review pointer on
   `{ _id: fileId, companyId, bulletinReviewVersionId: versionId }`;
5. `$set` `currentApprovedBulletinVersionId` and `currentApprovedVersionNo`;
6. `$inc: { revision: 1 }` on the file;
7. commit all, or none.

Steps 4 and 5 are one file update. A file pointing at a version that is not
approved, an approved version the file does not point at, or a cleared freeze
without a new pointer must each be unreachable rather than merely unlikely.

### 11.8 Concurrency outcomes

| Race | Outcome |
|---|---|
| **Two simultaneous submissions** | Two mechanisms, either sufficient. The Style File filter's `bulletinReviewVersionId: { $exists: false }` matches no document once the first commits; the partial unique index on `state: "IN_REVIEW"` refuses the second snapshot. The loser answers `IE_BULLETIN_VERSION_SUBMISSION_EXISTS` 409 naming the version already in review. Never two versions from one draft |
| **Version allocation** | The highest `versionNo` for the file is read **inside the transaction**, plus one; `{companyId, ieStyleFileId, versionNo}` unique is the actual arbiter, as `{companyId, fileId, packVersionNo}` is for `ExecutionPack`. A racing pair means the loser's transaction aborts on the duplicate key and is retried or refused — never a duplicate number, and never a gap that hides one |
| **Two simultaneous approvals** | Both filter on `state: "IN_REVIEW"` **and** `revision: expectedRevision`. The first commits and moves both; the second matches nothing and answers `IE_BULLETIN_VERSION_REVISION_CONFLICT` 409 with `{ expected, actual }`. Exactly one file pointer is written and exactly one predecessor is superseded |
| **Approval racing a return** | The same two filters decide. Whichever commits first moves the version out of `IN_REVIEW`; the loser matches nothing, re-reads once to classify, and answers `IE_BULLETIN_VERSION_TRANSITION_INVALID` 409 naming the state it actually found. The review pointer is cleared exactly once, by whichever won, because both clear it on `bulletinReviewVersionId: versionId` |
| **Approval racing a Style File edit** | The edit cannot be in flight against a frozen file — see the next row. An edit arriving in the instant *after* approval commits finds no review pointer, succeeds, and legitimately begins the successor draft. The approved version is frozen and unaffected |
| **Submit racing a bulletin PATCH** | §11.9. Whichever commits first wins, and the loser is told which one it was. There is no interleaving in which a snapshot and an editable draft both exist |
| **Return or approve racing a PATCH** | The PATCH filter requires no review pointer, so it cannot commit while a submission is in review. Once return or approve commits and clears the pointer, the PATCH is a normal edit of the successor draft |

### 11.9 Closing the PATCH race

The existing writer,
`PATCH /api/cms/ie/engineering-files/:fileId/bulletin` →
`ieStyleFile.updateBulletin`, already performs one conditional
`findOneAndUpdate` on
`{ _id, companyId, revision: expected, status: "DRAFT" }`
(`ieStyleFile.service.js:882`). **One clause is added to that filter and nothing
else about the route changes:**

```
{ _id, companyId, revision: expected, status: "DRAFT",
  bulletinReviewVersionId: { $exists: false } }
```

Checking the freeze by reading the version collection first and then writing
would be two operations, and two operations are what a race gets between. The
freeze is a field on the document being written, so the same filter that already
enforces the revision enforces the freeze, atomically, at no extra cost.

The route's existing miss-classifier — the single company-scoped re-read that
says *which* precondition failed (`ieStyleFile.service.js:898`) — gains one
branch: a file now carrying `bulletinReviewVersionId` answers
`IE_BULLETIN_VERSION_IN_REVIEW` 409, naming the version and its submitter,
rather than a revision conflict that would misdescribe what happened.

The two interleavings, and there are only two:

| Order | Result |
|---|---|
| **PATCH commits first** | The file's `revision` has moved, so submit's conditional update on `revision: expectedRevision` matches nothing. Submit's transaction aborts: the snapshot is rolled back and the caller gets `IE_FILE_REVISION_CONFLICT` 409. No orphan version is left behind, because the snapshot and the pointer commit together (§11.7) |
| **Submit commits first** | The file carries `bulletinReviewVersionId`, so the PATCH filter matches nothing and the caller gets `IE_BULLETIN_VERSION_IN_REVIEW` 409. The draft is unchanged |

**A snapshot and an editable draft can never diverge**, because the fact that
freezes the draft and the fact that records the snapshot are set in one
transaction, and the edit path tests that same fact in its own atomic filter.

### 11.10 Readiness gates for approval

Refused with `IE_BULLETIN_VERSION_NOT_READY` 409 carrying the complete list,
never the first failure alone:

1. the bulletin is not empty (`IE_BULLETIN_EMPTY`);
2. no duplicate row (`IE_BULLETIN_ROW_DUPLICATE`);
3. every row has an `APPROVED` method study whose `ieOperationRevision` matches
   the row's;
4. **every operation is `ACTIVE`** — §6.1, no override
   (`IE_BULLETIN_VERSION_OPERATION_RETIRED`);
5. the file's R&D source version is still the approved one
   (`IE_SOURCE_VERSION_SUPERSEDED`);
6. the approver's id differs from `submittedBy`
   (`IE_BULLETIN_VERSION_MAKER_CHECKER` 403).

Gates 1–5 are checked at **submit** as well, so an unusable snapshot is refused
before a reviewer is asked to look at it; they are checked **again** at approve,
because the library can move in between.

### 11.11 Legacy coexistence, and no migration

- `IeStyleFile.bulletin` keeps its shape, its `LIMITS.ROWS = 400` cap, its
  history event types and its PATCH route. Nothing about it changes.
- A file with no `currentApprovedBulletinVersionId` has simply never had a
  version approved. The field is **absent, not `null`**.
- Existing line layouts keep `bulletinRevision` and every source field, and are
  readable historical evidence — §3.2.
- **No migration and no backfill is approved by this audit.** Version 1 of any
  file is created by somebody pressing submit, not by a script. Manufacturing a
  version 1 from today's mutable draft would assert that somebody approved it.

### 11.12 Required tests

1. The draft's only writer is still the existing PATCH route; a source scan
   proves no other service writes `bulletin.rows`.
2. Submit snapshots the complete draft, including `requirementSnapshot` and the
   resolved approved times, and the snapshot equals the draft field for field.
3. **Submit sets the review pointer**, and the snapshot and the pointer are
   present or absent together — never one without the other.
4. Submit freezes the draft: a PATCH during `IN_REVIEW` answers
   `IE_BULLETIN_VERSION_IN_REVIEW` 409 and changes nothing.
5. **PATCH-first**: a PATCH committed between submit's read and its write makes
   submit answer `IE_FILE_REVISION_CONFLICT`, and **no version document remains**.
6. **Submit-first**: the PATCH answers `IE_BULLETIN_VERSION_IN_REVIEW`, and the
   draft rows are byte-identical afterwards.
7. Return unfreezes it: the pointer is cleared and the same PATCH then succeeds.
8. **A return for one version cannot clear another version's pointer** — the
   `bulletinReviewVersionId: versionId` predicate holds.
9. Approve clears the review pointer and sets the approved pointer in one file
   update; both land or neither does.
10. The submitted snapshot is immutable immediately: every content write to an
    `IN_REVIEW`, `RETURNED`, `APPROVED` or `SUPERSEDED` version is refused —
    through `save`, `updateOne`, `updateMany`, `replaceOne` and
    `findOneAndUpdate`.
11. Approving a second version supersedes the first and re-points the file.
12. Only the approval transaction can move `APPROVED` → `SUPERSEDED`; a direct
    update attempting it is refused.
13. Editing after approval changes only the draft; the approved version is
    byte-identical afterwards.
14. The next submit allocates *n*+1 and carries `supersedesVersionNo`.
15. Maker-checker: the submitter cannot approve, compared by id, with no owner
    or platform-administrator exemption.
16. Every readiness gate refuses, each naming its own code, and the not-ready
    payload lists **all** failures rather than the first.
17. A retired operation refuses approval with no override accepted at that gate.
18. `expectedRevision` conflicts on submit, return and approve.
19. Illegal transitions from `APPROVED`, `RETURNED` and `SUPERSEDED`.
20. A second submission while one is in review is refused, and is refused by
    **both** the file filter and the partial unique index independently.
21. **Transactions unavailable**: submit, return and approve each answer
    `IE_BULLETIN_VERSION_ATOMICITY_UNAVAILABLE` 503 and write nothing.
22. **No update on `ie_bulletin_versions` omits a `state` clause** — a source
    scan over every mutation filter in the service.
23. Company scope: another company's file and version are indistinguishable
    from absent.
24. Roles: `viewer` cannot submit; `editor` cannot approve or return.
25. A pre-7C1 layout stays readable and is refused for approval with
    `IE_LAYOUT_BULLETIN_VERSION_UNPROVEN`.
26. No IE service imports a PPC model.
27. The Production/barcode regression group stays green, unchanged.

### 11.13 Required mutation proofs

Each must turn its dedicated test red, and every file restored byte-identically:

1. **Remove the Style File review-pointer write from submit** — the snapshot
   commits alone and the draft stays editable (test 3).
2. **Remove the review-pointer predicate from the bulletin PATCH filter** — an
   edit lands while a submission is in review (tests 4 and 6).
3. **Make return non-transactional** — the version returns while the pointer
   survives, freezing the draft for ever (tests 7 and 21).
4. **Bypass immutability with `findOneAndUpdate`** — a submitted version's rows
   are rewritten by a query-layer write the `pre("save")` hook never sees
   (test 10).
5. Remove the `IN_REVIEW` draft freeze entirely.
6. Remove the partial unique `IN_REVIEW` index.
7. Drop the approved-pointer write from the approval transaction.
8. Accept the degraded non-transactional mode instead of failing closed.
9. Clear the review pointer without the `bulletinReviewVersionId` predicate
   (test 8).
10. Compare maker-checker by name instead of by actor id.
11. Allow a retired operation through bulletin approval.
12. Resolve approved times with a fresh resolver instead of `approvedTimesFor`.
13. Allocate `versionNo` from a count instead of the highest plus one.
14. Return the first readiness failure instead of the complete list.

---

## 12. Sources

- `docs/product/industrial-engineering-app-plan.md` — §3.1, §5.2, §5.3, §6.3, §9, Chunk 8
- `docs/tasks/industrial-engineering-chunk-00.md` — approved outcomes, IE/PPC/Production split
- `docs/audits/industrial-engineering-chunk-07b-working-time-audit.md`
- `docs/audits/industrial-engineering-order-readiness-data-audit.md`
- `models/CMS_Models/IndustrialEngineering/*.js` — all eight
- `models/CMS_Models/Manufacturing/WorkOrder/WorkOrder.js`
- `models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking.js`
- `models/CMS_Models/PPC/DownstreamHandoverReceipt.js`
- `models/CMS_Models/Merchandising/{ChangeControl,MerchandisingEvent,ExecutionPack}.js`
- `routes/Barcode_Scan_Punchings/trackingRoutes.js`
- `routes/CMS_Routes/Manufacturing/Manufacturing-Order/markAsDoneRoutes.js`
- `routes/CMS_Routes/PPC/inboundPacksRoute.js`
- `services/productionSyncService.js`
- `services/industrialEngineering/{ieLineLayout,ieCapacityStandard,workOrderStyleLink}.service.js`
- `services/ppc/{access,inboundPack}.service.js`
- `services/merchandising/executionPack.service.js`
- `services/storePurchase/{errors,unitOfWork}.service.js`
- `test/industrial-engineering/ie-production-tracking-continuity.test.js`
