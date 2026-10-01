# Engineering Feasibility — implementation and verification

1 Oct 2026. **Nothing committed. Nothing written to Atlas. No migration run.**

> Written to its own file rather than `latest-implementation.md`, which still
> holds the T&A lane's handoff for code that is not committed yet. Overwriting
> it would have destroyed that lane's only record.

## What it answers

One question, recorded once: **can this factory make this style?** Before this,
the Engineering Feasibility tab showed a placeholder saying no endpoint stored
the answer.

## Where the answer lives

The assessment is a DRAFT on the engineering file and a FROZEN COPY on the
bulletin version — the same shape the process route already uses, so feasibility
is decided by the maker-checker that already exists and gains no approval
system of its own.

| Thing | Where |
|---|---|
| The shape | `models/CMS_Models/IndustrialEngineering/feasibility.schema.js` |
| The draft | `IeStyleFile.feasibility` (+ a `FEASIBILITY_ASSESSED` history event) |
| The frozen copy | `IeBulletinVersion.feasibility`, written at submission |
| The rules | `services/industrialEngineering/ieFeasibility.service.js` |
| The doors | `GET`/`PATCH /api/cms/ie/engineering-files/:fileId/feasibility` |

There is deliberately **no approve verb**. A feasibility assessment is approved
by approving the bulletin version it was frozen into.

## The four outcomes

`NOT_ASSESSED` · `FEASIBLE` · `FEASIBLE_WITH_CONDITIONS` · `BLOCKED`

`NOT_ASSESSED` is the absence of a judgement, never a pass. `outcomeProblems`
refuses the three incoherent combinations: feasible with an open blocker,
"with conditions" and none stated, `BLOCKED` with nothing blocking.

Findings are repeatable records — area, observation, severity, owner, required
action, status — across eight areas (construction, materials, special
processes, machines, skills, difficult operations, quality risk, sample
evidence). Machines and materials may carry an availability, and only ever as a
question about a TYPE.

**Nothing commercial or physical is stored.** `REFUSED_FIELDS` names the fields
somebody will reasonably try to put here — a machine id, a serial number, an
operator, a rate, a supplier — and refuses each with where it actually belongs.

## Staleness

The assessment stamps the technical pack it judged (`basedOnTechnicalRevision`).
When R&D approves a newer one, `stalenessOf` marks it as needing reassessment,
and that outranks the verdict on every surface: a judgement about a garment that
has since changed is not reported as "can be made".

## The gate, applied prospectively

`feasibilityGaps(file, { stage })`:

| Stage | Refuses |
|---|---|
| `submitted` | not assessed |
| `approved` | not assessed, blocked, incoherent, stale |

So **a new submission attempt** needs an assessment, and approval additionally
needs it to be unblocked, coherent and current. Nothing retroactive:

- Versions already submitted, approved or released stay valid and readable.
- A historical version with no frozen snapshot reads
  **"Not recorded for this historical version"** — not "Feasible", not an error.
- A reopened legacy file needs an assessment before its NEXT submission.
- **No creation-date exception and no backfill.** Absence is absence; the gate
  reads the file's current state at the moment somebody tries to submit.

`saveFeasibility` does **not** bump the file revision — assessing a style must
not invalidate an open bulletin draft someone else is editing.

## The screen

`components/industrialEngineering/development/FeasibilityWorkspace.js`, with its
words in `feasibilityWords.mjs` (plain factory language: "Can be made",
"Collar folder must be arranged before bulk production" — never "assessment
entity absent"). It loads from the server on mount and replaces its state with
the server's published assessment after a save, so nothing lives only in the
browser. Writing is offered only where the server says this reader may write.

Review & Approval surfaces the server's own gap sentence, so the screen and the
refusal word the same condition identically.

## Fixtures, not weakened rules

530 suites failed the moment the gate went in, because they submitted bulletins
without assessing. That was fixture fallout, fixed centrally — a shared
`test/industrial-engineering/support/feasibility.js` that assesses **through the
real route**, plus `test/costing/helpers/authorityChain.js` — rather than by
writing `feasibility: { outcome: "FEASIBLE" }` into fixture documents. A
fabricated field would have kept passing after the rules changed underneath it.

The helper is "ensure assessed", not "assess once": it tolerates losing the
revision race, because the suite that proves exactly one of two simultaneous
submissions wins fires both through it at the same time.

The suites that prove the gate REFUSES an unassessed submission do not call it.

## The placeholder, and the dead code behind it

The old notice lived in `DevelopmentSections.js`, in a panel the page had
already stopped rendering — so the tab showed the workspace, but the component,
its words and the tests pinning them all survived. All of it is gone now:
`FeasibilityNotPublished`, `FEASIBILITY_MISSING`, `FEASIBILITY_MISSING_NOTE`,
and the page's unused `EngineeringFeasibility` import.

The two test blocks that asserted the placeholder were **inverted, not
deleted** — one of them, `the client must not name a feasibility endpoint`, was
the honest assertion while no endpoint existed and is now the opposite truth:
the client must name the read and the write, and must name no approve verb.

## Verified

| Suite | Result |
|---|---|
| `test/industrial-engineering/ie-feasibility.route.test.js` | **28/28 pass** |
| `components/industrialEngineering/development/ieFeasibility.test.mjs` | **15/15 pass** |
| `components/industrialEngineering/development/ieDevelopment.test.mjs` | **223/223 pass** |
| `components/industrialEngineering/development/developmentOverview.test.mjs` | **48/48 pass** |
| `test/industrial-engineering/ie-bulletin-version.route.test.js` | 57/58 |

The one backend failure is a pre-existing boundary assertion — that no IE
service imports a PPC model — tripped by `departmentStandards.service.js`,
which imports `PpcOrderTarget` for its `DEPARTMENTS`. Both that service and
that test are committed in HEAD and untouched by this work.

### The rest of the failures are not this work's, and that is measured

Claiming "pre-existing" is cheap, so it was checked against a real baseline: a
detached worktree at HEAD, where this work does not exist at all because none of
it is committed. The same command in both.

| | Suites failing | Tests failing | Tests passing | Total |
|---|---|---|---|---|
| HEAD, no feasibility work | 28 | 141 | 2993 | 3136 |
| With this work | 28 | 141 | 3048 | 3189 |

The sets of failing suites are **identical** — `comm` finds no suite failing in
one and not the other. This work therefore adds 53 passing tests and zero
failures. Nothing in the failure output mentions a feasibility code or the
assess helper (0 hits for `IE_FEASIBILITY`, 0 for `assessFeasible`); the failing
assertions belong to other lanes — `boardPolicy.financingGaps`, costing board
policy, and two stale `scripts/ie` directory-listing assertions that two
seeders already committed in HEAD had broken.

One failure WAS mine and is fixed: the suite proving that exactly one of two
simultaneous submissions wins fires both through the assess helper at once, and
read-then-write is not atomic. The helper now accepts losing that race, because
its promise is "somebody assessed this file", not "I assessed it".

## Live verification, on an isolated database

`scripts/demo/ie-feasibility-demo-server.js` is the showroom, built on the
pattern `ppc-demo-server.js` already established: an in-memory replica set, a
style and an engineering file created entirely through the IE routes, and the
REAL `server.js` spawned on a loopback port. The child gets no `.env` (it
prints `injecting env (0)`), and a Firebase credential for a project that does
not exist, so nothing it does can reach the shared cluster or the live
Firestore. `scripts/demo/ie-feasibility-demo-assessment.js` holds the
demonstration assessment and the only safe way to write it: through the file's
own PATCH route, never into a non-draft file, never over an assessment it did
not itself write.

Fourteen checks were run against it in a browser, as an editor, an approver and
a viewer. What they found, and what was fixed:

| Found live | Fix |
|---|---|
| Every chip in the area strip read "Concern / Concern" — the state's words were spread over the row and overwrote the area's own `label`, so a manager could see that five areas held something but not which five | `areaStrip` keeps `label` (the area) and `stateLabel`/`tone` (the state) apart; pinned by a test |
| The Summary card still said "No formal feasibility assessment is recorded" | The envelope carries `summariseFeasibility`, and the card reports the real verdict, the counts and both conditions with the desks that owe them |
| Review & Approval said nothing about a BLOCKED assessment until somebody pressed approve and was refused | The screen states the approval-stage condition from the same summary |
| The approver could not see the feasibility frozen into the version they were approving | `FrozenFeasibility` in the version detail, through the shared `versionFeasibilityWords` |
| The outcome radios announced `FEASIBLE_WITH_CONDITIONS` to assistive tech | `aria-label` carries the factory's words; the value still carries the server's |
| A viewer's refused write said "Changing the operation library needs…" | The feasibility write refuses in its own words |

Proven live: the saved assessment survives a full reload; a stale-revision save
is refused with "Somebody changed this assessment while you were editing it"
**and keeps what was typed**; a viewer gets a read-only screen (0 inputs, 0 edit
controls) and a 403 from the server; submission freezes the assessment into the
version; a later draft edit leaves that frozen copy untouched (`editable:
false`); a newer R&D pack reports "Needs reassessment"; and a BLOCKED assessment
submits but is refused at approval with `IE_FEASIBILITY_BLOCKED`. No horizontal
page overflow at 375 px.

## Atlas

**Not touched.** No read, no write. The demonstration lives only in the
in-memory database, which disappears when the showroom stops.
