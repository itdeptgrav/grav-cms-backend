# CLO-guided woven-shirt calibration

Status: **native piece ownership resolved; sewing-line geometry and generated
shirt still unverified** (5 October 2026).
User priority: shirt before T-shirt. This replaces the T-shirt as the first
calibration target without deleting the earlier T-shirt source audit.

## Active delivery goal and stop condition

Deliver a **usable woven-shirt 2D-to-3D workflow** in the R&D app, using the
five supplied `shirt2` files as the first reference set. Do not label a drape
"ready", "accurate", or "approved" merely because seam distances or tests
pass. Keep the uploaded DXF, GLB, ZPRJ, metadata and avatar unchanged; the
generated mesh must come from the 2D pattern, not from the finished GLB.

This goal is complete only when all of the following are evidenced on the
same generated revision:

1. A construction manifest accounts for all 38 native path pairs, explicitly
   distinguishing outer joins, interior attachments, same-piece paths and
   piping/trim. Every constraint sent to the solver has verified ownership,
   direction, sew-line position and a reproducible source reference. Missing
   required construction blocks draping instead of silently yielding a
   partial shirt.
2. The 13 DXF panels assemble without inverted/misplaced cuffs, unattached
   small panels or crossing seams. Mid-edge anchors work where CLO's seam ends
   do not coincide with DXF vertices. No reference GLB vertex positions are
   used as placement or correction targets.
3. The actual avatar's scale, pose and transform are verified against the
   supplied shirt source; fabric choice and its provenance are shown. Unknown
   seam allowance or fabric parameters are presented as assumptions, not as
   measurements from CLO.
4. Fixed front, back, left and right renders, plus collar, placket, armhole,
   cuff and hem close-ups, are visually compared with the CLO reference.
   Reject serrated collars, collapsed openings, detached panels, severe
   pleats/penetration and asymmetric construction even if numeric gates pass.
   Save the evidence and show the user the actual generated views.
5. Numeric checks on seam closure, pattern-edge strain, self/body collisions,
   open boundaries, settling and determinism pass. At least one changed shirt
   pattern is tested after freezing parameters to establish that this is not a
   one-file imitation. This is not a promise that every future shirt is perfect.

Current result: **not complete**. The corrected cuff hand is one demonstrated
improvement, but the generated Draft still fails the visual and construction
conditions above. The next implementation gate is construction completeness,
starting with exact mid-edge seam anchors and six interior attachments; do not
resume fabric-constant tuning before those are represented.

## Supplied reference set

- `shirt2.dxf`: AAMA file, size M, inches (25.4 mm per drawing unit), 13
  closed named pieces including front plackets, body fronts/back, collar
  stand and sleeve components. The file does not publish a separate AAMA
  layer-14 sewing line, so seam allowance is **unknown**, not zero.
- `shirt2.glb`: CLO Standalone export. Each of the 13 DXF names has a mesh.
  The two body-front meshes each include one internal opening; the outer
  boundaries match the corresponding DXF outlines once those openings are
  treated separately. All 13 pieces pass the source outline check. The
  largest selected outer-outline deviation is about 3.77 mm on each of the
  two main sleeve pieces; the body-front outer outlines are below 0.3 mm.
  For the source surface's 0.5–40 mm triangulation edges, median 3D/flat
  length ratios are 0.999–1.005 across pieces; mean absolute deformation is
  0.14–1.55%. These are properties of CLO's supplied *finished* reference,
  not results from our solver or a tolerance to approve any future drape.
- `design02_meta_data.xml`: 38 seam-line pairs, two physical-property records
  (`Cotton_Sateen_0`, `Linen_0`). Every named pattern mesh's GLB material
  matches the sateen record. The linen record appears in the export but is
  not assigned to one of the 13 named DXF pattern surfaces; it must not be
  silently substituted for them. The XML declares `design02.glb`, whereas
  the supplied file is named `shirt2.glb`; geometric correspondence is strong,
  but the rename/provenance should be confirmed before treating the native
  project as an exact source package.
- `shirt2.zprj`: native CLO project. It has a CLO header followed by a ZIP
  payload; that payload contains `design02.zpac`, itself another CLO-header +
  ZIP payload. The inner package contains `design02.pac` (binary garment
  construction data), `design02.pos`, the avatar and assets. The ZIP structure
  is readable, but the `.pac` construction records are still proprietary
  binary and have not been decoded. No source data was written back to it.
- `avatar2.fbx`: binary FBX with 70 of 70 body-bone names matched to the GLB
  skeleton. Applying the GLB bone transforms to the FBX produces a plausible
  common pose (left/right mid-arm centers about +207/−209 mm from center), but
  this is not yet a proven registration. A preliminary triangle-body contact
  probe sampled about 300 outer-face vertices per named garment piece: most
  panels had no >2 mm penetration, whereas the collar stand had 146 of 328
  samples >2 mm inside (deepest about 20.7 mm) and the back had 13 of 302
  (deepest about 15.4 mm). Check coordinate/sign conventions and the precise
  neck pose before using these numbers as a fit judgment.

Run the read-only target audit with:

`node scripts/audits/rnd-clo-calibration-source.js <shirt2.glb> <shirt2.dxf> <design02_meta_data.xml> shirt`

It reports 13 matched pieces, 38 seam pairs, no unmatched pattern materials,
and hashes the source bytes. Its `readyForParameterTuning` gate remains false:
the XML `MeshList` is empty and no stitch path has yet been assigned to a
verified piece edge. It does **not** run a drape or make a fit claim.
This source-only report does not read the nested native `.pac`. The separate
native ownership probe below resolves the **piece names**, but does not change
this report's readiness gate or establish the actual sewing-line geometry.

A second read-only probe, `scripts/audits/rnd-clo-seam-candidates.js`, tests
each XML index path against actual GLB surface-boundary edges and ranks piece
pairs by mean 3D gap in the finished CLO export. On this shirt, **23 of 38**
seam pairs have one candidate with <2 mm mean gap, <1.1 cut-length ratio and
>5 mm separation from the runner-up. The remaining **15** (pairs 13, 14, 16,
17, 18, 19, 20, 23–29 and 34) are unresolved: several are duplicated or
symmetrical, two have no outer-boundary candidate, and others may use an
internal sewing line or offset edge. These are *candidate identifications*,
not verified sewing instructions; no solver consumes them yet. The finished
GLB cannot be used to place a newly generated garment.
Five repeated XML path signatures occur at pairs (13,14), (20,26), (23,27),
(24,25), and (28,29). These are not duplicate records to discard; the native
piece IDs below distinguish their owners even when local point numbers repeat.

The nested native `design02.pac` adds a useful ownership clue. A read-only
probe (`scripts/audits/rnd-clo-native-seam-markers.js`) confirms that all 38
native path arrays match the 38 XML pairs exactly after converting PAC's
zero-based indices to XML's one-based indices. **30 records carry a `Sewing`
name marker; eight (1–7 and 38) do not.** Only **15 of the 30 marker-bearing
records** have a unique source-mesh candidate under the threshold above; the
other 15 remain unresolved. A marker is evidence, not yet proof that every
marked pair is a structural constraint or that every unmarked pair is purely
decorative. Do not use 23/38 as a construction-completeness percentage.
Every native record also refers to two distinct `Topstitch` names, including
the 30 records with a `Sewing` name. Thus “has a topstitch reference” is **not**
an exclusive classification. The PAC probe now reports both reference types
per record, but this marker-only probe still cannot assign either stitch path
to a cut-piece owner. The later native-ID cross-check can.
Conversely, native records 1–7 have **no** `Sewing` name yet map to close
cut-piece joins, including `Collar_Stand→Body_Back_1` and front-to-back
panel joins. Filtering out all eight records without a `Sewing` marker would
discard apparent construction seams. The name marker is not a safe
structural/decorative switch in either direction.

The GLB also has **41 auxiliary meshes** outside the 13 DXF cut pieces. A
separate diagnostic candidate pass finds pairs **16 and 17** within 1.1–1.2 mm
of `Collar_Stand` ↔ `PipingPattern_981982`, and pairs **18 and 19** within
1.1–1.3 mm of `Collar_Stand` ↔ `PipingPattern_990999`. Those four do not map
cleanly to two cut-piece outer boundaries because one side is auxiliary piping
geometry. They are still not classified as a construction requirement; if the
shirt needs visible piping, it needs an explicit trim model rather than a
fabric seam invented between two DXF cut pieces.
The geometric probe alone leaves pairs (20,26) ambiguous between the two
front/sleeve sides, (23,27) ambiguous between the two sleeve joins, and
(13,14) ambiguous at the overlapping front/placket layers. The native local
piece identifiers below resolve these *owner names* without choosing the
first close mesh. Pairs 24/25, 28/29 and 34 still lack a near-coincident
unique cross-piece cut-boundary match.
An internal-edge check against actual triangles leaves (13,14) with two
virtually coincident alternatives: `Body_Front_1→Body_Front_2` and
`Body_Front_1→Body_Front_Placket` (both about 0.1 mm; cut-length ratios
1.004 and 1.006). A read-only coloured front render of the CLO GLB confirms
that the front panel and placket visibly overlap, so proximity cannot settle
that choice. For pair 34, a loose vertex-index probe finds
`Pattern_1302624→Body_Front` at about 0.3 mm, but the indexed path is not
verified as a connected mesh edge; this is **not** a sewable path. Pairs 24/25
and 28/29 also show near-coincident *auxiliary stitch mesh* vertices under a
loose probe, but no valid near-coincident cut-piece edge. Do not turn any of
these loose coincidences into solver constraints.

### Native piece ownership — new verified step

Run the read-only cross-check with:

`node scripts/audits/rnd-clo-seam-ownership.js <extracted-design02.pac> <shirt2.glb> <shirt2.dxf> <design02_meta_data.xml>`

Each PAC seam record has two `uiSelfIndex` local piece identifiers. For the
23 uniquely matched geometric pairs, each identifier consistently maps to
one GLB mesh name; conflicting anchors are rejected. Applying that mapping
to the previously ambiguous *close* alternatives resolves the six repeated
front/placket and left/right pairs, then four collar-to-piping pairs anchor
two auxiliary piece identifiers. The resulting report identifies **both
named owners for all 38 of 38 records**:

- Pair 13 `Body_Front_1→Body_Front_2`; pair 14
  `Body_Front_1→Body_Front_Placket`.
- Pair 20 `Body_Front_2→Sleeves_3`; pair 26 `Body_Front→Sleeves_4`.
- Pair 23 `Sleeves_2→Sleeves_3`; pair 27 `Sleeves_1→Sleeves_4`.
- Pairs 16/17 join `Collar_Stand` to auxiliary
  `PipingPattern_981982`; 18/19 join it to `PipingPattern_990999`.
- Pairs 24 and 25 have both paths on a single sleeve piece
  (`Sleeves_1` and `Sleeves_2`, respectively); 28 and 29 likewise both
  belong to `Sleeves_4` and `Sleeves_3`. They must not become cross-panel
  sewing constraints merely because the XML calls them seam pairs. Direct
  vertex-paired distances in the CLO GLB round to 0.0 mm for these four
  records, although their two paths use distinct local indices; the short
  pair paths are 28.2/28.3 mm and the long paths 474.4/483.0 mm in flat UV.
  That is evidence of coincident within-piece stitch/fold paths, not proof of
  the manufacturing operation intended.
- Pair 34 belongs to `Pattern_1302624→Body_Front`; ownership is known, but
  its indexed geometry is still not a verified sewable edge. The paths are
  each 25.4 mm in flat UV and about 0.3 mm apart in the finished GLB, but
  the body-front path is not a connected triangulation-edge chain. It may be
  an internal attachment; the DXF/solver must explicitly support it rather
  than pretending it is an outer-edge seam.

The GLB-edge evidence alone reports 29 near-coincident boundary pairs, but
**five of those are internal front openings**, not DXF outer cuts. The
ownership audit now projects *every indexed 2D path point* onto the matched
DXF outline rather than trusting GLB boundary status. Its corrected breakdown
is **24 cross-piece pairs on both outer cuts, 6 small-panel-to-front interior
attachments (pairs 33–38, including one path without a connected GLB edge),
4 auxiliary-piping pairs and 4 same-piece sleeve paths**. All points along
each of the 24 outer-cut pairs are within 0.3 mm of the DXF cut outline;
the front-side paths of the five GLB-boundary interior attachments reach
29.6–120.1 mm *inside* that outline. This is an ownership/location result,
*not* 24 approved structural seams or a finished assembly map. The
order/direction of stitches, interior attachment semantics, allowance, folds
and seam type remain to be checked before simulation.
The four collar-to-piping boundary pairs have 1.1–1.3 mm direct gaps in the
CLO reference and 236–246 mm flat path lengths. Their reverse-order gaps are
over 90 mm, confirming path direction for that trim relationship; it still
does not make those auxiliary meshes part of the 13 DXF cut-piece assembly.

The six interior front attachments are **not absent from the DXF**. A new
read-only nearest-internal-line check compares each native indexed GLB UV path
against every published DXF internal line after the same piece registration
used by the outer-outline audit. Pairs 33–35 on `Body_Front` and 36–38 on
`Body_Front_2` each have one matching internal line: line index 2 (zero-based),
a closed 304.8 mm rectangular path. Maximum source-path distance to that
line is **0.00436 mm** on all six pairs; the next-nearest line is at least
about 91 mm away at its worst point. Their small-panel sides remain on the
small pieces' outer cuts. This resolves *which published 2D internal path*
receives those pieces, but not the operation (attachment, pocket opening,
fold), seam allowance, or solver constraint semantics. The current boundary-
only stitch system cannot consume this line, so the diagnostic still drops
both small panels. Do not replace the missing constraint with visual overlay.
The path lengths and line arcs make the attachment more specific: per front,
one native pair follows a **127 mm long side** and two follow **25.4 mm short
sides** of that 127×25.4 mm rectangle, leaving the other long side unpaired in
these six records. The source-path versus DXF-line arc-length discrepancy is
at most about **0.00436 mm**. Pair 37 travels backward around the mirrored
rectangle; taking every pair as forward would twist that side. This is enough
to specify *where and which way* the six preview constraints should attach,
not enough to infer the manufacturing name or approve a fit result.

### Diagnostic 24-join shirt — rejected, but one placement defect fixed

The native ownership audit now also measures the source path arc against each
DXF outline and the two endpoint orders in CLO's finished GLB. All **24 outer
cut pairs** have a direct-order mean endpoint gap below **0.53 mm** in the
reference. This identifies which ends meet in that source; it does not prove
that our derived placement or stitch line is correct. Pairs **21, 22, 30, 31**
end at the middle of a sleeve-cap DXF segment, **3.59 mm** from its nearest
published outline point. The current editor's point-index-only anchors cannot
represent those four ends exactly. Cuff pairs 23 and 27 are ambiguous by
endpoint position alone because their endpoints meet around a closed opening;
their *full indexed paths* resolve the direction (direct mean gap below 1 mm,
reversed about 61–62 mm).
The segment projection now identifies the shared missing sleeve-cap anchor on
each sleeve as **segment 35, fraction about 0.724915** in the registered DXF
outline. Its source GLB UV point is only about **0.027 mm off that segment**,
whereas the nearest published DXF vertex is **3.590 mm away**. Pairs 21/22
share that anchor on `Sleeves_3`; 30/31 share it on `Sleeves_4`. A preview
that snaps these four seam ends to the nearest point is therefore knowingly
sewing at the wrong location. It needs a segment-plus-fraction anchor (or a
derived boundary vertex inserted there), while keeping the original DXF
unchanged.

A scratch-only mid-edge A/B inserted that verified 0.724915 point into a
**derived** sleeve outline on both sides and remapped the four native run
endpoints. It did not edit the DXF or ship an app change. The 24 joins still
assembled, with 2,081 vertices and no mapping mismatch. Numerically the
severely compressed edges improved **5→4** and the worst edge rose from
**35%→62%** of cut length. Visually the shirt became *worse*: front placket
and right body panel crumpled, and another shoulder join gained a sharp
pleat. The front render is `/tmp/shirt2-mid-anchor-trial-front.png` when that
scratch artifact is present. This trial is **rejected**. It demonstrates that
exact anchors are necessary for source fidelity, but not sufficient to make
this incomplete construction and current solver produce a usable drape.

A **scratch diagnostic only**, never saved as a user revision, assigned 13
pieces their apparent roles and placed only the 24 outer-cut pairs into the
current Draft assembler with cut-boundary sewing. The parser and triangulator
accepted all 13 pieces: **2,075 vertices**, no seam-mapping errors or >25%
pairwise length mismatch, max boundary deviation **0.264 mm**. This tests the
adapter, not the garment. It omits six interior front attachments, four
same-piece sleeve fold/stitch paths and four auxiliary-piping relationships;
it uses an approximate capsule body and a poplin preset rather than the
supplied avatar or measured sateen. The two unattached small front panels
fell more than **12 m** in the diagnostic run, as expected when their six
interior seams are omitted.

The frontend flat-pattern read now preserves **all** imported internal lines
in millimetres, with original source-line indices, instead of retaining only
the lines from which a fold could be guessed. On this source, line index 2 on
each `Body_Front` is still the exact closed 127 × 25.4 mm rectangle; this is
preservation, **not** automatic classification as a cutout or a seam. A tested
triangle-barycentric anchor locates a point on an interior line, and a tested
solver surface-seam constraint can close one such point to another panel
without moving the DXF. These primitives have not yet been connected to the
six source attachments, and no new shirt drape has passed the visual gate.
The mesher now also accepts **explicitly confirmed** construction holes and
retains each inner loop as a free boundary. An arbitrary closed DXF internal
line is still not assumed to be a cutout. The synthetic area/boundary tests
pass; on the real `shirt2.dxf`, explicitly supplying internal line index 2
meshes `Body_Front` as 201 vertices / 274 triangles and `Body_Front_2` as 215
vertices / 304 triangles, each with a 12-vertex opening boundary. The
triangulated fabric area differs from the panel's cut area minus the 127 ×
25.4 mm rectangle by 0.0029% and 0.0055%, respectively. This is a **mesher
capability**, not yet a persisted construction decision or generated drape.
The geometry fingerprint now changes if a confirmed cutout path changes, so a
stored drape cannot be reopened on a different hole shape. A focused regression
test proves that the same outer perimeter with a moved cutout has a different
identity.
Next: record the line classification in the revision's construction manifest,
map each of the six native paths with direction to that boundary, then include
the surface seam data in geometry identity, closure reporting and readiness.

Visual audit **rejected** the first Draft mesh: one cuff crossed the torso,
the front and sleeve were crushed, and the solver reported **73 edges under
70%** of cut length (worst 13%). The traced cause of the crossed cuff was
specific: `templates/shirt.js` placed *both* unnamed cuffs on the left, while
the native seam map joins `Sleeves_2→Sleeves_3` and `Sleeves_1→Sleeves_4` on
opposite arms. An in-memory A/B test put each cuff on its sewn sleeve's arm;
compressed edges fell **73→5** (worst 35%) and the front became visibly more
shirt-like. This was then implemented in the frontend template by reading
cuff→sleeve handedness from the seam map, with conflict refusal and two focused
regressions. The related assemble call now passes its already resolved seams to
the template. Frontend targeted tests: **28 pass, 7 slow skipped, 0 fail**.

**Still not approved:** even after that correction, the Draft result has a
serrated collar and collapsed sleeve openings (reported opening roundness
roughly 6–11% for one sleeve). Five edges remain severely compressed, and
pairs 20 and 26 pleat at the armholes. The small interior panels still fall
because the current seam contract represents boundary runs, not their six
internal attachment lines. This is a bounded technical diagnosis, not a
working 2D→3D woven-shirt feature. The GLB source was never substituted for
the generated geometry, and the uploaded DXF/GLB/FBX/ZPRJ were unchanged.

A second scratch A/B joined each sleeve cap's three native pairs into one
ordered compound armhole seam (front segment then the two back segments),
leaving the same DXF and corrected cuff placement. It reduced the count of
<70% edges **5→2**, but the front render still showed an open/pleated shoulder
and collapsed openings; a shoulder seam also became sharply pleated. Thus a
lower compressed-edge count alone is **not** visual improvement. That compound
mapping was rejected and not added to application code.

The current frontend draper refuses zero seams (`NO_SEAMS`) and explicitly
unsupported mapped seams (`SEAM_UNSUPPORTED`), but it **does not prove every
source seam was mapped**: its real T-shirt test deliberately runs with two
named seams. A partial map could therefore produce a plausible but incomplete
shirt without an error. Before claiming this 13-piece shirt as a generated
preview, classify source pairs as structural sewing versus decorative or
topstitch evidence, then require a complete human-reviewable map of the
structural pairs, including internal lines. Only then render and compare
front/back/side views.
Its production collision body is still measurement-derived capsules
(`components/rnd/fit/solver/bodyCollision.js`), not the supplied FBX triangle
avatar. This is a separate fidelity gap: matching seam lengths on capsules
cannot validate fit around the real avatar's collar, shoulders and armholes.
Do not attribute an avatar-shape mismatch to fabric stiffness.

## Work before a credible generated shirt

1. Verify the FBX avatar's physical scale, pose and transform against the GLB
   garment and native project. Do not optimize garment shape against a
   misregistered body.
2. With owner names and outer-vs-interior locations now identified, classify
   the 24 outer-cut pairs into construction joins and any non-structural
   stitches; separately model the six interior attachments, four within-piece
   paths and four trim/piping pairs. Verify each *path*, orientation and
   cut-vs-sew-line semantics before
   emitting constraints. Confirm placket/collar construction and seam
   allowance; the XML `MeshList` is empty, so the native-ID cross-check must
   remain part of provenance.
3. Add shirt-specific assembly and piece-specific fabric behavior. Measured
   CLO properties are reference evidence; their numeric stiffness/friction
   values cannot be copied into a different constraint solver unchanged.
4. Generate a shirt **from flat DXF** without seeding the finished GLB pose.
   Compare fixed front/back/both-side views and collar, placket, shoulder,
   cuff/hem close-ups with CLO. Test seams, panel strain and body intersections.
   Reject any numerical pass with a visibly broken surface.
5. Freeze parameters, then validate changed shirt patterns from separate CLO
   DXF+GLB+XML triplets. One shirt is insufficient to guarantee every shirt.

The paired GLB remains a reference, not the generated output. The current
R&D draper has **not** passed this shirt's assembly or visual gate.

## Why the supplied GRAV CAD drape is not an arbitrary-DXF importer

Read-only check of the user's `cad.zip` source against the current R&D code
(6 October 2026): `renderer/src/fit3d/garment/SeamGraph.js` recognises
specific pre-labelled CAD group keys, including `Chest`, `Coller`,
`__custom__armhole` and `__custom__sleevecap`. Its
`GarmentAssembler.js` constructs a known shirt arrangement (fronts, back,
sleeves, optional yoke and collar) and its seam graph from those labelled
runs. That is a reusable *parametric shirt family* when those group labels
are present; it is not evidence that an arbitrary AAMA DXF contains enough
recognised semantics to assemble itself. This is first-party GRAV source and
is not being redistributed or substituted for the imported shirt.

The R&D frontend's `templates/index.js` currently maps `tshirt`, `polo`
and `woven-shirt` to the same `shirt` placement. `templates/shirt.js`
uses assigned roles rather than DXF names, which is the right direction, but
still makes heuristic placement/handedness choices for unnamed paired
sleeves. It does **not** import the 38 native `shirt2` operations. The
backend readiness gate checks mapped seams and boundary coverage, but has no
source-operation count to prove that every native operation was represented;
the source-only 38-path manifest still marks each operation
`not-yet-confirmed` and `readyForDrape: false`.

The next implementation contract must be source-driven: persist a reviewed
operation record for each applicable native path, with piece identity, path
geometry/direction, operation type, and cut-versus-sew-line provenance;
represent interior attachments and mid-edge anchors; refuse simulation when
required operations remain unrepresented. A category template may supply
placement rules and validation, but must not invent the seam graph. Test a
different shirt pattern with the template frozen before claiming general
shirt support.

## Six-front-attachment diagnostic (5 October 2026)

The native source resolves pairs 33–38 to the two small front pieces
`Pattern_1302624` and `Pattern_1302626` and closed internal line 2 on
`Body_Front` / `Body_Front_2`. Their direct endpoint pairing averages
0.308–0.319 mm separation in the finished GLB; reverse pairing is
25.3–126.7 mm. The internal-line match is within 0.0044 mm. This supports
the path ownership and direction, **not** an inference that every closed DXF
mark is a hole.

An opt-in diagnostic opened just these confirmed rectangles in a derived
preview mesh and attached all six native pairs at 34 sampled surface stations.
The source DXF/GLB/project files were not modified. The diagnostic assembled
13 pieces, mapped 24 outer joins plus the six front attachments, and ran a
Draft solve with no seam-map exception. The previously detached small front
pieces stayed near the chest. This is progress in construction completeness,
but the generated garment **failed visual inspection**: serrated/collapsed
collar, sharp diagonal chest pull, distorted cuffs and sleeve openings. Solver
health agreed: 25 cloth edges were compressed below 70% of their rest length
(worst 24%), sleeve openings were only 9–14% of their expected width, and
several seam pleats exceeded 170° surface turn. Outcome: `partial`, with
seven findings withheld. This preview is not approval-ready and must not be
used as evidence of equivalent CLO drape.

The opt-in path is not wired to stored pattern revisions or the R&D import UI.
Surface-seam residuals, collision adjacency, the four within-piece paths,
four trim/piping pairs, the supplied FBX avatar and measured sateen behavior
are still outside this diagnostic. Before another parameter-tuning pass,
isolate the collar/sleeve construction and use matched-camera renders against
the CLO reference; visual correctness remains the deciding gate. Focused
geometry, surface-seam, source-audit and run tests pass, but none of those
tests turns this failed visual result into a usable shirt.

## Appearance and drape audit (user CLO comparison)

The user-provided side-by-side view is a **failed visual comparison**, not a
request to copy the finished CLO mesh into a new revision. A more detailed
source-file check separates four layers that must not be conflated:

CLO's published workflow treats a template/project as a combination of
pattern and sewing, arrangement on an avatar, fabric physical properties,
simulation quality and appearance maps. Fabric stretch does **not** itself
generate a correct pattern or replace sewing instructions. CLO documents
[arrangement properties](https://support.clo3d.com/hc/en-us/articles/115002101968-Arrangement-Property-Setting),
[simulation modes](https://support.clo3d.com/hc/en-us/articles/53856382869657-Simulation),
[particle distance](https://support.clo3d.com/hc/en-us/articles/115012227227-Particle-Distance),
[fabric materials](https://support.clo3d.com/hc/en-us/articles/360047317454-Set-Fabric-Materials),
and [fabric normal maps](https://support.clo3d.com/hc/en-us/articles/115012380288-Fabric-Normal-Map)
as separate controls. These are public feature descriptions, **not** an
explanation of CLO's proprietary solver algorithm.

| Layer | CLO shirt evidence | Current generated preview | Consequence |
| --- | --- | --- | --- |
| Construction | Native project carries 38 paired paths, including six exact rectangular interior front attachments and mid-edge sleeve-cap anchors. | The initial diagnostic assembled only 24 outer joins. A later opt-in trial added the six front attachments; four within-piece and four trim/piping paths remain absent, and the resulting shirt still fails visual inspection. | Detached panels and collar/cuff shape errors are construction failures, not texture failures. |
| Physical cloth | Metadata names `Cotton_Sateen_0` with warp/weft stretch, shear, bend, density and friction; native project also contains fabric assets. | Frontend `fabrics.js` calls its preset values plausible but unmeasured, and maps profile values to constraint compliance heuristically; it has no verified conversion from CLO's physical units. Both the Fit UI **and** the worker runner were injecting a generic poplin/jersey preset, overriding even a recorded profile. Both overrides have now been removed, with regression checks. | The saved profile now reaches the solver, but it is **not** yet a CLO-calibrated sateen model; do not claim equivalent stretching or tune appearance to compensate for it. |
| Surface resolution | CLO supports separate simulation particle-distance/quality settings. The 13 named garment meshes in the finished GLB contain 149,730 triangles across 39 primitives (including duplicate surfaces/material regions, so this is **not** a directly comparable solver particle count). | R&D `triangulate.js` currently uses Draft 28 mm, Normal 11 mm, High 8 mm; the partial-shirt Draft diagnostic has only 2,075 cloth vertices. | Coarse triangles can suppress or exaggerate folds; changing resolution does not repair missing seams or avatar registration. |
| Appearance | `shirt2.glb` embeds 8 images and uses base-colour and normal textures, `KHR_texture_transform`, and `KHR_materials_specular`; its main sateen material has both base-colour and normal maps. The inner `design02.zpac` embeds sateen colour/normal, linen normal, topstitch, logo and other image assets. | `DrapeViewport.js` constructs a flat-colour `MeshStandardMaterial` for each piece, calculates vertex normals, and explicitly draws **no texture**. The derived cloth mesh carries flat 2D rest coordinates, but no renderer UV/material binding. | Fabric weave, print, topstitch colour and micro-normal detail cannot appear in the generated viewport today. This is an appearance gap independent of macro drape. |

The 2D import itself has not discarded every cutting mark: this DXF parses
as **13 grainlines, 6 notches, 3 drill points and 304 internal lines** across
the 13 pieces. The pattern viewer can show notches, grain and internals, and
the assembler uses grain direction for warp/weft behavior. But that is not
the same as validating notch alignment at each sewn join, assigning the 304
internal lines their construction/decorative roles, or rendering cut/stitch
details on the 3D result. Those are separate, currently unmet checks.

The GLB's 15 material records and 8 image records are read-only source
evidence. Do **not** copy its finished 3D vertex positions into the generated
mesh. Its embedded appearance assets may be used only with verified material
ownership, texture transform, permissions and pattern-space UV mapping. The
`Material2989` image path in metadata is a Windows `singstitch01.jpg` path;
it must not be assumed to be the main shirt fabric. The actual image bytes
are embedded in the source package and GLB, so a missing local Windows path
alone is not proof of a missing texture.

The immediate order is: finish source construction manifest and exact
interior/boundary anchors; validate avatar and measured fabric provenance;
then add pattern-space UVs and an explicit fabric appearance mode (with a
neutral geometry mode), and compare at matched camera, lighting, quality and
material settings. Track the two kinds of result separately: **geometric
folds/drape** versus **surface texture/shading**. A normal map can show weave
but cannot create cloth folds or fix a collapsed opening. A smoother shaded
image alone is not a passed drape.

For reuse beyond this sample, define garment-category construction templates
as *constraints and validated inputs* (piece roles, grain, seam graph,
internal lines, allowances, avatar, fabric profile, size), not as a canned
3D shape. Freeze each category's parameters and test on at least one changed
pattern and independent source before claiming support. The present evidence
supports **neither** "every shirt" nor "every 2D pattern" accuracy.
