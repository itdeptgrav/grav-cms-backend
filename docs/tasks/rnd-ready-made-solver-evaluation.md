# Ready-made solver gate for the `shirt2` woven shirt

Status: **research only; no replacement selected** (6 October 2026).

The product target remains the in-app, 2D-source-of-truth woven-shirt workflow
in `rnd-clo-shirt-calibration.md`. A third-party simulator is useful only if it
advances that full target; a convincing built-in example is not evidence that
it can construct and drape this imported shirt.

## Current source and trial evidence

- `shirt2.dxf` supplies 13 panels. The reference XML/PAC has 38 path pairs:
  24 outer-cut cross-piece pairs, six attachments to internal front-panel
  lines, four auxiliary-piping pairs, and four same-piece sleeve paths. See
  `rnd-clo-shirt-calibration.md` for the source audit and remaining semantic
  uncertainty.
- The isolated OpenSew-2 evaluation in `/tmp/grav-opensew-eval` has **not**
  produced a visually acceptable 2D-only shirt. Its construction/placement
  experiments are not part of GRAV and must not be presented as a completed
  drape. The last tested shoulder prearrangement reduced its initial shoulder
  gap but put 638 back-panel vertices inside the avatar; projecting them out
  caused 77 back-panel self-intersections. This variant is rejected.
- One avatar-pose trial bent the arms through the torso. That pose is invalid
  comparison evidence; a model that looks better in it is not an improvement.

## Candidate assessment

| Candidate | What exists | Exact `shirt2` gap | Gate |
| --- | --- | --- | --- |
| [GarmentCode/PyGarment](https://github.com/maria-korosteleva/GarmentCode) with its [modified Warp](https://github.com/maria-korosteleva/NvidiaWarp-GarmentCode) | 2D panel/seam JSON, panel meshing, single-pattern simulation command, XPBD cloth with body and self-collision work | No native AAMA DXF or supplied FBX ingest demonstrated. `BoxMesh.read_stitches()` addresses **panel boundary edge indices** and `collapse_stitch_vertices()` merges those edges. The six front-panel interior attachments therefore need a represented construction operation, not a simple JSON conversion. Trim and same-piece path semantics also remain unproven. | Conditional research candidate, not drop-in replacement. Prove adapter + interior attachments on `shirt2` before solver comparison. |
| [OpenSew-2](https://github.com/MarcelloMorettoni/opensew-2) | Blender-based cloth and stitching; source in isolated evaluation | The real 2D-only shirt currently fails visual and collision checks | Do not integrate current trial. |
| [SELVEDGE Studio](https://github.com/wieslawsoltes/SELVEDGEStudio) | Browser-native 2D editor and XPBD prototype | Its README says no avatar import, production interchange, or multilayer garment logic, and warns of visible penetration | Useful implementation reference, not this shirt's ready-made pipeline. |

### Rechecked against all native shirt paths

The read-only source audit was rerun on the original `shirt2.dxf`,
`shirt2.glb`, `design02_meta_data.xml`, and extracted read-only PAC. It reports
**38/38 named owners** and `readyForDrape: false`. This is a map of source
paths, not a complete physical construction contract.

The solver-neutral diagnostic is now executable:

`node scripts/audits/rnd-shirt-construction-manifest.js <extracted-design02.pac> <shirt2.glb> <shirt2.dxf> <design02_meta_data.xml>`

It emits the 13 original DXF cut outlines and internal lines in millimetres,
plus all 38 ordered native path point sequences and four source hashes. For
named DXF pieces it maps the reference GLB's **flat UV coordinates** back to
the verified original DXF panel coordinate system; the GLB's finished 3D
positions are never part of the output or a placement target. Auxiliary
piping has no DXF panel, so its points stay explicitly tagged as reference
flat UV only. The manifest labels every operation unconfirmed and blocks
draping. The exact supplied files produced counts 24/6/4/4 for outer/
interior/auxiliary/same-piece paths, and pairs 33–38 all mapped to internal
line index 2 on the corresponding front panel. Two focused coordinate/index
tests pass. This is source recovery, **not** a runnable GarmentCode spec or a
validated shirt assembly.

| Source pairs (1-based) | Count | Location | GarmentCode v2 stock JSON/`BoxMesh` fit |
| --- | ---: | --- | --- |
| 1–15, 20–23, 26–27, 30–32 | 24 | Two DXF outer cuts | Candidate for panel-edge stitches only after each source path is split into exact edges, orientation checked, and overlapping stitches checked. Pairs 21–22 and 30–31 require interpolated anchors. Not yet a runnable manifest. |
| 16–19 | 4 | Collar to auxiliary piping geometry absent from DXF | No source panel to encode; resolve whether trim must be reconstructed or explicitly omitted from physics with visible provenance. |
| 24–25, 28–29 | 4 | Two paths on the same sleeve piece | Native operation not established. Cannot assume a structural weld or discard as decoration. |
| 33–38 | 6 | Small panel cut edge to front-panel **internal DXF line** | Stock stitch format references only a panel's boundary-edge index. This operation is not representable as a simple stock stitch entry. The DXF internal path is identified, but semantics and mesh constraint need engineering. |

The GarmentCode [single-pattern CLI](https://raw.githubusercontent.com/maria-korosteleva/GarmentCode/main/test_garment_sim.py)
does accept a `*_specification.json` file, and an [example specification](https://raw.githubusercontent.com/maria-korosteleva/GarmentCode/main/assets/Patterns/shirt_mean_specification.json)
has panels, 3D translations/rotations, and stitches. However,
[`BoxMesh.read_stitches()`](https://raw.githubusercontent.com/maria-korosteleva/GarmentCode/main/pygarment/meshgen/boxmeshgen.py)
looks up the referenced panel's boundary edge and rejects reuse of a stitched
edge; its later stage merges seam vertices. These are concrete adapter and
representation constraints, not proof the candidate is unsuitable as a
physics base. Do not claim all 24 outer pairs work unchanged.

The same audit shows why even the 24 boundary pairs are **not** a blind
edge-to-edge conversion. Pairs 21–22 and 30–31 end between the current DXF
vertices and need precise splits. Sleeve joins 23 and 27 have a roughly
308 mm path opposite a 288 mm path, and their CLO-finished endpoint-gap test
does not disambiguate direct versus reversed order; the native path order must
settle direction. Front/back side sections 3–4 and 6–7 differ by roughly
11 mm per partner segment. Those differences may be intentional ease or
allowance; forcing equal sampled edge lengths or welding without a sewing
operation classification could distort the 2D source. The audit's
`readyForDrape: false` remains correct.

GarmentCode itself is MIT, but its modified Warp fork carries an
[NVIDIA research/evaluation-only license](https://github.com/maria-korosteleva/NvidiaWarp-GarmentCode/blob/main/LICENSE.md#33-use-limitation).
Internal company use must **not** be assumed to satisfy that restriction.
[Current upstream Warp](https://github.com/NVIDIA/warp/blob/main/LICENSE.md)
is Apache-2.0, but it does not automatically contain the garment-specific fork
changes. Check legal permission or choose a permitted implementation before
product use. This is a product/legal review gate, not a claim of legal advice.

## Smallest honest evaluation

An isolated shallow checkout of GarmentCode at `d449629979028123a5c4dc9e732a2ec19b7fce31`
exists at `/tmp/grav-garmentcode-eval`; no GRAV application code or supplied
source was modified. Its installation instructions require Python 3.9 and a
manual build of its modified Warp. The current local host is arm64 with
Python 3.14, no `warp` module, no Python 3.9 or `nvidia-smi` available, so a
local stock simulation has **not** run. This is an observed toolchain gap,
not a failed `shirt2` simulation. The repo's `test_garment_sim.py` is a real
single-pattern entry point, but a working setup and a pattern adapter are
still separate requirements.

1. Build a source-only `shirt2` adapter manifest without simulation: preserve
   all 13 panels and source identifiers; classify every one of the 38 paths;
   explicitly flag anything the candidate schema cannot represent. Do not
   silently drop interior attachments, piping, same-piece folds, or placket
   construction to make a demo run.
2. Use the candidate's single-pattern runner on a **separate small known-good
   example** to confirm its actual toolchain. A passed example establishes
   only that the runtime works.
3. Extend or adapt the candidate for the six front interior attachments and
   necessary construction semantics, register the supplied avatar, and use
   documented fabric assumptions. Only then simulate `shirt2` from the DXF.
4. Compare fixed front/back/left/right and collar/placket/armhole/cuff/hem
   close-ups to the paired CLO reference. Reject visibly broken results even
   if seam and strain numbers pass. Run a changed shirt pattern with frozen
   parameters before claiming reusable shirt support.

**Decision now:** stop OpenSew parameter tuning; test representational
completeness first. No open-source project examined here is presently verified
to take arbitrary `shirt2` DXF + native seam graph + `avatar2.fbx` and emit a
credible finished woven shirt without adapter or solver work. Do not change
the in-browser-worker decision in `docs/decisions/rnd-fit-simulation.md`
silently: a server-side Warp evaluation is an architecture experiment, and a
production switch requires an explicit decision update if it passes.
