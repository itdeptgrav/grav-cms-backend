# Interactive fit trials

**Lane B · product and technical contract · 2 Oct 2026.**
Grab, pin, relax, strain view, clearance view, baseline-versus-trial comparison,
and how all of it gets thrown away.

> **The governing rule.** The 2D pattern is the design. Interactive 3D actions are
> experiments and can **never** modify the 2D pattern. Not with a confirmation
> dialog, not with an admin override, not with a "apply to pattern" button that
> does not exist. A trial is a question somebody asked the cloth.

---

## 1. Why this needs a contract before it needs code

Pulling on a 3D garment is the most intuitive thing in this product and the easiest
place to destroy its credibility.

The failure is specific and it is not hypothetical. Somebody grabs the chest,
pulls, the cloth gives, the strain colour goes calm, and a screenshot of that
moment reaches a WhatsApp group with "chest is fine". The pattern was never
touched, which is exactly the problem: nothing in the picture says it was being
held open by a hand.

So the two things this document is actually for:

1. **A trial must be visibly a trial.** Baseline and trial are never the same
   surface, never the same findings, and never mixed.
2. **A trial must be reproducible or it must be gone.** Either it records enough
   to be re-run — revision, job, solver version, quality, body, fabric, and every
   action — or it is ephemeral and leaves nothing behind. There is no middle state
   where a half-remembered trial sits in a list looking authoritative.

---

## 2. Baseline drape versus trial state

| | **Baseline drape** | **Trial state** |
|---|---|---|
| What it is | the garment settled under gravity on the body, with nothing touched | the baseline plus one or more interactions |
| Where it comes from | a completed `RenderJob` with a stored `drape` | the baseline, replayed in the browser with the trial's actions applied |
| Who made it | the solver, from the pattern | a person, with their hands |
| Is it evidence about the pattern? | **yes** | **about the pattern under a stated intervention**, which is a different claim |
| Findings | the nine findings, per `fit-assistant-rules.md` | **trial observations only** — §6 |
| Default lifetime | stored with the job | **ephemeral** — §16 |

**One baseline per trial, always.** A trial is meaningless without the thing it
differs from, so a trial always names exactly one baseline `jobRef` and cannot be
re-pointed at another. This is the same immutability Lane A already applied to the
job itself: `patternRevisionId`, `patternRevisionRef`, `patternRevisionNumber` and
`inputs` are all `immutable: true`, with the reason recorded in the schema — *"a
job that could be re-pointed at another revision would make 'derived from revision
3' a claim rather than a fact."* A trial that could be re-pointed at another
baseline would make every sentence about it a claim rather than a fact.

**The baseline is never mutated.** Trial interactions run on a working copy of the
baseline's vertex positions in memory. The stored `drape.positions` buffer is read
once and never written back. Returning to baseline is therefore not an undo
operation — it is discarding the working copy (§12).

---

## 3. What is temporary and what may be saved

**Everything is temporary by default.** This is the single most important default
in the feature.

| Action | Default | Can it be saved? |
|---|---|---|
| Grab | temporary — gone on release and settle | only as part of a saved trial, and only as the action, never as a result |
| Pin | temporary — lives for the session | yes, as part of a saved trial |
| Relax | temporary — expires on its own (§9) | yes, as the action and its parameters |
| Camera, view mode, legend scale | temporary, per person | remembered as a UI preference, never part of a trial |
| Baseline drape | persisted by the job | not a trial |

**Saving requires one explicit action and a reason.** The button is **"Save this
trial as evidence"**, it is never the default, it is never triggered by navigation,
and it asks for a one-line note saying what the trial was for. A trial with no
stated question is a trial nobody can interpret in a month.

Closing the tab, navigating away, reloading, switching revision, switching body,
fabric, size or quality, or pressing Escape all **discard** the trial without a
confirmation prompt — because there is nothing of value to lose, and a prompt would
imply there was.

---

## 4. What a saved trial records

A saved trial is **a baseline reference plus an ordered list of actions**. It does
not store vertex positions.

That is a deliberate choice and it is the same one Lane A made for triangles. The
schema records: *"the triangulation is a pure function of the pattern, the quality
and the solver version, all three of which are recorded here, so it is cheaper to
rebuild than to keep."* A trial result is a pure function of the baseline, the
solver version, the quality and the actions. Storing the result instead of the
actions would produce a picture nobody could re-derive or check.

### 4.1 Provenance — all of it already exists

Everything item 3 of the brief asks a trial to be linked to is **already on the
job**, immutably. A trial needs **one** field, not copies:

| What must be pinned down | Where it already lives |
|---|---|
| exact pattern revision | `job.patternRevisionId` / `patternRevisionRef` / `patternRevisionNumber` — `immutable: true` |
| the RenderJob | `job.jobRef` — unique, `immutable: true` |
| solver version | `job.engine.version`, and `job.drape.solverVersion` |
| solver adapter | `job.engine.adapter` |
| quality | `job.drape.quality` |
| body | `job.inputs.avatar`, and `job.drape.body` |
| fabric profile | `job.inputs.fabrics`, and `job.drape.fabric { id, label, version }` |
| size | `job.inputs.renderSize` |
| seam mapping | `job.inputs.seamPairings` |

`job.inputs` is an immutable **copy**, not a reference, for the reason the schema
states: *"the revision's inputs may be edited afterwards; what this garment was
draped with cannot change retrospectively."*

**So a trial stores `baselineJobRef` and inherits all nine.** It must not copy them
— a copy can disagree with the job, and then a reader has two provenances and no
way to choose.

### 4.2 The trial record

| Field | Why |
|---|---|
| `trialRef` | unique, immutable |
| `baselineJobRef` | immutable. The one link that carries all provenance (§4.1) |
| `actions[]` | the ordered list, §4.3 |
| `note` | the one line the author had to write |
| `createdBy`, `createdAt` | a trial nobody is attributable for is not evidence |
| `solverVersionAtSave` | copied **here on purpose**, so reopening under a different solver can detect it (§13) |
| `qualityAtSave` | same reason |
| `observations[]` | what the author recorded as the point of the trial, §6 |

`solverVersionAtSave` and `qualityAtSave` are the **only** duplicated provenance,
and they are duplicated because their whole job is to be compared against the
current values and found different.

### 4.3 Actions are ordered and replayable

```
action := { seq, kind: grab | pin | relax, region, parameters, at }
```

`seq` is monotonic. Replay applies actions in `seq` order from the baseline. An
action list that does not replay to a settled state is a **failed replay**, which is
reported as such — never silently truncated to the actions that did work.

---

## 5. Stable anchoring

**A raw mesh-vertex index is not a stable anchor and is never stored.**

Meshing a piece inserts points along its outline, so a vertex index means something
different at every simulation quality. A pin stored as vertex 4,182 is, at High
quality, a pin somewhere else on the garment — and nothing on screen reveals it.

Lane A has already built the locator that avoids this, for seams. `anchorSchema`
locates a point on a piece by **an index into the piece's own outline** — the schema
calls it *"the authoritative locator for every kind except `fraction`"* — with four
kinds:

| `ANCHOR_KIND` | Locator | Stability |
|---|---|---|
| `turn-point` | `pointIndex` | exact; survives re-parse |
| `notch` | `pointIndex` | exact where a notch layer exists — ours publishes none |
| `placed` | `pointIndex` | exact; a person clicked it |
| `fraction` | `fraction` of perimeter | **moves** — the schema notes this is *"the reason W7 exists: move one point and every fraction after it means something else"* |

Trials reuse this unchanged for anything on a boundary.

### 5.1 Anchors live in pattern space

Every region is anchored in **the flat pattern's own coordinates**, which belong to
an immutable revision and therefore cannot move.

| Anchor kind | Shape | Use | Status |
|---|---|---|---|
| **Lane A's `anchorSchema`** | `{ pieceRef, kind, pointIndex \| fraction }` | anywhere on a piece's **boundary** — hems, necklines, seam edges | **exists**; reused unchanged |
| **`pattern-point`** | `{ pieceRef, x, y }` in the piece's own frame, millimetres | anywhere on a piece's **interior** | **new.** `ANCHOR_KIND` has no interior locator, because a seam never needs one |

The second row is a real addition and the reason is simple: a seam only ever runs
along a boundary, so `anchorSchema` never needed to name a point in the middle of a
panel. A grab, a pin and a relax region all land in the middle of a panel most of the
time. A `fraction` anchor must not be used for a trial region — it is the one kind
that moves (W7), and a pin that drifts when the pattern is re-parsed is worse than no
pin.

A **region** is an anchor plus a falloff:

```
region := { anchor, radiusMm, falloff: linear | smooth }
```

`radiusMm` is measured **in pattern space**, not on the draped surface and not in
screen pixels. The consequence is the one that matters: the same stored region
covers the same physical cloth at Draft and at High, because it is defined on the
cloth rather than on the mesh.

### 5.2 Resolution happens at load, every time

```
stored region  ──resolve──▶  { vertexIndex, weight }[]   (never stored)
```

At load, for the current mesh, each vertex is tested by the pattern-space distance
from its own preimage to the region's anchor, and weighted by the falloff. The
resulting vertex list is a derived, in-memory artefact with the same lifetime as
the mesh.

**This requires one thing from Lane A that does not exist yet.** Every mesh vertex
must carry its pattern-space preimage — the `pieceRef` and the `(x, y)` on that
piece's flat outline that it was generated from. The triangulator has this
information at the moment it creates each vertex and currently discards it. Without
it there is no stable anchoring, and this is the single hard data requirement of
this document.

### 5.3 When a region cannot be resolved

A region whose anchor falls outside every piece, or whose resolved vertex set is
empty, is **not quietly dropped**. The trial reports an **unresolvable region**,
names it, and the replay is a failed replay (§4.3). The common cause is a region
saved against a revision whose piece was later reshaped — which is staleness
(§13), and should have been caught before replay was attempted.

---

## 6. Trial observations are not findings

The nine findings in `fit-assistant-rules.md` are statements about **the pattern**.
Nothing measured while the cloth is being held, pinned or softened is a statement
about the pattern.

So, in a trial state:

| | |
|---|---|
| The nine findings | **suspended.** Not recomputed, not shown, not greyed-out versions of themselves |
| What is shown instead | **trial observations** — strain, clearance, and what the author writes down |
| Where the findings are | on the **baseline**, one click away, unchanged |

A trial observation is phrased as what it is: *"held open 18 mm at the left chest,
the cloth is no longer pulling at the armhole."* That is a useful sentence. It is
not "chest fits".

**Baseline and trial findings are never shown in the same panel, the same column, or
the same list.** The comparison view (§11) shows them side by side with a persistent
label on each, and no arithmetic is performed between them that is not explicitly a
difference.

---

## 7. Grab lifecycle

A grab is a **temporary kinematic constraint**: the region's vertices stop being
driven by the solver and start being driven by the pointer.

| Phase | What happens | What the user sees |
|---|---|---|
| **Select** | pointer down on the garment; the hit point is converted to a `pattern-point` anchor and resolved to a weighted vertex set | the affected patch highlights, with its radius visible, before anything moves |
| **Drag** | the region's vertices are moved with the pointer; their inverse mass is zero for the duration, so the solver treats them as held | the cloth follows; the rest of the garment responds live at reduced iteration count |
| **Release** | pointer up; the region's inverse mass is restored | the hand mark disappears |
| **Settle** | the solver runs to convergence from wherever the cloth is | a settling indicator, §10 |
| **Cancel** | Escape during drag, **or** pointer-up outside the viewport | the cloth returns to its pre-grab positions; no action is recorded |

**A grab's displacement is not a stored result.** What is stored, if the trial is
saved, is the action: the region, the displacement vector, and that it was released
and settled. The resulting positions are re-derived on replay.

**Grab is strictly transient in one respect worth stating:** on release and settle,
a knit will largely return to where it was, and a woven will largely stay where it
was pushed. That difference is real and is the interesting part of a grab. It is
not a bug, and the UI says which fabric behaviour it is showing.

---

## 8. Pin lifecycle

A pin is a **persistent positional constraint** that survives settling.

| Phase | What happens |
|---|---|
| **Placement** | pointer down places a pin at the hit point, anchored as a `pattern-point` |
| **Target position** | by default the pin's current world position — it holds cloth where it is. Dragging the pin sets an explicit target it pulls toward |
| **Visibility** | pins are **always drawn**, with a marker that is visible from any angle and is never hidden by cloth. A pin the user cannot see is the mechanism by which a trial gets mistaken for a baseline |
| **Effect on settling** | the pin's vertices are held at the target while every other vertex settles around them. The garment reaches a different equilibrium, which is the point |
| **Removal** | click the marker, or remove from the pin list. The cloth re-settles |
| **Strength** | a pin may be **hard** (held exactly) or **soft** (a spring with a stated stiffness). Default hard, because it is easier to reason about |

**Multiple pins are supported and are the normal case.** Pins are independent: each
resolves its own vertex set, and overlapping pins combine by taking the strongest
constraint per vertex rather than summing displacements, which would move cloth to
somewhere no pin asked for.

**A pinned garment is never described as fitting.** Any surface showing a pinned
state carries the pin count: *"3 pins — this garment is being held."*

---

## 9. Relax

Relax is the only action that changes the **material** rather than positions, so it
is the one with the most capacity to mislead.

| | |
|---|---|
| **What constraint changes** | the compliance of **stretch and shear** constraints in the region is temporarily raised — the cloth is made softer. Bending is **not** changed, and no positional constraint is added |
| **Why** | cloth that has settled into a locked, self-supporting configuration can sit at a false equilibrium. Softening it briefly lets it find a lower-energy state, which is often the honest answer |
| **Affected region** | the resolved region (§5), by falloff weight. Relax applies to the constraints whose **both** endpoints are in the region, so the boundary is not artificially softened |
| **Strength** | a multiplier on compliance, stated as a percentage, bounded. It cannot reach zero stiffness |
| **Duration** | a number of solver frames, after which compliance returns to the fabric's own values **and the cloth settles again** under the real material |
| **Reset** | immediate restoration of the fabric's compliance, and a re-settle |

**The honesty requirement, which is non-negotiable.** While a region is relaxed, the
cloth there is **not the fabric in the profile**. Therefore:

- **strain is withheld in the relaxed region** while relax is active, and marked as
  measured under a softened material for the frames it was;
- **no girth, clearance or dimensional observation taken in a relaxed region is
  reportable** as a property of the garment;
- the UI states it continuously: *"This area is softened — it is not behaving like
  the real fabric."*

The useful reading from a relax is **what happened after it ended**: if the cloth
settled somewhere materially different once the real material returned, the baseline
was at a false equilibrium and that is worth knowing. That after-state, under the
real fabric, is a legitimate observation.

---

## 10. While the solver is running

The solver runs in a browser Worker. The page stays responsive and the user is told
what is happening, in this order of preference:

1. **The cloth moving.** The honest progress indicator is the garment itself
   converging. Intermediate frames are shown.
2. **A settling state**, named plainly: *"Settling…"*, with the current largest
   per-frame movement in millimetres — the same `finalMoveMm` quantity Lane A
   already records. A number that is visibly falling is understood by everybody.
3. **Elapsed time**, after three seconds.

What is **not** shown: iteration counts, constraint counts, residuals, frame
numbers, or a percentage bar. A percentage is a lie here — convergence is not
linear and the solver does not know how many frames it needs.

**During settling:**

| | |
|---|---|
| Strain and clearance views | **shown, and marked unsettled.** The numbers move and the legend says they are provisional |
| Trial observations | **cannot be recorded** until settling completes. The record button is disabled, with the reason given |
| New actions | allowed. Grabbing mid-settle is normal use |
| **Cancel** | always available. It stops the solver and returns to **the last settled state**, not to a half-settled one, and no action is recorded |

A solve that does not converge within its frame budget stops and says so: *"The
cloth did not settle. The last movement was 4.1 mm per frame."* It does not present
an unsettled garment as settled, and no observation can be recorded from it.

---

## 11. Strain and clearance

### 11.1 Strain

**Definition.** Per-vertex, the mean extension of the stretch constraints touching
it, as a **percentage of rest length**, resolved along and across the grain
separately and reported as the larger of the two.

| | |
|---|---|
| Unit | **% extension**, where 0% is the cloth at its drawn size |
| Scale | sequential, 0% → the fabric's own stated stretch limit |
| Legend | always visible, always numeric, with the limit labelled |
| Available when | the fabric profile has stretch values **and** a stated load (`fabric-profile-contract.md` §2.2) |

**Honest limitations, printed with the view:**

- **It is a percentage of the fabric's own range, not a force.** 30% on a jersey and
  30% on a poplin are completely different situations.
- **The material model is linear**, so strain **understates** resistance near a
  knit's stretch limit — exactly where an undersized garment is
  (`fabric-profile-contract.md` §2.2).
- **Mesh density changes the smoothness, not the peaks.** A Draft mesh will miss a
  local concentration a High mesh finds.
- **A seam is not a material**, so strain is not reported across a seam line.

### 11.2 Clearance

**Definition.** Per-vertex, the signed distance from the cloth to the nearest point
on the body surface, in **millimetres**. Positive is a gap; negative means the cloth
is inside the body.

| | |
|---|---|
| Unit | **mm**, signed |
| Scale | **diverging**, centred on 0, so the sign change is the visual event |
| Legend | numeric, with the zero crossing labelled "touching" |
| Available when | the body has usable geometry (§11.4) |

**The limitation that matters most.** The in-app solver's body is a **capsule body
built from measurements** — the adapter says so itself. It is not a scan and not a
person. Clearance is therefore measured to an approximation of a torso, and:

- at the shoulder, armpit and neck — where capsules meet — the body surface is
  **least like a body**, and those are exactly where clearance findings are most
  wanted;
- clearance is **comparable between two fittings on the same body** and is not an
  absolute statement about a human being;
- `drape.tightestClearanceMm` is a real minimum over an approximate surface, and is
  labelled that way.

### 11.3 Negative clearance and penetration

Negative clearance has **two causes that the solver cannot distinguish**, and the
product says both:

| Cause | What it means |
|---|---|
| The garment is genuinely too tight | the cloth has nowhere to go, and collision has been pushed through |
| The solver failed there | a collision that was missed, a self-intersection, a region that never converged |

So penetration is presented as **"the cloth is inside the body here"**, with the
depth in millimetres and the honest sentence: *"This is either a garment too tight
at this point or a limit of the simulation, and this fitting cannot tell you
which."* It is **never** silently clamped to zero, and it is never coloured as
"very tight" on a continuous scale as though it were just the end of the range —
penetration gets its own distinct treatment so it cannot be read as a measurement.

Where penetration exceeds a stated depth, dimensional observations in that region
are **withheld**, because a girth measured through a body is not a girth.

### 11.4 Missing body and incomplete fabric data

| Missing | Clearance | Strain | What is said |
|---|---|---|---|
| No body measurements at all | **unavailable** | available | "There is no body for this fitting, so clearance cannot be shown." The garment still drapes under gravity |
| Body measurements but no landmarks | available as a **surface map**; **no per-finding clearance** | available | the map is shown, the findings that need landmarks stay unavailable (`fit-assistant-rules.md` §3.4) |
| Fabric with no stretch values | available | **unavailable** | "This fabric's stretch was never recorded, so strain cannot be shown." |
| Fabric stretch with no stated load | available | shown, **marked not comparable** | "Measured at an unstated load — do not compare this with another fabric." |
| Fabric estimated or a preset | available | shown, **marked estimated** | the whole trial is marked estimated (`fabric-profile-contract.md` §5) |
| Profile cannot be classified knit or woven | available | available | the girth observations are withheld (`fit-assistant-rules.md` §4.3) |

**An unavailable view is a named, explained empty state with a route to fixing it** —
not a blank panel, not a zeroed colour map, and never a plausible-looking map built
from defaults.

### 11.5 Colour

- **Never red/green as the only channel.** Roughly one in twelve men has a red-green
  deficiency and this is a garment industry.
- Strain: a single-hue sequential ramp, light to dark.
- Clearance: a two-hue diverging ramp with a clearly distinct zero.
- Penetration: a **pattern overlay**, not a colour step, so it is distinguishable
  without colour at all.
- Every scale has a numeric legend, and the numbers are the authority. The colour is
  a way of finding where to look.
- Scale bounds are **fixed per fabric and body**, not auto-ranged per frame — an
  auto-ranging scale makes every garment look equally strained.

---

## 12. Undo, redo and return to baseline

| Control | Scope |
|---|---|
| **Undo** | one action: the last pin placed, pin moved, pin removed, relax applied, or completed grab |
| **Redo** | re-applies an undone action, until a new action is taken |
| **Return to baseline** | **one click**, always available, no confirmation. Discards the working copy and shows the baseline drape |

**Undo boundaries, stated because they are where this gets confusing:**

- Undo **does not** cross a change of revision, body, fabric, size or quality. Those
  end the trial (§13), and the undo stack is emptied with it.
- Undo **does not** undo a *save*. A saved trial is a record; removing it is a
  separate, permissioned action with its own audit entry (§15).
- Undo **does not** step backwards through settling frames. Settling is not a user
  action; the unit of undo is the action, and undoing it re-settles.
- A grab that was cancelled was never an action, so there is nothing to undo.
- **Return to baseline is not an undo of everything** — it is a discard. After it,
  redo is empty, because the trial is gone rather than stepped back through.

---

## 13. Changing revision, body, fabric, size or quality — and staleness

All five are part of the baseline's identity. Four of them live inside
`job.inputs`, which Lane A made `immutable: true` precisely so that what a garment
was draped with cannot change retrospectively. The fifth, quality, is
`job.drape.quality`.

**Therefore: changing any of the five produces a different baseline, which means a
new job, which means the trial on the old baseline is over.**

| The user changes | What happens |
|---|---|
| **Pattern revision** | the trial **ends**. The new revision needs its own drape. The old trial, if saved, stays attached to the old revision and is marked **stale** |
| **Body** | the trial **ends**. New job |
| **Fabric** | the trial **ends**. New job |
| **Size** (`renderSize`) | the trial **ends**. New job |
| **Quality** (Draft → High) | the trial **ends**, and this is the one worth explaining to the user: a higher-quality mesh is a different mesh, and the trial's regions would resolve to different vertex sets. The **actions survive** and may be **offered for replay** on the new baseline, explicitly and as a new trial |

The quality case is the one that tempts a shortcut. Resolving the same stored
regions against a finer mesh is well-defined (§5.2) — that is the whole point of
pattern-space anchoring. What is **not** well-defined is calling the result the same
trial. The offer is *"Replay these 3 actions at High quality?"*, and the answer is a
**new** trial with its own `trialRef` and its own baseline.

### Staleness rules

A saved trial is **stale** when any of these is true:

| # | Condition |
|---|---|
| S1 | its baseline job's pattern revision is no longer the current one |
| S2 | `solverVersionAtSave` ≠ the current solver version |
| S3 | `qualityAtSave` ≠ the quality it is being viewed at |
| S4 | any of its regions is unresolvable against the current mesh (§5.3) |
| S5 | the fabric profile it names has been revised (`drape.fabric.version` differs) |

**What stale means, exactly:**

- the trial **remains visible as history**, with its note, its author, its date and
  its provenance intact — a stale trial is still a true record of a question
  somebody asked;
- it is **labelled stale wherever it appears**, including in lists and in any
  export;
- it **cannot be presented as current**, cannot be the source of an observation
  about today's pattern, and is excluded from any comparison against a current
  baseline;
- it is **never silently re-run** against a newer baseline, and never re-pointed.
  This is the same rule Lane A set for drapes — *"it goes stale rather than silently
  re-pointing when a newer revision is approved"* — applied one level up;
- re-running it is an explicit action producing a **new** trial.

S2 deserves a note. The adapter's comment says `SOLVER_VERSION` is *"bumped whenever
the browser solver changes in a way that moves vertices."* That is exactly the right
trigger: if vertices move, every stored observation about where cloth was is a
statement about a solver that no longer exists.

---

## 14. Permissions and audit

| Action | Who |
|---|---|
| Open a fitting, change views, read findings | anyone who may read the style |
| Run a trial — grab, pin, relax | anyone who may read the style. **Trials change nothing**, so gating them would only push people to screenshots |
| **Save a trial as evidence** | whoever may contribute to R&D on the style |
| Delete a saved trial | the author, or an R&D lead |
| Modify the 2D pattern | **nobody, through this surface, ever** |

**Audit.** Saving, deleting and replaying a trial each write an entry: who, when,
which trial, which baseline, and the note. Running an unsaved trial writes nothing,
because nothing happened.

**The permission that is not a permission.** There is no role that can apply a trial
to a pattern, because the operation does not exist. This is stated in the
permissions table on purpose: a reader looking for it should find an explicit "no"
rather than an absence they might take for an oversight.

---

## 15. Ephemeral by default

Stated once more, plainly, because it is the feature's safety property:

> A trial exists in one browser tab's memory and nowhere else, until somebody
> presses **"Save this trial as evidence"** and writes a line saying why.

No autosave. No draft trials. No "recently viewed" trial state restored on reload.
No trial in a URL that could be shared as though it were a result.

A **saved** trial is durable, attributable and re-runnable — and still not a
finding about the pattern (§6).

---

## 16. Why a saved trial is evidence and not a publication

Lane A already drew this line for drapes, and the reasoning transfers exactly. From
the schema:

> *A garment-model publication is a CLO export: a file somebody made, with a source
> project behind it, that a sample can be approved against. A drape is this system's
> own reading of a 2D pattern — derived, read-only, reproducible from the revision
> and the solver version. Filing one as a publication would put it in the same list
> as approvable models and somebody would approve it.*

A trial is one step further from a publication than a drape is: it is a drape **plus
a human intervention**. So:

| A saved trial is | A saved trial is not |
|---|---|
| a record that somebody asked a question of the cloth | a pattern revision |
| re-runnable from its baseline and actions | a model publication |
| attributable and dated | something a sample can be approved against |
| a legitimate attachment to a discussion | a version of the garment |

**Therefore, enforced:**

- a trial **cannot be approved**. There is no approve action on a trial, and it never
  appears in any list of approvable things;
- a trial is **never** the source of a technical pack, an IE projection, or anything
  a factory receives;
- a trial **cannot become** a pattern revision, a garment model, or a publication,
  by any route including export and re-import;
- after every action in a trial, the pattern revision is **byte-identical**. Nothing
  in the trial path holds a writable reference to it.

---

## 17. Performance, laptop and mobile

The solver runs on the reader's machine, so the honest position is that capability
differs and the product says what it is doing rather than pretending it is uniform.

| | Laptop / desktop | Mobile |
|---|---|---|
| Baseline drape | Draft and High | **Draft only**, stated plainly |
| Grab | live, at reduced iterations during drag | live if the device sustains it; otherwise **drag-then-settle**, where the cloth follows a simplified preview and solves on release |
| Pin, relax | yes | yes |
| Strain, clearance views | yes | yes — they are a shader over existing positions, which is cheap |
| Saving a trial | yes | yes |

**Expected behaviour, not promised numbers.** A Draft tee is tens of thousands of
constraints and settles in a few seconds on a current laptop; High is several times
that. Rather than printing a target this document cannot guarantee across devices,
the requirement is:

- **the page never blocks.** The solver is in a Worker and the UI stays interactive,
  including Cancel.
- **capability is detected, not assumed**, and the chosen mode is **visible**:
  *"Draft quality on this device."*
- **a device that cannot sustain live grab says so** and offers drag-then-settle,
  rather than presenting a stuttering 4fps drag as the product working.
- **the 100KB drape positions buffer** Lane A records is the transfer cost of
  opening a fitting, which is acceptable on mobile data; trials add nothing to it,
  because they store actions rather than positions (§4).

---

## 18. Plain-language wording

Everything in `plain-language-glossary.md` §7 still applies. These are the
trial-specific additions.

| Not this | This |
|---|---|
| "Apply kinematic constraint" | "Hold the cloth here" |
| "Constraint compliance increased 40% in selection" | "This area is softened" |
| "Solver converged, residual 0.3mm/frame" | "Settled" |
| "Solver did not converge" | "The cloth didn't settle" |
| "Penetration depth 7mm" | "The cloth is 7 mm inside the body here" |
| "Strain 0.34" | "Stretched 34% — this fabric's limit is 40%" |
| "Trial state diverges from baseline" | "This is a trial. The pattern hasn't changed." |
| "Stale trial" | "From an older pattern — kept as history" |
| "Vertex set unresolvable" | "This pin was placed on part of the pattern that has since changed" |

### The sentences that must be on screen

| Where | What it says |
|---|---|
| Any trial state | **"Trial — the pattern has not changed."** Persistent, not a toast |
| A pinned state | **"3 pins — this garment is being held."** |
| A relaxed region | **"Softened — not behaving like the real fabric."** |
| Mid-settle | **"Settling… largest movement 2.4 mm."** |
| Penetration present | **"The cloth is inside the body here — either too tight, or a limit of the simulation."** |
| A stale trial | **"From pattern revision 3. The current revision is 5."** |
| No neck finish | **"This pattern has no neck finish. The neck opening is unfinished."** (`garment-template-contract.md` §6.4) |

### Wording that is forbidden

- **"Apply to pattern"**, "push to pattern", "save as revision", or any phrasing
  implying the trial can reach the design. The operation does not exist and the words
  must not either.
- **"Fixed"**, "corrected", "resolved" about anything a trial did. A trial holds
  cloth; it fixes nothing.
- **"Fits"** on any pinned, grabbed or relaxed state.
- **"Approved"** anywhere near a trial (`plain-language-glossary.md` §9).
- A **percentage progress bar** for settling (§10).
