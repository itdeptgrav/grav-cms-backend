# Latest implementation — the CEO could read the requests desk but never write to it (1 Oct 2026)

> User-requested fix. Two routers, one model field, one new service. Nothing
> migrated, nothing committed. One row was written to Atlas — see below.

## The fault

Signed in as the CEO, the Raise-a-request form refused on submit:

> "Raising a request has to be done by a member of staff, and this login is a
> department account with no staff record. Sign in with your own employee login."

The sentence was true and useless. `intakeRequests.requester()` resolved a login
with no `employees` row to a STAND-IN — department and nothing personal — and
`refuseStandIn` then blocked raise, approve and withdraw. `ceodepartments` /
`dept_users` holds `ceo@grav.in` / `CEO001`; `employees` held nothing for it, and
`spendRequests.requester()` answered `null` outright, so every spend door
answered "Your staff record was not found."

## The fix — a row, not a looser schema

`services/requests/departmentStaffRecord.js` · `ensureStaffRecord(req)`. For a
login carrying a badge (`employeeId`) AND a live department grant (`deptId`), it
finds-or-upserts one `employees` row from what the session already proves: badge,
name, email, department. `$setOnInsert` only, so a record HR later fills in is
never flattened back; `accessDepartmentId` is the one field kept current.
`Employee.isDepartmentAccount` (new, default false) marks it — it gates nothing.

Both routers call it when the lookup misses: `intakeRequests.requester()` falls
back to it before the stand-in, `spendRequests.requester()` before `null`.

**Why not make `requestedBy` optional.** Three collections hold a REQUIRED ref
into `employees` for who asked — `IntakeRequest.requestedBy`, `MRF.requestedFor`,
`SpendRequest.requestedBy` — read by the "my requests" list, withdraw-ownership,
the approval chain and the MRF/spend spawn. Loosening all three pushes a null
check into every reader, and a missed one fails as a deleted employee rather than
as an error. The row keeps every ref valid. It is the move `coworkAuth` already
makes for a `ceo` claim with no Firestore document (`E000`).

## Attachments were stored and never shown

The form has uploaded documents to Drive and sent them since the service fields
existed, and `IntakeRequest.documents` has stored them — but no row carried them,
so a request with a PDF on it read "No photos" and the file was only findable in
the database. `intakeRow` now carries `documents[]` (url, name, mimeType, fileId)
and `documentCount`; `components/mrf/RequestDesk.js` renders each as a link in the
row's quiet line.

## Verified, live, as the CEO

- `GET /api/requests/intake/me` → `standIn: false`.
- One `employees` row written: `6abe1ca43ab8b52bed0f4005`, CEO001,
  `isDepartmentAccount: true`, Executive Office. **HR will see it in their list.**
- Service master created through the API: SVC/2026-27/0002.
- REQ-2610-0003 raised via the API, then **withdrawn through the UI** (the
  withdraw door was blocked by the same refusal).
- REQ-2610-0004 raised through the real form in the browser: PDF uploaded to
  Drive (`POST /api/upload-to-drive` → 200), `POST /api/requests/intake` → 201,
  row shows in My requests and in the Store's To-fulfil queue with the PDF as a
  link.
- `npm test`: 2165 pass, 3 fail — the same 3 fail on a clean stash
  (openItems, officeDeadline, a dry-run position test). Unrelated.

## Left undone, deliberately

The requester's own `documents` are still not copied onto the SpendRequest a
classification spawns (that model's `attachments` are Drive fileIds with no url —
a different shape and a different door). The intake row keeps them, so they stay
visible on the desk either way.

---

# Latest implementation — Accounting sessions could never be upgraded (1 Oct 2026)

> User-requested fix, outside the active Store & Purchase lanes. One file
> changed: `routes/Accountant_Routes/Acc_auth.js`. Nothing written to Atlas,
> no migration, nothing committed.

## The fault

Nobody who signed in through the main CMS login could reach Accounting. The
module loaded with every permission `false` and no organisation.

`POST /api/accountant/auth/sync-legacy` — the only door from a CMS session to an
`accountant_token` — resolved an `Acc_Department` row before it would do
anything, and refused anyone without one:

> "Your account isn't recognised as an accountant in the system. Only main
> accountant admin accounts can be promoted to organization owner."

`Acc_Department` is bound to collection `acc_departments`, which holds **zero
documents** in the live database. The pre-rename legacy rows were left behind in
`accountantdepartments`, and even that collection holds a single address
(`accounts@grav.in`). So the lookup failed for every person, **including the
Accounting owner** (`ray@grav.in`), every time.

The department row was only ever the input to the auto-promotion branch — it
decided *who could be made an owner*. That branch is retired (GAC-2): nothing is
created here any more. The lookup had been left behind, where it could only gate
legitimate users and grant nothing.

## The fix

`sync-legacy` now decides on the **Acc_User row**, which is what Access Control
actually writes, what carries the role and the organisation, and — with
`loginMode: "none"` — is exactly the "Accounting role storage for somebody whose
login identity lives elsewhere" case that `canonicalIdentity.service` describes.

The email comes from the bootstrap token, already verified against `JWT_SECRET`
by `legacyBootstrapAuth`; it is this backend's own claim about who signed in.

Removed: the `Acc_Department` / `mongooseRef` lookup block and `trustedEmail`.
Unchanged: the `isLegacy` guard that stops an `accountant_token` re-bootstrapping
itself, the `sessionsRevokedAt` ("log out of all devices") check, the inactive
refusal, the cookie + body token, and the `ACCOUNTING_GRANT_REQUIRED` 403 for a
person with no Accounting role.

## Verification (live dev database, server on :5055)

`POST /sync-legacy` with a CMS-shaped JWT, one address per Accounting role:

| Address | Before | After |
|---|---|---|
| `ray@grav.in` | 403 not recognised | 200 — `owner`, org GRAV |
| `accounts@grav.in` | 403 not recognised | 200 — `approver` |
| `subhadra.sahoo@grav.in` | 403 not recognised | 200 — `approver` |
| `casubhamsanket@gmail.com` | 403 not recognised | 200 — `viewer` |
| `nobody@grav.in` | 403 not recognised | 403 `ACCOUNTING_GRANT_REQUIRED` |

With the upgraded `accountant_token`: `GET /auth/me` returns the owner, the GRAV
organisation with its three companies, and all six permissions true;
`GET /tally/companies`, `/dashboard` and `/team` all answer 200.

## Not changed, and why

- **The direct door** `POST /api/accountant/auth/login` is untouched. It is for
  sub-accounts with no CMS record, and its `classify()` gate is correct.
- **`Acc_Department` itself.** The model and its empty collection are left
  alone; no data was migrated or renamed.
- `test/accountant/{legacy-auth-bootstrap,company-ownership-sync-legacy,accounting-auth-inventory}`
  fail under `node --test` both before and after this change — they use
  jest-style `beforeAll`. Pre-existing harness mismatch; they are not in
  `npm test`'s scope.

---

# Latest implementation — T&A Step 1: the controlled milestone foundation

> **Third pass, 27 Sep 2026.** The starter now places the production-readiness
> meeting, storage Option A is built (shared collection, discriminator), and the
> "automatic rejoin" claim is corrected. The only thing outstanding is one live
> index build, spelled out in
> `docs/decisions/tna-milestone-library-storage.md`.

27 Sep 2026. Lane A. **Nothing committed. Nothing written to Atlas. No migration run.**

## What changed, in one sentence

A milestone is now a record on a company-controlled list, and a template step
selects one and places it — it can no longer type the milestone's name, its
owning department, or the system action that closes it.

## Why

Across the starter template, the demo seeds and the tests, the same control
point existed under two identities:

| Found | What it was |
|---|---|
| `TRIM_APPROVED` and `TRIM_CARD_APPROVED` | both named "Trim card approved" |
| `FABRIC_IN` and `FABRIC_IN_HOUSE` | both named "Fabric in house" |
| `PPC_HANDOVER` | "Execution pack handed to PPC" in one template, "File handed to PPC" in another |
| `PRODUCTION_START`, `SEWING_START`, `CUTTING_START` | "Production starts" named no operation and overlapped cutting |
| `SAMPLE_APPROVED` | "Buyer approves the sample" — the development sample or the pre-production one? |

No single template was wrong. The company simply had no one thing called the
trim card, so "how late is the trim card, across every order" had no answer.

## The data model

`TnaMilestoneDefinition` — `merchandising_tna_milestone_definitions`.

- `milestoneCode` **immutable**, unique per company. A renamed milestone is the
  same control point with better words; a different control point is a
  different code.
- `name` is what a merchandiser reads, unique per company — that uniqueness
  index is what stops two codes wearing one label again.
- `stage`: `DEVELOPMENT` | `ORDER_EXECUTION` | `BOTH_CONDITIONAL`. The boundary
  that stops an order template asking for work finished before the order.
- `completionMethod`: `MANUAL` | `SYSTEM_EVENT`, mapped to the plan's existing
  `MERCHANDISING` | `SOURCE_EVENT` by `library.authorityFor` — the only
  conversion, so neither vocabulary has to know the other.
- `systemEventKey` must be a kind `tnaSourceEvents` knows. Free text here is a
  milestone waiting for a message nobody will send.
- `explanation`, `completionCriteria`, `proofRequired` — the sentences that
  settle an argument about what counts as done.
- No delete. Retiring is `isActive: false`, because a published template and
  every plan built from it still name the milestone.

Editable later: `name`, `explanation`, `completionCriteria`, `proofRequired`,
`isActive`. Refused: `stage`, `ownerDepartment`, `completionMethod`,
`systemEventKey`, `category`, `milestoneCode` — a milestone that means
something different is a different milestone.

## Requirement 5 needed no work

`TnaPlan.milestoneSchema` already snapshots `name`, `ownerDepartment`,
`completionAuthority` and `sourceEventKinds` at creation, and a plan pins
`templateVersionId`/`templateVersionNo`. Renaming a definition changes what NEW
plans are created with and nothing else. Proved, not assumed:
`tna-milestone-library.test.js` publishes a version, renames the definition, and
asserts the published version still holds the old words while the next version
gets the new ones.

## The compatibility rule — **CORRECTED**

There is **no compatibility mode**. The earlier pass let a company with no list
keep typing milestone names so nothing broke on deploy day. That made the
controlled list optional — a rule avoidable by having no data is not a rule —
and it kept producing exactly the records the list exists to stop.

Reading history and creating new data are different permissions:

| | Rule |
|---|---|
| A stored template version | read exactly as stored, forever. Reads never consult the list. |
| A running plan | unchanged, and keeps the words it was created with. |
| Creating a new version | refused unless every step names a library milestone. |
| Updating a draft | same refusal — including a draft created while a list existed and edited after it was emptied. |
| A company with no list | `TNA_MILESTONE_LIBRARY_REQUIRED`, naming both the screen and the seeder. |

## The publication rule — **CORRECTED**

A version may not be **published** containing a milestone completed by a system
action that nothing publishes yet. A schedule is a commitment, and a date
nothing can ever meet or mark is not one. Previously a `PLANNED` kind published
and merely showed as "Not integrated".

- Historical published versions and running plans keep theirs, shown as "Not
  integrated" and excluded from overdue, at-risk and next-action figures.
- An empty `sourceEventKinds` is refused too — unreachable *and* unnameable.
- The error names the milestone, the event and the application that owes it.
- It does **not** offer making the milestone manual. Merchandising cannot
  declare Quality's inspection passed, so that "fix" would be a fabrication.
- The picker disables such a milestone and says why; the server enforces it.

### The honest consequences, stated rather than worked around

**The starter template places 5 milestones, not 10.** Five of the legacy ten
wait on applications that do not exist. They stay on every company's milestone
list, each naming who owes its event.

**The starter is no longer derived from the legacy snapshot.** That was the
structural defect behind a wired-but-unused integration: `MILESTONES` was both
the ten-row fingerprint `isShippedStarter` matches *and* the source of what new
companies got, so `PP_MEETING_HELD` — added to the library after that snapshot
was written — was connected end to end and placed in no real plan. Now:

| | |
|---|---|
| `LEGACY_STARTER_MILESTONES` | the immutable fingerprint, used only by `isShippedStarter` |
| `STARTER_PLACEMENTS` | what a new company actually gets: code plus scheduling fields, nothing else |
| `STARTER_EDGES` | the order the work happens in |

A load-time guard asserts every placement names a library milestone with a live
producer, and that every edge names a placed milestone — so a registry change
fails loudly here rather than at a customer's first publish.

**What happens when a producer is finally built — precisely.** A published
version is immutable and a running plan is pinned to the one it was created
from, so nothing rejoins anything automatically:

| | |
|---|---|
| The milestone | becomes **eligible** — a new version may place it |
| A company seeded afterwards | receives it, because the starter is computed when that company is seeded |
| An existing company | receives it only when somebody reviews and publishes a **successor version** |
| Plans already running | never change |

`PP_MEETING_HELD` is that story already played out. Four tests pin it
(`tna-milestone-library.test.js` §12), including that creating and publishing a
successor leaves version 1 byte for byte and that a published version cannot be
edited at all.

**No non-Merchandising milestone is schedulable yet**, because all five wired
kinds are Merchandising's own. That is the pressure the publication gate exists
to create.

**The `isShippedStarter` repair can no longer be applied.** It republished all
ten; five can no longer be published, so the only version it could create would
silently drop them. It reports `repairBlocked` with them named and writes nothing.

## Duplicate names — **CORRECTED**

`name` was unique per company on the raw string, so "Fabric in house",
"fabric in house", "Fabric-in-house" and "Fabric  in  house" were four
milestones. Now:

- `nameIdentity()` on the model folds case, strips accents, reduces punctuation
  to spaces and collapses runs. Exported, so the service's message and the
  reconciliation report use the *same* rules the index enforces.
- A `pre("validate")` hook derives `nameKey` on every save, so it cannot drift
  from the display name on a rename.
- Uniqueness is the **index** `{companyId, nameKey}`, not a read-before-write
  check: two people saving two spellings in the same second both read nothing
  and both insert. The loser's `E11000` is caught and answered as
  `TNA_MILESTONE_EXISTS`, naming the winner — proved by two concurrency tests.
- The display name is stored exactly as typed.
- Nothing is merged. The report lists collisions, and a looser pass flags pairs
  the index would allow but a person should look at.

## The event registry gained six names

`tnaSourceEvents.PLANNED` now also names `source.store.fabric_in_house`,
`source.store.trims_in_house`, `source.production.sewing_started`, and print /
embroidery / wash approvals under `source.product_development.*`.

Six starter milestones previously carried an EMPTY `sourceEventKinds` under the
documented convention "no application publishes this yet". That convention said
the right thing badly: a screen could say a milestone was not connected, but not
what it was waiting for or who owed it. All six now name a kind, so they read
"waiting on Store's goods receipt" instead of "waiting on nothing". **No
behaviour changed** — a `PLANNED` kind has no producer, so none of them
completes today.

Fabric and trims are two kinds rather than one `source.store.material_received`
deliberately: one kind shared by two milestones would close both the moment
either material arrived. A test pins that no two shipped milestones share a kind.

## The starter library — 16 entries

The ten codes the starter template already uses are **unchanged**. Published
versions and running plans name them and `isShippedStarter` recognises an
untouched company by them. Only their words improved:

| Code | Was | Now |
|---|---|---|
| `TRIM_CARD_APPROVED` | Trim card approved | Materials and trims approved |
| `PACKAGING_APPROVED` | Packaging specification approved | Packaging approved |
| `DEVELOPMENT_APPROVED` | Development requirements approved | Development work list approved |
| `SAMPLE_APPROVED` | Buyer approves the sample | Pre-production sample approved |
| `PPC_HANDOVER` | Execution pack handed to PPC | Order pack sent to production planning |
| `PRODUCTION_START` | Production starts | Sewing started |
| `EX_FACTORY` | Ex-factory | Goods dispatched |

Added: `PP_MEETING_HELD`, `CUTTING_START`, and four Development-stage entries
(`DEV_SAMPLE_APPROVED`, and print / embroidery / wash approvals as
`BOTH_CONDITIONAL`).

## Reported, not resolved

- **`SAMPLE_APPROVED` is ambiguous.** Two different approvals wore "Buyer
  approves the sample". It is now the per-order pre-production one, and
  `DEV_SAMPLE_APPROVED` is the development one. A company that meant the
  development sample must move its own template step — that is a decision about
  their process, so nothing moves it for them.
- **`EX_FACTORY` stays owned by `IE_PPC_PRODUCTION`.** Dispatch arguably belongs
  to Logistics, and the vocabulary has it, but the owning department decides who
  may complete a milestone, so moving it moves authority. The owner's call.

## Files changed

Backend:
- `models/CMS_Models/Merchandising/TnaMilestoneDefinition.js` **new** — plus `nameIdentity` and the `nameKey` hook and unique index
- `services/merchandising/tnaMilestoneLibrary.service.js` **new** — `libraryFor` now refuses an empty list; `E11000` answered as a refusal
- `services/merchandising/tnaSourceEvents.js` — `knownKinds`/`isKnown`, six `PLANNED` names, `unsupportedInVersion` rewritten to require a live producer
- `services/merchandising/tnaConfig.service.js` — `STEP_FIELDS` only, no fallback shape, library always required
- `services/storePurchase/errors.js` — eight T&A codes registered
- `routes/CMS_Routes/Merchandising/tnaRoute.js` — `GET/POST /tna/milestones`, `PATCH /tna/milestones/:code`
- `routes/CMS_Routes/Merchandising/ppmRoute.js`, `handoverPackRoute.js` — `closed`/`retrying` instead of per-call counters
- `scripts/readiness/seed-tna-starter.js` — seeds the list; `PUBLISHABLE` derived from the registry; the repair reports and refuses
- `scripts/readiness/local-data-closure.js` — two checks whose premises changed
- `scripts/demo/merchandising-demo-complete-file.js` — places library codes, six milestones not fourteen, mixed states on rows that exist
- `scripts/migrations/tna-milestone-library-report.js` **new**, read-only
- `scripts/migrations/collection-cap-inventory.js` **new**, read-only

Frontend:
- `lib/merchandising/api.js` — `listTnaMilestoneLibrary`
- `components/merchandiser/ConfigurationEditor.js` — the typed code, name, owner,
  authority and event-key controls are gone; picker plus read-only facts; an
  unproducible milestone is visible, disabled and explained

Tests: `tna-milestone-library.test.js` (new, 51), `tna-milestone-library-report.test.js`
(new, 2), `configurationEditor.render.test.mjs` (new, 8), and edits to
`tna-plan.route`, `tna-source-event-integration`, `tna-starter-and-at-risk`,
`tna-overview-attention`, `demo-complete-file`, `preorderDevelopment.test.mjs`.

## The reconciliation report has no `--apply`

`scripts/migrations/tna-milestone-library-report.js` reads and prints. Every
question it raises — a step naming a milestone the list does not hold, two codes
meaning one thing, a step disagreeing with the list — is a question about
somebody's process, and a script that answered by picking would silently merge
two control points into one. Verified read-only: no `create`, `updateOne`,
`save`, `bulkWrite` or `deleteOne` anywhere in it.

## Verification

| Suite | Result |
|---|---|
| `tna-milestone-library.test.js` | **55 passed** (+4: published-version immutability) |
| `tna-configuration-collection.test.js` **new** | **13 passed** |
| `tna-starter-and-at-risk.test.js` | **12 passed** (+4: the two wired moments end to end) |
| `tna-milestone-library-report.test.js` | **2 passed** |
| `tna-source-event-integration.test.js` | **19 passed** |
| `tna-plan.route.test.js` | **40 passed** |
| `demo-complete-file.test.js` | **21 passed** |
| `ppm-lifecycle-immutability.test.js` | **25 passed** |
| `configurationEditor.render.test.mjs` | **8 passed** |
| `components/merchandiser/*.test.mjs` | **1006 passed, 0 failed** |
| `local-data-closure.js` | all checks passed (own in-memory replica set) |
| **the whole `test/merchandising` suite** | **43 of 47 suites, 1320 of 1324 tests** — the 4 failures are the pre-existing ones below |

### The two wired moments, proved on a real starter plan

`tna-starter-and-at-risk.test.js` §3 seeds the **real starter**, accepts a file,
creates and baselines a plan, then:

1. asserts both milestones are placed and the meeting's date falls **before** the
   handover's;
2. drives the real PPM route — draft → written up → conducted → **issued by a
   second person** — and asserts the meeting milestone closes while the pack
   milestone stays open;
3. drives the real pack route — prepared, then **submitted by a second person** —
   and asserts the pack milestone closes while the meeting stays open;
4. does both and asserts two milestones closed from **two different records**:
   two distinct `sourceEventKind`s and two distinct `sourceRecordRef`s, with
   `completedBy` empty on each, because nobody signed for either by hand.

The pack's own gate is satisfied the real way — three revisions created and
approved by a maker and a different checker — which incidentally makes this a
five-milestone end to end: all five close from five separate records.

### Existing tests changed, and why each was wrong rather than inconvenient

- **`tna-plan.route.test.js`** — its fixture held "Trim card approved" under
  `TRIM_APPROVED` and "Fabric in house" under `FABRIC_IN`: the exact duplicate
  pairs this work exists to end. Now seeds a list and places codes. Its fourth
  milestone was `EX_FACTORY`, owned by Production and waiting on nothing; it is
  now the readiness meeting, which proves the same rule with a real producer.
- **`tna-source-event-integration.test.js`** — three tests asserted the old
  publication rule. Rewritten, with the reversal explained in place.
- **`tna-starter-and-at-risk.test.js`** — the repair test now asserts the repair
  is refused and nothing written; a new test proves a legacy plan still reads with
  its stuck milestones intact and honest.
- **`tna-overview-attention.test.js`** — the "only one milestone collection" guard
  now passes for a better reason: there is no second collection at all.
- **`demo-complete-file.test.js`** — demanded ten milestones and four statuses,
  both satisfied by the rows that made the demo dishonest.
- **`preorderDevelopment.test.mjs`** — asserted a warning beside a control that no
  longer exists. Inverted to assert the control is gone and the rule moved to the
  library entry.

### Also fixed in this pass

Another agent had replaced the demo's milestone-list seeding with a comment
handing the work to Lane A. Done: the demo seeds the library and places codes.

### Pre-existing failures, not mine

Four suites fail on work in flight elsewhere in this shared tree. None touches a
file or symbol I changed.

One test each, four in total:

- `duplicate detection › it never answers what another company stocks`
- `a retry of a request that already succeeded › a key is scoped, so another company's identical key is not a replay`
- `companies are separate › a scoped run's duplicate check never reaches across the boundary`

  One root cause: `masterIdentityKey` duplicate detection reaching across
  companies (409 where 201 is expected). The schema index is correctly
  company-scoped, so the missing filter is service-side. `rawItems.js` currently
  has a partial refactor that removed four imports.

- `the complete Merchandising journey works as one product › Sales asks, Merchandising selects, the order adopts, PPC receives`

  `adopt.body.adopted` is 0 — Development-requirement adoption, which is Lane B's.

Every Time & Action suite passes.

## Storage — Option A built, one live index outstanding

The milestone library lives in `merchandising_tna_reason_codes` beside the reason
codes. `models/.../TnaConfiguration.js` is the neutral base;
`TnaMilestoneDefinition` is a Mongoose **discriminator** on it with value
`MILESTONE`.

- **The discriminator key is `kind`**, which every existing document already
  carries — so there was **no data migration**. A new key would have been absent
  on every existing row, and a discriminator filters by its key on every query,
  so every reason code in the business would have vanished from its own screens
  until a backfill ran.
- **Reason codes are not a discriminator.** `BLOCK`/`RESCHEDULE` is real
  information with two values, not a type tag with one. `TnaReasonCode` keeps its
  schema, document shape and indexes, and gets a query guard
  (`kind: $in [BLOCK, RESCHEDULE]`, `$and`-ed with whatever the caller asked) so
  a milestone can never be read as one.
- **`label` is not reused.** A milestone's `name` has its own length and its own
  uniqueness rule; the base requires neither field.
- **`code` *is* shared, deliberately** — same meaning in both — so the
  collection's **existing** unique index `{companyId, code, kind}` gives
  company-scoped milestone-code uniqueness with nothing built on a live cluster.

13 compatibility tests in `test/merchandising/tna-configuration-collection.test.js`
prove both directions, the reason-code document shape field-for-field, that the
shared index predates this work and carries no partial filter, and that a reason
code and a milestone may share a code.

### The one command awaiting explicit approval

```
db.merchandising_tna_reason_codes.createIndex(
  { "companyId": 1, "nameKey": 1 },
  { "unique": true,
    "name": "tna_milestone_name_unique",
    "partialFilterExpression": { "kind": "MILESTONE" },
    "background": true }
)
```

**PARTIAL is load-bearing**: a reason code has no `nameKey`, so without the
filter every one is `{companyId, null}` and the second insert fails. A test
covers exactly that. Run it through the dry-run script, which reports name
collisions first because a unique index will not build over violating data — and
merges nothing:

```bash
node -r dotenv/config scripts/migrations/tna-milestone-name-index.js
```

`autoIndex` is off in production, so deploying the code does not build it.

## Stopped here

Not started, per the brief: Sales requirement mapping, order-plan
reconciliation, the calendar redesign, demo seeding. The brief also listed
connecting the production-readiness-meeting and execution-pack events as
out of scope; both were built and tested in the previous pass and are left in
place rather than reverted.

## Step 2 connects here

- `services/merchandising/tnaSourceEvents.js` — `PLANNED` → `SUPPORTED`, with a
  `producer` and a `reference` shape, as each owning application starts publishing.
- `services/merchandising/tnaIntake.service.js` — `CONSUMED_KINDS` derives from
  `supportedKinds()`, so a kind moving to `SUPPORTED` is consumed with no edit
  here — for plans created from a version published after that point.
- `services/merchandising/tnaMilestoneLibrary.service.js` — `STARTER_LIBRARY`
  entries already point at the kinds; nothing to change when a producer lands.
- The `BOTH_CONDITIONAL` stage is where Sales' printing and embroidery
  requirements decide whether an order needs those milestones at all.
