# Latest implementation — the flat pattern, and which piece is which component

1 Oct 2026. **Committed on `NEW_CMS_BRANCH` in both repositories.**

An R&D technical bundle now carries the flat pattern beside the 3D garment and
the CLO source. The server reads the DXF rather than taking the upload's word
for anything, and states which flat piece is which 3D component — or says
plainly that it cannot.

Live demo data written to the dev Atlas database: **one new technical bundle**
(3D model 5 on `JW-SHIRT-DEMO-01`, approved), a **pattern attached to the
existing 3D model 4**, and one confirmed piece-to-component mapping on it. The
real CLO GLB (19.2 MB) and the CLO DXF (66 KB) were uploaded to the company
Drive through the real route. Nothing else was touched; see §6 for how to undo it.

## 1 · What was built

| Part | Where |
|---|---|
| AAMA/ASTM DXF parser | `utils/dxfInspect.js` |
| Content-based file classification | `utils/bundleFileTypes.js` |
| Bundle coherence, derived checks, measurements | `services/rnd/patternBundle.service.js` |
| The 2D→3D mapping ladder | `services/rnd/patternMapping.service.js` |
| Pattern schema, mappings, bundle fields | `models/CMS_Models/RnD/GarmentModel.js` |
| Routes, upload, IE projection | `routes/CMS_Routes/RnD/garmentModelRoute.js` |
| 2D viewer, upload cards, rail | `grav-cms` `components/rnd/workspace3d/patterns/**` |

New endpoints, all under `/api/cms/rnd`, all behind employee auth → company →
live R&D grant:

| Method | Path | Capability |
|---|---|---|
| POST | `/garment-models/classify` | `rnd.pattern.publish` — stores nothing |
| PUT | `/garment-models/:id/pattern` | `rnd.pattern.publish` |
| GET | `/garment-models/:id/pattern` | `rnd.model.read` |
| POST | `/garment-models/:id/pattern/mappings` | `rnd.pattern.map` |
| POST | `/garment-models/:id/pattern/rematch` | `rnd.pattern.map` |
| GET | `/garment-models/styles/:styleId/technical-bundle` | `rnd.model.read` |

`rnd.pattern.map` is deliberately its own capability rather than folded into
annotating: a marker is one person's note and is argued with in replies, while a
confirmed mapping is a statement that this flat piece **is** that component, it
is what the IE projection carries, and nothing downstream re-examines it.

The full design record, including the ASTM D6673 layer table and the four
defects a real CLO file exposed, is in
`docs/product/rnd-3d-garment-workspace.md` § Phase 3.

## 2 · The rule everything obeys

**Absent is absent.** No quantity is `null`, not `1`. No grainline is `null`,
not vertical. No sew line means the seam allowance is *unpublished*, not zero,
and the inspector says so in those words. One size is a sample pattern, not a
grading with one step. Each of those defaults would be a statement somebody
could cut cloth against, attributed to a patternmaker who never made it.

**Net pattern area is never called fabric consumption**, and the payload carries
the reason so an API consumer cannot mistake it either.

## 3 · Verification

| Suite | Result |
|---|---|
| `npx jest test/rnd/` (backend) | **195 passed** |
| `node --test components/rnd/**/*.test.mjs` (frontend) | **425 passed** |

The pattern fixture is a genuine CLO 7.1.178 export, committed at
`test/fixtures/rnd/clo-tshirt-aama.dxf` with a README explaining why a
hand-written one cannot test this parser.

Walked in the real application on **http://localhost:3001** against the real
backend on :5050, the real dev Atlas database and the real company Drive, signed
in as the seeded demo R&D editor, approver and viewer.

## 4 · What the live pass found that the tests did not

1. **A draft with no pattern could never get one** — `editable` was returned only
   on the branch that already had a pattern, so the control that attaches one
   never rendered in the exact case that needs it.
2. **An approved bundle could not start a revision** — "Publish a new bundle" was
   gated on the current bundle being editable.
3. **The pattern sheet asked for the 3D model**, a file it has no card for.
4. **Five piece labels overlapped into a smear at 375px.**
5. **A screen reader heard "5 pieces in in".**
6. **`{ ...mongooseSubdoc }` copies internals, not fields** — every confirmed
   mapping read back from the database arrived blank. Invisible to unit tests,
   which pass plain objects in.
7. **Eight new refusal codes all arrived as `VALIDATION`**, because an
   unregistered code silently becomes it.

Each is fixed, and each has a regression test naming it.

## 5 · Limitations, stated rather than implied

* The test DXF publishes **no notches, no drill holes, no sew line, no grading
  and no chosen piece names**. Those paths are implemented and covered by
  synthetic fixtures; they have not been run against a genuine export containing
  them.
* **No genuine `.zprj` was available.** The source path is verified with a ZIP
  fixture and by refusing every other format — which is what a container with no
  published specification honestly allows.
* **No fully graded production pattern has been run.** The storage ceiling
  (250,000 points) and draw ceiling (24,000 nodes) are enforced and tested; no
  real file has reached either.
* The CLO GLB **merges the whole garment into one mesh called `Cloth`**, beside
  nineteen trims and a 94-node avatar skeleton, so pattern pieces cannot be
  highlighted individually. The workspace says so in the brief's own words.

## 6 · Undoing the demo data

Three rows on style `6abb3397de13c635ae989477`, all in `GarmentModelPublication`:

* `GM-6424D750D2` — 3D model 5, APPROVED, the new bundle. Deleting it leaves
  3D model 3 superseded rather than approved; set it back if that matters.
* `GM-2F1BFAA52C` — 3D model 4, now IN_REVIEW with a pattern and one mapping.
  Clearing `patternSet`, `pieceMappings` and the `pattern` asset restores it.
* The two Drive objects behind them, in `rnd/garment-models/<styleId>/`.

`public/__dev__/tshirt-garment.glb` and `tshirt-pattern.dxf` were staged in the
frontend for the browser pass. That folder is gitignored; delete them when done.

## 7 · Next

1. **A genuine graded, notched DXF.** Everything below the sample-pattern case is
   implemented against synthetic fixtures and unproven against a real export.
2. **A CLO re-export with pattern-piece names switched on.** It is the one thing
   that would make name-based mapping possible on this style at all, and it
   would turn the mapping ladder's middle rungs from code into evidence.
3. **The marker-making system**, which takes this verified geometry as input.
   Deliberately not built here: nesting, fabric optimisation, cutting-room
   planning, operation bulletins, SAM and sewing sequence all remain out of scope.
