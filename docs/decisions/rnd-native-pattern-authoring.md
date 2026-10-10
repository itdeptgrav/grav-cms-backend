# R&D pattern authoring is the primary 2D-to-3D workflow

**Decided 6 Oct 2026.** This changes the entry point in
`rnd-fit-simulation.md`; it does not change its one-way rule that 2D is the
manufacturing source and 3D is derived evidence.

## Product decision

The normal workflow starts with a pattern created and edited inside GRAV.
Importing a CLO or other AAMA/ASTM DXF remains an optional migration/reference
path, not a prerequisite for creating a pattern or generating a drape. Exporting
DXF is an output of the native pattern document, not an intermediate step the
operator must round-trip through another application.

The operator should be able to:

1. Create a new, empty, named pattern for a style in the R&D workspace, choose
   display units, and enter known body/finished-garment measurements.
2. Draw or draft dimensioned pieces; edit curves, points, grainlines, notches,
   folds, internal lines, darts, plackets, collars, cuffs and cut/sew lines.
3. Assign each piece a role and layer, define seam allowances, and explicitly
   classify every boundary and internal construction path. Unknown stays
   unknown; it is never silently treated as a cut or seam.
4. Confirm seam partners, direction, notches, ease, and which paths are sewn,
   finished, folded, topstitched, attached internally or decorative. Confirm
   initial panel arrangement on the chosen measured avatar and a fabric profile.
   The arrangement includes an explicit avatar pose and a previewed 3D starting
   offset/rotation for each panel, not just a semantic slot such as "left arm".
   These are simulation inputs; they never edit the 2D cut outline.
5. Save an immutable 2D revision and request a derived 3D drape of that exact
   revision. A later 2D edit produces a new revision and an explicitly new
   drape; no 3D action can rewrite the 2D pattern.

The native editor hands a saved revision to Pattern & Fit for construction
review and simulation. It must not mint a browser-owned render job itself:
the editor has no cloth worker, so such a job would sit unfinished and block
the revision. Setup review must remain reachable even when readiness correctly
refuses to start a drape.

For the first deliverable, support a **woven shirt** with its actual required
construction (including collar, placket, cuff and sleeve details). Do not call
arbitrary shirt or other garment support complete until a second, materially
changed pattern has passed construction and visual validation.

## Why native authoring helps—and what it does not solve

Native creation records intent at the moment of drawing. The operator can say
that a path is a sewing line, fold, opening or pocket placement instead of
asking a DXF parser to guess from geometry. This removes ambiguity from the
input contract and makes readiness checks enforceable. It does **not** by
itself fix mesh generation, avatar registration, cloth behavior, texture,
lighting or visibly broken drapes. The simulator and visual acceptance gate
remain separate work. No promise of CLO-equivalent output follows merely from
adding an editor or more manual questions.

## Code reality at decision time, and remaining contract gaps

- `grav-cms/components/rnd/pattern-editor/` already contains drawing/editing,
  edge classification, seam mapping, measurements, allowances, revision
  serialization and a drape request. This is a useful starting point.
- At the time of this decision the editor was preview-only and required an
  existing pattern. A subsequent working-tree slice added a production R&D
  editor route and immutable native create-root revisions; the checkpoint and
  test evidence live in `docs/tasks/rnd-native-pattern-workflow.md`.
- Internal paths still need complete operation geometry, direction and
  ownership. The first slice persists an operation label and confirmation and
  blocks unimplemented operations from draping; that is not the same as
  simulating a pocket, pleat, dart or placket attachment.
- Editor state and simulation inputs must project from one saved document with
  stable identities. A shape edit invalidates affected seam/arrangement
  confirmations; unchanged confirmations may carry only when their referenced
  geometry is proven unchanged. The 3D job must cite the pattern, avatar and
  fabric revisions it actually used.
- A current working-tree slice adds per-panel avatar-space translation and yaw,
  a pre-simulation arrangement preview, and pose forwarding. This removes the
  silent standing-pose default but does not validate a sewn/draped shirt. A
  visual preview is necessary before a confirmation; it is not proof of fit.

## Acceptance sequence

1. A user can create a blank native woven-shirt pattern and reopen it without a
   DXF. The root revision says `native-authoring`, not `dxf-import`.
2. The user can draw all required shirt pieces at measured scale and assign
   construction semantics, including internal operations, without losing them
   on save/reopen/export.
3. Readiness names every unresolved path, seam, allowance, role, avatar or
   fabric input. It refuses a drape that would silently omit one.
4. A saved revision produces a drape linked to that revision. Numeric checks
   cover physical scale, panel perimeter, seam lengths, penetrations, strain,
   stability and cloth/texture provenance.
5. Fixed front/back/side and detail views are compared with a reference by a
   person; bad sleeves, collar, cuffs, placket or surface appearance fail even
   when numeric gates pass. Repeat on a changed woven-shirt pattern before
   claiming reusable shirt support.

## Implementation order

Create the native root revision contract; expose the editor in the real R&D
workspace; complete construction-path semantics and hard readiness; then
connect saved revisions to the drape pipeline and visual QA. Keep optional DXF
import/export alongside this path. Do not put a new solver behind a pattern
whose construction is still unknown.
