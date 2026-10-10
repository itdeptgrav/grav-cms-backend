# 20 mm body-length variant: visual QA, 2026-10-05

Source: `/Users/risheeray/Downloads/tshirt.dxf`. Its five parsed outlines are point-for-point identical to the existing `cloTshirt.patternSet.json` test fixture. The QA page derives an in-memory copy: front and back body pieces are lengthened 20 mm vertically from neckline to hem; both sleeves and neck band stay unchanged. The user's DXF is not edited.

The paired CLO reference path correctly refuses this non-uniform edit: the first front panel has a 12.3 mm residual after best common similarity fit. A scaled GLB would misrepresent it.

The browser draper **does produce a new mesh**. On the normal-quality A-pose-to-standing route, it took 132.2 s and settled at 0.046 mm/frame. Its worst aggregate seam residual was 1.79 mm, mean fabric strain 0.82%, max strain 21%, and source-fidelity audit passed. None of those numbers proves the surface is usable.

Front, back and left-side browser views were inspected. The body is visibly longer, but sleeve openings are pinched/unequal, the shoulder and neckline are distorted, and the hem has compressed folds. The surface gate reports sleeve openings 51% different in planarity and three sleeve-underarm pleat findings (worst turns 91–108 degrees). **Visual acceptance fails.** No sample should be approved from this output.

Next technical target: sleeve-underarm placement and collision/constraint behavior during the A-pose-to-standing transition. Do not tune to seam residual alone; retain front/back/side visual acceptance and compare against the paired CLO 3D reference. This experiment is accessible on the development page `/dev/fit-real` using the `+20 mm body length` variant button.
