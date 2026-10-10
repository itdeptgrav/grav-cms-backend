# CLO-guided T-shirt drape calibration

Status: **source target extracted; solver not calibrated or accepted** (5 October 2026).
The user has since prioritised a woven shirt; see
`docs/tasks/rnd-clo-shirt-calibration.md`. This T-shirt target is retained for
later validation, not the next solver-tuning target.

## Product boundary

The 2D pattern remains authoritative. A CLO GLB is a paired solved example and
validation oracle, never the output for a changed cut. T-shirt-specific
calibration may choose solver parameters and initialization rules, but may not
silently alter DXF cut lengths, seam topology, or a user's fabric measurements.
No claim of "all T-shirts" or fit accuracy is made from one source example.

## Source target now available

Run `node scripts/audits/rnd-clo-calibration-source.js <CLO.glb>
<parsed-pattern.json> <CLO-metadata.xml>` to verify an exact DXF/GLB match and
produce a read-only, hashed report. The current supplied pair is
`tshirt.dxf`, `shirt  waves 2.glb`, and `shirt  waves_meta_data.xml`, with the
parsed pattern at `grav-cms/components/rnd/fit/cloTshirt.patternSet.json`.
Original files are not modified.

The real run reports five named pieces, 15 XML seam pairs, and unambiguous
GLB-material-to-XML-property matches: front, back and sleeves use
`Knit_Fleece_Terry_0`; the neckband uses `Rib_1X1_319gsm_0`. Their XML
densities are 0.000226263 and 0.000319192 respectively, but the raw CLO
stiffness and contact values are **not** app solver parameters. The outer-face
GLB/UV edge-ratio medians are 0.975 front, 0.977 back, 0.985/0.987 sleeves
and 0.943 neckband, under the audit's unique-edge 0.5–40 mm filter. These
ratios are source-export geometry measurements, not a solver acceptance score.

The audit requires a DXF/GLB outline match before reporting a calibration
target. A missing material match makes `readyForParameterTuning` false. It
does not parse the proprietary ZPRJ container or assert that the supplied
avatar is in the exact CLO pose.

## Sequential implementation gate

1. Register the avatar and source garment in the same physical coordinate
   system. Verify units, pose, body/cloth clearance, and the exact 15 sewing
   paths including neckband fold and cyclic phase. Reject mismatched sources.
2. Build a *per-piece* solver fabric assignment. Calibrate a conversion from
   CLO's physical tests to this solver's force/compliance law with bounded
   parameter searches; never copy raw stiffness or friction values by name.
3. For the fixed source T-shirt, run an independent flat-2D-to-3D drape.
   Compare front/back/both sides and armhole/neck close-ups to the source GLB,
   plus per-piece surface shape, seam gaps, cloth/body intersections, and
   source-relative stretch distributions. A numerical pass cannot override a
   visibly collapsed sleeve or broken neckband.
4. Freeze the candidate parameters. Test on at least three *held-out* CLO
   DXF+GLB+metadata triplets that change body length, sleeve/armhole shape,
   and neckline/band independently. Do not tune on those held-out outcomes;
   use failures to narrow the supported T-shirt envelope or revise the model
   and repeat with a new holdout set.
5. Only after those results pass may the app label supported T-shirts as a
   validated drape. Outside the envelope, show a preview with an explicit
   limitation rather than a false fit-accurate claim.

## Current blockers

- Only one verified paired CLO example is in hand; it cannot establish
  generalization to different T-shirt cuts.
- The existing app fixture applies a single 180 gsm profile to all five
  pieces, unlike the two source fabrics.
- The source GLB and supplied avatar have a measurable registration/contact
  mismatch; the neckband and armhole topology still need source-faithful
  initialization. See `docs/tasks/rnd-drape-placement-recovery.md` for the
  rejected ablations and visual evidence.
- The independent altered-body-length test generated a mesh but failed visual
  sleeve/shoulder QA despite good seam numbers. See
  `docs/tasks/rnd-body-length-variant-qa.md`.
