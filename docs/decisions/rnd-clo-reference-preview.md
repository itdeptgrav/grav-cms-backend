# CLO reference preview is not a new drape

## Decision

The existing browser cloth solver remains experimental. A paired CLO DXF and GLB may be used as a *reference-guided size preview* only after the GLB's named panel UV boundaries match the publication's parsed DXF outlines in physical units. The original uploads and approved publications remain unchanged.

The reference path may derive a new GLB by applying one common, bounded scale to the garment group. It refuses changed piece sets, altered topology, panel reshaping, or piece-specific grading. A uniform 3D scale preserves the CLO drape's appearance; it does **not** solve cloth again or predict fit on an avatar. The endpoint and viewport must label it as unverified and must not expose fit measurements or approval controls.

## Evidence and remaining work

`tshirt.dxf` and `shirt  waves 2.glb` pair across all five cut pieces; the mean outline mismatch is 0–1.34 mm and the worst is under 3 mm. A 105% common size edit produced a derived GLB while the source GLB stayed byte-identical. The original and derived garment were visually compared in a browser. This establishes a useful reference display, not a general 2D-to-3D converter.

Next, the in-app path needs an authenticated end-to-end check against a publication containing this exact pair. General pattern edits still require a cloth assembly and simulation workflow validated against measured geometry and visual references. They must not silently fall back to proportional scaling.
