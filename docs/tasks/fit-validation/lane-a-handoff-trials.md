# Lane B → Lane A handoff · interactive fit trials

**2 Oct 2026.** Documentation only. No application code, schema, route or test was
touched. Companion to `lane-a-handoff.md`, which covers the fitting itself.

Specs: `docs/product/rnd-fit/interactive-fit-trials.md` and
`docs/product/rnd-fit/interactive-fit-trial-validation.md`.

---

## 1. The good news first

**Almost all the provenance already exists**, and Lane B is not asking for it again.

`renderJobSchema` already freezes `patternRevisionId`, `patternRevisionRef`,
`patternRevisionNumber` and the whole `inputs` copy as `immutable: true`, and
`drape` already records `solverVersion`, `quality`, `fabric { id, label, version }`,
`unit` and `body`. Between them that is every one of the nine things a trial must be
pinned to.

**So a trial needs one link, not nine copies:** `baselineJobRef`. A copy can disagree
with the job, and then a reader has two provenances and no way to choose.

The two deliberate exceptions are `solverVersionAtSave` and `qualityAtSave`, which
are duplicated **because their whole job is to be compared against the current values
and found different** (staleness S2, S3).

Lane A has also **already built the locator** trials need for boundaries.
`anchorSchema` / `ANCHOR_KIND` locates a point by an index into the piece's own
outline — *"the authoritative locator for every kind except `fraction`"* — and trials
reuse it unchanged. Lane B is extending it in exactly one place: an **interior**
locator, which a seam never needed.

---

## 2. Required data contracts

### 2.1 The one hard requirement

**Every mesh vertex must carry its pattern-space preimage** — the `pieceRef` and the
`(x, y)` on that piece's flat outline it was generated from.

The triangulator has this at the moment it creates each vertex and currently discards
it. Without it there is no stable anchoring for grab, pin or relax, and the feature
cannot be built honestly. This is the single blocking item.

It need not be persisted with the drape: like the triangulation, it is a pure function
of the pattern, the quality and the solver version, so it can be rebuilt. It must be
**available in memory** whenever a region is resolved.

### 2.2 Anchors (not vertex indices, ever)

```
anchor := anchorSchema                   // boundary — EXISTS, reused unchanged
        | { pieceRef, x, y }             // interior, piece-local mm — NEW
region := { anchor, radiusMm, falloff: linear|smooth }
```

The interior kind is the only addition. `ANCHOR_KIND` has `turn-point`, `notch`,
`placed` and `fraction`, all of which locate a point on a **boundary**, because a seam
never runs through the middle of a panel. A grab, pin or relax region usually does.

**`fraction` must not be used for a trial region.** It is the one kind that moves —
the schema says so itself, *"move one point and every fraction after it means
something else"* — and a pin that drifts on re-parse is worse than no pin.

`radiusMm` is pattern-space, not screen pixels and not draped-surface distance. That
is what makes a stored region cover the same cloth at Draft and at High.

### 2.3 The trial record

```
trial := {
  trialRef,                    // unique, immutable
  baselineJobRef,              // immutable — carries all provenance
  actions: [{ seq, kind: grab|pin|relax, region, parameters, at }],
  note,                        // required; the question the trial asked
  createdBy, createdAt,
  solverVersionAtSave,         // for staleness detection only
  qualityAtSave,               // same
  observations: [],
}
```

**Actions, not positions.** A trial result is a pure function of baseline + solver
version + quality + actions — the same reasoning Lane A used for not storing
triangles.

### 2.4 Two small gaps worth naming

| Gap | Where | Why it matters |
|---|---|---|
| `drape.quality` is a free string | `PatternRevision.js` | IT-08 switches Draft → High and staleness rule S3 compares qualities. Unnamed qualities cannot be compared reliably |
| No stated load on fabric stretch | `fabricSchema` | strain is a percentage of a range; without the load, two fabrics are not comparable (IT-13a). Already listed in `fabric-profile-contract.md` §8 |

Neither blocks a first implementation.

---

## 3. Implementation boundaries

| Boundary | Acceptance |
|---|---|
| **No write path to a pattern revision** from any trial code. Not guarded — absent | IT-10 |
| **No approve action on a trial**, and a trial in no approvable list | IT-11, IT-12 |
| **Baseline `drape.positions` is read-only.** Trials run on an in-memory working copy | IT-02 |
| **No autosave, no draft trials, no trial state in a URL.** Ephemeral by default | IT-06, IT-21 |
| **No trial whose baseline is another trial.** One baseline job, always | IT-22 |
| **No vertex index stored anywhere** in a trial | IT-08, IT-19 |
| **Solver stays in the Worker.** Cancel responsive throughout settling | IT-05 |

The viewport requirement that is easy to miss: **"Trial — the pattern has not
changed."** must render *inside the 3D canvas*, because the realistic threat is a
cropped screenshot in a group chat (IT-20). A toast or a side panel does not survive
the crop.

---

## 4. Compatibility with the current solver

Checked against `inAppSolver.adapter.js`, `garmentRender.service.js` and
`PatternRevision.js` as of commit `46c84b1e` **plus Lane A's uncommitted working
tree**, which is where the run / anchor / alignment model currently lives. **No
incompatibility found.** No trial code exists yet, so there is nothing to collide
with.

**A note on what Lane A has already built.** The working tree now implements
`anchorSchema`, `boundaryRunSchema` with required start and end anchors,
`piecePlanSchema` with `grainVector` and `boundaryConfirmed`, and `SEAM_ALIGNMENT`
with the comment *"the single most important field in this file"*. That is the revised
fitting contract, in code. Trials build on it rather than beside it, and the single
addition they need is the interior anchor in §2.2. Because that model is uncommitted,
the citations in these two specs are to work in progress and should be re-checked if
Lane A changes it before landing.

Five further notes:

1. **The capsule body is the honest limit on clearance.** The adapter describes itself
   as *"a fast approximate cloth solve on a capsule body built from measurements"*.
   Clearance is therefore measured to an approximation of a torso, least accurate at
   the shoulder, armpit and neck — exactly where it is most wanted. The spec says this
   on the view rather than hiding it (§11.2, IT-15).
2. **`SOLVER_VERSION` bumping on "changes that move vertices" is exactly the right
   staleness trigger** (S2). If vertices move, every stored observation about where
   cloth was describes a solver that no longer exists.
3. **The job lifecycle already handles the closed tab.** A job left in `simulating`
   that never reports is *"visible, and clearable"* by Lane A's design. Trials need
   nothing added for IT-06 — an unsaved trial simply has nothing to leave behind.
4. **`finalMoveMm` is the settling indicator.** It is already recorded, and a falling
   millimetre figure is the one progress signal that is not a lie (§10). No percentage
   bar.

5. **The vertex preimage does not exist yet.** Nothing in the current schema or
   solver records which pattern point a mesh vertex came from — grepped for, and
   absent. §2.1 is therefore a genuine blocking requirement rather than a
   restatement of something already there.

One behaviour Lane A will need to add that the solver does not have today: **relax**
requires temporarily scaling the compliance of stretch and shear constraints in a
subset of the mesh, and restoring them. Bending must not be touched. If per-constraint
compliance cannot be varied regionally in the current solver, relax is the one action
of the three that may need deferring — and it should be deferred rather than
approximated by adding positional constraints, which would be a different thing
wearing its name.

---

## 5. Unresolved decisions

For R&D or Lane A, not for Lane B to settle alone:

1. **Named quality levels.** "Draft" and "High" are used throughout both specs. Are
   those the two, and are they the stored strings? S3 and IT-08 need a definite answer.
2. **Relax bounds.** Maximum compliance multiplier and maximum duration. The spec says
   bounded and non-zero; the numbers are a tuning decision after the first real relax.
3. **Soft pins.** Specified as available with a stated stiffness, default hard. Worth
   shipping hard-only first and adding soft when somebody asks.
4. **Observation vocabulary.** A trial observation is currently free text with a
   stated region. Whether it should become structured is a question to answer after
   watching people use it, not before.
5. **Keyboard operation of grab and pin.** Not specified. `§11.5` covers colour but the
   pack does not cover keyboard-only use, and it should (noted in the validation pack
   §8).
6. **Trial retention.** Saved trials accumulate. Nobody has said whether they expire,
   and the fitting record is embedded in a document with a 16 MB ceiling — worth a
   decision before it is a problem.

---

## 6. Product decision recorded this round

**A missing neck finish does not block the complete garment drape.**

Applied as the smallest correction to the existing durable contracts:

| File | Change |
|---|---|
| `garment-template-contract.md` | R3 excepts the neck finish; **new R12** for a neck-finish piece that exists but is unmapped or unconfirmed; **new §6.4** states the decision in full |
| `fit-assistant-rules.md` | §3.4 notes collar/neck additionally needs a finish to exist; §5.4 withholds collar circumference, neck clearance and collar roll when there is none |
| `validation-matrix.md` | **VM-19** (Partial, absent finish) and **VM-20** (Refused, present but unmapped) — the two halves of the decision. Counts updated: 20 cases, 6 + 8 + 1 + 5 |

The rest of the garment does not depend on the neck finish, so refusing the whole
drape threw away every finding about the body and the sleeves to protect one finding
about a collar that is not there. The other half matters as much: a piece that exists
and is half-joined is an unfinished **mapping**, and draping around it would silently
exclude cloth the pattern-maker drew.

Nothing is invented in either case — no band, no collar, no facing, and the neck
opening is never closed to make a number available.
