# Fit tools

**Lane B · specification · 3 Oct 2026.**
The eight tools a person uses to judge a drape, and the rule that governs every
one of them: a screen may only say what the pipeline can prove.

Lane A owns the pipeline — DXF interpretation, meshing, seam mapping, the cloth
solver, collision, placement, the drape viewport. **Nothing in this document
changes Lane A's contract.** Where a tool needs an output that does not exist
yet, this document names the gap and
[`docs/tasks/fit-validation/lane-a-integration-checklist.md`](../../tasks/fit-validation/lane-a-integration-checklist.md)
turns it into a request.

### Which of these is authoritative

**This document is.** Under `AGENTS.md`, `docs/product/` and `docs/decisions/`
are durable sources of truth, and this is a product document: it states what the
fit tools mean and how they must behave.

The executable half — `components/rnd/fitTools/` in the frontend repo
(`evidence.js`, `metrics.js`, `schema.js`, `format.js`, `bands.js`) — **enforces**
that contract. It is the mechanism, not the meaning. A validator exists so the
rule below cannot be broken quietly; it does not get to decide what the rule is.

**A disagreement between the two is a defect in one of them, and it is never
resolved by reading only one.** Neither side silently overrides the other:

- Code that contradicts this document is a bug in the code, **unless** writing it
  revealed that the stated behaviour is wrong or impossible — in which case the
  finding is surfaced, this document is corrected first, and the code follows.
- A rule here that no validator enforces is a gap, not a decision already taken.
  It is written down as unenforced rather than assumed.

Either way the correction is made explicitly and recorded. Discovering a
disagreement and quietly conforming to whichever side is in front of you is the
failure mode this paragraph exists to prevent.

---

## 1. The problem this is solving

A fit screen is a persuasion machine. It colours a garment red and a person
believes something. The whole risk of this feature is that the belief is not
earned: that a colour came from a threshold nobody agreed, or from a number the
solver never measured, or from a drape that was still moving when the frames ran
out.

So the governing rule is not about accuracy. It is about **attribution**:

> Every number on screen can name what produced it, and every number that was
> not produced is absent with a reason rather than present as a zero.

A fit tool that cannot do that is better not shipped, because a wrong fit call
is paid for in sample yardage and in a buyer's confidence, and neither is
recovered by a later correction.

---

## 2. Four kinds of statement

Everything a fit screen shows is exactly one of these. The distinction is
enforced in `components/rnd/fitTools/evidence.js`, not merely described here.

| Class | What it is | May it colour the model? | Does it count as a finding? |
|---|---|---|---|
| **Solver evidence** | A quantity the solver computed from the cloth it simulated | Yes | Yes |
| **Derived interpretation** | Solver evidence compared against a threshold somebody chose | Yes, and it must name the rule | Yes |
| **Authored assessment** | A person's judgement, typed into the screen | **No** | Yes |
| **Warning** | A statement about the limits of the analysis | No | **No** |
| **Fixture** | Mock data in a harness | No | **No** |

### Why each boundary is where it is

**Solver vs derived.** "31.7%" is a measurement. "Tight" is an opinion about
25% being the edge. The second is a business decision that R&D owns and that
differs between a knit and a woven, so it travels with a band set id and a
version and is never hard-coded. When the bands change, yesterday's screens were
not wrong — they were judged by yesterday's rule, and the record says which.

**Derived vs authored.** A patternmaker writing "this armhole wants 5 mm more"
is the most valuable statement on the screen and the least verifiable. It is
kept, attributed, and never allowed to tint the geometry, because a colour reads
as measurement no matter whose opinion put it there.

**Warning vs finding.** "The body is capsules, not a scan" is true of every
reading on the screen. If it were counted among the findings it would inflate
the count of things wrong with the garment, when it is a thing wrong with the
analysis. They are listed under their own heading, below the findings, and the
count excludes them.

**Fixture.** Mock records carry `evidence: FIXTURE` and `countsAsFinding()`
returns false for them. This exists so that a screenshot of the preview harness
cannot be mistaken for a fitting, including by the person who took it.

---

## 3. The eight tools

### 3.1 Pressure / tightness heatmap — **not available**

Pressure on the body in kPa requires accumulated contact impulse at the body
surface. The XPBD solver resolves a penetration by moving the vertex
(`bodyCollision.resolve`) and keeps no impulse, so there is no force to
integrate. It is not a matter of exposing a field: the quantity is not computed.

The mode exists in the UI **and refuses**. It is listed precisely so that nobody
re-specifies it in three months, and so that "tightness" is not quietly
implemented as strain wearing the word *pressure*.

What would make it real is in the integration checklist as **LA-8**, and it is
the largest item there.

### 3.2 Strain and compression heatmap

**Available in the solver, not exposed by the pipeline.** `ClothSolver.strain()`
returns a per-vertex `Float32Array`; `runDrape` keeps only `maxPercent` and
`meanPercent`. The map needs the array, the mesh it belongs to, and one thing the
array does not currently carry: a mask of which vertices were actually measured.

The hazard is specific. `strain()` averages the incident edges that were long
enough to carry a ratio; a vertex whose every edge was excluded stays at `0`,
and zero strain and no reading are the same number. On screen that is a slack
armhole where there is no measurement at all. `fieldStats()` in `schema.js`
excludes a declared `missing` set for exactly this reason, and **LA-2** asks
Lane A for the mask.

Compression is the negative half of the same field and is drawn in the same
pass; it is not a second measurement. `geometryHealth` already counts
`compressedEdges` and `worstCompression` and does not report them upward
(**LA-5**).

**Unit:** percent of this cloth's own rest length. Never a force. 30% on a
jersey and 30% on a poplin are different situations, and the linear material
model understates resistance near a knit's limit — so the number is relative to
a material, and the material is named beside it.

### 3.3 Garment-to-body clearance

**Available in the solver, not exposed.** `ClothSolver.clearance()` returns a
per-vertex signed distance to the body SDF, or `null` when there is no body.
`runDrape` keeps only `tightestClearanceMm`.

**Unit:** millimetres, signed, positive away from the body. Valid −200…500.

Clearance is the most trustworthy thing on the screen and still rests on a body
made of capsules built from measurements rather than a scan. That caveat is
attached to every clearance reading as a warning, not mentioned once in a corner.

### 3.4 Collision and penetration findings

Penetration is the negative part of clearance, and it gets its own treatment
because it means something different.

The solver cannot distinguish a garment that is genuinely too small from a
collision it failed to resolve. Both produce cloth inside the body. So the
sentence says both:

> The cloth is 3.2 mm inside the body at the right armhole. That is either a
> garment too tight at this point or a limit of the simulation, and this fitting
> cannot tell you which.

This is `penetrationSentence()` in `format.js` and it is pinned by a test named
in capitals, because the tempting simplification — "too tight here" — is a
statement the pipeline is not entitled to make.

**Penetration is drawn as a hatch, not a colour.** It is a different kind of
fact from a measured distance and must not sit on the same continuous ramp.

`geometryHealth` already computes `penetratingVertices` and
`deepestPenetrationMm` per drape and discards them (**LA-5**).

### 3.5 Drag-line indicators — **not available**

A drag line is a direction: the axis along which the cloth is being pulled. It
needs the principal direction of the strain tensor per face. The solver carries
per-edge scalars and no tensor, and a scalar field cannot be differentiated into
a direction without inventing one.

The mode exists and refuses, for the same reason as pressure. **LA-9**.

### 3.6 Grab, pin, release, reset

The solver supports all four today: `solvePoint()` is a barycentric point
constraint used by both grab and pin, and `relaxRegion()` damps a sphere. None of
it is reachable from the UI, and none of it is persisted.

The rule that matters more than the mechanism:

> While cloth is held, pinned or relaxed, every metric over the affected region
> is **withheld**, not estimated.

A grab is a hand in the simulation. Strain under a hand is a reading of the hand.
`withheldUnder()` in `schema.js` returns the withheld metric list for a set of
manipulations, and the UI shows the refusal in place of the model rather than
greying a number that a screenshot would keep.

**Release** removes one constraint. **Reset** removes all of them and is always
offered, because a workspace with a forgotten pin in it produces a fitting nobody
can reproduce.

Manipulations are **temporary by default**. They are not part of the drape
record. If a person wants to keep one it becomes an authored finding describing
what they did, not a silent modification of the evidence.

### 3.7 Fit notes anchored to the garment or the body

A note is anchored by one of exactly two kinds:

- **`pattern-point`** — a piece reference and a coordinate in pattern
  millimetres. Survives re-meshing, re-draping, and a quality change.
- **`body-zone`** — one of the twelve zones in `BODY_ZONES`. Survives everything,
  including a different pattern.

**A vertex index is not an anchor**, and `findingProblems()` rejects one
explicitly. Vertex indices are a function of the mesher and the quality setting;
a note pinned to vertex 4,812 at draft quality points at a different part of the
garment at normal quality. That defect would be invisible, which is what makes
it worth a hard rejection rather than a convention.

Notes are authored assessments: attributed, counted, never colouring.

### 3.8 Comparison between two pattern revisions

Comparison is **by body zone, never by vertex**. Two revisions mesh differently —
different outlines, different vertex counts, different triangulation — so a
per-vertex difference is a picture of the re-meshing, not of the edit.

`comparability()` returns blockers and cautions, and the screen shows them
**above** the table:

| Kind | Case | Effect |
|---|---|---|
| Blocker | Different solver version | No comparison. The difference may be the solver's. |
| Blocker | Different body | No comparison. Nothing is held constant. |
| Blocker | Different fabric | No comparison. The garment changed in two ways at once. |
| Caution | Same pattern revision | Shown, flagged: this is run-to-run noise, not an edit. |
| Caution | Different quality | Shown, flagged: mesh density moves the numbers on its own. |
| Caution | Either drape unsettled | Shown, flagged: a preview is not a dimension. |

A zone present in one analysis and absent in the other produces a row with no
delta and a reason, not a delta against zero.

---

## 4. Units, ranges and missing data

Declared once, in `components/rnd/fitTools/metrics.js`.

| Metric | Unit | Valid range | State today |
|---|---|---|---|
| `strain` | percent of rest length | −100 … 400 | computed, not exposed |
| `clearance` | mm, signed, + away from body | −200 … 500 | computed, not exposed |
| `penetration` | mm of depth inside the body | 0 … 200 | computed, not exposed |
| `pressure` | kPa | — | **not produced** |
| `dragLine` | direction | — | **not produced** |

### Three availability states, three different sentences

A screen must never render the same empty message for different reasons:

- **Available** — the figure is here.
- **Computed but not exposed** — the solver works this out and the saved drape
  keeps only a summary. The fix is a pipeline change, and the sentence says so.
- **Not produced** — nothing computes this. The sentence says what would have to
  exist first.

`unavailableBecause()` returns a distinct sentence per state, and a test asserts
they are distinct.

### Missing data

- A value outside its declared range is **counted and reported**, never silently
  clamped and never discarded. A field with 400 out-of-range vertices is a
  finding about the solver.
- A vertex with no reading is in the `missing` set. It is excluded from
  statistics and drawn as absent — a distinct neutral treatment, never the colour
  of the lowest band.
- With no band set, numbers are shown **without a judgement** and the screen says
  R&D holds the bands. It does not fall back to a default threshold. A plausible
  default is worse than a refusal, because nobody checks it.

### One classifier

There is exactly one way to turn a measurement into a word:

```
classifyWithSet(bandSet, value, { purpose }) → classification
```

It takes a real `FitBandSet` ([schemas §8](./fit-analysis-schemas.md)).
`metricGuard()` in `metrics.js` is an **internal guard**, not a second
classifier — it answers only whether a value is answerable at all, takes no band
set, and can name no band.

### Dates

Every date in this toolset is a calendar date `YYYY-MM-DD` meaning midnight UTC,
or a full ISO-8601 instant with an explicit zone, and they are compared as parsed
instants rather than as text. [Schemas §9](./fit-analysis-schemas.md) states the
rule and why both halves of it matter.

### Confidence

Two flags travel with every analysis and both appear on screen:

- **`settled`** — whether the cloth stopped moving faster than the stage plan's
  threshold. `settled: false` means **preview**, and nothing in the product may
  describe an unsettled drape as a dimension.
- **`withheld`** — findings the drape produced and is not entitled to report,
  with the reason attached to each.

---

## 5. The flow

Seven steps. The preview harness at `/preview/fit-tools` walks all of them over
fixtures, and `fitToolsPreview.test.mjs` drives each one.

**1 · Choose a mode.** The list shows all five metrics. The two nothing produces
are disabled and say why, rather than being hidden — a hidden refusal gets
re-requested.

**2 · Read the model.** Colour by band, with the number drawn on each region as
well. Colour is never the only channel. The scale is bounded by the band set, not
auto-ranged per drape, because an auto-ranged scale makes every garment look like
it has a problem somewhere.

**3 · Click a region.** The panel answers four questions in order: what metric,
what value, which band produced that colour and where its edge is, and what this
metric cannot tell you.

**4 · Add a finding.** Typed against the clicked anchor, attributed, counted,
and visibly separate from the measurements.

**5 · Compare.** Cautions and blockers first, then the zone table, then the
statement that this is a zone comparison and why.

**6 · Clear or reset.** Always offered, including when nothing is held, so that
"is anything pinned?" is answerable by looking.

**7 · Leave.** Manipulations do not persist. The drape is unchanged by anything
done in this screen except the notes, which are stored beside it and never
inside it.

---

## 6. What is built, and what is not

**Built** (frontend repo, `components/rnd/fitTools/`, no Lane A file touched):
the modules above plus `bands.js` — the full `FitBandSet` schema, its validators,
selection by garment and date, and classification — with demo band sets in
`bandFixtures.mjs`, a Band Set editor, fixtures, and the preview routes
`/preview/fit-tools` and `/preview/fit-bands`.

**Not built:** anything wired to a real drape. The screen reads fixtures. It is
not in the drape viewport and must not be put there before the checklist is
satisfied — pointing these panels at the current `runDrape` output would produce
a screen with two aggregates on it and nine refusals, which teaches a viewer that
the tool is broken rather than that the pipeline is incomplete.
