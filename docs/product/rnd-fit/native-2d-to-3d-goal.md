# GRAV R&D: native 2D pattern to usable 3D garment

**Working goal — 6 Oct 2026.** This is the outcome we are trying to achieve,
not a claim that the feature is finished. The durable product decision is
[`rnd-native-pattern-authoring.md`](../../decisions/rnd-native-pattern-authoring.md);
the current implementation evidence is in
[`rnd-native-pattern-workflow.md`](../../tasks/rnd-native-pattern-workflow.md).

## The result a user should get

A patternmaker creates or edits a measured 2D pattern **inside GRAV**, tells
GRAV how its pieces are constructed and sewn, selects a measured avatar and a
fabric, and generates a 3D garment that visibly hangs and folds like that
fabric on that avatar. The garment must be recognisably the one the pattern
describes: correct panels, sleeves, collar, cuffs, plackets, openings and
closures. A smooth render or a small average seam gap cannot substitute for
that visual result.

The 2D pattern is the manufacturing source. A 3D result is derived evidence,
never a way of editing the 2D. Editing the pattern creates a new immutable 2D
revision and requires a new 3D result linked to that exact revision. DXF
import/export remains optional; no CLO or Blender round trip should be needed
by the patternmaker.

## What the user does in GRAV

1. Draw or draft scaled pieces with curves, grainlines, notches, allowances,
   cut and sewing lines, and any required internal construction paths.
2. Identify every piece's role, cut quantity, layer and boundary finish.
3. Confirm which edges sew together, their direction, matching points and
   intentional ease. State operations such as folds, darts, plackets and
   attachments instead of asking the renderer to guess them.
4. Arrange the panels around a selected, measured avatar in a stated pose.
   Confirm fabric properties and whether a front opening is open or fastened.
5. Save the pattern revision, run the drape, inspect it from fixed front,
   back, side and detail views, and correct the 2D construction if necessary.

Unknown or unsupported construction is a **stop**, not a plausible-looking
guess. GRAV should name the missing input or unsupported operation and keep
the incomplete 3D from approval.

## Responsibility boundary

| GRAV owns | A cloth-physics engine may own |
| --- | --- |
| Pattern geometry and units; construction and stitch decisions; seam partners; panel placement; closures; avatar and fabric identity; immutable revision and provenance; quality gates | Physical settling of an **already assembled** garment on the **same** avatar: gravity, bending, collision, natural folds and motion |

Blender is only a possible engine for the right-hand column. It must **not**
choose seams, sew loose panels, invent a pattern, or silently change garment
dimensions. The existing architecture decision runs the solver in a browser
Worker; adding a Blender stage would require a recorded architecture change
and a reliable in-app/server handoff. It has not been integrated.

The previous scratch Blender trial gave it separate panels and sewing springs.
That tested the wrong division of labour and its poor image does not establish
whether Blender can improve the flow of a correctly assembled shirt. The
trial is rejected, not a production path.

## First supported garment and later expansion

The **first acceptance target is a woven, button-front shirt**, including
body, sleeves, collar/stand, cuffs and plackets. We are building a reusable
pipeline, but a shared solver does not automatically know how to construct
trousers, jackets, dresses, knitwear or every shirt variation. Each garment
family needs its own construction contract, placement rules, material
behaviour and visual acceptance examples. Do not label “all garment types”
supported until those families pass their own tests.

For the woven shirt, one pattern that happens to work is not sufficient.
Validate both a native-authored baseline and a **materially changed** native
shirt pattern. Imported CLO files may be comparison references, not the
required source of 3D geometry or a substitute for the native workflow.

## Acceptance: what “usable” means

- All required pattern and construction inputs survive save/reopen; an edit
  invalidates only the affected confirmations. The generated job cites the
  exact 2D, avatar and fabric revisions.
- Physical scale and piece perimeters agree with the saved 2D. Seam lengths,
  stations and direction match the stated sewing map; no seam is silently
  omitted or paired to the wrong edge.
- The shirt is on the selected body without detached pieces, inverted panels,
  body penetration, collapsed sleeves, broken collar/cuffs, or an unintended
  open front. Cloth has believable folds and surface appearance, not a rigid
  shell or merely smooth-shaded broken geometry.
- Stability, strain, collisions, seam gaps and surface quality pass numeric
  checks **and** a person accepts high-quality front/back/side/detail images.
  Low-poly or wireframe diagnostics remain available but are not the approval
  view. A visually broken garment fails even if the numbers pass.
- Repeat the complete check after a meaningful pattern edit. A changed 2D
  must produce a correspondingly changed 3D without altering the old revision.

## Current evidence and next gate

Native revision creation, several construction confirmations, readiness
refusals and an app-side drape path exist in the working tree. They do **not**
yet prove a usable woven-shirt result. The current native pilot is a crude
diagnostic pattern, and the 120-frame Blender scratch views still show
collapsed sleeves and collar. A corrected left-armhole mapping now makes its
starting gap symmetric with the right; that does not fix the appearance.

The immediate handoff check also shows why Blender cannot yet be asked to do
physics only: after GRAV's full placement-and-sew stages, the native pilot has
a **98.9 mm worst underarm gap**. Naively welding nearest seam vertices would
create **2 degenerate faces**. A garment with those gaps is not an assembled
input for cloth finishing. The next gate is to close and validate the shirt's
construction **in GRAV**, produce sound joined geometry on the same avatar,
and only then compare a physics-only Blender finish against the best in-app
result. Until that gate passes, keep the earlier better preview available and
do not ship the Blender prototype as an improvement.
