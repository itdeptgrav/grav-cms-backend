# Latest implementation — the genuine CLO T-shirt, mapped and draped through the UI

2 Oct 2026. **Committed on `NEW_CMS_BRANCH` in both repositories. Nothing pushed.**

A pattern maker can import `clo-tshirt-aama.dxf`, map all ten seams of the
garment by clicking the pattern, save, reload, drape at Normal, and reopen the
stored drape. That was done end to end in the browser against a throwaway
MongoDB, and the six faults found on the way are the whole of this change.

The verdict is **a complete T-shirt preview, not a fit-approval surface.** Every
mapped seam closes, the garment is symmetric, and the cloth is not being
stretched — but the drape ends at 0.1 mm per frame against the 0.05 mm this
quality settles to, and it is sewn on the CUT boundary, so every dimensional
finding is withheld and the screen says "Preview — not fully settled". It is
never labelled fit approved.

## What the garment did

Normal, 534 frames, ~22 s in the browser. Mean seam gaps, in the order the
screen lists them:

| seam | declared | closed to |
|---|---|---|
| Left armhole | 53.3 cm | 4.5 mm |
| Right armhole | 53.3 cm | 3.6 mm |
| Left shoulder | 17.1 cm | 3.6 mm |
| Right shoulder | 17.1 cm | 4.1 mm |
| Left side seam | 40.0 cm | 0.4 mm |
| Right side seam | 40.0 cm | 0.3 mm |
| Left sleeve underarm | 14.9 cm | 1.5 mm |
| Right sleeve underarm | 14.9 cm | 1.0 mm |
| Neck band attachment | 55.8 cm | 5.1 mm |
| Neck band join | 4.1 cm | 2.0 mm |

Cloth under tension 259.9% at the worst point, **3.10% on average**. No edge
left unsewn, no piece sewn to two things, no NaN. The 2D source is byte-identical
to the file afterwards: 5 pieces, 540 outline points, unit `in`, factor 25.4.

## The sleeve cap is four runs, and the pattern has no fault

The earlier reading of this file put the sleeve cap 27.8% away from the armhole
and looked like a pattern that needed gathering. It does not. The sleeve's single
41.7 cm run is the straight **hem**; the cap is the four published runs between
the two underarm points, and together they are 53.4 cm against a front-plus-back
armhole of 53.3 cm — **0.1% ease**. A different run interpretation, not a
mismatch and not gathering.

The combinations a person selected, recorded so they can be checked:

- **cap, both sleeves** — `1→30`, `30→60`, `60→90`, `90→120`, in that order and
  the same direction on both sleeves. Reversing one of them to "match the mirror"
  is wrong and cost 27 mm on the right armhole.
- **armhole** — front `underarm→shoulder`, then back `shoulder→underarm`, which
  is one continuous stretch crossing the shoulder seam: `60→31` + `113→84` on the
  left, `64→93` + `51→80` on the right. Paired start-to-start.
- **neck opening** — six runs: front `95→0`, `0→29`, then back `115→134`,
  `134→0`, `0→29`, `29→49` = 58.2 cm, against a 53.4 cm rib band. The band is
  8.9% shorter **on purpose**, which is why the ease tolerance belongs to a run's
  role and not to seams in general.

## The six faults, all invisible to what was already checking

1. **A ring on the pattern was not a click target.** Anchors were drawn inside a
   `pointerEvents="none"` group, so a click aimed at one fell through and merely
   selected the piece underneath.
2. **A proposed run was measured in the file's own unit.** This export is in
   inches, so the pick bar read 0.7 cm for a 17.1 cm shoulder seam.
3. **Reverse wrote a word nothing reads.** It set `direction`; the solver chooses
   between the two stretches joining a pair of ends by `theLongWay`, which had no
   field to be stored in.
4. **Both sleeves were placed on the left arm.** Handedness came only from a
   piece's name and this file calls them `Pattern_1621764/5`. Readiness passed
   nine steps of nine, every seam length matched, every run was confirmed and the
   drape settled — with a 213 mm average gap on the right armhole. A sleeve also
   hung 70 mm outboard of the shoulder point, dragging the shoulder seam open.
5. **Readiness compared inches with millimetres.** R5 divided a perimeter in the
   file's unit by seam lengths in millimetres, so one mapped shoulder seam made a
   whole panel pass as fully sewn; and R7 refused the side seams for being
   "0.0% apart where this seam allows 0%", which is floating-point noise on two
   lengths that are 400.2140 mm each.
6. **A finished drape was discarded for being 12 characters too wordy.** The
   sentence explaining why a cut-boundary drape withholds its chest measurement
   is 412 characters against a 400 cap, so every such drape failed to save and
   the browser was told "Something went wrong."

Plus one reporting fault: **2639% strain was ten edges a tenth of a millimetre
long**, out of 11,328. The screen now names the exclusion and its size.

## Tests

- frontend `node --test "components/rnd/fit/*.test.mjs"` — **177 pass**
- backend `npx jest test/rnd/` — **354 pass**

Each fault has a regression test that fails without its fix, verified by
reverting the fix and re-running. `run.test.mjs` now asserts the thing no
tolerance can be traded against: **Normal must close every seam tighter than
Draft and end at a lower movement rate.** Gap bounds are each quality's own mesh
spacing rather than round numbers, and the woven and the knit are asserted
separately, because a poplin shoulder carrying two sleeves cannot close the last
millimetres without stretching and the solver is built to let the cloth win.

## What is still not true

- **Not settled.** 0.1 mm per frame against 0.05 mm. Preview only.
- **Sewn on the cut boundary.** A published sewing line is still not read into
  the mesh, so a 10 mm allowance is unaccounted for — of the order of 40 mm round
  a chest. Every dimensional finding is withheld, by the server, not by courtesy.
- **One vertex at 259.9%.** At the tightest fold, where cloth turns through
  nearly 180 degrees in two triangles. Known, pinned, not hidden.
- **Near-duplicate outline points survive the weld.** The mesher still builds
  0.12 mm edges from them, which carry a stiffness spike. Only the reporting of
  that was fixed here, not the mesher.
- **Draft is rough.** 17 mm shoulders and not settled. It is for seeing whether a
  mapping sews at all.
- The fabric is a preset, so W5 stands. No fit findings, no grab or pin, no trial
  comparison, no trousers or jackets.

## How it was verified

`scripts/rnd/fit-verification-world.js` boots mongodb-memory-server on port
27018 and seeds one company, one login and one style from the real DXF. It never
reads `MONGODB_URI` and never touches Atlas. No Atlas collection was dropped and
no unrelated database was modified.
