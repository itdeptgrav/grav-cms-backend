# Native R&D pattern → construction review → drape

**6 Oct 2026 checkpoint.** Product decision:
`docs/decisions/rnd-native-pattern-authoring.md`. This task is separate from
the IE Development writing brief and from unrelated CMS work in the shared
checkout.

## Shipped in this working tree; not yet a finished 2D-to-3D feature

- A native, named, empty root draft may be created for a style without a DXF.
  Its origin is `native-authoring`; the root is immutable, has no fake source
  file, and is explicitly not render-ready. Repeating a creation attempt with
  the same key returns that root.
- A drawn piece saves as a child draft through the existing editor-save route.
  The root remains unchanged and the child still has no imported source.
- The production R&D workspace links to a 2D authoring page; that page can
  create a root or open a saved revision. The existing editor now accepts an
  empty root. Its first freehand click and Escape handling were corrected.
- Native patterns can now draw a two-point internal path and explicitly mark
  it as a dart, pleat, fold, topstitch, placket, pocket attachment, decoration,
  or reference-only. The choice, confirmation, reason and exact path persist
  on save. The same readiness check used by the screen and render endpoint
  refuses unresolved native paths, and refuses operations the solver cannot
  actually perform; a confirmed reference-only path needs an explanation.
  This is a safety gate, not an implementation of those operations.
- Geometry edits now clear inherited boundary-finish confirmations on the new
  revision. In the editor, an outline/edge edit also returns seams touching
  that piece to `needs-checking`; a mere piece rename does not. A changed cut
  edge therefore cannot inherit a previous approval-looking seam/boundary
  statement without being reviewed again.
- Verification: backend focused persistence/route suites 96/96; frontend pure editor
  and persistence suites 139/139; frontend transpiled JSX UI suite 26/26.
  Frontend JSX syntax check passed. A browser walkthrough has not yet been done.

## Next sequential implementation tasks

1. **Construction review UI:** surface every boundary and internal path for
   confirmation. Ask only unresolved questions. Require piece role/cut count,
   cut-versus-sew line and allowance, seam partners/direction/notches/ease,
   opening/hem finish, panel layer and initial avatar placement. Reuse the
   existing Pattern & Fit body and fabric inputs instead of creating a second
   settings store.
2. **Solver support for confirmed operations:** implement only operations the
   simulation can actually carry. The current gate refuses all active internal
   operations; do not downgrade them to reference-only just to get a drape.
3. **End-to-end woven-shirt exercise:** author one shirt pattern in-app,
   complete the manual review, save, drape, and visually inspect front/back/
   sides plus collar, placket, cuffs and sleeves. Repeat with a changed shirt
   pattern. A numerical pass is not a visual pass.

No claim of a usable woven-shirt converter is made at this checkpoint.

## Live drape check and save-path correction — 6 Oct 2026

The current `/dev/fit-real` harness uses the **imported CLO `tshirt.dxf`**,
not a pattern drawn in the native editor. Its original Draft preview visibly
has an open/pleated right armhole; geometry reports two failures, including a
cut edge compressed to 53%, and shoulder/neck seam means exceed the 6 mm
target. The derived +20 mm body-length copy also responds to the changed 2D
outline, but is worse: four geometry findings, one surface finding, 40% worst
edge compression, and 0.50 mm/frame motion rather than a settled drape.
Neither is a usable or approved 3D result, and neither validates the woven
shirt goal.

The browser runner now sends geometry and surface findings to the backend.
The backend stores and reads both verdicts, withholds dimensional findings and
marks a failed-geometry/surface result `partial`, while preserving the visual
preview for diagnosis. It also accepts a *confirmed* `as-imported` sewing-line
source, already produced by the simulator and allowed by the model schema.
Focused verification: 32 backend drape tests and 23 frontend runner tests pass.

The production 2D editor no longer starts a browser-owned render job that it
cannot itself solve. Its saved-revision handoff opens Pattern & Fit on that exact
revision, where the construction setup and browser solver live; unsaved edits
cannot be handed off. Setup remains accessible even when readiness currently
refuses a drape. The editor's standalone harness retains its simulated preview
contract for tests. Frontend editor UI checks pass 27/27 and the changed route,
workspace shell and editor compile in the focused JSX syntax check.

## Explicit body and fabric review — 6 Oct 2026

Native-authored revisions now refuse a drape until a person explicitly confirms
the selected avatar/measurements and fabric profile. These are separate,
attributable server stamps. Editing a body or fabric value invalidates its prior
stamp; the setup screen clears the corresponding check as soon as the user edits
it. Imported DXF setup retains its previous behavior. Confirmation does not
turn a preset into measured fabric or prove that the drape looks right. Focused
backend persistence tests pass 72/72, including confirmation invalidation; the
changed setup panel passes a JSX build check.

At that checkpoint, panel arrangement was still missing. Construction-operation
support for a woven shirt and native baseline/changed shirt visual validation
remain missing. The imported CLO tee harness is not evidence for those.

## Explicit starting arrangement — 6 Oct 2026

Each simulated native panel now needs a person-confirmed starting body slot and
base/outer layer on the saved piece plan. The server checks that the slot is
compatible with the role, refuses unconfirmed or duplicate left/right pieces,
and drops a confirmation if the role, slot or layer changes. Editing the panel
outline also clears the inherited placement review. The shirt assembler now
reads the saved slot to choose sleeve arm, cuff wrist and pocket chest side;
outer panels start 4 mm farther from the body. The setup screen exposes these
choices for native patterns; imported DXFs remain explicitly labelled as
template-estimated rather than pretending they were reviewed.

This is an initial-placement contract, not a solved woven-shirt drape. It still
needs browser inspection on an authored baseline and an altered shirt, and the
unsupported active construction lines (for example plackets and darts) remain
hard refusals rather than being silently ignored.

## Construction semantics reach the solver — 6 Oct 2026

The editor document already persisted internal paths and their classified
operations, but its projection into the pattern set discarded `lineId`,
`operation`, confirmation, note and provenance. The Mongoose pattern-set schema
also discarded those fields. Thus the 3D side could see only a polyline and
could not distinguish a placket from a dart or a harmless reference mark.

The projection and schema now preserve those fields, and the raw 3D reader
carries them in millimetres without mutating the original outline. Direct
assembly refuses an unreviewed or unsupported active operation instead of
silently omitting it if a caller bypasses server readiness. Focused backend
editor persistence tests pass 73/73; frontend raw/mesh/solver tests pass 45/45.

This is **data integrity and refusal**, not operation support. The next
implementation must make at least the chosen woven-shirt operations real in
the cloth constraints and viewport; only then may readiness allow them. A
native-authored baseline and altered woven shirt still need end-to-end visual
validation before the goal can be marked complete.

## Native editor-to-drape handoff check — 6 Oct 2026

A focused persistence regression now starts from an empty `native-authoring`
root, saves five synthetic outlines through the same editor-document route as
the in-app 2D maker, records the panel/seam/body/fabric confirmations, and
checks that the saved child is render-ready with **no source DXF**. The root
remains empty and immutable. The focused editor-save suite passes 74/74.

This proves the *data handoff*, not the requested woven-shirt appearance: its
small regression outlines are shirt-like test geometry, not a complete
button-front/collar/cuff pattern drawn by a person in the UI. The current
`/dev/fit-real` visual harness still uses an imported CLO tee. Next, the
native path needs a genuine two-front woven shirt authored in-app, saved as
baseline and changed revisions, then draped and inspected in front/back/side
views; a readiness pass alone is insufficient.

As a solver diagnostic, the same small four-panel synthetic outline with a
stated woven fabric was assembled on the A-pose and moved to standing neutral.
It **settled** in Draft (about 5 seconds), but the result was correctly marked
`partial`: six geometry findings and three surface findings, including a
pleated right shoulder/side/armhole, two collapsed sleeve openings, and a
147.5% maximum edge strain. This is not a native shirt acceptance run and not
evidence that a person-authored pattern looks good. It does prove that merely
passing native readiness and switching the fabric to woven cannot make this
solver output usable; the next experiment must use a real shirt construction
and evaluate the resulting 3D geometry before any approval claim.

## Eleven-panel native-format diagnostic and Blender cloth ablation — 6 Oct 2026

`components/rnd/fit/nativeWovenShirt.fixtures.mjs` now defines a **synthetic**
native-format 11-panel woven shirt (two fronts, back, sleeves, collar stand
and fall, cuffs and plackets) and a +20 mm body/placket variant. It has 14
explicit seam groups, confirmed arrangement, body and fabric, and the 2D
outlines state that they are sewing lines. This is *not* an actual user-saved
pattern, a measured fabric, a validated cut outline, or a production shirt.
`/dev/fit-native-shirt` renders it in the browser for diagnosis only.

The browser Draft baseline took about 81.5 s and returned `partial`, despite
settling: worst mean seam gap 20.2 mm, maximum edge strain 34.9%, and 17
geometry/surface findings. Front/back/side views visibly fail: jagged collar,
knotted sleeves/cuffs, hanging plackets and a folded body. The altered version
also returned `partial` in Node (22.5 mm worst mean seam gap, 32.4% maximum
edge strain and 16 findings). The two different geometry identities prove the
2D change affects the 3D computation, **not** that either 3D is usable.

To test the proposal that Blender handle *only fabric physics* while GRAV keeps
2D authoring, construction review and rendering, a scratch-only Blender 5.2.2
comparison used the exact same baseline and changed **assembled diagnostic
meshes**. The baseline had 2,406 vertices, 4,170 triangles and 250 stitch
links; changed had 2,450 vertices, 4,248 triangles and 254 links. Continuous
anchors were effectively on existing vertices here (mean/max snap error below
0.00003 mm), so the old real-DXF Blender test's 13.35 mm anchor approximation
is not the reason for this particular failure. The collider was a triangle
approximation of the app's **estimated capsule body**, not an actual measured
avatar. Settings were a diagnostic 50 N sewing-force limit, 40 frames and one
neutral cloth material; these are not measured material parameters.

| Native-pattern Blender control | Baseline final seam links | Changed final seam links | Visual result |
| --- | --- | --- | --- |
| With body collision | 0.89 mm mean / 15.51 mm worst | 1.40 mm mean / 35.08 mm worst | Rejected: body folds through itself, collar jagged, sleeves/cuffs knotted, front/back/side not shirt-like |
| No body collision | 0.086 mm mean / 0.63 mm worst | Not run | Rejected: gravity collapses the joined pieces into a crumpled mass |

At frame 1 the baseline's 250 links start **307 mm mean / 765 mm worst** apart.
Blender's sewing springs close most links rapidly, but those large initial
motions and body contact produce bad cloth topology and folds. This isolates a
pre-physics assembly/construction defect: better cloth motion or shading alone
cannot make the current 11-panel setup a shirt. It does **not** prove Blender
could not produce a good drape after correct arrangement, explicit seam topology,
and measured fabric/body inputs. Four-view PNGs and benchmark scripts are in
`/tmp/grav-native-shirt-blender-20261006/`; original imports and production
app data were not touched. Do not integrate Blender as a production solver
based on this rejected result.

The distance is not abstract: at the start, each cuff join averages **549 mm**
from its sleeve hem and the sleeve-underarm joins **396 mm** apart. The first
diagnostic had each placket join about **404–411 mm** from the front opening.
Inspecting the authored runs found a real fixture mistake: each front opening
was walked neck→hem and its placket join hem→neck, but the confirmed seam said
`start-to-start`. Correcting those two fixture seams to `start-to-end` reduced
the initial placket gaps to **90/67 mm** and whole-garment initial mean gap from
**307 to 233 mm**. A fresh Blender/body run still visibly failed: final links
were **1.11 mm mean / 37.02 mm worst**, with a crumpled torso, knotted sleeves
and malformed collar. Thus even a demonstrable construction correction does not
make the current arrangement or physics valid. The earlier Blender table above
is the *pre-correction* comparison; its baseline result must not be presented as
the outcome of the revised seam mapping. Increasing sewing force to bridge the
remaining large gaps more quickly would be another numerically closed but
crumpled construction, not a cloth-quality fix.

Next test: create a *validated, pre-sewn construction state* from the native
panel and seam data without changing the 2D rest lengths. Check orientation,
openings, seam stations, panel-to-body clearance and initial link distances
**before** relaxation. Then compare the same initial state in the browser solver
and Blender. Only if Blender visibly improves a valid initial shirt should the
architecture decision about a headless cloth stage be revisited. The user's
app must remain the place for pattern-making and construction decisions;
Blender would be an invisible physics worker, not a separate user workflow.

## Already-dressed avatar physics control — 6 Oct 2026

The user's explicit clarification was to keep pattern-making/construction in
GRAV and consider Blender for **cloth motion only**. Two additional controlled
checks make that boundary concrete:

1. The shirt template's cuff placement used a fixed standing-arm wrist even
   for an A-pose avatar. It now uses the chosen pose's actual wrist and arm
   tilt. On the synthetic native shirt this reduced each cuff-to-sleeve-hem
   initial mean gap from about **549 mm to 140 mm** without changing any 2D
   rest length. The focused shirt-template suite passes 5/5, including a new
   A-pose/standing-pose wrist assertion. An isolated Blender/body rerun reduced
   the whole initial stitch mean from **233 to 201 mm** and the final worst
   stitch gap from **37.0 to 26.3 mm**, but the front render still shows a
   crumpled torso, malformed collar and knotted sleeve regions. The result is
   **visually rejected**; a smaller gap is not acceptance.
2. `shirt2.glb` and `avatar2.fbx` were imported into a scratch Blender scene.
   The FBX roots needed a 0.1 unit scale to match the GLB's metre coordinates.
   In the static front/back/side renders the CLO-exported shirt is registered
   to the avatar's torso. Its sleeves hang down while the avatar's arms are
   held out in an A-pose, so the sleeve/body poses do **not** match. This is
   an **already-dressed source control**, not a 2D-derived
   result. A bounded cloth test joined 13 visible shirt panel meshes (81,542
   vertices), added the actual FBX body as collider (71,410 faces), pinned
   12,869 upper vertices as temporary supports, and ran 20 Blender frames.
   By frame 20 mean vertex movement was 10.46 mm but the maximum was about
   **1,772 mm**, producing huge flying triangles. The output is visually
   rejected. A topology audit of that joined display geometry found **10,236
   boundary edges and 744 near-zero-area faces** (no edge shared by more than
   two faces). Those are concrete reasons to reject it as an unprepared cloth
   input; the audit alone does not isolate which specific defect caused each
   flying triangle. The GLB's display triangulation and separate panel topology
   cannot simply be given a cloth modifier and called a simulation-ready sewn
   mesh. This control's temporary shoulder pins and 3D rest shape also make
   it unsuitable as proof of native 2D-to-3D conversion.

3. A second **scratch-only** control removed vertices within 0.5 mm and
   degenerate triangles before the same 20-frame cloth test. The mesh shrank
   from 81,542 vertices / 152,634 faces to 31,977 vertices / 64,193 faces;
   mean/max vertex motion was 13.13 / 71.76 mm, so the catastrophic flying
   triangles stopped. It was **still visually rejected**: the shoulder and
   upper-chest render is speckled/broken, the sleeves do not follow the
   avatar's A-pose arms, and topology still has **490 boundary edges and 617
   non-manifold edges**. Such an aggressive merge could also erase intended
   garment layers. This is evidence that Blender can move a prepared mesh
   without exploding, not that this source export is a valid cloth simulation
   mesh or that the native pattern can now drape.

4. The production setup now offers a named avatar pose (standing-neutral or
   A-pose), stores it on the immutable pattern revision, requires it for a
   native pattern, and forwards it through both initial preview assembly and
   the browser worker. Reopening a saved drape rebuilds faces against that
   same recorded pose. Focused worker, runner and readiness tests pass. This
   fixes a real discrepancy: before this change the development harness used
   A-pose while production silently defaulted to standing-neutral. It does
   **not** yet implement the development harness's A-pose-to-standing-neutral
   transition in production; a standing result may therefore still differ.

5. The setup now stores a per-panel avatar-space translation (X/Y/Z in mm) and
   yaw correction (degrees), and requires the operator to preview the current
   unsimulated arrangement on the selected body before the UI allows a panel
   placement confirmation. The assembler applies these transforms to a derived
   3D copy only; an assembly test checks the 2D outline is unchanged. A change
   to the pose, slots, roles, seams or transforms invalidates that preview in
   the UI; the server drops a carried placement stamp if the stored transform
   changes and refuses native panels with missing/out-of-range transforms. A
   body/pose or seam-partner change also clears carried placement stamps even
   when the panel's numeric offset itself did not change. The save screen reads
   back the pose and transform values instead of trusting a 200 response.
   The optional high-detail avatar overlay is shown with a drape only when its
   saved content hash and displayed pose match the setup; otherwise the
   estimated capsule collision body remains the visible reference.
   This is a real control over starting geometry, not yet a successful drape.
   Focused readiness, assembly and save tests pass (including 74 in-memory
   pattern-editor/save tests). Next.js compiled the touched
   frontend code but its full build failed later while prerendering the
   unrelated `/marketing/campaigns/plans` page (`useSearchParams` without a
   Suspense boundary); full-build acceptance is therefore still unverified.

The scratch before/after images and scripts are under
`/tmp/grav-native-shirt-blender-20261006/`. The supplied GLB, FBX, DXF and
app-saved revisions were not altered. The next physics proof must use a
**simulation mesh built from confirmed native pattern panels**, with actual
joined/sewn topology and an initial garment on the avatar, while maintaining
the 2D rest metric and matching garment/avatar arm poses. Only then compare
browser and Blender fabric motion,
folds and fit. Do not substitute the CLO-exported GLB for the generated 3D.

## Native shirt on supplied avatar: Blender collision test — 6 Oct 2026

I imported `avatar2.fbx` as the actual Blender collider, at its independently
verified 0.1 FBX-to-metre root scale, and placed the *native-format 2D-derived*
11-panel diagnostic shirt around it. This run did **not** use the CLO shirt GLB
as the simulated garment. The avatar body has 71,410 faces; the baseline shirt
has 2,406 vertices, 4,170 triangles and 250 seam links. A second run used the
+20 mm body-length pattern (2,450 vertices, 4,248 triangles, 254 links). Both
were rendered before physics and after 20 frames of Blender cloth with sewing
springs, the avatar collision body and an unmeasured neutral cloth preset.

| Run | Final mean seam gap | Final worst seam gap | Mean/max vertex movement | Visual judgment |
| --- | ---: | ---: | ---: | --- |
| Baseline | 2.73 mm | 43.79 mm | 257 / 782 mm | **Reject:** torso collapses away from avatar; armholes/sleeves knot |
| +20 mm body length | 2.57 mm | 49.22 mm | 280 / 863 mm | **Reject:** same failure |

The initial render is not an already-worn, pre-sewn shirt: its front opening,
shoulders, sleeve and cuff pieces are separated in space. Exact initial seam
measurements on the baseline identify why the sewing stage receives a violent
task: both underarms average 396 mm apart, right side 286 mm, shoulders
260–268 mm, neck stand 248 mm, and cuffs 140 mm. Blender can pull most links
close, but this motion yields a crumpled, exposed torso rather than a wearable
shirt. A small *mean* seam gap therefore does not prove correct topology, panel
orientation or drape. The 2D pattern change altered the mesh but did not fix
construction. Front/side/back before-and-after PNGs and the scratch-only test
script are under `/tmp/grav-native-shirt-blender-20261006/` as
`native-*-actual-avatar-*.png` and `native-avatar-test.py`.

This validates the user's proposed division of labour as a **testable route**,
not as a completed feature: GRAV should still author and assemble the shirt;
Blender can be evaluated for subsequent fabric motion only after the shirt is
actually pre-sewn and dressed on the avatar. The next gate is a visually
shirt-like, non-interpenetrating frame-zero assembly with bounded seam-partner
distances and matched sleeve/avatar pose. Do not increase sewing force or
integrate this rejected Blender result into production.

## Construction diagnostic and sleeve ablation — 6 Oct 2026

The placement preview now reports interpolated starting distance for every
confirmed seam, ordered by mean gap, with the seam name, panel refs and worst
station. These are explicitly **pre-simulation** distances, not a fit score.
Selecting a row highlights a related panel. The calculation reads the assembled
3D copy and cannot write to the 2D revision. A focused test checks exact
anchor interpolation and the 11-panel shirt; the touched Next.js screen
compiled, though the full build still fails later on unrelated pages using
`useSearchParams()` without Suspense.

The 11-panel synthetic fixture contained another real construction error. Its
two underarm runs on each sleeve are walked in opposite directions (hem→cap
and cap→hem) but had been confirmed `start-to-start`. Correcting the fixture
to `start-to-end` reduced each underarm's initial average distance from about
396 mm to **193 mm** with the existing cylindrical placement. It did **not**
make the Blender/actual-avatar result wearable: at frame 20 the corrected
control still showed an exposed chest, irregular shoulders and folded panels
(46.85 mm worst seam station; 183/558 mm mean/max vertex movement). This
control is `native-baseline-seamfix-actual-avatar-*` in the scratch directory.

A separate scratch-only **isometric cone-unroll** experiment used the tapered
sleeve's own side edges to derive a 29.86° planar sector. It brought both
underarm starting gaps to numerical zero, without altering the 2D pattern.
However, 188 sleeve vertices started inside the app's estimated capsule body,
up to 37.5 mm deep. With the supplied FBX collider, both baseline and +20 mm
body-length variants still visually failed after 20 Blender frames: exposed
torso, tangled armholes and bunched sleeve areas. Their worst final seam
stations were 24.07 and 38.09 mm respectively. The cone is **not** integrated
into production: a low underarm gap is insufficient when avatar clearance and
front/back/shoulder placement remain wrong. Images and experimental code are
`native-*-cone-actual-avatar-*.png` and `cone-sleeve.mjs` under the same scratch
directory. The next geometry work needs a valid pre-sewn torso and avatar
clearance, then sleeve-to-armhole mapping, before any cloth-solver choice can
be evaluated on appearance.

The seam-distance readout also exposed two more crossed correspondences in the
same synthetic fixture. Right side was paired hem→underarm against
underarm→hem, and right shoulder outer→neck against neck→outer. Both are now
`start-to-end`. The corrected initial side-seam means are symmetric at about
118 mm each, and shoulder means are symmetric at about 260 mm each. The whole
starting mean is still about 151 mm, so this fixes confirmed construction
errors but does not make the frame-zero torso sewn or wearable. Focused
placement/template tests pass 9/9 after these fixture corrections.

## Sparse shoulder contact versus whole-panel clearance — 6 Oct 2026

The next assembly probe isolated a second, independent failure. Before avatar
clearance, both native shirt side seams start at **0 mm** gap. The old clearance
loop moved each *entire* front panel outward **66.2 mm** and the back **40.2 mm**
to resolve only 3 of 329 vertices per front and 6 of 649 on the back, all near
the arm/shoulder. This opened both full-length side seams to **117.7 mm** and
raised the overall mean starting seam distance from **79.8 to 150.9 mm**. The
reported placement spot was also stale: it still said radius 178.3 mm when the
mesh actually used 244.4 mm on the fronts and 218.5 mm on the back.

The adapter now reports the actual post-clearance spot. For a torso panel with
at most 1% of vertices penetrating and depth at most 36 mm, it records a local
contact rather than displacing the whole panel; pervasive/deep intersections
still take the whole-panel path. On the native shirt this keeps side seams at
0 mm at assembly and about **0.15 mm after 12 held placement frames**, while
all front/back vertices clear the estimated avatar. The shoulder seam means
fall from 260.4 to 154.0 mm; the overall starting mean is **116.5 mm** because
sleeve, collar and cuff clearance still create large gaps. Focused tests pass
10/10, including held-stage avatar clearance and side-seam preservation.

Scratch Blender comparison on the supplied `avatar2.fbx` was rerun for the
baseline and a +55 mm body-length variant. The initial Blender process crashed
on Metal startup under the restricted executor; rerunning the same installed
Blender outside that restriction succeeded. At frame 20, baseline mean/worst
seam gap is **2.20/40.32 mm**, vertex movement **159/393 mm**; changed length
is **2.67/41.21 mm**, movement **154/308 mm**. The torso now visibly hangs as a
shirt rather than collapsing into scraps, but both are **rejected**: open
front, irregular collar, and crumpled sleeves remain. Images are
`native-*-local-clearance-actual-avatar-frame20-*.png` in the scratch folder.
These are short diagnostic Blender runs, not a settled in-app 3D result. Next
work must solve front/placket closure and sleeve/armhole placement, then render
a settled baseline and changed pattern before calling this usable. The scratch
Blender test still has **sewing springs enabled** to expose seam behaviour; it
does not yet satisfy the desired final division of labour. GRAV must hand
Blender an already-sewn, avatar-dressed mesh so Blender handles cloth motion
only, while all pattern and stitch decisions remain in GRAV.

## Split-front closure decision and fasteners — 6 Oct 2026

The native fixture had two independent shirt fronts and a placket attached to
each, but **no instruction joining one placket to the other**. A 120-frame
Blender run did not settle that away: the front remained open, the shoulder and
collar were ragged, and one sleeve hung wrongly. This is a missing construction
decision, not a fabric-stiffness setting.

The setup now asks explicitly whether a split woven front is worn open or
buttoned. A buttoned choice names the two placket panels and an ordered list of
button positions in millimetres below their tops; a server-side confirmation
stamp is tied to those exact values. The readiness gate refuses a missing
decision, unmatched plackets, unordered/out-of-range stations, or an unstamped
choice. The 3D adapter turns valid stations into **point fastener constraints**
on a derived mesh; it does not sew the whole opening closed or edit the 2D
revision. The physical buttons, buttonholes and placket layering are still not
modelled, and the screen/template warning says so.

On the synthetic baseline and +55 mm body-length variant, six confirmed
fastener stations assemble with zero initial gap while the 2D records stay byte
identical. Backend readiness tests pass 56/56; persistence tests with an
isolated in-memory MongoDB pass 75/75, including confirmation expiry when
stations change; focused frontend tests pass 19/19. A scratch Blender run
approximated each weighted fastener by its nearest mesh vertex (Blender's
sewing-spring constraint is vertex-to-vertex) and was inspected at 120 frames:
the front closes. The reported worst sewing-spring gap changes from 45.84 mm
in the open control to 24.16 mm, though that is not a like-for-like seam set
because the buttoned run adds six links. **Still reject:** both sleeves and the collar remain
distorted, and the Blender scratch test still sews pieces instead of receiving
an already-sewn GRAV garment. The tested image is
`/tmp/grav-native-shirt-blender-20261006/native-baseline-local-clearance-buttoned-actual-avatar-frame120-front.png`.

## Compound armhole walk and Blender control — 6 Oct 2026

The native pilot's left compound armhole walked the front from underarm to
shoulder, then incorrectly restarted the back at its underarm. Its mean/worst
starting gap was **178.4/353.0 mm**, whereas the symmetric right armhole was
**157.1/171.7 mm**. The back's explicitly reversed armhole run now continues
from shoulder to underarm. Left and right both measure **157.1/171.7 mm** at
assembly; the focused closure and seam tests pass **6/6**. This fixes a
confirmed construction-map error, not the cloth appearance.

The corrected 120-frame Blender scratch run was rendered at 1400 px with
smooth shading, using first the supplied `avatar2.fbx` and then the *exact*
capsule body used by the app's pattern placement. Both remain visibly
unacceptable: sleeves collapse beside the arms and the collar crumples. The
FBX run's mean/worst sewing-spring gap is **1.47/20.35 mm**; the matching-body
control is **0.52/18.28 mm**. Thus avatar mismatch contributes, but removing
it does not make this construction wearable. The matching-body control is
`/tmp/grav-native-shirt-blender-20261006/native-baseline-local-clearance-buttoned-actual-avatar-frame120-front-smooth-proxy.png`.

**Decision:** do not integrate this Blender prototype or describe smooth
shading as a drape improvement. It still gives Blender separate panels with
sewing springs, contrary to the intended division of labour. GRAV must resolve
construction and deliver an already-assembled garment on the *same* avatar
before a controlled Blender-physics-only comparison can show whether Blender
adds useful cloth flow. The native pilot's straight, rectangular armholes and
straight sleeve caps are also a crude diagnostic pattern, not evidence that a
real woven-shirt sleeve can be generated automatically from arbitrary pieces.

## GRAV-only assembly handoff probe — 6 Oct 2026

To test the intended responsibility boundary, a scratch probe ran the native
pilot through GRAV's own placement, sewing and settling stages. Blender was
used only as a static, smooth-shaded renderer of the resulting positions; it
performed **no sewing or cloth simulation** in this comparison. This is not a
production integration or an accepted garment.

| Placement | Worst seam station after GRAV stages | Underarms | Visual result |
| --- | ---: | --- | --- |
| Current cylindrical sleeve placement, place + sew | 98.9 mm, right underarm | Both sides have nearly 100 mm local openings despite a 2.85 mm mean across all 250 stations | Rejected: open sleeve underside and distorted shirt |
| Scratch isometric cone sleeve placement, all five stages | 24.2 mm, collar stand to neck | Left worst 1.3 mm; right worst 2.5 mm | Rejected: ragged collar and shoulders, front gap, speckled sleeve surfaces |

The scratch cone changed only initial sleeve placement; the same GRAV solver
and 2D pilot were used. It demonstrates that the large underarm opening is
placement-sensitive, but it does **not** validate the cone as a general shirt
rule. The final cone result has 0 garment vertices inside the avatar and
0.75% mean / 11.35% worst measured edge strain, yet still looks broken. Its
collar stand has a 4.05 mm *mean* gap but a 24.2 mm **single-station** gap;
each shoulder also has a local gap of about 18–20 mm. Averages alone would
misrepresent the assembly.

The probe also tried a nearest-vertex seam weld solely to test whether GRAV
could hand off a topologically joined mesh. That naive operation makes two
degenerate faces in both placements. Do not export such a weld as an
assembled garment. The next work is to identify the collar/shoulder endpoint
and topology errors, introduce a proper seam-joining representation, and
make local seam failures explicit in model health. Only then run a
physics-only finishing comparison on an already-assembled garment. The
baseline **and changed native shirt** still need visual acceptance.
