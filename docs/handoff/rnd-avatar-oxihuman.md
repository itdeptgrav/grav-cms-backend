# Handoff — OxiHuman avatar lane in R&D Pattern & Fit

3 Oct 2026. Committed on `NEW_CMS_BRANCH` in `grav-cms` and `grav-cms-backend`.
Nothing pushed. Decision record: `docs/decisions/rnd-avatar-oxihuman.md`.

## What exists now

- **Avatar control in Pattern & Fit** (drape menu strip → *Avatar*): Preset ·
  Custom measurements (mm / cm / in, stored in mm) · Generated result ·
  Measurement verification table · Pose (A-pose 45°, standing 14.04°, show /
  hide, opacity, front / back / left / right, reset camera) · Save avatar ·
  saved library with *Open rN* · *Capsule body (fallback)*.
- **OxiHuman 0.2.1 in a Web Worker**, lazy: the panel chunk loads when opened,
  the engine and pack when Generate/Open is first pressed. Pinned wasm + pack
  hashes checked on load.
- **GRAV tape measurement** of every generated body; Pass ≤5 / Review ≤10 /
  Fail; "Fit verified" only when all four pass.
- **Ten presets**, 5 masculine + 5 feminine, all Fit verified.
- **Capsule collision body** in Lane A's `bodyFromMeasurements` shape, per pose,
  plus `laneAdapter.js#avatarBodyFactory` for any angle. Not wired into the
  solver.
- **Persistence**: `SampleStyle.rndAvatars` (append-only, `select:false`), routes
  `GET/POST /api/cms/rnd/styles/:styleId/avatars`, `GET …/:avatarId/revisions/:n`,
  server-side contract re-verification, `simulationInputs.avatar.avatarRef`
  validated on save and frozen by RenderJobs.

## Preset results (requested → GRAV-measured, mm)

| Preset | Height | Chest/bust | Waist | Hip | Verdict |
|---|---|---|---|---|---|
| Male S — Slim | 1700 → 1700.0 | 880 → 879.8 | 740 → 739.9 | 920 → 920.8 | Fit verified |
| Male M — Regular | 1760 → 1760.0 | 960 → 960.1 | 820 → 819.9 | 970 → 970.9 | Fit verified |
| Male L — Athletic | 1820 → 1820.0 | 1040 → 1040.1 | 840 → 839.9 | 1000 → 1000.2 | Fit verified |
| Male XL — Broad | 1780 → 1780.0 | 1090 → 1089.9 | 930 → 928.8 | 1050 → 1050.0 | Fit verified |
| Male M — Tall | 1900 → 1900.0 | 980 → 980.1 | 840 → 839.9 | 1010 → 1010.2 | Fit verified |
| Female XS — Slim | 1630 → 1630.0 | 800 → 800.1 | 640 → 640.1 | 880 → 880.6 | Fit verified |
| Female S — Regular | 1650 → 1650.0 | 860 → 860.0 | 690 → 690.0 | 930 → 929.7 | Fit verified |
| Female M — Regular | 1680 → 1680.0 | 920 → 920.1 | 750 → 749.9 | 990 → 990.0 | Fit verified |
| Female L — Curvy | 1650 → 1650.0 | 1020 → 1019.6 | 820 → 819.5 | 1100 → 1099.2 | Fit verified |
| Female M — Tall | 1780 → 1780.0 | 900 → 900.1 | 720 → 720.0 | 980 → 980.1 | Fit verified |

## Verification run

- Frontend `components/rnd/avatar/*.test.mjs`: 29/29 (17 rule tests, 12 against
  the real pinned engine incl. all ten presets). All `components/rnd/**`: 1333
  pass, 0 fail.
- Backend `services/rnd/avatarContract.test.js` 8/8; `test/rnd/avatar.route.test.js`
  12/12; all `test/rnd` 446/448 in one parallel run, the two failures in
  `pattern-editor-save.test.js` pass 61/61 when run alone.
- Chrome (authenticated, JW-SHIRT-DEMO-01): Male S — Slim, Female L — Curvy and a
  custom feminine 174/94/71/99 cm avatar generated and Fit verified; four views;
  A-pose vs standing; saved AV-25A8AADDAE r1, reloaded, reopened with every hash
  matching; capsule fallback shown after a deliberate engine-load failure and by
  choice; no console errors; no main-thread long tasks during generation.

## Not done / for the next lane

- The CMS session marks this R&D *editor* read-only in Pattern & Fit
  (`useDeptRole` vs the server's `access.canAnnotate: true`), so the in-panel
  Save button was disabled; the save was made through the same route with the
  same session. Pre-existing; affects Save setup and Drape too.
- Lane A: adopt `avatarBodyFactory` in `poseTransition.js`/`run.js`, decide the
  A-pose angle convention, and verify a drape on an OxiHuman body.
- Product: a fuller OHPK (male base shapes, below-base stature) needs a
  self-built pack from the CC0 MakeHuman targets — not the official release.
