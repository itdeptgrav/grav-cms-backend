# Latest implementation — measurements that follow the cloth, and a way out of the close-up

1 Oct 2026. **Committed on `NEW_CMS_BRANCH` in both repositories.** Live demo
data was written to the dev Atlas database (one further draft publication of
the sweater and five named measurements); nothing else.

## 1 · The measurement that follows the garment

A neckline measured as a line through space is a CHORD. It cuts across the neck
opening, and it always reads SHORT — the dangerous direction, because a pattern
cut to it does not fit. So there are now three separate modes, separately named,
and nothing converts one into another:

| Mode | What it measures |
|---|---|
| **Straight distance** | the direct line between two points. Useful for widths and reference checks; it does not follow the garment, and the label says so |
| **Surface distance** | two points, the shortest route **across** the cloth between them |
| **Guided curved path** | points placed along a seam, armhole, neckline or hem, each leg following the surface |

### The algorithm

`components/rnd/workspace3d/surfacePath.js`, three steps:

1. **Weld.** A glTF export splits vertices wherever a normal or a UV changes,
   so two triangles that touch on screen share no index at all. Welding by
   quantised position is what makes the mesh connected — without it, every pair
   of points reads as a different piece of cloth and the whole feature refuses.
2. **Corridor.** A\* over triangles through shared edges, from the triangle
   under the first point to the one under the second. The shared edges it
   crosses are the band of fabric the path must stay inside.
3. **Pull it taut.** One point per portal, started at the edge's midpoint, then
   relaxed: each is repeatedly moved to the spot **on its own edge** that
   minimises the distance to its two neighbours. A string drawn tight through a
   row of rings.

Every point it produces lies on a triangle edge, and consecutive points lie in
one triangle — so each segment is flat against the surface and the whole
polyline is on the garment.

**An error worth recording:** the first version projected the MIDPOINT of the
two neighbours onto the edge. That minimises a different quantity and is only
the same answer when the two legs are equal, so the string settled a few per
cent slack and every curve read long. Minimising |P−prev| + |P−next| properly
(ternary search, the function is convex along the edge) fixed it.

### Accuracy, and what it is not

- **Not a proven global geodesic.** The corridor comes from A\* over centroids;
  a genuinely shorter route round the other side of a sleeve would need an exact
  method (MMP, Chen–Han).
- **Bounded by the tessellation, and in the direction that matters.** A mesh is
  *inscribed* in the shape it stands for, so a path over its flat faces cuts
  inside the true curve and reads **short**. A 48-segment half-circle measures
  0.993 of the arc. My first draft of this caveat said "reads slightly long" —
  the test caught it, and short is the dangerous direction.
- Against a half-cylinder of known arc length (π) and chord (2), the method
  reads within **4%** of the arc; a quarter arc within **5%**; a flat run agrees
  with the straight distance to within 0.03.
- **Disconnected meshes are refused**, never answered with the gap:
  *"These points are not connected on the garment surface."*

### Where the arithmetic happens

The browser picks the points and walks the mesh; the **server recomputes the
value from the stored route**. A stored number that nothing can recompute is a
claim rather than a measurement. A surface measurement sent without its route
is **refused** — never quietly straightened into a chord under a surface
measurement's name.

## 2 · Saving and naming

Completing a placement no longer saves anything. It opens a panel, and the
**name is required** — the suggested default (`Measurement 4`) is refused
unchanged, by the server as well as the screen, because a rail of
"Measurement 1…9" is unreadable three weeks later.

Stored per measurement: publication and model number, id and ref, type, name,
category, every placed point's node reference and local position, the surface
route, raw value, converted value, unit, scale basis, linked tech-pack/POM item,
intended size, tolerance, note, status, creator, timestamps, revision and the
full event history.

Lifecycle: **draft → reviewed → accepted**, anything may be **withdrawn**, and a
withdrawn one may return to draft. A draft's points may be corrected (dragging a
point onto the seam you meant is part of taking a measurement); the moment it is
reviewed they are frozen. Nobody reviews or accepts their own. Rename, edit
note, edit link, duplicate (which copies what was measured and **none** of the
review) and view history are all supported.

## 3 · The handover to Industrial Engineering

`GET /api/cms/rnd/garment-models/styles/:styleId/measurement-handover` — read
only, and there is no companion write anywhere on the mount. Three rules:

- **Drafts stay in R&D.** A number somebody is still taking is not a fact anyone
  downstream should plan against.
- **Withdrawn is not current.** Kept in R&D as evidence, absent here.
- **A new model version inherits nothing.** Measurements belong to the
  publication they were taken on; earlier ones are reported under
  `previousVersionMeasurements` with their own publication ref.

It carries name, type, value, unit, scale state and basis, POM link, intended
size, tolerance, note, reviewer and review date, and the points plus the route,
so IE can draw the measurement read-only without any way to move it.

## 4 · Getting out of a close-up

Opening a note flew the camera onto a seam and offered no way back anybody could
find. Orbiting out of a close-up on a 39 MB garment is slow and imprecise,
clicking empty canvas is undiscoverable and fights the orbit control, and Reset
threw away every display option as well.

Now: a **`← Back to full garment`** button in the upper-left of the viewport,
near-opaque so it reads against pale fabric, present for as long as the close-up
is, beside a header — *"Viewing: Front neckline curve · 0.34 cm"* — with
previous/next. Four ways out, all through one function: the button, `Esc`, a
close icon in the inspector, and **Exit close-up** in the mobile sheet. Reset
View exits too.

The previous view is captured **once per focus session**, not once per click, so
walking from one note to the next and pressing Back returns to the view before
any of them. The close-up distance is a share of the MODEL's size, not of where
the camera currently is, so clicking the same item twice cannot creep closer. A
curved measurement is framed by its **whole route**, never its first point.

Leaving also puts the reader back on the panel they came from — restoring, not
resetting: the rail's filter and search are untouched.

## 5 · Live verification (port 3001, the 39.5 MB sweater)

Four measurements created and named through the UI with real pointer events,
then a full browser reload returning all four identically:

| Name | Type | Value | vs straight |
|---|---|---|---|
| Chest width, flat | straight | 0.920 | — |
| **Front neckline curve** | **surface** | **0.338** | **1.68× the 0.201 chord, 35 route points** |
| Left armhole seam | guided | 0.230 | 1.09× over 27 route points |
| Chest print drop from neck | straight | 0.218 | — |

The server's recomputation of each stored route matched the stored value exactly.

Lifecycle and handover, live: two accepted, one withdrawn, one left draft, the
model approved — the handover returned **exactly the two accepted**, excluded the
draft and the withdrawn, carried the 35-point route and the reviewer, and
answered `404` to a POST.

Close-up, measured against the live engine: camera distance **2.942 → 0.490**
(0.17×) on opening, **identical** on a second click, and **exactly restored** by
the button, by `Esc` and by the inspector's close icon — including after walking
to the next item. At 375px the model stays visible above a sheet carrying
**Exit close-up**, with no horizontal overflow.

**A verification error worth recording.** My first close-up measurements were
taken against a disposed engine: switching model tabs unmounts the viewport and
builds a new one, and the "Load NNNN ms" line left over from the previous engine
says nothing about the new one. Waiting on that text measured an empty scene and
reported a camera that never moved as "restored exactly". Polling the live
engine's own `dimensions()` is the only trustworthy signal, and every number
above was re-taken through it.

## Tests

| Suite | Result |
|---|---|
| `test/rnd/garment-model.route.test.js` | **97 passed** (71 before) |
| `npx jest test/rnd test/access` | 291 passed, 4 failed |
| `components/rnd/**` (frontend) | **295 passed** (261 before) |
| `npm test` (whole frontend) | 14,012 passed, 29 failed |

The 4 backend failures are `department-role-cache` and `gac-ar1-app-access`,
which fail identically on a clean worktree at `HEAD`. The frontend's 29 are
IE/Store/PPC suites from other lanes' uncommitted work; a clean worktree at
`HEAD` fails 33.

Screenshots: `docs/product/reference-images/rnd-3d-surface-path-closeup-`,
`rnd-3d-surface-measure-in-progress-`, `rnd-3d-measurement-save-panel-`,
`rnd-3d-measurement-list-`, `rnd-3d-measurement-focused-`,
`rnd-3d-restored-full-garment-`, `rnd-3d-mobile-close-up-exit-`
(all `2026-10-01.png`).
