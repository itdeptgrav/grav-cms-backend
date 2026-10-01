# IE Chunk 9A — Production actuals and barcode-to-IE traceability audit

**Status:** read-only architecture and contract pass. No endpoint, schema,
record or application file was changed to produce it.

**Verdict:** `PARTIALLY_READY_WITH_NAMED_FIRST_SLICE` — see §13.

---

## 0. Read this first: three accepted facts are no longer true

The accepted Chunk 8 audit (§4, "Barcode and scan continuity") was accurate
about the files it cited. **Two of those files are no longer mounted**, and the
scanner has been re-implemented elsewhere with different behaviour. Every claim
below was re-verified against the live `server.js`, not inherited.

| Accepted Chunk 8 §4 said | Live fact today | Evidence |
|---|---|---|
| The scanner is `routes/Barcode_Scan_Punchings/trackingRoutes.js`, mounted at `/api/tracking/*` | **That file is unmounted.** The live scanner is **inline in `server.js`** at `POST /api/cms/production/tracking/scan` and `/bulk-scans` | `server.js:2743`, `:3014`; mount removed in commit `53e0541`; inline block added in `624e9b7`/`69f0e54` |
| The main scan path persists only `{barcodeId, timeStamp}`; `activeOps` stays `[]` | **The live path persists a device-supplied `activeOps`** string on every barcode scan | `server.js:2816–2820` |
| Mark-as-done writes operation-code snapshots | **Mark-as-done is unreachable.** `markAsDoneRoutes.js` has not been mounted since **2026-04-01** | commit `53e0541` removed `app.use("/api/cms/manufacturing/mark-as-done", …)` |

So the "known legacy split" in the Chunk 9A brief is **inverted for current
data**: today the *scanner* carries operation evidence and mark-as-done carries
none. Data written **before** the scanner moved inline follows §4's description.
Both halves are reported below; neither is concealed.

**And the existing fence has been testing the dead code.**
`test/industrial-engineering/ie-production-tracking-continuity.test.js` mounts
`/api/tracking` → `routes/Barcode_Scan_Punchings/trackingRoutes` (line 45) and
reads `markAsDoneRoutes.js` source (line 184). It passes 8/8. **No test anywhere
exercises the live `/api/cms/production/tracking/*` routes** (repository search:
zero hits under `test/`). The fence's green result proves nothing about what the
floor devices actually call.

**And one finding is more severe than all of the above.** The barcode-device
router accepts an **anonymous firmware upload** and offers it to every scanner as
an update (§4.2). The first Production task is therefore security containment
(§10), separate from and ahead of the execution binding (§7).

---

## 1. Method

- Source reading of every model, route and service named below, with
  `file:line` citations.
- `git log -S` / `git show` to establish when mounts appeared and disappeared.
- **In-memory proofs with no database**: Mongoose documents constructed and
  inspected without `save()`, and pure functions called directly. No record was
  created, read from, or written to any database. Atlas was not touched.
- One existing test run, to prove a factual claim about the fence: `ie-production-tracking-continuity.test.js` (8/8, in-memory server).
- Counts are of **non-test** source files unless stated.
- Correction pass: route callers read from the sibling `grav-cms` checkout
  (read-only); the Production department grant read from
  `services/ensureAccessDepartments.js`; the command-ledger precedent read from
  `IeCommandLedger` and `ieRelease.service.js`.

---

## 2. The live path, record by record

### 2.1 Barcode creation and printing

There is **no single barcode generator**, and the generators produce **two
dialects** in the field:

| Dialect | Form | Written by |
|---|---|---|
| Short | `WO-<_id.slice(-8)>-<unit>` | `returnRequestRoutes.js:31`, `packagingRoutes.js:1249` |
| Full | `${workOrderNumber}-<unit, 3 digits>` | `bulkCuttingRoutes.js:135–141`, `quotationRoutes.js:1756/3144/3660` |

The Full dialect depends on `workOrderNumber`, which has **two canonical forms
assigned by two different writers**:

- the WorkOrder model hook gives every **new** order
  `workOrderNumber = "WO-<full 24-hex _id>"` (`WorkOrder.js:555–556`);
- `productionSyncService.updateWorkOrder` gives a **legacy** order it touches
  `workOrderNumber = "WO-<last 8>"` (`productionSyncService.js:437–438`).

So cutting prints `WO-<24hex>-001` for new orders and `WO-<8hex>-001` for
sync-touched legacy ones. A legacy order with **no** number is printed
`WO--001` (`bulkCuttingRoutes.js:135–136` prefixes `"WO-"` onto `""`), which
**no parser can resolve** (`parts[1]` is empty).

The completion route confirms both dialects in its own words:
`productionCompletionRoutes.js` — *"Current labels carry the full Mongo id
(`WO-<24 hex>-001`), while older labels carry only its last eight characters."*

All panels of one unit share **one** barcode string (`bulkCuttingRoutes.js:140`:
`barcodeId` carries no panel number). The printed work-order label on the PDF is
a human label (`manufacturingOrderPdf.js:77`), not a unit barcode.

### 2.2 Barcode resolution during scanning

- **Live scanner** (`server.js:2721`, `findWorkOrderByShortId`) loads the
  **entire** `WorkOrder` collection with `find({})` and returns the first
  document whose `_id.slice(-8)` equals the barcode's middle segment. It
  resolves the Short dialect only.
- **But the scanner does not store the work order at all.** It resolves one only
  to broadcast a websocket event (`server.js:2826–2860`), then discards it. The
  persisted scan holds the raw barcode string; every reader re-resolves it later.
- **17 resolvers** repository-wide do the same full-collection `WorkOrder.find({})`
  scan (listed in Appendix A).
- `slice(-8)` appears **55 times across 28 files** (Chunk 8 §4 recorded 54/27).
- The completion route (`productionCompletionRoutes.js:26–35`,
  `indexWorkOrdersByBarcodeIdentity`) is the **only** resolver that indexes both
  dialects.

### 2.3 Operator identity

- An ID-card scan beginning `GR` (`server.js:2698`, `isEmployeeId`) resolves
  `Employee.findOne({ identityId: scanId })` and toggles a sign-in/sign-out
  session on the machine's slot (`server.js:2878–2930`).
- Stored as `operators[].operatorIdentityId` (string), `operatorName` (string),
  `signInTime`, `signOutTime`.
- A barcode scan is attributed to **whoever is currently signed in on that
  machine** (`currentOperatorIdentityId`, `server.js:2796–2812`) — not to a
  credential presented with the scan.
- `Employee` carries **no `companyId`** (0 occurrences).

### 2.4 Physical machine identity

- `ProductionTracking.machines[].machineId` → `Machine` (`ref: "Machine"`,
  required). The device sends it in every payload; the server checks only that
  it exists (`server.js:2775`).
- `Machine.serialNumber` is globally unique; `Machine` has **no `companyId`**.
- **`Machine.type` is free text, not a reference to `MachineType`**
  (`Machine.js`). IE's planned `machineType` on a bulletin row is also free text.
  The two are independent strings with no shared key.
- `Machine.status` (`Operational | Under Maintenance | Idle | Repair Needed`) is
  a **current** value with no history.
- `BarcodeDevice` has **no machine reference and no company**. Which machine a
  device reports is the device's configuration, not a server-enforced binding.

### 2.5 Active operation selection and operation-code snapshots

The live scanner stores `activeOps: activeOps || ""` into a field declared
`[String]`. **Proved in memory** (documents constructed, never saved):

| Device sends | Stored as |
|---|---|
| nothing | `[""]` — **not `[]`**; a naive "has an operation" check reads true |
| `"SJ-01"` | `["SJ-01"]` |
| `"SJ-01,BA-03"` | `["SJ-01,BA-03"]` — **one** element, the comma is not split |
| `["SJ-01","BA-03"]` | `["SJ-01","BA-03"]` |
| field omitted | `[]` |

`activeOps` is **device-supplied and unvalidated**: nothing checks the codes
against the work order, the machine or any register.

### 2.6 Piece completion — the two "mark done" paths

| Path | Mount | Status | What it writes |
|---|---|---|---|
| `markAsDoneRoutes.js` `POST /bulk`, `/single` | was `/api/cms/manufacturing/mark-as-done` | **DEAD since 2026-04-01** | would write virtual scans into `ProductionTracking` |
| `productionCompletionRoutes.js` `POST /mark-done` | `/api/cms/manufacturing/production-completion` | **LIVE** | whole-garment completions into `ProductionCompletionScanRecord` |

The PM dashboard still calls the dead path
(`grav-cms/…/EmployeeTrackTab.js:453`, `/api/cms/manufacturing/mark-as-done/…`),
so that control **returns 404 today**.

**Historical data from the dead path is not trustworthy operation evidence.**
Its `writeVirtualScans` (`markAsDoneRoutes.js:98–161`):

- stamps each scan `now + i × 50 ms` — not when the work happened;
- sets `activeOps` to **every** operation code on the order, not the one done;
- writes the same scan once to **every** assigned machine, multiplying output;
- falls back to `Machine.findOne({})` — **any machine** — when none is assigned;
- pads units to three digits (`WO-x-001`), a different spelling from `WO-x-1`.

### 2.7 Production completion scan records

`ProductionCompletionScanRecord` — one document per IST day, `date` **unique**.
Each scan holds `barcodeId`, `scannedAt`, `scannedBy`. **No operation, no
machine, no stored work order, no company.** `scannedBy` is a **client-supplied
free string** from the request body (`productionCompletionRoutes.js:209, 285`).
Scans are voided into `voidedScans`, not deleted.

- Duplicate refusal is **global across every company** and **not atomic**: a
  `find` of existing barcodes, then a separate `$push`
  (`productionCompletionRoutes.js:263–291`). Two concurrent requests can both
  record one barcode, and one company's scan can refuse another company's
  identical barcode string.
- The route refuses completions for an order with no operation route
  (`WORK_ORDER_NOT_ROUTED`, 409).

### 2.8 Employee progress / output

**`EmployeeProductionProgress` is not operator output.** Its `employeeId` refs
**`EmployeeMpc`** (`models/Customer_Models/Employee_Mpc.js`: `customerId →
Customer`, `uin`, `department`, `designation`). It is the **customer's staff
member receiving made-to-measure garments**, with a `unitStart..unitEnd`
allocation, packaging history and dispatch history. `completedUnits` counts that
recipient's finished garments.

Chunk 9 must never read this as operator productivity.

### 2.9 Downtime, defects, rework

- **Downtime: no source exists.** No model records a stoppage; every "downtime"
  keyword hit is an unrelated "breakdown" (BOM, email text, per-operation).
  `Machine.status` has no history.
- **Defects: `DefectRecord` (Quality).** The richest source: a **resolved
  `workOrderId`** (nullable), `workOrderShortId`, an IST date string, `status`
  (`passed | defective | rejected`), `defects[].operationCode` (text),
  `defects[].operators[].operatorId` (free string recorded by the inspector),
  defect `types[]`, `stageId`, `inspectedByBiometricId`. No company.
- **Rework:** `DefectRecord.reworkRound` / `isRework` on the inspection. There
  is **no rework production record**: a reworked unit is rescanned under the
  same barcode and is indistinguishable from first-pass work in
  `ProductionTracking`.

### 2.10 Every reader that aggregates output

| Record | Non-test reader files |
|---|---|
| `ProductionTracking` | 14 (3 are dead routes) |
| `ProductionCompletionScanRecord` | 5 |
| `WorkOrder.productionCompletion` | **28** — including Central Costing `productionActual.service.js` and `productionCloseout.service.js` |
| `EmployeeProductionProgress` | 17 |
| `DefectRecord` | 8 |

Full lists in Appendix B. Production output **feeds costing closeout**, so a
wrong count is a wrong money figure.

### 2.11 The per-record summary

| Record | Stable id | Work order | Operation | Operator | Physical machine | Time / quantity | Company | Mutable | Survives op rename | Safe join to a release |
|---|---|---|---|---|---|---|---|---|---|---|
| `ProductionTracking` scan | subdoc `_id` | **barcode string only** | device text `activeOps` | session `operatorIdentityId` | `machineId` → Machine | one event per scan; server-local day bucket | **absent** | yes (cleanup strips) | yes — text kept, but joins by today's codes | **No** |
| Completion scan | subdoc `_id` | barcode string only | **none** | client string `scannedBy` | **none** | one whole-garment completion per barcode, IST day | absent | voidable | n/a | **No** (no operation) |
| `WorkOrder.operations[]` | subdoc `_id` | itself | `operationCode` text | — | — | `plannedTimeSeconds` **default 0** | absent | **yes — add/remove/reorder unguarded** | **No** | No IE reference |
| `WorkOrder.productionCompletion` | — | itself | positional op number | per-op operator stats | per-op machine stats | distinct unit sets; **append-only (`Math.max`)** | absent | yes (up only) | **No** | No |
| `EmployeeProductionProgress` | `_id` | `workOrderId` | none | **a customer recipient**, not an operator | none | recipient's finished garments | absent | yes | n/a | Not operator evidence |
| `DefectRecord` | `_id` | **resolved `workOrderId`** | text `operationCode` | inspector-recorded string | none | one inspection event, IST date string | absent | yes | text kept | Compatibility only |

---

## 3. The load-bearing join: `productionSyncService`

`services/productionSyncService.js` turns scans into
`WorkOrder.productionCompletion`. Every behaviour below was **proved by calling
the function directly, with no database**:

| Case | Result of `resolveActiveOpsCodesToOperationNumbers` |
|---|---|
| Stored array with one code | `[1]` |
| Device sent nothing (`[""]`) | `[]` |
| Device sent a comma-joined string (stored `["SJ-01,BA-03"]`) | **`[]` — every operation lost** |
| Same codes as a real array | `[1,2]` |
| Operation **renamed** on the order | `[]` — lost |
| Operations **reordered** | **`[2]` — re-attributed to the wrong operation** |
| **Duplicate** code on the order | **`[1,2]` — one scan, two credits** |

- **Matching is textual and positional**: lower-cased code text, and the
  operation number is the **array index + 1** (`:55–69`).
- It finds a work order's scans with `$regex: ^WO-<last8>-` (`:131`). **A Full
  dialect label `WO-<24hex>-001` never matches** — proved: the pattern expects
  `-` where the full id has a hex character. Every scanner scan of a new-order
  label is **invisible** to the sync.
- **Overall completion is an intersection** across every operation bucket and
  **returns 0** when any operation is unmatched (`:357–368`). With empty or
  comma-joined `activeOps`, scanner-derived completion is typically **0** even
  when every piece was scanned — which is why the separate completion
  `/mark-done` exists.
- `productionCompletion` is **append-only** (`Math.max`, `:440–446`). An
  over-count — from the dead path's fan-out, or a duplicate-code double credit —
  can **never be corrected**.
- **It rewrites identity**: `workOrderNumber = "WO-<last8>"` on any order it
  touches without one (`:437–438`).

**And it does not run on a schedule.** Its three cron jobs (15-min work-order
sync, 10-min employee sync, 02:00 cleanup) are registered inside `initialize()`,
which is **commented out** (`server.js:793`). It runs only when somebody calls
`POST /api/cms/production/sync/manual` or `/employee-sync/manual`.

### 3.1 Productive time is inferred, and sometimes fabricated

- `productiveTime` = the sum of gaps between consecutive scans, keeping only gaps
  under **1,800 s** (`:376–379`). Idle, breaks and downtime inside a gap count
  as productive; gaps over 30 minutes vanish.
- **`if (unitScans.length === 1) times.push(plannedTime || 0)`** (`:414`). A unit
  scanned once is given the **planned** time as its actual, or **0**. Comparing
  actual against planned then shows **zero variance by construction**.
- Unknown targets become `efficiency: 0`; an open session is measured to
  `new Date()`, so historical metrics keep growing.

**No productive time is recorded anywhere.** Only scan instants and session
sign-in/out are stored.

---

## 4. Security and evidence retention

### 4.1 No Production endpoint in `server.js` authenticates its caller

The handler is the second argument to `app.post`/`app.get` for every inline
Production route (`server.js:2743, 2996, 3014, 3172, 3265, 3427, 3440`). The only
middleware ahead of them are `errorWatch` and `opsControls`; `opsControls` is a
maintenance kill-switch that reads settings, not authentication. No global auth
layer precedes line 2743.

### 4.2 Anonymous firmware replacement on every scanner

This finding is **more severe than anything in §4.1** and was verified during this
correction pass.

- `app.use("/api/barcode-devices", …)` (`server.js:2585`) mounts
  `barcode-scanner-hardware-routes.js` with **no router-level or mount-level
  guard**.
- `POST /api/barcode-devices/firmware` accepts an uploaded binary, writes it to
  disk and saves a `Firmware` record with **`isActive: true`** and
  **`targetDevices: ['all']`** by default (`barcode-scanner-hardware-routes.js:268–333`).
- `POST /api/barcode-devices/check-update` offers the active firmware to any
  device whose version differs, with a download URL
  (`barcode-scanner-hardware-routes.js:92–189`).

So an anonymous upload is offered to every floor scanner as an update. Whether the
device firmware verifies a signature before installing is a **firmware-side fact
this audit cannot see from the backend**, and must not be assumed.

`BarcodeDevice` has a unique `deviceId` and **no credential of any kind**
(`BarcodeDevice.js`). No device-identity contract exists.

### 4.3 Anonymous evidence deletion

`POST /api/cms/production/cleanup/manual` → `cleanupOldTrackingData()`
(`productionSyncService.js:567–626`) **`deleteMany`s** `ProductionTracking` day
documents older than 15 days whose scans all belong to completed orders, and
**strips** those scans out of mixed documents. Completed orders are exactly what
Chunk 9 would analyse. The scheduled 02:00 run is off (`initialize()` commented
out, `server.js:793`), so this HTTP trigger is the only live way it runs.

### 4.4 Who actually calls each route

Checked read-only against the sibling `grav-cms` checkout. Firmware callers are
not visible from source and are marked as such.

| Route | Visible caller | Consequence for containment |
|---|---|---|
| `POST /api/cms/production/cleanup/manual` | **none** | can be disabled outright; nothing legitimate breaks |
| `POST /api/cms/production/sync/manual` | PM dashboard, `EmployeeTrackTab.js` (browser session) | can take session auth now |
| `POST /api/cms/production/employee-sync/manual` | PM dashboard, same file (browser session) | can take session auth now |
| `POST /api/barcode-devices/firmware` (upload) | admin page `app/barcode-scanner-device/page.js` (browser session) | can take session auth now |
| `GET /api/barcode-devices/`, `/:deviceId`, `/firmware/list` | admin page (browser) | can take session auth now |
| `POST /api/cms/production/tracking/scan` | **floor devices and** a browser scanner page, `app/grav-production/barcode-scanner-device/page.js` | **needs a device-identity contract** — session auth would break devices |
| `POST /api/cms/production/tracking/bulk-scans` | devices (offline replay); no browser caller | needs the device-identity contract |
| `POST /api/barcode-devices/check-update`, `GET /firmware/download/:version`, `GET /name` | devices | needs the device-identity contract |
| `GET /api/cms/production/tracking/status/*` | no browser caller; device use unknown | confirm from access logs before guarding |

### 4.5 Date semantics and the day-document race

`ProductionTracking` buckets by **server-local** midnight (`setHours(0,0,0,0)`,
`server.js:2768`); the completion record and `DefectRecord` bucket by **IST**. If
the host runs UTC, a scan between 00:00 and 05:30 IST lands on the previous day in
one record and not the others. Host timezone is a deployment fact this audit did
not measure.

`ProductionTracking` does `findOne({date})` → `new` → `save`, with **no unique
index on `date`** (`server.js:2770–2773`; schema `index: true` only). Two
simultaneous first scans of a new day can create two documents, and any
`findOne({date})` reader then sees only one.

---

## 5. The decisive answers

**Can a production scan be tied to the exact IE release used by the work order?**
**No.** Nothing records which release governed a run. `WorkOrder` carries no IE
provenance (0 `ieRelease*` fields). A scan does not even store its work order.

**Can it be tied to the exact bulletin row and operation revision?**
**No.** The only operation evidence is device-supplied code text, matched
positionally against today's mutable `WorkOrder.operations[]`, which carries no
IE identity.

**Does the main scan path record operation evidence, or only mark-as-done?**
**Today, only the main scan path records it** — as unvalidated device text,
stored in three encodings. **Mark-as-done has been dead since 2026-04-01.**
Historical data before the scanner moved inline has **no** operation evidence on
the scan path.

**Is operation-code matching positional, textual, or identity-based?**
**Textual and positional.** Never identity-based.

**What happens on rename, retire, replace, or reorder?**
Rename → the scan matches nothing. Reorder → re-attributed to the wrong
operation. Replace (new code) → old scans match nothing. Retire → no effect on
the join (codes are not checked against any register). Duplicate codes → double
credit. **Operation add/remove/reorder on an in-production order is unguarded**
(`workOrderRoutes.js:1457, 1479, 1519` check only for 404).

**Can one barcode resolve across companies?**
**Yes, structurally.** Resolution scans every company's work orders
(`WorkOrder.find({})`) by a 32-bit suffix and takes the first match; the sync's
prefix regex and the completion route's global duplicate check are also
company-blind. A collision is rare at today's volume but **nothing prevents it**
and the resolver does not detect it.

**Can physical `machineId` be confused with IE planned machine type?**
**Yes, easily.** `machineId` is a physical asset; `Machine.type` is free text
with no key into `MachineType` or IE; IE's `machineType` is a separate free
string. They must be published as two different things.

**Are output quantities pieces, operation completions, bundles, or other?**
- a `ProductionTracking` scan: one scan **event** of one **unit** barcode (all
  panels share it), optionally claiming operation completions;
- `productionCompletion.operationCompletion[].completedUnitNumbers`: **distinct
  units per operation** (operation completions);
- a completion scan: **one finished garment**, once per barcode ever;
- `EmployeeProductionProgress.completedUnits`: **a customer recipient's
  garments** — not operator output;
- **bundles: none** — no bundle entity is persisted.

**Is productive time recorded directly or inferred?**
**Inferred only** — and in one branch **fabricated from the planned time**
(§3.1).

**Are downtime, defect and rework sources trustworthy enough for Chunk 9?**
Downtime: **no source.** Defects: **usable as compatibility evidence** (resolved
work order, text operation). Rework: **only a QC flag**; rework production is
indistinguishable from first-pass work.

**Which Production-owned decisions still block a safe join?** Security
containment first (§10), then retention, barcode resolution, `activeOps`
encoding and the rest (§11). The exact list is in §12.2.

---

## 6. Ownership points compared

| | 1. Freeze onto `WorkOrder` | **2. Production execution binding** | 3. Bind on PPC accept | 4. Resolve dynamically |
|---|---|---|---|---|
| Tenancy | `WorkOrder` has no company; 141/147 unprovable | **Own proved `companyId`, only for provable orders** | acceptance is per release, not per order | derived at read time; moves when a style moves company |
| Immutability | `WorkOrder` is edited by 28+ files; ops add/remove/reorder unguarded | **New insert-only collection, fully guarded** | inherits option 1 or 2 | nothing is frozen |
| Barcode compat | additive, fine | **untouched** | untouched | untouched |
| Concurrency | full-doc `.save()` from the sync | **partial-unique "one ACTIVE per order" as arbiter** | — | n/a |
| Rollback | fields left on a shared record | **drop one collection** | — | trivial |
| Historical truth | one release per order — cannot say "units 1–200 under v1" | **a sequence of bindings with effective windows** | acceptance can precede orders | **judges past runs by today's release — wrong** |
| Ownership | IE or PPC writing Production's record — a cross-app write | **Production, reading IE and PPC** | PPC writing Production — cross-app | nobody owns the answer |

**Recommendation: option 2 — a separate, company-scoped, Production-owned
execution binding**, with an **ACCEPTED PPC receipt as a precondition** (option 3
as a gate, not as the binding event), and option 4 allowed only as a report
labelled `UNBOUND — inferred`, never as truth.

Why not the others:

- **Option 1** turns the most-mutated record in the system into frozen evidence,
  forces IE or PPC to write a Production model, and can hold only one release per
  order.
- **Option 3** conflates *planning acknowledging a standard* with *a specific
  order executing it*. One release covers many orders; acceptance happens before
  orders exist; and PPC must never write Production.
- **Option 4** answers "which standard governed this run?" with "whichever is
  current now" — exactly what *historical actuals must resolve against the frozen
  release* forbids.

---

## 7. The first implementation slice — Chunk 9A-i: the execution binding

**Scope:** the binding record, a Production command ledger, three commands and
two reads. No scan is read, no evidence is attributed, and no floor behaviour
changes. Attribution is Chunk 9A-ii (§8), which is **gated** and is not part of
this slice.

**9A-i is a separate track from the security containment in §10.** It touches no
scanner, firmware or cleanup code, and the security task touches no binding
code. They are sequenced in §12.

### 7.1 Model — `ProductionExecutionBinding`

`models/CMS_Models/Manufacturing/Production/ProductionExecutionBinding.js`,
collection `production_execution_bindings`. **Owner: Production.**

| Field | Rule |
|---|---|
| `companyId` | required, immutable — **proved at bind**, never from a body |
| `workOrderId` | required, immutable — the full ObjectId |
| `sampleStyleId` | required, immutable — the order's canonical style **at bind** |
| `ieReleaseId`, `releaseRef`, `releaseVersionNo`, `ieStyleFileId` | required, immutable — copied from the release |
| `aggregateFingerprint` | immutable — **stored for integrity, never published** (8A-ii precedent) |
| `ppcReceipt` | immutable — `{ receiptId, releaseRef, releaseVersionNo, state, decidedAt }` copied from the exact receipt proved in §7.4 |
| `operationMap[]` | immutable, **frozen at bind** — see §7.2 |
| `state` | `ACTIVE \| SUPERSEDED \| CLOSED` |
| `bindingSequence` | 1..n per work order |
| `effectiveFrom` | required, immutable — **server time at bind; never retroactive** |
| `effectiveTo` | null until superseded or closed |
| `supersedesBindingId`, `supersededByBindingId` | the chain |
| `boundBy {id, name}`, `boundAt` | from the session |
| `reason` | required on supersede and close |
| `revision` | optimistic concurrency |
| `history[]` | bounded audit lines |

**No `idempotencyKey` or `requestHash` on the binding.** The first draft put
them here, and one key and hash cannot represent a bind, a later supersede and a
later close. All three are recorded in the command ledger (§7.7), which commits
**in the same transaction** as the binding change. Because the ledger row and the
binding become visible together, the ledger alone classifies every race, so a
key on the binding is not needed even to classify an insert race.

**Indexes:** unique `{companyId, workOrderId, bindingSequence}`; partial unique
`{workOrderId}` where `state: "ACTIVE"` — **no company in the key**, so two
companies can never both bind one order; `{companyId, ieReleaseId}`;
`{companyId, releaseRef, releaseVersionNo}`.

**Immutability guard** (the IE pattern): every save of an existing document
refused; every update must name `state: "ACTIVE"` and `revision` as scalars in
its filter and may write only `state`, `effectiveTo`, `supersededByBindingId`,
`reason`, `revision`, `history`, `updatedAt`; replacements, upserts and all
deletion paths refused; a live transaction required for every state move.

### 7.2 The frozen operation map — the whole point

Decided **once, at bind**, and never re-derived:

```
operationMap[]: {
  bulletinRowId, sequence, ieOperationId, ieOperationRevision,
  operationCode,          // as the RELEASE froze it
  standardTimeMinutes,    // the frozen approved standard
  legacyOperationId,      // WorkOrder.operations[]._id matched at bind, or null
  legacyOperationCode,    // that operation's code AT BIND
  matchBasis: "CODE_EXACT_UNIQUE" | "UNMATCHED" | "AMBIGUOUS"
}
```

- Match rule: release row code equals work-order operation code (trimmed,
  case-insensitive), **unique on both sides**. **Never positional.**
- Because `legacyOperationCode` is frozen, a later rename of the work-order
  operation cannot break the historical join, and a reorder cannot re-attribute
  it.
- `UNMATCHED` / `AMBIGUOUS` rows are **published as such**. A binding with gaps
  is allowed and says so; nothing is guessed to fill it.
- This map is a **planned bridge**, decided before any work is done. It is not
  evidence that any operation was performed — see §7.13.

### 7.3 Write authority — the repository's actual Production grant

**A live `DepartmentRole` grant `{ departmentSlug: "production-supervisor", role
≥ "approver" }`**, read on every request through the fail-closed
`getEffectiveRole` / `roleAtLeast` path that IE and PPC already use.

Why that slug and nothing else, verified in source:

- `services/ensureAccessDepartments.js:84` registers `{ key: "prod_supervisor",
  slug: "production-supervisor", name: "Production Supervisor" }`. It is the
  **only Production department** in the `AccessDepartment` registry. There is no
  `production` slug, and this audit does not invent one.
- `DepartmentRole.departmentSlug` is free text (`models/Access/DepartmentRole.js:56`)
  with the ranked roles `viewer < editor < approver < owner`. Authority comes
  from the **department grant and its rank**, never from a job title.
- Its display name reads like a designation, but in this repository it is a
  **department record**. Renaming it to read as a department is a registry
  decision for the product owner, not something to assume here.

What does **not** grant authority, stated so an implementation cannot drift into
it:

- the legacy `ProductionSupervisorDepartment` login record (`routes/login.js:27, 72`);
- the JWT `role: "production_supervisor"`, which is used only to choose a
  redirect (`routes/login.js:163`);
- `isAdmin`, and any other department's grant, including `ie`, `ppc`,
  `project-manager` and `qc`;
- **`departmentWrites("production-supervisor")`** — it fails **open** for a
  department with no roles (`Middlewear/departmentWriteGuard.js:24`) and passes a
  request with no user email (`:198`). An immutable evidence binding cannot sit
  behind a guard that admits everyone by default.

Reads (`GET`) require the same department at `viewer`.

### 7.4 Commands, preconditions and the exact PPC proof

```
POST /api/cms/production/execution-bindings                     BIND
POST /api/cms/production/execution-bindings/:bindingId/supersede
POST /api/cms/production/execution-bindings/:bindingId/close
GET  /api/cms/production/execution-bindings?workOrderId=
GET  /api/cms/production/execution-bindings/:bindingId
```

`Idempotency-Key` header mandatory on all three writes. Company from
`resolveCompanyForActor` only. **Transactions required; fail closed** without
them.

**BIND** `{ workOrderId, ieReleaseId }` → `ACTIVE`, only when **every** check
holds, all inside the transaction:

1. The order exists and its canonical `sampleStyleId` resolves through
   `styleOwnerFrom` to the acting company.
2. The release is read by `{ _id: ieReleaseId, companyId }` and is **`ISSUED`**
   — the current version, not superseded, not withdrawn.
3. `release.sampleStyleId === workOrder.sampleStyleId`.
4. **The exact PPC receipt.** Read `IeReleaseReceipt` by
   `{ companyId, ieReleaseId: release._id }`, the unique index added in 8A-ii.
   Then prove **every** identity field against the release rather than trusting
   the lookup:
   - `receipt.companyId === release.companyId === acting company`
   - `receipt.ieReleaseId === release._id`
   - `receipt.releaseRef === release.releaseRef`
   - `receipt.releaseVersionNo === release.versionNo`
   - `receipt.state === "ACCEPTED"`

   A missing receipt, a `CLARIFICATION_REQUESTED` receipt, and a receipt whose
   identity disagrees with the release are three different refusals (§7.6),
   never one "not accepted".
5. The order has no `ACTIVE` binding.

Production **reads** the PPC receipt; it never writes it. Reading another
department's record is not authoring it — the same rule Merchandising follows for
PPC's inbound receipts.

**SUPERSEDE** `{ ieReleaseId, expectedRevision, reason }` — moves the order onto a
newer release. Within one transaction: the old binding `ACTIVE → SUPERSEDED`
(`effectiveTo = now`) **first**, then the new `ACTIVE` binding is inserted.
The order matters, because the partial-unique `ACTIVE` index would refuse the
insert otherwise. The new release must pass checks 1–4 on its own — **its own
exact `ACCEPTED` receipt**.

**CLOSE** `{ expectedRevision, reason }` — `ACTIVE → CLOSED`, `effectiveTo = now`.

No delete. No reactivation. No edit of a frozen field. No retroactive
`effectiveFrom`.

**When the bound release is later superseded or withdrawn by IE:**

- The existing binding is **not changed**. It stays evidence of what governed the
  order during its effective window. IE never writes a Production record, and a
  PPC receipt is immutable, so nothing reaches in to move it.
- Reads **derive**, never store, `governingRelease: { state, currentVersionNo }`
  from the release's current state — `ISSUED`, `SUPERSEDED` or `WITHDRAWN`.
- A **new BIND** against the superseded version is refused
  (`EXECUTION_BINDING_RELEASE_SUPERSEDED`, naming the current version). A new bind
  against a withdrawn one is refused (`EXECUTION_BINDING_RELEASE_WITHDRAWN`).
- Moving the order onto the newer release is Production's decision, made through
  **SUPERSEDE**, with the newer version's own accepted receipt.
- A receipt cannot be revoked — it is immutable — so a binding can never lose the
  acceptance it relied on.

### 7.5 Envelopes

```
201 { success, created: true,  replayed: false, binding }
200 { success, created: false, replayed: true,  binding }          // BIND replay
200 { success, replayed: false|true, superseded, binding }          // SUPERSEDE
200 { success, replayed: false|true, binding }                      // CLOSE

binding: {
  bindingId, state, bindingSequence, workOrderId, sampleStyleId,
  release: { ieReleaseId, releaseRef, releaseVersionNo },
  governingRelease: { state, currentVersionNo },     // derived at read time
  ppcAcceptance: { receiptId, releaseRef, releaseVersionNo, state: "ACCEPTED", decidedAt },
  effectiveFrom, effectiveTo,
  operationMap: [ … §7.2, with matchBasis on every row … ],
  coverage: { matched, unmatched, ambiguous },
  boundByName, boundAt, revision,

  // What this record is NOT — published so no screen infers otherwise (§7.13)
  scope: "EXECUTION_PROVENANCE_ONLY",
  attributesEvidence: false,
  measuresProductiveTime: false,
  operationIdentityEvidence: false,
  writesWorkOrder: false
}
```

No `aggregateFingerprint`, no company internals, no customer data.

### 7.6 Typed refusals

| Code | HTTP |
|---|---|
| `EXECUTION_BINDING_NOT_FOUND` — absent, foreign and malformed alike | 404 |
| `EXECUTION_BINDING_WORK_ORDER_NOT_FOUND` — including **unprovable** ownership (non-disclosing) | 404 |
| `EXECUTION_BINDING_RELEASE_NOT_FOUND` | 404 |
| `EXECUTION_BINDING_RELEASE_SUPERSEDED` — names the current version | 409 |
| `EXECUTION_BINDING_RELEASE_WITHDRAWN` | 409 |
| `EXECUTION_BINDING_STYLE_MISMATCH` | 409 |
| `EXECUTION_BINDING_RELEASE_NOT_ACCEPTED` — `details.reason`: `RECEIPT_ABSENT` or `CLARIFICATION_REQUESTED` | 409 |
| `EXECUTION_BINDING_RECEIPT_IDENTITY_MISMATCH` — a receipt found whose company, ref, version or release id disagrees with the release | 409 |
| `EXECUTION_BINDING_EXISTS` — an `ACTIVE` binding already governs the order | 409 |
| `EXECUTION_BINDING_REVISION_CONFLICT` — `{ expected, actual }` | 409 |
| `EXECUTION_BINDING_IMMUTABLE` — a superseded or closed binding | 409 |
| `EXECUTION_BINDING_REASON_REQUIRED` | 400 |
| `EXECUTION_BINDING_FORBIDDEN` | 403 |
| `EXECUTION_BINDING_ATOMICITY_UNAVAILABLE` | 503 |
| `IDEMPOTENCY_KEY_REQUIRED` / `IDEMPOTENCY_KEY_REUSED` | 400 / 409 |

### 7.7 Idempotency and concurrency — a Production command ledger

**Model:** `ProductionCommandLedger`, collection `production_command_ledger`,
owned by Production. The **same protocol** as IE's `IeCommandLedger` — a unique
`{companyId, scope, idempotencyKey}` with a `requestHash` — not a new one. It
differs from PPC's `once()` in one deliberate way: the ledger row is written
**inside** the command's transaction. PPC's `once()` writes it after the command,
which is what produced the lost-ledger defect fixed in 8A-ii
(`services/ppc/commandOnce.js`).

| Field | Rule |
|---|---|
| `companyId` | required, immutable |
| `command` | `BIND \| SUPERSEDE \| CLOSE` |
| `scope` | `EXECUTION_BINDING:BIND:<workOrderId>`, `…:SUPERSEDE:<bindingId>`, `…:CLOSE:<bindingId>` |
| `idempotencyKey` | required, immutable — from the header only |
| `requestHash` | canonical SHA-256 of the **command's** normalised request (below) |
| `resultBindingIds[]` | the identity of what the command produced: BIND `[new]`; SUPERSEDE `[old, new]`; CLOSE `[closed]` |
| `responseStatus` | the original status: 201 for a created bind, 200 otherwise |
| `actorId`, `actorName`, `createdAt` | from the session and the server |

**Unique index:** `{companyId, scope, idempotencyKey}`. **Scoped per command and
target**, so one key cannot silently act on a different binding, and a key reused
on a different target is simply a different command.

**Request hash inputs** — the whole command, not only its body:

- BIND: `{ command, workOrderId, ieReleaseId }`
- SUPERSEDE: `{ command, bindingId, ieReleaseId, expectedRevision, reason (whitespace-normalised) }`
- CLOSE: `{ command, bindingId, expectedRevision, reason (whitespace-normalised) }`

**Retention: no TTL.** Binding commands are a handful per work order. A 30-day
TTL would let a very late retry of an old BIND create a fresh binding on an order
whose earlier binding had since closed. The ledger is part of the evidence chain,
and it refuses every update, replacement and deletion path, as `IeCommandLedger`
does.

**The transaction boundary.** One transaction contains, in order:

1. the ledger read by `{companyId, scope, idempotencyKey}`;
2. every precondition read in §7.4;
3. the binding insert or conditional updates;
4. the ledger insert.

The binding change and its ledger row commit **together or not at all**. There is
no window in which a command succeeded and its ledger row is missing.

**Replay.** A ledger row found with the same `requestHash` replays: the original
`responseStatus`, with the envelope **rebuilt** from `resultBindingIds` and
`replayed: true`. The stored decision is restated exactly; derived fields such as
`governingRelease` reflect the release as it is now. A row with a different hash →
`IDEMPOTENCY_KEY_REUSED`. The ledger is read once before the transaction (the
cheap path) and again inside it (the authoritative path).

**Race-loss classification.** A transaction that loses a race sees the winner's
**committed** state, and the winner's binding and ledger row are committed
together:

| Race | What the loser hits | Classified by | Answer |
|---|---|---|---|
| Same key, same request, same scope | write conflict (retried) or E11000 on the ledger index | re-read ledger by key | same hash → **replay**; different hash → `IDEMPOTENCY_KEY_REUSED` |
| Different keys, BIND on one order | E11000 on the partial-unique `ACTIVE` index | ledger has no row for the loser's key | `EXECUTION_BINDING_EXISTS` |
| Different keys, SUPERSEDE or CLOSE on one binding | conditional update matches 0 (`revision` or `state` moved) | ledger has no row for the loser's key; re-read binding | `EXECUTION_BINDING_REVISION_CONFLICT`, or `…_IMMUTABLE` if no longer `ACTIVE` |
| Same key, retry after the original committed | ledger hit on the pre-read | ledger | replay |

No path returns a raw duplicate-key error or a 500. Transactions retried by the
driver are bounded, as in 8A-i.

### 7.8 Legacy coexistence

**Nothing existing changes.** `WorkOrder`, `ProductionTracking`, the completion
record, **both barcode dialects and every printed label**, the scanner,
completion `/mark-done`, the firmware routes and all 28 `productionCompletion`
readers are untouched. An order with no binding reads as `UNBOUND`, never as
"no variance".

### 7.9 Migration and backfill

**None.** No binding is inferred for any historical order, and no ledger row is
back-filled. A binding may be created for an order already in production; it
governs evidence **from `effectiveFrom` forward only**, and earlier evidence is
reported `UNBOUND_BEFORE_BINDING` by 9A-ii.

### 7.10 Test matrix

**Binding and map**
1. Bind succeeds for a provable order, an `ISSUED` release and its `ACCEPTED` receipt.
2. The operation map matches by unique exact code, never by position.
3. A reordered work order produces the **same** map.
4. Duplicate codes → `AMBIGUOUS`, not a guess.
5. Unmatched rows are published and counted in `coverage`.
6. An unprovable order is indistinguishable from an absent one.
7. Foreign company: refused, non-disclosing.
8. Two companies can never both bind one order.
9. No write to `WorkOrder`, `ProductionTracking`, any IE record or any PPC record.
10. Every update, replacement, upsert and deletion path is refused on the binding.
11. No retroactive `effectiveFrom`; the fingerprint is never published.
12. Transactions unavailable → fails closed.

**Exact PPC proof (§7.4)**
13. No receipt → `RELEASE_NOT_ACCEPTED` / `RECEIPT_ABSENT`.
14. `CLARIFICATION_REQUESTED` → `RELEASE_NOT_ACCEPTED` / `CLARIFICATION_REQUESTED`.
15. A receipt fabricated with a mismatched `releaseRef` → `RECEIPT_IDENTITY_MISMATCH`.
16. A mismatched `releaseVersionNo` → `RECEIPT_IDENTITY_MISMATCH`.
17. A receipt belonging to another company is never found.
18. Bind against a `SUPERSEDED` release → `RELEASE_SUPERSEDED`, naming the current version.
19. Bind against a `WITHDRAWN` release → `RELEASE_WITHDRAWN`.
20. After IE supersedes the bound release, the existing binding is **byte-identical** and reads `governingRelease.state: "SUPERSEDED"`.
21. SUPERSEDE onto the newer release without its own accepted receipt → refused.
22. The binding is never written when the receipt is read; the receipt is never written at all.

**Idempotency and concurrency (§7.7)**
23. BIND, SUPERSEDE and CLOSE each replay with their own original status and result identity.
24. The same key on a different request → `IDEMPOTENCY_KEY_REUSED`, per command.
25. The same key on a different target is a separate command, not a reuse.
26. The ledger row and the binding change commit atomically: a forced failure after the binding write leaves **neither**.
27. Two simultaneous binds, different keys → one binding; the loser gets `EXISTS`.
28. Two simultaneous binds, same key and request → one binding; both 201/200, one `replayed`.
29. Two simultaneous supersedes → one succeeds; the loser gets `REVISION_CONFLICT`.
30. A retry after the ledger row is committed replays without touching the binding.
31. No raw E11000 and no 500 on any race.
32. The ledger refuses update, replacement and deletion.

**Authority (§7.3)**
33. A `production-supervisor` approver can bind; a viewer cannot.
34. `ie`, `ppc`, `project-manager` and `qc` grants cannot bind.
35. The JWT `role: "production_supervisor"` alone cannot bind.
36. `isAdmin` alone cannot bind.
37. A department with **no** roles granted still refuses (the guard fails closed).

**Scope (§7.13)**
38. The envelope carries `attributesEvidence: false`, `measuresProductiveTime: false` and `operationIdentityEvidence: false`.
39. No binding command or read touches `ProductionTracking`.

### 7.11 Mutation proofs

| Mutation | Must turn red |
|---|---|
| Match operations by array index | 2, 3 |
| Drop the uniqueness requirement on code matching | 4 |
| Omit company from the ownership proof | 7 |
| Accept a `CLARIFICATION_REQUESTED` receipt | 14 |
| Look up the receipt by `ieReleaseId` but **skip the ref/version comparison** | 15, 16 |
| Accept a superseded release | 18 |
| Let IE supersession rewrite the binding | 20 |
| Remove the partial-unique `ACTIVE` index | 8, 27 |
| **Write the ledger row after the transaction** instead of inside it | 26 |
| Drop `command` or the target from the request hash | 24, 25 |
| Put a single key/hash on the binding and use it for supersede replay | 23 |
| Leak the duplicate-key error on a lost race | 31 |
| Allow a retroactive `effectiveFrom` | 11 |
| Replace the fail-closed guard with `departmentWrites` | 37 |
| Accept the JWT `role` as authority | 35 |
| Publish the fingerprint | 11 |
| Set `attributesEvidence: true` | 38 |

### 7.12 Boundaries

| Department | Owns | Must not |
|---|---|---|
| **IE** | the immutable release and its frozen rows | write a binding, a work order, a scan or a ledger row |
| **PPC** | the acceptance receipt | write a binding or any Production record |
| **Production** | the binding, its ledger, the scanner, the work order, completion, the device fleet | rewrite an IE release or a PPC receipt |
| **HR** | employee identity (`Employee.identityId`) | be treated as operator **output** |
| **Maintenance** | physical machines and their state | have planned machine **type** presented as the machine used |
| **Quality** | `DefectRecord`, stages, rework rounds | have defect operation text treated as IE identity |

### 7.13 What 9A-i does NOT establish

9A-i creates **provenance only**: which frozen IE release, accepted by PPC,
governed a work order from a given moment. It establishes nothing about what
happened on the floor.

- It does **not** make any existing scan trustworthy. Scans stay unauthenticated,
  device-supplied and deletable until §10 lands.
- It does **not** measure productive time. None is recorded (§3.1).
- It does **not** create operation-identity evidence. `operationMap` is a planned
  bridge decided before any work, not a record of which operation a scan
  performed.
- It does **not** attribute any scan to the binding. That is 9A-ii, and it is
  gated.
- It does **not** change `WorkOrder.productionCompletion` or any reader of it.

The envelope says so in `scope`, `attributesEvidence`, `measuresProductiveTime`
and `operationIdentityEvidence`, so no screen can infer otherwise.

---

## 8. Chunk 9A-ii — attributing evidence to a binding (gated)

A **read-only**, on-demand evidence report per binding. **It must not start**
until every gate below is met. Each gate is Production-owned.

| Gate | Why 9A-ii cannot run without it |
|---|---|
| **G1 — Scanner security enforced** (§10.3) | Unauthenticated scans can be injected against any signed-in operator; attributing them to a binding would launder them into evidence |
| **G2 — Evidence retention fixed** (§10.1, §11.1) | The raw scans for completed orders can be deleted; a report that silently loses its oldest evidence is not a report |
| **G3 — Barcode resolution decided** (§11.3) | Two dialects, an unparseable `WO--001`, and a company-blind 32-bit suffix; attribution needs a resolution rule Production owns |
| **G4 — `activeOps` encoding decided** (§11.5) | Three encodings in one field; the sync already loses multi-operation scans |

When the gates are met, 9A-ii attributes as follows:

- **Work order:** a scan attributes to a binding only when its barcode resolves to
  exactly one order that has that binding. Full-dialect ids resolve exactly. A
  Short-dialect suffix resolves **only among the acting company's bound orders**,
  and is refused as ambiguous if it matches more than one. Both dialects and every
  printed label stay readable.
- **Company:** a scan inherits company **only from its bound order** — never from
  the operator, the machine, the device, or the acting user's selection.
- **Time:** the binding's `effectiveFrom..effectiveTo` window, read with `find`
  over a date range, never `findOne({date})`, because duplicate day documents
  exist.
- **Operation:** parse all three encodings; map codes through the **frozen**
  `legacyOperationCode` → `bulletinRowId`. Every attribution carries
  `matchBasis: "LEGACY_CODE_VIA_FROZEN_MAP"`. Unmatched scans go to an
  `UNATTRIBUTED_OPERATION` bucket, reported, never dropped.
- **Quantity:** distinct unit numbers per operation, with the raw scan count
  beside it.
- **Machine:** `physicalMachine { machineId, name, serialNumber, typeText }` and
  the frozen `plannedMachineType`, published as **two separate fields**.
- **Time evidence:** scan instants only. No productive time is published as
  measured; any interval is labelled `INFERRED` with the 30-minute heuristic
  named. The planned-time substitution is never reproduced.
- **Unknowns stay `null`.** No variance is reported where either side is unknown.

This slice can claim **operation-level compatibility evidence**, never identity
traceability.

---

## 9. Can Chunk 9A start before Production has company tenancy?

**Yes, for the binding. Not for identity-level traceability.** The binding
carries its own proved `companyId`, so it does not need `WorkOrder` tenancy — it
is simply unavailable for orders whose company cannot be proved.

| | |
|---|---|
| **IE can build now** | Nothing new is required — the release, its frozen rows and the receipt exist. IE may add a read showing which bindings reference a release. |
| **Production can build now** | The security containment S0a–S0c (§10), and then 9A-i (§7). |
| **Production must own first** | The device-identity contract (§10.3), evidence retention, barcode resolution and `activeOps` encoding — the 9A-ii gates. |
| **Compatibility evidence only** | Operation-level actuals from `activeOps`; defect operation text; any order bound after production started. |
| **Blocked** | Identity-level operation traceability (needs IE row identity recorded at scan time); downtime (no source); measured productive time (not recorded); release attribution for orders whose company cannot be proved. |

---

## 10. The first Production task — S0: security containment

**Separate from 9A-i and ahead of it.** Owner: Production. It changes no binding,
no barcode, no printed label and no scan payload, and it does not add
browser-session auth to any device endpoint.

### 10.1 S0a — disable the manual cleanup trigger (immediate)

**Safest containment: remove the HTTP trigger outright.** `POST
/api/cms/production/cleanup/manual` has **no caller** (§4.4), and the scheduled
run is already off. Answer it with **404** (unmounted) rather than guarding it:

- nothing legitimate breaks;
- a guard would still leave an evidence-deleting route reachable by anyone who
  holds the grant, and 9A-ii needs that evidence;
- `cleanupOldTrackingData()` stays in the service, unreachable over HTTP, until a
  retention-aware, authenticated replacement is decided (§11.1).

Do **not** re-enable `initialize()`. It would restart the 02:00 purge.

### 10.2 S0b / S0c — guard the browser-only routes (immediate)

Each has a browser caller with an existing session, so employee authentication
plus a fail-closed department grant **does not affect any device**:

| Task | Routes | Guard |
|---|---|---|
| **S0b** | `POST /api/barcode-devices/firmware`; `GET /api/barcode-devices/`, `/:deviceId`, `/firmware/list` | employee auth + a live grant at `owner` — firmware replacement is the most dangerous act in this area |
| **S0c** | `POST /api/cms/production/sync/manual`, `/employee-sync/manual` | employee auth + a live grant at `approver` |

**Which department's grant guards S0b and S0c is Production's decision to
record, not this audit's to assume.** The routes are called from the
project-manager dashboard, while the data they write — completion and the device
fleet — is Production's. Record the choice in the decision register. **Do not
create a new role name.**

These guards must stay **off** the device routes: `check-update`,
`/firmware/download/:version` and `/name`.

### 10.3 S0d / S0e — device endpoints need an accepted device-identity contract

`/tracking/scan`, `/tracking/bulk-scans`, `check-update`, `/firmware/download` and
`/name` are called by firmware. `/tracking/scan` is **also** called by a browser
scanner page. Browser-session auth on these would **stop every floor device**, so
it must not be added without a contract.

**S0d — make the inline routes testable, byte-for-byte.** Move the inline block
out of `server.js` into a mountable router **without changing behaviour**, and pin
golden request/response tests for both barcode dialects, employee sign-in and
sign-out, `bulk-scans` replay and `check-update`. No test can reach these routes
today (§0); nothing in S0e can be proved until S0d lands.

**S0e — a device-identity contract, accepted before enforcement.** It must
decide:

- a per-device credential issued at registration and bound to
  `BarcodeDevice.deviceId`, stored hashed, presented in a header;
- which `machineId` values a device may report — today the device chooses, and
  the server only checks the machine exists;
- how the browser scanner page authenticates — session auth on its own route or
  path, not the device credential;
- rotation and revocation;
- a rollout that **observes first**: accept and log a missing or invalid
  credential, measure every caller, and only then enforce.

Until S0e is accepted, the only safe interim containment for the device routes is
**at the network edge** — restricting them to the factory's egress addresses, if
the devices call from a fixed network — together with access logging. That is a
deployment decision, and this source audit cannot verify it.

### 10.4 Tests that prove anonymous calls cannot scan or delete

| # | Test | Needs |
|---|---|---|
| S-1 | Anonymous `POST /cleanup/manual` → 404, and `ProductionTracking.deleteMany` is never called | S0a |
| S-2 | `cleanupOldTrackingData` is unreachable from any mounted route (source and router-table scan) | S0a |
| S-3 | Anonymous `POST /api/barcode-devices/firmware` → 401; no file written; no `Firmware` row | S0b |
| S-4 | Authenticated, without the grant → 403; with it → 201 | S0b |
| S-5 | `check-update` and `/firmware/download` still answer a device **unchanged** | S0b |
| S-6 | Anonymous `/sync/manual` and `/employee-sync/manual` → 401; no `WorkOrder` write | S0c |
| S-7 | Golden: `/scan` and `/bulk-scans` produce byte-identical responses and stored documents for both dialects | S0d |
| S-8 | Observe mode: a scan without a device credential is **accepted and logged** | S0e |
| S-9 | Enforce mode: a scan without, or with an invalid, credential → 401, and **no `ProductionTracking` write** | S0e |
| S-10 | Enforce mode: a valid credential → the same bytes as S-7 | S0e |
| S-11 | A credential bound to device A cannot report a machine outside device A's allowed set | S0e |
| S-12 | The browser scanner page authenticates on its own path | S0e |

**Mutation proofs:** remove each guard → S-3, S-6 and S-9 turn red; re-mount
cleanup → S-1 and S-2 turn red; guard `check-update` with session auth → S-5 turns
red; in enforce mode, accept a missing credential → S-9 turns red; let the device
choose any `machineId` → S-11 turns red.

### 10.5 Deployment checks — confirm the live environment matches this source

This audit read source only. Before S0 is declared done, Production confirms, **by
reading configuration and logs — never by calling a destructive route against a
live system**:

1. The deployed commit contains the audited `server.js` inline block, and
   `productionSyncService.initialize()` is still commented out.
2. Whether any edge, proxy or hosting rule already guards `/api/cms/production/*`
   or `/api/barcode-devices/*`. Source shows none, but the edge may differ.
3. Access logs: every caller of `/cleanup/manual`, `/sync/manual`,
   `/employee-sync/manual` and `/firmware` — **any anonymous or unknown caller is
   an incident, not a statistic**.
4. The `Firmware` collection: which versions are active, their `targetDevices`,
   and their file hashes against the builds Production actually shipped.
5. The URL the shipped firmware posts scans to. If any device still calls the
   unmounted `/api/tracking/scan`, those scans are being lost as 404s today.
6. Whether cleanup has ever run: the log line "Cleaning up old tracking data".
7. The host timezone, for the day-bucket finding in §4.5.
8. A read-only count of duplicate same-date `ProductionTracking` documents.

---

## 11. Other Production-owned prerequisites

In order of harm, after S0. Items are cited elsewhere as §11.1–§11.9.

1. **Replace the purge with a retention policy.** Scans for completed orders are
   the evidence Chunk 9 compares; decide their retention before 9A-ii (gate G2).
2. **Decide the fate of mark-as-done** — dead since 2026-04-01 while the PM
   dashboard still calls it. Re-mounting it as written would restore fabricated
   virtual scans.
3. **One barcode resolution rule and one `workOrderNumber` form.** Two writers
   assign two forms; the sync cannot see the Full dialect; legacy numberless
   orders print unparseable `WO--001` (gate G3). Printed labels in both dialects
   must stay readable.
4. **Guard operation add/remove/reorder** on orders with production evidence
   (`workOrderRoutes.js:1457, 1479, 1519`).
5. **Fix the `activeOps` encoding** — store a real array, never `""` or a
   comma-joined string. A firmware and server decision (gate G4).
6. **Make the `ProductionTracking` day document unique** and align its day
   boundary with IST.
7. **Stop substituting planned time for actual time** (`productionSyncService.js:414`).
8. **Company tenancy on `WorkOrder`** — the longer-term step that would widen
   bindable orders beyond those provable through their style.
9. **Record IE row identity at scan time** — the only path to identity-level
   traceability. A firmware and Production contract.

---

## 12. Revised implementation order and remaining blockers

### 12.1 Order

| Step | Owner | Depends on | Touches the floor? |
|---|---|---|---|
| **S0a** disable the manual cleanup trigger | Production | — | No |
| **S0b** guard firmware upload and fleet reads | Production | a recorded department choice | No — devices only download |
| **S0c** guard manual sync triggers | Production | a recorded department choice | No |
| **Deployment checks** (§10.5) | Production / ops | — | No — read-only |
| **S0d** extract the inline scanner routes, byte-for-byte, with golden tests | Production | — | **No — behaviour pinned identical** |
| **9A-i** execution binding + command ledger | Production (IE and PPC read-only) | S0a–S0c landed | No |
| **S0e** device-identity contract: observe, then enforce | Production + firmware | S0d; an accepted contract | Yes, only after observe mode proves every caller |
| Retention, barcode resolution, `activeOps` encoding | Production | S0d | Encoding — yes, firmware |
| **9A-ii** evidence attribution | Production / IE read | **G1–G4** all met | No — read-only |
| Scan-time IE row identity | Production + firmware | 9A-ii | Yes |

9A-i does not technically depend on S0; it reads no evidence. It is sequenced
after S0a–S0c because those remove the most harmful exposure in hours, with no
device impact, and should not wait behind a new feature.

### 12.2 Exact remaining blockers

| Blocker | Blocks | Owner |
|---|---|---|
| Anonymous firmware upload offered to every scanner | everything that trusts a scanner | Production — S0b |
| Anonymous evidence deletion | 9A-ii (G2) | Production — S0a |
| No device-identity contract; unauthenticated scans | 9A-ii (G1) | Production + firmware — S0e |
| The live scanner has no tests | proving S0e, G1–G4 | Production — S0d |
| 15-day purge of completed-order evidence | 9A-ii (G2) | Production — §11.1 |
| Two barcode dialects; `WO--001`; company-blind suffix resolution | 9A-ii (G3) | Production — §11.3 |
| `activeOps` in three encodings | 9A-ii (G4) | Production + firmware — §11.5 |
| Unguarded operation reorder on in-production orders | trustworthy historical attribution | Production — §11.4 |
| No downtime source | downtime analysis | Production + Maintenance |
| Productive time not recorded | measured productive time | Production + firmware |
| No scan-time IE row identity | identity-level traceability | Production + firmware |
| No `WorkOrder` tenancy | binding orders whose company cannot be proved | Production / Project Manager |
| The S0b/S0c department choice | S0b, S0c | Production — decision register |

**Not a blocker for 9A-i:** none of the above. 9A-i reads the release, the receipt
and the order, and writes only its own binding and ledger.

---

## 13. Verdict

The execution binding is a real, safe, additive first slice. It needs no
`WorkOrder` tenancy, touches no existing record, preserves both barcode dialects
and every printed label, freezes the release-to-operation bridge so historical
actuals resolve against the frozen release, proves the PPC acceptance by exact
receipt identity, and carries a command ledger that commits with it. It is
**ready**, and it claims provenance only.

Everything that would make operation-level actuals trustworthy is **not** ready,
and it is Production's:
- the scanners accept anonymous firmware and anonymous scans;
- the evidence can be deleted by an unauthenticated request;
- the barcode and operation encodings are ambiguous;
- downtime and productive time are not recorded.

The first Production task is the security containment in §10, separate from the
binding and ahead of it.

`PARTIALLY_READY_WITH_NAMED_FIRST_SLICE`

---

## Appendix A — full-collection `WorkOrder.find({})` resolvers (17)

`server.js:2721` · `routes/Barcode_Scan_Punchings/trackingRoutes.js:43` (dead) ·
`routes/CMS_Routes/Production/Tracking/trackingRoutes.js:43` (dead) ·
`packagingRoutes.js:422, 1132` · `Production/productionCompletionRoutes.js:59,
133, 245, 350` · `productionDashboardRoutes.js:56` ·
`CEO_Routes/rawItemWastageRoutes.js:282` · `CEO_Routes/Production.js:1110, 1643,
1845, 2316, 3269, 3628`

## Appendix B — readers by record

**`ProductionTracking` (14):** `server.js`, `productionSyncService.js`,
`CEO_Routes/Production.js`, `CEO_Routes/commandCenter.js`, `packagingRoutes.js`,
`workFlowTrackRoutes.js`, `qcRoutes.js`, `workOrderProgressRoutes.js`,
`workOrderRoutes.js`, `workOrderTimeline.js`, `productionDashboardRoutes.js`;
dead: `Barcode_Scan_Punchings/trackingRoutes.js`,
`Production/Tracking/trackingRoutes.js`, `markAsDoneRoutes.js`.

**`ProductionCompletionScanRecord` (5):** `manufacturingOrderRoutes.js`,
`Production/productionCompletionRoutes.js`, `workOrderRoutes.js`,
`services/manufacturing/planningFacts.js`, `services/productionView.js`.

**`WorkOrder.productionCompletion` (28):** includes
`services/centralCosting/productionActual.service.js`,
`services/centralCosting/productionCloseout.service.js`,
`services/closingReport.js`, `services/closingVerdict.js`,
`services/productionView.js`, `services/shipmentView.js`, and customer-facing
`Customer_Routes/OrderTracking.js`.

**`EmployeeProductionProgress` (17)** and **`DefectRecord` (8):** as enumerated
in §2.10.

## Appendix C — the zero-tenancy table (re-verified)

`WorkOrder`, `ProductionSchedule`, `ProductionTracking`,
`EmployeeProductionProgress`, `ProductionCompletionScanRecord`, `Machine`,
`DefectRecord`, `BarcodeDevice`: **0 `companyId` occurrences each.** `Employee`:
0.
