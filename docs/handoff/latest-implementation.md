# Latest implementation — the R&D 3D workspace's toolset, and measurements that say what they are worth

1 Oct 2026. **Committed on `NEW_CMS_BRANCH` in both repositories.** Live demo
data was written to the dev Atlas database (one new draft publication of the
sweater, three notes, four measurements, one scale calibration); nothing else.

## The audit that started it

Every control already in the workspace, and what was actually behind it:

| Control | Verdict |
|---|---|
| Select, Orbit, Pan | real |
| Measure (two points) | real but **ephemeral** — never stored, gone on reload |
| Add note | real, correctly refused to viewers and to accepted models |
| **Isolate part, Hide part** | **dead on this export.** The reference sweater is one merged mesh (`Object_2`, "Pieces 1"). They ran, dimmed nothing, changed nothing |
| Fit, Reset | real |
| Front/Back/Left/Right/Top | real, but jumped instantly |
| Isolate off, Show all | no-ops on a merged mesh |
| Grid, backgrounds, axis gizmo | real |
| Structure / Notes / Properties | real; Properties was a thin editor, not an inspector |

Missing entirely: zoom control, perspective/parallel, fullscreen, screenshot,
wireframe, surface, x-ray, bounding box, annotation and measurement visibility,
path and angle measurement, calibration, scale state, marker camera focus,
previous/next, return-to-previous-view, rail filters, mobile sheet.

And the one that mattered most: **clicking a note only shaded a list row.**

## What is now there

**Navigation.** Orbit, pan, zoom, fit, reset, five preset views, parallel ↔
perspective, fullscreen, screenshot. Preset views and every focus move glide
over 340 ms inside the one render loop that already existed — a second
`requestAnimationFrame` per control is how a viewer ends up with six loops
fighting over one camera. Touching the canvas cancels a glide, because a camera
that keeps moving under somebody's drag feels broken.

**Opening a note moves the garment.** The camera travels to the note's own
anchored point and frames about a third of the garment around it — close enough
to read a seam, wide enough to know which seam. The author's saved camera sets
the DIRECTION; the distance is computed for the point, so a note written from a
wide shot still opens at a readable size. The final position is ray-tested
against the mesh and pushed out in front of anything in the way, so a marker
inside a cuff cannot put the camera inside the fabric. Measured live: camera
moved 2.60 units, final distance 0.5 × the model's extent, never inside.

**The inspector** shows title, full note, category, priority, status,
department relevance, the anchored part, the linked technical item,
construction detail, author and date, replies, resolution and resolver, and the
event history with its revision — plus previous, next, and back to the previous
view.

**Measurements** are a server-side record, not a line on a canvas:
point-to-point, multi-point path, and angle. The browser picks the points; the
**server computes the number from them**, so two viewers cannot disagree about
a length and a stored figure is always something that can be rechecked.

## Measurement accuracy — what this can and cannot claim

- A **path is a polyline**: the sum of the straight segments between the points
  somebody placed. It reads shorter than a curve, exactly as a tape pulled taut
  between pins does. It is called that on screen, in the payload and in the
  code. It is **not** a geodesic and nothing here says it is — writing a real
  one means walking the mesh between two points, and this export is a single
  7,424-triangle shell with no seam topology to walk.
- An **angle needs no scale**: a ratio of lengths has no units, so it is as
  trustworthy on an unscaled export as on a calibrated one, and it carries no
  scale warning.
- Three scale states, always on screen: `Scale verified`, `Scale declared by
  export`, `Scale unverified — use as visual reference only`. Unverified shows
  the raw figure in the file's own units and never a centimetre.
- The scale is **frozen onto each measurement** as it is taken. Calibrating
  later changes what the NEXT measurement says; it never reaches back and
  relabels a number somebody already wrote down.
- Calibration belongs to **one publication** and there is no code path that
  copies it to another — a later export may be drawn at a different scale.
- The standing caveat is on every surface that lists a measurement, in every
  state including verified: *3D measurements support review. The approved
  measurement specification remains the manufacturing authority.*

**A real finding from the live run.** The reference export declares `cm` and is
1.197 × 0.703 × 0.322 model units — a sweater 1.2 cm tall. The declared unit is
wrong, which is precisely why "declared" is not "verified". After calibrating
against a 45 cm known distance the factor came out at ≈67, and a new
measurement read **41.18 cm** while the earlier ones correctly still read
0.22 cm on their original declared basis.

## Inspection, said honestly

Wireframe, surface and x-ray (double-sided, or the garment reads inside-out);
bounding box with the model's dimensions; note and measurement visibility
toggles. **Isolate and Hide are disabled on this export** with the reason on
hover — *"this export contains one merged garment mesh"* — and the strip beside
the model says the same. Notes and measurements keep working on that mesh, so
exactly two controls are disabled rather than the toolbar. A part the export
numbered rather than named is shown as **"Garment surface"** everywhere a
garment component belongs, with `Object_2` kept beside it as the muted
technical reference it actually is.

**No clipping/section tool was added.** It is the one control that would have
made the toolbar look complete and could not have been made stable and
understandable in this slice, so it is not rendered at all. A dead button is a
promise the product has not kept.

## Modes and usability

One mode at a time, always named on screen with a one-line instruction beside
it. Escape cancels and leaves no partial record, Ctrl/Cmd+Z takes back the last
point, Enter finishes a path, changing tool clears half-placed geometry, and a
drag is never a point. The keys are bound to the window — the canvas is
deliberately not focusable — and none of them fire while somebody is typing.
Nothing on screen says raycast, barycentric, node-local or optimistic lock.

## Storage, and the constraint that shaped it

Measurements **embed on the publication**. They belong to exactly one, can never
move to another, and are always read with it — there is no query that wants
them separately. The deciding constraint was blunter: this deployment is at its
database's 500-collection ceiling, so a new collection is not available. Each
measurement keeps its own `_id`, `revision`, status, author and events. The API
contract did not move: all 70 route tests passed unchanged across the storage
change.

Company scoping, R&D capabilities, private assets, immutable approved
publications, optimistic revision checks, maker-checker and non-disclosing
foreign-company answers are all unchanged and tested.

## Defects found and fixed on the way

- **Every event leaked the author's email.** `by` was returned as the whole
  `{ id, name, email }` record. A screen rendering it got an object where it
  expected a person, which is not a wrong name — it takes the entire workspace
  down to its error screen. Now a name, with a display helper that can never
  throw.
- **The structure tree showed `Object_2` as a pattern piece**, in the same type
  as a real one.
- **The calibrate tool from the rail armed the pointer and showed no panel** —
  two points could be placed with no way to finish. The tool now brings its
  panel.
- **The workspace-3d route had no Suspense boundary** around its
  `useSearchParams`, which fails the production build.
- The draft reading said "0.524 model units" while the saved one beside it said
  "0.52 cm" — the same length in two vocabularies.
- On a 375px screen the stats overlay and the display strip took a fifth of the
  width and overlaid the garment from two edges.

## Verification

Live on `http://localhost:3001/research-development/styles/6abb3397de13c635ae989477/workspace-3d`
(backend on **:5001**), driven through real pointer events on the canvas, on the
39.5 MB sweater:

three notes on different areas · one distance · one four-point path · one angle
· Escape abandoning a three-point placement cleanly · calibration from two known
points · a full browser reload returning all four measurements, three notes and
the verified scale identically · every display control exercised and confirmed
to act · the viewer read-only with a reason on every recording tool · 375px with
the model visible above the sheet and no horizontal overflow.

| Suite | Result |
|---|---|
| `test/rnd/garment-model.route.test.js` | 71 passed (48 before) |
| `test/rnd/demo-access-seed.test.js` | 5 passed |
| `npx jest test/rnd test/access` | 265 passed, 4 failed |
| `components/rnd/**` (frontend) | 261 passed (192 before) |
| `npm test` (whole frontend) | 13,973 passed, 29 failed |

The 4 backend failures are `department-role-cache` and `gac-ar1-app-access`;
they fail identically on a clean worktree at `HEAD`. The frontend's 29 are
IE/Store/PPC suites from other lanes' uncommitted work — a clean worktree at
`HEAD` fails **33**, so this work removed none and added none.

Screenshots: `docs/product/reference-images/rnd-3d-toolset-workspace-`,
`rnd-3d-marker-closeup-`, `rnd-3d-measure-in-progress-`,
`rnd-3d-measurements-after-reload-`, `rnd-3d-merged-mesh-`,
`rnd-3d-viewer-readonly-toolset-`, `rnd-3d-mobile-inspector-`,
`rnd-3d-calibrated-` (all `2026-10-01.png`).
