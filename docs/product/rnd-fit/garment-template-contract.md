# Garment template and seam-mapping contract

**Lane B · product specification · revised 1 Oct 2026.**
Scope: basic T-shirt, polo shirt, basic woven shirt — and the name-free
contract that lets a template describe any of them.

> **Read this first.** Nothing here is code and nothing here instructs anybody
> to change a pattern. It says what a fitting must be given before it can be
> attempted, where each of those things comes from, and which of them only a
> person can supply.

**Revision note.** This version corrects four claims the first draft got wrong:
that a reversed seam could be caught after assembly (§4.5), that grain is a
`lengthwise`/`crosswise` label read off the drawing (§4.8), that an unpublished
seam allowance is a minor display problem (§4.12), and that every edge must be
individually classified (§4.11). It also narrows the first-release requirements
to match Lane A's scope (§6).

---

## 1. Why this contract exists in this shape

The CAD archive already contained a working assembler. It was discarded, and the
reason is the whole argument for what follows.

It looked for drawing groups called `"Chest"`, `"Bottom hem"` and `"Coller"` —
including that misspelling, because one dataset spelled it that way. It decided
which outline was a yoke by looking for a group named `__custom__yokeseam`. Its
fit thresholds were measured on *one* garment: "Executive shirt M on its base
body". It worked, on that shirt, in that drawing, from that shop.

A second shop sends a DXF whose pieces are called `Pattern_636968`. Every lookup
returns nothing and the assembler reports that the drawing contains no garment.
The drawing is fine. The assumption was not.

Three rules follow:

| Rule | In practice |
|---|---|
| **A role is assigned, never recognised** | Nothing searches a drawing for a word. A piece has a role because somebody gave it one, or confirmed a suggestion. |
| **A seam is geometry, not a name** | A seam is ordered runs of boundary with a direction and an explicit alignment. It would be the same seam if every piece were called `A`, `B`, `C`. |
| **Absent is stated, never assumed** | An unsewn edge says so. A missing grainline is missing, not vertical. |

---

## 2. What the drawing gives us, and what it never will

This decides how much work a person must do per pattern, so it comes before
everything else.

The genuine CLO export this house produces publishes five AAMA layers:

| Layer | Meaning | Present |
|---|---|---|
| 1 | piece boundary | ✅ |
| 2 | turn points | ✅ |
| 3 | curve points | ✅ |
| 7 | grainline marker | ✅ |
| 8 | internal construction lines | ✅ |
| 4 | **notches** | ❌ |
| 5 | grade points | ❌ |
| 6 | **mirror / fold line** | ❌ |
| 13 | drill holes | ❌ |
| 14 | **sewing line** | ❌ |

Consequences, each of which shapes a section below:

- **No notches** → seam pairing cannot be derived from registration marks.
  Nothing in the file says which point on an armhole meets which point on a cap.
- **No sewing line** → the boundary is the **cut line**, and a sewing line must
  be derived before anything dimensional can be trusted (§4.12).
- **No mirror line** → cut-on-fold is unstated and must be said by a person.
- **Pieces are named `Pattern_636968`** → roles are human work.

**Measured, not assumed.** In that export all five pieces carry a grainline of
exactly 7.0866 in = 180.0 mm at 90° (one at 89.717°). That is a fixed-length
marker laid parallel to the selvedge, which is normal for every piece on a
marker. It is read as a **vector**, never as a label (§4.8).

Also measured: the two sleeves are **two separate outlines**, each stating
`QUANTITY: 1`. The contract supports that form without asking anybody to merge
or delete them (§4.7).

---

## 3. Three ways to know something

| Source | Meaning | Trust |
|---|---|---|
| **Derived** | Computed from the drawing's geometry. Re-computable, identical every time | use directly |
| **Stated** | A person or upstream record said it | use, and show who |
| **Confirmed** | Proposed by the system, agreed by a named person | use, and show the basis |

A fourth state matters most: **unknown**. An unknown value is never replaced by a
plausible default anywhere in this product.

And a distinction the screens must keep (L2): **a published zero is not an
unknown.** If a file publishes a notch layer and a piece has none, that is `0`.
If no notch layer exists, that is *not published*. The two look the same and mean
opposite things.

---

## 4. The generic seam-mapping contract

### 4.1 Piece

| Field | Source | Notes |
|---|---|---|
| `pieceRef` | Derived | minted per piece, stable across re-parses of the same file |
| `role` | Stated / Confirmed | from the **template's own** role vocabulary (§5). Never read from the piece's name |
| `cutQuantity` | Stated, or Derived where published | how many exist in the finished garment |
| `symmetry` | Stated / Confirmed | §4.7 |
| `pairedWith` | Stated / Confirmed | the other half, when left and right are drawn separately (§4.7) |
| `layer` | Stated | `shell`, `lining`, `interlining`, `rib`, `trim`, `pocketing` |
| `grainVector` | Derived / Stated | §4.8 |
| `simulated` | Derived from `layer` + template | whether this piece takes part in the drape (§8) |

A piece with no role is not an error. It is a piece nobody has placed yet, and
readiness names it.

### 4.2 Boundary run

A **run** is a stretch of one piece's closed boundary. Not a line, not a segment
list, not a name.

| Field | Source | Notes |
|---|---|---|
| `runId` | Assigned | unique within the piece; opaque — nothing parses it |
| `startAnchor`, `endAnchor` | Confirmed | two anchors on the boundary (§4.3). **Both are required** |
| `direction` | Derived | which way along the boundary the run travels, from `startAnchor` to `endAnchor` |
| `length` | Derived | arc length between the anchors, in the pattern's own unit |
| `role` | Stated / Confirmed | what this run is for, from the template's run vocabulary |

**Ordered geometry.** A run is always stored with its points in travel order.
Everything downstream — pairing, easing, sampling — depends on that order being
the stated one, never the storage order of the outline.

### 4.3 Anchors

| Anchor kind | Survives re-parse | Survives a pattern edit | In our files |
|---|---|---|---|
| **Notch** | yes | usually | ❌ not published |
| **Turn point** | yes | often | ✅ present |
| **Placed point** (a person clicked it) | yes | needs re-confirming | always |
| **Arc-length fraction** | yes | **no** | always |

Arc-length fractions are the fallback and are why a fitting goes stale: move one
point and every fraction after it means something else. Templates should prefer
turn points. The anchor kind used is recorded, because that is what tells a
reader how much a pattern edit is likely to have broken.

### 4.4 Seam

A seam joins **two ordered sequences of runs**. Not two runs — two sequences.

This is not generality for its own sake. On every garment in scope the armhole is
one sleeve-cap run sewn to two or three body runs in order. A contract pairing
one run to one run cannot express a set-in sleeve.

| Field | Source | Notes |
|---|---|---|
| `seamId` | Assigned | opaque |
| `sideA`, `sideB` | Confirmed | ordered lists of `{pieceRef, runId}` |
| `alignment` | **Confirmed — mandatory** | exactly which endpoint meets which (§4.5) |
| `ease` | Derived, reviewed | length difference as a percentage of the shorter side (§4.9) |
| `easeDistribution` | Stated | `even`, or concentrated between two named anchors |
| `seamType` | Stated | §4.10 |
| `confidence` | System | `proposed`, `confirmed`, `rejected` |
| `confirmedBy`, `confirmedAt` | System | a confirmation nobody is attributable for is a guess |

**Pairing rule.** Both sides are walked by normalised position along their own
total length: position `0.5` on side A is sewn to position `0.5` on side B,
whatever the point counts are. This is what lets a 125-point armhole sew to a
40-point cap.

**Compound traversal (M1).** Where a side has more than one run, those runs must
be **contiguous** (each run's end anchor is the next run's start anchor),
**co-directional** (all travelling the same way round their pieces), and the
sequence must **begin at a stated anchor** — for an armhole, the underarm. A
sequence that is not contiguous, or that reverses direction part-way, is a
readiness failure, not something to be silently re-ordered.

**Left and right are separate seams (M2).** Every body-to-sleeve, shoulder and
side seam exists twice. They are mapped, confirmed and reported independently,
and a confirmation on one side is never applied to the other by inference. The
one exception is a mirrored piece pair, where a single confirmation may be
*propagated* with that fact recorded (§4.7).

### 4.5 Alignment — prevention, because detection is not available

**A geometrically plausible reversed sleeve may not be detectable after
assembly.** This is the most important sentence in the document.

A sleeve cap sewn front-to-back has the **same piece perimeter, the same seam
length and the same scale** as one sewn correctly. Lane A's geometry-fidelity
gate compares exactly those three things, so it passes a reversed sleeve without
complaint. The garment drapes, renders, and the twist reads as a drape fold.
Nobody catches it by eye.

Nothing in this specification may claim that perimeter, seam-length or scale
fidelity detects a reversed seam. They do not.

So the defence is **prevention, before the run**:

1. each seam side is an **ordered sequence of boundary runs**;
2. each run carries **explicit start and end anchors**;
3. `alignment` states **exactly which endpoint meets which** — A-start to B-start,
   or A-start to B-end — as a stored value, never inferred from storage order;
4. the mapping interface **previews the orientation visually** before anything is
   confirmed: the two sides drawn with their travel direction and their joined
   endpoints shown;
5. a **named person confirms** that preview;
6. **simulation is refused** when `alignment` is absent or unconfirmed (R4);
7. the **confirmed orientation is recorded in the trial evidence**, so a later
   reader can see what was agreed and by whom.

### 4.6 What a fitting may still get wrong, stated plainly

Because §4.5 is prevention and not detection, the honest statement to carry on
every fitting is:

> This fitting assumes each seam is joined the way it was confirmed. A seam
> confirmed the wrong way round will still produce a believable garment, and
> nothing afterwards will flag it.

### 4.7 Symmetry and paired pieces

Two production forms, **both supported**. Neither requires deleting or merging a
piece the pattern room actually exported.

| Form | What the drawing contains | What the mapping does | What evidence records |
|---|---|---|---|
| **A — one piece, cut twice** | a single outline, `cutQuantity: 2`, `symmetry: mirrored-pair` or `identical-pair` | map and confirm **once**; the twin is generated, and the confirmation is *propagated* to it | "confirmed once on `PP-…`, propagated to its generated twin" |
| **B — two drawn pieces** | two outlines, each `cutQuantity: 1`, linked by `pairedWith` | map each side. A confirmation on one may be **offered** for the other and must be **separately confirmed** | both `pieceRef`s, and whether each confirmation was independent or accepted from the other side |

Form B is what our real export produces: `Pattern_1621764` and
`Pattern_1621765`, identical in area, each stating `QUANTITY: 1`.

**Cut-on-fold** is a third, different thing: the drawing contains **half** the
piece, and assembly reflects it across the fold run into one whole piece **and
creates no seam there**. A half-back not unfolded gives a garment half the width;
a half-back unfolded *and* given a centre seam gives a garment with a seam the
pattern never had. Our exports publish no mirror line, so cut-on-fold is
**stated by a person** on every pattern this house currently produces.

### 4.8 Grain — a vector, not a label

The first draft stored `lengthwise` / `crosswise` derived from the marker. That
was wrong, and the measurement in §2 shows why: every piece on a marker carries a
grainline parallel to the selvedge, so the absolute angle is ~90° for all of
them and says nothing about the garment. Our own parser would label the neck rib
`lengthwise` — the very piece that must be cut across.

**What is stored instead:**

| Field | Source | Notes |
|---|---|---|
| `grainVector` | Derived where layer 7 exists, else Stated | a direction **in the piece's own local coordinates** |
| `grainSource` | System | `marker-grainline`, `stated`, or `confirmed` |
| `grainConfidence` | System | high when derived from a published grainline; otherwise as stated |
| `grainConfirmed` | Confirmed | required where the source is `stated`, or where a template flags the piece |

**How it is used.** Warp and weft behaviour is calculated from the angle between
each piece of cloth and the **grain vector in that piece's own frame**. It is
never calculated from where the piece sits on the marker. A piece rotated on the
marker and a piece laid upright behave identically if their grain vectors
relative to their own outlines are the same.

**No piece is required to publish the word "crosswise."** Where a template needs
a particular orientation — a neck band being the usual case — it is expressed
geometrically: *the grain vector runs across the band's long dimension rather
than along it*. That is checkable against the stored vector, and it is true
regardless of how the piece was laid out.

### 4.9 Easing and gathering

Two runs sewn together are rarely the same length; the difference is deliberate.
`ease` is recorded as a percentage of the shorter side, with its distribution.
What is acceptable depends on seam, category and fabric —
`fit-assistant-rules.md` §2. The contract records it and the fact that somebody
looked.

A seam whose sides differ by more than the template allows is a **seam-length
mismatch** — a readiness failure, not a warning (`VM-11`).

### 4.10 Seam type

`plain`, `flat-felled`, `french`, `overlocked`, `bound`, `topstitched`, `taped`.

Recorded now, used later: a flat-felled seam is four layers and behaves stiffer
than the panels either side. The first templates may treat every seam alike; the
field exists so nobody has to go back and ask.

### 4.11 Boundary coverage — runs, not individual edges

The first draft said every edge must be classified. That was ill-defined: before
anybody places anchors there is no edge set, only a closed boundary. As written it
demanded a dozen declarations per tee before a first fitting.

**The rule instead:**

1. every **sewn** run is explicitly mapped;
2. every **fold** run is explicit (cut-on-fold, placket folds, band folds);
3. every **special construction** run is explicit (vents, openings, slits);
4. the **remaining uncovered perimeter** may be confirmed **once**, per piece, as
   finished/open boundary — one action, not one per edge;
5. the interface **shows the uncovered portions** on the piece before that
   confirmation is offered, so the person is agreeing to something they can see.

Readiness fails when perimeter is neither covered nor confirmed (R5) — which
still distinguishes "finished" from "nobody has done this yet", at a fraction of
the work.

### 4.12 Sewing line versus cut boundary

Our boundary is the **cut line**. The archive's mesh builder meshes the outline
**as drawn** — there is no allowance inset anywhere in it. Sewing on the cut line
joins the panels in the wrong places: it changes **where pieces meet, how they
assemble and how they drape**, not merely a number on a screen. On a chest girth
with two side seams and two armholes a 10 mm allowance is of the order of 40 mm —
comparable to the entire width of a fit band.

**This error is never described as "slight."**

**The hierarchy, in order:**

| Step | Source of the sewing line | Then |
|---|---|---|
| 1 | an **explicit sewing line published by the file** (AAMA layer 14) | use it |
| 2 | otherwise, **derive** one from a human-confirmed seam allowance and the cut boundary — preserving joins, corners and curve continuity | go to step 3 |
| 3 | **validate the derived geometry** before simulation: still closed, non-self-intersecting, corners resolved, no run collapsed to zero length | passes → use it, marked derived. Fails → step 4 |
| 4 | no trustworthy sewing line can be constructed | the **cut boundary** is used, and the fitting is **non-authoritative**: it **may** show a visual drape and **must withhold every dimensional finding affected by it** |

And two rules that hold at every step: the error is **never** called "slight", and
every fitting **records which of the three sources it used** — published, derived,
or cut boundary.

Deriving an inset is not arithmetic on a single number: at a corner two offset
curves must be intersected or trimmed, and an allowance that varies per edge must
be stated per run. Where that cannot be done cleanly, step 4 applies.

**What "withhold" means.** A fitting built on the cut boundary may still be
looked at. It may not report chest, waist, hem, bicep or collar numbers, because
every one of them is biased by the allowance. Shape, hang and obvious pulling
remain visible and are reported as observations, not measurements.

### 4.13 Construction notes

Free text against a seam or a piece, for the half of any instruction that does
not fit a field. Never parsed, never used to decide anything.

---

## 5. Role vocabularies are per template, not global

A role is meaningful only inside a category. "Band" means a neck band on a tee
and a cuff band on a polo sleeve, and a single global list would invent a
distinction nobody in a sampling room makes.

Each template declares its own vocabulary; the assembler compares a piece's role
only against the roles that template declared. The solver below it knows none of
these words.

---

## 6. The three categories

**First-release requirements are deliberately narrow**, matching Lane A's stated
first template — front, back, sleeves and an optional neck finish. Everything
else is optional with conditional rules when present, so a short-sleeved shirt, a
band-collar shirt and a shirt with no separate upper-back panel all pass.

> **Cut quantity** is the count in the finished garment, after unfolding and
> mirroring — not the number of outlines in the DXF.

> **Seam order below is typical; factory method may differ.** It is construction
> documentation and is **not** a readiness input (§8).

### 6.1 Basic T-shirt

**Required**

| Role | For | Cut qty | Symmetry | Grain |
|---|---|---|---|---|
| `body.front` | front torso | 1 | `cut-on-fold` or `single` | vector required |
| `body.back` | back torso | 1 | `cut-on-fold` or `single` | vector required |
| `sleeve` | upper arm | 2 | Form A or Form B (§4.7) | vector required |
| *a neck finish* | finishes the neck opening | — | — | — |

A **neck finish** is satisfied by `neck.band`, by a collar pair, or by a declared
facing. The template requires *a* finish, not a specific one.

**Optional**

| Role | When | Simulated? |
|---|---|---|
| `pocket.patch` | chest pocket | yes, as a surface layer |
| `reinforcement.shoulder` | shoulder tape | **no** (§7) |
| `label.*` | labels | **no** |

**Seams** *(typical; factory method may differ)*

| # | Seam | Side A | Side B | Typical ease |
|---|---|---|---|---|
| 1 | shoulder, **each side separately** | `body.front` shoulder run | `body.back` shoulder run | 0 – 2 % onto the back |
| 2 | neckline | `neck.band` join run | front neck + back neck, contiguous from a stated anchor | band **shorter**, stretched on, typically 10 – 25 % |
| 3 | sleeve to armhole, **each side** | `sleeve` cap run | front armhole + back armhole, contiguous from the underarm | 0 – 5 % |
| 4 | side and underarm, **each side** | front side + sleeve underarm | back side + sleeve underarm | 0 % |

Seam 4 is one continuous seam on a tee, cuff to hem — which is why sides are
sequences. Sewn as two separate seams is also valid and the template accepts both.

**Legitimately unsewn:** bottom hem, sleeve hem, the band's outer fold.

**Not simulated:** the band's fold-back (one layer), shoulder tape, labels, hem
turn-ups.

### 6.2 Polo shirt

A tee with a neck opening, a placket and a flat collar.

**Required:** `body.front`, `body.back`, `sleeve`, and *a neck finish*.

**Optional, with conditional rules when present**

| Role | When present, also require |
|---|---|
| `collar.flat` | a join run, and a neckline sequence to join it to |
| `placket.top` / `placket.under` | both, and the front opening runs |
| `cuff.band` | a join run per sleeve |
| `pocket.patch`, `interlining.collar`, `reinforcement.*` | — |

**Seams** *(typical; factory method may differ)*

| # | Seam | Side A | Side B |
|---|---|---|---|
| 1 | shoulder, each side | front shoulder | back shoulder |
| 2 | placket to opening | placket join runs | front opening runs |
| 3 | collar to neckline | collar join run | front neck + back neck + placket top runs, contiguous |
| 4 | sleeve to armhole, each side | cap run | front + back armhole, from the underarm |
| 5 | side and underarm, each side | front side + sleeve underarm | back side + sleeve underarm |
| 6 | cuff band, each side | band join run | sleeve lower run |

**Legitimately unsewn:** hem, sleeve hem when unbanded, collar outer edge,
placket free edges below the opening.

**Not simulated:** collar interlining stiffness, placket layer thickness, buttons
and buttonholes, the collar's roll line.

> The collar's roll is the most visible thing a polo does that is not modelled.
> The fitting shows a collar lying flat and must not be read as a statement about
> how it will stand.

### 6.3 Basic woven shirt

Same family, more pieces, no stretch to hide anything.

**Required — and only these**

| Role | For | Cut qty | Symmetry |
|---|---|---|---|
| `body.front` | front torso, often two halves | 1 or 2 | `single`, or Form A / Form B |
| `body.back` | back torso | 1 | `cut-on-fold` or `single` |
| `sleeve` | arm | 2 | Form A or Form B |
| *a neck finish* | — | — | — |

A **short-sleeved** shirt is a `sleeve` with no cuff. A **band-collar** shirt
satisfies the neck finish with a stand alone. A shirt with **no separate
upper-back panel** uses the back's own shoulder runs.

**Optional, with conditional rules when present**

| Role | When present, also require |
|---|---|
| `collar.stand` | a join run, and a neckline sequence |
| `collar.fall` | a join run, and `collar.stand` |
| `panel.upper-back` | its own shoulder, armhole and neck runs; and it **replaces** the back's shoulder runs in seam 2 |
| `cuff` | a join run per sleeve |
| `placket.front` | the front opening runs |
| `sleeve.opening` | the slit runs |
| `pocket.patch`, `interlining.*` | — |

**Seams** *(typical; factory method may differ)*

| # | Seam | Side A | Side B | Condition |
|---|---|---|---|---|
| 1 | upper-back panel to back | panel lower run | back upper run | only if the panel exists |
| 2 | shoulder, each side | front shoulder | panel shoulder, **or** back shoulder | |
| 3 | sleeve opening | facing runs | sleeve slit runs | only if present |
| 4 | sleeve to armhole, each side | cap run | front armhole + (panel armhole) + back armhole, contiguous from the underarm | |
| 5 | side and underarm, each side | front side + sleeve underarm | back side + sleeve underarm | |
| 6 | cuff, each side | cuff join run | sleeve lower run | only if a cuff exists |
| 7 | collar stand to neckline | stand join run | front neck + (panel neck) + back neck, contiguous | only if a stand exists |
| 8 | collar fall to stand | fall join run | stand upper run | only if a fall exists |

**The conditional piece is the point.** Whether the shirt has an upper-back panel
changes which runs exist and which seams are required. Requiring it would reject
half the shirts in the world; ignoring it would mis-sew the other half.

**Legitimately unsewn:** bottom hem, cuff outer edges, collar fall outer edge,
front placket fold, side vents.

**Not simulated:** interlining, buttons and buttonholes, pleats, the collar roll,
topstitching, and the thickness of a flat-felled seam.

---

## 7. What is not simulated, and how that is said

| Kind | Example | What the product says |
|---|---|---|
| **Not modelled** | collar roll, interlining, buttons | "This fitting does not model the collar's roll. Judge the stand from the sample." |
| **Modelled simply** | a folded band drawn as one layer | "The neck band is shown as a single layer, so it will look thinner than the made garment." |
| **Excluded on purpose** | labels, shoulder tape | nothing on screen; they are not garment shape |

The first two appear beside the fitting, not in a document. Somebody looking at a
flat-lying polo collar will otherwise conclude the pattern is wrong.

---

## 8. Readiness failures and safe warnings

A **readiness failure** stops a fitting. A **warning** lets it run and travels
with the result.

The principle: *a fitting that cannot be trusted must not be produced*, because a
believable picture with the wrong dimensions is worse than no picture — somebody
will approve a sample against it.

**Two validations, at two different moments (M4):**

- **Pre-simulation, on declared lengths.** Readiness compares the lengths the
  *pattern* says its runs are. It can refuse before any mesh exists.
- **Post-meshing, on built geometry.** Lane A's fidelity gate compares each
  piece's perimeter to its mesh boundary, each seam's declared length to the seam
  actually sewn, and the stated scale to the built scale. It fails rather than
  warns.

They are not the same check and neither replaces the other. Neither detects a
reversed seam (§4.5).

### Readiness failures — the fitting does not run

| # | Condition | Why it stops |
|---|---|---|
| R1 | no piece has a usable closed outline | nothing to sew |
| R2 | the pattern states no unit | every length is meaningless; out by 25.4× if guessed |
| R3 | a **required** role for the template is unassigned | incomplete by that template's definition (§6 — the required list is short) |
| R4 | a seam's `alignment` is absent or unconfirmed | §4.5 — the failure nothing downstream can catch |
| R5 | a piece's perimeter is neither covered by runs nor confirmed as finished | nobody has finished the mapping (§4.11) |
| R6 | a compound seam side is non-contiguous or changes direction | §4.4 |
| R7 | a seam's sides differ by more than the template's ease allowance | the pieces as mapped do not fit each other |
| R8 | an outline is open or self-intersecting | it cannot be made into cloth |
| R9 | no fabric profile for a simulated piece | the drape would be of a fabric nobody specified |
| R10 | a simulated piece has no grain vector, and its fabric behaves differently along and across | the stretch direction is undefined |
| R11 | the pattern revision changed after the mapping was confirmed | the mapping may point at geometry that moved |

### Safe warnings — the fitting runs and says this

| # | Condition | What travels with the result |
|---|---|---|
| W1 | sewing line **derived** rather than published | "Sewing lines were derived from a stated seam allowance." Dimensional findings are marked derived |
| W2 | sewing line could not be constructed; **cut boundary used** | non-authoritative drape; **dimensional findings withheld** (§4.12 step 4) |
| W3 | ease on a seam unusual but inside the allowance | named, with the number |
| W4 | an optional piece is absent | "This shirt has no separate upper-back panel." |
| W5 | fabric values estimated rather than measured | the whole fitting is marked estimated |
| W6 | a role or grain vector confirmed from a suggestion | the basis is shown |
| W7 | anchors are arc-length fractions | "This mapping will need re-checking after any pattern edit." |
| W8 | a construction element in §7 is present | the sentence from §7 |
| W9 | a mirrored confirmation was propagated rather than made independently | which side was confirmed, and which inherited (§4.7) |

---

## 9. What R&D must provide, per pattern

1. **The template** — which of the three categories.
2. **A role** for each piece that takes part in the garment.
3. **Cut quantity and symmetry**, including which pieces are cut on the fold —
   our exports publish no mirror line.
4. **The seam mapping**, with **alignment confirmed** on every seam (§4.5).
5. **Which perimeter is finished** rather than sewn (one confirmation per piece).
6. **A seam allowance**, per run or per garment, so a sewing line can be derived
   (§4.12). Without it, dimensional findings are withheld.
7. **A fabric profile** per piece or per garment.
8. **The body** being fitted to.
9. **The unit**, if the DXF does not state one.

### Derivable without a person

Outline, closed flag, perimeter, area, width, height, turn points, curve points,
internal lines, **grain vector** where layer 7 exists, notches where layer 4
exists, sewing line where layer 14 exists, size, quantity where published, and the
unit where the file states one.

### Must be confirmed by a person, always

Role. Symmetry, pairing and cut-on-fold. Seam pairing **and alignment**. Which
perimeter is finished. Seam allowance where no sewing line is published. Which
fabric belongs to which piece. Anything the file did not publish.

---

## 10. What this contract deliberately does not do

- It does not name a piece. Roles are assigned.
- It does not guess a seam from proximity, shape or length similarity. Two runs
  being the same length is not evidence they are sewn together; on a shirt several
  pairs match and only one pairing is correct.
- It does not claim a reversed seam can be detected after assembly (§4.5).
- It does not read grain from the marker (§4.8).
- It does not treat the cut boundary as a sewing line and call the difference
  slight (§4.12).
- It does not require manufacturing order as a readiness input (§6).
- It does not edit a pattern, ever — `fit-assistant-rules.md` §7.
- It does not define a universal number anywhere. Every tolerance is the
  template's, and templates set them by category, fit and fabric.
