# R&D fit simulation — the pattern is the garment, the drape is evidence

**Decided 1 Oct 2026.** Supersedes nothing; extends
`docs/decisions/` for the R&D 3D workspace.

## The provenance decision, recorded because it was asked for

`cad.zip` — the **Grav CAD desktop application** (`grav-cad-desktop`,
`appId: com.gravclothing.cad`) — is **first-party GRAV code**. The owner has
authorised reusing and adapting it inside the GRAV CMS.

Two things follow, and both are binding:

- It is **not open source.** The archive carries no `LICENSE`, `NOTICE` or
  `COPYING` file; the only licence files in it are Electron's and Chromium's,
  which belong to the bundled runtime. Nothing adapted from it may be
  redistributed, published, or described as available under an open licence.
- Code adapted from it **says so, in the file that adapted it**, naming the
  module it came from. Provenance that lives only in a commit message is
  provenance the next reader will not find.

## What was taken, and what was deliberately left

| From the archive | Here | Why |
|---|---|---|
| `simulation/ClothSolver.js` | `fit/solver/clothSolver.js` | XPBD small-steps is the right solver and it was already written to run on plain arrays with no renderer in the loop |
| `simulation/BodyCollision.js`, `SelfCollision.js`, `SettlePlan.js` | the same folder | SDF push-out with friction, vertex–triangle self-collision, and the A–E stage machine |
| `garment/PatternMeshBuilder.js` | `fit/triangulate.js` | the idea of forcing seam samples onto the boundary; the triangulator itself is written here |
| `workers/simulationWorker.js` | `fit/simulationWorker.js` | the message protocol |

**Left behind on purpose:** `garment/SeamGraph.js`, `GarmentAssembler.js`,
`collarSupply.js` and `analysis/FitAssistant.js`. Between them they carry 230+
references to `front`, `back`, `yoke`, `collar`, `sleeve`, `placket` and
`cuff`, thresholds tuned to *"Executive shirt M on its base body, 0.8" mesh"*,
and region names taken from one dataset including its typo (`"Coller"`). That
is a shirt, not a solver. Garment knowledge lives in
`fit/templates/`, and the solver below it does not know the word "sleeve".

## The unit boundary

**The internal simulation unit is the millimetre.** One number, one place, and
everything crossing into the solver goes through `fit/units.js`.

The archive worked in inches — `const G = 386.09 // in/s²`, a `upi`
(units-per-inch) divisor threaded through the mesh builder, tolerances printed
as `"`. That is a perfectly good choice for a shop that draws in inches and a
silent catastrophe for one that does not: a pattern read as millimetres when it
was drawn in inches is out by **25.4×**, and nothing about the shape on screen
reveals it.

Millimetres rather than inches because AAMA/ASTM DXF most often states
millimetres (`INSUNITS = 4`), because our `patternSet` already records
`unitInMm`, and because an integer-ish unit makes a tolerance like "0.5 mm"
something a pattern room can argue about.

Gravity is therefore `9806.65 mm/s²`. Every tolerance in the fidelity gate is
in millimetres. A pattern with no stated unit is **refused**, not assumed.

## Where the simulation runs

**In the browser, in a Worker.** Not on the server.

The server owns the *record* — which pattern revision, which body, which
fabric, which settings, and what happened — through the `RenderJob` built in
the previous slice. The browser owns the *computation*, because that is where
the garment is displayed and because a solver that runs next to its renderer
avoids shipping a megabyte of vertices per frame across a network.

So `simulationAdapter.service.js` gains an **`in-app`** adapter: it accepts the
job, marks it `simulating`, and the browser reports the outcome back through
the existing `recordRenderOutcome`. No Blender, no command line, no second
application — which was the point.

## What does not change

The 2D pattern remains the only manufacturing source of truth. Nothing in the
fit workspace writes to a pattern revision. A drape is **evidence**: it is
derived from exactly one immutable revision, it is read-only, and it goes stale
rather than silently re-pointing when a newer revision is approved.

## The geometry-fidelity gate

A believable garment with the wrong dimensions is worse than no garment,
because somebody will approve a sample against it. So before a drape is shown,
three comparisons must pass:

1. each source piece's outline perimeter against its generated mesh boundary;
2. each source seam's length against the seam actually sewn in simulation;
3. the pattern's stated scale against the scale the mesh was built at.

Over tolerance, the simulation **fails**. It does not warn.

## Scope

First template: **basic shirt / T-shirt / polo** — front, back, sleeves, and an
optional collar band. Trousers, jackets and everything else are later
templates against the same solver. Arbitrary imported DXF is **not** claimed to
assemble automatically; a pattern whose pieces cannot be given roles stops at
the mapping step and says so.
