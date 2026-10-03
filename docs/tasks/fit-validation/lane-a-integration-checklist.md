# Lane A integration checklist — fit tools

**Lane B · 3 Oct 2026.**
Eleven items. Each names an output the fit tools need, what exists today, and
what the tool does in the meantime.

**This changes nothing.** It is a request list written against Lane A's current
code, read on 3 Oct 2026 at frontend `076f6448`. No Lane A file was edited to
produce it. Where an item says "already computed", that is a statement about
code that exists and discards a value, not a complaint.

Specification: [`docs/product/rnd-fit/fit-tools.md`](../../product/rnd-fit/fit-tools.md).
Shapes: [`docs/product/rnd-fit/fit-analysis-schemas.md`](../../product/rnd-fit/fit-analysis-schemas.md).

---

## What exists today

`runDrape()` (`components/rnd/fit/run.js`) returns, among other things:

```
strain: { maxPercent, meanPercent, measuredEdges,
          edgesTooShortToMeasure, shortestRestMm, minRestForStrainMm }
tightestClearanceMm, placementClearanceMm
positions, tris, pieces[], body, vertexCount
geometryIdentity, solverVersion, quality, fabric{id,label,version}
patternRevisionRef, patternRevisionNumber
settled, settledBelowMm, convergence, finalMoveMm, finalWorstMoveMm
seamClosure, mismatches, unsewn, geometry (geometryHealth)
sewingLineSource, seamAllowanceMm, authoritative, withheld, outcome
```

`reportable()` in `drapeRunner.js` is what reaches the server, and it is a
**subset** — `geometry`, `mismatches`, `unsewn` and `placementClearanceMm` do not
survive the trip.

`ClothSolver` has more than the pipeline keeps: `strain(minRestMm)` and
`clearance()` both return per-vertex `Float32Array`s, `solvePoint()` is a
barycentric point constraint, `relaxRegion()` damps a sphere, and
`measureSeamGaps()` and `seamResidual()` both exist.

**So most of this checklist is about plumbing, not about new physics.** Two items
are not.

---

## The items

### LA-1 · The mesh travels with the analysis — **blocker for everything**

A scalar field is meaningless without the mesh it indexes. Needed beside any
field: `positions`, `tris`, `vertexCount`, the `pieces` table, and
`geometryIdentity`.

All five exist and all five are already in `reportable()`. The requirement is
that a fit analysis is **refused** when `geometryIdentity` does not match the
mesh it is being drawn over — `fieldMatchesMesh()` is the check, and it needs the
identity to be present on both sides rather than assumed equal.

*Status: available. Needs a guarantee, not a change.*

---

### LA-2 · Per-vertex strain, with a measured mask — **blocker for 3.2**

`ClothSolver.strain(minRestMm)` already returns the array. Two requests:

1. **Expose it.** Today only `maxPercent` and `meanPercent` survive.
2. **Add the mask.** `strain()` averages the incident edges that were long
   enough; a vertex whose every edge was excluded stays at `0`. Zero strain and
   no measurement are then the same number, and on a heatmap that is a slack
   green armhole where nothing was measured at all.

The mask is cheap — the function already builds a `count` array, and the vertices
to report are those with `count[i] === 0`.

Shape: `{ metric: "strain", domain: "vertex", values: Float32Array,
missing: number[], count }`. Values as a ratio or as a percent, either way, as
long as which one is stated.

*Status: computed, not exposed. Mask does not exist.*

---

### LA-3 · Per-vertex clearance — **blocker for 3.3 and 3.4**

`ClothSolver.clearance()` already returns the signed per-vertex array, or `null`
when there is no body. Only `tightestClearanceMm` is kept.

Expose the array and the `null` case distinctly: no body is a different fact
from a body that nothing came close to.

*Status: computed, not exposed.*

---

### LA-4 · A vertex-to-body-zone map — **blocker for the comparison**

Comparison between revisions is by zone, and nothing today maps a drape vertex
to one of the twelve zones in `BODY_ZONES`.

`bodyFromMeasurements()` already computes the landmarks this needs —
`yShoulder = 0.82h`, `yChest = 0.74h`, `yWaist = 0.62h`, `yHip = 0.52h`, plus the
arm capsules and `halfShoulder`. A zone assignment is a classification of each
vertex against those, and it belongs with the body because that is where the
landmarks live.

Output: `Uint8Array` of zone ordinals, plus the id list, plus the zones the body
could not place because it lacked the landmark.

*Status: does not exist. The inputs do.*

---

### LA-5 · `geometryHealth` reaches the server — **blocker for 3.4**

`geometryHealth()` already computes, per drape:

```
penetratingVertices, deepestPenetrationMm, compressedEdges, worstCompression,
seams, findings, ok
```

`run.js` puts it on the result as `geometry`. `reportable()` does not include it,
so it is computed on every render and thrown away.

These four numbers are most of the penetration and compression tooling. Adding
the key to `reportable()` is a one-line change on Lane A's side and the single
highest ratio of value to work in this list.

*Status: computed, discarded at the boundary.*

---

### LA-6 · A body identity — **blocker for the comparison**

`comparability()` refuses to compare two analyses with different bodies, and
cannot tell: the body is built by `bodyFromMeasurements()` from six measurements
with defaults for the absent ones, and carries no id.

Needed: a stable `bodyId` — a hash of the measurement set actually used,
including which values were defaulted, plus the builder's own version. Without
it, a comparison silently includes a body change, and a body change moves every
clearance number on the screen.

Related: the measurement defaults should be reportable. A body built from two
real measurements and four defaults is a different kind of evidence from one
built from six, and nothing currently says which happened.

*Status: does not exist.*

---

### LA-7 · A pattern-point ⇄ mesh mapping — **blocker for 3.6 and 3.7**

Every anchor in Lane B's schemas is a point in **pattern millimetres** on a named
piece, because that is the one locator that survives a re-mesh. The solver works
in vertex indices and barycentric triples.

Needed, both directions:

- `(pieceRef, x, y) → { ids: [a,b,c], w: [wa,wb,wc] }` — so a stored pin or note
  can be re-applied to a freshly meshed drape.
- `vertexIndex → (pieceRef, x, y)` — so a click on the model becomes a storable
  anchor.

The `pieces` table already carries `base` and `vertexCount`, which is the start of
the first direction but not the barycentric part.

*Status: does not exist.*

---

### LA-8 · Pressure — **not plumbing**

Pressure in kPa needs accumulated contact impulse at the body surface.
`bodyCollision.resolve()` corrects a penetration by moving the vertex and keeps
no impulse, so there is no force to integrate over an area.

What it would take: accumulate per-vertex correction impulse per substep, divide
by the vertex's share of surface area and by the timestep, and expose it as a
field. That is a change to the solver's inner loop, with a performance cost, and
it should not be undertaken because a screen has a tab for it.

**Until then the mode refuses.** `metrics.js` marks it `NOT_PRODUCED` and a test
asserts that nothing may quietly promote it.

*Status: not produced. Deliberately deferred.*

---

### LA-9 · Drag lines — **not plumbing**

A drag line is the principal direction of the strain tensor per face. The solver
carries per-edge scalars; a scalar field has no direction to extract.

What it would take: a per-face deformation gradient from the rest triangle to the
drawn triangle, then its principal axis. Tractable, and a larger piece of work
than it sounds, because the rest triangle has to survive the same re-meshing
every other anchor does.

**Until then the mode refuses**, same as LA-8.

*Status: not produced. Deliberately deferred.*

---

### LA-10 · Band sets, as data

Nothing in the product holds fit thresholds today. They belong in the database
beside the garment templates, keyed by category, fit and fabric behaviour, with a
version — the same arrangement the C1/C2 scoring bands already use in Firestore,
and for the same reason: they change without a deploy and have to be quotable
after the fact.

Until a band set exists, `classify()` returns `unclassified` and the screen shows
numbers **without a judgement**. It does not fall back to a default threshold.

*Status: does not exist. Not a Lane A item — this one is Lane B's, listed here so
the dependency is visible.*

---

### LA-11 · Manipulation reaches the UI

`solvePoint()` and `relaxRegion()` both work and neither is reachable. What the
fit tools need beyond the mechanism:

- the **affected region** of each active manipulation, so metrics over it can be
  withheld rather than estimated;
- a **release** for one and a **reset** for all;
- a guarantee that a manipulation is not written into the drape record.

*Status: solver supports it. Nothing surfaces it.*

---

## Order

| Priority | Items | Gives |
|---|---|---|
| 1 | LA-5 | Penetration and compression, for the cost of a key in an object |
| 2 | LA-2, LA-3 | The two heatmaps that matter |
| 3 | LA-4, LA-6 | Revision comparison |
| 4 | LA-7, LA-11 | Notes and manipulation |
| 5 | LA-8, LA-9 | Pressure and drag lines, if ever |

LA-1 and LA-10 run alongside; neither blocks the others.

---

## Until then

The fit tools are built, tested and **not wired to anything**. They live in
`components/rnd/fitTools/` with a preview at `/preview/fit-tools`, read fixtures,
and are not imported by the drape viewport.

That is the right state. Pointing these panels at today's `runDrape` output would
produce a screen with two aggregates and nine refusals on it, which teaches a
viewer that the tool is broken rather than that the pipeline is unfinished.
