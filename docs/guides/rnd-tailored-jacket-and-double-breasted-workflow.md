# Tailored jackets and double-breasted jackets in CLO: workflow and GRAV implementation guide

**Research guide · 7 Oct 2026.** This guide analyses the two supplied videos and translates their CLO workflows into a safe product and engineering plan for GRAV's native 2D-to-3D system.

This is a **research and implementation guide**, not a claim that GRAV supports jackets today. The current accepted first garment remains the woven shirt. Jackets require a separate construction template, operations, solver behaviour and visual acceptance set.

## 1. Sources and what each video contributes

1. [CLO — How to Create a Tailored Blazer](https://www.youtube.com/watch?v=PjVGQ1U6WPY) (29:49)
   - Shows the complete digital-tailoring sequence: shell and lining, vents and hems, layer ordering, shoulder pads, sleeve heads, interlining, lapel/collar folding, front closure, buttons, pockets, materials and final rendering.
   - Best source for understanding **how CLO assembles and stabilises a multilayer tailored garment**.
2. [IDES Studio — Tailored Jacket: Peak Lapel vs. Notch Lapel](https://www.youtube.com/watch?v=bHJhdsDBUfg) (22:58)
   - Starts from an existing jacket block and changes break point, hem, center-front wrap, button arrangement, notch lapel to peak lapel, and single vent to double vents.
   - Best source for understanding **which 2D edits create a double-breasted jacket**.

The second video explicitly edits an existing reliable jacket pattern; it does not draft a jacket block from body measurements. GRAV should therefore separate:

- drafting or importing a valid jacket block;
- editing the jacket's style geometry; and
- constructing and simulating that edited pattern.

## 2. The central finding

“Double-breasted” cannot be implemented as a visual preset or a second row of buttons.

It changes a connected group of pattern and construction facts:

- the center-front overlap or **wrap**;
- which front lies on top;
- the button and buttonhole columns;
- which buttons are functional;
- the internal anchor or jigger closure, where used;
- the break point and lapel roll line;
- lapel width and usually lapel type;
- front hem balance after the wrap changes;
- front facing and lining geometry;
- the starting arrangement of the two fronts; and
- the closure constraints used during simulation.

If GRAV only draws buttons on a single-breasted pattern, the result is not a double-breasted jacket. If it widens the front but does not update facings, lining, closure anchors and lapel geometry, the 3D result is structurally inconsistent.

## 3. CLO's end-to-end tailored-jacket workflow

### 3.1 Start from a trustworthy pattern

CLO's video starts from either an existing pattern or a modular jacket block. Shell and lining are treated as separate assemblies.

For GRAV, a jacket revision must declare at least:

- category and style variant;
- units and scale;
- wearer convention: menswear or womenswear overlap direction;
- shell, lining, facing, interlining, reinforcement and trim layers;
- stable piece identities and roles;
- grain vectors;
- boundary run classifications;
- seam partners, direction, stations and ease;
- folds, roll lines, vents, pocket placements and closures; and
- avatar, pose, fabric profiles and initial panel transforms.

Unknown values remain unknown. A plausible jacket silhouette is not enough to infer this information.

### 3.2 Construct the shell first

The official CLO workflow arranges and sews shell pieces, folds vent extensions inward, connects vent edges, and adds a hem turn of about 30 mm in its example.

The transferable principle is not “always use 30 mm.” It is:

1. The hem and vent geometry belongs to the 2D pattern.
2. Fold paths need an explicit fold direction and target state.
3. Vent edges have different jobs above and below the vent opening.
4. Simulation should pause after each construction group so errors can be found locally.

GRAV should store the hem depth and vent geometry from the actual pattern. The video's 30 mm is an example, not a product default.

### 3.3 Construct the lining separately

CLO settles the lining alone, temporarily shrinks it, freezes it, brings the shell above it, then gradually restores the lining to full size while simulating. It later joins shell and lining segment by segment.

This reveals two distinct needs:

- the lining has its own real 2D geometry, ease and seams; and
- the simulator needs a reliable way to insert one sewn layer inside another without tangling.

GRAV must not permanently alter lining rest lengths to imitate CLO's temporary 85% shrink workflow. If a temporary insertion scale is used, it must be a solver-only state that returns to exactly 100% before evidence is accepted. The immutable 2D lining geometry remains unchanged.

### 3.4 Join shell, facing and lining deliberately

CLO removes conflicting center-front seams, then joins shell and lining around their intended boundaries. It uses custom or turned sewing directions and repeatedly simulates to check the result.

GRAV needs explicit operation types rather than generic “sew these lines”:

- `boundary-seam` — ordinary two-sided seam;
- `edge-to-facing` — shell edge joined to facing;
- `edge-to-lining` — shell/facing boundary joined to lining;
- `same-piece-fold` — hem, vent or facing return;
- `interior-attachment` — one piece attached to an internal path of another;
- `closure` — button/buttonhole, jigger button, hook or snap;
- `stabilising-tack` — a digital or manufacturing tack with stated visibility;
- `decorative` — visible but non-structural; and
- `reference-only` — visible construction guidance with no solver action.

Every operation needs owner pieces, ordered geometry, direction, layer relationship and provenance.

### 3.5 Add shoulder pads and sleeve heads

CLO inserts library shoulder pads between lining and shell, attaches each pad across front and back shoulder regions, and uses collision thickness to create pad volume. It creates a sleeve-head piece by tracing the sleeve-cap shape, sewing it into the cap region and placing it under the sleeve.

These are not ordinary decorative trims. They materially change shoulder shape.

GRAV needs separate concepts for:

- `shoulder-pad` as a shaped reinforcement with thickness, stiffness and attachment paths;
- `sleeve-head` as a simulated or equivalent structural component attached along a defined cap path; and
- ordinary `interlining`, which changes stiffness but does not necessarily need a separate free cloth surface.

The current GRAV shirt template deliberately does not simulate interlining. A jacket cannot be considered visually faithful while all shoulder structure is omitted without a prominent limitation.

### 3.6 Represent interlining, fusing and tape

CLO applies bonded reinforcement to fronts, facings, collar pieces and selected local regions. It also applies seam tape around sleeve and hem areas.

For GRAV, the clean model is a regional material modifier attached to source geometry:

```text
reinforcement region
  owner piece
  closed or open path
  reinforcement profile
  attachment = fused | sewn | taped
  bending modifier
  stretch/shear modifier
  thickness/collision policy
  provenance and confirmation
```

Do not require a separate simulated cloth mesh for every fused interlining region. Use one only when the construction genuinely behaves as an independent layer. Otherwise apply a documented regional constitutive modifier to the owner panel.

### 3.7 Fold and stabilise lapels and collars

CLO folds the lapel and collar along internal roll/fold lines, strengthens pieces temporarily, enables fold rendering, and sometimes adds hidden zero-visibility sewing to stabilise the fold.

GRAV should model the physical intent directly:

- lapel roll line;
- collar roll line;
- fold direction;
- preferred dihedral angle or curvature range;
- crease stiffness;
- fused regions; and
- temporary construction stage.

A hidden seam used only to force a fold in CLO is an implementation technique, not necessarily a manufacturing seam. GRAV must not export it as a sewing instruction or silently add it to the manufacturing pattern.

### 3.8 Close the double-breasted front in stages

CLO manually brings one front over the other using pins and small movements, removes the pins, places buttons and buttonholes, then fastens them. It notes that menswear normally places the wearer's left front over the right and womenswear normally reverses this.

GRAV should replace manual trial-and-error with a declared closure plan:

```text
front closure
  style = single-breasted | double-breasted
  overlap = wearer-left-over-right | wearer-right-over-left
  wrap width
  button configuration = 6x2 | 6x1 | 4x2 | 4x1 | custom
  functional closure pairs
  decorative button anchors
  internal anchor/jigger pair, optional
  closure state = open | partially-fastened | fastened
  ordered fastening stage
```

The solver can then guide the fronts into a collision-safe overlap and activate closure constraints in order. Pins may remain an interactive recovery tool, but they must not be the only reproducible way to close the jacket.

### 3.9 Add pockets, trims and visual materials last

CLO creates pocket placement lines, clones them as pocket/flap pieces, bonds flaps, sews them to internal paths, then assigns shell and lining materials. It also uses rendering thickness and double-sided rendering to fake some visual bulk.

GRAV should distinguish:

- pocket placement path;
- pocket opening;
- welt, jet, patch, flap and bag pieces;
- which components affect the outer silhouette;
- which components are represented only in the manufacturing record; and
- which visible thickness is rendering-only rather than physical thickness.

Texture, normal maps and render thickness come after structural acceptance. They cannot repair a malformed lapel, tangled lining or incorrect wrap.

## 4. How a single-breasted block becomes double-breasted

The IDES video provides the clearest pattern-edit sequence.

### Step 1 — Preserve center front as a datum

The center-front line remains the body's reference. Increasing wrap moves the front edge and related closure marks outward; it does not redefine the center of the wearer.

GRAV should store `centerFront` as a construction datum, not infer it from the finished front edge.

### Step 2 — Set the break point

The break point is where the front closes and the lapel begins to roll. It normally sits near the waist, with the exact height driven by style and body proportions.

When it moves, GRAV must update or revalidate:

- the boundary segment point;
- lapel roll line endpoint;
- closure/button marks tied to the break;
- affected facing geometry;
- lapel curve; and
- any dependent notch or collar relationship.

These items should be constrained or moved as one dependency group. CLO requires separate tool moves for pattern points and buttons; GRAV should avoid that source of inconsistency.

### Step 3 — Increase the center-front wrap

The tutorial calculates wrap from the desired distance between button columns. For a symmetric layout, the front edge moves outward by half the column spacing while center front remains fixed.

Use a semantic edit:

```text
set double-breasted wrap
  column spacing = user value
  front edge offset = column spacing / 2 from center front
  preserve break-to-near-button relation
  update facing and lining dependencies
  revalidate hem and lapel balance
```

The example uses about 90 mm between columns. That is a tutorial choice, not a universal standard.

### Step 4 — Define button configuration and function

Configurations such as `6x2` mean six visible buttons and two functional buttons. GRAV should never infer function from appearance.

Each closure record needs:

- button anchor;
- paired buttonhole anchor, if functional;
- owner piece and layer;
- size and shank/thread offset;
- functional or decorative status;
- fastening order; and
- symmetric-copy provenance, where applicable.

The tutorial places the button nearest the break roughly 7–10 mm from the break point to the outside edge of the button. Keep this as optional guidance, not a hard validation rule.

### Step 5 — Balance lapel width against wrap

The tutorial explains the visual relationship:

- a narrower wrap tends to look longer and more modern;
- a wider wrap looks squarer and broader; and
- wider wrap normally needs a wider lapel for balance.

This should be a design advisory in GRAV, not an automatic geometry rewrite. Product rules may warn about unusual proportions but must not silently “correct” a deliberate design.

### Step 6 — Convert notch lapel to peak lapel, if desired

The tutorial mirrors the lapel outline across the roll line as a construction reference, then edits the lapel point, gorge/notch and collar together. It repeatedly verifies that sewing lengths still match.

GRAV should treat the lapel and collar as a dependency system:

- lapel edge and roll line;
- gorge seam;
- collar notch;
- upper/lower collar seam;
- neck seam;
- back-neck length;
- high-point-shoulder alignment; and
- facing equivalents.

A peak-lapel conversion is incomplete until all affected seam lengths and joins have been revalidated.

### Step 7 — Rebalance the front hem

A line that looks horizontal in 2D may rise in 3D because the side seams and body volume rotate the sewn hem. The tutorial checks the 3D result and adjusts the front pattern accordingly.

GRAV should support a controlled revise-and-compare loop:

1. Save immutable revision A.
2. Generate the drape.
3. Show hem-level evidence from front and side views.
4. Create revision B with the intentional 2D edit.
5. Generate a new drape linked to B.
6. Compare A and B without altering either source revision.

Do not let a 3D drag directly rewrite the approved 2D pattern.

### Step 8 — Change vent construction, if desired

The tutorial converts one center-back vent into two side-back vents by copying the existing vent geometry, splitting the side-back seams at the vent height, adding extensions and fold lines, updating seam extents, and sewing the folded vent returns.

GRAV needs vent records with:

- `ventType = none | center | double-side | custom`;
- owner pieces;
- opening start anchors;
- fold paths and direction;
- underlap/overlap order;
- seam portions that stop at the opening;
- internal attachment paths; and
- lining/facing treatment.

“Vent” cannot be only a boundary label; it is a small construction graph.

## 5. CLO techniques that GRAV must not copy blindly

| CLO technique shown | What it achieves | GRAV requirement |
| --- | --- | --- |
| Temporarily shrink lining to 85% | Inserts lining inside shell | Solver-only insertion state; restore exact 2D rest metric before acceptance |
| Layer values `-1`, `0`, `1` | Resolves temporary ordering | Named layer relationships plus temporary stage overrides |
| Strengthen/freeze panels | Prevents tangling while another group moves | Explicit staged solver controls, never permanent material changes |
| Hidden seams with line intensity/thickness `0` | Stabilises folds or facing position | Record as a solver constraint distinct from manufacturing seams |
| Disable button collision | Avoids trim fighting with cloth | Use robust trim/cloth attachment or disclose render-only hardware |
| Render thickness or double-sided flap | Improves appearance | Keep render thickness separate from physical cloth thickness and collision offset |
| Omit a physical lining fold for stability | Simplifies the digital garment | Record the approximation; do not claim exact construction fidelity |
| Eyeball 3D, then sample | Style development loop | Preserve immutable revisions and require physical-sample validation for production decisions |

The videos are honest examples of experienced CLO operators using both real construction and digital stabilisation tricks. GRAV's data model must say which is which.

## 6. Proposed GRAV jacket construction contract

### 6.1 Add a separate garment template

Add a future template such as `tailored-jacket`; do not stretch `woven-shirt` until it means both shirt and jacket.

Suggested role vocabulary:

```text
shell.front
shell.side-front
shell.back
shell.side-back
sleeve.upper
sleeve.under
collar.upper
collar.under
facing.front
facing.back-neck
lining.front
lining.back
lining.sleeve
pocket.welt
pocket.jet
pocket.flap
pocket.bag
reinforcement.shoulder-pad
reinforcement.sleeve-head
interlining.front
interlining.facing
interlining.collar
```

Roles should support left/right ownership and mirrored or separately drawn pieces without relying on filenames.

### 6.2 Extend the internal-operation vocabulary

The current native editor records operations such as folds, topstitching and pocket attachment but refuses unsupported active operations. Jackets require at least:

```text
lapel-roll
collar-roll
hem-turn
vent-fold
vent-attachment
facing-attachment
lining-attachment
interior-piece-attachment
fused-region
seam-tape
pocket-opening
pocket-attachment
button-anchor
buttonhole-anchor
closure-pair
stabilising-tack
```

An operation is only supported when it has both:

1. a complete persisted geometry/ownership contract; and
2. an implemented solver or render behaviour.

Until then, readiness must refuse it rather than reclassify it as decoration.

### 6.3 Store dependencies, not duplicated coordinates

Important jacket landmarks should be first-class anchors:

- center front;
- waistline;
- break point;
- lapel roll line;
- gorge/notch points;
- button columns and rows;
- hem and vent heights; and
- pocket placement baselines.

Dependent geometry may reference those anchors. When a source landmark moves, GRAV can identify exactly which confirmations become stale.

### 6.4 Add a construction-stage plan

A reproducible jacket drape should run named stages:

1. Validate pattern and construction completeness.
2. Place and sew shell panels.
3. Form hems and vents.
4. Place and sew lining panels separately.
5. Insert lining into shell without changing final rest geometry.
6. Join shell, facing and lining at declared boundaries.
7. Insert shoulder pads and sleeve heads.
8. Activate interlining and tape material modifiers.
9. Form lapel and collar rolls.
10. Bring fronts into the declared overlap.
11. Activate closures in order.
12. Settle at diagnostic quality.
13. Run topology, geometry, collision, strain and stability gates.
14. Settle and render at acceptance quality.

Each stage should report which constraints it created and which input records authorised them.

## 7. Recommended GRAV user workflow

### Screen A — Jacket setup

Ask for:

- jacket template and base block;
- single- or double-breasted;
- wearer overlap convention;
- lapel type;
- button configuration;
- vent type;
- lining choice;
- shoulder structure; and
- avatar, pose and fabric profiles.

This screen creates intent; it must not invent missing geometry.

### Screen B — 2D style editing

Provide semantic actions where possible:

- move break point;
- set wrap/column spacing;
- change button stance;
- reshape lapel and collar;
- change hem shape;
- create or change vents; and
- place pockets.

Show exact dimensions and the affected dependent geometry before applying the edit.

### Screen C — Construction review

Group questions by operation rather than presenting every raw line at once:

- shell seams;
- lining seams;
- shell-to-facing joins;
- shell/facing-to-lining joins;
- lapel/collar rolls;
- hems and vents;
- shoulder structure;
- pockets; and
- closures.

For every unresolved item show its 2D path, owner, direction and corresponding 3D preview.

### Screen D — Starting arrangement

Preview all layers around the chosen avatar. Detect before simulation:

- panels starting inside the body;
- left/right fronts placed on the same side;
- lining outside shell;
- shoulder pads outside both layers;
- sleeve heads on the wrong cap;
- intersecting collar/lapel pieces; and
- seam stations separated by implausibly large distances.

### Screen E — Staged build monitor

Show construction progress by named stage. When a stage fails, keep the last valid state and identify the operation involved. Do not make the operator diagnose an undifferentiated pile of cloth.

### Screen F — Jacket acceptance

Required fixed views:

- front open, if supported;
- front fastened;
- back;
- left and right side;
- lapel/collar close-up;
- both shoulder/sleeve-cap close-ups;
- front closure close-up;
- vent close-up; and
- inside/lining diagnostic view.

Also show comparison with the previous 2D revision when the user has edited wrap, break, lapel, hem or vent geometry.

## 8. Readiness failures specific to jackets

Refuse simulation when any applicable condition is unresolved:

- center front or break point is missing;
- double-breasted style has no wrap dimension;
- overlap side is unknown;
- a functional button has no paired buttonhole or anchor;
- a facing does not follow the changed front/lapel boundary;
- shell and lining joins are incomplete;
- lapel or collar roll path lacks direction;
- collar/gorge seam partners no longer match after editing;
- a vent has a fold but no opening/seam-stop definition;
- a shoulder pad or sleeve head has no owner and attachment path;
- active interlining/tape regions have no implemented material effect;
- a pocket piece targets an unconfirmed internal path;
- layer order or initial placement is unconfirmed;
- any structural operation is labelled decorative to bypass support; or
- a geometry edit invalidated a dependent confirmation.

## 9. Validation and acceptance

### 9.1 Numeric gates

At minimum record and validate:

- source-to-mesh scale and piece perimeter;
- seam length and station correspondence;
- unmatched or duplicated construction paths;
- body and self-penetration;
- shell/lining ordering violations;
- closure residuals at every functional anchor;
- lapel/collar roll continuity;
- vent opening and underlap order;
- edge, area and shear strain by piece;
- motion at the end of settling; and
- provenance of fabric and reinforcement properties.

### 9.2 Visual gates

A person must reject the result if any of these are visible:

- fronts cross in the wrong order;
- closure is offset or twisted;
- lapels are asymmetric without design intent;
- collar/gorge is broken or jagged;
- shoulder pad edge is visible through the shell;
- sleeve cap is collapsed, knotted or detached;
- lining emerges through shell openings;
- facings flip outward;
- vents are sealed, inverted or crossing;
- pockets float, sink or attach to the wrong panel;
- hem is unintentionally uneven; or
- the jacket looks plausible only from one camera.

Numeric success never overrides a failed visual review.

### 9.3 Minimum proof before claiming jacket support

1. One native-authored, lined, double-breasted baseline jacket completes the full workflow.
2. A materially changed revision alters at least two linked style features, for example wrap plus break point, or lapel plus vent construction.
3. Both pass construction completeness, numeric gates and fixed-view human review.
4. The changed 3D result visibly corresponds to the changed 2D while the old revision remains unchanged.
5. At least one open-front and one fastened state are tested if both are claimed.
6. Limitations such as unmodelled seam bulk, interlining or hardware are visible beside the result.

One successful imported CLO jacket is useful reference evidence, but it does not prove the native authoring workflow.

## 10. Sequential implementation plan

Keep this behind the woven-shirt acceptance work unless product priority is deliberately changed.

### J0 — Reference fixture and terminology

- Obtain an authorised jacket pattern with shell, facing, lining, upper/under sleeve, collar and vent construction.
- Record a CLO project/result as comparison evidence, not generated output.
- Produce a complete construction manifest and fixed-view reference set.

**Exit:** every piece and construction path is accounted for, including unknowns.

### J1 — Jacket data contract and hard readiness

- Add the jacket template, role vocabulary, landmarks, closure plan, vent graph and reinforcement records.
- Persist all fields through save/reopen and immutable revision creation.
- Refuse unsupported operations.

**Exit:** a jacket can be fully described, even though it may not yet drape.

### J2 — Semantic double-breasted pattern edits

- Implement break-point, wrap, button-stance and dependent-facing/lining edits.
- Add dependency invalidation and before/after measurements.

**Exit:** a user can create a structurally consistent double-breasted revision without manually chasing duplicated coordinates.

### J3 — Shell, lapel, collar, hem and vent construction

- Implement fold/roll constraints and vent construction.
- Validate collar/gorge lengths and directions.

**Exit:** an unlined shell can settle with correct overlap, lapel, collar, hem and vents.

### J4 — Closures

- Implement functional/decorative buttons, buttonholes, optional jigger anchor and ordered fastening.
- Keep render hardware separate from physical closure constraints.

**Exit:** open and fastened states are reproducible from the same revision.

### J5 — Lining and facing assembly

- Implement separately sewn lining, collision-safe insertion and declared shell/facing/lining joins.
- Preserve final 2D rest geometry throughout.

**Exit:** lining remains inside and attached correctly in all fixed views.

### J6 — Tailoring structure

- Implement shoulder pads, sleeve heads, fused regions and tape effects.
- Record every approximation and its scope.

**Exit:** shoulder and lapel silhouette materially reflect the selected structure without visible pad edges or cap collapse.

### J7 — Pockets and finish details

- Implement the selected first pocket construction completely.
- Add trim/render finishing without weakening physical gates.

**Exit:** the chosen pocket is both structurally and visually correct; other pocket types remain explicitly unsupported.

### J8 — Baseline and changed-pattern acceptance

- Run both native patterns through diagnostic and high-quality stages.
- Review all fixed and detail views.
- Record failures rather than tuning only to the reference garment.

**Exit:** both garments pass, or jacket support remains unshipped.

## 11. Immediate advice for the current GRAV implementation

Do not begin by adding a “double-breasted” checkbox to the existing woven-shirt template. The most useful next design work is:

1. define the jacket construction manifest and role vocabulary;
2. model center front, break point, roll line, wrap and closure pairs as linked data;
3. define shell/facing/lining joins and the vent construction graph;
4. choose one shoulder-structure representation; and
5. build hard readiness before connecting the jacket to the solver.

That order follows the existing GRAV rule: the 2D pattern and explicit construction are the garment; the 3D drape is evidence. A stronger solver cannot recover construction facts that were never recorded.

## 12. Related GRAV source-of-truth documents

- [`docs/decisions/rnd-native-pattern-authoring.md`](../decisions/rnd-native-pattern-authoring.md)
- [`docs/decisions/rnd-fit-simulation.md`](../decisions/rnd-fit-simulation.md)
- [`docs/product/rnd-fit/native-2d-to-3d-goal.md`](../product/rnd-fit/native-2d-to-3d-goal.md)
- [`docs/product/rnd-fit/garment-template-contract.md`](../product/rnd-fit/garment-template-contract.md)
- [`docs/product/rnd-fit/fabric-profile-contract.md`](../product/rnd-fit/fabric-profile-contract.md)
- [`docs/tasks/rnd-native-pattern-workflow.md`](../tasks/rnd-native-pattern-workflow.md)
